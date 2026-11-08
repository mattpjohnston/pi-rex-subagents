import { appendFileSync } from "node:fs";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { claim, readClaim, withRunLock } from "./claims.ts";
import { atomicWrite, type ResultFile, type RunRecord } from "./records.ts";
import { deriveOutcome } from "./results.ts";

export function registerReporter(pi: ExtensionAPI, run: RunRecord): void {
  process.umask(0o077);
  let shutdown = false;
  const log = (type: string, data: Record<string, unknown> = {}): void => {
    appendFileSync(run.paths.events, `${JSON.stringify({ type, at: Date.now(), data })}\n`, {
      mode: 0o600,
    });
  };
  log("child_loaded", { pid: process.pid, tty: Boolean(process.stdin.isTTY), cwd: process.cwd() });
  const settings = (ctx: ExtensionContext) => ({
    provider: ctx.model?.provider ?? run.effective.provider,
    model: ctx.model?.id ?? run.effective.model,
    thinking: pi.getThinkingLevel(),
  });
  const lastAssistant = (ctx: ExtensionContext): AssistantMessage | undefined => {
    for (const entry of ctx.sessionManager.getBranch().toReversed()) {
      if (entry.type !== "message") continue;
      if (entry.message.role === "assistant") return entry.message;
      if (entry.message.role === "user") break;
    }
    return undefined;
  };

  // This is the sole settlement owner. Later inbox/descendant decisions belong inside this lock.
  const settle = async (
    ctx: ExtensionContext,
    aborted: boolean,
    quitting = false,
  ): Promise<void> => {
    const action = await withRunLock(run.paths.lock, async () => {
      const winner = await readClaim(run.paths.claim);
      if (winner === "taken_over") return "stay";
      if (winner === "cancelled" || winner === "result") return "exit";
      if (shutdown && !quitting) return "stay";
      const result: ResultFile = {
        version: 1,
        runId: run.id,
        ...deriveOutcome(lastAssistant(ctx), aborted, quitting),
        sessionFile: ctx.sessionManager.getSessionFile() ?? null,
        effective: settings(ctx),
        finishedAt: Date.now(),
      };
      await atomicWrite(run.paths.result, result);
      await claim(run.paths.claim, "result");
      log("result_claimed", { outcome: result.outcome });
      return "exit";
    });
    if (action === "exit" && !quitting) ctx.shutdown();
  };

  pi.on("project_trust", (event) => {
    log("project_trust", { cwd: event.cwd });
    return { trusted: "undecided" };
  });
  pi.on("session_start", async (event, ctx) => {
    const winner = await readClaim(run.paths.claim);
    log("session_start", {
      reason: event.reason,
      cwd: ctx.cwd,
      effective: settings(ctx),
      tools: pi.getActiveTools(),
      trusted: ctx.isProjectTrusted(),
      sessionFile: ctx.sessionManager.getSessionFile() ?? null,
      claim: winner,
    });
    if (winner === "cancelled" || winner === "result") ctx.shutdown();
  });
  pi.on("ui_prompt_start", (event) => {
    log("ui_prompt_start", { kind: event.kind, title: event.title ?? "Pi dialog" });
  });
  pi.on("ui_prompt_end", () => {
    log("ui_prompt_end");
  });
  if (process.env.PI_SUBAGENTS_LOG_TOOLS)
    pi.on("tool_call", (event) => {
      log("tool_call", {
        name: event.toolName,
        input: event.input,
        toolCallId: event.toolCallId,
        parentToolCallId: event.parentToolCallId,
      });
    });
  pi.on("agent_settled", async (event, ctx) => {
    log("agent_settled", { aborted: event.aborted, shutdown });
    if (!shutdown) await settle(ctx, event.aborted);
  });
  pi.on("session_shutdown", async (event, ctx) => {
    log("session_shutdown", { reason: event.reason });
    if (event.reason === "quit") {
      shutdown = true;
      await settle(ctx, false, true);
    }
  });
  const rejectReplacement = async (_event: unknown, ctx: ExtensionContext) => {
    if (!(await readClaim(run.paths.claim))) {
      ctx.ui.notify(
        "Managed child cannot replace its session before an outcome is claimed",
        "error",
      );
      return { cancel: true };
    }
    return undefined;
  };
  pi.on("session_before_switch", rejectReplacement);
  pi.on("session_before_fork", rejectReplacement);
  pi.registerCommand("subagent-takeover", {
    description:
      "Take human ownership of this live child, disabling publication and automatic shutdown",
    handler: async (_args, ctx) => {
      const winner = await withRunLock(run.paths.lock, async () => {
        const existing = await readClaim(run.paths.claim);
        if (existing) return existing;
        await claim(run.paths.claim, "taken_over");
        return null;
      });
      if (winner) {
        log("takeover_refused", { winner });
        ctx.ui.notify(`Takeover refused: ${winner} already won`, "error");
        return;
      }
      log("takeover_claimed");
      // Testing hook: an extra harness extension can delay UI acknowledgement after the durable claim.
      pi.events.emit("subagents:test-takeover-claimed", { runId: run.id });
      ctx.ui.notify(
        `Taken over: ${run.label}. Automatic result publication and shutdown are disabled.`,
        "info",
      );
      log("takeover_acknowledged");
    },
  });
}
