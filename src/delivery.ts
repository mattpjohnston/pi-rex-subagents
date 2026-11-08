import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import type { Claim } from "./claims.ts";
import { isTerminal, type CheckoutReport, type RunRecord } from "./records.ts";
import { checkoutText } from "./results.ts";

export const RESULTS_TYPE = "subagent-results";
export const NOTE_TYPE = "subagent-results-note";
export const DELIVERY_NOTE =
  "Background results are already in this session. Continue from that delivery; do not expect them to be sent again.";
export const COALESCE_MS = 1000;

export interface DeliveryOutcome {
  runId: string;
  outcome: string;
  text: string;
  sessionPath: string;
  resultPath: string;
  checkout?: CheckoutReport;
}
export interface PackedDelivery {
  content: string;
  runIds: string[];
}
export interface BranchNode {
  type: string;
  customType?: string;
  details?: unknown;
}

export type DeliverySource = "settled" | "timer" | "reconcile" | "append" | "finished";
export type DeliveryAction = "deliver" | "note" | "wait" | "none";
/** Busy parents deliver on settle. Idle parents wait out the coalesce window, except reconciliation. */
export function nextDelivery(input: {
  idle: boolean;
  pending: boolean;
  unanswered: boolean;
  source: DeliverySource;
}): DeliveryAction {
  if (input.source === "append") return input.pending ? "deliver" : "none";
  if (!input.idle) return input.pending || input.unanswered ? "wait" : "none";
  if (input.pending && input.source !== "finished") return "deliver";
  if (input.pending) return "wait";
  if (input.unanswered && input.source !== "finished" && input.source !== "timer") return "note";
  return "none";
}
export function coalesceDelay(): number {
  const raw = process.env.PI_SUBAGENTS_COALESCE_MS;
  if (raw === undefined) return COALESCE_MS;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 && value <= 60_000 ? value : COALESCE_MS;
}

export function fullEntry(outcome: DeliveryOutcome): string {
  const lines = [
    `Run: ${outcome.runId}`,
    `Outcome: ${outcome.outcome}`,
    `Session: ${outcome.sessionPath}`,
  ];
  if (outcome.checkout) lines.push(checkoutText(outcome.checkout));
  lines.push("", outcome.text);
  return lines.join("\n");
}
export function pathEntry(outcome: DeliveryOutcome): string {
  return `Run: ${outcome.runId}\nOutcome: ${outcome.outcome}\nResult: ${outcome.resultPath}`;
}
function fits(text: string, maxBytes: number, maxLines: number): boolean {
  return Buffer.byteLength(text) <= maxBytes && text.split("\n").length <= maxLines;
}
/** Full entries until the cap, then run ID, outcome and result path. Unfitted IDs stay pending. */
export function packDelivery(
  outcomes: readonly DeliveryOutcome[],
  maxBytes = DEFAULT_MAX_BYTES,
  maxLines = DEFAULT_MAX_LINES,
): PackedDelivery {
  const parts: string[] = [];
  const runIds: string[] = [];
  for (const outcome of outcomes) {
    const full = [...parts, fullEntry(outcome)].join("\n\n");
    const chosen = fits(full, maxBytes, maxLines)
      ? fullEntry(outcome)
      : [...parts, pathEntry(outcome)].join("\n\n");
    if (!fits(chosen, maxBytes, maxLines)) break;
    parts.push(fits(full, maxBytes, maxLines) ? fullEntry(outcome) : pathEntry(outcome));
    runIds.push(outcome.runId);
  }
  return { content: parts.join("\n\n"), runIds };
}

function listedIds(details: unknown): string[] {
  if (!details || typeof details !== "object" || !("runIds" in details)) return [];
  const runIds = details.runIds;
  return Array.isArray(runIds) ? runIds.filter((id) => typeof id === "string") : [];
}
/**
 * Pi's getBranch() still contains entries a compaction summarized. Compaction details only
 * store read and modified files, so a summarized delivery is recognized from the entry itself.
 */
export function deliveredRunIds(branch: readonly BranchNode[]): Set<string> {
  const ids = new Set<string>();
  for (const entry of branch) {
    if (entry.type === "custom_message" && entry.customType === RESULTS_TYPE)
      for (const id of listedIds(entry.details)) ids.add(id);
  }
  return ids;
}
export function endsWithUnansweredDelivery(branch: readonly BranchNode[]): boolean {
  const leaf = branch.at(-1);
  return leaf?.type === "custom_message" && leaf.customType === RESULTS_TYPE;
}

/**
 * A taken-over claim is the outcome at once, matching the foreground return. The process is
 * meant to stay live, so the exit and grace clauses apply to result and cancelled claims.
 * A terminal record with no claim is a startup or reporter failure and is still an outcome.
 */
export function outcomeReady(run: RunRecord, claim: Claim | null): boolean {
  if (!run.background) return false;
  if (claim === "taken_over") return true;
  const settled = run.process.state === "exited" || run.process.state === "unresolved";
  if (claim) return settled;
  return settled && isTerminal(run.lifecycle);
}

export interface TransitionView {
  id: string;
  background: boolean;
  parentSessionId: string;
  lifecycle: RunRecord["lifecycle"];
  processState: RunRecord["process"]["state"];
  claim: Claim | null;
  queued: boolean;
  delivered: boolean;
  ready: boolean;
}
export function transitionView(
  run: RunRecord,
  claim: Claim | null,
  delivered: ReadonlySet<string>,
): TransitionView {
  return {
    id: run.id,
    background: run.background,
    parentSessionId: run.parentSessionId,
    lifecycle: run.lifecycle,
    processState: run.process.state,
    claim,
    queued: run.queue !== null && !claim && !isTerminal(run.lifecycle),
    delivered: delivered.has(run.id),
    ready: outcomeReady(run, claim),
  };
}
function owned(run: TransitionView, sessionId: string): boolean {
  return run.parentSessionId === sessionId && run.claim !== "taken_over";
}
export function parentOwnedLive(run: TransitionView): boolean {
  return (
    run.queued ||
    run.lifecycle === "admitting" ||
    run.lifecycle === "starting" ||
    run.lifecycle === "running" ||
    run.processState === "live" ||
    run.processState === "unknown"
  );
}
export function blocksReplacement(runs: readonly TransitionView[], sessionId: string): boolean {
  return runs.some(
    (run) =>
      owned(run, sessionId) &&
      (parentOwnedLive(run) || (run.background && run.ready && !run.delivered)),
  );
}
export function shouldCancel(run: TransitionView, sessionId: string): boolean {
  return run.background && owned(run, sessionId) && parentOwnedLive(run);
}
export function shouldAppend(run: TransitionView, sessionId: string): boolean {
  return run.background && run.parentSessionId === sessionId && run.ready && !run.delivered;
}
