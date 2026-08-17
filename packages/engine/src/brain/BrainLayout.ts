/**
 * Feed-forward neural layout (docs/04 §10, docs/08 §18, docs/10 §10-11).
 *
 * 32 inputs → 12 hidden → 5 outputs, plus 32 → 5 skip connections:
 *
 *   input→hidden   32 × 12 = 384 weights at IH_OFFSET
 *   hidden→output  12 ×  5 =  60 weights at HO_OFFSET
 *   input→output   32 ×  5 = 160 weights at IO_OFFSET
 *   total                    604 Int16 weights per organism
 *
 * M16 makes which of these are *active* inherited; this file still fixes the
 * ceiling, and the ceiling is a compile-time constant. M17 raised the input
 * count from 20 to 32: the single "plant" reading became five per-channel
 * readings and the single gradient pair became five pairs, because a world with
 * five plant channels that an organism can only perceive as one number is a
 * world where the channels cannot be told apart by anything that has to act.
 *
 * These constants are a storage and hashing contract: changing a count, an
 * offset or the meaning of an input index changes every brain in every save.
 */

export const BRAIN_INPUT_COUNT = 32;
export const BRAIN_HIDDEN_COUNT = 12;
export const BRAIN_OUTPUT_COUNT = 5;

export const IH_OFFSET = 0;
export const HO_OFFSET = IH_OFFSET + BRAIN_INPUT_COUNT * BRAIN_HIDDEN_COUNT; // 384
export const IO_OFFSET = HO_OFFSET + BRAIN_HIDDEN_COUNT * BRAIN_OUTPUT_COUNT; // 444
export const BRAIN_WEIGHT_COUNT = IO_OFFSET + BRAIN_INPUT_COUNT * BRAIN_OUTPUT_COUNT; // 604

/**
 * Sensor input indices (docs/08 §18).
 *
 * Every value is Q-scaled; some are inherently non-negative. Nothing here is
 * omniscient: there is no species identity, no "this creature is a predator"
 * flag and no global knowledge — only what the organism could plausibly sense
 * about itself and its immediate surroundings (docs/04 §12).
 */
export const BrainInput = {
  /** Constant +Q, so a network can express an unconditional bias. */
  Bias: 0,
  /** -Q empty, +Q full. */
  Energy: 1,
  /** -Q near death, +Q unhurt. */
  Health: 2,
  /** -Q newborn, +Q fully developed. */
  Development: 3,
  /**
   * Standing biomass of each channel in the current cell, against that
   * channel's own local capacity (M17). Five consecutive inputs in `Resource`
   * order, so `LocalResource + resource` is the channel's input.
   *
   * Five plain readings, deliberately. There is no "best food here" input and
   * no ranking of any kind: the engine reports what is present and the network
   * decides what that is worth to it, which is the whole of docs/11 §M17's
   * sensor rule. A ranked input would put the engine's opinion of an organism's
   * diet inside the organism's own perception, which is ADR 0027's forbidden
   * direction of causation wearing a sensor's clothes.
   */
  LocalResource: 4,
  /**
   * Each channel's gradient projected onto the heading, in `Resource` order
   * (M17). `ResourceGradientForward + resource`.
   */
  ResourceGradientForward: 9,
  /** Each channel's gradient projected to the right; positive = food to the right. */
  ResourceGradientLateral: 14,
  /** -Q no carcass in range, +Q carcass at contact. */
  CarcassProximity: 19,
  /** Carcass direction projected onto the heading; 0 when absent. */
  CarcassForward: 20,
  /** Carcass direction projected to the right; 0 when absent. */
  CarcassLateral: 21,
  /** -Q no visible creature, +Q creature at contact. */
  CreatureProximity: 22,
  /** Visible creature direction projected onto the heading; 0 when absent. */
  CreatureForward: 23,
  /** Visible creature direction projected to the right; 0 when absent. */
  CreatureLateral: 24,
  /** -Q much smaller than me, +Q at least twice my radius. */
  CreatureRelativeSize: 25,
  /** Signed circular hue difference to the visible creature. */
  CreatureHueDifference: 26,
  /** +Q inside thermal tolerance, -Q under maximum thermal stress. */
  ThermalComfort: 27,
  /** -Q isolated, +Q crowded. */
  Crowding: 28,
  /** 0 safe, +Q water or world edge directly ahead. */
  TerrainDangerForward: 29,
  /** Positive = more danger on the LEFT, negative = more on the right. */
  TerrainDangerLateral: 30,
  /** Deterministic oscillator plus stateless hash noise. */
  InternalSignal: 31,
} as const;

export type BrainInput = (typeof BrainInput)[keyof typeof BrainInput];

/** Output indices (docs/04 §10). */
export const BrainOutput = {
  /** [0, Q] movement effort. */
  Throttle: 0,
  /** [-Q, Q]; negative turns left/counter-clockwise, positive right/clockwise. */
  Turn: 1,
  /** [0, Q] intent to feed. */
  Eat: 2,
  /** [0, Q] intent to attack. */
  Attack: 3,
  /** [0, Q] intent to reproduce. */
  Reproduce: 4,
} as const;

export type BrainOutput = (typeof BrainOutput)[keyof typeof BrainOutput];

/** Input names, indexed by input value. Diagnostics, DTOs and test fixtures. */
export const BRAIN_INPUT_NAMES: readonly string[] = [
  "bias",
  "energy",
  "health",
  "development",
  "localFoliage",
  "localBrowse",
  "localFruit",
  "localRoots",
  "localDefended",
  "foliageGradientForward",
  "browseGradientForward",
  "fruitGradientForward",
  "rootsGradientForward",
  "defendedGradientForward",
  "foliageGradientLateral",
  "browseGradientLateral",
  "fruitGradientLateral",
  "rootsGradientLateral",
  "defendedGradientLateral",
  "carcassProximity",
  "carcassForward",
  "carcassLateral",
  "creatureProximity",
  "creatureForward",
  "creatureLateral",
  "creatureRelativeSize",
  "creatureHueDifference",
  "thermalComfort",
  "crowding",
  "terrainDangerForward",
  "terrainDangerLateral",
  "internalSignal",
];

/** Output names, indexed by output value. */
export const BRAIN_OUTPUT_NAMES: readonly string[] = [
  "throttle",
  "turn",
  "eat",
  "attack",
  "reproduce",
];

/** Weight index of the input→hidden connection (input i → hidden h). */
export function ihWeightIndex(hidden: number, input: number): number {
  return IH_OFFSET + hidden * BRAIN_INPUT_COUNT + input;
}

/** Weight index of the hidden→output connection (hidden h → output o). */
export function hoWeightIndex(output: number, hidden: number): number {
  return HO_OFFSET + output * BRAIN_HIDDEN_COUNT + hidden;
}

/** Weight index of the skip connection (input i → output o). */
export function ioWeightIndex(output: number, input: number): number {
  return IO_OFFSET + output * BRAIN_INPUT_COUNT + input;
}
