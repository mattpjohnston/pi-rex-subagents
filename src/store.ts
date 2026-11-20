import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, readdir, readFile, rename, rm, stat, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type, type Static, type TSchema } from "typebox";
import { Check } from "typebox/value";

const strict = { additionalProperties: false };
const nonEmpty = Type.String({ minLength: 1 });

export const Thinking = Type.Union([
  Type.Literal("off"),
  Type.Literal("minimal"),
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("xhigh"),
  Type.Literal("max"),
]);
export type Thinking = Static<typeof Thinking>;

export const Placement = Type.Union([
  Type.Literal("tab"),
  Type.Literal("split"),
  Type.Literal("float"),
  Type.Literal("detached"),
]);
export type Placement = Static<typeof Placement>;

export const Outcome = Type.Union([
  Type.Literal("completed"),
  Type.Literal("failed"),
  Type.Literal("aborted"),
  Type.Literal("incomplete"),
  Type.Literal("taken_over"),
  Type.Literal("cancelled"),
]);
export type Outcome = Static<typeof Outcome>;

export const ModelSettings = Type.Object(
  { provider: nonEmpty, model: nonEmpty, thinking: Thinking },
  strict,
);
export type ModelSettings = Static<typeof ModelSettings>;

export const RexLocation = Type.Object(
  { sessionId: nonEmpty, windowId: Type.Union([nonEmpty, Type.Null()]), blockId: nonEmpty },
  strict,
);
export type RexLocation = Static<typeof RexLocation>;

export const WorktreeInfo = Type.Object(
  {
    path: nonEmpty,
    branch: nonEmpty,
    base: nonEmpty,
    repository: nonEmpty,
    diffStat: Type.Optional(Type.String()),
    keptReason: Type.Optional(Type.String()),
    removedAt: Type.Optional(Type.Number()),
  },
  strict,
);
export type WorktreeInfo = Static<typeof WorktreeInfo>;

export const WaitingInfo = Type.Object(
  { kind: nonEmpty, title: Type.String(), since: Type.Number() },
  strict,
);
export type WaitingInfo = Static<typeof WaitingInfo>;

export const RunRecord = Type.Object(
  {
    version: Type.Literal(2),
    id: Type.String({ pattern: "^[a-f0-9]{16,24}$" }),
    label: nonEmpty,
    parentSessionId: nonEmpty,
    cwd: nonEmpty,
    repoRoot: Type.Union([nonEmpty, Type.Null()]),
    readOnly: Type.Boolean(),
    background: Type.Boolean(),
    placement: Placement,
    keepOpen: Type.Boolean(),
    model: ModelSettings,
    continueFrom: Type.Union([nonEmpty, Type.Null()]),
    worktree: Type.Optional(WorktreeInfo),
    rex: Type.Union([RexLocation, Type.Null()]),
    status: Type.Union([Type.Literal("queued"), Type.Literal("running"), Outcome]),
    waiting: Type.Union([WaitingInfo, Type.Null()]),
    sessionFile: Type.Union([nonEmpty, Type.Null()]),
    diagnostic: Type.Union([Type.String(), Type.Null()]),
    createdAt: Type.Number(),
    finishedAt: Type.Union([Type.Number(), Type.Null()]),
  },
  strict,
);
export type RunRecord = Static<typeof RunRecord>;

export const ResultFile = Type.Object(
  {
    version: Type.Literal(2),
    runId: nonEmpty,
    outcome: Type.Union([
      Type.Literal("completed"),
      Type.Literal("failed"),
      Type.Literal("aborted"),
      Type.Literal("incomplete"),
    ]),
    assistantText: Type.String(),
    stopReason: Type.Union([Type.String(), Type.Null()]),
    reason: Type.Union([Type.String(), Type.Null()]),
    sessionFile: Type.Union([nonEmpty, Type.Null()]),
    model: ModelSettings,
    finishedAt: Type.Number(),
  },
  strict,
);
export type ResultFile = Static<typeof ResultFile>;

const ConfigFile = Type.Object(
  {
    maxConcurrent: Type.Optional(Type.Integer({ minimum: 1 })),
    keepOpen: Type.Optional(Type.Boolean()),
    keepRunsForDays: Type.Optional(Type.Union([Type.Integer({ minimum: 1 }), Type.Literal(false)])),
  },
  strict,
);

export interface SubagentConfig {
  maxConcurrent: number;
  keepOpen: boolean;
  keepRunsForMs: number | null;
}

export interface RunPaths {
  dir: string;
  run: string;
  task: string;
  result: string;
  takenOver: string;
  sessionDir: string;
}

export function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function parse<T extends TSchema>(schema: T, value: unknown): Static<T> {
  if (!Check(schema, value)) throw new Error("Invalid subagent data");
  return value;
}

export function stateDir(): string {
  const override = process.env.PI_SUBAGENTS_STATE_DIR?.trim();
  return override ? resolve(override) : join(getAgentDir(), "subagents");
}

export function runPaths(id: string): RunPaths {
  const dir = join(stateDir(), "runs", id);
  return {
    dir,
    run: join(dir, "run.json"),
    task: join(dir, "task.md"),
    result: join(dir, "result.json"),
    takenOver: join(dir, "taken_over"),
    sessionDir: join(dir, "session"),
  };
}

export function isTerminal(status: RunRecord["status"]): status is Outcome {
  return status !== "queued" && status !== "running";
}

export async function ensurePrivateDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await ensurePrivateDir(dirname(path));
  const temp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const file = await open(temp, "wx", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await rename(temp, path);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}

export async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

export async function writeRun(run: RunRecord): Promise<void> {
  await atomicWriteJson(runPaths(run.id).run, run);
}

export async function readRun(id: string): Promise<RunRecord> {
  return parse(RunRecord, await readJson(runPaths(id).run));
}

export async function listRuns(): Promise<RunRecord[]> {
  const dir = join(stateDir(), "runs");
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const runs: RunRecord[] = [];
  for (const name of entries) {
    try {
      runs.push(parse(RunRecord, await readJson(join(dir, name, "run.json"))));
    } catch {
      // Ignore legacy v1 records or partial directories.
    }
  }
  return runs.sort((a, b) => a.createdAt - b.createdAt);
}

export async function readResult(id: string): Promise<ResultFile | null> {
  try {
    return parse(ResultFile, await readJson(runPaths(id).result));
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

export async function writeResult(result: ResultFile): Promise<void> {
  await atomicWriteJson(runPaths(result.runId).result, result);
}

export async function isTakenOver(id: string): Promise<boolean> {
  try {
    await stat(runPaths(id).takenOver);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

/** Atomically claims human takeover. Returns false if result.json already exists. */
export async function markTakenOver(id: string): Promise<"claimed" | "already_taken" | "finished"> {
  const paths = runPaths(id);
  if (await readResult(id)) return "finished";
  try {
    const file = await open(paths.takenOver, "wx", 0o600);
    try {
      await file.writeFile(`${new Date().toISOString()}\n`, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    return "claimed";
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      return "already_taken";
    }
    throw error;
  }
}

export async function readConfig(): Promise<SubagentConfig> {
  const path = join(stateDir(), "config.json");
  let raw: Static<typeof ConfigFile> = {};
  try {
    raw = parse(ConfigFile, await readJson(path));
  } catch (error) {
    if (!isMissing(error)) {
      throw new Error(`Invalid subagent config ${path}: ${errorText(error)}`, { cause: error });
    }
  }
  const keepDays = raw.keepRunsForDays ?? 30;
  return {
    maxConcurrent: raw.maxConcurrent ?? 4,
    keepOpen: raw.keepOpen ?? false,
    keepRunsForMs: keepDays === false ? null : keepDays * 86_400_000,
  };
}

export async function cleanupOldRuns(now = Date.now()): Promise<number> {
  const config = await readConfig();
  if (config.keepRunsForMs === null) return 0;
  let removed = 0;
  for (const run of await listRuns()) {
    if (!isTerminal(run.status) || run.status === "taken_over") continue;
    if (run.finishedAt === null || now - run.finishedAt < config.keepRunsForMs) continue;
    await rm(runPaths(run.id).dir, { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}
