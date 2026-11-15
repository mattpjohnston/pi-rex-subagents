import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  atomicWrite,
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

async function child() {
  dir = await mkdtemp(join(tmpdir(), "pirs-reporter-"));
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
  const sent: string[] = [];
  const pi = new Proxy(
    {
      on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) =>
        handlers.set(name, handler),
      getActiveTools: () => [],
      getAllTools: () => [],
      getThinkingLevel: () => "off",
      sendUserMessage: (text: string) => sent.push(text),
      events: { emit: () => {}, on: () => () => {} },
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
  return { run, handlers, ctx, sent };
}

it("a working child with an empty inbox polls without taking the protocol lock", async () => {
  const { handlers, ctx } = await child();
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

it("settlement sends again a message Pi dropped after it was sent", async () => {
  const { run, handlers, ctx, sent } = await child();
  const messageId = "0123abcd-0000-4000-8000-000000000001";
  await atomicWrite(join(run.paths.inbox, `${messageId}.json`), {
    id: messageId,
    runId: run.id,
    text: "hold before committing",
    sender: run.parentSessionId,
    createdAt: 1,
  });
  // Accepted and handed to Pi earlier, but never seen in a saved user message.
  await atomicWrite(join(run.paths.inbox, `${messageId}.ack.json`), {
    messageId,
    runId: run.id,
    state: "accepted",
    acceptedAt: 1,
    sentAt: 2,
  });
  vi.useFakeTimers({ toFake: ["setInterval"] });
  await handlers.get("session_start")?.({ reason: "startup" }, ctx);
  await handlers.get("agent_settled")?.({ aborted: false }, ctx);
  await handlers.get("session_shutdown")?.({ reason: "reload" }, ctx);
  expect(sent.filter((text) => text.includes(`[subagent message ${messageId}]`))).toHaveLength(1);
});
