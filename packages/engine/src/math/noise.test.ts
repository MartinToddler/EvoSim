import { describe, expect, it } from "vitest";
import { Q } from "./fixed";
import { NOISE_SALT, latticeValueQ, layeredNoiseQ, smoothstepQ, valueNoiseQ } from "./noise";

describe("smoothstepQ", () => {
  it("is exact at both ends and the midpoint", () => {
    expect(smoothstepQ(0)).toBe(0);
    expect(smoothstepQ(Q)).toBe(Q);
    expect(smoothstepQ(Q / 2)).toBe(Q / 2);
  });

  it("is monotonic and stays in range", () => {
    let previous = -1;
    for (let t = 0; t <= Q; t += 16) {
      const value = smoothstepQ(t);
      expect(value).toBeGreaterThanOrEqual(previous);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(Q);
      previous = value;
    }
  });

  it("clamps out-of-range inputs", () => {
    expect(smoothstepQ(-100)).toBe(0);
    expect(smoothstepQ(Q + 100)).toBe(Q);
  });
});

describe("latticeValueQ", () => {
  it("is a pure function of its inputs", () => {
    expect(latticeValueQ(1, 2, 3, 4)).toBe(latticeValueQ(1, 2, 3, 4));
  });

  it("stays inside [0, Q)", () => {
    for (let i = 0; i < 2000; i += 1) {
      const value = latticeValueQ(0xe0a12026, NOISE_SALT.moisture, i, i * 3);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(Q);
    }
  });

  it("decorrelates neighbouring lattice points", () => {
    // Adjacent points must not be adjacent values, or the field would show a
    // visible diagonal ramp instead of noise.
    const a = latticeValueQ(7, 0, 10, 10);
    const b = latticeValueQ(7, 0, 11, 10);
    const c = latticeValueQ(7, 0, 10, 11);
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });

  it("separates fields by salt", () => {
    expect(latticeValueQ(7, NOISE_SALT.moisture, 5, 5)).not.toBe(
      latticeValueQ(7, NOISE_SALT.temperature, 5, 5),
    );
  });

  it("matches golden values (locks the lattice hash)", () => {
    expect(latticeValueQ(0xe0a12026, NOISE_SALT.elevationOctave0, 0, 0)).toBe(744);
    expect(latticeValueQ(0xe0a12026, NOISE_SALT.moisture, 3, 7)).toBe(1475);
  });
});

describe("valueNoiseQ", () => {
  it("stays inside [0, Q]", () => {
    for (let gy = 0; gy < 64; gy += 1) {
      for (let gx = 0; gx < 64; gx += 1) {
        const value = valueNoiseQ(0xe0a12026, NOISE_SALT.moisture, gx, gy, 16);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(Q);
      }
    }
  });

  it("reproduces the lattice value exactly at lattice points", () => {
    const seed = 42;
    const wavelength = 16;
    for (const [ix, iy] of [
      [0, 0],
      [1, 0],
      [2, 3],
    ] as const) {
      expect(valueNoiseQ(seed, 0, ix * wavelength, iy * wavelength, wavelength)).toBe(
        latticeValueQ(seed, 0, ix, iy),
      );
    }
  });

  it("is continuous: neighbouring samples differ smoothly", () => {
    // With a 64-cell wavelength, one step can only move a fraction of the way
    // between two lattice values, so large jumps mean broken interpolation.
    let maxJump = 0;
    let previous = valueNoiseQ(11, 0, 0, 5, 64);
    for (let gx = 1; gx < 256; gx += 1) {
      const value = valueNoiseQ(11, 0, gx, 5, 64);
      maxJump = Math.max(maxJump, Math.abs(value - previous));
      previous = value;
    }
    expect(maxJump).toBeLessThan(Q / 8);
  });

  it("is deterministic across calls", () => {
    expect(valueNoiseQ(5, 1, 17, 23, 32)).toBe(valueNoiseQ(5, 1, 17, 23, 32));
  });
});

describe("layeredNoiseQ", () => {
  const octaves = [
    { wavelengthCells: 64, weightQ: 2253 },
    { wavelengthCells: 32, weightQ: 1229 },
    { wavelengthCells: 16, weightQ: 614 },
  ];

  it("stays inside [0, Q] across the grid", () => {
    for (let gy = 0; gy < 256; gy += 8) {
      for (let gx = 0; gx < 256; gx += 8) {
        const value = layeredNoiseQ(0xe0a12026, NOISE_SALT.elevationOctave0, gx, gy, octaves);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(Q);
      }
    }
  });

  it("actually varies across the grid", () => {
    const values = new Set<number>();
    for (let gx = 0; gx < 256; gx += 4) {
      values.add(layeredNoiseQ(3, NOISE_SALT.elevationOctave0, gx, 128, octaves));
    }
    expect(values.size).toBeGreaterThan(32);
  });

  it("gives different seeds different fields", () => {
    const a = layeredNoiseQ(1, NOISE_SALT.elevationOctave0, 40, 40, octaves);
    const b = layeredNoiseQ(2, NOISE_SALT.elevationOctave0, 40, 40, octaves);
    expect(a).not.toBe(b);
  });
});
