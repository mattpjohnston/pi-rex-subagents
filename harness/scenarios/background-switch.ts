import assert from "node:assert/strict";
import { realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { readClaim } from "../../src/claims.ts";
import { captureContains, current, key, records, send, until } from "../lib/phase-one.ts";
import { directory } from "../lib/phase-two.ts";
import {
  entries,
  parentLaunch,
  resultsEntries,
  sessionPath,
  turnEnded,
} from "../lib/phase-four.ts";
import { withRun, type Run } from "../lib/run.ts";

const hold =
  "Call harness_hold exactly once and wait until it is released, then reply briefly. Do not use other tools.";

async function holding(run: Run, label: string) {
  const cwd = await directory(run, label);
  const plansPath = join(run.out, `${label}-plans.json`);
  await writeFile(
    plansPath,
    JSON.stringify([
      { label: `${label}-child`, cwd, access: "write", background: true, task: hold },
    ]),
    { mode: 0o600 },
  );
  const parent = await run.newSession(
    label,
    await parentLaunch(
      run,
      label,
      "Call harness_background exactly once now. Do not call other tools. After it returns, reply OK. Whenever background subagent results arrive later, reply RECEIVED and use no tools.",
      [],
      { HARNESS_PLANS: plansPath, HARNESS_RESPONSE: join(run.out, `${label}-response.json`) },
    ),
  );
  const child = await until(`${label} child live`, async () => {
    const record = (await records(run)).find((item) => item.label === `${label}-child` && item.rex);
    return record ?? null;
  });
  await turnEnded(run, label);
  return { parent, child };
}
async function refuse(run: Run, parent: { sessionId: string; blockId: string }, command: string) {
  await send(run, parent, command);
  await until(
    `${command} confirmation`,
    () => captureContains(run, parent, "Cancel background subagents"),
    20_000,
  );
  await key(run, parent, "down");
  await key(run, parent, "enter");
  await until(
    `${command} refused`,
    async () => {
      const shown = await captureContains(run, parent, "Cancel background subagents");
      return shown ? null : true;
    },
    20_000,
  );
}

export default async function backgroundSwitch(): Promise<void> {
  await withRun("background-switch", async (run) => {
    const fresh = await holding(run, "new");
    const session = await sessionPath(run, "new");
    await refuse(run, fresh.parent, "/new");
    assert.equal((await current(run, fresh.child.id)).process.state, "live");
    await send(run, fresh.parent, "/new");
    await until(
      "confirm new",
      () => captureContains(run, fresh.parent, "Cancel background subagents"),
      20_000,
    );
    await key(run, fresh.parent, "enter");
    await until(
      "new cancelled the child",
      async () => {
        const record = await current(run, fresh.child.id);
        return record.lifecycle === "cancelled" ? record : null;
      },
      45_000,
    );
    assert.equal(await readClaim(fresh.child.paths.claim), "cancelled");
    // The record is written cancelled just before the outcome is appended, so wait for the append.
    const appended = await until(
      "outcome appended to the old session",
      async () => {
        const rows = await entries(session);
        const at = rows.findIndex((row) => resultsEntries([row]).length === 1);
        return at >= 0 ? rows.slice(at + 1) : null;
      },
      20_000,
    );
    assert(
      !appended.some((row) => row.type === "message"),
      "The append to the old session must not start a turn",
    );

    const quitting = await holding(run, "quit");
    const quitSession = await sessionPath(run, "quit");
    await send(run, quitting.parent, "/quit");
    await until(
      "quit cancelled the child",
      async () => {
        const record = await current(run, quitting.child.id);
        return record.lifecycle === "cancelled" ? record : null;
      },
      45_000,
    );
    await until(
      "outcome appended on quit",
      async () => (resultsEntries(await entries(quitSession)).length >= 1 ? true : null),
      20_000,
    );

    const cloning = await holding(run, "clone");
    await refuse(run, cloning.parent, "/clone");
    assert.equal((await current(run, cloning.child.id)).process.state, "live");
    await send(run, cloning.parent, "/clone");
    await until(
      "confirm clone",
      () => captureContains(run, cloning.parent, "Cancel background subagents"),
      20_000,
    );
    await key(run, cloning.parent, "enter");
    await until(
      "clone cancelled the child",
      async () => {
        const record = await current(run, cloning.child.id);
        return record.lifecycle === "cancelled" ? record : null;
      },
      45_000,
    );

    const forking = await holding(run, "fork");
    await send(run, forking.parent, "/fork");
    await until(
      "fork selector",
      () => captureContains(run, forking.parent, "Fork from Message"),
      20_000,
    );
    await key(run, forking.parent, "enter");
    await until(
      "confirm fork",
      () => captureContains(run, forking.parent, "Cancel background subagents"),
      20_000,
    );
    await key(run, forking.parent, "escape");
    assert.equal((await current(run, forking.child.id)).process.state, "live");
    await send(run, forking.parent, "/fork");
    await until(
      "fork selector again",
      () => captureContains(run, forking.parent, "Fork from Message"),
      20_000,
    );
    await key(run, forking.parent, "enter");
    await until(
      "confirm fork again",
      () => captureContains(run, forking.parent, "Cancel background subagents"),
      20_000,
    );
    await key(run, forking.parent, "enter");
    await until(
      "fork cancelled the child",
      async () => {
        const record = await current(run, forking.child.id);
        return record.lifecycle === "cancelled" ? record : null;
      },
      45_000,
    );

    const resuming = await holding(run, "resume");
    // The parent records its realpath cwd, and /resume lists only sessions from that folder.
    const other = SessionManager.create(await realpath(run.scratch), join(run.sessions, "resume"));
    other.appendMessage({ role: "user", content: "other session", timestamp: Date.now() });
    await send(run, resuming.parent, "/resume");
    await until(
      "resume selector",
      () => captureContains(run, resuming.parent, "other session"),
      20_000,
    );
    await key(run, resuming.parent, "enter");
    await until(
      "confirm resume",
      () => captureContains(run, resuming.parent, "Cancel background subagents"),
      20_000,
    );
    await key(run, resuming.parent, "escape");
    assert.equal((await current(run, resuming.child.id)).process.state, "live");
    await send(run, resuming.parent, "/resume");
    await until(
      "resume selector again",
      () => captureContains(run, resuming.parent, "other session"),
      20_000,
    );
    await key(run, resuming.parent, "enter");
    await until(
      "confirm resume again",
      () => captureContains(run, resuming.parent, "Cancel background subagents"),
      20_000,
    );
    await key(run, resuming.parent, "enter");
    await until(
      "resume cancelled the child",
      async () => {
        const record = await current(run, resuming.child.id);
        return record.lifecycle === "cancelled" ? record : null;
      },
      45_000,
    );

    const treePlans = join(run.out, "tree-plans.json");
    await writeFile(
      treePlans,
      JSON.stringify([
        {
          label: "tree-child",
          cwd: await directory(run, "tree"),
          access: "read",
          background: true,
          task: "Reply TREE. Do not use tools.",
        },
      ]),
      { mode: 0o600 },
    );
    const treeParent = await run.newSession(
      "tree",
      await parentLaunch(
        run,
        "tree",
        "Call harness_background exactly once now. Do not call other tools. After it returns, reply OK. Whenever background subagent results arrive later, reply RECEIVED and use no tools.",
        [],
        {
          HARNESS_PLANS: treePlans,
          HARNESS_RESPONSE: join(run.out, "tree-response.json"),
          PI_SUBAGENTS_COALESCE_MS: "0",
        },
      ),
    );
    const treeSession = await sessionPath(run, "tree");
    await until(
      "tree delivery",
      async () => {
        const rows = resultsEntries(await entries(treeSession));
        return rows.length === 1 ? rows[0] : null;
      },
      180_000,
    );
    await turnEnded(run, "tree");
    await send(run, treeParent, "/tree");
    await until("tree selector", () => captureContains(run, treeParent, "Session Tree"), 20_000);
    // Two steps up from the leaf is the reply before the delivery, a branch without it.
    await key(run, treeParent, "up");
    await key(run, treeParent, "up");
    await key(run, treeParent, "enter");
    if (await captureContains(run, treeParent, "Summarize")) await key(run, treeParent, "enter");
    await until(
      "delivered again on the new branch",
      async () => {
        const rows = resultsEntries(await entries(treeSession));
        return rows.length >= 2 ? rows : null;
      },
      180_000,
    );
    console.log(
      "background-switch: PASS; new, quit, clone, fork, resume and tree followed the transition table",
    );
  });
}
