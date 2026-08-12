/**
 * Integer colour ramps for debug field painting.
 *
 * Presentation only — nothing here is authoritative, and no simulation value is
 * derived from a colour. Interpolation is nevertheless done in integer
 * arithmetic: it keeps the unit tests exact rather than approximately equal, and
 * it avoids float rounding differences between platforms showing up as visual
 * diffs in screenshots.
 *
 * Ramp stops are expressed in the DOMAIN of the layer they describe (Q units for
 * normalized fields, centi-Celsius for temperature, biomass units for
 * vegetation), so a reader never has to reverse a normalization to see what a
 * colour means.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface RampStop {
  /** Domain value at which this colour applies exactly. */
  readonly at: number;
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/** A ramp is a list of stops in strictly ascending `at` order, at least one long. */
export type ColorRamp = readonly RampStop[];

/**
 * True when every stop's domain value is strictly greater than the previous one.
 *
 * {@link sampleRamp} assumes this and cannot detect a violation from the inside:
 * given ascending stops its segment search provably lands on a positive span, so
 * a runtime span check would be unreachable code in a per-pixel loop. The
 * invariant is locked by tests over the ramps this package actually ships
 * instead, which is where a malformed constant would come from.
 */
export function isAscendingRamp(ramp: ColorRamp): boolean {
  if (ramp.length === 0) {
    return false;
  }
  for (let i = 1; i < ramp.length; i += 1) {
    if ((ramp[i] as RampStop).at <= (ramp[i - 1] as RampStop).at) {
      return false;
    }
  }
  return true;
}

/**
 * Force a list of non-descending stops into a strictly ascending ramp.
 *
 * Ramps whose stop positions come from world data (sea level, mountain level, a
 * biomass reference) can legitimately collide: a world whose mountain threshold
 * sits at 1.0 would put the rock and snow stops at the same position. Where two
 * stops share a position the LATER colour wins, so the extreme of the ramp always
 * survives — dropping the last stop instead would silently lose the "peak" colour.
 */
export function compactRamp(stops: readonly RampStop[]): ColorRamp {
  const compacted: RampStop[] = [];
  for (const stop of stops) {
    const previous = compacted[compacted.length - 1];
    if (previous === undefined || stop.at > previous.at) {
      compacted.push(stop);
    } else {
      compacted[compacted.length - 1] = { ...stop, at: previous.at };
    }
  }
  return compacted;
}

/**
 * Sample `ramp` at `value`, writing into `out`.
 *
 * Values below the first stop and above the last clamp to those stops, so a
 * layer can never paint an out-of-range colour for an out-of-range cell — it
 * paints the extreme, which is what a debug view should show.
 *
 * Writes into a caller-owned `out` rather than returning a fresh object: this is
 * called once per cell per repaint (65 536 times for a 256² grid), and the
 * project forbids per-iteration allocation in loops of that size.
 */
export function sampleRamp(ramp: ColorRamp, value: number, out: Rgb): void {
  const first = ramp[0];
  if (first === undefined) {
    throw new RangeError("colour ramp must have at least one stop");
  }
  if (value <= first.at) {
    out.r = first.r;
    out.g = first.g;
    out.b = first.b;
    return;
  }

  const last = ramp[ramp.length - 1] as RampStop;
  if (value >= last.at) {
    out.r = last.r;
    out.g = last.g;
    out.b = last.b;
    return;
  }

  // Ramps have a handful of stops, so a linear scan beats any index structure.
  // `value` is strictly inside (first.at, last.at) here, so a segment exists.
  for (let i = 1; i < ramp.length; i += 1) {
    const hi = ramp[i] as RampStop;
    if (value > hi.at) {
      continue;
    }
    const lo = ramp[i - 1] as RampStop;
    const span = hi.at - lo.at;
    const t = value - lo.at;
    out.r = lo.r + Math.trunc(((hi.r - lo.r) * t) / span);
    out.g = lo.g + Math.trunc(((hi.g - lo.g) * t) / span);
    out.b = lo.b + Math.trunc(((hi.b - lo.b) * t) / span);
    return;
  }
}

/** CSS colour string for a sampled ramp/palette entry (legend swatches). */
export function rgbToCss(color: Rgb): string {
  return `rgb(${color.r}, ${color.g}, ${color.b})`;
}
