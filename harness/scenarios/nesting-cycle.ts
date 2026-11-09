import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { events, maybeFile, records, until } from "../lib/phase-one.ts";
import { directory, finished, queued } from "../lib/phase-two.ts";
import {
  batchReady,
  call,
  delegated,
  named,
  plan,
  snapshotProof,
  toolResults,
  tree,
} from "../lib/phase-six.ts";
import { withRun } from "../lib/run.ts";

export default async function cycle(): Promise<void> {
  await withRun("nesting-cycle", async (run) => {
    await writeFile(join(run.state, "limits.json"), JSON.stringify({ active: 3, depth: 2 }));
    const aRoot = await directory(run, "A"),
      bRoot = await directory(run, "B");
    const goA = join(run.out, "go-a"),
      goB = join(run.out, "go-b");
    await plan(run, "cross-b", [{ calls: [] }]);
    await plan(run, "cycle-a", [
      { waitFor: goA, calls: [call("subagent", delegated("cross-b", bRoot, "read"))] },
    ]);
    await plan(run, "cycle-b", [
      { waitFor: goB, calls: [call("subagent", delegated("cross-a", aRoot, "inspect", false))] },
    ]);
    const a = await tree(run, delegated("cycle-a", aRoot, "write", false));
    const b = await tree(run, delegated("cycle-b", bRoot, "write", false));
    const ar = await a.record(),
      br = await b.record();
    await batchReady(ar, 0);
    await batchReady(br, 0);
    await writeFile(goA, "go");
    const crossB = await named(run, "cross-b");
    await queued(run, crossB);
    await snapshotProof(run, "cross-tree-before-closing-launch");
    await writeFile(goB, "go");
    const crossA = await named(run, "cross-a");
    await b.answer();
    await a.answer();
    await finished(run, ar);
    await finished(run, br);
    await finished(run, crossB);
    const all = await records(run),
      refused = all.find((r) => r.id === crossA.id);
    assert(refused);
    assert.equal(refused.lifecycle, "failed");
    assert.equal(refused.rex, null);
    assert.match(refused.diagnostic ?? "", /wait cycle/);
    for (const id of [ar.id, br.id, crossA.id, crossB.id])
      assert((refused.diagnostic ?? "").includes(id));
    const errors = (await toolResults(br)).filter((r) => r.toolName === "subagent" && r.isError);
    assert(errors.some((r) => /wait cycle/.test(JSON.stringify(r.content))));
    await run.record("cross-tree-cycle-proof.json", { ar, br, crossA: refused, crossB, errors });
    console.log(
      "nesting cross-tree cycle: PASS; exact A -> child B -> B -> child A -> A cycle refused before Rex launch, all four runs named",
    );

    const wrapperRoot = await directory(run, "wrapper");
    await plan(run, "wrapper-owner", [
      {
        calls: [call("harness_nested", delegated("wrapped-child", wrapperRoot, "inspect", false))],
      },
    ]);
    const wrapped = await tree(run, delegated("wrapper-owner", wrapperRoot, "write", false));
    const wrapperOwner = await wrapped.record();
    await wrapped.answer();
    await finished(run, wrapperOwner);
    const wrappedChild = await named(run, "wrapped-child");
    const wrapperFailure = (await records(run)).find((r) => r.id === wrappedChild.id);
    assert(wrapperFailure);
    assert.equal(wrapperFailure.rex, null);
    assert.match(wrapperFailure.diagnostic ?? "", /wait cycle/);
    assert((wrapperFailure.diagnostic ?? "").includes(wrapperOwner.id));
    console.log(
      "nesting wrapper cycle: PASS; foreground launch waiting for its calling non-launch tool is refused as a cycle, not exempted or deadlocked",
    );

    const root = await directory(run, "inspect");
    await plan(run, "default-inspector", [{ calls: [call("bash", { command: "pwd" })] }]);
    const defaultInput = { ...delegated("default-inspector", root, "inspect", false) };
    const { access: _access, ...withoutAccess } = defaultInput;
    await plan(run, "inspector", [
      { calls: [call("subagent", delegated("forbidden-writer", root, "write", false))] },
      { calls: [call("subagent", withoutAccess)] },
    ]);
    const inspector = await tree(run, delegated("inspector", root, "inspect", false));
    const parent = await inspector.record(),
      child = await named(run, "default-inspector");
    await inspector.answer();
    await finished(run, parent);
    await finished(run, child);
    assert.equal(child.access, "inspect");
    const childStarted = (await events(child)).find((e) => e.type === "session_start");
    assert(childStarted);
    const tools = childStarted.data.tools;
    assert(Array.isArray(tools));
    assert(tools.includes("bash"));
    for (const tool of ["edit", "write", "subagent", "subagent_control"])
      assert(!tools.includes(tool));
    const parentResults = await toolResults(parent);
    assert(
      parentResults.some(
        (r) =>
          r.toolName === "subagent" &&
          r.isError &&
          /Nested write refused/.test(JSON.stringify(r.content)),
      ),
    );
    assert(!(await records(run)).some((r) => r.label === "forbidden-writer"));
    assert.equal(await maybeFile(join(root, "unexpected")), null);
    await until("inspect fingerprint persisted", () =>
      maybeFile(join(run.state, "runs", child.id, "checkout.json")),
    );
    console.log(
      "nesting inspect: PASS; write refused before a record or Rex launch; default is inspect; shell present, mutation/nesting tools absent at depth limit",
    );
  });
}
