import { describe, expect, it } from "vitest";
import { BIOME_COLORS, biomeName, composeTerrainRgba, hueTint, organismTint } from "./palette";

/**
 * Colour policy (docs/06 §§2, 4).
 *
 * `composeTerrainRgba` is the one piece of the renderer that turns simulation
 * fields into pixels, and it is pure, so it is tested directly rather than
 * through a GPU.
 */

function pixel(out: Uint8Array, cell: number): [number, number, number, number] {
  const at = cell << 2;
  return [out[at] as number, out[at + 1] as number, out[at + 2] as number, out[at + 3] as number];
}

describe("composeTerrainRgba", () => {
  it("writes opaque RGBA for every cell", () => {
    const cells = 16;
    const out = new Uint8Array(cells * 4);
    composeTerrainRgba(
      new Uint8Array(cells).fill(1),
      new Uint8Array(cells).fill(128),
      new Uint8Array(cells).fill(0),
      out,
    );
    for (let cell = 0; cell < cells; cell += 1) {
      expect(pixel(out, cell)[3]).toBe(255);
    }
  });

  it("greens land as vegetation fills in", () => {
    const bare = new Uint8Array(4);
    const lush = new Uint8Array(4);
    const grassland = new Uint8Array([1]);
    const elevation = new Uint8Array([128]);
    composeTerrainRgba(grassland, elevation, new Uint8Array([0]), bare);
    composeTerrainRgba(grassland, elevation, new Uint8Array([255]), lush);

    // Stocked ground is greener and less red than grazed ground: the single
    // most useful thing this view shows.
    expect(pixel(lush, 0)[0]).toBeLessThan(pixel(bare, 0)[0]);
    expect(pixel(lush, 0)[1] / Math.max(1, pixel(lush, 0)[0])).toBeGreaterThan(
      pixel(bare, 0)[1] / Math.max(1, pixel(bare, 0)[0]),
    );
  });

  it("keeps a saturated desert recognisably desert", () => {
    // The vegetation blend is capped below 1 so the biome underneath never
    // disappears.
    const out = new Uint8Array(4);
    composeTerrainRgba(new Uint8Array([3]), new Uint8Array([128]), new Uint8Array([255]), out);
    const [r, g, b] = pixel(out, 0);
    const desert = BIOME_COLORS[3] as readonly [number, number, number];
    expect(r).toBeGreaterThan(b);
    expect(r).toBeGreaterThan(60);
    expect(g).toBeLessThan(desert[1]);
  });

  it("ignores vegetation on water and darkens with depth", () => {
    const shallow = new Uint8Array(4);
    const deep = new Uint8Array(4);
    const water = new Uint8Array([0]);
    composeTerrainRgba(water, new Uint8Array([255]), new Uint8Array([255]), shallow);
    composeTerrainRgba(water, new Uint8Array([0]), new Uint8Array([255]), deep);

    expect(pixel(deep, 0)[2]).toBeLessThan(pixel(shallow, 0)[2]);
    // Blue-dominant either way: vegetation must not tint the sea green.
    expect(pixel(shallow, 0)[2]).toBeGreaterThan(pixel(shallow, 0)[1]);
    expect(pixel(deep, 0)[2]).toBeGreaterThan(pixel(deep, 0)[1]);
  });

  it("paints an unknown biome index in an unmistakable colour", () => {
    const out = new Uint8Array(4);
    composeTerrainRgba(new Uint8Array([200]), new Uint8Array([255]), new Uint8Array([0]), out);
    const [r, g, b] = pixel(out, 0);
    expect(r).toBeGreaterThan(200);
    expect(g).toBeLessThan(60);
    expect(b).toBeGreaterThan(200);
  });

  it("stops at the shortest input rather than reading past an array", () => {
    const out = new Uint8Array(8 * 4);
    expect(() => {
      composeTerrainRgba(new Uint8Array(2), new Uint8Array(8), new Uint8Array(8), out);
    }).not.toThrow();
    // Cells beyond the shortest field are left untouched.
    expect(pixel(out, 4)[3]).toBe(0);
  });
});

describe("hue and organism tints", () => {
  it("covers the hue circle and wraps", () => {
    expect(hueTint(0)).toBe(hueTint(360));
    expect(hueTint(-30)).toBe(hueTint(330));
    expect(hueTint(120)).not.toBe(hueTint(0));
  });

  it("produces the expected dominant channel per sector", () => {
    const red = hueTint(0);
    expect((red >> 16) & 0xff).toBeGreaterThan((red >> 8) & 0xff);
    const green = hueTint(120);
    expect((green >> 8) & 0xff).toBeGreaterThan((green >> 16) & 0xff);
    const blue = hueTint(240);
    expect(blue & 0xff).toBeGreaterThan((blue >> 8) & 0xff);
  });

  it("darkens with falling health but keeps the inherited hue readable", () => {
    const healthy = organismTint(200, 255);
    const wounded = organismTint(200, 20);
    const luminance = (tint: number): number =>
      ((tint >> 16) & 0xff) + ((tint >> 8) & 0xff) + (tint & 0xff);
    expect(luminance(wounded)).toBeLessThan(luminance(healthy));
    // Never black: a dying organism must still be visible.
    expect(luminance(wounded)).toBeGreaterThan(0);
    // Same hue family — health shades, it does not recolour.
    const dominant = (tint: number): number => {
      const r = (tint >> 16) & 0xff;
      const g = (tint >> 8) & 0xff;
      const b = tint & 0xff;
      return r >= g && r >= b ? 0 : g >= b ? 1 : 2;
    };
    expect(dominant(wounded)).toBe(dominant(healthy));
  });

  it("stays inside 24-bit range for every hue and health", () => {
    for (let hue = 0; hue < 360; hue += 7) {
      for (const health of [0, 1, 128, 255]) {
        const tint = organismTint(hue, health);
        expect(tint).toBeGreaterThanOrEqual(0);
        expect(tint).toBeLessThanOrEqual(0xffffff);
      }
    }
  });
});

describe("biomeName", () => {
  it("names the engine's biomes", () => {
    expect(biomeName(0)).toBe("Water");
    expect(biomeName(5)).toBe("Mountain");
  });

  it("labels an unknown index instead of returning undefined", () => {
    expect(biomeName(42)).toBe("Unknown(42)");
  });
});
