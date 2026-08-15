import type { DeepReadonly } from "@eon/shared";
import type { SimulationConfig } from "../config/SimulationConfig";

/**
 * Canonical player commands (task J01, docs/01 §4, docs/02 §§15–16).
 *
 * A command is the ONLY way player input reaches authoritative state. The UI
 * never touches an engine array; it describes an intent, the intent becomes an
 * immutable versioned command, and the engine applies it at a tick boundary
 * (phase 0 of docs/03 §7). Same seed + config + canonical command stream ⇒
 * identical state, which is what makes saves, replay and branching possible.
 *
 * ## Identity
 *
 * Every accepted command carries `(schemaVersion, id, tick, sequence)`:
 *
 * - `id` — engine-assigned, monotonic from 1 in ACCEPTANCE order, never reused;
 * - `tick` — the tick whose phase 0 applies it;
 * - `sequence` — engine-assigned, globally monotonic in acceptance order.
 *
 * The application order is `(tick, sequence)` lexicographic. Sequence — not
 * arrival — breaks ties inside a tick, and because the engine assigns both
 * numbers itself at acceptance, no two commands can ever share a `(tick,
 * sequence)` pair and no ordering ambiguity can exist in a recorded log.
 *
 * ## Quantization
 *
 * Every payload field is an integer in engine units: whole LU for geometry,
 * centi-°C for temperature, Q fractions for normalized fields, biomass units
 * for biomass. Pointer floats die at the UI/protocol boundary (docs/02 §16);
 * nothing fractional ever enters the log.
 */

/** Version of the command payload contract. Stored, hashed and serialized. */
export const COMMAND_SCHEMA_VERSION = 1;

/**
 * The intervention vocabulary (docs/02 §15). Numbering is a storage contract:
 * it is hashed, serialized and used as the event-payload discriminant.
 */
export const InterventionKind = {
  SetGlobalTemperature: 0,
  PaintTemperature: 1,
  PaintMoisture: 2,
  PaintFertility: 3,
  RaiseTerrain: 4,
  LowerTerrain: 5,
  AddBiomass: 6,
  RemoveBiomass: 7,
  Meteor: 8,
} as const;

export type InterventionKind = (typeof InterventionKind)[keyof typeof InterventionKind];

export const INTERVENTION_KIND_COUNT = 9;

/** Wire names from docs/02 §15, indexed by kind. */
export const COMMAND_TYPE_NAMES: readonly string[] = [
  "SET_GLOBAL_TEMPERATURE_OFFSET",
  "PAINT_TEMPERATURE",
  "PAINT_MOISTURE",
  "PAINT_FERTILITY",
  "RAISE_TERRAIN",
  "LOWER_TERRAIN",
  "ADD_BIOMASS",
  "REMOVE_BIOMASS",
  "METEOR",
];

/** Human-readable kind names for DTOs and timeline captions, indexed by kind. */
export const INTERVENTION_KIND_NAMES: readonly string[] = [
  "globalTemperature",
  "temperatureBrush",
  "moistureBrush",
  "fertilityBrush",
  "raiseTerrain",
  "lowerTerrain",
  "addBiomass",
  "removeBiomass",
  "meteor",
];

/** Radial falloff of a brush application (docs/02 §16). */
export const BrushFalloff = {
  Linear: 0,
  Hard: 1,
} as const;

export type BrushFalloff = (typeof BrushFalloff)[keyof typeof BrushFalloff];

export const BRUSH_FALLOFF_NAMES: readonly string[] = ["linear", "hard"];

/** The kinds that carry a brush payload. */
export type BrushKind =
  | typeof InterventionKind.PaintTemperature
  | typeof InterventionKind.PaintMoisture
  | typeof InterventionKind.PaintFertility
  | typeof InterventionKind.RaiseTerrain
  | typeof InterventionKind.LowerTerrain
  | typeof InterventionKind.AddBiomass
  | typeof InterventionKind.RemoveBiomass;

interface CommandIdentity {
  readonly schemaVersion: typeof COMMAND_SCHEMA_VERSION;
  /** Unique per world, monotonic from 1 in acceptance order. Never 0. */
  readonly id: number;
  /** Tick whose phase 0 applies this command. */
  readonly tick: number;
  /** Globally monotonic acceptance counter; the in-tick tie-break. */
  readonly sequence: number;
}

/** SET_GLOBAL_TEMPERATURE_OFFSET: set the absolute world-wide offset. */
export interface GlobalTemperatureCommand extends CommandIdentity {
  readonly kind: typeof InterventionKind.SetGlobalTemperature;
  /** New absolute offset in centi-°C (replaces, does not add). */
  readonly offsetCentiC: number;
}

/**
 * A canonical brush stroke: resampled, quantized samples plus one radius,
 * strength and falloff for the whole stroke (docs/02 §16).
 *
 * Each affected cell receives ONE application per command, scaled by the
 * strongest falloff factor any sample projects onto it — a stroke is a single
 * band-shaped intervention, not a pile of overlapping stamps, so its per-cell
 * effect is bounded by `strength` however densely the samples overlap.
 */
export interface BrushCommand extends CommandIdentity {
  readonly kind: BrushKind;
  /** Brush radius in whole LU. */
  readonly radiusLU: number;
  /**
   * Signed centre-strength in the kind's units: centi-°C for temperature,
   * Q for moisture/fertility/terrain, biomass units for biomass. Temperature,
   * moisture and fertility carry their direction in the sign; terrain and
   * biomass kinds are direction-in-the-kind and strictly positive.
   */
  readonly strength: number;
  readonly falloff: BrushFalloff;
  /** Sample coordinates in whole LU, parallel arrays, at least one sample. */
  readonly samplesXLU: readonly number[];
  readonly samplesYLU: readonly number[];
}

/** METEOR: one deterministic radial catastrophe (docs/03 §25). */
export interface MeteorCommand extends CommandIdentity {
  readonly kind: typeof InterventionKind.Meteor;
  readonly centerXLU: number;
  readonly centerYLU: number;
  readonly radiusLU: number;
}

export type SimulationCommand = GlobalTemperatureCommand | BrushCommand | MeteorCommand;

// --- Inputs ------------------------------------------------------------------

interface InputBase {
  /**
   * Optional explicit target tick. Omitted (the live UI path), the engine
   * stamps the tick that will execute next. Explicit ticks exist for fixtures
   * and scripted experiments; a tick in the past is rejected.
   */
  readonly targetTick?: number;
}

export interface GlobalTemperatureInput extends InputBase {
  readonly kind: typeof InterventionKind.SetGlobalTemperature;
  readonly offsetCentiC: number;
}

export interface BrushInput extends InputBase {
  readonly kind: BrushKind;
  readonly radiusLU: number;
  readonly strength: number;
  readonly falloff: BrushFalloff;
  readonly samplesXLU: readonly number[];
  readonly samplesYLU: readonly number[];
}

export interface MeteorInput extends InputBase {
  readonly kind: typeof InterventionKind.Meteor;
  readonly centerXLU: number;
  readonly centerYLU: number;
  readonly radiusLU: number;
}

export type CommandInput = GlobalTemperatureInput | BrushInput | MeteorInput;

// --- Queue results -----------------------------------------------------------

/**
 * Why a command was rejected. Numbering crosses the protocol; a rejection is a
 * deterministic answer, not an exception — a malformed message from a buggy UI
 * must never stop a running world.
 */
export const CommandRejectReason = {
  /** Explicit target tick lies before the next executable tick. */
  PastTick: 0,
  /** Structurally invalid: wrong types, non-integers, mismatched arrays. */
  Malformed: 1,
  /** Structurally valid but outside the config's intervention bounds. */
  OutOfBounds: 2,
} as const;

export type CommandRejectReason = (typeof CommandRejectReason)[keyof typeof CommandRejectReason];

export const COMMAND_REJECT_REASON_NAMES: readonly string[] = [
  "pastTick",
  "malformed",
  "outOfBounds",
];

export type CommandQueueResult =
  | { readonly accepted: true; readonly command: SimulationCommand }
  | { readonly accepted: false; readonly reason: CommandRejectReason; readonly detail: string };

// --- Validation ----------------------------------------------------------------

export type CommandInputProblem = {
  readonly reason: CommandRejectReason;
  readonly detail: string;
} | null;

function isInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

const BRUSH_KIND_SET: ReadonlySet<number> = new Set([
  InterventionKind.PaintTemperature,
  InterventionKind.PaintMoisture,
  InterventionKind.PaintFertility,
  InterventionKind.RaiseTerrain,
  InterventionKind.LowerTerrain,
  InterventionKind.AddBiomass,
  InterventionKind.RemoveBiomass,
]);

export function isBrushKind(kind: number): kind is BrushKind {
  return BRUSH_KIND_SET.has(kind);
}

function malformed(detail: string): CommandInputProblem {
  return { reason: CommandRejectReason.Malformed, detail };
}

function outOfBounds(detail: string): CommandInputProblem {
  return { reason: CommandRejectReason.OutOfBounds, detail };
}

/** Centre-strength bound for a brush kind, from the intervention config. */
export function brushStrengthBound(
  kind: BrushKind,
  config: DeepReadonly<SimulationConfig>,
): number {
  const bounds = config.interventions;
  switch (kind) {
    case InterventionKind.PaintTemperature:
      return bounds.maxTemperatureBrushStrengthCentiC;
    case InterventionKind.PaintMoisture:
      return bounds.maxMoistureBrushStrengthQ;
    case InterventionKind.PaintFertility:
      return bounds.maxFertilityBrushStrengthQ;
    case InterventionKind.RaiseTerrain:
    case InterventionKind.LowerTerrain:
      return bounds.maxTerrainBrushStrengthQ;
    case InterventionKind.AddBiomass:
    case InterventionKind.RemoveBiomass:
      return bounds.maxBiomassBrushStrengthUnits;
  }
}

/** True for kinds whose strength is signed (direction in the sign). */
export function brushStrengthIsSigned(kind: BrushKind): boolean {
  return (
    kind === InterventionKind.PaintTemperature ||
    kind === InterventionKind.PaintMoisture ||
    kind === InterventionKind.PaintFertility
  );
}

/**
 * Structural and bounds validation of a command input against the config.
 *
 * Returns `null` when the input is acceptable. The target-tick rule is NOT
 * checked here — it needs the engine's current tick and lives in
 * `SimulationEngine.queueCommand`.
 */
export function validateCommandInput(
  input: CommandInput,
  config: DeepReadonly<SimulationConfig>,
): CommandInputProblem {
  const bounds = config.interventions;
  const sizeLU = config.world.sizeLU;

  if (input.targetTick !== undefined && !isInt(input.targetTick)) {
    return malformed(`targetTick must be a safe integer, got ${String(input.targetTick)}`);
  }

  switch (input.kind) {
    case InterventionKind.SetGlobalTemperature: {
      if (!isInt(input.offsetCentiC)) {
        return malformed(`offsetCentiC must be an integer, got ${String(input.offsetCentiC)}`);
      }
      const bound = bounds.maxGlobalTemperatureOffsetCentiC;
      if (Math.abs(input.offsetCentiC) > bound) {
        return outOfBounds(
          `global temperature offset ${input.offsetCentiC} exceeds ±${bound} centi-°C`,
        );
      }
      return null;
    }

    case InterventionKind.Meteor: {
      if (!isInt(input.centerXLU) || !isInt(input.centerYLU) || !isInt(input.radiusLU)) {
        return malformed("meteor centre and radius must be integers (whole LU)");
      }
      if (
        input.radiusLU < bounds.meteor.minRadiusLU ||
        input.radiusLU > bounds.meteor.maxRadiusLU
      ) {
        return outOfBounds(
          `meteor radius ${input.radiusLU} LU is outside ` +
            `[${bounds.meteor.minRadiusLU}, ${bounds.meteor.maxRadiusLU}]`,
        );
      }
      if (
        input.centerXLU < 0 ||
        input.centerXLU > sizeLU ||
        input.centerYLU < 0 ||
        input.centerYLU > sizeLU
      ) {
        return outOfBounds(
          `meteor centre (${input.centerXLU}, ${input.centerYLU}) is outside the world`,
        );
      }
      return null;
    }

    default: {
      if (!isBrushKind(input.kind)) {
        return malformed(`unknown command kind ${String((input as { kind: unknown }).kind)}`);
      }
      if (!isInt(input.radiusLU) || !isInt(input.strength)) {
        return malformed("brush radius and strength must be integers");
      }
      if (input.falloff !== BrushFalloff.Linear && input.falloff !== BrushFalloff.Hard) {
        return malformed(
          `brush falloff must be 0 (linear) or 1 (hard), got ${String(input.falloff)}`,
        );
      }
      // Runtime array check through `unknown` locals: the declared type is
      // already `readonly number[]`, but a payload that crossed a structured
      // clone is untrusted, and narrowing the field itself would degrade its
      // element type to `any` for the loop below.
      const rawSamplesX: unknown = input.samplesXLU;
      const rawSamplesY: unknown = input.samplesYLU;
      if (!Array.isArray(rawSamplesX) || !Array.isArray(rawSamplesY)) {
        return malformed("brush samples must be arrays");
      }
      if (input.samplesXLU.length !== input.samplesYLU.length) {
        return malformed(
          `brush sample arrays disagree: ${input.samplesXLU.length} x-values vs ` +
            `${input.samplesYLU.length} y-values`,
        );
      }
      if (input.samplesXLU.length === 0) {
        return malformed("a brush command must carry at least one sample");
      }
      if (input.samplesXLU.length > bounds.maxBrushSamplesPerCommand) {
        return outOfBounds(
          `brush carries ${input.samplesXLU.length} samples, above the ` +
            `${bounds.maxBrushSamplesPerCommand} cap`,
        );
      }
      for (let i = 0; i < input.samplesXLU.length; i += 1) {
        const x = input.samplesXLU[i];
        const y = input.samplesYLU[i];
        if (!isInt(x) || !isInt(y)) {
          return malformed(
            `brush sample ${i} must be integer LU, got (${String(x)}, ${String(y)})`,
          );
        }
        if (x < 0 || x > sizeLU || y < 0 || y > sizeLU) {
          return outOfBounds(`brush sample ${i} at (${x}, ${y}) is outside the world`);
        }
      }
      if (input.radiusLU < bounds.minBrushRadiusLU || input.radiusLU > bounds.maxBrushRadiusLU) {
        return outOfBounds(
          `brush radius ${input.radiusLU} LU is outside ` +
            `[${bounds.minBrushRadiusLU}, ${bounds.maxBrushRadiusLU}]`,
        );
      }
      const strengthBound = brushStrengthBound(input.kind, config);
      if (input.strength === 0) {
        return outOfBounds("brush strength must be nonzero");
      }
      if (brushStrengthIsSigned(input.kind)) {
        if (Math.abs(input.strength) > strengthBound) {
          return outOfBounds(`brush strength ${input.strength} exceeds ±${strengthBound}`);
        }
      } else if (input.strength < 0 || input.strength > strengthBound) {
        return outOfBounds(
          `brush strength ${input.strength} must be in (0, ${strengthBound}] — ` +
            "direction is part of the command kind",
        );
      }
      return null;
    }
  }
}
