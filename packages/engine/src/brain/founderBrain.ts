import { clamp } from "../math/fixed";
import { BRAIN_WEIGHT_COUNT, BrainInput, BrainOutput, ioWeightIndex } from "./BrainLayout";

/**
 * Founder neural controller (docs/08 §20, docs/04 §17, task D07).
 *
 * Random brains do not forage, so the founder ships with a calibrated reflex
 * network instead of hope. Every weight is a direct input→output skip
 * connection; all 240 input→hidden and 60 hidden→output weights are zero, so
 * the hidden layer starts silent and mutation can discover it later
 * (docs/08 §20).
 *
 * This is NOT a heuristic: after spawn the founder runs the same
 * {@link inferBrain} as every descendant, and these weights mutate like any
 * others. The reflexes it encodes are exactly the ones docs/04 §17 lists —
 * moderate wandering movement, turning toward food, avoiding water, eating in
 * a plant-rich cell, reproducing when mature and well fed, and a low baseline
 * attack drive.
 *
 * Weights are written in hundredths of a conceptual real unit and converted by
 * ×weightScale, matching "converted by *4096 and clamped" in docs/08 §20.
 * Changing them changes evolutionary history from tick 0 (docs/08 §21).
 */
interface FounderSkipWeight {
  output: number;
  input: number;
  /** Conceptual weight × 100, e.g. -85 means -0.85. */
  hundredths: number;
}

export const FOUNDER_SKIP_WEIGHTS: readonly FounderSkipWeight[] = [
  // Throttle: keep moving, move more when hungry, drift toward food ahead,
  // slow down in front of danger.
  { output: BrainOutput.Throttle, input: BrainInput.Bias, hundredths: 30 },
  { output: BrainOutput.Throttle, input: BrainInput.Energy, hundredths: -40 },
  { output: BrainOutput.Throttle, input: BrainInput.PlantGradientForward, hundredths: 20 },
  { output: BrainOutput.Throttle, input: BrainInput.TerrainDangerForward, hundredths: -50 },

  // Turn: follow the lateral food gradient, steer away from the more dangerous
  // side, and wander via the internal signal. Positive turn goes right, and
  // both lateral inputs are positive when the useful direction is right
  // (food) or when danger is on the left, so a positive weight is correct for
  // both (docs/08 §18).
  { output: BrainOutput.Turn, input: BrainInput.PlantGradientLateral, hundredths: 150 },
  { output: BrainOutput.Turn, input: BrainInput.TerrainDangerLateral, hundredths: 180 },
  { output: BrainOutput.Turn, input: BrainInput.InternalSignal, hundredths: 25 },

  // Eat: mostly driven by how much plant matter is underfoot.
  //
  // CALIBRATED, and the one place this fixture departs from docs/08 §20, which
  // specifies a bias of +0.10. That value does not survive contact with the
  // sensor encoding: docs/08 §18 pins carcassProximity at -Q whenever no
  // carcass is in range, which is *always* before Milestone 5 and most of the
  // time afterwards, so the +0.40 carcass term below acts as a permanent -0.40
  // penalty rather than an occasional bonus. Measured on the reference world,
  // the specified founder produced an eat output of 0.354 against a 0.55
  // threshold at every tick of its life: it never attempted to feed once, and
  // all 256 founders starved by tick ~600 — the "founder cannot find food"
  // failure mode of docs/07 §12.
  //
  // The bias is therefore raised to +1.10, which decomposes as:
  //   +0.10  the intended bias from docs/08 §20;
  //   +0.40  cancelling the carcass sensor's absent state, so the carcass term
  //          becomes the bonus it was written to be instead of a standing tax;
  //   +0.60  placing the feeding floor at one quarter of a cell's carrying
  //          capacity, so the founder feeds when there is grass underfoot and
  //          stops before stripping a cell bare.
  //
  // This is calibration of an ordinary inheritable weight, which docs/07 §15
  // and docs/08 §21 explicitly anticipate — not a survival bonus: mutation can
  // move it in either direction, and every descendant is bound by the same
  // engine feeding rules.
  { output: BrainOutput.Eat, input: BrainInput.Bias, hundredths: 110 },
  { output: BrainOutput.Eat, input: BrainInput.LocalPlant, hundredths: 120 },
  { output: BrainOutput.Eat, input: BrainInput.CarcassProximity, hundredths: 40 },

  // Attack: a negative bias only, so attacking is rare until mutation finds a
  // reason for it. No predator/prey wiring exists anywhere in the engine.
  { output: BrainOutput.Attack, input: BrainInput.Bias, hundredths: -85 },

  // Reproduce: the brain's willingness; the engine still enforces maturity,
  // development and energy reserves on top of it (docs/04 §19).
  { output: BrainOutput.Reproduce, input: BrainInput.Bias, hundredths: -20 },
  { output: BrainOutput.Reproduce, input: BrainInput.Energy, hundredths: 130 },
  { output: BrainOutput.Reproduce, input: BrainInput.Development, hundredths: 90 },
];

/**
 * Convert hundredths of a conceptual unit into an integer weight.
 *
 * Rounds half away from zero on the magnitude so the encoding is symmetric:
 * -0.85 and +0.85 must produce weights of equal size.
 */
function encodeWeight(hundredths: number, weightScale: number): number {
  const magnitude = Math.trunc((Math.abs(hundredths) * weightScale + 50) / 100);
  return hundredths < 0 ? -magnitude : magnitude;
}

/** Build the founder's 400 weights. Hidden-layer weights are all zero. */
export function createFounderBrainWeights(
  weightScale: number,
  weightMin: number,
  weightMax: number,
): Int16Array {
  const weights = new Int16Array(BRAIN_WEIGHT_COUNT);
  for (const entry of FOUNDER_SKIP_WEIGHTS) {
    weights[ioWeightIndex(entry.output, entry.input)] = clamp(
      encodeWeight(entry.hundredths, weightScale),
      weightMin,
      weightMax,
    );
  }
  return weights;
}
