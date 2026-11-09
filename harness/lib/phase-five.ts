import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { withAdmissionLock } from "../../src/claims.ts";
import { readFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import type { LaunchInput } from "../../src/launch.ts";
import type { RunRecord } from "../../src/records.ts";
import { entries, sessionPath, turnEnded } from "./phase-four.ts";
import { events, send, start, until } from "./phase-one.ts";
import { repo, type Run } from "./run.ts";
import { object } from "./rex.ts";

export const holdTask =
  "Call harness_hold exactly once, then wait. After it returns, follow any correction or hold order you received and give a short final report. Do not use other tools.";
export async function launchControlled(
  run: Run,
  input: LaunchInput,
  env: Record<string, string> = {},
) {
  return start(
    run,
    input,
    {
      PI_SUBAGENTS_CHILD_EXTENSIONS: [
        join(repo, "harness", "child-tools.ts"),
        join(repo, "harness", "protocol-hooks.ts"),
      ].join(delimiter),
      ...env,
    },
    [join(repo, "harness", "protocol-hooks.ts")],
  );
}
export async function parentTool(
  run: Run,
  parent: { sessionId: string; blockId: string },
  label: string,
  name: string,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  await turnEnded(run, label);
  const path = await sessionPath(run, label);
  const before = (await entries(path)).length;
  await send(
    run,
    parent,
    `Call ${name} exactly once with these arguments: ${JSON.stringify(input)}. Do not call any other tools. After it returns, reply OK and do not repeat the call.`,
  );
  const result = await until(
    `${label} ${name} tool result`,
    async () => {
      for (const row of (await entries(path)).slice(before)) {
        if (row.type !== "message") continue;
        const message = object(row.message);
        if (message.role === "assistant" && message.stopReason === "error")
          throw new Error(`Parent provider error: ${JSON.stringify(message)}`);
        if (message.role !== "toolResult" || message.toolName !== name) continue;
        assert(!message.isError, JSON.stringify(message));
        return message;
      }
      return null;
    },
    180_000,
  );
  const calls = (await readFile(join(run.out, `${label}-tools.jsonl`), "utf8"))
    .trim()
    .split("\n")
    .map((line) => object(JSON.parse(line)));
  assert(
    calls.some((call) => call.name === name && isDeepStrictEqual(call.input, input)),
    `Real model must call ${name} with prescribed arguments: ${JSON.stringify(calls)}`,
  );
  assert(Array.isArray(result.content));
  const text = result.content.map((part) => object(part).text).join("\n");
  return {
    message: result,
    text,
    ...(name === "subagent_control" ? object(JSON.parse(text)) : {}),
  };
}
export async function userMessageWithId(record: RunRecord, id: string): Promise<void> {
  await until(`persisted user message ${id}`, async () => {
    const session = (await events(record)).find((e) => e.type === "session_start")?.data
      .sessionFile;
    if (typeof session !== "string") return null;
    return (await entries(session)).some(
      (row) =>
        row.type === "message" &&
        object(row.message).role === "user" &&
        JSON.stringify(object(row.message).content).includes(id),
    );
  });
}

export async function leaveStaleRunLock(path: string): Promise<void> {
  const holder: unknown = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        "import {execFileSync} from 'node:child_process'; console.log(JSON.stringify({pid:process.pid,startTime:execFileSync('ps',['-p',String(process.pid),'-o','lstart='],{encoding:'utf8'}).trim(),token:'dead-harness-holder'}))",
      ],
      { encoding: "utf8" },
    ),
  );
  await withAdmissionLock(async () => {
    await mkdir(path, { mode: 0o700 });
    await writeFile(join(path, "holder.json"), JSON.stringify(holder), { mode: 0o600 });
  });
}
