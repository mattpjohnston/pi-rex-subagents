import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";
import { Type } from "typebox";
import { parse, type Location, type ProcessObservation } from "./records.ts";

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected Rex object");
  return value as Record<string, unknown>;
}
export async function command(
  args: string[],
  executable = process.env.PI_SUBAGENTS_REX ?? "rex",
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      args,
      { encoding: "utf8", timeout: 15_000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error && (error.killed || typeof error.code !== "number")) {
          reject(error);
          return;
        }
        resolve({ code: typeof error?.code === "number" ? error.code : 0, stdout, stderr });
      },
    );
  });
}
export async function rexJson(args: string[]): Promise<unknown> {
  const reply = await command(args);
  if (reply.code !== 0) throw new Error(`Rex exit ${reply.code}: ${reply.stderr}`);
  return JSON.parse(reply.stdout) as unknown;
}
export async function requireLocalRex(): Promise<void> {
  const who = object(await rexJson(["whoami", "--json"]));
  if (typeof who.endpoint !== "string" || !who.endpoint.startsWith("unix:"))
    throw new Error(
      "Subagents require a local Rex server; remote artifact transport is unsupported",
    );
}

/** Resolve by stable block ID, including after moves to another session. No label fallback. */
export async function locate(blockId: string, hint?: Location): Promise<Location | null> {
  if (hint) {
    const direct = await command(["block", "inspect", "-s", hint.sessionId, blockId, "--json"]);
    if (direct.code === 0) {
      const data = object(JSON.parse(direct.stdout));
      const block = object(data.block);
      if (typeof data.session_id === "string" && typeof block.window_id === "string")
        return { sessionId: data.session_id, windowId: block.window_id, blockId };
      throw new Error("Invalid Rex block location");
    }
    if (direct.code !== 3) throw new Error(`Rex unreachable or ambiguous: exit ${direct.code}`);
  }
  const list = object(await rexJson(["ls", "--json"]));
  if (!Array.isArray(list.sessions)) throw new Error("Invalid Rex sessions");
  for (const entry of list.sessions) {
    const session = object(entry);
    if (typeof session.session_id !== "string") throw new Error("Invalid Rex session ID");
    if (session.session_id === hint?.sessionId) continue;
    const reply = await command(["block", "inspect", "-s", session.session_id, blockId, "--json"]);
    if (reply.code === 3) continue;
    if (reply.code !== 0) throw new Error(`Rex unreachable or ambiguous: exit ${reply.code}`);
    const data = object(JSON.parse(reply.stdout));
    const block = object(data.block);
    if (typeof block.window_id !== "string") throw new Error("Invalid Rex window ID");
    return { sessionId: session.session_id, windowId: block.window_id, blockId };
  }
  return null;
}
export async function observeProcess(
  location: Location,
): Promise<{ location: Location | null; process: ProcessObservation }> {
  try {
    const current = await locate(location.blockId, location);
    if (!current) return { location: null, process: { state: "exited", code: null } };
    const reply = await command([
      "block",
      "call",
      "-s",
      current.sessionId,
      "-b",
      current.blockId,
      "process",
    ]);
    if (reply.code === 3) return { location: current, process: { state: "unknown" } };
    if (reply.code !== 0) return { location: current, process: { state: "unknown" } };
    const data = object(JSON.parse(reply.stdout));
    if (data.last_exit !== null && data.last_exit !== undefined) {
      const exit = object(data.last_exit);
      if (typeof exit.exit_code === "number")
        return { location: current, process: { state: "exited", code: exit.exit_code } };
    }
    if (data.child) {
      const child = object(data.child);
      if (typeof child.pid === "number")
        return { location: current, process: { state: "live", pid: child.pid } };
    }
    return { location: current, process: { state: "unknown" } };
  } catch {
    return { location, process: { state: "unknown" } };
  }
}

export const RexEvent = Type.Object({
  type: Type.Literal("session_event"),
  payload: Type.Object({
    session_id: Type.String(),
    event: Type.Object({
      type: Type.Literal("block_event"),
      payload: Type.Object({
        block_id: Type.String(),
        name: Type.String(),
        payload: Type.Unknown(),
      }),
    }),
  }),
});
export type BlockEvent = { sessionId: string; blockId: string; name: string; payload: unknown };
export function parseBlockEvent(raw: unknown): BlockEvent | null {
  try {
    const event = parse(RexEvent, raw).payload;
    return {
      sessionId: event.session_id,
      blockId: event.event.payload.block_id,
      name: event.event.payload.name,
      payload: event.event.payload.payload,
    };
  } catch {
    return null;
  }
}

/** One push stream for a parent runtime; local file polling never polls terminal status. */
export class RexEvents {
  readonly changes = new EventEmitter();
  private child: ChildProcess | undefined;
  private stopped = false;
  private reconnect: ReturnType<typeof setTimeout> | undefined;
  private readonly blocks = new Set<string>();
  connected = false;

  watch(blockId: string): void {
    this.blocks.add(blockId);
  }
  start(): void {
    if (this.child || this.stopped) return;
    const child = spawn(process.env.PI_SUBAGENTS_REX ?? "rex", ["events", "--all", "--json"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    this.child = child;
    this.connected = true;
    if (!child.stdout) throw new Error("Rex stream stdout unavailable");
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      if (line.length > 1024 * 1024) return;
      try {
        const event = parseBlockEvent(JSON.parse(line));
        if (
          event &&
          this.blocks.has(event.blockId) &&
          ["child_exited", "program_status_changed"].includes(event.name)
        )
          this.changes.emit(event.blockId, event);
      } catch {
        /* Unrelated server event. Reconciliation remains authoritative. */
      }
    });
    child.on("error", () => {
      this.connected = false;
    });
    child.once("close", () => {
      lines.close();
      this.child = undefined;
      this.connected = false;
      this.changes.emit("disconnected");
      if (!this.stopped) this.reconnect = setTimeout(() => this.start(), 1000);
    });
  }
  stop(): void {
    this.stopped = true;
    clearTimeout(this.reconnect);
    this.child?.kill();
    this.changes.removeAllListeners();
  }
}

/** Exact block only: never fall back to the former window, pane focus, or a label. */
export async function closeBlock(location: Location): Promise<void> {
  const reply = await command(["block", "close", "-s", location.sessionId, location.blockId]);
  if (reply.code !== 0 && reply.code !== 3)
    throw new Error(`Rex block close exit ${reply.code}: ${reply.stderr}`);
}
