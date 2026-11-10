import { progressUpdate } from "../src/index.ts";
import { observeRexEvent, runForeground } from "../src/launch.ts";
import { RexEvents } from "../src/rex.ts";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  atomicWrite,
  parse,
  privateDirectory,
  readResult,
  readRun,
  RunRecord,
  runPaths,
  transition,
  writeRun,
} from "../src/records.ts";

function record(root: string): RunRecord {
  const id = "a".repeat(24);
  const dir = join(root, "runs", id);
  const settings = { provider: "test", model: "model", thinking: "off" as const };
  return {
    version: 1,
    id,
    label: "test",
    taskPath: join(dir, "task.md"),
    cwd: root,
    checkoutRoot: root,
    access: "write",
    requested: settings,
    effective: settings,
    background: false,
    continueFrom: null,
    parentSessionId: "test-parent",
    parentRunId: null,
    depth: 0,
    rex: null,
    location: null,
    paths: runPaths(dir),
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
}
it("parses one complete record and rejects extra ownership and invalid variants", () => {
  const run = record(tmpdir());
  expect(parse(RunRecord, run)).toEqual(run);
  for (const invalid of [
    { ...run, owner: "parent" },
    { ...run, lifecycle: "done" },
    { ...run, process: { state: "exited" } },
    { ...run, effective: { ...run.effective, thinking: "unlimited" } },
  ])
    expect(() => parse(RunRecord, invalid)).toThrow();
});
it("permits explicit lifecycle edges, never resurrection or completion directly from admission", () => {
  const run = record(tmpdir());
  expect(() => transition(run, "completed")).toThrow();
  transition(run, "starting");
  transition(run, "running");
  transition(run, "incomplete");
  expect(run.finishedAt).toBeTypeOf("number");
  expect(() => transition(run, "running")).toThrow();
});
it("an ended run is neither waiting for a human nor queued", () => {
  for (const outcome of ["failed", "cancelled", "taken_over"] as const) {
    const run = record(tmpdir());
    run.queue = { reason: "checkout", detail: "older writer", since: 1 };
    transition(run, "starting");
    run.waiting = { source: "reporter", kind: "confirm", title: "Proceed?", since: 2 };
    transition(run, outcome);
    expect([run.waiting, run.queue]).toEqual([null, null]);
    run.waiting = { source: "rex", kind: "blocked", title: "Pi dialog", since: 3 };
    transition(run, outcome);
    expect(run.waiting).toBeNull();
  }
});
it("validates every disk read and rejects a well-formed result from another run", async () => {
  const root = await mkdtemp(join(tmpdir(), "pirs-record-"));
  const previous = process.env.PI_SUBAGENTS_STATE_DIR;
  process.env.PI_SUBAGENTS_STATE_DIR = root;
  try {
    const run = record(root);
    await privateDirectory(join(root, "runs", run.id));
    await writeRun(run);
    expect((await readRun(run.id)).id).toBe(run.id);
    await atomicWrite(run.paths.result, {
      version: 1,
      runId: "stale",
      outcome: "completed",
      assistantText: "text",
      sessionFile: null,
      effective: run.effective,
      stopReason: "stop",
      reason: null,
      finishedAt: 0,
    });
    await expect(readResult(run)).rejects.toThrow("run ID mismatch");
    await writeFile(run.paths.run, JSON.stringify({ ...run, owner: "parent" }));
    await expect(readRun(run.id)).rejects.toThrow("Invalid persisted");
    expect(await readFile(run.paths.result, "utf8")).toContain("stale");
  } finally {
    if (previous === undefined) delete process.env.PI_SUBAGENTS_STATE_DIR;
    else process.env.PI_SUBAGENTS_STATE_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

it("clears a Rex-only wait with a question kind when the program resumes", () => {
  const run = record(tmpdir());
  const event = {
    sessionId: "",
    blockId: "",
    name: "program_status_changed",
    payload: { record: { state: "blocked", kind: "question" } },
  };
  observeRexEvent(run, event);
  expect(run.waiting?.kind).toBe("question");
  observeRexEvent(run, { ...event, payload: { record: { state: "working", kind: "question" } } });
  expect(run.waiting).toBeNull();
});

it("does not let advisory Rex idle clear an authoritative reporter or trust wait", () => {
  const run = record(tmpdir());
  for (const source of ["reporter", "trust"] as const) {
    run.waiting = { source, kind: "input", title: "Question", since: 1 };
    observeRexEvent(run, {
      sessionId: "",
      blockId: "",
      name: "program_status_changed",
      payload: { record: { state: "idle" } },
    });
    expect(run.waiting?.source).toBe(source);
  }
});

it("records no live process when cancellation wins before Rex launch", async () => {
  const root = await mkdtemp(join(tmpdir(), "pirs-cancel-"));
  const previous = process.env.PI_SUBAGENTS_STATE_DIR;
  process.env.PI_SUBAGENTS_STATE_DIR = root;
  try {
    const run = record(root);
    await privateDirectory(join(root, "runs", run.id));
    await writeRun(run);
    const result = await runForeground(
      run,
      "unused-entry",
      new RexEvents(),
      AbortSignal.abort(),
      () => {},
    );
    expect(result.run.lifecycle).toBe("cancelled");
    expect(result.run.process).toEqual({ state: "exited", code: null });
  } finally {
    if (previous === undefined) delete process.env.PI_SUBAGENTS_STATE_DIR;
    else process.env.PI_SUBAGENTS_STATE_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

it("a stale writer cannot reopen an ended run or revive an exited process", async () => {
  const root = await mkdtemp(join(tmpdir(), "pirs-stale-"));
  const previous = process.env.PI_SUBAGENTS_STATE_DIR;
  process.env.PI_SUBAGENTS_STATE_DIR = root;
  try {
    const launcher = record(root);
    await privateDirectory(join(root, "runs", launcher.id));
    transition(launcher, "starting");
    transition(launcher, "running");
    launcher.process = { state: "live", pid: 4242 };
    await writeRun(launcher);
    const canceller = await readRun(launcher.id);
    transition(canceller, "cancelled");
    canceller.process = { state: "exited", code: 143 };
    await writeRun(canceller);
    launcher.diagnostic = "still polling";
    await writeRun(launcher);
    const saved = await readRun(launcher.id);
    expect(saved).toMatchObject({
      lifecycle: "cancelled",
      finishedAt: canceller.finishedAt,
      process: { state: "exited", code: 143 },
      diagnostic: "still polling",
    });
    expect(launcher.lifecycle).toBe("running");
  } finally {
    if (previous === undefined) delete process.env.PI_SUBAGENTS_STATE_DIR;
    else process.env.PI_SUBAGENTS_STATE_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

it("repairs permissions on a pre-existing state directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "pirs-permissions-"));
  try {
    await chmod(root, 0o755);
    await privateDirectory(root);
    expect((await stat(root)).mode & 0o777).toBe(0o700);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("does not raise an attention notice for a queued run", () => {
  const run = record(tmpdir());
  run.queue = { reason: "checkout", detail: "older-writer", since: 1 };
  const queued = progressUpdate(run);
  expect(queued.attention).toBeNull();
  expect(queued.text).toContain("queued for checkout: older-writer");
  expect(queued.text).not.toContain("waiting for a human");
  expect(() =>
    parse(RunRecord, {
      ...run,
      waiting: { source: "admission", kind: "capacity", title: "capacity", since: 1 },
    }),
  ).toThrow();
  run.waiting = { source: "reporter", kind: "question", title: "Need a decision", since: 2 };
  const both = progressUpdate(run);
  expect(both.attention).toContain("waiting for a human");
  expect(both.attention).toContain("queued for checkout");
  expect(both.text).toBe(both.attention);
});
