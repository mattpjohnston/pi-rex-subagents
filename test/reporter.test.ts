import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerReporter, TrustStatus } from "../src/reporter.ts";
import { isTakenOver, readResult, writeRun, type RunRecord } from "../src/store.ts";

let dir: string;
let prevState: string | undefined;

function sampleRun(id: string): RunRecord {
  return {
    version: 2,
    id,
    label: "worker",
    parentSessionId: "sess-1",
    cwd: "/tmp",
    repoRoot: null,
    access: "write",
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
    createdAt: 100,
    finishedAt: null,
  };
}

function fakePi() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const commands = new Map<
    string,
    { handler: (args: string, ctx: ExtensionContext) => Promise<void> }
  >();
  const pi = {
    on: (name: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(name, fn);
      return () => handlers.delete(name);
    },
    registerCommand: (
      name: string,
      def: { handler: (args: string, ctx: ExtensionContext) => Promise<void> },
    ) => {
      commands.set(name, def);
    },
    getThinkingLevel: () => "low" as const,
  } as unknown as ExtensionAPI;

  const shutdown = vi.fn();
  const notify = vi.fn();
  const ctx = {
    model: { provider: "anthropic", id: "claude-sonnet-4-5" },
    sessionManager: {
      getSessionFile: () => "/tmp/child-session.jsonl",
      getBranch: () => [
        {
          type: "message",
          message: {
            role: "assistant",
            stopReason: "stop",
            content: [{ type: "text", text: "Finished task." }],
          },
        },
      ],
    },
    ui: { notify },
    shutdown,
  } as unknown as ExtensionContext;

  return { pi, handlers, commands, ctx, shutdown, notify };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pirs-rep-"));
  prevState = process.env.PI_SUBAGENTS_STATE_DIR;
  process.env.PI_SUBAGENTS_STATE_DIR = dir;
});

afterEach(async () => {
  vi.useRealTimers();
  if (prevState === undefined) delete process.env.PI_SUBAGENTS_STATE_DIR;
  else process.env.PI_SUBAGENTS_STATE_DIR = prevState;
  await rm(dir, { recursive: true, force: true });
});

describe("reporter", () => {
  it("writes result.json and shuts down on agent_settled", async () => {
    const run = sampleRun("aaaaaaaaaaaaaaaaaaaa");
    await writeRun(run);
    const { pi, handlers, ctx, shutdown } = fakePi();
    registerReporter(pi, run);

    await handlers.get("agent_settled")?.({ type: "agent_settled", aborted: false }, ctx);
    const result = await readResult(run.id);
    expect(result).toMatchObject({
      outcome: "completed",
      assistantText: "Finished task.",
      sessionFile: "/tmp/child-session.jsonl",
    });
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it("stops reporting and stays open after /subagent-takeover", async () => {
    const run = sampleRun("bbbbbbbbbbbbbbbbbbbb");
    await writeRun(run);
    const { pi, handlers, commands, ctx, shutdown } = fakePi();
    registerReporter(pi, run);

    await commands.get("subagent-takeover")?.handler("", ctx);
    expect(await isTakenOver(run.id)).toBe(true);

    await handlers.get("agent_settled")?.({ type: "agent_settled", aborted: false }, ctx);
    expect(await readResult(run.id)).toBeNull();
    expect(shutdown).not.toHaveBeenCalled();
  });

  it("writes a failed result on unexpected quit before settlement", async () => {
    const run = sampleRun("cccccccccccccccccccc");
    await writeRun(run);
    const { pi, handlers, ctx } = fakePi();
    registerReporter(pi, run);

    await handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, ctx);
    const result = await readResult(run.id);
    expect(result?.outcome).toBe("failed");
    expect(result?.reason).toContain("quit");
  });

  it("emits OSC 7501 blocked status for project_trust and clears on end", () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    const trust = new TrustStatus((seq) => writes.push(seq));

    trust.prompt();
    expect(writes).toEqual([]);
    vi.advanceTimersByTime(500);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain("state=blocked:app=pi:kind=permission");

    trust.end();
    expect(writes).toHaveLength(2);
    expect(writes[1]).toContain("state=idle:app=pi");
  });
});
