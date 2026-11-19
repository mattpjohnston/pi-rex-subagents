import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

async function child(idle = false, failSends = 0) {
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
      sendUserMessage: (text: string) => {
        if (failSends-- > 0) throw new Error("send failed");
        sent.push(text);
        // Pi is busy from the moment it accepts a prompt.
        idle = false;
      },
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
    isIdle: () => idle,
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

const messageId = "0123abcd-0000-4000-8000-000000000001";
/** A message accepted earlier; sentAt null means not yet handed to Pi. */
async function accepted(run: RunRecord, sentAt: number | null): Promise<void> {
  await atomicWrite(join(run.paths.inbox, `${messageId}.json`), {
    id: messageId,
    runId: run.id,
    text: "hold before committing",
    sender: run.parentSessionId,
    createdAt: 1,
  });
  await atomicWrite(join(run.paths.inbox, `${messageId}.ack.json`), {
    messageId,
    runId: run.id,
    state: "accepted",
    acceptedAt: 1,
    sentAt,
  });
}
const sends = (sent: string[]) =>
  sent.filter((text) => text.includes(`[subagent message ${messageId}]`)).length;
/** Runs inbox polls until the condition holds, or two seconds of them pass. */
const pollUntil = async (done: () => boolean) => {
  for (let tick = 0; tick < 40 && !done(); tick++) {
    vi.advanceTimersByTime(250);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};
/** Lets a poll that was already running finish before the test removes its directory. */
const stop = async (
  handlers: Map<string, (event: unknown, ctx: unknown) => unknown>,
  ctx: unknown,
) => {
  await handlers.get("session_shutdown")?.({ reason: "reload" }, ctx);
  await new Promise((resolve) => setTimeout(resolve, 300));
};

it("settlement sends again a message Pi dropped after it was sent", async () => {
  const { run, handlers, ctx, sent } = await child();
  // Accepted and handed to Pi earlier, but never seen in a saved user message.
  await accepted(run, 2);
  vi.useFakeTimers({ toFake: ["setInterval"] });
  await handlers.get("session_start")?.({ reason: "startup" }, ctx);
  await handlers.get("agent_settled")?.({ aborted: false }, ctx);
  await handlers.get("session_shutdown")?.({ reason: "reload" }, ctx);
  expect(sent.filter((text) => text.includes(`[subagent message ${messageId}]`))).toHaveLength(1);
});

it("a send that throws during settlement is sent again at the next poll", async () => {
  const { run, handlers, ctx, sent } = await child(true, 1);
  await accepted(run, null);
  vi.useFakeTimers({ toFake: ["setInterval"] });
  await handlers.get("session_start")?.({ reason: "startup" }, ctx);
  await Promise.resolve(handlers.get("agent_settled")?.({ aborted: false }, ctx)).catch(
    () => undefined,
  );
  expect(sends(sent)).toBe(0);
  await pollUntil(() => sends(sent) > 0);
  await stop(handlers, ctx);
  expect(sends(sent)).toBe(1);
});

it("after a reload, an idle child sends again a message Pi dropped", async () => {
  const { run, handlers, ctx, sent } = await child(true);
  await accepted(run, 2);
  vi.useFakeTimers({ toFake: ["setInterval"] });
  await handlers.get("session_start")?.({ reason: "reload" }, ctx);
  await pollUntil(() => sends(sent) > 0);
  await stop(handlers, ctx);
  expect(sends(sent)).toBe(1);
});

it("a message dropped together with a child's outcome is sent again with it", async () => {
  const { run, handlers, ctx, sent } = await child();
  await accepted(run, null);
  const kid = { ...run, id: "e".repeat(24), label: "kid", parentRunId: run.id, background: true };
  kid.paths = runPaths(join(dirname(run.paths.run), "..", kid.id));
  await privateDirectory(kid.paths.inbox);
  Object.assign(kid, {
    lifecycle: "completed",
    finishedAt: 1,
    process: { state: "exited", code: 0 },
  });
  await writeRun(kid);
  await atomicWrite(kid.paths.result, {
    version: 1,
    runId: kid.id,
    outcome: "completed",
    assistantText: "kid done",
    sessionFile: null,
    effective: kid.effective,
    stopReason: "stop",
    reason: null,
    finishedAt: 1,
  });
  await writeFile(kid.paths.claim, "result");
  vi.useFakeTimers({ toFake: ["setInterval"] });
  await handlers.get("session_start")?.({ reason: "startup" }, ctx);
  await handlers.get("agent_settled")?.({ aborted: false }, ctx);
  expect(sends(sent)).toBe(1);
  // Pi dropped that turn and settled again without saving either.
  await new Promise((resolve) => setTimeout(resolve, 5));
  await handlers.get("agent_settled")?.({ aborted: false }, ctx);
  await stop(handlers, ctx);
  expect(sends(sent)).toBe(2);
  expect(sent.at(-1)).toContain(`[subagent outcome ${kid.id}]`);
});
