import assert from "node:assert/strict";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withRun, repo } from "../lib/run.ts";
import { parentArgv } from "../lib/pi.ts";
import { captureContains, current, events, key, records, send, until } from "../lib/phase-one.ts";
import { directory, hold } from "../lib/phase-two.ts";
import { object, success } from "../lib/rex.ts";
import type { RunRecord } from "../../src/records.ts";
import { locate, observeProcess } from "../../src/rex.ts";

export default async function terminals(): Promise<void> {
  await withRun("terminals", async (run) => {
    const plan = [];
    for (let i = 0; i < 4; i++)
      plan.push({
        label: `completed-${i}`,
        cwd: await directory(run, `complete-${i}`),
        task: "Reply briefly. No tools.",
      });
    plan.push({
      label: "failed",
      cwd: await directory(run, "failed"),
      task: "HARNESS_MODE=missing\nCall harness_done_without_result once. Do not call other tools.",
    });
    plan.push({
      label: "taken",
      cwd: await directory(run, "taken"),
      task: "Call harness_hold once and wait before replying.",
    });
    plan.push({
      label: "live",
      cwd: await directory(run, "live"),
      task: "Call harness_hold once and wait before replying.",
    });
    const planPath = join(run.out, "batch-plan.json"),
      response = join(run.out, "batch-response.json");
    await writeFile(planPath, JSON.stringify(plan));
    const argv = await parentArgv(
      run,
      "terminal-parent",
      "Call harness_batch exactly once now. Do not call any other tools. After it finishes reply briefly.",
      {
        HARNESS_PLAN: planPath,
        HARNESS_RESPONSE: response,
        PI_SUBAGENTS_CHILD_NO_DISCOVERY: "1",
        PI_SUBAGENTS_CHILD_EXTENSIONS: join(repo, "harness/child-tools.ts"),
        PI_SUBAGENTS_LOG_TOOLS: "1",
      },
    );
    argv.splice(argv.length - 1, 0, "-e", join(repo, "harness/batch-tools.ts"));
    const parent = await run.newSession("terminal-parent", argv);
    const find = (label: string) =>
      until(`record ${label}`, async () => (await records(run)).find((r) => r.label === label));
    const taken = await hold(run, await find("taken"));
    assert(taken.rex);
    await send(run, taken.rex, "/subagent-takeover");
    await until("takeover acknowledged", async () =>
      (await events(taken)).some((e) => e.type === "takeover_acknowledged"),
    );
    const live = await hold(run, await find("live"));
    assert(live.rex);
    const all = await records(run),
      completed = all.filter((r) => r.label.startsWith("completed-"));
    assert.equal(completed.length, 4);
    for (const r of completed) {
      assert.equal(r.lifecycle, "completed");
      assert.equal(r.process.state, "exited");
      assert(r.rex);
    }
    const failed = all.find((r) => r.label === "failed");
    assert(failed?.rex);
    assert.equal(failed.lifecycle, "failed");
    assert.equal(failed.process.state, "exited");
    const get = (label: string) => {
      const r = all.find((r) => r.label === label);
      assert(r?.rex);
      return { ...r, rex: r.rex };
    };
    const manual = get("completed-0"),
      split = get("completed-1"),
      single = get("completed-2");
    const unrelated = object(
      success(
        await run.rex.command([
          "window",
          "new",
          "-s",
          parent.sessionId,
          "unrelated",
          "--focus=false",
          "--keep-open",
          "--shell",
          "none",
          "--json",
          "--",
          "sleep",
          "600",
        ]),
      ).data,
    );
    assert(Array.isArray(unrelated.block_ids));
    const unrelatedId = unrelated.block_ids[0];
    assert.equal(typeof unrelatedId, "string");
    const extra = object(
      success(
        await run.rex.command([
          "split",
          "-s",
          parent.sessionId,
          "-b",
          split.rex.blockId,
          "--split=right",
          "--focus=false",
          "--keep-open",
          "--shell",
          "none",
          "--json",
          "--",
          "sleep",
          "600",
        ]),
      ).data,
    );
    assert(Array.isArray(extra.block_ids));
    const extraId = extra.block_ids[0];
    assert.equal(typeof extraId, "string");
    for (const r of [manual, live]) {
      assert(r.rex);
      success(
        await run.rex.command(
          ["move", "-s", parent.sessionId, r.rex.blockId, "right", String(unrelatedId)],
          false,
        ),
      );
    }
    const moved = await locate(live.rex.blockId, live.rex);
    assert(moved);
    assert.notEqual(moved.windowId, live.rex.windowId);
    assert.equal(
      await readFile(live.paths.claim, "utf8").catch(() => null),
      null,
      "Layout must not transfer ownership",
    );
    await send(run, parent, "/subagents");
    await until("moved current location appears in status", async () =>
      success(await run.rex.capture(parent.sessionId, parent.blockId))
        .stdout.replace(/\s/g, "")
        .includes(moved.windowId),
    );
    success(
      await run.rex.command(["block", "close", "-s", parent.sessionId, manual.rex.blockId], false),
    );
    await send(run, parent, `/subagents dismiss ${manual.id}`);
    await until("already-gone dismissal returns without closing former tab", async () =>
      success(await run.rex.capture(parent.sessionId, parent.blockId)).stdout.includes(
        "artifacts retained",
      ),
    );
    assert.equal(
      (
        await run.rex.command([
          "block",
          "inspect",
          "-s",
          parent.sessionId,
          String(unrelatedId),
          "--json",
        ])
      ).code,
      0,
    );
    await until("widget counts clearable exited children", async () =>
      success(await run.rex.capture(parent.sessionId, parent.blockId)).stdout.includes(
        "3 exited completed child terminal(s)",
      ),
    );
    const artifacts: { record: RunRecord; paths: string[]; before: Buffer[] }[] = [];
    for (const record of completed) {
      const result = object(JSON.parse(await readFile(record.paths.result, "utf8")));
      assert.equal(typeof result.sessionFile, "string");
      const paths = [
        record.paths.result,
        record.paths.claim,
        record.taskPath,
        record.paths.events,
        String(result.sessionFile),
      ];
      artifacts.push({
        record,
        paths,
        before: await Promise.all(paths.map((path) => readFile(path))),
      });
    }
    await send(run, parent, "/subagents clear");
    for (const r of completed)
      await until(
        `clear closes ${r.label}`,
        async () =>
          (
            await run.rex.command([
              "block",
              "inspect",
              "-s",
              parent.sessionId,
              r.rex?.blockId ?? "",
              "--json",
            ])
          ).code === 3,
      );
    for (const id of [
      extraId,
      unrelatedId,
      live.rex.blockId,
      taken.rex.blockId,
      failed.rex.blockId,
      parent.blockId,
    ])
      assert.equal(
        (await run.rex.command(["block", "inspect", "-s", parent.sessionId, String(id), "--json"]))
          .code,
        0,
        `Preserve block ${String(id)}`,
      );
    const windows = object(
      success(await run.rex.command(["window", "ls", "-s", parent.sessionId, "--json"])).data,
    );
    assert(
      !JSON.stringify(windows).includes(single.rex.windowId),
      "Last-block close removes single-child tab",
    );
    for (const item of artifacts) {
      await stat(item.record.paths.run);
      for (const [i, path] of item.paths.entries())
        assert.deepEqual(await readFile(path), item.before[i]);
    }
    await send(run, parent, `/subagents dismiss ${live.id}`);
    await until("live dismissal refused", () =>
      captureContains(run, parent, "Refusing dismissal of live or unknown child"),
    );
    assert.equal((await observeProcess(moved)).process.state, "live");
    await send(run, parent, `/subagents dismiss ${failed.id}`);
    await until(
      "exited failure dismissed",
      async () =>
        (
          await run.rex.command([
            "block",
            "inspect",
            "-s",
            parent.sessionId,
            failed.rex?.blockId ?? "",
            "--json",
          ])
        ).code === 3,
    );
    await key(run, parent, "escape");
    await until("moved child cancellation follows block ID", async () => {
      const r = await current(run, live.id);
      return r.lifecycle === "cancelled" && r.process.state === "exited" && r;
    });
    assert.equal((await observeProcess(taken.rex)).process.state, "live");
    await send(run, parent, `/subagents dismiss ${live.id}`);
    await until(
      "moved exited child dismissed",
      async () =>
        (
          await run.rex.command([
            "block",
            "inspect",
            "-s",
            parent.sessionId,
            live.rex?.blockId ?? "",
            "--json",
          ])
        ).code === 3,
    );
    for (const id of [extraId, unrelatedId, taken.rex.blockId, parent.blockId])
      assert.equal(
        (await run.rex.command(["block", "inspect", "-s", parent.sessionId, String(id), "--json"]))
          .code,
        0,
      );
    await key(run, taken.rex, "escape");
    await until("taken child settles", async () =>
      (await events(taken)).some((e) => e.type === "agent_settled"),
    );
    await key(run, taken.rex, "ctrl+d");
    await until(
      "taken process exits",
      async () =>
        (await observeProcess(taken.rex as NonNullable<typeof taken.rex>)).process.state ===
        "exited",
    );
    await send(run, parent, `/subagents dismiss ${taken.id}`);
    await until(
      "individual dismissal permits exited takeover",
      async () =>
        (
          await run.rex.command([
            "block",
            "inspect",
            "-s",
            parent.sessionId,
            taken.rex?.blockId ?? "",
            "--json",
          ])
        ).code === 3,
    );
    await run.record("terminal-evidence.json", {
      moved,
      completed: completed.map((r) => r.id),
      preservedBlocks: [extraId, unrelatedId, parent.blockId],
      artifactSetsIntact: artifacts.length,
    });
    console.log(
      "terminals item 12: PASS; split + shared-tab moves preserve ownership, status/cancel follow stable block ID; clear closes exactly three eligible blocks; live/taken/failed/unrelated panes survive; live dismissal refused; exited failure/cancellation/takeover individually dismissed; already-gone child never targets former tab; single-child tab disappears; four artifact sets byte-identical and records retained",
    );
  });
}
