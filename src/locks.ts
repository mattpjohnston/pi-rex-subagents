import { execFile, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { readFileSync, rmdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

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
function code(error: unknown, values: string[]): boolean {
  return error instanceof Error && "code" in error && values.includes(String(error.code));
}
export async function withLock<T>(
  path: string,
  body: () => Promise<T>,
  recover: () => Promise<unknown>,
): Promise<T> {
  const temp = `${path}.${process.pid}.${randomBytes(16).toString("hex")}.tmp`;
  await mkdir(temp, { mode: 0o700 });
  try {
    const startTime = processStart(process.pid);
    if (!startTime) throw new Error("Cannot identify lock holder");
    const file = await open(join(temp, "holder.json"), "wx", 0o600);
    try {
      await file.writeFile(
        JSON.stringify({ pid: process.pid, startTime, token: randomBytes(16).toString("hex") }),
      );
      await file.sync();
    } finally {
      await file.close();
    }
    let lastRecovery = 0;
    while (true) {
      try {
        await rename(temp, path);
        break;
      } catch (error) {
        if (!code(error, ["EEXIST", "ENOTEMPTY"])) throw error;
        if (Date.now() - lastRecovery >= 500) {
          await recover();
          lastRecovery = Date.now();
        }
        await delay(25);
      }
    }
    try {
      return await body();
    } finally {
      // Remove metadata only after the entire directory has left the shared pathname.
      // Otherwise a contender can rename onto the briefly empty directory during rm.
      await rename(path, temp);
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

/** Runs in a short-lived helper whose cwd pins the original directory inode. */
function reapAtCwd(sharedPath: string): boolean {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync("holder.json", "utf8")) as unknown;
  } catch (error) {
    if (code(error, ["ENOENT"])) return false;
    throw error;
  }
  if (
    !value ||
    typeof value !== "object" ||
    !("pid" in value) ||
    typeof value.pid !== "number" ||
    !Number.isSafeInteger(value.pid) ||
    value.pid < 1 ||
    !("startTime" in value) ||
    typeof value.startTime !== "string" ||
    !value.startTime ||
    !("token" in value) ||
    typeof value.token !== "string" ||
    !value.token
  )
    throw new Error("Invalid lock holder");
  const start = processStart(value.pid);
  if (start === value.startTime) return false;
  if (start === null) {
    try {
      process.kill(value.pid, 0);
      return false;
    } catch (error) {
      if (!code(error, ["ESRCH"])) throw error;
    }
  }
  // Relative unlink targets the pinned inode even if a different reaper already removed
  // its name. rmdir, never recursive rm, cannot delete a new nonempty lock at sharedPath.
  try {
    unlinkSync("holder.json");
  } catch (error) {
    if (!code(error, ["ENOENT"])) throw error;
  }
  try {
    rmdirSync(sharedPath);
  } catch (error) {
    if (!code(error, ["ENOENT", "ENOTEMPTY", "EEXIST"])) throw error;
  }
  return true;
}
export async function recoverStaleLock(path: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [fileURLToPath(import.meta.url), "--recover", path],
      { cwd: path, encoding: "utf8", timeout: 5000 },
      (error, stdout, stderr) => {
        if (error) {
          if (code(error, ["ENOENT"])) resolve(false);
          else
            reject(new Error(`Lock recovery failed: ${stderr || error.message}`, { cause: error }));
        } else resolve(stdout.trim() === "recovered");
      },
    );
  });
}
if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === "--recover") {
  const path = process.argv[3];
  if (!path) throw new Error("Recovery path required");
  console.log(reapAtCwd(path) ? "recovered" : "retained");
}
