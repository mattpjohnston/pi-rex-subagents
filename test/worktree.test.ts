import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { prepareRun } from "../src/launch.ts";
import { createWorktree, retireWorktree } from "../src/worktree.ts";

let dir: string | undefined;
afterEach(async () => {
  vi.unstubAllEnvs();
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function repo(): Promise<string> {
  dir = await realpath(await mkdtemp(join(tmpdir(), "pirs-worktree-")));
  const root = join(dir, "project");
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "f"), "hi\n");
  execFileSync("git", ["-C", root, "add", "."]);
  execFileSync("git", [
    "-C",
    root,
    "-c",
    "user.name=a",
    "-c",
    "user.email=a@b",
    "commit",
    "-qm",
    "i",
  ]);
  return root;
}
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, "-c", "user.name=a", "-c", "user.email=a@b", ...args], {
    encoding: "utf8",
  }).trim();
const branches = (root: string) => git(root, "branch", "--format=%(refname:short)").split("\n");

it("a worktree launch runs in a new worktree on its own branch, in the same subdirectory", async () => {
  const root = await repo();
  vi.stubEnv("PI_SUBAGENTS_STATE_DIR", join(dir ?? "", "state"));
  vi.stubEnv("REX_SESSION", "s");
  const ctx = {
    cwd: join(root, "src"),
    model: undefined,
    thinkingLevel: "off",
    modelRegistry: { find: (provider: string, id: string) => ({ provider, id }) as never },
    sessionManager: { getSessionId: () => "parent" },
  } as never;
  const run = await prepareRun(
    { task: "change", label: "Fix Bug", provider: "p", model: "m", worktree: true },
    ctx,
  );
  const path = join(dir ?? "", "project.worktrees", `fix-bug-${run.id.slice(0, 8)}`);
  expect(run.worktree).toMatchObject({ path, branch: `subagent/fix-bug-${run.id.slice(0, 8)}` });
  expect([run.cwd, run.checkoutRoot]).toEqual([join(path, "src"), path]);
  expect(git(path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(run.worktree?.branch);
});

it("a finished worktree goes only when nothing in it would be lost", async () => {
  const root = await repo();
  const made = async (label: string) =>
    (await createWorktree(root, root, label, "0123456789ab")).worktree;
  const untouched = await made("untouched");
  expect(await retireWorktree(untouched)).toMatchObject({ removedAt: expect.any(Number) });
  expect([existsSync(untouched.path), branches(root)]).toEqual([false, ["main"]]);

  const dirty = await made("dirty");
  await writeFile(join(dirty.path, "new"), "x\n");
  expect((await retireWorktree(dirty)).kept).toMatch(/uncommitted/);
  expect(existsSync(dirty.path)).toBe(true);

  const committed = await made("committed");
  await writeFile(join(committed.path, "src", "f"), "changed\n");
  git(committed.path, "commit", "-qam", "work");
  expect((await retireWorktree(committed)).kept).toMatch(/commits no other branch has/);
  git(root, "merge", "-q", "--ff-only", committed.branch);
  expect(await retireWorktree(committed)).toMatchObject({ removedAt: expect.any(Number) });
  expect(branches(root)).not.toContain(committed.branch);
});

it("the result names the worktree, and says why it was kept", async () => {
  const { resultText } = await import("../src/results.ts");
  const base = {
    id: "a".repeat(24),
    label: "x",
    lifecycle: "completed",
    effective: { provider: "p", model: "m", thinking: "off" },
    process: { state: "exited", code: 0 },
    paths: { result: "r", events: "e", sessionDir: "s" },
    rex: null,
    location: null,
    sessionFile: null,
    diagnostic: null,
  } as never as import("../src/records.ts").RunRecord;
  const worktree = { path: "/w", branch: "subagent/x", base: "b", repository: "/r" };
  expect(
    resultText({ ...base, worktree: { ...worktree, kept: "it has uncommitted changes" } }),
  ).toMatch(/Worktree: \/w on branch subagent\/x, kept because it has uncommitted changes/);
  expect(resultText({ ...base, worktree: { ...worktree, removedAt: 1 } })).toMatch(/removed/);
});
