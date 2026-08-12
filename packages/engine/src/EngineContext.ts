import type { ReadonlySimulationConfig } from "./config/cloneConfig";
import type { EngineScratch } from "./EngineScratch";
import type { GenomeStore } from "./organisms/GenomeStore";
import type { OrganismStore } from "./organisms/OrganismStore";
import type { PhenotypeStore } from "./organisms/phenotype";
import type { Xoshiro128 } from "./random/Xoshiro128";
import type { SpatialGrid } from "./spatial/SpatialGrid";
import type { EnvironmentStore } from "./world/EnvironmentStore";

/**
 * Everything an authoritative tick phase may touch.
 *
 * Phases take this context rather than the engine itself (ADR 0002 §1): the hot
 * path then performs no WeakMap lookup, phases stay unit-testable against a
 * synthetic context, and the set of state a phase can reach is visible in one
 * place. The context is built once in the engine constructor and never
 * replaced; only the contents of its stores change.
 *
 * The current tick is deliberately absent. It lives in the engine's private
 * field and is passed explicitly to the phases that need it (sensing, aging),
 * so no phase can read a stale copy.
 */
export interface EngineContext {
  /** World seed, for stateless per-entity noise. */
  readonly seed: number;
  readonly config: ReadonlySimulationConfig;
  readonly environment: EnvironmentStore;
  readonly organisms: OrganismStore;
  readonly genomes: GenomeStore;
  readonly phenotypes: PhenotypeStore;
  /** Spatial index as of before movement; sensing reads it. */
  readonly spatialPre: SpatialGrid;
  /** Spatial index as of after movement; feeding and combat read it. */
  readonly spatialPost: SpatialGrid;
  readonly scratch: EngineScratch;
  /**
   * The authoritative generator. Only phases that genuinely need randomness may
   * draw from it, and only inside a tick — advancing it anywhere else breaks
   * the determinism contract.
   */
  readonly rng: Xoshiro128;
}
