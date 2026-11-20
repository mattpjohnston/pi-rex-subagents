import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildChildArgv,
  ConcurrencyGate,
  launchSubagent,
  resolveModelSettings,
  type ActiveRun,
} from "../src/launch.ts";
import { RexEvents } from "../src/rex.ts";
import { markTakenOver, writeResult, type RunRecord } from "../src/store.ts";

let tmp: string;
let prevEnv: Record<string, string | undefined>;
let events: RexEvents;

function fakeModel(provider: string, id: string): Model<Api> {
  return {
    id,
    name: id,
    provider,
    api: "anthropic-messages",
    baseUrl: "https://example.com",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8192,
  };
}

async function createFakeRex(
  logPath: string,
  mode: "complete" | "crash" | "hold",
): Promise<string> {
  const script = join(tmp, `fake-rex-${mode}`);
  const code = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + "\\n");

if (args[0] === "whoami") {
  console.log(JSON.stringify({ endpoint: "unix:/tmp/fake-rex.sock" }));
  process.exit(0);
}
if (args[0] === "events") {
  setInterval(() => {}, 60000);
  return;
}
if (args[0] === "window" && args[1] === "new") {
  console.log(JSON.stringify({ window_id: "win:1", block_ids: ["blk:tab"] }));
  process.exit(0);
}
if (args[0] === "split") {
  console.log(JSON.stringify({ block_ids: ["blk:split"] }));
  process.exit(0);
}
if (args[0] === "api" && args[1] === "call" && args[2] === "session.new_layer") {
  console.log(JSON.stringify({ block_ids: ["blk:float"] }));
  process.exit(0);
}
if (args[0] === "api" && args[1] === "call" && (args[2] === "session.detach_block" || args[2] === "session.set_block_label")) {
  console.log(JSON.stringify({ ok: true }));
  process.exit(0);
}
if (args[0] === "block" && args[1] === "inspect") {
  const blockId = args[4];
  console.log(JSON.stringify({ session_id: args[3], block: { block_id: blockId, window_id: blockId === "blk:detached" ? null : "win:1" } }));
  process.exit(0);
}
if (args[0] === "block" && args[1] === "call" && args[6] === "process") {
  const state = ${JSON.stringify(mode)};
  if (state === "crash") {
    console.log(JSON.stringify({ last_exit: { exit_code: 1 } }));
  } else if (state === "complete") {
    const runsDir = ${JSON.stringify(join(tmp, "state", "runs"))};
    const done = fs.existsSync(runsDir) && fs.readdirSync(runsDir).some((id) =>
      fs.existsSync(runsDir + "/" + id + "/result.json")
    );
    console.log(JSON.stringify(done ? { last_exit: { exit_code: 0 } } : { child: { pid: 999999 } }));
  } else {
    console.log(JSON.stringify({ child: { pid: 999999 } }));
  }
  process.exit(0);
}
if (args[0] === "block" && args[1] === "close") {
  process.exit(0);
}
if (args[0] === "capture") {
  console.log("Error: invalid API key\\n");
  process.exit(0);
}
console.log(JSON.stringify({}));
`;
  await writeFile(script, code, { mode: 0o755 });
  await chmod(script, 0o755);
  return script;
}

function fakeCtx(cwd: string): ExtensionContext {
  const models = [
    fakeModel("anthropic", "claude-sonnet-4-5"),
    fakeModel("claude-bridge", "claude-opus-5-5"),
  ];
  return {
    cwd,
    model: models[0],
    thinkingLevel: "low",
    modelRegistry: {
      find: (provider: string, id: string) =>
        models.find((m) => m.provider === provider && m.id === id),
    },
    sessionManager: { getSessionId: () => "parent-sess-1" },
  } as unknown as ExtensionContext;
}

beforeEach(async () => {
  tmp = await realpath(await mkdtemp(join(tmpdir(), "pirs-launch-")));
  prevEnv = {
    PI_SUBAGENTS_STATE_DIR: process.env.PI_SUBAGENTS_STATE_DIR,
    PI_SUBAGENTS_REX: process.env.PI_SUBAGENTS_REX,
    PI_SUBAGENTS_PI: process.env.PI_SUBAGENTS_PI,
    REX_SESSION: process.env.REX_SESSION,
    REX_BLOCK: process.env.REX_BLOCK,
  };
  const fakePi = join(tmp, "fake-pi");
  await writeFile(fakePi, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  process.env.PI_SUBAGENTS_STATE_DIR = join(tmp, "state");
  process.env.PI_SUBAGENTS_PI = fakePi;
  process.env.REX_SESSION = "session:parent";
  process.env.REX_BLOCK = "block:parent";
  events = new RexEvents();
});

afterEach(async () => {
  events.stop();
  for (const [key, val] of Object.entries(prevEnv)) {
    if (val === undefined) delete process.env[key];
    else process.env[key] = val;
  }
  await rm(tmp, { recursive: true, force: true });
});

describe("launch", () => {
  it("resolves inherited and provider-qualified models without silent fallback", () => {
    const find = (p: string, id: string) =>
      p === "openrouter" && id === "google/gemini-2.5" ? fakeModel(p, id) : undefined;
    expect(
      resolveModelSettings(
        { provider: "openrouter", model: "google/gemini-2.5", thinking: "medium" },
        {},
        find,
      ),
    ).toEqual({ provider: "openrouter", model: "google/gemini-2.5", thinking: "medium" });

    expect(
      resolveModelSettings(undefined, { model: "openrouter/google/gemini-2.5" }, find),
    ).toEqual({ provider: "openrouter", model: "google/gemini-2.5", thinking: "off" });

    expect(() => resolveModelSettings(undefined, { provider: "nope", model: "x" }, find)).toThrow(
      "Unknown model selection",
    );
  });

  it("builds readOnly argv with --tools read,grep,find,ls --no-mcp (keeping extensions)", async () => {
    const run: RunRecord = {
      version: 2,
      id: "aaaaaaaaaaaaaaaaaaaa",
      label: "research",
      parentSessionId: "sess-1",
      cwd: tmp,
      repoRoot: null,
      readOnly: true,
      background: false,
      placement: "tab",
      keepOpen: false,
      model: { provider: "claude-bridge", model: "claude-opus-5-5", thinking: "low" },
      continueFrom: null,
      rex: null,
      status: "queued",
      waiting: null,
      sessionFile: null,
      diagnostic: null,
      createdAt: 1,
      finishedAt: null,
    };
    const inlineArgv = await buildChildArgv(
      run,
      "/ext/index.ts",
      "Check README.md",
      "/prev/session.jsonl",
    );
    expect(inlineArgv).toContain("--tools");
    expect(inlineArgv).toContain("read,grep,find,ls");
    expect(inlineArgv).toContain("--no-mcp");
    expect(inlineArgv).not.toContain("--no-extensions");
    expect(inlineArgv).toContain("--fork");
    expect(inlineArgv).toContain("/prev/session.jsonl");
    expect(inlineArgv.slice(-2)).toEqual(["--", "Check README.md"]);

    const fileFallback = await buildChildArgv(run, "/ext/index.ts", "@weird-prefix");
    expect(fileFallback.at(-1)).toMatch(/^@.*task\.md$/);
  });

  it("enforces concurrency cap and supports abort while queued", async () => {
    const gate = new ConcurrencyGate();
    const release1 = await gate.acquire(1);
    const ac = new AbortController();
    const queued = gate.acquire(1, ac.signal);
    ac.abort();
    await expect(queued).rejects.toThrow("Aborted while queued");
    release1();
    const release2 = await gate.acquire(1);
    release2();
  });

  it("launches tab, split, float, and detached panes via user config placement", async () => {
    const log = join(tmp, "rex.log");
    process.env.PI_SUBAGENTS_REX = await createFakeRex(log, "complete");
    const gate = new ConcurrencyGate();
    const live = new Map<string, ActiveRun>();
    await mkdir(join(tmp, "state"), { recursive: true });

    for (const placement of ["tab", "split", "float", "detached"] as const) {
      await writeFile(join(tmp, "state", "config.json"), JSON.stringify({ placement }));
      const handle = await launchSubagent({
        input: { task: "say hi", label: `p-${placement}`, background: true },
        ctx: fakeCtx(tmp),
        entry: "/ext/index.ts",
        events,
        gate,
        liveRuns: live,
      });
      await writeResult({
        version: 2,
        runId: handle.run.id,
        outcome: "completed",
        assistantText: `ok ${placement}`,
        stopReason: "stop",
        reason: null,
        sessionFile: "/tmp/s.jsonl",
        model: handle.run.model,
        finishedAt: Date.now(),
      });
      const outcome = await handle.done;
      expect(outcome.run.status).toBe("completed");
      expect(outcome.result?.assistantText).toBe(`ok ${placement}`);
    }

    const calls = await readFile(log, "utf8");
    expect(calls).toContain('"window","new"');
    expect(calls).toContain('"split"');
    expect(calls).toContain('"session.new_layer"');
    expect(calls).toContain('"session.detach_block"');
  });

  it("captures terminal tail when child crashes before writing a result", async () => {
    const log = join(tmp, "rex-crash.log");
    process.env.PI_SUBAGENTS_REX = await createFakeRex(log, "crash");
    const handle = await launchSubagent({
      input: { task: "boom", label: "crasher" },
      ctx: fakeCtx(tmp),
      entry: "/ext/index.ts",
      events,
      gate: new ConcurrencyGate(),
      liveRuns: new Map(),
    });
    const outcome = await handle.done;
    expect(outcome.run.status).toBe("failed");
    expect(outcome.run.diagnostic).toContain("invalid API key");
  });

  it("blocks duplicate non-worktree writers in the same repo and allows worktree writers", async () => {
    const repo = join(tmp, "repo");
    await mkdir(repo);
    execFileSync("git", ["-C", repo, "init", "-q", "-b", "main"]);
    execFileSync("git", ["-C", repo, "config", "user.email", "t@e.com"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "T"]);
    await writeFile(join(repo, "a.txt"), "hi\n");
    execFileSync("git", ["-C", repo, "add", "."]);
    execFileSync("git", ["-C", repo, "commit", "-q", "-m", "init"]);

    const log = join(tmp, "rex-hold.log");
    process.env.PI_SUBAGENTS_REX = await createFakeRex(log, "hold");
    const gate = new ConcurrencyGate();
    const live = new Map<string, ActiveRun>();

    const first = await launchSubagent({
      input: { task: "edit 1", label: "w1", background: true },
      ctx: fakeCtx(repo),
      entry: "/ext/index.ts",
      events,
      gate,
      liveRuns: live,
    });

    await expect(
      launchSubagent({
        input: { task: "edit 2", label: "w2", background: true },
        ctx: fakeCtx(repo),
        entry: "/ext/index.ts",
        events,
        gate,
        liveRuns: live,
      }),
    ).rejects.toThrow("worktree: true");

    // Worktree writer in same repo succeeds concurrently.
    const second = await launchSubagent({
      input: { task: "edit 2", label: "w2", worktree: true, background: true },
      ctx: fakeCtx(repo),
      entry: "/ext/index.ts",
      events,
      gate,
      liveRuns: live,
    });
    expect(second.run.worktree?.branch).toContain("subagent/w2-");

    // Taking over first leaves it taken_over; cancelling second cancels cleanly.
    await markTakenOver(first.run.id);
    expect(await first.cancel()).toBe("taken_over");
    expect(await second.cancel()).toBe("cancelled");
    await Promise.all([first.done, second.done]);
  });
});
