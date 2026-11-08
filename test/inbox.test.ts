import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { expect, it } from "vitest";
import { inboxDecision, settlementDecision, type ProtocolSnapshot } from "../src/protocol.ts";
import {
  acceptWritten,
  ackPath,
  inboxEntries,
  markConsumed,
  markSent,
  messageState,
  messageText,
  readAck,
  waitForAck,
} from "../src/inbox.ts";
import { atomicWrite, parse, privateDirectory, runPaths, type RunRecord } from "../src/records.ts";
import { claim, withProtocolLock } from "../src/claims.ts";
import { ownedRuns } from "../src/control.ts";

const Snapshot = Type.Object({
  claim: Type.Union([
    Type.Null(),
    Type.Literal("result"),
    Type.Literal("taken_over"),
    Type.Literal("cancelled"),
  ]),
  lock: Type.Union([Type.Null(), Type.Literal("parent")]),
  child: Type.Union(
    ["working", "settling", "idle", "shutdown", "exiting", "human", "exited"].map((s) =>
      Type.Literal(s),
    ),
  ),
  messages: Type.Array(
    Type.Union(
      ["none", "written", "accepted", "sent", "consumed", "refused"].map((s) => Type.Literal(s)),
    ),
  ),
  piQueue: Type.Array(Type.Number()),
});
const Case = Type.Object({ snapshot: Snapshot, inbox: Type.String(), settlement: Type.String() });
it("matches every reachable current protocol state (including the e19 counterexample)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pirs-protocol-"));
  const started = performance.now();
  try {
    const path = join(dir, "cases.ndjson");
    const summary = execFileSync("python3", ["-B", "models/export_protocol.py", path], {
      encoding: "utf8",
    });
    let count = 0,
      pending = 0;
    for (const line of (await readFile(path, "utf8")).trim().split("\n")) {
      const c = parse(Case, JSON.parse(line));
      const s = c.snapshot as ProtocolSnapshot;
      expect(inboxDecision(s), `inbox ${line}`).toBe(c.inbox);
      expect(settlementDecision(s), `settlement ${line}`).toBe(c.settlement);
      if (c.settlement === "wait") pending++;
      count++;
    }
    expect(count).toBe(461);
    expect(pending).toBeGreaterThan(0);
    console.log(
      `Protocol differential: ${summary.trim()}; ${pending} pending-message settlements; ${(performance.now() - started).toFixed(0)} ms`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
it("orders the settlement table: claims, unsent, sent, then publication", () => {
  const s: ProtocolSnapshot = {
    claim: null,
    lock: null,
    child: "settling",
    messages: [],
    piQueue: [],
  };
  expect(settlementDecision(s)).toBe("publish");
  expect(settlementDecision({ ...s, messages: ["sent"] })).toBe("wait");
  expect(settlementDecision({ ...s, messages: ["sent", "accepted"] })).toBe("send");
  expect(settlementDecision({ ...s, claim: "cancelled", messages: ["accepted"] })).toBe("exit");
  expect(settlementDecision({ ...s, claim: "taken_over", messages: ["sent"] })).toBe("stay");
  expect(settlementDecision({ ...s, lock: "parent" })).toBe("none");
});
it("only accepts before a claim; consumption requires a persisted user-message marker; timeout is not delivery", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pirs-inbox-"));
  const previous = process.env.PI_SUBAGENTS_STATE_DIR;
  process.env.PI_SUBAGENTS_STATE_DIR = dir;
  try {
    const paths = runPaths(join(dir, "child"));
    await privateDirectory(paths.inbox);
    const run = { id: "child", paths, parentSessionId: "parent" } as RunRecord;
    const write = async () => {
      const id = randomUUID();
      await atomicWrite(join(paths.inbox, `${id}.json`), {
        id,
        runId: run.id,
        text: "Hold",
        sender: "parent",
        createdAt: Date.now(),
      });
      return id;
    };
    const id = await write();
    expect(await waitForAck(run, id, 1)).toEqual({ status: "unacknowledged", messageId: id });
    await withProtocolLock(paths.lock, async () => {
      const entries = await inboxEntries(run);
      expect(entries.map(messageState)).toEqual(["written"]);
      await acceptWritten(run, entries);
      expect(entries.map(messageState)).toEqual(["accepted"]);
      await markSent(run, entries);
      expect(entries.map(messageState)).toEqual(["sent"]);
      await markConsumed(run, entries, []);
      expect(entries.map(messageState)).toEqual(["sent"]);
      await markConsumed(run, entries, [messageText(entries.map((e) => e.message))]);
      expect(entries.map(messageState)).toEqual(["consumed"]);
    });
    expect(await waitForAck(run, id, 1)).toEqual({ status: "accepted", messageId: id });
    expect((await stat(ackPath(run, id))).mode & 0o777).toBe(0o600);
    for (const winner of ["taken_over"] as const) {
      const refused = await write();
      await withProtocolLock(paths.lock, async () => {
        await claim(paths.claim, winner);
        await acceptWritten(run, await inboxEntries(run));
      });
      expect(await readAck(run, refused)).toMatchObject({ state: "refused", claim: winner });
      expect(await waitForAck(run, refused, 1)).toEqual({
        status: "refused",
        messageId: refused,
        reason: winner,
      });
    }
  } finally {
    if (previous === undefined) delete process.env.PI_SUBAGENTS_STATE_DIR;
    else process.env.PI_SUBAGENTS_STATE_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
it("scopes by ancestry, never another parent's tree, and tolerates record order", () => {
  const run = (id: string, parentSessionId: string, parentRunId: string | null) =>
    ({ id, parentSessionId, parentRunId }) as RunRecord;
  const runs = [
    run("grandchild", "child-session", "child"),
    run("stranger", "other", null),
    run("child", "parent", null),
    run("other-child", "stranger-session", "stranger"),
  ];
  expect(ownedRuns(runs, "parent").map((r) => r.id)).toEqual(["grandchild", "child"]);
});
