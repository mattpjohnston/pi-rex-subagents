import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, isAbsolute, resolve } from "node:path";
import {
  clampThinkingLevel,
  type Api,
  type Model,
  type ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import type { ModelSettings } from "./records.ts";

export function resolveSettings(
  parent: ModelSettings | undefined,
  input: { provider?: string; model?: string; thinking?: ModelThinkingLevel },
  find: (provider: string, id: string) => Model<Api> | undefined,
): { requested: ModelSettings; effective: ModelSettings } {
  let provider = input.provider?.trim() ?? parent?.provider ?? "";
  let id = input.model?.trim() ?? parent?.model ?? "";
  if (input.provider !== undefined && !provider) throw new Error("Empty provider override");
  if (input.model !== undefined && !id) throw new Error("Empty model override");
  if (input.model?.includes("/")) {
    const slash = id.indexOf("/");
    const prefix = id.slice(0, slash);
    const suffix = id.slice(slash + 1);
    // Explicit provider/model wins; inherited slash IDs are never reinterpreted.
    if (!input.provider) {
      provider = prefix;
      id = suffix;
    } else if (prefix === provider) id = suffix;
  }
  const model = find(provider, id);
  if (!model) throw new Error(`Unknown model selection: ${provider}/${id}; no provider fallback`);
  const requested = { provider, model: id, thinking: input.thinking ?? parent?.thinking ?? "off" };
  return {
    requested,
    effective: { ...requested, thinking: clampThinkingLevel(model, requested.thinking) },
  };
}

export async function executable(name: string): Promise<string> {
  const candidates =
    isAbsolute(name) || name.includes("/")
      ? [resolve(name)]
      : (process.env.PATH ?? "").split(delimiter).map((dir) => resolve(dir, name));
  for (const path of candidates) {
    try {
      await access(path, constants.X_OK);
      if ((await stat(path)).isFile()) return path;
    } catch (error) {
      if (
        !(
          error instanceof Error &&
          "code" in error &&
          ["ENOENT", "EACCES", "ENOTDIR"].includes(String(error.code))
        )
      )
        throw error;
    }
  }
  throw new Error(`Executable not found on PATH: ${name}`);
}
export async function workingDirectory(parent: string, requested?: string): Promise<string> {
  const path = await realpath(resolve(parent, requested ?? "."));
  if (!(await stat(path)).isDirectory()) throw new Error(`Not a directory: ${path}`);
  return path;
}
