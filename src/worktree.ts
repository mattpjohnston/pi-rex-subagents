import { execFile } from "node:child_process";
import { mkdir, realpath } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { WorktreeInfo } from "./store.ts";

const DIFF_STAT_CAP = 4_000;

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      "git",
      ["-C", cwd, ...args],
      { encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`git ${args[0]}: ${stderr.trim() || error.message}`));
        else resolvePromise(stdout.trim());
      },
    );
  });
}

/** Returns the real path of the git working-tree root, or null if cwd is not in a git repo. */
export async function findRepoRoot(cwd: string): Promise<string | null> {
  try {
    const top = await git(cwd, ["rev-parse", "--show-toplevel"]);
    return top ? await realpath(top) : null;
  } catch {
    return null;
  }
}

/**
 * Returns the main repository root (even if cwd is inside an existing linked worktree)
 * so new worktrees never nest inside `.worktrees/.worktrees/`.
 */
async function mainRepoRoot(repoRoot: string): Promise<string> {
  try {
    const common = await git(repoRoot, ["rev-parse", "--git-common-dir"]);
    const commonAbs = await realpath(resolve(repoRoot, common));
    return basename(commonAbs) === ".git" ? dirname(commonAbs) : repoRoot;
  } catch {
    return repoRoot;
  }
}

function worktreeContainer(mainRoot: string): string {
  return join(dirname(mainRoot), `${basename(mainRoot)}.worktrees`);
}

function slug(label: string): string {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "subagent"
  );
}

function capStat(text: string): string {
  if (text.length <= DIFF_STAT_CAP) return text;
  return `${text.slice(0, DIFF_STAT_CAP)}\n… (truncated)`;
}

/**
 * Creates a worktree next to the main repository: <parent>/<repo>.worktrees/<label>-<shortId>
 * on branch subagent/<label>-<shortId> from HEAD. One container folder lets Pi's
 * "Trust parent folder" cover all future worktrees for the repo.
 */
export async function createWorktree(
  repoRoot: string,
  cwd: string,
  label: string,
  id: string,
): Promise<{ worktree: WorktreeInfo; cwd: string }> {
  const mainRoot = await mainRepoRoot(repoRoot);
  const name = `${slug(label)}-${id.slice(0, 8)}`;
  const container = worktreeContainer(mainRoot);
  const path = join(container, name);
  const branch = `subagent/${name}`;
  const base = await git(repoRoot, ["rev-parse", "--verify", "HEAD"]);
  await mkdir(container, { recursive: true });
  await git(repoRoot, ["worktree", "add", "-q", "-b", branch, path, base]);
  return {
    worktree: { path, branch, base, repository: mainRoot },
    cwd: join(path, relative(repoRoot, cwd)),
  };
}

/**
 * Summarizes changes (including untracked files) and removes the worktree + branch only when
 * completely clean and holding no unmerged commits. If the subagent switched to another branch
 * with new commits, keeps the worktree and reports the actual branch.
 */
export async function finishWorktree(worktree: WorktreeInfo): Promise<WorktreeInfo> {
  try {
    const dirty = await git(worktree.path, ["status", "--porcelain", "--untracked-files=all"]);
    const tip = await git(worktree.path, ["rev-parse", "HEAD"]);
    const currentBranch = await git(worktree.path, ["branch", "--show-current"]).catch(() => "");
    const activeBranch = currentBranch || worktree.branch;
    const trackedStat = await git(worktree.path, ["diff", "--stat", worktree.base]).catch(() => "");
    const rawStat = [trackedStat, dirty].filter(Boolean).join("\n");
    const diffStat = rawStat ? capStat(rawStat) : "";

    if (dirty) {
      return {
        ...worktree,
        branch: activeBranch,
        ...(diffStat ? { diffStat } : {}),
        keptReason: "uncommitted changes",
      };
    }

    if (tip !== worktree.base) {
      const holders = (
        await git(worktree.repository, [
          "for-each-ref",
          "--format=%(refname)",
          "--contains",
          tip,
          "refs/heads",
        ])
      )
        .split("\n")
        .filter(
          (ref) =>
            ref && ref !== `refs/heads/${worktree.branch}` && ref !== `refs/heads/${activeBranch}`,
        );
      if (holders.length === 0) {
        return {
          ...worktree,
          branch: activeBranch,
          ...(diffStat ? { diffStat } : {}),
          keptReason:
            activeBranch !== worktree.branch
              ? `unmerged commits on branch ${activeBranch}`
              : "unmerged commits on branch",
        };
      }
    }

    await git(worktree.repository, ["worktree", "remove", worktree.path]);
    await git(worktree.repository, ["branch", "-D", worktree.branch]).catch(() => undefined);
    return { ...worktree, branch: activeBranch, removedAt: Date.now() };
  } catch (error) {
    return {
      ...worktree,
      keptReason: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface ListedWorktree {
  path: string;
  branch: string;
  dirty: boolean;
}

/** Lists existing subagent worktrees (by subagent/* branch or inside <repo>.worktrees/). */
export async function listSubagentWorktrees(repoRoot: string): Promise<ListedWorktree[]> {
  const mainRoot = await mainRepoRoot(repoRoot);
  const container = `${worktreeContainer(mainRoot)}/`;
  const raw = await git(mainRoot, ["worktree", "list", "--porcelain"]);
  const entries: ListedWorktree[] = [];
  let path = "";
  let branch = "";
  const flush = async () => {
    if (path && (branch.startsWith("subagent/") || path.startsWith(container))) {
      const status = await git(path, ["status", "--porcelain", "--untracked-files=all"]).catch(
        () => "",
      );
      entries.push({ path, branch: branch || "(detached)", dirty: status.length > 0 });
    }
    path = "";
    branch = "";
  };
  for (const line of raw.split("\n")) {
    if (!line.trim()) {
      await flush();
    } else if (line.startsWith("worktree ")) {
      path = line.slice("worktree ".length);
    } else if (line.startsWith("branch refs/heads/")) {
      branch = line.slice("branch refs/heads/".length);
    }
  }
  await flush();
  return entries;
}

export async function removeSubagentWorktree(
  repoRoot: string,
  path: string,
  branch: string,
  force = false,
): Promise<void> {
  const mainRoot = await mainRepoRoot(repoRoot);
  await git(mainRoot, ["worktree", "remove", ...(force ? ["--force"] : []), path]);
  if (branch && branch !== "(detached)") {
    await git(mainRoot, ["branch", "-D", branch]).catch(() => undefined);
  }
}
