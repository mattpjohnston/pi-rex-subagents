import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readlink } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { runHardenedGit } from "./git-read.ts";
import { isMissing, type CheckoutReport } from "./records.ts";

export const FINGERPRINT_MAX_BYTES = 2 * 1024 * 1024 * 1024;
export const FINGERPRINT_MAX_MS = 60_000;
export const CHECKOUT_PATH_CAP = 50;

export interface FingerprintOk {
  version: 1;
  state: "ok";
  kind: "git" | "dir";
  head: string | null;
  headSymbolic: string | null;
  refs: Record<string, string>;
  stage: Record<string, string>;
  flags: Record<string, string>;
  meta: Record<string, string>;
  files: Record<string, string>;
}

export interface FingerprintUnknown {
  version: 1;
  state: "unknown";
  reason: string;
}

export type Fingerprint = FingerprintOk | FingerprintUnknown;

export function fingerprintLimits(): { bytes: number; ms: number } {
  return {
    bytes: envLimit("PI_SUBAGENTS_FINGERPRINT_MAX_BYTES", FINGERPRINT_MAX_BYTES),
    ms: envLimit("PI_SUBAGENTS_FINGERPRINT_MAX_MS", FINGERPRINT_MAX_MS),
  };
}

function envLimit(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) return fallback;
  return value;
}

class Budget {
  readonly started = Date.now();
  readonly maxMs: number;
  bytesLeft: number;
  reason: string | null = null;
  constructor(maxBytes: number, maxMs: number) {
    this.maxMs = maxMs;
    this.bytesLeft = maxBytes;
    if (maxMs === 0) this.reason = "fingerprint time budget exceeded";
  }
  expired(): boolean {
    if (this.reason) return true;
    if (Date.now() - this.started >= this.maxMs) {
      this.reason = "fingerprint time budget exceeded";
      return true;
    }
    return false;
  }
  take(bytes: number): boolean {
    if (this.expired()) return false;
    if (bytes > this.bytesLeft) {
      this.reason = "fingerprint size budget exceeded";
      return false;
    }
    this.bytesLeft -= bytes;
    return true;
  }
}

function unknown(reason: string): FingerprintUnknown {
  return { version: 1, state: "unknown", reason };
}
function isUnknownFingerprint(
  value: FingerprintUnknown | Record<string, string>,
): value is FingerprintUnknown {
  return "version" in value && value.version === 1 && "state" in value && value.state === "unknown";
}

async function hashBytes(bytes: Buffer): Promise<string> {
  return createHash("sha256").update(bytes).digest("hex");
}

async function hashStream(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

function relOrLabel(root: string, path: string, label: string): string {
  const rel = relative(root, path);
  if (rel && !rel.startsWith("..") && !rel.startsWith(`..${sep}`)) return rel.split(sep).join("/");
  return label;
}

async function hashOne(
  path: string,
  budget: Budget,
): Promise<{ hash: string } | { missing: true } | { unknown: string }> {
  let stat;
  try {
    stat = await lstat(path);
  } catch (error) {
    if (isMissing(error)) return { missing: true };
    return { unknown: error instanceof Error ? error.message : String(error) };
  }
  if (stat.isSymbolicLink()) {
    const target = await readlink(path);
    const bytes = Buffer.byteLength(target);
    if (!budget.take(bytes)) return { unknown: budget.reason ?? "fingerprint budget exceeded" };
    return { hash: `symlink:${await hashBytes(Buffer.from(target))}` };
  }
  if (!stat.isFile()) return { missing: true };
  if (!budget.take(stat.size)) return { unknown: budget.reason ?? "fingerprint budget exceeded" };
  return { hash: await hashStream(path) };
}

async function hashTree(
  root: string,
  budget: Budget,
): Promise<Record<string, string> | FingerprintUnknown> {
  const files: Record<string, string> = {};
  const walk = async (dir: string, rel: string): Promise<FingerprintUnknown | null> => {
    if (budget.expired()) return unknown(budget.reason ?? "fingerprint budget exceeded");
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      return unknown(error instanceof Error ? error.message : String(error));
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === ".git") continue;
      const child = join(dir, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const stat = await lstat(child);
      if (stat.isSymbolicLink()) {
        const hashed = await hashOne(child, budget);
        if ("unknown" in hashed) return unknown(hashed.unknown);
        if ("hash" in hashed) files[childRel] = hashed.hash;
        continue;
      }
      if (stat.isDirectory()) {
        const nested = await walk(child, childRel);
        if (nested) return nested;
        continue;
      }
      if (!stat.isFile()) continue;
      const hashed = await hashOne(child, budget);
      if ("unknown" in hashed) return unknown(hashed.unknown);
      if ("hash" in hashed) files[childRel] = hashed.hash;
    }
    return null;
  };
  const failed = await walk(root, "");
  return failed ?? files;
}

async function gitText(
  cwd: string,
  args: string[],
  budget: Budget,
): Promise<{ code: number; stdout: string; stderr: string } | FingerprintUnknown> {
  if (budget.expired()) return unknown(budget.reason ?? "fingerprint budget exceeded");
  const remaining = Math.max(1, budget.maxMs - (Date.now() - budget.started));
  try {
    return await runHardenedGit(cwd, args, { timeoutMs: remaining });
  } catch (error) {
    return unknown(error instanceof Error ? error.message : String(error));
  }
}

function parseShowRef(text: string): Record<string, string> {
  const refs: Record<string, string> = {};
  for (const line of text.split("\n")) {
    if (!line) continue;
    const space = line.indexOf(" ");
    if (space <= 0) continue;
    refs[line.slice(space + 1)] = line.slice(0, space);
  }
  return refs;
}

function parseStage(text: string): Record<string, string> {
  const stage: Record<string, string> = {};
  for (const record of text.split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    stage[record.slice(tab + 1)] = record.slice(0, tab);
  }
  return stage;
}

function parseFlags(text: string): Record<string, string> {
  const flags: Record<string, string> = {};
  for (const line of text.split("\n")) {
    if (line.length < 2) continue;
    flags[line.slice(2)] = line.slice(0, 1);
  }
  return flags;
}

async function hashMeta(
  root: string,
  path: string,
  label: string,
  budget: Budget,
  meta: Record<string, string>,
): Promise<FingerprintUnknown | null> {
  const hashed = await hashOne(path, budget);
  if ("unknown" in hashed) return unknown(hashed.unknown);
  if ("hash" in hashed) meta[relOrLabel(root, path, label)] = hashed.hash;
  return null;
}

async function hashMetaDir(
  root: string,
  dir: string,
  label: string,
  budget: Budget,
  meta: Record<string, string>,
): Promise<FingerprintUnknown | null> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return null;
    return unknown(error instanceof Error ? error.message : String(error));
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory()) continue;
    const failed = await hashMeta(
      root,
      join(dir, entry.name),
      `${label}/${entry.name}`,
      budget,
      meta,
    );
    if (failed) return failed;
  }
  return null;
}

async function captureGit(root: string, budget: Budget): Promise<Fingerprint> {
  const head = await gitText(root, ["rev-parse", "--verify", "HEAD"], budget);
  if ("state" in head) return head;
  const symbolic = await gitText(root, ["symbolic-ref", "-q", "HEAD"], budget);
  if ("state" in symbolic) return symbolic;
  const refs = await gitText(root, ["show-ref"], budget);
  if ("state" in refs) return refs;
  const stage = await gitText(root, ["ls-files", "--stage", "-z"], budget);
  if ("state" in stage) return stage;
  const flags = await gitText(root, ["ls-files", "-v"], budget);
  if ("state" in flags) return flags;
  const gitPath = async (name: string) => {
    const result = await gitText(
      root,
      ["rev-parse", "--path-format=absolute", "--git-path", name],
      budget,
    );
    return result;
  };
  const config = await gitPath("config");
  if ("state" in config) return config;
  const common = await gitText(
    root,
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    budget,
  );
  if ("state" in common) return common;
  const worktreeConfig = await gitPath("config.worktree");
  if ("state" in worktreeConfig) return worktreeConfig;
  const hooks = await gitPath("hooks");
  if ("state" in hooks) return hooks;
  const info = await gitPath("info");
  if ("state" in info) return info;
  const meta: Record<string, string> = {};
  for (const [path, label] of [
    [config.stdout.trim(), "git/config"],
    [join(common.stdout.trim(), "config"), "git/common-config"],
    [worktreeConfig.stdout.trim(), "git/config.worktree"],
  ] as const) {
    if (!path) continue;
    const failed = await hashMeta(root, path, label, budget, meta);
    if (failed) return failed;
  }
  for (const [path, label] of [
    [hooks.stdout.trim(), "git/hooks"],
    [info.stdout.trim(), "git/info"],
  ] as const) {
    if (!path) continue;
    const failed = await hashMetaDir(root, path, label, budget, meta);
    if (failed) return failed;
  }
  const files = await hashTree(root, budget);
  if (isUnknownFingerprint(files)) return files;
  const headFailed =
    head.code !== 0 &&
    !/unknown revision|needed a single revision|ambiguous argument|not a valid object/.test(
      `${head.stderr} ${head.stdout}`,
    );
  if (headFailed) return unknown(head.stderr.trim() || "Cannot read HEAD");
  if (refs.code !== 0 && (refs.code !== 1 || refs.stderr.trim() !== ""))
    return unknown(refs.stderr.trim() || "Cannot read refs");
  if (symbolic.code !== 0 && symbolic.code !== 1)
    return unknown(symbolic.stderr.trim() || "Cannot read HEAD");
  if (stage.code !== 0) return unknown(stage.stderr.trim() || "Cannot read the index");
  if (flags.code !== 0) return unknown(flags.stderr.trim() || "Cannot read index flags");
  return {
    version: 1,
    state: "ok",
    kind: "git",
    head: head.code === 0 ? head.stdout.trim() : null,
    headSymbolic: symbolic.code === 0 ? symbolic.stdout.trim() : null,
    refs: parseShowRef(refs.stdout),
    stage: parseStage(stage.stdout),
    flags: parseFlags(flags.stdout),
    meta,
    files,
  };
}

export async function captureFingerprint(root: string): Promise<Fingerprint> {
  const limits = fingerprintLimits();
  const budget = new Budget(limits.bytes, limits.ms);
  if (budget.expired()) return unknown(budget.reason ?? "fingerprint budget exceeded");
  let probe: { code: number; stdout: string; stderr: string };
  try {
    probe = await runHardenedGit(root, ["rev-parse", "--is-inside-work-tree"], {
      timeoutMs: Math.max(1, limits.ms),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/not a git repository/i.test(message)) {
      const files = await hashTree(root, budget);
      if (isUnknownFingerprint(files)) return files;
      return emptyDir(files);
    }
    return unknown(message);
  }
  if (probe.code !== 0 && /not a git repository/i.test(probe.stderr)) {
    const files = await hashTree(root, budget);
    if (isUnknownFingerprint(files)) return files;
    return emptyDir(files);
  }
  if (probe.code !== 0) return unknown(probe.stderr.trim() || "Cannot identify the checkout");
  return captureGit(root, budget);
}

function emptyDir(files: Record<string, string>): FingerprintOk {
  return {
    version: 1,
    state: "ok",
    kind: "dir",
    head: null,
    headSymbolic: null,
    refs: {},
    stage: {},
    flags: {},
    meta: {},
    files,
  };
}

function diffMap(
  before: Record<string, string>,
  after: Record<string, string>,
  paths: Set<string>,
): void {
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (before[key] !== after[key]) paths.add(key);
  }
}

export function compareFingerprints(before: Fingerprint, after: Fingerprint): CheckoutReport {
  if (before.state === "unknown" || after.state === "unknown") {
    const failed = before.state === "unknown" ? before : after;
    return {
      state: "unknown",
      paths: [],
      total: 0,
      reason: failed.state === "unknown" ? failed.reason : "fingerprint could not be completed",
    };
  }
  const paths = new Set<string>();
  if (before.kind !== after.kind) paths.add(".git");
  if (before.head !== after.head || before.headSymbolic !== after.headSymbolic) paths.add("HEAD");
  diffMap(before.refs, after.refs, paths);
  diffMap(before.stage, after.stage, paths);
  diffMap(before.flags, after.flags, paths);
  diffMap(before.meta, after.meta, paths);
  diffMap(before.files, after.files, paths);
  const all = [...paths].sort();
  return {
    state: all.length ? "changed" : "clean",
    paths: all.slice(0, CHECKOUT_PATH_CAP),
    total: all.length,
  };
}
