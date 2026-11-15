import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { waitForRuns } from "../src/control.ts";
import {
  atomicWrite,
  initialActivity,
  privateDirectory,
  runPaths,
  writeRun,
  type RunRecord,
} from "../src/records.ts";

let dir: string | undefined;
afterEach(async () => {
  vi.unstubAllEnvs();
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function run(root: string, id: string, ended: boolean): Promise<RunRecord> {
  const runDir = join(root, "runs", id);
  await privateDirectory(runDir);
  const settings = { provider: "p", model: "m", thinking: "off" as const };
  const record: RunRecord = {
    version: 1,
    id,
    label: `run-${id.slice(0, 1)}`,
    taskPath: join(runDir, "task.md"),
    cwd: root,
    checkoutRoot: root,
    access: "read",
    requested: settings,
    effective: settings,
    background: true,
    continueFrom: null,
    parentSessionId: "parent",
    parentRunId: null,
    depth: 1,
    activity: initialActivity(),
    rex: null,
    location: null,
    paths: runPaths(runDir),
    lifecycle: ended ? "completed" : "running",
    process: ended ? { state: "exited", code: 0 } : { state: "live", pid: null },
    waiting: null,
    queue: null,
    sessionFile: null,
    diagnostic: null,
    createdAt: 0,
    updatedAt: 0,
    loadedAt: 0,
    finishedAt: ended ? 1 : null,
  };
  await writeRun(record);
  if (ended) {
    await atomicWrite(record.paths.result, {
      version: 1,
      runId: id,
      outcome: "completed",
      assistantText: `answer from ${id.slice(0, 1)}`,
      sessionFile: null,
      effective: settings,
      stopReason: "stop",
      reason: null,
      finishedAt: 1,
    });
    await writeFile(record.paths.claim, "result");
  }
  return record;
}

it("wait reports each named run once it has an outcome, and lists the rest at the timeout", async () => {
  dir = await mkdtemp(join(tmpdir(), "pirs-wait-"));
  vi.stubEnv("PI_SUBAGENTS_STATE_DIR", dir);
  const done = await run(dir, "a".repeat(24), true);
  const busy = await run(dir, "b".repeat(24), false);
  const all = await waitForRuns([done.id], 1000);
  expect(all.pending).toEqual([]);
  expect(all.text).toContain("answer from a");
  expect(all.runIds).toEqual([done.id]);
  const started = Date.now();
  const partial = await waitForRuns([done.id, busy.id], 300);
  expect(Date.now() - started).toBeGreaterThanOrEqual(250);
  expect(partial.runIds).toEqual([done.id]);
  expect(partial.pending).toEqual([busy.id]);
  const aborted = await waitForRuns([busy.id], 60_000, AbortSignal.abort());
  expect(aborted.pending).toEqual([busy.id]);
});
