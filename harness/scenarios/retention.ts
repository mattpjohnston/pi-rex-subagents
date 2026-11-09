import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { privateDirectory, runPaths, writeRun, type RunRecord } from "../../src/records.ts";
import { records, start, until } from "../lib/phase-one.ts";
import { directory, finished } from "../lib/phase-two.ts";
import { withRun } from "../lib/run.ts";

export default async function retention(): Promise<void> {
  await withRun("retention", async (run) => {
    const now = Date.now();
    const old = now - 40 * 86_400_000;
    const settings = { provider: "test", model: "test", thinking: "off" as const };
    const seeded: RunRecord[] = [];
    const seed = async (label: string, patch: Partial<RunRecord> = {}) => {
      const id = randomBytes(12).toString("hex");
      const root = join(run.state, "runs", id);
      const record: RunRecord = {
        version: 1,
        id,
        label,
        taskPath: join(root, "task.md"),
        cwd: run.scratch,
        checkoutRoot: run.scratch,
        access: "read",
        requested: settings,
        effective: settings,
        background: false,
        continueFrom: null,
        parentSessionId: "retention-seed",
        parentRunId: null,
        depth: 1,
        rex: null,
        location: null,
        paths: runPaths(root),
        lifecycle: "completed",
        process: { state: "exited", code: 0 },
        waiting: null,
        queue: null,
        sessionFile: null,
        diagnostic: null,
        createdAt: old,
        updatedAt: old,
        loadedAt: old,
        finishedAt: old,
        ...patch,
      };
      await privateDirectory(root);
      await privateDirectory(record.paths.sessionDir);
      await writeFile(join(record.paths.sessionDir, "transcript.jsonl"), "retention fixture\n");
      await writeRun(record);
      seeded.push(record);
      return record;
    };
    const foreground = await seed("old-foreground");
    await privateDirectory(join(run.state, "reservations"));
    await writeFile(
      join(run.state, "reservations", foreground.id + ".json"),
      JSON.stringify({
        id: foreground.id,
        members: [
          {
            runId: foreground.id,
            access: foreground.access,
            checkout: foreground.checkoutRoot,
            provider: foreground.effective.provider,
          },
        ],
      }),
    );
    const delivered = await seed("old-background-delivered", {
      background: true,
      deliveredAt: old,
    });
    await seed("old-background-undelivered", { background: true });
    const taken = await seed("old-taken-over", { lifecycle: "taken_over" });
    await writeFile(taken.paths.claim, "taken_over");
    await seed("old-unresolved", { process: { state: "unresolved", pid: null } });
    await seed("recent-completed", { finishedAt: now });
    await seed("queued-admitting", {
      lifecycle: "admitting",
      process: { state: "unknown" },
      finishedAt: null,
      queue: { reason: "capacity", detail: "retention fixture", since: old },
    });
    const parent = await seed("old-parent-with-kept-child");
    await seed("recent-nested-child", { parentRunId: parent.id, depth: 2, finishedAt: now });
    const endedParent = await seed("old-parent-with-old-child");
    const endedChild = await seed("old-nested-child", {
      parentRunId: endedParent.id,
      depth: 2,
      background: true,
    });
    const deleted = [foreground, delivered, endedParent, endedChild].map((record) => record.id);
    const kept = seeded.filter((record) => !deleted.includes(record.id)).map((record) => record.id);
    await run.record("retention-before.json", { seeded, deleted, kept });
    await writeFile(join(run.state, "limits.json"), JSON.stringify({ keepRunsFor: 30 }));

    const launched = await start(
      run,
      {
        label: "retention-real-child",
        cwd: await directory(run, "real-child"),
        access: "read",
        task: "Reply briefly. No tools.",
      },
      {
        PI_SUBAGENTS_CHILD_EXTENSIONS: "",
        PI_SUBAGENTS_RUN_ID: "",
        PI_SUBAGENTS_RUN_DIR: "",
      },
    );
    await until(
      "retention deletions settle",
      async () => {
        const names = await readdir(join(run.state, "runs"));
        return (
          deleted.every((id) => !names.includes(id)) &&
          names.every((name) => !name.startsWith(".deleted-"))
        );
      },
      30_000,
    );
    const child = await finished(run, await launched.record());
    await launched.answer();
    const after = await records(run);
    assert.deepEqual(after.map((record) => record.id).sort(), [...kept, child.id].sort());
    assert(child.finishedAt !== null && child.finishedAt >= now, "the real recent child survived");
    await run.record("retention-after.json", {
      records: after,
      deleted,
      kept,
      realChild: child.id,
    });
    console.log(
      "retention: PASS; only old delivered ended runs deleted, kept descendants retain ancestors, real recent child survived",
    );
  });
}
