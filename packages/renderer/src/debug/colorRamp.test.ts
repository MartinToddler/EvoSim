import { describe, expect, it } from "vitest";
import {
  type ColorRamp,
  type Rgb,
  compactRamp,
  isAscendingRamp,
  rgbToCss,
  sampleRamp,
} from "./colorRamp";

const RAMP: ColorRamp = [
  { at: 0, r: 0, g: 0, b: 0 },
  { at: 100, r: 100, g: 50, b: 200 },
  { at: 200, r: 200, g: 0, b: 100 },
];

function sample(ramp: ColorRamp, value: number): Rgb {
  const out: Rgb = { r: -1, g: -1, b: -1 };
  sampleRamp(ramp, value, out);
  return out;
}

describe("sampleRamp", () => {
  it("returns stop colours exactly at stop positions", () => {
    expect(sample(RAMP, 0)).toEqual({ r: 0, g: 0, b: 0 });
    expect(sample(RAMP, 100)).toEqual({ r: 100, g: 50, b: 200 });
    expect(sample(RAMP, 200)).toEqual({ r: 200, g: 0, b: 100 });
  });

  it("interpolates linearly between stops", () => {
    expect(sample(RAMP, 50)).toEqual({ r: 50, g: 25, b: 100 });
    expect(sample(RAMP, 150)).toEqual({ r: 150, g: 25, b: 150 });
  });

  it("clamps below the first and above the last stop", () => {
    expect(sample(RAMP, -1000)).toEqual({ r: 0, g: 0, b: 0 });
    expect(sample(RAMP, 999_999)).toEqual({ r: 200, g: 0, b: 100 });
  });

  it("handles ramps with negative domains (temperature in centi-Celsius)", () => {
    const signed: ColorRamp = [
      { at: -2000, r: 0, g: 0, b: 255 },
      { at: 0, r: 128, g: 128, b: 128 },
      { at: 2000, r: 255, g: 0, b: 0 },
    ];
    expect(sample(signed, -2000)).toEqual({ r: 0, g: 0, b: 255 });
    // Truncation is toward zero, matching the engine's rounding policy
    // (ADR 0001 §5): the falling blue channel lands on 192, not 191.
    expect(sample(signed, -1000)).toEqual({ r: 64, g: 64, b: 192 });
    expect(sample(signed, 0)).toEqual({ r: 128, g: 128, b: 128 });
    expect(sample(signed, 1000)).toEqual({ r: 191, g: 64, b: 64 });
  });

  it("is deterministic and integer valued across the whole domain", () => {
    for (let value = -50; value <= 250; value += 1) {
      const first = sample(RAMP, value);
      expect(sample(RAMP, value)).toEqual(first);
      expect(Number.isInteger(first.r)).toBe(true);
      expect(Number.isInteger(first.g)).toBe(true);
      expect(Number.isInteger(first.b)).toBe(true);
    }
  });

  it("writes into the caller's colour object rather than allocating", () => {
    const out: Rgb = { r: 9, g: 9, b: 9 };
    sampleRamp(RAMP, 50, out);
    expect(out).toEqual({ r: 50, g: 25, b: 100 });
    sampleRamp(RAMP, 200, out);
    expect(out).toEqual({ r: 200, g: 0, b: 100 });
  });

  it("supports a single-stop ramp as a constant colour", () => {
    const flat: ColorRamp = [{ at: 42, r: 1, g: 2, b: 3 }];
    expect(sample(flat, -1)).toEqual({ r: 1, g: 2, b: 3 });
    expect(sample(flat, 42)).toEqual({ r: 1, g: 2, b: 3 });
    expect(sample(flat, 1000)).toEqual({ r: 1, g: 2, b: 3 });
  });

  it("rejects an empty ramp instead of painting an undefined colour", () => {
    expect(() => sample([], 0)).toThrow(RangeError);
  });
});

describe("isAscendingRamp", () => {
  it("accepts a strictly ascending ramp", () => {
    expect(isAscendingRamp(RAMP)).toBe(true);
    expect(isAscendingRamp([{ at: 0, r: 0, g: 0, b: 0 }])).toBe(true);
  });

  it("rejects empty, repeated and descending stops", () => {
    expect(isAscendingRamp([])).toBe(false);
    expect(
      isAscendingRamp([
        { at: 5, r: 0, g: 0, b: 0 },
        { at: 5, r: 1, g: 1, b: 1 },
      ]),
    ).toBe(false);
    expect(
      isAscendingRamp([
        { at: 5, r: 0, g: 0, b: 0 },
        { at: 4, r: 1, g: 1, b: 1 },
      ]),
    ).toBe(false);
  });
});

describe("compactRamp", () => {
  it("leaves an already ascending ramp alone", () => {
    expect(compactRamp(RAMP)).toEqual(RAMP);
  });

  it("collapses colliding stops, keeping the later colour", () => {
    const collapsed = compactRamp([
      { at: 0, r: 1, g: 1, b: 1 },
      { at: 0, r: 2, g: 2, b: 2 },
      { at: 10, r: 3, g: 3, b: 3 },
    ]);
    expect(collapsed).toEqual([
      { at: 0, r: 2, g: 2, b: 2 },
      { at: 10, r: 3, g: 3, b: 3 },
    ]);
    expect(isAscendingRamp(collapsed)).toBe(true);
  });

  it("keeps the ramp extreme when the last stop collides", () => {
    // A world whose mountain threshold sits at 1.0 puts rock and snow together;
    // the peak colour must survive, not the one below it.
    const collapsed = compactRamp([
      { at: 0, r: 1, g: 1, b: 1 },
      { at: 4096, r: 2, g: 2, b: 2 },
      { at: 4096, r: 3, g: 3, b: 3 },
    ]);
    expect(collapsed[collapsed.length - 1]).toEqual({ at: 4096, r: 3, g: 3, b: 3 });
    expect(isAscendingRamp(collapsed)).toBe(true);
  });

  it("produces an ascending ramp from any non-descending input", () => {
    for (const middle of [0, 1, 2, 5, 9, 10]) {
      const result = compactRamp([
        { at: 0, r: 0, g: 0, b: 0 },
        { at: middle, r: 1, g: 1, b: 1 },
        { at: 10, r: 2, g: 2, b: 2 },
      ]);
      expect(isAscendingRamp(result)).toBe(true);
    }
  });

  it("returns an empty ramp for empty input rather than inventing a stop", () => {
    expect(compactRamp([])).toEqual([]);
  });
});

describe("rgbToCss", () => {
  it("formats an rgb() string", () => {
    expect(rgbToCss({ r: 1, g: 22, b: 255 })).toBe("rgb(1, 22, 255)");
  });
});
