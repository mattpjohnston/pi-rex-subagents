/** Callable-set checks for restricted children. Hidden tools are unreachable; inspect still rejects a hidden edit or write. */

/** Launch flags and the callable-set checks both read these, so they cannot disagree. */
export const READ_TOOLS = ["read", "grep", "find", "ls", "git_read"] as const;
export const INSPECT_EXCLUDED = ["edit", "write"] as const;

export interface ToolSnapshot {
  name: string;
  exposure: string;
}

const loadable = (exposure: string) => exposure !== "hidden";

/** Names beyond the read allowlist that are active or loadable (direct, model-only, deferred, codemode). */
export function readViolations(active: readonly string[], all: readonly ToolSnapshot[]): string[] {
  const allowed = new Set<string>(READ_TOOLS);
  const extras = new Set<string>();
  for (const name of active) if (!allowed.has(name)) extras.add(name);
  for (const tool of all) {
    if (!loadable(tool.exposure) || allowed.has(tool.name)) continue;
    extras.add(tool.name);
  }
  return [...extras].sort();
}

/** Exact tool names edit and write, at any exposure, including hidden. */
export function inspectViolations(
  active: readonly string[],
  all: readonly ToolSnapshot[],
): string[] {
  const banned = new Set<string>(INSPECT_EXCLUDED);
  const extras = new Set<string>();
  for (const name of active) if (banned.has(name)) extras.add(name);
  for (const tool of all) if (banned.has(tool.name)) extras.add(tool.name);
  return [...extras].sort();
}
