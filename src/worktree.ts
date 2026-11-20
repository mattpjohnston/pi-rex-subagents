import { execFile } from "node:child_process";
import { mkdir, realpath } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import type { WorktreeInfo } from "./store.ts";

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-C", cwd, ...args],
      { encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`git ${args[0]}: ${stderr.trim() || error.message}`));
        else resolve(stdout.trim());
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

function slug(label: string): string {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "subagent"
  );
}

/**
 * Creates a worktree next to the repository: <parent>/<repo>.worktrees/<label>-<shortId>
 * on branch subagent/<label>-<shortId> from HEAD. One container folder lets Pi's
 * "Trust parent folder" cover all future worktrees for the repo.
 */
export async function createWorktree(
  repoRoot: string,
  cwd: string,
  label: string,
  id: string,
): Promise<{ worktree: WorktreeInfo; cwd: string }> {
  const name = `${slug(label)}-${id.slice(0, 8)}`;
  const container = join(dirname(repoRoot), `${basename(repoRoot)}.worktrees`);
  const path = join(container, name);
  const branch = `subagent/${name}`;
  const base = await git(repoRoot, ["rev-parse", "--verify", "HEAD"]);
  await mkdir(container, { recursive: true });
  await git(repoRoot, ["worktree", "add", "-q", "-b", branch, path, base]);
  return {
    worktree: { path, branch, base, repository: repoRoot },
    cwd: join(path, relative(repoRoot, cwd)),
  };
}

/**
 * Summarizes changes (including untracked files) and removes the worktree + branch only when
 * completely clean and holding no unmerged commits. Otherwise keeps it for review/merge.
 */
export async function finishWorktree(worktree: WorktreeInfo): Promise<WorktreeInfo> {
  try {
    const dirty = await git(worktree.path, ["status", "--porcelain", "--untracked-files=all"]);
    const tip = await git(worktree.path, ["rev-parse", "HEAD"]);
    const trackedStat = await git(worktree.path, ["diff", "--stat", worktree.base]).catch(() => "");
    const summaryParts = [trackedStat, dirty].filter(Boolean);
    const diffStat = summaryParts.join("\n");

    if (dirty) {
      return {
        ...worktree,
        ...(diffStat ? { diffStat } : {}),
        keptReason: "uncommitted changes",
      };
    }

    if (tip !== worktree.base) {
      const otherBranches = (
        await git(worktree.repository, [
          "for-each-ref",
          "--format=%(refname)",
          "--contains",
          tip,
          "refs/heads",
        ])
      )
        .split("\n")
        .filter((ref) => ref && ref !== `refs/heads/${worktree.branch}`);
      if (otherBranches.length === 0) {
        return {
          ...worktree,
          ...(diffStat ? { diffStat } : {}),
          keptReason: "unmerged commits on branch",
        };
      }
    }

    await git(worktree.repository, ["worktree", "remove", worktree.path]);
    await git(worktree.repository, ["branch", "-D", worktree.branch]);
    return { ...worktree, removedAt: Date.now() };
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

/** Lists existing subagent/* worktrees attached to repoRoot. */
export async function listSubagentWorktrees(repoRoot: string): Promise<ListedWorktree[]> {
  const raw = await git(repoRoot, ["worktree", "list", "--porcelain"]);
  const entries: ListedWorktree[] = [];
  let path = "";
  let branch = "";
  const flush = async () => {
    if (path && branch.startsWith("subagent/")) {
      const status = await git(path, ["status", "--porcelain", "--untracked-files=all"]).catch(
        () => "",
      );
      entries.push({ path, branch, dirty: status.length > 0 });
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
  await git(repoRoot, ["worktree", "remove", ...(force ? ["--force"] : []), path]);
  await git(repoRoot, ["branch", "-D", branch]).catch(() => undefined);
}
