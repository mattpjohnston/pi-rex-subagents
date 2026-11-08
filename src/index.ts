import { realpath } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isToolCallEventType,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { contains } from "./admission-core.ts";
import { writerOnPath } from "./admission.ts";
import { canonicalTarget } from "./checkout.ts";
import { clearEligible, dismiss } from "./terminals.ts";
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
import { LaunchInput, cancel, prepareRun, reconcile, runForeground } from "./launch.ts";
import { RexEvents, locate, rexJson } from "./rex.ts";
import { cappedText, resultText } from "./results.ts";

const entry = fileURLToPath(import.meta.url);
const live = (run: RunRecord) => !isTerminal(run.lifecycle) || run.process.state !== "exited";
const waitingFirst = (a: RunRecord, b: RunRecord) =>
  Number(Boolean(b.waiting)) - Number(Boolean(a.waiting)) || a.createdAt - b.createdAt;
export function statusLine(run: RunRecord): string {
  return `${run.label} [${run.access}] ${run.waiting ? (run.waiting.source === "admission" ? `waiting for admission: ${run.waiting.title}` : `waiting for a human: ${run.waiting.kind} — ${run.waiting.title}`) : run.lifecycle}`;
}
export function attentionText(run: RunRecord): string {
  return `${statusLine(run)}. Open /subagents go ${run.label}.${run.waiting?.kind === "project_trust" ? ' Pi’s "Trust parent folder" option can cover later worktrees under that root.' : ""}`;
}

export default async function (pi: ExtensionAPI): Promise<void> {
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
    return;
  }
  const events = new RexEvents();
  const active = new Map<string, RunRecord>();
  const prepared = new Map<string, RunRecord>();
  // Pi emits every sibling start before preflight. Reserve the intended checkout in this
  // runtime too, so a sibling edit cannot race a launch that has not reached admission yet.
  pi.on("tool_execution_start", async (event, ctx) => {
    if (event.toolName !== "subagent") return;
    const run = await prepareRun(parse(LaunchInput, event.args), ctx);
    prepared.set(event.toolCallId, run);
    active.set(run.id, run);
  });
  pi.on("tool_execution_end", async (event) => {
    const run = prepared.get(event.toolCallId);
    if (!run) return;
    prepared.delete(event.toolCallId);
    active.delete(run.id);
    // A blocked or aborted preflight never executes the launch tool.
    if (run.lifecycle === "admitting") {
      await cancel(run);
      transition(run, "cancelled");
      run.process = { state: "exited", code: null };
      run.waiting = null;
      await writeRun(run);
    }
  });
  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("edit", event) && !isToolCallEventType("write", event)) return;
    try {
      const target = await canonicalTarget(ctx.cwd, event.input.path);
      const writer =
        [...active.values()].find(
          (run) =>
            run.access === "write" &&
            run.lifecycle === "admitting" &&
            contains(run.checkoutRoot, target),
        ) ?? (await writerOnPath(target));
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
  const notices = new Map<string, string>();
  const refresh = async (ctx: ExtensionContext) => {
    if (refreshing) return;
    refreshing = true;
    try {
      const runs = (await listRuns()).filter(
        (run) => run.parentSessionId === ctx.sessionManager.getSessionId(),
      );
      for (const run of runs) {
        if (isTerminal(run.lifecycle) && run.process.state !== "exited" && run.rex) {
          await reconcile(run);
          await writeRun(run);
        }
      }
      const lines = runs.filter(live).sort(waitingFirst).slice(0, 20).map(statusLine);
      const clearable = (await Promise.all(runs.map(clearEligible))).filter(Boolean).length;
      if (clearable)
        lines.push(`${clearable} exited completed child terminal(s): /subagents clear`);
      ctx.ui.setWidget("subagents", lines.length ? lines : undefined);
    } catch (error) {
      ctx.ui.setStatus("subagents", `Subagent records: ${errorText(error)}`);
    } finally {
      refreshing = false;
    }
  };
  pi.on("session_start", (_event, ctx) => {
    context = ctx;
    widget = setInterval(() => {
      void refresh(ctx);
    }, 2000);
    void refresh(ctx);
  });
  pi.on("session_shutdown", async () => {
    clearInterval(widget);
    for (const run of active.values()) await cancel(run);
    events.stop();
    context = undefined;
  });
  pi.registerCommand("subagents", {
    description:
      "List this parent's runs; all lists every live child; go <label> selects its current Rex tab",
    handler: async (args, ctx) => {
      const all = (await listRuns()).sort(waitingFirst);
      const owned = all.filter((run) => run.parentSessionId === ctx.sessionManager.getSessionId());
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
      if (args.startsWith("go ")) {
        const label = args.slice(3).trim();
        const matches = all.filter(
          (run) => run.label === label && run.parentSessionId === ctx.sessionManager.getSessionId(),
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
          "Usage: /subagents [all | go <label> | clear | dismiss <label|run-id>]",
          "error",
        );
        return;
      }
      const selected = all.filter((run) =>
        args === "all" ? live(run) : run.parentSessionId === ctx.sessionManager.getSessionId(),
      );
      for (const run of selected.slice(0, 30)) {
        if (run.rex) run.location = await locate(run.rex.blockId, run.location ?? run.rex);
      }
      const text = cappedText(
        selected
          .slice(0, 30)
          .map((run) =>
            [
              statusLine(run),
              `Run ${run.id}; checkout ${run.checkoutRoot}; model ${run.effective.provider}/${run.effective.model} (${run.effective.thinking})`,
              `Rex ${JSON.stringify(run.location)}; process ${JSON.stringify(run.process)}`,
              `Result ${run.paths.result}; events ${run.paths.events}; session ${run.sessionFile ?? run.paths.sessionDir}`,
            ].join("\n"),
          )
          .join("\n\n") || "No subagents",
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
      "Delegate one task to a fresh interactive Pi in a background Rex tab and wait for its outcome. Ask for a short final report; have bulk output written to a file the report names. Inherits the parent's effective model and thinking unless overridden. Output is capped at 50 KB / 2000 lines, with the full session path. Phase 1 supports foreground write children only.",
    parameters: LaunchInput,
    async execute(_id, input, signal, onUpdate, ctx) {
      const run = prepared.get(_id) ?? (await prepareRun(input, ctx));
      active.set(run.id, run);
      const progress = (current: RunRecord) => {
        const text =
          current.waiting && current.waiting.source !== "admission"
            ? attentionText(current)
            : statusLine(current);
        onUpdate?.({ content: [{ type: "text", text }], details: { runId: current.id } });
        const previous = notices.get(run.id);
        if (current.waiting && text !== previous) {
          ctx.ui.notify(text, "warning");
          pi.sendMessage(
            { customType: "subagent-attention", content: text, display: true },
            { triggerTurn: false },
          );
          notices.set(run.id, text);
        } else if (!current.waiting && previous) {
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
        const outcome = await runForeground(run, entry, events, signal, progress);
        return {
          content: [{ type: "text" as const, text: resultText(outcome.run, outcome.result) }],
          details: { runId: run.id },
        };
      } catch (error) {
        run.diagnostic = errorText(error);
        if (run.lifecycle === "admitting") await cancel(run);
        // An admitted launch with no reply may still exist in Rex. Never invent exit proof.
        if (run.lifecycle === "admitting") run.process = { state: "exited", code: null };
        if (!isTerminal(run.lifecycle)) transition(run, "failed");
        await writeRun(run);
        throw error;
      } finally {
        active.delete(run.id);
        if (context) await refresh(context);
      }
    },
  });
}
