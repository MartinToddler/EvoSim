import { Graphics, Rectangle, Texture, type Renderer } from "pixi.js";
import { MORPH_CHANNEL_COUNT, MORPH_MAGNITUDE_SCALE, MorphChannel } from "@eon/protocol";
import { hueTint } from "../palette";
import { GEOMETRY_UNIT, buildMorphologyGeometry, type Point } from "./morphologyGeometry";

/**
 * Painting a developed body, and caching the result (M14, docs/11 §M14).
 *
 * ## Why a cache, and why it is bounded
 *
 * Generating a texture is far too expensive to do per organism per frame, and
 * morphology is continuous, so the number of distinct bodies a world can
 * contain is unbounded. Two facts make a small cache the right answer anyway:
 * a body never changes during a life, and relatives share one. So the cache is
 * keyed on the channel block itself — identical channels are drawn identically,
 * because nothing downstream of the engine is random — and it holds a fixed
 * number of entries with least-recently-used eviction.
 *
 * The cache is only ever consulted for organisms that reached the detail layer,
 * and that layer already has a hard budget, so the number of distinct keys
 * requested in one frame cannot exceed it. Sizing the cache above that budget
 * is what makes thrashing impossible rather than merely unlikely.
 *
 * ## Why the texture carries colour instead of being tinted
 *
 * A body has two pigments and a pattern between them. A single sprite tint can
 * only multiply one colour over the whole sprite, so the pattern would vanish.
 * The generated texture therefore bakes both hues, and health shading is
 * applied as a sprite tint on top — which darkens both pigments together and
 * leaves the inherited pattern readable, the same principle `organismTint`
 * already applies to hue.
 */

/**
 * Frame edge length, in texture units, for a generated body.
 *
 * `MORPH_MAGNITUDE_SCALE * GEOMETRY_UNIT` is the longest silhouette the wire
 * format can express, plus a small margin for the outline stroke. A frame
 * smaller than that would clip the longest lineages — and clipping is silent,
 * which is why the number is derived rather than chosen.
 *
 * Memory: at resolution 2 one texture is `(2 * 104)^2 * 4` bytes ≈ 173 KB, so
 * the default cache of {@link MORPH_TEXTURE_CACHE_LIMIT} entries costs about
 * 8 MB — bounded, and independent of population.
 */
export const MORPH_SPRITE_FRAME = MORPH_MAGNITUDE_SCALE * GEOMETRY_UNIT + 4;

/**
 * Default cache size.
 *
 * The cache is consulted only for organisms on the detail layer, which has a
 * hard budget, so this only has to exceed that budget for thrashing to be
 * impossible rather than merely unlikely.
 */
export const MORPH_TEXTURE_CACHE_LIMIT = 48;

/** Ink used for outlines, segment divisions and the eye. */
const INK = 0x0d1114;

/** Shade multipliers that keep plating and pattern legible against any hue. */
const PLATE_LIGHTEN = 1.35;
const PATTERN_MIN_MIX = 0.25;

function shade(color: number, factor: number): number {
  const r = Math.min(255, Math.round(((color >> 16) & 0xff) * factor));
  const g = Math.min(255, Math.round(((color >> 8) & 0xff) * factor));
  const b = Math.min(255, Math.round((color & 0xff) * factor));
  return (r << 16) | (g << 8) | b;
}

function tracePolygon(graphics: Graphics, points: readonly Point[]): void {
  if (points.length === 0) {
    return;
  }
  const first = points[0] as Point;
  graphics.moveTo(first.x, first.y);
  for (let i = 1; i < points.length; i += 1) {
    const point = points[i] as Point;
    graphics.lineTo(point.x, point.y);
  }
  graphics.closePath();
}

/**
 * Paint one developed body into `graphics`, in the geometry frame.
 *
 * Exported so the morphology gallery draws through exactly the production path
 * rather than through a parallel illustration of it.
 */
export function paintMorphology(graphics: Graphics, channels: ArrayLike<number>, base = 0): void {
  const geometry = buildMorphologyGeometry(channels, base);
  const primary = hueTint((channels[base + MorphChannel.PrimaryHueHalfDeg] as number) * 2);
  const secondary = hueTint((channels[base + MorphChannel.SecondaryHueHalfDeg] as number) * 2);
  const contrast =
    PATTERN_MIN_MIX +
    ((channels[base + MorphChannel.PigmentContrast] as number) / 255) * (1 - PATTERN_MIN_MIX);

  // Appendages first, so the trunk overlaps their roots and they read as
  // attached rather than as loose quads.
  for (const quad of geometry.appendages) {
    tracePolygon(graphics, quad);
    graphics.fill({ color: shade(primary, 0.78) });
  }

  tracePolygon(graphics, geometry.outline);
  graphics.fill({ color: primary });

  for (const band of geometry.patternBands) {
    tracePolygon(graphics, band);
    graphics.fill({ color: secondary, alpha: contrast });
  }

  for (const plate of geometry.plates) {
    tracePolygon(graphics, plate);
    graphics.fill({ color: shade(primary, PLATE_LIGHTEN), alpha: 0.85 });
    tracePolygon(graphics, plate);
    graphics.stroke({ color: INK, width: 0.5, alpha: 0.5 });
  }

  for (const [a, b] of geometry.segmentLines) {
    graphics.moveTo(a.x, a.y).lineTo(b.x, b.y);
  }
  if (geometry.segmentLines.length > 0) {
    graphics.stroke({ color: INK, width: 0.6, alpha: 0.45 });
  }

  tracePolygon(graphics, geometry.mouth);
  graphics.fill({ color: shade(primary, 0.5) });

  // Redraw the outline as a contour so the silhouette stays crisp over the
  // pattern and plating that were laid on top of it.
  tracePolygon(graphics, geometry.outline);
  graphics.stroke({ color: INK, width: 0.9, alpha: 0.8 });

  for (const sensor of geometry.sensors) {
    graphics.circle(sensor.at.x, sensor.at.y, sensor.radius).fill({ color: INK, alpha: 0.9 });
    graphics
      .circle(
        sensor.at.x + sensor.radius * 0.25,
        sensor.at.y - sensor.radius * 0.25,
        sensor.radius * 0.35,
      )
      .fill({ color: 0xffffff, alpha: 0.85 });
  }
}

/**
 * Bounded LRU of generated body textures.
 *
 * Keys are the channel bytes joined into a string. That is one small
 * allocation per lookup rather than per pixel, and it is the only key that is
 * exactly as precise as the drawing: two organisms whose channels differ in any
 * byte can draw differently, and two whose channels match cannot.
 */
export class MorphologyTextureCache {
  readonly capacity: number;
  readonly #renderer: Renderer;
  readonly #entries = new Map<string, Texture>();

  constructor(renderer: Renderer, capacity: number) {
    this.#renderer = renderer;
    this.capacity = Math.max(1, Math.trunc(capacity));
  }

  /** How many textures are currently resident. Diagnostics and tests. */
  get size(): number {
    return this.#entries.size;
  }

  /**
   * Texture for one organism's channel block, generating it on a miss.
   *
   * `Map` preserves insertion order, so re-inserting on a hit makes the first
   * key the least recently used one — an LRU without a second data structure.
   */
  acquire(channels: ArrayLike<number>, base: number): Texture {
    let key = "";
    for (let i = 0; i < MORPH_CHANNEL_COUNT; i += 1) {
      key += `${channels[base + i] as number},`;
    }
    const existing = this.#entries.get(key);
    if (existing !== undefined) {
      this.#entries.delete(key);
      this.#entries.set(key, existing);
      return existing;
    }

    const graphics = new Graphics();
    paintMorphology(graphics, channels, base);
    const texture = this.#renderer.generateTexture({
      target: graphics,
      frame: new Rectangle(
        -MORPH_SPRITE_FRAME / 2,
        -MORPH_SPRITE_FRAME / 2,
        MORPH_SPRITE_FRAME,
        MORPH_SPRITE_FRAME,
      ),
      resolution: 2,
      antialias: true,
    });
    graphics.destroy();

    if (this.#entries.size >= this.capacity) {
      const oldestKey = this.#entries.keys().next().value;
      if (oldestKey !== undefined) {
        this.#entries.get(oldestKey)?.destroy(true);
        this.#entries.delete(oldestKey);
      }
    }
    this.#entries.set(key, texture);
    return texture;
  }

  destroy(): void {
    for (const texture of this.#entries.values()) {
      texture.destroy(true);
    }
    this.#entries.clear();
  }
}

/**
 * Sprite scale that draws a body of `radiusLU` at its true size.
 *
 * A generated texture is {@link MORPH_SPRITE_FRAME} units wide and the geometry
 * inside it is {@link GEOMETRY_UNIT} units per adult radius, so a sprite at
 * scale `radiusLU / GEOMETRY_UNIT` puts one adult radius on exactly one radius
 * of world. Exported because the detail layer and the gallery both need it and
 * neither should re-derive it.
 */
export function morphSpriteScale(radiusLU: number): number {
  return radiusLU / GEOMETRY_UNIT;
}
