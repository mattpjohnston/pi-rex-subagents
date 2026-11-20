import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupOldRuns,
  isTakenOver,
  listRuns,
  markTakenOver,
  readConfig,
  readResult,
  readRun,
  runPaths,
  writeResult,
  writeRun,
  type RunRecord,
} from "../src/store.ts";

let dir: string;
let prevState: string | undefined;

function sampleRun(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    version: 2,
    id: "0123456789abcdef0123",
    label: "worker",
    parentSessionId: "sess-1",
    cwd: "/tmp",
    repoRoot: null,
    readOnly: false,
    background: false,
    placement: "tab",
    keepOpen: false,
    model: { provider: "anthropic", model: "claude-sonnet-4-5", thinking: "low" },
    continueFrom: null,
    rex: null,
    status: "running",
    waiting: null,
    sessionFile: null,
    diagnostic: null,
    createdAt: 1_000,
    finishedAt: null,
    ...overrides,
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pirs-store-"));
  prevState = process.env.PI_SUBAGENTS_STATE_DIR;
  process.env.PI_SUBAGENTS_STATE_DIR = dir;
});

afterEach(async () => {
  if (prevState === undefined) delete process.env.PI_SUBAGENTS_STATE_DIR;
  else process.env.PI_SUBAGENTS_STATE_DIR = prevState;
  await rm(dir, { recursive: true, force: true });
});

describe("store", () => {
  it("writes, reads, and lists runs sorted by creation time", async () => {
    const newer = sampleRun({ id: "aaaaaaaaaaaaaaaaaaaa", createdAt: 200 });
    const older = sampleRun({ id: "bbbbbbbbbbbbbbbbbbbb", createdAt: 100 });
    await writeRun(newer);
    await writeRun(older);

    expect((await readRun(newer.id)).createdAt).toBe(200);
    expect((await listRuns()).map((r) => r.id)).toEqual([older.id, newer.id]);
  });

  it("reads default config and rejects malformed config.json", async () => {
    expect(await readConfig()).toEqual({
      maxConcurrent: 4,
      placement: "tab",
      keepOpen: false,
      keepRunsForMs: 30 * 86_400_000,
    });

    await writeFile(
      join(dir, "config.json"),
      JSON.stringify({ maxConcurrent: 8, placement: "split", keepOpen: true }),
    );
    expect(await readConfig()).toEqual({
      maxConcurrent: 8,
      placement: "split",
      keepOpen: true,
      keepRunsForMs: 30 * 86_400_000,
    });

    await writeFile(join(dir, "config.json"), JSON.stringify({ maxConcurrent: 0 }));
    await expect(readConfig()).rejects.toThrow("Invalid subagent config");
  });

  it("handles atomic takeover claims and respects existing results", async () => {
    const id = "11111111111111111111";
    await writeRun(sampleRun({ id }));
    expect(await isTakenOver(id)).toBe(false);
    expect(await markTakenOver(id)).toBe("claimed");
    expect(await isTakenOver(id)).toBe(true);
    expect(await markTakenOver(id)).toBe("already_taken");

    const finishedId = "22222222222222222222";
    await writeRun(sampleRun({ id: finishedId }));
    await writeResult({
      version: 2,
      runId: finishedId,
      outcome: "completed",
      assistantText: "done",
      stopReason: "stop",
      reason: null,
      sessionFile: null,
      model: { provider: "anthropic", model: "claude-sonnet-4-5", thinking: "off" },
      finishedAt: 500,
    });
    expect(await readResult(finishedId)).not.toBeNull();
    expect(await markTakenOver(finishedId)).toBe("finished");
    expect(await isTakenOver(finishedId)).toBe(false);
  });

  it("cleans up old finished runs while keeping recent, running, and taken_over runs", async () => {
    const now = 100 * 86_400_000;
    const oldDone = sampleRun({
      id: "00000000000000000001",
      status: "completed",
      finishedAt: now - 40 * 86_400_000,
    });
    const recentDone = sampleRun({
      id: "00000000000000000002",
      status: "completed",
      finishedAt: now - 5 * 86_400_000,
    });
    const oldTakenOver = sampleRun({
      id: "00000000000000000003",
      status: "taken_over",
      finishedAt: now - 50 * 86_400_000,
    });
    const live = sampleRun({ id: "00000000000000000004", status: "running", finishedAt: null });

    for (const r of [oldDone, recentDone, oldTakenOver, live]) await writeRun(r);
    expect(await cleanupOldRuns(now)).toBe(1);
    expect((await listRuns()).map((r) => r.id)).toEqual([recentDone.id, oldTakenOver.id, live.id]);
    await expect(readRun(oldDone.id)).rejects.toThrow();
    expect(runPaths(recentDone.id).run).toContain(recentDone.id);
  });
});
