/**
 * Data transfer objects exchanged with the simulation Worker (docs/02 §§11-14).
 *
 * Everything here is plain serializable data: no class instances, no browser
 * types, no engine internals. A DTO is a *projection* of authoritative state
 * for display or inspection — receiving one can never let the main thread write
 * simulation state back.
 */

/**
 * Requested simulation speed (docs/02 §8).
 *
 * Speed is a *scheduling* choice and nothing else. It changes how many
 * authoritative ticks the host asks for per second of wall clock; it never
 * changes what a tick does. There is no `deltaTime` anywhere in the engine, so
 * a world run at 1× and the same world run at MAX produce byte-identical
 * state.
 */
export type SimulationSpeed = "paused" | "x1" | "x5" | "x20" | "x100" | "max";

export const SIMULATION_SPEEDS: readonly SimulationSpeed[] = [
  "paused",
  "x1",
  "x5",
  "x20",
  "x100",
  "max",
];

/** Speed multipliers relative to `HostRuntimeConfig.targetTicksPerSecond1x`. */
export const SPEED_MULTIPLIER: Readonly<Record<SimulationSpeed, number>> = Object.freeze({
  paused: 0,
  x1: 1,
  x5: 5,
  x20: 20,
  x100: 100,
  // MAX is "unpaced" (docs/02 §8): run as fast as the slice budget allows and
  // report the achieved rate, rather than aim at a number.
  max: Number.POSITIVE_INFINITY,
});

export function isSimulationSpeed(value: unknown): value is SimulationSpeed {
  return typeof value === "string" && (SIMULATION_SPEEDS as readonly string[]).includes(value);
}

/**
 * Target ticks per second for a speed, or `Infinity` for MAX.
 *
 * `targetTicksPerSecond1x` is host runtime configuration, never simulation
 * configuration — see `HostRuntimeConfig`.
 */
export function targetTicksPerSecond(speed: SimulationSpeed, targetAt1x: number): number {
  return SPEED_MULTIPLIER[speed] * targetAt1x;
}

/**
 * Non-authoritative display metadata for the loaded world (Milestone 7).
 *
 * Everything here is either a label list copied from engine constants or a
 * fixed quantization range for a byte-per-cell display field. The host fills it
 * from `@eon/engine` exports so the UI never needs an engine import, and none
 * of it can feed back into simulation state — it exists to caption numbers the
 * engine already produced.
 */
export interface WorldDisplayDto {
  /** Names of the brain sensor inputs, indexed like `EntityDetailsDto.brainInputs`. */
  brainInputLabels: readonly string[];
  /** Names of the brain intent outputs, indexed like `EntityDetailsDto.brainIntents`. */
  brainIntentLabels: readonly string[];
  /** Death cause names, indexed like `TelemetryDto.deathsByCause`. */
  deathCauseLabels: readonly string[];
  /** World event type names, indexed like `WorldEventDto.type` (Milestone 8). */
  eventTypeLabels: readonly string[];
  /** Event severity names, indexed like `WorldEventDto.severity` (Milestone 8). */
  eventSeverityLabels: readonly string[];
  /** Species end-reason names, indexed like `SpeciesSummaryDto.endReason` (Milestone 8). */
  speciesEndReasonLabels: readonly string[];
  /** Trait dimension names, indexed like `SpeciesDetailsDto.centroidTraits` (Milestone 8). */
  traitDimensionLabels: readonly string[];
  /** Temperature that byte 0 of the terrain temperature plane represents. */
  temperatureDisplayMinC: number;
  /** Temperature that byte 255 of the terrain temperature plane represents. */
  temperatureDisplayMaxC: number;
  /** Plant units that byte 255 of the terrain capacity plane represents. */
  capacityDisplayReference: number;
}

/** Identity of the world currently loaded in the Worker. */
export interface WorldSummaryDto {
  seed: number;
  /** `0x`-prefixed uppercase seed, which is how worlds are named in the UI. */
  seedHex: string;
  engineVersion: string;
  protocolVersion: number;
  configSchemaVersion: number;
  snapshotSchemaVersion: number;
  /** Canonical digest of the authoritative config this world runs on. */
  configHash: string;
  /** World edge length in location units. */
  worldSizeLU: number;
  /** Environment grid edge length in cells. */
  gridSize: number;
  /** Location units per environment cell. */
  cellSizeLU: number;
  /** Which world-generation attempt produced this world; 0 means the seed worked directly. */
  generationAttempt: number;
  /** Population cap; the render snapshot is sized for it. */
  maxOrganisms: number;
  maxCarcasses: number;
  /** Centre of the founder spawn region, in location units. */
  founderCentreXLU: number;
  founderCentreYLU: number;
  /** Labels and legend ranges; see {@link WorldDisplayDto}. */
  display: WorldDisplayDto;
}

/**
 * Mean trait values over the *alive* population (Milestone 7 charts).
 *
 * A fixed handful of scalars, computed in the engine's single telemetry pass
 * and streamed at telemetry cadence — this is what lets the charts show trait
 * drift without ever shipping a per-organism array (CLAUDE.md React boundary).
 * All values are in the same human units as `EntityDetailsDto`. When the
 * population is zero every mean is 0 and the UI is expected to show a gap.
 */
export interface TraitMeansDto {
  /** Mean signed diet in [-1, 1]: -1 herbivore, +1 carnivore. */
  diet: number;
  /** Mean genetic top speed in location units per tick. */
  maxSpeedLUPerTick: number;
  /** Mean adult body radius in location units. */
  adultRadiusLU: number;
  /** Mean vision range in location units. */
  visionRangeLU: number;
  /** Mean attack investment in [0, 1]. */
  attack: number;
  /** Mean armor investment in [0, 1]. */
  armor: number;
  /** Mean metabolic pace in [0, 1]. */
  metabolicPace: number;
  /** Mean thermal optimum in °C. */
  thermalOptimumC: number;
}

/**
 * Low-frequency world state for the HUD (docs/02 §11).
 *
 * This is the *only* per-world number stream React is allowed to hold, and it
 * is deliberately a fixed handful of scalars: no per-organism data of any kind
 * reaches React state (CLAUDE.md React boundary).
 */
export interface TelemetryDto {
  tick: number;
  population: number;
  totalBirths: number;
  totalDeaths: number;
  /** Births refused because the population cap was full — an ecology-distortion warning. */
  capRejectedBirths: number;
  /** Cumulative deaths indexed by the engine's `DeathCause`. */
  deathsByCause: readonly number[];
  carcassCount: number;
  /** Total plant biomass in the world, in plant units. */
  plantBiomass: number;
  plantCapacity: number;
  /** Highest generation number alive right now; 0 when the world is empty. */
  maxGeneration: number;
  /** Total body mass of the alive population, in engine mass units. */
  organismMass: number;
  /** Mean energy as a fraction of each body's capacity, in [0, 1]. */
  meanEnergyFraction: number;
  /** Mean trait values over the alive population; see {@link TraitMeansDto}. */
  traitMeans: TraitMeansDto;

  // --- Species and history (Milestone 8) --------------------------------------
  /** Species with living members right now. */
  activeSpeciesCount: number;
  /** Species ever recorded, including split and extinct ones. */
  totalSpeciesCount: number;
  /** Species that ended by extinction (a split parent is not extinct). */
  extinctSpeciesCount: number;
  /**
   * ID of the newest world event, 0 before any event. The UI compares this
   * against the newest event it has and pulls the difference with
   * REQUEST_HISTORY_RANGE — telemetry is the change signal, so no separate
   * event push stream exists.
   */
  latestEventId: number;

  // --- Host pacing, measured on the wall clock outside the engine -----------
  speed: SimulationSpeed;
  /** Ticks actually executed per second of wall clock, measured by the host. */
  achievedTicksPerSecond: number;
  /** What the current speed asks for; `null` at MAX, which is unpaced. */
  targetTicksPerSecond: number | null;
  /** True when the host cannot keep up with the requested speed. */
  behindTarget: boolean;

  // --- Render transport health ---------------------------------------------
  renderBuffersInFlight: number;
  /** Snapshots skipped because every pooled buffer was still with the renderer. */
  droppedRenderSnapshots: number;

  /**
   * Mean milliseconds per authoritative tick phase over the last telemetry
   * window, indexed by `TickPhase` (CLAUDE.md "Profiling"). Empty when nothing
   * ran in the window.
   */
  phaseMillis: readonly number[];
}

/**
 * One organism's inspectable state (docs/06 §11), fetched on demand.
 *
 * Sent for a single entity in response to a QUERY_ENTITY, never streamed. The
 * genome appears here as *derived phenotype numbers in human units*, not as raw
 * gene words, and the brain is deliberately absent: a full network dump per
 * query is Milestone 7 inspector work.
 */
export interface EntityDetailsDto {
  entityId: number;
  speciesId: number;
  generation: number;
  parentEntityId: number;
  ageTicks: number;

  /** Position in location units. */
  xLU: number;
  yLU: number;
  /** Heading in radians, for display. */
  headingRadians: number;
  /** Current speed in location units per tick. */
  speedLUPerTick: number;

  energy: number;
  maxEnergy: number;
  /** Health as a fraction in [0, 1]. */
  health: number;
  /** Realized development in [0, 1]; below 1 means juvenile. */
  development: number;
  radiusLU: number;
  mass: number;

  /** Signed diet in [-1, 1]: -1 herbivore specialist, +1 carnivore specialist. */
  diet: number;
  maxSpeedLUPerTick: number;
  visionRangeLU: number;
  visionFovDegrees: number;
  attack: number;
  armor: number;
  metabolicPace: number;
  thermalOptimumC: number;
  thermalToleranceC: number;
  maturityAgeTicks: number;
  maxAgeTicks: number;
  hueDegrees: number;
  /** Ticks until this organism may reproduce again; 0 means ready. */
  reproductionCooldownTicks: number;

  // --- Current running costs (docs/06 §11), derived read-only ----------------
  /** Basal upkeep in energy units per tick, thermal multiplier included. */
  costBasalPerTick: number;
  /** Movement cost of the most recent tick's realized effort. */
  costMovementPerTick: number;
  /**
   * Thermal stress as a fraction of the engine's capped worst case, in [0, 1].
   * Below 0.5 stress only raises the basal cost; above 0.5 the organism also
   * takes health damage (the engine's severe-stress threshold).
   */
  thermalStress: number;

  // --- Brain, debug-style (docs/06 §11) --------------------------------------
  /**
   * Sensor inputs the brain saw on the most recent tick, in [-1, 1], indexed
   * like `WorldDisplayDto.brainInputLabels`. All zero before the first tick.
   */
  brainInputs: readonly number[];
  /**
   * Intent levels the brain produced on the most recent tick, indexed like
   * `WorldDisplayDto.brainIntentLabels`. Turn is signed in [-1, 1] (negative
   * left); the rest are in [0, 1].
   */
  brainIntents: readonly number[];

  /** Lifetime energy actually digested, by source. */
  plantEnergyEaten: number;
  meatEnergyEaten: number;
  kills: number;

  /** Environment under the organism right now. */
  biome: number;
  biomeName: string;
  cellTemperatureC: number;
  cellPlantBiomass: number;
}

/** Everything a fatal or non-fatal worker failure must report (docs/02 §19). */
export interface WorkerErrorDto {
  message: string;
  /** True when the simulation stopped and cannot continue. */
  fatal: boolean;
  /** Tick at which the failure was noticed, or `null` before a world exists. */
  tick: number | null;
  seed: number | null;
  engineVersion: string;
  /** Message type being handled when it failed, when known. */
  whileHandling: string | null;
}

// --- Species and history (Milestone 8, protocol 4) ---------------------------

/**
 * One species row for the Tree of Life and species lists (docs/06 §§12, 14,
 * docs/05 §19). Sent inside {@link TreeSnapshotDto}; the inspector's fuller
 * view is {@link SpeciesDetailsDto}.
 */
export interface SpeciesSummaryDto {
  id: number;
  /** 0 for the founder species; always smaller than `id` (the tree is acyclic). */
  parentSpeciesId: number;
  originTick: number;
  /** 0 while the species is active. */
  endTick: number;
  /** Index into `WorldDisplayDto.speciesEndReasonLabels`. */
  endReason: number;
  population: number;
  /** Lifetime observed intake, for the dominant-diet display (docs/06 §19). */
  plantEnergyConsumed: number;
  meatEnergyConsumed: number;
  /** Permanent badge: this lineage was detected living on meat (docs/05 §15). */
  carnivoreDetected: boolean;
  /** Signed diet position of the current centroid, in [-1, 1]. */
  centroidDiet: number;
}

/** Everything the species inspector shows (docs/06 §12). */
export interface SpeciesDetailsDto extends SpeciesSummaryDto {
  founderEntityId: number;
  generationAtOrigin: number;
  totalBirths: number;
  totalDeaths: number;
  totalKills: number;
  /**
   * Current mean member phenotype, one normalized [0, 1] value per trait
   * dimension, indexed like `WorldDisplayDto.traitDimensionLabels`.
   */
  centroidTraits: readonly number[];
  /** The same vector frozen at the species' origin, for drift display. */
  originCentroid: readonly number[];
  /** Split-candidate progress: consecutive qualifying analyses so far. */
  candidatePasses: number;
  /** Analyses a candidate must survive before a split executes. */
  stabilityIntervalsRequired: number;
  /** Daughter species IDs, ascending; empty unless this species split. */
  childIds: readonly number[];
  /** Mean age of living members in ticks; 0 when extinct. */
  meanAgeTicks: number;
  /** Mean energy as a fraction of body capacity, in [0, 1]; 0 when extinct. */
  meanEnergyFraction: number;
  /** Recent engine-side samples (docs/06 §15), oldest first, aligned by index. */
  series: {
    ticks: readonly number[];
    population: readonly number[];
    /** Mean normalized adult size, [0, 1]. */
    meanSize: readonly number[];
    /** Mean normalized effective speed, [0, 1]. */
    meanSpeed: readonly number[];
    /** Mean signed diet, [-1, 1]. */
    meanDiet: readonly number[];
  };
}

/** The whole registry at one tick, for the Tree of Life (docs/05 §19). */
export interface TreeSnapshotDto {
  tick: number;
  /** Every species ever, ascending ID — parents always precede children. */
  species: readonly SpeciesSummaryDto[];
}

/** One timeline event (docs/05 §12), numeric payload documented per type. */
export interface WorldEventDto {
  id: number;
  tick: number;
  /** Index into `WorldDisplayDto.eventTypeLabels`. */
  type: number;
  /** Index into `WorldDisplayDto.eventSeverityLabels`. */
  severity: number;
  speciesIds: readonly number[];
  entityIds: readonly number[];
  /** Event location in location units, or `null` for world-wide events. */
  region: { xLU: number; yLU: number; radiusLU: number } | null;
  payloadVersion: number;
  payload: readonly number[];
}

/**
 * Timeline backfill (docs/06 §13): every retained event newer than the
 * caller's `sinceEventId`, plus the long-horizon world series that backs the
 * timeline. `droppedEventCount` > 0 means the far past scrolled out of the
 * engine's bounded log (persistence will chunk it out in Milestone 10).
 */
export interface HistorySliceDto {
  tick: number;
  droppedEventCount: number;
  events: readonly WorldEventDto[];
  worldSeries: {
    ticks: readonly number[];
    population: readonly number[];
    activeSpecies: readonly number[];
  };
}
