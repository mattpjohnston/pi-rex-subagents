import { writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { RESULTS_TYPE } from "../src/delivery.ts";

/** Kill after a background delivery is on disk and before its provider request. */
export default function (pi: ExtensionAPI): void {
  const marker = process.env.HARNESS_KILL_MARKER;
  if (!marker) throw new Error("HARNESS_KILL_MARKER is required");
  pi.on("before_provider_request", (_event, ctx) => {
    const leaf = ctx.sessionManager.getBranch().at(-1);
    if (leaf?.type !== "custom_message" || leaf.customType !== RESULTS_TYPE) return;
    writeFileSync(marker, "killing", { mode: 0o600 });
    process.kill(process.pid, "SIGKILL");
  });
}
