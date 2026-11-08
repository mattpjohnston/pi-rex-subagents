export type Access = "read" | "inspect" | "write";
export interface AdmissionRun {
  id: string;
  parent: string | null;
  access: Access;
  checkout: string;
  provider: string;
  state: "queued" | "running" | "parked" | "taken" | "exited";
  reservation: string | null;
  ticket: number | null;
  detached: boolean;
  readyToWake: boolean;
}
export interface Limits {
  active: number;
  depth: number;
  providers: Record<string, number>;
}
export interface Snapshot {
  runs: AdmissionRun[];
  limits: Limits;
}
export interface TicketDecision {
  id: string;
  blockers: string[];
  reason: "checkout" | "capacity" | null;
}
export interface AdmissionDecision {
  tickets: TicketDecision[];
  admit: { id: string; reservation: string } | null;
  wakes: { id: string; hasSlot: boolean }[];
}
export function contains(root: string, target: string): boolean {
  return root === target || target.startsWith(root.endsWith("/") ? root : `${root}/`);
}
export function overlaps(a: string, b: string): boolean {
  return contains(a, b) || contains(b, a);
}
const compatible = (a: Access, b: Access) => a !== "write" && b !== "write";
const holds = (r: AdmissionRun) =>
  r.reservation !== null && r.state !== "queued" && r.state !== "exited";
function ancestors(snapshot: Snapshot, run: AdmissionRun): AdmissionRun[] {
  const out: AdmissionRun[] = [];
  let parent = run.parent;
  while (parent !== null) {
    const r = snapshot.runs.find((r) => r.id === parent);
    if (!r) break;
    out.push(r);
    parent = r.parent;
  }
  return out;
}
export function reservationFor(snapshot: Snapshot, run: AdmissionRun): string | null {
  return (
    ancestors(snapshot, run).find((a) => holds(a) && overlaps(a.checkout, run.checkout))
      ?.reservation ?? null
  );
}
export function blockers(snapshot: Snapshot, run: AdmissionRun, older: AdmissionRun[]): string[] {
  const anc = ancestors(snapshot, run);
  const reservation = reservationFor(snapshot, run);
  const out = new Set<string>();
  for (const other of snapshot.runs) {
    if (other.id === run.id || !holds(other) || !overlaps(other.checkout, run.checkout)) continue;
    if (anc.includes(other) && other.reservation === reservation) continue;
    if (!compatible(run.access, other.access)) out.add(other.id);
  }
  for (const other of older) {
    if (!overlaps(other.checkout, run.checkout) || compatible(run.access, other.access)) continue;
    if (reservation !== null && reservationFor(snapshot, other) !== reservation) continue;
    out.add(other.id);
  }
  return [...out].sort();
}
export function hasSlot(snapshot: Snapshot, run: AdmissionRun): boolean {
  const counted = snapshot.runs.filter((r) => r.state === "running" || r.state === "taken");
  const providerLimit = snapshot.limits.providers[run.provider];
  return (
    counted.length < snapshot.limits.active &&
    (providerLimit === undefined ||
      counted.filter((r) => r.provider === run.provider).length < providerLimit)
  );
}
function tickets(snapshot: Snapshot): AdmissionRun[] {
  return snapshot.runs
    .filter((r) => r.state === "queued")
    .sort((a, b) => (a.ticket ?? 0) - (b.ticket ?? 0));
}
/** One FIFO pass. Checkout waiters never hold the capacity line. */
export function decide(snapshot: Snapshot): AdmissionDecision {
  const waking = snapshot.runs.filter((r) => r.state === "parked" && r.readyToWake);
  const result: AdmissionDecision = {
    tickets: [],
    admit: null,
    wakes: waking.map((r) => ({ id: r.id, hasSlot: hasSlot(snapshot, r) })),
  };
  const older: AdmissionRun[] = [];
  let capacityHeld = false;
  for (const run of tickets(snapshot)) {
    const blocked = blockers(snapshot, run, older);
    older.push(run);
    const reason = blocked.length
      ? "checkout"
      : capacityHeld || waking.length || !hasSlot(snapshot, run)
        ? "capacity"
        : null;
    result.tickets.push({ id: run.id, blockers: blocked, reason });
    if (blocked.length) continue;
    if (reason === "capacity") {
      capacityHeld = true;
      continue;
    }
    if (!result.admit)
      result.admit = { id: run.id, reservation: reservationFor(snapshot, run) ?? run.id };
    // The model emits only one admission per pass. Later verdicts are still useful diagnostics.
    capacityHeld = true;
  }
  return result;
}
/** The snapshot includes the tentative launch, before it waits or parks its parent. */
export function launchCycle(snapshot: Snapshot, start: string): string[] | null {
  const edges = new Map<string, Set<string>>(snapshot.runs.map((r) => [r.id, new Set<string>()]));
  for (const run of snapshot.runs) {
    if (run.state === "exited" || run.state === "taken") continue;
    for (const child of snapshot.runs) {
      if (child.parent === run.id && child.state !== "exited" && !child.detached)
        edges.get(run.id)?.add(child.id);
    }
  }
  const older: AdmissionRun[] = [];
  for (const run of tickets(snapshot)) {
    for (const id of blockers(snapshot, run, older)) edges.get(run.id)?.add(id);
    older.push(run);
  }
  const visit = (id: string, path: string[], seen: Set<string>): string[] | null => {
    for (const next of edges.get(id) ?? []) {
      if (next === start) return [...path, start];
      if (seen.has(next)) continue;
      seen.add(next);
      const cycle = visit(next, [...path, next], seen);
      if (cycle) return cycle;
    }
    return null;
  };
  return visit(start, [start], new Set([start]));
}
