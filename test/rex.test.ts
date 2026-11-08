import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parseBlockEvent } from "../src/rex.ts";

it("parses measured Rex event envelopes with identifiers removed", () => {
  const events: unknown = JSON.parse(
    readFileSync(new URL("./fixtures/rex-events.json", import.meta.url), "utf8"),
  );
  if (!Array.isArray(events)) throw new Error("Invalid fixture");
  expect(events.map(parseBlockEvent)).toMatchObject([
    { name: "program_status_changed", payload: { record: { state: "idle" } } },
    { name: "child_exited", payload: { exit_code: 0 } },
  ]);
  expect(parseBlockEvent({ type: "session_created" })).toBeNull();
});
