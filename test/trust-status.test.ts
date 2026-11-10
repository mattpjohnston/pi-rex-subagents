import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { privateDirectory, runPaths, type RunRecord } from "../src/records.ts";

const writes = vi.hoisted(() => [] as string[]);
vi.mock("node:fs", async (original) => ({
  ...(await original<typeof import("node:fs")>()),
  writeSync: (fd: number, data: string) => {
    writes.push(`${fd}:${data}`);
    return data.length;
  },
}));

const BLOCKED = `1:\x1b]7501;state=blocked:app=pi:kind=permission:msg=${Buffer.from("Project trust").toString("base64")}\x1b\\`;
const IDLE = "1:\x1b]7501;state=idle:app=pi\x1b\\";

let dir: string;
let handlers: Map<string, (event: unknown, ctx: unknown) => unknown>;
beforeEach(async () => {
  vi.useFakeTimers();
  writes.length = 0;
  dir = await mkdtemp(join(tmpdir(), "pirs-trust-status-"));
  await privateDirectory(dir);
  const { registerReporter } = await import("../src/reporter.ts");
  handlers = new Map();
  const pi = new Proxy(
    { on: (name: string, handler: (event: unknown) => unknown) => handlers.set(name, handler) },
    { get: (target, key) => (key in target ? target[key as "on"] : () => undefined) },
  );
  const settings = { provider: "p", model: "m", thinking: "off" as const };
  registerReporter(
    pi as never,
    {
      id: "d".repeat(24),
      label: "waiting-child",
      access: "write",
      effective: settings,
      paths: runPaths(dir),
    } as RunRecord,
  );
});
afterEach(async () => {
  vi.useRealTimers();
  await rm(dir, { recursive: true, force: true });
});
const sequences = () => writes.filter((write) => write.includes("\x1b]"));

it("an open trust prompt reports Pi's blocked status once, and idle when it ends", () => {
  handlers.get("project_trust")?.({ cwd: dir }, {});
  vi.advanceTimersByTime(1000);
  handlers.get("project_trust")?.({ cwd: dir }, {});
  vi.advanceTimersByTime(1000);
  expect(sequences()).toEqual([BLOCKED]);
  handlers.get("session_shutdown")?.({ reason: "reload" }, {});
  expect(sequences()).toEqual([BLOCKED, IDLE]);
});

it("a trust decision Pi settles without a prompt reports nothing", () => {
  handlers.get("project_trust")?.({ cwd: dir }, {});
  handlers.get("session_shutdown")?.({ reason: "reload" }, {});
  vi.advanceTimersByTime(1000);
  expect(sequences()).toEqual([]);
});

it("a dialog wait writes nothing, because Pi reports it", () => {
  handlers.get("ui_prompt_start")?.({ kind: "select", title: "Pick one" }, {});
  vi.advanceTimersByTime(1000);
  handlers.get("ui_prompt_end")?.({}, {});
  expect(sequences()).toEqual([]);
});
