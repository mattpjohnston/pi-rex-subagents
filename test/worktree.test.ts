import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorktree, findRepoRoot, finishWorktree } from "../src/worktree.ts";

let root: string;
let repo: string;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "pirs-wt-")));
  repo = join(root, "app");
  await mkdir(join(repo, "sub"), { recursive: true });
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test"]);
  await writeFile(join(repo, "sub", "hello.txt"), "initial\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "init"]);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("worktree", () => {
  it("finds repo root and returns null outside git", async () => {
    expect(await findRepoRoot(join(repo, "sub"))).toBe(repo);
    const plain = join(root, "plain");
    await mkdir(plain);
    expect(await findRepoRoot(plain)).toBeNull();
  });

  it("creates worktree preserving subdirectory and removes it when untouched", async () => {
    const created = await createWorktree(repo, join(repo, "sub"), "Fix Login!", "abcdef1234567890");
    expect(created.worktree.branch).toBe("subagent/fix-login-abcdef12");
    expect(created.cwd).toBe(join(created.worktree.path, "sub"));
    expect(existsSync(join(created.cwd, "hello.txt"))).toBe(true);

    const retired = await finishWorktree(created.worktree);
    expect(retired.removedAt).toBeTypeOf("number");
    expect(existsSync(created.worktree.path)).toBe(false);
    expect(git(repo, ["branch", "--list", created.worktree.branch])).toBe("");
  });

  it("keeps worktree with uncommitted changes and records diffStat", async () => {
    const { worktree } = await createWorktree(repo, repo, "dirty", "1111111122222222");
    await writeFile(join(worktree.path, "sub", "hello.txt"), "edited\n");

    const finished = await finishWorktree(worktree);
    expect(finished.removedAt).toBeUndefined();
    expect(finished.keptReason).toBe("uncommitted changes");
    expect(finished.diffStat).toContain("hello.txt");
    expect(existsSync(worktree.path)).toBe(true);
  });

  it("keeps worktree with unmerged commits and removes it once merged", async () => {
    const { worktree } = await createWorktree(repo, repo, "feature", "3333333344444444");
    await writeFile(join(worktree.path, "sub", "hello.txt"), "committed\n");
    git(worktree.path, ["add", "."]);
    git(worktree.path, ["commit", "-q", "-m", "work"]);

    const kept = await finishWorktree(worktree);
    expect(kept.removedAt).toBeUndefined();
    expect(kept.keptReason).toBe("unmerged commits on branch");
    expect(kept.diffStat).toContain("hello.txt");

    git(repo, ["merge", "-q", "--ff-only", worktree.branch]);
    const cleaned = await finishWorktree(worktree);
    expect(cleaned.removedAt).toBeTypeOf("number");
    expect(existsSync(worktree.path)).toBe(false);
  });
});
