import assert from "node:assert/strict";
import { readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withRun, repo } from "../lib/run.ts";
import { parentArgv } from "../lib/pi.ts";
import { current, key, maybeFile, records, start, until } from "../lib/phase-one.ts";
import { directory, hold, sample } from "../lib/phase-two.ts";
import { object } from "../lib/rex.ts";

export default async function parallel(): Promise<void> {
  await withRun("parallel", async (run) => {
    await writeFile(join(run.state, "limits.json"), JSON.stringify({ active: 2 }));
    const stop = sample(run, 2);
    try {
      const a = await directory(run, "a"),
        b = await directory(run, "b"),
        c = await directory(run, "c");
      const childModel =
        process.env.HARNESS_MODEL ?? "openrouter/nvidia/nemotron-3.5-lightning:free";
      const childSlash = childModel.indexOf("/");
      const plans = [a, a, b, c].map((cwd, i) => ({
        label: `parallel-${i}`,
        cwd,
        task: "Call harness_hold exactly once and wait until it is released, then reply briefly. Do not use other tools.",
        provider: childSlash > 0 ? childModel.slice(0, childSlash) : childModel,
        model: childSlash > 0 ? childModel.slice(childSlash + 1) : childModel,
      }));
      const sameMessage = join(a, "sibling-write");
      const prompt = `Acceptance harness: in ONE assistant message, issue exactly FOUR parallel subagent tool calls. Copy every field of each object, especially cwd, provider, and model. Do not omit cwd. Do not set background or access. Objects: ${JSON.stringify(plans)}. In that SAME message also call write on ${sameMessage} with content forbidden. Do not use a harness tool, codemode, or bash. Do not wait for any child before issuing the other calls. The children intentionally hold; the human will abort the batch. After abortion do not retry any call.`;
      const argv = await parentArgv(run, "parallel-parent", prompt, {
        PI_SUBAGENTS_CHILD_NO_DISCOVERY: "1",
        PI_SUBAGENTS_CHILD_EXTENSIONS: join(repo, "harness/child-tools.ts"),
        PI_SUBAGENTS_LOG_TOOLS: "1",
      });
      // Free models occasionally drop a copied field; HARNESS_PARENT_MODEL selects a steadier parent.
      const parentModel = process.env.HARNESS_PARENT_MODEL ?? childModel;
      const modelFlag = argv.indexOf("--model");
      if (modelFlag >= 0) argv[modelFlag + 1] = parentModel;
      const parent = await run.newSession("parallel-parent", argv);
      await until("four real model-issued runs", async () => {
        const all = await records(run);
        return all.length === 4 && all;
      });
      await until("two running and two waiting", async () => {
        const all = await records(run);
        return (
          all.filter((r) => r.rex).length === 2 &&
          all.filter((r) => r.queue && !r.waiting).length === 2
        );
      });
      const queuedRuns = (await records(run)).filter((r) => r.queue);
      assert.equal(queuedRuns.filter((r) => r.queue?.reason === "checkout").length, 1);
      assert.equal(queuedRuns.filter((r) => r.queue?.reason === "capacity").length, 1);
      assert(queuedRuns.every((r) => r.waiting === null));
      const live = (await records(run)).filter((r) => r.rex);
      for (const record of live) await hold(run, record);
      const sessionDir = join(run.sessions, "parallel-parent");
      const sessionNames = (await readdir(sessionDir)).filter((name) => name.endsWith(".jsonl"));
      assert.equal(sessionNames.length, 1);
      const session = join(sessionDir, sessionNames[0] ?? "");
      const entries = (await readFile(session, "utf8"))
        .trim()
        .split("\n")
        .map((line) => object(JSON.parse(line)));
      const batches = entries
        .filter((entry) => entry.type === "message")
        .map((entry) => object(entry.message))
        .filter((message) => message.role === "assistant")
        .map((message) =>
          Array.isArray(message.content)
            ? message.content.map(object).filter((part) => part.type === "toolCall")
            : [],
        );
      const batch = batches.find(
        (calls) => calls.filter((call) => call.name === "subagent").length === 4,
      );
      assert(batch, "Parent transcript must contain four subagent calls in one assistant message");
      assert(
        batch.some((call) => call.name === "write"),
        "Sibling write must be in the same assistant message",
      );
      assert.equal(await maybeFile(sameMessage), null, "Sibling mutation must be refused");
      console.log(
        "parallel item 6 model batch: PASS; parent transcript has four subagent calls + write in one assistant message; two run, one checkout-waits, one capacity-waits; sibling write refused",
      );
      await key(run, parent, "escape");
      const cancelled = await until("Escape cancels queued and running children", async () => {
        const all = await records(run);
        return all.every((r) => r.lifecycle === "cancelled" && r.process.state === "exited") && all;
      });
      for (const r of cancelled) assert.equal(await readFile(r.paths.claim, "utf8"), "cancelled");
      assert.equal(cancelled.filter((r) => r.rex).length, 2);
      await run.record("parallel-evidence.json", { batch, cancelled });
      console.log(
        "parallel item 6 abort: PASS; Escape claims cancelled for all four, two queued runs never create blocks, two running children exit",
      );

      const protectedDir = await directory(run, "protected");
      const outside = await directory(run, "outside");
      await writeFile(join(protectedDir, "existing"), "original");
      await writeFile(join(outside, "existing"), "original");
      const alias = join(run.scratch, "protected-alias");
      await symlink(protectedDir, alias);
      const writer = await start(run, {
        label: "guard-writer",
        cwd: protectedDir,
        task: "Call harness_hold exactly once and wait before replying.",
      });
      const record = await hold(run, await writer.record());
      const response = join(run.out, "guard-response.json");
      const guardArgv = await parentArgv(
        run,
        "guard-parent",
        "Call harness_guard exactly once now. No other tools. Reply briefly afterward.",
        { HARNESS_GUARD_TARGET: alias, HARNESS_GUARD_OUTSIDE: outside, HARNESS_RESPONSE: response },
      );
      guardArgv.splice(guardArgv.length - 1, 0, "-e", join(repo, "harness/guard-tools.ts"));
      await run.newSession("guard-parent", guardArgv);
      const results = await until("guard response", async () => {
        const raw = await maybeFile(response);
        if (!raw) return null;
        const value: unknown = JSON.parse(raw);
        assert(Array.isArray(value));
        return value.map(object);
      });
      assert.equal(results.length, 5);
      assert.equal(results[0]?.isError, true);
      assert.equal(results[1]?.isError, true);
      assert.match(JSON.stringify(results.slice(0, 2)), new RegExp(record.id));
      assert.match(JSON.stringify(results.slice(0, 2)), /holds checkout/);
      for (const result of results.slice(2))
        assert.equal(result.isError, false, JSON.stringify(result));
      assert.equal(await readFile(join(protectedDir, "existing"), "utf8"), "original");
      assert.equal(await maybeFile(join(protectedDir, "new/deep/file")), null);
      assert.equal(await readFile(join(outside, "existing"), "utf8"), "allowed");
      assert.equal(await readFile(join(outside, "new"), "utf8"), "allowed");
      assert.equal(await readFile(join(protectedDir, "shell-marker"), "utf8"), "shell-allowed");
      await key(run, writer.parent, "escape");
      await writer.answer();
      assert.equal((await current(run, record.id)).process.state, "exited");
      await run.record("guard-evidence.json", results);
      console.log(
        "parallel item 6 guard: PASS; a different parent's live writer blocks edit/write through a symlink and nearest-existing ancestor; names run + checkout; outside edit/write and inside bash remain allowed, persisted file outcomes verified",
      );
      console.log(
        "DEFERRED: reader starvation checks to phase 3; background parts of item 6 to phase 4",
      );
    } finally {
      await stop();
    }
  });
}
