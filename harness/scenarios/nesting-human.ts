import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { current, send, start, until } from "../lib/phase-one.ts";
import { directory, finished, hold, queued, release } from "../lib/phase-two.ts";
import {
  assertNoStart,
  call,
  delegated,
  named,
  plan,
  snapshotProof,
  tree,
} from "../lib/phase-six.ts";
import { withRun } from "../lib/run.ts";

export default async function human(): Promise<void> {
  await withRun("nesting-human", async (run) => {
    await writeFile(join(run.state, "limits.json"), JSON.stringify({ active: 1, depth: 2 }));
    for (const action of ["typing", "provider"]) {
      const cwd = await directory(run, `${action}-owner`),
        leafRoot = await directory(run, `${action}-leaf`);
      await plan(run, `${action}-leaf`, [{ calls: [call("harness_hold")] }]);
      await plan(run, `${action}-owner`, [
        { calls: [call("subagent", delegated(`${action}-leaf`, leafRoot, "inspect", false))] },
      ]);
      const launching = await tree(run, delegated(`${action}-owner`, cwd, "write", false));
      const owner = await launching.record(),
        leaf = await named(run, `${action}-leaf`);
      await hold(run, leaf);
      const parked = await current(run, owner.id);
      assert(parked.rex);
      assert.equal(parked.activity?.parked, "foreground");
      if (action === "typing")
        await send(
          run,
          parked.rex,
          "Human direction: after the current review returns, give a short final report and do not launch any additional work.",
        );
      else {
        assert(process.env.HARNESS_OVERRIDE_MODEL);
        await send(run, parked.rex, `/harness-model ${process.env.HARNESS_OVERRIDE_MODEL}`);
      }
      await until(
        `${action} clears parking immediately`,
        async () => (await current(run, owner.id)).activity?.parked === null,
      );
      const snapshot = await snapshotProof(run, `${action}-counts-immediately`);
      assert.equal(snapshot.runs.filter((r) => r.state === "running").length, 2);
      if (action === "provider") {
        const model = process.env.HARNESS_OVERRIDE_MODEL;
        assert(model);
        const updated = await current(run, owner.id);
        assert.equal(`${updated.effective.provider}/${updated.effective.model}`, model);
        assert.equal(snapshot.runs.find((r) => r.id === owner.id)?.provider, model.split("/")[0]);
      }
      const outside = await start(
        run,
        delegated(`${action}-waiting`, await directory(run, `${action}-outside`), "write", true),
      );
      const waiting = await outside.record();
      await queued(run, waiting, "capacity");
      await assertNoStart(run, waiting);
      await release(leaf);
      await launching.answer();
      await finished(run, owner);
      await hold(run, waiting);
      await release(waiting);
      await finished(run, waiting);
      console.log(
        `nesting human ${action}: PASS; parked parent counts immediately while its foreground child still works; new admission waits`,
      );
    }
  });
}
