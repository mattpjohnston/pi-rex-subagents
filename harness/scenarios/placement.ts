import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { writerOnPath } from "../../src/admission.ts";
import type { RunRecord } from "../../src/records.ts";
import { current, send, start, until } from "../lib/phase-one.ts";
import { directory, finished, hold, release } from "../lib/phase-two.ts";
import { object, success, type Rex } from "../lib/rex.ts";
import { withRun } from "../lib/run.ts";

async function block(rex: Rex, sessionId: string, blockId: string) {
  const data = object(
    success(await rex.command(["block", "inspect", "-s", sessionId, blockId, "--json"])).data,
  );
  return object(data.block);
}
async function windows(rex: Rex, sessionId: string): Promise<Record<string, unknown>[]> {
  const session = object(success(await rex.inspectSession(sessionId)).data);
  return Array.isArray(session.windows) ? session.windows.map(object) : [];
}
/** Whether a finished child still holds its checkout, as the next admission pass sees it. */
const holds = async (record: RunRecord) =>
  (await writerOnPath(join(record.checkoutRoot, "probe")))?.id === record.id;

export default async function placement(): Promise<void> {
  await withRun("placement", async (run) => {
    await writeFile(join(run.state, "limits.json"), JSON.stringify({ closeCompletedAfter: 2 }));
    const task = "Call harness_hold once and wait before replying. Then reply briefly.";

    const floating = await start(run, {
      label: "float-child",
      cwd: await directory(run, "float"),
      task,
      placement: "float",
      background: true,
    });
    const parentWindow = String(
      (await block(run.rex, floating.parent.sessionId, floating.parent.blockId)).window_id,
    );
    const floated: RunRecord = await hold(run, await floating.record());
    assert(floated.rex);
    assert.equal(floated.rex.windowId, parentWindow, "a floating child opens in the parent's tab");
    const tab = (await windows(run.rex, floating.parent.sessionId)).find(
      (window) => window.window_id === parentWindow,
    );
    const layers = tab && Array.isArray(tab.layers) ? tab.layers.map(object) : [];
    const layer = layers.find((candidate) =>
      JSON.stringify(candidate.blocks).includes(String(floated.rex?.blockId)),
    );
    assert.equal(layer?.kind, "floating", "the child sits in a floating layer");
    assert.equal(
      (await windows(run.rex, floating.parent.sessionId)).length,
      1,
      "no extra tab is opened",
    );
    await release(floated);
    const floatDone = await finished(run, floated);
    assert(!(await holds(floatDone)), "exit releases the reservation");
    await until(
      "the finished floating child closes after the grace period",
      async () => (await current(run, floated.id)).tabClosedAt !== undefined,
      60_000,
    );
    console.log(
      "placement float: PASS; child floats over the parent's tab, no new tab, exit releases, closes after the grace period",
    );

    const away = await start(run, {
      label: "detached-child",
      cwd: await directory(run, "detached"),
      task,
      placement: "detached",
      background: true,
    });
    const detached = await hold(run, await away.record());
    assert(detached.location);
    assert.equal(detached.location.windowId, null, "a detached child is in no window");
    assert.equal(
      (await block(run.rex, away.parent.sessionId, detached.location.blockId)).placement,
      "detached",
    );
    assert.equal((await windows(run.rex, away.parent.sessionId)).length, 1, "its tab closed");
    await away.answer();
    await send(run, away.parent, "/subagents go detached-child");
    const parentPane = String(
      (await block(run.rex, away.parent.sessionId, away.parent.blockId)).window_id,
    );
    await until("go brings the detached child back beside the parent", async () => {
      const placed = await block(run.rex, away.parent.sessionId, detached.location?.blockId ?? "");
      return placed.window_id === parentPane;
    });
    await release(detached);
    const detachedDone = await finished(run, detached);
    assert.equal(detachedDone.process.state, "exited");
    assert(!(await holds(detachedDone)), "exit releases the reservation");
    console.log(
      "placement detached: PASS; child runs in no window, its tab closes, /subagents go brings it back beside the parent, exit releases",
    );
  });
}
