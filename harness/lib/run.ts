import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { object, Rex, success } from "./rex.ts";

export const repo = fileURLToPath(new URL("../../", import.meta.url));

async function guardHashes(): Promise<Record<string, string | null>> {
  const paths = new Set([
    join(homedir(), ".pi", "agent", "settings.json"),
    join(homedir(), ".pi", "agent", "trust.json"),
    join(homedir(), ".pi", "agent", "extensions", "subagent.ts"),
    ...(process.env.HARNESS_GUARD_FILES ?? "")
      .split(":")
      .filter(Boolean)
      .map((path) => resolve(path)),
  ]);
  const hashes: Record<string, string | null> = {};
  for (const path of paths) {
    try {
      hashes[path] = createHash("sha256")
        .update(await readFile(path))
        .digest("hex");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      hashes[path] = null;
    }
  }
  return hashes;
}

export interface Run {
  scratch: string;
  state: string;
  sessions: string;
  out: string;
  rex: Rex;
  record: (name: string, data: unknown) => Promise<void>;
  newSession: (label: string, argv: string[]) => Promise<{ sessionId: string; blockId: string }>;
}

export async function withRun(scenario: string, body: (run: Run) => Promise<void>): Promise<void> {
  const before = await guardHashes();
  const listed = object(success(await new Rex().listSessions()).data);
  if (!Array.isArray(listed.sessions)) throw new Error("Rex did not return a session list");
  const stale = listed.sessions
    .map((entry: unknown) => object(entry))
    .filter((entry) => {
      if (typeof entry.label !== "string" || typeof entry.session_id !== "string") {
        throw new Error("Invalid Rex session entry");
      }
      return entry.label.startsWith("pirs-h-");
    });
  if (stale.length)
    throw new Error(`Leftover harness sessions; refusing to start: ${JSON.stringify(stale)}`);

  const scratch = await mkdtemp(join(tmpdir(), "pi-rex-subagents-"));
  const previousStateDir = process.env.PI_SUBAGENTS_STATE_DIR;
  process.env.PI_SUBAGENTS_STATE_DIR = join(scratch, "state");
  const state = join(scratch, "state");
  const sessions = join(scratch, "sessions");
  const out = join(scratch, "out");
  const stamp = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`;
  const archive = join(repo, ".harness-runs", `${stamp}-${scenario}`);
  const owned: string[] = [];
  const ownedBlocks: { sessionId: string; blockId: string }[] = [];
  const errors: unknown[] = [];
  const record = async (name: string, data: unknown): Promise<void> => {
    if (!/^[a-z0-9_.-]+$/i.test(name)) throw new Error("Invalid artifact name");
    await writeFile(join(out, name), `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  };
  const rex = new Rex(async (argv, result) => {
    await appendFile(join(out, "rex.ndjson"), `${JSON.stringify({ argv, ...result })}\n`, {
      mode: 0o600,
    });
  });
  try {
    for (const dir of [state, sessions, out]) await mkdir(dir, { mode: 0o700 });
    await record("guards-before.json", before);
    await body({
      scratch,
      state,
      sessions,
      out,
      rex,
      record,
      newSession: async (label, argv) => {
        if (!/^[a-z0-9-]+$/.test(label)) throw new Error("Invalid harness session label");
        const created = object(
          success(await rex.newSession(`pirs-h-${stamp}-${label}`, scratch, argv)).data,
        );
        if (typeof created.session_id !== "string" || !created.session_id.startsWith("session:")) {
          throw new Error("Rex launch did not return a session ID; launch may be unresolved");
        }
        // Record ownership before validating the rest of the reply so teardown still runs.
        owned.push(created.session_id);
        await record("owned-sessions.json", owned);
        if (!Array.isArray(created.initial_windows))
          throw new Error("Rex launch has no initial windows");
        const blocks = object(created.initial_windows[0]).block_ids;
        if (!Array.isArray(blocks) || typeof blocks[0] !== "string")
          throw new Error("Rex launch has no block ID");
        ownedBlocks.push({ sessionId: created.session_id, blockId: blocks[0] });
        return { sessionId: created.session_id, blockId: blocks[0] };
      },
    });
  } catch (error) {
    errors.push(error);
  } finally {
    await teardown();
    if (previousStateDir === undefined) delete process.env.PI_SUBAGENTS_STATE_DIR;
    else process.env.PI_SUBAGENTS_STATE_DIR = previousStateDir;
  }
  async function teardown(): Promise<void> {
    for (const [index, block] of ownedBlocks.entries()) {
      try {
        await record(
          `parent-capture-${index}.json`,
          await rex.capture(block.sessionId, block.blockId),
        );
      } catch (error) {
        errors.push(error);
      }
    }
    for (const id of owned) {
      try {
        const killed = await rex.killSession(id);
        if (killed.code !== 0 && killed.code !== 3) success(killed);
        const after = await rex.inspectSession(id);
        if (after.code !== 3)
          throw new Error(`Session removal not confirmed: ${id}, Rex exit ${after.code}`);
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      await mkdir(join(archive, "out"), { recursive: true, mode: 0o700 });
      for (const name of ["out", "state", "sessions"]) {
        if (existsSync(join(scratch, name)))
          await cp(join(scratch, name), join(archive, name), { recursive: true });
      }
    } catch (error) {
      errors.push(error);
    }
    try {
      await rm(scratch, { recursive: true, force: true });
      if (existsSync(scratch)) throw new Error("Harness scratch directory still exists");
    } catch (error) {
      errors.push(error);
    }
    let unchanged = false;
    try {
      const after = await guardHashes();
      await writeFile(
        join(archive, "out", "guards-after.json"),
        `${JSON.stringify(after, null, 2)}\n`,
        { mode: 0o600 },
      );
      unchanged = JSON.stringify(before) === JSON.stringify(after);
      if (!unchanged) throw new Error("Guard files changed during the harness run");
    } catch (error) {
      errors.push(error);
    }
    try {
      await writeFile(
        join(archive, "out", "result.json"),
        `${JSON.stringify(
          {
            scenario,
            sessionsCreated: owned.length,
            scratchRemoved: !existsSync(scratch),
            guardsUnchanged: unchanged,
            errors: errors.map((error) => (error instanceof Error ? error.message : String(error))),
          },
          null,
          2,
        )}\n`,
        { mode: 0o600 },
      );
    } catch (error) {
      errors.push(error);
    }
  }
  console.log(`harness ${scenario}: artifacts ${archive}`);
  if (errors.length) throw new AggregateError(errors, `harness ${scenario} failed`);
  console.log(
    `harness ${scenario}: PASS; ${owned.length} owned session(s) gone; scratch removed; guard hashes unchanged`,
  );
}
