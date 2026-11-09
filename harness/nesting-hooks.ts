import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionAPI, MessageEndEventResult } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { JsonValue } from "@earendil-works/pi-ai";
import { parse, readRun } from "../src/records.ts";

const Batch = Type.Object({
  waitFor: Type.Optional(Type.String()),
  calls: Type.Array(
    // Parsed from JSON below, so every argument value is already a JSON value.
    Type.Object({
      name: Type.String(),
      arguments: Type.Record(Type.String(), Type.Unsafe<JsonValue>({})),
    }),
  ),
});
/** Replace real model responses with a fixed tool plan, not a wrapper tool holding the join. */
export default async function nestingHooks(pi: ExtensionAPI): Promise<void> {
  const id = process.env.PI_SUBAGENTS_RUN_ID;
  const plans = process.env.HARNESS_NESTED_PLAN_DIR;
  if (!id || !plans) return;
  const run = await readRun(id);
  let batches;
  try {
    batches = parse(
      Type.Array(Batch),
      JSON.parse(await readFile(join(plans, `${run.label}.json`), "utf8")),
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  let index = 0;
  pi.on("message_end", async (event): Promise<MessageEndEventResult | void> => {
    if (
      event.message.role !== "assistant" ||
      ["error", "aborted"].includes(event.message.stopReason)
    )
      return;
    const batchIndex = index++;
    const batch = batches[batchIndex];
    if (!batch)
      return {
        message: {
          ...event.message,
          content: [{ type: "text" as const, text: "Acceptance plan finished." }],
          stopReason: "stop" as const,
        },
      };
    await writeFile(join(dirname(run.paths.run), `batch-${batchIndex}-ready`), "ready", {
      mode: 0o600,
    });
    while (batch.waitFor) {
      try {
        await readFile(batch.waitFor);
        break;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      await delay(50);
    }
    return {
      message: {
        ...event.message,
        content: batch.calls.map((call, n) => ({
          type: "toolCall" as const,
          id: `fixed-${batchIndex}-${n}`,
          name: call.name,
          arguments: call.arguments,
        })),
        stopReason: batch.calls.length ? ("toolUse" as const) : ("stop" as const),
      },
    };
  });
}
