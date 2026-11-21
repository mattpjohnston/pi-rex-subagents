import { execFile, spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { delimiter } from "node:path";
import { createInterface } from "node:readline";
import { Type } from "typebox";
import { parse, type Placement, type RexLocation } from "./store.ts";

export interface ProcessStatus {
  state: "live" | "exited" | "unknown";
  pid?: number;
  code?: number | null;
}

export interface BlockEvent {
  sessionId: string;
  blockId: string;
  name: string;
  payload: unknown;
}

const RexEventSchema = Type.Object({
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

/** Right-half floating pane over the parent's tab. */
const FLOAT_BOUNDS = [0.5, 0.04, 0.49, 0.92];

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected JSON object from Rex");
  }
  return value as Record<string, unknown>;
}

function rexBin(): string {
  return process.env.PI_SUBAGENTS_REX ?? "rex";
}

export async function rexCommand(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      rexBin(),
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

export async function rexJson(args: string[]): Promise<Record<string, unknown>> {
  const reply = await rexCommand(args);
  if (reply.code !== 0) throw new Error(`Rex exit ${reply.code}: ${reply.stderr.trim()}`);
  return asObject(JSON.parse(reply.stdout));
}

export async function requireLocalRex(): Promise<void> {
  const who = await rexJson(["whoami", "--json"]);
  if (typeof who.endpoint !== "string" || !who.endpoint.startsWith("unix:")) {
    throw new Error("pi-rex-subagents requires a local Rex server");
  }
}

export async function locateBlock(
  blockId: string,
  sessionHint?: string,
): Promise<RexLocation | null> {
  const trySession = async (sessionId: string): Promise<RexLocation | null> => {
    const reply = await rexCommand(["block", "inspect", "-s", sessionId, blockId, "--json"]);
    if (reply.code === 3) return null;
    if (reply.code !== 0) throw new Error(`Rex inspect exit ${reply.code}: ${reply.stderr.trim()}`);
    const data = asObject(JSON.parse(reply.stdout));
    const block = asObject(data.block);
    const windowId = typeof block.window_id === "string" ? block.window_id : null;
    return { sessionId, windowId, blockId };
  };

  if (sessionHint) {
    const found = await trySession(sessionHint);
    if (found) return found;
  }
  const listed = await rexJson(["ls", "--json"]);
  if (!Array.isArray(listed.sessions)) return null;
  for (const entry of listed.sessions) {
    const sessionId = asObject(entry).session_id;
    if (typeof sessionId !== "string" || sessionId === sessionHint) continue;
    const found = await trySession(sessionId);
    if (found) return found;
  }
  return null;
}

export async function openPane(options: {
  sessionId: string;
  parentBlockId?: string;
  label: string;
  cwd: string;
  placement: Placement;
  keepOpen: boolean;
  argv: string[];
}): Promise<RexLocation> {
  const { sessionId, parentBlockId, label, cwd, placement, keepOpen, argv } = options;

  if (placement === "split") {
    if (!parentBlockId) throw new Error("split placement requires REX_BLOCK");
    const args = [
      "split",
      "-s",
      sessionId,
      "-b",
      parentBlockId,
      "--split=right",
      "--focus=false",
      "--label",
      label,
      "-c",
      cwd,
      ...(keepOpen ? ["--keep-open"] : []),
      "--shell",
      "none",
      "--json",
      "--",
      ...argv,
    ];
    const reply = await rexJson(args);
    const blockId = Array.isArray(reply.block_ids) ? reply.block_ids[0] : undefined;
    if (typeof blockId !== "string") throw new Error("Rex split returned no block ID");
    const located = await locateBlock(blockId, sessionId);
    return located ?? { sessionId, windowId: null, blockId };
  }

  if (placement === "float") {
    if (!parentBlockId) throw new Error("float placement requires REX_BLOCK");
    const parent = await locateBlock(parentBlockId, sessionId);
    if (!parent?.windowId) throw new Error("Parent pane is not inside a Rex window");
    const reply = await rexJson([
      "api",
      "call",
      "session.new_layer",
      JSON.stringify({
        session_id: sessionId,
        window_id: parent.windowId,
        bounds: FLOAT_BOUNDS,
        focus: false,
        layout: {
          block: {
            flavor: "com.superlogical.terminal.shell",
            label,
            options: {
              shell: "none",
              command: argv,
              cwd,
              exit: { on_completion: !keepOpen },
              // session.new_layer doesn't inherit PATH like rex window new does.
              path_prepend: (process.env.PATH ?? "").split(delimiter).filter(Boolean),
            },
          },
        },
      }),
    ]);
    const blockId = Array.isArray(reply.block_ids) ? reply.block_ids[0] : undefined;
    if (typeof blockId !== "string") throw new Error("Rex new_layer returned no block ID");
    return { sessionId, windowId: parent.windowId, blockId };
  }

  const safeLabel = label.startsWith("-") ? ` ${label}` : label;
  const reply = await rexJson([
    "window",
    "new",
    "-s",
    sessionId,
    safeLabel,
    "--focus=false",
    "-c",
    cwd,
    ...(keepOpen ? ["--keep-open"] : []),
    "--shell",
    "none",
    "--json",
    "--",
    ...argv,
  ]);
  const blockId = Array.isArray(reply.block_ids) ? reply.block_ids[0] : undefined;
  if (typeof reply.window_id !== "string" || typeof blockId !== "string") {
    throw new Error("Rex window new returned invalid IDs");
  }
  const opened: RexLocation = { sessionId, windowId: reply.window_id, blockId };
  if (placement !== "detached") return opened;

  try {
    await rexJson([
      "api",
      "call",
      "session.detach_block",
      JSON.stringify({ session_id: sessionId, block_id: blockId }),
    ]);
    await rexJson([
      "api",
      "call",
      "session.set_block_label",
      JSON.stringify({ session_id: sessionId, block_id: blockId, label }),
    ]);
    return { sessionId, windowId: null, blockId };
  } catch {
    return opened;
  }
}

export async function observeProcess(
  location: RexLocation,
): Promise<{ location: RexLocation | null; process: ProcessStatus }> {
  try {
    const current = await locateBlock(location.blockId, location.sessionId);
    if (!current) return { location: null, process: { state: "exited", code: null } };
    const reply = await rexCommand([
      "block",
      "call",
      "-s",
      current.sessionId,
      "-b",
      current.blockId,
      "process",
    ]);
    if (reply.code !== 0) return { location: current, process: { state: "unknown" } };
    const data = asObject(JSON.parse(reply.stdout));
    if (data.last_exit && typeof data.last_exit === "object") {
      const code = asObject(data.last_exit).exit_code;
      return {
        location: current,
        process: { state: "exited", code: typeof code === "number" ? code : null },
      };
    }
    if (data.child && typeof data.child === "object") {
      const pid = asObject(data.child).pid;
      if (typeof pid === "number") return { location: current, process: { state: "live", pid } };
    }
    return { location: current, process: { state: "unknown" } };
  } catch {
    return { location, process: { state: "unknown" } };
  }
}

export async function closeBlock(location: RexLocation): Promise<void> {
  const reply = await rexCommand(["block", "close", "-s", location.sessionId, location.blockId]);
  if (reply.code !== 0 && reply.code !== 3) {
    throw new Error(`Rex block close exit ${reply.code}: ${reply.stderr.trim()}`);
  }
}

export async function focusBlock(location: RexLocation, anchorBlockId?: string): Promise<void> {
  let target = location;
  if (target.windowId === null) {
    if (!anchorBlockId) throw new Error("Detached pane needs REX_BLOCK to reattach as a split");
    await rexJson([
      "api",
      "call",
      "session.move_block",
      JSON.stringify({
        session_id: target.sessionId,
        block_id: target.blockId,
        anchor_block_id: anchorBlockId,
      }),
    ]);
    const relocated = await locateBlock(target.blockId, target.sessionId);
    if (!relocated?.windowId) return;
    target = relocated;
  }
  await rexJson([
    "api",
    "call",
    "session.focus_block",
    JSON.stringify({ session_id: target.sessionId, block_id: target.blockId }),
  ]);
  await rexCommand([
    "do",
    "session.select",
    `session_id=${target.sessionId}`,
    `window_id=${target.windowId}`,
    "--json",
  ]);
}

export async function screenTail(location: RexLocation, lines = 15): Promise<string | null> {
  try {
    const reply = await rexCommand([
      "capture",
      "-s",
      location.sessionId,
      "-b",
      location.blockId,
      "--trim",
      "--unwrap",
    ]);
    if (reply.code !== 0) return null;
    const text = reply.stdout.trimEnd().split("\n").slice(-lines).join("\n").trim();
    return text ? text.slice(-2000) : null;
  } catch {
    return null;
  }
}

export function parseBlockEvent(raw: unknown): BlockEvent | null {
  try {
    const event = parse(RexEventSchema, raw).payload;
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

/** Single push stream for all active subagents; started lazily, zero polling when idle. */
export class RexEvents {
  readonly changes = new EventEmitter();
  private child: ChildProcess | undefined;
  private reconnect: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private readonly watched = new Set<string>();

  watch(blockId: string): void {
    this.watched.add(blockId);
    this.start();
  }

  unwatch(blockId: string): void {
    this.watched.delete(blockId);
    if (this.watched.size === 0) {
      clearTimeout(this.reconnect);
      this.reconnect = undefined;
      this.child?.kill();
      this.child = undefined;
    }
  }

  private start(): void {
    if (this.child || this.stopped) return;
    const child = spawn(rexBin(), ["events", "--all", "--json"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    this.child = child;
    if (!child.stdout) return;
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      if (line.length > 1024 * 1024) return;
      try {
        const event = parseBlockEvent(JSON.parse(line));
        if (
          event &&
          this.watched.has(event.blockId) &&
          (event.name === "child_exited" || event.name === "program_status_changed")
        ) {
          this.changes.emit(event.blockId, event);
        }
      } catch {
        // Ignore unrelated server events.
      }
    });
    child.on("error", () => undefined);
    child.once("close", () => {
      lines.close();
      if (this.child !== child) return;
      this.child = undefined;
      if (!this.stopped && this.watched.size > 0) {
        this.reconnect = setTimeout(() => this.start(), 1000);
      }
    });
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.reconnect);
    this.child?.kill();
    this.child = undefined;
    this.watched.clear();
    this.changes.removeAllListeners();
  }
}
