/**
 * Non-authoritative population analytics for the headless tools.
 *
 * This lives in `scripts/` rather than in the engine on purpose. docs/05 §21
 * allows analytics such as trait variance and generation time, and forbids them
 * from ever feeding back into selection; keeping them outside `packages/engine`
 * makes that structural rather than a promise. It is also why floating point is
 * fine here and would not be inside a tick phase.
 */
import { Resource, GENE_COUNT, Gene, Q, type SimulationEngine, geneToQ } from "@eon/engine";

export interface PopulationStats {
  population: number;
  maxGeneration: number;
  meanGeneration: number;
  meanEnergy: number;
  meanDevelopmentQ: number;
  meanHealthQ: number;
  meanAgeTicks: number;
  /** Cumulative plant energy ingested by the CURRENTLY LIVING organisms. */
  plantIntake: number;
  /** Cumulative meat energy ingested by the CURRENTLY LIVING organisms. */
  meatIntake: number;
  /** Kills credited to the CURRENTLY LIVING organisms. */
  kills: number;
  /**
   * Mean signed diet gene of the living population, normalized to [-1, 1].
   *
   * The single number that says whether a world has discovered carnivory:
   * founders start herbivore-leaning, and only realized reproductive success can
   * move this.
   */
  meanDiet: number;
  /**
   * Summed population variance of the 15 ecological genes, hue excluded, in
   * normalized Q² units (docs/05 §3 excludes hue from trait comparison).
   *
   * Zero for the founder generation, which is genetically uniform, so any
   * non-zero value is inherited variation that mutation produced.
   */
  traitVarianceQ2: number;
  /** Per-gene variance in the same units, indexed by Gene. */
  varianceByGeneQ2: number[];
}

/** Summarize the living population of an engine. */
export function summarizePopulation(engine: SimulationEngine): PopulationStats {
  const { organisms, genomes } = engine;
  const slots: number[] = [];
  let energy = 0;
  let development = 0;
  let health = 0;
  let age = 0;
  let intake = 0;
  let meatIntake = 0;
  let kills = 0;
  let generationSum = 0;
  let maxGeneration = 0;

  for (let slot = 0; slot < organisms.slotHighWater; slot += 1) {
    if (organisms.alive[slot] !== 1) {
      continue;
    }
    slots.push(slot);
    energy += organisms.energy[slot] as number;
    development += organisms.developmentQ[slot] as number;
    health += organisms.healthQ[slot] as number;
    age += organisms.ageTicks[slot] as number;
    intake += organisms.plantEnergyEaten[slot] as number;
    meatIntake += organisms.meatEnergyEaten[slot] as number;
    kills += organisms.kills[slot] as number;
    const generation = organisms.generation[slot] as number;
    generationSum += generation;
    if (generation > maxGeneration) {
      maxGeneration = generation;
    }
  }

  const n = slots.length;
  const divisor = Math.max(n, 1);
  // Diet is stored unsigned and mapped to a signed Q range, exactly as the
  // engine's phenotype mapping does (docs/03 §24).
  let dietSum = 0;
  for (const slot of slots) {
    dietSum += (geneToQ(genomes.gene(slot, Gene.Process + Resource.Meat)) * 2 - Q) / Q;
  }
  const varianceByGeneQ2 = new Array<number>(GENE_COUNT).fill(0);
  let traitVarianceQ2 = 0;

  if (n >= 2) {
    for (let gene = 0; gene < GENE_COUNT; gene += 1) {
      let sum = 0;
      for (const slot of slots) {
        sum += geneToQ(genomes.gene(slot, gene));
      }
      const mean = sum / n;
      let squared = 0;
      for (const slot of slots) {
        const delta = geneToQ(genomes.gene(slot, gene)) - mean;
        squared += delta * delta;
      }
      const variance = squared / n;
      varianceByGeneQ2[gene] = variance;
      if (gene !== Gene.Hue) {
        traitVarianceQ2 += variance;
      }
    }
  }

  return {
    population: n,
    maxGeneration,
    meanGeneration: generationSum / divisor,
    meanEnergy: Math.round(energy / divisor),
    meanDevelopmentQ: development / divisor,
    meanHealthQ: health / divisor,
    meanAgeTicks: age / divisor,
    plantIntake: intake,
    meatIntake,
    kills,
    meanDiet: dietSum / divisor,
    traitVarianceQ2,
    varianceByGeneQ2,
  };
}

/** Standard-deviation view of {@link PopulationStats.traitVarianceQ2}, as a fraction of a gene range. */
export function traitStdDevFraction(stats: PopulationStats): number {
  // 15 genes contribute to the sum, so the mean per-gene variance is /15.
  const meanVariance = stats.traitVarianceQ2 / (GENE_COUNT - 1);
  return Math.sqrt(meanVariance) / Q;
}
