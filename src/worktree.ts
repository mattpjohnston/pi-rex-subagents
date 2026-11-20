import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { isRepository } from "./checkout.ts";
import type { RunRecord } from "./records.ts";

type Worktree = NonNullable<RunRecord["worktree"]>;

/** Plain git, not the hardened reader: this creates and removes worktrees on purpose. */
function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-C", cwd, ...args],
      { encoding: "utf8", timeout: 60_000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`git ${args[0]}: ${stderr.trim() || error.message}`));
        else resolve(stdout.trim());
      },
    );
  });
}

/** A label as it can appear in a directory and a branch name. */
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
 * A worktree for one run, next to the repository: <parent>/<repo>.worktrees/<label>-<id>, on a
 * new branch subagent/<label>-<id> from the checkout's HEAD. One root per repository lets one
 * "Trust parent folder" cover every worktree. The child works in the same subdirectory it would
 * have in the checkout.
 */
export async function createWorktree(
  root: string,
  cwd: string,
  label: string,
  id: string,
): Promise<{ worktree: Worktree; cwd: string }> {
  if (!isRepository(root)) throw new Error(`worktree needs a git repository; ${cwd} isn't in one`);
  const name = `${slug(label)}-${id.slice(0, 8)}`;
  const container = join(dirname(root), `${basename(root)}.worktrees`);
  const path = join(container, name);
  const branch = `subagent/${name}`;
  const base = await git(root, ["rev-parse", "--verify", "HEAD"]);
  await mkdir(container, { recursive: true });
  await git(root, ["worktree", "add", "-q", "-b", branch, path, base]);
  return {
    worktree: { path, branch, base, repository: root },
    cwd: join(path, relative(root, cwd)),
  };
}

/**
 * Removes a finished run's worktree and branch when nothing in them would be lost: no changes,
 * untracked files included, and no commit that another branch doesn't also hold. Otherwise
 * the worktree stays and the reason is recorded, so the parent can review and merge it.
 */
export async function retireWorktree(worktree: Worktree): Promise<Worktree> {
  try {
    const dirty = await git(worktree.path, ["status", "--porcelain", "--untracked-files=all"]);
    if (dirty) return { ...worktree, kept: "it has uncommitted changes" };
    const tip = await git(worktree.path, ["rev-parse", "HEAD"]);
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
        .filter((ref) => ref && ref !== `refs/heads/${worktree.branch}`);
      if (!holders.length)
        return { ...worktree, kept: "its branch has commits no other branch has" };
    }
    await git(worktree.repository, ["worktree", "remove", worktree.path]);
    await git(worktree.repository, ["branch", "-D", worktree.branch]);
    return { ...worktree, removedAt: Date.now() };
  } catch (error) {
    return { ...worktree, kept: error instanceof Error ? error.message : String(error) };
  }
}
