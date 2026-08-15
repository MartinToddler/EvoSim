/**
 * World seed selection for the Milestone 6 shell.
 *
 * The project's mandatory deterministic fixture uses `0xE0A12026` (CLAUDE.md),
 * so that is the world the application opens by default: what you see in the
 * browser is the same world the golden hashes, the headless runner and the
 * soak tests describe.
 *
 * `?seed=` accepts decimal or `0x` hex so a specific world can be shared by
 * link. World creation/loading UI is Milestone 10; a query parameter is the
 * honest minimum until then.
 */

export const DEFAULT_SEED = 0xe0a12026;

/**
 * Parse a seed from a query string, falling back to {@link DEFAULT_SEED}.
 *
 * Anything unparseable falls back rather than throwing: a typo in a URL should
 * open the default world, not a blank page. Seeds are normalized to uint32
 * exactly as the engine does, so `?seed=` and the engine agree on which world a
 * number names.
 */
/**
 * Whether the URL names a seed at all (ADR 0025).
 *
 * A `?seed=` link is a deep link INTO the New World screen with that seed
 * prefilled and previewed — it must not skip the explicit Create World step,
 * and its absence means the app opens on the start screen.
 */
export function hasSeedInLocation(search: string): boolean {
  const raw = new URLSearchParams(search).get("seed");
  return raw !== null && raw.trim() !== "";
}

export function readSeedFromLocation(search: string): number {
  const raw = new URLSearchParams(search).get("seed");
  if (raw === null || raw.trim() === "") {
    return DEFAULT_SEED;
  }
  const trimmed = raw.trim();
  // The shape is checked before parsing, because `Number.parseInt` is lenient
  // in ways that turn typos into worlds: it reads "12abc" as 12 and "0x" as 0,
  // so a malformed link would silently open a *different* world instead of the
  // default one.
  if (/^0[xX][0-9a-fA-F]+$/.test(trimmed)) {
    return Number.parseInt(trimmed.slice(2), 16) >>> 0;
  }
  if (/^-?\d+$/.test(trimmed)) {
    return Number.parseInt(trimmed, 10) >>> 0;
  }
  return DEFAULT_SEED;
}
