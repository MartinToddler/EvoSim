/**
 * World camera (task G08, docs/06 §5).
 *
 * Deliberately a plain class with no Pixi, no DOM and no event handling: the
 * camera is pure geometry, so its behaviour — that zooming keeps the point
 * under the cursor still, that panning cannot lose the world off-screen, that
 * a fitted world is actually fitted — is unit-testable without a browser.
 * `EonRenderer` reads it and applies it to a Pixi container; input handlers
 * push into it. Nothing else.
 *
 * Camera state is non-authoritative (docs/02 §9): it is never saved, never
 * hashed, and cannot influence the simulation.
 *
 * ## Coordinate systems
 *
 * - **World** — location units (LU). The simulation's own units, `0 … sizeLU`.
 * - **Screen** — CSS pixels inside the canvas, origin top-left.
 *
 * `zoom` is the conversion factor: screen pixels per location unit.
 */
export interface CameraState {
  /** World point at the centre of the viewport. */
  centerXLU: number;
  centerYLU: number;
  /** Screen pixels per location unit. */
  zoom: number;
}

export class Camera {
  readonly worldSizeLU: number;

  #viewportWidth = 1;
  #viewportHeight = 1;
  #centerXLU: number;
  #centerYLU: number;
  #zoom = 1;

  /**
   * Hard zoom ceiling.
   *
   * At 64 px/LU a 2 LU organism is 128 px across, which is far past the point
   * where a coarse 256² terrain texture stops carrying information. Zooming
   * further would only magnify texels.
   */
  static readonly MAX_ZOOM = 64;

  constructor(worldSizeLU: number) {
    this.worldSizeLU = worldSizeLU;
    this.#centerXLU = worldSizeLU / 2;
    this.#centerYLU = worldSizeLU / 2;
  }

  get viewportWidth(): number {
    return this.#viewportWidth;
  }

  get viewportHeight(): number {
    return this.#viewportHeight;
  }

  get centerXLU(): number {
    return this.#centerXLU;
  }

  get centerYLU(): number {
    return this.#centerYLU;
  }

  get zoom(): number {
    return this.#zoom;
  }

  /**
   * Smallest zoom that still fills the viewport in at least one axis.
   *
   * Used as the lower bound so the world can never shrink into a small island
   * surrounded by void. On a viewport more extreme in aspect than the (square)
   * world, one axis will show beyond the world edge; that is the honest result
   * of fitting, and the alternative — cropping — hides part of the world.
   */
  get minZoom(): number {
    return Math.min(this.#viewportWidth, this.#viewportHeight) / this.worldSizeLU;
  }

  /** Resize the viewport, keeping the world visible. */
  setViewport(widthPx: number, heightPx: number): void {
    this.#viewportWidth = Math.max(1, widthPx);
    this.#viewportHeight = Math.max(1, heightPx);
    this.#clampZoom();
    this.#clampCenter();
  }

  /** Frame the whole world. */
  fitWorld(): void {
    this.#zoom = this.minZoom;
    this.#centerXLU = this.worldSizeLU / 2;
    this.#centerYLU = this.worldSizeLU / 2;
    this.#clampCenter();
  }

  /** Centre on a world point, respecting the edge clamp. */
  centerOn(xLU: number, yLU: number): void {
    this.#centerXLU = xLU;
    this.#centerYLU = yLU;
    this.#clampCenter();
  }

  /** Pan by a screen-space delta, as a drag does. */
  panByScreen(dxPx: number, dyPx: number): void {
    this.#centerXLU -= dxPx / this.#zoom;
    this.#centerYLU -= dyPx / this.#zoom;
    this.#clampCenter();
  }

  /**
   * Multiply the zoom while keeping the world point under `(screenX, screenY)`
   * exactly where it is.
   *
   * This is what makes wheel zoom feel like zooming rather than teleporting: the
   * thing the pointer is over is the thing that stays put. Implemented by
   * solving for the centre that maps the same world point to the same screen
   * point at the new zoom, rather than by nudging the centre toward the cursor.
   */
  zoomAroundScreen(screenX: number, screenY: number, factor: number): void {
    const before = this.screenToWorld(screenX, screenY);
    this.#zoom = this.#clampZoomValue(this.#zoom * factor);
    const after = this.screenToWorld(screenX, screenY);
    this.#centerXLU += before.xLU - after.xLU;
    this.#centerYLU += before.yLU - after.yLU;
    this.#clampCenter();
  }

  /** Set an absolute zoom, anchored on the viewport centre. */
  setZoom(zoom: number): void {
    this.#zoom = this.#clampZoomValue(zoom);
    this.#clampCenter();
  }

  screenToWorld(screenX: number, screenY: number): { xLU: number; yLU: number } {
    return {
      xLU: this.#centerXLU + (screenX - this.#viewportWidth / 2) / this.#zoom,
      yLU: this.#centerYLU + (screenY - this.#viewportHeight / 2) / this.#zoom,
    };
  }

  worldToScreen(xLU: number, yLU: number): { x: number; y: number } {
    return {
      x: (xLU - this.#centerXLU) * this.#zoom + this.#viewportWidth / 2,
      y: (yLU - this.#centerYLU) * this.#zoom + this.#viewportHeight / 2,
    };
  }

  /** World-space rectangle currently visible, for culling. */
  visibleBounds(): { minXLU: number; minYLU: number; maxXLU: number; maxYLU: number } {
    const halfWidth = this.#viewportWidth / 2 / this.#zoom;
    const halfHeight = this.#viewportHeight / 2 / this.#zoom;
    return {
      minXLU: this.#centerXLU - halfWidth,
      minYLU: this.#centerYLU - halfHeight,
      maxXLU: this.#centerXLU + halfWidth,
      maxYLU: this.#centerYLU + halfHeight,
    };
  }

  state(): CameraState {
    return { centerXLU: this.#centerXLU, centerYLU: this.#centerYLU, zoom: this.#zoom };
  }

  #clampZoomValue(zoom: number): number {
    if (!Number.isFinite(zoom)) {
      return this.#zoom;
    }
    return Math.min(Camera.MAX_ZOOM, Math.max(this.minZoom, zoom));
  }

  #clampZoom(): void {
    this.#zoom = this.#clampZoomValue(this.#zoom);
  }

  /**
   * Keep the viewport over the world.
   *
   * When the world is wider than the viewport the centre is bounded so the edge
   * never comes inside; when the viewport is wider than the world (possible on
   * one axis at minimum zoom) the world is centred instead, because there is no
   * pan position that would fill the axis.
   */
  #clampCenter(): void {
    const halfWidth = this.#viewportWidth / 2 / this.#zoom;
    const halfHeight = this.#viewportHeight / 2 / this.#zoom;

    this.#centerXLU =
      halfWidth * 2 >= this.worldSizeLU
        ? this.worldSizeLU / 2
        : Math.min(this.worldSizeLU - halfWidth, Math.max(halfWidth, this.#centerXLU));
    this.#centerYLU =
      halfHeight * 2 >= this.worldSizeLU
        ? this.worldSizeLU / 2
        : Math.min(this.worldSizeLU - halfHeight, Math.max(halfHeight, this.#centerYLU));
  }
}
