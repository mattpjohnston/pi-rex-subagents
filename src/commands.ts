import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ActiveRun } from "./launch.ts";
import { closeBlock, focusBlock, locateBlock, observeProcess, rexJson } from "./rex.ts";
import { errorText, isTerminal, listRuns, type RunRecord } from "./store.ts";
import { findRepoRoot, listSubagentWorktrees, removeSubagentWorktree } from "./worktree.ts";

export function statusLine(run: RunRecord): string {
  const mode = run.readOnly ? "read" : run.worktree ? "worktree" : "write";
  const detail = run.waiting ? `waiting (${run.waiting.title})` : run.status;
  return `${run.label} [${mode}] ${detail}`;
}

function findUnique(runs: readonly RunRecord[], query: string): RunRecord | null {
  const matches = runs.filter((r) => r.id === query || r.label === query);
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

async function handleWorktrees(ctx: ExtensionContext): Promise<void> {
  const repoRoot = await findRepoRoot(ctx.cwd);
  if (!repoRoot) {
    ctx.ui.notify("Not inside a git repository", "warning");
    return;
  }
  const worktrees = await listSubagentWorktrees(repoRoot);
  if (worktrees.length === 0) {
    ctx.ui.notify("No subagent worktrees for this repository", "info");
    return;
  }
  if (!ctx.hasUI) {
    ctx.ui.notify(
      worktrees.map((w) => `${w.branch} (${w.dirty ? "dirty" : "clean"}) — ${w.path}`).join("\n"),
      "info",
    );
    return;
  }
  const choices = worktrees.map(
    (w) => `${w.branch} [${w.dirty ? "uncommitted changes" : "clean"}] — ${w.path}`,
  );
  const picked = await ctx.ui.select("Subagent worktrees (select to remove)", choices);
  if (!picked) return;
  const selected = worktrees[choices.indexOf(picked)];
  if (!selected) return;
  if (selected.dirty) {
    const confirmed = await ctx.ui.confirm(
      `Remove dirty worktree ${selected.branch}?`,
      `${selected.path} has uncommitted changes. Removing it discards them.`,
    );
    if (!confirmed) return;
  }
  await removeSubagentWorktree(repoRoot, selected.path, selected.branch, selected.dirty);
  ctx.ui.notify(`Removed worktree ${selected.branch}`, "info");
}

async function focusRun(run: RunRecord, ctx: ExtensionContext): Promise<void> {
  if (!run.rex) {
    ctx.ui.notify(`${run.label} has no Rex pane`, "warning");
    return;
  }
  const loc = await locateBlock(run.rex.blockId, run.rex.sessionId);
  if (!loc) {
    ctx.ui.notify(`${run.label}'s Rex pane is already closed`, "warning");
    return;
  }
  await focusBlock(loc, process.env.REX_BLOCK);
  ctx.ui.notify(`Focused ${run.label}`, "info");
}

export function registerCommands(
  pi: ExtensionAPI,
  liveRuns: Map<string, ActiveRun>,
  onUpdate: () => void,
): void {
  pi.registerCommand("subagents", {
    description:
      "Manage subagents: /subagents [go <label|id|next> | cancel <label|id> | worktrees | clear]",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      const sessionId = ctx.sessionManager.getSessionId();
      const owned = (await listRuns()).filter((r) => r.parentSessionId === sessionId);

      if (trimmed === "worktrees") {
        await handleWorktrees(ctx);
        return;
      }

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
        if (!target) {
          ctx.ui.notify("Specify a unique label or run ID belonging to this session", "error");
          return;
        }
        await focusRun(target, ctx);
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
          "Usage: /subagents [go <label|id|next> | cancel <label|id> | worktrees | clear]",
          "error",
        );
        return;
      }

      if (owned.length === 0) {
        ctx.ui.notify("No subagents in this session", "info");
        return;
      }

      const recent = owned.slice(-20).toReversed();
      if (ctx.hasUI) {
        const choices = recent.map((run) => {
          const wt = run.worktree && !run.worktree.removedAt ? ` · ${run.worktree.branch}` : "";
          return `${statusLine(run)}${wt} (${run.id.slice(0, 8)})`;
        });
        const picked = await ctx.ui.select("Subagents (select to act)", choices);
        if (!picked) return;
        const selected = recent[choices.indexOf(picked)];
        if (!selected) return;

        const isActive = liveRuns.has(selected.id);
        const actions = [
          ...(selected.rex ? ["Jump to Rex pane"] : []),
          ...(isActive ? ["Cancel subagent"] : []),
          "Show run details",
        ];
        const action =
          actions.length === 1 ? actions[0] : await ctx.ui.select(selected.label, actions);
        if (action === "Jump to Rex pane") {
          await focusRun(selected, ctx);
        } else if (action === "Cancel subagent") {
          const outcome = await liveRuns.get(selected.id)?.cancel();
          onUpdate();
          ctx.ui.notify(
            outcome === "taken_over"
              ? `${selected.label} was taken over; left running`
              : `Cancelled ${selected.label}`,
            outcome === "taken_over" ? "warning" : "info",
          );
        } else if (action === "Show run details") {
          const lines = [
            `${statusLine(selected)} (${selected.id})`,
            `model: ${selected.model.provider}/${selected.model.model} (${selected.model.thinking})`,
            ...(selected.rex
              ? [`rex: session=${selected.rex.sessionId} block=${selected.rex.blockId}`]
              : []),
            ...(selected.worktree
              ? [
                  `worktree: ${selected.worktree.path} (${selected.worktree.branch}${selected.worktree.removedAt ? ", removed" : ""})`,
                ]
              : []),
            ...(selected.sessionFile ? [`session: ${selected.sessionFile}`] : []),
          ];
          ctx.ui.notify(lines.join("\n"), "info");
        }
        return;
      }

      const text = recent.map((run) => `${statusLine(run)} (${run.id})`).join("\n");
      ctx.ui.notify(text, "info");
    },
  });
}
