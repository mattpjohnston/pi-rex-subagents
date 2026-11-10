import { execFileSync } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { captureFingerprint, compareFingerprints, type Fingerprint } from "../src/fingerprint.ts";

const roots: string[] = [];
const previous = {
  bytes: process.env.PI_SUBAGENTS_FINGERPRINT_MAX_BYTES,
  ms: process.env.PI_SUBAGENTS_FINGERPRINT_MAX_MS,
};
afterEach(async () => {
  if (previous.bytes === undefined) delete process.env.PI_SUBAGENTS_FINGERPRINT_MAX_BYTES;
  else process.env.PI_SUBAGENTS_FINGERPRINT_MAX_BYTES = previous.bytes;
  if (previous.ms === undefined) delete process.env.PI_SUBAGENTS_FINGERPRINT_MAX_MS;
  else process.env.PI_SUBAGENTS_FINGERPRINT_MAX_MS = previous.ms;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pirs-fingerprint-"));
  roots.push(root);
  return root;
}

async function gitRepo(): Promise<string> {
  const root = await scratch();
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "config", "user.email", "probe@example.com"]);
  execFileSync("git", ["-C", root, "config", "user.name", "Probe"]);
  await writeFile(join(root, "f"), "hi\n");
  execFileSync("git", ["-C", root, "add", "f"]);
  execFileSync("git", ["-C", root, "commit", "-qm", "init"]);
  return root;
}

function ok(fingerprint: Fingerprint): Extract<Fingerprint, { state: "ok" }> {
  expect(fingerprint.state).toBe("ok");
  if (fingerprint.state !== "ok") throw new Error("expected a completed fingerprint");
  return fingerprint;
}

it("reports each checkout change and never calls an unknown fingerprint clean", async () => {
  const root = await gitRepo();
  const before = ok(await captureFingerprint(root));
  expect(compareFingerprints(before, ok(await captureFingerprint(root)))).toMatchObject({
    state: "clean",
    total: 0,
  });

  await writeFile(join(root, "ignored"), "secret\n");
  await writeFile(join(root, ".gitignore"), "ignored\n");
  expect(compareFingerprints(before, ok(await captureFingerprint(root))).paths).toEqual(
    expect.arrayContaining([".gitignore", "ignored"]),
  );

  execFileSync("git", ["-C", root, "update-index", "--skip-worktree", "f"]);
  await writeFile(join(root, "f"), "skip\n");
  expect(compareFingerprints(before, ok(await captureFingerprint(root))).paths).toContain("f");
  execFileSync("git", ["-C", root, "update-index", "--no-skip-worktree", "f"]);
  await writeFile(join(root, "f"), "hi\n");

  execFileSync("git", ["-C", root, "branch", "extra"]);
  expect(compareFingerprints(before, ok(await captureFingerprint(root))).paths).toContain(
    "refs/heads/extra",
  );

  await writeFile(join(root, "g"), "staged\n");
  execFileSync("git", ["-C", root, "add", "g"]);
  await rm(join(root, "g"));
  const staged = compareFingerprints(before, ok(await captureFingerprint(root)));
  expect(staged.state).toBe("changed");
  expect(staged.paths).toContain("g");

  execFileSync("git", ["-C", root, "config", "harness.marker", "changed"]);
  expect(
    compareFingerprints(before, ok(await captureFingerprint(root))).paths.some((path) =>
      path.includes("config"),
    ),
  ).toBe(true);

  const unknown = compareFingerprints(
    { version: 1, state: "unknown", reason: "fingerprint size budget exceeded" },
    ok(await captureFingerprint(root)),
  );
  expect(unknown).toEqual({
    state: "unknown",
    paths: [],
    total: 0,
    reason: "fingerprint size budget exceeded",
  });
});

it("hashes symlink targets without following them", async () => {
  const root = await scratch();
  const outside = await scratch();
  await writeFile(join(outside, "secret"), "outside\n");
  await symlink(join(outside, "secret"), join(root, "link"));
  await symlink(outside, join(root, "dirlink"));
  const first = ok(await captureFingerprint(root));
  expect(first.kind).toBe("dir");
  expect(first.files.dirlink).toMatch(/^symlink:/);
  await symlink(join(outside, "secret"), join(root, "other"));
  await rm(join(root, "link"));
  await symlink(join(outside, "missing"), join(root, "link"));
  const changed = compareFingerprints(first, ok(await captureFingerprint(root)));
  expect(changed.paths).toEqual(["link", "other"]);
  expect(ok(await captureFingerprint(root)).files).not.toHaveProperty("secret");
});

it("returns unknown instead of clean when the testing budget is exceeded", async () => {
  const root = await gitRepo();
  process.env.PI_SUBAGENTS_FINGERPRINT_MAX_BYTES = "1";
  const limited = await captureFingerprint(root);
  expect(limited.state).toBe("unknown");
  if (limited.state === "unknown") expect(limited.reason).toMatch(/size budget/);
  process.env.PI_SUBAGENTS_FINGERPRINT_MAX_BYTES = previous.bytes;
  process.env.PI_SUBAGENTS_FINGERPRINT_MAX_MS = "0";
  const timed = await captureFingerprint(root);
  expect(timed).toMatchObject({ state: "unknown", reason: expect.stringMatching(/time budget/) });
});

it("sees a linked worktree config and the common config as separate paths", async () => {
  const root = await gitRepo();
  const linked = join(root, "..", "linked-worktree");
  execFileSync("git", ["-C", root, "worktree", "add", "-qb", "linked", linked]);
  roots.push(linked);
  const before = ok(await captureFingerprint(linked));
  execFileSync("git", ["-C", linked, "config", "extensions.worktreeConfig", "true"]);
  execFileSync("git", ["-C", linked, "config", "--worktree", "harness.worktree", "1"]);
  execFileSync("git", ["-C", root, "config", "harness.common", "1"]);
  const changed = compareFingerprints(before, ok(await captureFingerprint(linked)));
  expect(changed.state).toBe("changed");
  expect(
    changed.paths.some((path) => path.includes("config.worktree") || path.includes("worktree")),
  ).toBe(true);
  expect(
    changed.paths.some((path) => path.includes("common-config") || path.endsWith("config")),
  ).toBe(true);
});

it("sees a change to one stage of a conflicted path", async () => {
  const root = await gitRepo();
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  git("checkout", "-qb", "theirs");
  await writeFile(join(root, "f"), "theirs\n");
  git("commit", "-qam", "theirs");
  git("checkout", "-q", "-");
  await writeFile(join(root, "f"), "ours\n");
  git("commit", "-qam", "ours");
  try {
    git("merge", "-q", "theirs");
  } catch {
    // The conflict is the point: the index now holds stages 1, 2 and 3 for f.
  }
  const before = ok(await captureFingerprint(root));
  const other = execFileSync("git", ["-C", root, "hash-object", "-w", "--stdin"], {
    input: "another base\n",
    encoding: "utf8",
  }).trim();
  execFileSync("git", ["-C", root, "update-index", "--index-info"], {
    input: `100644 ${other} 1\tf\n`,
  });
  expect(git("ls-files", "--stage", "f").split("\n")).toHaveLength(3);
  const after = ok(await captureFingerprint(root));
  expect(compareFingerprints(before, after)).toMatchObject({ state: "changed", paths: ["f"] });
});
