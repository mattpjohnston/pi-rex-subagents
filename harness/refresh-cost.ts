/**
 * Counts the Rex calls and time of the parent's periodic refresh.
 *
 *   node harness/refresh-cost.ts copy <state-dir> <parent-pi-session-id> [passes]
 *   node harness/refresh-cost.ts synthetic <runs> <sessions> [passes]
 *
 * `copy` measures a copy of an existing state directory, so the original is never written.
 * `synthetic` creates <sessions> Rex sessions named pirs-h-cost-*, writes <runs> completed
 * records against them (a few with open exited tabs, most with tabs closed long ago, some
 * failed), measures, and kills only the sessions it created.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, RunRecord, runPaths } from "../src/records.ts";
import { object, Rex, success } from "./lib/rex.ts";

const [mode, first, second, passArg] = process.argv.slice(2);
const passes = Number(passArg ?? 3);
const scratch = await mkdtemp(join(tmpdir(), "pirs-refresh-cost-"));
const log = join(scratch, "rex-calls.log");
const wrapper = join(scratch, "rex");
const realRex = execFileSync("/bin/sh", ["-c", "command -v rex"], { encoding: "utf8" }).trim();
await writeFile(wrapper, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec '${realRex}' "$@"\n`);
await chmod(wrapper, 0o700);
await writeFile(log, "");
const state = join(scratch, "state");
const created: string[] = [];
const rex = new Rex();
let parentSessionId: string;

const ID = () => randomBytes(12).toString("hex");
function record(input: {
  parentSessionId: string;
  lifecycle: RunRecord["lifecycle"];
  location: { sessionId: string; windowId: string; blockId: string };
  label: string;
}): RunRecord {
  const id = ID();
  const dir = join(state, "runs", id);
  const settings = { provider: "bench", model: "bench", thinking: "off" as const };
  const now = Date.now() - 40 * 86_400_000;
  return {
    version: 1,
    id,
    label: input.label,
    taskPath: join(dir, "task.md"),
    cwd: scratch,
    checkoutRoot: scratch,
    access: "write",
    requested: settings,
    effective: settings,
    background: false,
    continueFrom: null,
    parentSessionId: input.parentSessionId,
    parentRunId: null,
    depth: 1,
    rex: input.location,
    location: input.location,
    paths: {
      run: join(dir, "run.json"),
      result: join(dir, "result.json"),
      claim: join(dir, "claim"),
      lock: join(dir, "lock"),
      events: join(dir, "events.jsonl"),
      inbox: join(dir, "inbox"),
      sessionDir: join(dir, "session"),
    },
    lifecycle: input.lifecycle,
    process: { state: "exited", code: 0 },
    waiting: null,
    queue: null,
    sessionFile: null,
    diagnostic: null,
    createdAt: now,
    updatedAt: now,
    loadedAt: now,
    finishedAt: now,
  };
}
async function writeRecord(run: RunRecord, claim: string): Promise<void> {
  await mkdir(join(state, "runs", run.id), { recursive: true, mode: 0o700 });
  await writeFile(run.paths.run, `${JSON.stringify(run)}\n`, { mode: 0o600 });
  await writeFile(run.paths.claim, claim, { mode: 0o600 });
}

async function synthetic(runs: number, sessions: number): Promise<void> {
  parentSessionId = `bench-${ID()}`;
  const open: { sessionId: string; windowId: string; blockId: string }[] = [];
  for (let index = 0; index < sessions; index += 1) {
    const label = `pirs-h-cost-${index}`;
    const made = object(
      success(
        await rex.command([
          "new",
          label,
          "--window",
          "anchor",
          "--keep-open",
          "--shell",
          "none",
          "--json",
          "--",
          "sleep",
          "600",
        ]),
      ).data,
    );
    const sessionId = String(made.session_id);
    created.push(sessionId);
    const tab = object(
      success(
        await rex.command([
          "window",
          "new",
          "-s",
          sessionId,
          `open-${index}`,
          "--focus=false",
          "--keep-open",
          "--shell",
          "none",
          "--json",
          "--",
          "true",
        ]),
      ).data,
    );
    const blocks = tab.block_ids;
    if (!Array.isArray(blocks)) throw new Error("Rex did not return the new tab's block");
    open.push({ sessionId, windowId: String(tab.window_id), blockId: String(blocks[0]) });
  }
  for (let index = 0; index < runs; index += 1) {
    const tab = open[index];
    const failed = index >= open.length && index % 8 === 0;
    const where = tab ?? {
      sessionId: created[index % created.length] ?? "",
      windowId: `window:${ID()}`,
      blockId: `block:01a1a2cc-0000-7000-8000-${ID().slice(0, 12)}`,
    };
    await writeRecord(
      record({
        parentSessionId,
        lifecycle: failed ? "failed" : "completed",
        location: where,
        label: tab ? `open-${index}` : `gone-${index}`,
      }),
      "result",
    );
  }
}

const measure = async (): Promise<void> => {
  delete process.env.PI_SUBAGENTS_RUN_ID;
  delete process.env.PI_SUBAGENTS_RUN_DIR;
  process.env.PI_SUBAGENTS_STATE_DIR = state;
  process.env.PI_SUBAGENTS_REX = wrapper;
  let tick: (() => void) | undefined;
  globalThis.setInterval = ((callback: () => void) => {
    tick = callback;
    return 0;
  }) as unknown as typeof setInterval;
  let settle: (() => void) | undefined;
  const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
  const listeners = new Map<string, ((data: unknown) => void)[]>();
  const pi = {
    on: (name: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) =>
      handlers.set(name, handler),
    events: {
      emit: (channel: string, data: unknown) => {
        for (const listener of listeners.get(channel) ?? []) listener(data);
      },
      on: (channel: string, listener: (data: unknown) => void) => {
        listeners.set(channel, [...(listeners.get(channel) ?? []), listener]);
        return () =>
          listeners.set(
            channel,
            (listeners.get(channel) ?? []).filter((l) => l !== listener),
          );
      },
    },
    registerCommand: () => {},
    registerTool: () => {},
    sendMessage: () => {},
  };
  let failure: string | undefined;
  const ctx = {
    cwd: scratch,
    isIdle: () => true,
    sessionManager: { getSessionId: () => parentSessionId, getBranch: () => [] },
    ui: {
      setWidget: () => settle?.(),
      setStatus: (_id: string, text: string) => {
        failure = text;
        settle?.();
      },
      notify: () => {},
    },
  };
  const extension = (await import("../src/index.ts")) as {
    default: (pi: unknown) => Promise<void>;
  };
  await extension.default(pi);
  const results = [];
  for (let pass = 1; pass <= passes; pass += 1) {
    const before = (await readFile(log, "utf8")).split("\n").filter(Boolean).length;
    const done = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const started = performance.now();
    if (pass === 1) await handlers.get("session_start")?.({ reason: "startup" }, ctx);
    else tick?.();
    await done;
    const ms = performance.now() - started;
    const calls = (await readFile(log, "utf8")).split("\n").filter(Boolean).length - before;
    results.push({ pass, calls, ms: Math.round(ms) });
    if (failure) throw new Error(`refresh failed: ${failure}`);
  }
  await handlers.get("session_shutdown")?.({ reason: "reload" }, ctx);
  const runs = (await import("../src/records.ts")).listRuns;
  console.log(JSON.stringify({ runs: (await runs()).length, results }));
};

try {
  if (mode === "copy" && first && second) {
    await mkdir(state, { recursive: true, mode: 0o700 });
    await cp(join(first, "runs"), join(state, "runs"), { recursive: true });
    for (const id of await readdir(join(state, "runs"))) {
      if (!/^[a-f0-9]{24}$/.test(id)) continue;
      const dir = join(state, "runs", id);
      const path = join(dir, "run.json");
      const run = parse(RunRecord, JSON.parse(await readFile(path, "utf8")));
      run.paths = runPaths(dir);
      run.taskPath = join(dir, "task.md");
      await writeFile(path, `${JSON.stringify(run)}\n`);
    }
    parentSessionId = second;
  } else if (mode === "synthetic" && first && second) {
    await synthetic(Number(first), Number(second));
  } else {
    throw new Error(
      "Usage: refresh-cost.ts copy <state-dir> <parent-session-id> | synthetic <runs> <sessions>",
    );
  }
  const listed = object(success(await rex.listSessions()).data);
  console.error(`Rex sessions: ${Array.isArray(listed.sessions) ? listed.sessions.length : "?"}`);
  await measure();
} finally {
  for (const id of created) await rex.killSession(id);
  await rm(scratch, { recursive: true, force: true });
}
