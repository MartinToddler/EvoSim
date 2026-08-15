/**
 * Shared strict argument parsing for the headless tools.
 *
 * Every one of these scripts feeds a golden fixture, a benchmark or a
 * calibration conclusion, so malformed input must fail loudly rather than
 * quietly run a different experiment than the operator asked for.
 * `Number.parseInt` is deliberately NOT trusted on its own: it accepts trailing
 * garbage ("100abc" -> 100) and silently truncates ("1.5" -> 1).
 */

const DECIMAL_PATTERN = /^-?\d+$/;
const HEX_PATTERN = /^0[xX][0-9a-fA-F]+$/;

/** Build a `fail` for one tool, prefixing its name onto every error. */
export function makeFail(tool: string): (message: string) => never {
  return (message: string): never => {
    console.error(`${tool}: ${message}`);
    process.exit(1);
  };
}

/** Strictly parse a CLI integer, decimal or `0x`-prefixed hex. */
export function parseIntStrict(
  raw: string,
  name: string,
  fail: (message: string) => never,
): number {
  const isHex = HEX_PATTERN.test(raw);
  if (!isHex && !DECIMAL_PATTERN.test(raw)) {
    fail(`invalid ${name}: ${JSON.stringify(raw)} is not an integer (use 123 or 0x7B)`);
  }
  const value = isHex ? Number.parseInt(raw.slice(2), 16) : Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value)) {
    fail(`invalid ${name}: ${raw} is outside the safe integer range`);
  }
  return value;
}
