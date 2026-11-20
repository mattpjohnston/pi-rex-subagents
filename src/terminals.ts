import { readClaim } from "./claims.ts";
import { readRun, writeRun, type Location, type RunRecord } from "./records.ts";
import {
  blockLabel,
  closeBlock,
  labelBlock,
  locate,
  object,
  observeProcess,
  rexJson,
} from "./rex.ts";

async function markTabClosed(run: RunRecord): Promise<void> {
  const current = await readRun(run.id);
  if (current.tabClosedAt === undefined) {
    current.tabClosedAt = Date.now();
    await writeRun(current);
  }
  run.tabClosedAt = current.tabClosedAt;
}

/** Where to look for a run's tab. Once Rex has confirmed the tab closed, nowhere. */
export function lastKnownTab(run: RunRecord): Location | null {
  return run.tabClosedAt === undefined ? (run.location ?? run.rex) : null;
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
  const state = tabState(
    session,
    location,
    run,
    location.windowId === null ? await blockLabel(location) : undefined,
  );
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
 * Rex does not report which session the app shows, so a child counts as viewed while it is in
 * its session's active tab. That errs towards keeping it: a child you are looking at is always
 * there, and one left there in a session you walked away from merely stays a little longer.
 *
 * A child in its own tab is kept once the tab's label no longer matches the launch label:
 * pinned, renamed, or shared by the human. A floating or detached child lives in someone else's
 * window or none, so its block's label decides instead, and it counts as viewed only while it
 * is the focused block of the active tab.
 */
export function tabState(
  session: Record<string, unknown>,
  location: Location,
  run: Pick<RunRecord, "label" | "placement">,
  detachedLabel?: string,
): { viewing: boolean; kept: boolean } {
  const windows = Array.isArray(session.windows) ? session.windows.map(object) : [];
  const tab = windows.find((window) => window.window_id === location.windowId);
  if ((run.placement ?? "tab") === "tab")
    return {
      viewing: session.active_window_id === location.windowId,
      kept: tab !== undefined && tab.label !== run.label,
    };
  if (location.windowId === null)
    return { viewing: false, kept: detachedLabel !== undefined && detachedLabel !== run.label };
  const layers = tab && Array.isArray(tab.layers) ? tab.layers.map(object) : [];
  const block = layers
    .flatMap((layer) => (Array.isArray(layer.blocks) ? layer.blocks.map(object) : []))
    .find((candidate) => candidate.block_id === location.blockId);
  return {
    viewing:
      session.active_window_id === location.windowId && tab?.focused_block_id === location.blockId,
    kept: block !== undefined && block.label !== run.label,
  };
}
export async function readTabState(
  location: Location,
  run: Pick<RunRecord, "label" | "placement">,
): Promise<{ viewing: boolean; kept: boolean }> {
  if (location.windowId === null) return tabState({}, location, run, await blockLabel(location));
  const session = object(await rexJson(["session", "inspect", location.sessionId, "--json"]));
  return tabState(session, location, run);
}
export async function keep(run: RunRecord): Promise<void> {
  const where = run.rex ? (await observeProcess(run.location ?? run.rex)).location : null;
  if (!where) throw new Error(`Run ${run.id} has no open tab`);
  if ((await readTabState(where, run)).kept) return;
  if ((run.placement ?? "tab") !== "tab" || where.windowId === null) {
    await labelBlock(where, `${PIN}${run.label}`);
    return;
  }
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
