import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, readdir, rename, stat, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type, type Static, type TSchema } from "typebox";
import { Check } from "typebox/value";
import { withAdmissionLock } from "./claims.ts";

const object = { additionalProperties: false };
const text = Type.String({ minLength: 1 });
const nullableText = Type.Union([text, Type.Null()]);
export const Thinking = Type.Union([
  Type.Literal("off"),
  Type.Literal("minimal"),
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("xhigh"),
  Type.Literal("max"),
]);
export const Settings = Type.Object({ provider: text, model: text, thinking: Thinking }, object);
export type ModelSettings = Static<typeof Settings>;
export const Outcome = Type.Union([
  Type.Literal("completed"),
  Type.Literal("failed"),
  Type.Literal("aborted"),
  Type.Literal("incomplete"),
  Type.Literal("taken_over"),
  Type.Literal("cancelled"),
]);
export type Outcome = Static<typeof Outcome>;
export const Lifecycle = Type.Union([
  Type.Literal("admitting"),
  Type.Literal("starting"),
  Type.Literal("running"),
  Outcome,
]);
export type Lifecycle = Static<typeof Lifecycle>;
export const ProcessObservation = Type.Union([
  Type.Object(
    { state: Type.Literal("live"), pid: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]) },
    object,
  ),
  Type.Object(
    { state: Type.Literal("exited"), code: Type.Union([Type.Integer(), Type.Null()]) },
    object,
  ),
  Type.Object(
    {
      state: Type.Literal("unresolved"),
      pid: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    },
    object,
  ),
  Type.Object({ state: Type.Literal("unknown") }, object),
]);
export type ProcessObservation = Static<typeof ProcessObservation>;
export const Location = Type.Object({ sessionId: text, windowId: text, blockId: text }, object);
export type Location = Static<typeof Location>;
export const Waiting = Type.Object(
  {
    source: Type.Union([Type.Literal("reporter"), Type.Literal("rex"), Type.Literal("trust")]),
    kind: text,
    title: text,
    since: Type.Number(),
  },
  object,
);
export const QueueState = Type.Object(
  {
    reason: Type.Union([Type.Literal("checkout"), Type.Literal("capacity")]),
    detail: text,
    since: Type.Number(),
  },
  object,
);
export type QueueState = Static<typeof QueueState>;
export const Activity = Type.Object(
  {
    effective: Type.Optional(Settings),
    parked: Type.Union([Type.Literal("foreground"), Type.Literal("settled"), Type.Null()]),
    readyToWake: Type.Boolean(),
    tools: Type.Array(Type.Object({ id: Type.String(), name: Type.String() }, object)),
    foreground: Type.Array(Type.String()),
  },
  object,
);
export type Activity = Static<typeof Activity>;
export const initialActivity = (): Activity => ({
  parked: null,
  readyToWake: false,
  tools: [],
  foreground: [],
});
export const RunRecord = Type.Object(
  {
    version: Type.Literal(1),
    id: Type.String({ pattern: "^[a-f0-9]{24}$" }),
    label: text,
    taskPath: text,
    cwd: text,
    checkoutRoot: text,
    access: Type.Union([Type.Literal("read"), Type.Literal("inspect"), Type.Literal("write")]),
    requested: Settings,
    effective: Settings,
    background: Type.Boolean(),
    continueFrom: Type.Union([
      Type.Object({ runId: text, sessionFile: text }, object),
      Type.Null(),
    ]),
    parentSessionId: text,
    rootParentSessionId: Type.Optional(text),
    activity: Type.Optional(Activity),
    parentRunId: nullableText,
    launchCaller: Type.Optional(text),
    depth: Type.Integer({ minimum: 0 }),
    rex: Type.Union([Location, Type.Null()]),
    location: Type.Union([Location, Type.Null()]),
    paths: Type.Object(
      {
        run: text,
        result: text,
        claim: text,
        lock: text,
        events: text,
        inbox: text,
        sessionDir: text,
      },
      object,
    ),
    lifecycle: Lifecycle,
    process: ProcessObservation,
    waiting: Type.Union([Waiting, Type.Null()]),
    queue: Type.Union([QueueState, Type.Null()]),
    sessionFile: nullableText,
    unconsumedMessages: Type.Optional(
      Type.Array(Type.Object({ id: text, text: Type.String() }, object)),
    ),
    diagnostic: nullableText,
    createdAt: Type.Number(),
    updatedAt: Type.Number(),
    loadedAt: Type.Union([Type.Number(), Type.Null()]),
    finishedAt: Type.Union([Type.Number(), Type.Null()]),
    tabClosedAt: Type.Optional(Type.Number()),
  },
  object,
);
export type RunRecord = Static<typeof RunRecord>;
export const CheckoutReport = Type.Object(
  {
    state: Type.Union([Type.Literal("clean"), Type.Literal("changed"), Type.Literal("unknown")]),
    paths: Type.Array(Type.String()),
    total: Type.Integer({ minimum: 0 }),
    reason: Type.Optional(Type.String()),
  },
  object,
);
export type CheckoutReport = Static<typeof CheckoutReport>;
export const ResultFile = Type.Object(
  {
    version: Type.Literal(1),
    runId: text,
    outcome: Type.Union([
      Type.Literal("completed"),
      Type.Literal("failed"),
      Type.Literal("aborted"),
      Type.Literal("incomplete"),
    ]),
    assistantText: Type.String(),
    sessionFile: nullableText,
    effective: Settings,
    stopReason: nullableText,
    reason: nullableText,
    finishedAt: Type.Number(),
    checkout: Type.Optional(CheckoutReport),
  },
  object,
);
export type ResultFile = Static<typeof ResultFile>;
export const ChildEvent = Type.Object(
  { type: text, at: Type.Number(), data: Type.Record(Type.String(), Type.Unknown()) },
  object,
);
export type ChildEvent = Static<typeof ChildEvent>;

export function parse<T extends TSchema>(schema: T, value: unknown): Static<T> {
  if (!Check(schema, value)) throw new Error("Invalid persisted subagent data");
  return value as Static<T>;
}
export function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
export function stateDir(): string {
  return resolve(process.env.PI_SUBAGENTS_STATE_DIR ?? join(getAgentDir(), "subagents"));
}
export function runDirectory(id: string): string {
  if (!/^[a-f0-9]{24}$/.test(id)) throw new Error("Invalid run ID");
  return join(stateDir(), "runs", id);
}
export function runPaths(dir: string): RunRecord["paths"] {
  return {
    run: join(dir, "run.json"),
    result: join(dir, "result.json"),
    claim: join(dir, "claim"),
    lock: join(dir, "lock"),
    events: join(dir, "events.jsonl"),
    inbox: join(dir, "inbox"),
    sessionDir: join(dir, "session"),
  };
}
export async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}
export async function syncDirectory(path: string): Promise<void> {
  const dir = await open(path, "r");
  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
}
export async function atomicWrite(path: string, value: unknown): Promise<void> {
  const temp = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    const file = await open(temp, "wx", 0o600);
    try {
      await file.writeFile(`${JSON.stringify(value)}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temp, path);
    await syncDirectory(dirname(path));
  } finally {
    await unlink(temp).catch((error) => {
      if (!isMissing(error)) throw error;
    });
  }
}
export async function readJson(path: string): Promise<unknown> {
  if ((await stat(path)).size > 64 * 1024 * 1024)
    throw new Error(`Persisted data too large: ${path}`);
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}
export async function readRun(id: string): Promise<RunRecord> {
  const record = parse(RunRecord, await readJson(join(runDirectory(id), "run.json")));
  if (record.id !== id) throw new Error("Run record ID mismatch");
  return record;
}
export async function writeRun(run: RunRecord): Promise<void> {
  await withAdmissionLock(async () => {
    // The reporter owns activity; a parent's older lifecycle observation must not erase it.
    const saved = await readRun(run.id).catch((error: unknown) => {
      if (!isMissing(error)) throw error;
      return null;
    });
    if (saved?.tabClosedAt !== undefined) run.tabClosedAt = saved.tabClosedAt;
    if (saved?.activity) run.activity = saved.activity;
    if (saved?.activity?.effective) run.effective = saved.activity.effective;
    run.updatedAt = Date.now();
    await atomicWrite(run.paths.run, parse(RunRecord, run));
  });
}
/** Admission lock serializes reporter activity with lifecycle observations from other processes. */
export async function updateActivity(
  id: string,
  update: (activity: Activity, run: RunRecord) => void,
): Promise<RunRecord> {
  return withAdmissionLock(async () => {
    const run = await readRun(id);
    const activity = run.activity ?? initialActivity();
    update(activity, run);
    run.activity = activity;
    run.updatedAt = Date.now();
    await atomicWrite(run.paths.run, parse(RunRecord, run));
    return run;
  });
}
export async function readResult(run: RunRecord): Promise<ResultFile> {
  const result = parse(ResultFile, await readJson(run.paths.result));
  if (result.runId !== run.id) throw new Error("Result run ID mismatch");
  return result;
}
export function isTerminal(state: Lifecycle): state is Outcome {
  return !["admitting", "starting", "running"].includes(state);
}
export function transition(run: RunRecord, next: Lifecycle): void {
  if (run.lifecycle === next) return;
  const allowed =
    run.lifecycle === "admitting"
      ? next === "starting" || next === "cancelled" || next === "failed"
      : run.lifecycle === "starting"
        ? next === "running" || isTerminal(next)
        : run.lifecycle === "running"
          ? isTerminal(next)
          : false;
  if (!allowed) throw new Error(`Invalid lifecycle transition ${run.lifecycle} -> ${next}`);
  run.lifecycle = next;
  if (isTerminal(next)) run.finishedAt = Date.now();
}
export async function listRuns(): Promise<RunRecord[]> {
  let ids: string[];
  try {
    ids = await readdir(join(stateDir(), "runs"));
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const records = await Promise.all(
    ids
      .filter((id) => /^[a-f0-9]{24}$/.test(id))
      .map(async (id) => {
        try {
          return await readRun(id);
        } catch (error) {
          if (isMissing(error)) return null;
          throw error;
        }
      }),
  );
  return records.filter((record) => record !== null);
}
