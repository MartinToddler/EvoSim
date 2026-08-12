import type { DeepReadonly } from "@eon/shared";
import type { SimulationConfig } from "../config/SimulationConfig";
import { Q, clamp, clampQ, qmul } from "../math/fixed";
import { NOISE_SALT, layeredNoiseQ, smoothstepQ, valueNoiseQ } from "../math/noise";
import { EnvironmentStore } from "./EnvironmentStore";
import { classifyBiome } from "./biomes";
import { recomputeAllPlantCapacities, temperatureSuitabilityQ } from "./plants";

/**
 * Deterministic procedural world generation (tasks C03–C06, docs/03 §§15–20).
 *
 * Everything is a pure function of (seed, config): no PRNG draws, no wall
 * clock. Two engines given the same seed and config build byte-identical
 * environment arrays, which is what makes the world part of the state hash
 * meaningful.
 *
 * Field order matters, because each field feeds the next: elevation decides
 * where water is, water and elevation shape moisture, elevation and latitude
 * shape temperature, and all three produce fertility, biomes and finally plant
 * capacity.
 */

/** Salt separating world-generation retry sub-seeds from other noise fields. */
const RETRY_SALT = 0x0000a77e;

function fmix32(h: number): number {
  let x = h >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x85ebca6b) >>> 0;
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35) >>> 0;
  x ^= x >>> 16;
  return x >>> 0;
}

/**
 * Sub-seed for generation attempt `attempt` (docs/03 §15).
 * Attempt 0 uses the world seed unchanged, so "seed X gives world X" holds for
 * every world that is valid on the first try — which is the normal case.
 */
export function generationSubSeed(seed: number, attempt: number): number {
  if (attempt === 0) {
    return seed >>> 0;
  }
  return fmix32((fmix32((seed ^ RETRY_SALT) >>> 0) ^ attempt) >>> 0);
}

/** Elevation with the border faded to ocean (docs/03 §15 "apply edge falloff"). */
function generateElevation(
  environment: EnvironmentStore,
  config: DeepReadonly<SimulationConfig>,
  seed: number,
): void {
  const { size } = environment;
  const { elevationOctaves, edgeFalloffCells } = config.world.generation;
  const octaves = elevationOctaves.map((octave) => ({
    wavelengthCells: octave.wavelengthCells,
    weightQ: octave.weightQ,
  }));

  for (let gy = 0; gy < size; gy += 1) {
    for (let gx = 0; gx < size; gx += 1) {
      const raw = layeredNoiseQ(seed, NOISE_SALT.elevationOctave0, gx, gy, octaves);

      // Distance to the nearest border, faded with smoothstep so the coast is
      // a gradient rather than a hard ring.
      const edgeDistance = Math.min(gx, gy, size - 1 - gx, size - 1 - gy);
      const falloffQ =
        edgeDistance >= edgeFalloffCells
          ? Q
          : smoothstepQ(Math.trunc((edgeDistance * Q) / edgeFalloffCells));

      environment.elevationQ[gy * size + gx] = clampQ(qmul(raw, falloffQ));
    }
  }
}

/**
 * Water influence field in [0, Q]: 1.0 in water, decaying with distance inland
 * (docs/03 §16 "deterministic grid distance/dilation approximation").
 *
 * Implemented as max-dilation with a fixed decay per pass, double buffered so
 * the result does not depend on iteration direction.
 */
function computeWaterInfluence(
  environment: EnvironmentStore,
  config: DeepReadonly<SimulationConfig>,
): Uint16Array {
  const { size, cellCount, elevationQ } = environment;
  const { seaLevelQ } = config.world;
  const passes = config.world.generation.waterInfluencePasses;

  let current = new Uint16Array(cellCount);
  let next = new Uint16Array(cellCount);
  for (let i = 0; i < cellCount; i += 1) {
    current[i] = (elevationQ[i] as number) < seaLevelQ ? Q : 0;
  }

  const decay = Math.trunc(Q / (passes + 1));
  const last = size - 1;

  // Direct index arithmetic with explicit border tests: this loop runs
  // passes × cellCount times, so neither a helper call nor a per-cell array
  // literal belongs in it (CLAUDE.md: no allocation in hot loops).
  for (let pass = 0; pass < passes; pass += 1) {
    for (let gy = 0; gy < size; gy += 1) {
      const rowBase = gy * size;
      for (let gx = 0; gx < size; gx += 1) {
        const index = rowBase + gx;
        let best = current[index] as number;

        if (gx > 0) {
          const value = (current[index - 1] as number) - decay;
          if (value > best) best = value;
        }
        if (gx < last) {
          const value = (current[index + 1] as number) - decay;
          if (value > best) best = value;
        }
        if (gy > 0) {
          const value = (current[index - size] as number) - decay;
          if (value > best) best = value;
        }
        if (gy < last) {
          const value = (current[index + size] as number) - decay;
          if (value > best) best = value;
        }

        next[index] = best < 0 ? 0 : best > Q ? Q : best;
      }
    }
    const swap = current;
    current = next;
    next = swap;
  }

  return current;
}

/** Moisture = noise + inverse elevation + water influence (docs/03 §16). */
function generateMoisture(
  environment: EnvironmentStore,
  config: DeepReadonly<SimulationConfig>,
  seed: number,
  waterInfluence: Uint16Array,
): void {
  const { size } = environment;
  const { moistureWavelengthCells } = config.world.generation;
  const weights = config.world.moisture;

  for (let gy = 0; gy < size; gy += 1) {
    for (let gx = 0; gx < size; gx += 1) {
      const index = gy * size + gx;
      const noiseQ = valueNoiseQ(seed, NOISE_SALT.moisture, gx, gy, moistureWavelengthCells);
      const inverseElevationQ = Q - (environment.elevationQ[index] as number);

      const moisture =
        qmul(noiseQ, weights.noiseWeightQ) +
        qmul(inverseElevationQ, weights.inverseElevationWeightQ) +
        qmul(waterInfluence[index] as number, weights.waterInfluenceWeightQ);

      environment.baseMoistureQ[index] = clampQ(moisture);
    }
  }
}

/** Temperature from latitude, elevation and low-frequency noise (docs/03 §17). */
function generateTemperature(
  environment: EnvironmentStore,
  config: DeepReadonly<SimulationConfig>,
  seed: number,
): void {
  const { size } = environment;
  const { temperatureWavelengthCells } = config.world.generation;
  const climate = config.world.climate;
  const { seaLevelQ } = config.world;
  const maxLatitudeSpan = size - 1;

  for (let gy = 0; gy < size; gy += 1) {
    // 0 at the equator row, Q at either pole edge. Symmetric by construction.
    const latitudeQ = Math.trunc((Math.abs(2 * gy - maxLatitudeSpan) * Q) / maxLatitudeSpan);
    const latitudeCooling = qmul(climate.poleTemperatureDropCentiC, latitudeQ);

    for (let gx = 0; gx < size; gx += 1) {
      const index = gy * size + gx;
      const elevation = environment.elevationQ[index] as number;
      const aboveSeaQ =
        elevation <= seaLevelQ
          ? 0
          : Math.trunc(((elevation - seaLevelQ) * Q) / Math.max(Q - seaLevelQ, 1));
      const elevationCooling = qmul(climate.elevationCoolingCentiC, aboveSeaQ);

      // Signed noise in [-amplitude, +amplitude].
      const noiseQ = valueNoiseQ(seed, NOISE_SALT.temperature, gx, gy, temperatureWavelengthCells);
      const noiseCentiC = Math.trunc(
        ((2 * noiseQ - Q) * climate.temperatureNoiseAmplitudeCentiC) / Q,
      );

      const temperature =
        climate.equatorTemperatureCentiC - latitudeCooling - elevationCooling + noiseCentiC;

      // Int16Array range is ±32767, i.e. ±327 °C — unreachable, but clamp so a
      // future extreme configuration cannot silently wrap.
      environment.baseTemperatureCentiC[index] = clamp(temperature, -32768, 32767);
    }
  }
}

/** Fertility from moisture, temperature, lowland preference and noise (docs/03 §18). */
function generateFertility(
  environment: EnvironmentStore,
  config: DeepReadonly<SimulationConfig>,
  seed: number,
): void {
  const { size } = environment;
  const { fertilityWavelengthCells } = config.world.generation;
  const fertility = config.world.fertility;
  const { seaLevelQ } = config.world;

  for (let gy = 0; gy < size; gy += 1) {
    for (let gx = 0; gx < size; gx += 1) {
      const index = gy * size + gx;
      const elevation = environment.elevationQ[index] as number;
      const aboveSeaQ =
        elevation <= seaLevelQ
          ? 0
          : Math.trunc(((elevation - seaLevelQ) * Q) / Math.max(Q - seaLevelQ, 1));

      const temperatureQ = temperatureSuitabilityQ(
        environment.baseTemperatureCentiC[index] as number,
        fertility.optimumTemperatureCentiC,
        fertility.toleranceCentiC,
      );
      const noiseQ = valueNoiseQ(seed, NOISE_SALT.fertility, gx, gy, fertilityWavelengthCells);

      const value =
        qmul(environment.baseMoistureQ[index] as number, fertility.moistureWeightQ) +
        qmul(temperatureQ, fertility.temperatureWeightQ) +
        qmul(Q - aboveSeaQ, fertility.lowlandWeightQ) +
        qmul(noiseQ, fertility.noiseWeightQ);

      environment.fertilityQ[index] = clampQ(value);
    }
  }
}

/** Classify every cell (docs/03 §19). */
function generateBiomes(
  environment: EnvironmentStore,
  config: DeepReadonly<SimulationConfig>,
): void {
  const thresholds = {
    seaLevelQ: config.world.seaLevelQ,
    mountainLevelQ: config.world.mountainLevelQ,
    ...config.world.biomeThresholds,
  };

  for (let i = 0; i < environment.cellCount; i += 1) {
    environment.biome[i] = classifyBiome(
      {
        elevationQ: environment.elevationQ[i] as number,
        moistureQ: environment.getMoistureQ(i),
        fertilityQ: environment.fertilityQ[i] as number,
        temperatureCentiC: environment.getTemperatureCentiC(i),
      },
      thresholds,
    );
  }
}

/**
 * Build one candidate world from a sub-seed. Validity is checked separately by
 * the caller, which retries with the next sub-seed if this world is unusable.
 */
export function generateEnvironment(
  config: DeepReadonly<SimulationConfig>,
  subSeed: number,
): EnvironmentStore {
  const environment = new EnvironmentStore(config.world.envGridSize, config.world.envCellSizeLU);

  generateElevation(environment, config, subSeed);
  const waterInfluence = computeWaterInfluence(environment, config);
  generateMoisture(environment, config, subSeed, waterInfluence);
  generateTemperature(environment, config, subSeed);
  generateFertility(environment, config, subSeed);
  generateBiomes(environment, config);

  recomputeAllPlantCapacities(environment, config);
  seedInitialBiomass(environment, config);

  environment.recomputePassability();

  return environment;
}

/** Start every productive cell at a configured fraction of its capacity. */
function seedInitialBiomass(
  environment: EnvironmentStore,
  config: DeepReadonly<SimulationConfig>,
): void {
  const fractionQ = config.plants.initialBiomassFractionQ;
  for (let i = 0; i < environment.cellCount; i += 1) {
    environment.plantBiomass[i] = qmul(environment.plantCapacity[i] as number, fractionQ);
  }
}
