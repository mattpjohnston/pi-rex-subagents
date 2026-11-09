import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { readClaim } from "../../src/claims.ts";
import { readAck, sendInboxMessage } from "../../src/inbox.ts";
import { observeProcess } from "../../src/rex.ts";
import { current, events, maybeFile, records, result, send, until } from "../lib/phase-one.ts";
import { directory, finished, hold, release } from "../lib/phase-two.ts";
import {
  holdTask,
  launchControlled,
  leaveStaleRunLock,
  parentTool,
  userMessageWithId,
} from "../lib/phase-five.ts";
import { withRun } from "../lib/run.ts";

export default async function control(): Promise<void> {
  await withRun("control", async (run) => {
    const cwd = await directory(run, "owned");
    const own = await launchControlled(run, {
      label: "control",
      cwd,
      task: holdTask,
      background: true,
    });
    const live = await hold(run, await own.record());
    await own.answer();
    const foreign = await launchControlled(run, {
      label: "foreign",
      cwd: await directory(run, "foreign"),
      task: holdTask,
      background: true,
    });
    const outsider = await hold(run, await foreign.record());
    await foreign.answer();
    const list = await parentTool(run, own.parent, "control", "subagent_control", {
      operation: "list",
    });
    assert(Array.isArray(list.runs));
    assert(list.runs.some((r) => JSON.stringify(r).includes(live.id)));
    assert(
      list.runs.some(
        (r) =>
          r &&
          typeof r === "object" &&
          "lastRexStatus" in r &&
          r.lastRexStatus &&
          typeof r.lastRexStatus === "object" &&
          "state" in r.lastRexStatus &&
          r.lastRexStatus.state === "working",
      ),
      "List must return the child's real Rex working status",
    );
    assert(!JSON.stringify(list).includes(outsider.id));
    console.log(
      "control list: PASS; real parent model call, own run present, other parent's run absent",
    );

    // Leave metadata for a confirmed dead PID; message must recover it rather than time out.
    await leaveStaleRunLock(live.paths.lock);
    const message = await parentTool(run, own.parent, "control", "subagent_control", {
      operation: "message",
      runId: live.id,
      text: "Correction: include WORKING_ORDER_APPLIED in your final report after the hold returns.",
    });
    assert.equal(message.status, "accepted");
    assert.equal(typeof message.messageId, "string");
    assert((await events(live)).some((e) => e.type === "inbox_sent" && e.data.mode === "steer"));
    await release(live);
    await userMessageWithId(live, String(message.messageId));
    const final = await finished(run, live);
    assert.match((await result(final)).assistantText, /WORKING_ORDER_APPLIED/);
    assert.equal((await readAck(live, String(message.messageId)))?.state, "consumed");
    console.log(
      "control message working + stale lock: PASS; accepted, steer, ID persisted as user, consumed, final reply applied order",
    );

    const idle = await launchControlled(run, {
      label: "idle-message",
      cwd,
      task: "HARNESS_MODE=idle\nReply READY. Do not use tools.",
      background: true,
    });
    const idleRun = await idle.record();
    await idle.answer();
    await until("idle child held after settlement", () =>
      maybeFile(join(dirname(idleRun.paths.run), "idle-held")),
    );
    const idleLive = await current(run, idleRun.id);
    const idleMessage = await sendInboxMessage(
      idleLive,
      idleLive.parentSessionId,
      "Correction: reply IDLE_ORDER_APPLIED. Do not use tools.",
    );
    assert.equal(idleMessage.status, "accepted");
    assert(idleMessage.messageId);
    await userMessageWithId(idleRun, idleMessage.messageId);
    await finished(run, idleRun);
    assert.match((await result(idleRun)).assistantText, /IDLE_ORDER_APPLIED/);
    assert(
      (await events(idleRun)).some((e) => e.type === "inbox_sent" && e.data.mode === "prompt"),
    );
    console.log("control idle: PASS; idle prompt ID persisted as user and reply applied order");

    const dialog = await launchControlled(run, {
      label: "dialog-message",
      cwd,
      background: true,
      task: "Call ask_human exactly once and wait for the answer before replying. Then obey any correction you received.",
    });
    const dialogRun = await dialog.record();
    await dialog.answer();
    const dialogLive = await until("open child dialog", async () => {
      const r = await current(run, dialogRun.id);
      return r.waiting && r.rex && r;
    });
    assert(dialogLive.rex);
    const dialogMessage = await sendInboxMessage(
      dialogLive,
      dialogLive.parentSessionId,
      "Correction: include DIALOG_ORDER_APPLIED in your final report. This is not a dialog answer.",
    );
    assert.equal(dialogMessage.status, "accepted");
    assert(dialogMessage.messageId);
    assert(!(await events(dialogRun)).some((e) => e.type === "ui_prompt_end"));
    assert.equal((await observeProcess(dialogLive.rex)).process.state, "live");
    assert((await current(run, dialogRun.id)).waiting);
    await send(run, dialogLive.rex, "HARNESS_HUMAN_ANSWER");
    await userMessageWithId(dialogRun, dialogMessage.messageId);
    await finished(run, dialogRun);
    assert((await events(dialogRun)).some((e) => e.type === "ui_prompt_end"));
    assert.match((await result(dialogRun)).assistantText, /DIALOG_ORDER_APPLIED/);
    console.log(
      "control dialog: PASS; message accepted without answering dialog; ui_prompt_end only after harness human answer",
    );

    const cancelLive = await launchControlled(run, {
      label: "cancel-control",
      cwd,
      background: true,
      task: holdTask,
    });
    const toCancel = await hold(run, await cancelLive.record());
    await cancelLive.answer();
    await parentTool(run, cancelLive.parent, "cancel-control", "subagent", {
      label: "queued-control",
      cwd,
      background: true,
      task: "Reply briefly. Do not use tools.",
    });
    const queued = await until("queued owned child", async () =>
      (await records(run)).find((r) => r.label === "queued-control" && r.queue),
    );
    const queuedCancel = await parentTool(
      run,
      cancelLive.parent,
      "cancel-control",
      "subagent_control",
      { operation: "cancel", runId: queued.id },
    );
    assert.equal(queuedCancel.status, "cancelled");
    const liveCancel = await parentTool(
      run,
      cancelLive.parent,
      "cancel-control",
      "subagent_control",
      { operation: "cancel", runId: toCancel.id },
    );
    assert.equal(liveCancel.status, "cancelled");
    await until(
      "queued and live process exit",
      async () =>
        (await current(run, queued.id)).process.state === "exited" &&
        (await current(run, toCancel.id)).process.state === "exited",
    );
    assert.equal(await readClaim(queued.paths.claim), "cancelled");
    assert.equal(await readClaim(toCancel.paths.claim), "cancelled");
    console.log(
      "control cancel: PASS; real model cancels queued and live background children through durable claims; both exited",
    );
    await release(outsider);
    await finished(run, outsider);
    await run.record("control-evidence.json", {
      list,
      message,
      idleMessage,
      dialogMessage,
      queuedCancel,
      liveCancel,
    });
  });
}
