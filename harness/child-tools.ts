import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** Harness-only tools, loaded solely through PI_SUBAGENTS_CHILD_EXTENSIONS for isolated runs. */
export default function (pi: ExtensionAPI): void {
  const dir = process.env.PI_SUBAGENTS_RUN_DIR;
  if (!dir) throw new Error("Harness child tools require a managed run environment");
  pi.registerTool({
    name: "harness_facts",
    label: "Harness facts",
    description: "Record real TTY, cwd and effective settings for the acceptance test.",
    parameters: Type.Object({}),
    async execute(_id, _args, _signal, _update, ctx) {
      const facts = {
        tty: Boolean(process.stdin.isTTY),
        cwd: process.cwd(),
        provider: ctx.model?.provider,
        model: ctx.model?.id,
        thinking: pi.getThinkingLevel(),
        sessionFile: ctx.sessionManager.getSessionFile(),
        programStatusOverride: process.env.PI_PROGRAM_STATUS ?? null,
      };
      await writeFile(join(dir, "facts.json"), JSON.stringify(facts), { mode: 0o600 });
      return { content: [{ type: "text", text: JSON.stringify(facts) }], details: undefined };
    },
  });
  pi.registerTool({
    name: "ask_human",
    label: "Ask human",
    description: "Ask the harness human a blocking question. Wait for the answer.",
    parameters: Type.Object({}),
    async execute(_id, _args, signal, _update, ctx) {
      const answer = await ctx.ui.input("Subagent acceptance question", "Answer here", { signal });
      return { content: [{ type: "text", text: answer ?? "No answer" }], details: undefined };
    },
  });
  pi.registerTool({
    name: "harness_hold",
    label: "Hold",
    description:
      "Wait for the human to release the acceptance run, then return. Call once when requested.",
    parameters: Type.Object({}),
    async execute(_id, _args, signal) {
      await writeFile(join(dir, "holding"), "ready", { mode: 0o600 });
      while (!signal?.aborted) {
        try {
          await readFile(join(dir, "release"));
          return { content: [{ type: "text", text: "Released" }], details: undefined };
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        }
        await delay(100);
      }
      throw new Error("Hold interrupted");
    },
  });
  pi.registerTool({
    name: "harness_error",
    label: "Handled error",
    description: "Return an intentional handled tool failure for acceptance testing.",
    parameters: Type.Object({}),
    execute() {
      throw new Error("Intentional harness tool failure; handle it and report normally");
    },
  });
}
