import { writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { claim, withProtocolLock } from "../src/claims.ts";
import { atomicWrite, readRun } from "../src/records.ts";
import { Type } from "typebox";

/** Harness-only tools, loaded solely through PI_SUBAGENTS_CHILD_EXTENSIONS for isolated runs. */
export default async function (pi: ExtensionAPI): Promise<void> {
  const dir = process.env.PI_SUBAGENTS_RUN_DIR;
  if (!dir) throw new Error("Harness child tools require a managed run environment");
  const run = await readRun(process.env.PI_SUBAGENTS_RUN_ID ?? "");
  const task = await readFile(run.taskPath, "utf8");
  const mode = /HARNESS_MODE=([a-z-]+)/.exec(task)?.[1];
  if (mode === "provider-error" || mode === "length")
    pi.on("before_provider_request", (event) => {
      if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload))
        throw new Error("Unsupported harness provider payload");
      return {
        ...event.payload,
        ...(mode === "length"
          ? { max_tokens: 1, max_completion_tokens: 1 }
          : { model: "intentionally-invalid-harness-model" }),
      };
    });
  if (mode === "oversized" || mode === "missing-assistant")
    pi.on("message_end", (event) => {
      if (event.message.role !== "assistant" || event.message.stopReason !== "stop") return;
      return {
        message: {
          ...event.message,
          content:
            mode === "missing-assistant"
              ? []
              : [{ type: "text", text: "oversized acceptance output\n".repeat(5000) }],
        },
      };
    });
  if (mode === "malformed" || mode === "wrong-id" || mode === "missing-file")
    pi.on("agent_before_settle", async (_event, ctx) => {
      await withProtocolLock(run.paths.lock, async () => {
        if (mode !== "missing-file")
          await atomicWrite(
            run.paths.result,
            mode === "malformed"
              ? { malformed: true }
              : {
                  version: 1,
                  runId: "stale-run",
                  outcome: "completed",
                  assistantText: "untrusted stale answer",
                  sessionFile: ctx.sessionManager.getSessionFile() ?? null,
                  effective: run.effective,
                  stopReason: "stop",
                  reason: null,
                  finishedAt: Date.now(),
                },
          );
        await claim(run.paths.claim, "result");
      });
    });
  if (mode === "delay-ack")
    pi.events.on("subagents:test-takeover-claimed", () => {
      writeFileSync(join(dir, "ack-delayed"), "ready", { mode: 0o600 });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000);
    });
  if (mode === "settle-first")
    pi.on("agent_settled", () => {
      pi.sendUserMessage("/subagent-takeover", { expandPromptTemplates: true });
    });
  if (mode === "hang")
    pi.on("session_shutdown", async (event) => {
      if (event.reason === "quit") while (true) await delay(60_000);
    });
  if (mode === "missing")
    pi.registerTool({
      name: "harness_done_without_result",
      label: "Done without result",
      description: "Exercise an advisory done status followed by exit with no reporter result.",
      parameters: Type.Object({}),
      async execute() {
        process.stdout.write("\x1b]7501;state=done:app=pi\x1b\\");
        await writeFile(join(dir, "done-without-result"), "ready", { mode: 0o600 });
        await delay(500);
        process.exit(0);
      },
    });
  if (task.includes("harness_facts"))
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
  if (task.includes("ask_human"))
    pi.registerTool({
      name: "ask_human",
      label: "Ask human",
      description: "Ask the harness human a blocking question. Wait for the answer.",
      parameters: Type.Object({}),
      async execute(_id, _args, signal, _update, ctx) {
        const answer = await ctx.ui.input("Subagent acceptance question", "Answer here", {
          signal,
        });
        return { content: [{ type: "text", text: answer ?? "No answer" }], details: undefined };
      },
    });
  if (task.includes("harness_hold"))
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
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
              throw error;
          }
          await delay(100);
        }
        throw new Error("Hold interrupted");
      },
    });
  if (mode === "handled-error")
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
