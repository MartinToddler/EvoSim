import { describe, expect, it } from "vitest";
import { MORPH_CHANNEL_COUNT, MORPH_MAGNITUDE_SCALE, MorphChannel } from "@eon/protocol";
import { GEOMETRY_UNIT, buildMorphologyGeometry, type Point } from "./morphologyGeometry";
import { MORPH_SPRITE_FRAME } from "./drawMorphology";

/**
 * The widest body `DEFAULT_CONFIG` can grow, in adult radii, and the longest
 * tail as a multiple of the body length (`organism.morphology.bodyLengthMaxQ`
 * = 9830/4096 and `tailLengthMaxQ` = 4506/4096).
 *
 * Restated here rather than imported: the renderer does not depend on the
 * engine, and the point of the assertion is that the two agree.
 */
const DEFAULT_MAX_BODY_LENGTH_RADII = 9830 / 4096;
const DEFAULT_MAX_TAIL_MULTIPLE = 4506 / 4096;

/** A middling body: every channel at half, with plausible small counts. */
function baseChannels(): Uint8Array {
  const channels = new Uint8Array(MORPH_CHANNEL_COUNT).fill(128);
  channels[MorphChannel.SegmentCount] = 2;
  channels[MorphChannel.AppendagePairs] = 2;
  channels[MorphChannel.PatternFrequency] = 0;
  // Extents decode against the wire scale, so half a byte is 5 radii — far too
  // long for a default. 41 is the founder's body length (1.63 radii).
  channels[MorphChannel.BodyLength] = 41;
  channels[MorphChannel.BodyWidth] = 25;
  channels[MorphChannel.AppendageLength] = 10;
  channels[MorphChannel.TailLength] = 8;
  return channels;
}

function allPoints(channels: Uint8Array): Point[] {
  const geometry = buildMorphologyGeometry(channels);
  return [
    ...geometry.outline,
    ...geometry.appendages.flat(),
    ...geometry.plates.flat(),
    ...geometry.patternBands.flat(),
    ...geometry.mouth,
    ...geometry.segmentLines.flat(),
    ...geometry.sensors.map((sensor) => sensor.at),
  ];
}

describe("procedural body geometry (M14)", () => {
  it("is deterministic: the same channels give byte-identical geometry", () => {
    const channels = baseChannels();
    expect(JSON.stringify(buildMorphologyGeometry(channels))).toBe(
      JSON.stringify(buildMorphologyGeometry(channels)),
    );
  });

  it("produces a closed trunk outline with both sides sampled", () => {
    const geometry = buildMorphologyGeometry(baseChannels());
    expect(geometry.outline.length).toBeGreaterThan(8);
    const rightSide = geometry.outline.filter((point) => point.y > 0.01);
    const leftSide = geometry.outline.filter((point) => point.y < -0.01);
    expect(rightSide.length).toBeGreaterThan(0);
    expect(leftSide.length).toBe(rightSide.length);
  });

  it("never leaves the sprite frame, for any channel combination at all", () => {
    // The renderer must survive the whole wire range, including bytes no legal
    // config can emit; a body that would overflow is shrunk to fit rather than
    // clipped, because clipping silently amputates a tail.
    const half = MORPH_SPRITE_FRAME / 2;
    const extremes = [0, 1, 64, 128, 200, 255];
    for (const value of extremes) {
      const channels = new Uint8Array(MORPH_CHANNEL_COUNT).fill(value);
      channels[MorphChannel.SegmentCount] = 5;
      channels[MorphChannel.AppendagePairs] = 4;
      channels[MorphChannel.PatternFrequency] = 6;
      for (const point of allPoints(channels)) {
        expect(Number.isFinite(point.x)).toBe(true);
        expect(Number.isFinite(point.y)).toBe(true);
        expect(Math.abs(point.x)).toBeLessThanOrEqual(half);
        expect(Math.abs(point.y)).toBeLessThanOrEqual(half);
      }
    }
  });

  it("never shrinks a body the engine can actually grow", () => {
    // `validateConfig` bounds the expressible silhouette below the frame, so
    // the fit guard must be inert for every real organism. If this fails the
    // config bound and the frame have drifted apart and bodies are being
    // silently rescaled.
    const maxBodyLength = Math.round((DEFAULT_MAX_BODY_LENGTH_RADII * 255) / 10);
    const maxTail = Math.round((DEFAULT_MAX_TAIL_MULTIPLE * 255) / 10);
    for (const value of [0, 64, 128, 200, 255]) {
      const channels = new Uint8Array(MORPH_CHANNEL_COUNT).fill(value);
      channels[MorphChannel.SegmentCount] = 5;
      channels[MorphChannel.AppendagePairs] = 4;
      channels[MorphChannel.PatternFrequency] = 6;
      channels[MorphChannel.BodyLength] = Math.min(value, maxBodyLength);
      channels[MorphChannel.BodyWidth] = Math.min(value, maxBodyLength);
      channels[MorphChannel.TailLength] = Math.min(value, maxTail);
      channels[MorphChannel.AppendageLength] = Math.min(value, maxTail);
      expect(buildMorphologyGeometry(channels).fitScale).toBe(1);
    }
  });

  it("decodes body extents through the shared wire scale", () => {
    const channels = baseChannels();
    channels[MorphChannel.BodyLength] = 51; // 51/255 * 10 = 2.0 radii
    channels[MorphChannel.HeadProportion] = 0;
    channels[MorphChannel.TailLength] = 0;
    const geometry = buildMorphologyGeometry(channels);
    // Half the trunk plus a head of zero extent: the nose sits at one radius.
    expect(geometry.halfLength).toBeCloseTo(GEOMETRY_UNIT, 6);
    expect(MORPH_MAGNITUDE_SCALE).toBe(10);
  });

  it("grows the silhouette when the body-length channel grows", () => {
    const short = baseChannels();
    const long = baseChannels();
    long[MorphChannel.BodyLength] = 80;
    expect(buildMorphologyGeometry(long).halfLength).toBeGreaterThan(
      buildMorphologyGeometry(short).halfLength,
    );
  });

  it("draws exactly the structural counts it was given", () => {
    for (let pairs = 0; pairs <= 4; pairs += 1) {
      const channels = baseChannels();
      channels[MorphChannel.AppendagePairs] = pairs;
      // Two quads per pair, left and right.
      expect(buildMorphologyGeometry(channels).appendages).toHaveLength(pairs * 2);
    }
    for (let segments = 1; segments <= 5; segments += 1) {
      const channels = baseChannels();
      channels[MorphChannel.SegmentCount] = segments;
      expect(buildMorphologyGeometry(channels).segmentLines).toHaveLength(segments - 1);
    }
    for (let frequency = 0; frequency <= 6; frequency += 1) {
      const channels = baseChannels();
      channels[MorphChannel.PatternFrequency] = frequency;
      expect(buildMorphologyGeometry(channels).patternBands).toHaveLength(frequency);
    }
  });

  it("draws no appendages when the length channel is zero, however many pairs there are", () => {
    const channels = baseChannels();
    channels[MorphChannel.AppendagePairs] = 4;
    channels[MorphChannel.AppendageLength] = 0;
    expect(buildMorphologyGeometry(channels).appendages).toHaveLength(0);
  });

  it("makes a small channel change a small geometry change", () => {
    // Relatives differ by a nudge, so the drawing must not be chaotic in the
    // channels: a one-byte change that moved the silhouette by a body length
    // would make inheritance invisible.
    const base = baseChannels();
    const nudged = baseChannels();
    nudged[MorphChannel.BodyWidth] = (base[MorphChannel.BodyWidth] as number) + 1;
    const a = buildMorphologyGeometry(base);
    const b = buildMorphologyGeometry(nudged);
    expect(Math.abs(a.halfWidth - b.halfWidth)).toBeLessThan(GEOMETRY_UNIT * 0.25);
    expect(a.outline).toHaveLength(b.outline.length);
  });
});
