import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readClaim } from "../../src/claims.ts";
import { maybeFile, records, send, until } from "../lib/phase-one.ts";
import { directory, release } from "../lib/phase-two.ts";
import { entries, parentLaunch, resultsEntries, runIds, sessionPath } from "../lib/phase-four.ts";
import { withRun, type Run } from "../lib/run.ts";

const holdTask =
  "Call harness_hold exactly once and wait until it is released, then reply briefly. Do not use other tools.";

// Hold tasks need the harness hold tool, which read mode correctly withholds; inspect is admitted as a reader.
function plan(label: string, cwd: string, access: "inspect" | "write" = "inspect") {
  return { label, cwd, access, background: true, task: holdTask };
}
function role(row: Record<string, unknown>): string | undefined {
  if (
    row.type !== "message" ||
    !row.message ||
    typeof row.message !== "object" ||
    !("role" in row.message)
  )
    return undefined;
  return typeof row.message.role === "string" ? row.message.role : undefined;
}
async function launch(
  run: Run,
  label: string,
  plans: ReturnType<typeof plan>[],
  env: Record<string, string> = {},
) {
  const plansPath = join(run.out, `${label}-plans.json`);
  const response = join(run.out, `${label}-response.json`);
  await writeFile(plansPath, JSON.stringify(plans), { mode: 0o600 });
  const parent = await run.newSession(
    label,
    await parentLaunch(
      run,
      label,
      "Call harness_background exactly once now. Do not call subagent yourself or other tools. After it returns, reply OK. Whenever background subagent results arrive later, reply RECEIVED and use no tools.",
      [],
      { HARNESS_PLANS: plansPath, HARNESS_RESPONSE: response, ...env },
    ),
  );
  const children = () =>
    until(`${label} runs`, async () => {
      const all = (await records(run)).filter((record) =>
        plans.some((item) => item.label === record.label),
      );
      return all.length === plans.length ? all : null;
    });
  return { parent, response, children };
}
async function oneDelivery(run: Run, label: string, ids: string[]): Promise<void> {
  const path = await sessionPath(run, label);
  await until(
    `${label} one coalesced delivery`,
    async () => {
      const rows = await entries(path);
      const deliveries = resultsEntries(rows);
      if (deliveries.length !== 1) return null;
      const listed = runIds(deliveries[0] ?? {});
      if (!(ids.every((id) => listed.includes(id)) && listed.length === ids.length)) return null;
      const deliveryId = deliveries[0]?.id;
      const index = rows.findIndex((row) => row.id === deliveryId);
      const followed = rows.slice(index + 1).some((row) => role(row) === "assistant");
      return followed ? rows : null;
    },
    180_000,
  );
  await run.record(`${label}-delivery.json`, { count: 1, ids });
}
function toolText(value: unknown): string {
  return JSON.stringify(value ?? "");
}

export default async function background(): Promise<void> {
  await withRun("background", async (run) => {
    await writeFile(join(run.state, "limits.json"), JSON.stringify({ active: 5 }), { mode: 0o600 });
    const checkout = await directory(run, "busy");
    const elsewhere = await directory(run, "elsewhere");
    const inside = join(checkout, "parent-edit");
    const outside = join(elsewhere, "parent-edit");
    const hold = join(run.out, "busy-hold");
    const guardPath = join(run.out, "busy-guard.json");
    const busyPlans = [0, 1, 2, 3, 4].map((index) =>
      plan(`busy-${index}`, checkout, index === 0 ? "write" : "inspect"),
    );
    const busy = await launch(run, "busy", busyPlans, {
      HARNESS_GUARD_INSIDE: inside,
      HARNESS_GUARD_OUTSIDE: outside,
      HARNESS_GUARD_OUTPUT: guardPath,
      HARNESS_PARENT_HOLD: hold,
    });
    await until("parent holding while children run", () => maybeFile(hold));
    const running = await busy.children();
    await until("guard recorded", () => maybeFile(guardPath), 90_000);
    const guard = JSON.parse((await maybeFile(guardPath)) ?? "{}") as Record<string, unknown>;
    assert.match(toolText(guard.writeInside), /holds checkout|refused/i);
    assert.match(toolText(guard.editInside), /holds checkout|refused/i);
    assert.doesNotMatch(toolText(guard.writeOutside), /holds checkout/);
    assert.doesNotMatch(toolText(guard.bash), /refused|holds checkout/i);
    assert.match((await maybeFile(outside)) ?? "", /allowed/);
    await Promise.all(running.map(release));
    await until("children finished while parent busy", async () => {
      const all = await records(run);
      return running.every(
        (record) => all.find((item) => item.id === record.id)?.process.state === "exited",
      )
        ? true
        : null;
    });
    assert.equal(resultsEntries(await entries(await sessionPath(run, "busy"))).length, 0);
    await writeFile(`${hold}.release`, "go", { mode: 0o600 });
    await oneDelivery(
      run,
      "busy",
      running.map((record) => record.id),
    );

    const idleRoot = await directory(run, "idle");
    const idlePlans = [0, 1, 2, 3, 4].map((index) => plan(`idle-${index}`, idleRoot));
    // Each child still makes one model reply after release, and that latency spreads past 1 s.
    const idle = await launch(run, "idle", idlePlans, { PI_SUBAGENTS_COALESCE_MS: "5000" });
    const idleRuns = await idle.children();
    await until("parent idle before children finish", async () => {
      const path = await sessionPath(run, "idle").catch(() => "");
      if (!path) return null;
      return (await entries(path)).some((row) => role(row) === "assistant") ? true : null;
    });
    await Promise.all(idleRuns.map(release));
    await oneDelivery(
      run,
      "idle",
      idleRuns.map((record) => record.id),
    );

    await writeFile(join(run.state, "limits.json"), JSON.stringify({ active: 1 }), { mode: 0o600 });
    const queuedCheckout = await directory(run, "cancel");
    const cancelPlans = [
      plan("cancel-running", queuedCheckout, "write"),
      plan("cancel-queued", queuedCheckout, "write"),
    ];
    const cancelHold = join(run.out, "cancel-hold");
    const cancelling = await launch(run, "cancel", cancelPlans, {
      HARNESS_PARENT_HOLD: cancelHold,
    });
    await until("cancel parent holding", () => maybeFile(cancelHold));
    const queued = await until("one running and one queued", async () => {
      const all = (await records(run)).filter((record) => record.label.startsWith("cancel-"));
      const live = all.find((record) => record.rex);
      const waiting = all.find((record) => record.queue);
      return live && waiting ? { live, waiting } : null;
    });
    await send(run, cancelling.parent, `/subagents cancel ${queued.waiting.label}`);
    await send(run, cancelling.parent, `/subagents cancel ${queued.live.label}`);
    await until("both background runs cancelled", async () => {
      const all = await records(run);
      return [queued.live, queued.waiting].every(
        (record) => all.find((item) => item.id === record.id)?.lifecycle === "cancelled",
      )
        ? true
        : null;
    });
    assert.equal(await readClaim(queued.live.paths.claim), "cancelled");
    assert.equal(await readClaim(queued.waiting.paths.claim), "cancelled");
    await writeFile(`${cancelHold}.release`, "go", { mode: 0o600 });
    console.log(
      "background: PASS; busy and idle coalesced once, guard held, queued and running cancelled",
    );
  });
}
