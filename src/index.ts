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
import { park, readLimits, wake, writerOnPath } from "./admission.ts";
import { canonicalTarget, checkoutRoot } from "./checkout.ts";
import { ownedRuns, registerControl, treeOrder } from "./control.ts";
import { live, registerSubagentsCommand, statusLine } from "./commands.ts";
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
import { cleanupRuns, markDelivered } from "./retention.ts";
import { workingDirectory } from "./settings.ts";
import { clearEligible, closeDecision, dismiss } from "./terminals.ts";
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
import { RexEvents } from "./rex.ts";
import { resultText } from "./results.ts";

type TabView = NonNullable<Awaited<ReturnType<typeof clearEligible>>>;

const retentionStarted = Symbol.for("pi-rex-subagents.retention-started");
const entry = fileURLToPath(import.meta.url);
const waitingFirst = (a: RunRecord, b: RunRecord) =>
  Number(Boolean(b.waiting)) - Number(Boolean(a.waiting)) || a.createdAt - b.createdAt;
export function attentionText(run: RunRecord): string {
  return `${statusLine(run)}. Open /subagents go ${run.label}.${run.waiting?.kind === "project_trust" ? ' Pi’s "Trust parent folder" option can cover later worktrees under that root.' : ""}`;
}
/** A checkout or capacity queue is not a human wait and must not raise an attention notice. */
export function progressUpdate(run: RunRecord): { text: string; attention: string | null } {
  const attention = run.waiting ? attentionText(run) : null;
  return { text: attention ?? statusLine(run), attention };
}

/** A top-level parent is refused only by writers; a nested member by any descendant (the spec). */
function refusesParentEdits(access: unknown): boolean {
  return Boolean(process.env.PI_SUBAGENTS_RUN_ID) || (access !== "read" && access !== "inspect");
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
      if (!refusesParentEdits(part.arguments.access)) continue;
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
    const guards = refusesParentEdits(input.access);
    if (guards)
      intended.set(event.toolCallId, {
        id: event.toolCallId,
        label: input.label?.trim() || "pending launch",
        checkoutRoot: await checkoutRoot(await workingDirectory(ctx.cwd, input.cwd)),
      });
    const run = await prepareRun(input, ctx, event.parentToolCallId);
    if (guards)
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
      await writeRun(run);
    }
  });
  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("edit", event) && !isToolCallEventType("write", event)) return;
    // Another extension's edit or write tool may name its targets inside an edit script. Like
    // bash, a call whose targets can't be known in advance is not refused.
    const path: unknown = event.input.path;
    if (typeof path !== "string") return;
    try {
      const target = await canonicalTarget(ctx.cwd, path);
      const writer =
        (await sameMessageWriter(ctx, target)) ??
        [...intended.values()].find((run) => contains(run.checkoutRoot, target)) ??
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
  const sessionRuns = (ctx: ExtensionContext, records: RunRecord[]) =>
    records.filter((run) => run.parentSessionId === ctx.sessionManager.getSessionId());
  const views = async (ctx: ExtensionContext, records: RunRecord[]) => {
    const delivered = deliveredRunIds(ctx.sessionManager.getBranch());
    return Promise.all(
      sessionRuns(ctx, records).map(async (run) => {
        if (run.background && delivered.has(run.id)) await markDelivered(run);
        return transitionView(run, await readClaim(run.paths.claim), delivered);
      }),
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
    for (const run of sessionRuns(ctx, await listRuns())) {
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
    if (!blocksReplacement(await views(ctx, await listRuns()), ctx.sessionManager.getSessionId()))
      return;
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
  const autoClose = async (runs: RunRecord[], tabs: Map<string, TabView>) => {
    const graceMs = (await readLimits()).closeCompletedAfterMs;
    if (graceMs === null) return;
    for (const run of runs) {
      const tab = tabs.get(run.id);
      if (!tab) {
        closing.delete(run.id);
        continue;
      }
      const now = Date.now();
      const state = closing.get(run.id) ?? { eligibleSince: now, lastViewedAt: null };
      closing.set(run.id, state);
      const looking = tab.viewing;
      if (looking) state.lastViewedAt = now;
      if (closeDecision({ ...state, viewing: looking, now, graceMs }) === "close") {
        await dismiss(run);
        tabs.delete(run.id);
        closing.delete(run.id);
      }
    }
  };
  const refresh = async (ctx: ExtensionContext) => {
    if (refreshing) return;
    refreshing = true;
    try {
      // Cleanup can remove records that tab reconciliation would otherwise write back.
      await (Reflect.get(globalThis, retentionStarted) as Promise<void> | undefined);
      const records = await listRuns();
      const runs = ownedRuns(records, ctx.sessionManager.getSessionId());
      for (const run of runs) {
        if (isTerminal(run.lifecycle) && run.process.state !== "exited" && run.rex) {
          await reconcile(run);
          await writeRun(run);
        }
      }
      const sessions = new Map<string, Record<string, unknown>>();
      const tabs = new Map<string, TabView>();
      for (const run of runs) {
        const tab = await clearEligible(run, sessions);
        if (tab) tabs.set(run.id, tab);
      }
      await autoClose(runs, tabs);
      const lines = treeOrder(runs.filter(live)).slice(0, 20).map(statusLine);
      const clearable = tabs.size;
      if (clearable)
        lines.push(`${clearable} exited completed child terminal(s): /subagents clear`);
      const pending = (await views(ctx, records)).filter((run) =>
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
    if (!childId && !Reflect.has(globalThis, retentionStarted)) {
      const cleanup = (async () => {
        await views(ctx, await listRuns());
        await cleanupRuns();
      })().catch((error: unknown) => {
        ctx.ui.setStatus("subagents", `Subagent records: ${errorText(error)}`);
      });
      Reflect.set(globalThis, retentionStarted, cleanup);
    }
    widget = setInterval(() => {
      void refresh(ctx);
    }, 2000);
    if (event.reason === "reload") {
      for (const run of sessionRuns(ctx, await listRuns())) {
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
  registerSubagentsCommand(pi, { refresh, views });
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
