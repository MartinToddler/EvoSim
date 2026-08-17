import { Q, clampSignedQ, qmul } from "../math/fixed";
import {
  BRAIN_HIDDEN_COUNT,
  BRAIN_INPUT_COUNT,
  BRAIN_OUTPUT_COUNT,
  HO_OFFSET,
  IH_OFFSET,
  IO_OFFSET,
} from "./BrainLayout";
import {
  BRAIN_MEMORY_COUNT,
  connectionActive,
  hiddenActive,
  inputActive,
  memoryActive,
  memoryGateWeightIndex,
  memoryReadWeightIndex,
  memorySkipWeightIndex,
  memoryValueWeightIndex,
  recurrentActive,
  recurrentWeightIndex,
} from "./NeuralTopology";

/**
 * Quantized neural inference (docs/04 §11, task D06).
 *
 * Integer only: every neuron accumulates `Σ input × weight` in a JS number,
 * divides by the weight scale truncating toward zero (the project rounding
 * policy, ADR 0001 §5) and hard-clamps to `[-Q, Q]` — a hard tanh. No floats
 * and no transcendental activation, so inference is bit-identical everywhere.
 *
 * Accumulator headroom: the widest sum is
 * `(inputs + hidden + memory + 1) × Q × weightMax` = 37 × 4096 × 8192 ≈ 1.24e9,
 * three orders of magnitude below 2^53. The config validator enforces this
 * bound for any tuned topology. M16's recurrent and memory terms widen the sum
 * by five, which is why the bound is restated here rather than left at 32.
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
 * @param topology     Packed topology masks (M16).
 * @param topologyBase Offset of this organism's mask block.
 * @param hiddenPrev   Authoritative previous hidden activations; updated here.
 * @param hiddenPrevBase Offset of this organism's previous-activation block.
 * @param memory       Authoritative memory registers; updated here.
 * @param memoryBase   Offset of this organism's memory block.
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
  topology: Uint16Array,
  topologyBase: number,
  hiddenPrev: Int16Array,
  hiddenPrevBase: number,
  memory: Int16Array,
  memoryBase: number,
): void {
  // 1. Hidden layer. An inactive unit is not computed and contributes nothing;
  //    an inactive input is not read; a masked-off connection is skipped with
  //    its weight left intact, which is what lets a lineage restore it later.
  const ihBase = weightBase + IH_OFFSET;
  for (let h = 0; h < BRAIN_HIDDEN_COUNT; h += 1) {
    if (!hiddenActive(topology, topologyBase, h)) {
      hidden[hiddenBase + h] = 0;
      continue;
    }
    const row = ihBase + h * BRAIN_INPUT_COUNT;
    let sum = 0;
    for (let i = 0; i < BRAIN_INPUT_COUNT; i += 1) {
      if (!inputActive(topology, topologyBase, i)) {
        continue;
      }
      if (!connectionActive(topology, topologyBase, IH_OFFSET + h * BRAIN_INPUT_COUNT + i)) {
        continue;
      }
      sum += (sensors[sensorBase + i] as number) * (weights[row + i] as number);
    }
    // Recurrence: this unit's own activation from the previous tick. One
    // weight, gated by one bit — the smallest thing that can hold a state
    // across a tick, and the reason `hiddenPrev` is authoritative.
    if (recurrentActive(topology, topologyBase, h)) {
      const index = recurrentWeightIndex(h);
      if (connectionActive(topology, topologyBase, index)) {
        sum += (hiddenPrev[hiddenPrevBase + h] as number) * (weights[weightBase + index] as number);
      }
    }
    // Memory read.
    for (let m = 0; m < BRAIN_MEMORY_COUNT; m += 1) {
      if (!memoryActive(topology, topologyBase, m)) {
        continue;
      }
      const index = memoryReadWeightIndex(h, m);
      if (!connectionActive(topology, topologyBase, index)) {
        continue;
      }
      sum += (memory[memoryBase + m] as number) * (weights[weightBase + index] as number);
    }
    hidden[hiddenBase + h] = clampSignedQ(Math.trunc(sum / weightScale));
  }

  // 2. Outputs: hidden, the input skips, and any memory wired straight through.
  const hoBase = weightBase + HO_OFFSET;
  const ioBase = weightBase + IO_OFFSET;
  for (let o = 0; o < BRAIN_OUTPUT_COUNT; o += 1) {
    const hiddenRow = hoBase + o * BRAIN_HIDDEN_COUNT;
    const skipRow = ioBase + o * BRAIN_INPUT_COUNT;
    let sum = 0;
    for (let h = 0; h < BRAIN_HIDDEN_COUNT; h += 1) {
      if (!hiddenActive(topology, topologyBase, h)) {
        continue;
      }
      if (!connectionActive(topology, topologyBase, HO_OFFSET + o * BRAIN_HIDDEN_COUNT + h)) {
        continue;
      }
      sum += (hidden[hiddenBase + h] as number) * (weights[hiddenRow + h] as number);
    }
    for (let i = 0; i < BRAIN_INPUT_COUNT; i += 1) {
      if (!inputActive(topology, topologyBase, i)) {
        continue;
      }
      if (!connectionActive(topology, topologyBase, IO_OFFSET + o * BRAIN_INPUT_COUNT + i)) {
        continue;
      }
      sum += (sensors[sensorBase + i] as number) * (weights[skipRow + i] as number);
    }
    for (let m = 0; m < BRAIN_MEMORY_COUNT; m += 1) {
      if (!memoryActive(topology, topologyBase, m)) {
        continue;
      }
      const index = memorySkipWeightIndex(o, m);
      if (!connectionActive(topology, topologyBase, index)) {
        continue;
      }
      sum += (memory[memoryBase + m] as number) * (weights[weightBase + index] as number);
    }
    outputs[outputBase + o] = clampSignedQ(Math.trunc(sum / weightScale));
  }

  // 3. Memory write, AFTER the outputs are read.
  //
  //    Ordering is load-bearing: a register written before the outputs would
  //    let a network react to a value in the same tick it decided to store,
  //    which is a hidden zero-delay loop. Writing last makes every register
  //    exactly one tick old when it is read, so "remember" and "recall" are
  //    always separated by a tick and the network cannot cheat its way to
  //    instantaneous feedback.
  //
  //    `memory = memory + gate * (value - memory)` is a gated blend, not an
  //    assignment. A gate near 0 holds what is there; a gate near Q overwrites.
  //    An assignment could only latch, so nothing could hold a value loosely,
  //    and a running average could never latch at all — the capability
  //    fixtures need both.
  for (let m = 0; m < BRAIN_MEMORY_COUNT; m += 1) {
    if (!memoryActive(topology, topologyBase, m)) {
      memory[memoryBase + m] = 0;
      continue;
    }
    let gateSum = 0;
    let valueSum = 0;
    for (let h = 0; h < BRAIN_HIDDEN_COUNT; h += 1) {
      if (!hiddenActive(topology, topologyBase, h)) {
        continue;
      }
      const activation = hidden[hiddenBase + h] as number;
      const gateIndex = memoryGateWeightIndex(m, h);
      if (connectionActive(topology, topologyBase, gateIndex)) {
        gateSum += activation * (weights[weightBase + gateIndex] as number);
      }
      const valueIndex = memoryValueWeightIndex(m, h);
      if (connectionActive(topology, topologyBase, valueIndex)) {
        valueSum += activation * (weights[weightBase + valueIndex] as number);
      }
    }
    // The gate is a fraction in [0, Q]: a negative drive means "do not write",
    // which is the resting state a register needs in order to hold anything.
    const gateQ = Math.max(0, clampSignedQ(Math.trunc(gateSum / weightScale)));
    const valueQ = clampSignedQ(Math.trunc(valueSum / weightScale));
    const current = memory[memoryBase + m] as number;
    memory[memoryBase + m] = clampSignedQ(current + qmul(gateQ, valueQ - current));
  }

  // 4. Carry the hidden layer into the next tick.
  for (let h = 0; h < BRAIN_HIDDEN_COUNT; h += 1) {
    hiddenPrev[hiddenPrevBase + h] = hidden[hiddenBase + h] as number;
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
