import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFile, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Type } from "typebox";
import { overlaps } from "../../src/admission-core.ts";
import { withAdmissionLock } from "../../src/claims.ts";
import { isMissing, parse, RunRecord } from "../../src/records.ts";
import { assertNoAuthError, current, maybeFile, result, until } from "./phase-one.ts";
import type { Run } from "./run.ts";

export async function directory(run: Run, name: string, git = false): Promise<string> {
  const path = join(run.scratch, name);
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (git) execFileSync("git", ["init", "-q", path]);
  return realpath(path);
}
export async function hold(run: Run, record: RunRecord): Promise<RunRecord> {
  await until(`hold ${record.label}`, () => maybeFile(join(dirname(record.paths.run), "holding")));
  return current(run, record.id);
}
export async function release(record: RunRecord): Promise<void> {
  await writeFile(join(dirname(record.paths.run), "release"), "go", { mode: 0o600 });
}
export async function finished(run: Run, record: RunRecord): Promise<RunRecord> {
  return until(`confirmed result + exit ${record.label}`, async () => {
    const final = await current(run, record.id);
    if (final.process.state !== "exited") return null;
    assert.equal(final.lifecycle, "completed", JSON.stringify(final));
    assertNoAuthError(await result(final));
    return final;
  });
}
export async function queued(run: Run, record: RunRecord, kind = "checkout"): Promise<RunRecord> {
  return until(`queued ${record.label} for ${kind}`, async () => {
    const r = await current(run, record.id);
    return r.waiting?.source === "admission" && r.waiting.kind === kind && r;
  });
}
const Reservation = Type.Object({
  id: Type.String(),
  members: Type.Array(
    Type.Object({
      runId: Type.String(),
      access: RunRecord.properties.access,
      checkout: Type.String(),
      provider: Type.String(),
    }),
  ),
});
const Ticket = Type.Object({ runId: Type.String(), seq: Type.Number() });
async function jsonFiles(run: Run, dir: string): Promise<unknown[]> {
  let files: string[];
  try {
    files = await readdir(join(run.state, dir));
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const values = [];
  for (const name of files.filter((name) => name.endsWith(".json"))) {
    try {
      values.push(JSON.parse(await readFile(join(run.state, dir, name), "utf8")) as unknown);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  return values;
}
/** Sample reservations and tickets every 500 ms for the whole multi-parent schedule. */
export function sample(run: Run, active: number, providers: Record<string, number> = {}) {
  let stopped = false;
  let count = 0;
  let error: unknown;
  const loop = (async () => {
    try {
      while (!stopped) {
        const { reservations, queue } = await withAdmissionLock(async () => ({
          reservations: (await jsonFiles(run, "reservations")).map((value) =>
            parse(Reservation, value),
          ),
          queue: (await jsonFiles(run, "queue")).map((value) => parse(Ticket, value)),
        }));
        const members = reservations.flatMap((r) => r.members);
        assert(members.length <= active, `Managed members ${members.length} > ceiling ${active}`);
        for (const [provider, cap] of Object.entries(providers))
          assert(
            members.filter((m) => m.provider === provider).length <= cap,
            `Provider ${provider} exceeds ${cap}`,
          );
        for (const [i, a] of members.entries())
          for (const b of members.slice(i + 1))
            assert(
              !overlaps(a.checkout, b.checkout) || (a.access !== "write" && b.access !== "write"),
              `Conflicting members ${a.runId}, ${b.runId}`,
            );
        await appendFile(
          join(run.out, "admission-samples.ndjson"),
          `${JSON.stringify({ at: Date.now(), reservations, queue })}\n`,
          { mode: 0o600 },
        );
        count++;
        await delay(500);
      }
    } catch (e) {
      error = e;
    }
  })();
  return async () => {
    stopped = true;
    await loop;
    if (error) throw error;
    assert(count > 0);
    console.log(
      `admission sampler: ${count} samples, 500 ms interval; every overlap and ceiling invariant passed`,
    );
  };
}
