import { EventEmitter } from "node:events";
import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { admit, keepRunsForMs, readLimits } from "../src/admission.ts";
import { privateDirectory, readRun, runPaths, writeRun, type RunRecord } from "../src/records.ts";
import { cleanupRuns, retentionDecision } from "../src/retention.ts";

const day = 86_400_000;
const now = 40 * day;
const keepMs = 30 * day;
const started = Symbol.for("pi-rex-subagents.retention-started");
let dir: string;
let shutdown: (() => Promise<unknown>) | undefined;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pirs-retention-"));
  vi.stubEnv("PI_SUBAGENTS_STATE_DIR", dir);
  vi.stubEnv("PI_SUBAGENTS_RUN_ID", "");
  vi.stubEnv("PI_SUBAGENTS_RUN_DIR", "");
  Reflect.deleteProperty(globalThis, started);
});
afterEach(async () => {
  await shutdown?.();
  shutdown = undefined;
  Reflect.deleteProperty(globalThis, started);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});
function record(id = "a".repeat(24), patch: Partial<RunRecord> = {}): RunRecord {
  const root = join(dir, "runs", id);
  const settings = { provider: "test", model: "test", thinking: "off" as const };
  return {
    version: 1,
    id,
    label: id,
    taskPath: join(root, "task.md"),
    cwd: dir,
    checkoutRoot: dir,
    access: "write",
    requested: settings,
    effective: settings,
    background: false,
    continueFrom: null,
    parentSessionId: "parent",
    parentRunId: null,
    depth: 1,
    rex: null,
    location: null,
    paths: runPaths(root),
    lifecycle: "completed",
    process: { state: "exited", code: 0 },
    waiting: null,
    queue: null,
    sessionFile: null,
    diagnostic: null,
    createdAt: 0,
    updatedAt: 0,
    loadedAt: 0,
    finishedAt: 0,
    ...patch,
  };
}
async function seed(id: string, patch: Partial<RunRecord> = {}) {
  const run = record(id.repeat(24), patch);
  await privateDirectory(join(dir, "runs", run.id));
  await writeRun(run);
  return run;
}
const exists = async (id: string) =>
  access(join(dir, "runs", id)).then(
    () => true,
    () => false,
  );
type Input = Parameters<typeof retentionDecision>[0];
const decision = (run: Partial<RunRecord> = {}, input: Partial<Input> = {}) =>
  retentionDecision({
    run: record(undefined, run),
    claim: null,
    parent: null,
    childrenKept: false,
    now,
    keepMs,
    ...input,
  });

test.each<{
  name: string;
  run?: Partial<RunRecord>;
  input?: Partial<Input>;
  expected: "keep" | "delete";
}>([
  { name: "old foreground completed", expected: "delete" },
  ...(["failed", "cancelled", "aborted", "incomplete"] as const).map((lifecycle) => ({
    name: lifecycle,
    run: { lifecycle },
    expected: "delete" as const,
  })),
  { name: "disabled", input: { keepMs: null }, expected: "keep" },
  { name: "no finish timestamp", run: { finishedAt: null }, expected: "keep" },
  { name: "recent", run: { finishedAt: now - day }, expected: "keep" },
  { name: "exact boundary", run: { finishedAt: now - keepMs }, expected: "keep" },
  { name: "just beyond boundary", run: { finishedAt: now - keepMs - 1 }, expected: "delete" },
  ...(["admitting", "starting", "running"] as const).map((lifecycle) => ({
    name: lifecycle,
    run: { lifecycle },
    expected: "keep" as const,
  })),
  { name: "taken-over lifecycle", run: { lifecycle: "taken_over" }, expected: "keep" },
  { name: "taken-over claim", input: { claim: "taken_over" }, expected: "keep" },
  { name: "result claim", input: { claim: "result" }, expected: "delete" },
  { name: "cancelled claim", input: { claim: "cancelled" }, expected: "delete" },
  ...(["live", "unresolved"] as const).map((state) => ({
    name: state,
    run: { process: { state, pid: 123 } },
    expected: "keep" as const,
  })),
  { name: "unknown", run: { process: { state: "unknown" } }, expected: "keep" },
  {
    name: "queued",
    run: { queue: { reason: "capacity", detail: "full", since: 0 } },
    expected: "keep",
  },
  { name: "kept child", input: { childrenKept: true }, expected: "keep" },
  { name: "background undelivered", run: { background: true }, expected: "keep" },
  { name: "background delivered", run: { background: true, deliveredAt: 0 }, expected: "delete" },
  {
    name: "nested missing parent",
    run: { parentRunId: "b".repeat(24), background: true },
    input: { parent: "missing" },
    expected: "delete",
  },
  {
    name: "nested absent parent observation",
    run: { parentRunId: "b".repeat(24) },
    expected: "keep",
  },
])("retention: $name", ({ run, input, expected }) => expect(decision(run, input)).toBe(expected));

test.each([
  {
    lifecycle: "completed" as const,
    process: { state: "exited" as const, code: 0 },
    expected: "delete",
  },
  {
    lifecycle: "failed" as const,
    process: { state: "exited" as const, code: 1 },
    expected: "delete",
  },
  {
    lifecycle: "running" as const,
    process: { state: "exited" as const, code: 0 },
    expected: "keep",
  },
  {
    lifecycle: "completed" as const,
    process: { state: "live" as const, pid: 123 },
    expected: "keep",
  },
  {
    lifecycle: "completed" as const,
    process: { state: "unresolved" as const, pid: 123 },
    expected: "keep",
  },
  { lifecycle: "completed" as const, process: { state: "unknown" as const }, expected: "keep" },
])("nested parent: %j", ({ lifecycle, process, expected }) => {
  expect(
    decision(
      { parentRunId: "b".repeat(24), background: true },
      { parent: record("b".repeat(24), { lifecycle, process }) },
    ),
  ).toBe(expected);
});

test("keepRunsFor defaults to 30 days and accepts positive days or false", async () => {
  expect(await keepRunsForMs()).toBe(30 * day);
  await writeFile(join(dir, "limits.json"), "{}");
  expect(await keepRunsForMs()).toBe(30 * day);
  await writeFile(join(dir, "limits.json"), JSON.stringify({ keepRunsFor: 2 }));
  expect(await keepRunsForMs()).toBe(2 * day);
  await readLimits();
  await writeFile(join(dir, "limits.json"), JSON.stringify({ keepRunsFor: false }));
  expect(await keepRunsForMs()).toBeNull();
});
test.each(["soon", 0, -1, 1.5, true, null])(
  "invalid keepRunsFor %j names limits.json",
  async (keepRunsFor) => {
    await writeFile(join(dir, "limits.json"), JSON.stringify({ keepRunsFor }));
    await expect(keepRunsForMs()).rejects.toThrow(/limits\.json/);
    await expect(readLimits()).rejects.toThrow(/limits\.json/);
  },
);

async function parent(branch: unknown[] = []) {
  let tick: (() => void) | undefined;
  vi.stubGlobal("setInterval", (callback: () => void) => {
    tick = callback;
    return 0;
  });
  const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
  const bus = new EventEmitter();
  const statuses: string[] = [];
  const pi = {
    on: (name: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) =>
      handlers.set(name, handler),
    events: {
      emit: (channel: string, data: unknown) => {
        bus.emit(channel, data);
      },
      on: (channel: string, listener: (data: unknown) => void) => {
        bus.on(channel, listener);
        return () => {
          bus.off(channel, listener);
        };
      },
    },
    registerCommand: () => {},
    registerTool: () => {},
    sendMessage: () => {},
  };
  let refreshed: (() => void) | undefined;
  const ctx = {
    cwd: dir,
    isIdle: () => false,
    sessionManager: { getSessionId: () => "parent", getBranch: () => branch },
    ui: {
      setWidget: () => refreshed?.(),
      setStatus: (_id: string, text: string) => statuses.push(text),
    },
  };
  const extension = (await import("../src/index.ts")) as {
    default: (pi: unknown) => Promise<void>;
  };
  await extension.default(pi);
  shutdown = async () => handlers.get("session_shutdown")?.({ reason: "reload" }, ctx);
  return {
    statuses,
    start: () => handlers.get("session_start")?.({ reason: "startup" }, ctx),
    reload: async () => {
      await shutdown?.();
      await handlers.get("session_start")?.({ reason: "reload" }, ctx);
    },
    refresh: async () => {
      const done = new Promise<void>((resolve) => {
        refreshed = resolve;
      });
      tick?.();
      await done;
    },
    branch,
  };
}

test("startup removes only eligible directories and reload never repeats cleanup", async () => {
  const old = await seed("a");
  const background = await seed("b", { background: true });
  const live = await seed("c", {
    lifecycle: "running",
    process: { state: "live", pid: 123 },
    finishedAt: null,
  });
  const taken = await seed("d", { lifecycle: "taken_over" });
  await writeFile(taken.paths.claim, "taken_over");
  const p = await parent();
  await p.start();
  await vi.waitFor(async () => expect(await exists(old.id)).toBe(false));
  for (const run of [background, live, taken]) expect(await exists(run.id)).toBe(true);
  const later = await seed("e");
  await p.reload();
  await p.refresh();
  expect(await exists(later.id)).toBe(true);
  expect(p.statuses).toEqual([]);
  await shutdown?.();
  const reloaded = await parent();
  await reloaded.start();
  await reloaded.refresh();
  expect(await exists(later.id)).toBe(true);
  expect(reloaded.statuses).toEqual([]);
});

test("refresh stamps only this session's delivered background runs and preserves the stamp", async () => {
  const run = await seed("a", { background: true, finishedAt: Date.now() });
  const other = await seed("b", {
    background: true,
    parentSessionId: "other",
    finishedAt: Date.now(),
  });
  const foreground = await seed("c", { finishedAt: Date.now() });
  const p = await parent();
  await p.start();
  await p.refresh();
  expect((await readRun(run.id)).deliveredAt).toBeUndefined();
  p.branch.push({
    type: "custom_message",
    customType: "subagent-results",
    details: { runIds: [run.id, other.id, foreground.id] },
  });
  await p.refresh();
  const saved = await readRun(run.id);
  expect(saved.deliveredAt).toEqual(expect.any(Number));
  expect((await readRun(other.id)).deliveredAt).toBeUndefined();
  expect((await readRun(foreground.id)).deliveredAt).toBeUndefined();
  await writeRun(run);
  await p.refresh();
  expect((await readRun(run.id)).deliveredAt).toBe(saved.deliveredAt);
});

test("startup stamps an old background delivery before deciding retention", async () => {
  const run = await seed("a", { background: true });
  const p = await parent([
    { type: "custom_message", customType: "subagent-results", details: { runIds: [run.id] } },
  ]);
  await p.start();
  await vi.waitFor(async () => expect(await exists(run.id)).toBe(false));
  expect(p.statuses).toEqual([]);
});

test("cleanup visits leaves first, retains ancestors of kept descendants and ignores tombstones", async () => {
  const root = await seed("a");
  const child = await seed("b", { parentRunId: root.id, depth: 2, background: true });
  const keptRoot = await seed("c");
  const keptChild = await seed("d", {
    parentRunId: keptRoot.id,
    depth: 2,
    process: { state: "unknown" },
  });
  await privateDirectory(join(dir, "runs", ".deleted-old"));
  await cleanupRuns();
  expect(await exists(root.id)).toBe(false);
  expect(await exists(child.id)).toBe(false);
  expect(await exists(keptRoot.id)).toBe(true);
  expect(await exists(keptChild.id)).toBe(true);
});

test("retention removes stale admission references so the next launch can start", async () => {
  const old = await seed("a");
  await privateDirectory(join(dir, "reservations"));
  await writeFile(
    join(dir, "reservations", old.id + ".json"),
    JSON.stringify({
      id: old.id,
      members: [
        {
          runId: old.id,
          access: old.access,
          checkout: old.checkoutRoot,
          provider: old.effective.provider,
        },
      ],
    }),
  );
  await cleanupRuns();
  const next = await seed("b", {
    lifecycle: "admitting",
    process: { state: "unknown" },
    finishedAt: null,
  });
  expect(await admit(next)).toBe(true);
});

test("startup refresh waits for cleanup instead of querying a deleted tab", async () => {
  const rex = join(dir, "rex");
  const log = join(dir, "rex.log");
  await writeFile(log, "");
  await writeFile(
    rex,
    `#!/bin/sh
printf '%s\\n' "$*" >> '${log}'
exit 3
`,
  );
  await chmod(rex, 0o700);
  vi.stubEnv("PI_SUBAGENTS_REX", rex);
  const run = await seed("a", { rex: { sessionId: "s", windowId: "w", blockId: "gone" } });
  await writeFile(run.paths.claim, "result");
  const p = await parent();
  await p.start();
  await p.refresh();
  await vi.waitFor(async () => expect(await exists(run.id)).toBe(false));
  expect(await readFile(log, "utf8")).toBe("");
  expect(p.statuses).toEqual([]);
});
