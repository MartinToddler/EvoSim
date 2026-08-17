/**
 * The shape contract for a decoded engine snapshot.
 *
 * ## Why this exists
 *
 * `valueCodec` restores *whatever graph was written*. That is exactly what a
 * lossless container should do, and exactly what must not be handed to the
 * engine unchecked: a payload that is missing `organisms.alive` would not fail
 * with "this save is damaged" but with `TypeError: cannot read length of
 * undefined`, thrown from inside a restore routine, halfway through mutating a
 * live store. Docs/06 §27 requires a load to validate array lengths and shape
 * *before* trusting the payload, and this table is that check.
 *
 * The walker also **rebuilds** every object as an ordinary plain object with
 * only the declared keys. Two things fall out of that: the null-prototype
 * records the decoder produces never reach engine code, and an unknown extra
 * field cannot ride along into a future engine version that would suddenly
 * start reading it.
 *
 * ## The completeness contract
 *
 * The table below is the durable format's promise about which authoritative
 * state survives a save. `snapshotShape.test.ts` walks a real
 * `engine.serialize()` and fails if the engine produces a field this table does
 * not describe — so the next milestone that adds authoritative state cannot
 * quietly add it to the engine and forget the file format. That test is the
 * enforcement mechanism behind "audit everything that can affect the future".
 *
 * Depth stops where the engine's own validators take over: `config` (validated
 * by `validateConfig`), the command list (validated field by field in
 * `CommandLog.restore`) and the event list (validated in `EventStore.restore`)
 * are checked here only for being JSON-safe data, because re-implementing their
 * rules would create a second, drifting copy of them.
 */

/** Leaf and container kinds a snapshot field may take. */
export type FieldSpec =
  | { kind: "number" }
  | { kind: "string" }
  /** Fixed-length plain array of numbers (the PRNG state tuple). */
  | { kind: "numberTuple"; length: number }
  | { kind: "typedArray"; of: TypedArrayName }
  /** Arbitrary JSON-safe data; the engine's own restore validator owns it. */
  | { kind: "json" }
  | { kind: "object"; fields: Readonly<Record<string, FieldSpec>> }
  | { kind: "arrayOf"; element: FieldSpec };

export type TypedArrayName = "u8" | "i8" | "u16" | "i16" | "u32" | "i32" | "f32" | "f64";

const TYPED_ARRAY_CONSTRUCTORS: Readonly<
  Record<TypedArrayName, new (length: number) => ArrayBufferView & { length: number }>
> = {
  u8: Uint8Array,
  i8: Int8Array,
  u16: Uint16Array,
  i16: Int16Array,
  u32: Uint32Array,
  i32: Int32Array,
  f32: Float32Array,
  f64: Float64Array,
};

const number: FieldSpec = { kind: "number" };
const json: FieldSpec = { kind: "json" };
const typed = (of: TypedArrayName): FieldSpec => ({ kind: "typedArray", of });
const object = (fields: Readonly<Record<string, FieldSpec>>): FieldSpec => ({
  kind: "object",
  fields,
});
const arrayOf = (element: FieldSpec): FieldSpec => ({ kind: "arrayOf", element });

/** Per-slot organism arrays, in the order `organismSnapshot.ts` captures them. */
const ORGANISM_FIELDS: Readonly<Record<string, FieldSpec>> = {
  capacity: number,
  slotHighWater: number,
  freeSlots: typed("i32"),
  nextEntityId: number,
  totalBirths: number,
  totalDeaths: number,
  capRejectedBirths: number,
  birthEnergyDiscarded: number,
  deathsByCause: typed("u32"),

  alive: typed("u8"),
  entityId: typed("u32"),
  parentEntityId: typed("u32"),
  generation: typed("u32"),
  speciesId: typed("u32"),
  x: typed("i32"),
  y: typed("i32"),
  posFracX: typed("u8"),
  posFracY: typed("u8"),
  vx: typed("i32"),
  vy: typed("i32"),
  angle: typed("u16"),
  energy: typed("i32"),
  healthQ: typed("u16"),
  ageTicks: typed("u32"),
  developmentQ: typed("u16"),
  waterTicks: typed("u16"),
  lastDamageQ: typed("u16"),
  attackCooldown: typed("u16"),
  reproductionCooldown: typed("u16"),
  plantEnergyEaten: typed("u32"),
  meatEnergyEaten: typed("u32"),
  kills: typed("u16"),

  genes: typed("u16"),
  morphGenes: typed("u16"),
  topology: typed("u16"),
  brainWeights: typed("i16"),
  hiddenPrevQ: typed("i16"),
  memoryQ: typed("i16"),
};

const CARCASS_FIELDS: Readonly<Record<string, FieldSpec>> = {
  capacity: number,
  slotHighWater: number,
  freeSlots: typed("i32"),
  totalCreated: number,
  skippedAtCap: number,
  totalMeatCreated: number,
  totalMeatEaten: number,
  totalMeatDecayed: number,

  active: typed("u8"),
  entityId: typed("u32"),
  x: typed("i32"),
  y: typed("i32"),
  remainingMeat: typed("u32"),
  sourceSpeciesId: typed("u32"),
  ageTicks: typed("u32"),
};

const ENVIRONMENT_FIELDS: Readonly<Record<string, FieldSpec>> = {
  size: number,
  cellSizeLU: number,
  globalTemperatureOffsetCentiC: number,
  elevationQ: typed("u16"),
  baseMoistureQ: typed("u16"),
  moistureOffsetQ: typed("i16"),
  fertilityQ: typed("u16"),
  baseTemperatureCentiC: typed("i16"),
  temperatureOffsetCentiC: typed("i16"),
  biome: typed("u8"),
  plantBiomass: typed("u16"),
  plantCapacity: typed("u16"),
  plantGrowthRemainderQ: typed("u16"),
  founderRegion: object({
    centerCellIndex: number,
    centerGridX: number,
    centerGridY: number,
    componentCells: number,
  }),
};

const SPECIES_RECORD_FIELDS: Readonly<Record<string, FieldSpec>> = {
  id: number,
  parentSpeciesId: number,
  originTick: number,
  endTick: number,
  endReason: number,
  population: number,
  centroidTraits: typed("i32"),
  originCentroid: typed("i32"),
  founderEntityId: number,
  generationAtOrigin: number,
  totalBirths: number,
  totalDeaths: number,
  totalKills: number,
  plantEnergyConsumed: number,
  meatEnergyConsumed: number,
  candidatePasses: number,
  candidateCentroidA: typed("i32"),
  candidateCentroidB: typed("i32"),
  carnivoreDetected: number,
  carnivoreStreak: number,
  prevPlantConsumedSample: number,
  prevMeatConsumedSample: number,
};

const DETECTOR_FIELDS: Readonly<Record<string, FieldSpec>> = {
  sampleCount: number,
  prevTotalBirths: number,
  prevTotalDeaths: number,
  prevCombatDeaths: number,
  prevPlantEnergyConsumed: number,
  prevMeatEnergyConsumed: number,
  populationRing: typed("f64"),
  lastBoomCrashSample: number,
  activeSpeciesRing: typed("f64"),
  extinctSpeciesRing: typed("f64"),
  lastMassExtinctionSample: number,
  lastCapRejectedBirths: number,
  capEventActive: number,
  firstPredationRecorded: number,
};

const STATISTICS_FIELDS: Readonly<Record<string, FieldSpec>> = {
  worldSampleCount: number,
  tiers: arrayOf(object({ values: typed("f64"), ticks: typed("f64"), length: number })),
  speciesSeries: arrayOf(
    object({
      speciesId: number,
      ticks: typed("f64"),
      values: typed("f64"),
      length: number,
      start: number,
    }),
  ),
};

/** The complete durable shape of `EngineCoreSnapshot`. */
export const SNAPSHOT_SHAPE: Extract<FieldSpec, { kind: "object" }> = object({
  schemaVersion: number,
  engineVersion: { kind: "string" },
  seed: number,
  tick: number,
  generationAttempt: number,
  rngState: { kind: "numberTuple", length: 4 },
  // Validated in depth by `validateConfig` on the restore path.
  config: json,
  environment: object(ENVIRONMENT_FIELDS),
  organisms: object(ORGANISM_FIELDS),
  carcasses: object(CARCASS_FIELDS),
  species: object({ nextSpeciesId: number, records: arrayOf(object(SPECIES_RECORD_FIELDS)) }),
  history: object({
    // Event records are validated by `EventStore.restore`.
    events: object({ nextEventId: number, droppedEventCount: number, events: json }),
    detectors: object(DETECTOR_FIELDS),
    stats: object(STATISTICS_FIELDS),
  }),
  // Command records are validated by `CommandLog.restore`, which owns the
  // per-kind payload rules and the (tick, sequence) ordering invariant.
  commands: object({
    nextCommandId: number,
    nextSequence: number,
    cursor: number,
    commands: json,
  }),
}) as Extract<FieldSpec, { kind: "object" }>;

/** Thrown when a decoded payload does not match {@link SNAPSHOT_SHAPE}. */
export class SnapshotShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotShapeError";
  }
}

/**
 * Validate a decoded value against the shape and return a normalized copy.
 *
 * The result contains only declared fields, on ordinary prototypes, with typed
 * arrays of exactly the declared classes. The caller casts it to
 * `EngineCoreSnapshot`; this function is what makes that cast honest.
 */
export function normalizeSnapshotShape(value: unknown): unknown {
  return walk(value, SNAPSHOT_SHAPE, "$");
}

function walk(value: unknown, spec: FieldSpec, path: string): unknown {
  switch (spec.kind) {
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new SnapshotShapeError(`${path} must be a finite number, got ${describe(value)}`);
      }
      return value;
    case "string":
      if (typeof value !== "string") {
        throw new SnapshotShapeError(`${path} must be a string, got ${describe(value)}`);
      }
      return value;
    case "numberTuple": {
      if (!Array.isArray(value) || value.length !== spec.length) {
        throw new SnapshotShapeError(
          `${path} must be an array of ${spec.length} numbers, got ${describe(value)}`,
        );
      }
      return value.map((entry, index) => walk(entry, { kind: "number" }, `${path}[${index}]`));
    }
    case "typedArray": {
      const Constructor = TYPED_ARRAY_CONSTRUCTORS[spec.of];
      if (!(value instanceof Constructor)) {
        throw new SnapshotShapeError(
          `${path} must be a ${Constructor.name}, got ${describe(value)}`,
        );
      }
      return value;
    }
    case "json":
      return normalizeJson(value, path, 0);
    case "arrayOf": {
      if (!Array.isArray(value)) {
        throw new SnapshotShapeError(`${path} must be an array, got ${describe(value)}`);
      }
      return value.map((entry, index) => walk(entry, spec.element, `${path}[${index}]`));
    }
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new SnapshotShapeError(`${path} must be an object, got ${describe(value)}`);
      }
      const source = value as Record<string, unknown>;
      const result: Record<string, unknown> = {};
      for (const [key, fieldSpec] of Object.entries(spec.fields)) {
        if (!(key in source)) {
          throw new SnapshotShapeError(`${path}.${key} is missing from the snapshot`);
        }
        result[key] = walk(source[key], fieldSpec, `${path}.${key}`);
      }
      return result;
    }
  }
}

/** Depth limit for the free-form regions, mirroring the codec's own limit. */
const MAX_JSON_DEPTH = 16;

/**
 * Copy a JSON-safe subtree onto ordinary prototypes, rejecting anything a
 * `JSON.parse` result could not contain — typed arrays included, because a
 * field declared free-form is one the engine reads as plain JSON.
 */
function normalizeJson(value: unknown, path: string, depth: number): unknown {
  if (depth > MAX_JSON_DEPTH) {
    throw new SnapshotShapeError(`${path} nests deeper than ${MAX_JSON_DEPTH} levels`);
  }
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new SnapshotShapeError(`${path} must be a finite number, got ${describe(value)}`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => normalizeJson(entry, `${path}[${index}]`, depth + 1));
  }
  if (typeof value === "object" && !ArrayBuffer.isView(value)) {
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(source)) {
      result[key] = normalizeJson(source[key], `${path}.${key}`, depth + 1);
    }
    return result;
  }
  throw new SnapshotShapeError(`${path} is not JSON-safe data (${describe(value)})`);
}

function describe(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (ArrayBuffer.isView(value)) {
    return value.constructor.name;
  }
  if (Array.isArray(value)) {
    return `array(${value.length})`;
  }
  return typeof value;
}
