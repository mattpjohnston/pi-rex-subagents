import { randomBytes } from "node:crypto";
import { open, writeFile } from "node:fs/promises";
import { dirname, delimiter, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Type, type Static } from "typebox";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  Thinking,
  ChildEvent,
  errorText,
  isMissing,
  parse,
  privateDirectory,
  readRun,
  readResult,
  runDirectory,
  runPaths,
  stateDir,
  transition,
  writeRun,
  type ResultFile,
  RunRecord,
  type ModelSettings,
} from "./records.ts";
import { claim, readClaim, withRunLock } from "./claims.ts";
import { admit } from "./admission.ts";
import { checkoutRoot } from "./checkout.ts";
import { executable, resolveSettings, workingDirectory } from "./settings.ts";
import {
  object,
  observeProcess,
  requireLocalRex,
  rexJson,
  type BlockEvent,
  RexEvents,
} from "./rex.ts";

export const LaunchInput = Type.Object(
  {
    task: Type.String({ minLength: 1 }),
    label: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
    cwd: Type.Optional(Type.String()),
    access: Type.Optional(
      Type.Union([Type.Literal("read"), Type.Literal("inspect"), Type.Literal("write")]),
    ),
    background: Type.Optional(Type.Boolean()),
    continueFrom: Type.Optional(Type.String()),
    provider: Type.Optional(Type.String()),
    model: Type.Optional(Type.String()),
    thinking: Type.Optional(Thinking),
  },
  { additionalProperties: false },
);
export type LaunchInput = Static<typeof LaunchInput>;
export type Progress = (run: RunRecord) => void;
export const STARTUP_MS = 60_000;
export const SHUTDOWN_MS = 10_000;
export const CANCELLATION_MS = 30_000;

export async function prepareRun(input: LaunchInput, ctx: ExtensionContext): Promise<RunRecord> {
  if (input.access && input.access !== "write")
    throw new Error(`${input.access} access is not yet supported`);
  if (input.background) throw new Error("Background subagents are not yet supported");
  if (!input.task.trim()) throw new Error("Subagent task must not be empty");
  if (!process.env.REX_SESSION)
    throw new Error("Subagent requires a parent running inside Rex (REX_SESSION is not set)");
  const parent: ModelSettings | undefined = ctx.model
    ? { provider: ctx.model.provider, model: ctx.model.id, thinking: ctx.thinkingLevel ?? "off" }
    : undefined;
  const effective = resolveSettings(parent, input, (provider, id) =>
    ctx.modelRegistry.find(provider, id),
  );
  const cwd = await workingDirectory(ctx.cwd, input.cwd);
  const root = await checkoutRoot(cwd);
  let continueFrom: RunRecord["continueFrom"] = null;
  if (input.continueFrom) {
    const source = await readRun(input.continueFrom);
    if (source.process.state === "live" || source.process.state === "unresolved")
      throw new Error("Cannot continue a live or unresolved run");
    if (!source.rex) throw new Error("Cannot confirm source process exit");
    const observation = await observeProcess(source.rex);
    if (observation.process.state !== "exited")
      throw new Error("Cannot continue until source process exit is confirmed");
    const sessionFile =
      (await readClaim(source.paths.claim)) === "result"
        ? (await readResult(source)).sessionFile
        : source.sessionFile;
    if (!sessionFile) throw new Error("Source run has no saved session file");
    continueFrom = { runId: source.id, sessionFile };
  }
  const id = randomBytes(12).toString("hex");
  const paths = runPaths(runDirectory(id));
  await privateDirectory(stateDir());
  await privateDirectory(dirname(paths.run));
  await privateDirectory(paths.sessionDir);
  await privateDirectory(paths.inbox);
  await writeFile(resolve(dirname(paths.run), "task.md"), `# Delegated task\n\n${input.task}\n`, {
    mode: 0o600,
  });
  const run: RunRecord = {
    version: 1,
    id,
    label: input.label?.trim() || `child-${id.slice(0, 8)}`,
    taskPath: resolve(dirname(paths.run), "task.md"),
    cwd,
    checkoutRoot: root,
    access: "write",
    requested: {
      provider: input.provider ?? null,
      model: input.model ?? null,
      thinking: input.thinking ?? null,
    },
    effective,
    background: false,
    continueFrom,
    parentSessionId: ctx.sessionManager.getSessionId(),
    parentRunId: null,
    depth: 0,
    rex: null,
    paths,
    lifecycle: "admitting",
    process: { state: "unknown" },
    waiting: null,
    sessionFile: null,
    diagnostic: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    loadedAt: null,
    finishedAt: null,
  };
  await writeRun(run);
  return run;
}

export async function childArgv(run: RunRecord, entry: string): Promise<string[]> {
  const env = [`PI_SUBAGENTS_RUN_DIR=${dirname(run.paths.run)}`, `PI_SUBAGENTS_RUN_ID=${run.id}`];
  for (const key of ["PI_SUBAGENTS_STATE_DIR", "PI_SUBAGENTS_LOG_TOOLS", "PI_CODING_AGENT_DIR"]) {
    if (process.env[key]) env.push(`${key}=${process.env[key]}`);
  }
  const args = [
    await executable(process.env.PI_SUBAGENTS_PI ?? "pi"),
    "--model",
    `${run.effective.provider}/${run.effective.model}`,
    "--thinking",
    run.effective.thinking,
    "--session-dir",
    run.paths.sessionDir,
    "--name",
    run.label,
    "-e",
    entry,
  ];
  // Testing hooks only: isolate child discovery and load scenario fault tools, not user features.
  if (process.env.PI_SUBAGENTS_CHILD_NO_DISCOVERY === "1") args.push("--no-extensions");
  for (const extension of (process.env.PI_SUBAGENTS_CHILD_EXTENSIONS ?? "")
    .split(delimiter)
    .filter(Boolean))
    args.push("-e", extension);
  if (run.continueFrom) args.push("--fork", run.continueFrom.sessionFile);
  args.push(`@${run.taskPath}`);
  return ["/usr/bin/env", ...env, ...args];
}

export async function reconcile(run: RunRecord): Promise<void> {
  if (!run.rex) return;
  const observation = await observeProcess(run.rex);
  if (observation.location) run.rex = observation.location;
  run.process = observation.process;
}

/** Claim before signalling. A result winner may be closed, but never rewritten. */
export async function cancel(run: RunRecord): Promise<"result" | "taken_over" | "cancelled"> {
  const winner = await withRunLock(run.paths.lock, async () => {
    const existing = await readClaim(run.paths.claim);
    return existing ?? claim(run.paths.claim, "cancelled");
  });
  if (winner === "taken_over") return winner;
  await reconcile(run);
  if (run.process.state === "live" && run.process.pid) {
    try {
      process.kill(run.process.pid, "SIGTERM");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
    }
  }
  return winner;
}

class EventCursor {
  private offset = 0;
  private pending = "";
  async drain(run: RunRecord): Promise<boolean> {
    let file;
    try {
      file = await open(run.paths.events, "r");
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
    try {
      const buffer = Buffer.alloc(256 * 1024);
      let changed = false;
      while (true) {
        const read = await file.read(buffer, 0, buffer.length, this.offset);
        if (!read.bytesRead) break;
        this.offset += read.bytesRead;
        this.pending += buffer.subarray(0, read.bytesRead).toString("utf8");
        let end;
        while ((end = this.pending.indexOf("\n")) >= 0) {
          const line = this.pending.slice(0, end);
          this.pending = this.pending.slice(end + 1);
          const event = parse(ChildEvent, JSON.parse(line));
          switch (event.type) {
            case "child_loaded":
              run.loadedAt = event.at;
              changed = true;
              break;
            case "project_trust":
              run.waiting = { kind: "project_trust", title: "Project trust", since: event.at };
              changed = true;
              break;
            case "session_start":
              run.waiting = null;
              if (typeof event.data.sessionFile === "string")
                run.sessionFile = event.data.sessionFile;
              if (event.data.effective)
                run.effective = parse(RunRecord.properties.effective, event.data.effective);
              changed = true;
              break;
            case "ui_prompt_start":
              run.waiting = {
                kind: String(event.data.kind),
                title: String(event.data.title),
                since: event.at,
              };
              changed = true;
              break;
            case "ui_prompt_end":
              run.waiting = null;
              changed = true;
              break;
          }
        }
        if (this.pending.length > 1024 * 1024) throw new Error("Oversized child event");
      }
      return changed;
    } finally {
      await file.close();
    }
  }
}

export async function runForeground(
  run: RunRecord,
  entry: string,
  events: RexEvents,
  signal: AbortSignal | undefined,
  progress: Progress,
): Promise<{ run: RunRecord; result?: ResultFile }> {
  progress(run);
  await admit(run);
  if (signal?.aborted) {
    await cancel(run);
    transition(run, "cancelled");
    await writeRun(run);
    return { run };
  }
  transition(run, "starting");
  await writeRun(run);
  progress(run);
  await requireLocalRex();
  const argv = await childArgv(run, entry);
  let launch: unknown;
  try {
    // Never retry: timeout or a malformed reply can mean the child was launched.
    launch = await rexJson([
      "window",
      "new",
      "-s",
      process.env.REX_SESSION ?? "",
      run.label,
      "--focus=false",
      "-c",
      run.cwd,
      "--keep-open",
      "--shell",
      "none",
      "--json",
      "--",
      ...argv,
    ]);
    const reply = object(launch);
    if (
      typeof reply.window_id !== "string" ||
      !Array.isArray(reply.block_ids) ||
      typeof reply.block_ids[0] !== "string"
    )
      throw new Error("Invalid Rex launch reply");
    run.rex = {
      sessionId: process.env.REX_SESSION ?? "",
      windowId: reply.window_id,
      blockId: reply.block_ids[0],
    };
  } catch (error) {
    run.diagnostic = `Uncertain Rex launch: ${errorText(error)}. Not retried.`;
    transition(run, "failed");
    await writeRun(run);
    return { run };
  }
  await writeRun(run);
  events.watch(run.rex.blockId);
  events.start();
  const pushed: BlockEvent[] = [];
  const listener = (event: BlockEvent) => {
    pushed.push(event);
  };
  const blockId = run.rex.blockId;
  events.changes.on(blockId, listener);
  const cursor = new EventCursor();
  let result: ResultFile | undefined;
  let invalidResult = false;
  let resultDeadline: number | undefined;
  let cancelDeadline: number | undefined;
  let cancelled = false;
  let lastReconcile = 0;
  let shown = "";
  const startupDeadline = Date.now() + STARTUP_MS;
  try {
    while (true) {
      let changed = await cursor.drain(run);
      for (const event of pushed.splice(0)) {
        const payload = object(event.payload);
        if (event.name === "child_exited" && typeof payload.exit_code === "number") {
          run.process = { state: "exited", code: payload.exit_code };
          changed = true;
        } else if (event.name === "program_status_changed") {
          const status = payload.record ? object(payload.record) : null;
          if (status?.state === "blocked")
            run.waiting ??= {
              kind: typeof status.kind === "string" ? status.kind : "blocked",
              title: typeof status.msg === "string" ? status.msg : "Pi dialog",
              since: Date.now(),
            };
          else if (run.waiting?.kind === "blocked") run.waiting = null;
          changed = true;
        }
      }
      if (Date.now() - lastReconcile >= (events.connected ? 5000 : 1000)) {
        await reconcile(run);
        lastReconcile = Date.now();
        changed = true;
      }
      if (run.loadedAt && run.lifecycle === "starting") {
        transition(run, "running");
        changed = true;
      }
      let winner = await readClaim(run.paths.claim);
      if (winner === "taken_over") {
        transition(run, "taken_over");
        run.waiting = null;
        await writeRun(run);
        progress(run);
        return { run };
      }
      if (winner === "result" && !resultDeadline) {
        resultDeadline = Date.now() + SHUTDOWN_MS;
        try {
          result = await readResult(run);
          run.effective = result.effective;
          run.sessionFile = result.sessionFile;
        } catch (error) {
          invalidResult = true;
          run.diagnostic = `Reporter failure: ${errorText(error)}; inspect ${run.paths.result}`;
        }
      }
      if (
        signal?.aborted &&
        !cancelled &&
        (!resultDeadline || Date.now() >= resultDeadline || run.process.state === "exited")
      ) {
        winner = await cancel(run);
        cancelled = true;
        if (winner === "taken_over") continue;
        cancelDeadline = Date.now() + CANCELLATION_MS;
      }
      if (winner === "cancelled" && !cancelDeadline) cancelDeadline = Date.now() + CANCELLATION_MS;
      const graceEnded = cancelDeadline ?? resultDeadline;
      if ((winner && run.process.state === "exited") || (graceEnded && Date.now() >= graceEnded)) {
        if (run.process.state === "live")
          run.process = { state: "unresolved", pid: run.process.pid };
        transition(
          run,
          winner === "cancelled"
            ? "cancelled"
            : invalidResult
              ? "failed"
              : (result?.outcome ?? "failed"),
        );
        break;
      }
      if (!winner && run.process.state === "exited") {
        run.diagnostic = `Startup or reporter failure: child exited without a result claim. Events: ${run.paths.events}`;
        transition(run, "failed");
        break;
      }
      if (!run.loadedAt && Date.now() >= startupDeadline) {
        run.diagnostic = `Startup deadline exceeded; reporter did not load. Events: ${run.paths.events}`;
        await cancel(run);
        const deadline = Date.now() + CANCELLATION_MS;
        while (run.process.state !== "exited" && Date.now() < deadline) {
          await delay(250);
          await reconcile(run);
        }
        if (run.process.state === "live")
          run.process = { state: "unresolved", pid: run.process.pid };
        transition(run, "failed");
        break;
      }
      if (changed) await writeRun(run);
      const summary = JSON.stringify([run.lifecycle, run.waiting]);
      if (summary !== shown) {
        progress(run);
        shown = summary;
      }
      await delay(200);
    }
    run.waiting = null;
    await writeRun(run);
    progress(run);
    return { run, ...(result ? { result } : {}) };
  } finally {
    events.changes.off(blockId, listener);
  }
}
