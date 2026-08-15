/**
 * Approximate engine memory accounting (task L03, docs/07 §11).
 *
 * ## What this is for
 *
 * docs/07 §11 asks for approximate bytes of organism state, brains, the
 * environment, carcasses, species, render buffers, queued snapshots and
 * chart/event history, and for a watch on unbounded growth. This module answers
 * the engine's share of that question; the host answers for render buffers and
 * queued snapshots, and the UI answers for chart history, because those live
 * outside the engine and the engine cannot see them.
 *
 * ## Why it is safe
 *
 * It reads `byteLength` off buffers that already exist and returns a plain
 * object. It allocates nothing large, touches no PRNG, reads no clock and never
 * writes. Calling it between ticks cannot change a state hash, and a test
 * asserts exactly that.
 *
 * ## Exact where it can be, modelled where it cannot
 *
 * Everything held as a TypedArray is reported exactly from `byteLength` — that
 * is the great majority of the engine's footprint, and it is the part that
 * scales with population and world size. Species records, timeline events and
 * the command log are ordinary JS objects whose true cost is an engine
 * implementation detail, so those are modelled from the constants below and
 * labelled `modelled` in the report. The point of the number is to answer "is
 * this growing without bound, and is it megabytes or gigabytes", not to match a
 * heap snapshot byte for byte.
 */
import type { SimulationEngine } from "../SimulationEngine";
import { engineInternals } from "../internal";

/**
 * Bytes charged to one ordinary JS object.
 *
 * A V8 object on a 64-bit build carries a map (hidden class) pointer, a
 * properties backing-store pointer and an elements backing-store pointer, then
 * its in-object fields. 32 bytes covers the header; fields are counted
 * separately at {@link JS_FIELD_BYTES}.
 */
const JS_OBJECT_OVERHEAD_BYTES = 32;

/** Bytes charged to one tagged field or JS-array element (a 64-bit slot). */
const JS_FIELD_BYTES = 8;

/**
 * Fields on a `SpeciesRecord`, excluding the two `Int32Array` centroids, which
 * are measured exactly. Counted from the interface in `evolution/SpeciesStore`:
 * id, parentSpeciesId, originTick, endTick, endReason, population,
 * founderEntityId, generationAtOrigin, totalBirths, totalDeaths, totalKills,
 * plantEnergyConsumed, meatEnergyConsumed, candidate, carnivoreDetected,
 * carnivoreStreak, prevPlantConsumedSample, prevMeatConsumedSample.
 */
const SPECIES_RECORD_SCALAR_FIELDS = 18;

/**
 * Fields on a `WorldEventRecord` excluding its three array-valued ones
 * (speciesIds, entityIds, payload), which are measured from their lengths:
 * id, tick, type, severity, regionXPos, regionYPos, regionRadiusPos,
 * payloadVersion.
 */
const EVENT_RECORD_SCALAR_FIELDS = 8;

/**
 * Fields charged to one command before its brush samples.
 *
 * Commands are a discriminated union of different widths; this is the common
 * identity-and-header part (id, tick, sequence, kind, schemaVersion) plus a
 * generous allowance for the kind-specific scalars, which top out around ten.
 */
const COMMAND_SCALAR_FIELDS = 16;

/** Sum the `byteLength` of any number of typed-array views. */
function viewBytes(...views: readonly ArrayBufferView[]): number {
  let total = 0;
  for (const view of views) {
    total += view.byteLength;
  }
  return total;
}

/**
 * Sum every typed array reachable as an own enumerable property of `store`.
 *
 * The SoA stores declare each column as a public `readonly` field, so walking
 * them is both complete and drift-proof: a column added in a later milestone is
 * accounted for without anyone remembering to update this file. Fields that are
 * not typed arrays are skipped, and private (`#`) state is invisible here by
 * construction — the two stores that keep buffers privately report their own
 * size instead.
 *
 * Each column is its own allocation in this codebase, so no buffer is counted
 * twice.
 */
function ownViewBytes(store: object): number {
  let total = 0;
  for (const value of Object.values(store)) {
    if (ArrayBuffer.isView(value)) {
      total += value.byteLength;
    }
  }
  return total;
}

/** Bytes charged to a JS object with `fields` tagged fields. */
function objectBytes(fields: number): number {
  return JS_OBJECT_OVERHEAD_BYTES + fields * JS_FIELD_BYTES;
}

/** Bytes charged to a JS array of `length` tagged elements. */
function arrayBytes(length: number): number {
  return JS_OBJECT_OVERHEAD_BYTES + length * JS_FIELD_BYTES;
}

/**
 * Per-category byte totals. Every field is an approximation in the sense
 * documented above: typed-array categories are exact, `species`, `events` and
 * `commands` are modelled.
 */
export interface EngineMemoryReport {
  /** Live organism SoA columns, including the free list and death counters. */
  organismState: number;
  /** Gene words for every slot (`GenomeStore.genes`). */
  genes: number;
  /** Brain weights for every slot — the largest single allocation at MVP sizes. */
  brains: number;
  /** Derived per-organism phenotype cache. */
  phenotypes: number;
  /** Environment grid: elevation, moisture, temperature, biome, plants, passability. */
  environment: number;
  /** Carcass SoA columns. */
  carcasses: number;
  /** Both organism spatial grids plus the carcass index. */
  spatialIndex: number;
  /** Reusable per-tick working memory (sensors, intents, claims, buffers). */
  scratch: number;
  /** Species registry records and their centroids (modelled). */
  species: number;
  /** In-memory timeline events (modelled). */
  events: number;
  /** Statistics tiers and species series buffers. */
  statistics: number;
  /** Accepted player commands, including brush sample arrays (modelled). */
  commands: number;
  /** Sum of every category above. */
  total: number;
}

/**
 * Shape and occupancy context, so a byte total can be read against what the
 * world actually holds rather than in isolation.
 */
export interface EngineMemoryContext {
  organismCapacity: number;
  liveOrganisms: number;
  carcassCapacity: number;
  liveCarcasses: number;
  environmentCells: number;
  speciesRecords: number;
  retainedEvents: number;
  commandCount: number;
  /**
   * Bytes charged to one organism slot: the four strictly per-organism stores
   * (state, genes, brains, phenotypes) divided by the cap. This is the number
   * that says what raising `limits.maxOrganisms` costs.
   *
   * The spatial index and the scratch buffers are deliberately excluded: both
   * mix per-slot columns with world-sized ones (grid heads, per-cell demand),
   * so charging them to a slot would make the figure depend on world size.
   * `organismState` carries one fixed allocation of its own — the death-cause
   * histogram, a few dozen bytes — which is the only inexactness here.
   */
  bytesPerOrganismSlot: number;
}

export interface EngineMemoryEstimate {
  bytes: EngineMemoryReport;
  context: EngineMemoryContext;
}

/**
 * Estimate the engine's resident memory.
 *
 * Diagnostic only. Nothing authoritative may read the result: it is a
 * host-visible number derived from allocation sizes, and feeding it back into a
 * rule would make behaviour depend on the storage layout rather than on the
 * simulation.
 */
export function estimateEngineMemory(engine: SimulationEngine): EngineMemoryEstimate {
  const { context } = engineInternals(engine);
  const { organisms, genomes, carcasses, environment, scratch, phenotypes } = context;

  const organismState = ownViewBytes(organisms);
  const carcassBytes = ownViewBytes(carcasses);
  const environmentBytes = ownViewBytes(environment);
  const spatialIndex =
    ownViewBytes(context.spatialPre) +
    ownViewBytes(context.spatialPost) +
    ownViewBytes(context.carcassIndex);

  let speciesBytes = arrayBytes(engine.species.count);
  for (const record of engine.species.records) {
    speciesBytes += objectBytes(SPECIES_RECORD_SCALAR_FIELDS);
    speciesBytes += viewBytes(record.centroidTraits, record.originCentroid);
    if (record.candidate !== null) {
      // passes + two centroid references.
      speciesBytes += objectBytes(3);
      speciesBytes += viewBytes(record.candidate.centroidA, record.candidate.centroidB);
    }
  }

  let eventBytes = arrayBytes(engine.events.events.length);
  for (const event of engine.events.events) {
    eventBytes += objectBytes(EVENT_RECORD_SCALAR_FIELDS + 3);
    eventBytes +=
      arrayBytes(event.speciesIds.length) +
      arrayBytes(event.entityIds.length) +
      arrayBytes(event.payload.length);
  }

  let commandBytes = arrayBytes(engine.commands.length);
  for (let i = 0; i < engine.commands.length; i += 1) {
    const command = engine.commands.at(i) as { samplesXLU?: readonly number[] };
    commandBytes += objectBytes(COMMAND_SCALAR_FIELDS);
    const samples = command.samplesXLU;
    if (samples !== undefined) {
      // A brush carries two parallel sample arrays of equal length.
      commandBytes += 2 * arrayBytes(samples.length);
    }
  }

  const bytes: EngineMemoryReport = {
    organismState,
    genes: viewBytes(genomes.genes),
    brains: viewBytes(genomes.brainWeights),
    phenotypes: ownViewBytes(phenotypes),
    environment: environmentBytes,
    carcasses: carcassBytes,
    spatialIndex,
    scratch: ownViewBytes(scratch),
    species: speciesBytes,
    events: eventBytes,
    statistics: engine.stats.approximateBytes(),
    commands: commandBytes,
    total: 0,
  };
  bytes.total =
    bytes.organismState +
    bytes.genes +
    bytes.brains +
    bytes.phenotypes +
    bytes.environment +
    bytes.carcasses +
    bytes.spatialIndex +
    bytes.scratch +
    bytes.species +
    bytes.events +
    bytes.statistics +
    bytes.commands;

  const capacity = organisms.capacity;
  const perSlot = bytes.organismState + bytes.genes + bytes.brains + bytes.phenotypes;

  return {
    bytes,
    context: {
      organismCapacity: capacity,
      liveOrganisms: organisms.liveCount,
      carcassCapacity: carcasses.capacity,
      liveCarcasses: carcasses.liveCount,
      environmentCells: environment.cellCount,
      speciesRecords: engine.species.count,
      retainedEvents: engine.events.events.length,
      commandCount: engine.commands.length,
      bytesPerOrganismSlot: capacity > 0 ? perSlot / capacity : 0,
    },
  };
}

/**
 * The report's categories as `[name, bytes]` pairs, largest first, without the
 * total.
 *
 * One typed place to turn the report into a list, so every consumer — the
 * benchmark CLI, the Worker's telemetry, the performance HUD — orders and names
 * the categories identically, and a category added here appears in all three
 * without any of them being edited.
 */
export function memoryCategories(report: EngineMemoryReport): [string, number][] {
  const entries: [string, number][] = [];
  for (const name of Object.keys(report) as (keyof EngineMemoryReport)[]) {
    if (name !== "total") {
      entries.push([name, report[name]]);
    }
  }
  entries.sort((a, b) => b[1] - a[1]);
  return entries;
}

/** Human-readable byte size, for CLI and overlay output only. */
export function formatBytes(bytes: number): string {
  const KIB = 1024;
  const MIB = KIB * 1024;
  const GIB = MIB * 1024;
  if (bytes < KIB) return `${bytes} B`;
  if (bytes < MIB) return `${(bytes / KIB).toFixed(1)} KiB`;
  if (bytes < GIB) return `${(bytes / MIB).toFixed(2)} MiB`;
  return `${(bytes / GIB).toFixed(2)} GiB`;
}
