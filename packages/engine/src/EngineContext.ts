import type { ReadonlySimulationConfig } from "./config/cloneConfig";
import type { CarcassStore } from "./ecology/CarcassStore";
import type { EngineScratch } from "./EngineScratch";
import type { SpeciesStore } from "./evolution/SpeciesStore";
import type { TraitRanges } from "./evolution/traitVector";
import type { EventStore } from "./history/EventStore";
import type { EventDetectors } from "./history/eventDetection";
import type { StatisticsStore } from "./history/StatisticsStore";
import type { NeuralStateStore } from "./brain/NeuralStateStore";
import type { GenomeStore } from "./organisms/GenomeStore";
import type { MorphologyStore } from "./morphology/morphDevelopment";
import type { MorphologyReference, PhysicalPhenotypeStore } from "./morphology/physicalPhenotype";
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
  /**
   * Authoritative neural state (M16): memory registers and the hidden
   * activations carried between ticks. Hashed and serialized, unlike the
   * derived phenotype caches beside it — memory is history, not a function of
   * the genome.
   */
  readonly neural: NeuralStateStore;
  /** Derived morphological phenotype cache (M14). Not hashed, not serialized. */
  readonly morphology: MorphologyStore;
  /** Derived physical phenotype cache (M15). Not hashed, not serialized. */
  readonly physical: PhysicalPhenotypeStore;
  /**
   * The neutral point the physical phenotype is measured against (M15).
   *
   * A pure function of the config, built once with the context: the founder
   * body's physics is 1.0 by definition, and everything else is a difference
   * from it.
   */
  readonly morphologyReference: MorphologyReference;
  /** Authoritative carrion (docs/03 §23). */
  readonly carcasses: CarcassStore;
  /** Authoritative species registry and split-candidate state (docs/05 §5). */
  readonly species: SpeciesStore;
  /** Authoritative timeline event log (docs/05 §12). */
  readonly events: EventStore;
  /** Authoritative event-detector state (docs/02 §9). */
  readonly detectors: EventDetectors;
  /** Derived statistics time series — serialized, never hashed (docs/05 §11). */
  readonly stats: StatisticsStore;
  /** Derived trait normalization table, a pure function of the config. */
  readonly traitRanges: TraitRanges;
  /** Spatial index as of before movement; sensing reads it. */
  readonly spatialPre: SpatialGrid;
  /** Spatial index as of after movement; feeding and combat read it. */
  readonly spatialPost: SpatialGrid;
  /**
   * Spatial index over carcasses, rebuilt with `spatialPre` in phase 2.
   *
   * One index serves both the sensing phase and the feeding phase even though
   * they run either side of movement: a carcass never moves, and nothing creates
   * or removes one between phase 2 and phase 9. Carcasses created by phase 13
   * therefore first become sensible and edible on the following tick, which is
   * the same rule sensing already follows — an organism cannot react to
   * something that did not exist when it looked.
   */
  readonly carcassIndex: SpatialGrid;
  readonly scratch: EngineScratch;
  /**
   * The authoritative generator. Only phases that genuinely need randomness may
   * draw from it, and only inside a tick — advancing it anywhere else breaks
   * the determinism contract.
   */
  readonly rng: Xoshiro128;
}
