import { readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Type, type Static } from "typebox";
import {
  contains,
  decide,
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
  stateDir,
  writeRun,
  RunRecord,
} from "./records.ts";
import { observeProcess } from "./rex.ts";

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
async function collect(): Promise<Reservation[]> {
  const reservations = await readReservations();
  for (const reservation of reservations) {
    const kept = [];
    for (const member of reservation.members) {
      const record = await readRun(member.runId);
      const exited = record.rex
        ? (await observeProcess(record.location ?? record.rex)).process.state === "exited"
        : record.process.state === "exited";
      if (!exited) kept.push(member);
    }
    reservation.members = kept;
    if (kept.length) await atomicWrite(pathForReservation(reservation.id), reservation);
    else await unlink(pathForReservation(reservation.id));
  }
  return reservations.filter((reservation) => reservation.members.length);
}
async function pass(limits: Limits): Promise<{ snapshot: Snapshot; reservations: Reservation[] }> {
  const reservations = await collect();
  const runs: AdmissionRun[] = [];
  for (const reservation of reservations)
    for (const member of reservation.members) {
      const record = await readRun(member.runId);
      runs.push({
        id: member.runId,
        parent: record.parentRunId,
        access: member.access,
        checkout: member.checkout,
        provider: member.provider,
        state: (await readClaim(record.paths.claim)) === "taken_over" ? "taken" : "running",
        reservation: reservation.id,
        ticket: null,
        detached: false,
        readyToWake: false,
      });
    }
  for (const ticket of await readTickets()) {
    const record = await readRun(ticket.runId);
    if (runs.some((run) => run.id === ticket.runId) || (await readClaim(record.paths.claim))) {
      await unlink(pathForTicket(ticket));
      continue;
    }
    runs.push({
      id: record.id,
      parent: record.parentRunId,
      access: record.access,
      checkout: record.checkoutRoot,
      provider: record.effective.provider,
      state: "queued",
      reservation: null,
      ticket: ticket.seq,
      detached: false,
      readyToWake: false,
    });
  }
  const snapshot = { runs, limits };
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
  return { snapshot, reservations };
}
export async function admit(
  run: RunRecord,
  signal?: AbortSignal,
  progress: (run: RunRecord) => void = () => {},
): Promise<boolean> {
  await withAdmissionLock(async () => {
    await readLimits();
    await privateDirectory(join(stateDir(), "queue"));
    await privateDirectory(join(stateDir(), "reservations"));
    if ((await readClaim(run.paths.claim)) || signal?.aborted) return;
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
  });
  while (true) {
    const outcome = await withAdmissionLock(async () => {
      const limits = await readLimits();
      if (signal?.aborted || (await readClaim(run.paths.claim))) {
        await removeTicket(run.id);
        return "cancelled";
      }
      const { snapshot, reservations } = await pass(limits);
      if (reservations.some((r) => r.members.some((m) => m.runId === run.id))) return "admitted";
      const ticket = decide(snapshot).tickets.find((ticket) => ticket.id === run.id);
      const reason =
        ticket?.reason === "checkout"
          ? `checkout: ${ticket.blockers.join(", ")}`
          : "capacity: active or provider ceiling / older capacity ticket";
      if (run.waiting?.title !== reason) {
        run.waiting = {
          source: "admission",
          kind: ticket?.reason ?? "capacity",
          title: reason,
          since: Date.now(),
        };
        await writeRun(run);
        progress(run);
      }
      return "waiting";
    });
    if (outcome !== "waiting") {
      run.waiting = null;
      return outcome === "admitted";
    }
    await delay(200);
  }
}

export async function writerOnPath(target: string): Promise<RunRecord | null> {
  return withAdmissionLock(async () => {
    await readLimits();
    for (const reservation of await collect())
      for (const member of reservation.members) {
        if (member.access === "write" && contains(member.checkout, target))
          return readRun(member.runId);
      }
    return null;
  });
}
