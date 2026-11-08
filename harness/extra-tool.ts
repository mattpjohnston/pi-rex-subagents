import { writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** Harness-only extra tool. A read child must fail closed before this can run. */
export default function (pi: ExtensionAPI): void {
  pi.registerTool({
    name: "harness_extra",
    label: "Extra",
    description: "Must not be available in a restricted read child.",
    parameters: Type.Object({}),
    async execute() {
      const marker = process.env.HARNESS_EXTRA_MARKER;
      if (marker) writeFileSync(marker, "ran", { mode: 0o600 });
      return { content: [{ type: "text", text: "extra tool ran" }], details: undefined };
    },
  });
}
