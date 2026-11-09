import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { cancel } from "../../src/launch.ts";
import { readClaim } from "../../src/claims.ts";
import { executable } from "../../src/settings.ts";
import { observeProcess } from "../../src/rex.ts";
import { current, events, maybeFile, records, result, until } from "../lib/phase-one.ts";
import { directory, hold, queued, release } from "../lib/phase-two.ts";
import { parentTool } from "../lib/phase-five.ts";
import { entries, resultsEntries, sessionPath } from "../lib/phase-four.ts";
import { call, delegated, named, plan, tree } from "../lib/phase-six.ts";
import { object } from "../lib/rex.ts";
import { withRun } from "../lib/run.ts";

export default async function races(): Promise<void> {
  await withRun("nesting-races", async (run) => {
    await writeFile(join(run.state, "limits.json"), JSON.stringify({ active: 1, depth: 2 }));
    const cwd = await directory(run, "cancel");
    await plan(run, "cancel-live", [{ calls: [call("harness_hold")] }]);
    await plan(run, "cancel-queued", [{ calls: [call("harness_hold")] }]);
    await plan(run, "cancel-owner", [
      { calls: [call("subagent", delegated("cancel-live", cwd))] },
      { calls: [call("subagent", delegated("cancel-queued", cwd, "write"))] },
    ]);
    const launching = await tree(run, delegated("cancel-owner", cwd, "write", true));
    const owner = await launching.record(),
      live = await named(run, "cancel-live"),
      waiting = await named(run, "cancel-queued");
    await hold(run, live);
    await queued(run, waiting);
    await launching.answer();
    const list = await parentTool(run, launching.parent, "cancel-owner", "subagent_control", {
      operation: "list",
    });
    assert(Array.isArray(list.runs));
    const listed = list.runs.map(object);
    assert.equal(listed.length, 3);
    assert.equal(listed[0]?.runId, owner.id);
    assert(listed.filter((r) => r.parentRunId === owner.id).every((r) => r.indent === "  "));
    const response = await parentTool(run, launching.parent, "cancel-owner", "subagent_control", {
      operation: "cancel",
      runId: owner.id,
    });
    assert.equal(response.status, "cancelled");
    await until("whole managed tree cancelled", async () => {
      const all = await records(run);
      return [owner, live, waiting].every(
        (r) =>
          all.find((f) => f.id === r.id)?.process.state === "exited" &&
          all.find((f) => f.id === r.id)?.lifecycle === "cancelled",
      );
    });
    for (const r of [owner, live, waiting])
      assert.equal(await readClaim(r.paths.claim), "cancelled");
    assert.equal((await current(run, waiting.id)).rex, null);
    console.log(
      "nesting cancellation: PASS; public list indents descendants, public cancel claims live and queued subtree, queued child never starts",
    );

    await writeFile(join(run.state, "limits.json"), JSON.stringify({ active: 3, depth: 2 }));
    const slowRoot = await directory(run, "slow");
    const reply = join(run.out, "delayed-reply"),
      replyRelease = join(run.out, "release-reply");
    const wrapper = join(run.scratch, "delayed-rex.mjs");
    const rex = await executable(process.env.PI_SUBAGENTS_REX ?? "rex");
    await writeFile(
      wrapper,
      `#!${process.execPath}\nimport {spawnSync} from 'node:child_process'; import {writeFileSync,existsSync} from 'node:fs'; import {setTimeout as delay} from 'node:timers/promises'; const args=process.argv.slice(2); const delayed=args[0]==='window' && args[1]==='new' && args.includes('slow-grandchild'); const r=spawnSync(${JSON.stringify(rex)},args,delayed?{encoding:'utf8',maxBuffer:4*1024*1024}:{stdio:'inherit'}); if(delayed && r.status===0){writeFileSync(${JSON.stringify(reply)},r.stdout,{mode:0o600});while(!existsSync(${JSON.stringify(replyRelease)}))await delay(20);} if(delayed){await new Promise(done=>process.stdout.write(r.stdout??'',done));await new Promise(done=>process.stderr.write(r.stderr??'',done));} process.exit(r.status??1);\n`,
      { mode: 0o700 },
    );
    await plan(run, "slow-grandchild", [{ calls: [call("harness_hold")] }]);
    await plan(run, "slow-owner", [
      { calls: [call("subagent", delegated("slow-grandchild", slowRoot, "inspect", false))] },
    ]);
    const slow = await tree(run, delegated("slow-owner", slowRoot, "write", true), {
      PI_SUBAGENTS_REX: wrapper,
    });
    const slowOwner = await slow.record(),
      grandchild = await named(run, "slow-grandchild");
    const delayed = object(
      JSON.parse(await until("Rex block created, reply held", () => maybeFile(reply))),
    );
    assert.equal((await current(run, grandchild.id)).rex, null);
    const cancelling = cancel(await current(run, slowOwner.id));
    await until(
      "cancellation wins during Rex reply",
      async () => (await readClaim(grandchild.paths.claim)) === "cancelled",
    );
    await writeFile(replyRelease, "go");
    await cancelling;
    assert(Array.isArray(delayed.block_ids));
    const blockId = delayed.block_ids[0];
    assert(typeof blockId === "string");
    const location = (await current(run, slowOwner.id)).rex;
    assert(location);
    await until(
      "cancelled in-flight block closed",
      async () =>
        (await run.rex.command(["block", "inspect", "-s", location.sessionId, blockId, "--json"]))
          .code === 3,
    );
    assert.equal(await readClaim(grandchild.paths.claim), "cancelled");
    await run.record("inflight-cancellation-proof.json", {
      owner: await current(run, slowOwner.id),
      grandchild: await current(run, grandchild.id),
      delayed,
    });
    console.log(
      "nesting in-flight cancellation: PASS; cancellation claims grandchild before Rex reply, launcher closes exact returned block before ancestor exits",
    );

    // Crash only our managed parent, leaving a child outcome with no receiving process.
    const orphanRoot = await directory(run, "orphan-owner"),
      orphanLeafRoot = await directory(run, "orphan-leaf");
    await plan(run, "orphan-leaf", [{ calls: [call("harness_hold")] }]);
    await plan(run, "orphan-owner", [
      { calls: [call("subagent", delegated("orphan-leaf", orphanLeafRoot))] },
    ]);
    const orphan = await tree(run, delegated("orphan-owner", orphanRoot, "write", true));
    const orphanOwner = await orphan.record(),
      orphanLeaf = await named(run, "orphan-leaf");
    await hold(run, orphanLeaf);
    const parentRecord = await current(run, orphanOwner.id);
    assert(parentRecord.rex);
    const parentProcess = await observeProcess(parentRecord.rex);
    assert(parentProcess.process.state === "live" && parentProcess.process.pid);
    process.kill(parentProcess.process.pid, "SIGKILL");
    await until(
      "crashed immediate parent observed",
      async () => (await current(run, orphanOwner.id)).process.state === "exited",
    );
    await orphan.answer();
    const orphans = await parentTool(run, orphan.parent, "orphan-owner", "subagent_control", {
      operation: "list",
    });
    assert(Array.isArray(orphans.runs));
    assert(orphans.runs.map(object).some((r) => r.runId === orphanLeaf.id && r.orphaned === true));
    await release(orphanLeaf);
    await until(
      "orphan result preserved",
      async () => (await readClaim(orphanLeaf.paths.claim)) === "result",
    );
    assert((await result(orphanLeaf)).sessionFile);
    const rootMessages = resultsEntries(await entries(await sessionPath(run, "orphan-owner")));
    assert(!JSON.stringify(rootMessages).includes(orphanLeaf.id));
    assert(!(await events(orphanOwner)).some((e) => e.type === "descendants_sent"));
    assert(await maybeFile(join(dirname(orphanLeaf.paths.run), "result.json")));
    console.log(
      "nesting orphan: PASS; result retained, no delivery to gone parent or root, list marks orphaned",
    );
  });
}
