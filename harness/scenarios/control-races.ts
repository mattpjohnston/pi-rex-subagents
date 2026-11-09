import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readAck, sendInboxMessage } from "../../src/inbox.ts";
import { resultText } from "../../src/results.ts";
import { observeProcess } from "../../src/rex.ts";
import { readClaim } from "../../src/claims.ts";
import { current, events, key, maybeFile, send, until } from "../lib/phase-one.ts";
import { directory, finished, hold, release } from "../lib/phase-two.ts";
import { holdTask, launchControlled, parentTool, userMessageWithId } from "../lib/phase-five.ts";
import { turnEnded } from "../lib/phase-four.ts";
import { withRun } from "../lib/run.ts";

export default async function controlRaces(): Promise<void> {
  await withRun("control-races", async (run) => {
    const cwd = await directory(run, "race");
    const settling = await launchControlled(run, {
      label: "settling",
      cwd,
      background: true,
      task: "HARNESS_MODE=settle-pause\nReply briefly. Do not use tools.",
    });
    const record = await settling.record();
    await settling.answer();
    await until("settlement barrier open", () =>
      maybeFile(join(dirname(record.paths.run), "settling-paused")),
    );
    const settlingLive = await until("child running while settlement paused", async () => {
      const r = await current(run, record.id);
      return r.lifecycle === "running" && r;
    });
    const accepted = await sendInboxMessage(
      settlingLive,
      record.parentSessionId,
      "Correction: reply SETTLEMENT_ORDER_APPLIED. Do not use tools.",
    );
    assert.equal(accepted.status, "accepted");
    assert(accepted.messageId);
    assert.equal(await readClaim(record.paths.claim), null);
    assert.equal((await readAck(record, accepted.messageId))?.state, "accepted");
    await writeFile(join(dirname(record.paths.run), "release-settlement"), "go", { mode: 0o600 });
    await userMessageWithId(record, accepted.messageId);
    await finished(run, record);
    const resultBefore = await readFile(record.paths.result, "utf8");
    assert.match(resultBefore, /SETTLEMENT_ORDER_APPLIED/);
    const refused = await sendInboxMessage(
      await current(run, record.id),
      record.parentSessionId,
      "Late correction",
    );
    assert.equal(refused.status, "refused");
    if (refused.status === "refused") assert.equal(refused.reason, "result");
    assert.equal(await readFile(record.paths.result, "utf8"), resultBefore);
    console.log(
      "control settlement orderings: PASS; pre-publication message accepted and applied before result; post-claim message refused, result unchanged",
    );

    const takeover = await launchControlled(run, {
      label: "takeover-message",
      cwd,
      background: true,
      task: holdTask,
    });
    const takenLive = await hold(run, await takeover.record());
    await takeover.answer();
    assert(takenLive.rex);
    const beforeTakeover = await sendInboxMessage(
      takenLive,
      takenLive.parentSessionId,
      "Hold order accepted just before human takeover.",
    );
    assert.equal(beforeTakeover.status, "accepted");
    assert(beforeTakeover.messageId);
    assert.equal((await readAck(takenLive, beforeTakeover.messageId))?.state, "accepted");
    await send(run, takenLive.rex, "/subagent-takeover");
    const taken = await until("takeover lists pending accepted message", async () => {
      const r = await current(run, takenLive.id);
      return (
        r.lifecycle === "taken_over" &&
        r.unconsumedMessages?.some((m) => m.id === beforeTakeover.messageId) &&
        r
      );
    });
    assert(resultText(taken).includes(beforeTakeover.messageId));
    const afterTakeover = await sendInboxMessage(
      taken,
      taken.parentSessionId,
      "This must be refused",
    );
    assert.equal(afterTakeover.status, "refused");
    const noCancel = await parentTool(
      run,
      takeover.parent,
      "takeover-message",
      "subagent_control",
      { operation: "cancel", runId: taken.id },
    );
    assert.equal(noCancel.status, "refused");
    assert.equal((await observeProcess(takenLive.rex)).process.state, "live");
    await key(run, takenLive.rex, "escape");
    await until("human interrupt settled", async () =>
      (await events(takenLive)).some((e) => e.type === "agent_settled"),
    );
    await key(run, takenLive.rex, "ctrl+d");
    console.log(
      "control takeover: PASS; accepted unconsumed ID listed in taken_over outcome, later message and model cancellation refused, human process left live",
    );

    const hung = await launchControlled(run, {
      label: "hung-result",
      cwd: await directory(run, "hang"),
      background: true,
      task: "HARNESS_MODE=hang\nReply briefly. Do not use tools.",
    });
    const hungRecord = await hung.record();
    await hung.answer();
    await until(
      "result shutdown grace ends",
      async () => (await current(run, hungRecord.id)).process.state === "unresolved",
    );
    const unchanged = await readFile(hungRecord.paths.result, "utf8");
    const closed = await parentTool(run, hung.parent, "hung-result", "subagent_control", {
      operation: "cancel",
      runId: hungRecord.id,
    });
    assert.equal(closed.status, "result");
    assert.equal(await readFile(hungRecord.paths.result, "utf8"), unchanged);
    assert.equal(await readClaim(hungRecord.paths.claim), "result");
    assert(hungRecord.rex || (await current(run, hungRecord.id)).rex);
    const hungFinal = await current(run, hungRecord.id);
    assert(hungFinal.rex);
    assert.equal((await observeProcess(hungFinal.rex)).process.state, "exited");
    console.log(
      "control hung result: PASS; model cancellation closed process after grace; result bytes and claim unchanged",
    );

    const crash = await launchControlled(
      run,
      {
        label: "crash-cancel",
        cwd: await directory(run, "crash"),
        background: true,
        task: holdTask,
      },
      { HARNESS_CANCEL_CRASH: "1" },
    );
    const orphan = await hold(run, await crash.record());
    await crash.answer();
    // The real parent model calls cancel. A hook kills only this disposable parent after its claim.
    await turnEnded(run, "crash-cancel");
    await send(
      run,
      crash.parent,
      `Call subagent_control with operation cancel and runId ${orphan.id}. Do not use other tools.`,
    );
    await until(
      "crashed parent left cancellation claim",
      async () => (await readClaim(orphan.paths.claim)) === "cancelled",
    );
    assert(orphan.rex);
    await until(
      "parent process crash confirmed",
      async () =>
        (await observeProcess({ ...crash.parent, windowId: "unused" })).process.state === "exited",
    );
    assert.equal((await observeProcess(orphan.rex)).process.state, "live");
    await release(orphan);
    await until(
      "child exits at next settlement without a live parent",
      async () =>
        (await observeProcess(orphan.rex as NonNullable<typeof orphan.rex>)).process.state ===
        "exited",
    );
    assert.equal(await readClaim(orphan.paths.claim), "cancelled");
    assert.equal(await maybeFile(orphan.paths.result), null);
    assert((await events(orphan)).some((e) => e.type === "agent_settled"));
    // Crash must also have been a real model-facing call, logged before the hook killed the parent.
    assert.match(
      await readFile(join(run.out, "crash-cancel-tools.jsonl"), "utf8"),
      /"name":"subagent_control"/,
    );
    console.log(
      "control cancel crash: PASS; parent SIGKILL after cancelled claim and before signal; child remained live, then exited at next settlement with no result",
    );
    // An orphan's queued delivery is intentionally not appended to any replacement parent.
    await run.record("race-evidence.json", {
      accepted,
      refused,
      taken,
      afterTakeover,
      noCancel,
      closed,
    });
  });
}
