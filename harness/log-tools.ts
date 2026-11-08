import { appendFile } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI): void {
  const path = process.env.HARNESS_TOOL_LOG;
  if (!path) throw new Error("HARNESS_TOOL_LOG is required by the harness logger");
  pi.on("session_start", async (event, ctx) => {
    await appendFile(
      `${path}.lifecycle`,
      `${JSON.stringify({ event: "session_start", reason: event.reason, sessionId: ctx.sessionManager.getSessionId() })}\n`,
      { mode: 0o600 },
    );
  });
  pi.on("tool_call", async (event) => {
    await appendFile(
      path,
      `${JSON.stringify({
        name: event.toolName,
        input: event.input,
        toolCallId: event.toolCallId,
        parentToolCallId: event.parentToolCallId,
      })}\n`,
      { mode: 0o600 },
    );
  });
}
