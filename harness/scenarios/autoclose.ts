import assert from "node:assert/strict";
import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { RunRecord } from "../../src/records.ts";
import { observeProcess } from "../../src/rex.ts";
import { VIEW_SETTLE_MS } from "../../src/terminals.ts";
import { current, start, until } from "../lib/phase-one.ts";
import { directory, finished, hold, release } from "../lib/phase-two.ts";
import { object, success } from "../lib/rex.ts";
import { withRun } from "../lib/run.ts";

const GRACE_S = 4;

async function tabOpen(record: RunRecord): Promise<boolean> {
  assert(record.rex);
  return (await observeProcess(record.location ?? record.rex)).location !== null;
}

export default async function autoclose(): Promise<void> {
  await withRun("autoclose", async (run) => {
    await writeFile(
      join(run.state, "limits.json"),
      JSON.stringify({ closeCompletedAfter: GRACE_S }),
    );

    const quick = await start(run, {
      label: "auto-unviewed",
      cwd: await directory(run, "unviewed"),
      task: "Reply briefly. No tools.",
    });
    const unviewed = await finished(run, await quick.record());
    assert.equal(unviewed.lifecycle, "completed");
    const finishedAt = Date.now();
    assert(await tabOpen(unviewed), "tab stays during the grace period");
    await until(
      "unviewed tab closes after the grace period",
      async () => !(await tabOpen(unviewed)),
      30_000,
    );
    assert(Date.now() - finishedAt >= (GRACE_S - 2) * 1000, "not closed before the grace period");
    await access(unviewed.paths.result);
    assert((await current(run, unviewed.id)).sessionFile, "transcript kept after the tab closed");
    console.log(
      "autoclose unviewed: PASS; completed tab closed after the grace period, records kept",
    );

    const viewedLaunch = await start(run, {
      label: "auto-viewed",
      cwd: await directory(run, "viewed"),
      task: "Call harness_hold once and wait before replying.",
    });
    const held = await hold(run, await viewedLaunch.record());
    assert(held.rex);
    const parentView = object(
      success(await run.rex.inspectSession(viewedLaunch.parent.sessionId)).data,
    );
    const parentWindow = parentView.active_window_id;
    assert(typeof parentWindow === "string");
    // Set the session's active tab on the server: it is what the extension reads, and unlike
    // session.select it neither depends on the app nor moves the user's view.
    const select = async (windowId: string) => {
      success(
        await run.rex.command(
          ["window", "focus", "-s", viewedLaunch.parent.sessionId, windowId],
          false,
        ),
      );
    };
    await select(held.rex.windowId);
    const activeNow = async () =>
      object(success(await run.rex.inspectSession(viewedLaunch.parent.sessionId)).data)
        .active_window_id;
    assert.equal(await activeNow(), held.rex.windowId, "selected the child tab");
    await release(held);
    const viewed = await finished(run, held);
    await run.record("viewed-active.json", {
      active: await activeNow(),
      child: held.rex.windowId,
      parentWindow,
    });
    assert.equal(viewed.lifecycle, "completed");
    await delay((GRACE_S * 1000 + VIEW_SETTLE_MS) * 2);
    assert(await tabOpen(viewed), "a tab you are viewing does not close");
    await select(parentWindow);
    assert.equal(await activeNow(), parentWindow, "switched back to the parent tab");
    const leftAt = Date.now();
    await until(
      "viewed tab closes after you leave it",
      async () => !(await tabOpen(viewed)),
      30_000,
    );
    assert(Date.now() - leftAt >= VIEW_SETTLE_MS - 1000, "not closed the moment you leave");
    console.log(
      "autoclose viewed: PASS; stayed open while viewed past the grace period, closed after leaving",
    );
  });
}
