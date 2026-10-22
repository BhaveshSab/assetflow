import { describe, expect, it } from "vitest";

import { initialsOf } from "./TopHeader";

describe("initialsOf", () => {
  it("uses the first letter of the first and last name", () => {
    expect(initialsOf("Ada Lovelace")).toBe("AL");
  });

  it("handles a single name", () => {
    expect(initialsOf("Ada")).toBe("A");
  });

  it("ignores extra whitespace", () => {
    expect(initialsOf("  Ada   Byron  ")).toBe("AB");
  });

  it("falls back to ? for an unknown name", () => {
    expect(initialsOf(undefined)).toBe("?");
    expect(initialsOf("")).toBe("?");
    expect(initialsOf("   ")).toBe("?");
  });
});
