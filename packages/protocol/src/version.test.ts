import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "./version";
import { decodeMainToWorkerMessage } from "./messages";

describe("protocol version", () => {
  it("is 2 for Milestone 6 (changing it is a deliberate wire-format decision)", () => {
    expect(PROTOCOL_VERSION).toBe(2);
  });

  it("refuses messages stamped with any other version", () => {
    const stale = {
      protocolVersion: 1,
      type: "SET_RUN_STATE",
      payload: { speed: "x1" },
    };
    const result = decodeMainToWorkerMessage(stale);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/unsupported protocol version 1/);
    }
  });
});
