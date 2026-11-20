import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { current, start } from "../lib/phase-one.ts";
import { directory, finished, hold, release } from "../lib/phase-two.ts";
import { withRun } from "../lib/run.ts";

export default async function worktree(): Promise<void> {
  await withRun("worktree", async (run) => {
    const repo = await directory(run, "project", true);
    await writeFile(join(repo, "f"), "hi\n");
    execFileSync("git", ["-C", repo, "add", "f"]);
    execFileSync("git", [
      "-C",
      repo,
      "-c",
      "user.name=a",
      "-c",
      "user.email=a@b",
      "commit",
      "-qm",
      "i",
    ]);
    const task = "Call harness_hold once and wait before replying. Then reply briefly.";
    const first = await start(run, { label: "wt-clean", cwd: repo, task, worktree: true });
    const second = await start(run, { label: "wt-dirty", cwd: repo, task, worktree: true });
    const a = await hold(run, await first.record());
    const b = await hold(run, await second.record());
    assert(a.worktree && b.worktree);
    for (const held of [a, b]) {
      const now = await current(run, held.id);
      assert.equal(now.lifecycle, "running", "both worktree writers run at once");
      assert.equal(now.queue, null);
      assert(now.cwd.startsWith(join(repo + ".worktrees")), "the child works in the worktree");
    }
    assert.notEqual(a.worktree.path, b.worktree.path);
    await writeFile(join(b.worktree.path, "notes"), "unsaved\n");
    await release(a);
    await release(b);
    const answers = [await first.answer(), await second.answer()].map((x) => JSON.stringify(x));
    const doneA = await finished(run, a);
    const doneB = await finished(run, b);
    assert(doneA.worktree?.removedAt, "a worktree with nothing in it is removed");
    assert(!existsSync(a.worktree.path));
    assert.match(String(doneB.worktree?.kept), /uncommitted/);
    assert(existsSync(b.worktree.path), "a worktree with changes is kept");
    assert(answers[0]?.includes(`branch ${a.worktree.branch}, removed`));
    assert(answers[1]?.includes(`branch ${b.worktree.branch}, kept because it has uncommitted`));
    console.log(
      "worktree: PASS; two writers ran at once in their own worktrees, the clean one was removed, the changed one kept and named in the result",
    );
  });
}
