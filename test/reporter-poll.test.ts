import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  initialActivity,
  privateDirectory,
  runPaths,
  writeRun,
  type RunRecord,
} from "../src/records.ts";

const locks = vi.hoisted(() => ({ count: 0 }));
vi.mock("../src/claims.ts", async (original) => {
  const actual = await original<typeof import("../src/claims.ts")>();
  return {
    ...actual,
    withProtocolLock: <T>(path: string, body: () => Promise<T>) => {
      locks.count++;
      return actual.withProtocolLock(path, body);
    },
  };
});

let dir: string | undefined;
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  if (dir) await rm(dir, { recursive: true, force: true });
});

it("a working child with an empty inbox polls without taking the protocol lock", async () => {
  dir = await mkdtemp(join(tmpdir(), "pirs-poll-"));
  vi.stubEnv("PI_SUBAGENTS_STATE_DIR", dir);
  const id = "d".repeat(24);
  const runDir = join(dir, "runs", id);
  const paths = runPaths(runDir);
  await privateDirectory(paths.inbox);
  const settings = { provider: "p", model: "m", thinking: "off" as const };
  const run: RunRecord = {
    version: 1,
    id,
    label: "child",
    taskPath: join(runDir, "task.md"),
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
    activity: initialActivity(),
    rex: null,
    location: null,
    paths,
    lifecycle: "running",
    process: { state: "live", pid: null },
    waiting: null,
    queue: null,
    sessionFile: null,
    diagnostic: null,
    createdAt: 0,
    updatedAt: 0,
    loadedAt: 0,
    finishedAt: null,
  };
  await writeRun(run);
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const pi = new Proxy(
    {
      on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) =>
        handlers.set(name, handler),
      getActiveTools: () => [],
      getAllTools: () => [],
      getThinkingLevel: () => "off",
    },
    {
      get: (target, key) => (key in target ? target[key as keyof typeof target] : () => undefined),
    },
  );
  const { registerReporter } = await import("../src/reporter.ts");
  registerReporter(pi as never, run);
  const ctx = {
    cwd: dir,
    isIdle: () => false,
    isProjectTrusted: () => true,
    model: undefined,
    sessionManager: { getBranch: () => [], getSessionFile: () => undefined },
    ui: { notify: () => {} },
    shutdown: () => {},
  };
  vi.useFakeTimers({ toFake: ["setInterval"] });
  await handlers.get("session_start")?.({ reason: "startup" }, ctx);
  locks.count = 0;
  for (let poll = 0; poll < 8; poll++) {
    vi.advanceTimersByTime(250);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await handlers.get("session_shutdown")?.({ reason: "reload" }, ctx);
  expect(locks.count).toBe(0);
});
