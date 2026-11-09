import { appendFile, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Type, type Static } from "typebox";
import {
  contains,
  decide,
  launchCycle,
  overlaps,
  reservationFor,
  type AdmissionRun,
  type Limits,
  type Snapshot,
} from "./admission-core.ts";
import { readClaim, withAdmissionLock } from "./claims.ts";
import {
  atomicWrite,
  errorText,
  isMissing,
  parse,
  privateDirectory,
  readJson,
  readRun,
  listRuns,
  updateActivity,
  stateDir,
  writeRun,
  RunRecord,
} from "./records.ts";
import { observeProcess, traceRex } from "./rex.ts";

const positive = Type.Integer({ minimum: 1 });
const LimitsFile = Type.Object(
  {
    active: Type.Optional(positive),
    depth: Type.Optional(positive),
    providers: Type.Optional(Type.Record(Type.String({ minLength: 1 }), positive)),
  },
  { additionalProperties: false },
);
export async function readLimits(): Promise<Limits> {
  const path = join(stateDir(), "limits.json");
  try {
    const input = parse(LimitsFile, await readJson(path));
    return { active: input.active ?? 4, depth: input.depth ?? 2, providers: input.providers ?? {} };
  } catch (error) {
    if (isMissing(error)) return { active: 4, depth: 2, providers: {} };
    throw new Error(`Invalid admission limits ${path}: ${errorText(error)}`, { cause: error });
  }
}
const Member = Type.Object(
  {
    runId: Type.String(),
    access: RunRecord.properties.access,
    checkout: Type.String(),
    provider: Type.String(),
  },
  { additionalProperties: false },
);
const Reservation = Type.Object(
  { id: Type.String(), members: Type.Array(Member) },
  { additionalProperties: false },
);
export type Reservation = Static<typeof Reservation>;
const Ticket = Type.Object(
  { runId: Type.String(), seq: Type.Integer({ minimum: 0 }) },
  { additionalProperties: false },
);
type Ticket = Static<typeof Ticket>;
const pathForTicket = (ticket: Ticket) =>
  join(stateDir(), "queue", `${ticket.seq}-${ticket.runId}.json`);
const pathForReservation = (id: string) => join(stateDir(), "reservations", `${id}.json`);
async function files(directory: string): Promise<string[]> {
  try {
    return (await readdir(join(stateDir(), directory)))
      .filter((name) => name.endsWith(".json"))
      .map((name) => join(stateDir(), directory, name));
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}
export async function readReservations(): Promise<Reservation[]> {
  return Promise.all(
    (await files("reservations")).map(async (path) => parse(Reservation, await readJson(path))),
  );
}
async function readTickets(): Promise<Ticket[]> {
  return Promise.all(
    (await files("queue")).map(async (path) => parse(Ticket, await readJson(path))),
  );
}
/** Admission lock required. Removing a ticket is idempotent; membership requires Rex exit proof. */
export async function removeTicket(runId: string): Promise<void> {
  for (const ticket of await readTickets())
    if (ticket.runId === runId) await unlink(pathForTicket(ticket));
}
export async function updateMemberProvider(runId: string, provider: string): Promise<void> {
  await withAdmissionLock(async () => {
    for (const reservation of await readReservations()) {
      const member = reservation.members.find((member) => member.runId === runId);
      if (member) {
        member.provider = provider;
        await atomicWrite(pathForReservation(reservation.id), reservation);
      }
    }
  });
}
/** Called only under admission lock. Unknown launch/liveness never frees a reservation. */
async function collect(): Promise<{ reservations: Reservation[]; checked: number }> {
  let checked = 0;
  const reservations = await readReservations();
  for (const reservation of reservations) {
    const kept = [];
    for (const member of reservation.members) {
      const record = await readRun(member.runId);
      let exited = record.process.state === "exited";
      if (record.rex) {
        checked += 1;
        exited = (await observeProcess(record.location ?? record.rex)).process.state === "exited";
      }
      if (!exited) kept.push(member);
    }
    reservation.members = kept;
    if (kept.length) await atomicWrite(pathForReservation(reservation.id), reservation);
    else await unlink(pathForReservation(reservation.id));
  }
  return {
    reservations: reservations.filter((reservation) => reservation.members.length),
    checked,
  };
}
/** Called under admission. Keep exited ancestry in the graph even after membership ends. */
export async function admissionSnapshot(
  limits: Limits,
  savedReservations?: Reservation[],
): Promise<Snapshot> {
  const reservations = savedReservations ?? (await readReservations());
  const records = await listRuns();
  const tickets = await readTickets();
  const runs: AdmissionRun[] = [];
  for (const record of records) {
    const reservation = reservations.find((r) => r.members.some((m) => m.runId === record.id));
    const ticket = tickets.find((t) => t.runId === record.id);
    const winner = await readClaim(record.paths.claim);
    const claimed = await claimedAncestor(record);
    if (ticket && (winner || claimed)) await removeTicket(record.id);
    runs.push({
      id: record.id,
      parent: record.parentRunId,
      access: record.access,
      checkout: record.checkoutRoot,
      provider:
        reservation?.members.find((m) => m.runId === record.id)?.provider ??
        record.effective.provider,
      state: reservation
        ? winner === "taken_over"
          ? "taken"
          : record.activity?.parked
            ? "parked"
            : "running"
        : ticket && !winner && !claimed
          ? "queued"
          : "exited",
      reservation: reservation?.id ?? null,
      ticket: ticket?.seq ?? null,
      detached: winner === "taken_over",
      readyToWake: record.activity?.readyToWake ?? false,
    });
  }
  const snapshot = { runs, limits };
  for (const run of runs) {
    if (run.state !== "queued") continue;
    const reservation = reservationFor(snapshot, run);
    if (!reservation) continue;
    run.joining = [];
    const launching = records.find((r) => r.id === run.id);
    let parent = run.parent;
    while (parent) {
      const ancestor = runs.find((r) => r.id === parent);
      const record = records.find((r) => r.id === parent);
      if (!ancestor || !record) break;
      if (
        ancestor.reservation === reservation &&
        overlaps(ancestor.checkout, run.checkout) &&
        record.activity?.tools.some((tool) => tool.name !== "subagent")
      )
        run.joining.push(parent);
      if (
        parent === run.parent &&
        run.joining.includes(parent) &&
        launching?.launchCaller &&
        !launching.background &&
        record.activity?.tools.some(
          (tool) =>
            tool.name !== "subagent" &&
            (tool.id === launching.launchCaller ||
              launching.launchCaller?.startsWith(`${tool.id}/`)),
        )
      )
        run.joinCycle = parent;
      parent = ancestor.parent;
    }
  }
  return snapshot;
}
export async function claimedAncestor(run: RunRecord): Promise<string | null> {
  let parent = run.parentRunId;
  while (parent) {
    const record = await readRun(parent);
    if (await readClaim(record.paths.claim)) return parent;
    parent = record.parentRunId;
  }
  return null;
}
async function pass(
  limits: Limits,
): Promise<{ snapshot: Snapshot; reservations: Reservation[]; checked: number }> {
  const { reservations, checked } = await collect();
  const snapshot = await admissionSnapshot(limits, reservations);
  const runs = snapshot.runs;
  const admitted = decide(snapshot).admit;
  if (admitted) {
    const run = runs.find((run) => run.id === admitted.id);
    if (!run || run.ticket === null) throw new Error("Admission lost ticket");
    const reservation = reservations.find((r) => r.id === admitted.reservation) ?? {
      id: admitted.reservation,
      members: [],
    };
    reservation.members.push({
      runId: run.id,
      access: run.access,
      checkout: run.checkout,
      provider: run.provider,
    });
    await atomicWrite(pathForReservation(reservation.id), reservation);
    await unlink(pathForTicket({ runId: run.id, seq: run.ticket }));
    if (!reservations.includes(reservation)) reservations.push(reservation);
  }
  return { snapshot, reservations, checked };
}
async function notePass(metric: {
  holdMs: number;
  rexCalls: number;
  members: number;
  checked: number;
}): Promise<void> {
  const path = process.env.PI_SUBAGENTS_ADMISSION_METRICS;
  if (!path) return;
  await appendFile(path, `${JSON.stringify({ at: Date.now(), ...metric })}\n`);
}
export async function admit(
  run: RunRecord,
  signal?: AbortSignal,
  progress: (run: RunRecord) => void = () => {},
  pause?: AbortSignal,
): Promise<boolean | "paused"> {
  await withAdmissionLock(async () => {
    await readLimits();
    await privateDirectory(join(stateDir(), "queue"));
    await privateDirectory(join(stateDir(), "reservations"));
    if ((await readClaim(run.paths.claim)) || signal?.aborted) return;
    const ancestor = await claimedAncestor(run);
    if (ancestor) throw new Error(`Launch refused: ancestor ${ancestor} already has a claim`);
    if (
      (await readTickets()).some((ticket) => ticket.runId === run.id) ||
      (await readReservations()).some((r) => r.members.some((m) => m.runId === run.id))
    )
      return;
    const counter = join(stateDir(), "sequence.json");
    let seq = 0;
    try {
      seq = parse(
        Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER - 1 }),
        await readJson(counter),
      );
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    await atomicWrite(counter, seq + 1);
    await atomicWrite(pathForTicket({ runId: run.id, seq }), { runId: run.id, seq });
    const cycle = launchCycle(await admissionSnapshot(await readLimits()), run.id);
    if (cycle) {
      await removeTicket(run.id);
      throw new Error(`Nested launch refused: wait cycle ${cycle.join(" -> ")}`);
    }
  });
  while (true) {
    const measured = await withAdmissionLock(async () => {
      const started = performance.now();
      const traced = await traceRex(async () => {
        const limits = await readLimits();
        if (signal?.aborted || (await readClaim(run.paths.claim)) || (await claimedAncestor(run))) {
          await removeTicket(run.id);
          if (run.queue) {
            run.queue = null;
            await writeRun(run);
          }
          return { outcome: "cancelled" as const, members: 0, checked: 0 };
        }
        if (pause?.aborted) return { outcome: "paused" as const, members: 0, checked: 0 };
        const { snapshot, reservations, checked } = await pass(limits);
        const members = reservations.reduce(
          (count, reservation) => count + reservation.members.length,
          0,
        );
        if (reservations.some((r) => r.members.some((m) => m.runId === run.id))) {
          if (run.queue) {
            run.queue = null;
            await writeRun(run);
          }
          return { outcome: "admitted" as const, members, checked };
        }
        const ticket = decide(snapshot).tickets.find((item) => item.id === run.id);
        const reason = ticket?.reason === "checkout" ? "checkout" : "capacity";
        const detail =
          reason === "checkout"
            ? ticket?.blockers.join(", ") || "overlapping checkout"
            : "active or provider ceiling, or an older capacity ticket";
        if (run.queue?.reason !== reason || run.queue.detail !== detail) {
          run.queue = { reason, detail, since: run.queue?.since ?? Date.now() };
          await writeRun(run);
          progress(run);
        }
        return { outcome: "waiting" as const, members, checked };
      });
      return {
        outcome: traced.value.outcome,
        members: traced.value.members,
        checked: traced.value.checked,
        holdMs: performance.now() - started,
        rexCalls: traced.calls,
      };
    });
    await notePass(measured);
    if (measured.outcome === "paused") return "paused";
    if (measured.outcome !== "waiting") return measured.outcome === "admitted";
    await delay(200);
  }
}

export async function writerOnPath(target: string, memberId?: string): Promise<RunRecord | null> {
  return withAdmissionLock(async () => {
    await readLimits();
    const reservations = (await collect()).reservations;
    if (memberId) {
      const own = await readRun(memberId);
      const reservation = reservations.find((r) => r.members.some((m) => m.runId === memberId));
      if (contains(own.checkoutRoot, target) && reservation)
        for (const member of reservation.members)
          if (await isDescendant(member.runId, memberId)) return readRun(member.runId);
    }
    for (const reservation of reservations)
      for (const member of reservation.members) {
        if (member.runId === memberId || (memberId && (await isDescendant(memberId, member.runId))))
          continue;
        if (
          contains(member.checkout, target) &&
          (member.access === "write" || (memberId && (await isDescendant(member.runId, memberId))))
        )
          return readRun(member.runId);
      }
    return null;
  });
}

export async function isDescendant(id: string, ancestor: string): Promise<boolean> {
  let parent = (await readRun(id)).parentRunId;
  while (parent) {
    if (parent === ancestor) return true;
    parent = (await readRun(parent)).parentRunId;
  }
  return false;
}
export async function park(
  id: string,
  reason: "foreground" | "settled",
  callId?: string,
): Promise<void> {
  await updateActivity(id, (activity) => {
    activity.parked = reason;
    activity.readyToWake = false;
    if (callId && !activity.foreground.includes(callId)) activity.foreground.push(callId);
  });
}
/** Return to model work is a separate admission, before every newer launch ticket. */
export async function wake(id: string, callId?: string): Promise<void> {
  await updateActivity(id, (activity) => {
    if (callId) activity.foreground = activity.foreground.filter((call) => call !== callId);
    if (activity.parked && !activity.foreground.length) activity.readyToWake = true;
  });
  while (true) {
    const done = await tryWake(id);
    if (done) return;
    await delay(200);
  }
}

export async function tryWake(id: string): Promise<boolean> {
  return withAdmissionLock(async () => {
    const run = await readRun(id);
    if (
      !run.activity?.parked ||
      run.activity.foreground.length ||
      (await readClaim(run.paths.claim))
    )
      return true;
    const snapshot = await admissionSnapshot(await readLimits(), (await collect()).reservations);
    if (!decide(snapshot).wakes.find((r) => r.id === id)?.hasSlot) return false;
    await updateActivity(id, (activity) => {
      activity.parked = null;
      activity.readyToWake = false;
    });
    return true;
  });
}
