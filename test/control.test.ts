import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { answerDialog, childScreen, waitForRuns } from "../src/control.ts";
import {
  atomicWrite,
  initialActivity,
  privateDirectory,
  runPaths,
  writeRun,
  type RunRecord,
} from "../src/records.ts";

let dir: string | undefined;
afterEach(async () => {
  vi.unstubAllEnvs();
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function run(root: string, id: string, ended: boolean): Promise<RunRecord> {
  const runDir = join(root, "runs", id);
  await privateDirectory(runDir);
  const settings = { provider: "p", model: "m", thinking: "off" as const };
  const record: RunRecord = {
    version: 1,
    id,
    label: `run-${id.slice(0, 1)}`,
    taskPath: join(runDir, "task.md"),
    cwd: root,
    checkoutRoot: root,
    access: "read",
    requested: settings,
    effective: settings,
    background: true,
    continueFrom: null,
    parentSessionId: "parent",
    parentRunId: null,
    depth: 1,
    activity: initialActivity(),
    rex: null,
    location: null,
    paths: runPaths(runDir),
    lifecycle: ended ? "completed" : "running",
    process: ended ? { state: "exited", code: 0 } : { state: "live", pid: null },
    waiting: null,
    queue: null,
    sessionFile: null,
    diagnostic: null,
    createdAt: 0,
    updatedAt: 0,
    loadedAt: 0,
    finishedAt: ended ? 1 : null,
  };
  await writeRun(record);
  if (ended) {
    await atomicWrite(record.paths.result, {
      version: 1,
      runId: id,
      outcome: "completed",
      assistantText: `answer from ${id.slice(0, 1)}`,
      sessionFile: null,
      effective: settings,
      stopReason: "stop",
      reason: null,
      finishedAt: 1,
    });
    await writeFile(record.paths.claim, "result");
  }
  return record;
}

it("wait reports each named run once it has an outcome, and lists the rest at the timeout", async () => {
  dir = await mkdtemp(join(tmpdir(), "pirs-wait-"));
  vi.stubEnv("PI_SUBAGENTS_STATE_DIR", dir);
  const done = await run(dir, "a".repeat(24), true);
  const busy = await run(dir, "b".repeat(24), false);
  const all = await waitForRuns([done.id], 1000);
  expect(all.pending).toEqual([]);
  expect(all.text).toContain("answer from a");
  expect(all.runIds).toEqual([done.id]);
  const started = Date.now();
  const partial = await waitForRuns([done.id, busy.id], 300);
  expect(Date.now() - started).toBeGreaterThanOrEqual(250);
  expect(partial.runIds).toEqual([done.id]);
  expect(partial.pending).toEqual([busy.id]);
  const aborted = await waitForRuns([busy.id], 60_000, AbortSignal.abort());
  expect(aborted.pending).toEqual([busy.id]);
});

it("answer types into a child's dialog only while that same wait is open", async () => {
  dir = await mkdtemp(join(tmpdir(), "pirs-answer-"));
  vi.stubEnv("PI_SUBAGENTS_STATE_DIR", dir);
  const log = join(dir, "rex.log");
  await writeFile(
    join(dir, "rex"),
    `#!/bin/sh
printf '%s\\n' "$*" >> '${log}'
case "$1 $2" in
  'block inspect') echo '{"session_id":"s","block":{"window_id":"w"}}' ;;
  'capture -s') echo 'Subagent acceptance question'; echo '> _' ;;
  *) exit 0 ;;
esac
`,
    { mode: 0o700 },
  );
  vi.stubEnv("PI_SUBAGENTS_REX", join(dir, "rex"));
  const child = await run(dir, "a".repeat(24), false);
  child.rex = { sessionId: "s", windowId: "w", blockId: "b" };
  child.waiting = { source: "reporter", kind: "input", title: "Question", since: 1000 };
  await writeRun(child);
  const calls = async () =>
    (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean);
  expect(await childScreen(child)).toContain("Subagent acceptance question");
  const stale = await answerDialog(child, 999, { text: "yes" }, 50);
  expect(stale).toMatchObject({ status: "refused" });
  expect((await calls()).some((call) => call.startsWith("send"))).toBe(false);
  const answered = await answerDialog(child, 1000, { text: "yes" }, 50);
  expect(answered).toMatchObject({ status: "sent", ended: false });
  expect(await calls()).toEqual(
    expect.arrayContaining(["send -s s -b b yes", "send-key -s s -b b enter"]),
  );
  await answerDialog(child, 1000, { keys: ["down", "enter"] }, 50);
  expect(await calls()).toContain("send-key -s s -b b down enter");
});
