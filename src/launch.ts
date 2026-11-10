import { randomBytes } from "node:crypto";
import { open, stat, writeFile } from "node:fs/promises";
import { dirname, delimiter, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Type, type Static } from "typebox";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  Thinking,
  ChildEvent,
  atomicWrite,
  errorText,
  isMissing,
  parse,
  privateDirectory,
  readRun,
  readJson,
  readResult,
  runDirectory,
  runPaths,
  stateDir,
  isTerminal,
  recordProcess,
  transition,
  writeRun,
  type CheckoutReport,
  type ResultFile,
  RunRecord,
  initialActivity,
  listRuns,
  type ModelSettings,
} from "./records.ts";
import { claim, readClaim, withAdmissionLock, withProtocolLock } from "./claims.ts";
import { admit, canLaunchChildren, claimedAncestor, removeTicket } from "./admission.ts";
import { InboxMessage } from "./inbox.ts";
import { checkoutRoot } from "./checkout.ts";
import { captureFingerprint, compareFingerprints, type Fingerprint } from "./fingerprint.ts";
import { executable, resolveSettings, workingDirectory } from "./settings.ts";
import { INSPECT_EXCLUDED, READ_TOOLS } from "./restrictions.ts";
import {
  object,
  locate,
  closeBlock,
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

export async function prepareRun(
  input: LaunchInput,
  ctx: ExtensionContext,
  launchCaller?: string,
): Promise<RunRecord> {
  const parentRun = process.env.PI_SUBAGENTS_RUN_ID
    ? await readRun(process.env.PI_SUBAGENTS_RUN_ID)
    : null;
  if (parentRun) {
    if (!(await canLaunchChildren(parentRun)))
      throw new Error(`Nested launch refused: depth limit or read access on ${parentRun.id}`);
    if (parentRun.access === "inspect" && input.access === "write")
      throw new Error(
        "Nested write refused: inspect children may launch only read or inspect children",
      );
    if ((await readClaim(parentRun.paths.claim)) || (await claimedAncestor(parentRun)))
      throw new Error(`Nested launch refused: ancestor ${parentRun.id} already has a claim`);
  }
  if (!input.task.trim()) throw new Error("Subagent task must not be empty");
  if (!process.env.REX_SESSION)
    throw new Error("Subagent requires a parent running inside Rex (REX_SESSION is not set)");
  const parent: ModelSettings | undefined = ctx.model
    ? { provider: ctx.model.provider, model: ctx.model.id, thinking: ctx.thinkingLevel ?? "off" }
    : undefined;
  const settings = resolveSettings(parent, input, (provider, id) =>
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
  await privateDirectory(dirname(dirname(paths.run)));
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
    access: input.access ?? (parentRun?.access === "inspect" ? "inspect" : "write"),
    requested: settings.requested,
    effective: settings.effective,
    background: input.background === true,
    continueFrom,
    parentSessionId: ctx.sessionManager.getSessionId(),
    rootParentSessionId:
      parentRun?.rootParentSessionId ??
      parentRun?.parentSessionId ??
      ctx.sessionManager.getSessionId(),
    parentRunId: parentRun?.id ?? null,
    ...(launchCaller ? { launchCaller } : {}),
    depth: parentRun ? parentRun.depth + 1 : 1,
    activity: initialActivity(),
    rex: null,
    location: null,
    paths,
    lifecycle: "admitting",
    process: { state: "unknown" },
    waiting: null,
    queue: null,
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
  for (const key of [
    "PI_SUBAGENTS_STATE_DIR",
    "PI_SUBAGENTS_LOG_TOOLS",
    "PI_SUBAGENTS_CHILD_NO_DISCOVERY",
    "PI_SUBAGENTS_CHILD_EXTENSIONS",
    "HARNESS_NESTED_PLAN_DIR",
    "HARNESS_TOOL_LOG",
    "HARNESS_EXTRA_MARKER",
    "HARNESS_INSPECT_MARKER",
    "HARNESS_INSPECT_RESULT",
    "PI_SUBAGENTS_PI",
    "PI_SUBAGENTS_REX",
    "PI_CODING_AGENT_DIR",
  ]) {
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
  ];
  if (run.access === "read")
    args.push("--no-extensions", "--no-mcp", "--tools", READ_TOOLS.join(","));
  else if (run.access === "inspect") args.push("--exclude-tools", INSPECT_EXCLUDED.join(","));
  args.push("-e", entry);
  // Testing hooks only: isolate child discovery and load scenario fault tools, not user features.
  // read already passes --no-extensions. inspect keeps discovered extensions unless the hook says otherwise.
  if (run.access !== "read" && process.env.PI_SUBAGENTS_CHILD_NO_DISCOVERY === "1")
    args.push("--no-extensions");
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
  const observation = await observeProcess(run.location ?? run.rex);
  run.location = observation.location;
  recordProcess(run, observation.process);
}

/** Claim before signalling. A result winner may be closed, but never rewritten. */
export async function cancel(
  run: RunRecord,
  afterClaim?: () => void,
): Promise<"result" | "taken_over" | "cancelled"> {
  const targets: RunRecord[] = [];
  const winner = await withAdmissionLock(async () => {
    const records = await listRuns();
    let ancestor = run.parentRunId;
    while (ancestor) {
      const parent = await readRun(ancestor);
      if ((await readClaim(parent.paths.claim)) === "taken_over") return "taken_over" as const;
      ancestor = parent.parentRunId;
    }
    const visit = async (current: RunRecord): Promise<"result" | "taken_over" | "cancelled"> => {
      const winner = await withProtocolLock(
        current.paths.lock,
        async () =>
          (await readClaim(current.paths.claim)) ?? claim(current.paths.claim, "cancelled"),
      );
      if (winner === "taken_over") return winner;
      await removeTicket(current.id);
      targets.push(current);
      for (const child of records.filter((r) => r.parentRunId === current.id)) await visit(child);
      return winner;
    };
    return visit(run);
  });
  if (winner === "cancelled") afterClaim?.();
  if (winner === "taken_over") return winner;
  await Promise.all(
    targets
      .filter((r) => r.id !== run.id)
      .map(async (child) => {
        await signalCancelled(child);
        const deadline = Date.now() + CANCELLATION_MS;
        do {
          await reconcile(child);
          if (!child.rex && child.lifecycle === "admitting")
            child.process = { state: "exited", code: null };
          if (child.process.state === "exited") break;
          await delay(200);
        } while (Date.now() < deadline);
        const fresh = await readRun(child.id);
        if (!isTerminal(fresh.lifecycle)) {
          const winner = await readClaim(fresh.paths.claim);
          const result = winner === "result" ? await readResult(fresh).catch(() => null) : null;
          transition(fresh, winner === "result" ? (result?.outcome ?? "failed") : "cancelled");
        }
        recordProcess(fresh, child.process);
        await writeRun(fresh);
      }),
  );
  if (winner === "result") {
    const result = await readResult(run).catch(() => null);
    const remaining = (result?.finishedAt ?? run.finishedAt ?? 0) + SHUTDOWN_MS - Date.now();
    if (remaining > 0) await delay(remaining);
    await reconcile(run);
    if (run.process.state !== "exited" && run.location) await closeBlock(run.location);
    await reconcile(run);
    return winner;
  }
  await signalCancelled(run);
  return winner;
}
async function signalCancelled(run: RunRecord): Promise<void> {
  // Keep the launcher alive until it can close a block returned after the cancellation claim.
  // Otherwise signalling its ancestor first can kill the only process waiting for Rex's reply.
  const deadline = Date.now() + CANCELLATION_MS;
  while (run.lifecycle === "starting" && !run.rex && Date.now() < deadline) {
    await delay(100);
    Object.assign(run, await readRun(run.id));
  }
  await reconcile(run);
  if ((run.process.state === "live" || run.process.state === "unresolved") && run.process.pid) {
    if ((await readClaim(run.paths.claim)) === "result") {
      const result = await readResult(run).catch(() => null);
      const remaining = (result?.finishedAt ?? 0) + SHUTDOWN_MS - Date.now();
      if (remaining > 0) await delay(remaining);
      if (run.location) await closeBlock(run.location);
      return;
    }
    try {
      process.kill(run.process.pid, "SIGTERM");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
    }
  }
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
              run.waiting = {
                source: "trust",
                kind: "project_trust",
                title: "Project trust",
                since: event.at,
              };
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
                source: "reporter",
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

export function observeRexEvent(run: RunRecord, event: BlockEvent): void {
  const payload = object(event.payload);
  if (event.name === "child_exited" && typeof payload.exit_code === "number") {
    run.process = { state: "exited", code: payload.exit_code };
  } else if (event.name === "program_status_changed") {
    const status = payload.record ? object(payload.record) : null;
    if (status?.state === "blocked")
      run.waiting ??= {
        source: "rex",
        kind: typeof status.kind === "string" ? status.kind : "blocked",
        title: typeof status.msg === "string" ? status.msg : "Pi dialog",
        since: Date.now(),
      };
    else if (run.waiting?.source === "rex") run.waiting = null;
  }
}

async function finishCheckout(
  run: RunRecord,
  before: Fingerprint | undefined,
): Promise<CheckoutReport | undefined> {
  if (!before) return undefined;
  const after =
    run.process.state === "exited"
      ? await captureFingerprint(run.checkoutRoot).catch((error: unknown): Fingerprint => ({
          version: 1,
          state: "unknown",
          reason: errorText(error),
        }))
      : {
          version: 1 as const,
          state: "unknown" as const,
          reason: "Process exit was not confirmed",
        };
  const dir = dirname(run.paths.run);
  await atomicWrite(join(dir, "fingerprint-after.json"), after);
  const checkout = compareFingerprints(before, after);
  await atomicWrite(join(dir, "checkout.json"), checkout);
  try {
    const result = await readResult(run);
    await atomicWrite(run.paths.result, { ...result, checkout });
  } catch (error) {
    if (isMissing(error) || error instanceof SyntaxError) return checkout;
    if (
      error instanceof Error &&
      (error.message.startsWith("Invalid persisted") || error.message.startsWith("Result run ID"))
    )
      return checkout;
    throw error;
  }
  return checkout;
}
export interface WatchOptions {
  detach?: AbortSignal;
  resume?: boolean;
}
function stopped(options: WatchOptions): boolean {
  return options.detach?.aborted === true;
}
const launchKey = "pi-rex-subagents:launches";
function launchWaits(): Map<string, Promise<void>> {
  const host = globalThis as unknown as Record<string, Map<string, Promise<void>>>;
  return (host[launchKey] ??= new Map());
}
async function savedBefore(run: RunRecord): Promise<Fingerprint | undefined> {
  try {
    const value = await readJson(join(dirname(run.paths.run), "fingerprint-before.json"));
    if (!value || typeof value !== "object" || !("version" in value) || !("state" in value))
      return undefined;
    if (value.version !== 1) return undefined;
    if (value.state === "unknown" && "reason" in value && typeof value.reason === "string")
      return { version: 1, state: "unknown", reason: value.reason };
    if (value.state === "ok") return value as Fingerprint;
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  return undefined;
}
/** Written and synced before Rex is asked for a tab, so its absence proves Rex never was. */
const launchMarker = (run: RunRecord) => join(dirname(run.paths.run), "rex-launch");
async function mayHaveAskedRex(run: RunRecord): Promise<boolean> {
  if (run.rex !== null) return true;
  try {
    await stat(launchMarker(run));
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}
/**
 * Ends a launch nobody will watch to completion. A launch that never asked Rex for a tab has no
 * process, so its exit is certain and it gives up its ticket; after the ask, exit proof only
 * ever comes from Rex.
 */
export async function abandon(
  run: RunRecord,
  outcome: "cancelled" | "failed",
  error?: unknown,
): Promise<void> {
  if (isTerminal(run.lifecycle) && error === undefined) return;
  if (error !== undefined) run.diagnostic = errorText(error);
  if (!(await mayHaveAskedRex(run))) {
    await withAdmissionLock(async () => {
      await withProtocolLock(
        run.paths.lock,
        async () => (await readClaim(run.paths.claim)) ?? claim(run.paths.claim, "cancelled"),
      );
      await removeTicket(run.id);
    });
    run.process = { state: "exited", code: null };
  }
  if (!isTerminal(run.lifecycle)) transition(run, outcome);
  await writeRun(run);
}
type Watched = { run: RunRecord; result?: ResultFile; checkout?: CheckoutReport };
export async function runForeground(
  run: RunRecord,
  entry: string,
  events: RexEvents,
  signal: AbortSignal | undefined,
  progress: Progress,
  options: WatchOptions = {},
): Promise<Watched> {
  try {
    return await watch(run, entry, events, signal, progress, options);
  } catch (error) {
    // The original error is the caller's answer; failing to record it must not replace it.
    await abandon(run, "failed", error).catch(() => undefined);
    throw error;
  }
}
async function watch(
  run: RunRecord,
  entry: string,
  events: RexEvents,
  signal: AbortSignal | undefined,
  progress: Progress,
  options: WatchOptions,
): Promise<Watched> {
  if (options.resume) {
    await launchWaits().get(run.id);
    Object.assign(run, await readRun(run.id));
  }
  progress(run);
  if (
    options.resume &&
    isTerminal(run.lifecycle) &&
    (run.process.state === "exited" || run.process.state === "unresolved")
  )
    return { run };
  if (options.resume && run.lifecycle === "failed" && !run.rex) return { run };
  let before: Fingerprint | undefined;
  const launched = options.resume && run.rex && run.lifecycle !== "admitting";
  if (!launched) {
    // Anything that can fail without launching runs before admission, so it can't strand a
    // reservation that no process will ever release.
    await requireLocalRex();
    const argv = await childArgv(run, entry);
    const admitted = await admit(run, signal, progress, options.detach);
    if (admitted === "paused" || stopped(options)) return { run };
    const starting =
      admitted &&
      !signal?.aborted &&
      (await withAdmissionLock(async () => {
        if ((await readClaim(run.paths.claim)) || (await claimedAncestor(run))) return false;
        transition(run, "starting");
        await writeRun(run);
        return true;
      }));
    if (!starting) {
      await abandon(run, "cancelled");
      return { run };
    }
    progress(run);
    if (run.access === "inspect") {
      try {
        before = await captureFingerprint(run.checkoutRoot);
      } catch (error) {
        before = { version: 1, state: "unknown", reason: errorText(error) };
      }
      await atomicWrite(join(dirname(run.paths.run), "fingerprint-before.json"), before);
    }
    if (stopped(options)) return { run };
    let finishLaunch = () => {};
    const launchDone = new Promise<void>((resolve) => {
      finishLaunch = resolve;
    });
    launchWaits().set(run.id, launchDone);
    try {
      let launch: unknown;
      try {
        // Never retry: timeout or a malformed reply can mean the child was launched.
        await atomicWrite(launchMarker(run), { askedAt: Date.now() });
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
        run.location = { ...run.rex };
        const cancelled = await withProtocolLock(run.paths.lock, async () => {
          const winner = await readClaim(run.paths.claim);
          if (winner) return winner === "cancelled";
          return (await claimedAncestor(run)) ? claim(run.paths.claim, "cancelled") : false;
        });
        if (cancelled) {
          // Publish Rex identity only after cleanup, so ancestor cancellation keeps us alive.
          await closeBlock(run.location);
        }
      } catch (error) {
        run.diagnostic = `Uncertain Rex launch: ${errorText(error)}. Not retried.`;
        transition(run, "failed");
        await writeRun(run);
        return { run, checkout: await finishCheckout(run, before) };
      }
      await writeRun(run);
    } finally {
      finishLaunch();
      if (launchWaits().get(run.id) === launchDone) launchWaits().delete(run.id);
    }
  }
  if (stopped(options) || !run.rex) return { run };
  if (!before && run.access === "inspect") before = await savedBefore(run);
  events.watch(run.rex.blockId);
  if ((await readClaim(run.paths.claim)) === "cancelled" || (await claimedAncestor(run))) {
    await cancel(run);
    const location = await locate(run.rex.blockId, run.rex);
    if (location) await closeBlock(location);
  }
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
      if (stopped(options)) return { run, ...(result ? { result } : {}) };
      let changed = await cursor.drain(run);
      for (const event of pushed.splice(0)) {
        observeRexEvent(run, event);
        changed = true;
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
        const pending = parse(
          Type.Array(InboxMessage),
          await readJson(join(dirname(run.paths.run), "takeover-messages.json")).catch(
            (error: unknown) => {
              if (isMissing(error)) return [];
              throw error;
            },
          ),
        );
        run.unconsumedMessages = pending.map(({ id, text }) => ({ id, text }));
        transition(run, "taken_over");
        await writeRun(run);
        progress(run);
        return { run, checkout: await finishCheckout(run, before) };
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
        transition(run, "failed");
        break;
      }
      if (changed) await writeRun(run);
      const summary = JSON.stringify([run.lifecycle, run.waiting, run.queue]);
      if (summary !== shown) {
        progress(run);
        shown = summary;
      }
      await delay(200);
    }
    await writeRun(run);
    progress(run);
    const checkout = await finishCheckout(run, before);
    if (checkout && result) result = { ...result, checkout };
    return { run, ...(result ? { result } : {}), ...(checkout ? { checkout } : {}) };
  } finally {
    events.changes.off(blockId, listener);
  }
}

/** Returns once the run is admitted or queued. The shared lifecycle keeps watching. */
export function startBackground(
  run: RunRecord,
  entry: string,
  events: RexEvents,
  signal: AbortSignal | undefined,
  progress: Progress,
  options: WatchOptions,
): { ready: Promise<RunRecord>; done: Promise<{ run: RunRecord }> } {
  let release: (current: RunRecord) => void = () => {};
  let refuse: (error: unknown) => void = () => {};
  const ready = new Promise<RunRecord>((resolve, reject) => {
    release = resolve;
    refuse = reject;
  });
  // A resumed watch has no launch call waiting on ready; done carries the failure to it.
  ready.catch(() => undefined);
  let released = false;
  const note = (current: RunRecord) => {
    progress(current);
    if (!released && (current.queue !== null || current.lifecycle !== "admitting")) {
      released = true;
      release(current);
    }
  };
  const done = runForeground(run, entry, events, signal, note, options).then(
    (outcome) => {
      if (!released) {
        released = true;
        release(outcome.run);
      }
      return outcome;
    },
    (error: unknown) => {
      // A refusal before the run queues, such as a wait cycle, is the launch call's answer.
      if (!released) {
        released = true;
        refuse(error);
      }
      throw error;
    },
  );
  return { ready, done };
}
