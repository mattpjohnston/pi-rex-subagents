import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import {
  blocksReplacement,
  deliveredRunIds,
  endsWithUnansweredDelivery,
  outcomeReady,
  packDelivery,
  pathEntry,
  RESULTS_TYPE,
  nextDelivery,
  shouldAppend,
  shouldCancel,
  transitionView,
  type DeliveryOutcome,
} from "../src/delivery.ts";
import type { RunRecord } from "../src/records.ts";

const id = (char: string) => char.repeat(24);
function outcome(runId: string, text: string): DeliveryOutcome {
  return {
    runId,
    outcome: "completed",
    text,
    sessionPath: `/sessions/${runId}`,
    resultPath: `/results/${runId}`,
  };
}
function run(patch: Partial<RunRecord> = {}): RunRecord {
  const settings = { provider: "test", model: "model", thinking: "off" as const };
  return {
    version: 1,
    id: id("a"),
    label: "child",
    taskPath: "/task",
    cwd: "/work",
    checkoutRoot: "/work",
    access: "write",
    requested: settings,
    effective: settings,
    background: true,
    continueFrom: null,
    parentSessionId: "parent",
    parentRunId: null,
    depth: 0,
    rex: null,
    location: null,
    paths: {
      run: "/run",
      result: "/result",
      claim: "/claim",
      lock: "/lock",
      events: "/events",
      inbox: "/inbox",
      sessionDir: "/session",
    },
    lifecycle: "running",
    process: { state: "live", pid: 1 },
    waiting: null,
    queue: null,
    sessionFile: "/session/child.jsonl",
    diagnostic: null,
    createdAt: 1,
    updatedAt: 1,
    loadedAt: 1,
    finishedAt: null,
    ...patch,
  };
}

it("packs full entries until the cap, then path entries, and stays inside both limits", () => {
  const full = outcome(id("b"), "x".repeat(20_000));
  const packed = packDelivery(
    [full, outcome(id("c"), "y".repeat(40_000)), outcome(id("d"), "z".repeat(40_000))],
    50 * 1024,
    2000,
  );
  expect(Buffer.byteLength(packed.content)).toBeLessThanOrEqual(50 * 1024);
  expect(packed.content.split("\n").length).toBeLessThanOrEqual(2000);
  expect(packed.runIds).toEqual([id("b"), id("c"), id("d")]);
  expect(packed.content).toContain("x".repeat(20_000));
  expect(packed.content).toContain(pathEntry(outcome(id("c"), "")));
  expect(packed.content).not.toContain("y".repeat(100));
});

it("leaves an entry pending when even its path form does not fit", () => {
  const packed = packDelivery([outcome(id("e"), "huge")], 20, 2);
  expect(packed.runIds).toEqual([]);
  expect(packed.content).toBe("");
});

it("recognizes a delivery on the active branch after compaction and not after leaving it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pirs-delivery-"));
  const session = SessionManager.create(dir, join(dir, "sessions"));
  const runId = id("f");
  const user = session.appendMessage({ role: "user", content: "start", timestamp: 1 });
  session.appendCustomMessageEntry(RESULTS_TYPE, "five results", true, { runIds: [runId] });
  const kept = session.appendMessage({ role: "user", content: "kept", timestamp: 2 });
  session.appendCompaction("summary of the delivery", kept, 10, {
    readFiles: [],
    modifiedFiles: [],
  });
  const branch = session.getBranch();
  expect(deliveredRunIds(branch)).toEqual(new Set([runId]));
  expect(branch.some((entry) => entry.type === "custom_message")).toBe(true);
  expect(session.buildContextEntries().some((entry) => entry.type === "custom_message")).toBe(
    false,
  );
  const compaction = branch.find((entry) => entry.type === "compaction");
  expect(compaction?.type === "compaction" ? compaction.details : undefined).toEqual({
    readFiles: [],
    modifiedFiles: [],
  });
  expect(endsWithUnansweredDelivery(branch)).toBe(false);
  session.branch(user);
  expect(deliveredRunIds(session.getBranch()).size).toBe(0);
  const unanswered = SessionManager.inMemory(dir);
  unanswered.appendCustomMessageEntry(RESULTS_TYPE, "pending turn", true, { runIds: [runId] });
  expect(endsWithUnansweredDelivery(unanswered.getBranch())).toBe(true);
});

it("decides replacement, cancellation, and append without treating takeover as owned", () => {
  const delivered = new Set<string>();
  const live = transitionView(run(), null, delivered);
  const queued = transitionView(
    run({ id: id("q"), queue: { reason: "capacity", detail: "ceiling", since: 1 } }),
    null,
    delivered,
  );
  const pending = transitionView(
    run({
      id: id("p"),
      lifecycle: "completed",
      process: { state: "exited", code: 0 },
      finishedAt: 2,
    }),
    "result",
    delivered,
  );
  const taken = transitionView(
    run({ id: id("t"), lifecycle: "taken_over", process: { state: "live", pid: 4 } }),
    "taken_over",
    delivered,
  );
  expect(blocksReplacement([live, taken], "parent")).toBe(true);
  expect(blocksReplacement([taken], "parent")).toBe(true);
  expect(
    blocksReplacement(
      [
        transitionView(
          run({ id: id("t"), lifecycle: "taken_over", process: { state: "live", pid: 4 } }),
          "taken_over",
          new Set([id("t")]),
        ),
      ],
      "parent",
    ),
  ).toBe(false);
  expect(blocksReplacement([pending], "parent")).toBe(true);
  expect(shouldCancel(live, "parent")).toBe(true);
  expect(shouldCancel(queued, "parent")).toBe(true);
  expect(shouldCancel(taken, "parent")).toBe(false);
  expect(shouldCancel(pending, "parent")).toBe(false);
  expect(shouldAppend(pending, "parent")).toBe(true);
  expect(shouldAppend(live, "parent")).toBe(false);
  expect(outcomeReady(run({ process: { state: "unresolved", pid: 9 } }), "cancelled")).toBe(true);
  expect(outcomeReady(run(), "result")).toBe(false);
  expect(outcomeReady(run(), "taken_over")).toBe(true);
  expect(outcomeReady(run({ process: { state: "exited", code: 0 } }), "taken_over")).toBe(true);
  expect(outcomeReady(run({ background: false }), "result")).toBe(false);
});

it("coalesces on settle or the idle timer, and reconciles without waiting", () => {
  const pending = { idle: true, pending: true, unanswered: false };
  expect(nextDelivery({ ...pending, source: "finished" })).toBe("wait");
  expect(nextDelivery({ ...pending, idle: false, source: "finished" })).toBe("wait");
  expect(nextDelivery({ ...pending, source: "settled" })).toBe("deliver");
  expect(nextDelivery({ ...pending, source: "timer" })).toBe("deliver");
  expect(nextDelivery({ ...pending, source: "reconcile" })).toBe("deliver");
  expect(nextDelivery({ idle: true, pending: false, unanswered: true, source: "reconcile" })).toBe(
    "note",
  );
  expect(nextDelivery({ idle: false, pending: true, unanswered: false, source: "settled" })).toBe(
    "wait",
  );
  expect(nextDelivery({ idle: false, pending: true, unanswered: false, source: "append" })).toBe(
    "deliver",
  );
});
