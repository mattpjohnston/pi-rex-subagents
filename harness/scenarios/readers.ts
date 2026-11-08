import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { observeProcess } from "../../src/rex.ts";
import { repo, withRun } from "../lib/run.ts";
import { parentArgv } from "../lib/pi.ts";
import { current, key, records, start, until } from "../lib/phase-one.ts";
import { directory, finished, hold, queued, release, sample } from "../lib/phase-two.ts";
import { success } from "../lib/rex.ts";
import { sessionOnlyTrustIndex } from "../lib/trust.ts";
import type { Run } from "../lib/run.ts";
import type { RunRecord } from "../../src/records.ts";

const holdTask =
  "Call harness_hold exactly once and wait until it is released, then reply briefly. Do not use other tools.";
const readEnv = { PI_SUBAGENTS_CHILD_EXTENSIONS: "" };

async function trustHold(run: Run, label: string, cwd: string): Promise<RunRecord> {
  const launched = await start(
    run,
    { label, cwd, access: "read", task: "Reply READY. Do not call tools." },
    readEnv,
  );
  const record = await launched.record();
  return until(`${label} waiting on project trust`, async () => {
    const currentRecord = await current(run, record.id);
    return currentRecord.waiting?.kind === "project_trust" && currentRecord.rex
      ? currentRecord
      : null;
  });
}

async function answerTrust(run: Run, record: RunRecord): Promise<void> {
  const live = await current(run, record.id);
  assert(live.rex);
  const capture = success(await run.rex.capture(live.rex.sessionId, live.rex.blockId)).stdout;
  const index = sessionOnlyTrustIndex(capture);
  for (let step = 0; step < index; step++) await key(run, live.rex, "down");
  const selected = success(await run.rex.capture(live.rex.sessionId, live.rex.blockId)).stdout;
  assert.match(selected, /Trust \(this session only\)/);
  await key(run, live.rex, "enter");
}

async function stopProcess(run: Run, record: RunRecord): Promise<void> {
  const live = await current(run, record.id);
  if (live.process.state === "exited") return;
  if (live.rex) {
    const observed = await observeProcess(live.rex);
    if (observed.process.state === "live" && observed.process.pid) {
      try {
        process.kill(observed.process.pid, "SIGTERM");
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
      }
    }
  }
  await until(`${record.label} exited`, async () => {
    const currentRecord = await current(run, record.id);
    return currentRecord.process.state === "exited" ? currentRecord : null;
  });
}

export default async function readers(): Promise<void> {
  await withRun("readers", async (run) => {
    await writeFile(join(run.state, "limits.json"), JSON.stringify({ active: 8 }));
    const stop = sample(run, 8);
    try {
      const checkout = await directory(run, "shared", true);
      await mkdir(join(checkout, ".pi"), { mode: 0o700 });
      await writeFile(join(checkout, ".pi", "settings.json"), "{}", { mode: 0o600 });
      const first = await trustHold(run, "reader-a", checkout);
      const second = await trustHold(run, "reader-b", checkout);
      assert(first.rex && second.rex);
      assert.equal(first.checkoutRoot, second.checkoutRoot);
      const writer = await start(run, { label: "waiting-writer", cwd: checkout, task: holdTask });
      const waiting = await queued(run, await writer.record());
      assert.equal(waiting.rex, null);
      console.log(
        "readers item 4 overlap: PASS; two trust-held readers from two parents overlap; writer has no block",
      );
      await stopProcess(run, first);
      await stopProcess(run, second);
      await answerTrust(
        run,
        await until("writer trust", async () => {
          const currentRecord = await current(run, waiting.id);
          return currentRecord.waiting?.kind === "project_trust" ? currentRecord : null;
        }),
      );
      await release(await hold(run, waiting));
      await writer.answer();
      await finished(run, waiting);

      const holder = await start(run, { label: "blocking-writer", cwd: checkout, task: holdTask });
      const holderRecord = await holder.record();
      await answerTrust(
        run,
        await until("blocking writer trust", async () => {
          const currentRecord = await current(run, holderRecord.id);
          return currentRecord.waiting?.kind === "project_trust" ? currentRecord : null;
        }),
      );
      const held = await hold(run, holderRecord);
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

      const gate = await trustHold(run, "starvation-reader", checkout);
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
      await stopProcess(run, gate);
      await answerTrust(
        run,
        await until("older writer trust", async () => {
          const currentRecord = await current(run, olderQueued.id);
          return currentRecord.waiting?.kind === "project_trust" ? currentRecord : null;
        }),
      );
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
