import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readClaim } from "../../src/claims.ts";
import { current, events, maybeFile, result, start, until } from "../lib/phase-one.ts";
import { directory, finished, hold, queued, release } from "../lib/phase-two.ts";
import {
  assertNoStart,
  batchReady,
  call,
  deliveredBeforePublish,
  delegated,
  named,
  plan,
  snapshotProof,
  toolResults,
  tree,
} from "../lib/phase-six.ts";
import { withRun } from "../lib/run.ts";

export default async function nesting(): Promise<void> {
  await withRun("nesting", async (run) => {
    await writeFile(join(run.state, "limits.json"), JSON.stringify({ active: 1, depth: 2 }));
    const cwd = await directory(run, "foreground");
    const go = join(run.out, "launch-review"),
      shellReady = join(run.out, "shell-ready"),
      shellRelease = join(run.out, "shell-release");
    await writeFile(join(cwd, "original"), "unchanged");
    await plan(run, "review", [{ calls: [call("harness_hold")] }]);
    await plan(run, "writer", [
      {
        waitFor: go,
        calls: [
          call("bash", {
            command: `printf ready > '${shellReady}'; while [ ! -f '${shellRelease}' ]; do sleep 0.1; done`,
          }),
          call("edit", {
            path: join(cwd, "original"),
            edits: [{ oldText: "unchanged", newText: "bad" }],
          }),
          call("write", { path: join(cwd, "blocked"), content: "bad" }),
          call("subagent", delegated("review", cwd, "inspect", false)),
        ],
      },
    ]);
    const launch = await tree(run, delegated("writer", cwd, "write", false));
    const writer = await launch.record();
    await batchReady(writer, 0);
    const outside = await start(run, delegated("outside", cwd, "write", true));
    const outsideRecord = await outside.record();
    await queued(run, outsideRecord);
    await writeFile(go, "go");
    const review = await named(run, "review");
    await until("same-message bash running", () => maybeFile(shellReady));
    await queued(run, review);
    await assertNoStart(run, review);
    assert.equal(await readFile(join(cwd, "original"), "utf8"), "unchanged");
    assert.equal(await maybeFile(join(cwd, "blocked")), null);
    const heldJoin = await snapshotProof(run, "join-held-by-bash");
    assert(heldJoin.runs.find((r) => r.id === review.id)?.joining?.includes(writer.id));
    await writeFile(shellRelease, "go");
    await hold(run, review);
    const snapshot = await snapshotProof(run, "joined-ahead-of-outside");
    const member = snapshot.runs.find((r) => r.id === review.id);
    assert.equal(member?.reservation, writer.id);
    assert.equal(snapshot.runs.find((r) => r.id === writer.id)?.state, "parked");
    await assertNoStart(run, outsideRecord);
    const toolEnds = (await events(writer)).filter((e) => e.type === "tool_ended");
    const bashEnd = toolEnds.find((e) => e.data.name === "bash");
    const reviewLoaded = (await events(review)).find((e) => e.type === "child_loaded");
    assert(bashEnd && reviewLoaded && bashEnd.at <= reviewLoaded.at);
    await release(review);
    await launch.answer();
    const finalWriter = await finished(run, writer);
    const results = await toolResults(finalWriter);
    for (const name of ["edit", "write"])
      assert(
        results.some(
          (r) => r.toolName === name && r.isError && /refused/.test(JSON.stringify(r.content)),
        ),
      );
    assert(results.some((r) => r.toolName === "bash" && !r.isError));
    await hold(run, outsideRecord);
    await release(outsideRecord);
    await finished(run, outsideRecord);
    console.log(
      "nesting foreground: PASS; subagent exempt, bash holds join, same-message edit/write refused, joins ahead of outside writer at active=1",
    );

    await writeFile(join(run.state, "limits.json"), JSON.stringify({ active: 4, depth: 2 }));
    const fifoRoot = await directory(run, "fifo");
    await writeFile(join(fifoRoot, "read-me"), "review");
    for (const label of ["first-reader", "older-writer"])
      await plan(run, label, [{ calls: [call("harness_hold")] }]);
    await plan(run, "newer-reader", [
      { calls: [call("read", { path: join(fifoRoot, "read-me") })] },
    ]);
    await plan(run, "fifo-owner", [
      {
        calls: [call("subagent", delegated("first-reader", fifoRoot))],
      },
      { calls: [call("subagent", delegated("older-writer", fifoRoot, "write"))] },
      { calls: [call("subagent", delegated("newer-reader", fifoRoot, "read"))] },
      {
        calls: [
          call("write", { path: join(fifoRoot, "blocked"), content: "bad" }),
          call("edit", {
            path: join(fifoRoot, "read-me"),
            edits: [{ oldText: "review", newText: "bad" }],
          }),
        ],
      },
    ]);
    const fifo = await tree(run, delegated("fifo-owner", fifoRoot, "write", false));
    const owner = await fifo.record();
    const first = await named(run, "first-reader"),
      older = await named(run, "older-writer"),
      newer = await named(run, "newer-reader");
    await hold(run, first);
    await queued(run, older);
    await queued(run, newer);
    await release(first);
    await hold(run, older);
    await assertNoStart(run, newer);
    await release(older);
    await fifo.answer();
    const finalOwner = await finished(run, owner);
    const finalOlder = await finished(run, older),
      finalNewer = await finished(run, newer);
    assert((finalNewer.loadedAt ?? 0) >= (await result(finalOlder)).finishedAt);
    const ownerEvents = await events(finalOwner);
    assert(ownerEvents.some((e) => e.type === "parked"));
    assert(ownerEvents.filter((e) => e.type === "descendants_sent").length >= 1);
    assert.equal(await readClaim(finalOwner.paths.claim), "result");
    assert.equal(await maybeFile(join(fifoRoot, "blocked")), null);
    console.log(
      "nesting FIFO: PASS; newer reader did not bypass older nested writer; member guard remains active after background launch",
    );

    // A background descendant may finish while its immediate parent is still in a tool.
    const busyRoot = await directory(run, "busy-owner"),
      leafA = await directory(run, "leaf-a"),
      leafB = await directory(run, "leaf-b");
    for (const label of ["busy-a", "busy-b"])
      await plan(run, label, [{ calls: [call("harness_hold")] }]);
    await plan(run, "busy-owner", [
      {
        calls: [
          call("subagent", delegated("busy-a", leafA)),
          call("subagent", delegated("busy-b", leafB)),
        ],
      },
      { calls: [call("harness_hold")] },
    ]);
    const busy = await tree(run, delegated("busy-owner", busyRoot, "write", false));
    const busyOwner = await busy.record(),
      a = await named(run, "busy-a"),
      b = await named(run, "busy-b");
    await hold(run, busyOwner);
    await hold(run, a);
    await hold(run, b);
    await release(a);
    await release(b);
    await finished(run, a);
    await finished(run, b);
    assert.equal(await readClaim(busyOwner.paths.claim), null);
    assert(!(await events(busyOwner)).some((e) => e.type === "descendants_sent"));
    await release(busyOwner);
    await busy.answer();
    await finished(run, busyOwner);
    await deliveredBeforePublish(busyOwner, [a.id, b.id]);
    assert.equal((await current(run, busyOwner.id)).activity?.parked, null);
    await run.record("nesting-proof.json", {
      foreground: writer.id,
      fifo: owner.id,
      busy: busyOwner.id,
      retainedOutcomes: [a.id, b.id],
    });
    assert(await maybeFile(join(dirname(busyOwner.paths.run), "result.json")));
    console.log(
      "nesting busy delivery: PASS; both outcomes retained while busy, persisted together before publication, no subagent-results path",
    );
  });
}
