import { EventEmitter } from "node:events";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { privateDirectory, readRun, runPaths, writeRun, type RunRecord } from "../src/records.ts";
import { clearEligible, dismiss } from "../src/terminals.ts";

let dir: string;
let log: string;
let shutdown: (() => Promise<unknown>) | undefined;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pirs-terminals-"));
  log = join(dir, "rex.log");
  const rex = join(dir, "rex");
  vi.stubEnv("PI_SUBAGENTS_STATE_DIR", dir);
  vi.stubEnv("PI_SUBAGENTS_REX", rex);
  vi.stubEnv("PI_SUBAGENTS_RUN_ID", "");
  vi.stubEnv("PI_SUBAGENTS_RUN_DIR", "");
  await writeFile(join(dir, "limits.json"), JSON.stringify({ keepRunsFor: false }));
  await writeFile(log, "");
  await writeFile(
    rex,
    `#!/bin/sh
printf '%s\\n' "$*" >> '${log}'
case "$1 $2" in
  'block inspect')
    case "$5" in
      gone) exit 3 ;;
      unreachable) exit 4 ;;
      *) printf '%s\\n' '{"session_id":"s","block":{"window_id":"w"}}' ;;
    esac ;;
  'ls --json') printf '%s\\n' '{"sessions":[{"session_id":"s"}]}' ;;
  'session inspect') printf '%s\\n' '{"active_window_id":"parent","windows":[{"window_id":"w","label":"child"}]}' ;;
  'block call') printf '%s\\n' '{"last_exit":{"exit_code":0}}' ;;
  'block close') exit 0 ;;
  *) exit 1 ;;
esac
`,
  );
  await chmod(rex, 0o700);
});
afterEach(async () => {
  await shutdown?.();
  shutdown = undefined;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

async function record(blockId: string, id = "a".repeat(24)): Promise<RunRecord> {
  const root = join(dir, "runs", id);
  const settings = { provider: "test", model: "test", thinking: "off" as const };
  const location = { sessionId: "s", windowId: "w", blockId };
  const run: RunRecord = {
    version: 1,
    id,
    label: "child",
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
    rex: location,
    location,
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
  };
  await privateDirectory(root);
  await writeRun(run);
  await writeFile(run.paths.claim, "result");
  return run;
}
const calls = async () => (await readFile(log, "utf8")).split("\n").filter(Boolean);

test("a gone completed tab is persisted as closed and never queried again after reload", async () => {
  const run = await record("gone");
  expect(await clearEligible(run)).toBeFalsy();
  expect(await readRun(run.id)).toHaveProperty("tabClosedAt", expect.any(Number));
  expect(run).toHaveProperty("tabClosedAt", expect.any(Number));
  const before = await calls();
  expect(before.length).toBeGreaterThan(0);
  expect(await clearEligible(await readRun(run.id))).toBeFalsy();
  expect(await calls()).toEqual(before);
});

async function parent() {
  let tick: (() => void) | undefined;
  vi.stubGlobal("setInterval", (callback: () => void) => {
    tick = callback;
    return 0;
  });
  const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
  const bus = new EventEmitter();
  const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
  const notifications: string[] = [];
  const widgets: (string[] | undefined)[] = [];
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
    registerCommand: (
      name: string,
      command: { handler: (args: string, ctx: unknown) => Promise<void> },
    ) => commands.set(name, command.handler),
    registerTool: () => {},
    sendMessage: () => {},
  };
  let settle: (() => void) | undefined;
  let failure: ((error: Error) => void) | undefined;
  const ctx = {
    cwd: dir,
    isIdle: () => true,
    sessionManager: { getSessionId: () => "parent", getBranch: () => [] },
    ui: {
      setWidget: (_id: string, lines: string[] | undefined) => {
        widgets.push(lines);
        settle?.();
      },
      setStatus: (_id: string, text: string) => failure?.(new Error(text)),
      notify: (text: string) => {
        notifications.push(text);
      },
    },
  };
  const extension = (await import("../src/index.ts")) as {
    default: (pi: unknown) => Promise<void>;
  };
  await extension.default(pi);
  shutdown = async () => handlers.get("session_shutdown")?.({ reason: "reload" }, ctx);
  const refresh = async (first = false) => {
    const before = (await calls()).length;
    const done = new Promise<void>((resolve, reject) => {
      settle = resolve;
      failure = reject;
    });
    if (first) await handlers.get("session_start")?.({ reason: "startup" }, ctx);
    else tick?.();
    await done;
    return (await calls()).slice(before);
  };
  return { refresh, list: () => commands.get("subagents")?.("", ctx), notifications, widgets };
}

test("one refresh checks an open exited tab only once", async () => {
  await record("open");
  const { refresh } = await parent();
  const commands = await refresh(true);
  expect(commands).toHaveLength(2);
  expect(commands).toEqual(["block inspect -s s open --json", "session inspect s --json"]);
});

test("a gone tab costs zero Rex calls on the second parent refresh", async () => {
  await record("gone");
  const { refresh } = await parent();
  expect((await refresh(true)).length).toBeGreaterThan(0);
  expect(await refresh()).toEqual([]);
});

test.each([
  { lifecycle: "failed" as const },
  { rex: null },
  { process: { state: "live" as const, pid: 123 } },
  { process: { state: "unknown" as const } },
  { tabClosedAt: 0 },
])("ineligible records make no Rex calls: %j", async (patch) => {
  const run = { ...(await record("open")), ...patch };
  expect(await clearEligible(run)).toBeFalsy();
  expect(await calls()).toEqual([]);
});

test.each(["taken_over", "cancelled"])("claim %s makes no Rex calls", async (claim) => {
  const run = await record("open");
  await writeFile(run.paths.claim, claim);
  expect(await clearEligible(run)).toBeFalsy();
  expect(await calls()).toEqual([]);
});

test("Rex being unreachable is not proof a tab closed", async () => {
  const run = await record("unreachable");
  expect(await clearEligible(run)).toBeFalsy();
  expect(await readRun(run.id)).not.toHaveProperty("tabClosedAt");
  expect(await clearEligible(run)).toBeFalsy();
  expect(await calls()).toHaveLength(2);
});

test("renamed tabs are kept", async () => {
  const run = await record("open");
  run.label = "previous name";
  expect(await clearEligible(run)).toBeFalsy();
  expect(await readRun(run.id)).not.toHaveProperty("tabClosedAt");
});

test.each(["open", "gone"])("dismiss records a %s tab as closed", async (block) => {
  const run = await record(block);
  await dismiss(run);
  const saved = await readRun(run.id);
  expect(saved.tabClosedAt).toEqual(expect.any(Number));
  expect(run.tabClosedAt).toEqual(saved.tabClosedAt);
  expect((await calls()).some((call) => call.startsWith("block close"))).toBe(block === "open");
});

test("closure preserves newer record fields and survives an older writer", async () => {
  const stale = await record("gone");
  const newer = await readRun(stale.id);
  newer.diagnostic = "newer observation";
  await writeRun(newer);
  await clearEligible(stale);
  const closed = await readRun(stale.id);
  expect(closed.diagnostic).toBe("newer observation");
  expect(closed.tabClosedAt).toEqual(expect.any(Number));
  await writeRun(newer);
  expect((await readRun(stale.id)).tabClosedAt).toBe(closed.tabClosedAt);
});

test("one refresh shares the session inspection between open tabs", async () => {
  await record("open");
  await record("other-open", "b".repeat(24));
  const { refresh, widgets } = await parent();
  const commands = await refresh(true);
  expect(commands).toHaveLength(3);
  expect(commands.filter((call) => call.startsWith("session inspect"))).toHaveLength(1);
  expect(widgets.at(-1)).toEqual(["2 exited completed child terminal(s): /subagents clear"]);
});

test("auto-close persists closure and removes the closed tab from the widget count", async () => {
  const run = await record("open");
  await writeFile(
    join(dir, "limits.json"),
    JSON.stringify({ closeCompletedAfter: 0, keepRunsFor: false }),
  );
  const { refresh, widgets } = await parent();
  expect((await refresh(true)).some((call) => call.startsWith("block close"))).toBe(true);
  expect(await readRun(run.id)).toHaveProperty("tabClosedAt", expect.any(Number));
  expect(widgets.at(-1)).toBeUndefined();
  expect(await refresh()).toEqual([]);
});

test("listing a known closed tab shows closed without asking Rex", async () => {
  const run = await record("gone");
  await clearEligible(run);
  const before = await calls();
  const { list, notifications } = await parent();
  await list();
  expect(await calls()).toEqual(before);
  expect(notifications.join("\n")).toContain("Rex closed; process");
});
