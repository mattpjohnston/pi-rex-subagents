import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { observeProcess } from "../../src/rex.ts";
import { repo, withRun } from "../lib/run.ts";
import { parentArgv } from "../lib/pi.ts";
import { current, key, maybeFile, records, send, start, until } from "../lib/phase-one.ts";
import { directory, finished, hold, queued, release, sample } from "../lib/phase-two.ts";
import type { Run } from "../lib/run.ts";
import type { RunRecord } from "../../src/records.ts";

const holdTask =
  "Call harness_hold exactly once and wait until it is released, then reply briefly. Do not use other tools.";
const readEnv = { PI_SUBAGENTS_CHILD_EXTENSIONS: "" };

async function takeReader(run: Run, label: string, cwd: string): Promise<RunRecord> {
  const launched = await start(
    run,
    { label, cwd, access: "read", task: "Reply READY. Do not call tools." },
    readEnv,
  );
  const record = await launched.record();
  const live = await until(`${label} has a block`, async () => {
    const currentRecord = await current(run, record.id);
    return currentRecord.rex ? currentRecord : null;
  });
  assert(live.rex);
  await send(run, live.rex, "/subagent-takeover");
  const taken = await until(`${label} taken over`, async () => {
    const currentRecord = await current(run, record.id);
    return currentRecord.lifecycle === "taken_over" ? currentRecord : null;
  });
  await launched.answer();
  return taken;
}

async function quit(run: Run, record: RunRecord): Promise<void> {
  if (!record.rex) return;
  await send(run, record.rex, "/quit");
  const started = Date.now();
  await until(`${record.label} exited`, async () => {
    const currentRecord = await current(run, record.id);
    if (currentRecord.process.state === "exited") return currentRecord;
    if (record.rex && (await observeProcess(record.rex)).process.state === "exited")
      return currentRecord;
    const pid = currentRecord.process.state === "live" ? currentRecord.process.pid : null;
    if (Date.now() - started > 15_000 && pid) {
      try {
        process.kill(pid, "SIGTERM");
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
      }
    }
    return null;
  });
}

export default async function readers(): Promise<void> {
  await withRun("readers", async (run) => {
    await writeFile(join(run.state, "limits.json"), JSON.stringify({ active: 8 }));
    const stop = sample(run, 8);
    try {
      const checkout = await directory(run, "shared", true);
      const first = await takeReader(run, "reader-a", checkout);
      const second = await takeReader(run, "reader-b", checkout);
      assert(first.rex && second.rex);
      assert.equal(first.checkoutRoot, second.checkoutRoot);
      const writer = await start(run, { label: "waiting-writer", cwd: checkout, task: holdTask });
      const waiting = await queued(run, await writer.record());
      assert.equal(waiting.rex, null);
      assert.equal((await current(run, first.id)).process.state, "live");
      assert.equal((await current(run, second.id)).process.state, "live");
      console.log(
        "readers item 4 overlap: PASS; two readers from two parents overlap; writer has no block",
      );
      await quit(run, first);
      await quit(run, second);
      await release(await hold(run, waiting));
      await writer.answer();
      await finished(run, waiting);

      const holder = await start(run, { label: "blocking-writer", cwd: checkout, task: holdTask });
      const held = await hold(run, await holder.record());
      const behindA = await start(
        run,
        {
          label: "behind-a",
          cwd: checkout,
          access: "read",
          task: "Reply AFTER. Do not call tools.",
        },
        readEnv,
      );
      const behindB = await start(
        run,
        {
          label: "behind-b",
          cwd: checkout,
          access: "read",
          task: "Reply AFTER. Do not call tools.",
        },
        readEnv,
      );
      const queuedA = await queued(run, await behindA.record());
      const queuedB = await queued(run, await behindB.record());
      assert.equal(queuedA.rex, null);
      assert.equal(queuedB.rex, null);
      await release(held);
      await holder.answer();
      await until("readers admitted behind writer", async () => {
        const a = await current(run, queuedA.id);
        const b = await current(run, queuedB.id);
        return a.rex && b.rex ? [a, b] : null;
      });
      await key(run, behindA.parent, "escape");
      await key(run, behindB.parent, "escape");
      console.log(
        "readers item 4 behind writer: PASS; both readers stayed queued until the writer exited, then both received blocks",
      );

      const gate = await takeReader(run, "starvation-reader", checkout);
      const older = await start(run, { label: "older-writer", cwd: checkout, task: holdTask });
      const olderQueued = await queued(run, await older.record());
      const newerA = await start(
        run,
        {
          label: "newer-a",
          cwd: checkout,
          access: "read",
          task: "Reply NEWER. Do not call tools.",
        },
        readEnv,
      );
      const newerB = await start(
        run,
        {
          label: "newer-b",
          cwd: checkout,
          access: "read",
          task: "Reply NEWER. Do not call tools.",
        },
        readEnv,
      );
      await queued(run, await newerA.record());
      await queued(run, await newerB.record());
      assert.equal((await current(run, olderQueued.id)).rex, null);
      await quit(run, gate);
      const admitted = await hold(run, olderQueued);
      assert.equal((await current(run, (await newerA.record()).id)).rex, null);
      assert.equal((await current(run, (await newerB.record()).id)).rex, null);
      await release(admitted);
      await older.answer();
      await key(run, newerA.parent, "escape");
      await key(run, newerB.parent, "escape");
      console.log(
        "readers item 6 starvation: PASS; newer readers did not pass the older queued writer",
      );

      const plan = join(run.out, "fanout-plan.json");
      const response = join(run.out, "fanout-response.json");
      await writeFile(
        plan,
        JSON.stringify([
          { label: "fan-a", cwd: checkout, access: "read", task: "Reply FAN. Do not call tools." },
          { label: "fan-b", cwd: checkout, access: "read", task: "Reply FAN. Do not call tools." },
        ]),
      );
      const argv = await parentArgv(
        run,
        "fanout",
        "Call harness_fanout exactly once. Do not call subagent yourself.",
        {
          HARNESS_PLAN: plan,
          HARNESS_RESPONSE: response,
          PI_SUBAGENTS_CHILD_EXTENSIONS: "",
          PI_SUBAGENTS_LOG_TOOLS: "1",
        },
      );
      argv.splice(argv.length - 1, 0, "-e", join(repo, "harness/fanout-tools.ts"));
      const parent = await run.newSession("fanout", argv);
      const pair = await until("one parent two readers", async () => {
        const matches = [await maybeRecord(run, "fan-a"), await maybeRecord(run, "fan-b")];
        return matches[0]?.rex && matches[1]?.rex ? matches : null;
      });
      assert(pair[0]?.rex && pair[1]?.rex);
      await send(run, pair[0].rex, "/subagent-takeover");
      await send(run, pair[1].rex, "/subagent-takeover");
      await until("fanout responses", () => maybeFile(response));
      await key(run, parent, "escape");
      console.log(
        "readers item 4 one parent: PASS; one parent had two read children with blocks at the same time",
      );
    } finally {
      await stop();
    }
  });
}

function maybeRecord(run: Run, label: string): Promise<RunRecord | null> {
  return records(run).then((all) => all.find((record) => record.label === label) ?? null);
}
