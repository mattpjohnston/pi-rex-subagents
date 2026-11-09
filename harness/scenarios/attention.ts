import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { repo, withRun, type Run } from "../lib/run.ts";
import { current, events, key, send, start, until, watchRex } from "../lib/phase-one.ts";
import { object, success } from "../lib/rex.ts";
import { sessionOnlyTrustIndex } from "../lib/trust.ts";
import { locate } from "../../src/rex.ts";
import { type Location, type RunRecord } from "../../src/records.ts";

const script = join(repo, "rex", "next_waiting.lua");

async function appClient(run: Run): Promise<string> {
  const clients = object(success(await run.rex.command(["client", "ls", "--json"])).data);
  assert(Array.isArray(clients.clients));
  const app = clients.clients
    .map(object)
    .find((client) => client.info && object(client.info).kind === "app");
  assert(app && typeof app.client_id === "string");
  return app.client_id;
}

/** The app requests a size only for a block it is showing. Attachment and ownership are sticky. */
async function shownAt(
  run: Run,
  blockId: string,
  hint: Location,
  app: string,
): Promise<{ location: Location; stamp: string | null }> {
  const location = await locate(blockId, hint);
  assert(location, "waiting block disappeared");
  const size = object(
    success(
      await run.rex.command([
        "block",
        "call",
        "-s",
        location.sessionId,
        "-b",
        location.blockId,
        "size",
      ]),
    ).data,
  );
  assert(Array.isArray(size.desired));
  const desired = size.desired.map(object).find((entry) => entry.client_id === app);
  return { location, stamp: typeof desired?.updated_at === "string" ? desired.updated_at : null };
}

async function assertShown(
  run: Run,
  record: RunRecord,
  app: string,
  previous: string | null,
): Promise<string> {
  assert(record.rex);
  const shown = await shownAt(run, record.rex.blockId, record.location ?? record.rex, app);
  const view = object(success(await run.rex.inspectSession(shown.location.sessionId)).data);
  assert(Array.isArray(view.windows));
  const window = view.windows
    .map(object)
    .find((entry) => entry.window_id === shown.location.windowId);
  const block = object(
    success(
      await run.rex.command([
        "block",
        "inspect",
        "-s",
        shown.location.sessionId,
        shown.location.blockId,
        "--json",
      ]),
    ).data,
  );
  assert.equal(view.active_window_id, shown.location.windowId);
  assert.equal(window?.focused_block_id, shown.location.blockId);
  assert.equal(object(block.block).owner, app);
  const deadline = Date.now() + 8_000;
  let stamp = shown.stamp;
  while ((!stamp || (previous !== null && stamp <= previous)) && Date.now() < deadline) {
    await delay(200);
    stamp = (await shownAt(run, record.rex.blockId, shown.location, app)).stamp;
  }
  assert(stamp, "app has not requested a size for the selected block");
  if (previous) assert(stamp > previous, `stamp ${stamp} did not advance past ${previous}`);
  return stamp;
}

async function serverIdentity(): Promise<{ pid: number; startedAt: string }> {
  // Do not log this reply: whoami includes account details that must not land in harness output.
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      process.env.PI_SUBAGENTS_REX ?? "rex",
      ["whoami", "--json"],
      { encoding: "utf8", timeout: 10_000 },
      (error, out) => {
        if (error) reject(error);
        else resolve(out);
      },
    );
  });
  const who = object(JSON.parse(stdout));
  assert(typeof who.pid === "number" && typeof who.started_at === "string");
  return { pid: who.pid, startedAt: who.started_at };
}

function processRows(): { pid: number; ppid: number; command: string }[] {
  const out = execFileSync("ps", ["-ax", "-o", "pid=,ppid=,command="], { encoding: "utf8" });
  return out
    .trim()
    .split("\n")
    .flatMap((line) => {
      const match = /^(\d+)\s+(\d+)\s+(.*)$/.exec(line.trim());
      const command = match?.[3];
      return match && command ? [{ pid: Number(match[1]), ppid: Number(match[2]), command }] : [];
    });
}

function descendants(root: number, rows: { pid: number; ppid: number }[]): number[] {
  const children = new Map<number, number[]>();
  for (const row of rows) {
    const list = children.get(row.ppid) ?? [];
    list.push(row.pid);
    children.set(row.ppid, list);
  }
  const found: number[] = [];
  const stack = [...(children.get(root) ?? [])];
  const seen = new Set<number>();
  while (stack.length) {
    const pid = stack.pop();
    if (pid === undefined || seen.has(pid)) continue;
    seen.add(pid);
    found.push(pid);
    stack.push(...(children.get(pid) ?? []));
  }
  return found;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function eventStreamPids(
  run: Run,
  parent: { sessionId: string; blockId: string },
): Promise<number[]> {
  const data = object(
    success(
      await run.rex.command([
        "block",
        "call",
        "-s",
        parent.sessionId,
        "-b",
        parent.blockId,
        "process",
      ]),
    ).data,
  );
  const roots: number[] = [];
  for (const key of ["child", "foreground"] as const) {
    if (!data[key]) continue;
    const process = object(data[key]);
    if (typeof process.pid === "number") roots.push(process.pid);
  }
  assert(roots.length, "parent terminal has no process");
  const rows = processRows();
  const ids = new Set(roots.flatMap((pid) => [pid, ...descendants(pid, rows)]));
  return rows
    .filter(
      (row) => ids.has(row.pid) && row.command.includes("events") && row.command.includes("--all"),
    )
    .map((row) => row.pid);
}

async function moveToNewWindow(
  run: Run,
  sessionId: string,
  blockId: string,
  label: string,
): Promise<Location> {
  const created = object(
    success(
      await run.rex.command([
        "window",
        "new",
        "-s",
        sessionId,
        label,
        "--focus=false",
        "--keep-open",
        "--shell",
        "none",
        "--json",
        "--",
        "sleep",
        "300",
      ]),
    ).data,
  );
  assert(Array.isArray(created.block_ids) && typeof created.block_ids[0] === "string");
  success(
    await run.rex.command(["move", "-s", sessionId, blockId, "right", created.block_ids[0]], false),
  );
  const moved = await locate(blockId, { sessionId, windowId: blockId, blockId });
  assert(moved, "moved block was not found in its session");
  assert.notEqual(moved.windowId, undefined);
  return moved;
}

async function benchmark(run: Run, waiting: RunRecord): Promise<number[]> {
  const agent = join(run.scratch, "benchmark-agent");
  const state = join(agent, "subagents");
  await mkdir(join(state, "reservations"), { recursive: true, mode: 0o700 });
  const members = [];
  for (let index = 0; index < 128; index++) {
    const id = index.toString(16).padStart(24, "0");
    await mkdir(join(state, "runs", id), { recursive: true, mode: 0o700 });
    await writeFile(
      join(state, "runs", id, "run.json"),
      JSON.stringify({ ...waiting, id, waiting: { ...waiting.waiting, since: index } }),
      { mode: 0o600 },
    );
    if (index >= 80) members.push({ runId: id });
  }
  await writeFile(join(state, "reservations", "live.json"), JSON.stringify({ members }), {
    mode: 0o600,
  });
  const times = [];
  const previousAgent = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.PI_CODING_AGENT_DIR = agent;
    for (let index = 0; index < 5; index++) {
      if (index === 0) process.env.PI_SUBAGENTS_STATE_DIR = state;
      else delete process.env.PI_SUBAGENTS_STATE_DIR;
      const before = performance.now();
      const picked = object(success(await run.rex.command(["do", script, "--json"])).data);
      times.push(performance.now() - before);
      assert.equal(picked.recordsRead, 48);
      assert.equal(picked.runId, (80).toString(16).padStart(24, "0"));
    }
  } finally {
    process.env.PI_SUBAGENTS_STATE_DIR = run.state;
    if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgent;
  }
  await run.record("action-timing.json", { live: 48, historical: 80, milliseconds: times });
  return times;
}

export default async function attention(): Promise<void> {
  await withRun("attention", async (run) => {
    const stream = watchRex(run);
    try {
      const app = await appClient(run);
      // Sibling directories, not the shared scratch: a writer on a parent path blocks a child path.
      const dialogCwd = join(run.scratch, "dialog-project");
      const trustCwd = join(run.scratch, "trust-project");
      await mkdir(dialogCwd, { recursive: true, mode: 0o700 });
      await mkdir(join(trustCwd, ".pi"), { recursive: true, mode: 0o700 });
      await writeFile(join(trustCwd, ".pi", "settings.json"), "{}", { mode: 0o600 });
      const dialog = await start(run, {
        label: "attention-dialog",
        cwd: dialogCwd,
        task: "Call ask_human twice, one call at a time, waiting for each answer. Then report briefly. No other tools.",
      });
      const initial = await dialog.record();
      const first = await until("first dialog wait", async () => {
        const record = await current(run, initial.id);
        return record.waiting?.source === "reporter" && record;
      });
      assert(first.rex);
      assert(first.waiting);
      const dialogRex = first.rex;
      const trust = await start(run, {
        label: "attention-trust",
        cwd: trustCwd,
        task: "Reply briefly without tools.",
      });
      const trustInitial = await trust.record();
      const trustWait = await until("trust wait", async () => {
        const record = await current(run, trustInitial.id);
        return record.waiting?.source === "trust" && record;
      });
      assert(trustWait.rex);
      assert(trustWait.waiting);
      const trustRex = trustWait.rex;
      assert(first.waiting.since < trustWait.waiting.since);
      const away = await run.newSession("attention-away", ["sleep", "300"]);
      const awayView = object(success(await run.rex.inspectSession(away.sessionId)).data);
      assert(typeof awayView.active_window_id === "string");
      const awayWindow = awayView.active_window_id;
      const goAway = async () => {
        success(
          await run.rex.command([
            "do",
            "session.select",
            `session_id=${away.sessionId}`,
            `window_id=${awayWindow}`,
            "--json",
          ]),
        );
        await delay(300);
      };
      const pick = async (target: RunRecord) => {
        assert(target.rex);
        await goAway();
        const before = await shownAt(run, target.rex.blockId, target.location ?? target.rex, app);
        const picked = object(
          success(await run.rex.command(["do", "-s", away.sessionId, script, "--json"])).data,
        );
        assert.equal(picked.status, "selected");
        assert.equal(picked.runId, target.id);
        const stamp = await assertShown(run, target, app, before.stamp);
        await goAway();
        const parked = await shownAt(run, target.rex.blockId, target.location ?? target.rex, app);
        assert.equal(parked.stamp, stamp, "leaving the session refreshed the child's show time");
        await send(run, dialog.parent, "/subagents go next");
        await assertShown(run, target, app, stamp);
      };
      await pick(first);
      const times = await benchmark(run, first);
      const moved = await moveToNewWindow(
        run,
        dialogRex.sessionId,
        dialogRex.blockId,
        "attention-anchor-dialog",
      );
      assert.notEqual(moved.windowId, dialogRex.windowId);
      await until(
        "parent location follows the moved block",
        async () => {
          const record = await current(run, initial.id);
          return record.location?.windowId === moved.windowId && record;
        },
        12_000,
      );
      const blockedFor = (blockId: string) =>
        stream.seen.filter(
          (event) =>
            event.blockId === blockId &&
            event.name === "program_status_changed" &&
            object(object(event.payload).record ?? {}).state === "blocked",
        ).length;
      const blockedBefore = blockedFor(dialogRex.blockId);
      await send(run, dialogRex, "FIRST_WAIT_ANSWER");
      const second = await until("second distinct dialog wait", async () => {
        const record = await current(run, initial.id);
        return (
          record.waiting?.source === "reporter" &&
          record.waiting.since > (first.waiting?.since ?? 0) &&
          record
        );
      });
      assert(second.waiting);
      assert(
        blockedFor(dialogRex.blockId) > blockedBefore,
        "no blocked status on the moved block's stream",
      );
      await pick(trustWait);
      const exitsBefore = stream.seen.filter(
        (event) => event.blockId === dialogRex.blockId && event.name === "child_exited",
      ).length;
      await send(run, dialogRex, "SECOND_WAIT_ANSWER");
      await dialog.answer();
      const dialogFinal = await until("dialog exit recorded", async () => {
        const record = await current(run, initial.id);
        return record.process.state === "exited" && record.lifecycle === "completed" && record;
      });
      assert(
        stream.seen.filter(
          (event) => event.blockId === dialogRex.blockId && event.name === "child_exited",
        ).length > exitsBefore,
        "child_exited was not observed for the moved block",
      );
      const serverBefore = await serverIdentity();
      const killed = await eventStreamPids(run, trust.parent);
      assert(killed.length >= 1, "trust parent has no rex events stream to drop");
      for (const pid of killed) {
        try {
          process.kill(pid, "SIGTERM");
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
        }
      }
      await until(
        "dropped rex events subprocesses exited",
        async () => killed.every((pid) => !alive(pid)) || null,
        5_000,
      );
      const serverAfter = await serverIdentity();
      assert.equal(serverAfter.pid, serverBefore.pid);
      assert.equal(serverAfter.startedAt, serverBefore.startedAt);
      const trustMoved = await moveToNewWindow(
        run,
        trustRex.sessionId,
        trustRex.blockId,
        "attention-anchor-trust",
      );
      assert.notEqual(trustMoved.windowId, trustRex.windowId);
      await until(
        "dropped stream reconciled the move through block liveness",
        async () => {
          assert(
            killed.every((pid) => !alive(pid)),
            "killed rex events process was restarted in place",
          );
          const record = await current(run, trustInitial.id);
          return record.location?.windowId === trustMoved.windowId && record;
        },
        12_000,
      );
      const capture = success(await run.rex.capture(trustRex.sessionId, trustRex.blockId)).stdout;
      for (let index = 0; index < sessionOnlyTrustIndex(capture); index++)
        await key(run, trustRex, "down");
      assert.match(
        success(await run.rex.capture(trustRex.sessionId, trustRex.blockId)).stdout,
        /→ Trust \(this session only\)/,
      );
      await key(run, trustRex, "enter");
      await trust.answer();
      const trustFinal = await until("trust exit recorded after the dropped stream", async () => {
        const record = await current(run, trustInitial.id);
        return record.process.state === "exited" && record.lifecycle === "completed" && record;
      });
      for (const record of [dialogFinal, trustFinal]) assert.equal(record.waiting, null);
      await delay(500);
      const notices = stream.seen.filter(
        (event) =>
          event.name === "desktop_notification" &&
          (event.blockId === dialogRex.blockId || event.blockId === trustRex.blockId),
      );
      assert.deepEqual(notices, [], "waiting children send no desktop notification");
      assert.equal(
        (await events(dialogFinal)).filter((event) => event.type === "ui_prompt_start").length,
        2,
      );
      assert(
        !stream.seen.some(
          (event) =>
            event.blockId === trustRex.blockId &&
            event.name === "program_status_changed" &&
            object(object(event.payload).record ?? {}).state === "blocked",
        ),
      );
      const noWaiting = object(success(await run.rex.command(["do", script, "--json"])).data);
      assert.equal(noWaiting.status, "no_waiting");
      await run.record("attention-evidence.json", {
        dialogFinal,
        trustFinal,
        desktopNotifications: notices.length,
        timing: times,
        killedStreams: killed.length,
        serverPidUnchanged: serverBefore.pid === serverAfter.pid,
      });
      console.log(
        `attention: PASS; script + go next select the oldest wait from another session; dialog moved and still produced a stream exit; no desktop notifications; trust wait with no blocked status; dropped stream reconciled a same-session move through liveness; server pid unchanged; 48 live records ms ${times.map((ms) => ms.toFixed(1)).join(", ")}; cross-session move deferred`,
      );
    } finally {
      stream.stop();
    }
  });
}
