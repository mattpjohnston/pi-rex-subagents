import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

let dir: string | undefined;
afterEach(async () => {
  vi.unstubAllEnvs();
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function toolCall(
  input: Record<string, unknown>,
  limits?: string,
  launches: Record<string, unknown>[] = [],
) {
  dir = await mkdtemp(join(tmpdir(), "pirs-guard-"));
  vi.stubEnv("PI_SUBAGENTS_STATE_DIR", dir);
  if (limits !== undefined) await writeFile(join(dir, "limits.json"), limits);
  vi.stubEnv("PI_SUBAGENTS_RUN_ID", "");
  vi.stubEnv("PI_SUBAGENTS_RUN_DIR", "");
  const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
  const listeners: ((data: unknown) => void)[] = [];
  const pi = {
    on: (name: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) =>
      handlers.set(name, handler),
    events: {
      emit: (_channel: string, data: unknown) => {
        for (const listener of listeners) listener(data);
      },
      on: (_channel: string, listener: (data: unknown) => void) => {
        listeners.push(listener);
        return () => listeners.splice(listeners.indexOf(listener), 1);
      },
    },
    registerCommand: () => {},
    registerTool: () => {},
  };
  const extension = (await import("../src/index.ts")) as {
    default: (pi: unknown) => Promise<void>;
  };
  await extension.default(pi);
  const ctx = { cwd: dir, sessionManager: { getBranch: () => [] } };
  // A launch whose preflight fails still counts while its call is in flight.
  for (const [index, args] of launches.entries())
    await handlers
      .get("tool_execution_start")?.(
        { toolName: "subagent", toolCallId: `launch-${index}`, args },
        ctx,
      )
      .catch(() => undefined);
  return handlers.get("tool_call")?.({ toolName: "edit", toolCallId: "t", input }, ctx);
}

it("an edit tool with no single path is not refused, like bash", async () => {
  expect(await toolCall({ text: "[notes.md]\n@APPEND\n+line" })).toBeUndefined();
});

it("an edit with a path and no child writer is allowed", async () => {
  expect(await toolCall({ path: "notes.md", oldText: "a", newText: "b" })).toBeUndefined();
});

it("a malformed limits.json blocks launches, not the parent's own edits", async () => {
  expect(
    await toolCall({ path: "notes.md", oldText: "a", newText: "b" }, '{"active": 0}'),
  ).toBeUndefined();
});

it("a top-level read or inspect launch in flight does not refuse the parent's edit", async () => {
  const edit = { path: "notes.md", oldText: "a", newText: "b" };
  for (const access of ["read", "inspect"])
    expect(await toolCall(edit, undefined, [{ task: "look", access }])).toBeUndefined();
  expect(await toolCall(edit, undefined, [{ task: "change", access: "write" }])).toMatchObject({
    block: true,
  });
  expect(await toolCall(edit, undefined, [{ task: "change" }])).toMatchObject({ block: true });
});
