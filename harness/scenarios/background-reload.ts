import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { NOTE_TYPE } from "../../src/delivery.ts";
import { maybeFile, records, send, until } from "../lib/phase-one.ts";
import { directory, release } from "../lib/phase-two.ts";
import {
  entries,
  parentLaunch,
  resultsEntries,
  sessionPath,
  turnEnded,
} from "../lib/phase-four.ts";
import { parentArgv } from "../lib/pi.ts";
import { repo, withRun } from "../lib/run.ts";

const hold =
  "Call harness_hold exactly once and wait until it is released, then reply briefly. Do not use other tools.";

export default async function backgroundReload(): Promise<void> {
  await withRun("background-reload", async (run) => {
    const cwd = await directory(run, "reload");
    const plans = [0, 1].map((index) => ({
      label: `reload-${index}`,
      cwd,
      access: "inspect" as const,
      background: true,
      task: hold,
    }));
    const plansPath = join(run.out, "reload-plans.json");
    await writeFile(plansPath, JSON.stringify(plans), { mode: 0o600 });
    const parent = await run.newSession(
      "reload",
      await parentLaunch(
        run,
        "reload",
        "Call harness_background exactly once now. Do not call other tools. After it returns, reply OK. Whenever background subagent results arrive later, reply RECEIVED and use no tools.",
        [],
        { HARNESS_PLANS: plansPath, HARNESS_RESPONSE: join(run.out, "reload-response.json") },
      ),
    );
    const children = await until("reload children running", async () => {
      const all = (await records(run)).filter((record) => record.label.startsWith("reload-"));
      return all.length === 2 && all.every((record) => record.rex && record.loadedAt) ? all : null;
    });
    const before = await Promise.all(
      children.map(async (record) => ({
        id: record.id,
        block: record.rex?.blockId,
        loads: (await maybeFile(record.paths.events))?.split("child_loaded").length,
      })),
    );
    await turnEnded(run, "reload");
    await send(run, parent, "/reload");
    await until("reload reattached", async () => {
      const log = await maybeFile(join(run.out, "reload-tools.jsonl.lifecycle"));
      return log?.includes('"reason":"reload"') ? true : null;
    });
    const after = await records(run);
    for (const child of before) {
      const current = after.find((record) => record.id === child.id);
      assert.equal(current?.rex?.blockId, child.block);
      assert.equal(
        (await maybeFile(current?.paths.events ?? ""))?.split("child_loaded").length,
        child.loads,
      );
      assert.equal(current?.process.state, "live");
    }
    await Promise.all(children.map(release));
    await until(
      "results after reload",
      async () => {
        const rows = resultsEntries(await entries(await sessionPath(run, "reload")));
        return rows.length === 1 ? true : null;
      },
      180_000,
    );

    const quick = await directory(run, "timer");
    const timerPlans = [0, 1].map((index) => ({
      label: `timer-${index}`,
      cwd: quick,
      access: "read" as const,
      background: true,
      task: "Reply TIMER. Do not use tools.",
    }));
    const timerPath = join(run.out, "timer-plans.json");
    await writeFile(timerPath, JSON.stringify(timerPlans), { mode: 0o600 });
    const timerParent = await run.newSession(
      "timer",
      await parentLaunch(
        run,
        "timer",
        "Call harness_background exactly once now. Do not call other tools. After it returns, reply OK. Whenever background subagent results arrive later, reply RECEIVED and use no tools.",
        [],
        {
          HARNESS_PLANS: timerPath,
          HARNESS_RESPONSE: join(run.out, "timer-response.json"),
          PI_SUBAGENTS_COALESCE_MS: "8000",
        },
      ),
    );
    await until("timer children exited", async () => {
      const all = (await records(run)).filter((record) => record.label.startsWith("timer-"));
      return all.length === 2 && all.every((record) => record.process.state === "exited")
        ? true
        : null;
    });
    await turnEnded(run, "timer");
    await send(run, timerParent, "/reload");
    await until(
      "one delivery after timer reload",
      async () => {
        const rows = resultsEntries(await entries(await sessionPath(run, "timer")));
        return rows.length === 1 ? true : null;
      },
      180_000,
    );

    const killPlans = [
      {
        label: "kill-child",
        cwd: await directory(run, "kill"),
        access: "read" as const,
        background: true,
        task: "Reply KILL. Do not use tools.",
      },
    ];
    const killPath = join(run.out, "kill-plans.json");
    await writeFile(killPath, JSON.stringify(killPlans), { mode: 0o600 });
    const marker = join(run.out, "kill-marker");
    await run.newSession(
      "kill",
      await parentLaunch(
        run,
        "kill",
        "Call harness_background exactly once now. Do not call other tools. After it returns, reply OK. Whenever background subagent results arrive later, reply RECEIVED and use no tools.",
        ["-e", join(repo, "harness", "kill-after-delivery.ts")],
        {
          HARNESS_PLANS: killPath,
          HARNESS_RESPONSE: join(run.out, "kill-response.json"),
          HARNESS_KILL_MARKER: marker,
          PI_SUBAGENTS_COALESCE_MS: "0",
        },
      ),
    );
    await until("killed between delivery and provider request", () => maybeFile(marker), 180_000);
    const saved = await sessionPath(run, "kill");
    // A restart loads only the extension under test; the batch tool needs a plan this launch does not have.
    const restart = await parentArgv(run, "kill-restart", "Continue.", {
      PI_SUBAGENTS_COALESCE_MS: "0",
    });
    restart.pop();
    restart.push("--session", saved);
    await run.newSession("kill-restart", restart);
    await until(
      "restart starts one turn without resending",
      async () => {
        const rows = await entries(saved);
        const deliveries = resultsEntries(rows);
        const note = rows.filter(
          (row) => row.type === "custom_message" && row.customType === NOTE_TYPE,
        );
        if (deliveries.length !== 1 || note.length < 1) return null;
        const noteIndex = rows.findIndex((row) => row.id === note[0]?.id);
        return rows.slice(noteIndex + 1).some((row) => row.type === "message") ? rows : null;
      },
      180_000,
    );
    console.log(
      "background-reload: PASS; reload kept children, timer reload delivered once, kill reconciled one turn",
    );
  });
}
