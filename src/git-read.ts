import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Type } from "typebox";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

export const GIT_READ_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER = 8 * 1024 * 1024;
export const GIT_READ_SUBCOMMANDS = [
  "blame",
  "diff",
  "grep",
  "log",
  "ls-files",
  "rev-parse",
  "shortlog",
  "show",
  "status",
] as const;

/** Flags this Git accepts. rev-parse treats unknown options as revisions, so it gets none. */
const DIFF_FLAGS: Record<string, readonly string[]> = {
  blame: ["--no-ext-diff", "--no-textconv"],
  diff: ["--no-ext-diff", "--no-textconv"],
  grep: ["--no-textconv"],
  log: ["--no-ext-diff", "--no-textconv"],
  shortlog: ["--no-ext-diff", "--no-textconv"],
  show: ["--no-ext-diff", "--no-textconv"],
};

const REFUSED_LONG = [
  "config",
  "exec",
  "ext-diff",
  "open-files-in-pager",
  "output",
  "show-signature",
  "textconv",
  "upload-pack",
];
const EXACT_OPTIONS = ["text"];

export function refusedGitArgument(arg: string): string | null {
  if (arg.startsWith("-") && !arg.startsWith("--")) {
    if (arg.startsWith("-c")) return "-c";
    // Git bundles short options, so `grep -iO<cmd>` runs <cmd> as a pager. An attached value
    // that contains O is refused too; pass such a value as its own argument.
    if (arg.includes("O")) return "-O";
    return null;
  }
  if (arg === "--") return null;
  const name = arg.slice(2).split("=", 1)[0] ?? "";
  if (!name) return null;
  // An exact option name wins over abbreviation in Git, so these are not refused prefixes.
  if (EXACT_OPTIONS.includes(name)) return null;
  // Git treats a unique prefix as the option, with or without =value.
  const hit = REFUSED_LONG.find((refused) => refused.startsWith(name));
  return hit ? `--${hit}` : null;
}

export function validateGitReadArgs(args: readonly string[]): string | null {
  const sub = args[0];
  if (!sub || !GIT_READ_SUBCOMMANDS.includes(sub as (typeof GIT_READ_SUBCOMMANDS)[number]))
    return `git_read only allows ${GIT_READ_SUBCOMMANDS.join(", ")}`;
  for (const arg of args.slice(1)) {
    const refused = refusedGitArgument(arg);
    if (refused) return `git_read refuses ${arg} (${refused})`;
  }
  return null;
}

let hardenPaths: { attr: string; hooks: string } | undefined;
const emptyTrees = new Map<string, string>();

async function privateHardenPaths(): Promise<{ attr: string; hooks: string }> {
  if (hardenPaths) return hardenPaths;
  const root = await mkdtemp(join(tmpdir(), "pi-rex-git-"));
  await chmod(root, 0o700);
  const attr = join(root, "attributes");
  const hooks = join(root, "hooks");
  await writeFile(attr, "", { mode: 0o600 });
  await mkdir(hooks, { mode: 0o700 });
  hardenPaths = { attr, hooks };
  return hardenPaths;
}

export function gitReadEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (key.startsWith("GIT_") || value === undefined) continue;
    env[key] = value;
  }
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_ATTR_NOSYSTEM = "1";
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_PAGER = "cat";
  env.PAGER = "cat";
  env.GIT_TERMINAL_PROMPT = "0";
  // A promisor remote in repo config would otherwise fetch missing objects through any
  // transport, including ext:: commands. No read needs the network.
  env.GIT_NO_LAZY_FETCH = "1";
  env.GIT_ALLOW_PROTOCOL = "none";
  return env;
}

function execGit(
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeout: number,
  signal?: AbortSignal,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      args,
      { cwd, env, timeout, maxBuffer: GIT_MAX_BUFFER, encoding: "utf8", signal },
      (error, stdout, stderr) => {
        if (error && (error.killed || typeof error.code !== "number")) {
          reject(error);
          return;
        }
        resolve({
          code: typeof error?.code === "number" ? error.code : 0,
          stdout,
          stderr,
        });
      },
    );
    // Empty stdin: shortlog reads it when it is not a terminal.
    child.stdin?.end();
  });
}

/** Env-hardened git without --attr-source, only for discovering the empty tree. */
async function bootstrapGit(
  cwd: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const { hooks } = await privateHardenPaths();
  return execGit(
    cwd,
    ["-c", `core.hooksPath=${hooks}`, "-c", "core.fsmonitor=false", "--no-pager", ...args],
    gitReadEnv(),
    10_000,
  );
}

/**
 * The ID depends on the repository's hash format, so it is cached per repository: the nearest
 * directory above cwd that has a .git entry or is itself a repository (HEAD, objects and refs),
 * as Git discovers them. stat calls cost no Git process, and a repository created or cloned
 * inside a directory already read gets its own entry.
 */
async function repositoryKey(cwd: string): Promise<string> {
  const exists = async (path: string) => {
    try {
      await lstat(path);
      return true;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
      throw error;
    }
  };
  let dir = resolve(cwd);
  try {
    while (true) {
      if (await exists(join(dir, ".git"))) return dir;
      const bare = await Promise.all(
        ["HEAD", "objects", "refs"].map((name) => exists(join(dir, name))),
      );
      if (bare.every(Boolean)) return dir;
      const parent = dirname(dir);
      if (parent === dir) return cwd;
      dir = parent;
    }
  } catch {
    return cwd;
  }
}
async function emptyTreeId(cwd: string): Promise<string> {
  const key = await repositoryKey(cwd);
  const cached = emptyTrees.get(key);
  if (cached) return cached;
  const hashed = await bootstrapGit(cwd, [
    "hash-object",
    "--no-filters",
    "-t",
    "tree",
    "/dev/null",
  ]);
  if (hashed.code !== 0) throw new Error(hashed.stderr.trim() || "Cannot hash the empty tree");
  const id = hashed.stdout.trim();
  emptyTrees.set(key, id);
  return id;
}

export async function runHardenedGit(
  cwd: string,
  args: readonly string[],
  options: { timeoutMs?: number; signal?: AbortSignal; env?: NodeJS.ProcessEnv } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const sub = args[0];
  if (!sub) throw new Error("git command is empty");
  const { attr, hooks } = await privateHardenPaths();
  const empty = await emptyTreeId(cwd);
  const argv = [
    `--attr-source=${empty}`,
    "-c",
    `core.attributesFile=${attr}`,
    "-c",
    `core.hooksPath=${hooks}`,
    "-c",
    "core.fsmonitor=false",
    "-c",
    "diff.external=",
    "-c",
    "log.showSignature=false",
    "-c",
    "core.pager=cat",
    "--no-pager",
    sub,
    ...(DIFF_FLAGS[sub] ?? []),
    ...args.slice(1),
  ];
  return execGit(
    cwd,
    argv,
    options.env ?? gitReadEnv(),
    options.timeoutMs ?? GIT_READ_TIMEOUT_MS,
    options.signal,
  );
}

export function capGitOutput(stdout: string, stderr: string, code: number): string {
  const text = [`exit ${code}`, stderr.trim() ? `stderr:\n${stderr.trimEnd()}` : "", stdout]
    .filter(Boolean)
    .join("\n");
  return truncateHead(text, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES }).content;
}

export async function runGitRead(
  cwd: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<string> {
  const refused = validateGitReadArgs(args);
  if (refused) throw new Error(refused);
  let result: { code: number; stdout: string; stderr: string };
  try {
    result = await runHardenedGit(cwd, args, { signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError")
      throw new Error("git_read aborted", { cause: error });
    if (error instanceof Error && "killed" in error && error.killed)
      throw new Error(`git_read timed out after ${GIT_READ_TIMEOUT_MS}ms`, { cause: error });
    throw error;
  }
  return capGitOutput(result.stdout, result.stderr, result.code);
}

export function registerGitRead(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "git_read",
    label: "Git read",
    description:
      "Run one allowlisted git command with no shell. The first argument must be log, show, blame, diff, ls-files, rev-parse, status, shortlog, or grep. Refuses options that write files, run commands, or verify signatures, including unique prefixes of those long options.",
    parameters: Type.Object(
      { args: Type.Array(Type.String(), { minItems: 1 }) },
      { additionalProperties: false },
    ),
    async execute(_id, input, signal) {
      const text = await runGitRead(process.cwd(), input.args, signal);
      return { content: [{ type: "text", text }], details: undefined };
    },
  });
}
