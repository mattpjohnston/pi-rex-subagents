import { describe, expect, it } from "vitest";
import { deliveredRunIds, formatRunResult, packBatchResults, RESULTS_TYPE } from "../src/launch.ts";
import { deriveOutcome } from "../src/reporter.ts";
import type { ResultFile, RunRecord } from "../src/store.ts";

function makeRun(id: string, overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    version: 2,
    id,
    label: `job-${id.slice(0, 4)}`,
    parentSessionId: "sess-1",
    cwd: "/tmp/repo",
    repoRoot: "/tmp/repo",
    readOnly: false,
    background: true,
    placement: "tab",
    keepOpen: false,
    model: { provider: "anthropic", model: "claude-sonnet-4-5", thinking: "low" },
    continueFrom: null,
    rex: { sessionId: "session:1", windowId: "window:1", blockId: "block:1" },
    status: "completed",
    waiting: null,
    sessionFile: "/tmp/session.jsonl",
    diagnostic: null,
    createdAt: 100,
    finishedAt: 200,
    ...overrides,
  };
}

function makeResult(runId: string, assistantText: string): ResultFile {
  return {
    version: 2,
    runId,
    outcome: "completed",
    assistantText,
    stopReason: "stop",
    reason: null,
    sessionFile: "/tmp/session.jsonl",
    model: { provider: "anthropic", model: "claude-sonnet-4-5", thinking: "low" },
    finishedAt: 200,
  };
}

describe("delivery & outcomes", () => {
  it("derives outcomes accurately from assistant messages", () => {
    expect(
      deriveOutcome({ stopReason: "stop", content: [{ type: "text", text: "all good" }] }, false)
        .outcome,
    ).toBe("completed");
    expect(deriveOutcome(undefined, true).outcome).toBe("aborted");
    expect(
      deriveOutcome({ stopReason: "error", errorMessage: "rate limit", content: [] }, false),
    ).toMatchObject({ outcome: "failed", reason: "rate limit" });
    expect(deriveOutcome({ stopReason: "length", content: [] }, false).outcome).toBe("incomplete");
    expect(deriveOutcome(undefined, false, true)).toMatchObject({
      outcome: "failed",
      reason: "Child quit before settlement",
    });
  });

  it("includes Rex IDs and worktree diff stat in formatted results", () => {
    const run = makeRun("aaaaaaaaaaaaaaaaaaaa", {
      worktree: {
        path: "/tmp/repo.worktrees/fix",
        branch: "subagent/fix",
        base: "abc123",
        repository: "/tmp/repo",
        keptReason: "unmerged commits on branch",
        diffStat: " src/app.ts | 10 ++++++++++\n 1 file changed",
      },
    });
    const text = formatRunResult(run, makeResult(run.id, "Implemented fix."));
    expect(text).toContain("Rex: session=session:1 block=block:1");
    expect(text).toContain("subagent/fix");
    expect(text).toContain("src/app.ts | 10 ++++++++++");
    expect(text).toContain("Implemented fix.");
  });

  it("packs multiple results under the byte cap, falling back to path-only entries", () => {
    const a = makeRun("aaaaaaaaaaaaaaaaaaaa");
    const b = makeRun("bbbbbbbbbbbbbbbbbbbb");
    const packed = packBatchResults(
      [
        { run: a, result: makeResult(a.id, "short reply") },
        { run: b, result: makeResult(b.id, "x".repeat(500)) },
      ],
      650,
      100,
    );
    expect(packed.runIds).toEqual([a.id, b.id]);
    expect(packed.content).toContain("short reply");
    expect(packed.content).toContain("Result:");
    expect(packed.content).not.toContain("x".repeat(500));
  });

  it("tracks delivered run IDs from both background deliveries and wait tool results", () => {
    const ids = deliveredRunIds([
      {
        type: "custom_message",
        customType: RESULTS_TYPE,
        details: { runIds: ["run-1", "run-2"] },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolName: "subagent_control",
          details: { runIds: ["run-3"] },
        },
      },
    ]);
    expect([...ids].sort()).toEqual(["run-1", "run-2", "run-3"]);
  });
});
