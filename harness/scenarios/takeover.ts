import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { claim, withRunLock } from "../../src/claims.ts";
import { cancel } from "../../src/launch.ts";
import { observeProcess } from "../../src/rex.ts";
import { withRun } from "../lib/run.ts";
import { current, events, key, maybeFile, result, send, start, until } from "../lib/phase-one.ts";

export default async function takeover(): Promise<void> {
  await withRun("takeover", async (run) => {
    const steered = await start(run, {
      label: "steer",
      task: "Call harness_hold exactly once and wait before your final report.",
    });
    const original = await steered.record();
    await until("steer hold", () => maybeFile(join(dirname(original.paths.run), "holding")));
    const live = await current(run, original.id);
    assert(live.rex);
    await send(
      run,
      live.rex,
      "After the hold, include STEERING_REACHED_CHILD in your final report.",
    );
    await writeFile(join(dirname(live.paths.run), "release"), "go", { mode: 0o600 });
    await steered.answer();
    const finished = await current(run, live.id);
    assert.equal(finished.lifecycle, "completed");
    const reported = await result(finished);
    assert(reported.sessionFile);
    assert.match(await readFile(reported.sessionFile, "utf8"), /STEERING_REACHED_CHILD/);
    console.log(
      "takeover steer: PASS; Rex-typed steering persisted in the child session before completion",
    );

    const settled = await start(run, {
      label: "settled-first",
      task: "HARNESS_MODE=settle-first\nReply briefly. Do not use tools.",
    });
    const settledRecord = await settled.record();
    await settled.answer();
    const settledFinal = await current(run, settledRecord.id);
    assert.equal(settledFinal.lifecycle, "completed");
    assert(
      (await events(settledRecord)).some(
        (e) => e.type === "takeover_refused" && e.data.winner === "result",
      ),
    );
    console.log(
      "takeover settlement-first: PASS; queued takeover refused visibly with result as winner",
    );
    const delayed = await start(run, {
      label: "delayed-ack",
      task: "HARNESS_MODE=delay-ack\nCall harness_hold exactly once and wait before replying.",
    });
    const delayedRecord = await delayed.record();
    await until("delayed-ack hold", () =>
      maybeFile(join(dirname(delayedRecord.paths.run), "holding")),
    );
    const delayedLive = await current(run, delayedRecord.id);
    assert(delayedLive.rex);
    await send(run, delayedLive.rex, "/subagent-takeover");
    await until("acknowledgement deliberately delayed", () =>
      maybeFile(join(dirname(delayedRecord.paths.run), "ack-delayed")),
    );
    assert(!(await events(delayedRecord)).some((e) => e.type === "takeover_acknowledged"));
    await key(run, delayed.parent, "escape");
    assert.equal(await cancel(delayedLive), "taken_over");
    await delayed.answer();
    assert.equal((await current(run, delayedRecord.id)).lifecycle, "taken_over");
    assert.equal((await observeProcess(delayedLive.rex)).process.state, "live");
    await until("delayed acknowledgement finishes", async () =>
      (await events(delayedRecord)).some((e) => e.type === "takeover_acknowledged"),
    );
    await key(run, delayedLive.rex, "escape");
    await until("delayed child settles interruption", async () =>
      (await events(delayedRecord)).some((e) => e.type === "agent_settled"),
    );
    await key(run, delayedLive.rex, "ctrl+d");
    console.log(
      "takeover delayed-ack: PASS; parent abort/cancel after claim and before acknowledgement leaves child alive",
    );
    const cancelled = await start(run, {
      label: "cancel-first",
      task: "Call harness_hold exactly once and wait before replying.",
    });
    const cancelledRecord = await cancelled.record();
    await until("cancel-first hold", () =>
      maybeFile(join(dirname(cancelledRecord.paths.run), "holding")),
    );
    const cancelledLive = await current(run, cancelledRecord.id);
    assert(cancelledLive.rex);
    // Pause parent cancellation between the durable step and signalling to force this ordering.
    await withRunLock(cancelledLive.paths.lock, () =>
      claim(cancelledLive.paths.claim, "cancelled"),
    );
    await send(run, cancelledLive.rex, "/subagent-takeover");
    await until("takeover names cancellation winner", async () =>
      (await events(cancelledRecord)).some(
        (e) => e.type === "takeover_refused" && e.data.winner === "cancelled",
      ),
    );
    await key(run, cancelled.parent, "escape");
    await cancelled.answer();
    const cancelledFinal = await current(run, cancelledRecord.id);
    assert.equal(cancelledFinal.lifecycle, "cancelled");
    assert.equal(cancelledFinal.process.state, "exited");
    console.log(
      "takeover cancellation-first: PASS; takeover refuses the durable cancellation winner before signalling",
    );
    const launched = await start(run, {
      label: "human-owned",
      task: "Call harness_hold exactly once and wait before your final report.",
    });
    const record = await launched.record();
    await until("takeover hold", () => maybeFile(join(dirname(record.paths.run), "holding")));
    const active = await current(run, record.id);
    assert(active.rex);
    await send(run, active.rex, "/subagent-takeover");
    await until(
      "durable takeover claim",
      async () => (await maybeFile(active.paths.claim)) === "taken_over",
    );
    await launched.answer();
    const taken = await current(run, record.id);
    assert.equal(taken.lifecycle, "taken_over");
    assert.equal(taken.process.state, "live");
    const beforeCancel = await observeProcess(active.rex);
    assert.equal(beforeCancel.process.state, "live");
    assert.equal(await cancel(taken), "taken_over");
    assert.equal((await observeProcess(active.rex)).process.state, "live");
    const acknowledged = await events(active);
    assert(acknowledged.some((e) => e.type === "takeover_acknowledged"));
    await key(run, active.rex, "escape");
    await until("taken-over interrupt settled", async () =>
      (await events(active)).some((e) => e.type === "agent_settled" && e.data.aborted === true),
    );
    assert.equal(await maybeFile(active.paths.result), null);
    const count = (await events(active)).filter((e) => e.type === "agent_settled").length;
    await send(run, active.rex, "Human continuation: reply HUMAN_CONTINUED and do not use tools.");
    await until(
      "human continuation settles",
      async () => (await events(active)).filter((e) => e.type === "agent_settled").length > count,
    );
    assert.equal(await maybeFile(active.paths.result), null);
    assert.equal((await observeProcess(active.rex)).process.state, "live");
    await send(run, active.rex, "/reload");
    await until("reload reads durable takeover", async () =>
      (await events(active)).some(
        (e) =>
          e.type === "session_start" && e.data.reason === "reload" && e.data.claim === "taken_over",
      ),
    );
    assert.equal(await maybeFile(active.paths.result), null);
    assert.equal((await observeProcess(active.rex)).process.state, "live");
    await run.record("takeover-evidence.json", {
      taken,
      log: await events(active),
      cancellationRefused: true,
    });
    await key(run, active.rex, "ctrl+d");
    await until(
      "human process exits",
      async () =>
        (await observeProcess(active.rex as NonNullable<typeof active.rex>)).process.state ===
        "exited",
    );
    assert.equal(await readFile(active.paths.claim, "utf8"), "taken_over");
    assert.equal(await maybeFile(active.paths.result), null);
    console.log(
      "takeover: PASS; durable claim before ack, live handoff, cancellation refused, Escape distinct, human continuation, reload preserves ownership, human exit leaves artifacts intact",
    );
  });
}
