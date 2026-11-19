import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { readClaim } from "../src/claims.ts";
import { outcomeSettled } from "../src/delivery.ts";
import { privateDirectory, readRun, runPaths, writeRun, type RunRecord } from "../src/records.ts";

const seen = vi.hoisted(() => ({ settledDuringCapture: [] as boolean[], runId: "" }));
vi.mock("../src/fingerprint.ts", async (original) => {
  const actual = await original<typeof import("../src/fingerprint.ts")>();
  return {
    ...actual,
    captureFingerprint: async (root: string) => {
      if (seen.runId) {
        const run = await readRun(seen.runId);
        seen.settledDuringCapture.push(outcomeSettled(run, await readClaim(run.paths.claim)));
      }
      return actual.captureFingerprint(root);
    },
  };
});

let dir: string | undefined;
afterEach(async () => {
  vi.unstubAllEnvs();
  if (dir) await rm(dir, { recursive: true, force: true });
});

it("an inspect run isn't reported as finished until its checkout report is written", async () => {
  dir = await mkdtemp(join(tmpdir(), "pirs-inspect-order-"));
  vi.stubEnv("PI_SUBAGENTS_STATE_DIR", dir);
  vi.stubEnv("PI_SUBAGENTS_PI", process.execPath);
  vi.stubEnv("REX_SESSION", "s");
  const id = "f".repeat(24);
  const runDir = join(dir, "runs", id);
  const paths = runPaths(runDir);
  const settings = { provider: "p", model: "m", thinking: "off" as const };
  const result = JSON.stringify({
    version: 1,
    runId: id,
    outcome: "completed",
    assistantText: "looked",
    sessionFile: null,
    effective: settings,
    stopReason: "stop",
    reason: null,
    finishedAt: 1,
  });
  // A Rex whose child finishes at once: it publishes a result and its process has exited.
  await writeFile(
    join(dir, "rex"),
    `#!/bin/sh
case "$1 $2" in
  'whoami --json') echo '{"endpoint":"unix:///rex.sock"}' ;;
  'window new') printf '%s' '${result}' > '${paths.result}'; printf result > '${paths.claim}'
    echo '{"window_id":"w","block_ids":["b"]}' ;;
  'block inspect') echo '{"session_id":"s","block":{"window_id":"w"}}' ;;
  'block call') echo '{"last_exit":{"exit_code":0}}' ;;
  'events --all') sleep 30 ;;
  *) exit 1 ;;
esac
`,
    { mode: 0o700 },
  );
  vi.stubEnv("PI_SUBAGENTS_REX", join(dir, "rex"));
  await privateDirectory(runDir);
  const checkout = join(dir, "checkout");
  await privateDirectory(checkout);
  const run: RunRecord = {
    version: 1,
    id,
    label: "inspector",
    taskPath: join(runDir, "task.md"),
    cwd: checkout,
    checkoutRoot: checkout,
    access: "inspect",
    requested: settings,
    effective: settings,
    background: true,
    continueFrom: null,
    parentSessionId: "parent",
    parentRunId: null,
    depth: 1,
    rex: null,
    location: null,
    paths,
    lifecycle: "admitting",
    process: { state: "unknown" },
    waiting: null,
    queue: null,
    sessionFile: null,
    diagnostic: null,
    createdAt: 0,
    updatedAt: 0,
    loadedAt: null,
    finishedAt: null,
  };
  await writeRun(run);
  seen.runId = id;
  const { runForeground } = await import("../src/launch.ts");
  const { RexEvents } = await import("../src/rex.ts");
  const events = new RexEvents();
  try {
    const outcome = await runForeground(run, "unused-entry", events, undefined, () => {});
    expect(outcome.run.lifecycle).toBe("completed");
    expect(outcome.checkout?.state).toBe("clean");
  } finally {
    events.stop();
  }
  // Before launch, and after the child exited: neither time may a reader see it finished.
  expect(seen.settledDuringCapture).toEqual([false, false]);
}, 20_000);
