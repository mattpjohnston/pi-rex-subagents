import { constants } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { repo } from "./run.ts";
import type { Run } from "./run.ts";

async function piExecutable(): Promise<string> {
  const name = process.env.PI_SUBAGENTS_PI ?? "pi";
  const candidates =
    isAbsolute(name) || name.includes("/")
      ? [resolve(name)]
      : (process.env.PATH ?? "").split(delimiter).map((dir) => resolve(dir, name));
  for (const path of candidates) {
    try {
      await access(path, constants.X_OK);
      return path;
    } catch (error) {
      if (
        !(
          error instanceof Error &&
          "code" in error &&
          ["ENOENT", "EACCES", "ENOTDIR"].includes(String(error.code))
        )
      ) {
        throw error;
      }
    }
  }
  throw new Error("Pi executable not found; set PI_SUBAGENTS_PI or add pi to PATH");
}

export async function parentArgv(run: Run, label: string, prompt: string): Promise<string[]> {
  if (!/^[a-z0-9-]+$/.test(label)) throw new Error("Invalid Pi session label");
  const sessionDir = join(run.sessions, label);
  await mkdir(sessionDir, { mode: 0o700 });
  // Only these non-secret harness paths are forwarded; env argv is visible in ps.
  return [
    "/usr/bin/env",
    `PI_SUBAGENTS_STATE_DIR=${run.state}`,
    `HARNESS_TOOL_LOG=${join(run.out, `${label}-tools.jsonl`)}`,
    await piExecutable(),
    "--no-extensions",
    "-e",
    join(repo, "src", "index.ts"),
    "-e",
    join(repo, "harness", "log-tools.ts"),
    "--model",
    process.env.HARNESS_MODEL ?? "openrouter/nvidia/nemotron-3.5-lightning:free",
    "--thinking",
    "low",
    "--session-dir",
    sessionDir,
    prompt,
  ];
}
