import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { readAck } from "../../src/inbox.ts";
import { readClaim } from "../../src/claims.ts";
import { events, maybeFile, until } from "../lib/phase-one.ts";
import { directory, finished, hold, release } from "../lib/phase-two.ts";
import { parentTool } from "../lib/phase-five.ts";
import {
  call,
  childSession,
  delegated,
  deliveredBeforePublish,
  named,
  plan,
  tree,
} from "../lib/phase-six.ts";
import { object } from "../lib/rex.ts";
import { repo, withRun } from "../lib/run.ts";

export default async function inbox(): Promise<void> {
  await withRun("nesting-inbox", async (run) => {
    await writeFile(join(run.state, "limits.json"), JSON.stringify({ active: 2, depth: 2 }));
    const cwd = await directory(run, "owner"),
      leafRoot = await directory(run, "leaf");
    await plan(run, "inbox-leaf", [{ calls: [call("harness_hold")] }]);
    await plan(run, "inbox-owner", [
      { calls: [call("subagent", delegated("inbox-leaf", leafRoot))] },
      { calls: [call("harness_hold")] },
    ]);
    const launched = await tree(
      run,
      {
        ...delegated("inbox-owner", cwd, "write", true),
        task: "HARNESS_MODE=settle-pause\nFollow the acceptance plan. Call harness_hold once if asked.",
      },
      {
        PI_SUBAGENTS_CHILD_EXTENSIONS: ["child-tools.ts", "nesting-hooks.ts", "protocol-hooks.ts"]
          .map((name) => join(repo, "harness", name))
          .join(delimiter),
      },
    );
    const owner = await launched.record(),
      leaf = await named(run, "inbox-leaf");
    await hold(run, owner);
    await hold(run, leaf);
    await launched.answer();
    const cancelled = await parentTool(run, launched.parent, "inbox-owner", "subagent_control", {
      operation: "cancel",
      runId: leaf.id,
    });
    assert.equal(cancelled.status, "cancelled");
    await until(
      "nested cancellation outcome ready",
      async () => (await readClaim(leaf.paths.claim)) === "cancelled",
    );
    assert(!(await events(owner)).some((e) => e.type === "descendants_sent"));
    await release(owner);
    await until("nested settlement held before decision", () =>
      maybeFile(join(dirname(owner.paths.run), "settling-paused")),
    );
    const message = await parentTool(run, launched.parent, "inbox-owner", "subagent_control", {
      operation: "message",
      runId: owner.id,
      text: "Record this hold order, use no more tools, and report briefly after observing the nested outcome.",
    });
    assert.equal(message.status, "accepted");
    assert(typeof message.messageId === "string");
    const messageId = message.messageId;
    const ack = await readAck(owner, message.messageId);
    assert(ack?.state === "accepted" && ack.sentAt === null);
    await writeFile(join(dirname(owner.paths.run), "release-settlement"), "go");
    await finished(run, owner);
    await deliveredBeforePublish(owner, [leaf.id]);
    const rows = await childSession(owner);
    assert(
      rows.some(
        (row) =>
          row.type === "message" &&
          object(row.message).role === "user" &&
          JSON.stringify(row).includes(`[subagent outcome ${leaf.id}]`) &&
          JSON.stringify(row).includes(`[subagent message ${messageId}]`),
      ),
    );
    const consumed = await readAck(owner, message.messageId);
    assert(consumed?.state === "consumed");
    const ownerEvents = await events(owner);
    const sent = ownerEvents.find((e) => e.type === "descendants_sent"),
      claimed = ownerEvents.find((e) => e.type === "result_claimed");
    assert(sent && claimed && sent.at < claimed.at && consumed.consumedAt <= claimed.at);
    await run.record("nested-inbox-proof.json", { message, consumed, ownerEvents });
    console.log(
      "nesting inbox: PASS; cancelled outcome retained while busy, unsent accepted order and descendant outcome persisted in one user turn, consumption before publication",
    );
  });
}
