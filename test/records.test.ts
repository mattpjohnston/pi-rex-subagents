import { progressUpdate } from "../src/index.ts";
import { observeRexEvent, reconcile, runForeground, startBackground } from "../src/launch.ts";
import { RexEvents } from "../src/rex.ts";
import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { readReservations } from "../src/admission.ts";
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

/** A local Rex endpoint and a Pi executable, so a launch gets as far as admission without either. */
async function localLaunchTools(root: string): Promise<void> {
  const rex = join(root, "rex");
  await writeFile(rex, `#!/bin/sh\nprintf '%s\\n' '{"endpoint":"unix:///rex.sock"}'\n`, {
    mode: 0o700,
  });
  vi.stubEnv("PI_SUBAGENTS_REX", rex);
  vi.stubEnv("PI_SUBAGENTS_PI", process.execPath);
}
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
    await localLaunchTools(root);
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
    vi.unstubAllEnvs();
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

it("a background launch refused before it queues returns the refusal", async () => {
  const root = await mkdtemp(join(tmpdir(), "pirs-refused-"));
  const previous = process.env.PI_SUBAGENTS_STATE_DIR;
  process.env.PI_SUBAGENTS_STATE_DIR = root;
  try {
    const run = record(root);
    run.background = true;
    await privateDirectory(join(root, "runs", run.id));
    await writeRun(run);
    await writeFile(join(root, "limits.json"), JSON.stringify({ active: 0 }));
    await localLaunchTools(root);
    const started = startBackground(run, "unused-entry", new RexEvents(), undefined, () => {}, {});
    started.done.catch(() => undefined);
    const outcome = await Promise.race([
      started.ready.then(
        () => "returned",
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      ),
      new Promise((resolve) => setTimeout(() => resolve("still waiting after 2 s"), 2000)),
    ]);
    expect(outcome).toMatch(/Invalid admission limits/);
  } finally {
    vi.unstubAllEnvs();
    if (previous === undefined) delete process.env.PI_SUBAGENTS_STATE_DIR;
    else process.env.PI_SUBAGENTS_STATE_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

it("a launch that fails before asking Rex for a tab holds no reservation", async () => {
  const root = await mkdtemp(join(tmpdir(), "pirs-prelaunch-"));
  vi.stubEnv("PI_SUBAGENTS_STATE_DIR", root);
  vi.stubEnv("PI_SUBAGENTS_REX", join(root, "missing-rex"));
  try {
    const run = record(root);
    await privateDirectory(join(root, "runs", run.id));
    await writeRun(run);
    await expect(
      runForeground(run, "unused-entry", new RexEvents(), undefined, () => {}),
    ).rejects.toThrow();
    expect((await readReservations()).flatMap((r) => r.members)).toEqual([]);
  } finally {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});

it("a queued launch that fails gives up its place in the queue", async () => {
  const root = await mkdtemp(join(tmpdir(), "pirs-queued-"));
  vi.stubEnv("PI_SUBAGENTS_STATE_DIR", root);
  try {
    await localLaunchTools(root);
    const holder = {
      ...record(root),
      id: "b".repeat(24),
      paths: runPaths(join(root, "runs", "b".repeat(24))),
    };
    holder.lifecycle = "running";
    holder.process = { state: "live", pid: null };
    await privateDirectory(join(root, "runs", holder.id));
    await writeRun(holder);
    await privateDirectory(join(root, "reservations"));
    await atomicWrite(join(root, "reservations", `${holder.id}.json`), {
      id: holder.id,
      members: [{ runId: holder.id, access: "write", checkout: root, provider: "test" }],
    });
    const run = { ...record(root), background: true };
    await privateDirectory(join(root, "runs", run.id));
    await writeRun(run);
    const started = startBackground(run, "unused-entry", new RexEvents(), undefined, () => {}, {});
    expect((await started.ready).queue?.reason).toBe("checkout");
    await writeFile(join(root, "limits.json"), "{");
    await expect(started.done).rejects.toThrow(/Invalid admission limits/);
    expect(await readdir(join(root, "queue"))).toEqual([]);
    expect((await readRun(run.id)).lifecycle).toBe("failed");
  } finally {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});

it("an ended run whose process Rex later finds alive is unresolved, unless taken over", async () => {
  const root = await mkdtemp(join(tmpdir(), "pirs-unresolved-"));
  const rex = join(root, "rex");
  await writeFile(
    rex,
    `#!/bin/sh
case "$1 $2" in
  'block inspect') printf '%s\\n' '{"session_id":"s","block":{"window_id":"w"}}' ;;
  'block call') printf '%s\\n' '{"last_exit":null,"child":{"pid":4242}}' ;;
  *) exit 1 ;;
esac
`,
    { mode: 0o700 },
  );
  vi.stubEnv("PI_SUBAGENTS_REX", rex);
  try {
    for (const [outcome, expected] of [
      ["completed", "unresolved"],
      ["cancelled", "unresolved"],
      ["taken_over", "live"],
    ] as const) {
      const run = record(root);
      run.rex = { sessionId: "s", windowId: "w", blockId: "b" };
      transition(run, "starting");
      transition(run, outcome);
      // Rex was unreachable when the shutdown grace ended.
      run.process = { state: "unknown" };
      await reconcile(run);
      expect([outcome, run.process]).toEqual([outcome, { state: expected, pid: 4242 }]);
    }
  } finally {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});

it("a stale write keeps an ended run's live process unresolved", async () => {
  const root = await mkdtemp(join(tmpdir(), "pirs-stale-live-"));
  vi.stubEnv("PI_SUBAGENTS_STATE_DIR", root);
  try {
    const run = record(root);
    await privateDirectory(join(root, "runs", run.id));
    transition(run, "starting");
    transition(run, "running");
    run.process = { state: "live", pid: 4242 };
    await writeRun(run);
    const canceller = await readRun(run.id);
    const watcher = await readRun(run.id);
    transition(canceller, "cancelled");
    await writeRun(canceller);
    await writeRun(watcher);
    expect(await readRun(run.id)).toMatchObject({
      lifecycle: "cancelled",
      process: { state: "unresolved", pid: 4242 },
    });
  } finally {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});

it("a resumed background watch that fails leaves no unhandled rejection", async () => {
  const root = await mkdtemp(join(tmpdir(), "pirs-resume-"));
  vi.stubEnv("PI_SUBAGENTS_STATE_DIR", root);
  vi.stubEnv("PI_SUBAGENTS_REX", join(root, "missing-rex"));
  const unhandled: unknown[] = [];
  const track = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", track);
  try {
    const run = { ...record(root), background: true };
    await privateDirectory(join(root, "runs", run.id));
    await writeRun(run);
    // A reload resumes the watch and keeps only `done`, as index.ts does.
    const { done } = startBackground(run, "unused-entry", new RexEvents(), undefined, () => {}, {
      resume: true,
    });
    await expect(done).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(unhandled).toEqual([]);
  } finally {
    process.off("unhandledRejection", track);
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});

it("a resumed launch cancelled before it asks Rex records that no process exists", async () => {
  const root = await mkdtemp(join(tmpdir(), "pirs-resume-cancel-"));
  vi.stubEnv("PI_SUBAGENTS_STATE_DIR", root);
  try {
    await localLaunchTools(root);
    const run = { ...record(root), background: true };
    await privateDirectory(join(root, "runs", run.id));
    // A reload detached the watcher after admission, before it asked Rex for a tab.
    transition(run, "starting");
    await writeRun(run);
    await writeFile(run.paths.claim, "cancelled");
    const resumed = await runForeground(run, "unused-entry", new RexEvents(), undefined, () => {}, {
      resume: true,
    });
    expect(resumed.run).toMatchObject({
      lifecycle: "cancelled",
      process: { state: "exited", code: null },
    });
    expect(await readRun(run.id)).toMatchObject({ process: { state: "exited", code: null } });
  } finally {
    vi.unstubAllEnvs();
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
