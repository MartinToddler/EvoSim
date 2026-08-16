/**
 * Procedural body geometry (M14, docs/11 §M14).
 *
 * The last stage of the morphology pipeline:
 *
 * ```text
 * MorphologyGenotype -> developmental interpreter -> MorphologyPhenotype
 *   -> [this file] -> geometry -> pixels
 * ```
 *
 * This module is deliberately Pixi-free and allocation-visible: it turns the
 * 26 phenotype channels the engine sent into plain arrays of points, so the
 * mapping can be unit-tested in Node and so the same function feeds both the
 * production sprite cache and the morphology gallery. Drawing them is
 * `drawMorphology.ts`'s job.
 *
 * ## This is a projection, not a decision
 *
 * Nothing here can change the simulation. The renderer receives an already
 * developed phenotype and chooses how to draw it; it never chooses what the
 * body IS. There is no randomness in this file — two organisms with the same
 * channels produce byte-identical geometry, which is what makes the sprite
 * cache safe to key on the channels alone.
 *
 * ## Coordinate frame
 *
 * Everything is drawn in a frame of {@link GEOMETRY_UNIT} units per adult body
 * radius, +X forward along the heading, +Y to the organism's right. The caller
 * scales that frame to the radius it was given.
 */

import {
  MORPH_CHANNEL_COUNT,
  MORPH_MAGNITUDE_SCALE,
  MorphChannel,
  morphMagnitude,
} from "@eon/protocol";

/** Widest silhouette the wire scale can express, in frame units. */

/**
 * Frame units per adult body radius.
 *
 * Chosen against the wire scale, not for looks: a magnitude channel tops out at
 * `MORPH_MAGNITUDE_SCALE` (10.0), so the longest expressible silhouette is 10
 * radii and a frame of `10 * GEOMETRY_UNIT` units contains every body the
 * engine can grow. Raising this without raising the sprite frame would clip the
 * longest lineages, which is exactly the kind of silent failure the fixed frame
 * exists to prevent.
 */
export const GEOMETRY_UNIT = 10;

/**
 * Half-extent of the frame every body is drawn into, in geometry units.
 *
 * The drawing surface is fixed so that "how big an organism looks" is one
 * constant rather than a function of the artwork, exactly as `SPRITE_FRAME`
 * already is for the shared sprites. A body wider than this is shrunk to fit
 * rather than clipped.
 */
export const GEOMETRY_FRAME_HALF = (MORPH_MAGNITUDE_SCALE * GEOMETRY_UNIT) / 2;

/** Number of samples along each side of the body outline. */
const OUTLINE_SAMPLES = 14;

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface MorphologyGeometry {
  /** Closed outline of the trunk, head and tail, clockwise from the nose. */
  readonly outline: readonly Point[];
  /** One quad per appendage, mirrored left and right. */
  readonly appendages: readonly (readonly Point[])[];
  /** Segment boundary lines across the trunk. */
  readonly segmentLines: readonly (readonly [Point, Point])[];
  /** Plating bands: closed polygons clipped to the trunk. */
  readonly plates: readonly (readonly Point[])[];
  /** Pattern bands drawn in the secondary pigment. */
  readonly patternBands: readonly (readonly Point[])[];
  /** Anterior sensory structures. */
  readonly sensors: readonly { at: Point; radius: number }[];
  /** Anterior feeding structure. */
  readonly mouth: readonly Point[];
  /** Half-extent of the geometry along each axis, in frame units. */
  readonly halfLength: number;
  readonly halfWidth: number;
  /**
   * Uniform shrink applied so the body fits {@link GEOMETRY_FRAME_HALF}.
   *
   * `1` for every body the engine can currently grow — `validateConfig` bounds
   * the silhouette below the frame, and a test pins that. It is not `1` only
   * for channel values outside what any legal config can emit, where shrinking
   * the whole body uniformly is the one failure mode that stays honest:
   * clipping would silently amputate a tail and look like a short lineage.
   */
  readonly fitScale: number;
}

/** A channel byte in `[0, 255]` as a fraction in `[0, 1]`. */
function unit(channels: ArrayLike<number>, channel: number): number {
  return (channels[channel] as number) / 255;
}

/**
 * Trunk half-width at a normalized position along the body.
 *
 * `t = 0` is the rear tip and `t = 1` the nose. Taper is applied as a power so
 * a high taper gene produces a genuinely pointed end rather than a slightly
 * narrower one, and both ends are independent — a lineage can evolve a blunt
 * front with a tapered rear or the reverse.
 */
function trunkHalfWidth(
  t: number,
  halfWidth: number,
  frontTaper: number,
  rearTaper: number,
): number {
  const frontExponent = 0.45 + frontTaper * 2.2;
  const rearExponent = 0.45 + rearTaper * 2.2;
  // Two shoulders meeting at the widest point, biased slightly forward so the
  // silhouette reads as an animal rather than as a symmetric lozenge.
  // A floor keeps both ends non-degenerate. Without it the trunk pinches to a
  // point at t=0 and the tail would attach to nothing, which draws as a bowtie.
  const floor = 0.06;
  const peak = 0.45;
  if (t >= peak) {
    const u = (1 - t) / (1 - peak);
    return halfWidth * (floor + (1 - floor) * Math.pow(Math.max(0, u), frontExponent));
  }
  const u = t / peak;
  return halfWidth * (floor + (1 - floor) * Math.pow(Math.max(0, u), rearExponent));
}

/**
 * Build the geometry for one developed phenotype.
 *
 * `channels` is the packed per-organism morphology block from a render
 * snapshot: {@link MORPH_CHANNEL_COUNT} bytes starting at `base`.
 */
export function buildMorphologyGeometry(channels: ArrayLike<number>, base = 0): MorphologyGeometry {
  const at = (channel: number): number => unit(channels, base + channel);

  // Extent channels decode through the protocol's fixed wire scale, so the
  // drawn proportions are the developed ones rather than a renderer guess.
  const bodyLength = morphMagnitude(channels[base + MorphChannel.BodyLength] as number);
  const bodyWidth = morphMagnitude(channels[base + MorphChannel.BodyWidth] as number);
  const frontTaper = at(MorphChannel.FrontTaper);
  const rearTaper = at(MorphChannel.RearTaper);
  const headProportion = at(MorphChannel.HeadProportion);
  const tailLength = morphMagnitude(channels[base + MorphChannel.TailLength] as number);
  const tailWidth = 0.08 + at(MorphChannel.TailWidth) * 0.55;
  const tailTaper = at(MorphChannel.TailTaper);

  const halfLen = (bodyLength * GEOMETRY_UNIT) / 2;
  const halfWid = (bodyWidth * GEOMETRY_UNIT) / 2;
  const headExtent = halfLen * headProportion;
  const tailExtent = halfLen * 2 * tailLength;
  const noseX = halfLen + headExtent;
  const tailX = -halfLen - tailExtent;

  // Outline: nose -> right side -> rear -> tail -> left side -> nose.
  const outline: Point[] = [];
  outline.push({ x: noseX, y: 0 });
  for (let i = OUTLINE_SAMPLES; i >= 0; i -= 1) {
    const t = i / OUTLINE_SAMPLES;
    const x = -halfLen + t * 2 * halfLen;
    outline.push({ x, y: trunkHalfWidth(t, halfWid, frontTaper, rearTaper) });
  }
  if (tailExtent > 0.5) {
    const tipHalfWidth = (halfWid * tailWidth) / 2;
    outline.push({ x: -halfLen, y: halfWid * tailWidth });
    outline.push({ x: tailX, y: tipHalfWidth * (1 - tailTaper) });
    outline.push({ x: tailX, y: -tipHalfWidth * (1 - tailTaper) });
    outline.push({ x: -halfLen, y: -halfWid * tailWidth });
  }
  for (let i = 0; i <= OUTLINE_SAMPLES; i += 1) {
    const t = i / OUTLINE_SAMPLES;
    const x = -halfLen + t * 2 * halfLen;
    outline.push({ x, y: -trunkHalfWidth(t, halfWid, frontTaper, rearTaper) });
  }

  // Appendages: symmetric pairs distributed over a span whose centre the
  // placement channel moves fore and aft. Front pairs are longer than rear
  // ones by the front-bias channel — one continuous knob, not a limb "type".
  const pairs = channels[base + MorphChannel.AppendagePairs] as number;
  // Appendage length is stored as a multiple of the body HALF-WIDTH, on the
  // same wire scale as the body extents.
  const appendageLength =
    morphMagnitude(channels[base + MorphChannel.AppendageLength] as number) * halfWid;
  const appendageThickness = Math.max(
    0.6,
    (0.1 + at(MorphChannel.AppendageThickness) * 0.5) * appendageLength,
  );
  const appendageAngle = (at(MorphChannel.AppendageAngle) - 0.5) * 1.2;
  const frontBias = at(MorphChannel.AppendageFrontBias);
  const placement = at(MorphChannel.AppendagePlacement);
  const appendages: Point[][] = [];
  if (pairs > 0 && appendageLength > 0.75) {
    const spanCentre = (placement - 0.5) * halfLen * 1.1;
    const spanHalf = halfLen * 0.62;
    for (let p = 0; p < pairs; p += 1) {
      const u = pairs === 1 ? 0.5 : p / (pairs - 1);
      const x = spanCentre + (0.5 - u) * 2 * spanHalf;
      const t = (x + halfLen) / (2 * halfLen);
      const attachY = trunkHalfWidth(Math.min(1, Math.max(0, t)), halfWid, frontTaper, rearTaper);
      // Front pairs longer when frontBias > 0.5, rear pairs longer below it.
      const bias = 1 + (frontBias - 0.5) * 2 * (u - 0.5) * -1.2;
      const reach = appendageLength * Math.max(0.25, bias);
      const dx = Math.sin(appendageAngle) * reach;
      const dy = Math.cos(appendageAngle) * reach;
      const half = appendageThickness / 2;
      for (const side of [1, -1]) {
        const rootY = attachY * side;
        const tipX = x + dx;
        const tipY = rootY + dy * side;
        appendages.push([
          { x: x - half, y: rootY },
          { x: x + half, y: rootY },
          { x: tipX + half * 0.35, y: tipY },
          { x: tipX - half * 0.35, y: tipY },
        ]);
      }
    }
  }

  // Segment boundaries: purely visual divisions of the trunk.
  const segments = Math.max(1, channels[base + MorphChannel.SegmentCount] as number);
  const falloff = 0.55 + at(MorphChannel.SegmentProportion) * 0.45;
  const segmentLines: [Point, Point][] = [];
  if (segments > 1) {
    // Segment widths shrink toward the rear by `falloff`; the boundaries are
    // the running sum of that geometric series, normalized to the trunk.
    let total = 0;
    const widths: number[] = [];
    let w = 1;
    for (let s = 0; s < segments; s += 1) {
      widths.push(w);
      total += w;
      w *= falloff;
    }
    let acc = 0;
    for (let s = 0; s < segments - 1; s += 1) {
      acc += widths[s] as number;
      const t = 1 - acc / total;
      const x = -halfLen + t * 2 * halfLen;
      const y = trunkHalfWidth(t, halfWid, frontTaper, rearTaper);
      segmentLines.push([
        { x, y: -y * 0.92 },
        { x, y: y * 0.92 },
      ]);
    }
  }

  // Plating: bands across the trunk, concentrated where the distribution
  // channel says and covering the fraction the coverage channel says.
  const coverage = at(MorphChannel.ArmorCoverage);
  const expression = at(MorphChannel.PlateExpression);
  const distribution = at(MorphChannel.ArmorDistribution);
  const plates: Point[][] = [];
  if (coverage > 0.08 && expression > 0.05) {
    const bandCount = 1 + Math.round(coverage * 4);
    const centre = 1 - distribution; // 0 -> rear, 1 -> front
    const spread = 0.18 + coverage * 0.5;
    for (let b = 0; b < bandCount; b += 1) {
      const u = bandCount === 1 ? 0.5 : b / (bandCount - 1);
      const t = Math.min(0.97, Math.max(0.03, centre + (u - 0.5) * 2 * spread));
      const halfBand = (0.035 + expression * 0.06) * 2;
      const t0 = Math.max(0.02, t - halfBand);
      const t1 = Math.min(0.98, t + halfBand);
      const y0 = trunkHalfWidth(t0, halfWid, frontTaper, rearTaper) * 0.96;
      const y1 = trunkHalfWidth(t1, halfWid, frontTaper, rearTaper) * 0.96;
      const x0 = -halfLen + t0 * 2 * halfLen;
      const x1 = -halfLen + t1 * 2 * halfLen;
      plates.push([
        { x: x0, y: -y0 },
        { x: x1, y: -y1 },
        { x: x1, y: y1 },
        { x: x0, y: y0 },
      ]);
    }
  }

  // Pattern: repeats in the secondary pigment. Orientation rotates the band
  // from across the body (0) to along it (1).
  const frequency = channels[base + MorphChannel.PatternFrequency] as number;
  const orientation = at(MorphChannel.PatternOrientation);
  const patternBands: Point[][] = [];
  if (frequency > 0) {
    for (let b = 0; b < frequency; b += 1) {
      const t = (b + 0.5) / frequency;
      if (orientation < 0.5) {
        const halfBand = 0.5 / frequency / 2;
        const t0 = Math.max(0.01, t - halfBand);
        const t1 = Math.min(0.99, t + halfBand);
        const y0 = trunkHalfWidth(t0, halfWid, frontTaper, rearTaper);
        const y1 = trunkHalfWidth(t1, halfWid, frontTaper, rearTaper);
        const x0 = -halfLen + t0 * 2 * halfLen;
        const x1 = -halfLen + t1 * 2 * halfLen;
        patternBands.push([
          { x: x0, y: -y0 },
          { x: x1, y: -y1 },
          { x: x1, y: y1 },
          { x: x0, y: y0 },
        ]);
      } else {
        const y = (t - 0.5) * 2 * halfWid;
        const halfBand = (halfWid / frequency) * 0.45;
        patternBands.push([
          { x: -halfLen, y: y - halfBand },
          { x: halfLen, y: y - halfBand },
          { x: halfLen, y: y + halfBand },
          { x: -halfLen, y: y + halfBand },
        ]);
      }
    }
  }

  // Anterior structures.
  const sensorSize = at(MorphChannel.SensorSize);
  const sensorPlacement = at(MorphChannel.SensorPlacement);
  const sensors: { at: Point; radius: number }[] = [];
  if (sensorSize > 0.02) {
    const radius = Math.max(0.6, sensorSize * halfWid * 0.55);
    const x = halfLen * (0.25 + sensorPlacement * 0.7) + headExtent * 0.35;
    const y = trunkHalfWidth(
      Math.min(0.99, (x + halfLen) / (2 * halfLen)),
      halfWid,
      frontTaper,
      rearTaper,
    );
    const offset = y * (0.25 + sensorPlacement * 0.55);
    sensors.push({ at: { x, y: -offset }, radius });
    sensors.push({ at: { x, y: offset }, radius });
  }

  const mouthSize = at(MorphChannel.MouthSize);
  const mouthHalf = Math.max(0.5, mouthSize * halfWid * 0.6);
  const mouthDepth = Math.max(0.8, mouthSize * (headExtent + halfLen * 0.12));
  const mouth: Point[] = [
    { x: noseX, y: -mouthHalf * 0.35 },
    { x: noseX, y: mouthHalf * 0.35 },
    { x: noseX - mouthDepth, y: mouthHalf },
    { x: noseX - mouthDepth, y: -mouthHalf },
  ];

  let halfWidthExtent = halfWid;
  for (const quad of appendages) {
    for (const point of quad) {
      halfWidthExtent = Math.max(halfWidthExtent, Math.abs(point.y));
    }
  }
  const halfLengthExtent = Math.max(noseX, -tailX);

  const fitScale = Math.min(
    1,
    GEOMETRY_FRAME_HALF / Math.max(halfLengthExtent, halfWidthExtent, 1e-6),
  );
  if (fitScale < 1) {
    scalePoints(outline, fitScale);
    for (const quad of appendages) {
      scalePoints(quad, fitScale);
    }
    for (const line of segmentLines) {
      scalePoints(line, fitScale);
    }
    for (const plate of plates) {
      scalePoints(plate, fitScale);
    }
    for (const band of patternBands) {
      scalePoints(band, fitScale);
    }
    scalePoints(mouth, fitScale);
    for (const sensor of sensors) {
      sensor.at = { x: sensor.at.x * fitScale, y: sensor.at.y * fitScale };
      sensor.radius *= fitScale;
    }
  }

  return {
    outline,
    appendages,
    segmentLines,
    plates,
    patternBands,
    sensors,
    mouth,
    halfLength: halfLengthExtent * fitScale,
    halfWidth: halfWidthExtent * fitScale,
    fitScale,
  };
}

/** Scale a point array in place, so the fit pass allocates nothing extra. */
function scalePoints(points: Point[] | [Point, Point], scale: number): void {
  for (let i = 0; i < points.length; i += 1) {
    const point = points[i] as Point;
    (points as Point[])[i] = { x: point.x * scale, y: point.y * scale };
  }
}

/** Re-exported so callers can size a channel block without importing protocol. */
export { MORPH_CHANNEL_COUNT };
