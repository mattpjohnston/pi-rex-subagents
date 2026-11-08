import { writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** Deterministic inspect probe. Calls real tools through Pi; does not register edit or write. */
export default function (pi: ExtensionAPI): void {
  pi.registerTool({
    name: "harness_inspect",
    label: "Inspect probe",
    description:
      "Call once with no arguments. Proves bash is callable and edit/write are not, then writes one marker through bash.",
    parameters: Type.Object({}),
    async execute(_id, _input, signal, _update, ctx) {
      const marker = process.env.HARNESS_INSPECT_MARKER;
      const output = process.env.HARNESS_INSPECT_RESULT;
      if (!marker || !output) throw new Error("Inspect probe paths missing");
      const call = async (name: string, input: Record<string, unknown>) => {
        try {
          return await ctx.executeTool(name, input, { signal });
        } catch (error) {
          return { isError: true, error: error instanceof Error ? error.message : String(error) };
        }
      };
      const edit = await call("edit", { path: marker, edits: [{ oldText: "x", newText: "y" }] });
      const write = await call("write", { path: marker, content: "forbidden" });
      const bash = await call("bash", { command: `printf child-write > '${marker}'` });
      const report = { edit, write, bash };
      writeFileSync(output, JSON.stringify(report), { mode: 0o600 });
      return {
        content: [{ type: "text", text: "Inspect probe finished. Reply briefly." }],
        details: undefined,
      };
    },
  });
}
