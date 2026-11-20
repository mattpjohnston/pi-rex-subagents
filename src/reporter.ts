import { writeSync } from "node:fs";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  isTakenOver,
  markTakenOver,
  readResult,
  writeResult,
  type ResultFile,
  type RunRecord,
} from "./store.ts";

const TRUST_MSG = Buffer.from("Project trust").toString("base64");

/**
 * Pi reports every wait to Rex via OSC 7501 except its project-trust prompt.
 * Emit the exact same blocked status while the trust prompt is open so Rex
 * displays tab dots, Activity view entries, and notifications uniformly.
 */
export class TrustStatus {
  private reported = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly write: (seq: string) => void;

  constructor(write: (seq: string) => void) {
    this.write = write;
  }

  prompt(): void {
    clearTimeout(this.timer);
    // Trust observers also fire for already-saved decisions; wait briefly for session_start.
    this.timer = setTimeout(() => {
      if (this.reported) return;
      this.reported = true;
      this.write(`\x1b]7501;state=blocked:app=pi:kind=permission:msg=${TRUST_MSG}\x1b\\`);
    }, 500);
  }

  end(): void {
    clearTimeout(this.timer);
    if (!this.reported) return;
    this.reported = false;
    this.write("\x1b]7501;state=idle:app=pi\x1b\\");
  }
}

export function deriveOutcome(
  assistant: Pick<AssistantMessage, "stopReason" | "errorMessage" | "content"> | undefined,
  aborted: boolean,
  shutdown = false,
): Pick<ResultFile, "outcome" | "assistantText" | "stopReason" | "reason"> {
  const assistantText =
    assistant?.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n") ?? "";
  const stopReason = assistant?.stopReason ?? null;
  if (shutdown) {
    return { outcome: "failed", assistantText, stopReason, reason: "Child quit before settlement" };
  }
  if (aborted || stopReason === "aborted") {
    return { outcome: "aborted", assistantText, stopReason, reason: "Agent aborted" };
  }
  if (stopReason === "error") {
    return {
      outcome: "failed",
      assistantText,
      stopReason,
      reason: assistant?.errorMessage ?? "Provider error",
    };
  }
  if (stopReason === "length" || !assistantText.trim()) {
    return {
      outcome: "incomplete",
      assistantText,
      stopReason,
      reason: stopReason === "length" ? "Length cutoff" : "Missing assistant reply",
    };
  }
  return { outcome: "completed", assistantText, stopReason, reason: null };
}

function lastAssistant(ctx: ExtensionContext): AssistantMessage | undefined {
  for (const entry of ctx.sessionManager.getBranch().toReversed()) {
    if (entry.type !== "message") continue;
    if (entry.message.role === "assistant") return entry.message;
    if (entry.message.role === "user") break;
  }
  return undefined;
}

export function registerReporter(pi: ExtensionAPI, run: RunRecord): void {
  const trust = new TrustStatus((seq) => {
    try {
      writeSync(1, seq);
    } catch {
      // Display-only; ignore closed stdout.
    }
  });

  const currentModel = (ctx: ExtensionContext) => ({
    provider: ctx.model?.provider ?? run.model.provider,
    model: ctx.model?.id ?? run.model.model,
    thinking: pi.getThinkingLevel(),
  });

  pi.on("project_trust", () => {
    trust.prompt();
    return { trusted: "undecided" as const };
  });

  pi.on("session_start", () => {
    trust.end();
  });

  pi.registerCommand("subagent-takeover", {
    description: "Take ownership of this subagent session so it stops reporting and stays open",
    handler: async (_args, ctx) => {
      const state = await markTakenOver(run.id);
      if (state === "finished") {
        ctx.ui.notify("This subagent already finished and reported its result.", "warning");
        return;
      }
      ctx.ui.notify(
        state === "claimed"
          ? "Session taken over. It will no longer report to the parent or exit automatically."
          : "You already own this session.",
        "info",
      );
    },
  });

  pi.on("agent_settled", async (event, ctx) => {
    trust.end();
    if (await isTakenOver(run.id)) return;
    if (await readResult(run.id)) return;
    const derived = deriveOutcome(lastAssistant(ctx), event.aborted);
    // Recheck takeover right before writing so a concurrent /subagent-takeover wins cleanly.
    if (await isTakenOver(run.id)) return;
    await writeResult({
      version: 2,
      runId: run.id,
      ...derived,
      sessionFile: ctx.sessionManager.getSessionFile() ?? null,
      model: currentModel(ctx),
      finishedAt: Date.now(),
    });
    ctx.shutdown();
  });

  pi.on("session_shutdown", async (event, ctx) => {
    trust.end();
    if (event.reason !== "quit") return;
    if (await isTakenOver(run.id)) return;
    if (await readResult(run.id)) return;
    const derived = deriveOutcome(lastAssistant(ctx), false, true);
    await writeResult({
      version: 2,
      runId: run.id,
      ...derived,
      sessionFile: ctx.sessionManager.getSessionFile() ?? null,
      model: currentModel(ctx),
      finishedAt: Date.now(),
    });
  });
}
