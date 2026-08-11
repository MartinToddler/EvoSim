import { describe, expect, it } from "vitest";
import { err, ok, type Result } from "./result";

describe("Result", () => {
  it("ok carries a value", () => {
    const r: Result<number, string> = ok(42);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toBe(42);
    }
  });

  it("err carries an error", () => {
    const r: Result<number, string> = err("nope");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe("nope");
    }
  });
});
