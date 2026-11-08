import { mkdtemp, mkdir, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claim, processStart, readClaim, recoverStaleRunLock, withRunLock } from "../src/claims.ts";
import { parse, ResultFile, RunRecord } from "../src/records.ts";
import { cappedText, deriveOutcome } from "../src/results.ts";
import { resolveSettings } from "../src/settings.ts";
import { getModel } from "@earendil-works/pi-ai/compat";

async function scratch(body: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "pirs-test-"));
  try {
    await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
describe("claim protocol", () => {
  it("arbitrates two real processes through one nonempty hard link", async () => {
    await scratch(async (dir) => {
      const path = join(dir, "claim");
      const source = new URL("../src/claims.ts", import.meta.url).href;
      const race = (winner: string) =>
        new Promise<string>((resolve, reject) => {
          const child = spawn(process.execPath, [
            "--input-type=module",
            "-e",
            `import {claim} from ${JSON.stringify(source)}; console.log(await claim(${JSON.stringify(path)},${JSON.stringify(winner)}));`,
          ]);
          let out = "";
          child.stdout.on("data", (b: Buffer) => {
            out += b.toString();
          });
          child.once("error", reject);
          child.once("exit", (code) => {
            if (code) reject(new Error(`Racer exit ${code}`));
            else resolve(out.trim());
          });
        });
      const winners = await Promise.all([race("result"), race("cancelled")]);
      expect(winners[0]).toBe(winners[1]);
      expect(await readClaim(path)).toBe(winners[0]);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect(await readdir(dir)).toEqual(["claim"]);
    });
  });
  it("a crash before link leaves no empty winning claim", async () => {
    await scratch(async (dir) => {
      await writeFile(join(dir, "claim.crashed.tmp"), "", { mode: 0o600 });
      expect(await readClaim(join(dir, "claim"))).toBeNull();
      expect(await claim(join(dir, "claim"), "taken_over")).toBe("taken_over");
      expect(await readFile(join(dir, "claim"), "utf8")).toBe("taken_over");
    });
  });
  it("rejects an empty or malformed claim", async () => {
    await scratch(async (dir) => {
      const path = join(dir, "claim");
      await writeFile(path, "");
      await expect(readClaim(path)).rejects.toThrow("Invalid claim");
    });
  });
});
describe("run lock", () => {
  it("serializes contenders and releases on failure", async () => {
    await scratch(async (dir) => {
      const lock = join(dir, "lock");
      const order: string[] = [];
      const acquired = Promise.withResolvers<void>();
      const first = withRunLock(lock, async () => {
        order.push("first");
        acquired.resolve();
        await new Promise((r) => setTimeout(r, 80));
        order.push("released");
      });
      await acquired.promise;
      await Promise.all([
        first,
        withRunLock(lock, async () => {
          order.push("second");
        }),
      ]);
      expect(order).toEqual(["first", "released", "second"]);
      await expect(withRunLock(lock, () => Promise.reject(new Error("failure")))).rejects.toThrow(
        "failure",
      );
      await expect(stat(lock)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });
  it("keeps live holders and recovers dead/reused PIDs and crashed initialization", async () => {
    await scratch(async (dir) => {
      const lock = join(dir, "lock");
      await withRunLock(lock, async () => {
        expect(await recoverStaleRunLock(lock)).toBe(false);
      });
      await mkdir(lock);
      await writeFile(
        join(lock, "holder.json"),
        JSON.stringify({ pid: process.pid, startTime: "different incarnation", token: "old" }),
      );
      expect(await recoverStaleRunLock(lock)).toBe(true);
      await mkdir(lock);
      expect(await recoverStaleRunLock(lock)).toBe(false);
      await utimes(lock, 1, 1);
      expect(await recoverStaleRunLock(lock)).toBe(true);
      expect(processStart(process.pid)).toBeTruthy();
    });
  });
});
describe("boundary parsing and outcomes", () => {
  it("rejects partial records and results, extra ownership and invalid states", () => {
    expect(() => parse(RunRecord, {})).toThrow();
    expect(() => parse(ResultFile, { runId: "stale", outcome: "completed" })).toThrow();
  });
  it("distinguishes abort, errors, cutoff, missing replies and normal text", () => {
    const assistant = {
      stopReason: "stop" as const,
      content: [{ type: "text" as const, text: "done" }],
    };
    expect(deriveOutcome(assistant, false).outcome).toBe("completed");
    expect(deriveOutcome(assistant, true).outcome).toBe("aborted");
    expect(
      deriveOutcome({ ...assistant, stopReason: "error", errorMessage: "bad" }, false).outcome,
    ).toBe("failed");
    expect(deriveOutcome({ ...assistant, stopReason: "length" }, false).outcome).toBe("incomplete");
    expect(deriveOutcome(undefined, false).outcome).toBe("incomplete");
    expect(deriveOutcome(assistant, false, true).outcome).toBe("failed");
  });
  it("caps lines and UTF-8 bytes including notice and artifact paths", () => {
    for (const bulk of ["x\n".repeat(4000), "界".repeat(40_000)]) {
      const text = cappedText(`Session: saved-session\n${bulk}`);
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(50 * 1024);
      expect(text.split("\n").length).toBeLessThanOrEqual(2000);
      expect(text).toContain("saved-session");
      expect(text).toContain("truncated");
    }
  });
});
describe("model resolution", () => {
  const find = (provider: string, id: string) =>
    provider === "openrouter" && id === "nvidia/nemotron-3.5-lightning:free"
      ? getModel("openrouter", "nvidia/nemotron-3.5-lightning:free")
      : provider === "openai" && id === "gpt-4o"
        ? getModel("openai", "gpt-4o")
        : undefined;
  const parent = {
    provider: "openrouter",
    model: "nvidia/nemotron-3.5-lightning:free",
    thinking: "low" as const,
  };
  it("inherits slash-containing IDs and resolves bare and qualified overrides", () => {
    expect(resolveSettings(parent, {}, find).model).toBe(parent.model);
    expect(resolveSettings(parent, { model: parent.model }, find).provider).toBe("openrouter");
    expect(resolveSettings(parent, { model: `openrouter/${parent.model}` }, find).model).toBe(
      parent.model,
    );
    expect(
      resolveSettings(parent, { provider: "openai", model: "gpt-4o", thinking: "max" }, find)
        .thinking,
    ).toBe("off");
  });
  it("refuses invalid selections rather than falling back", () => {
    expect(() => resolveSettings(parent, { provider: "missing" }, find)).toThrow(
      "no provider fallback",
    );
    expect(() => resolveSettings(parent, { model: "missing/model" }, find)).toThrow();
    expect(() =>
      resolveSettings(parent, { provider: "openai", model: `openrouter/${parent.model}` }, find),
    ).toThrow();
  });
});
