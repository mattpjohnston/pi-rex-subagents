import { randomBytes } from "node:crypto";
import { rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { readLimits, removeRunAdmission } from "./admission.ts";
import { readClaim, withAdmissionLock, type Claim } from "./claims.ts";
import {
  isMissing,
  isTerminal,
  listRuns,
  readRun,
  runDirectory,
  stateDir,
  writeRun,
  type RunRecord,
} from "./records.ts";

export function retentionDecision(input: {
  run: RunRecord;
  claim: Claim | null;
  parent: RunRecord | null | "missing";
  childrenKept: boolean;
  now: number;
  keepMs: number | null;
}): "delete" | "keep" {
  const { run, claim, parent, childrenKept, now, keepMs } = input;
  if (
    keepMs === null ||
    run.finishedAt === null ||
    now - run.finishedAt <= keepMs ||
    !isTerminal(run.lifecycle) ||
    run.lifecycle === "taken_over" ||
    claim === "taken_over" ||
    run.process.state !== "exited" ||
    run.queue !== null ||
    childrenKept
  )
    return "keep";
  if (run.parentRunId !== null)
    return parent === "missing" ||
      (parent !== null && isTerminal(parent.lifecycle) && parent.process.state === "exited")
      ? "delete"
      : "keep";
  return !run.background || run.deliveredAt !== undefined ? "delete" : "keep";
}

/** Only the owning parent can attest that it saw a background delivery on its branch. */
export async function markDelivered(run: RunRecord): Promise<void> {
  if (run.deliveredAt !== undefined) return;
  await withAdmissionLock(async () => {
    const current = await readRun(run.id).catch((error: unknown) => {
      if (!isMissing(error)) throw error;
      return null;
    });
    if (!current) return;
    if (current.deliveredAt === undefined) {
      current.deliveredAt = Date.now();
      await writeRun(current);
    }
    run.deliveredAt = current.deliveredAt;
  });
}

/** A retained descendant must never lose the ancestry used by admission and cancellation. */
function leavesFirst(records: RunRecord[]): RunRecord[] {
  const ordered: RunRecord[] = [];
  const visited = new Set<string>();
  const visit = (run: RunRecord) => {
    if (visited.has(run.id)) return;
    visited.add(run.id);
    for (const child of records) if (child.parentRunId === run.id) visit(child);
    ordered.push(run);
  };
  for (const run of records) visit(run);
  return ordered;
}

export async function cleanupRuns(): Promise<void> {
  const keepMs = (await readLimits()).keepRunsForMs;
  if (keepMs === null) return;
  const records = new Map((await listRuns()).map((run) => [run.id, run]));
  for (const run of leavesFirst([...records.values()])) {
    if (
      retentionDecision({
        run,
        claim: await readClaim(run.paths.claim),
        parent: run.parentRunId ? (records.get(run.parentRunId) ?? "missing") : null,
        childrenKept: [...records.values()].some((child) => child.parentRunId === run.id),
        now: Date.now(),
        keepMs,
      }) !== "delete"
    )
      continue;
    const deleted = await withAdmissionLock(async () => {
      const current = await readRun(run.id).catch((error: unknown) => {
        if (!isMissing(error)) throw error;
        return null;
      });
      if (!current) return null;
      const fresh = await listRuns();
      if (
        retentionDecision({
          run: current,
          claim: await readClaim(current.paths.claim),
          parent: current.parentRunId
            ? (fresh.find((parent) => parent.id === current.parentRunId) ?? "missing")
            : null,
          childrenKept: fresh.some((child) => child.parentRunId === current.id),
          now: Date.now(),
          keepMs,
        }) !== "delete"
      )
        return null;
      const tombstone = join(
        stateDir(),
        "runs",
        `.deleted-${current.id}-${randomBytes(8).toString("hex")}`,
      );
      await removeRunAdmission(current.id);
      await rename(runDirectory(current.id), tombstone);
      return tombstone;
    });
    if (deleted) {
      records.delete(run.id);
      await rm(deleted, { recursive: true, force: true });
    }
  }
}
