import { DEFAULT_CONFIG, cloneConfig, type SimulationConfig } from "@eon/engine";

/**
 * Worlds the persistence acceptance tests run.
 *
 * ## Why not DEFAULT_CONFIG for the long run
 *
 * The reference world's carrying capacity sits far above the organism safety
 * cap, so it spends a 10 000-tick run climbing toward thousands of organisms and
 * costs on the order of ten minutes *per run* — and the acceptance test needs
 * two of them. `soak.test.ts` in `@eon/engine` hit exactly this and answered it
 * the same way: a smaller map with the same biology. Every organism, brain,
 * mutation, reproduction, combat and plant constant here is DEFAULT_CONFIG's;
 * only geometry, founder count and the validity thresholds that scale with area
 * differ.
 *
 * That is not a weaker subject for what *this* milestone tests. A save has to
 * carry live organisms, their genomes and brains, the slot free lists, carcasses
 * with their own free list, species records, statistics, the event log and the
 * command cursor. This world produces all of them, and its boom-crash cycle
 * recycles organism and carcass slots hard — which is precisely the state a
 * naive snapshot gets wrong.
 *
 * A 64x64 variant was measured and rejected: it goes extinct near tick 8 000, so
 * the last fifth of a 10 000-tick comparison would be two empty worlds agreeing
 * with each other.
 *
 * The reference world is still covered — by a shorter continuation in
 * `continuation.test.ts`, and by the engine's own 10 000-tick golden fixture.
 */
export const ACCEPTANCE_GRID_SIZE = 96;
export const ACCEPTANCE_FOUNDERS = 64;

/** DEFAULT_CONFIG biology on a 1 536 LU map. */
export const ACCEPTANCE_CONFIG: SimulationConfig = (() => {
  const config = cloneConfig(DEFAULT_CONFIG);
  config.world.envGridSize = ACCEPTANCE_GRID_SIZE;
  config.world.sizeLU = ACCEPTANCE_GRID_SIZE * config.world.envCellSizeLU;
  config.world.generation.edgeFalloffCells = Math.max(1, Math.floor(ACCEPTANCE_GRID_SIZE / 8));
  config.world.initialOrganisms = ACCEPTANCE_FOUNDERS;
  config.world.founderSpawnRadiusLU = Math.min(
    config.world.founderSpawnRadiusLU,
    config.world.sizeLU / 4,
  );
  config.world.validity.minFounderRegionCells = Math.floor(
    (ACCEPTANCE_GRID_SIZE * ACCEPTANCE_GRID_SIZE) / 8,
  );
  config.world.validity.minTotalPlantCapacity = Math.floor(
    config.world.validity.minTotalPlantCapacity / 16,
  );
  return config;
})();

/** The project's mandated fixture seed (CLAUDE.md). */
export const ACCEPTANCE_SEED = 0xe0a12026;

/** Live organisms in a snapshot's alive flags. */
export function countAlive(alive: Uint8Array): number {
  let count = 0;
  for (const flag of alive) {
    count += flag;
  }
  return count;
}

/** Distinct gene values, as a cheap proxy for "mutation has happened". */
export function distinctGenes(genes: Uint16Array): number {
  const seen = new Set<number>();
  for (const gene of genes) {
    seen.add(gene);
  }
  return seen.size;
}
