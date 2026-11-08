import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { records, until } from "../lib/phase-one.ts";
import { directory } from "../lib/phase-two.ts";
import { parentLaunch } from "../lib/phase-four.ts";
import { withRun, type Run } from "../lib/run.ts";
import { object } from "../lib/rex.ts";

function childModel(): { provider: string; model: string; thinking: "low" } {
  const value = process.env.HARNESS_MODEL ?? "openrouter/nvidia/nemotron-3.5-lightning:free";
  const slash = value.indexOf("/");
  return {
    provider: slash > 0 ? value.slice(0, slash) : value,
    model: slash > 0 ? value.slice(slash + 1) : value,
    thinking: "low",
  };
}
async function parent(run: Run, label: string, prompt: string) {
  const argv = await parentLaunch(run, label, prompt);
  const selected = process.env.HARNESS_PARENT_MODEL;
  if (selected) {
    const flag = argv.indexOf("--model");
    if (flag >= 0) argv[flag + 1] = selected;
  }
  return run.newSession(label, argv);
}
async function calls(run: Run, label: string) {
  const raw = await readFile(join(run.out, `${label}-tools.jsonl`), "utf8");
  return raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => object(JSON.parse(line)))
    .filter((call) => call.name === "subagent");
}

export default async function compose(): Promise<void> {
  await withRun("compose", async (run) => {
    const settings = childModel();
    const checkout = await directory(run, "how", true);
    const how = `In ONE assistant message, call subagent twice and no other tools. Both are access read, background false, cwd ${checkout}, provider ${settings.provider}, model ${settings.model}, thinking ${settings.thinking}. Tasks: "Read-only angle A. Reply HOW_A. Do not use tools." and "Read-only angle B. Reply HOW_B. Do not use tools." Labels how-a and how-b. Do not edit the checkout.`;
    await parent(run, "how", how);
    const howCalls = await until("two read launches", async () => {
      const logged = await calls(run, "how").catch(() => []);
      return logged.length >= 2 ? logged : null;
    });
    assert.equal(howCalls.length, 2);
    for (const call of howCalls) {
      const input = object(call.input);
      assert.equal(input.access, "read");
      assert.equal(input.cwd, checkout);
      assert.equal(input.provider, settings.provider);
      assert.equal(input.model, settings.model);
      assert.equal(input.thinking, settings.thinking);
    }
    const howRuns = await until("how children", async () => {
      const all = (await records(run)).filter((record) => record.label.startsWith("how-"));
      return all.length === 2 ? all : null;
    });
    assert(howRuns.every((record) => record.access === "read"));
    assert(
      howRuns.every(
        (record) =>
          record.effective.provider === settings.provider &&
          record.effective.model === settings.model &&
          record.effective.thinking === settings.thinking,
      ),
    );

    const impl = await directory(run, "impl", true);
    await parent(
      run,
      "impl",
      `Call subagent once with access write, background false, cwd ${impl}, provider ${settings.provider}, model ${settings.model}, thinking ${settings.thinking}, label impl-writer, task "Reply IMPL. Do not edit files." Do not edit ${impl} yourself. Do not call other tools.`,
    );
    const writer = await until("implementation child", async () =>
      (await records(run)).find((record) => record.label === "impl-writer"),
    );
    assert.equal(writer.access, "write");
    const implCalls = await calls(run, "impl");
    assert.equal(implCalls.filter((call) => call.name === "subagent").length, 1);
    assert.equal(
      implCalls.filter((call) => call.name === "edit" || call.name === "write").length,
      0,
    );

    const review = await directory(run, "review", true);
    await writeFile(join(review, "sample.txt"), "sample\n", { mode: 0o600 });
    await parent(
      run,
      "review",
      `In ONE assistant message, call subagent three times and no other tools. Two access read and one access inspect, all background false, cwd ${review}, provider ${settings.provider}, model ${settings.model}, thinking ${settings.thinking}. Labels review-a, review-b, review-inspect. The inspect task must say to run the command true and reply INSPECT. The read tasks must say to reply READ and not use tools.`,
    );
    const reviewers = await until("review children", async () => {
      const all = (await records(run)).filter((record) => record.label.startsWith("review-"));
      return all.length === 3 ? all : null;
    });
    assert.equal(reviewers.filter((record) => record.access === "read").length, 2);
    assert.equal(reviewers.filter((record) => record.access === "inspect").length, 1);

    const base = await directory(run, "arena", true);
    execFileSync(
      "git",
      [
        "-C",
        base,
        "-c",
        "user.name=harness",
        "-c",
        "user.email=harness@example.com",
        "commit",
        "--allow-empty",
        "-m",
        "base",
      ],
      { stdio: "ignore" },
    );
    const left = join(run.scratch, "arena-left");
    const right = join(run.scratch, "arena-right");
    execFileSync("git", ["-C", base, "worktree", "add", "-b", "left", left], { stdio: "ignore" });
    execFileSync("git", ["-C", base, "worktree", "add", "-b", "right", right], { stdio: "ignore" });
    await parent(
      run,
      "arena",
      `In ONE assistant message, call subagent twice and no other tools. Both access write, background false, provider ${settings.provider}, model ${settings.model}, thinking ${settings.thinking}. One cwd ${left} label arena-left task "Reply LEFT. Do not edit files." One cwd ${right} label arena-right task "Reply RIGHT. Do not edit files."`,
    );
    const arena = await until("worktree writers", async () => {
      const all = (await records(run)).filter((record) => record.label.startsWith("arena-"));
      return all.length === 2 && all.every((record) => record.rex) ? all : null;
    });
    assert.equal(new Set(arena.map((record) => record.checkoutRoot)).size, 2);
    console.log(
      "compose: PASS; top-level how, implementation, review and worktree launches used the parent's settings",
    );
  });
}
