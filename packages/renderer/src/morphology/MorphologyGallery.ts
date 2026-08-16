import { Application, Container, Graphics } from "pixi.js";
import { paintMorphology } from "./drawMorphology";

/**
 * A grid of procedurally drawn bodies (M14, docs/11 §M14).
 *
 * The gallery lives in the renderer package for the same reason the world view
 * does: PixiJS is the renderer's dependency, and neither the app shell nor the
 * engine should acquire it to show a debug screen. What the caller supplies is
 * channel blocks — the exact bytes a render snapshot carries — and what it gets
 * back is the exact drawing the detail layer would produce for them, because
 * both go through {@link paintMorphology}.
 *
 * Like every other renderer surface this decides nothing: it is handed already
 * developed bodies and paints them.
 */

export interface MorphologyGalleryOptions {
  /** Where to mount the canvas. */
  host: HTMLElement;
  /** Edge length of one grid cell, in canvas pixels. */
  cellPx: number;
  /** Cells per row. */
  columns: number;
  /** Background colour, matching the app shell. */
  background: number;
}

export class MorphologyGallery {
  readonly #app = new Application();
  readonly #layer = new Container();
  readonly #options: MorphologyGalleryOptions;
  #ready = false;
  #destroyed = false;
  /** Bodies requested before init finished, drawn as soon as it does. */
  #pending: readonly Uint8Array[] | null = null;

  private constructor(options: MorphologyGalleryOptions) {
    this.#options = options;
  }

  /**
   * Create and mount a gallery.
   *
   * `Application.init` is asynchronous (Pixi 8 picks a WebGL or WebGPU backend
   * at runtime), so a gallery destroyed before it finishes must not mount a
   * canvas into a host React has already unmounted — hence the destroyed flag
   * rather than a bare await.
   */
  static async create(options: MorphologyGalleryOptions): Promise<MorphologyGallery> {
    const gallery = new MorphologyGallery(options);
    await gallery.#app.init({
      background: options.background,
      width: options.cellPx * options.columns,
      height: options.cellPx,
      antialias: true,
      autoDensity: true,
      resolution: globalThis.devicePixelRatio ?? 1,
    });
    if (gallery.#destroyed) {
      gallery.#app.destroy({ removeView: true }, { children: true });
      return gallery;
    }
    gallery.#app.stage.addChild(gallery.#layer);
    options.host.appendChild(gallery.#app.canvas);
    gallery.#ready = true;
    if (gallery.#pending !== null) {
      const pending = gallery.#pending;
      gallery.#pending = null;
      gallery.draw(pending);
    }
    return gallery;
  }

  /** Replace the grid with `bodies`, one channel block each. */
  draw(bodies: readonly Uint8Array[]): void {
    if (this.#destroyed) {
      return;
    }
    if (!this.#ready) {
      this.#pending = bodies;
      return;
    }
    const { cellPx, columns } = this.#options;
    for (const child of this.#layer.removeChildren()) {
      child.destroy({ children: true });
    }
    const rows = Math.max(1, Math.ceil(bodies.length / columns));
    this.#app.renderer.resize(cellPx * columns, cellPx * rows);

    // The painter draws in geometry units centred on the origin; one cell is
    // one body, so the scale is the cell divided by the frame it draws into.
    const scale = cellPx / GALLERY_FRAME_UNITS;
    bodies.forEach((channels, index) => {
      const graphics = new Graphics();
      paintMorphology(graphics, channels, 0);
      graphics.x = (index % columns) * cellPx + cellPx / 2;
      graphics.y = Math.floor(index / columns) * cellPx + cellPx / 2;
      graphics.scale.set(scale);
      this.#layer.addChild(graphics);
    });
  }

  destroy(): void {
    if (this.#destroyed) {
      return;
    }
    this.#destroyed = true;
    if (this.#ready) {
      this.#app.destroy({ removeView: true }, { children: true });
    }
  }
}

/**
 * Frame the gallery scales a cell against.
 *
 * Smaller than the full sprite frame on purpose: almost every body is far
 * shorter than the longest one the wire format can express, so scaling every
 * cell against the absolute maximum would draw a typical animal as a speck.
 * A body that exceeds this is drawn larger than its cell rather than clipped —
 * the grid has gutters, and the alternative is a lineage that looks amputated.
 */
const GALLERY_FRAME_UNITS = 44;
