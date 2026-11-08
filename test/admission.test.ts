import { execFileSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Type } from "typebox";
import { expect, it } from "vitest";
import { decide, launchCycle, type Snapshot } from "../src/admission-core.ts";
import { parse } from "../src/records.ts";

const Run = Type.Object({
  id: Type.String(),
  parent: Type.Union([Type.String(), Type.Null()]),
  access: Type.Union([Type.Literal("read"), Type.Literal("inspect"), Type.Literal("write")]),
  checkout: Type.String(),
  provider: Type.String(),
  state: Type.Union([
    Type.Literal("queued"),
    Type.Literal("running"),
    Type.Literal("parked"),
    Type.Literal("taken"),
    Type.Literal("exited"),
  ]),
  reservation: Type.Union([Type.String(), Type.Null()]),
  ticket: Type.Union([Type.Number(), Type.Null()]),
  detached: Type.Boolean(),
  readyToWake: Type.Boolean(),
});
const SnapshotSchema = Type.Object({
  runs: Type.Array(Run),
  limits: Type.Object({
    active: Type.Number(),
    depth: Type.Number(),
    providers: Type.Record(Type.String(), Type.Number()),
  }),
});
const Case = Type.Object({
  snapshot: SnapshotSchema,
  blockers: Type.Array(Type.Object({ id: Type.String(), blockers: Type.Array(Type.String()) })),
  admit: Type.Union([Type.Object({ id: Type.String(), reservation: Type.String() }), Type.Null()]),
  wakes: Type.Array(Type.Object({ id: Type.String(), hasSlot: Type.Boolean() })),
  launches: Type.Array(
    Type.Object({ snapshot: SnapshotSchema, id: Type.String(), refused: Type.Boolean() }),
  ),
});
it("agrees with the oracle on at least 20,000 reachable states across 2,200 trees", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pirs-differential-"));
  const started = performance.now();
  try {
    const path = join(dir, "cases.ndjson");
    const summary = execFileSync("python3", ["-B", "models/export_cases.py", path], {
      encoding: "utf8",
    });
    let count = 0;
    for await (const line of createInterface({ input: createReadStream(path) })) {
      const c = parse(Case, JSON.parse(line));
      const got = decide(c.snapshot);
      expect(
        got.tickets.map(({ id, blockers }) => ({ id, blockers })),
        `blockers case ${count}`,
      ).toEqual(c.blockers);
      expect(got.admit, `admit case ${count}`).toEqual(c.admit);
      expect(got.wakes, `wakes case ${count}`).toEqual(c.wakes);
      for (const launch of c.launches)
        expect(launchCycle(launch.snapshot, launch.id) !== null, `cycle case ${count}`).toBe(
          launch.refused,
        );
      count++;
    }
    expect(count).toBeGreaterThanOrEqual(20000);
    console.log(`Differential: ${summary.trim()}; ${(performance.now() - started).toFixed(0)} ms`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 120000);

export function fifoSnapshot(): Snapshot {
  return {
    limits: { active: 4, depth: 2, providers: {} },
    runs: [
      {
        id: "reader",
        parent: null,
        access: "read",
        checkout: "/repo",
        provider: "p",
        state: "running",
        reservation: "reader",
        ticket: null,
        detached: false,
        readyToWake: false,
      },
      {
        id: "writer",
        parent: null,
        access: "write",
        checkout: "/repo",
        provider: "p",
        state: "queued",
        reservation: null,
        ticket: 0,
        detached: false,
        readyToWake: false,
      },
      {
        id: "new-reader",
        parent: null,
        access: "read",
        checkout: "/repo",
        provider: "p",
        state: "queued",
        reservation: null,
        ticket: 1,
        detached: false,
        readyToWake: false,
      },
      {
        id: "independent",
        parent: null,
        access: "write",
        checkout: "/other",
        provider: "q",
        state: "queued",
        reservation: null,
        ticket: 2,
        detached: false,
        readyToWake: false,
      },
    ],
  };
}
it("does not starve a writer or let checkout waiters hold capacity", () => {
  const got = decide(fifoSnapshot());
  expect(got.tickets[1]).toEqual({ id: "new-reader", blockers: ["writer"], reason: "checkout" });
  expect(got.admit?.id).toBe("independent");
});
it("parks without counting, wakes before tickets, and counts takeover at once", () => {
  const s = fifoSnapshot();
  const first = s.runs[0];
  if (!first) throw new Error("missing fixture");
  first.state = "parked";
  first.readyToWake = true;
  s.limits.active = 1;
  expect(decide(s).wakes).toEqual([{ id: "reader", hasSlot: true }]);
  expect(decide(s).admit).toBeNull();
  first.state = "taken";
  expect(decide(s).admit).toBeNull();
});
