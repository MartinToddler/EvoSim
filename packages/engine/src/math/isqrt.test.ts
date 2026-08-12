import { describe, expect, it } from "vitest";
import { Q } from "./fixed";
import { isqrt, powQ, qsqrt } from "./isqrt";

describe("isqrt", () => {
  it("returns the exact integer square root for small values", () => {
    for (let n = 0; n < 2000; n += 1) {
      const root = isqrt(n);
      expect(root * root).toBeLessThanOrEqual(n);
      expect((root + 1) * (root + 1)).toBeGreaterThan(n);
    }
  });

  it("is exact on perfect squares and one either side of them", () => {
    for (let r = 1; r <= 100_000; r = r < 1000 ? r + 1 : r * 3) {
      const square = r * r;
      expect(isqrt(square)).toBe(r);
      expect(isqrt(square - 1)).toBe(r - 1);
      expect(isqrt(square + 1)).toBe(r);
    }
  });

  it("handles the largest squared world distance", () => {
    // Two opposite corners of a 4096 LU world in sub-units.
    const span = 4096 * 256;
    const distSq = 2 * span * span;
    const root = isqrt(distSq);
    expect(root * root).toBeLessThanOrEqual(distSq);
    expect((root + 1) * (root + 1)).toBeGreaterThan(distSq);
  });

  it("treats zero and negatives as zero rather than producing NaN", () => {
    expect(isqrt(0)).toBe(0);
    expect(isqrt(-1)).toBe(0);
    expect(isqrt(-1e9)).toBe(0);
  });

  it("uses no transcendental math, so it agrees with Math.sqrt where that is exact", () => {
    for (let n = 1; n < 100_000; n += 997) {
      expect(isqrt(n)).toBe(Math.floor(Math.sqrt(n)));
    }
  });
});

describe("qsqrt", () => {
  it("is exact at the endpoints", () => {
    expect(qsqrt(0)).toBe(0);
    expect(qsqrt(Q)).toBe(Q);
  });

  it("squares back to approximately the input", () => {
    for (let a = 0; a <= Q; a += 37) {
      const root = qsqrt(a);
      const squared = Math.trunc((root * root) / Q);
      expect(Math.abs(squared - a)).toBeLessThanOrEqual(2);
    }
  });
});

describe("powQ", () => {
  it("is exact at the endpoints", () => {
    expect(powQ(0, 5530)).toBe(0);
    expect(powQ(Q, 5530)).toBe(Q);
    expect(powQ(Q, 5120)).toBe(Q);
    expect(powQ(2048, 0)).toBe(Q);
  });

  it("reproduces integer exponents exactly enough", () => {
    // x² at x = 0.5 is 0.25.
    expect(powQ(2048, 2 * Q)).toBe(1024);
    // x¹ is the identity.
    expect(powQ(1234, Q)).toBe(1234);
  });

  it("is monotone in the base", () => {
    let previous = -1;
    for (let x = 0; x <= Q; x += 16) {
      const value = powQ(x, 5530);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
  });

  it("tracks the real power to well under 1% of Q", () => {
    for (const exponentQ of [5530, 5120, 5734]) {
      const exponent = exponentQ / Q;
      for (let x = 64; x <= Q; x += 64) {
        const expected = Math.pow(x / Q, exponent) * Q;
        expect(Math.abs(powQ(x, exponentQ) - expected)).toBeLessThan(0.01 * Q);
      }
    }
  });

  it("never exceeds Q for a base in [0, Q] and an exponent of at least 1", () => {
    for (let x = 0; x <= Q; x += 13) {
      expect(powQ(x, 5530)).toBeLessThanOrEqual(Q);
      expect(powQ(x, 5734)).toBeLessThanOrEqual(Q);
    }
  });
});
