import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readClaim } from "./claims.ts";
import { sendInboxMessage } from "./inbox.ts";
import { cancel } from "./launch.ts";
import { listRuns, readRun, type RunRecord } from "./records.ts";
import { object, observeProcess, rexJson } from "./rex.ts";
import { cappedText } from "./results.ts";
import { setTimeout as delay } from "node:timers/promises";
import { park, wake } from "./admission.ts";
import { outcomeOf, outcomeSettled, packDelivery, type DeliveryOutcome } from "./delivery.ts";
import { lastKnownTab } from "./terminals.ts";

export const CONTROL_LIST_LIMIT = 30;
const WAIT_DEFAULT_SECONDS = 600;
const WAIT_MAX_SECONDS = 3600;
export const ControlInput = Type.Object(
  {
    operation: Type.Union([
      Type.Literal("list"),
      Type.Literal("cancel"),
      Type.Literal("message"),
      Type.Literal("wait"),
    ]),
    runId: Type.Optional(Type.String()),
    runIds: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: CONTROL_LIST_LIMIT })),
    timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: WAIT_MAX_SECONDS })),
    text: Type.Optional(Type.String({ minLength: 1, maxLength: 50_000 })),
  },
  { additionalProperties: false },
);

/** Include descendants even when their immediate parent has a different Pi session ID. */
export function ownedRuns(runs: readonly RunRecord[], sessionId: string): RunRecord[] {
  const ids = new Set(runs.filter((run) => run.parentSessionId === sessionId).map((run) => run.id));
  let changed = true;
  while (changed) {
    changed = false;
    for (const run of runs) {
      if (run.parentRunId && ids.has(run.parentRunId) && !ids.has(run.id)) {
        ids.add(run.id);
        changed = true;
      }
    }
  }
  return runs.filter((run) => ids.has(run.id));
}
export async function cancelControlled(
  run: RunRecord,
  afterClaim?: () => void,
): Promise<{ status: "cancelled" | "refused" | "result"; reason: string }> {
  const winner = await cancel(run, afterClaim);
  if (winner === "taken_over")
    return { status: "refused", reason: "taken_over: human-owned child left running" };
  return {
    status: winner,
    reason:
      winner === "result"
        ? "Process closed after shutdown grace; recorded outcome unchanged"
        : "Cancellation claimed before signalling; exit confirmation remains in the run record",
  };
}
/** Runs waiting for a human come first, then the oldest. */
export const waitingFirst = (a: RunRecord, b: RunRecord) =>
  Number(Boolean(b.waiting)) - Number(Boolean(a.waiting)) || a.createdAt - b.createdAt;
/**
 * Outcomes of the named runs once each has one, or what's ready when the time is up or the
 * call is aborted. Waiting cancels nothing.
 */
export async function waitForRuns(
  ids: readonly string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ text: string; runIds: string[]; pending: string[] }> {
  const deadline = Date.now() + timeoutMs;
  const ready = new Map<string, DeliveryOutcome>();
  while (true) {
    for (const id of ids) {
      if (ready.has(id)) continue;
      const run = await readRun(id);
      const claim = await readClaim(run.paths.claim);
      if (outcomeSettled(run, claim)) ready.set(id, await outcomeOf(run, claim));
    }
    if (ready.size === ids.length || Date.now() >= deadline || signal?.aborted) break;
    await delay(Math.min(500, deadline - Date.now()), undefined, { signal }).catch(() => undefined);
  }
  const packed = packDelivery(ids.flatMap((id) => ready.get(id) ?? []));
  const pending = ids.filter((id) => !packed.runIds.includes(id));
  return { text: packed.content, runIds: packed.runIds, pending };
}
export function treeOrder(runs: readonly RunRecord[]): RunRecord[] {
  const ordered: RunRecord[] = [];
  const visit = (parent: string | null) => {
    const children = runs
      .filter((r) =>
        parent === null
          ? !r.parentRunId || !runs.some((p) => p.id === r.parentRunId)
          : r.parentRunId === parent,
      )
      .sort(waitingFirst);
    for (const child of children) {
      ordered.push(child);
      visit(child.id);
    }
  };
  visit(null);
  return ordered;
}
export async function controlList(runs: readonly RunRecord[]) {
  const sorted = treeOrder(runs);
  const entries = [];
  for (const run of sorted.slice(0, CONTROL_LIST_LIMIT)) {
    let lastRexStatus: unknown = null;
    let process = run.process;
    let location = lastKnownTab(run);
    if (location) {
      const observed = await observeProcess(location);
      process = observed.process;
      location = observed.location;
      if (location) {
        try {
          const reply = object(
            await rexJson([
              "block",
              "call",
              "-s",
              location.sessionId,
              "-b",
              location.blockId,
              "program_status",
            ]),
          );
          const statuses = Array.isArray(reply.records) ? reply.records.map(object) : [];
          const status = statuses
            .filter((status) => typeof status.updated_at === "string")
            .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))[0];
          lastRexStatus = status
            ? {
                state: status.state,
                kind: status.kind,
                title: status.title,
                message: status.msg,
                updatedAt: status.updated_at,
              }
            : null;
        } catch {
          lastRexStatus = "unknown";
        }
      }
    }
    entries.push({
      runId: run.id,
      parentRunId: run.parentRunId,
      depth: run.depth,
      indent: "  ".repeat(Math.max(0, run.depth - 1)),
      orphaned: Boolean(
        run.parentRunId &&
        (!runs.some((r) => r.id === run.parentRunId) ||
          runs.find((r) => r.id === run.parentRunId)?.process.state === "exited"),
      ),
      parked: run.activity?.parked ?? null,
      label: run.label,
      access: run.access,
      state: (await readClaim(run.paths.claim)) ?? run.lifecycle,
      queue: run.queue,
      checkout: run.checkoutRoot,
      lastRexStatus,
      waiting: run.waiting,
      process,
      location,
      elapsedMs: Math.max(0, (run.finishedAt ?? Date.now()) - run.createdAt),
    });
  }
  return { runs: entries, omitted: Math.max(0, runs.length - entries.length) };
}
export function registerControl(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "subagent_control",
    label: "Subagent control",
    description:
      "Control this parent's delegated runs. list probes liveness and shows bounded status including queues and human waits. wait blocks until every run in runIds has an outcome or timeoutSeconds (default 600) passes, and returns those outcomes; they are not delivered again later. While waiting you can't be steered, so prefer ending your turn and letting background results arrive unless you need them now. cancel stops a queued or live background child so you can replace a stuck agent; it never kills a taken-over human session. message sends stop/hold orders or a correction to a live child, as steering or an idle prompt, with an accepted/refused acknowledgment (unacknowledged after 10 seconds is NOT delivery). It never types into a dialog. message is not for chaining new work: launch a fresh subagent instead.",
    parameters: ControlInput,
    async execute(callId, input, signal, _update, ctx) {
      const sessionId = ctx.sessionManager.getSessionId();
      const owned = ownedRuns(await listRuns(), sessionId);
      if (input.operation === "wait") {
        const ids = [...new Set(input.runIds ?? (input.runId ? [input.runId] : []))];
        const unknown = ids.filter((id) => !owned.some((run) => run.id === id));
        if (!ids.length || unknown.length)
          return {
            content: [
              {
                type: "text",
                text: `wait refused: runIds must name runs owned by this parent${unknown.length ? ` (not: ${unknown.join(", ")})` : ""}`,
              },
            ],
            details: { runIds: [] },
          };
        // A subagent that waits makes no model calls, so it gives its slot back meanwhile.
        const child = process.env.PI_SUBAGENTS_RUN_ID;
        if (child) await park(child, "foreground", callId);
        try {
          const waited = await waitForRuns(
            ids,
            (input.timeoutSeconds ?? WAIT_DEFAULT_SECONDS) * 1000,
            signal,
          );
          const still = waited.pending.length
            ? `\n\nStill running or not shown: ${waited.pending.join(", ")}. Background results for these arrive as usual.`
            : "";
          return {
            content: [{ type: "text", text: (waited.text || "No outcomes yet.") + still }],
            details: { runIds: waited.runIds },
          };
        } finally {
          if (child) await wake(child, callId);
        }
      }
      let response: unknown;
      if (input.operation === "list") response = await controlList(owned);
      else {
        const run = owned.find((run) => run.id === input.runId);
        if (!run)
          response = {
            status: "refused",
            reason: "runId must identify a run owned by this parent",
          };
        else if (input.operation === "cancel")
          response = await cancelControlled(run, () =>
            pi.events.emit("subagents:test-cancel-claimed", { runId: run.id }),
          );
        else if (!input.text?.trim())
          response = { status: "refused", reason: "message requires nonempty text" };
        else response = await sendInboxMessage(run, sessionId, input.text, signal);
      }
      return {
        content: [{ type: "text", text: cappedText(JSON.stringify(response)) }],
        details: undefined,
      };
    },
  });
}
