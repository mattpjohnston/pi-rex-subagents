import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ActiveRun } from "./launch.ts";
import { closeBlock, focusBlock, locateBlock, observeProcess, rexJson } from "./rex.ts";
import { errorText, isTerminal, listRuns, type RunRecord } from "./store.ts";

export function statusLine(run: RunRecord): string {
  const mode = run.readOnly ? "read" : run.worktree ? "worktree" : "write";
  const detail = run.waiting ? `waiting (${run.waiting.title})` : run.status;
  return `${run.label} [${mode}] ${detail}`;
}

function findUnique(runs: readonly RunRecord[], query: string): RunRecord | null {
  const matches = runs.filter((r) => r.id === query || r.label === query);
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

export function registerCommands(
  pi: ExtensionAPI,
  liveRuns: Map<string, ActiveRun>,
  onUpdate: () => void,
): void {
  pi.registerCommand("subagents", {
    description: "Manage subagents: /subagents [go <label|id|next> | cancel <label|id> | clear]",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      const sessionId = ctx.sessionManager.getSessionId();
      const owned = (await listRuns()).filter((r) => r.parentSessionId === sessionId);

      if (trimmed === "go next") {
        try {
          const script = fileURLToPath(new URL("../rex/next_waiting.lua", import.meta.url));
          const result = await rexJson([
            "do",
            script,
            ...(process.env.REX_BLOCK ? [`anchor=${process.env.REX_BLOCK}`] : []),
            "--json",
          ]);
          ctx.ui.notify(
            result.status === "selected"
              ? "Jumped to oldest waiting terminal"
              : "No waiting terminals right now",
            "info",
          );
        } catch (error) {
          ctx.ui.notify(`Could not jump to waiting terminal: ${errorText(error)}`, "error");
        }
        return;
      }

      if (trimmed.startsWith("go ")) {
        const target = findUnique(owned, trimmed.slice(3).trim());
        if (!target?.rex) {
          ctx.ui.notify("Specify a unique label or run ID with a Rex pane", "error");
          return;
        }
        const loc = await locateBlock(target.rex.blockId, target.rex.sessionId);
        if (!loc) {
          ctx.ui.notify(`${target.label}'s Rex pane is already closed`, "warning");
          return;
        }
        await focusBlock(loc, process.env.REX_BLOCK);
        ctx.ui.notify(`Focused ${target.label}`, "info");
        return;
      }

      if (trimmed.startsWith("cancel ")) {
        const target = findUnique(owned, trimmed.slice(7).trim());
        if (!target) {
          ctx.ui.notify("Specify a unique label or run ID belonging to this session", "error");
          return;
        }
        const active = liveRuns.get(target.id);
        if (!active) {
          ctx.ui.notify(`${target.label} is not running (${target.status})`, "warning");
          return;
        }
        const outcome = await active.cancel();
        onUpdate();
        ctx.ui.notify(
          outcome === "taken_over"
            ? `${target.label} was taken over; left running`
            : `Cancelled ${target.label}`,
          outcome === "taken_over" ? "warning" : "info",
        );
        return;
      }

      if (trimmed === "clear") {
        let closed = 0;
        for (const run of owned) {
          if (!isTerminal(run.status) || run.status === "taken_over" || !run.rex) continue;
          const obs = await observeProcess(run.rex);
          if (obs.location && obs.process.state === "exited") {
            await closeBlock(obs.location).catch(() => undefined);
            closed += 1;
          }
        }
        ctx.ui.notify(`Closed ${closed} finished pane(s)`, "info");
        return;
      }

      if (trimmed) {
        ctx.ui.notify(
          "Usage: /subagents [go <label|id|next> | cancel <label|id> | clear]",
          "error",
        );
        return;
      }

      if (owned.length === 0) {
        ctx.ui.notify("No subagents in this session", "info");
        return;
      }

      const text = owned
        .slice(-20)
        .map((run) => {
          const lines = [
            `${statusLine(run)} (${run.id})`,
            `  model: ${run.model.provider}/${run.model.model} (${run.model.thinking}) | placement: ${run.placement}`,
          ];
          if (run.rex) lines.push(`  rex: session=${run.rex.sessionId} block=${run.rex.blockId}`);
          if (run.worktree) {
            lines.push(
              `  worktree: ${run.worktree.path} (${run.worktree.branch}${run.worktree.removedAt ? ", removed" : ""})`,
            );
          }
          return lines.join("\n");
        })
        .join("\n\n");

      ctx.ui.notify(text, "info");
      pi.sendMessage(
        { customType: "subagents-list", content: text, display: true },
        { triggerTurn: false },
      );
    },
  });
}
