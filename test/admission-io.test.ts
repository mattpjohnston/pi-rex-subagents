import { execFileSync, spawn } from "node:child_process";
import { watch, existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { canonicalTarget, checkoutRoot } from "../src/checkout.ts";
import { contains, overlaps } from "../src/admission-core.ts";
import { admit, readLimits, tryWake, writerOnPath } from "../src/admission.ts";
import { privateDirectory, runPaths, writeRun, type RunRecord } from "../src/records.ts";
import { recoverStaleLock, withLock } from "../src/locks.ts";

async function scratch(body: (dir: string) => Promise<void>) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "pirs-admission-test-")));
  const previous = process.env.PI_SUBAGENTS_STATE_DIR;
  process.env.PI_SUBAGENTS_STATE_DIR = dir;
  try {
    await body(dir);
  } finally {
    if (previous === undefined) delete process.env.PI_SUBAGENTS_STATE_DIR;
    else process.env.PI_SUBAGENTS_STATE_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
}
it("waiters automatically recover a dead run holder instead of timing out", async () => {
  await scratch(async (dir) => {
    const lock = join(dir, "run-lock");
    await mkdir(lock);
    await writeFile(
      join(lock, "holder.json"),
      JSON.stringify({ pid: process.pid, startTime: "earlier incarnation", token: "stale" }),
    );
    await withLock(
      lock,
      async () => {
        expect(JSON.parse(await readFile(join(lock, "holder.json"), "utf8"))).toMatchObject({
          pid: process.pid,
        });
      },
      () => recoverStaleLock(lock),
    );
    await expect(stat(lock)).rejects.toMatchObject({ code: "ENOENT" });
  });
}, 3000);
it("publishes the lock and its holder atomically to another process", async () => {
  await scratch(async (dir) => {
    const lock = join(dir, "run-lock");
    const observations: boolean[] = [];
    const watcher = watch(dir, (_event, name) => {
      if (name !== "run-lock" || !existsSync(lock)) return;
      try {
        JSON.parse(readFileSync(join(lock, "holder.json"), "utf8"));
        observations.push(true);
      } catch (error) {
        if (existsSync(lock)) observations.push(false);
        else if (!(error instanceof Error)) throw error;
      }
    });
    try {
      const source = new URL("../src/locks.ts", import.meta.url).href;
      const child = spawn(process.execPath, [
        "--input-type=module",
        "-e",
        `import {recoverStaleLock, withLock} from ${JSON.stringify(source)}; const lock = ${JSON.stringify(lock)}; await withLock(lock,()=>new Promise(r=>setTimeout(r,100)),()=>recoverStaleLock(lock));`,
      ]);
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code) => (code ? reject(new Error(`lock worker ${code}`)) : resolve()));
      });
      expect(observations.length).toBeGreaterThan(0);
      expect(observations.every(Boolean)).toBe(true);
    } finally {
      watcher.close();
    }
  });
});
it("reads limits fresh, defaults only when absent, and names malformed files", async () => {
  await scratch(async (dir) => {
    expect(await readLimits()).toMatchObject({ active: 4, depth: 2, providers: {} });
    const path = join(dir, "limits.json");
    await writeFile(path, JSON.stringify({ active: 2, providers: { p: 1 } }));
    expect(await readLimits()).toMatchObject({ active: 2, depth: 2, providers: { p: 1 } });
    await writeFile(path, JSON.stringify({ active: 1, depth: 3 }));
    expect((await readLimits()).active).toBe(1);
    for (const invalid of [
      "{",
      "null",
      '{"active":0}',
      '{"providers":{"p":1.2}}',
      '{"unexpected":1}',
    ]) {
      await writeFile(path, invalid);
      await expect(readLimits()).rejects.toThrow(path);
    }
  });
});
it("canonicalizes worktrees, subdirectories, nested repositories, aliases and new guard paths", async () => {
  await scratch(async (dir) => {
    const outer = join(dir, "outer"),
      nested = join(outer, "nested"),
      sub = join(outer, "sub");
    await mkdir(sub, { recursive: true });
    await mkdir(nested);
    execFileSync("git", ["init", "-q", outer]);
    execFileSync("git", ["init", "-q", nested]);
    const alias = join(dir, "alias");
    await symlink(outer, alias);
    expect(await checkoutRoot(sub)).toBe(await checkoutRoot(alias));
    expect(overlaps(await checkoutRoot(outer), await checkoutRoot(nested))).toBe(true);
    expect(overlaps(dir, await checkoutRoot(outer))).toBe(true);
    expect(await canonicalTarget(dir, "@alias/new/deep/file")).toBe(join(outer, "new/deep/file"));
    expect(await canonicalTarget(sub, "../nested/file")).toBe(join(nested, "file"));
    expect(contains("/repo", "/repo-other/file")).toBe(false);
    expect(contains("/", "/repo/file")).toBe(true);
  });
});

it("serializes four real processes through stale recovery and repeated release", async () => {
  await scratch(async (dir) => {
    const lock = join(dir, "race-lock");
    await mkdir(lock);
    await writeFile(
      join(lock, "holder.json"),
      JSON.stringify({ pid: process.pid, startTime: "old incarnation", token: "stale" }),
    );
    const source = new URL("../src/locks.ts", import.meta.url).href;
    const worker = `import {withLock,recoverStaleLock} from ${JSON.stringify(source)}; import {open,unlink,appendFile} from 'node:fs/promises'; const lock=${JSON.stringify(lock)}, marker=${JSON.stringify(join(dir, "exclusive"))}, log=${JSON.stringify(join(dir, "operations"))}; for(let i=0;i<25;i++) await withLock(lock,async()=>{const fd=await open(marker,'wx');await fd.close();await new Promise(r=>setTimeout(r,2));await appendFile(log,'x');await unlink(marker);},()=>recoverStaleLock(lock));`;
    await Promise.all(
      Array.from(
        { length: 4 },
        () =>
          new Promise<void>((resolve, reject) => {
            const child = spawn(process.execPath, ["--input-type=module", "-e", worker]);
            let err = "";
            child.stderr.on("data", (data: Buffer) => {
              err += data.toString();
            });
            child.once("error", reject);
            child.once("exit", (code) =>
              code ? reject(new Error(`Lock contender failed: ${err}`)) : resolve(),
            );
          }),
      ),
    );
    expect((await readFile(join(dir, "operations"), "utf8")).length).toBe(100);
  });
}, 15000);

it("admission writes no measurement file, whatever the environment says", async () => {
  const root = await mkdtemp(join(tmpdir(), "pirs-admit-"));
  const metrics = join(root, "metrics.ndjson");
  const previous = { ...process.env };
  process.env.PI_SUBAGENTS_STATE_DIR = root;
  process.env.PI_SUBAGENTS_ADMISSION_METRICS = metrics;
  try {
    const id = "c".repeat(24);
    const dir = join(root, "runs", id);
    await privateDirectory(dir);
    const settings = { provider: "p", model: "test", thinking: "off" as const };
    const run: RunRecord = {
      version: 1,
      id,
      label: "admitted",
      taskPath: join(dir, "task.md"),
      cwd: root,
      checkoutRoot: root,
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
    await writeRun(run);
    expect(await admit(run)).toBe(true);
    expect(existsSync(metrics)).toBe(false);
  } finally {
    process.env = previous;
    await rm(root, { recursive: true, force: true });
  }
});

it("admission never holds its lock while asking Rex about members", async () => {
  await scratch(async (dir) => {
    const log = join(dir, "rex.log");
    const rex = join(dir, "rex");
    await writeFile(
      rex,
      `#!/bin/sh
if [ -d '${join(dir, "lock")}' ]; then echo locked >> '${log}'; else echo free >> '${log}'; fi
case "$1 $2" in
  'block inspect') printf '%s\\n' '{"session_id":"s","block":{"window_id":"w"}}' ;;
  'block call') printf '%s\\n' '{"last_exit":null,"child":{"pid":4242}}' ;;
  *) exit 1 ;;
esac
`,
      { mode: 0o700 },
    );
    const previousRex = process.env.PI_SUBAGENTS_REX;
    process.env.PI_SUBAGENTS_REX = rex;
    try {
      const make = async (id: string, access: RunRecord["access"]): Promise<RunRecord> => {
        const runDir = join(dir, "runs", id);
        await privateDirectory(runDir);
        const settings = { provider: "p", model: "test", thinking: "off" as const };
        const run: RunRecord = {
          version: 1,
          id,
          label: id.slice(0, 4),
          taskPath: join(runDir, "task.md"),
          cwd: dir,
          checkoutRoot: dir,
          access,
          requested: settings,
          effective: settings,
          background: false,
          continueFrom: null,
          parentSessionId: "parent",
          parentRunId: null,
          depth: 1,
          activity: { parked: "settled", readyToWake: true, tools: [], foreground: [] },
          rex: null,
          location: null,
          paths: runPaths(runDir),
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
        await writeRun(run);
        return run;
      };
      const member = await make("d".repeat(24), "read");
      expect(await admit(member)).toBe(true);
      member.rex = { sessionId: "s", windowId: "w", blockId: "b" };
      await writeRun(member);
      await writeFile(log, "");
      await writerOnPath(join(dir, "file.txt"));
      await tryWake(member.id);
      expect(await admit(await make("e".repeat(24), "read"))).toBe(true);
      const calls = (await readFile(log, "utf8")).split("\n").filter(Boolean);
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.filter((state) => state === "locked")).toEqual([]);
    } finally {
      if (previousRex === undefined) delete process.env.PI_SUBAGENTS_REX;
      else process.env.PI_SUBAGENTS_REX = previousRex;
    }
  });
});
