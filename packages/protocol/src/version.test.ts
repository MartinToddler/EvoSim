import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "./version";

describe("protocol version", () => {
  it("is locked at 1 for v0.1 (changing it is a deliberate wire-format decision)", () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });
});
