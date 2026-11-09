import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { admissionSnapshot, readLimits } from "../../src/admission.ts";
import { withAdmissionLock } from "../../src/claims.ts";
import type { LaunchInput } from "../../src/launch.ts";
import { type RunRecord } from "../../src/records.ts";
import { current, events, maybeFile, records, start, until } from "./phase-one.ts";
import { entries, resultsEntries } from "./phase-four.ts";
import { object } from "./rex.ts";
import { repo, type Run } from "./run.ts";

export type FixedCall = { name: string; arguments: Record<string, unknown> };
export type Batch = { waitFor?: string; calls: FixedCall[] };
export const call = (name: string, args: Record<string, unknown> = {}): FixedCall => ({
  name,
  arguments: args,
});
export const delegated = (
  label: string,
  cwd: string,
  access: "write" | "inspect" | "read" = "inspect",
  background = true,
) => ({
  label,
  cwd,
  access,
  background,
  task: "Follow the parent's acceptance plan. Call harness_hold once if available, otherwise reply briefly. Do not invent tasks or launch extra children.",
});
export async function plan(run: Run, label: string, batches: Batch[]): Promise<void> {
  await mkdir(join(run.out, "plans"), { recursive: true, mode: 0o700 });
  await writeFile(join(run.out, "plans", `${label}.json`), JSON.stringify(batches), {
    mode: 0o600,
  });
}
export async function tree(run: Run, input: LaunchInput, env: Record<string, string> = {}) {
  return start(run, input, {
    HARNESS_NESTED_PLAN_DIR: join(run.out, "plans"),
    PI_SUBAGENTS_CHILD_EXTENSIONS: [
      join(repo, "harness", "child-tools.ts"),
      join(repo, "harness", "nesting-hooks.ts"),
    ].join(delimiter),
    ...env,
  });
}
export async function named(run: Run, label: string): Promise<RunRecord> {
  return until(
    `record ${label}`,
    async () => (await records(run)).find((r) => r.label === label),
    180_000,
  );
}
export async function batchReady(record: RunRecord, index: number): Promise<void> {
  await until(`${record.label} batch ${index}`, () =>
    maybeFile(join(dirname(record.paths.run), `batch-${index}-ready`)),
  );
}
export async function snapshotProof(run: Run, name: string) {
  const snapshot = await withAdmissionLock(async () => admissionSnapshot(await readLimits()));
  await run.record(`${name}.json`, snapshot);
  return snapshot;
}
export async function childSession(record: RunRecord) {
  const session = (await events(record)).find((e) => e.type === "session_start")?.data.sessionFile;
  assert.equal(typeof session, "string");
  assert(typeof session === "string");
  return entries(session);
}
export async function deliveredBeforePublish(record: RunRecord, ids: string[]): Promise<void> {
  const rows = await childSession(record);
  assert.equal(resultsEntries(rows).length, 0);
  const userRows = rows.filter((r) => r.type === "message" && object(r.message).role === "user");
  for (const id of ids)
    assert.equal(
      userRows.filter((row) => JSON.stringify(row).includes(`[subagent outcome ${id}]`)).length,
      1,
      `Exactly one persisted outcome for ${id}`,
    );
  const sent = (await events(record)).filter((e) => e.type === "descendants_sent");
  const claimed = (await events(record)).find((e) => e.type === "result_claimed");
  assert(claimed);
  assert(sent.every((e) => e.at <= claimed.at));
  assert(ids.every((id) => sent.some((e) => Array.isArray(e.data.ids) && e.data.ids.includes(id))));
  assert(
    userRows.some((row) =>
      ids.every((id) => JSON.stringify(row).includes(`[subagent outcome ${id}]`)),
    ),
    "Waiting outcomes delivered in one turn",
  );
}
export async function toolResults(record: RunRecord) {
  return (await childSession(record))
    .filter((r) => r.type === "message" && object(r.message).role === "toolResult")
    .map((r) => object(r.message));
}
export async function assertNoStart(run: Run, record: RunRecord): Promise<void> {
  assert.equal((await current(run, record.id)).loadedAt, null);
  assert(!(await events(record)).some((e) => e.type === "child_loaded"));
}
