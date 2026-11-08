import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { parseBlockEvent, type BlockEvent } from "../../src/rex.ts";
import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  parse,
  RunRecord,
  ChildEvent,
  ResultFile,
  type ChildEvent as Event,
} from "../../src/records.ts";
import type { LaunchInput } from "../../src/launch.ts";
import { parentArgv } from "./pi.ts";
import { repo, type Run } from "./run.ts";
import { object, success } from "./rex.ts";

export async function until<T>(
  description: string,
  check: () => Promise<T | null | undefined | false>,
  timeout = 120_000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value !== false && value !== undefined && value !== null) return value;
    await delay(200);
  }
  throw new Error(`Timed out: ${description}`);
}
export async function maybeFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}
export async function records(run: Run): Promise<RunRecord[]> {
  let ids: string[];
  try {
    ids = await readdir(join(run.state, "runs"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  return Promise.all(
    ids.map(async (id) =>
      parse(RunRecord, JSON.parse(await readFile(join(run.state, "runs", id, "run.json"), "utf8"))),
    ),
  );
}
export async function events(record: RunRecord): Promise<Event[]> {
  const raw = await maybeFile(record.paths.events);
  if (!raw) return [];
  return raw
    .trim()
    .split("\n")
    .map((line) => parse(ChildEvent, JSON.parse(line)));
}
export async function result(record: RunRecord): Promise<ResultFile> {
  return parse(ResultFile, JSON.parse(await readFile(record.paths.result, "utf8")));
}
export async function start(run: Run, input: LaunchInput, extraEnv: Record<string, string> = {}) {
  assert(input.label);
  const label = input.label;
  const plan = join(run.out, `${label}-plan.json`);
  const response = join(run.out, `${label}-response.json`);
  await writeFile(plan, JSON.stringify(input), { mode: 0o600 });
  const argv = await parentArgv(
    run,
    label,
    "Call harness_launch exactly once now. Do not call subagent directly or other tools. Afterward reply OK.",
    {
      HARNESS_PLAN: plan,
      HARNESS_RESPONSE: response,
      PI_SUBAGENTS_CHILD_NO_DISCOVERY: "1",
      PI_SUBAGENTS_CHILD_EXTENSIONS: join(repo, "harness", "child-tools.ts"),
      PI_SUBAGENTS_LOG_TOOLS: "1",
      ...extraEnv,
    },
  );
  argv.splice(argv.length - 1, 0, "-e", join(repo, "harness", "parent-tools.ts"));
  const parent = await run.newSession(label, argv);
  const record = () =>
    until(`run record ${label}`, async () =>
      (await records(run)).find((record) => record.label === label),
    );
  const answer = () =>
    until(
      `parent response ${label}`,
      async () => {
        const value = await maybeFile(response);
        if (!value) return null;
        return object(JSON.parse(value));
      },
      180_000,
    );
  return { parent, record, answer, response };
}
export async function send(
  run: Run,
  location: { sessionId: string; blockId: string },
  text: string,
): Promise<void> {
  success(
    await run.rex.command(["send", "-s", location.sessionId, "-b", location.blockId, text], false),
  );
  success(
    await run.rex.command(
      ["send-key", "-s", location.sessionId, "-b", location.blockId, "enter"],
      false,
    ),
  );
}
export async function key(
  run: Run,
  location: { sessionId: string; blockId: string },
  value: string,
): Promise<void> {
  success(
    await run.rex.command(
      ["send-key", "-s", location.sessionId, "-b", location.blockId, value],
      false,
    ),
  );
}
export async function current(run: Run, id: string): Promise<RunRecord> {
  return parse(
    RunRecord,
    JSON.parse(await readFile(join(run.state, "runs", id, "run.json"), "utf8")),
  );
}
export function assertNoAuthError(record: ResultFile): void {
  if (/401|403|unauthori[sz]ed|authentication|api.?key|invalid.*token/i.test(record.reason ?? ""))
    throw new Error(`Provider auth error; stop testing: ${record.reason}`);
}

export function watchRex(run: Run): { seen: BlockEvent[]; stop: () => void } {
  const child = spawn(process.env.PI_SUBAGENTS_REX ?? "rex", ["events", "--all", "--json"], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  const seen: BlockEvent[] = [];
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    appendFileSync(join(run.out, "events.ndjson"), `${line}\n`, { mode: 0o600 });
    const event = parseBlockEvent(JSON.parse(line));
    if (event) seen.push(event);
  });
  return {
    seen,
    stop: () => {
      lines.close();
      child.kill();
    },
  };
}
