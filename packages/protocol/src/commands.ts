/**
 * Player command wire shapes and canonical stroke resampling (tasks J01–J02,
 * docs/02 §§15–16).
 *
 * ## Why raw pointer events never become commands
 *
 * `pointermove` frequency is a device property — 60 Hz mice, 120 Hz pens,
 * whatever a trackpad batches — and authoritative history must not depend on
 * it (docs/10 §25 names this exact mistake). The UI collects the pointer path
 * as float world coordinates, and on stroke completion {@link resampleStroke}
 * turns it into the canonical form: samples spaced a fixed WORLD distance
 * apart along the path geometry, quantized to whole LU. Two devices drawing
 * the same line at different event rates produce the same canonical samples,
 * which is what makes a recorded command replayable on any machine.
 *
 * The protocol package owns this function because it defines the wire
 * contract's content: what a brush command's samples MEAN is "the resampled,
 * quantized path", and the algorithm that produces them is part of that
 * meaning. It is pure math — no DOM, no engine import — and versioned by
 * PROTOCOL_VERSION like every other wire shape.
 */

/** Intervention kinds on the wire, mirroring the engine's numbering 0..8. */
export const COMMAND_KINDS = [
  "setGlobalTemperature",
  "paintTemperature",
  "paintMoisture",
  "paintFertility",
  "raiseTerrain",
  "lowerTerrain",
  "addBiomass",
  "removeBiomass",
  "meteor",
] as const;

export type CommandKindDto = (typeof COMMAND_KINDS)[number];

export type BrushKindDto =
  | "paintTemperature"
  | "paintMoisture"
  | "paintFertility"
  | "raiseTerrain"
  | "lowerTerrain"
  | "addBiomass"
  | "removeBiomass";

export type BrushFalloffDto = "linear" | "hard";

/** SET_GLOBAL_TEMPERATURE_OFFSET request: set the absolute world offset. */
export interface GlobalTemperatureRequestDto {
  kind: "setGlobalTemperature";
  offsetCentiC: number;
  /** Explicit target tick, or null/omitted for "the next executable tick". */
  targetTick?: number | null;
}

/** A canonical brush stroke request (docs/02 §16). */
export interface BrushRequestDto {
  kind: BrushKindDto;
  /** Brush radius in whole LU. */
  radiusLU: number;
  /**
   * Signed centre strength in the kind's engine units: centi-°C for
   * temperature, Q fractions for moisture/fertility/terrain, biomass units for
   * biomass. Terrain and biomass kinds carry direction in the kind and must be
   * positive.
   */
  strength: number;
  falloff: BrushFalloffDto;
  /** Canonical resampled sample coordinates in whole LU; parallel arrays. */
  samplesXLU: number[];
  samplesYLU: number[];
  targetTick?: number | null;
}

/** METEOR request: one radial catastrophe. */
export interface MeteorRequestDto {
  kind: "meteor";
  centerXLU: number;
  centerYLU: number;
  radiusLU: number;
  targetTick?: number | null;
}

export type CommandRequestDto = GlobalTemperatureRequestDto | BrushRequestDto | MeteorRequestDto;

/** Why the engine refused a command; mirrors the engine's numbering 0..2. */
export const COMMAND_REJECT_REASONS = ["pastTick", "malformed", "outOfBounds"] as const;

export type CommandRejectReasonDto = (typeof COMMAND_REJECT_REASONS)[number];

/**
 * Answer to QUEUE_COMMAND. Acceptance carries the stamped identity so the UI
 * can reference the immutable log entry; rejection carries a deterministic
 * reason and a human-readable detail. Both echo the request's kind.
 */
export type CommandResultDto =
  | {
      accepted: true;
      kind: CommandKindDto;
      commandId: number;
      /** Tick whose phase 0 will apply (or already applied) the command. */
      tick: number;
      sequence: number;
    }
  | {
      accepted: false;
      kind: CommandKindDto;
      reason: CommandRejectReasonDto;
      detail: string;
    };

/**
 * Intervention bounds the UI needs to build its tools, copied verbatim from
 * the authoritative config by the Worker host (the one module that imports
 * both packages). Units are engine units, exactly as commands carry them.
 */
export interface InterventionDisplayDto {
  brushSampleSpacingLU: number;
  maxBrushSamplesPerCommand: number;
  minBrushRadiusLU: number;
  maxBrushRadiusLU: number;
  maxTemperatureBrushStrengthCentiC: number;
  maxMoistureBrushStrengthQ: number;
  maxFertilityBrushStrengthQ: number;
  maxTerrainBrushStrengthQ: number;
  maxBiomassBrushStrengthUnits: number;
  maxGlobalTemperatureOffsetCentiC: number;
  meteorMinRadiusLU: number;
  meteorMaxRadiusLU: number;
}

// --- Canonical stroke resampling (task J02) -----------------------------------

/** A raw pointer-path point in float world coordinates. */
export interface StrokePointLU {
  xLU: number;
  yLU: number;
}

export interface ResampleStrokeOptions {
  /** Fixed world-distance spacing between canonical samples, in LU. */
  spacingLU: number;
  /** Hard cap on emitted samples; the stroke is truncated beyond it. */
  maxSamples: number;
  /** World edge; every sample is clamped into [0, worldSizeLU]. */
  worldSizeLU: number;
}

export interface CanonicalStroke {
  samplesXLU: number[];
  samplesYLU: number[];
  /** True when the sample cap truncated the tail of the path. */
  truncated: boolean;
}

/**
 * Deterministically resample a pointer path into canonical brush samples
 * (docs/02 §16):
 *
 * 1. drop non-finite points and clamp the rest into the world;
 * 2. walk the polyline and emit a point at every multiple of `spacingLU` of
 *    ARC LENGTH along it (linear interpolation between vertices), plus the
 *    final endpoint, so the stroke ends where the pointer lifted;
 * 3. quantize every emitted point to whole LU (round half away from zero);
 * 4. drop consecutive duplicates the quantization created;
 * 5. cap at `maxSamples`, keeping the earliest samples.
 *
 * Equivalent paths sampled at different pointer frequencies yield identical
 * canonical samples as long as the recorded polylines trace the same geometry
 * to within the 0.5 LU quantization margin — exactly true for straight
 * segments at any two rates, and true for curves once the pointer rate is high
 * enough that chord error stays under half an LU. A click (single point, or a
 * path shorter than one spacing) canonicalizes to one sample.
 */
export function resampleStroke(
  points: readonly StrokePointLU[],
  options: ResampleStrokeOptions,
): CanonicalStroke {
  const { spacingLU, maxSamples, worldSizeLU } = options;
  if (!(spacingLU > 0) || !(maxSamples >= 1) || !(worldSizeLU > 0)) {
    throw new RangeError(
      `resampleStroke needs positive spacing, cap and world size; got ` +
        `${spacingLU}, ${maxSamples}, ${worldSizeLU}`,
    );
  }

  const clean: StrokePointLU[] = [];
  for (const point of points) {
    if (Number.isFinite(point.xLU) && Number.isFinite(point.yLU)) {
      clean.push({
        xLU: Math.min(Math.max(point.xLU, 0), worldSizeLU),
        yLU: Math.min(Math.max(point.yLU, 0), worldSizeLU),
      });
    }
  }
  if (clean.length === 0) {
    return { samplesXLU: [], samplesYLU: [], truncated: false };
  }

  const outX: number[] = [];
  const outY: number[] = [];
  let truncated = false;

  const quantize = (value: number): number => Math.round(value);
  const push = (xLU: number, yLU: number): boolean => {
    const qx = quantize(xLU);
    const qy = quantize(yLU);
    const last = outX.length - 1;
    if (last >= 0 && outX[last] === qx && outY[last] === qy) {
      return true; // duplicate after quantization; not a capacity problem
    }
    if (outX.length >= maxSamples) {
      truncated = true;
      return false;
    }
    outX.push(qx);
    outY.push(qy);
    return true;
  };

  // First sample: where the stroke started.
  push((clean[0] as StrokePointLU).xLU, (clean[0] as StrokePointLU).yLU);

  // Walk the polyline emitting a sample at every spacing multiple of arc
  // length. `nextAt` is the arc-length position of the next sample; `walked`
  // the length consumed so far.
  let walked = 0;
  let nextAt = spacingLU;
  let emitting = true;
  for (let i = 1; i < clean.length && emitting; i += 1) {
    const from = clean[i - 1] as StrokePointLU;
    const to = clean[i] as StrokePointLU;
    const dx = to.xLU - from.xLU;
    const dy = to.yLU - from.yLU;
    const segment = Math.hypot(dx, dy);
    if (segment === 0) {
      continue;
    }
    while (nextAt <= walked + segment) {
      const t = (nextAt - walked) / segment;
      if (!push(from.xLU + dx * t, from.yLU + dy * t)) {
        emitting = false;
        break;
      }
      nextAt += spacingLU;
    }
    walked += segment;
  }

  // The endpoint, so the stroke ends where the pointer lifted.
  if (emitting) {
    const last = clean[clean.length - 1] as StrokePointLU;
    push(last.xLU, last.yLU);
  }

  return { samplesXLU: outX, samplesYLU: outY, truncated };
}
