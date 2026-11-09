import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { events, records, result, start, until } from "../lib/phase-one.ts";
import { directory, finished } from "../lib/phase-two.ts";
import { entries, resultsEntries, sessionPath } from "../lib/phase-four.ts";
import { withRun } from "../lib/run.ts";
import { object } from "../lib/rex.ts";

export default async function nestingModel(): Promise<void> {
  await withRun("nesting-model", async (run) => {
    await writeFile(join(run.state, "limits.json"), JSON.stringify({ active: 1, depth: 2 }));
    const cwd = await directory(run, "implementation");
    await writeFile(join(cwd, "answer.txt"), "parent-selected-review-scope\n");
    const reviewerModel = process.env.HARNESS_OVERRIDE_MODEL;
    assert(reviewerModel, "HARNESS_OVERRIDE_MODEL required for policy ownership proof");
    const launched = await start(run, {
      label: "writer",
      cwd,
      access: "write",
      task: `This is a fully model-driven nested implementation/review acceptance case. The parent selected the playbook: call subagent exactly once, FOREGROUND, access read, label reviewer, cwd ${cwd}, model ${reviewerModel}, thinking off, task 'Read answer.txt with the read tool and report its contents in one short sentence. Do not use other tools.' Do not use bash or any other tool yourself. When the reviewer returns, give a short final report. Do not invent a different workflow or model.`,
    });
    const writer = await launched.record();
    const reviewer = await until(
      "model-driven nested reviewer record",
      async () => (await records(run)).find((r) => r.label === "reviewer"),
      180_000,
    );
    await launched.answer();
    const finalWriter = await finished(run, writer);
    const finalReviewer = await finished(run, reviewer);
    assert.equal(reviewer.parentRunId, writer.id);
    assert.equal(writer.depth, 1);
    assert.equal(reviewer.depth, 2);
    assert.equal(reviewer.rootParentSessionId, writer.parentSessionId);
    assert.notEqual(reviewer.parentSessionId, writer.parentSessionId);
    assert.equal(`${reviewer.effective.provider}/${reviewer.effective.model}`, reviewerModel);
    const writerEvents = await events(finalWriter);
    assert(writerEvents.some((e) => e.type === "tool_call" && e.data.name === "subagent"));
    const reviewerEvents = await events(finalReviewer);
    const startEvent = reviewerEvents.find((e) => e.type === "session_start");
    assert(startEvent);
    assert.deepEqual((startEvent.data.tools as string[]).toSorted(), [
      "find",
      "git_read",
      "grep",
      "ls",
      "read",
    ]);
    assert(reviewerEvents.some((e) => e.type === "tool_call" && e.data.name === "read"));
    const writerSession = (await result(finalWriter)).sessionFile;
    assert(writerSession);
    const childRows = await entries(writerSession);
    assert.equal(
      resultsEntries(childRows).length,
      0,
      "Nested outcomes never use the unmanaged results path",
    );
    const returned = childRows.find(
      (row) =>
        row.type === "message" &&
        object(row.message).role === "toolResult" &&
        object(row.message).toolName === "subagent",
    );
    assert(returned && object(object(returned.message).details).runId === reviewer.id);
    const rootRows = await entries(await sessionPath(run, "writer"));
    assert(!JSON.stringify(resultsEntries(rootRows)).includes(reviewer.id));
    assert.equal(await readFile(join(cwd, "answer.txt"), "utf8"), "parent-selected-review-scope\n");
    await run.record("nested-model-proof.json", {
      writer: finalWriter,
      reviewer: finalReviewer,
      writerEvents,
      reviewerEvents,
    });
    console.log(
      "nesting-model: PASS; foreground same-checkout join at active=1, depth=2 tools absent, parent-selected Haiku reviewer, result only to immediate parent",
    );
  });
}
