import { readdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readRun } from "../src/records.ts";

/** Test-only barriers; the production reporter remains the only settlement decision owner. */
export default async function (pi: ExtensionAPI): Promise<void> {
  const id = process.env.PI_SUBAGENTS_RUN_ID;
  if (!id) {
    if (process.env.HARNESS_CANCEL_CRASH === "1")
      pi.events.on("subagents:test-cancel-claimed", () => process.kill(process.pid, "SIGKILL"));
    return;
  }
  const run = await readRun(id);
  const task = await readFile(run.taskPath, "utf8");
  const dir = dirname(run.paths.run);
  let first = true;
  // The reporter's inbox poll settles an idle child again every 250 ms, so an idle hold must
  // cover every settlement until the harness's message reaches the inbox, not just the first.
  const messageArrived = () => {
    try {
      return readdirSync(run.paths.inbox).some((name) => name.endsWith(".json"));
    } catch {
      return false;
    }
  };
  pi.events.on("subagents:test-settlement", (raw) => {
    if (!raw || typeof raw !== "object") return;
    const boundary = raw as { runId: string; before: Promise<void>; hold: boolean };
    if (boundary.runId !== id) return;
    if (task.includes("HARNESS_MODE=idle") && !messageArrived()) {
      boundary.hold = true;
      if (first) boundary.before = writeFile(join(dir, "idle-held"), "ready", { mode: 0o600 });
    }
    if (!first) return;
    first = false;
    if (task.includes("HARNESS_MODE=settle-pause")) {
      boundary.before = (async () => {
        await writeFile(join(dir, "settling-paused"), "ready", { mode: 0o600 });
        while (true) {
          try {
            await readFile(join(dir, "release-settlement"));
            return;
          } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
              throw error;
          }
          await delay(50);
        }
      })();
    }
  });
}
