import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withRun } from "../lib/run.ts";
import { current, events, key, result, send, start, until } from "../lib/phase-one.ts";
import { sessionOnlyTrustIndex } from "../lib/trust.ts";
import { success } from "../lib/rex.ts";

export default async function trust(): Promise<void> {
  await withRun("trust", async (run) => {
    const cwd = join(run.scratch, "trust-project");
    await mkdir(join(cwd, ".pi"), { recursive: true, mode: 0o700 });
    await writeFile(join(cwd, ".pi", "settings.json"), "{}", { mode: 0o600 });
    const launched = await start(run, {
      label: "trust",
      cwd,
      task: "Reply TRUST_ANSWERED briefly. Do not use tools.",
    });
    const record = await launched.record();
    const waiting = await until("observe-only trust waiting record", async () => {
      const r = await current(run, record.id);
      return r.waiting?.kind === "project_trust" && r;
    });
    assert(waiting.rex);
    const parent = success(
      await run.rex.capture(launched.parent.sessionId, launched.parent.blockId),
    ).stdout;
    assert.match(parent, /Trust parent folder/);
    assert.match(parent, /\/subagents go trust/);
    const capture = success(
      await run.rex.capture(waiting.rex.sessionId, waiting.rex.blockId),
    ).stdout;
    await run.record("trust-prompt.json", capture);
    assert.match(capture, /Trust project folder/);
    assert.match(capture, /this session/i);
    for (const command of ["/subagents", "/subagents all"]) {
      await send(run, launched.parent, command);
      await until(
        "trust listing",
        async () => {
          const value = success(
            await run.rex.capture(launched.parent.sessionId, launched.parent.blockId),
          ).stdout;
          return value.includes(`Run ${record.id}`) && value.includes("project_trust");
        },
        10_000,
      );
    }
    await send(run, launched.parent, "/subagents go trust");
    // Select Pi's session-only trust option, never a remembered decision in the user's agent dir.
    const sessionIndex = sessionOnlyTrustIndex(capture);
    for (let index = 0; index < sessionIndex; index++) await key(run, waiting.rex, "down");
    const selected = success(
      await run.rex.capture(waiting.rex.sessionId, waiting.rex.blockId),
    ).stdout;
    assert.match(selected, /→ Trust \(this session only\)/);
    await key(run, waiting.rex, "enter");
    await launched.answer();
    const final = await current(run, record.id);
    assert.equal(final.waiting, null);
    assert.equal(final.lifecycle, "completed");
    assert.equal(final.process.state, "exited");
    assert((await result(final)).assistantText.trim());
    const logged = await events(final);
    assert(logged.some((e) => e.type === "project_trust"));
    assert(logged.some((e) => e.type === "session_start" && e.data.trusted === true));
    await run.record("trust-evidence.json", { waiting, final });
    console.log(
      "trust: PASS; real ask prompt, undecided observer, notice/root guidance, waiting lists, session-only answer and cleared wait",
    );
  });
}
