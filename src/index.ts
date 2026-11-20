import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import type {
  ExtensionAPI,
  ExtensionContext,
  MessageRenderer,
  Theme,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { registerCommands, statusLine } from "./commands.ts";
import {
  attachToRun,
  coalesceDelayMs,
  ConcurrencyGate,
  deliveredRunIds,
  formatRunResult,
  LaunchInput,
  launchSubagent,
  packBatchResults,
  RESULTS_TYPE,
  type ActiveRun,
  type BatchSummary,
} from "./launch.ts";
import { registerReporter } from "./reporter.ts";
import { RexEvents } from "./rex.ts";
import {
  cleanupOldRuns,
  errorText,
  isTerminal,
  listRuns,
  readResult,
  readRun,
  type RunRecord,
} from "./store.ts";

const ENTRY = fileURLToPath(import.meta.url);
const RUNTIME_CHANNEL = "pi-rex-subagents:runtime";

interface ResultsDetails {
  runIds: string[];
  summaries?: BatchSummary[];
}

export interface SubagentToolDetails {
  runId: string;
  label?: string;
  status?: RunRecord["status"];
  mode?: "read" | "worktree" | "write";
  background?: boolean;
  elapsedMs?: number;
  worktreeBranch?: string;
  worktreeKept?: string;
  preview?: string;
}

const ControlInput = Type.Object(
  {
    operation: Type.Union([Type.Literal("list"), Type.Literal("wait"), Type.Literal("cancel")]),
    runId: Type.Optional(Type.String()),
    runIds: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 30 })),
    timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 3600 })),
  },
  { additionalProperties: false },
);

/** Prevents duplicate registration if loaded twice; /reload resets listeners cleanly. */
function claimRuntime(events: ExtensionAPI["events"]): boolean {
  let claimed = false;
  const probe = events.on(RUNTIME_CHANNEL, (data) => {
    if (data && typeof data === "object" && "pong" in data && data.pong === true) claimed = true;
  });
  events.emit(RUNTIME_CHANNEL, { ping: true });
  probe();
  if (claimed) return false;
  events.on(RUNTIME_CHANNEL, (data) => {
    if (data && typeof data === "object" && "ping" in data && data.ping === true) {
      events.emit(RUNTIME_CHANNEL, { pong: true });
    }
  });
  return true;
}

function wrapPlain(text: string, maxWidth: number): string[] {
  const width = Math.max(10, maxWidth);
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    if (raw.length <= width) {
      out.push(raw);
      continue;
    }
    let rest = raw;
    while (rest.length > width) {
      out.push(rest.slice(0, width));
      rest = rest.slice(width);
    }
    if (rest) out.push(rest);
  }
  return out;
}

function formatDuration(ms: number | undefined): string {
  if (ms === undefined || ms < 0) return "";
  if (ms < 1000) return `${ms}ms`;
  const secs = ms / 1000;
  return secs < 60 ? `${secs.toFixed(1)}s` : `${Math.floor(secs / 60)}m${Math.round(secs % 60)}s`;
}

function makeTextComponent(buildLines: (width: number) => string[]) {
  return {
    invalidate() {},
    render(width: number): string[] {
      return buildLines(width);
    },
  };
}

/**
 * Quiet 1-line renderer for background subagent deliveries, replacing Pi's default
 * full-width purple custom-message box. Press Ctrl+O to inspect the raw payload.
 */
export const renderSubagentResults: MessageRenderer<ResultsDetails> = (message, options, theme) => {
  const summaries = message.details?.summaries ?? [];
  const count = summaries.length || message.details?.runIds?.length || 1;
  const list = summaries.length
    ? summaries.map((s) => `${s.label} (${s.status})`).join(", ")
    : `${count} run(s)`;
  const pad = " ".repeat(Math.max(0, options.outputPad));
  const hint = options.expanded ? "" : ` (${options.keyHint("app.tools.expand", "to expand")})`;

  return makeTextComponent((width) => {
    const innerWidth = Math.max(10, width - pad.length * 2);
    const headerPlain = `↳ subagents finished: ${list}`;
    const clipped =
      headerPlain.length > innerWidth
        ? `${headerPlain.slice(0, Math.max(1, innerWidth - 1))}…`
        : headerPlain;
    const lines = [`${pad}${theme.fg("muted", clipped)}${hint}`];
    if (!options.expanded) return lines;

    const raw =
      typeof message.content === "string"
        ? message.content
        : message.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n");
    lines.push("");
    for (const line of wrapPlain(raw, innerWidth)) {
      lines.push(`${pad}${theme.fg("dim", line)}`);
    }
    return lines;
  });
};

export const renderSubagentCall: NonNullable<
  ToolDefinition<typeof LaunchInput, SubagentToolDetails>["renderCall"]
> = (args, theme) => {
  const tags: string[] = [];
  if (args?.readOnly) tags.push("read");
  else if (args?.worktree) tags.push("worktree");
  if (args?.background) tags.push("bg");
  if (args?.placement && args.placement !== "tab") tags.push(args.placement);
  const label = args?.label?.trim() || "subagent";
  const badge = tags.length ? ` ${theme.fg("muted", `[${tags.join(" · ")}]`)}` : "";
  const firstLine = (args?.task ?? "").trim().split("\n")[0]?.trim() ?? "";

  return makeTextComponent((width) => {
    const lines = [`${theme.fg("toolTitle", theme.bold("subagent"))} ${label}${badge}`];
    if (firstLine) {
      const clipped =
        firstLine.length > Math.max(10, width - 2)
          ? `${firstLine.slice(0, Math.max(1, width - 3))}…`
          : firstLine;
      lines.push(theme.fg("dim", `  ${clipped}`));
    }
    return lines;
  });
};

export const renderSubagentResult: NonNullable<
  ToolDefinition<typeof LaunchInput, SubagentToolDetails>["renderResult"]
> = (result, options, theme) => {
  const details = result.details;
  const rawText = result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");

  return makeTextComponent((width) => {
    const inner = Math.max(10, width - 2);
    if (options.isPartial) {
      const status = rawText.trim() || "running…";
      return [theme.fg("muted", `  ▸ ${status.slice(0, inner)}`)];
    }

    if (options.expanded) {
      return wrapPlain(rawText, inner).map((line) => `  ${theme.fg("toolOutput", line)}`);
    }

    if (details?.background) {
      const wt = details.worktreeBranch ? ` · ${details.worktreeBranch}` : "";
      return [theme.fg("muted", `  ↳ running in background${wt}`)];
    }

    const ok = details?.status === "completed";
    const icon = ok ? "✓" : details?.status === "taken_over" ? "↗" : "✗";
    const color: Parameters<Theme["fg"]>[0] = ok
      ? "success"
      : details?.status === "taken_over"
        ? "warning"
        : "error";
    const dur = formatDuration(details?.elapsedMs);
    const meta = [details?.status ?? "done", dur].filter(Boolean).join(" · ");
    const lines = [`  ${theme.fg(color, icon)} ${theme.fg("muted", meta)}`];
    if (details?.worktreeBranch) {
      const note = details.worktreeKept ? ` (${details.worktreeKept})` : " (cleaned up)";
      lines.push(theme.fg("dim", `  branch: ${details.worktreeBranch}${note}`));
    }
    if (details?.preview) {
      for (const line of wrapPlain(details.preview, inner).slice(0, 3)) {
        lines.push(`  ${theme.fg("toolOutput", line)}`);
      }
    }
    return lines;
  });
};

export default async function (pi: ExtensionAPI): Promise<void> {
  if (!claimRuntime(pi.events)) return;

  // Child subagent process: register only the lightweight reporter (flat depth = 1).
  const childRunId = process.env.PI_SUBAGENTS_RUN_ID;
  if (childRunId) {
    const run = await readRun(childRunId);
    registerReporter(pi, run);
    return;
  }

  pi.registerMessageRenderer<ResultsDetails>(RESULTS_TYPE, renderSubagentResults);

  const events = new RexEvents();
  const gate = new ConcurrencyGate();
  const liveRuns = new Map<string, ActiveRun>();
  const inflightDeliveries = new Set<string>();
  let context: ExtensionContext | undefined;
  let coalesceTimer: ReturnType<typeof setTimeout> | undefined;

  const updateWidget = () => {
    if (!context) return;
    const active = [...liveRuns.values()]
      .map((entry) => entry.run)
      .sort(
        (a, b) =>
          Number(Boolean(b.waiting)) - Number(Boolean(a.waiting)) || a.createdAt - b.createdAt,
      );
    context.ui.setWidget(
      "subagents",
      active.length ? active.slice(0, 15).map(statusLine) : undefined,
    );
  };

  const notifyWaiting = (run: RunRecord) => {
    if (!context || !run.waiting) return;
    const notice = `${run.label} is waiting (${run.waiting.title}). Run /subagents go ${run.label}`;
    context.ui.notify(notice, "warning");
  };

  const collectPending = async (ctx: ExtensionContext) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const delivered = deliveredRunIds(ctx.sessionManager.getBranch());
    for (const id of inflightDeliveries) if (delivered.has(id)) inflightDeliveries.delete(id);

    const ready: { run: RunRecord; result: Awaited<ReturnType<typeof readResult>> }[] = [];
    for (const run of await listRuns()) {
      if (run.parentSessionId !== sessionId || !run.background || !isTerminal(run.status)) continue;
      if (delivered.has(run.id) || inflightDeliveries.has(run.id)) continue;
      ready.push({ run, result: await readResult(run.id) });
    }
    if (ready.length === 0) return null;
    const packed = packBatchResults(ready);
    if (packed.runIds.length === 0) return null;
    for (const id of packed.runIds) inflightDeliveries.add(id);
    return packed;
  };

  const deliverPending = async (ctx: ExtensionContext, triggerTurn: boolean) => {
    const packed = await collectPending(ctx);
    if (!packed) return;
    pi.sendMessage(
      {
        customType: RESULTS_TYPE,
        content: packed.content,
        display: true,
        details: { runIds: packed.runIds, summaries: packed.summaries },
      },
      { triggerTurn, deliverAs: "followUp" },
    );
  };

  const scheduleDelivery = () => {
    if (!context || !context.isIdle() || coalesceTimer) return;
    coalesceTimer = setTimeout(() => {
      coalesceTimer = undefined;
      if (context?.isIdle()) void deliverPending(context, true);
    }, coalesceDelayMs());
  };

  const injectAtBoundary = async (ctx: ExtensionContext, outcome: string) => {
    if (outcome === "aborted") return;
    const packed = await collectPending(ctx);
    if (!packed) return;
    clearTimeout(coalesceTimer);
    coalesceTimer = undefined;
    return {
      entries: [
        {
          type: "custom_message" as const,
          customType: RESULTS_TYPE,
          content: packed.content,
          display: true,
          details: { runIds: packed.runIds, summaries: packed.summaries },
        },
      ],
      continue: true,
    };
  };

  pi.on("session_start", async (event, ctx) => {
    context = ctx;
    void cleanupOldRuns().catch(() => undefined);

    if (event.reason === "reload") {
      const sessionId = ctx.sessionManager.getSessionId();
      for (const run of await listRuns()) {
        if (run.parentSessionId !== sessionId || !run.background || isTerminal(run.status))
          continue;
        const handle = attachToRun({
          run,
          events,
          liveRuns,
          onChange: updateWidget,
          onWaiting: notifyWaiting,
        });
        void handle.done.then(() => scheduleDelivery());
      }
    }
    updateWidget();
    await deliverPending(ctx, ctx.isIdle());
  });

  // Deliver finished background results right inside the active loop before the model wraps up.
  pi.on("turn_end", async (event, ctx) => {
    context = ctx;
    return injectAtBoundary(ctx, event.outcome);
  });

  pi.on("agent_before_settle", async (event, ctx) => {
    context = ctx;
    return injectAtBoundary(ctx, event.outcome);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    context = ctx;
    clearTimeout(coalesceTimer);
    coalesceTimer = undefined;
    await deliverPending(ctx, true);
  });

  pi.on("session_shutdown", async (event, ctx) => {
    clearTimeout(coalesceTimer);
    coalesceTimer = undefined;
    if (event.reason !== "reload") {
      const toCancel = [...liveRuns.values()].filter(
        (entry) => !entry.run.background || event.reason === "quit",
      );
      await Promise.all(toCancel.map((entry) => entry.cancel()));
      await deliverPending(ctx, false);
    }
    events.stop();
    context = undefined;
  });

  registerCommands(pi, liveRuns, updateWidget);

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description:
      "Delegate a task to a fresh interactive Pi session in an unfocused Rex tab (closes automatically when done). Multiple foreground calls in one turn run in parallel — prefer the default foreground mode whenever you need the results for your reply. Use background: true only when the user wants to keep chatting while a long task runs. Use worktree: true for parallel writers in the same git repository, and readOnly: true for research. Default placement is tab; only set placement (split, float, detached) when the user explicitly asks for that layout. Returns Rex session/block IDs so you can also inspect or arrange panes with the rex CLI.",
    parameters: LaunchInput,
    renderCall: renderSubagentCall,
    renderResult: renderSubagentResult,
    async execute(_id, input, signal, onUpdate, ctx) {
      context = ctx;
      const handle = await launchSubagent({
        input,
        ctx,
        entry: ENTRY,
        events,
        gate,
        liveRuns,
        signal,
        onChange: (run) => {
          updateWidget();
          onUpdate?.({
            content: [{ type: "text", text: statusLine(run) }],
            details: { runId: run.id, label: run.label, status: run.status },
          });
        },
        onWaiting: notifyWaiting,
      });

      const mode: SubagentToolDetails["mode"] = handle.run.readOnly
        ? "read"
        : handle.run.worktree
          ? "worktree"
          : "write";

      if (handle.run.background) {
        void handle.done.then(() => scheduleDelivery());
        const rexInfo = handle.run.rex
          ? ` (Rex session=${handle.run.rex.sessionId} block=${handle.run.rex.blockId})`
          : "";
        const wtInfo = handle.run.worktree
          ? ` in worktree ${handle.run.worktree.path} (${handle.run.worktree.branch})`
          : "";
        return {
          content: [
            {
              type: "text" as const,
              text: `Started background subagent ${handle.run.id} (${handle.run.label})${wtInfo}${rexInfo}. Its result will arrive automatically when it finishes.`,
            },
          ],
          details: {
            runId: handle.run.id,
            label: handle.run.label,
            status: handle.run.status,
            mode,
            background: true,
            worktreeBranch: handle.run.worktree?.branch,
          },
        };
      }

      const outcome = await handle.done;
      const preview = (outcome.result?.assistantText ?? outcome.run.diagnostic ?? "").trim();
      return {
        content: [{ type: "text" as const, text: formatRunResult(outcome.run, outcome.result) }],
        details: {
          runId: outcome.run.id,
          label: outcome.run.label,
          status: outcome.run.status,
          mode,
          background: false,
          elapsedMs: Math.max(0, (outcome.run.finishedAt ?? Date.now()) - outcome.run.createdAt),
          worktreeBranch: outcome.run.worktree?.branch,
          worktreeKept: outcome.run.worktree?.keptReason,
          preview: preview ? preview.split("\n").slice(0, 4).join("\n").slice(0, 300) : undefined,
        },
      };
    },
  });

  pi.registerTool({
    name: "subagent_control",
    label: "Subagent Control",
    description:
      "Inspect or manage this session's subagents: list (shows status, worktree, and Rex IDs), wait (blocks until named runs finish or timeoutSeconds elapses), or cancel (stops a running subagent unless taken over by the user).",
    parameters: ControlInput,
    async execute(_id, input, signal, _onUpdate, ctx) {
      const sessionId = ctx.sessionManager.getSessionId();
      const owned = (await listRuns()).filter((r) => r.parentSessionId === sessionId);

      if (input.operation === "list") {
        const summary = owned.slice(-30).map((run) => ({
          runId: run.id,
          label: run.label,
          status: run.status,
          readOnly: run.readOnly,
          background: run.background,
          placement: run.placement,
          waiting: run.waiting,
          rex: run.rex,
          worktree: run.worktree ? { path: run.worktree.path, branch: run.worktree.branch } : null,
          elapsedMs: Math.max(0, (run.finishedAt ?? Date.now()) - run.createdAt),
        }));
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ runs: summary }, null, 2) }],
          details: undefined,
        };
      }

      if (input.operation === "cancel") {
        const target = owned.find((r) => r.id === input.runId);
        if (!target) {
          return {
            content: [{ type: "text" as const, text: "cancel refused: unknown runId" }],
            details: undefined,
          };
        }
        const active = liveRuns.get(target.id);
        if (!active) {
          return {
            content: [
              { type: "text" as const, text: `Run ${target.id} is already ${target.status}` },
            ],
            details: undefined,
          };
        }
        const outcome = await active.cancel();
        updateWidget();
        return {
          content: [
            {
              type: "text" as const,
              text:
                outcome === "taken_over"
                  ? `Run ${target.id} was taken over by the user and left running.`
                  : `Cancelled run ${target.id} (${target.label}).`,
            },
          ],
          details: undefined,
        };
      }

      // operation === "wait"
      const ids = [...new Set(input.runIds ?? (input.runId ? [input.runId] : []))];
      const unknown = ids.filter((id) => !owned.some((r) => r.id === id));
      if (ids.length === 0 || unknown.length > 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `wait refused: invalid runIds${unknown.length ? ` (${unknown.join(", ")})` : ""}`,
            },
          ],
          details: { runIds: [] },
        };
      }

      const deadline = Date.now() + (input.timeoutSeconds ?? 600) * 1000;
      const doneItems = new Map<
        string,
        { run: RunRecord; result: Awaited<ReturnType<typeof readResult>> }
      >();
      while (doneItems.size < ids.length && Date.now() < deadline && !signal?.aborted) {
        for (const id of ids) {
          if (doneItems.has(id)) continue;
          try {
            const run = await readRun(id);
            if (isTerminal(run.status)) {
              doneItems.set(id, { run, result: await readResult(id) });
            }
          } catch (error) {
            return {
              content: [{ type: "text" as const, text: `wait error: ${errorText(error)}` }],
              details: { runIds: [...doneItems.keys()] },
            };
          }
        }
        if (doneItems.size === ids.length) break;
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        await delay(Math.min(400, remaining), undefined, { signal }).catch(() => undefined);
      }

      const packed = packBatchResults(ids.flatMap((id) => doneItems.get(id) ?? []));
      const pending = ids.filter((id) => !packed.runIds.includes(id));
      const suffix = pending.length
        ? `\n\nStill running: ${pending.join(", ")}. Their results will arrive automatically.`
        : "";
      return {
        content: [
          { type: "text" as const, text: (packed.content || "No runs finished yet.") + suffix },
        ],
        details: { runIds: packed.runIds },
      };
    },
  });
}
