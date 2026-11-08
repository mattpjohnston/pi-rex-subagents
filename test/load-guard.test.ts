import { expect, it } from "vitest";
import { claimRuntime } from "../src/load-guard.ts";

function bus() {
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  return {
    emit(channel: string, data: unknown) {
      for (const handler of listeners.get(channel) ?? []) handler(data);
    },
    on(channel: string, handler: (data: unknown) => void) {
      const set = listeners.get(channel) ?? new Set();
      set.add(handler);
      listeners.set(channel, set);
      return () => set.delete(handler);
    },
    reset() {
      listeners.clear();
    },
  };
}

it("makes a second load in the same runtime a no-op and allows a reloaded runtime", () => {
  const events = bus();
  expect(claimRuntime(events)).toBe(true);
  expect(claimRuntime(events)).toBe(false);
  events.emit("pi-rex-subagents:runtime", { ping: true });
  events.reset();
  expect(claimRuntime(events)).toBe(true);
});
