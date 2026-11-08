import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
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
  const names = (await readdir(join(run.sessions, label))).filter((name) =>
    name.endsWith(".jsonl"),
  );
  assert.equal(names.length, 1, `Expected one session file for ${label}, saw ${names.join(",")}`);
  return join(run.sessions, label, names[0] ?? "");
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
  argv.splice(promptIndex, 0, "-e", join(repo, "harness", "background-tools.ts"), ...extra);
  return argv;
}
