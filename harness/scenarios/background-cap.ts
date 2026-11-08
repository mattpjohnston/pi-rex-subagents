import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import { until } from "../lib/phase-one.ts";
import { directory } from "../lib/phase-two.ts";
import { entries, parentLaunch, resultsEntries, sessionPath } from "../lib/phase-four.ts";
import { withRun } from "../lib/run.ts";

export default async function backgroundCap(): Promise<void> {
  await withRun("background-cap", async (run) => {
    const cwd = await directory(run, "cap");
    const plans = [0, 1, 2].map((index) => ({
      label: `cap-${index}`,
      cwd,
      access: "read" as const,
      background: true,
      task: "HARNESS_MODE=oversized\nReply CAP. Do not use tools.",
    }));
    const plansPath = join(run.out, "cap-plans.json");
    await writeFile(plansPath, JSON.stringify(plans), { mode: 0o600 });
    await run.newSession(
      "cap",
      await parentLaunch(
        run,
        "cap",
        "Call harness_background exactly once now. Do not call other tools. After it returns, reply OK.",
        [],
        {
          HARNESS_PLANS: plansPath,
          HARNESS_RESPONSE: join(run.out, "cap-response.json"),
          PI_SUBAGENTS_COALESCE_MS: "1000",
        },
      ),
    );
    const delivery = await until(
      "capped coalesced delivery",
      async () => {
        const rows = resultsEntries(await entries(await sessionPath(run, "cap")));
        return rows.length === 1 ? rows[0] : null;
      },
      180_000,
    );
    const content = typeof delivery?.content === "string" ? delivery.content : "";
    assert(Buffer.byteLength(content) <= DEFAULT_MAX_BYTES);
    assert(content.split("\n").length <= DEFAULT_MAX_LINES);
    assert.match(content, /Result: /);
    assert.doesNotMatch(content, /oversized acceptance output(?:\n.*){20}/);
    console.log("background-cap: PASS; one message stayed within the cap and used path entries");
  });
}
