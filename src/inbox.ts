import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Type, type Static } from "typebox";
import { readClaim, withAdmissionLock, withRunLock } from "./claims.ts";
import { atomicWrite, isMissing, parse, readJson, type RunRecord } from "./records.ts";
import type { MessageState } from "./protocol.ts";

export const MESSAGE_ACK_MS = 10_000;
export const INBOX_POLL_MS = 250;
const object = { additionalProperties: false };
const id = Type.String({ pattern: "^[a-f0-9-]{36}$" });
export const InboxMessage = Type.Object(
  {
    id,
    runId: Type.String(),
    text: Type.String({ minLength: 1, maxLength: 50_000 }),
    sender: Type.String({ minLength: 1 }),
    createdAt: Type.Number(),
  },
  object,
);
export type InboxMessage = Static<typeof InboxMessage>;
const identity = { messageId: id, runId: Type.String() };
export const MessageAck = Type.Union([
  Type.Object(
    {
      ...identity,
      state: Type.Literal("accepted"),
      acceptedAt: Type.Number(),
      sentAt: Type.Union([Type.Number(), Type.Null()]),
    },
    object,
  ),
  Type.Object(
    {
      ...identity,
      state: Type.Literal("consumed"),
      acceptedAt: Type.Number(),
      sentAt: Type.Number(),
      consumedAt: Type.Number(),
    },
    object,
  ),
  Type.Object(
    {
      ...identity,
      state: Type.Literal("refused"),
      claim: Type.Union([
        Type.Literal("result"),
        Type.Literal("cancelled"),
        Type.Literal("taken_over"),
      ]),
      refusedAt: Type.Number(),
    },
    object,
  ),
]);
export type MessageAck = Static<typeof MessageAck>;
export interface InboxEntry {
  message: InboxMessage;
  ack: MessageAck | null;
}
export const ackPath = (run: RunRecord, messageId: string) =>
  join(run.paths.inbox, `${messageId}.ack.json`);
export async function readAck(run: RunRecord, messageId: string): Promise<MessageAck | null> {
  try {
    const ack = parse(MessageAck, await readJson(ackPath(run, messageId)));
    if (ack.messageId !== messageId || ack.runId !== run.id)
      throw new Error("Message ack identity mismatch");
    return ack;
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}
export async function inboxEntries(run: RunRecord): Promise<InboxEntry[]> {
  const entries = [];
  for (const name of (await readdir(run.paths.inbox)).sort()) {
    if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
    const message = parse(InboxMessage, await readJson(join(run.paths.inbox, name)));
    if (
      `${message.id}.json` !== name ||
      message.runId !== run.id ||
      message.sender !== run.parentSessionId
    )
      throw new Error("Inbox message identity mismatch");
    entries.push({ message, ack: await readAck(run, message.id) });
  }
  return entries;
}
export function messageState(entry: InboxEntry): MessageState {
  if (!entry.ack) return "written";
  if (entry.ack.state === "accepted") return entry.ack.sentAt === null ? "accepted" : "sent";
  return entry.ack.state;
}
export function messageText(messages: readonly InboxMessage[]): string {
  return messages.map((m) => `[subagent message ${m.id}]\n${m.text}`).join("\n\n");
}
/** Caller holds the run lock. */
export async function acceptWritten(run: RunRecord, entries: InboxEntry[]): Promise<void> {
  const winner = await readClaim(run.paths.claim);
  for (const entry of entries) {
    if (entry.ack) continue;
    entry.ack = winner
      ? {
          messageId: entry.message.id,
          runId: run.id,
          state: "refused",
          claim: winner,
          refusedAt: Date.now(),
        }
      : {
          messageId: entry.message.id,
          runId: run.id,
          state: "accepted",
          acceptedAt: Date.now(),
          sentAt: null,
        };
    await atomicWrite(ackPath(run, entry.message.id), entry.ack);
  }
}
export async function markSent(run: RunRecord, entries: InboxEntry[]): Promise<void> {
  for (const entry of entries) {
    if (entry.ack?.state !== "accepted" || entry.ack.sentAt !== null) continue;
    entry.ack = { ...entry.ack, sentAt: Date.now() };
    await atomicWrite(ackPath(run, entry.message.id), entry.ack);
  }
}
/** Only persisted user messages count. message_end itself fires before Pi appends the entry. */
export async function markConsumed(
  run: RunRecord,
  entries: InboxEntry[],
  userTexts: readonly string[],
): Promise<void> {
  for (const entry of entries) {
    if (entry.ack?.state !== "accepted" || entry.ack.sentAt === null) continue;
    if (!userTexts.some((text) => text.includes(`[subagent message ${entry.message.id}]`)))
      continue;
    entry.ack = {
      ...entry.ack,
      state: "consumed",
      sentAt: entry.ack.sentAt,
      consumedAt: Date.now(),
    };
    await atomicWrite(ackPath(run, entry.message.id), entry.ack);
  }
}
export type MessageReply =
  | { status: "accepted" | "unacknowledged"; messageId: string }
  | { status: "refused"; messageId?: string; reason: string };
export async function waitForAck(
  run: RunRecord,
  messageId: string,
  timeoutMs = MESSAGE_ACK_MS,
  signal?: AbortSignal,
): Promise<MessageReply> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const ack = await readAck(run, messageId);
    if (ack)
      return ack.state === "refused"
        ? { status: "refused", messageId, reason: ack.claim }
        : { status: "accepted", messageId };
    if (Date.now() >= deadline || signal?.aborted) return { status: "unacknowledged", messageId };
    await delay(Math.min(INBOX_POLL_MS, deadline - Date.now()));
  }
}
export async function sendInboxMessage(
  run: RunRecord,
  sender: string,
  text: string,
  signal?: AbortSignal,
): Promise<MessageReply> {
  if (sender !== run.parentSessionId)
    return { status: "refused", reason: "Not this run's immediate parent" };
  const message = parse(InboxMessage, {
    id: randomUUID(),
    runId: run.id,
    sender,
    text,
    createdAt: Date.now(),
  });
  const refusal = await withAdmissionLock(() =>
    withRunLock(
      run.paths.lock,
      async () => {
        const winner = await readClaim(run.paths.claim);
        if (winner) return winner;
        if (run.lifecycle !== "running" || !run.rex || run.process.state === "exited")
          return "Child is not live";
        await atomicWrite(join(run.paths.inbox, `${message.id}.json`), message);
        return null;
      },
      true,
    ),
  );
  if (refusal) return { status: "refused", reason: refusal };
  return waitForAck(run, message.id, MESSAGE_ACK_MS, signal);
}
export async function unconsumedMessages(run: RunRecord): Promise<InboxMessage[]> {
  return (await inboxEntries(run))
    .filter((entry) => entry.ack?.state === "accepted")
    .map((entry) => entry.message);
}
