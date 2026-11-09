import { afterEach, describe, expect, it, vi } from "vitest";
import { AttentionNotices } from "../src/attention.ts";

afterEach(() => vi.useRealTimers());

describe("attention notices", () => {
  it("writes one OSC 9 per wait, names the child and title, and strips control sequences", () => {
    const writes: string[] = [];
    const notices = new AttentionNotices("review\x07\x1b", (text) => writes.push(text));
    notices.start("Question\n\x9c");
    notices.start("nested question");
    expect(writes).toEqual(["\x1b]9;Subagent review  : Question  \x07"]);
    notices.end();
    notices.start("Another question");
    expect(writes).toHaveLength(2);
    expect(writes[1]).toContain("Another question");
  });

  it("notifies a trust wait once, but not a trust event followed by session_start", () => {
    vi.useFakeTimers();
    const write = vi.fn();
    const notices = new AttentionNotices("trust", write);
    notices.trust();
    notices.end();
    vi.advanceTimersByTime(1000);
    expect(write).not.toHaveBeenCalled();
    notices.trust();
    vi.advanceTimersByTime(500);
    expect(write).toHaveBeenCalledExactlyOnceWith("\x1b]9;Subagent trust: Project trust\x07");
    notices.start("Trust");
    expect(write).toHaveBeenCalledTimes(1);
    notices.end();
    vi.advanceTimersByTime(1000);
    expect(write).toHaveBeenCalledTimes(1);
  });
});
