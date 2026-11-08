import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { LaunchInput } from "../src/launch.ts";
import { listRuns, parse } from "../src/records.ts";

/** Harness-only driver for background batches, the parent guard, and a parent hold. */
export default function (pi: ExtensionAPI): void {
  const plansPath = process.env.HARNESS_PLANS;
  const output = process.env.HARNESS_RESPONSE;
  if (!plansPath || !output) throw new Error("Harness background plan and response paths required");
  let started = false;
  pi.registerTool({
    name: "harness_background",
    label: "Harness background",
    description: "Launch the prescribed background runs once. Call this once, with no arguments.",
    parameters: Type.Object({}),
    async execute(_id, _args, signal, _update, ctx) {
      if (started) throw new Error("Harness background plan already started");
      started = true;
      const plans = parse(Type.Array(LaunchInput), JSON.parse(await readFile(plansPath, "utf8")));
      const launched = [];
      for (const plan of plans) {
        launched.push(await ctx.executeTool("subagent", plan, { signal }));
      }
      const guard: Record<string, unknown> = {};
      const inside = process.env.HARNESS_GUARD_INSIDE;
      const outside = process.env.HARNESS_GUARD_OUTSIDE;
      if (inside && outside) {
        const deadline = Date.now() + 60_000;
        while (Date.now() < deadline) {
          if ((await listRuns()).some((run) => run.access === "write" && run.rex)) break;
          await delay(200);
        }
        guard.writeInside = await ctx.executeTool(
          "write",
          { path: inside, content: "blocked" },
          { signal },
        );
        guard.editInside = await ctx.executeTool(
          "edit",
          { path: inside, edits: [{ oldText: "blocked", newText: "still" }] },
          { signal },
        );
        guard.writeOutside = await ctx.executeTool(
          "write",
          { path: outside, content: "allowed" },
          { signal },
        );
        guard.bash = await ctx.executeTool("bash", { command: "mkdir -p /tmp" }, { signal });
      }
      const guardOutput = process.env.HARNESS_GUARD_OUTPUT;
      if (guardOutput) await writeFile(guardOutput, JSON.stringify(guard), { mode: 0o600 });
      const hold = process.env.HARNESS_PARENT_HOLD;
      if (hold) {
        await writeFile(hold, "holding", { mode: 0o600 });
        while (!signal?.aborted) {
          try {
            await readFile(`${hold}.release`);
            break;
          } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
              throw error;
            await delay(100);
          }
        }
      }
      await writeFile(output, JSON.stringify({ launched, guard }), { mode: 0o600 });
      return {
        content: [{ type: "text", text: "Background batch finished. Reply briefly." }],
        details: undefined,
      };
    },
  });
}
