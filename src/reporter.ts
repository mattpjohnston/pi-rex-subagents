import { appendFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { claim, outsideAdmission, readClaim, withProtocolLock } from "./claims.ts";
import {
  acceptWritten,
  inboxEntries,
  INBOX_POLL_MS,
  markConsumed,
  markSent,
  messageState,
  messageText,
  type InboxEntry,
} from "./inbox.ts";
import { inboxDecision, settlementDecision, type ProtocolSnapshot } from "./protocol.ts";
import { registerGitRead } from "./git-read.ts";
import {
  atomicWrite,
  listRuns,
  readRun,
  updateActivity,
  type ResultFile,
  type RunRecord,
} from "./records.ts";
import { outcomeOf, outcomeSettled, packDelivery, type DeliveryOutcome } from "./delivery.ts";
import { inspectViolations, readViolations, type ToolSnapshot } from "./restrictions.ts";
import { deriveOutcome } from "./results.ts";
import { canLaunchChildren, park, tryWake, updateMemberProvider, wake } from "./admission.ts";
import { TrustStatus } from "./trust-status.ts";

export function registerReporter(pi: ExtensionAPI, run: RunRecord): void {
  process.umask(0o077);
  let shutdown = false;
  let halted = false;
  const trustStatus = new TrustStatus((sequence) => {
    try {
      // Same stdout the TUI uses for OSC 7501. A closed terminal must not fail the child.
      writeSync(1, sequence);
    } catch {
      /* Display only; the waiting record is the source of truth. */
    }
  });
  if (run.access === "read") registerGitRead(pi);
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

  let context: ExtensionContext | undefined;
  let polling = false;
  let settling = false;
  let hasSettled = false;
  const sentOutcomes = new Set<string>();
  let timer: ReturnType<typeof setInterval> | undefined;
  const snapshot = async (
    ctx: ExtensionContext,
    entries: InboxEntry[],
    phase?: ProtocolSnapshot["child"],
  ): Promise<ProtocolSnapshot> => ({
    claim: await readClaim(run.paths.claim),
    lock: null,
    child: phase ?? (settling ? "settling" : ctx.isIdle() ? "idle" : "working"),
    messages: entries.map(messageState),
  });
  const consume = async (ctx: ExtensionContext, entries: InboxEntry[]) => {
    const userTexts = ctx.sessionManager.getBranch().flatMap((entry) => {
      if (entry.type !== "message" || entry.message.role !== "user") return [];
      const content = entry.message.content;
      return [
        typeof content === "string"
          ? content
          : content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("\n"),
      ];
    });
    await markConsumed(run, entries, userTexts);
  };
  const descendantState = async (ctx: ExtensionContext) => {
    const branch = ctx.sessionManager.getBranch();
    const seen = new Set<string>();
    const texts: string[] = [];
    for (const entry of branch) {
      if (entry.type !== "message") continue;
      if (entry.message.role === "user") texts.push(JSON.stringify(entry.message.content));
      if (entry.message.role === "toolResult" && entry.message.toolName === "subagent") {
        const details: unknown = entry.message.details;
        if (
          details &&
          typeof details === "object" &&
          "runId" in details &&
          typeof details.runId === "string"
        )
          seen.add(details.runId);
      }
    }
    const pending: DeliveryOutcome[] = [];
    let live = false;
    for (const child of (await listRuns()).filter((r) => r.parentRunId === run.id)) {
      const winner = await readClaim(child.paths.claim);
      if (!outcomeSettled(child, winner)) {
        live = true;
        continue;
      }
      if (
        (child.background || !seen.has(child.id)) &&
        !texts.some((text) => text.includes(`[subagent outcome ${child.id}]`))
      )
        pending.push(await outcomeOf(child, winner));
    }
    return { pending, live };
  };
  const dispatch = async (
    ctx: ExtensionContext,
    entries: InboxEntry[],
    outcomes: DeliveryOutcome[] = [],
  ) => {
    const unsent = entries.filter(
      (entry) => entry.ack?.state === "accepted" && entry.ack.sentAt === null,
    );
    if (!unsent.length && !outcomes.length) return;
    await markSent(run, unsent);
    const mode = ctx.isIdle() ? "prompt" : "steer";
    const packed = packDelivery(
      outcomes.map((outcome) => ({
        ...outcome,
        text: outcome.text,
      })),
      50 * 1024 - outcomes.length * 48,
      2000 - outcomes.length,
    );
    // A path-only packed entry still needs its delivery identity.
    const descendantText =
      packed.runIds.map((id) => `[subagent outcome ${id}]`).join("\n") +
      (packed.content ? `\n${packed.content}` : "");
    for (const id of packed.runIds) sentOutcomes.add(id);
    outsideAdmission(() =>
      pi.sendUserMessage(
        [messageText(unsent.map((entry) => entry.message)), descendantText]
          .filter(Boolean)
          .join("\n\n"),
        mode === "steer" ? { deliverAs: "steer" } : undefined,
      ),
    );
    log("inbox_sent", { ids: unsent.map((entry) => entry.message.id), mode });
    if (packed.runIds.length) log("descendants_sent", { ids: packed.runIds, mode });
  };
  const drain = async (ctx: ExtensionContext) => {
    await withProtocolLock(run.paths.lock, async () => {
      const entries = await inboxEntries(run);
      await consume(ctx, entries);
      const decision = inboxDecision(await snapshot(ctx, entries));
      if (decision !== "none") await acceptWritten(run, entries);
      if (
        decision !== "defer" &&
        !(hasSettled && ctx.isIdle()) &&
        !(await readRun(run.id)).activity?.parked
      )
        await dispatch(ctx, entries);
    });
  };
  // One settlement owner, including inbox decisions. Pi defers the next turn until it returns.
  const settle = async (
    ctx: ExtensionContext,
    aborted: boolean,
    quitting = false,
  ): Promise<void> => {
    // Harness extensions can hold this boundary without adding a second settlement owner.
    const boundary = { runId: run.id, before: Promise.resolve(), hold: false };
    pi.events.emit("subagents:test-settlement", boundary);
    await boundary.before;
    const action = await withProtocolLock(run.paths.lock, async () => {
      const entries = await inboxEntries(run);
      await consume(ctx, entries);
      if (inboxDecision(await snapshot(ctx, entries, "settling")) === "defer")
        await acceptWritten(run, entries);
      const descendants = await descendantState(ctx);
      const decision = settlementDecision({
        ...(await snapshot(ctx, entries, "settling")),
        descendants: { pending: descendants.pending.length > 0, live: descendants.live },
      });
      if (
        decision === "send" &&
        descendants.pending.length &&
        descendants.pending.every((outcome) => sentOutcomes.has(outcome.runId))
      )
        return "stay";
      if (decision === "send") {
        if ((await readRun(run.id)).activity?.parked) {
          await updateActivity(run.id, (activity) => {
            activity.readyToWake = true;
          });
          return "wake";
        }
        await dispatch(ctx, entries, descendants.pending);
        return "stay";
      }
      if (decision === "wait" || decision === "park") {
        await park(run.id, "settled");
        log("parked", { reason: decision });
        return "stay";
      }
      if (decision !== "publish") return decision;
      if (shutdown && !quitting) return "stay";
      if (boundary.hold && !quitting) return "stay";
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
    if (action === "wake" && (await tryWake(run.id))) await settle(ctx, aborted, quitting);
    if (action === "exit" && !quitting) ctx.shutdown();
  };

  pi.on("project_trust", (event) => {
    log("project_trust", { cwd: event.cwd });
    trustStatus.prompt();
    return { trusted: "undecided" };
  });
  const toolSnapshots = (): ToolSnapshot[] =>
    pi.getAllTools().map((tool) => ({ name: tool.name, exposure: tool.exposure }));
  // Pi handles /reload before extension input, so a child cannot cancel it. The launch flags
  // stay on the session and resource loader. Re-check after reload, before the next model turn,
  // and exit if the callable set expanded.
  const enforceRestriction = async (ctx: ExtensionContext, when: string): Promise<void> => {
    const active = pi.getActiveTools();
    const nestingBanned = !(await canLaunchChildren(run));
    const all = toolSnapshots();
    const extras = [
      ...(run.access === "read"
        ? readViolations(active, all)
        : run.access === "inspect"
          ? inspectViolations(active, all)
          : []),
      ...(nestingBanned
        ? all
            .filter(
              (tool) =>
                ["subagent", "subagent_control"].includes(tool.name) && tool.exposure !== "hidden",
            )
            .map((tool) => tool.name)
        : []),
    ];
    log("tool_set", { when, active, all, extras });
    if (!extras.length || halted) return;
    halted = true;
    const reason = `Restricted tool set violated: ${extras.join(", ")}`;
    log("tool_restriction", { extras, reason });
    await withProtocolLock(run.paths.lock, async () => {
      if (await readClaim(run.paths.claim)) return;
      const result: ResultFile = {
        version: 1,
        runId: run.id,
        outcome: "failed",
        assistantText: "",
        sessionFile: ctx.sessionManager.getSessionFile() ?? null,
        effective: settings(ctx),
        stopReason: null,
        reason,
        finishedAt: Date.now(),
      };
      await atomicWrite(run.paths.result, result);
      await claim(run.paths.claim, "result");
    });
    ctx.abort();
    ctx.shutdown();
    process.exit(1);
  };
  pi.on("session_start", async (event, ctx) => {
    trustStatus.end();
    const winner = await readClaim(run.paths.claim);
    log("session_start", {
      reason: event.reason,
      cwd: ctx.cwd,
      effective: settings(ctx),
      tools: pi.getActiveTools(),
      allTools: toolSnapshots(),
      trusted: ctx.isProjectTrusted(),
      sessionFile: ctx.sessionManager.getSessionFile() ?? null,
      claim: winner,
    });
    if (winner === "cancelled" || winner === "result") {
      ctx.shutdown();
      return;
    }
    await enforceRestriction(ctx, event.reason);
    context = ctx;
    // Polling survives atomic rename and needs no platform-specific fs.watch fallback.
    timer = setInterval(() => {
      if (!context || polling || shutdown) return;
      polling = true;
      void (async () => {
        if (!context) return;
        await drain(context);
        if (hasSettled && context.isIdle() && !settling) {
          settling = true;
          try {
            await settle(context, false);
          } finally {
            settling = false;
          }
        }
      })()
        .catch((error: unknown) => {
          log("inbox_error", { reason: error instanceof Error ? error.message : String(error) });
        })
        .finally(() => {
          polling = false;
        });
    }, INBOX_POLL_MS);
  });
  pi.on("before_agent_start", async (_event, ctx) => {
    hasSettled = false;
    await wake(run.id);
    await enforceRestriction(ctx, "before_agent_start");
  });
  pi.on("before_provider_request", async () => {
    log("model_call", { activity: (await readRun(run.id)).activity });
  });
  pi.on("cache_warming_decision", async () => {
    if ((await readRun(run.id)).activity?.parked) return { action: "stop" as const };
    return;
  });
  pi.on("model_select", async (event, ctx) => {
    await updateActivity(run.id, (activity, record) => {
      activity.parked = null;
      activity.readyToWake = false;
      record.effective = settings(ctx);
      activity.effective = record.effective;
    });
    await updateMemberProvider(run.id, event.model.provider);
  });
  pi.on("input", async (event) => {
    if (event.source !== "extension")
      await updateActivity(run.id, (activity) => {
        activity.parked = null;
        activity.readyToWake = false;
      });
  });
  pi.on("tool_execution_start", async (event) => {
    await updateActivity(run.id, (activity) => {
      activity.tools.push({ id: event.toolCallId, name: event.toolName });
    });
    log("tool_started", { id: event.toolCallId, name: event.toolName });
  });
  pi.on("tool_execution_end", async (event) => {
    await updateActivity(run.id, (activity) => {
      activity.tools = activity.tools.filter((tool) => tool.id !== event.toolCallId);
    });
    log("tool_ended", { id: event.toolCallId, name: event.toolName, isError: event.isError });
  });
  pi.on("ui_prompt_start", (event) => {
    log("ui_prompt_start", { kind: event.kind, title: event.title ?? "Pi dialog" });
  });
  pi.on("ui_prompt_end", () => {
    log("ui_prompt_end");
  });
  pi.on("tool_call", async (event, ctx) => {
    if (process.env.PI_SUBAGENTS_LOG_TOOLS)
      log("tool_call", {
        name: event.toolName,
        input: event.input,
        toolCallId: event.toolCallId,
        parentToolCallId: event.parentToolCallId,
      });
    if (halted) return { block: true, reason: "Restricted child is shutting down" };
    if (run.access !== "read" && run.access !== "inspect") return;
    const called =
      run.access === "read"
        ? readViolations([event.toolName], [{ name: event.toolName, exposure: "direct" }])
        : inspectViolations([event.toolName], [{ name: event.toolName, exposure: "direct" }]);
    const extras =
      run.access === "read"
        ? readViolations(pi.getActiveTools(), toolSnapshots())
        : inspectViolations(pi.getActiveTools(), toolSnapshots());
    const banned = [...new Set([...called, ...extras])];
    if (!banned.length) return;
    await enforceRestriction(ctx, "tool_call");
    return { block: true, reason: `Restricted tool set violated: ${banned.join(", ")}` };
  });
  pi.on("message_end", (event, ctx) => {
    if (event.message.role !== "user") return;
    // Pi appends after this notification returns. Never acknowledge consumption from the event alone.
    setImmediate(() => {
      if (context)
        void drain(ctx).catch((error: unknown) => log("inbox_error", { reason: String(error) }));
    });
  });
  pi.on("agent_settled", async (event, ctx) => {
    log("agent_settled", { aborted: event.aborted, shutdown });
    hasSettled = true;
    settling = true;
    try {
      if (!shutdown) await settle(ctx, event.aborted);
    } finally {
      settling = false;
    }
  });
  pi.on("session_shutdown", async (event, ctx) => {
    log("session_shutdown", { reason: event.reason });
    trustStatus.end();
    clearInterval(timer);
    context = undefined;
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
      const winner = await withProtocolLock(run.paths.lock, async () => {
        const existing = await readClaim(run.paths.claim);
        if (existing) return existing;
        const entries = await inboxEntries(run);
        await consume(ctx, entries);
        const pending = entries
          .filter((entry) => entry.ack?.state === "accepted")
          .map((entry) => entry.message);
        await atomicWrite(join(dirname(run.paths.run), "takeover-messages.json"), pending);
        await updateActivity(run.id, (activity) => {
          activity.parked = null;
          activity.readyToWake = false;
        });
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
