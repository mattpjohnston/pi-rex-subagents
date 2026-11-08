import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ResultFile, RunRecord } from "./records.ts";

export function deriveOutcome(
  assistant: Pick<AssistantMessage, "stopReason" | "errorMessage" | "content"> | undefined,
  aborted: boolean,
  shutdown = false,
): Pick<ResultFile, "outcome" | "assistantText" | "stopReason" | "reason"> {
  const assistantText =
    assistant?.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n") ?? "";
  const stopReason = assistant?.stopReason ?? null;
  if (shutdown)
    return { outcome: "failed", assistantText, stopReason, reason: "Child quit before settlement" };
  if (aborted || stopReason === "aborted")
    return { outcome: "aborted", assistantText, stopReason, reason: "Agent aborted" };
  if (stopReason === "error")
    return {
      outcome: "failed",
      assistantText,
      stopReason,
      reason: assistant?.errorMessage ?? "Provider error",
    };
  if (stopReason === "length" || !assistantText.trim())
    return {
      outcome: "incomplete",
      assistantText,
      stopReason,
      reason: stopReason === "length" ? "Length cutoff" : "Missing assistant reply",
    };
  return { outcome: "completed", assistantText, stopReason, reason: null };
}

/** Metadata and truncation notice share the cap; artifact paths precede bulk text. */
export function cappedText(text: string): string {
  const notice = "[Output truncated; full output is in the child session file above.]\n";
  const first = truncateHead(text, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
  if (!first.truncated) return first.content;
  return (
    notice +
    truncateHead(text, {
      maxBytes: DEFAULT_MAX_BYTES - Buffer.byteLength(notice),
      maxLines: DEFAULT_MAX_LINES - 1,
    }).content
  );
}
export function resultText(run: RunRecord, result?: ResultFile): string {
  return cappedText(
    [
      `Run: ${run.id} (${run.label})`,
      `Outcome: ${run.lifecycle}${result && run.process.state !== "exited" ? " (answer recorded, completion NOT confirmed)" : ""}`,
      `Model: ${run.effective.provider}/${run.effective.model}; thinking: ${run.effective.thinking}`,
      `Session: ${result?.sessionFile ?? run.sessionFile ?? run.paths.sessionDir}`,
      `Process: ${JSON.stringify(run.process)}`,
      `Result: ${run.paths.result}`,
      `Events: ${run.paths.events}`,
      run.rex
        ? `Capture: rex capture -s ${run.rex.sessionId} -b ${run.rex.blockId} --trim --unwrap`
        : "Launch location unknown; do not retry blindly",
      run.diagnostic ?? "",
      result?.reason ?? "",
      "",
      result?.assistantText ?? "",
    ].join("\n"),
  );
}
