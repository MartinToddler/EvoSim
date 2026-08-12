import { describe, expect, it } from "vitest";
import { Q } from "../math/fixed";
import { statelessNoiseSignedQ, statelessNoiseU32 } from "./statelessNoise";

describe("statelessNoiseU32", () => {
  it("matches golden values (locks the mixing function)", () => {
    expect(statelessNoiseU32(1, 2, 3)).toBe(3441078823);
    expect(statelessNoiseU32(0xe0a12026, 42, 1000)).toBe(2333229767);
  });

  it("is a pure function of its inputs", () => {
    expect(statelessNoiseU32(5, 6, 7)).toBe(statelessNoiseU32(5, 6, 7));
  });

  it("varies with each input independently", () => {
    const base = statelessNoiseU32(10, 20, 30);
    expect(statelessNoiseU32(11, 20, 30)).not.toBe(base);
    expect(statelessNoiseU32(10, 21, 30)).not.toBe(base);
    expect(statelessNoiseU32(10, 20, 31)).not.toBe(base);
  });

  it("pins the high-tick mixing constant with golden values", () => {
    // Without these, changing TICK_HIGH_MIX would silently alter every
    // organism's sensory noise beyond tick 2^32 and still pass CI.
    expect(statelessNoiseU32(0xe0a12026, 42, 2 ** 32)).toBe(3714520332);
    expect(statelessNoiseU32(0xe0a12026, 42, 2 ** 32 + 1000)).toBe(2835794242);
    expect(statelessNoiseU32(1, 2, 2 ** 40 + 3)).toBe(2180562109);
  });

  it("does not repeat with a period of 2^32 ticks", () => {
    for (const tick of [0, 1, 12345]) {
      expect(statelessNoiseU32(0xe0a12026, 42, tick + 2 ** 32)).not.toBe(
        statelessNoiseU32(0xe0a12026, 42, tick),
      );
      expect(statelessNoiseU32(0xe0a12026, 42, tick + 2 ** 40)).not.toBe(
        statelessNoiseU32(0xe0a12026, 42, tick),
      );
    }
  });

  it("stays uniform-looking across a high-tick epoch", () => {
    // Sample an epoch far above 2^32 and check the stream is not degenerate.
    const base = 2 ** 45;
    const values = new Set<number>();
    for (let i = 0; i < 512; i += 1) {
      values.add(statelessNoiseU32(7, 3, base + i));
    }
    expect(values.size).toBe(512);
  });
});

describe("statelessNoiseSignedQ", () => {
  it("matches golden values", () => {
    expect(statelessNoiseSignedQ(0xe0a12026, 42, 1000)).toBe(-3385);
    expect(statelessNoiseSignedQ(7, 1, 0)).toBe(-3013);
    expect(statelessNoiseSignedQ(0xe0a12026, 42, 2 ** 32 + 1000)).toBe(-1726);
  });

  it("stays inside the documented [-Q, Q-1] range", () => {
    for (let tick = 0; tick < 2000; tick += 1) {
      const v = statelessNoiseSignedQ(0xabc, 17, tick);
      expect(v).toBeGreaterThanOrEqual(-Q);
      expect(v).toBeLessThanOrEqual(Q - 1);
    }
  });
});
