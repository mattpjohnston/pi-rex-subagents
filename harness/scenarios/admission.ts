import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { withRun } from "../lib/run.ts";
import { current, send, start, until } from "../lib/phase-one.ts";
import { directory, finished, hold, queued, release, sample } from "../lib/phase-two.ts";

const task =
  "Call harness_hold exactly once. Wait until released, then reply briefly. Do not use other tools.";
export default async function admission(): Promise<void> {
  await withRun("admission", async (run) => {
    await writeFile(join(run.state, "limits.json"), JSON.stringify({ active: 2 }));
    const stop = sample(run, 2);
    try {
      const outer = await directory(run, "outer", true);
      const sub = await directory(run, "outer/sub");
      const nested = await directory(run, "outer/nested", true);
      const alias = join(run.scratch, "alias");
      await symlink(sub, alias);
      const first = await start(run, { label: "outer-writer", cwd: outer, task });
      const a = await hold(run, await first.record());
      const second = await start(run, { label: "nested-writer", cwd: nested, task });
      const b = await queued(run, await second.record());
      const third = await start(run, { label: "alias-writer", cwd: alias, task });
      const c = await queued(run, await third.record());
      assert.equal(a.checkoutRoot, c.checkoutRoot);
      assert(b.checkoutRoot.startsWith(`${a.checkoutRoot}/`));
      assert.equal(b.rex, null);
      assert.equal(c.rex, null);
      await release(a);
      await first.answer();
      await finished(run, a);
      const bLive = await hold(run, b);
      assert.equal(
        (await current(run, c.id)).rex,
        null,
        "Newer writer must stay behind older conflicting ticket",
      );
      await release(bLive);
      await second.answer();
      await finished(run, b);
      await release(await hold(run, c));
      await third.answer();
      await finished(run, c);
      console.log(
        "admission item 4 writers: PASS; subdirectory + symlink alias + nested repository serialize across three parents; FIFO confirmed",
      );

      const nonGit = await directory(run, "plain");
      const git = await directory(run, "plain/git", true);
      const plain = await start(run, { label: "plain-writer", cwd: nonGit, task });
      const p = await hold(run, await plain.record());
      const inside = await start(run, { label: "git-in-plain", cwd: git, task });
      const g = await queued(run, await inside.record());
      assert.equal(g.rex, null);
      await release(p);
      await plain.answer();
      await release(await hold(run, g));
      await inside.answer();
      console.log(
        "admission item 4 non-Git containment: PASS; Git checkout nested in a non-Git directory conflicts",
      );

      execFileSync("git", [
        "-C",
        outer,
        "commit",
        "--allow-empty",
        "-qm",
        "Initialize harness worktree",
      ]);
      const worktree = join(run.scratch, "worktree");
      execFileSync("git", ["-C", outer, "worktree", "add", "-qb", "harness-worktree", worktree]);
      const dialog = await start(run, {
        label: "dialog-writer",
        cwd: outer,
        task: "Call ask_human exactly once, wait for the answer, then reply briefly. Do not call other tools.",
      });
      const d = await dialog.record();
      const waiting = await until("dialog holds a writer reservation", async () => {
        const r = await current(run, d.id);
        return r.waiting?.source === "reporter" && r;
      });
      assert(waiting.rex);
      const blocked = await start(run, { label: "checkout-waiter", cwd: outer, task });
      const blockedRecord = await queued(run, await blocked.record());
      const independent = await start(run, { label: "worktree-writer", cwd: worktree, task });
      const independentRecord = await hold(run, await independent.record());
      assert.notEqual(independentRecord.checkoutRoot, d.checkoutRoot);
      assert.equal((await current(run, blockedRecord.id)).rex, null);
      await send(run, waiting.rex, "DIALOG_RELEASED");
      await dialog.answer();
      await release(await hold(run, blockedRecord));
      await blocked.answer();
      await release(independentRecord);
      await independent.answer();
      console.log(
        "admission item 5 worktrees: PASS; independent linked-worktree writer overlaps a dialog writer while a conflicting ticket waits without holding capacity. Shared Git metadata and external services remain the parent's responsibility.",
      );

      const launched = [];
      for (let i = 0; i < 4; i++)
        launched.push(
          await start(run, {
            label: `ceiling-${i}`,
            cwd: await directory(run, `ceiling-${i}`),
            task,
          }),
        );
      const records = await Promise.all(launched.map((parent) => parent.record()));
      await until("four-parent ceiling reached", async () => {
        const live = await Promise.all(records.map((r) => current(run, r.id)));
        return (
          live.filter((r) => r.rex).length === 2 &&
          live.filter((r) => r.queue?.reason === "capacity").length === 2
        );
      });
      await delay(5000);
      const ordered = await Promise.all(records.map((r) => current(run, r.id)));
      const live = ordered.filter((r) => r.rex),
        pending = ordered.filter((r) => !r.rex);
      assert.equal(live.length, 2);
      const [firstLive, secondLive] = live;
      assert(firstLive && secondLive);
      // Tightening a limit does not kill existing work; it gates the next admission.
      await writeFile(
        join(run.state, "limits.json"),
        JSON.stringify({ active: 2, providers: { [firstLive.effective.provider]: 1 } }),
      );
      await release(await hold(run, firstLive));
      await finished(run, firstLive);
      assert.equal((await current(run, pending[0]?.id ?? "")).rex, null);
      await release(await hold(run, secondLive));
      await finished(run, secondLive);
      const next = await until("provider-limited next admission", async () => {
        const now = await Promise.all(pending.map((r) => current(run, r.id)));
        const admitted = now.filter((r) => r.rex);
        return admitted.length === 1 && admitted[0];
      });
      const last = pending.find((r) => r.id !== next.id);
      assert(last);
      await queued(run, last, "capacity");
      await release(await hold(run, next));
      await finished(run, next);
      await release(await hold(run, last));
      await finished(run, last);
      await Promise.all(launched.map((p) => p.answer()));
      console.log(
        "admission item 5 ceilings: PASS; four parents share active=2, then edited provider ceiling=1 gates the next launch without reload",
      );

      await writeFile(join(run.state, "limits.json"), "{");
      const malformed = await start(run, { label: "malformed-limits", cwd: outer, task });
      const response = await malformed.answer();
      assert.equal(response.isError, true);
      assert.match(JSON.stringify(response), /Invalid admission limits.*limits\.json/);
      const invalid = await current(run, (await malformed.record()).id);
      assert.equal(invalid.rex, null);
      assert.match(await readFile(invalid.paths.claim, "utf8"), /cancelled/);
      await run.record("malformed-evidence.json", { response, invalid });
      console.log(
        "admission malformed limits: PASS; launch blocked with file-naming error, no child created",
      );
      console.log(
        "Reader overlap, FIFO behind writers, and starvation are covered separately by the readers scenario.",
      );
    } finally {
      await stop();
    }
  });
}
