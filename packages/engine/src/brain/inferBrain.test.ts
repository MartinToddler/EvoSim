import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../config/defaultConfig";
import { Q } from "../math/fixed";
import {
  BRAIN_HIDDEN_COUNT,
  BRAIN_INPUT_COUNT,
  BRAIN_OUTPUT_COUNT,
  BRAIN_WEIGHT_COUNT,
  BrainInput,
  BrainOutput,
  HO_OFFSET,
  IH_OFFSET,
  IO_OFFSET,
  hoWeightIndex,
  ihWeightIndex,
  ioWeightIndex,
} from "./BrainLayout";
import { createFounderBrainWeights } from "./founderBrain";
import { inferBrain, positiveOutputQ } from "./inferBrain";

const { weightScale, weightMin, weightMax } = DEFAULT_CONFIG.brain;

function run(sensors: Int16Array, weights: Int16Array): Int16Array {
  const hidden = new Int16Array(BRAIN_HIDDEN_COUNT);
  const outputs = new Int16Array(BRAIN_OUTPUT_COUNT);
  inferBrain(sensors, 0, weights, 0, hidden, 0, outputs, 0, weightScale);
  return outputs;
}

describe("brain layout", () => {
  it("matches the documented v0.1 topology and weight budget", () => {
    expect(BRAIN_INPUT_COUNT).toBe(20);
    expect(BRAIN_HIDDEN_COUNT).toBe(12);
    expect(BRAIN_OUTPUT_COUNT).toBe(5);
    expect(IH_OFFSET).toBe(0);
    expect(HO_OFFSET).toBe(240);
    expect(IO_OFFSET).toBe(300);
    expect(BRAIN_WEIGHT_COUNT).toBe(400);
  });

  it("agrees with the config, which the validator also cross-checks", () => {
    expect(DEFAULT_CONFIG.brain.inputCount).toBe(BRAIN_INPUT_COUNT);
    expect(DEFAULT_CONFIG.brain.hiddenCount).toBe(BRAIN_HIDDEN_COUNT);
    expect(DEFAULT_CONFIG.brain.outputCount).toBe(BRAIN_OUTPUT_COUNT);
    expect(DEFAULT_CONFIG.brain.weightCount).toBe(BRAIN_WEIGHT_COUNT);
  });

  it("gives every connection a distinct weight index", () => {
    const seen = new Set<number>();
    for (let h = 0; h < BRAIN_HIDDEN_COUNT; h += 1) {
      for (let i = 0; i < BRAIN_INPUT_COUNT; i += 1) {
        seen.add(ihWeightIndex(h, i));
      }
    }
    for (let o = 0; o < BRAIN_OUTPUT_COUNT; o += 1) {
      for (let h = 0; h < BRAIN_HIDDEN_COUNT; h += 1) {
        seen.add(hoWeightIndex(o, h));
      }
      for (let i = 0; i < BRAIN_INPUT_COUNT; i += 1) {
        seen.add(ioWeightIndex(o, i));
      }
    }
    expect(seen.size).toBe(BRAIN_WEIGHT_COUNT);
    expect(Math.min(...seen)).toBe(0);
    expect(Math.max(...seen)).toBe(BRAIN_WEIGHT_COUNT - 1);
  });
});

describe("quantized inference", () => {
  it("produces zero output from a zero network", () => {
    const sensors = new Int16Array(BRAIN_INPUT_COUNT).fill(Q);
    const outputs = run(sensors, new Int16Array(BRAIN_WEIGHT_COUNT));
    expect(Array.from(outputs)).toEqual([0, 0, 0, 0, 0]);
  });

  it("computes a known golden vector through skip, hidden and both paths", () => {
    const sensors = new Int16Array(BRAIN_INPUT_COUNT);
    sensors[0] = Q; // bias
    sensors[1] = -2048; // -0.5
    sensors[2] = 1024; // +0.25

    const weights = new Int16Array(BRAIN_WEIGHT_COUNT);
    // Skip path into output 0: 1.0*bias + 0.5*(-0.5) = 0.75 → 3072.
    weights[ioWeightIndex(0, 0)] = 4096;
    weights[ioWeightIndex(0, 1)] = 2048;
    // Hidden 0 = 0.25*bias + 1.0*(+0.25) = 0.5 → 2048; output 1 = 2.0*hidden0 = 1.0 → 4096.
    weights[ihWeightIndex(0, 0)] = 1024;
    weights[ihWeightIndex(0, 2)] = 4096;
    weights[hoWeightIndex(1, 0)] = 8192;
    // Output 2 mixes both paths: hidden0*0.5 + bias*(-0.25) = 0.25 - 0.25 = 0.
    weights[hoWeightIndex(2, 0)] = 2048;
    weights[ioWeightIndex(2, 0)] = -1024;

    const hidden = new Int16Array(BRAIN_HIDDEN_COUNT);
    const outputs = new Int16Array(BRAIN_OUTPUT_COUNT);
    inferBrain(sensors, 0, weights, 0, hidden, 0, outputs, 0, weightScale);

    expect(hidden[0]).toBe(2048);
    expect(Array.from(outputs)).toEqual([3072, 4096, 0, 0, 0]);
  });

  it("hard-clamps activations to [-Q, Q] rather than saturating the Int16", () => {
    const sensors = new Int16Array(BRAIN_INPUT_COUNT).fill(Q);
    const weights = new Int16Array(BRAIN_WEIGHT_COUNT);
    for (let i = 0; i < BRAIN_INPUT_COUNT; i += 1) {
      weights[ioWeightIndex(0, i)] = weightMax;
      weights[ioWeightIndex(1, i)] = weightMin;
      weights[ihWeightIndex(0, i)] = weightMax;
    }
    const hidden = new Int16Array(BRAIN_HIDDEN_COUNT);
    const outputs = new Int16Array(BRAIN_OUTPUT_COUNT);
    inferBrain(sensors, 0, weights, 0, hidden, 0, outputs, 0, weightScale);

    expect(hidden[0]).toBe(Q);
    expect(outputs[0]).toBe(Q);
    expect(outputs[1]).toBe(-Q);
  });

  it("truncates toward zero, matching the project rounding policy", () => {
    const sensors = new Int16Array(BRAIN_INPUT_COUNT);
    sensors[0] = 1;
    const weights = new Int16Array(BRAIN_WEIGHT_COUNT);
    weights[ioWeightIndex(0, 0)] = 4095; // 4095 / 4096 → 0
    weights[ioWeightIndex(1, 0)] = -4095; // -4095 / 4096 → -0, not -1
    const outputs = run(sensors, weights);
    expect(outputs[0]).toBe(0);
    expect(outputs[1]).toBe(0);
  });

  it("reads only its own organism's block", () => {
    const sensors = new Int16Array(BRAIN_INPUT_COUNT * 2);
    sensors[BRAIN_INPUT_COUNT + 0] = Q; // second organism's bias only
    const weights = new Int16Array(BRAIN_WEIGHT_COUNT * 2);
    weights[BRAIN_WEIGHT_COUNT + ioWeightIndex(0, 0)] = 4096;

    const hidden = new Int16Array(BRAIN_HIDDEN_COUNT);
    const outputs = new Int16Array(BRAIN_OUTPUT_COUNT * 2);
    inferBrain(sensors, 0, weights, 0, hidden, 0, outputs, 0, weightScale);
    inferBrain(
      sensors,
      BRAIN_INPUT_COUNT,
      weights,
      BRAIN_WEIGHT_COUNT,
      hidden,
      0,
      outputs,
      BRAIN_OUTPUT_COUNT,
      weightScale,
    );
    expect(outputs[0]).toBe(0);
    expect(outputs[BRAIN_OUTPUT_COUNT]).toBe(Q);
  });
});

describe("output mapping", () => {
  it("maps signed activations onto the positive action range", () => {
    expect(positiveOutputQ(-Q)).toBe(0);
    expect(positiveOutputQ(0)).toBe(Q / 2);
    expect(positiveOutputQ(Q)).toBe(Q);
  });
});

describe("founder brain fixture", () => {
  const weights = createFounderBrainWeights(weightScale, weightMin, weightMax);

  it("uses skip connections only, leaving the hidden layer silent", () => {
    for (let i = 0; i < IO_OFFSET; i += 1) {
      expect(`w[${i}]=${weights[i]}`).toBe(`w[${i}]=0`);
    }
    let nonZeroSkips = 0;
    for (let i = IO_OFFSET; i < BRAIN_WEIGHT_COUNT; i += 1) {
      if (weights[i] !== 0) {
        nonZeroSkips += 1;
      }
    }
    expect(nonZeroSkips).toBe(14);
  });

  it("encodes the documented conceptual weights symmetrically", () => {
    expect(weights[ioWeightIndex(BrainOutput.Throttle, BrainInput.Bias)]).toBe(1229); // +0.30
    expect(weights[ioWeightIndex(BrainOutput.Throttle, BrainInput.Energy)]).toBe(-1638); // -0.40
    expect(weights[ioWeightIndex(BrainOutput.Turn, BrainInput.PlantGradientLateral)]).toBe(6144);
    expect(weights[ioWeightIndex(BrainOutput.Turn, BrainInput.TerrainDangerLateral)]).toBe(7373);
    expect(weights[ioWeightIndex(BrainOutput.Attack, BrainInput.Bias)]).toBe(-3482); // -0.85
    expect(weights[ioWeightIndex(BrainOutput.Reproduce, BrainInput.Energy)]).toBe(5325);
  });

  it("stays inside the configured weight clamp", () => {
    for (let i = 0; i < BRAIN_WEIGHT_COUNT; i += 1) {
      expect(weights[i]).toBeGreaterThanOrEqual(weightMin);
      expect(weights[i]).toBeLessThanOrEqual(weightMax);
    }
  });

  it("produces the calibrated reflexes it was written for", () => {
    const sensors = new Int16Array(BRAIN_INPUT_COUNT);
    sensors[BrainInput.Bias] = Q;
    sensors[BrainInput.Energy] = 0; // half full
    sensors[BrainInput.Health] = Q;
    sensors[BrainInput.Development] = -Q; // newborn
    sensors[BrainInput.LocalPlant] = 0; // cell at half capacity
    sensors[BrainInput.CarcassProximity] = -Q; // no carrion anywhere
    sensors[BrainInput.CreatureProximity] = -Q;
    sensors[BrainInput.ThermalComfort] = Q;

    const outputs = run(sensors, weights);
    const throttle = positiveOutputQ(outputs[BrainOutput.Throttle] as number);
    const eat = positiveOutputQ(outputs[BrainOutput.Eat] as number);
    const attack = positiveOutputQ(outputs[BrainOutput.Attack] as number);
    const reproduce = positiveOutputQ(outputs[BrainOutput.Reproduce] as number);

    // Moves at a moderate pace rather than sprinting or standing still.
    expect(throttle).toBeGreaterThan(Q / 4);
    expect(throttle).toBeLessThan((3 * Q) / 4);
    // Feeds on a half-full cell despite the carcass sensor sitting at -Q.
    expect(eat).toBeGreaterThanOrEqual(DEFAULT_CONFIG.organism.feeding.eatOutputThresholdQ);
    // Barely attacks, and will not try to breed as a newborn.
    expect(attack).toBeLessThan(DEFAULT_CONFIG.combat.attackOutputThresholdQ);
    expect(reproduce).toBeLessThan(DEFAULT_CONFIG.reproduction.reproduceOutputThresholdQ);
  });

  it("stops feeding once a cell falls below a quarter of its capacity", () => {
    const sensors = new Int16Array(BRAIN_INPUT_COUNT);
    sensors[BrainInput.Bias] = Q;
    sensors[BrainInput.CarcassProximity] = -Q;
    const threshold = DEFAULT_CONFIG.organism.feeding.eatOutputThresholdQ;

    // localPlant = -0.5 is exactly 25% of capacity: the calibrated floor.
    sensors[BrainInput.LocalPlant] = -2048;
    expect(
      positiveOutputQ(run(sensors, weights)[BrainOutput.Eat] as number),
    ).toBeGreaterThanOrEqual(threshold);

    sensors[BrainInput.LocalPlant] = -2100;
    expect(positiveOutputQ(run(sensors, weights)[BrainOutput.Eat] as number)).toBeLessThan(
      threshold,
    );
  });

  it("turns toward lateral food and away from lateral danger", () => {
    const sensors = new Int16Array(BRAIN_INPUT_COUNT);
    sensors[BrainInput.Bias] = Q;
    sensors[BrainInput.CarcassProximity] = -Q;

    sensors[BrainInput.PlantGradientLateral] = 1000; // food to the right
    expect(run(sensors, weights)[BrainOutput.Turn] as number).toBeGreaterThan(0);

    sensors[BrainInput.PlantGradientLateral] = -1000; // food to the left
    expect(run(sensors, weights)[BrainOutput.Turn] as number).toBeLessThan(0);

    sensors[BrainInput.PlantGradientLateral] = 0;
    sensors[BrainInput.TerrainDangerLateral] = Q; // danger on the left
    expect(run(sensors, weights)[BrainOutput.Turn] as number).toBeGreaterThan(0); // turn right
  });

  it("slows down in front of danger and speeds up when hungry", () => {
    const sensors = new Int16Array(BRAIN_INPUT_COUNT);
    sensors[BrainInput.Bias] = Q;
    sensors[BrainInput.CarcassProximity] = -Q;
    sensors[BrainInput.Energy] = Q; // full
    const wellFed = positiveOutputQ(run(sensors, weights)[BrainOutput.Throttle] as number);

    sensors[BrainInput.Energy] = -Q; // starving
    const hungry = positiveOutputQ(run(sensors, weights)[BrainOutput.Throttle] as number);
    expect(hungry).toBeGreaterThan(wellFed);

    sensors[BrainInput.TerrainDangerForward] = Q;
    const facingWater = positiveOutputQ(run(sensors, weights)[BrainOutput.Throttle] as number);
    expect(facingWater).toBeLessThan(hungry);
  });
});
