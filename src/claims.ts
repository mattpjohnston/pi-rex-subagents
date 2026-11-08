import { randomBytes } from "node:crypto";
import { link, open, readFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isMissing, privateDirectory, stateDir, syncDirectory } from "./records.ts";
import { recoverStaleLock, withLock } from "./locks.ts";
export { processStart } from "./locks.ts";

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
export async function withAdmissionLock<T>(body: () => Promise<T>): Promise<T> {
  await privateDirectory(stateDir());
  const path = join(stateDir(), "lock");
  return withLock(path, body, () => recoverStaleLock(path));
}
export async function withRunLock<T>(
  path: string,
  body: () => Promise<T>,
  admissionHeld = false,
): Promise<T> {
  return withLock(path, body, () =>
    admissionHeld ? recoverStaleRunLock(path) : withAdmissionLock(() => recoverStaleRunLock(path)),
  );
}
/** Caller holds the admission lock. A live or unidentified holder is retained, regardless of age. */
export const recoverStaleRunLock = recoverStaleLock;
