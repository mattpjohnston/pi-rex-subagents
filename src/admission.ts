import { readdir, unlink } from "node:fs/promises";
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
  isTerminal,
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
import { observeProcess } from "./rex.ts";

const positive = Type.Integer({ minimum: 1 });
const LimitsFile = Type.Object(
  {
    keepRunsFor: Type.Optional(Type.Union([positive, Type.Literal(false)])),
    active: Type.Optional(positive),
    depth: Type.Optional(positive),
    providers: Type.Optional(Type.Record(Type.String({ minLength: 1 }), positive)),
    closeCompletedAfter: Type.Optional(
      Type.Union([Type.Integer({ minimum: 0 }), Type.Literal(false)]),
    ),
  },
  { additionalProperties: false },
);
/** limits.json, read fresh on every call. Missing means defaults; malformed throws, naming the file. */
export async function readLimits(): Promise<
  Limits & { closeCompletedAfterMs: number | null; keepRunsForMs: number | null }
> {
  const path = join(stateDir(), "limits.json");
  let input: Static<typeof LimitsFile> = {};
  try {
    input = parse(LimitsFile, await readJson(path));
  } catch (error) {
    if (!isMissing(error))
      throw new Error(`Invalid admission limits ${path}: ${errorText(error)}`, { cause: error });
  }
  const closeAfter = input.closeCompletedAfter ?? 60;
  const keepDays = input.keepRunsFor ?? 30;
  return {
    active: input.active ?? 4,
    depth: input.depth ?? 2,
    providers: input.providers ?? {},
    closeCompletedAfterMs: closeAfter === false ? null : closeAfter * 1000,
    keepRunsForMs: keepDays === false ? null : keepDays * 86_400_000,
  };
}
/** Read children, and children at the depth limit, get neither subagent tool. */
export async function canLaunchChildren(run: RunRecord): Promise<boolean> {
  return run.access !== "read" && run.depth < (await readLimits()).depth;
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
/** A reservation removed between listing and reading is skipped, so this is safe without the lock. */
export async function readReservations(): Promise<Reservation[]> {
  const read = await Promise.all(
    (await files("reservations")).map(async (path) => {
      try {
        return parse(Reservation, await readJson(path));
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
    }),
  );
  return read.filter((reservation) => reservation !== null);
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
/** Caller holds admission and has confirmed this run can be deleted with an exited process. */
export async function removeRunAdmission(runId: string): Promise<void> {
  await removeTicket(runId);
  for (const reservation of await readReservations()) {
    const kept = reservation.members.filter((member) => member.runId !== runId);
    if (kept.length === reservation.members.length) continue;
    reservation.members = kept;
    if (kept.length) await atomicWrite(pathForReservation(reservation.id), reservation);
    else await unlink(pathForReservation(reservation.id));
  }
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
/**
 * Members whose exit Rex confirms. Asked without the admission lock, because each Rex call can
 * take seconds and every lock user would wait. Exit is final, so a member seen exited here is
 * still exited when collect drops it. Unknown liveness never counts as exited.
 */
async function exitedMembers(): Promise<ReadonlySet<string>> {
  const exited = new Set<string>();
  for (const reservation of await readReservations())
    for (const member of reservation.members) {
      const record = await readRun(member.runId).catch((error: unknown) => {
        if (isMissing(error)) return null;
        throw error;
      });
      if (!record) continue;
      const gone = record.rex
        ? (await observeProcess(record.location ?? record.rex)).process.state === "exited"
        : record.process.state === "exited";
      if (gone) exited.add(member.runId);
    }
  return exited;
}
/** Caller holds admission. Drops members already confirmed exited; a reservation ends with its last. */
async function collect(exited: ReadonlySet<string>): Promise<Reservation[]> {
  const reservations = await readReservations();
  for (const reservation of reservations) {
    const kept = reservation.members.filter((member) => !exited.has(member.runId));
    if (kept.length === reservation.members.length) continue;
    reservation.members = kept;
    if (kept.length) await atomicWrite(pathForReservation(reservation.id), reservation);
    else await unlink(pathForReservation(reservation.id));
  }
  return reservations.filter((reservation) => reservation.members.length);
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
    let parent = run.parent;
    while (parent) {
      const ancestor = runs.find((r) => r.id === parent);
      const record = records.find((r) => r.id === parent);
      if (!ancestor || !record) break;
      const owner = parent;
      // A pending launch, and any call that encloses one (codemode, a harness wrapper), only
      // waits for its child; Pi tracks every call it makes as its own tool, so those still hold.
      const launchCallers = records
        .filter((r) => r.parentRunId === owner && r.launchCaller && !isTerminal(r.lifecycle))
        .map((r) => r.launchCaller ?? "");
      const encloses = (id: string) =>
        launchCallers.some((caller) => caller === id || caller.startsWith(`${id}/`));
      if (
        ancestor.reservation === reservation &&
        overlaps(ancestor.checkout, run.checkout) &&
        record.activity?.tools.some((tool) => tool.name !== "subagent" && !encloses(tool.id))
      )
        run.joining.push(parent);
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
  exited: ReadonlySet<string>,
): Promise<{ snapshot: Snapshot; reservations: Reservation[] }> {
  const reservations = await collect(exited);
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
  return { snapshot, reservations };
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
    const exited = await exitedMembers();
    const outcome = await withAdmissionLock(async () => {
      const limits = await readLimits();
      if (signal?.aborted || (await readClaim(run.paths.claim)) || (await claimedAncestor(run))) {
        await removeTicket(run.id);
        if (run.queue) {
          run.queue = null;
          await writeRun(run);
        }
        return "cancelled" as const;
      }
      if (pause?.aborted) return "paused" as const;
      const { snapshot, reservations } = await pass(limits, exited);
      if (reservations.some((r) => r.members.some((m) => m.runId === run.id))) {
        if (run.queue) {
          run.queue = null;
          await writeRun(run);
        }
        return "admitted" as const;
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
      return "waiting" as const;
    });
    if (outcome === "paused") return "paused";
    if (outcome !== "waiting") return outcome === "admitted";
    await delay(200);
  }
}

export async function writerOnPath(target: string, memberId?: string): Promise<RunRecord | null> {
  const exited = await exitedMembers();
  return withAdmissionLock(async () => {
    const reservations = await collect(exited);
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

async function waking(id: string): Promise<boolean> {
  const run = await readRun(id);
  return Boolean(
    run.activity?.parked && !run.activity.foreground.length && !(await readClaim(run.paths.claim)),
  );
}
export async function tryWake(id: string): Promise<boolean> {
  if (!(await withAdmissionLock(() => waking(id)))) return true;
  const exited = await exitedMembers();
  return withAdmissionLock(async () => {
    if (!(await waking(id))) return true;
    const snapshot = await admissionSnapshot(await readLimits(), await collect(exited));
    if (!decide(snapshot).wakes.find((r) => r.id === id)?.hasSlot) return false;
    await updateActivity(id, (activity) => {
      activity.parked = null;
      activity.readyToWake = false;
    });
    return true;
  });
}
