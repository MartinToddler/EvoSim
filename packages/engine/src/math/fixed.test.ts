import { describe, expect, it } from "vitest";
import {
  ANGLE_STEPS,
  POS_SCALE,
  Q,
  TRIG_SCALE,
  absInt,
  clamp,
  clampQ,
  clampSignedQ,
  distSq,
  lerpQ,
  qdiv,
  qmul,
} from "./fixed";

describe("fixed-point scales (docs/08 §1)", () => {
  it("locks the v0.1 scale constants", () => {
    expect(Q).toBe(4096);
    expect(POS_SCALE).toBe(256);
    expect(ANGLE_STEPS).toBe(4096);
    expect(TRIG_SCALE).toBe(32767);
  });
});

describe("qmul", () => {
  it("multiplies Q fractions", () => {
    expect(qmul(Q, Q)).toBe(Q); // 1.0 * 1.0
    expect(qmul(2048, 2048)).toBe(1024); // 0.5 * 0.5 = 0.25
    expect(qmul(8192, 2048)).toBe(4096); // 2.0 * 0.5 = 1.0
    expect(qmul(0, 12345)).toBe(0);
  });

  it("truncates toward zero, including negatives (documented rounding policy)", () => {
    expect(qmul(3, 3)).toBe(0); // 9/4096 truncates to 0
    expect(qmul(-3, 3)).toBe(0); // -9/4096 truncates to canonical 0, not -1
    expect(qmul(-2048, 2049)).toBe(-1024); // -1024.5 -> -1024 (toward zero)
    expect(qmul(2048, -2049)).toBe(-1024);
  });
});

describe("qdiv", () => {
  it("divides Q fractions", () => {
    expect(qdiv(Q, Q)).toBe(Q);
    expect(qdiv(1024, 2048)).toBe(2048); // 0.25 / 0.5 = 0.5
    expect(qdiv(Q, 2)).toBe(Q * 2048); // scale-up allowed for intermediate math
  });

  it("truncates toward zero for negative operands", () => {
    expect(qdiv(-1, 3)).toBe(-1365); // -4096/3 = -1365.33 -> -1365
    expect(qdiv(1, -3)).toBe(-1365);
  });
});

describe("clamp family", () => {
  it("clamp bounds values", () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-5, 0, 10)).toBe(0);
    expect(clamp(15, 0, 10)).toBe(10);
  });

  it("clampQ bounds into [0, Q]", () => {
    expect(clampQ(-1)).toBe(0);
    expect(clampQ(Q + 1)).toBe(Q);
    expect(clampQ(1234)).toBe(1234);
  });

  it("clampSignedQ bounds into [-Q, Q]", () => {
    expect(clampSignedQ(-Q - 1)).toBe(-Q);
    expect(clampSignedQ(Q + 1)).toBe(Q);
    expect(clampSignedQ(-1234)).toBe(-1234);
  });
});

describe("lerpQ", () => {
  it("is exact at both endpoints", () => {
    expect(lerpQ(100, 900, 0)).toBe(100);
    expect(lerpQ(100, 900, Q)).toBe(900);
    expect(lerpQ(-500, 500, 0)).toBe(-500);
    expect(lerpQ(-500, 500, Q)).toBe(500);
  });

  it("interpolates midpoints with truncation", () => {
    expect(lerpQ(0, 100, 2048)).toBe(50);
    expect(lerpQ(100, 0, 2048)).toBe(50);
    expect(lerpQ(0, 3, 2048)).toBe(1); // 1.5 truncates toward zero
  });
});

describe("distSq / absInt", () => {
  it("computes integer squared distance", () => {
    expect(distSq(0, 0, 3, 4)).toBe(25);
    expect(distSq(-3, -4, 0, 0)).toBe(25);
    expect(distSq(10, 10, 10, 10)).toBe(0);
  });

  it("absInt handles negatives", () => {
    expect(absInt(-7)).toBe(7);
    expect(absInt(7)).toBe(7);
    expect(absInt(0)).toBe(0);
  });
});
