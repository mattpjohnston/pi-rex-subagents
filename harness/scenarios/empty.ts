import assert from "node:assert/strict";
import { withRun } from "../lib/run.ts";
import { success } from "../lib/rex.ts";

export default async function empty(): Promise<void> {
  await withRun("empty", async (run) => {
    const { sessionId, blockId } = await run.newSession("empty", ["/bin/sh", "-c", "echo ok"]);
    const exited = success(await run.rex.wait(sessionId, blockId));
    await run.record("exit.json", exited);
    const captured = success(await run.rex.capture(sessionId, blockId));
    assert.match(captured.stdout, /^ok\r?$/m);
    await run.record("capture.json", captured);
    console.log("harness empty: child exit 0; captured ok");
  });
}
