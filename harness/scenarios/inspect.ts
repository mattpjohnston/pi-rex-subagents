import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { repo, withRun } from "../lib/run.ts";
import { current, events, key, result, send, start, until } from "../lib/phase-one.ts";
import { directory, finished, hold, queued, release, sample } from "../lib/phase-two.ts";
import { sessionOnlyTrustIndex } from "../lib/trust.ts";
import { success } from "../lib/rex.ts";
import type { Run } from "../lib/run.ts";
import type { ResultFile, RunRecord } from "../../src/records.ts";

const holdTask =
  "Call harness_hold exactly once and wait until it is released, then reply briefly. Do not use other tools.";
const discover = { PI_SUBAGENTS_CHILD_NO_DISCOVERY: "0" };

async function answerTrust(run: Run, record: RunRecord): Promise<void> {
  const state = await until("inspect trust or load", async () => {
    const currentRecord = await current(run, record.id);
    if (currentRecord.waiting?.kind === "project_trust" && currentRecord.rex)
      return { kind: "trust" as const, record: currentRecord };
    if (currentRecord.loadedAt) return { kind: "loaded" as const, record: currentRecord };
    return null;
  });
  if (state.kind === "loaded" || !state.record.rex) return;
  const capture = success(
    await run.rex.capture(state.record.rex.sessionId, state.record.rex.blockId),
  ).stdout;
  const index = sessionOnlyTrustIndex(capture);
  for (let step = 0; step < index; step++) await key(run, state.record.rex, "down");
  const selected = success(
    await run.rex.capture(state.record.rex.sessionId, state.record.rex.blockId),
  ).stdout;
  assert.match(selected, /Trust \(this session only\)/);
  await key(run, state.record.rex, "enter");
  await until("inspect loaded after trust", async () => (await current(run, record.id)).loadedAt);
}

function checkoutOf(file: ResultFile): NonNullable<ResultFile["checkout"]> {
  assert(file.checkout, JSON.stringify(file));
  return file.checkout;
}

export default async function inspect(): Promise<void> {
  await withRun("inspect", async (run) => {
    await writeFile(join(run.state, "limits.json"), JSON.stringify({ active: 8 }));
    const stop = sample(run, 8);
    try {
      const checkout = await directory(run, "inspected", true);
      execFileSync("git", ["-C", checkout, "config", "user.email", "probe@example.com"]);
      execFileSync("git", ["-C", checkout, "config", "user.name", "Probe"]);
      await writeFile(join(checkout, "f"), "hi\n");
      execFileSync("git", ["-C", checkout, "add", "f"]);
      execFileSync("git", ["-C", checkout, "commit", "-qm", "init"]);
      const server = join(repo, "harness/mcp-server.mjs");
      await mkdir(join(checkout, ".pi"), { mode: 0o700 });
      await writeFile(
        join(checkout, ".pi", "mcp.json"),
        JSON.stringify({ mcpServers: { harness: { command: "node", args: [server] } } }),
      );

      const marker = join(checkout, "child-marker");
      const probeOut = join(run.out, "inspect-probe.json");
      const probe = await start(
        run,
        {
          label: "probe",
          cwd: checkout,
          access: "inspect",
          task: "Call harness_inspect exactly once, then reply briefly. Do not call other tools.",
        },
        {
          ...discover,
          PI_SUBAGENTS_CHILD_EXTENSIONS: join(repo, "harness/inspect-tools.ts"),
          HARNESS_INSPECT_MARKER: marker,
          HARNESS_INSPECT_RESULT: probeOut,
        },
      );
      await answerTrust(run, await probe.record());
      await probe.answer();
      const probeRecord = await current(run, (await probe.record()).id);
      const probeResult = await result(probeRecord);
      assert.equal(probeRecord.lifecycle, "completed");
      const changed = checkoutOf(probeResult);
      assert.equal(changed.state, "changed");
      assert(changed.paths.includes("child-marker"), changed.paths.join(","));
      assert.equal(await readFile(marker, "utf8"), "child-write");
      const probeReport = JSON.parse(await readFile(probeOut, "utf8")) as {
        edit: { isError?: boolean };
        write: { isError?: boolean };
        bash: { isError?: boolean };
      };
      assert.equal(probeReport.edit.isError, true);
      assert.equal(probeReport.write.isError, true);
      assert.notEqual(probeReport.bash.isError, true);
      const listed = toolNames(await events(probeRecord));
      assert(!listed.includes("edit") && !listed.includes("write"));
      assert(listed.includes("bash"));
      assert(
        !listed.includes("subagent"),
        "phase 6: inspect children have no subagent tool at depth 1",
      );
      const mcp = listed.filter((name) => name.startsWith("mcp__"));
      console.log(
        mcp.length
          ? `inspect item 14 tools: PASS; edit/write absent, bash present, MCP listed: ${mcp.join(", ")}`
          : "inspect item 14 tools: PASS for edit/write/bash; MCP was not verified (no mcp__ tool was callable after project .pi/mcp.json and session-only trust)",
      );

      const parentPath = join(checkout, "parent-marker");
      const parentRun = await start(
        run,
        { label: "parent-change", cwd: checkout, access: "inspect", task: holdTask },
        discover,
      );
      const parentRecord = await parentRun.record();
      await answerTrust(run, parentRecord);
      await hold(run, parentRecord);
      await writeFile(parentPath, "parent\n");
      await release(await current(run, parentRecord.id));
      await parentRun.answer();
      const parentResult = checkoutOf(await result(await current(run, parentRecord.id)));
      assert.equal(parentResult.state, "changed");
      assert(parentResult.paths.includes("parent-marker"));
      assert.equal((await result(await current(run, parentRecord.id))).outcome, "completed");
      console.log(
        "inspect item 14 parent write: PASS; changed path is the parent's file and the outcome stayed completed",
      );

      const clean = await start(
        run,
        {
          label: "clean",
          cwd: checkout,
          access: "inspect",
          task: "Reply CLEAN. Do not call any tool.",
        },
        discover,
      );
      await answerTrust(run, await clean.record());
      await clean.answer();
      const cleanResult = await result(await current(run, (await clean.record()).id));
      assert.equal(cleanResult.outcome, "completed");
      assert.equal(checkoutOf(cleanResult).state, "clean");
      console.log("inspect item 14 clean: PASS");

      const overlapReader = await start(
        run,
        {
          label: "overlap-reader",
          cwd: checkout,
          access: "read",
          task: "Reply READY. Do not call tools.",
        },
        { PI_SUBAGENTS_CHILD_EXTENSIONS: "" },
      );
      const reader = await overlapReader.record();
      await until("overlap reader block", async () => (await current(run, reader.id)).rex);
      const readerLive = await current(run, reader.id);
      assert(readerLive.rex);
      await send(run, readerLive.rex, "/subagent-takeover");
      await until(
        "overlap reader taken",
        async () => (await current(run, reader.id)).lifecycle === "taken_over",
      );
      const inspectorA = await start(
        run,
        { label: "overlap-a", cwd: checkout, access: "inspect", task: holdTask },
        discover,
      );
      const inspectorB = await start(
        run,
        { label: "overlap-b", cwd: checkout, access: "inspect", task: holdTask },
        discover,
      );
      await answerTrust(run, await inspectorA.record());
      await answerTrust(run, await inspectorB.record());
      await hold(run, await inspectorA.record());
      await hold(run, await inspectorB.record());
      const writer = await start(run, { label: "overlap-writer", cwd: checkout, task: holdTask });
      const waiting = await queued(run, await writer.record());
      assert((await current(run, reader.id)).rex);
      assert((await current(run, (await inspectorA.record()).id)).rex);
      assert((await current(run, (await inspectorB.record()).id)).rex);
      assert.equal(waiting.rex, null);
      console.log(
        "inspect item 14 overlap: PASS; inspectors overlap a reader and each other; writer waits",
      );
      const readerTaken = await current(run, reader.id);
      assert(readerTaken.rex);
      await send(run, readerTaken.rex, "/quit");
      await release(await current(run, (await inspectorA.record()).id));
      await release(await current(run, (await inspectorB.record()).id));
      await inspectorA.answer();
      await inspectorB.answer();
      await release(await hold(run, waiting));
      await writer.answer();

      await mutate(
        run,
        checkout,
        "ignored",
        async () => {
          await writeFile(join(checkout, ".gitignore"), "secret\n");
          await writeFile(join(checkout, "secret"), "ignored\n");
        },
        (paths) => paths.includes("secret"),
      );
      await mutate(
        run,
        checkout,
        "skip",
        async () => {
          execFileSync("git", ["-C", checkout, "update-index", "--skip-worktree", "f"]);
          await writeFile(join(checkout, "f"), "skip-worktree\n");
        },
        (paths) => paths.includes("f"),
      );
      execFileSync("git", ["-C", checkout, "update-index", "--no-skip-worktree", "f"]);
      await writeFile(join(checkout, "f"), "hi\n");
      await mutate(
        run,
        checkout,
        "ref",
        async () => {
          execFileSync("git", ["-C", checkout, "branch", "extra"]);
        },
        (paths) => paths.includes("refs/heads/extra"),
      );
      await mutate(
        run,
        checkout,
        "staged",
        async () => {
          await writeFile(join(checkout, "g"), "staged\n");
          execFileSync("git", ["-C", checkout, "add", "g"]);
          await writeFile(join(checkout, "g"), "");
        },
        (paths) => paths.includes("g"),
      );
      await mutate(
        run,
        checkout,
        "config",
        async () => {
          execFileSync("git", ["-C", checkout, "config", "harness.marker", "changed"]);
        },
        (paths) => paths.some((path) => path.includes("config")),
      );
      console.log(
        "inspect item 14 mutations: PASS; ignored, skip-worktree, ref, staged, and config each reported changed",
      );

      const failing = await start(
        run,
        {
          label: "failed-change",
          cwd: checkout,
          access: "inspect",
          task: "HARNESS_MODE=provider-error\nReply if you can.",
        },
        { ...discover, PI_SUBAGENTS_CHILD_EXTENSIONS: join(repo, "harness/child-tools.ts") },
      );
      const failingRecord = await failing.record();
      await answerTrust(run, failingRecord);
      await until(
        "failed inspector launched",
        async () => (await current(run, failingRecord.id)).rex,
      );
      await writeFile(join(checkout, "during-failure"), "changed\n");
      await failing.answer();
      const failed = await result(await current(run, failingRecord.id));
      assert.equal(failed.outcome, "failed");
      assert.equal(checkoutOf(failed).state, "changed");
      assert(checkoutOf(failed).paths.includes("during-failure"));
      console.log(
        "inspect item 14 failed change: PASS; outcome stayed failed and checkout changed",
      );

      const unknown = await start(
        run,
        {
          label: "budget",
          cwd: checkout,
          access: "inspect",
          task: "Reply BUDGET. Do not call tools.",
        },
        { ...discover, PI_SUBAGENTS_FINGERPRINT_MAX_BYTES: "1" },
      );
      await answerTrust(run, await unknown.record());
      await unknown.answer();
      const budget = checkoutOf(await result(await current(run, (await unknown.record()).id)));
      assert.equal(budget.state, "unknown");
      assert.match(budget.reason ?? "", /budget/);
      console.log(`inspect item 14 budget: PASS; checkout unknown (${budget.reason})`);
      console.log(
        "inspect nested write: not run; phase 6 owns nesting, and depth 1 children have no subagent tool",
      );
    } finally {
      await stop();
    }
  });
}

async function mutate(
  run: Run,
  cwd: string,
  label: string,
  change: () => Promise<void>,
  matches: (paths: string[]) => boolean,
): Promise<void> {
  const launched = await start(run, { label, cwd, access: "inspect", task: holdTask }, discover);
  const record = await launched.record();
  await answerTrust(run, record);
  await hold(run, record);
  await change();
  await release(await current(run, record.id));
  await launched.answer();
  const report = checkoutOf(await result(await finished(run, record)));
  assert.equal(report.state, "changed", `${label}: ${JSON.stringify(report)}`);
  assert(matches(report.paths), `${label}: ${report.paths.join(", ")}`);
}

function toolNames(log: { type: string; data: Record<string, unknown> }[]): string[] {
  const startEvent = log.find((event) => event.type === "session_start");
  const all = startEvent?.data.allTools;
  if (!Array.isArray(all)) return [];
  return all.map((tool) =>
    typeof tool === "object" && tool && "name" in tool ? String(tool.name) : "",
  );
}
