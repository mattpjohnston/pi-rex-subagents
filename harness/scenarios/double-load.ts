import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { childArgv } from "../../src/launch.ts";
import {
  privateDirectory,
  runDirectory,
  runPaths,
  writeRun,
  type RunRecord,
} from "../../src/records.ts";
import { events, maybeFile, result, until } from "../lib/phase-one.ts";
import { assertNotRateLimited } from "../lib/phase-four.ts";
import { repo, withRun, type Run } from "../lib/run.ts";

function modelSettings(): RunRecord["effective"] {
  const model = process.env.HARNESS_MODEL ?? "openrouter/nvidia/nemotron-3.5-lightning:free";
  const slash = model.indexOf("/");
  return {
    provider: slash > 0 ? model.slice(0, slash) : model,
    model: slash > 0 ? model.slice(slash + 1) : model,
    thinking: "low",
  };
}
async function child(run: Run, label: string, extra: string): Promise<RunRecord> {
  const id = randomBytes(12).toString("hex");
  const dir = runDirectory(id);
  await privateDirectory(join(run.state, "runs"));
  await privateDirectory(dir);
  const paths = runPaths(dir);
  await privateDirectory(paths.sessionDir);
  await privateDirectory(paths.inbox);
  const settings = modelSettings();
  const task = join(dir, "task.md");
  await writeFile(task, "# Delegated task\n\nReply exactly DOUBLE_LOAD. Do not use tools.\n", {
    mode: 0o600,
  });
  const record: RunRecord = {
    version: 1,
    id,
    label,
    taskPath: task,
    cwd: run.scratch,
    checkoutRoot: run.scratch,
    access: "write",
    requested: settings,
    effective: settings,
    background: false,
    continueFrom: null,
    parentSessionId: "double-load",
    parentRunId: null,
    depth: 0,
    rex: null,
    location: null,
    paths,
    lifecycle: "running",
    process: { state: "unknown" },
    waiting: null,
    queue: null,
    sessionFile: null,
    diagnostic: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    loadedAt: null,
    finishedAt: null,
  };
  await writeRun(record);
  process.env.PI_SUBAGENTS_CHILD_NO_DISCOVERY = "1";
  const argv = await childArgv(record, join(repo, "src", "index.ts"));
  delete process.env.PI_SUBAGENTS_CHILD_NO_DISCOVERY;
  const prompt = argv.pop();
  argv.push("-e", extra, prompt ?? "");
  await run.newSession(label, argv);
  return record;
}
async function prove(run: Run, label: string, extra: string): Promise<void> {
  const record = await child(run, label, extra);
  const settled = await until(`${label} one settlement`, async () => {
    const logged = await events(record);
    const loads = logged.filter((event) => event.type === "child_loaded");
    const settlements = logged.filter((event) => event.type === "agent_settled");
    // The reporter logs agent_settled before it writes the result, 30-120 ms later.
    if (!loads.length || !settlements.length || !(await maybeFile(record.paths.result)))
      return null;
    assert.equal(loads.length, 1, `${label} loaded ${loads.length} times`);
    assert.equal(settlements.length, 1, `${label} settled ${settlements.length} times`);
    return logged;
  });
  const written = await result(record);
  assertNotRateLimited(`${written.reason ?? ""} ${written.assistantText}`);
  assert.equal(written.runId, record.id);
  await run.record(`${label}-events.json`, settled);
}

export default async function doubleLoad(): Promise<void> {
  await withRun("double-load", async (run) => {
    const entry = join(repo, "src", "index.ts");
    const link = join(run.scratch, "entry-link.ts");
    await symlink(entry, link);
    await prove(run, "same-path", entry);
    await prove(run, "symlink", link);
    console.log(
      "double-load: PASS; one child_loaded, one settlement and one result for both loads",
    );
  });
}
