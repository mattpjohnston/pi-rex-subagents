import { expect, it } from "vitest";
import { sessionOnlyTrustIndex } from "../harness/lib/trust.ts";

it("counts a parent-folder option even when Rex wraps its path onto the next line", () => {
  expect(
    sessionOnlyTrustIndex(
      "→ Trust\n  Trust parent folder\n (scratch-root)\n  Trust (this session only)\n  Do not trust",
    ),
  ).toBe(2);
  expect(sessionOnlyTrustIndex("→ Trust\n  Trust (this session only)\n  Do not trust")).toBe(1);
  expect(() => sessionOnlyTrustIndex("→ Trust\n  Do not trust")).toThrow();
});
