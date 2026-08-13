import {
  Application,
  BufferImageSource,
  Container,
  Graphics,
  Particle,
  ParticleContainer,
  Sprite,
  Texture,
} from "pixi.js";
import {
  readRenderSnapshotCounts,
  type RenderSnapshotView,
  type TerrainSnapshotView,
  type VegetationSnapshotView,
} from "@eon/protocol";
import { Camera } from "./Camera";
import { CARCASS_TINT, SELECTION_TINT, composeTerrainRgba, organismTint } from "./palette";
import { findOrganismIndex, pickOrganism, type PickResult } from "./selection/pickOrganism";
import { SPRITE_FRAME, createRendererTextures, type RendererTextures } from "./textures";

/**
 * PixiJS world renderer (tasks G05-G10, docs/06 §§1-6, docs/10 §§22, 24).
 *
 * ## A projection, and only a projection
 *
 * This class decides nothing. It never computes a position, never resolves a
 * feeding claim, never kills anything. It receives packed snapshots of state
 * that has already happened and paints them; selection sends an entity ID back
 * and the Worker answers. There is no code path from here into authoritative
 * state (CLAUDE.md renderer boundary), and the package cannot even import the
 * engine — it depends on `@eon/protocol` alone (docs/02 §4).
 *
 * ## Render frequency is independent of simulation frequency
 *
 * Pixi draws on `requestAnimationFrame`, the simulation ticks in a Worker on
 * its own schedule, and neither knows the other's rate. A 144 Hz monitor does
 * not speed up evolution and a 30 Hz one does not slow it down; frames simply
 * repaint whatever the most recent snapshot said. When frames outrun snapshots
 * the same picture is drawn twice, which is correct.
 *
 * ## Object lifetime
 *
 * Every particle, sprite and texture is created once in the constructor and
 * reused for the life of the world (docs/10 §24). A snapshot updates fields on
 * existing objects; nothing is created or destroyed per frame. The particle
 * pools are sized from the engine's own population and carcass caps, so they
 * cannot be outgrown.
 */

/**
 * Smallest radius, in screen pixels, at which an organism is still drawn.
 *
 * At full-world zoom a 2 LU animal is about one pixel across and effectively
 * invisible. docs/06 §3 puts that in LOD 0 — "point, tint only" — and this
 * constant is what makes such a point actually a point rather than a
 * sub-pixel smear. It exaggerates size when zoomed out; that is the intended
 * trade, and it affects nothing but pixels.
 */
const MIN_SCREEN_RADIUS_PX = 1.6;

/** Screen radius above which an organism is eligible for the detail layer. */
const DETAIL_MIN_SCREEN_RADIUS_PX = 7;

/** Maximum extra elongation applied to the fastest genomes (docs/06 §4). */
const MAX_ELONGATION = 1.35;

/** Click tolerance in screen pixels, converted to world units at pick time. */
const PICK_TOLERANCE_PX = 8;

/** Drag distance beyond which a pointer gesture stops counting as a click. */
const CLICK_SLOP_PX = 5;

export interface EonRendererOptions {
  canvas: HTMLCanvasElement;
  worldSizeLU: number;
  gridSize: number;
  maxOrganisms: number;
  maxCarcasses: number;
  maxDetailedOrganisms: number;
  /** Called when the user clicks an organism, or empty space (`null`). */
  onSelectionChange: (entityId: number | null) => void;
  /** Hands a spent snapshot buffer back so the Worker can refill it. */
  onRecycleRenderBuffer: (buffer: ArrayBuffer) => void;
  /** Hands a spent vegetation buffer back. */
  onRecycleVegetationBuffer: (buffer: ArrayBuffer) => void;
}

export interface RendererStats {
  drawnOrganisms: number;
  drawnCarcasses: number;
  detailedOrganisms: number;
  snapshotTick: number;
  zoom: number;
  fps: number;
}

export class EonRenderer {
  readonly camera: Camera;

  readonly #app: Application;
  readonly #canvas: HTMLCanvasElement;
  readonly #textures: RendererTextures;
  readonly #options: EonRendererOptions;

  /** Camera-transformed root; every child below uses world location units. */
  readonly #worldLayer = new Container();
  readonly #terrainSprite: Sprite;
  readonly #terrainSource: BufferImageSource;
  readonly #terrainPixels: Uint8Array;
  readonly #biome: Uint8Array;
  readonly #elevation: Uint8Array;

  readonly #carcassLayer: ParticleContainer;
  readonly #carcassPool: Particle[] = [];
  readonly #organismLayer: ParticleContainer;
  readonly #organismPool: Particle[] = [];
  readonly #detailLayer = new Container();
  readonly #detailPool: Sprite[] = [];
  readonly #selectionLayer = new Graphics();
  readonly #debugLayer = new Graphics();

  #snapshot: RenderSnapshotView | null = null;
  #organismCount = 0;
  #carcassCount = 0;
  #snapshotTick = 0;
  #detailedCount = 0;

  #selectedEntityId: number | null = null;
  #debugEnabled = false;
  #destroyed = false;

  /** Set whenever the picture must be rebuilt: new snapshot or camera change. */
  #visualDirty = true;

  // Pointer gesture state.
  readonly #activePointers = new Map<number, { x: number; y: number }>();
  #dragPointerId: number | null = null;
  #dragLastX = 0;
  #dragLastY = 0;
  #dragTravel = 0;
  #pinchDistance = 0;

  private constructor(app: Application, options: EonRendererOptions) {
    this.#app = app;
    this.#canvas = options.canvas;
    this.#options = options;
    this.camera = new Camera(options.worldSizeLU);
    this.#textures = createRendererTextures(app.renderer);

    // --- Terrain ------------------------------------------------------------
    const cells = options.gridSize * options.gridSize;
    this.#biome = new Uint8Array(cells);
    this.#elevation = new Uint8Array(cells);
    this.#terrainPixels = new Uint8Array(cells * 4);
    this.#terrainSource = new BufferImageSource({
      resource: this.#terrainPixels,
      width: options.gridSize,
      height: options.gridSize,
      // Linear keeps a 256² field from looking like a spreadsheet when a
      // 4096 LU world is stretched across a monitor. Biome edges blur by half a
      // cell, which is honest: the underlying data really is that coarse.
      scaleMode: "linear",
      alphaMode: "premultiply-alpha-on-upload",
    });
    this.#terrainSprite = new Sprite(new Texture({ source: this.#terrainSource }));
    this.#terrainSprite.width = options.worldSizeLU;
    this.#terrainSprite.height = options.worldSizeLU;

    // --- Entity layers ------------------------------------------------------
    // Carcasses below organisms: a body being eaten should be under the eater.
    this.#carcassLayer = new ParticleContainer({
      texture: this.#textures.carcass,
      dynamicProperties: { position: true, vertex: true, rotation: false, uvs: false, color: true },
    });
    this.#organismLayer = new ParticleContainer({
      texture: this.#textures.body,
      dynamicProperties: { position: true, vertex: true, rotation: true, uvs: false, color: true },
    });
    for (let i = 0; i < options.maxCarcasses; i += 1) {
      const particle = new Particle({ texture: this.#textures.carcass });
      particle.anchorX = 0.5;
      particle.anchorY = 0.5;
      particle.tint = CARCASS_TINT;
      this.#carcassPool.push(particle);
    }
    for (let i = 0; i < options.maxOrganisms; i += 1) {
      const particle = new Particle({ texture: this.#textures.body });
      particle.anchorX = 0.5;
      particle.anchorY = 0.5;
      this.#organismPool.push(particle);
    }
    for (let i = 0; i < options.maxDetailedOrganisms; i += 1) {
      const sprite = new Sprite(this.#textures.detail);
      sprite.anchor.set(0.5);
      sprite.visible = false;
      this.#detailPool.push(sprite);
      this.#detailLayer.addChild(sprite);
    }

    this.#worldLayer.addChild(
      this.#terrainSprite,
      this.#carcassLayer,
      this.#organismLayer,
      this.#detailLayer,
      this.#debugLayer,
    );
    app.stage.addChild(this.#worldLayer);
    // The selection ring lives in SCREEN space, above the camera transform.
    // Drawn inside the world layer it is tessellated at world scale — a ring
    // two location units across becomes a visible hexagon once the camera is
    // zoomed in far enough to be worth looking at. In screen space its radius
    // is in pixels, so it is round at every zoom and its stroke is exactly the
    // width asked for.
    app.stage.addChild(this.#selectionLayer);

    this.camera.setViewport(app.renderer.width, app.renderer.height);
    this.camera.fitWorld();

    this.#attachInput();
    app.ticker.add(this.#onFrame);
  }

  /**
   * Create a renderer bound to `canvas`.
   *
   * WebGL is requested explicitly rather than letting Pixi prefer WebGPU:
   * docs/02 §5 makes WebGPU optional and requires the fallback path to keep
   * working, and WebGL is the one every target browser has.
   */
  static async create(options: EonRendererOptions): Promise<EonRenderer> {
    const app = new Application();
    await app.init({
      canvas: options.canvas,
      preference: "webgl",
      antialias: true,
      background: 0x080c10,
      resolution: globalThis.devicePixelRatio > 0 ? globalThis.devicePixelRatio : 1,
      autoDensity: true,
      powerPreference: "high-performance",
    });
    return new EonRenderer(app, options);
  }

  // --- Inbound data ----------------------------------------------------------

  /** Adopt the one-off terrain field sent with WORLD_READY. */
  applyTerrain(view: TerrainSnapshotView): void {
    this.#biome.set(view.biome.subarray(0, this.#biome.length));
    this.#elevation.set(view.elevation.subarray(0, this.#elevation.length));
    composeTerrainRgba(this.#biome, this.#elevation, view.vegetation, this.#terrainPixels);
    this.#terrainSource.update();
  }

  /**
   * Repaint vegetation into the terrain texture and hand the buffer back.
   *
   * The buffer is recycled immediately: the field is consumed here and now, so
   * holding it would only shrink the Worker's pool.
   */
  applyVegetation(view: VegetationSnapshotView): void {
    composeTerrainRgba(this.#biome, this.#elevation, view.vegetation, this.#terrainPixels);
    this.#terrainSource.update();
    this.#options.onRecycleVegetationBuffer(view.buffer);
  }

  /**
   * Adopt a render snapshot, recycling the previous one.
   *
   * The current snapshot is held rather than copied out and released: hit
   * testing and zoom-driven rescaling both need the columns after the frame
   * that delivered them, and holding one buffer is cheaper than copying five
   * columns on every snapshot. The pool is sized for it — the Worker keeps
   * filling the others.
   */
  applyRenderSnapshot(view: RenderSnapshotView): void {
    const previous = this.#snapshot;
    this.#snapshot = view;
    const counts = readRenderSnapshotCounts(view);
    this.#organismCount = counts.organismCount;
    this.#carcassCount = counts.carcassCount;
    this.#snapshotTick = counts.tick;
    this.#visualDirty = true;
    if (previous !== null) {
      this.#options.onRecycleRenderBuffer(previous.buffer);
    }
  }

  // --- View control ----------------------------------------------------------

  resize(widthPx: number, heightPx: number): void {
    if (this.#destroyed) {
      return;
    }
    this.#app.renderer.resize(widthPx, heightPx);
    this.camera.setViewport(widthPx, heightPx);
    this.#visualDirty = true;
  }

  setSelected(entityId: number | null): void {
    this.#selectedEntityId = entityId;
    this.#visualDirty = true;
  }

  get selectedEntityId(): number | null {
    return this.#selectedEntityId;
  }

  setDebugOverlay(enabled: boolean): void {
    this.#debugEnabled = enabled;
    this.#debugLayer.visible = enabled;
    this.#visualDirty = true;
  }

  /** Centre the camera on an entity present in the current snapshot. */
  focusEntity(entityId: number): boolean {
    const view = this.#snapshot;
    if (view === null) {
      return false;
    }
    const index = findOrganismIndex(view, this.#organismCount, entityId);
    if (index < 0) {
      return false;
    }
    this.camera.centerOn(view.organismX[index] as number, view.organismY[index] as number);
    this.#visualDirty = true;
    return true;
  }

  stats(): RendererStats {
    return {
      drawnOrganisms: this.#organismCount,
      drawnCarcasses: this.#carcassCount,
      detailedOrganisms: this.#detailedCount,
      snapshotTick: this.#snapshotTick,
      zoom: this.camera.zoom,
      fps: this.#app.ticker.FPS,
    };
  }

  destroy(): void {
    if (this.#destroyed) {
      return;
    }
    this.#destroyed = true;
    this.#detachInput();
    this.#app.ticker.remove(this.#onFrame);
    // Hand back whatever we still hold, so a restarted session does not begin
    // with a pool that has silently lost a buffer.
    if (this.#snapshot !== null) {
      this.#options.onRecycleRenderBuffer(this.#snapshot.buffer);
      this.#snapshot = null;
    }
    // Scene first, then the textures it referenced. `texture: false` keeps Pixi
    // from destroying them underneath us; doing it in the other order would
    // free textures that particles still point at.
    this.#app.destroy({ removeView: false }, { children: true, texture: false });
    this.#textures.destroy();
  }

  // --- Frame -----------------------------------------------------------------

  readonly #onFrame = (): void => {
    if (this.#destroyed) {
      return;
    }
    this.#applyCamera();
    if (this.#visualDirty) {
      this.#syncCarcasses();
      this.#syncOrganisms();
      this.#syncDetail();
      this.#drawSelection();
      if (this.#debugEnabled) {
        this.#drawDebug();
      }
      this.#visualDirty = false;
    }
  };

  #applyCamera(): void {
    const zoom = this.camera.zoom;
    const layer = this.#worldLayer;
    const x = this.camera.viewportWidth / 2 - this.camera.centerXLU * zoom;
    const y = this.camera.viewportHeight / 2 - this.camera.centerYLU * zoom;
    if (layer.scale.x !== zoom || layer.position.x !== x || layer.position.y !== y) {
      layer.scale.set(zoom);
      layer.position.set(x, y);
      // Sprite scale is derived from zoom (the minimum-size floor), so a camera
      // move invalidates the particle columns too.
      this.#visualDirty = true;
    }
  }

  /**
   * Resize a particle container's child list without allocating a new array.
   *
   * `ParticleContainer` draws exactly `particleChildren.length` particles, so
   * this is how the drawn count follows the population. The pool objects
   * themselves are never discarded — only the slice of them that is currently
   * on screen changes.
   */
  static #fitChildren(container: ParticleContainer, pool: Particle[], count: number): void {
    const children = container.particleChildren;
    if (children.length > count) {
      children.length = count;
    } else {
      while (children.length < count) {
        children.push(pool[children.length] as Particle);
      }
    }
    container.update();
  }

  #syncOrganisms(): void {
    const view = this.#snapshot;
    const count = view === null ? 0 : Math.min(this.#organismCount, this.#organismPool.length);
    if (view !== null) {
      const minRadiusLU = MIN_SCREEN_RADIUS_PX / this.camera.zoom;
      for (let i = 0; i < count; i += 1) {
        const particle = this.#organismPool[i] as Particle;
        particle.x = view.organismX[i] as number;
        particle.y = view.organismY[i] as number;
        particle.rotation = view.organismRotation[i] as number;

        const radiusLU = Math.max(view.organismRadiusLU[i] as number, minRadiusLU);
        // Speed stretches the body along its heading and narrows it across:
        // the docs/06 §4 "speed -> elongation" mapping, applied so total area
        // stays roughly constant and fast animals read as streamlined rather
        // than simply bigger.
        const elongation = 1 + ((view.organismSpeed[i] as number) / 255) * (MAX_ELONGATION - 1);
        particle.scaleX = ((radiusLU * 2) / SPRITE_FRAME) * elongation;
        particle.scaleY = (radiusLU * 2) / SPRITE_FRAME / elongation;
        particle.tint = organismTint(
          view.organismHueDeg[i] as number,
          view.organismHealth[i] as number,
        );
      }
    }
    EonRenderer.#fitChildren(this.#organismLayer, this.#organismPool, count);
  }

  #syncCarcasses(): void {
    const view = this.#snapshot;
    const count = view === null ? 0 : Math.min(this.#carcassCount, this.#carcassPool.length);
    if (view !== null) {
      const minRadiusLU = MIN_SCREEN_RADIUS_PX / this.camera.zoom;
      for (let i = 0; i < count; i += 1) {
        const particle = this.#carcassPool[i] as Particle;
        particle.x = view.carcassX[i] as number;
        particle.y = view.carcassY[i] as number;
        const radiusLU = Math.max(view.carcassRadiusLU[i] as number, minRadiusLU);
        const scale = (radiusLU * 2) / SPRITE_FRAME;
        particle.scaleX = scale;
        particle.scaleY = scale;
      }
    }
    EonRenderer.#fitChildren(this.#carcassLayer, this.#carcassPool, count);
  }

  /**
   * Promote the largest on-screen organisms to the detail layer (docs/06 §3).
   *
   * The budget is a hard cap from host runtime configuration, so the cost of
   * this layer cannot grow with population. Promotion is by screen size and
   * visibility; the selected organism is promoted first whatever its size,
   * because the thing the user is looking at is the thing that should be
   * legible.
   */
  #syncDetail(): void {
    const view = this.#snapshot;
    const budget = this.#detailPool.length;
    let used = 0;

    if (view !== null && this.camera.zoom > 0) {
      const bounds = this.camera.visibleBounds();
      const minRadiusLU = DETAIL_MIN_SCREEN_RADIUS_PX / this.camera.zoom;
      const selectedIndex =
        this.#selectedEntityId === null
          ? -1
          : findOrganismIndex(view, this.#organismCount, this.#selectedEntityId);

      const promote = (i: number): void => {
        const sprite = this.#detailPool[used] as Sprite;
        used += 1;
        sprite.visible = true;
        sprite.x = view.organismX[i] as number;
        sprite.y = view.organismY[i] as number;
        sprite.rotation = view.organismRotation[i] as number;
        const radiusLU = view.organismRadiusLU[i] as number;
        const elongation = 1 + ((view.organismSpeed[i] as number) / 255) * (MAX_ELONGATION - 1);
        sprite.scale.set(
          ((radiusLU * 2) / SPRITE_FRAME) * elongation,
          (radiusLU * 2) / SPRITE_FRAME / elongation,
        );
      };

      if (selectedIndex >= 0) {
        promote(selectedIndex);
      }
      const count = Math.min(this.#organismCount, view.organismId.length);
      for (let i = 0; i < count && used < budget; i += 1) {
        if (i === selectedIndex) {
          continue;
        }
        if ((view.organismRadiusLU[i] as number) < minRadiusLU) {
          continue;
        }
        const x = view.organismX[i] as number;
        const y = view.organismY[i] as number;
        if (x < bounds.minXLU || x > bounds.maxXLU || y < bounds.minYLU || y > bounds.maxYLU) {
          continue;
        }
        promote(i);
      }
    }

    for (let i = used; i < this.#detailPool.length; i += 1) {
      const sprite = this.#detailPool[i] as Sprite;
      if (!sprite.visible) {
        break;
      }
      sprite.visible = false;
    }
    this.#detailedCount = used;
  }

  #drawSelection(): void {
    const graphics = this.#selectionLayer;
    graphics.clear();
    const view = this.#snapshot;
    if (view === null || this.#selectedEntityId === null) {
      return;
    }
    const index = findOrganismIndex(view, this.#organismCount, this.#selectedEntityId);
    if (index < 0) {
      // Selected organism is not in this frame — it died, or it fell outside a
      // truncated snapshot. Draw nothing rather than a ring on a stale spot.
      return;
    }
    const radiusPx = Math.max(
      (view.organismRadiusLU[index] as number) * this.camera.zoom,
      MIN_SCREEN_RADIUS_PX,
    );
    const centre = this.camera.worldToScreen(
      view.organismX[index] as number,
      view.organismY[index] as number,
    );
    // A 9 px floor keeps the ring findable when the organism itself is one
    // pixel at world zoom: the selection has to be visible even when the thing
    // selected is not.
    graphics
      .circle(centre.x, centre.y, Math.max(9, radiusPx * 1.9 + 3))
      .stroke({ color: SELECTION_TINT, width: 1.5, alpha: 0.95 });
  }

  /**
   * Development overlay (task G10, docs/06 §18).
   *
   * Intentionally minimal for Milestone 6: the environment cell grid and the
   * world boundary, which together make "where is a cell edge" and "where does
   * the world stop" visible while tuning. Vision cones, sensed-target lines and
   * per-organism annotations need per-organism data that the render snapshot
   * deliberately does not carry, so they arrive with the inspector work that
   * needs them anyway.
   */
  #drawDebug(): void {
    const graphics = this.#debugLayer;
    graphics.clear();
    const size = this.#options.worldSizeLU;
    const cellSizeLU = size / this.#options.gridSize;
    const bounds = this.camera.visibleBounds();
    const lineWidth = 1 / this.camera.zoom;

    // One grid line per environment cell would be 256 lines over the whole
    // world; step up when zoomed out so the overlay stays readable.
    const targetSpacingPx = 48;
    const cellsPerLine = Math.max(1, Math.ceil(targetSpacingPx / (cellSizeLU * this.camera.zoom)));
    const step = cellSizeLU * cellsPerLine;

    const firstX = Math.floor(Math.max(0, bounds.minXLU) / step) * step;
    for (let x = firstX; x <= Math.min(size, bounds.maxXLU); x += step) {
      graphics.moveTo(x, Math.max(0, bounds.minYLU)).lineTo(x, Math.min(size, bounds.maxYLU));
    }
    const firstY = Math.floor(Math.max(0, bounds.minYLU) / step) * step;
    for (let y = firstY; y <= Math.min(size, bounds.maxYLU); y += step) {
      graphics.moveTo(Math.max(0, bounds.minXLU), y).lineTo(Math.min(size, bounds.maxXLU), y);
    }
    graphics.stroke({ color: 0x64d0ff, width: lineWidth, alpha: 0.22 });

    graphics.rect(0, 0, size, size).stroke({ color: 0xff9c40, width: lineWidth * 2, alpha: 0.8 });
  }

  // --- Input -----------------------------------------------------------------

  #attachInput(): void {
    const canvas = this.#canvas;
    canvas.addEventListener("wheel", this.#onWheel, { passive: false });
    canvas.addEventListener("pointerdown", this.#onPointerDown);
    canvas.addEventListener("pointermove", this.#onPointerMove);
    canvas.addEventListener("pointerup", this.#onPointerUp);
    canvas.addEventListener("pointercancel", this.#onPointerUp);
    canvas.addEventListener("pointerleave", this.#onPointerUp);
    // Without this, a drag on touch scrolls the page instead of panning.
    canvas.style.touchAction = "none";
  }

  #detachInput(): void {
    const canvas = this.#canvas;
    canvas.removeEventListener("wheel", this.#onWheel);
    canvas.removeEventListener("pointerdown", this.#onPointerDown);
    canvas.removeEventListener("pointermove", this.#onPointerMove);
    canvas.removeEventListener("pointerup", this.#onPointerUp);
    canvas.removeEventListener("pointercancel", this.#onPointerUp);
    canvas.removeEventListener("pointerleave", this.#onPointerUp);
  }

  #localPoint(event: PointerEvent | WheelEvent): { x: number; y: number } {
    const rect = this.#canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  readonly #onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    const point = this.#localPoint(event);
    // Exponential in the scroll delta so a trackpad's many small events and a
    // mouse wheel's few large ones cover ground at a comparable rate.
    const factor = Math.exp(-event.deltaY * 0.0015);
    this.camera.zoomAroundScreen(point.x, point.y, factor);
    this.#visualDirty = true;
  };

  readonly #onPointerDown = (event: PointerEvent): void => {
    const point = this.#localPoint(event);
    this.#activePointers.set(event.pointerId, point);
    if (this.#activePointers.size === 2) {
      this.#dragPointerId = null;
      this.#pinchDistance = this.#currentPinchDistance();
      return;
    }
    this.#dragPointerId = event.pointerId;
    this.#dragLastX = point.x;
    this.#dragLastY = point.y;
    this.#dragTravel = 0;
    this.#canvas.setPointerCapture(event.pointerId);
  };

  readonly #onPointerMove = (event: PointerEvent): void => {
    const point = this.#localPoint(event);
    if (!this.#activePointers.has(event.pointerId)) {
      return;
    }
    this.#activePointers.set(event.pointerId, point);

    if (this.#activePointers.size >= 2) {
      const distance = this.#currentPinchDistance();
      if (this.#pinchDistance > 0 && distance > 0) {
        const centre = this.#pinchCentre();
        this.camera.zoomAroundScreen(centre.x, centre.y, distance / this.#pinchDistance);
        this.#visualDirty = true;
      }
      this.#pinchDistance = distance;
      return;
    }

    if (this.#dragPointerId !== event.pointerId) {
      return;
    }
    const dx = point.x - this.#dragLastX;
    const dy = point.y - this.#dragLastY;
    this.#dragLastX = point.x;
    this.#dragLastY = point.y;
    this.#dragTravel += Math.abs(dx) + Math.abs(dy);
    this.camera.panByScreen(dx, dy);
    this.#visualDirty = true;
  };

  readonly #onPointerUp = (event: PointerEvent): void => {
    const wasDragging = this.#dragPointerId === event.pointerId;
    const point = this.#localPoint(event);
    this.#activePointers.delete(event.pointerId);
    if (this.#activePointers.size < 2) {
      this.#pinchDistance = 0;
    }
    if (!wasDragging) {
      return;
    }
    this.#dragPointerId = null;
    if (this.#canvas.hasPointerCapture(event.pointerId)) {
      this.#canvas.releasePointerCapture(event.pointerId);
    }
    // A gesture that moved is a pan, not a click. Without this a slightly
    // shaky drag would also reselect whatever it ended over.
    if (this.#dragTravel > CLICK_SLOP_PX) {
      return;
    }
    this.#selectAtScreen(point.x, point.y);
  };

  #currentPinchDistance(): number {
    const points = [...this.#activePointers.values()];
    const a = points[0];
    const b = points[1];
    if (a === undefined || b === undefined) {
      return 0;
    }
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  #pinchCentre(): { x: number; y: number } {
    const points = [...this.#activePointers.values()];
    const a = points[0];
    const b = points[1];
    if (a === undefined || b === undefined) {
      return { x: this.camera.viewportWidth / 2, y: this.camera.viewportHeight / 2 };
    }
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  /** Hit-test a screen point and report the result upward. */
  #selectAtScreen(screenX: number, screenY: number): void {
    const view = this.#snapshot;
    if (view === null) {
      return;
    }
    const world = this.camera.screenToWorld(screenX, screenY);
    const hit: PickResult | null = pickOrganism(
      view,
      this.#organismCount,
      world.xLU,
      world.yLU,
      PICK_TOLERANCE_PX / this.camera.zoom,
    );
    const entityId = hit === null ? null : hit.entityId;
    this.setSelected(entityId);
    this.#options.onSelectionChange(entityId);
  }
}
