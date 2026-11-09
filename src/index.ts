import { realpath } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  isToolCallEventType,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { contains } from "./admission-core.ts";
import { closeCompletedAfterMs, park, readLimits, wake, writerOnPath } from "./admission.ts";
import { canonicalTarget, checkoutRoot } from "./checkout.ts";
import { cancelControlled, ownedRuns, registerControl, treeOrder } from "./control.ts";
import { readClaim } from "./claims.ts";
import {
  DELIVERY_NOTE,
  NOTE_TYPE,
  RESULTS_TYPE,
  blocksReplacement,
  coalesceDelay,
  deliveredRunIds,
  endsWithUnansweredDelivery,
  nextDelivery,
  outcomeOf,
  packDelivery,
  shouldAppend,
  shouldCancel,
  transitionView,
} from "./delivery.ts";
import { claimRuntime } from "./load-guard.ts";
import { workingDirectory } from "./settings.ts";
import { clearEligible, closeDecision, dismiss, viewing } from "./terminals.ts";
import { registerReporter } from "./reporter.ts";
import {
  errorText,
  isTerminal,
  listRuns,
  parse,
  readRun,
  runDirectory,
  transition,
  writeRun,
  type RunRecord,
} from "./records.ts";
import {
  CANCELLATION_MS,
  LaunchInput,
  cancel,
  prepareRun,
  reconcile,
  runForeground,
  startBackground,
} from "./launch.ts";
import { RexEvents, locate, object, rexJson } from "./rex.ts";
import { cappedText, resultText } from "./results.ts";

const entry = fileURLToPath(import.meta.url);
const live = (run: RunRecord) => !isTerminal(run.lifecycle) || run.process.state !== "exited";
const waitingFirst = (a: RunRecord, b: RunRecord) =>
  Number(Boolean(b.waiting)) - Number(Boolean(a.waiting)) || a.createdAt - b.createdAt;
export function statusLine(run: RunRecord): string {
  const human = run.waiting
    ? `waiting for a human: ${run.waiting.kind} — ${run.waiting.title}`
    : null;
  const queued = run.queue ? `queued for ${run.queue.reason}: ${run.queue.detail}` : null;
  const indent = "  ".repeat(Math.max(0, run.depth - 1));
  return `${indent}${run.label} [${run.access}] ${[human, queued, run.activity?.parked ? `parked (${run.activity.parked})` : null].filter(Boolean).join("; ") || run.lifecycle}`;
}
export function attentionText(run: RunRecord): string {
  return `${statusLine(run)}. Open /subagents go ${run.label}.${run.waiting?.kind === "project_trust" ? ' Pi’s "Trust parent folder" option can cover later worktrees under that root.' : ""}`;
}
/** A checkout or capacity queue is not a human wait and must not raise an attention notice. */
export function progressUpdate(run: RunRecord): { text: string; attention: string | null } {
  const attention = run.waiting ? attentionText(run) : null;
  return { text: attention ?? statusLine(run), attention };
}

async function sameMessageWriter(
  ctx: ExtensionContext,
  target: string,
): Promise<{ id: string; label: string; checkoutRoot: string } | null> {
  // Preflight prepares each call before the next start, so a write listed first must still
  // see later launches in this assistant message.
  for (const entry of ctx.sessionManager.getBranch().toReversed()) {
    if (entry.type !== "message") continue;
    if (entry.message.role !== "assistant" || !Array.isArray(entry.message.content)) return null;
    for (const part of entry.message.content) {
      if (part.type !== "toolCall" || part.name !== "subagent") continue;
      const access = part.arguments.access;
      if (!process.env.PI_SUBAGENTS_RUN_ID && (access === "read" || access === "inspect")) continue;
      const label =
        typeof part.arguments.label === "string" && part.arguments.label.trim()
          ? part.arguments.label.trim()
          : "pending launch";
      const cwd = typeof part.arguments.cwd === "string" ? part.arguments.cwd : undefined;
      const root = await checkoutRoot(await workingDirectory(ctx.cwd, cwd));
      if (contains(root, target)) return { id: part.id, label, checkoutRoot: root };
    }
    return null;
  }
  return null;
}
export default async function (pi: ExtensionAPI): Promise<void> {
  if (!claimRuntime(pi.events)) return;
  const childId = process.env.PI_SUBAGENTS_RUN_ID;
  if (childId || process.env.PI_SUBAGENTS_RUN_DIR) {
    if (
      !childId ||
      !process.env.PI_SUBAGENTS_RUN_DIR ||
      (await realpath(process.env.PI_SUBAGENTS_RUN_DIR)) !== (await realpath(runDirectory(childId)))
    )
      throw new Error("Invalid managed child run environment");
    const run = await readRun(childId);
    if ((await realpath(dirname(run.paths.run))) !== (await realpath(runDirectory(childId))))
      throw new Error("Child record path mismatch");
    registerReporter(pi, run);
    if (run.access === "read" || run.depth >= (await readLimits()).depth) return;
  }
  registerControl(pi);
  const events = new RexEvents();
  const active = new Map<string, RunRecord>();
  const watches = new Map<string, AbortController>();
  const handed = new Set<string>();
  const inflight = new Set<string>();
  const prepared = new Map<string, RunRecord>();
  // The runner swallows a start-handler error, so record the checkout before prepareRun can throw.
  // A rejected launch in this message must still refuse a sibling edit or write.
  const intended = new Map<string, { id: string; label: string; checkoutRoot: string }>();
  pi.on("tool_execution_start", async (event, ctx) => {
    if (event.toolName !== "subagent") return;
    const input = parse(LaunchInput, event.args);
    const root = await checkoutRoot(await workingDirectory(ctx.cwd, input.cwd));
    intended.set(event.toolCallId, {
      id: event.toolCallId,
      label: input.label?.trim() || "pending launch",
      checkoutRoot: root,
    });
    const run = await prepareRun(input, ctx, event.parentToolCallId);
    intended.set(event.toolCallId, {
      id: run.id,
      label: run.label,
      checkoutRoot: run.checkoutRoot,
    });
    prepared.set(event.toolCallId, run);
    active.set(run.id, run);
  });
  pi.on("tool_execution_end", async (event) => {
    intended.delete(event.toolCallId);
    const run = prepared.get(event.toolCallId);
    if (!run) return;
    prepared.delete(event.toolCallId);
    active.delete(run.id);
    // A handed-off background run stays admitting while queued. The watcher owns it.
    if (handed.delete(event.toolCallId)) return;
    // A blocked or aborted preflight never executes the launch tool.
    if (run.lifecycle === "admitting") {
      await cancel(run);
      transition(run, "cancelled");
      run.process = { state: "exited", code: null };
      run.waiting = null;
      run.queue = null;
      await writeRun(run);
    }
  });
  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("edit", event) && !isToolCallEventType("write", event)) return;
    try {
      const target = await canonicalTarget(ctx.cwd, event.input.path);
      const writer =
        (await sameMessageWriter(ctx, target)) ??
        [...intended.values()].find((run) => contains(run.checkoutRoot, target)) ??
        [...active.values()].find(
          (run) =>
            run.access === "write" &&
            run.lifecycle === "admitting" &&
            contains(run.checkoutRoot, target),
        ) ??
        (await writerOnPath(target, childId));
      if (writer)
        return {
          block: true,
          reason: `Child writer ${writer.id} (${writer.label}) holds checkout ${writer.checkoutRoot}; parent edit/write refused`,
        };
    } catch (error) {
      return { block: true, reason: `Cannot check child writer guard: ${errorText(error)}` };
    }
    return;
  });
  let widget: ReturnType<typeof setInterval> | undefined;
  let refreshing = false;
  let context: ExtensionContext | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const notices = new Map<string, string>();
  const sessionRuns = async (ctx: ExtensionContext) =>
    (await listRuns()).filter((run) => run.parentSessionId === ctx.sessionManager.getSessionId());
  const views = async (ctx: ExtensionContext) => {
    const delivered = deliveredRunIds(ctx.sessionManager.getBranch());
    return Promise.all(
      (await sessionRuns(ctx)).map(async (run) =>
        transitionView(run, await readClaim(run.paths.claim), delivered),
      ),
    );
  };
  const clearTimer = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const deliver = async (
    ctx: ExtensionContext,
    source: "settled" | "timer" | "reconcile" | "append",
  ) => {
    const branch = ctx.sessionManager.getBranch();
    if (childId) return;
    const delivered = deliveredRunIds(branch);
    for (const id of inflight) if (delivered.has(id)) inflight.delete(id);
    const pending = [];
    for (const run of await sessionRuns(ctx)) {
      const claim = await readClaim(run.paths.claim);
      const view = transitionView(run, claim, delivered);
      if (!shouldAppend(view, ctx.sessionManager.getSessionId()) || inflight.has(run.id)) continue;
      pending.push(await outcomeOf(run, claim));
    }
    const idle = ctx.isIdle();
    const action = nextDelivery({
      idle,
      pending: pending.length > 0,
      unanswered: endsWithUnansweredDelivery(branch),
      source,
    });
    if (action === "wait" || action === "none") return;
    clearTimer();
    if (action === "note") {
      pi.sendMessage(
        { customType: NOTE_TYPE, content: DELIVERY_NOTE, display: true },
        { triggerTurn: true, deliverAs: "followUp" },
      );
      return;
    }
    const packed = packDelivery(pending);
    if (!packed.runIds.length) return;
    for (const id of packed.runIds) inflight.add(id);
    pi.sendMessage(
      {
        customType: RESULTS_TYPE,
        content: packed.content,
        display: true,
        details: { runIds: packed.runIds },
      },
      { triggerTurn: source !== "append" && idle, deliverAs: "followUp" },
    );
  };
  const noteFinished = () => {
    if (!context || timer) return;
    if (
      nextDelivery({
        idle: context.isIdle(),
        pending: true,
        unanswered: false,
        source: "finished",
      }) !== "wait"
    )
      return;
    timer = setTimeout(() => {
      timer = undefined;
      if (context) void deliver(context, "timer");
    }, coalesceDelay());
  };
  const detachWatches = () => {
    for (const detach of watches.values()) detach.abort();
    watches.clear();
  };
  const follow = (
    run: RunRecord,
    signal?: AbortSignal,
    resume = false,
    progress: (run: RunRecord) => void = () => {},
  ) => {
    const detach = new AbortController();
    const linked = new AbortController();
    const onAbort = () => linked.abort();
    if (signal) {
      if (signal.aborted) linked.abort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    const started = startBackground(
      run,
      entry,
      events,
      signal ? linked.signal : undefined,
      progress,
      {
        detach: detach.signal,
        resume,
      },
    );
    watches.set(run.id, detach);
    void started.done.then(
      () => {
        watches.delete(run.id);
        signal?.removeEventListener("abort", onAbort);
        if (!detach.signal.aborted) noteFinished();
      },
      (error: unknown) => {
        watches.delete(run.id);
        void readRun(run.id)
          .then(async (current) => {
            current.diagnostic = errorText(error);
            if (!isTerminal(current.lifecycle)) transition(current, "failed");
            await writeRun(current);
          })
          .catch(() => undefined);
      },
    );
    return {
      ready: started.ready,
      detach,
      release: () => signal?.removeEventListener("abort", onAbort),
    };
  };
  const cancelOwned = async (sessionId: string) => {
    for (const run of await listRuns()) {
      const claim = await readClaim(run.paths.claim);
      if (shouldCancel(transitionView(run, claim, new Set()), sessionId)) await cancel(run);
    }
    const deadline = Date.now() + CANCELLATION_MS;
    while (Date.now() < deadline) {
      let waiting = false;
      for (const run of await listRuns()) {
        if (run.parentSessionId !== sessionId || !run.background || isTerminal(run.lifecycle))
          continue;
        if ((await readClaim(run.paths.claim)) === "taken_over") continue;
        if (run.process.state === "live" || run.process.state === "unknown" || run.queue !== null) {
          waiting = true;
          break;
        }
      }
      if (!waiting) break;
      await delay(200);
    }
    for (const run of await listRuns()) {
      if (run.parentSessionId !== sessionId || run.process.state !== "live") continue;
      if ((await readClaim(run.paths.claim)) === "taken_over") continue;
      const fresh = await readRun(run.id);
      if (fresh.process.state !== "live") continue;
      fresh.process = { state: "unresolved", pid: fresh.process.pid };
      if (!isTerminal(fresh.lifecycle)) transition(fresh, "cancelled");
      await writeRun(fresh);
    }
  };
  const confirmReplacement = async (ctx: ExtensionContext, kind: string) => {
    if (!blocksReplacement(await views(ctx), ctx.sessionManager.getSessionId())) return;
    const confirmed = await ctx.ui.confirm(
      "Cancel background subagents?",
      `This session has live, queued, or undelivered subagent work. ${kind} cancels parent-owned children and appends their outcomes here. A taken-over child keeps running.`,
    );
    if (!confirmed) return { cancel: true as const };
    await cancelOwned(ctx.sessionManager.getSessionId());
    await deliver(ctx, "append");
    return;
  };
  // Grace and viewing timestamps live in memory: a reload only restarts the grace period.
  const closing = new Map<string, { eligibleSince: number; lastViewedAt: number | null }>();
  const autoClose = async (runs: RunRecord[]) => {
    const graceMs = await closeCompletedAfterMs();
    if (graceMs === null) return;
    for (const run of runs) {
      if (!(await clearEligible(run))) {
        closing.delete(run.id);
        continue;
      }
      const now = Date.now();
      const state = closing.get(run.id) ?? { eligibleSince: now, lastViewedAt: null };
      closing.set(run.id, state);
      const location = run.location ?? run.rex;
      if (!location) continue;
      const looking = await viewing(location);
      if (looking) state.lastViewedAt = now;
      if (closeDecision({ ...state, viewing: looking, now, graceMs }) === "close") {
        await dismiss(run);
        closing.delete(run.id);
      }
    }
  };
  const refresh = async (ctx: ExtensionContext) => {
    if (refreshing) return;
    refreshing = true;
    try {
      const runs = ownedRuns(await listRuns(), ctx.sessionManager.getSessionId());
      for (const run of runs) {
        if (isTerminal(run.lifecycle) && run.process.state !== "exited" && run.rex) {
          await reconcile(run);
          await writeRun(run);
        }
      }
      await autoClose(runs);
      const lines = treeOrder(runs.filter(live)).slice(0, 20).map(statusLine);
      const clearable = (await Promise.all(runs.map(clearEligible))).filter(Boolean).length;
      if (clearable)
        lines.push(`${clearable} exited completed child terminal(s): /subagents clear`);
      const pending = (await views(ctx)).filter((run) =>
        shouldAppend(run, ctx.sessionManager.getSessionId()),
      ).length;
      if (pending) lines.push(`${pending} background result(s) pending delivery`);
      ctx.ui.setWidget("subagents", lines.length ? lines : undefined);
      if (ctx.isIdle() && pending) noteFinished();
    } catch (error) {
      ctx.ui.setStatus("subagents", `Subagent records: ${errorText(error)}`);
    } finally {
      refreshing = false;
    }
  };
  pi.on("session_start", async (event, ctx) => {
    context = ctx;
    widget = setInterval(() => {
      void refresh(ctx);
    }, 2000);
    if (event.reason === "reload") {
      for (const run of await sessionRuns(ctx)) {
        if (!run.background || (await readClaim(run.paths.claim)) === "taken_over") continue;
        if (
          isTerminal(run.lifecycle) &&
          (run.process.state === "exited" || run.process.state === "unresolved")
        )
          continue;
        follow(run, undefined, true);
      }
    }
    void refresh(ctx);
    await deliver(ctx, "reconcile");
  });
  pi.on("session_tree", async (_event, ctx) => {
    context = ctx;
    if (ctx.isIdle()) await deliver(ctx, "reconcile");
  });
  pi.on("agent_settled", async (_event, ctx) => {
    context = ctx;
    await deliver(ctx, "settled");
  });
  pi.on("session_before_switch", async (event, ctx) => confirmReplacement(ctx, event.reason));
  pi.on("session_before_fork", async (_event, ctx) => confirmReplacement(ctx, "fork"));
  pi.on("session_shutdown", async (event, ctx) => {
    clearInterval(widget);
    clearTimer();
    if (event.reason !== "reload") {
      for (const run of active.values()) if (!run.background) await cancel(run);
      if (event.reason === "quit") await cancelOwned(ctx.sessionManager.getSessionId());
      await deliver(ctx, "append");
    }
    detachWatches();
    events.stop();
    context = undefined;
  });
  pi.registerCommand("subagents", {
    description:
      "List this parent's runs; all lists every live child; go <label> selects its tab; go next selects the oldest wait across parents; cancel <label|run-id> cancels a background run",
    handler: async (args, ctx) => {
      const all = treeOrder(await listRuns());
      const owned = ownedRuns(all, ctx.sessionManager.getSessionId());
      if (args === "clear" || args.startsWith("dismiss ")) {
        const target = args.slice("dismiss ".length).trim();
        const selected =
          args === "clear"
            ? (
                await Promise.all(
                  owned.map(async (run) => ((await clearEligible(run)) ? run : null)),
                )
              ).filter((run) => run !== null)
            : owned.filter((run) => run.id === target || run.label === target);
        if (args !== "clear" && selected.length !== 1) {
          ctx.ui.notify(
            "Dismiss requires exactly one child label or run ID belonging to this parent",
            "error",
          );
          return;
        }
        for (const run of selected) await dismiss(run);
        ctx.ui.notify(
          `${selected.length} exited child terminal(s) dismissed; artifacts retained`,
          "info",
        );
        await refresh(ctx);
        return;
      }
      if (args.startsWith("cancel ")) {
        const target = args.slice("cancel ".length).trim();
        const matches = owned.filter((run) => run.id === target || run.label === target);
        if (matches.length !== 1) {
          ctx.ui.notify(
            "Cancel requires exactly one run label or ID belonging to this parent",
            "error",
          );
          return;
        }
        const selected = matches[0];
        if (!selected) return;
        const response = await cancelControlled(selected);
        ctx.ui.notify(
          `${selected.label} (${selected.id}): ${response.status}; ${response.reason}`,
          response.status === "refused" ? "warning" : "info",
        );
        await refresh(ctx);
        return;
      }
      if (args === "go next") {
        const selected = object(
          await rexJson([
            "do",
            fileURLToPath(new URL("../rex/next_waiting.lua", import.meta.url)),
            "--json",
          ]),
        );
        ctx.ui.notify(
          selected.status === "selected"
            ? "Selected the oldest waiting subagent"
            : `No waiting subagent (${String(selected.status)})`,
          selected.status === "selected" ? "info" : "warning",
        );
        return;
      }
      if (args.startsWith("go ")) {
        const label = args.slice(3).trim();
        const matches = all.filter(
          (run) => run.label === label && owned.some((r) => r.id === run.id),
        );
        if (matches.length !== 1 || !matches[0]?.rex) {
          ctx.ui.notify("Label must identify exactly one child with a Rex block", "error");
          return;
        }
        const location = await locate(
          matches[0].rex.blockId,
          matches[0].location ?? matches[0].rex,
        );
        if (!location) {
          ctx.ui.notify("Child block no longer exists; artifacts are retained", "warning");
          return;
        }
        await rexJson([
          "do",
          "session.select",
          `session_id=${location.sessionId}`,
          `window_id=${location.windowId}`,
          "--json",
        ]);
        ctx.ui.notify(`Selected subagent ${matches[0].label}`, "info");
        return;
      }
      if (args && args !== "all") {
        ctx.ui.notify(
          "Usage: /subagents [all | go <label|next> | cancel <label|run-id> | clear | dismiss <label|run-id>]",
          "error",
        );
        return;
      }
      const selected = args === "all" ? all.filter(live) : owned;
      for (const run of selected.slice(0, 30)) {
        if (run.rex) run.location = await locate(run.rex.blockId, run.location ?? run.rex);
      }
      const pending = (await views(ctx)).filter((run) =>
        shouldAppend(run, ctx.sessionManager.getSessionId()),
      ).length;
      const text = cappedText(
        [
          selected
            .slice(0, 30)
            .map((run) =>
              [
                statusLine(run),
                run.parentRunId &&
                all.find((r) => r.id === run.parentRunId)?.process.state === "exited"
                  ? "Orphaned: immediate parent is gone; outcome retained on disk"
                  : "",
                `Run ${run.id}; checkout ${run.checkoutRoot}; model ${run.effective.provider}/${run.effective.model} (${run.effective.thinking})`,
                `Rex ${JSON.stringify(run.location)}; process ${JSON.stringify(run.process)}`,
                `Result ${run.paths.result}; events ${run.paths.events}; session ${run.sessionFile ?? run.paths.sessionDir}`,
              ].join("\n"),
            )
            .join("\n\n") || "No subagents",
          pending ? `${pending} background result(s) pending delivery` : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
      );
      ctx.ui.notify(text, "info");
      pi.sendMessage(
        { customType: "subagents-list", content: text, display: true },
        { triggerTurn: false },
      );
    },
  });
  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description:
      "Delegate one task to a fresh interactive Pi in a background Rex tab. access is read (only read, grep, find, ls, and git_read), inspect (normal tools except edit and write; reports checkout changes), or write. Ask for a short final report; have bulk output written to a file the report names. Inherits model and thinking unless overridden. Output is capped at 50 KB / 2000 lines with the full session path. Foreground waits for the result. Background returns a run ID once admitted or queued and delivers outcomes together after you settle. Nested launches share admission and checkout reservations, to the configured depth. Inspect children default to inspect and cannot launch writers. A member with a live descendant on its checkout cannot edit/write; bash is not blocked. Workflow and model choices remain yours.",
    parameters: LaunchInput,
    async execute(_id, input, signal, onUpdate, ctx) {
      const run = prepared.get(_id) ?? (await prepareRun(input, ctx));
      active.set(run.id, run);
      const progress = (current: RunRecord) => {
        const update = progressUpdate(current);
        onUpdate?.({
          content: [{ type: "text", text: update.text }],
          details: { runId: current.id },
        });
        const previous = notices.get(run.id);
        if (update.attention && update.attention !== previous) {
          ctx.ui.notify(update.attention, "warning");
          pi.sendMessage(
            { customType: "subagent-attention", content: update.attention, display: true },
            { triggerTurn: false },
          );
          notices.set(run.id, update.attention);
        } else if (!update.attention && previous) {
          ctx.ui.notify(`${current.label}: no longer waiting`, "info");
          notices.delete(run.id);
        }
        const lines = [...active.values()]
          .filter(live)
          .sort(waitingFirst)
          .slice(0, 20)
          .map(statusLine);
        ctx.ui.setWidget("subagents", lines.length ? lines : undefined);
      };
      try {
        if (run.background) {
          handed.add(_id);
          const watched = follow(run, signal, false, progress);
          const ready = await watched.ready;
          watched.release();
          if (isTerminal(ready.lifecycle))
            return {
              content: [{ type: "text" as const, text: resultText(ready) }],
              details: { runId: ready.id },
            };
          const state = ready.queue ? `queued for ${ready.queue.reason}` : "admitted";
          return {
            content: [
              {
                type: "text" as const,
                text: `Run ${ready.id} (${ready.label}) is ${state}. The result arrives later.`,
              },
            ],
            details: { runId: ready.id },
          };
        }
        if (childId) await park(childId, "foreground", _id);
        const outcome = await runForeground(run, entry, events, signal, progress);
        return {
          content: [
            {
              type: "text" as const,
              text: resultText(outcome.run, outcome.result, outcome.checkout),
            },
          ],
          details: { runId: run.id },
        };
      } catch (error) {
        handed.delete(_id);
        run.diagnostic = errorText(error);
        if (run.lifecycle === "admitting") await cancel(run);
        // An admitted launch with no reply may still exist in Rex. Never invent exit proof.
        if (run.lifecycle === "admitting") run.process = { state: "exited", code: null };
        if (!isTerminal(run.lifecycle)) transition(run, "failed");
        await writeRun(run);
        throw error;
      } finally {
        active.delete(run.id);
        if (childId && !run.background) await wake(childId, _id);
        if (context) await refresh(context);
      }
    },
  });
}
