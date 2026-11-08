import { execFileSync, spawn } from "node:child_process";
import { watch, existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { canonicalTarget, checkoutRoot } from "../src/checkout.ts";
import { contains, overlaps } from "../src/admission-core.ts";
import { readLimits } from "../src/admission.ts";
import { withRunLock } from "../src/claims.ts";

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
    await withRunLock(lock, async () => {
      expect(JSON.parse(await readFile(join(lock, "holder.json"), "utf8"))).toMatchObject({
        pid: process.pid,
      });
    });
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
      const source = new URL("../src/claims.ts", import.meta.url).href;
      const child = spawn(process.execPath, [
        "--input-type=module",
        "-e",
        `import {withRunLock} from ${JSON.stringify(source)}; await withRunLock(${JSON.stringify(lock)},()=>new Promise(r=>setTimeout(r,100)));`,
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
    expect(await readLimits()).toEqual({ active: 4, depth: 2, providers: {} });
    const path = join(dir, "limits.json");
    await writeFile(path, JSON.stringify({ active: 2, providers: { p: 1 } }));
    expect(await readLimits()).toEqual({ active: 2, depth: 2, providers: { p: 1 } });
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
