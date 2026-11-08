import type { Claim } from "./claims.ts";

/** `accepted` is the durable interval before dispatch; the oracle folds it into `sent`. */
export type MessageState = "none" | "written" | "accepted" | "sent" | "consumed" | "refused";
export interface ProtocolSnapshot {
  claim: Claim | null;
  lock: "parent" | null;
  child: "working" | "settling" | "idle" | "shutdown" | "exiting" | "human" | "exited";
  messages: readonly MessageState[];
  piQueue: readonly number[];
}
export type InboxAction = "steer" | "prompt" | "defer" | "refuse" | "none";
export function inboxDecision(s: ProtocolSnapshot): InboxAction {
  if (s.lock || !s.messages.includes("written")) return "none";
  if (s.child === "settling") return s.claim === null ? "defer" : "none";
  if (s.child !== "working" && s.child !== "idle") return "none";
  if (s.claim !== null) return "refuse";
  return s.child === "working" ? "steer" : "prompt";
}
export type SettlementAction = "send" | "wait" | "publish" | "exit" | "stay" | "none";
export function settlementDecision(s: ProtocolSnapshot): SettlementAction {
  if (s.lock || s.child !== "settling") return "none";
  if (s.claim === "cancelled" || s.claim === "result") return "exit";
  if (s.claim === "taken_over") return "stay";
  // Phase 6: coalesce descendant outcomes with unsent accepted messages here.
  if (s.messages.includes("accepted")) return "send";
  if (s.messages.includes("sent")) return "wait";
  // Phase 6: park here if live or queued descendants remain.
  return "publish";
}
