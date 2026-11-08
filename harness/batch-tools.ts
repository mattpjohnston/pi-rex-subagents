import { readFile, writeFile } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { LaunchInput } from "../src/launch.ts";
import { parse } from "../src/records.ts";

/** A same-parent sequential plan for terminal-lifecycle acceptance, not the parallel-call test. */
export default function (pi: ExtensionAPI): void {
  let started = false;
  pi.registerTool({
    name: "harness_batch",
    label: "Lifecycle plan",
    description:
      "Call exactly once with no arguments to run the prescribed terminal lifecycle plan.",
    parameters: Type.Object({}),
    async execute(_id, _input, signal, _update, ctx) {
      if (started) throw new Error("Batch already started");
      started = true;
      const plan = process.env.HARNESS_PLAN,
        output = process.env.HARNESS_RESPONSE;
      if (!plan || !output) throw new Error("Batch paths missing");
      const inputs = parse(Type.Array(LaunchInput), JSON.parse(await readFile(plan, "utf8")));
      const results = [];
      for (const input of inputs)
        results.push(await ctx.executeTool("subagent", input, { signal }));
      await writeFile(output, JSON.stringify(results), { mode: 0o600 });
      return {
        content: [{ type: "text", text: "Lifecycle plan finished. Reply briefly." }],
        details: undefined,
      };
    },
  });
}
