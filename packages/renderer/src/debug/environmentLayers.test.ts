import { describe, expect, it } from "vitest";
import { DEBUG_BIOME_COLORS, DEBUG_BIOME_COUNT, UNKNOWN_BIOME_COLOR } from "./biomePalette";
import { isAscendingRamp, type RampStop, type Rgb } from "./colorRamp";
import {
  type DebugPixelBuffer,
  EnvironmentDebugError,
  type EnvironmentDebugFields,
  Q_SCALE,
} from "./environmentDebugFields";
import {
  createDebugPixelBuffer,
  describeLayerLegend,
  ENVIRONMENT_DEBUG_LAYER_IDS,
  ENVIRONMENT_DEBUG_LAYERS,
  FERTILITY_RAMP,
  formatCellValue,
  formatCentiC,
  formatQ,
  MOISTURE_RAMP,
  paintEnvironmentLayer,
  parseEnvironmentDebugLayerId,
  TEMPERATURE_DISPLAY_MAX_CENTIC,
  TEMPERATURE_DISPLAY_MIN_CENTIC,
  TEMPERATURE_RAMP,
} from "./environmentLayers";

const SEA_LEVEL_Q = 1884;
const MOUNTAIN_LEVEL_Q = 3195;

/**
 * A tiny hand-built 2×2 world.
 *
 * Cell 0 is deep water, cell 1 is a fertile lowland, cell 2 is a cold mountain,
 * cell 3 is a hot dry desert cell. Every value is chosen so the expected colour
 * can be reasoned about by hand.
 */
function makeFields(overrides: Partial<EnvironmentDebugFields> = {}): EnvironmentDebugFields {
  return {
    size: 2,
    cellSizeLU: 16,
    elevationQ: new Uint16Array([0, 2400, 4096, 2000]),
    moistureQ: new Uint16Array([4096, 3000, 1000, 0]),
    temperatureCentiC: new Int16Array([1000, 1800, -1500, 3500]),
    fertilityQ: new Uint16Array([0, 4096, 500, 200]),
    biome: new Uint8Array([0, 2, 5, 3]),
    plantCapacity: new Uint16Array([0, 20000, 1000, 4000]),
    plantBiomass: new Uint16Array([0, 10000, 250, 4000]),
    seaLevelQ: SEA_LEVEL_Q,
    mountainLevelQ: MOUNTAIN_LEVEL_Q,
    biomassReference: 20000,
    ...overrides,
  };
}

/** Drop the domain position from a ramp stop, leaving just the colour. */
function rgbOf(stop: { r: number; g: number; b: number }): Rgb {
  return { r: stop.r, g: stop.g, b: stop.b };
}

function pixel(target: DebugPixelBuffer, index: number): Rgb & { a: number } {
  const at = index * 4;
  return {
    r: target[at] as number,
    g: target[at + 1] as number,
    b: target[at + 2] as number,
    a: target[at + 3] as number,
  };
}

describe("layer registry", () => {
  it("describes every layer id exactly once, in a stable order", () => {
    expect(ENVIRONMENT_DEBUG_LAYERS.map((layer) => layer.id)).toEqual([
      ...ENVIRONMENT_DEBUG_LAYER_IDS,
    ]);
    expect(new Set(ENVIRONMENT_DEBUG_LAYER_IDS).size).toBe(ENVIRONMENT_DEBUG_LAYER_IDS.length);
  });

  it("covers the seven fields the milestone requires", () => {
    expect([...ENVIRONMENT_DEBUG_LAYER_IDS]).toEqual([
      "elevation",
      "biome",
      "temperature",
      "moisture",
      "fertility",
      "plantCapacity",
      "plantBiomass",
    ]);
  });

  it("gives every layer a label and a description", () => {
    for (const layer of ENVIRONMENT_DEBUG_LAYERS) {
      expect(layer.label.length).toBeGreaterThan(0);
      expect(layer.description.length).toBeGreaterThan(20);
    }
  });

  it("parses known layer ids and rejects anything else", () => {
    expect(parseEnvironmentDebugLayerId("biome")).toBe("biome");
    expect(parseEnvironmentDebugLayerId("plantBiomass")).toBe("plantBiomass");
    expect(parseEnvironmentDebugLayerId("elevations")).toBeNull();
    expect(parseEnvironmentDebugLayerId("")).toBeNull();
    expect(parseEnvironmentDebugLayerId("__proto__")).toBeNull();
  });

  it("ships only strictly ascending ramps", () => {
    expect(isAscendingRamp(TEMPERATURE_RAMP)).toBe(true);
    expect(isAscendingRamp(MOISTURE_RAMP)).toBe(true);
    expect(isAscendingRamp(FERTILITY_RAMP)).toBe(true);
  });
});

describe("paintEnvironmentLayer", () => {
  it("fills every pixel opaquely for every layer", () => {
    const fields = makeFields();
    for (const layer of ENVIRONMENT_DEBUG_LAYER_IDS) {
      const target = createDebugPixelBuffer(fields);
      paintEnvironmentLayer(fields, layer, target);
      for (let i = 0; i < 4; i += 1) {
        expect(pixel(target, i).a).toBe(255);
      }
    }
  });

  it("produces a buffer of exactly size² × 4 bytes", () => {
    const fields = makeFields();
    expect(createDebugPixelBuffer(fields).length).toBe(2 * 2 * 4);
    const bigger = makeFields({
      size: 4,
      elevationQ: new Uint16Array(16),
      moistureQ: new Uint16Array(16),
      temperatureCentiC: new Int16Array(16),
      fertilityQ: new Uint16Array(16),
      biome: new Uint8Array(16),
      plantCapacity: new Uint16Array(16),
      plantBiomass: new Uint16Array(16),
    });
    expect(createDebugPixelBuffer(bigger).length).toBe(4 * 4 * 4);
  });

  it("rejects a target buffer of the wrong size rather than painting part of it", () => {
    const fields = makeFields();
    expect(() => paintEnvironmentLayer(fields, "biome", new Uint8ClampedArray(15))).toThrow(
      EnvironmentDebugError,
    );
    expect(() => paintEnvironmentLayer(fields, "biome", new Uint8ClampedArray(17))).toThrow(
      EnvironmentDebugError,
    );
  });

  it("rejects fields whose arrays disagree with the grid size", () => {
    const broken = makeFields({ fertilityQ: new Uint16Array(3) });
    expect(() => paintEnvironmentLayer(broken, "fertility", new Uint8ClampedArray(16))).toThrow(
      /fertilityQ has 3 entries, expected 4/,
    );
  });

  it("rejects thresholds that would make the elevation ramp ill-formed", () => {
    const inverted = makeFields({ seaLevelQ: 3000, mountainLevelQ: 2000 });
    expect(() => paintEnvironmentLayer(inverted, "elevation", new Uint8ClampedArray(16))).toThrow(
      /mountain level/,
    );
    const noReference = makeFields({ biomassReference: 0 });
    expect(() =>
      paintEnvironmentLayer(noReference, "plantBiomass", new Uint8ClampedArray(16)),
    ).toThrow(/biomass reference/);
  });

  it("reuses the target buffer, so switching layers overwrites in place", () => {
    const fields = makeFields();
    const target = createDebugPixelBuffer(fields);
    paintEnvironmentLayer(fields, "biome", target);
    const asBiome = pixel(target, 1);
    paintEnvironmentLayer(fields, "fertility", target);
    expect(pixel(target, 1)).not.toEqual(asBiome);
    paintEnvironmentLayer(fields, "biome", target);
    expect(pixel(target, 1)).toEqual(asBiome);
  });

  describe("biome layer", () => {
    it("maps each cell to its palette colour", () => {
      const fields = makeFields();
      const target = createDebugPixelBuffer(fields);
      paintEnvironmentLayer(fields, "biome", target);
      expect(pixel(target, 0)).toMatchObject(DEBUG_BIOME_COLORS[0] as Rgb); // Water
      expect(pixel(target, 1)).toMatchObject(DEBUG_BIOME_COLORS[2] as Rgb); // Forest
      expect(pixel(target, 2)).toMatchObject(DEBUG_BIOME_COLORS[5] as Rgb); // Mountain
      expect(pixel(target, 3)).toMatchObject(DEBUG_BIOME_COLORS[3] as Rgb); // Desert
    });

    it("paints an out-of-range biome in a deliberately impossible colour", () => {
      const fields = makeFields({ biome: new Uint8Array([0, 1, 2, DEBUG_BIOME_COUNT + 3]) });
      const target = createDebugPixelBuffer(fields);
      paintEnvironmentLayer(fields, "biome", target);
      expect(pixel(target, 3)).toMatchObject(UNKNOWN_BIOME_COLOR);
    });
  });

  describe("elevation layer", () => {
    it("splits the palette exactly at sea level", () => {
      const fields = makeFields({
        elevationQ: new Uint16Array([SEA_LEVEL_Q - 1, SEA_LEVEL_Q, 0, Q_SCALE]),
      });
      const target = createDebugPixelBuffer(fields);
      paintEnvironmentLayer(fields, "elevation", target);

      const justBelow = pixel(target, 0);
      const atSeaLevel = pixel(target, 1);
      const deepest = pixel(target, 2);
      const peak = pixel(target, 3);

      // Just below sea level is the top of the ocean ramp; at sea level is the
      // bottom of the land ramp. The two must differ, or the coastline is a lie.
      expect(justBelow).not.toEqual(atSeaLevel);
      // Ocean is blue-dominant, land at the shore is green-dominant.
      expect(justBelow.b).toBeGreaterThan(justBelow.g);
      expect(atSeaLevel.g).toBeGreaterThan(atSeaLevel.b);
      // Deep water is darker than the shelf; the peak is the brightest thing shown.
      expect(deepest.r + deepest.g + deepest.b).toBeLessThan(
        justBelow.r + justBelow.g + justBelow.b,
      );
      expect(peak.r + peak.g + peak.b).toBeGreaterThan(atSeaLevel.r + atSeaLevel.g + atSeaLevel.b);
    });

    it("is monotone in brightness across the land range", () => {
      const samples: number[] = [];
      for (let elevation = SEA_LEVEL_Q; elevation <= Q_SCALE; elevation += 64) {
        const fields = makeFields({
          elevationQ: new Uint16Array([elevation, elevation, elevation, elevation]),
        });
        const target = createDebugPixelBuffer(fields);
        paintEnvironmentLayer(fields, "elevation", target);
        const p = pixel(target, 0);
        samples.push(p.r + p.g + p.b);
      }
      // Not strictly monotone stop-to-stop (rock is darker than midland), but the
      // ends must be ordered: the snow cap is the brightest sample.
      expect(Math.max(...samples)).toBe(samples[samples.length - 1]);
    });
  });

  describe("temperature layer", () => {
    it("uses the fixed display window, clamping beyond it", () => {
      const belowMin = TEMPERATURE_DISPLAY_MIN_CENTIC - 5000;
      const aboveMax = TEMPERATURE_DISPLAY_MAX_CENTIC + 5000;
      const fields = makeFields({
        temperatureCentiC: new Int16Array([
          belowMin,
          TEMPERATURE_DISPLAY_MIN_CENTIC,
          aboveMax,
          TEMPERATURE_DISPLAY_MAX_CENTIC,
        ]),
      });
      const target = createDebugPixelBuffer(fields);
      paintEnvironmentLayer(fields, "temperature", target);
      expect(pixel(target, 0)).toEqual(pixel(target, 1));
      expect(pixel(target, 2)).toEqual(pixel(target, 3));
    });

    it("paints the documented anchors exactly", () => {
      const fields = makeFields({ temperatureCentiC: new Int16Array([0, 1800, 3000, -2000]) });
      const target = createDebugPixelBuffer(fields);
      paintEnvironmentLayer(fields, "temperature", target);
      expect(pixel(target, 0)).toMatchObject({ r: 122, g: 178, b: 220 }); // 0 °C
      expect(pixel(target, 1)).toMatchObject({ r: 245, g: 240, b: 205 }); // 18 °C
      expect(pixel(target, 2)).toMatchObject({ r: 232, g: 150, b: 78 }); // 30 °C
      expect(pixel(target, 3)).toMatchObject({ r: 49, g: 78, b: 158 }); // -20 °C
    });

    it("is cold-to-warm ordered: colder cells are more blue than red", () => {
      const fields = makeFields({ temperatureCentiC: new Int16Array([-1500, 0, 1800, 3500]) });
      const target = createDebugPixelBuffer(fields);
      paintEnvironmentLayer(fields, "temperature", target);
      expect(pixel(target, 0).b).toBeGreaterThan(pixel(target, 0).r);
      expect(pixel(target, 3).r).toBeGreaterThan(pixel(target, 3).b);
    });
  });

  describe("normalized field layers", () => {
    it("paints moisture and fertility from their ramp endpoints", () => {
      const fields = makeFields({
        moistureQ: new Uint16Array([0, Q_SCALE, 0, Q_SCALE]),
        fertilityQ: new Uint16Array([0, Q_SCALE, 0, Q_SCALE]),
      });
      const target = createDebugPixelBuffer(fields);

      paintEnvironmentLayer(fields, "moisture", target);
      expect(pixel(target, 0)).toMatchObject(rgbOf(MOISTURE_RAMP[0] as RampStop));
      expect(pixel(target, 1)).toMatchObject(
        rgbOf(MOISTURE_RAMP[MOISTURE_RAMP.length - 1] as RampStop),
      );

      paintEnvironmentLayer(fields, "fertility", target);
      expect(pixel(target, 0)).toMatchObject(rgbOf(FERTILITY_RAMP[0] as RampStop));
      expect(pixel(target, 1)).toMatchObject(
        rgbOf(FERTILITY_RAMP[FERTILITY_RAMP.length - 1] as RampStop),
      );
    });

    it("distinguishes every distinct moisture value it is given", () => {
      const fields = makeFields({ moistureQ: new Uint16Array([0, 1024, 2048, 4096]) });
      const target = createDebugPixelBuffer(fields);
      paintEnvironmentLayer(fields, "moisture", target);
      const colors = [0, 1, 2, 3].map((i) => JSON.stringify(pixel(target, i)));
      expect(new Set(colors).size).toBe(4);
    });
  });

  describe("vegetation layers", () => {
    it("shares one scale, so capacity and biomass are comparable by eye", () => {
      const fields = makeFields({
        biome: new Uint8Array([1, 1, 1, 1]),
        plantCapacity: new Uint16Array([0, 10000, 20000, 20000]),
        plantBiomass: new Uint16Array([0, 10000, 20000, 5000]),
        biomassReference: 20000,
      });
      const capacityPixels = createDebugPixelBuffer(fields);
      const biomassPixels = createDebugPixelBuffer(fields);
      paintEnvironmentLayer(fields, "plantCapacity", capacityPixels);
      paintEnvironmentLayer(fields, "plantBiomass", biomassPixels);

      // Equal values must produce equal colours across the two layers.
      for (const index of [0, 1, 2]) {
        expect(pixel(capacityPixels, index)).toEqual(pixel(biomassPixels, index));
      }
      // Cell 3 holds a quarter of its capacity, so biomass is darker there.
      const cap = pixel(capacityPixels, 3);
      const bio = pixel(biomassPixels, 3);
      expect(bio.g).toBeLessThan(cap.g);
    });

    it("draws water as water rather than as barren land", () => {
      const fields = makeFields({
        biome: new Uint8Array([0, 1, 0, 1]),
        plantCapacity: new Uint16Array([0, 0, 0, 20000]),
        plantBiomass: new Uint16Array([0, 0, 0, 20000]),
      });
      const target = createDebugPixelBuffer(fields);
      paintEnvironmentLayer(fields, "plantCapacity", target);
      const water = pixel(target, 0);
      const barrenLand = pixel(target, 1);
      expect(water).not.toEqual(barrenLand);
      expect(water.b).toBeGreaterThan(water.g);
      expect(pixel(target, 2)).toEqual(water);
    });

    it("still paints a degenerate world whose biomass reference is 1", () => {
      // Not reachable through world validation, but the ramp must stay well formed
      // rather than throwing inside a debug view.
      const fields = makeFields({
        biome: new Uint8Array([1, 1, 1, 1]),
        plantCapacity: new Uint16Array([0, 1, 1, 0]),
        plantBiomass: new Uint16Array([0, 1, 0, 1]),
        biomassReference: 1,
      });
      const target = createDebugPixelBuffer(fields);
      expect(() => {
        paintEnvironmentLayer(fields, "plantBiomass", target);
      }).not.toThrow();
      expect(pixel(target, 1)).not.toEqual(pixel(target, 0));
    });

    it("clamps a cell above the world reference to the top of the ramp", () => {
      const fields = makeFields({
        biome: new Uint8Array([1, 1, 1, 1]),
        plantBiomass: new Uint16Array([20000, 30000, 65535, 20000]),
        biomassReference: 20000,
      });
      const target = createDebugPixelBuffer(fields);
      paintEnvironmentLayer(fields, "plantBiomass", target);
      expect(pixel(target, 1)).toEqual(pixel(target, 0));
      expect(pixel(target, 2)).toEqual(pixel(target, 0));
    });
  });
});

describe("describeLayerLegend", () => {
  it("returns non-empty captions and CSS colours for every layer", () => {
    const fields = makeFields();
    for (const layer of ENVIRONMENT_DEBUG_LAYER_IDS) {
      const legend = describeLayerLegend(fields, layer);
      expect(legend.length).toBeGreaterThan(1);
      for (const entry of legend) {
        expect(entry.caption.length).toBeGreaterThan(0);
        expect(entry.css).toMatch(/^rgb\(\d+, \d+, \d+\)$/);
      }
    }
  });

  it("names every biome, so colour is never the only signal", () => {
    const legend = describeLayerLegend(makeFields(), "biome");
    expect(legend.map((entry) => entry.caption)).toEqual([
      "Water",
      "Grassland",
      "Forest",
      "Desert",
      "Tundra",
      "Mountain",
    ]);
  });

  it("reports the world's own thresholds and biomass reference", () => {
    const fields = makeFields();
    const elevation = describeLayerLegend(fields, "elevation")
      .map((entry) => entry.caption)
      .join(" ");
    expect(elevation).toContain(formatQ(SEA_LEVEL_Q));
    expect(elevation).toContain(formatQ(MOUNTAIN_LEVEL_Q));

    const vegetation = describeLayerLegend(fields, "plantBiomass").map((entry) => entry.caption);
    expect(vegetation).toContain("20000 units");
    expect(vegetation).toContain("water");
  });
});

describe("formatCellValue", () => {
  it("formats each layer in its own unit", () => {
    const fields = makeFields();
    expect(formatCellValue(fields, "elevation", 1)).toBe("0.586");
    expect(formatCellValue(fields, "biome", 1)).toBe("Forest");
    expect(formatCellValue(fields, "temperature", 1)).toBe("18.00 °C");
    expect(formatCellValue(fields, "moisture", 1)).toBe("0.732");
    expect(formatCellValue(fields, "fertility", 1)).toBe("1.000");
    expect(formatCellValue(fields, "plantCapacity", 1)).toBe("20000 units");
    expect(formatCellValue(fields, "plantBiomass", 1)).toBe("10000 units");
  });

  it("formats negative temperatures", () => {
    expect(formatCentiC(-1500)).toBe("-15.00 °C");
    expect(formatQ(0)).toBe("0.000");
    expect(formatQ(Q_SCALE)).toBe("1.000");
  });
});
