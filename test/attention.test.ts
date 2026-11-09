import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runPaths, type RunRecord } from "../src/records.ts";

const writes = vi.hoisted(() => [] as string[]);
vi.mock("node:fs", async (original) => ({
  ...(await original<typeof import("node:fs")>()),
  writeSync: (fd: number, data: string) => {
    writes.push(`${fd}:${data}`);
    return data.length;
  },
}));

let dir: string | undefined;
afterEach(async () => {
  vi.useRealTimers();
  if (dir) await rm(dir, { recursive: true, force: true });
});

it("a waiting child writes no OSC 9 desktop notification", async () => {
  vi.useFakeTimers();
  dir = await mkdtemp(join(tmpdir(), "pirs-attention-"));
  const { registerReporter } = await import("../src/reporter.ts");
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const pi = new Proxy(
    { on: (name: string, handler: (event: unknown) => unknown) => handlers.set(name, handler) },
    { get: (target, key) => (key in target ? target[key as "on"] : () => undefined) },
  );
  const settings = { provider: "p", model: "m", thinking: "off" as const };
  const run = {
    id: "d".repeat(24),
    label: "waiting-child",
    access: "write",
    effective: settings,
    paths: runPaths(dir),
  } as RunRecord;
  registerReporter(pi as never, run);
  handlers.get("ui_prompt_start")?.({ kind: "select", title: "Pick one" }, {});
  handlers.get("project_trust")?.({ cwd: dir }, {});
  vi.advanceTimersByTime(1000);
  expect(writes.filter((write) => write.includes("\x1b]9;"))).toEqual([]);
});
