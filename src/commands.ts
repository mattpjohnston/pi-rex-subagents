import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { cancelControlled, ownedRuns, treeOrder } from "./control.ts";
import { shouldAppend, type TransitionView } from "./delivery.ts";
import { isTerminal, listRuns, type RunRecord } from "./records.ts";
import { locate, object, rexJson } from "./rex.ts";
import { cappedText } from "./results.ts";
import { clearEligible, dismiss, keep } from "./terminals.ts";

export const live = (run: RunRecord) =>
  !isTerminal(run.lifecycle) || run.process.state !== "exited";
export function statusLine(run: RunRecord): string {
  const human = run.waiting
    ? `waiting for a human: ${run.waiting.kind} — ${run.waiting.title}`
    : null;
  const queued = run.queue ? `queued for ${run.queue.reason}: ${run.queue.detail}` : null;
  const indent = "  ".repeat(Math.max(0, run.depth - 1));
  return `${indent}${run.label} [${run.access}] ${[human, queued, run.activity?.parked ? `parked (${run.activity.parked})` : null].filter(Boolean).join("; ") || run.lifecycle}`;
}

export function registerSubagentsCommand(
  pi: ExtensionAPI,
  {
    refresh,
    views,
  }: {
    refresh: (ctx: ExtensionContext) => Promise<void>;
    views: (ctx: ExtensionContext, records: RunRecord[]) => Promise<TransitionView[]>;
  },
): void {
  pi.registerCommand("subagents", {
    description:
      "List this parent's runs; all lists every live child; go <label> selects its tab; go next selects the oldest wait across parents; cancel <label|run-id> cancels a background run; keep <label|run-id> pins its tab open",
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
      if (args.startsWith("keep ")) {
        const target = args.slice("keep ".length).trim();
        const matches = owned.filter((run) => run.id === target || run.label === target);
        const selected = matches.length === 1 ? matches[0] : undefined;
        if (!selected) {
          ctx.ui.notify(
            "Keep requires exactly one run label or ID belonging to this parent",
            "error",
          );
          return;
        }
        await keep(selected);
        ctx.ui.notify(`Keeping ${selected.label}'s tab; /subagents dismiss closes it`, "info");
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
          "Usage: /subagents [all | go <label|next> | cancel <label|run-id> | keep <label|run-id> | clear | dismiss <label|run-id>]",
          "error",
        );
        return;
      }
      const selected = args === "all" ? all.filter(live) : owned;
      for (const run of selected.slice(0, 30)) {
        if (run.rex && run.tabClosedAt === undefined)
          run.location = await locate(run.rex.blockId, run.location ?? run.rex);
      }
      const pending = (await views(ctx, all)).filter((run) =>
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
                `Rex ${run.tabClosedAt !== undefined ? "closed" : JSON.stringify(run.location)}; process ${JSON.stringify(run.process)}`,
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
}
