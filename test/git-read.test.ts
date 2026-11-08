import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { refusedGitArgument, runGitRead, validateGitReadArgs } from "../src/git-read.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function repo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pirs-git-read-"));
  roots.push(root);
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "config", "user.email", "probe@example.com"]);
  execFileSync("git", ["-C", root, "config", "user.name", "Probe"]);
  await writeFile(join(root, "f"), "hi\n");
  execFileSync("git", ["-C", root, "add", "f"]);
  execFileSync("git", ["-C", root, "commit", "-qm", "init"]);
  return root;
}

async function markerScript(
  root: string,
  name: string,
): Promise<{ script: string; marker: string }> {
  const script = join(root, name);
  const marker = join(root, `${name}.marker`);
  await writeFile(script, `#!/bin/sh\necho ran >> '${marker}'\ncat\n`, { mode: 0o700 });
  await chmod(script, 0o700);
  return { script, marker };
}

async function unchanged(root: string, body: () => Promise<void>): Promise<void> {
  const before = await snapshot(root);
  await body();
  expect(await snapshot(root)).toEqual(before);
}

async function snapshot(root: string): Promise<{ stage: string; files: string }> {
  const files: string[] = [];
  const walk = async (dir: string, rel: string): Promise<void> => {
    for (const name of (await readdir(dir)).sort()) {
      if (rel === "" && name === ".git") continue;
      const child = join(dir, name);
      const childRel = rel ? `${rel}/${name}` : name;
      const stat = await lstat(child);
      if (stat.isSymbolicLink()) {
        files.push(`${childRel}:link`);
        continue;
      }
      if (stat.isDirectory()) {
        await walk(child, childRel);
        continue;
      }
      files.push(
        `${childRel}:${createHash("sha256")
          .update(await readFile(child))
          .digest("hex")}`,
      );
    }
  };
  await walk(root, "");
  return {
    stage: execFileSync(
      "git",
      [
        "-C",
        root,
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.hooksPath=/dev/null",
        "ls-files",
        "--stage",
      ],
      { encoding: "utf8" },
    ),
    files: files.join("\n"),
  };
}

it("refuses dangerous flags and unique prefixes before git runs", () => {
  expect(validateGitReadArgs(["log"])).toBeNull();
  expect(validateGitReadArgs(["bundle"])).toMatch(/only allows/);
  for (const arg of [
    "--output=/tmp/x",
    "--outp=x",
    "--open-f",
    "--show-s",
    "--text",
    "-c",
    "-ckey=value",
    "-O",
    "-Ofile",
  ])
    expect(refusedGitArgument(arg), arg).toBeTruthy();
  expect(refusedGitArgument("--exclude-standard")).toBeNull();
  expect(refusedGitArgument("--cached")).toBeNull();
  expect(refusedGitArgument("--no-textconv")).toBeNull();
  expect(validateGitReadArgs(["grep", "--open-f", "hi"])).toMatch(/open-files-in-pager/);
});

it("refuses a prefix that real git accepts, and does not create its output file", async () => {
  const root = await repo();
  const pager = join(root, "pager");
  const marker = join(root, "pager.marker");
  await writeFile(pager, `#!/bin/sh\necho ran >> '${marker}'\ncat\n`, { mode: 0o700 });
  execFileSync("git", ["-C", root, "grep", `--open-files-in-pager=${pager}`, "hi"], {
    encoding: "utf8",
  });
  expect(await readFile(marker, "utf8")).toBe("ran\n");
  await rm(marker);
  await expect(runGitRead(root, ["grep", "--open-f", "hi"])).rejects.toThrow(/open-files-in-pager/);
  await expect(readFile(marker, "utf8")).rejects.toThrow(/ENOENT/);
  const output = join(root, "diff-out");
  execFileSync("git", ["-C", root, "diff", `--output=${output}`]);
  expect(await readFile(output, "utf8")).toBe("");
  await rm(output);
  await expect(runGitRead(root, ["diff", `--output=${output}`])).rejects.toThrow(/output/);
  await expect(readFile(output, "utf8")).rejects.toThrow(/ENOENT/);
});

it("does not run a clean filter, smudge filter, diff driver, external diff, fsmonitor, or hook", async () => {
  const root = await repo();
  const filter = await markerScript(root, "filter");
  execFileSync("git", ["-C", root, "config", "filter.x.clean", filter.script]);
  execFileSync("git", ["-C", root, "config", "filter.x.smudge", filter.script]);
  await writeFile(join(root, ".gitattributes"), "* filter=x\n");
  execFileSync("git", ["-C", root, "status", "--porcelain"]);
  expect(await readFile(filter.marker, "utf8")).toMatch(/ran/);
  await rm(filter.marker);
  await unchanged(root, async () => {
    await runGitRead(root, ["status"]);
    await runGitRead(root, ["diff"]);
    await runGitRead(root, ["blame", "HEAD", "--", "f"]);
  });
  await expect(readFile(filter.marker, "utf8")).rejects.toThrow(/ENOENT/);

  const driver = await markerScript(root, "driver");
  execFileSync("git", ["-C", root, "config", "diff.x.command", driver.script]);
  execFileSync("git", ["-C", root, "config", "diff.x.textconv", driver.script]);
  await writeFile(join(root, ".gitattributes"), "* diff=x\n");
  await writeFile(join(root, "f"), "changed\n");
  execFileSync("git", ["-C", root, "diff"], { encoding: "utf8" });
  expect(await readFile(driver.marker, "utf8")).toMatch(/ran/);
  await rm(driver.marker);
  await unchanged(root, async () => {
    await runGitRead(root, ["diff"]);
  });
  await expect(readFile(driver.marker, "utf8")).rejects.toThrow(/ENOENT/);

  const externalRoot = await repo();
  await writeFile(join(externalRoot, "f"), "changed\n");
  const external = await markerScript(externalRoot, "external");
  execFileSync("git", ["-C", externalRoot, "config", "diff.external", external.script]);
  execFileSync("git", ["-C", externalRoot, "diff"], {
    env: { ...process.env, GIT_EXTERNAL_DIFF: external.script },
  });
  expect(await readFile(external.marker, "utf8")).toMatch(/ran/);
  await rm(external.marker);
  await unchanged(externalRoot, async () => {
    await runGitRead(externalRoot, ["diff"]);
  });
  const previous = process.env.GIT_EXTERNAL_DIFF;
  process.env.GIT_EXTERNAL_DIFF = external.script;
  try {
    await runGitRead(externalRoot, ["diff"]);
  } finally {
    if (previous === undefined) delete process.env.GIT_EXTERNAL_DIFF;
    else process.env.GIT_EXTERNAL_DIFF = previous;
  }
  await expect(readFile(external.marker, "utf8")).rejects.toThrow(/ENOENT/);

  const watchRoot = await repo();
  const watch = await markerScript(watchRoot, "fsmonitor");
  execFileSync("git", ["-C", watchRoot, "config", "core.fsmonitor", watch.script]);
  execFileSync("git", ["-C", watchRoot, "status"]);
  expect(await readFile(watch.marker, "utf8")).toMatch(/ran/);
  await rm(watch.marker);
  await unchanged(watchRoot, async () => {
    await runGitRead(watchRoot, ["status"]);
  });
  await expect(readFile(watch.marker, "utf8")).rejects.toThrow(/ENOENT/);

  const hookRoot = await repo();
  const hooks = join(hookRoot, "evil-hooks");
  const hookMarker = join(hookRoot, "hook.marker");
  await writeFile(join(hookRoot, "hook.sh"), `#!/bin/sh\necho ran >> '${hookMarker}'\n`, {
    mode: 0o700,
  });
  execFileSync("mkdir", ["-p", hooks]);
  execFileSync("cp", [join(hookRoot, "hook.sh"), join(hooks, "post-index-change")]);
  execFileSync("chmod", ["+x", join(hooks, "post-index-change")]);
  execFileSync("git", ["-C", hookRoot, "config", "core.hooksPath", hooks]);
  execFileSync("git", ["-C", hookRoot, "status"]);
  expect(await readFile(hookMarker, "utf8")).toMatch(/ran/);
  await rm(hookMarker);
  await unchanged(hookRoot, async () => {
    await runGitRead(hookRoot, ["status"]);
  });
  await expect(readFile(hookMarker, "utf8")).rejects.toThrow(/ENOENT/);
});

it("does not run gpg.program for log or show when the repo enables showSignature", async () => {
  const root = await repo();
  const marker = join(root, "gpg.marker");
  const program = join(root, "gpg.sh");
  await writeFile(program, `#!/bin/sh\necho ran >> '${marker}'\nexit 1\n`, { mode: 0o700 });
  const tree = execFileSync("git", ["-C", root, "write-tree"], { encoding: "utf8" }).trim();
  const body = `tree ${tree}\nauthor Probe <probe@example.com> 1700000000 +0000\ncommitter Probe <probe@example.com> 1700000000 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n dummy-signature\n -----END PGP SIGNATURE-----\n\nsigned\n`;
  const oid = execFileSync("git", ["-C", root, "hash-object", "-t", "commit", "-w", "--stdin"], {
    input: body,
    encoding: "utf8",
  }).trim();
  execFileSync("git", ["-C", root, "update-ref", "HEAD", oid]);
  execFileSync("git", ["-C", root, "config", "gpg.program", program]);
  execFileSync("git", ["-C", root, "config", "log.showSignature", "true"]);
  execFileSync("git", ["-C", root, "log", "--show-signature", "-1"]);
  expect(await readFile(marker, "utf8")).toMatch(/ran/);
  await rm(marker);
  await unchanged(root, async () => {
    await runGitRead(root, ["log", "-1"]);
    await runGitRead(root, ["show", "HEAD"]);
  });
  await expect(readFile(marker, "utf8")).rejects.toThrow(/ENOENT/);
  await expect(runGitRead(root, ["log", "--show-signature", "-1"])).rejects.toThrow(
    /show-signature/,
  );
  await expect(readFile(marker, "utf8")).rejects.toThrow(/ENOENT/);
});
