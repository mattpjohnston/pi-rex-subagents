import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { isMissing } from "./records.ts";

export async function checkoutRoot(cwd: string): Promise<string> {
  const root = await new Promise<string | null>((resolve, reject) => {
    execFile(
      "git",
      ["-C", cwd, "rev-parse", "--show-toplevel"],
      { encoding: "utf8", timeout: 5000, maxBuffer: 64 * 1024 },
      (error, stdout, stderr) => {
        if (!error) {
          resolve(stdout.trim());
          return;
        }
        if (error.code === 128 && stderr.includes("not a git repository")) {
          resolve(null);
          return;
        }
        reject(error);
      },
    );
  });
  return realpath(root ?? cwd);
}

/** Resolve non-existent write targets through the nearest existing ancestor, including symlinks. */
export async function canonicalTarget(cwd: string, input: string): Promise<string> {
  input = input.startsWith("@") ? input.slice(1) : input;
  const expanded =
    input === "~" ? homedir() : input.startsWith("~/") ? join(homedir(), input.slice(2)) : input;
  let path = resolve(cwd, expanded);
  const suffix: string[] = [];
  while (true) {
    try {
      return join(await realpath(path), ...suffix);
    } catch (error) {
      if (!isMissing(error)) throw error;
      const parent = dirname(path);
      if (parent === path) throw error;
      suffix.unshift(basename(path));
      path = parent;
    }
  }
}
