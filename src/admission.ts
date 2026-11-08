import type { RunRecord } from "./records.ts";

/** Phase 1 has no reservations or queue; phase 2 owns machine-wide admission here. */
export function admit(_run: RunRecord): Promise<void> {
  return Promise.resolve();
}
