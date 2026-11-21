import { constants, watch, type FSWatcher } from "node:fs";
import { access, realpath, stat, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { delimiter, isAbsolute, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  clampThinkingLevel,
  type Api,
  type Model,
  type ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import {
  closeBlock,
  observeProcess,
  openPane,
  requireLocalRex,
  screenTail,
  type BlockEvent,
  type RexEvents,
} from "./rex.ts";
import {
  Access,
  ensurePrivateDir,
  errorText,
  isTakenOver,
  isTerminal,
  Placement,
  readConfig,
  readResult,
  readRun,
  runPaths,
  stateDir,
  Thinking,
  writeRun,
  type ModelSettings,
  type ResultFile,
  type RunRecord,
} from "./store.ts";
import { createWorktree, findRepoRoot, finishWorktree } from "./worktree.ts";

export const RESULTS_TYPE = "subagent-results";
export const COALESCE_MS = 2_000;
const INLINE_TASK_MAX_BYTES = 32_768;

export const LaunchInput = Type.Object(
  {
    task: Type.String({ minLength: 1 }),
    label: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
    cwd: Type.Optional(Type.String()),
    access: Type.Optional(Access),
    worktree: Type.Optional(Type.Boolean()),
    background: Type.Optional(Type.Boolean()),
    placement: Type.Optional(Placement),
    continueFrom: Type.Optional(Type.String()),
    provider: Type.Optional(Type.String()),
    model: Type.Optional(Type.String()),
    thinking: Type.Optional(Thinking),
  },
  { additionalProperties: false },
);
export type LaunchInput = Static<typeof LaunchInput>;

export interface BranchNode {
  type: string;
  customType?: string;
  details?: unknown;
  message?: { role?: string; toolName?: string; details?: unknown };
}

export function resolveModelSettings(
  parent: ModelSettings | undefined,
  input: { provider?: string; model?: string; thinking?: ModelThinkingLevel },
  find: (provider: string, id: string) => Model<Api> | undefined,
): ModelSettings {
  let provider = input.provider?.trim() ?? parent?.provider ?? "";
  let id = input.model?.trim() ?? parent?.model ?? "";
  if (input.provider !== undefined && !provider) throw new Error("Empty provider override");
  if (input.model !== undefined && !id) throw new Error("Empty model override");
  if (input.model?.includes("/")) {
    const slash = id.indexOf("/");
    const prefix = id.slice(0, slash);
    const suffix = id.slice(slash + 1);
    if (!input.provider) {
      provider = prefix;
      id = suffix;
    } else if (prefix === provider) {
      id = suffix;
    }
  }
  const found = find(provider, id);
  if (!found) throw new Error(`Unknown model selection: ${provider}/${id}`);
  const thinking = clampThinkingLevel(found, input.thinking ?? parent?.thinking ?? "off");
  return { provider, model: id, thinking };
}

export async function findExecutable(name: string): Promise<string> {
  const candidates =
    isAbsolute(name) || name.includes("/")
      ? [resolve(name)]
      : (process.env.PATH ?? "").split(delimiter).map((dir) => resolve(dir, name));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // Try next PATH entry.
    }
  }
  throw new Error(`Executable not found on PATH: ${name}`);
}

export async function resolveWorkingDir(parentCwd: string, requested?: string): Promise<string> {
  const target = await realpath(resolve(parentCwd, requested ?? "."));
  if (!(await stat(target)).isDirectory()) throw new Error(`Not a directory: ${target}`);
  return target;
}

export async function buildChildArgv(
  run: RunRecord,
  entry: string,
  task?: string,
  continueSessionFile?: string,
): Promise<string[]> {
  const env = [`PI_SUBAGENTS_RUN_ID=${run.id}`];
  // Always pass the resolved absolute state dir so a child in another cwd finds the same run dir.
  if (process.env.PI_SUBAGENTS_STATE_DIR?.trim()) {
    env.push(`PI_SUBAGENTS_STATE_DIR=${stateDir()}`);
  }
  if (process.env.PI_CODING_AGENT_DIR?.trim()) {
    env.push(`PI_CODING_AGENT_DIR=${resolve(process.env.PI_CODING_AGENT_DIR)}`);
  }
  const piBin = await findExecutable(process.env.PI_SUBAGENTS_PI ?? "pi");
  const paths = runPaths(run.id);
  const args = [
    piBin,
    "--model",
    `${run.model.provider}/${run.model.model}`,
    "--thinking",
    run.model.thinking,
    "--session-dir",
    paths.sessionDir,
    "--name",
    run.label,
  ];
  if (run.access === "read") {
    // Keep extensions loaded so custom providers (e.g. claude-bridge) still work,
    // while restricting callable tools to read-only built-ins and disabling MCP.
    args.push("--tools", "read,grep,find,ls", "--no-mcp");
  } else if (run.access === "inspect") {
    // Keep bash, MCP, and extensions for read-only-by-intent investigations (e.g. why/reflect).
    args.push("--exclude-tools", "edit,write");
  }
  args.push("-e", entry);
  if (continueSessionFile) args.push("--fork", continueSessionFile);
  // Pass normal prompts directly so the child Rex tab displays clean text rather than
  // Pi's <file name=".../task.md"> attachment wrapper; fall back to @task.md for huge, @, or / tasks
  // (Pi interprets leading "/" as a slash command).
  const canInline =
    task !== undefined &&
    Buffer.byteLength(task) <= INLINE_TASK_MAX_BYTES &&
    !task.startsWith("@") &&
    !task.trimStart().startsWith("/") &&
    !task.includes("\0");
  if (canInline) args.push("--", task);
  else args.push(`@${paths.task}`);
  return ["/usr/bin/env", ...env, ...args];
}

export function cappedText(text: string): string {
  const notice = "[Output truncated; full transcript is in the child session file above.]\n";
  const first = truncateHead(text, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
  if (!first.truncated) return first.content;
  return (
    notice +
    truncateHead(text, {
      maxBytes: DEFAULT_MAX_BYTES - Buffer.byteLength(notice),
      maxLines: DEFAULT_MAX_LINES - 1,
    }).content
  );
}

export function formatRunResult(run: RunRecord, result?: ResultFile | null): string {
  const lines = [
    `Run: ${run.id} (${run.label})`,
    `Outcome: ${run.status}`,
    `Model: ${run.model.provider}/${run.model.model} (thinking: ${run.model.thinking})`,
    `Session: ${result?.sessionFile ?? run.sessionFile ?? runPaths(run.id).sessionDir}`,
  ];
  if (run.rex) {
    lines.push(`Rex: session=${run.rex.sessionId} block=${run.rex.blockId}`);
  }
  if (run.worktree) {
    const wt = run.worktree;
    if (wt.removedAt !== undefined) {
      lines.push(
        `Worktree: ${wt.path} (branch ${wt.branch}, removed: clean with no unmerged work)`,
      );
    } else {
      lines.push(
        `Worktree: ${wt.path} (branch ${wt.branch}, kept${wt.keptReason ? `: ${wt.keptReason}` : ""})`,
      );
      if (wt.diffStat) lines.push(`Diff stat:\n${wt.diffStat}`);
    }
  }
  if (run.diagnostic) lines.push(`Diagnostic: ${run.diagnostic}`);
  if (result?.reason) lines.push(`Reason: ${result.reason}`);
  if (result?.assistantText) lines.push("", result.assistantText);
  return cappedText(lines.join("\n"));
}

export interface BatchSummary {
  runId: string;
  label: string;
  status: RunRecord["status"];
}

export function packBatchResults(
  items: readonly { run: RunRecord; result: ResultFile | null }[],
  maxBytes = DEFAULT_MAX_BYTES,
  maxLines = DEFAULT_MAX_LINES,
): { content: string; runIds: string[]; summaries: BatchSummary[] } {
  const fits = (text: string) =>
    Buffer.byteLength(text) <= maxBytes && text.split("\n").length <= maxLines;

  const parts: string[] = [];
  const runIds: string[] = [];
  const summaries: BatchSummary[] = [];
  for (const { run, result } of items) {
    const full = formatRunResult(run, result);
    const short = [
      `Run: ${run.id} (${run.label})`,
      `Outcome: ${run.status}`,
      `Result: ${runPaths(run.id).result}`,
      `Session: ${result?.sessionFile ?? run.sessionFile ?? runPaths(run.id).sessionDir}`,
    ].join("\n");
    const withFull = [...parts, full].join("\n\n---\n\n");
    if (fits(withFull)) {
      parts.push(full);
      runIds.push(run.id);
      summaries.push({ runId: run.id, label: run.label, status: run.status });
      continue;
    }
    const withShort = [...parts, short].join("\n\n---\n\n");
    if (!fits(withShort)) break;
    parts.push(short);
    runIds.push(run.id);
    summaries.push({ runId: run.id, label: run.label, status: run.status });
  }
  return { content: parts.join("\n\n---\n\n"), runIds, summaries };
}

export function deliveredRunIds(branch: readonly BranchNode[]): Set<string> {
  const ids = new Set<string>();
  const addFrom = (details: unknown) => {
    if (!details || typeof details !== "object" || !("runIds" in details)) return;
    if (Array.isArray(details.runIds)) {
      for (const id of details.runIds) if (typeof id === "string") ids.add(id);
    }
  };
  for (const entry of branch) {
    if (entry.type === "custom_message" && entry.customType === RESULTS_TYPE) {
      addFrom(entry.details);
    }
    if (entry.message?.role === "toolResult" && entry.message.toolName === "subagent_control") {
      addFrom(entry.message.details);
    }
  }
  return ids;
}

export function coalesceDelayMs(): number {
  const raw = process.env.PI_SUBAGENTS_COALESCE_MS;
  if (raw === undefined) return COALESCE_MS;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 60_000 ? parsed : COALESCE_MS;
}

/** Simple in-memory concurrency limiter for a parent Pi process. */
export class ConcurrencyGate {
  private active = 0;
  private readonly queue: (() => void)[] = [];

  /** Accounts for an already-running child reattached on reload/resume. */
  holdExisting(): () => void {
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      const next = this.queue.shift();
      next?.();
    };
  }

  async acquire(maxConcurrent: number, signal?: AbortSignal): Promise<() => void> {
    while (this.active >= maxConcurrent) {
      if (signal?.aborted) throw new Error("Aborted before launch");
      await new Promise<void>((resolve, reject) => {
        const entry = () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        };
        const onAbort = () => {
          const idx = this.queue.indexOf(entry);
          if (idx >= 0) this.queue.splice(idx, 1);
          reject(new Error("Aborted while queued"));
        };
        this.queue.push(entry);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
    if (signal?.aborted) throw new Error("Aborted before launch");
    return this.holdExisting();
  }
}

export interface RunOutcome {
  run: RunRecord;
  result: ResultFile | null;
}

export interface ActiveRun {
  run: RunRecord;
  done: Promise<RunOutcome>;
  cancel: () => Promise<RunRecord["status"]>;
  /** Stops local watchers/timers without cancelling the child process (for reload/switch). */
  detach: () => void;
}

/**
 * Prepares a run record, creates optional worktree, spawns Pi in Rex, and returns
 * a handle that resolves when the subagent completes, is taken over, or is cancelled.
 */
export async function launchSubagent(options: {
  input: LaunchInput;
  ctx: ExtensionContext;
  entry: string;
  events: RexEvents;
  gate: ConcurrencyGate;
  liveRuns: Map<string, ActiveRun>;
  reservedRepos: Map<string, { id: string; label: string }>;
  signal?: AbortSignal;
  onChange?: (run: RunRecord) => void;
  onWaiting?: (run: RunRecord) => void;
}): Promise<ActiveRun> {
  const { input, ctx, entry, events, gate, liveRuns, reservedRepos, signal, onChange, onWaiting } =
    options;
  if (!input.task.trim()) throw new Error("Subagent task must not be empty");
  const sessionId = process.env.REX_SESSION;
  if (!sessionId) throw new Error("REX_SESSION is not set; start Pi inside Rex to use subagents");

  await requireLocalRex();
  const config = await readConfig();
  const parentModel: ModelSettings | undefined = ctx.model
    ? { provider: ctx.model.provider, model: ctx.model.id, thinking: ctx.thinkingLevel ?? "off" }
    : undefined;
  const model = resolveModelSettings(parentModel, input, (p, id) => ctx.modelRegistry.find(p, id));
  const requestedCwd = await resolveWorkingDir(ctx.cwd, input.cwd);
  const baseRepo = await findRepoRoot(requestedCwd);
  const runAccess = input.access ?? "write";

  let continueSessionFile: string | undefined;
  if (input.continueFrom) {
    const prev = await readRun(input.continueFrom);
    if (!isTerminal(prev.status)) throw new Error(`Run ${prev.id} is still running`);
    const prevResult = await readResult(prev.id);
    const sessionFile = prevResult?.sessionFile ?? prev.sessionFile;
    if (!sessionFile) throw new Error(`Run ${prev.id} has no saved session to continue from`);
    continueSessionFile = sessionFile;
  }

  const id = randomBytes(10).toString("hex");
  const label = input.label?.trim() || `sub-${id.slice(0, 6)}`;
  const placement = input.placement ?? config.placement;
  const keepOpen = config.keepOpen;

  // Synchronous reservation eliminates the parallel-call TOCTOU race for non-worktree writers.
  let reservedRepoKey: string | null = null;
  if (runAccess === "write" && !input.worktree && baseRepo) {
    const existing = reservedRepos.get(baseRepo);
    if (existing) {
      throw new Error(
        `Another writer (${existing.label}, ${existing.id}) is already running in ${baseRepo}. Pass worktree: true for parallel writers, or access: "inspect" / "read" for non-editing work.`,
      );
    }
    reservedRepos.set(baseRepo, { id, label });
    reservedRepoKey = baseRepo;
  }

  const releaseRepo = () => {
    if (reservedRepoKey && reservedRepos.get(reservedRepoKey)?.id === id) {
      reservedRepos.delete(reservedRepoKey);
    }
  };

  let effectiveCwd = requestedCwd;
  let worktree: RunRecord["worktree"];
  let releaseSlot: (() => void) | undefined;
  let run: RunRecord | undefined;

  try {
    if (input.worktree) {
      if (!baseRepo) throw new Error(`worktree: true requires a git repository (${requestedCwd})`);
      const created = await createWorktree(baseRepo, requestedCwd, label, id);
      worktree = created.worktree;
      effectiveCwd = created.cwd;
    }

    const paths = runPaths(id);
    await ensurePrivateDir(stateDir());
    await ensurePrivateDir(paths.dir);
    await ensurePrivateDir(paths.sessionDir);
    await writeFile(paths.task, `# Delegated task\n\n${input.task}\n`, { mode: 0o600 });

    run = {
      version: 2,
      id,
      label,
      parentSessionId: ctx.sessionManager.getSessionId(),
      cwd: effectiveCwd,
      repoRoot: worktree ? worktree.path : baseRepo,
      access: runAccess,
      background: input.background === true,
      placement,
      keepOpen,
      model,
      continueFrom: input.continueFrom ?? null,
      ...(worktree ? { worktree } : {}),
      rex: null,
      status: "queued",
      waiting: null,
      sessionFile: null,
      diagnostic: null,
      createdAt: Date.now(),
      finishedAt: null,
    };
    await writeRun(run);

    releaseSlot = await gate.acquire(config.maxConcurrent, signal);
    if (signal?.aborted) throw new Error("Aborted before launch");

    const argv = await buildChildArgv(run, entry, input.task, continueSessionFile);
    run.rex = await openPane({
      sessionId,
      parentBlockId: process.env.REX_BLOCK,
      label,
      cwd: effectiveCwd,
      placement,
      keepOpen,
      argv,
    });
    run.status = "running";
    await writeRun(run);
  } catch (error) {
    releaseSlot?.();
    releaseRepo();
    if (run) {
      if (run.worktree) run.worktree = await finishWorktree(run.worktree);
      run.status = signal?.aborted ? "cancelled" : "failed";
      run.diagnostic = errorText(error);
      run.finishedAt = Date.now();
      await writeRun(run);
    } else if (worktree) {
      await finishWorktree(worktree);
    }
    throw error;
  }

  return attachToRun({
    run,
    events,
    liveRuns,
    releaseSlot,
    releaseRepo,
    signal: run.background ? undefined : signal,
    onChange,
    onWaiting,
  });
}

/** Attaches event-driven watching to an already-started run (used on launch and reload/resume). */
export function attachToRun(options: {
  run: RunRecord;
  events: RexEvents;
  liveRuns: Map<string, ActiveRun>;
  releaseSlot?: () => void;
  releaseRepo?: () => void;
  signal?: AbortSignal;
  onChange?: (run: RunRecord) => void;
  onWaiting?: (run: RunRecord) => void;
}): ActiveRun {
  const { run, events, liveRuns, releaseSlot, releaseRepo, signal, onChange, onWaiting } = options;
  const blockId = run.rex?.blockId;
  let cancelled = false;
  let finished = false;
  let checking = false;
  let recheckNeeded = false;
  let cancelPromise: Promise<RunRecord["status"]> | undefined;
  let settleDone: (outcome: RunOutcome) => void = () => undefined;
  let rejectDone: (error: unknown) => void = () => undefined;
  const done = new Promise<RunOutcome>((resolve, reject) => {
    settleDone = resolve;
    rejectDone = reject;
  });

  const paths = runPaths(run.id);
  let watcher: FSWatcher | undefined;
  let fallbackTimer: ReturnType<typeof setInterval> | undefined;

  const cleanup = () => {
    watcher?.close();
    watcher = undefined;
    clearInterval(fallbackTimer);
    fallbackTimer = undefined;
    if (blockId) {
      events.changes.off(blockId, onRexEvent);
      events.unwatch(blockId);
    }
    signal?.removeEventListener("abort", onAbort);
    liveRuns.delete(run.id);
    releaseRepo?.();
    releaseSlot?.();
  };

  const detach = () => {
    if (finished) return;
    finished = true;
    cleanup();
  };

  const finalize = async (forced?: {
    status: RunRecord["status"];
    result?: ResultFile | null;
    diagnostic?: string | null;
  }) => {
    if (finished) return;
    finished = true;
    cleanup();
    try {
      const result = forced?.result !== undefined ? forced.result : await readResult(run.id);
      const taken = await isTakenOver(run.id);
      run.waiting = null;

      if (result && !taken) {
        run.sessionFile = result.sessionFile;
        run.model = result.model;
      }

      if (taken && !result) {
        run.status = "taken_over";
      } else if (forced) {
        run.status = forced.status;
        if (forced.diagnostic) run.diagnostic = forced.diagnostic;
      } else if (result) {
        run.status = result.outcome;
      } else if (cancelled) {
        run.status = "cancelled";
      } else {
        run.status = "failed";
        const tail = run.rex ? await screenTail(run.rex) : null;
        run.diagnostic = tail
          ? `Exited without writing a result.\nLast terminal lines:\n${tail}`
          : "Exited without writing a result.";
      }

      if (run.worktree && run.status !== "taken_over") {
        run.worktree = await finishWorktree(run.worktree);
      }
      run.finishedAt = Date.now();
      await writeRun(run);
      onChange?.(run);
      settleDone({ run, result });
    } catch (error) {
      rejectDone(error);
    }
  };

  const checkDiskAndProcess = async () => {
    if (finished) return;
    if (checking) {
      recheckNeeded = true;
      return;
    }
    checking = true;
    try {
      do {
        recheckNeeded = false;
        if (finished) return;
        if (await isTakenOver(run.id)) {
          await finalize({ status: "taken_over", result: null });
          return;
        }
        const result = await readResult(run.id);
        if (result) {
          if (run.rex) {
            const deadline = Date.now() + 3_000;
            while (Date.now() < deadline && !finished) {
              const obs = await observeProcess(run.rex);
              if (obs.process.state === "exited") break;
              await delay(150);
            }
          }
          await finalize({ status: result.outcome, result });
          return;
        }
        if (run.rex) {
          const obs = await observeProcess(run.rex);
          if (obs.process.state === "exited") {
            await finalize();
            return;
          }
        }
      } while (recheckNeeded && !finished);
    } finally {
      checking = false;
    }
  };

  const onRexEvent = (event: BlockEvent) => {
    if (finished) return;
    if (event.name === "child_exited") {
      void checkDiskAndProcess();
      return;
    }
    if (event.name === "program_status_changed") {
      const payload =
        event.payload && typeof event.payload === "object"
          ? (event.payload as Record<string, unknown>)
          : null;
      const rec =
        payload?.record && typeof payload.record === "object"
          ? (payload.record as Record<string, unknown>)
          : null;
      if (rec?.state === "blocked") {
        run.waiting = {
          kind: typeof rec.kind === "string" ? rec.kind : "input",
          title:
            typeof rec.msg === "string"
              ? rec.msg
              : typeof rec.title === "string"
                ? rec.title
                : "Waiting for input",
          since: Date.now(),
        };
        void writeRun(run);
        onWaiting?.(run);
        onChange?.(run);
      } else if (run.waiting) {
        run.waiting = null;
        void writeRun(run);
        onChange?.(run);
      }
    }
  };

  const cancelRun = (): Promise<RunRecord["status"]> => {
    if (cancelPromise) return cancelPromise;
    cancelPromise = (async () => {
      if (finished) return run.status;
      if (await isTakenOver(run.id)) {
        await finalize({ status: "taken_over", result: null });
        return "taken_over";
      }
      cancelled = true;
      if (run.rex) {
        const obs = await observeProcess(run.rex);
        if (obs.process.state === "live" && obs.process.pid) {
          let signalled = false;
          try {
            process.kill(obs.process.pid, "SIGTERM");
            signalled = true;
          } catch {
            // Process already exited.
          }
          if (signalled) {
            let exited = false;
            const deadline = Date.now() + 5_000;
            while (Date.now() < deadline) {
              if ((await observeProcess(run.rex)).process.state === "exited") {
                exited = true;
                break;
              }
              await delay(200);
            }
            if (!exited) {
              try {
                process.kill(obs.process.pid, "SIGKILL");
              } catch {
                // Already exited.
              }
            }
          }
        }
        if (!run.keepOpen && obs.location) {
          await closeBlock(obs.location).catch(() => undefined);
        }
        const after = await observeProcess(run.rex);
        if (after.process.state !== "exited") {
          // Rex couldn't confirm process exit (e.g. unreachable with keepOpen: true); keep reservation
          // and allow retrying cancel instead of pretending the writer stopped.
          cancelled = false;
          cancelPromise = undefined;
          return run.status;
        }
      }
      await finalize({ status: "cancelled", result: null });
      return "cancelled";
    })();
    return cancelPromise;
  };

  const onAbort = () => {
    void cancelRun();
  };

  if (blockId) {
    events.watch(blockId);
    events.changes.on(blockId, onRexEvent);
  }
  try {
    watcher = watch(paths.dir, () => {
      void checkDiskAndProcess();
    });
  } catch {
    // Fallback interval covers environments where fs.watch isn't available.
  }
  // Lightweight safety check ONLY while this run is actively live (cleared immediately on exit).
  fallbackTimer = setInterval(() => {
    void checkDiskAndProcess();
  }, 1500);
  signal?.addEventListener("abort", onAbort, { once: true });

  const handle: ActiveRun = { run, done, cancel: cancelRun, detach };
  liveRuns.set(run.id, handle);
  onChange?.(run);
  if (signal?.aborted) {
    void cancelRun();
  } else {
    void checkDiskAndProcess();
  }
  return handle;
}
