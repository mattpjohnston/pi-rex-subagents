import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** Harness-only boundary driver; every nested call goes through Pi's normal tool_call gates. */
export default function (pi: ExtensionAPI): void {
  pi.registerTool({
    name: "harness_guard",
    label: "Guard probe",
    description: "Call once with no arguments to run the acceptance guard probe.",
    parameters: Type.Object({}),
    async execute(_id, _input, signal, _update, ctx) {
      const target = process.env.HARNESS_GUARD_TARGET,
        outside = process.env.HARNESS_GUARD_OUTSIDE,
        output = process.env.HARNESS_RESPONSE;
      if (!target || !outside || !output) throw new Error("Guard harness paths missing");
      const calls = [
        {
          name: "edit",
          input: {
            path: join(target, "existing"),
            edits: [{ oldText: "original", newText: "forbidden" }],
          },
        },
        {
          name: "write",
          input: { path: `@${join(target, "new/deep/file")}`, content: "forbidden" },
        },
        {
          name: "edit",
          input: {
            path: join(outside, "existing"),
            edits: [{ oldText: "original", newText: "allowed" }],
          },
        },
        { name: "write", input: { path: join(outside, "new"), content: "allowed" } },
        {
          name: "bash",
          input: { command: `printf shell-allowed > '${join(target, "shell-marker")}'` },
        },
      ];
      const results = [];
      for (const call of calls)
        results.push({
          name: call.name,
          ...(await ctx.executeTool(call.name, call.input, { signal })),
        });
      await writeFile(output, JSON.stringify(results), { mode: 0o600 });
      return {
        content: [{ type: "text", text: "Guard probe finished. Reply briefly." }],
        details: undefined,
      };
    },
  });
}
