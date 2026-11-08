import { readFile, writeFile } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { parse } from "../src/records.ts";
import { LaunchInput } from "../src/launch.ts";

/** Harness-only driver: a real parent model invokes the public launch tool through Pi. */
export default function (pi: ExtensionAPI): void {
  const plan = process.env.HARNESS_PLAN;
  const output = process.env.HARNESS_RESPONSE;
  if (!plan || !output) throw new Error("Harness plan and response paths required");
  let started = false;
  pi.registerTool({
    name: "harness_launch",
    label: "Harness launch",
    description:
      "Run the prescribed acceptance task once through subagent. Call this once, with no arguments.",
    parameters: Type.Object({}),
    async execute(_id, _args, signal, _update, ctx) {
      if (started) throw new Error("Harness plan already started");
      started = true;
      const input = parse(LaunchInput, JSON.parse(await readFile(plan, "utf8")));
      const result = await ctx.executeTool("subagent", input, { signal });
      await writeFile(output, JSON.stringify(result), { mode: 0o600 });
      return {
        content: [{ type: "text", text: "Acceptance task finished. Reply briefly." }],
        details: undefined,
      };
    },
  });
}
