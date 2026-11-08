import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { link, mkdir, open, readFile, rm, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Type } from "typebox";
import { atomicWrite, isMissing, parse, readJson, syncDirectory } from "./records.ts";

export type Claim = "result" | "taken_over" | "cancelled";
export async function readClaim(path: string): Promise<Claim | null> {
  let value: string;
  try {
    value = await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  if (value !== "result" && value !== "taken_over" && value !== "cancelled")
    throw new Error("Invalid claim file");
  return value;
}
export async function claim(path: string, winner: Claim): Promise<Claim> {
  const temp = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    const file = await open(temp, "wx", 0o600);
    try {
      await file.writeFile(winner);
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await link(temp, path);
      await syncDirectory(dirname(path));
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
    const actual = await readClaim(path);
    if (!actual) throw new Error("Claim disappeared");
    return actual;
  } finally {
    await unlink(temp).catch((error) => {
      if (!isMissing(error)) throw error;
    });
  }
}

const Holder = Type.Object(
  {
    pid: Type.Integer({ minimum: 1 }),
    startTime: Type.String({ minLength: 1 }),
    token: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);
export function processStart(pid: number): string | null {
  try {
    return (
      execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
        encoding: "utf8",
        timeout: 2000,
      }).trim() || null
    );
  } catch (error) {
    if (error instanceof Error && "status" in error && error.status === 1) return null;
    throw error;
  }
}
export async function withRunLock<T>(path: string, body: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + 10_000;
  while (true) {
    try {
      await mkdir(path, { mode: 0o700 });
      break;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      if (Date.now() >= deadline)
        throw new Error(`Run lock busy; stale recovery requires admission lock: ${path}`);
      await delay(25);
    }
  }
  try {
    const startTime = processStart(process.pid);
    if (!startTime) throw new Error("Cannot identify run lock holder");
    await atomicWrite(join(path, "holder.json"), {
      pid: process.pid,
      startTime,
      token: randomBytes(16).toString("hex"),
    });
    return await body();
  } finally {
    await rm(path, { recursive: true });
  }
}

/** Caller must hold the admission lock. Never infer death from age or a failed ps call. */
export async function recoverStaleRunLock(path: string): Promise<boolean> {
  try {
    let holder;
    try {
      holder = parse(Holder, await readJson(join(path, "holder.json")));
    } catch (error) {
      if (!isMissing(error)) throw error;
      // A suspended initializer is indistinguishable from a crash before metadata. Fail closed.
      return false;
    }
    if (holder) {
      const start = processStart(holder.pid);
      if (start === holder.startTime) return false;
      if (start === null) {
        try {
          process.kill(holder.pid, 0);
          return false;
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
        }
      }
    }
    await rm(path, { recursive: true });
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}
