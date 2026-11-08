import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { withRun } from "../lib/run.ts";
import { current, events, result, send, start, until, watchRex } from "../lib/phase-one.ts";
import { object, success } from "../lib/rex.ts";

export default async function status(): Promise<void> {
  await withRun("status", async (run) => {
    const stream = watchRex(run);
    try {
      const launched = await start(run, {
        label: "dialog",
        task: "Call ask_human exactly once. Wait for its answer, then report that answer in one sentence. Do not call other tools.",
      });
      const record = await launched.record();
      const waiting = await until("dialog waiting record", async () => {
        const value = await current(run, record.id);
        return value.waiting?.title === "Subagent acceptance question" && value;
      });
      assert(waiting.rex);
      assert.equal(waiting.rex.sessionId, launched.parent.sessionId);
      const capture = success(
        await run.rex.capture(launched.parent.sessionId, launched.parent.blockId),
      ).stdout;
      assert.match(capture, /dialog/);
      assert.match(capture, /waiting for a human/);
      assert.match(capture, /Subagent acceptance question/);
      assert.match(capture, /\/subagents go dialog/);
      for (const [index, text] of ["/subagents", "/subagents all"].entries()) {
        await send(run, launched.parent, text);
        await until(
          "waiting listing visible",
          async () => {
            const capture = success(
              await run.rex.capture(launched.parent.sessionId, launched.parent.blockId),
            ).stdout;
            await run.record(`listing-${index}.json`, capture);
            return capture.includes(`Run ${record.id}`);
          },
          10_000,
        );
      }
      await send(run, launched.parent, "/subagents go dialog");
      await until(
        "go gives the child block to the app client",
        async () => {
          const clients = object(
            success(await run.rex.command(["client", "ls", "--json"])).data,
          ).clients;
          assert(Array.isArray(clients));
          const apps = clients
            .map(object)
            .filter((client) => client.info && object(client.info).kind === "app");
          const inspected = object(
            success(
              await run.rex.command([
                "block",
                "inspect",
                "-s",
                waiting.rex?.sessionId ?? "",
                waiting.rex?.blockId ?? "",
                "--json",
              ]),
            ).data,
          );
          const owner = object(inspected.block).owner;
          return apps.some((app) => app.client_id === owner);
        },
        10_000,
      );
      await send(run, waiting.rex, "DIALOG_ANSWER_CONFIRMED");
      await launched.answer();
      const final = await current(run, record.id);
      assert.equal(final.waiting, null);
      assert.equal(final.lifecycle, "completed");
      assert.equal(final.process.state, "exited");
      const reported = await result(final);
      assert(reported.sessionFile);
      assert.match(await readFile(reported.sessionFile, "utf8"), /DIALOG_ANSWER_CONFIRMED/);
      assert(reported.assistantText.trim());
      const states = stream.seen
        .filter((e) => e.blockId === waiting.rex?.blockId && e.name === "program_status_changed")
        .map((e) => object(object(e.payload).record ?? {}).state);
      assert(states.includes("working"), `No native working status: ${JSON.stringify(states)}`);
      assert(states.includes("blocked"), `No native blocked status: ${JSON.stringify(states)}`);
      assert(
        stream.seen.some((e) => e.blockId === waiting.rex?.blockId && e.name === "child_exited"),
      );
      const logged = await events(final);
      assert(logged.some((e) => e.type === "ui_prompt_start"));
      assert(logged.some((e) => e.type === "ui_prompt_end"));
      await run.record("status-evidence.json", { states, waiting, final });
      console.log(
        "status: native working + blocked + exit, prompt events, attention, waiting lists, go and cleared notice; result + exit confirmed",
      );
    } finally {
      stream.stop();
    }
  });
}
