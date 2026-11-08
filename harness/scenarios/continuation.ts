import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { withRun } from "../lib/run.ts";
import { current, key, maybeFile, result, start, until } from "../lib/phase-one.ts";
import { object } from "../lib/rex.ts";

export default async function continuation(): Promise<void> {
  await withRun("continuation", async (run) => {
    const first = await start(run, {
      label: "original",
      task: "Remember the conversation token ORIGINAL_CONVERSATION_CARRIED. Reply briefly with that exact token.",
    });
    const original = await first.record();
    await first.answer();
    const source = await current(run, original.id);
    const reported = await result(source);
    assert(reported.sessionFile);
    const paths = [reported.sessionFile, source.paths.result, source.paths.claim];
    const before = await Promise.all(paths.map((path) => readFile(path)));
    const follow = await start(run, {
      label: "continued",
      continueFrom: source.id,
      task: "What exact conversation token did I ask you to remember earlier? Reply with it. Do not read any files or use tools.",
    });
    const next = await follow.record();
    await follow.answer();
    const final = await current(run, next.id);
    const continued = await result(final);
    assert.equal(final.lifecycle, "completed");
    assert.equal(final.process.state, "exited");
    assert.notEqual(final.id, source.id);
    assert.notEqual(continued.sessionFile, reported.sessionFile);
    assert.match(continued.assistantText, /ORIGINAL_CONVERSATION_CARRIED/);
    assert(continued.sessionFile);
    const fork = await readFile(continued.sessionFile, "utf8");
    assert.match(fork, /ORIGINAL_CONVERSATION_CARRIED/);
    for (let i = 0; i < paths.length; i++)
      assert.deepEqual(await readFile(paths[i] ?? ""), before[i]);
    const live = await start(run, {
      label: "live-source",
      task: "Call harness_hold exactly once and wait before replying.",
    });
    const active = await live.record();
    await until("source holds live process", () =>
      maybeFile(join(dirname(active.paths.run), "holding")),
    );
    const refused = await start(run, {
      label: "refuse-live",
      continueFrom: active.id,
      task: "Reply briefly.",
    });
    const response = await refused.answer();
    assert.equal(response.isError, true);
    assert.match(JSON.stringify(object(response.result).content), /live or unresolved/);
    await writeFile(join(dirname(active.paths.run), "release"), "go", { mode: 0o600 });
    await live.answer();
    await key(run, live.parent, "ctrl+d");
    await run.record("continuation-evidence.json", {
      source,
      final,
      refused: response,
      byteIdenticalArtifacts: paths.length,
    });
    console.log(
      "continuation: PASS; fork carries prior conversation, source session/result/claim byte-identical, live run rejected; unresolved rejection is covered by failures",
    );
  });
}
