import { readClaim } from "./claims.ts";
import type { RunRecord } from "./records.ts";
import { closeBlock, observeProcess } from "./rex.ts";

export async function clearEligible(run: RunRecord): Promise<boolean> {
  if (run.lifecycle !== "completed" || !run.rex || (await readClaim(run.paths.claim)) !== "result")
    return false;
  const observation = await observeProcess(run.location ?? run.rex);
  return observation.location !== null && observation.process.state === "exited";
}
export async function dismiss(run: RunRecord): Promise<void> {
  if (!run.rex) throw new Error(`Run ${run.id} has no known block`);
  const observation = await observeProcess(run.location ?? run.rex);
  if (observation.process.state !== "exited")
    throw new Error(`Refusing dismissal of live or unknown child ${run.id}`);
  if (observation.location) await closeBlock(observation.location);
}
