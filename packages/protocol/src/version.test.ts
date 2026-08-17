import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "./version";
import { decodeMainToWorkerMessage } from "./messages";

describe("protocol version", () => {
  // 13 was M17's per-channel payloads and 14 the statistics panel that reads
  // them. Both moved the constant and neither moved this test, so it sat red
  // through two milestones — `pnpm verify` was already failing on it before
  // the ADR 0031 §5e pass touched anything.
  it("is 14 (changing it is a deliberate wire-format decision)", () => {
    expect(PROTOCOL_VERSION).toBe(14);
  });

  it("refuses messages stamped with any other version", () => {
    const stale = {
      protocolVersion: 2,
      type: "SET_RUN_STATE",
      payload: { speed: "x1" },
    };
    const result = decodeMainToWorkerMessage(stale);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/unsupported protocol version 2/);
    }
  });
});
