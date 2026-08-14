import {
  CONFIG_SCHEMA_VERSION,
  DEATH_CAUSE_COUNT,
  DEFAULT_CONFIG,
  ENGINE_VERSION,
  SNAPSHOT_SCHEMA_VERSION,
  SimulationEngine,
  TickPhase,
  collectTelemetryAggregates,
  queryEntity,
  writeRenderSnapshot,
  writeTerrainFields,
  writeVegetationField,
  type SimulationConfig,
} from "@eon/engine";
import {
  DEFAULT_HOST_RUNTIME_CONFIG,
  FieldHeader,
  PROTOCOL_VERSION,
  RenderBufferPool,
  RenderHeader,
  VegetationBufferPool,
  createTerrainBuffer,
  decodeMainToWorkerMessage,
  envelope,
  requestEnvelope,
  targetTicksPerSecond,
  validateHostRuntimeConfig,
  viewRenderSnapshot,
  viewTerrainSnapshot,
  viewVegetationSnapshot,
  type HostRuntimeConfig,
  type MainToWorkerMessage,
  type SimulationSpeed,
  type TelemetryDto,
  type WorkerToMainMessage,
  type WorldSummaryDto,
} from "@eon/protocol";
import { PhaseProfiler } from "./PhaseProfiler";

/**
 * Simulation Worker host (tasks G02/G03, docs/02 §§3, 8, docs/10 §20).
 *
 * The host owns the one authoritative engine instance and decides *when* it
 * steps. It decides nothing about *what* a step does — no biology lives here,
 * and no wall-clock value ever reaches the engine. That split is the whole
 * design:
 *
 * > Speed changes scheduling, never equations.
 *
 * A world run at 1×, at MAX, paused and resumed fifty times, or fast-forwarded
 * headlessly in Node produces the same state hash at the same tick, because all
 * four differ only in how often this class calls `step()`.
 *
 * ## Why the clock, scheduler and port are injected
 *
 * `performance.now`, `setTimeout` and `postMessage` are the three pieces of
 * browser that a Worker host genuinely needs, and all three are untestable in
 * Node and untestable *deterministically* anywhere. Injecting them turns
 * "pause, resume, change speed, run MAX, drop a snapshot" from a manual
 * browser exercise into ordinary unit tests with a fake clock, which is where
 * the interesting bugs — double loops, pause races, snapshot backlogs — are
 * actually found. `simulation.worker.ts` supplies the real three and does
 * nothing else.
 *
 * ## Ticks are never dropped; snapshots are
 *
 * When the host cannot keep up with the requested speed it falls behind and
 * says so (`behindTarget`, `achievedTicksPerSecond`). It never skips
 * authoritative ticks to catch up, and it never runs a "bigger" tick. Render
 * snapshots are the opposite: if every pooled buffer is still with the
 * renderer, the snapshot is skipped and the simulation carries on (docs/02 §10).
 */

/** Wall-clock source, in milliseconds. Monotonic is preferred but not required. */
export interface HostClock {
  now(): number;
}

/**
 * Opaque timer handle.
 *
 * `number | object` rather than `unknown` because both real implementations are
 * covered by it — browsers return a number from `setTimeout`, Node returns a
 * `Timeout` — while still leaving `HostTimerHandle | null` a meaningful type.
 * With `unknown` the null case would be swallowed by the union, and "is a loop
 * scheduled" is exactly the question this field has to answer.
 */
export type HostTimerHandle = number | object;

export interface HostScheduler {
  schedule(callback: () => void, delayMs: number): HostTimerHandle;
  cancel(handle: HostTimerHandle): void;
}

export interface HostPort {
  post(message: WorkerToMainMessage, transfer?: readonly ArrayBuffer[]): void;
}

export interface SimulationHostOptions {
  clock: HostClock;
  scheduler: HostScheduler;
  port: HostPort;
}

/**
 * Sub-slice granularity for the MAX-mode clock check.
 *
 * MAX must yield to the Worker event loop often enough that a PAUSE click is
 * honoured promptly (docs/02 §8), so the elapsed budget is re-read every tick
 * rather than every N ticks. One clock read against one whole-population tick
 * is not a measurable cost, and batching would make the pause latency depend on
 * population size — exactly the coupling to avoid.
 */
const MAX_MODE_CLOCK_CHECK_EVERY_TICK = true;

export class SimulationHost {
  readonly #clock: HostClock;
  readonly #scheduler: HostScheduler;
  readonly #port: HostPort;
  readonly #profiler: PhaseProfiler;

  #engine: SimulationEngine | null = null;
  #hostRuntime: HostRuntimeConfig = DEFAULT_HOST_RUNTIME_CONFIG;
  #world: WorldSummaryDto | null = null;

  #speed: SimulationSpeed = "paused";
  /**
   * Handle of the *single* scheduled loop iteration, or null when no iteration
   * is pending.
   *
   * This field is the entire "no two loops" guarantee. Every path that could
   * start the loop — INIT_NEW_WORLD, SET_RUN_STATE, the loop rescheduling
   * itself — goes through {@link #ensureLoopScheduled}, which returns
   * immediately if a handle already exists. Two rapid resume clicks therefore
   * produce one loop, not two racing ones that would each step the engine.
   */
  #loopHandle: HostTimerHandle | null = null;
  /** Re-entrancy guard: a scheduler that fires synchronously must not nest. */
  #insideLoop = false;

  /** Fractional tick debt owed to the wall clock at the current speed. */
  #tickDebt = 0;
  #lastLoopAt = 0;

  #renderPool: RenderBufferPool | null = null;
  #vegetationPool: VegetationBufferPool | null = null;
  #renderStreamEnabled = true;
  #lastRenderAt = Number.NEGATIVE_INFINITY;
  #lastVegetationAt = Number.NEGATIVE_INFINITY;

  #telemetryWindowStart = 0;
  #telemetryWindowTicks = 0;
  #lastTelemetryAt = Number.NEGATIVE_INFINITY;
  #behindTarget = false;

  #disposed = false;
  #fatal = false;

  constructor(options: SimulationHostOptions) {
    this.#clock = options.clock;
    this.#scheduler = options.scheduler;
    this.#port = options.port;
    this.#profiler = new PhaseProfiler(() => this.#clock.now());
  }

  // --- Inspection, for tests and diagnostics ---------------------------------

  get tick(): number {
    return this.#engine?.tick ?? 0;
  }

  get speed(): SimulationSpeed {
    return this.#speed;
  }

  get running(): boolean {
    return this.#loopHandle !== null;
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  get hasWorld(): boolean {
    return this.#engine !== null;
  }

  /**
   * Canonical state hash of the live engine.
   *
   * Present so a test can compare Worker-driven execution against a headless
   * Node run without going through the message port. It reads state and cannot
   * change it.
   */
  stateHash(): string | null {
    return this.#engine?.computeStateHash() ?? null;
  }

  // --- Message entry point ---------------------------------------------------

  /**
   * Handle one untrusted message from the main thread.
   *
   * Nothing thrown here may escape: an exception inside a Worker's `onmessage`
   * is reported to the page as a bare `ErrorEvent` with no context about which
   * world, tick or message caused it (docs/02 §19). So every failure is caught,
   * turned into an ERROR envelope with the identifying detail attached, and —
   * when it is not recoverable — stops the loop rather than leaving a
   * half-stepped engine running.
   */
  handleMessage(data: unknown): void {
    if (this.#disposed) {
      return;
    }
    const decoded = decodeMainToWorkerMessage(data);
    if (!decoded.ok) {
      this.#reportError(decoded.reason, false, null, null);
      return;
    }
    const message = decoded.message;
    try {
      this.#dispatch(message);
    } catch (error) {
      const requestId = message.requestId;
      this.#reportError(
        error instanceof Error ? error.message : String(error),
        // A failure while stepping the simulation is fatal; a failure while
        // answering a query is not — the world is still valid.
        message.type === "INIT_NEW_WORLD" || message.type === "SET_RUN_STATE",
        message.type,
        requestId === undefined ? null : requestId,
      );
    }
  }

  #dispatch(message: MainToWorkerMessage): void {
    switch (message.type) {
      case "INIT_NEW_WORLD":
        this.#initWorld(message.payload.seed, message.payload.config, message.payload.hostRuntime);
        this.#setSpeed(message.payload.speed);
        return;
      case "SET_RUN_STATE":
        this.#setSpeed(message.payload.speed);
        return;
      case "QUERY_ENTITY":
        this.#answerEntityQuery(message.payload.entityId, message.requestId ?? 0);
        return;
      case "QUERY_STATE_HASH":
        this.#answerStateHashQuery(message.payload.targetTick, message.requestId ?? 0);
        return;
      case "RECYCLE_RENDER_BUFFER":
        this.#renderPool?.release(message.payload.buffer);
        return;
      case "RECYCLE_VEGETATION_BUFFER":
        this.#vegetationPool?.release(message.payload.buffer);
        return;
      case "SET_RENDER_STREAM":
        this.#renderStreamEnabled = message.payload.enabled;
        return;
      case "DISPOSE":
        this.dispose();
        return;
    }
  }

  // --- World lifecycle -------------------------------------------------------

  #initWorld(seed: number, config: unknown, hostRuntime: Partial<HostRuntimeConfig> | null): void {
    // Stop whatever was running before touching any field: initializing a
    // second world while the first one's loop is still scheduled is exactly the
    // race that would produce two engines stepping into one port.
    this.#stopLoop();
    this.#fatal = false;

    const merged: HostRuntimeConfig = {
      ...DEFAULT_HOST_RUNTIME_CONFIG,
      ...(hostRuntime ?? {}),
      // The schema version identifies the *shape* this host understands; a
      // caller cannot talk it down to an older one by sending a number.
      schemaVersion: DEFAULT_HOST_RUNTIME_CONFIG.schemaVersion,
    };
    validateHostRuntimeConfig(merged);
    this.#hostRuntime = merged;

    const authoritativeConfig =
      config === null || config === undefined ? DEFAULT_CONFIG : (config as SimulationConfig);
    const engine = new SimulationEngine({ seed, config: authoritativeConfig });
    engine.setProfiler(this.#profiler);
    this.#engine = engine;

    const environment = engine.environment;
    const world: WorldSummaryDto = {
      seed: engine.seed,
      seedHex: `0x${engine.seed.toString(16).toUpperCase().padStart(8, "0")}`,
      engineVersion: ENGINE_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      configSchemaVersion: CONFIG_SCHEMA_VERSION,
      snapshotSchemaVersion: SNAPSHOT_SCHEMA_VERSION,
      configHash: engine.configHash,
      worldSizeLU: engine.config.world.sizeLU,
      gridSize: environment.size,
      cellSizeLU: environment.cellSizeLU,
      generationAttempt: engine.generationAttempt,
      maxOrganisms: engine.config.limits.maxOrganisms,
      maxCarcasses: engine.config.limits.maxCarcasses,
      // The founder region is recorded in grid cells; the UI thinks in location
      // units, so it is converted here, at the cell's centre.
      founderCentreXLU: (engine.founderRegion.centerGridX + 0.5) * environment.cellSizeLU,
      founderCentreYLU: (engine.founderRegion.centerGridY + 0.5) * environment.cellSizeLU,
    };
    this.#world = world;

    this.#renderPool = new RenderBufferPool(
      world.maxOrganisms,
      world.maxCarcasses,
      merged.renderBufferPoolSize,
    );
    this.#vegetationPool = new VegetationBufferPool(world.gridSize);
    this.#lastRenderAt = Number.NEGATIVE_INFINITY;
    this.#lastVegetationAt = Number.NEGATIVE_INFINITY;
    this.#lastTelemetryAt = Number.NEGATIVE_INFINITY;
    this.#telemetryWindowStart = this.#clock.now();
    this.#telemetryWindowTicks = 0;
    this.#profiler.resetWindow();
    // A new world must not inherit the previous one's stream state: a viewer
    // who suspended the old world's pictures still expects the new world to
    // open with one on screen, and "behind target" is a claim about a loop
    // that no longer exists.
    this.#renderStreamEnabled = true;
    this.#behindTarget = false;

    const terrainBuffer = createTerrainBuffer(world.gridSize);
    const terrain = viewTerrainSnapshot(terrainBuffer);
    writeTerrainFields(engine, terrain.biome, terrain.elevation);
    writeVegetationField(engine, terrain.vegetation);

    this.#port.post(
      envelope("WORLD_READY", {
        world,
        hostRuntime: merged,
        terrain: terrainBuffer,
        telemetry: this.#buildTelemetry(0),
      }),
      [terrainBuffer],
    );

    // A world opens with one picture already on screen, before any speed is
    // chosen: a paused world must still be visible.
    this.#emitRenderSnapshot();
  }

  /** Stop scheduling, release the engine and refuse further work. */
  dispose(): void {
    this.#stopLoop();
    this.#engine = null;
    this.#world = null;
    this.#renderPool = null;
    this.#vegetationPool = null;
    this.#disposed = true;
  }

  // --- Run state -------------------------------------------------------------

  #setSpeed(speed: SimulationSpeed): void {
    if (this.#engine === null) {
      throw new Error("cannot set run state before a world is initialized");
    }
    if (this.#fatal) {
      return;
    }
    this.#speed = speed;

    // Reset the tick debt on every speed change, including pause and resume.
    //
    // Without this, a world paused for thirty seconds would owe 600 ticks at 1x
    // the instant it resumed and would sprint through them, and a switch from
    // 1x to 100x would carry the old debt forward at the new rate. Both are the
    // same bug: wall-clock time that passed while a speed was NOT in effect
    // must not be billed to it.
    this.#tickDebt = 0;
    this.#lastLoopAt = this.#clock.now();

    if (speed === "paused") {
      this.#stopLoop();
      // Telemetry immediately, so the HUD shows "paused" without waiting for a
      // cadence that only advances while the loop runs.
      this.#emitTelemetry();
      return;
    }
    this.#ensureLoopScheduled(0);
  }

  #ensureLoopScheduled(delayMs: number): void {
    if (this.#loopHandle !== null || this.#disposed || this.#fatal) {
      return;
    }
    if (this.#speed === "paused" || this.#engine === null) {
      return;
    }
    this.#loopHandle = this.#scheduler.schedule(() => {
      this.#runLoopIteration();
    }, delayMs);
  }

  #stopLoop(): void {
    if (this.#loopHandle !== null) {
      this.#scheduler.cancel(this.#loopHandle);
      this.#loopHandle = null;
    }
  }

  // --- The loop --------------------------------------------------------------

  #runLoopIteration(): void {
    // The handle is consumed the moment the callback runs, so anything the
    // iteration does — including a synchronous pause triggered by a message
    // delivered mid-slice — sees an accurate "no iteration pending".
    this.#loopHandle = null;
    if (this.#disposed || this.#fatal || this.#insideLoop) {
      return;
    }
    const engine = this.#engine;
    if (engine === null || this.#speed === "paused") {
      return;
    }

    this.#insideLoop = true;
    try {
      const executed = this.#runTickSlice(engine);
      this.#telemetryWindowTicks += executed;
      this.#emitRenderSnapshotIfDue();
      this.#emitVegetationIfDue();
      this.#emitTelemetryIfDue();
    } catch (error) {
      this.#reportError(error instanceof Error ? error.message : String(error), true, "tick", null);
      return;
    } finally {
      this.#insideLoop = false;
    }

    this.#ensureLoopScheduled(this.#nextDelayMs());
  }

  /**
   * Execute the ticks this slice owes, bounded by the slice time budget and by
   * a hard tick cap. Returns how many ticks ran.
   *
   * Both bounds matter. The time budget is what keeps the Worker responsive at
   * MAX (docs/02 §8). The tick cap is what keeps the loop terminating when the
   * clock does not advance — under a fake clock in tests, but also under a
   * coarse real one.
   */
  #runTickSlice(engine: SimulationEngine): number {
    const runtime = this.#hostRuntime;
    const sliceStart = this.#clock.now();
    const sliceBudgetMs = runtime.maxWorkerSliceMs;
    let executed = 0;

    if (this.#speed === "max") {
      const cap = runtime.maxTicksPerSlice;
      while (executed < cap) {
        this.#stepOnce(engine);
        executed += 1;
        if (MAX_MODE_CLOCK_CHECK_EVERY_TICK && this.#clock.now() - sliceStart >= sliceBudgetMs) {
          break;
        }
      }
      this.#behindTarget = false;
      this.#lastLoopAt = this.#clock.now();
      return executed;
    }

    const tps = targetTicksPerSecond(this.#speed, runtime.targetTicksPerSecond1x);
    const now = this.#clock.now();
    const elapsedMs = Math.max(0, now - this.#lastLoopAt);
    this.#lastLoopAt = now;
    this.#tickDebt += (elapsedMs * tps) / 1000;

    // Cap the debt rather than let it grow without bound. A tab that was
    // backgrounded for a minute must not come back and sprint through 1200
    // ticks; it resumes from where it is, and the HUD reports that it fell
    // behind.
    if (this.#tickDebt > runtime.maxCatchUpTicks) {
      this.#tickDebt = runtime.maxCatchUpTicks;
      this.#behindTarget = true;
    }

    while (this.#tickDebt >= 1 && executed < runtime.maxTicksPerSlice) {
      this.#stepOnce(engine);
      executed += 1;
      this.#tickDebt -= 1;
      if (this.#clock.now() - sliceStart >= sliceBudgetMs) {
        break;
      }
    }
    // Still owing a whole tick after the slice ended means the machine cannot
    // sustain the requested rate.
    this.#behindTarget = this.#tickDebt >= 1;
    return executed;
  }

  #stepOnce(engine: SimulationEngine): void {
    this.#profiler.beginTick();
    engine.step();
    this.#profiler.endTick();
  }

  /**
   * Delay before the next slice.
   *
   * MAX yields with zero delay: the point is to return to the event loop so
   * queued messages are handled, not to wait. Paced speeds wait until the next
   * tick is actually due, which keeps the Worker idle between ticks instead of
   * spinning on a clock comparison.
   */
  #nextDelayMs(): number {
    if (this.#speed === "max") {
      return 0;
    }
    const tps = targetTicksPerSecond(this.#speed, this.#hostRuntime.targetTicksPerSecond1x);
    if (tps <= 0) {
      return 0;
    }
    const msUntilNextTick = ((1 - this.#tickDebt) * 1000) / tps;
    return Math.max(0, Math.min(msUntilNextTick, 1000 / tps));
  }

  // --- Outbound streams ------------------------------------------------------

  #emitRenderSnapshotIfDue(): void {
    if (!this.#renderStreamEnabled) {
      return;
    }
    const rate =
      this.#speed === "max"
        ? this.#hostRuntime.maxModeRenderSnapshotsPerSecond
        : this.#hostRuntime.normalRenderSnapshotsPerSecond;
    const now = this.#clock.now();
    if (now - this.#lastRenderAt < 1000 / rate) {
      return;
    }
    // The cadence clock advances whether or not a buffer was available. Leaving
    // it behind on a dry pool would retry on every slice — hundreds of times a
    // second at high speed — and would turn `droppedSnapshots` into a count of
    // refused *attempts* rather than of frames the viewer actually lost.
    this.#lastRenderAt = now;
    this.#emitRenderSnapshot();
  }

  #emitRenderSnapshot(): void {
    const engine = this.#engine;
    const pool = this.#renderPool;
    if (engine === null || pool === null || !this.#renderStreamEnabled) {
      return;
    }
    const buffer = pool.acquire();
    if (buffer === null) {
      // Every buffer is still with the renderer. Skip this frame — the picture
      // is allowed to be late, the simulation is not.
      return;
    }
    const startedAt = this.#clock.now();
    const view = viewRenderSnapshot(buffer);
    const counts = writeRenderSnapshot(engine, view);
    view.header[RenderHeader.OrganismCount] = counts.organismCount;
    view.header[RenderHeader.CarcassCount] = counts.carcassCount;
    view.header[RenderHeader.Tick] = engine.tick;
    this.#profiler.recordHostPhase(TickPhase.RenderSnapshot, this.#clock.now() - startedAt);

    this.#lastRenderAt = this.#clock.now();
    this.#port.post(envelope("RENDER_SNAPSHOT", { buffer, tick: engine.tick }), [buffer]);
  }

  #emitVegetationIfDue(): void {
    const engine = this.#engine;
    const pool = this.#vegetationPool;
    if (engine === null || pool === null || !this.#renderStreamEnabled) {
      return;
    }
    const now = this.#clock.now();
    if (now - this.#lastVegetationAt < 1000 / this.#hostRuntime.vegetationSnapshotsPerSecond) {
      return;
    }
    // Same reasoning as the render cadence: the clock advances even when the
    // pool is dry, so a missed field costs one skipped update rather than a
    // retry on every slice.
    this.#lastVegetationAt = now;
    const buffer = pool.acquire();
    if (buffer === null) {
      return;
    }
    const view = viewVegetationSnapshot(buffer);
    writeVegetationField(engine, view.vegetation);
    view.header[FieldHeader.Tick] = engine.tick;
    this.#port.post(envelope("VEGETATION_SNAPSHOT", { buffer, tick: engine.tick }), [buffer]);
  }

  #emitTelemetryIfDue(): void {
    const now = this.#clock.now();
    if (now - this.#lastTelemetryAt < 1000 / this.#hostRuntime.telemetrySnapshotsPerSecond) {
      return;
    }
    this.#emitTelemetry();
  }

  /**
   * Send one telemetry frame and open a new measurement window.
   *
   * The achieved rate is ticks executed since the previous frame divided by the
   * wall time since the previous frame — a measurement of what happened, never
   * an input to anything. Nothing in the engine can read it.
   */
  #emitTelemetry(): void {
    if (this.#engine === null) {
      return;
    }
    const now = this.#clock.now();
    const windowMs = Math.max(0, now - this.#telemetryWindowStart);
    const achieved = windowMs > 0 ? (this.#telemetryWindowTicks * 1000) / windowMs : 0;
    const telemetry = this.#buildTelemetry(achieved);

    this.#lastTelemetryAt = now;
    this.#telemetryWindowStart = now;
    this.#telemetryWindowTicks = 0;
    this.#profiler.resetWindow();

    this.#port.post(envelope("TELEMETRY", telemetry));
  }

  #buildTelemetry(achievedTicksPerSecond: number): TelemetryDto {
    const engine = this.#engine;
    if (engine === null) {
      throw new Error("telemetry requested before a world exists");
    }
    const aggregates = collectTelemetryAggregates(engine);
    const organisms = engine.organisms;
    const deathsByCause: number[] = new Array<number>(DEATH_CAUSE_COUNT);
    for (let cause = 0; cause < DEATH_CAUSE_COUNT; cause += 1) {
      deathsByCause[cause] = organisms.deathsByCause[cause] as number;
    }
    const target =
      this.#speed === "max" || this.#speed === "paused"
        ? null
        : targetTicksPerSecond(this.#speed, this.#hostRuntime.targetTicksPerSecond1x);

    return {
      tick: engine.tick,
      population: aggregates.population,
      totalBirths: organisms.totalBirths,
      totalDeaths: organisms.totalDeaths,
      capRejectedBirths: organisms.capRejectedBirths,
      deathsByCause,
      carcassCount: engine.carcasses.liveCount,
      plantBiomass: aggregates.plantBiomass,
      plantCapacity: aggregates.plantCapacity,
      maxGeneration: aggregates.maxGeneration,
      speed: this.#speed,
      achievedTicksPerSecond,
      targetTicksPerSecond: target,
      behindTarget: this.#behindTarget,
      renderBuffersInFlight: this.#renderPool?.inFlight ?? 0,
      droppedRenderSnapshots: this.#renderPool?.droppedSnapshots ?? 0,
      phaseMillis: this.#profiler.meanMillis(),
    };
  }

  // --- Queries ---------------------------------------------------------------

  #answerEntityQuery(entityId: number, requestId: number): void {
    const engine = this.#engine;
    if (engine === null) {
      throw new Error("cannot query an entity before a world is initialized");
    }
    this.#port.post(
      requestEnvelope(
        "ENTITY_DETAILS",
        { entityId, details: queryEntity(engine, entityId), tick: engine.tick },
        requestId,
      ),
    );
  }

  #answerStateHashQuery(targetTick: number | null, requestId: number): void {
    const engine = this.#engine;
    if (engine === null) {
      throw new Error("cannot hash state before a world is initialized");
    }
    if (targetTick !== null) {
      if (targetTick < engine.tick) {
        throw new Error(
          `cannot hash tick ${targetTick}: the world is already at ${engine.tick} and the engine ` +
            "cannot step backwards",
        );
      }
      // Deliberately synchronous and unpaced. This path exists for
      // determinism verification, where "run exactly N ticks" must mean exactly
      // that and must not be interleaved with anything else.
      const remaining = targetTick - engine.tick;
      for (let i = 0; i < remaining; i += 1) {
        this.#stepOnce(engine);
      }
      this.#telemetryWindowTicks += remaining;
    }
    this.#port.post(
      requestEnvelope(
        "STATE_HASH",
        { tick: engine.tick, hash: engine.computeStateHash(), engineVersion: ENGINE_VERSION },
        requestId,
      ),
    );
  }

  // --- Failure ---------------------------------------------------------------

  #reportError(
    message: string,
    fatal: boolean,
    whileHandling: string | null,
    requestId: number | null,
  ): void {
    if (fatal) {
      this.#fatal = true;
      this.#stopLoop();
    }
    const payload = {
      message,
      fatal,
      tick: this.#engine?.tick ?? null,
      seed: this.#world?.seed ?? null,
      engineVersion: ENGINE_VERSION,
      whileHandling,
    };
    this.#port.post(
      requestId === null
        ? envelope("ERROR", payload)
        : requestEnvelope("ERROR", payload, requestId),
    );
  }
}
