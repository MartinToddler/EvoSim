import { type SimulationEngine, clamp } from "@eon/engine";
import type { EnvironmentDebugFields } from "@eon/renderer";

/**
 * Engine → debug field snapshot (Milestone 2.5).
 *
 * The only place in the debug view that touches the engine's environment store.
 * It does three things and nothing else:
 *
 * 1. copies the authoritative arrays, so what is on screen is a snapshot rather
 *    than a live alias — advancing the world cannot make the image disagree with
 *    the numbers printed next to it;
 * 2. folds the player offsets into effective moisture and temperature, so the
 *    painter never has to know how the engine splits a field into base + offset;
 * 3. picks the biomass reference the two vegetation layers share.
 *
 * It makes no simulation decision, changes no engine state and derives nothing
 * biological. This is the whole engine boundary of the debug view: the renderer
 * side never sees `EnvironmentStore`, and React never sees either.
 */

/** Int16Array bounds, so a large player temperature offset cannot wrap around. */
const INT16_MIN = -32768;
const INT16_MAX = 32767;

export function captureEnvironmentDebugFields(engine: SimulationEngine): EnvironmentDebugFields {
  const { environment, config } = engine;
  const cells = environment.cellCount;

  const moistureQ = new Uint16Array(cells);
  const temperatureCentiC = new Int16Array(cells);
  let maxCapacity = 0;

  for (let i = 0; i < cells; i += 1) {
    moistureQ[i] = environment.getMoistureQ(i);
    temperatureCentiC[i] = clamp(environment.getTemperatureCentiC(i), INT16_MIN, INT16_MAX);
    const capacity = environment.resourceCapacity[i] as number;
    if (capacity > maxCapacity) {
      maxCapacity = capacity;
    }
  }

  return {
    size: environment.size,
    cellSizeLU: environment.cellSizeLU,
    elevationQ: new Uint16Array(environment.elevationQ),
    moistureQ,
    temperatureCentiC,
    fertilityQ: new Uint16Array(environment.fertilityQ),
    biome: new Uint8Array(environment.biome),
    // Totals across every channel, one value per cell (M17). The debug layers
    // are a per-cell map and the underlying arrays are now five planes long, so
    // copying them raw would draw the foliage plane over a fifth of the world
    // and index off the end for the rest.
    plantCapacity: totalPerCell(environment, environment.resourceCapacity),
    plantBiomass: totalPerCell(environment, environment.resourceBiomass),
    seaLevelQ: config.world.seaLevelQ,
    mountainLevelQ: config.world.mountainLevelQ,
    // A world with no capacity anywhere would be rejected by world validation, but
    // the ramp still needs a positive span, so floor the reference at 1.
    biomassReference: Math.max(maxCapacity, 1),
  };
}

/** Sum one resource-major field down to one value per cell. */
function totalPerCell(environment: { cellCount: number }, field: Uint16Array): Uint16Array {
  const { cellCount } = environment;
  const planes = field.length / cellCount;
  const out = new Uint16Array(cellCount);
  for (let cell = 0; cell < cellCount; cell += 1) {
    let total = 0;
    for (let plane = 0; plane < planes; plane += 1) {
      total += field[plane * cellCount + cell] as number;
    }
    out[cell] = Math.min(total, 65535);
  }
  return out;
}
