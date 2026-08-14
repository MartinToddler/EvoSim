import { describe, expect, it } from "vitest";
import {
  WORLD_LAYERS,
  composeBiomeLayerRgba,
  composeDataLayerRgba,
  isWorldLayerId,
  worldLayerLegendStops,
} from "./palette";

/**
 * World-layer composition (task H05). Pure byte-array functions, so the whole
 * layer feature short of the GPU upload is testable in Node — including the
 * property the milestone demands: composing a view reads fields and writes
 * pixels, nothing else.
 */

const CELLS = 16;

function base(): Uint8Array {
  const pixels = new Uint8Array(CELLS * 4);
  for (let cell = 0; cell < CELLS; cell += 1) {
    pixels[cell * 4] = 100;
    pixels[cell * 4 + 1] = 110;
    pixels[cell * 4 + 2] = 120;
    pixels[cell * 4 + 3] = 255;
  }
  return pixels;
}

describe("world layer palette", () => {
  it("has legend stops for every data layer and biome swatches for biomes", () => {
    for (const layer of WORLD_LAYERS) {
      if (layer.id === "terrain") {
        continue;
      }
      expect(worldLayerLegendStops(layer.id).length, layer.id).toBeGreaterThan(1);
    }
    expect(worldLayerLegendStops("biome")).toHaveLength(6);
  });

  it("validates layer ids", () => {
    expect(isWorldLayerId("temperature")).toBe(true);
    expect(isWorldLayerId("terrain")).toBe(true);
    expect(isWorldLayerId("wind")).toBe(false);
    expect(isWorldLayerId(3)).toBe(false);
  });

  it("maps low values dark and high values bright on sequential ramps", () => {
    const values = new Uint8Array(CELLS);
    values[0] = 0;
    values[1] = 255;
    const out = new Uint8Array(CELLS * 4);
    composeDataLayerRgba("moisture", values, base(), 1, out);
    const luminanceLow = (out[0] as number) + (out[1] as number) + (out[2] as number);
    const luminanceHigh = (out[4] as number) + (out[5] as number) + (out[6] as number);
    expect(luminanceHigh).toBeGreaterThan(luminanceLow);
    expect(out[3]).toBe(255);
  });

  it("temperature diverges: cold is blue, hot is red, the middle is neutral", () => {
    const values = new Uint8Array(CELLS);
    values[0] = 0;
    values[1] = 128;
    values[2] = 255;
    const out = new Uint8Array(CELLS * 4);
    composeDataLayerRgba("temperature", values, base(), 1, out);
    // Cold pole: blue dominates red. Hot pole: red dominates blue.
    expect(out[2] as number).toBeGreaterThan(out[0] as number);
    expect(out[8] as number).toBeGreaterThan(out[10] as number);
    // Neutral midpoint: channels close together (gray-ish).
    const midSpread =
      Math.max(out[4] as number, out[5] as number, out[6] as number) -
      Math.min(out[4] as number, out[5] as number, out[6] as number);
    expect(midSpread).toBeLessThan(24);
  });

  it("opacity 0 shows the base verbatim; opacity 1 shows pure layer colour", () => {
    const values = new Uint8Array(CELLS).fill(255);
    const zero = new Uint8Array(CELLS * 4);
    composeDataLayerRgba("fertility", values, base(), 0, zero);
    expect([...zero.subarray(0, 4)]).toEqual([100, 110, 120, 255]);

    const full = new Uint8Array(CELLS * 4);
    const fullAgain = new Uint8Array(CELLS * 4);
    composeDataLayerRgba("fertility", values, base(), 1, full);
    composeDataLayerRgba("fertility", values, new Uint8Array(CELLS * 4), 1, fullAgain);
    // At full opacity the base contributes nothing.
    expect([...full]).toEqual([...fullAgain]);
  });

  it("is a pure function of its inputs (idempotent, input untouched)", () => {
    const values = new Uint8Array(CELLS).fill(80);
    Object.freeze(values.buffer);
    const baseline = base();
    const baselineCopy = new Uint8Array(baseline);
    const first = new Uint8Array(CELLS * 4);
    const second = new Uint8Array(CELLS * 4);
    composeDataLayerRgba("vegetation", values, baseline, 0.7, first);
    composeDataLayerRgba("vegetation", values, baseline, 0.7, second);
    expect([...first]).toEqual([...second]);
    expect([...baseline]).toEqual([...baselineCopy]);
  });

  it("paints biome categories flat and blends them by opacity", () => {
    const biome = new Uint8Array(CELLS);
    biome[0] = 0; // water
    biome[1] = 3; // desert
    const out = new Uint8Array(CELLS * 4);
    composeBiomeLayerRgba(biome, base(), 1, out);
    expect([...out.subarray(0, 3)]).toEqual([38, 76, 130]);
    expect([...out.subarray(4, 7)]).toEqual([214, 192, 130]);

    const blended = new Uint8Array(CELLS * 4);
    composeBiomeLayerRgba(biome, base(), 0.5, blended);
    expect(blended[0]).toBe(Math.round((100 + 38) / 2) | 0);
  });
});
