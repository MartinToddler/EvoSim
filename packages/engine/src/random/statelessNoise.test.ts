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
});

describe("statelessNoiseSignedQ", () => {
  it("matches golden values", () => {
    expect(statelessNoiseSignedQ(0xe0a12026, 42, 1000)).toBe(-3385);
    expect(statelessNoiseSignedQ(7, 1, 0)).toBe(-3013);
  });

  it("stays inside the documented [-Q, Q-1] range", () => {
    for (let tick = 0; tick < 2000; tick += 1) {
      const v = statelessNoiseSignedQ(0xabc, 17, tick);
      expect(v).toBeGreaterThanOrEqual(-Q);
      expect(v).toBeLessThanOrEqual(Q - 1);
    }
  });
});
