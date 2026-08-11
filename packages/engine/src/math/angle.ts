import { ANGLE_STEPS } from "./fixed";

/**
 * Heading/angle helpers (task B02, docs/03 §3).
 *
 * Headings are integers in [0, ANGLE_STEPS), i.e. 0..4095, where a full turn
 * is ANGLE_STEPS steps. Turn sign convention (docs/08 §18): positive turn
 * output increases the heading ("turn right / clockwise" in the v0.1 world
 * orientation); negative decreases it.
 */

const ANGLE_MASK = ANGLE_STEPS - 1;

/** Wrap any integer angle (including negatives) into [0, ANGLE_STEPS). */
export function wrapAngle(steps: number): number {
  // ANGLE_STEPS is a power of two, so a bitwise mask wraps negatives correctly:
  // (-1 & 4095) === 4095.
  return steps & ANGLE_MASK;
}

/** Add a (possibly negative) delta to a heading, wrapping into [0, ANGLE_STEPS). */
export function addAngle(steps: number, delta: number): number {
  return (steps + delta) & ANGLE_MASK;
}

/**
 * Smallest signed difference from `from` to `to` in [-ANGLE_STEPS/2, ANGLE_STEPS/2).
 * Positive means `to` lies clockwise of `from`.
 */
export function signedAngleDiff(from: number, to: number): number {
  const diff = (to - from) & ANGLE_MASK;
  return diff >= ANGLE_STEPS / 2 ? diff - ANGLE_STEPS : diff;
}

/** Convert whole degrees to the nearest angle step (360° == ANGLE_STEPS). */
export function degreesToSteps(degrees: number): number {
  return wrapAngle(Math.round((degrees * ANGLE_STEPS) / 360));
}
