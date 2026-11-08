import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { readReservations } from "../../src/admission.ts";
import { withAdmissionLock } from "../../src/claims.ts";
import { observeProcess } from "../../src/rex.ts";
import { executable } from "../../src/settings.ts";
import { current, events, key, maybeFile, send, start, until } from "../lib/phase-one.ts";
import { directory, hold, queued, release, sample } from "../lib/phase-two.ts";
import { object, success } from "../lib/rex.ts";
import { withRun } from "../lib/run.ts";

const task =
  "Call harness_hold exactly once and wait until released, then reply briefly. Do not use other tools.";

export default async function recovery(): Promise<void> {
  await withRun("recovery", async (run) => {
    const stop = sample(run, 4);
    try {
      const realRex = await executable(process.env.PI_SUBAGENTS_REX ?? "rex");
      const mode = join(run.out, "rex-mode");
      const wrapper = join(run.scratch, "rex-wrapper.cjs");
      const calls = join(run.out, "wrapper-calls.ndjson");
      const launchedReply = join(run.out, "timeout-launch.json");
      await writeFile(mode, "pass");
      await writeFile(
        wrapper,
        `#!/usr/bin/env node
const fs = require("node:fs");
const cp = require("node:child_process");
const args = process.argv.slice(2);
const mode = fs.readFileSync(${JSON.stringify(mode)}, "utf8");
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ mode, args }) + "\\n");
if (mode === "unreachable") process.exit(4);
const result = cp.spawnSync(${JSON.stringify(realRex)}, args, { encoding: "utf8" });
if (mode === "timeout" && args[0] === "window" && args[1] === "new") {
  fs.writeFileSync(${JSON.stringify(launchedReply)}, result.stdout);
  setTimeout(() => {
    process.stdout.write(result.stdout);
    process.exit(result.status ?? 1);
  }, 30000);
} else {
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  process.exit(result.status ?? 1);
}
`,
        { mode: 0o700 },
      );
      const unrelated = await run.newSession("unrelated", ["sleep", "600"]);
      const sentinel = join(run.scratch, "unrelated-file");
      await writeFile(sentinel, "preserve");

      const cwd = await directory(run, "unreachable");
      const first = await start(
        run,
        { label: "unreachable-live", cwd, task },
        { PI_SUBAGENTS_REX: wrapper },
      );
      const active = await hold(run, await first.record());
      assert(active.rex);
      await writeFile(mode, "unreachable");
      // Confirm Rex is unknown before aborting, or cancellation would signal a still-live pid.
      await until(
        "parent observes Rex unreachable",
        async () => (await current(run, active.id)).process.state === "unknown",
      );
      await key(run, first.parent, "escape");
      await first.answer();
      const unknown = await current(run, active.id);
      assert.equal(unknown.lifecycle, "cancelled");
      assert.equal(unknown.process.state, "unknown");
      assert.equal((await observeProcess(active.rex)).process.state, "live");
      assert(
        (await withAdmissionLock(readReservations)).some((r) =>
          r.members.some((m) => m.runId === active.id),
        ),
      );
      const conflict = await start(run, { label: "after-unreachable", cwd, task });
      const blocked = await queued(run, await conflict.record());
      assert.equal(blocked.rex, null);
      assert.equal(blocked.waiting, null);
      await writeFile(mode, "pass");
      await release(active);
      const resumed = await hold(run, blocked);
      await release(resumed);
      await conflict.answer();
      assert(
        !(await withAdmissionLock(readReservations)).some((r) =>
          r.members.some((m) => m.runId === active.id),
        ),
      );
      console.log(
        "recovery Rex unreachable: PASS; wrapper exit 4 leaves process unknown and reservation intact; conflicting writer waits; confirmed exit then permits admission",
      );

      await writeFile(mode, "timeout");
      const timeoutCwd = await directory(run, "timeout");
      const timeout = await start(
        run,
        { label: "launch-timeout", cwd: timeoutCwd, task },
        { PI_SUBAGENTS_REX: wrapper },
      );
      const timed = await timeout.record();
      await timeout.answer();
      const uncertain = await current(run, timed.id);
      assert.equal(uncertain.lifecycle, "failed");
      assert.equal(uncertain.process.state, "unknown");
      assert.equal(uncertain.rex, null);
      assert.match(uncertain.diagnostic ?? "", /Uncertain Rex launch[\s\S]*Not retried/);
      const actual = object(JSON.parse(await readFile(launchedReply, "utf8")));
      assert(Array.isArray(actual.block_ids));
      assert.equal(typeof actual.block_ids[0], "string");
      const location = {
        sessionId: timeout.parent.sessionId,
        windowId: String(actual.window_id),
        blockId: String(actual.block_ids[0]),
      };
      assert.equal((await observeProcess(location)).process.state, "live");
      const waiting = await start(run, { label: "after-timeout", cwd: timeoutCwd, task });
      const waitingRecord = await queued(run, await waiting.record());
      assert.equal(waitingRecord.rex, null);
      const logged = (await readFile(calls, "utf8"))
        .trim()
        .split("\n")
        .map((line) => object(JSON.parse(line)));
      const timedLaunches = logged.filter(
        (call) =>
          call.mode === "timeout" &&
          Array.isArray(call.args) &&
          call.args[0] === "window" &&
          call.args[1] === "new",
      );
      assert.equal(timedLaunches.length, 1);
      assert(
        (await withAdmissionLock(readReservations)).some((r) =>
          r.members.some((m) => m.runId === uncertain.id),
        ),
      );
      await key(run, waiting.parent, "escape");
      await waiting.answer();
      await writeFile(mode, "pass");
      await run.record("timeout-evidence.json", {
        uncertain,
        location,
        timedLaunches: timedLaunches.length,
      });
      console.log(
        "recovery launch timeout: PASS; wrapper launches one real child and withholds the reply; failed/unknown outcome, reservation retained, conflicting writer blocked. The unknown block stays reserved until manual recovery, as documented.",
      );

      const crashCwd = await directory(run, "crash");
      const crashed = await start(run, { label: "crash-parent", cwd: crashCwd, task });
      const orphan = await hold(run, await crashed.record());
      assert(orphan.rex);
      const parentProcess = object(
        success(
          await run.rex.command([
            "block",
            "call",
            "-s",
            crashed.parent.sessionId,
            "-b",
            crashed.parent.blockId,
            "process",
          ]),
        ).data,
      );
      const pid = object(parentProcess.child).pid;
      assert.equal(typeof pid, "number");
      process.kill(Number(pid), "SIGKILL");
      const next = await start(run, { label: "after-crash", cwd: crashCwd, task });
      const nextRecord = await queued(run, await next.record());
      assert.equal(nextRecord.rex, null);
      assert.equal((await observeProcess(orphan.rex)).process.state, "live");
      assert(
        (await withAdmissionLock(readReservations)).some((r) =>
          r.members.some((m) => m.runId === orphan.id),
        ),
      );
      await release(orphan);
      await hold(run, nextRecord);
      assert.equal((await observeProcess(orphan.rex)).process.state, "exited");
      assert(
        !(await withAdmissionLock(readReservations)).some((r) =>
          r.members.some((m) => m.runId === orphan.id),
        ),
      );
      await release(nextRecord);
      await next.answer();
      console.log(
        "recovery parent SIGKILL: PASS; only this run's parent Pi was killed; child and membership survive until Rex confirms exit, then the conflicting writer is admitted",
      );

      const takenCwd = await directory(run, "taken-reload");
      const takenParent = await start(run, { label: "taken-reload", cwd: takenCwd, task });
      const taken = await hold(run, await takenParent.record());
      assert(taken.rex);
      await send(run, taken.rex, "/subagent-takeover");
      await takenParent.answer();
      assert.equal((await current(run, taken.id)).lifecycle, "taken_over");
      // /reload is ignored while the parent is still writing its reply.
      await until("parent idle after takeover", async () => {
        const text = success(
          await run.rex.capture(takenParent.parent.sessionId, takenParent.parent.blockId),
        ).stdout;
        return text.includes("taken_over") && !text.includes("Working");
      });
      await send(run, takenParent.parent, "/reload");
      await until("parent runtime reload observed", async () => {
        const raw = await maybeFile(join(run.out, "taken-reload-tools.jsonl.lifecycle"));
        return raw?.includes('"reason":"reload"') ?? false;
      });
      const afterReload = await start(run, { label: "conflict-after-reload", cwd: takenCwd, task });
      const afterRecord = await queued(run, await afterReload.record());
      assert.equal(afterRecord.rex, null);
      assert(
        (await withAdmissionLock(readReservations)).some((r) =>
          r.members.some((m) => m.runId === taken.id),
        ),
      );
      await key(run, takenParent.parent, "ctrl+d");
      await delay(500);
      assert.equal((await observeProcess(taken.rex)).process.state, "live");
      await key(run, taken.rex, "escape");
      await until("human interruption settles", async () =>
        (await events(taken)).some((e) => e.type === "agent_settled"),
      );
      await key(run, taken.rex, "ctrl+d");
      await hold(run, afterRecord);
      assert(
        !(await withAdmissionLock(readReservations)).some((r) =>
          r.members.some((m) => m.runId === taken.id),
        ),
      );
      await release(afterRecord);
      await afterReload.answer();
      assert.equal(await readFile(taken.paths.claim, "utf8"), "taken_over");
      assert.equal(await maybeFile(taken.paths.result), null);
      assert.equal(
        (
          await run.rex.command([
            "block",
            "inspect",
            "-s",
            unrelated.sessionId,
            unrelated.blockId,
            "--json",
          ])
        ).code,
        0,
      );
      assert.equal(await readFile(sentinel, "utf8"), "preserve");
      console.log(
        "recovery items 7 and 10 takeover/reload: PASS; taken-over membership survives the parent's reload and quit; a conflicting writer stays blocked until the human exits; the reservation then releases without inventing a result. Unrelated terminal and file intact. The real Rex server was not stopped, restarted, or disconnected.",
      );
      console.log("DEFERRED: background reload and session-switch scenarios belong to phase 4");
    } finally {
      await stop();
    }
  });
}
