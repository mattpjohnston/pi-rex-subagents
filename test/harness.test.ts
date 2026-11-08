import { existsSync } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { parentArgv } from "../harness/lib/pi.ts";
import { object, Rex, success } from "../harness/lib/rex.ts";
import { repo } from "../harness/lib/run.ts";
import type { Run } from "../harness/lib/run.ts";

const scratch: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

test.each([3, 4, 7])("Rex wrapper preserves subprocess exit code %i", async (code) => {
  vi.stubEnv("PI_SUBAGENTS_REX", process.execPath);
  const result = await new Rex().command([
    "-e",
    `process.stderr.write('diagnostic'); process.exit(${code});`,
  ]);
  expect(result.code).toBe(code);
  expect(result.stderr).toBe("diagnostic");
  expect(() => success(result)).toThrow(`Rex exited ${code}`);
});

test("Rex wrapper parses JSON and passes argv without shell expansion", async () => {
  vi.stubEnv("PI_SUBAGENTS_REX", process.execPath);
  const argv = ["space here", "$(exit 5)", "; exit 9"];
  const logs: unknown[] = [];
  const rex = new Rex(async (args, result) => {
    logs.push({ args, result });
  });
  const result = success(
    await rex.command([
      "-e",
      "console.log(JSON.stringify({args:process.argv.slice(1)}))",
      "--",
      ...argv,
    ]),
  );
  expect(object(result.data).args).toEqual(argv);
  expect(logs).toHaveLength(1);
});

test("Rex wrapper rejects malformed successful JSON, but records the reply", async () => {
  vi.stubEnv("PI_SUBAGENTS_REX", process.execPath);
  const logs: unknown[] = [];
  const rex = new Rex(async (_args, result) => {
    logs.push(result.stdout);
  });
  await expect(rex.command(["-e", "console.log('not json')"])).rejects.toThrow();
  expect(logs).toEqual(["not json\n"]);
  expect(object({ valid: true }).valid).toBe(true);
  expect(() => object([])).toThrow();
  expect(() => object(null)).toThrow();
});

test("Rex wrapper fails on a missing executable rather than calling it gone", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-test-"));
  scratch.push(dir);
  vi.stubEnv("PI_SUBAGENTS_REX", join(dir, "missing"));
  await expect(new Rex().listSessions()).rejects.toThrow();
});

test("parent argv isolates state and sessions and forwards only harness paths and explicit executable configuration", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-test-"));
  scratch.push(dir);
  vi.stubEnv("PI_SUBAGENTS_PI", process.execPath);
  vi.stubEnv("HARNESS_MODEL", "provider/test-model");
  vi.stubEnv("PI_SUBAGENTS_REX", undefined);
  vi.stubEnv("PI_CODING_AGENT_DIR", undefined);
  const run = {
    scratch: dir,
    state: join(dir, "state"),
    sessions: dir,
    out: join(dir, "out"),
    rex: new Rex(),
    record: async () => {},
    newSession: async () => {
      throw new Error("unused");
    },
  } satisfies Run;
  const argv = await parentArgv(run, "parent", "prompt with spaces; literal");
  expect(argv).toEqual([
    "/usr/bin/env",
    `PI_SUBAGENTS_STATE_DIR=${run.state}`,
    `HARNESS_TOOL_LOG=${join(run.out, "parent-tools.jsonl")}`,
    `PI_SUBAGENTS_PI=${process.execPath}`,
    process.execPath,
    "--no-extensions",
    "-e",
    join(repo, "src", "index.ts"),
    "-e",
    join(repo, "harness", "log-tools.ts"),
    "--model",
    "provider/test-model",
    "--thinking",
    "low",
    "--session-dir",
    join(dir, "parent"),
    "prompt with spaces; literal",
  ]);
  expect((await stat(join(dir, "parent"))).mode & 0o777).toBe(0o700);
  await expect(parentArgv(run, "../escape", "prompt")).rejects.toThrow("Invalid Pi session label");
  expect(existsSync(join(dir, "escape"))).toBe(false);
  vi.stubEnv("PI_SUBAGENTS_PI", join(dir, "missing"));
  await expect(parentArgv(run, "other", "prompt")).rejects.toThrow("Pi executable not found");
});
