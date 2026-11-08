import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { withRun } from "../lib/run.ts";
import {
  assertNoAuthError,
  current,
  key,
  maybeFile,
  result,
  start,
  until,
  watchRex,
} from "../lib/phase-one.ts";
import { object } from "../lib/rex.ts";

export default async function failures(): Promise<void> {
  await withRun("failures", async (run) => {
    const stream = watchRex(run);
    try {
      const cases = [
        { mode: "provider-error", task: "Reply briefly.", expected: "failed" },
        {
          mode: "handled-error",
          task: "Call harness_error once, then handle that intentional tool failure and give a short final report.",
          expected: "completed",
        },
        {
          mode: "abort",
          task: "Call harness_hold once. Wait for it before replying.",
          expected: "aborted",
        },
        {
          mode: "length",
          task: "Write a long detailed essay about concurrency.",
          expected: "incomplete",
        },
        { mode: "missing-assistant", task: "Reply briefly.", expected: "incomplete" },
        {
          mode: "missing",
          task: "Call harness_done_without_result once. Do not call other tools.",
          expected: "failed",
        },
        { mode: "missing-file", task: "Reply briefly.", expected: "failed" },
        { mode: "malformed", task: "Reply briefly.", expected: "failed" },
        { mode: "wrong-id", task: "Reply briefly.", expected: "failed" },
        { mode: "oversized", task: "Reply briefly.", expected: "completed" },
        { mode: "hang", task: "Reply briefly.", expected: "completed" },
        {
          mode: "cancel",
          task: "Call harness_hold once. Wait for it before replying.",
          expected: "cancelled",
        },
      ];
      for (const test of cases.filter(
        (test) =>
          !process.env.HARNESS_FAILURE_CASE || test.mode === process.env.HARNESS_FAILURE_CASE,
      )) {
        const launched = await start(run, {
          label: test.mode,
          task: `HARNESS_MODE=${test.mode}\n${test.task}`,
        });
        const record = await launched.record();
        if (test.mode === "abort" || test.mode === "cancel") {
          await until("hold active", () => maybeFile(join(dirname(record.paths.run), "holding")));
          const active = await until("running child location", async () => {
            const r = await current(run, record.id);
            return r.rex && r;
          });
          assert(active.rex);
          await key(run, test.mode === "abort" ? active.rex : launched.parent, "escape");
        }
        const response = await launched.answer();
        const final = await current(run, record.id);
        assert.equal(final.lifecycle, test.expected, `${test.mode}: ${JSON.stringify(final)}`);
        if (!["missing", "missing-file", "malformed", "wrong-id", "cancel"].includes(test.mode)) {
          const reported = await result(final);
          assertNoAuthError(reported);
          assert(reported.sessionFile);
          await readFile(reported.sessionFile);
        }
        if (test.mode === "missing") {
          assert.equal(await maybeFile(final.paths.result), null);
          assert(
            stream.seen.some(
              (e) =>
                e.blockId === final.rex?.blockId &&
                e.name === "program_status_changed" &&
                object(object(e.payload).record ?? {}).state === "done",
            ),
          );
          assert.match(final.diagnostic ?? "", /without a result claim/);
        }
        if (test.mode === "missing-file") {
          assert.equal(await maybeFile(final.paths.result), null);
          assert.match(final.diagnostic ?? "", /Reporter failure:.*ENOENT/);
        }
        if (test.mode === "malformed" || test.mode === "wrong-id") {
          assert.match(
            final.diagnostic ?? "",
            test.mode === "wrong-id" ? /run ID mismatch/ : /Invalid persisted/,
          );
        }
        if (test.mode === "oversized") {
          const content = object(response.result).content;
          assert(Array.isArray(content));
          const text = content.map((c) => object(c).text).join("\n");
          assert(Buffer.byteLength(text) <= 50 * 1024);
          assert(text.split("\n").length <= 2000);
          assert.match(text, /truncated/);
          assert(text.includes((await result(final)).sessionFile ?? "missing session"));
          assert((await result(final)).assistantText.length > 100_000);
        }
        if (test.mode === "hang") {
          assert.equal(final.process.state, "unresolved");
          assert.equal(await readFile(final.paths.claim, "utf8"), "result");
          const rejected = await start(run, {
            label: "reject-unresolved",
            continueFrom: final.id,
            task: "Reply briefly.",
          });
          const answer = await rejected.answer();
          assert.equal(answer.isError, true);
          assert.match(JSON.stringify(object(answer.result).content), /live or unresolved/);
        } else assert.equal(final.process.state, "exited");
        await run.record(`${test.mode}-evidence.json`, { final, response });
        console.log(
          `failures ${test.mode}: PASS; outcome ${final.lifecycle}; process ${final.process.state}; ${final.diagnostic ?? "validated result"}`,
        );
      }
    } finally {
      stream.stop();
    }
  });
}
