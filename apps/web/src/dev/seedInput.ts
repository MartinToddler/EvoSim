import { type Result, err, ok } from "@eon/shared";

/**
 * Seed text parsing for the environment debug view.
 *
 * A seed is the single input that decides a whole world, so this parser is
 * deliberately strict for the same reason the headless CLI is (ADR 0002 §6):
 * `Number.parseInt` accepts trailing garbage ("100abc" → 100) and truncates
 * decimals ("1.5" → 1), which would silently generate a different world than the
 * one the user typed. Out-of-range values are rejected rather than coerced,
 * because `seed >>> 0` maps distinct inputs onto the same world.
 */

/** Seeds are uint32 (the engine narrows with `>>> 0`). */
export const MIN_SEED = 0;
export const MAX_SEED = 0xffffffff;

const DECIMAL_PATTERN = /^\d+$/;
const HEX_PATTERN = /^0[xX][0-9a-fA-F]+$/;

export function parseSeedInput(raw: string): Result<number, string> {
  const text = raw.trim();
  if (text.length === 0) {
    return err("Enter a seed, for example 0xE0A12026 or 3768655910.");
  }

  const isHex = HEX_PATTERN.test(text);
  if (!isHex && !DECIMAL_PATTERN.test(text)) {
    return err(`"${text}" is not an unsigned integer. Use 123 or 0x7B.`);
  }

  const value = isHex ? Number.parseInt(text.slice(2), 16) : Number.parseInt(text, 10);
  if (!Number.isSafeInteger(value)) {
    return err(`"${text}" is outside the safe integer range.`);
  }
  if (value < MIN_SEED || value > MAX_SEED) {
    return err(`Seed must be in [${MIN_SEED}, ${MAX_SEED}], got ${value}.`);
  }
  return ok(value);
}

/** Canonical display form: zero-padded uppercase hex, which is how seeds are quoted. */
export function formatSeedHex(seed: number): string {
  return `0x${(seed >>> 0).toString(16).toUpperCase().padStart(8, "0")}`;
}
