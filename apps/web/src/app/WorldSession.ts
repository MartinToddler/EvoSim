import { EonRenderer } from "@eon/renderer";
import {
  viewRenderSnapshot,
  viewTerrainSnapshot,
  viewVegetationSnapshot,
  type EntityDetailsPayload,
  type HostRuntimeConfig,
  type SimulationSpeed,
  type TelemetryDto,
  type WorkerErrorDto,
  type WorldSummaryDto,
} from "@eon/protocol";
import { WorkerClient, workerPort } from "../worker/WorkerClient";

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
 * ## Teardown is explicit
 *
 * Renderer destroyed, worker terminated, observers disconnected, buffers
 * returned. A session that leaked a Worker would leave a whole simulation
 * running in the background with nothing watching it.
 */

export interface WorldSessionCallbacks {
  onWorldReady: (world: WorldSummaryDto, hostRuntime: HostRuntimeConfig) => void;
  onTelemetry: (telemetry: TelemetryDto) => void;
  onSelectionChange: (entityId: number | null) => void;
  onEntityDetails: (payload: EntityDetailsPayload) => void;
  onError: (error: WorkerErrorDto) => void;
}

export interface WorldSessionOptions {
  canvas: HTMLCanvasElement;
  /** Element whose size the canvas should follow. */
  viewport: HTMLElement;
  seed: number;
  initialSpeed: SimulationSpeed;
  callbacks: WorldSessionCallbacks;
}

export class WorldSession {
  readonly #client: WorkerClient;
  readonly #worker: Worker;
  readonly #options: WorldSessionOptions;
  #renderer: EonRenderer | null = null;
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
  #destroyed = false;
  #world: WorldSummaryDto | null = null;

  private constructor(options: WorldSessionOptions) {
    this.#options = options;
    this.#worker = new Worker(new URL("../worker/simulation.worker.ts", import.meta.url), {
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
      onTelemetry: (telemetry) => {
        options.callbacks.onTelemetry(telemetry);
        // Refresh the inspector in step with the HUD rather than per frame: an
        // organism's energy and age change every tick, but nobody can read a
        // number that updates 60 times a second.
        this.#refreshSelectedEntity();
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

  get renderer(): EonRenderer | null {
    return this.#renderer;
  }

  setSpeed(speed: SimulationSpeed): void {
    this.#client.setSpeed(speed);
  }

  setDebugOverlay(enabled: boolean): void {
    this.#renderer?.setDebugOverlay(enabled);
  }

  fitWorld(): void {
    this.#renderer?.camera.fitWorld();
  }

  focusSelected(): void {
    if (this.#selectedEntityId !== null) {
      this.#renderer?.focusEntity(this.#selectedEntityId);
    }
  }

  clearSelection(): void {
    this.#selectedEntityId = null;
    this.#renderer?.setSelected(null);
    this.#options.callbacks.onSelectionChange(null);
  }

  /** Suspend or resume the render stream, e.g. when the tab is hidden. */
  setRenderStream(enabled: boolean): void {
    this.#client.setRenderStream(enabled);
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
    this.#world = world;
    const renderer = await EonRenderer.create({
      canvas: this.#options.canvas,
      worldSizeLU: world.worldSizeLU,
      gridSize: world.gridSize,
      maxOrganisms: world.maxOrganisms,
      maxCarcasses: world.maxCarcasses,
      maxDetailedOrganisms: hostRuntime.maxDetailedRenderedOrganisms,
      onSelectionChange: (entityId) => {
        this.#handleSelection(entityId);
      },
      onRecycleRenderBuffer: (buffer) => {
        this.#client.recycleRenderBuffer(buffer);
      },
      onRecycleVegetationBuffer: (buffer) => {
        this.#client.recycleVegetationBuffer(buffer);
      },
    });

    // The session may have been torn down while Pixi was initializing.
    if (this.#destroyed) {
      renderer.destroy();
      return;
    }
    this.#renderer = renderer;
    renderer.applyTerrain(viewTerrainSnapshot(terrain));
    this.#observeResize();

    const pending = this.#pendingSnapshot;
    this.#pendingSnapshot = null;
    if (pending !== null) {
      renderer.applyRenderSnapshot(viewRenderSnapshot(pending));
    }
    this.#options.callbacks.onWorldReady(world, hostRuntime);
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

  // --- Selection -------------------------------------------------------------

  #handleSelection(entityId: number | null): void {
    this.#selectedEntityId = entityId;
    this.#options.callbacks.onSelectionChange(entityId);
    this.#refreshSelectedEntity();
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
        this.#options.callbacks.onEntityDetails(payload);
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
    const observer = new ResizeObserver(apply);
    observer.observe(this.#options.viewport);
    this.#resizeObserver = observer;
  }
}
