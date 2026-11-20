import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runForeground } from "../src/launch.ts";
import { RexEvents } from "../src/rex.ts";
import { privateDirectory, runPaths, writeRun, type RunRecord } from "../src/records.ts";

let dir: string | undefined;
afterEach(async () => {
  vi.unstubAllEnvs();
  if (dir) await rm(dir, { recursive: true, force: true });
});

/** A Rex whose child exits at once. The parent's pane is block p in window pw. */
async function fakeRex(root: string): Promise<string> {
  const log = join(root, "rex.log");
  const detached = join(root, "detached");
  await writeFile(
    join(root, "rex"),
    `#!/bin/sh
printf '%s\\n' "$*" >> '${log}'
case "$1 $2" in
  'whoami --json') echo '{"endpoint":"unix:///rex.sock"}' ;;
  'window new') echo '{"window_id":"w","block_ids":["c"]}' ;;
  'api call')
    case "$3" in
      session.new_layer) echo '{"layer_id":"l","block_ids":["c"],"revision":1}' ;;
      session.detach_block) touch '${detached}'; echo '{"revision":2}' ;;
      *) echo '{"revision":3}' ;;
    esac ;;
  'block inspect')
    case "$5" in
      p) echo '{"session_id":"s","block":{"block_id":"p","window_id":"pw","placement":"placed"}}' ;;
      *) if [ -f '${detached}' ]; then
           echo '{"session_id":"s","block":{"block_id":"c","window_id":null,"placement":"detached"}}'
         else
           echo '{"session_id":"s","block":{"block_id":"c","window_id":"pw","placement":"placed"}}'
         fi ;;
    esac ;;
  'block call') echo '{"last_exit":{"exit_code":0}}' ;;
  'capture -s') echo 'screen' ;;
  'events --all') sleep 30 ;;
  *) exit 1 ;;
esac
`,
    { mode: 0o700 },
  );
  return log;
}

async function launch(placement: "float" | "detached") {
  dir = await mkdtemp(join(tmpdir(), "pirs-placement-"));
  vi.stubEnv("PI_SUBAGENTS_STATE_DIR", dir);
  vi.stubEnv("PI_SUBAGENTS_PI", process.execPath);
  vi.stubEnv("PI_SUBAGENTS_REX", join(dir, "rex"));
  vi.stubEnv("REX_SESSION", "s");
  vi.stubEnv("REX_BLOCK", "p");
  const log = await fakeRex(dir);
  const id = "a".repeat(24);
  const runDir = join(dir, "runs", id);
  await privateDirectory(runDir);
  const settings = { provider: "p", model: "m", thinking: "off" as const };
  const run: RunRecord = {
    version: 1,
    id,
    label: "child",
    taskPath: join(runDir, "task.md"),
    cwd: dir,
    checkoutRoot: dir,
    access: "read",
    placement,
    requested: settings,
    effective: settings,
    background: false,
    continueFrom: null,
    parentSessionId: "parent",
    parentRunId: null,
    depth: 1,
    rex: null,
    location: null,
    paths: runPaths(runDir),
    lifecycle: "admitting",
    process: { state: "unknown" },
    waiting: null,
    queue: null,
    sessionFile: null,
    diagnostic: null,
    createdAt: 0,
    updatedAt: 0,
    loadedAt: null,
    finishedAt: null,
  };
  await writeRun(run);
  const events = new RexEvents();
  try {
    const outcome = await runForeground(run, "unused-entry", events, undefined, () => {});
    return { outcome, calls: (await readFile(log, "utf8")).trim().split("\n") };
  } finally {
    events.stop();
  }
}

it("a floating child opens as a layer over the parent's window", async () => {
  const { outcome, calls } = await launch("float");
  const layer = calls.find((call) => call.startsWith("api call session.new_layer"));
  expect(layer).toBeDefined();
  const args = JSON.parse(layer?.slice("api call session.new_layer ".length) ?? "{}");
  expect(args).toMatchObject({
    session_id: "s",
    window_id: "pw",
    focus: false,
    layout: {
      block: {
        label: "child",
        options: {
          shell: "none",
          cwd: dir,
          exit: { on_completion: false },
          path_prepend: (process.env.PATH ?? "").split(":").filter(Boolean),
        },
      },
    },
  });
  expect(args.layout.block.options.command[0]).toBe("/usr/bin/env");
  expect(calls.some((call) => call.startsWith("window new"))).toBe(false);
  expect(outcome.run.rex).toEqual({ sessionId: "s", windowId: "pw", blockId: "c" });
}, 20_000);

it("a detached child runs out of any window, and its exit is still seen", async () => {
  const { outcome, calls } = await launch("detached");
  const order = calls.map((call) => call.split(" ").slice(0, 3).join(" "));
  const opened = order.indexOf("window new -s");
  expect(opened).toBeGreaterThanOrEqual(0);
  expect(order.indexOf("api call session.detach_block")).toBeGreaterThan(opened);
  expect(order).toContain("api call session.set_block_label");
  expect(outcome.run.location).toEqual({ sessionId: "s", windowId: null, blockId: "c" });
  // Exit proof, not "unknown": a detached child must still release its reservation.
  expect(outcome.run.process).toEqual({ state: "exited", code: 0 });
}, 20_000);
