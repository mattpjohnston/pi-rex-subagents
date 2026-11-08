import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { RESULTS_TYPE } from "../../src/delivery.ts";
import { parentArgv } from "./pi.ts";
import { repo, type Run } from "./run.ts";
import { object } from "./rex.ts";

export function rateLimited(text: string): boolean {
  return /\b429\b|rate limit|too many requests/i.test(text);
}
export function assertNotRateLimited(text: string): void {
  if (rateLimited(text)) throw new Error(`Provider rate limit; not retrying: ${text}`);
}
export async function sessionPath(run: Run, label: string): Promise<string> {
  // Pi writes nothing until the session holds a message, so wait for the file to appear.
  const deadline = Date.now() + 60_000;
  while (true) {
    const names = (await readdir(join(run.sessions, label))).filter((name) =>
      name.endsWith(".jsonl"),
    );
    assert(names.length <= 1, `Expected one session file for ${label}, saw ${names.join(",")}`);
    if (names[0]) return join(run.sessions, label, names[0]);
    if (Date.now() >= deadline) throw new Error(`No session file for ${label} after 60 s`);
    await delay(200);
  }
}
export async function entries(path: string): Promise<Record<string, unknown>[]> {
  const raw = (await readFile(path, "utf8")).trim();
  if (!raw) return [];
  return raw.split("\n").map((line) => object(JSON.parse(line)));
}
export function resultsEntries(
  rows: readonly Record<string, unknown>[],
): Record<string, unknown>[] {
  return rows.filter((row) => row.type === "custom_message" && row.customType === RESULTS_TYPE);
}
export function runIds(row: Record<string, unknown>): string[] {
  const details = row.details;
  if (!details || typeof details !== "object" || !("runIds" in details)) return [];
  const ids = details.runIds;
  return Array.isArray(ids) ? ids.filter((id) => typeof id === "string") : [];
}
export async function parentLaunch(
  run: Run,
  label: string,
  prompt: string,
  extra: string[] = [],
  env: Record<string, string> = {},
): Promise<string[]> {
  const argv = await parentArgv(run, label, prompt, {
    PI_SUBAGENTS_CHILD_NO_DISCOVERY: "1",
    PI_SUBAGENTS_CHILD_EXTENSIONS: join(repo, "harness", "child-tools.ts"),
    PI_SUBAGENTS_LOG_TOOLS: "1",
    ...env,
  });
  const promptIndex = argv.length - 1;
  // The batch tool refuses to load without a plan, so only plan-driven parents get it.
  const batch = env.HARNESS_PLANS ? ["-e", join(repo, "harness", "background-tools.ts")] : [];
  argv.splice(promptIndex, 0, ...batch, ...extra);
  return argv;
}

/** Pi refuses /reload and other session commands mid-response, so wait for the turn to end. */
export async function turnEnded(run: Run, label: string): Promise<void> {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const messages = (await entries(await sessionPath(run, label)))
      .filter((row) => row.type === "message" || row.type === "custom_message")
      .map((row) => (row.type === "message" ? object(row.message) : { role: "custom" }));
    const last = messages.at(-1);
    if (last?.role === "assistant" && last.stopReason !== "toolUse") {
      await delay(500);
      return;
    }
    await delay(200);
  }
  throw new Error(`Timed out: ${label} turn ended`);
}
