import { Q, clampSignedQ } from "../math/fixed";
import {
  BRAIN_HIDDEN_COUNT,
  BRAIN_INPUT_COUNT,
  BRAIN_OUTPUT_COUNT,
  HO_OFFSET,
  IH_OFFSET,
  IO_OFFSET,
} from "./BrainLayout";

/**
 * Quantized neural inference (docs/04 §11, task D06).
 *
 * Integer only: every neuron accumulates `Σ input × weight` in a JS number,
 * divides by the weight scale truncating toward zero (the project rounding
 * policy, ADR 0001 §5) and hard-clamps to `[-Q, Q]` — a hard tanh. No floats
 * and no transcendental activation, so inference is bit-identical everywhere.
 *
 * Accumulator headroom: the widest sum is `(inputs + hidden) × Q × weightMax`
 * = 32 × 4096 × 8192 ≈ 1.07e9, three orders of magnitude below 2^53. The
 * config validator enforces this bound for any tuned topology.
 *
 * Allocation-free by construction: the caller owns the sensor, hidden and
 * output buffers, and this writes into slices of them.
 */

/** Number of hidden values written per organism. */
export const HIDDEN_STRIDE = BRAIN_HIDDEN_COUNT;

/**
 * Run one organism's network.
 *
 * @param sensors      Sensor block, `BRAIN_INPUT_COUNT` values from `sensorBase`.
 * @param sensorBase   Offset of this organism's sensor block.
 * @param weights      Packed weights, `BRAIN_WEIGHT_COUNT` from `weightBase`.
 * @param weightBase   Offset of this organism's weight block.
 * @param hidden       Scratch for hidden activations.
 * @param hiddenBase   Offset of this organism's hidden block.
 * @param outputs      Receives `BRAIN_OUTPUT_COUNT` raw activations in [-Q, Q].
 * @param outputBase   Offset into `outputs`.
 * @param weightScale  Divisor applied to every neuron's accumulator.
 */
export function inferBrain(
  sensors: Int16Array,
  sensorBase: number,
  weights: Int16Array,
  weightBase: number,
  hidden: Int16Array,
  hiddenBase: number,
  outputs: Int16Array,
  outputBase: number,
  weightScale: number,
): void {
  const ihBase = weightBase + IH_OFFSET;
  for (let h = 0; h < BRAIN_HIDDEN_COUNT; h += 1) {
    const row = ihBase + h * BRAIN_INPUT_COUNT;
    let sum = 0;
    for (let i = 0; i < BRAIN_INPUT_COUNT; i += 1) {
      sum += (sensors[sensorBase + i] as number) * (weights[row + i] as number);
    }
    hidden[hiddenBase + h] = clampSignedQ(Math.trunc(sum / weightScale));
  }

  const hoBase = weightBase + HO_OFFSET;
  const ioBase = weightBase + IO_OFFSET;
  for (let o = 0; o < BRAIN_OUTPUT_COUNT; o += 1) {
    const hiddenRow = hoBase + o * BRAIN_HIDDEN_COUNT;
    const skipRow = ioBase + o * BRAIN_INPUT_COUNT;
    let sum = 0;
    for (let h = 0; h < BRAIN_HIDDEN_COUNT; h += 1) {
      sum += (hidden[hiddenBase + h] as number) * (weights[hiddenRow + h] as number);
    }
    for (let i = 0; i < BRAIN_INPUT_COUNT; i += 1) {
      sum += (sensors[sensorBase + i] as number) * (weights[skipRow + i] as number);
    }
    outputs[outputBase + o] = clampSignedQ(Math.trunc(sum / weightScale));
  }
}

/**
 * Map a raw output in `[-Q, Q]` to a positive action level in `[0, Q]`
 * (docs/04 §11: `(raw + Q) / 2`). Used for throttle, eat, attack and reproduce;
 * turn keeps its raw signed value.
 */
export function positiveOutputQ(raw: number): number {
  return (clampSignedQ(raw) + Q) >> 1;
}
