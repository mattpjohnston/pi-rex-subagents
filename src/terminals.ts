import { readClaim } from "./claims.ts";
import { readRun, writeRun, type Location, type RunRecord } from "./records.ts";
import { closeBlock, locate, object, observeProcess, rexJson } from "./rex.ts";

async function markTabClosed(run: RunRecord): Promise<void> {
  const current = await readRun(run.id);
  if (current.tabClosedAt === undefined) {
    current.tabClosedAt = Date.now();
    await writeRun(current);
  }
  run.tabClosedAt = current.tabClosedAt;
}

export async function clearEligible(
  run: RunRecord,
  sessions = new Map<string, Record<string, unknown>>(),
): Promise<{ location: Location; viewing: boolean } | null> {
  if (
    run.lifecycle !== "completed" ||
    !run.rex ||
    run.tabClosedAt !== undefined ||
    run.process.state !== "exited" ||
    (await readClaim(run.paths.claim)) !== "result"
  )
    return null;
  let location: Location | null;
  try {
    location = await locate(run.rex.blockId, run.location ?? run.rex);
  } catch {
    return null;
  }
  if (!location) {
    await markTabClosed(run);
    return null;
  }
  let session = sessions.get(location.sessionId);
  if (!session) {
    session = object(await rexJson(["session", "inspect", location.sessionId, "--json"]));
    sessions.set(location.sessionId, session);
  }
  const state = tabState(session, location, run.label);
  return state.kept ? null : { location, viewing: state.viewing };
}
export async function dismiss(run: RunRecord): Promise<void> {
  if (!run.rex) throw new Error(`Run ${run.id} has no known block`);
  const observation = await observeProcess(run.location ?? run.rex);
  if (observation.process.state !== "exited")
    throw new Error(`Refusing dismissal of live or unknown child ${run.id}`);
  if (observation.location) await closeBlock(observation.location);
  await markTabClosed(run);
}

/** A tab you just left stays this long, so tabbing past it does not close it. */
export const VIEW_SETTLE_MS = 5_000;
export function closeDecision(input: {
  eligibleSince: number;
  lastViewedAt: number | null;
  viewing: boolean;
  now: number;
  graceMs: number | null;
}): "close" | "wait" {
  if (input.graceMs === null || input.viewing) return "wait";
  if (input.now - input.eligibleSince < input.graceMs) return "wait";
  if (input.lastViewedAt !== null && input.now - input.lastViewedAt < VIEW_SETTLE_MS) return "wait";
  return "close";
}
export const PIN = "📌 ";
/**
 * Rex does not report which session the app shows, so a tab counts as viewed while it is its
 * session's active tab. That errs towards keeping a tab: a tab you are looking at is always
 * active, and one left active in a session you walked away from merely stays a little longer.
 * A tab whose label no longer matches the launch label was pinned, renamed, or shared by the
 * human, and is kept.
 */
export function tabState(
  session: Record<string, unknown>,
  location: Location,
  launchLabel: string,
): { viewing: boolean; kept: boolean } {
  const windows = Array.isArray(session.windows) ? session.windows.map(object) : [];
  const tab = windows.find((window) => window.window_id === location.windowId);
  return {
    viewing: session.active_window_id === location.windowId,
    kept: tab !== undefined && tab.label !== launchLabel,
  };
}
export async function readTabState(
  location: Location,
  launchLabel: string,
): Promise<{ viewing: boolean; kept: boolean }> {
  const session = object(await rexJson(["session", "inspect", location.sessionId, "--json"]));
  return tabState(session, location, launchLabel);
}
export async function keep(run: RunRecord): Promise<void> {
  const where = run.rex ? (await observeProcess(run.location ?? run.rex)).location : null;
  if (!where) throw new Error(`Run ${run.id} has no open tab`);
  if ((await readTabState(where, run.label)).kept) return;
  await rexJson([
    "window",
    "rename",
    "-s",
    where.sessionId,
    where.windowId,
    `${PIN}${run.label}`,
    "--json",
  ]);
}
