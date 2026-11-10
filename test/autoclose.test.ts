import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { readLimits } from "../src/admission.ts";

const closeCompletedAfterMs = async () => (await readLimits()).closeCompletedAfterMs;
import { closeDecision, VIEW_SETTLE_MS } from "../src/terminals.ts";

const grace = 60_000;
test("waits out the grace period after a child completes", () => {
  expect(
    closeDecision({
      eligibleSince: 0,
      lastViewedAt: null,
      viewing: false,
      now: 59_999,
      graceMs: grace,
    }),
  ).toBe("wait");
  expect(
    closeDecision({
      eligibleSince: 0,
      lastViewedAt: null,
      viewing: false,
      now: 60_000,
      graceMs: grace,
    }),
  ).toBe("close");
});
test("never closes a tab while it is being viewed, and waits after you leave it", () => {
  expect(
    closeDecision({
      eligibleSince: 0,
      lastViewedAt: 120_000,
      viewing: true,
      now: 120_000,
      graceMs: grace,
    }),
  ).toBe("wait");
  expect(
    closeDecision({
      eligibleSince: 0,
      lastViewedAt: 120_000,
      viewing: false,
      now: 120_000 + VIEW_SETTLE_MS - 1,
      graceMs: grace,
    }),
  ).toBe("wait");
  expect(
    closeDecision({
      eligibleSince: 0,
      lastViewedAt: 120_000,
      viewing: false,
      now: 120_000 + VIEW_SETTLE_MS,
      graceMs: grace,
    }),
  ).toBe("close");
});
test("auto-close can be turned off", () => {
  expect(
    closeDecision({
      eligibleSince: 0,
      lastViewedAt: null,
      viewing: false,
      now: 1e9,
      graceMs: null,
    }),
  ).toBe("wait");
});

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pirs-autoclose-"));
  process.env.PI_SUBAGENTS_STATE_DIR = dir;
});
afterEach(async () => {
  delete process.env.PI_SUBAGENTS_STATE_DIR;
  await rm(dir, { recursive: true, force: true });
});
test("reads closeCompletedAfter from limits.json, defaulting to 60 s", async () => {
  expect(await closeCompletedAfterMs()).toBe(60_000);
  await writeFile(join(dir, "limits.json"), JSON.stringify({ closeCompletedAfter: 5 }));
  expect(await closeCompletedAfterMs()).toBe(5_000);
  await writeFile(join(dir, "limits.json"), JSON.stringify({ closeCompletedAfter: false }));
  expect(await closeCompletedAfterMs()).toBeNull();
  await writeFile(join(dir, "limits.json"), JSON.stringify({ closeCompletedAfter: "soon" }));
  await expect(closeCompletedAfterMs()).rejects.toThrow(/limits/);
});

test("a tab renamed away from its launch label is kept; the launch label is not", async () => {
  const { tabState } = await import("../src/terminals.ts");
  const where = { sessionId: "s", windowId: "w2", blockId: "b" };
  const view = (label: string, active = "w1") => ({
    active_window_id: active,
    windows: [
      { window_id: "w1", label: "parent" },
      { window_id: "w2", label },
    ],
  });
  expect(tabState(view("reviewer"), where, "reviewer")).toEqual({ viewing: false, kept: false });
  expect(tabState(view("📌 reviewer"), where, "reviewer")).toEqual({ viewing: false, kept: true });
  expect(tabState(view("my notes"), where, "reviewer")).toEqual({ viewing: false, kept: true });
  expect(tabState(view("reviewer", "w2"), where, "reviewer")).toEqual({
    viewing: true,
    kept: false,
  });
});
