import type { DeepReadonly } from "@eon/shared";
import type { SimulationConfig } from "../config/SimulationConfig";
import { Q } from "../math/fixed";
import type { ReadonlyEnvironmentView } from "./EnvironmentStore";
import { BIOME_COUNT, Biome } from "./biomes";
import { totalPlantCapacity } from "./plants";

/**
 * World validity and founder-region selection (tasks C03/C08, docs/03 §§15, 26).
 *
 * A procedurally generated world can be unusable: nearly all ocean, nearly all
 * land, a single climate, or no connected habitat big enough for a founder
 * population. Rather than nudging the generator with special cases, an invalid
 * world is rejected and regenerated from a derived sub-seed — the world stays
 * a pure function of the seed, and nothing is quietly "fixed up".
 */

export interface FounderRegion {
  /** Cell index of the region centre. */
  centerCellIndex: number;
  centerGridX: number;
  centerGridY: number;
  /** Size in cells of the connected land component containing the centre. */
  componentCells: number;
}

export interface WorldValidity {
  valid: boolean;
  /** Human-readable reason when invalid; empty when valid. */
  reason: string;
  landFractionQ: number;
  totalCapacity: number;
  biomeClasses: number;
  largestComponentCells: number;
  /** Present only when the world is valid. */
  founderRegion: FounderRegion | null;
}

/** Fraction of cells that are not water, in Q. */
export function landFractionQ(environment: ReadonlyEnvironmentView): number {
  let land = 0;
  for (let i = 0; i < environment.cellCount; i += 1) {
    if (environment.biome[i] !== Biome.Water) {
      land += 1;
    }
  }
  return Math.trunc((land * Q) / environment.cellCount);
}

/** Number of distinct biome classes present in the world. */
export function distinctBiomeCount(environment: ReadonlyEnvironmentView): number {
  const seen = new Uint8Array(BIOME_COUNT);
  for (let i = 0; i < environment.cellCount; i += 1) {
    seen[environment.biome[i] as number] = 1;
  }
  let count = 0;
  for (let b = 0; b < BIOME_COUNT; b += 1) {
    count += seen[b] as number;
  }
  return count;
}

/**
 * Label connected components of productive land (4-connectivity).
 *
 * Cells are scanned in ascending index order and each component is flood
 * filled with an explicit stack, so labels — and therefore the choice of
 * "largest component, ties by lowest label" — are fully deterministic.
 * Returns labels (0 = not productive land) and the size of each label.
 */
export function labelLandComponents(environment: ReadonlyEnvironmentView): {
  labels: Int32Array;
  sizes: number[];
} {
  const { cellCount, size } = environment;
  const labels = new Int32Array(cellCount);
  const sizes: number[] = [0]; // index 0 is the "not land" bucket
  const stack = new Int32Array(cellCount);

  const isLand = (index: number): boolean =>
    environment.biome[index] !== Biome.Water && (environment.plantCapacity[index] as number) > 0;

  let nextLabel = 1;
  for (let start = 0; start < cellCount; start += 1) {
    if (labels[start] !== 0 || !isLand(start)) {
      continue;
    }

    const label = nextLabel;
    nextLabel += 1;
    let count = 0;
    let top = 0;
    stack[top] = start;
    top += 1;
    labels[start] = label;

    while (top > 0) {
      top -= 1;
      const index = stack[top] as number;
      count += 1;

      const gx = index % size;
      const gy = (index - gx) / size;

      // Four neighbours pushed inline: allocating an array per popped cell
      // would mean one allocation per land cell per world generation.
      if (gx > 0 && labels[index - 1] === 0 && isLand(index - 1)) {
        labels[index - 1] = label;
        stack[top] = index - 1;
        top += 1;
      }
      if (gx < size - 1 && labels[index + 1] === 0 && isLand(index + 1)) {
        labels[index + 1] = label;
        stack[top] = index + 1;
        top += 1;
      }
      if (gy > 0 && labels[index - size] === 0 && isLand(index - size)) {
        labels[index - size] = label;
        stack[top] = index - size;
        top += 1;
      }
      if (gy < size - 1 && labels[index + size] === 0 && isLand(index + size)) {
        labels[index + size] = label;
        stack[top] = index + size;
        top += 1;
      }
    }

    sizes.push(count);
  }

  return { labels, sizes };
}

/**
 * Separable box blur of plant capacity, used to score "how fertile is the
 * neighbourhood" rather than "how fertile is this one cell".
 *
 * Without it the founder centre would land on whichever single cell happens to
 * have the highest capacity, which can be a one-cell islet.
 */
function blurCapacity(environment: ReadonlyEnvironmentView, radiusCells: number): Int32Array {
  const { size, cellCount, plantCapacity } = environment;
  const horizontal = new Int32Array(cellCount);
  const blurred = new Int32Array(cellCount);

  for (let gy = 0; gy < size; gy += 1) {
    for (let gx = 0; gx < size; gx += 1) {
      let sum = 0;
      for (let dx = -radiusCells; dx <= radiusCells; dx += 1) {
        sum += plantCapacity[environment.cellIndex(gx + dx, gy)] as number;
      }
      horizontal[gy * size + gx] = sum;
    }
  }

  for (let gy = 0; gy < size; gy += 1) {
    for (let gx = 0; gx < size; gx += 1) {
      let sum = 0;
      for (let dy = -radiusCells; dy <= radiusCells; dy += 1) {
        sum += horizontal[environment.cellIndex(gx, gy + dy)] as number;
      }
      blurred[gy * size + gx] = sum;
    }
  }

  return blurred;
}

/**
 * Choose the founder region (docs/03 §26): the most productive neighbourhood
 * inside the largest connected land component.
 *
 * Tie-breaking is explicit — highest blurred capacity, then lowest cell index —
 * so the same world always produces the same founder region.
 */
export function selectFounderRegion(
  environment: ReadonlyEnvironmentView,
  config: DeepReadonly<SimulationConfig>,
  labels: Int32Array,
  largestLabel: number,
  componentCells: number,
): FounderRegion {
  const radiusCells = Math.max(
    1,
    Math.ceil(config.world.founderSpawnRadiusLU / environment.cellSizeLU),
  );
  const blurred = blurCapacity(environment, radiusCells);

  let bestIndex = -1;
  let bestScore = -1;
  for (let i = 0; i < environment.cellCount; i += 1) {
    if (labels[i] !== largestLabel) {
      continue;
    }
    const score = blurred[i] as number;
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }

  // The component is non-empty by construction, so a centre always exists.
  const centerGridX = bestIndex % environment.size;
  const centerGridY = (bestIndex - centerGridX) / environment.size;
  return { centerCellIndex: bestIndex, centerGridX, centerGridY, componentCells };
}

/** Run every world validity rule (docs/03 §15). */
export function validateWorld(
  environment: ReadonlyEnvironmentView,
  config: DeepReadonly<SimulationConfig>,
): WorldValidity {
  const land = landFractionQ(environment);
  const capacity = totalPlantCapacity(environment);
  const biomeClasses = distinctBiomeCount(environment);
  const { labels, sizes } = labelLandComponents(environment);

  let largestLabel = 0;
  let largestCells = 0;
  for (let label = 1; label < sizes.length; label += 1) {
    const cells = sizes[label] as number;
    if (cells > largestCells) {
      largestCells = cells;
      largestLabel = label;
    }
  }

  const result: WorldValidity = {
    valid: false,
    reason: "",
    landFractionQ: land,
    totalCapacity: capacity,
    biomeClasses,
    largestComponentCells: largestCells,
    founderRegion: null,
  };

  if (land < config.world.minLandFractionQ) {
    result.reason = `land fraction ${land} below minimum ${config.world.minLandFractionQ}`;
    return result;
  }
  if (land > config.world.maxLandFractionQ) {
    result.reason = `land fraction ${land} above maximum ${config.world.maxLandFractionQ}`;
    return result;
  }
  if (largestCells < config.world.validity.minFounderRegionCells) {
    result.reason =
      `largest connected land component ${largestCells} cells, below minimum ` +
      `${config.world.validity.minFounderRegionCells}`;
    return result;
  }
  if (capacity < config.world.validity.minTotalPlantCapacity) {
    result.reason = `total plant capacity ${capacity} below minimum ${config.world.validity.minTotalPlantCapacity}`;
    return result;
  }
  if (biomeClasses < config.world.validity.minBiomeClasses) {
    result.reason = `only ${biomeClasses} biome classes, minimum ${config.world.validity.minBiomeClasses}`;
    return result;
  }

  result.valid = true;
  result.founderRegion = selectFounderRegion(
    environment,
    config,
    labels,
    largestLabel,
    largestCells,
  );
  return result;
}
