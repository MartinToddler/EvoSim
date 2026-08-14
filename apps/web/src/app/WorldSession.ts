import { EonRenderer } from "@eon/renderer";
import type { WorldLayerId } from "@eon/renderer/palette";
import {
  viewRenderSnapshot,
  viewTerrainSnapshot,
  viewVegetationSnapshot,
  type EntityDetailsDto,
  type EntityDetailsPayload,
  type HostRuntimeConfig,
  type SimulationSpeed,
  type SpeciesDetailsDto,
  type SpeciesDetailsPayload,
  type TelemetryDto,
  type TerrainSnapshotView,
  type TreeSnapshotDto,
  type VegetationSnapshotView,
  type RenderSnapshotView,
  type WorkerErrorDto,
  type WorldEventDto,
  type WorldSummaryDto,
} from "@eon/protocol";
import { resampleStroke } from "@eon/protocol";
import type {
  BrushFalloffDto,
  BrushKindDto,
  CommandRequestDto,
  CommandResultDto,
} from "@eon/protocol";
import { WorkerClient, workerPort, type RawWorker } from "../worker/WorkerClient";

/**
 * Composition root for one open world (docs/10 §22).
 *
 * Owns the Worker, the client facade and the renderer, and wires the three
 * together. React holds a reference to this object and calls methods on it; it
 * never sees a render snapshot, a buffer or an organism coordinate.
 *
 * ## The one place the two clocks meet
 *
 * The Worker ticks on its own schedule and Pixi draws on `requestAnimationFrame`.
 * Neither waits for the other. This class is where a snapshot produced by the
 * first becomes a picture drawn by the second, and its only job at that seam is
 * to make sure buffers get handed back.
 *
 * ## DTOs are frozen at this boundary
 *
 * Everything handed to the React callbacks is `Object.freeze`d first (arrays
 * and nested objects included), so no UI code can mutate what it observes —
 * the DTO a component sees is exactly the DTO the Worker sent, permanently.
 * This costs a few freezes per second on small objects and turns "the UI
 * cannot write simulation state" from a convention into a thrown TypeError.
 *
 * ## Teardown is explicit
 *
 * Renderer destroyed, worker terminated, observers disconnected, buffers
 * returned. A session that leaked a Worker would leave a whole simulation
 * running in the background with nothing watching it.
 */

export type FollowEndReason = "died" | "user" | "selection" | "cleared";

export interface WorldSessionCallbacks {
  onWorldReady: (world: WorldSummaryDto, hostRuntime: HostRuntimeConfig) => void;
  onTelemetry: (telemetry: TelemetryDto) => void;
  onSelectionChange: (entityId: number | null) => void;
  onEntityDetails: (payload: EntityDetailsPayload) => void;
  /** Follow started (entityId) or stopped (null, with the reason why). */
  onFollowChange: (entityId: number | null, reason: FollowEndReason | "started") => void;
  /** Fresh Tree of Life snapshot (Milestone 8). */
  onTree?: (tree: TreeSnapshotDto) => void;
  /** Selected-species inspector refresh (Milestone 8). */
  onSpeciesDetails?: (payload: SpeciesDetailsPayload) => void;
  /**
   * The accumulated event log after new events arrived (Milestone 8). The
   * array is the session's bounded, frozen accumulation — not just the delta —
   * so React can render it directly.
   */
  onHistoryEvents?: (events: readonly WorldEventDto[], droppedBeforeOldest: number) => void;
  /** Verdict on a queued intervention (Milestone 9): accepted identity or rejection. */
  onCommandResult?: (result: CommandResultDto, tick: number) => void;
  onError: (error: WorkerErrorDto) => void;
}

/**
 * The tool a pointer stroke feeds (Milestone 9). The UI owns choosing it; the
 * session owns turning strokes into canonical commands with it. Global
 * temperature is not a canvas tool — see {@link WorldSession.applyGlobalTemperature}.
 */
export interface ActiveBrushTool {
  kind: BrushKindDto;
  radiusLU: number;
  strength: number;
  falloff: BrushFalloffDto;
}

export interface ActiveMeteorTool {
  kind: "meteor";
  radiusLU: number;
}

export type ActiveCanvasTool = ActiveBrushTool | ActiveMeteorTool;

/**
 * Client-side bound on the accumulated event log, mirroring the engine's own
 * in-memory budget: the UI can never hold more history than the engine would.
 */
const MAX_CLIENT_EVENTS = 4096;

/**
 * The slice of `Worker` the session actually uses, so tests can supply a fake
 * without a browser (docs/10 §22's teardown contract is exactly what those
 * tests pin down).
 */
export type SessionWorker = RawWorker;

/** The slice of {@link EonRenderer} the session drives; structurally satisfied. */
export interface SessionRenderer {
  readonly camera: { fitWorld(): void };
  applyTerrain(view: TerrainSnapshotView): void;
  applyVegetation(view: VegetationSnapshotView): void;
  applyRenderSnapshot(view: RenderSnapshotView): void;
  setSelected(entityId: number | null): void;
  setFollowed(entityId: number | null): void;
  setDebugOverlay(enabled: boolean): void;
  setToolCapture(radiusLU: number | null): void;
  setWorldLayer(layer: WorldLayerId): void;
  setLayerOpacity(opacity: number): void;
  focusEntity(entityId: number): boolean;
  resize(widthPx: number, heightPx: number): void;
  destroy(): void;
}

export interface RendererFactoryOptions {
  canvas: HTMLCanvasElement;
  worldSizeLU: number;
  gridSize: number;
  maxOrganisms: number;
  maxCarcasses: number;
  maxDetailedOrganisms: number;
  onSelectionChange: (entityId: number | null) => void;
  onFollowEnd: (reason: "died" | "user") => void;
  onRecycleRenderBuffer: (buffer: ArrayBuffer) => void;
  onRecycleVegetationBuffer: (buffer: ArrayBuffer) => void;
  onStrokeComplete?: (points: { xLU: number; yLU: number }[]) => void;
}

export interface WorldSessionOptions {
  canvas: HTMLCanvasElement;
  /** Element whose size the canvas should follow. */
  viewport: HTMLElement;
  seed: number;
  initialSpeed: SimulationSpeed;
  callbacks: WorldSessionCallbacks;
  /** Test seam: supply a fake Worker. Defaults to the real simulation Worker. */
  createWorker?: () => SessionWorker;
  /** Test seam: supply a fake renderer. Defaults to {@link EonRenderer}. */
  createRenderer?: (options: RendererFactoryOptions) => Promise<SessionRenderer>;
}

/** Freeze a telemetry DTO and its nested arrays/objects in place. */
function freezeTelemetry(telemetry: TelemetryDto): TelemetryDto {
  Object.freeze(telemetry.deathsByCause);
  Object.freeze(telemetry.phaseMillis);
  Object.freeze(telemetry.traitMeans);
  return Object.freeze(telemetry);
}

function freezeDetails(details: EntityDetailsDto | null): EntityDetailsDto | null {
  if (details === null) {
    return null;
  }
  Object.freeze(details.brainInputs);
  Object.freeze(details.brainIntents);
  return Object.freeze(details);
}

function freezeWorld(world: WorldSummaryDto): WorldSummaryDto {
  Object.freeze(world.display.brainInputLabels);
  Object.freeze(world.display.brainIntentLabels);
  Object.freeze(world.display.deathCauseLabels);
  Object.freeze(world.display.eventTypeLabels);
  Object.freeze(world.display.eventSeverityLabels);
  Object.freeze(world.display.speciesEndReasonLabels);
  Object.freeze(world.display.traitDimensionLabels);
  Object.freeze(world.display);
  return Object.freeze(world);
}

function freezeTree(tree: TreeSnapshotDto): TreeSnapshotDto {
  for (const species of tree.species) {
    Object.freeze(species);
  }
  Object.freeze(tree.species);
  return Object.freeze(tree);
}

function freezeSpeciesDetails(details: SpeciesDetailsDto | null): SpeciesDetailsDto | null {
  if (details === null) {
    return null;
  }
  Object.freeze(details.centroidTraits);
  Object.freeze(details.originCentroid);
  Object.freeze(details.childIds);
  Object.freeze(details.series.ticks);
  Object.freeze(details.series.population);
  Object.freeze(details.series.meanSize);
  Object.freeze(details.series.meanSpeed);
  Object.freeze(details.series.meanDiet);
  Object.freeze(details.series);
  return Object.freeze(details);
}

function freezeEvent(event: WorldEventDto): WorldEventDto {
  Object.freeze(event.speciesIds);
  Object.freeze(event.entityIds);
  if (event.region !== null) {
    Object.freeze(event.region);
  }
  Object.freeze(event.payload);
  return Object.freeze(event);
}

export class WorldSession {
  readonly #client: WorkerClient;
  readonly #worker: SessionWorker;
  readonly #options: WorldSessionOptions;
  #renderer: SessionRenderer | null = null;
  #resizeObserver: ResizeObserver | null = null;

  /**
   * A snapshot that arrived before the renderer finished initializing.
   *
   * At most one is held: a newer snapshot replaces and recycles the older, so
   * this can never become a backlog. Without it the first frame of a paused
   * world would be dropped and the user would stare at an empty canvas until
   * they pressed play.
   */
  #pendingSnapshot: ArrayBuffer | null = null;
  #selectedEntityId: number | null = null;
  #followedEntityId: number | null = null;
  /** Layer choices made before the renderer exists are applied when it does. */
  #worldLayer: WorldLayerId = "terrain";
  #layerOpacity = 0.85;
  #debugOverlay = false;
  #destroyed = false;
  #world: WorldSummaryDto | null = null;

  // --- Player tools (Milestone 9) ----------------------------------------------
  #activeTool: ActiveCanvasTool | null = null;

  // --- Species and history (Milestone 8) --------------------------------------
  #selectedSpeciesId: number | null = null;
  /** True while a species/tree panel is open, so populations stay live. */
  #treeWatching = false;
  /** Species counts at the last tree fetch; a change forces a refresh. */
  #treeRevision = "";
  #treeRequestInFlight = false;
  /** Highest event ID already accumulated; the pull cursor. */
  #lastFetchedEventId = 0;
  #historyRequestInFlight = false;
  /** Bounded, frozen accumulation of events, oldest first. */
  #events: WorldEventDto[] = [];
  /** Events that scrolled out of this accumulation or the engine's log. */
  #eventsDroppedBeforeOldest = 0;

  private constructor(options: WorldSessionOptions) {
    this.#options = options;
    this.#worker =
      options.createWorker !== undefined
        ? options.createWorker()
        : new Worker(new URL("../worker/simulation.worker.ts", import.meta.url), {
            type: "module",
          });
    this.#client = new WorkerClient(workerPort(this.#worker), {
      onWorldReady: (payload) => {
        // Renderer creation is async and can genuinely fail — a machine with no
        // WebGL at all, or a lost context. Without this catch the rejection is
        // unhandled and the page shows an empty canvas with no explanation.
        this.#handleWorldReady(payload.world, payload.hostRuntime, payload.terrain).catch(
          (error: unknown) => {
            options.callbacks.onError({
              message: `renderer failed to start: ${error instanceof Error ? error.message : String(error)}`,
              fatal: true,
              tick: payload.telemetry.tick,
              seed: payload.world.seed,
              engineVersion: payload.world.engineVersion,
              whileHandling: "WORLD_READY",
            });
          },
        );
      },
      onRenderSnapshot: (payload) => {
        this.#handleRenderSnapshot(payload.buffer);
      },
      onVegetationSnapshot: (payload) => {
        this.#handleVegetation(payload.buffer);
      },
      onTerrainSnapshot: (payload) => {
        // A command edited the world; repaint the terrain planes (Milestone 9).
        if (!this.#destroyed) {
          this.#renderer?.applyTerrain(viewTerrainSnapshot(payload.buffer));
        }
      },
      onTelemetry: (telemetry) => {
        options.callbacks.onTelemetry(freezeTelemetry(telemetry));
        // Refresh the inspector in step with the HUD rather than per frame: an
        // organism's energy and age change every tick, but nobody can read a
        // number that updates 60 times a second.
        this.#refreshSelectedEntity();
        // Species and history piggyback the same cadence: telemetry is the
        // change signal (protocol 4 has no event push stream by design).
        this.#refreshSelectedSpecies();
        this.#refreshTree(telemetry);
        this.#refreshHistory(telemetry.latestEventId);
      },
      onError: (error) => {
        options.callbacks.onError(error);
      },
      onProtocolViolation: (reason) => {
        options.callbacks.onError({
          message: `protocol violation: ${reason}`,
          fatal: false,
          tick: null,
          seed: null,
          engineVersion: "unknown",
          whileHandling: null,
        });
      },
    });
  }

  static start(options: WorldSessionOptions): WorldSession {
    const session = new WorldSession(options);
    session.#client.initNewWorld({ seed: options.seed, speed: options.initialSpeed });
    return session;
  }

  get world(): WorldSummaryDto | null {
    return this.#world;
  }

  get selectedEntityId(): number | null {
    return this.#selectedEntityId;
  }

  get followedEntityId(): number | null {
    return this.#followedEntityId;
  }

  get worldLayer(): WorldLayerId {
    return this.#worldLayer;
  }

  setSpeed(speed: SimulationSpeed): void {
    this.#client.setSpeed(speed);
  }

  setDebugOverlay(enabled: boolean): void {
    this.#debugOverlay = enabled;
    this.#renderer?.setDebugOverlay(enabled);
  }

  /**
   * Switch the world view. Renderer-local by construction: no Worker message
   * exists for this, so a layer switch cannot regenerate or perturb the
   * simulation (task H05 requirement).
   */
  setWorldLayer(layer: WorldLayerId): void {
    this.#worldLayer = layer;
    this.#renderer?.setWorldLayer(layer);
  }

  setLayerOpacity(opacity: number): void {
    this.#layerOpacity = opacity;
    this.#renderer?.setLayerOpacity(opacity);
  }

  fitWorld(): void {
    // Manually reframing the world is taking the camera back from follow.
    this.#endFollow("user");
    this.#renderer?.camera.fitWorld();
  }

  focusSelected(): void {
    if (this.#selectedEntityId !== null) {
      this.#renderer?.focusEntity(this.#selectedEntityId);
    }
  }

  /** Start following the currently selected organism. */
  followSelected(): void {
    const entityId = this.#selectedEntityId;
    if (entityId === null || this.#destroyed) {
      return;
    }
    this.#followedEntityId = entityId;
    this.#renderer?.setFollowed(entityId);
    this.#options.callbacks.onFollowChange(entityId, "started");
  }

  stopFollow(): void {
    this.#endFollow("cleared");
  }

  clearSelection(): void {
    this.#endFollow("cleared");
    this.#selectedEntityId = null;
    this.#renderer?.setSelected(null);
    this.#options.callbacks.onSelectionChange(null);
  }

  /** Suspend or resume the render stream, e.g. when the tab is hidden. */
  setRenderStream(enabled: boolean): void {
    this.#client.setRenderStream(enabled);
  }

  // --- Player tools (Milestone 9) ----------------------------------------------

  /**
   * Arm a canvas tool, or disarm with null. While armed, one-pointer strokes
   * paint (the renderer suppresses click-select and pan for that pointer), and
   * each completed stroke becomes ONE canonical command. The UI never touches
   * simulation state: this whole path ends in QUEUE_COMMAND.
   */
  setActiveTool(tool: ActiveCanvasTool | null): void {
    this.#activeTool = tool;
    this.#renderer?.setToolCapture(tool === null ? null : tool.radiusLU);
  }

  get activeTool(): ActiveCanvasTool | null {
    return this.#activeTool;
  }

  /** Queue a SET_GLOBAL_TEMPERATURE_OFFSET command (panel tool, no canvas). */
  applyGlobalTemperature(offsetCentiC: number): void {
    this.#queueCommand({
      kind: "setGlobalTemperature",
      offsetCentiC: Math.round(offsetCentiC),
    });
  }

  /** Turn one completed pointer stroke into one canonical command. */
  #handleStrokeComplete(points: { xLU: number; yLU: number }[]): void {
    const tool = this.#activeTool;
    const world = this.#world;
    if (tool === null || world === null || this.#destroyed || points.length === 0) {
      return;
    }
    if (tool.kind === "meteor") {
      // A meteor is aimed, not painted: the strike lands where the pointer
      // lifted, quantized like every command coordinate.
      const last = points[points.length - 1] as { xLU: number; yLU: number };
      this.#queueCommand({
        kind: "meteor",
        centerXLU: Math.round(Math.min(Math.max(last.xLU, 0), world.worldSizeLU)),
        centerYLU: Math.round(Math.min(Math.max(last.yLU, 0), world.worldSizeLU)),
        radiusLU: Math.round(tool.radiusLU),
      });
      return;
    }
    // Canonicalization (docs/02 §16): resample the raw pointer path at the
    // configured world spacing and quantize to whole LU. Device event rate
    // dies here; only the canonical samples reach the log.
    const bounds = world.display.interventions;
    const stroke = resampleStroke(points, {
      spacingLU: bounds.brushSampleSpacingLU,
      maxSamples: bounds.maxBrushSamplesPerCommand,
      worldSizeLU: world.worldSizeLU,
    });
    if (stroke.samplesXLU.length === 0) {
      return;
    }
    this.#queueCommand({
      kind: tool.kind,
      radiusLU: Math.round(tool.radiusLU),
      strength: Math.round(tool.strength),
      falloff: tool.falloff,
      samplesXLU: stroke.samplesXLU,
      samplesYLU: stroke.samplesYLU,
    });
  }

  #queueCommand(command: CommandRequestDto): void {
    this.#client
      .queueCommand(command)
      .then((payload) => {
        if (!this.#destroyed) {
          this.#options.callbacks.onCommandResult?.(Object.freeze(payload.result), payload.tick);
        }
      })
      .catch(() => {
        // Worker failure; the error handler already surfaced it.
      });
  }

  // --- Species and history (Milestone 8) --------------------------------------

  /**
   * Select a species for the inspector, or clear with null. Details are
   * fetched immediately and then refreshed at telemetry cadence, exactly like
   * the organism inspector.
   */
  selectSpecies(speciesId: number | null): void {
    this.#selectedSpeciesId = speciesId;
    this.#refreshSelectedSpecies();
  }

  get selectedSpeciesId(): number | null {
    return this.#selectedSpeciesId;
  }

  /**
   * Tell the session whether a species/tree view is open. While watching, the
   * tree refreshes every telemetry so populations stay live; while not, it
   * refreshes only when the species set itself changes (a split, an
   * extinction) so the TopBar count stays honest at near-zero cost.
   */
  setTreeWatching(watching: boolean): void {
    this.#treeWatching = watching;
  }

  #refreshSelectedSpecies(): void {
    const speciesId = this.#selectedSpeciesId;
    if (speciesId === null || this.#destroyed) {
      return;
    }
    this.#client
      .querySpecies(speciesId)
      .then((payload) => {
        if (this.#destroyed || this.#selectedSpeciesId !== payload.speciesId) {
          return;
        }
        this.#options.callbacks.onSpeciesDetails?.(
          Object.freeze({ ...payload, details: freezeSpeciesDetails(payload.details) }),
        );
      })
      .catch(() => {
        // The error handler already surfaced the failure; the inspector keeps
        // its last known values (same policy as the organism inspector).
      });
  }

  #refreshTree(telemetry: TelemetryDto): void {
    const revision = `${telemetry.totalSpeciesCount}:${telemetry.activeSpeciesCount}:${telemetry.extinctSpeciesCount}`;
    const structureChanged = revision !== this.#treeRevision;
    if (
      (!this.#treeWatching && !structureChanged) ||
      this.#treeRequestInFlight ||
      this.#destroyed
    ) {
      return;
    }
    this.#treeRequestInFlight = true;
    this.#client
      .requestTree()
      .then((payload) => {
        this.#treeRequestInFlight = false;
        if (this.#destroyed) {
          return;
        }
        this.#treeRevision = revision;
        this.#options.callbacks.onTree?.(freezeTree(payload.tree));
      })
      .catch(() => {
        this.#treeRequestInFlight = false;
      });
  }

  #refreshHistory(latestEventId: number): void {
    if (
      latestEventId <= this.#lastFetchedEventId ||
      this.#historyRequestInFlight ||
      this.#destroyed
    ) {
      return;
    }
    this.#historyRequestInFlight = true;
    this.#client
      .requestHistory(this.#lastFetchedEventId)
      .then((payload) => {
        this.#historyRequestInFlight = false;
        if (this.#destroyed || payload.history.events.length === 0) {
          return;
        }
        for (const event of payload.history.events) {
          // Overlap is possible if the engine dropped and re-served nothing new;
          // IDs are strictly increasing, so a simple guard dedupes.
          if (event.id > this.#lastFetchedEventId) {
            this.#events.push(freezeEvent(event));
            this.#lastFetchedEventId = event.id;
          }
        }
        if (this.#events.length > MAX_CLIENT_EVENTS) {
          const excess = this.#events.length - MAX_CLIENT_EVENTS;
          this.#events.splice(0, excess);
          this.#eventsDroppedBeforeOldest += excess;
        }
        this.#options.callbacks.onHistoryEvents?.(
          Object.freeze([...this.#events]),
          this.#eventsDroppedBeforeOldest + payload.history.droppedEventCount,
        );
      })
      .catch(() => {
        this.#historyRequestInFlight = false;
      });
  }

  destroy(): void {
    if (this.#destroyed) {
      return;
    }
    this.#destroyed = true;
    this.#resizeObserver?.disconnect();
    this.#resizeObserver = null;
    this.#renderer?.destroy();
    this.#renderer = null;
    this.#pendingSnapshot = null;
    // `dispose` sends DISPOSE and then terminates, so the host stops its loop
    // cleanly instead of being killed mid-tick.
    this.#client.dispose();
  }

  // --- Worker events ---------------------------------------------------------

  async #handleWorldReady(
    world: WorldSummaryDto,
    hostRuntime: HostRuntimeConfig,
    terrain: ArrayBuffer,
  ): Promise<void> {
    const frozenWorld = freezeWorld(world);
    this.#world = frozenWorld;
    const create =
      this.#options.createRenderer ??
      ((rendererOptions: RendererFactoryOptions): Promise<SessionRenderer> =>
        EonRenderer.create(rendererOptions));
    const renderer = await create({
      canvas: this.#options.canvas,
      worldSizeLU: world.worldSizeLU,
      gridSize: world.gridSize,
      maxOrganisms: world.maxOrganisms,
      maxCarcasses: world.maxCarcasses,
      maxDetailedOrganisms: hostRuntime.maxDetailedRenderedOrganisms,
      onSelectionChange: (entityId) => {
        this.#handleSelection(entityId);
      },
      onFollowEnd: (reason) => {
        // The renderer already stopped following (target died or the user
        // dragged); mirror that here and tell the UI why the camera stopped.
        if (this.#followedEntityId !== null) {
          this.#followedEntityId = null;
          this.#options.callbacks.onFollowChange(null, reason);
        }
      },
      onRecycleRenderBuffer: (buffer) => {
        this.#client.recycleRenderBuffer(buffer);
      },
      onRecycleVegetationBuffer: (buffer) => {
        this.#client.recycleVegetationBuffer(buffer);
      },
      onStrokeComplete: (points) => {
        this.#handleStrokeComplete(points);
      },
    });

    // The session may have been torn down while Pixi was initializing.
    if (this.#destroyed) {
      renderer.destroy();
      return;
    }
    this.#renderer = renderer;
    renderer.setDebugOverlay(this.#debugOverlay);
    if (this.#activeTool !== null) {
      renderer.setToolCapture(this.#activeTool.radiusLU);
    }
    if (this.#worldLayer !== "terrain") {
      renderer.setWorldLayer(this.#worldLayer);
    }
    renderer.setLayerOpacity(this.#layerOpacity);
    renderer.applyTerrain(viewTerrainSnapshot(terrain));
    this.#observeResize();

    const pending = this.#pendingSnapshot;
    this.#pendingSnapshot = null;
    if (pending !== null) {
      renderer.applyRenderSnapshot(viewRenderSnapshot(pending));
    }
    this.#options.callbacks.onWorldReady(frozenWorld, Object.freeze(hostRuntime));
  }

  #handleRenderSnapshot(buffer: ArrayBuffer): void {
    if (this.#destroyed) {
      return;
    }
    const renderer = this.#renderer;
    if (renderer === null) {
      // Keep only the newest; hand the older one straight back.
      const previous = this.#pendingSnapshot;
      this.#pendingSnapshot = buffer;
      if (previous !== null) {
        this.#client.recycleRenderBuffer(previous);
      }
      return;
    }
    renderer.applyRenderSnapshot(viewRenderSnapshot(buffer));
  }

  #handleVegetation(buffer: ArrayBuffer): void {
    if (this.#destroyed) {
      return;
    }
    const renderer = this.#renderer;
    if (renderer === null) {
      this.#client.recycleVegetationBuffer(buffer);
      return;
    }
    // applyVegetation consumes the field and recycles the buffer itself.
    renderer.applyVegetation(viewVegetationSnapshot(buffer));
  }

  // --- Selection and follow ----------------------------------------------------

  #handleSelection(entityId: number | null): void {
    // Selecting something else — or empty space — releases the camera: follow
    // is a property of the followed organism, not of selection in general.
    if (this.#followedEntityId !== null && this.#followedEntityId !== entityId) {
      this.#endFollow("selection");
    }
    this.#selectedEntityId = entityId;
    this.#options.callbacks.onSelectionChange(entityId);
    this.#refreshSelectedEntity();
  }

  #endFollow(reason: FollowEndReason): void {
    if (this.#followedEntityId === null) {
      return;
    }
    this.#followedEntityId = null;
    this.#renderer?.setFollowed(null);
    this.#options.callbacks.onFollowChange(null, reason);
  }

  #refreshSelectedEntity(): void {
    const entityId = this.#selectedEntityId;
    if (entityId === null || this.#destroyed) {
      return;
    }
    this.#client
      .queryEntity(entityId)
      .then((payload) => {
        // The user may have selected something else while this was in flight.
        // Answering for a stale selection would overwrite the inspector with
        // the previous organism's numbers.
        if (this.#destroyed || this.#selectedEntityId !== payload.entityId) {
          return;
        }
        if (payload.details === null && this.#followedEntityId === payload.entityId) {
          // Death discovered by query — the paused-world path, where no new
          // snapshot will ever tell the renderer.
          this.#endFollow("died");
        }
        this.#options.callbacks.onEntityDetails(
          Object.freeze({ ...payload, details: freezeDetails(payload.details) }),
        );
      })
      .catch(() => {
        // A rejected query means the worker is gone or reported a failure; the
        // error handler has already surfaced it, and the inspector simply keeps
        // its last known values.
      });
  }

  #observeResize(): void {
    const apply = (): void => {
      const rect = this.#options.viewport.getBoundingClientRect();
      this.#renderer?.resize(Math.max(1, rect.width), Math.max(1, rect.height));
    };
    apply();
    this.#renderer?.camera.fitWorld();
    // Absent in Node test environments; the initial size was still applied.
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(apply);
    observer.observe(this.#options.viewport);
    this.#resizeObserver = observer;
  }
}
