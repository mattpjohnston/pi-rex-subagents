import assert from "node:assert/strict";
import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { withRun } from "../lib/run.ts";
import { assertNoAuthError, current, events, result, start } from "../lib/phase-one.ts";
import { object } from "../lib/rex.ts";

export default async function launch(): Promise<void> {
  await withRun("launch", async (run) => {
    const marker = "PHASE_ONE_CWD_INSTRUCTIONS_LOADED";
    await writeFile(
      join(run.scratch, "AGENTS.md"),
      `When asked for the acceptance marker, quote exactly ${marker}.\n`,
      { mode: 0o600 },
    );
    for (const override of [false, true]) {
      const label = override ? "override" : "inherit";
      const model = process.env.HARNESS_MODEL ?? "openrouter/nvidia/nemotron-3.5-lightning:free";
      const slash = model.indexOf("/");
      const launched = await start(run, {
        label,
        task: "Call harness_facts once, then quote the acceptance marker from the cwd AGENTS.md in your short final report. Do not use other tools.",
        ...(override
          ? {
              provider: model.slice(0, slash),
              model: model.slice(slash + 1),
              thinking: "max" as const,
            }
          : {}),
      });
      const record = await launched.record();
      const answer = await launched.answer();
      assert.equal(answer.isError, false);
      const final = await current(run, record.id);
      const reported = await result(final);
      assertNoAuthError(reported);
      assert.equal(final.lifecycle, "completed");
      assert.equal(final.process.state, "exited");
      assert.equal(final.parentRunId, null);
      assert.equal(final.depth, 0);
      assert.equal(await readFile(final.paths.claim, "utf8"), "result");
      assert.match(reported.assistantText, new RegExp(marker));
      const facts = object(
        JSON.parse(await readFile(join(dirname(final.paths.run), "facts.json"), "utf8")),
      );
      assert.equal(facts.tty, true);
      assert.equal(facts.cwd, await realpath(run.scratch));
      assert.equal(`${String(facts.provider)}/${String(facts.model)}`, model);
      assert.equal(facts.programStatusOverride, null);
      assert.equal(facts.thinking, final.effective.thinking);
      assert.equal(final.requested.thinking, override ? "max" : null);
      assert.equal(final.requested.provider, override ? model.slice(0, slash) : null);
      assert.equal(final.effective.provider + "/" + final.effective.model, model);
      assert(reported.sessionFile?.startsWith(final.paths.sessionDir));
      assert.equal((await stat(final.paths.result)).mode & 0o777, 0o600);
      assert.equal((await stat(dirname(final.paths.run))).mode & 0o777, 0o700);
      const logged = await events(final);
      assert(logged.some((e) => e.type === "child_loaded"));
      assert(logged.some((e) => e.type === "session_start"));
      assert(logged.some((e) => e.type === "tool_call" && e.data.name === "harness_facts"));
      console.log(
        `launch ${label}: TTY, cwd, marker, fresh session, ${model}, requested thinking ${String(final.requested.thinking)}, effective ${final.effective.thinking}, result + exit confirmed`,
      );
    }
  });
}
