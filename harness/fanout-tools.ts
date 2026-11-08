import { readFile, writeFile } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { LaunchInput } from "../src/launch.ts";
import { parse } from "../src/records.ts";

/** One parent issues the prescribed launches concurrently, the way one assistant message would. */
export default function (pi: ExtensionAPI): void {
  let started = false;
  pi.registerTool({
    name: "harness_fanout",
    label: "Fan-out",
    description: "Call once with no arguments to launch the prescribed tasks together.",
    parameters: Type.Object({}),
    async execute(_id, _input, signal, _update, ctx) {
      if (started) throw new Error("Fan-out already started");
      started = true;
      const plan = process.env.HARNESS_PLAN;
      const output = process.env.HARNESS_RESPONSE;
      if (!plan || !output) throw new Error("Fan-out paths missing");
      const inputs = parse(Type.Array(LaunchInput), JSON.parse(await readFile(plan, "utf8")));
      const results = await Promise.all(
        inputs.map((input) => ctx.executeTool("subagent", input, { signal })),
      );
      await writeFile(output, JSON.stringify(results), { mode: 0o600 });
      return {
        content: [{ type: "text", text: "Fan-out finished. Reply briefly." }],
        details: undefined,
      };
    },
  });
}
