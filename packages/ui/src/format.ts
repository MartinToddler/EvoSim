/**
 * Number formatting for the observation UI (Milestone 7).
 *
 * One place, so the top bar, inspector and charts agree on how a population or
 * a biomass reads. Everything here is presentation only.
 */

/** Whole number with thousands separators. */
export function formatInt(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

/** Compact magnitude for values that run into millions (biomass, energy). */
export function formatCompact(value: number): string {
  return value.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 1 });
}

/** A fraction in [0, 1] as a whole percentage. */
export function formatPercent(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}

/** Fixed decimals, trimming to something a human scans rather than parses. */
export function formatFixed(value: number, decimals: number): string {
  return value.toFixed(decimals);
}

/** Signed value with an explicit +, so drift direction is visible at a glance. */
export function formatSigned(value: number, decimals: number): string {
  const text = value.toFixed(decimals);
  return value >= 0 ? `+${text}` : text;
}

/**
 * Compact tick count for chart axes: raw ticks are precise but unreadable past
 * a million, and the simulated year is the unit the top bar already teaches.
 */
export function formatYear(tick: number, ticksPerSimYear: number): string {
  const year = tick / Math.max(1, ticksPerSimYear);
  if (year >= 100) {
    return `y${Math.round(year).toLocaleString("en-US")}`;
  }
  return `y${year.toFixed(year >= 10 ? 0 : 1)}`;
}
