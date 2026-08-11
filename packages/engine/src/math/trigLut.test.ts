import { describe, expect, it } from "vitest";
import { ANGLE_STEPS, TRIG_SCALE } from "./fixed";
import { HASH_TAG, StateHash } from "./hash";
import { SIN_LUT, cosLut, sinLut } from "./trigLut";

describe("SIN_LUT construction", () => {
  it("has one entry per angle step", () => {
    expect(SIN_LUT.length).toBe(ANGLE_STEPS);
  });

  it("hits the exact cardinal values", () => {
    expect(sinLut(0)).toBe(0);
    expect(sinLut(1024)).toBe(TRIG_SCALE); // 90°
    expect(sinLut(2048)).toBe(0); // 180°
    expect(sinLut(3072)).toBe(-TRIG_SCALE); // 270°
    expect(cosLut(0)).toBe(TRIG_SCALE);
    expect(cosLut(1024)).toBe(0);
    expect(cosLut(2048)).toBe(-TRIG_SCALE);
  });

  it("matches known non-cardinal values", () => {
    expect(sinLut(512)).toBe(23170); // sin 45° = 0.70711 → round(23169.77)
    expect(cosLut(512)).toBe(23170);
    expect(sinLut(1)).toBe(50); // sin(2π/4096) ≈ 0.0015340 → round(50.26)
  });

  it("stays within amplitude bounds", () => {
    for (let h = 0; h < ANGLE_STEPS; h += 1) {
      const v = SIN_LUT[h] as number;
      expect(v).toBeGreaterThanOrEqual(-TRIG_SCALE);
      expect(v).toBeLessThanOrEqual(TRIG_SCALE);
    }
  });

  it("is monotonically non-decreasing across the first quadrant", () => {
    for (let h = 1; h <= 1024; h += 1) {
      expect(sinLut(h)).toBeGreaterThanOrEqual(sinLut(h - 1));
    }
  });

  it("satisfies exact symmetries", () => {
    for (let h = 0; h < ANGLE_STEPS; h += 1) {
      // sin(π - x) == sin(x)
      expect(sinLut((2048 - h) & 4095)).toBe(sinLut(h));
      // sin(-x) == -sin(x); `| 0` canonicalizes the IEEE -0 that plain
      // negation produces for zero entries (toBe uses Object.is).
      expect(sinLut((4096 - h) & 4095)).toBe(-sinLut(h) | 0);
    }
  });

  it("wraps indices outside [0, ANGLE_STEPS)", () => {
    expect(sinLut(4096)).toBe(sinLut(0));
    expect(sinLut(-1)).toBe(sinLut(4095));
    expect(cosLut(-1024)).toBe(cosLut(3072));
  });

  it("matches the golden table hash (locks all 4096 entries)", () => {
    const digest = new StateHash().array(HASH_TAG.i16, SIN_LUT).digest();
    expect(digest).toBe("80e3f9466ecdf39e");
  });
});
