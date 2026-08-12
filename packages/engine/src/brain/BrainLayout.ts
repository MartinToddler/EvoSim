/**
 * Fixed v0.1 neural topology (docs/04 §10, docs/08 §18, docs/10 §10-11).
 *
 * 20 inputs → 12 hidden → 5 outputs, plus 20 → 5 skip connections:
 *
 *   input→hidden   20 × 12 = 240 weights at IH_OFFSET
 *   hidden→output  12 ×  5 =  60 weights at HO_OFFSET
 *   input→output   20 ×  5 = 100 weights at IO_OFFSET
 *   total                    400 Int16 weights per organism
 *
 * The topology is fixed for MVP; evolving topology (NEAT) is explicitly out of
 * scope. The skip connections are what make a viable founder reflex network
 * expressible without any hidden units, so hidden weights can start at zero and
 * be discovered by mutation later (docs/04 §17).
 *
 * These constants are a storage and hashing contract: changing a count, an
 * offset or the meaning of an input index changes every brain in every save.
 */

export const BRAIN_INPUT_COUNT = 20;
export const BRAIN_HIDDEN_COUNT = 12;
export const BRAIN_OUTPUT_COUNT = 5;

export const IH_OFFSET = 0;
export const HO_OFFSET = IH_OFFSET + BRAIN_INPUT_COUNT * BRAIN_HIDDEN_COUNT; // 240
export const IO_OFFSET = HO_OFFSET + BRAIN_HIDDEN_COUNT * BRAIN_OUTPUT_COUNT; // 300
export const BRAIN_WEIGHT_COUNT = IO_OFFSET + BRAIN_INPUT_COUNT * BRAIN_OUTPUT_COUNT; // 400

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
  /** Plant biomass in the current cell relative to its capacity. */
  LocalPlant: 4,
  /** Plant gradient projected onto the heading. */
  PlantGradientForward: 5,
  /** Plant gradient projected onto the right-hand basis; positive = food to the right. */
  PlantGradientLateral: 6,
  /** -Q no carcass in range, +Q carcass at contact. */
  CarcassProximity: 7,
  /** Carcass direction projected onto the heading; 0 when absent. */
  CarcassForward: 8,
  /** Carcass direction projected to the right; 0 when absent. */
  CarcassLateral: 9,
  /** -Q no visible creature, +Q creature at contact. */
  CreatureProximity: 10,
  /** Visible creature direction projected onto the heading; 0 when absent. */
  CreatureForward: 11,
  /** Visible creature direction projected to the right; 0 when absent. */
  CreatureLateral: 12,
  /** -Q much smaller than me, +Q at least twice my radius. */
  CreatureRelativeSize: 13,
  /** Signed circular hue difference to the visible creature. */
  CreatureHueDifference: 14,
  /** +Q inside thermal tolerance, -Q under maximum thermal stress. */
  ThermalComfort: 15,
  /** -Q isolated, +Q crowded. */
  Crowding: 16,
  /** 0 safe, +Q water or world edge directly ahead. */
  TerrainDangerForward: 17,
  /** Positive = more danger on the LEFT, negative = more on the right. */
  TerrainDangerLateral: 18,
  /** Deterministic oscillator plus stateless hash noise. */
  InternalSignal: 19,
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
  "localPlant",
  "plantGradientForward",
  "plantGradientLateral",
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
