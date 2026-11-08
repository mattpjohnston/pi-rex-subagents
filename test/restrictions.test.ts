import { expect, it } from "vitest";
import { inspectViolations, readViolations } from "../src/restrictions.ts";

const readTools = ["read", "grep", "find", "ls", "git_read"].map((name) => ({
  name,
  exposure: "direct",
}));

it("fails closed when a read child can load anything beyond the five tools", () => {
  expect(readViolations(["read", "grep", "find", "ls", "git_read"], readTools)).toEqual([]);
  expect(
    readViolations(["read", "bash"], [...readTools, { name: "bash", exposure: "direct" }]),
  ).toEqual(["bash"]);
  expect(
    readViolations(["read"], [...readTools, { name: "mcp__x__ping", exposure: "deferred" }]),
  ).toEqual(["mcp__x__ping"]);
  expect(
    readViolations(["read"], [...readTools, { name: "codemode", exposure: "codemode" }]),
  ).toEqual(["codemode"]);
  expect(
    readViolations(["read"], [...readTools, { name: "hidden_tool", exposure: "hidden" }]),
  ).toEqual([]);
});

it("fails closed when an inspector can load edit or write at any exposure", () => {
  expect(inspectViolations(["read", "bash"], [{ name: "bash", exposure: "direct" }])).toEqual([]);
  expect(
    inspectViolations(
      ["read"],
      [
        { name: "edit", exposure: "hidden" },
        { name: "write", exposure: "deferred" },
      ],
    ),
  ).toEqual(["edit", "write"]);
  expect(inspectViolations(["edit"], [])).toEqual(["edit"]);
});
