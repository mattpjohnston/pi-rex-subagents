import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readClaim } from "../../src/claims.ts";
import { cancel } from "../../src/launch.ts";
import { observeProcess } from "../../src/rex.ts";
import { current, events, records, send, start, until } from "../lib/phase-one.ts";
import { directory, finished, hold, queued, release } from "../lib/phase-two.ts";
import { parentLaunch, resultsEntries, entries, runIds, sessionPath } from "../lib/phase-four.ts";
import {
  assertNoStart,
  batchReady,
  call,
  delegated,
  deliveredBeforePublish,
  named,
  plan,
  snapshotProof,
  tree,
} from "../lib/phase-six.ts";
import { repo, withRun } from "../lib/run.ts";
import { delimiter } from "node:path";

export default async function capacity(): Promise<void> {
  await withRun("nesting-capacity", async (run) => {
    const limits = async (active: number) =>
      writeFile(join(run.state, "limits.json"), JSON.stringify({ active, depth: 2 }));
    await limits(2);
    const aRoot = await directory(run, "a"),
      bRoot = await directory(run, "b");
    const go = join(run.out, "workers-go");
    for (const [worker, leaf, cwd] of [
      ["worker-a", "review-a", aRoot],
      ["worker-b", "review-b", bRoot],
    ]) {
      assert(worker && leaf && cwd);
      await plan(run, leaf, [{ calls: [call("harness_hold")] }]);
      await plan(run, worker, [{ waitFor: go, calls: [call("subagent", delegated(leaf, cwd))] }]);
    }
    const plans = join(run.out, "coordinator-plans.json");
    await writeFile(
      plans,
      JSON.stringify([
        delegated("worker-a", aRoot, "write"),
        delegated("worker-b", bRoot, "write"),
      ]),
    );
    await run.newSession(
      "coordinator",
      await parentLaunch(
        run,
        "coordinator",
        "Call harness_background exactly once. Then reply briefly and do not launch other work. When results arrive, acknowledge briefly.",
        [],
        {
          HARNESS_PLANS: plans,
          HARNESS_RESPONSE: join(run.out, "coordinator-response.json"),
          HARNESS_NESTED_PLAN_DIR: join(run.out, "plans"),
          PI_SUBAGENTS_CHILD_EXTENSIONS: [
            join(repo, "harness", "child-tools.ts"),
            join(repo, "harness", "nesting-hooks.ts"),
          ].join(delimiter),
        },
      ),
    );
    const a = await named(run, "worker-a"),
      b = await named(run, "worker-b");
    await batchReady(a, 0);
    await batchReady(b, 0);
    await writeFile(go, "go");
    const ra = await named(run, "review-a"),
      rb = await named(run, "review-b");
    await hold(run, ra);
    await hold(run, rb);
    const parked = await snapshotProof(run, "background-tree-at-ceiling");
    assert.equal(parked.runs.filter((r) => r.state === "running").length, 2);
    for (const writer of [a, b])
      assert.equal(parked.runs.find((r) => r.id === writer.id)?.state, "parked");
    assert.equal(a.parentSessionId, b.parentSessionId);
    assert.equal(ra.rootParentSessionId, a.parentSessionId);
    assert.equal(rb.rootParentSessionId, a.parentSessionId);
    await limits(1);
    await release(ra);
    await finished(run, ra);
    await until(
      "parked writer waiting to reacquire slot",
      async () => (await current(run, a.id)).activity?.readyToWake,
    );
    const outsiderRoot = await directory(run, "newer");
    const outsider = await start(run, delegated("newer-ticket", outsiderRoot, "write", true));
    const newer = await outsider.record();
    await queued(run, newer, "capacity");
    await assertNoStart(run, newer);
    const waiting = await snapshotProof(run, "wake-before-newer-ticket");
    assert(waiting.runs.find((r) => r.id === a.id)?.readyToWake);
    await release(rb);
    await finished(run, a);
    await finished(run, b);
    await hold(run, newer);
    const modelCalls = (await events(a)).filter((e) => e.type === "model_call");
    assert(modelCalls.length >= 3);
    assert(
      modelCalls.every(
        (e) =>
          e.data.activity &&
          typeof e.data.activity === "object" &&
          "parked" in e.data.activity &&
          e.data.activity.parked === null,
      ),
    );
    const deliveredA = (await events(a)).find((e) => e.type === "descendants_sent");
    assert(
      deliveredA &&
        (await current(run, newer.id)).loadedAt &&
        deliveredA.at <= ((await current(run, newer.id)).loadedAt ?? 0),
    );
    await deliveredBeforePublish(a, [ra.id]);
    await deliveredBeforePublish(b, [rb.id]);
    await release(newer);
    await finished(run, newer);
    const rootDeliveries = await until("coordinator receives only its workers", async () => {
      const rows = resultsEntries(await entries(await sessionPath(run, "coordinator")));
      const ids = rows.flatMap(runIds);
      return [a.id, b.id].every((id) => ids.includes(id)) ? ids : null;
    });
    assert(!rootDeliveries.includes(ra.id) && !rootDeliveries.includes(rb.id));
    console.log(
      "nesting background capacity: PASS; orchestrate-shaped workers park at active=2, nested reviews run, wake at active=1 precedes newer ticket, every observed model call is unparked",
    );

    // A takeover is a human action, not a model-driven wake: it may exceed the ceiling.
    await limits(1);
    const humanRoot = await directory(run, "human"),
      reviewRoot = await directory(run, "human-review");
    await plan(run, "human-review", [{ calls: [call("harness_hold")] }]);
    await plan(run, "parked-human", [
      { calls: [call("subagent", delegated("human-review", reviewRoot, "inspect", false))] },
    ]);
    const human = await tree(run, delegated("parked-human", humanRoot, "write", true));
    const owner = await human.record(),
      reviewer = await named(run, "human-review");
    await hold(run, reviewer);
    const owned = await current(run, owner.id);
    assert(owned.rex);
    assert.equal(owned.activity?.parked, "foreground");
    await send(run, owned.rex, "/subagent-takeover");
    await until(
      "parked takeover claim",
      async () => (await readClaim(owner.paths.claim)) === "taken_over",
    );
    const full = await snapshotProof(run, "human-over-ceiling");
    assert.equal(full.runs.filter((r) => r.state === "running" || r.state === "taken").length, 2);
    const waitingParent = await start(
      run,
      delegated("after-human", await directory(run, "after-human"), "write", true),
    );
    const after = await waitingParent.record();
    await queued(run, after, "capacity");
    await assertNoStart(run, after);
    assert.equal(await cancel(owner), "taken_over");
    assert.equal(await cancel(reviewer), "taken_over");
    await release(reviewer);
    await finished(run, reviewer);
    await assertNoStart(run, after); // the human still consumes the only slot
    await run.rex.command(["block", "close", "-s", owned.rex.sessionId, owned.rex.blockId], false);
    await hold(run, after);
    await release(after);
    await finished(run, after);
    console.log(
      "nesting human capacity: PASS; takeover counts immediately above ceiling, blocks new work, cancellation protects human subtree",
    );

    await limits(3);
    const takenRoot = await directory(run, "taken-leaf"),
      parentRoot = await directory(run, "taken-owner");
    await plan(run, "taken-leaf", [{ calls: [call("harness_hold")] }]);
    await plan(run, "taken-owner", [
      { calls: [call("subagent", delegated("taken-leaf", takenRoot))] },
    ]);
    const taking = await tree(run, delegated("taken-owner", parentRoot, "write", false));
    const takenOwner = await taking.record(),
      leaf = await named(run, "taken-leaf");
    await hold(run, leaf);
    const liveLeaf = await current(run, leaf.id);
    assert(liveLeaf.rex);
    await send(run, liveLeaf.rex, "/subagent-takeover");
    await taking.answer();
    await finished(run, takenOwner);
    assert.equal((await observeProcess(liveLeaf.rex)).process.state, "live");
    await deliveredBeforePublish(takenOwner, [leaf.id]);
    assert.equal(await readClaim(leaf.paths.claim), "taken_over");
    await run.rex.command(
      ["block", "close", "-s", liveLeaf.rex.sessionId, liveLeaf.rex.blockId],
      false,
    );
    await run.record("capacity-evidence.json", {
      parked,
      waiting,
      full,
      records: await records(run),
    });
    console.log(
      "nesting descendant takeover: PASS; parent publishes after taken_over delivery while human descendant stays live",
    );
  });
}
