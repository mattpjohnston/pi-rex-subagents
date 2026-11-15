import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runForeground } from "../src/launch.ts";
import { RexEvents } from "../src/rex.ts";
import { privateDirectory, runPaths, writeRun, type RunRecord } from "../src/records.ts";

let dir: string | undefined;
afterEach(async () => {
  vi.unstubAllEnvs();
  if (dir) await rm(dir, { recursive: true, force: true });
});

/** A Rex that opens a tab whose process has already exited, printing what Pi printed. */
async function fakeRex(root: string, screen: string): Promise<string> {
  const log = join(root, "rex.log");
  const rex = join(root, "rex");
  await writeFile(
    rex,
    `#!/bin/sh
echo "$1 $2" >> '${log}'
case "$1 $2" in
  'whoami --json') echo '{"endpoint":"unix:///rex.sock"}' ;;
  'window new') echo '{"window_id":"w","block_ids":["b"]}' ;;
  'block inspect') echo '{"session_id":"s","block":{"window_id":"w"}}' ;;
  'block call') echo '{"last_exit":{"exit_code":1}}' ;;
  'capture -s') printf '%s\\n' ${JSON.stringify(screen)} ;;
  'events --all') sleep 30 ;;
  *) exit 1 ;;
esac
`,
    { mode: 0o700 },
  );
  return log;
}

it("a child that exits before it starts reports what its terminal showed", async () => {
  dir = await mkdtemp(join(tmpdir(), "pirs-launch-"));
  vi.stubEnv("PI_SUBAGENTS_STATE_DIR", dir);
  vi.stubEnv("PI_SUBAGENTS_PI", process.execPath);
  vi.stubEnv("REX_SESSION", "s");
  const log = await fakeRex(
    dir,
    'Error: Model "bridge/opus" not found. Use --list-models to see available models.',
  );
  vi.stubEnv("PI_SUBAGENTS_REX", join(dir, "rex"));
  const id = "e".repeat(24);
  const runDir = join(dir, "runs", id);
  await privateDirectory(runDir);
  const settings = { provider: "bridge", model: "opus", thinking: "off" as const };
  const run: RunRecord = {
    version: 1,
    id,
    label: "child",
    taskPath: join(runDir, "task.md"),
    cwd: dir,
    checkoutRoot: dir,
    access: "read",
    requested: settings,
    effective: settings,
    background: false,
    continueFrom: null,
    parentSessionId: "parent",
    parentRunId: null,
    depth: 1,
    rex: null,
    location: null,
    paths: runPaths(runDir),
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
  const events = new RexEvents();
  try {
    const outcome = await runForeground(run, "unused-entry", events, undefined, () => {});
    expect((await readFile(log, "utf8")).split("\n")).toContain("window new");
    expect(outcome.run.lifecycle).toBe("failed");
    expect(outcome.run.diagnostic).toContain('Model "bridge/opus" not found');
  } finally {
    events.stop();
  }
}, 20_000);
