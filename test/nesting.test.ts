import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { admissionSnapshot, readLimits, updateMemberProvider } from "../src/admission.ts";
import { decide, launchCycle } from "../src/admission-core.ts";
import { claim, withAdmissionLock } from "../src/claims.ts";
import { readClaim } from "../src/claims.ts";
import { cancel } from "../src/launch.ts";
import { settlementDecision, type ProtocolSnapshot } from "../src/protocol.ts";
import {
  atomicWrite,
  initialActivity,
  privateDirectory,
  readRun,
  runPaths,
  updateActivity,
  writeRun,
  type RunRecord,
} from "../src/records.ts";

it("builds the model's nested reservation, parking, takeover, and ancestry shapes from disk", async () => {
  const root = await mkdtemp(join(tmpdir(), "pirs-nesting-"));
  const previous = process.env.PI_SUBAGENTS_STATE_DIR;
  process.env.PI_SUBAGENTS_STATE_DIR = root;
  try {
    const make = async (
      n: number,
      parent: RunRecord | null,
      checkout = "/checkout",
    ): Promise<RunRecord> => {
      const id = n.toString(16).padStart(24, "0");
      const paths = runPaths(join(root, "runs", id));
      await privateDirectory(join(root, "runs", id));
      const settings = { provider: "p", model: "test", thinking: "off" as const };
      const run: RunRecord = {
        version: 1,
        id,
        label: `run-${n}`,
        taskPath: join(root, "task"),
        cwd: checkout,
        checkoutRoot: checkout,
        access: "write",
        requested: settings,
        effective: settings,
        background: true,
        continueFrom: null,
        parentSessionId: parent?.id ?? "unmanaged",
        rootParentSessionId: "unmanaged",
        parentRunId: parent?.id ?? null,
        depth: parent ? parent.depth + 1 : 1,
        rex: null,
        location: null,
        paths,
        lifecycle: "running",
        process: { state: "live", pid: null },
        waiting: null,
        queue: null,
        sessionFile: null,
        diagnostic: null,
        createdAt: n,
        updatedAt: n,
        loadedAt: n,
        finishedAt: null,
        activity: initialActivity(),
      };
      await writeRun(run);
      return run;
    };
    const a = await make(1, null),
      b = await make(2, a),
      c = await make(3, b),
      outside = await make(4, null);
    c.access = "read";
    await writeRun(c);
    for (const dir of ["queue", "reservations"]) await privateDirectory(join(root, dir));
    await atomicWrite(join(root, "reservations", `${a.id}.json`), {
      id: a.id,
      members: [a, b].map((r) => ({
        runId: r.id,
        access: r.access,
        checkout: r.checkoutRoot,
        provider: "p",
      })),
    });
    await atomicWrite(join(root, "queue", `0-${outside.id}.json`), { runId: outside.id, seq: 0 });
    await atomicWrite(join(root, "queue", `1-${c.id}.json`), { runId: c.id, seq: 1 });
    await updateActivity(a.id, (activity) => {
      activity.parked = "foreground";
    });
    await updateActivity(b.id, (activity) => {
      activity.parked = "foreground";
      activity.tools = [{ id: "launch", name: "subagent" }];
    });
    // Lifecycle observations can be stale in a different process; they cannot clear activity.
    await writeRun(b);
    expect((await readRun(b.id)).activity?.parked).toBe("foreground");
    await updateActivity(b.id, (activity, run) => {
      run.effective = { ...run.effective, provider: "human-provider" };
      activity.effective = run.effective;
    });
    await updateMemberProvider(b.id, "human-provider");
    await writeRun(b);
    expect((await readRun(b.id)).effective.provider).toBe("human-provider");
    let snapshot = await withAdmissionLock(() =>
      admissionSnapshot({ active: 1, depth: 3, providers: {} }),
    );
    expect(snapshot.runs.find((r) => r.id === b.id)).toMatchObject({
      parent: a.id,
      reservation: a.id,
      state: "parked",
    });
    expect(decide(snapshot).admit).toEqual({ id: c.id, reservation: a.id });
    expect(launchCycle(snapshot, c.id)).toBeNull();
    await updateActivity(b.id, (activity) => {
      activity.tools.push({ id: "shell", name: "bash" });
    });
    snapshot = await admissionSnapshot(await readLimits());
    expect(decide(snapshot).tickets.find((r) => r.id === c.id)).toMatchObject({
      reason: "checkout",
      blockers: [b.id],
    });
    expect(launchCycle(snapshot, c.id)).toBeNull();
    c.background = false;
    c.launchCaller = "wrapper";
    await writeRun(c);
    await updateActivity(b.id, (activity) => {
      activity.tools.push({ id: "wrapper", name: "codemode" });
    });
    snapshot = await admissionSnapshot(await readLimits());
    expect(launchCycle(snapshot, c.id)).toEqual([c.id, b.id, c.id]);
    delete c.launchCaller;
    c.background = true;
    await writeRun(c);
    await claim(b.paths.claim, "taken_over");
    snapshot = await admissionSnapshot(await readLimits());
    expect(snapshot.runs.find((r) => r.id === b.id)).toMatchObject({
      state: "taken",
      detached: true,
    });
    expect(snapshot.runs.find((r) => r.id === c.id)?.state).toBe("exited");
    await updateActivity(a.id, (activity) => {
      activity.readyToWake = true;
    });
    snapshot = await admissionSnapshot({ active: 1, depth: 3, providers: {} });
    expect(decide(snapshot).wakes).toEqual([{ id: a.id, hasSlot: false }]);
    expect(decide(snapshot).admit).toBeNull();
    const sibling = await make(5, a, "/other");
    const queued = await make(6, sibling, "/third");
    await atomicWrite(join(root, "queue", `2-${queued.id}.json`), { runId: queued.id, seq: 2 });
    for (const record of [sibling, queued])
      await updateActivity(record.id, (_activity, run) => {
        run.process = { state: "exited", code: null };
      });
    const completed = await make(7, a, "/completed");
    completed.process = { state: "exited", code: 0 };
    await writeRun(completed);
    await atomicWrite(completed.paths.result, {
      version: 1,
      runId: completed.id,
      outcome: "completed",
      assistantText: "done",
      sessionFile: null,
      effective: completed.effective,
      stopReason: "stop",
      reason: null,
      finishedAt: Date.now(),
    });
    await claim(completed.paths.claim, "result");
    await cancel(a);
    expect(await readClaim(a.paths.claim)).toBe("cancelled");
    expect(await readClaim(completed.paths.claim)).toBe("result");
    expect((await readRun(completed.id)).lifecycle).toBe("completed");
    expect(await readClaim(sibling.paths.claim)).toBe("cancelled");
    expect(await readClaim(queued.paths.claim)).toBe("cancelled");
    expect(await readClaim(b.paths.claim)).toBe("taken_over");
    expect(await readClaim(c.paths.claim)).toBeNull();
    expect(await cancel(c)).toBe("taken_over");
  } finally {
    if (previous === undefined) delete process.env.PI_SUBAGENTS_STATE_DIR;
    else process.env.PI_SUBAGENTS_STATE_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

it("extends the one-run settlement table in the specified descendant order", () => {
  const base: ProtocolSnapshot = {
    claim: null,
    lock: null,
    child: "settling",
    messages: [],
    piQueue: [],
  };
  expect(
    settlementDecision({ ...base, messages: ["sent"], descendants: { pending: true, live: true } }),
  ).toBe("send");
  expect(
    settlementDecision({
      ...base,
      messages: ["accepted"],
      descendants: { pending: false, live: true },
    }),
  ).toBe("send");
  expect(
    settlementDecision({
      ...base,
      messages: ["sent"],
      descendants: { pending: false, live: true },
    }),
  ).toBe("wait");
  expect(settlementDecision({ ...base, descendants: { pending: false, live: true } })).toBe("park");
  expect(settlementDecision({ ...base, descendants: { pending: false, live: false } })).toBe(
    "publish",
  );
  expect(
    settlementDecision({ ...base, claim: "cancelled", descendants: { pending: true, live: true } }),
  ).toBe("exit");
  expect(
    settlementDecision({
      ...base,
      claim: "taken_over",
      descendants: { pending: true, live: true },
    }),
  ).toBe("stay");
});
