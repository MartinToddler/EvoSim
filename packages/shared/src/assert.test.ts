import { describe, expect, it } from "vitest";
import { EonAssertionError, assert, unreachable } from "./assert";

describe("assert", () => {
  it("passes on true condition", () => {
    expect(() => assert(true, "ok")).not.toThrow();
  });

  it("throws EonAssertionError with message on false condition", () => {
    expect(() => assert(false, "broken invariant")).toThrowError(EonAssertionError);
    expect(() => assert(false, "broken invariant")).toThrowError("broken invariant");
  });

  it("unreachable always throws", () => {
    expect(() => unreachable(undefined as never)).toThrowError(EonAssertionError);
  });
});
