import {
  BRAIN_INPUT_NAMES,
  BRAIN_OUTPUT_NAMES,
  BrushFalloff,
  COMMAND_REJECT_REASON_NAMES,
  CONFIG_SCHEMA_VERSION,
  DEATH_CAUSE_COUNT,
  DEATH_CAUSE_NAMES,
  DEFAULT_CONFIG,
  ENGINE_VERSION,
  EVENT_SEVERITY_NAMES,
  INTERVENTION_KIND_NAMES,
  InterventionKind,
  POS_SCALE,
  Q,
  Reconstruction,
  SNAPSHOT_SCHEMA_VERSION,
  SPECIES_END_REASON_NAMES,
  SimulationEngine,
  TEMPERATURE_DISPLAY_MAX_CENTI_C,
  TEMPERATURE_DISPLAY_MIN_CENTI_C,
  TICK_PHASE_NAMES,
  TRAIT_DIM_NAMES,
  TickPhase,
  WORLD_EVENT_TYPE_NAMES,
  capacityDisplayReference,
  collectTelemetryAggregates,
  estimateEngineMemory,
  memoryCategories,
  queryEntity,
  queryHistory,
  querySpecies,
  queryTree,
  prepareBranchSnapshot,
  writeRenderSnapshot,
  writeTerrainFields,
  writeVegetationField,
  type CommandInput,
  type HistorySlice,
  type SimulationConfig,
  type SpeciesDetails,
  type SpeciesSummary,
  type ReconstructionProgress,
} from "@eon/engine";
import {
  decodeDurableSnapshot,
  encodeDurableSnapshot,
  verifyRestoredStateHash,
} from "@eon/persistence/codec";
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
  type CommandRequestDto,
  type CommandResultDto,
  type HistorySliceDto,
  type HostRuntimeConfig,
  type MainToWorkerMessage,
  type MemoryTelemetryDto,
  type SimulationSpeed,
  type SpeciesDetailsDto,
  type SpeciesSummaryDto,
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

/** A replay in flight: what it is reconstructing, for whom, and its timer. */
interface ReplayJob {
  reconstruction: Reconstruction;
  /** Correlates every progress report and the final answer with one request. */
  requestId: number;
  handle: HostTimerHandle | null;
}

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
  /** Command-log cursor at the last terrain check; a move means terrain may have changed. */
  #lastAppliedCommandCursor = 0;

  /**
   * The reconstructed world being previewed, or null in the present
   * (Milestone 11).
   *
   * A SECOND engine, never the live one. The live engine is not rewound, not
   * advanced and not commanded while this is set, which is what makes "return
   * to present" a mode switch rather than a reload — and what makes it
   * impossible for a preview to leak into the world it was taken from.
   */
  #historical: SimulationEngine | null = null;
  /** The replay in flight, or null. Only one at a time; a newer one cancels it. */
  #replay: ReplayJob | null = null;

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
        if (this.previewing) {
          // Time controls belong to the present. Ignored rather than refused:
          // a speed button is not a request that can fail, and the UI disables
          // them anyway.
          return;
        }
        this.#setSpeed(message.payload.speed);
        return;
      case "QUEUE_COMMAND":
        if (this.previewing) {
          // The read-only rule, enforced where it cannot be forgotten. A tool
          // left enabled by a UI bug would otherwise edit the present while the
          // screen shows the past — the exact confusion historical mode exists
          // to prevent.
          this.#reportError(
            "interventions are disabled while previewing history; return to the present or " +
              "branch from this tick first",
            false,
            "QUEUE_COMMAND",
            message.requestId ?? null,
          );
          return;
        }
        this.#queueCommand(message.payload.command, message.requestId ?? 0);
        return;
      case "QUERY_ENTITY":
        this.#answerEntityQuery(message.payload.entityId, message.requestId ?? 0);
        return;
      case "QUERY_SPECIES":
        this.#answerSpeciesQuery(message.payload.speciesId, message.requestId ?? 0);
        return;
      case "REQUEST_TREE":
        this.#answerTreeRequest(message.requestId ?? 0);
        return;
      case "REQUEST_HISTORY_RANGE":
        this.#answerHistoryRequest(message.payload.sinceEventId, message.requestId ?? 0);
        return;
      case "QUERY_STATE_HASH":
        this.#answerStateHashQuery(message.payload.targetTick, message.requestId ?? 0);
        return;
      case "REQUEST_SAVE": {
        const reason = message.payload.reason;
        if (this.previewing) {
          // Saving here would store the live world under the tick the user is
          // looking at — a save whose contents and label disagree.
          this.#reportError(
            "cannot save while previewing history; return to the present or branch instead",
            false,
            "REQUEST_SAVE",
            message.requestId ?? null,
          );
          return;
        }
        if (reason === "branch") {
          // A branch save is not this world's save. It becomes ANOTHER world's
          // origin, and it must have this world's queued future stripped first
          // or the branch would inherit commands the player never asked it to
          // run. That is CREATE_BRANCH's job, and only it can do it.
          this.#reportError(
            "a branch origin cannot be produced by REQUEST_SAVE; use CREATE_BRANCH",
            false,
            "REQUEST_SAVE",
            message.requestId ?? null,
          );
          return;
        }
        this.#answerSaveRequest(reason, message.requestId ?? 0);
        return;
      }
      case "LOAD_WORLD":
        this.#loadWorld(
          message.payload.snapshot as ArrayBuffer,
          message.payload.hostRuntime,
          message.payload.speed,
        );
        return;
      case "REQUEST_REWIND":
        this.#beginRewind(
          message.payload.snapshot as ArrayBuffer,
          message.payload.targetTick,
          message.requestId ?? 0,
        );
        return;
      case "RETURN_TO_PRESENT":
        this.#returnToPresent();
        return;
      case "CREATE_BRANCH":
        this.#answerBranchRequest(message.payload.branchTick, message.requestId ?? 0);
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
    const authoritativeConfig =
      config === null || config === undefined ? DEFAULT_CONFIG : (config as SimulationConfig);
    this.#adoptEngine(new SimulationEngine({ seed, config: authoritativeConfig }), hostRuntime);
  }

  /**
   * Resume a world from a durable snapshot (Milestone 10, task K04).
   *
   * Order is the whole design here: the container is validated, the engine is
   * rebuilt and its canonical hash is checked against the one recorded at save
   * time — all before a single field of this host changes. A save that turns
   * out to be corrupt, or written by another engine version, therefore leaves
   * the world that is currently running exactly as it was, and the failure
   * surfaces as an ordinary (non-fatal) error the UI can show.
   */
  #loadWorld(
    snapshot: ArrayBuffer,
    hostRuntime: Partial<HostRuntimeConfig> | null,
    speed: SimulationSpeed,
  ): void {
    const { header, snapshot: state } = decodeDurableSnapshot(new Uint8Array(snapshot));
    const engine = SimulationEngine.fromSnapshot(state);
    // The end-to-end check: bytes survived (checksum) AND this build reads them
    // as the same simulation state the writing build held (state hash).
    verifyRestoredStateHash(header, engine.computeStateHash());

    this.#adoptEngine(engine, hostRuntime);
    this.#setSpeed(speed);
  }

  /**
   * Make `engine` this host's world and announce it.
   *
   * Shared by "new world" and "loaded world" so a restored world is hosted by
   * exactly the same code path as a fresh one — no second, subtly different
   * WORLD_READY to drift out of sync.
   */
  #adoptEngine(engine: SimulationEngine, hostRuntime: Partial<HostRuntimeConfig> | null): void {
    // Stop whatever was running before touching any field: adopting a second
    // world while the first one's loop is still scheduled is exactly the race
    // that would produce two engines stepping into one port.
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
      // Labels and legend ranges copied from engine constants here, in the one
      // place that legitimately imports both packages — so the UI can caption
      // engine numbers without an engine dependency, and the legend can never
      // disagree with the writer that quantized the field.
      display: {
        brainInputLabels: [...BRAIN_INPUT_NAMES],
        brainIntentLabels: [...BRAIN_OUTPUT_NAMES],
        deathCauseLabels: [...DEATH_CAUSE_NAMES],
        eventTypeLabels: [...WORLD_EVENT_TYPE_NAMES],
        eventSeverityLabels: [...EVENT_SEVERITY_NAMES],
        speciesEndReasonLabels: [...SPECIES_END_REASON_NAMES],
        traitDimensionLabels: [...TRAIT_DIM_NAMES],
        interventionKindLabels: [...INTERVENTION_KIND_NAMES],
        tickPhaseLabels: [...TICK_PHASE_NAMES],
        temperatureDisplayMinC: TEMPERATURE_DISPLAY_MIN_CENTI_C / 100,
        temperatureDisplayMaxC: TEMPERATURE_DISPLAY_MAX_CENTI_C / 100,
        capacityDisplayReference: capacityDisplayReference(engine.config),
        // Tool bounds verbatim from the authoritative config (Milestone 9), so
        // the UI's sliders can never promise a value the engine would reject.
        interventions: {
          brushSampleSpacingLU: engine.config.interventions.brushSampleSpacingLU,
          maxBrushSamplesPerCommand: engine.config.interventions.maxBrushSamplesPerCommand,
          minBrushRadiusLU: engine.config.interventions.minBrushRadiusLU,
          maxBrushRadiusLU: engine.config.interventions.maxBrushRadiusLU,
          maxTemperatureBrushStrengthCentiC:
            engine.config.interventions.maxTemperatureBrushStrengthCentiC,
          maxMoistureBrushStrengthQ: engine.config.interventions.maxMoistureBrushStrengthQ,
          maxFertilityBrushStrengthQ: engine.config.interventions.maxFertilityBrushStrengthQ,
          maxTerrainBrushStrengthQ: engine.config.interventions.maxTerrainBrushStrengthQ,
          maxBiomassBrushStrengthUnits: engine.config.interventions.maxBiomassBrushStrengthUnits,
          maxGlobalTemperatureOffsetCentiC:
            engine.config.interventions.maxGlobalTemperatureOffsetCentiC,
          meteorMinRadiusLU: engine.config.interventions.meteor.minRadiusLU,
          meteorMaxRadiusLU: engine.config.interventions.meteor.maxRadiusLU,
        },
      },
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
    // `behindTarget` describes a loop, and the loop it described belonged to
    // the world being replaced. Left standing, a world loaded into a paused
    // host announces itself as "Behind" about a loop that no longer exists —
    // and, paused, never runs a slice to correct it. (The Milestone 6 review
    // found this for a re-INIT and called it unreachable through the app; a
    // load replaces the world inside the running Worker, so it is reachable.)
    this.#behindTarget = false;
    // A restored world resumes mid-history: starting this at 0 would make the
    // first tick after a load look like "commands were applied" and re-ship
    // terrain for nothing.
    this.#lastAppliedCommandCursor = engine.commands.cursor;
    this.#telemetryWindowStart = this.#clock.now();
    this.#telemetryWindowTicks = 0;
    // A new world must not inherit the previous one's stream state: a viewer
    // who suspended the old world's pictures still expects the new world to
    // open with one on screen, and "behind target" is a claim about a loop
    // that no longer exists.
    this.#renderStreamEnabled = true;
    this.#behindTarget = false;
    this.#profiler.resetWindow();

    const terrainBuffer = createTerrainBuffer(world.gridSize);
    const terrain = viewTerrainSnapshot(terrainBuffer);
    writeTerrainFields(engine, terrain);
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

  /**
   * The engine the UI is looking at: the preview when one is open, otherwise
   * the live world.
   *
   * Every read-only projection — render snapshots, telemetry, the inspector,
   * the tree, the event feed, the state hash — goes through here, so the
   * inspector describes the tick on screen rather than a present nobody is
   * watching. Everything that CHANGES state deliberately does not.
   */
  #viewEngine(): SimulationEngine | null {
    return this.#historical ?? this.#engine;
  }

  /** True while a historical preview is open or being reconstructed. */
  get previewing(): boolean {
    return this.#historical !== null || this.#replay !== null;
  }

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
      this.#emitTerrainIfCommandsApplied();
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

  // --- Player commands (Milestone 9) ------------------------------------------

  /**
   * Queue one player command with the engine and answer with its verdict.
   *
   * The host converts wire shapes to engine inputs and back; it decides
   * NOTHING about validity — acceptance, bounds and the target tick are the
   * engine's judgement, returned as a deterministic result rather than an
   * exception, so a rejected command becomes a toast and never a dead world.
   */
  #queueCommand(request: CommandRequestDto, requestId: number): void {
    const engine = this.#engine;
    if (engine === null) {
      throw new Error("cannot queue a command before a world is initialized");
    }
    const result = engine.queueCommand(commandInputFromDto(request));
    const dto: CommandResultDto = result.accepted
      ? {
          accepted: true,
          kind: request.kind,
          commandId: result.command.id,
          tick: result.command.tick,
          sequence: result.command.sequence,
        }
      : {
          accepted: false,
          kind: request.kind,
          reason: (COMMAND_REJECT_REASON_NAMES[result.reason] ??
            "malformed") as (CommandResultDto & { accepted: false })["reason"],
          detail: result.detail,
        };
    this.#port.post(
      requestEnvelope("COMMAND_RESULT", { result: dto, tick: engine.tick }, requestId),
    );
  }

  /**
   * Re-ship the packed terrain fields if any command was applied since the
   * last check. Commands are the only thing that can change terrain between
   * WORLD_READY snapshots, and they apply inside `step()`, so polling the
   * log's cursor once per loop slice is exact — no applied command can be
   * missed, and a world with no interventions never re-sends a byte.
   */
  #emitTerrainIfCommandsApplied(): void {
    const engine = this.#engine;
    const world = this.#world;
    if (engine === null || world === null) {
      return;
    }
    if (engine.commands.cursor === this.#lastAppliedCommandCursor) {
      return;
    }
    this.#lastAppliedCommandCursor = engine.commands.cursor;
    this.#emitTerrainNow();
  }

  /**
   * Send the terrain of whichever world is on screen, unconditionally.
   *
   * The change-gated path above cannot serve historical mode: entering a
   * preview changes the terrain without applying a single command, and leaving
   * it changes the terrain back.
   */
  #emitTerrainNow(): void {
    const engine = this.#viewEngine();
    const world = this.#world;
    if (engine === null || world === null) {
      return;
    }
    const terrainBuffer = createTerrainBuffer(world.gridSize);
    const terrain = viewTerrainSnapshot(terrainBuffer);
    writeTerrainFields(engine, terrain);
    writeVegetationField(engine, terrain.vegetation);
    terrain.header[FieldHeader.Tick] = engine.tick;
    this.#port.post(envelope("TERRAIN_SNAPSHOT", { buffer: terrainBuffer, tick: engine.tick }), [
      terrainBuffer,
    ]);
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
    const engine = this.#viewEngine();
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
    const engine = this.#viewEngine();
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
    if (this.#viewEngine() === null) {
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
    const engine = this.#viewEngine();
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
      organismMass: aggregates.organismMass,
      meanEnergyFraction: aggregates.meanEnergyFraction,
      traitMeans: aggregates.traitMeans,
      activeSpeciesCount: engine.species.activeCount,
      totalSpeciesCount: engine.species.count,
      extinctSpeciesCount:
        engine.species.count - engine.species.activeCount - countSplitSpecies(engine),
      latestEventId: engine.events.latestEventId,
      pendingCommandCount: engine.commands.pendingCount,
      speed: this.#speed,
      achievedTicksPerSecond,
      targetTicksPerSecond: target,
      behindTarget: this.#behindTarget,
      renderBuffersInFlight: this.#renderPool?.inFlight ?? 0,
      droppedRenderSnapshots: this.#renderPool?.droppedSnapshots ?? 0,
      phaseMillis: this.#profiler.meanMillis(),
      memory: this.#memoryTelemetry(engine),
    };
  }

  /**
   * Worker-side memory occupancy for the development HUD (docs/07 §11).
   *
   * Measured at telemetry cadence, which is ~2 Hz — the walk over species
   * records, retained events and the command log is bounded by the engine's own
   * caps, and this is off the tick path entirely.
   */
  #memoryTelemetry(engine: SimulationEngine): MemoryTelemetryDto {
    const estimate = estimateEngineMemory(engine);
    return {
      engineTotalBytes: estimate.bytes.total,
      engineBytesByCategory: memoryCategories(estimate.bytes),
      renderPoolBytes: this.#renderPool?.allocatedBytes ?? 0,
      organismCapacity: estimate.context.organismCapacity,
      bytesPerOrganismSlot: Math.round(estimate.context.bytesPerOrganismSlot),
    };
  }

  // --- Queries ---------------------------------------------------------------

  #answerEntityQuery(entityId: number, requestId: number): void {
    const engine = this.#viewEngine();
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

  #answerSpeciesQuery(speciesId: number, requestId: number): void {
    const engine = this.#viewEngine();
    if (engine === null) {
      throw new Error("cannot query a species before a world is initialized");
    }
    const details = querySpecies(engine, speciesId);
    this.#port.post(
      requestEnvelope(
        "SPECIES_DETAILS",
        {
          speciesId,
          details: details === null ? null : speciesDetailsDto(details),
          tick: engine.tick,
        },
        requestId,
      ),
    );
  }

  #answerTreeRequest(requestId: number): void {
    const engine = this.#viewEngine();
    if (engine === null) {
      throw new Error("cannot snapshot the tree before a world is initialized");
    }
    const tree = queryTree(engine);
    this.#port.post(
      requestEnvelope(
        "TREE_SNAPSHOT",
        { tree: { tick: tree.tick, species: tree.species.map(speciesSummaryDto) } },
        requestId,
      ),
    );
  }

  #answerHistoryRequest(sinceEventId: number, requestId: number): void {
    const engine = this.#viewEngine();
    if (engine === null) {
      throw new Error("cannot fetch history before a world is initialized");
    }
    this.#port.post(
      requestEnvelope(
        "HISTORY_EVENTS",
        { history: historySliceDto(queryHistory(engine, sinceEventId)) },
        requestId,
      ),
    );
  }

  #answerStateHashQuery(targetTick: number | null, requestId: number): void {
    const engine = this.#viewEngine();
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
      this.#emitTerrainIfCommandsApplied();
    }
    this.#port.post(
      requestEnvelope(
        "STATE_HASH",
        { tick: engine.tick, hash: engine.computeStateHash(), engineVersion: ENGINE_VERSION },
        requestId,
      ),
    );
  }

  /**
   * Serialize the running world into a durable snapshot and transfer it
   * (Milestone 10, task K04).
   *
   * Saving is a *read* of authoritative state. It draws no randomness, steps
   * nothing and mutates nothing: `serialize()` hands over detached copies, and
   * the container is built from those. A world saved at tick N therefore has
   * exactly the future it would have had if nobody had ever pressed Save — the
   * property the whole milestone exists to guarantee.
   *
   * The bytes are transferred rather than copied, so a multi-megabyte save does
   * not double its own cost crossing the port.
   */
  #answerSaveRequest(reason: "manual" | "autosave", requestId: number): void {
    const engine = this.#engine;
    if (engine === null) {
      throw new Error("cannot save before a world is initialized");
    }
    const stateHash = engine.computeStateHash();
    const bytes = encodeDurableSnapshot({
      snapshot: engine.serialize(),
      stateHash,
      configHash: engine.configHash,
    });
    // `encodeDurableSnapshot` returns a Uint8Array that exactly fills its own
    // buffer, so transferring that buffer transfers precisely the save.
    const buffer = bytes.buffer as ArrayBuffer;
    this.#port.post(
      requestEnvelope(
        "SNAPSHOT_DATA",
        {
          buffer,
          tick: engine.tick,
          stateHash,
          engineVersion: ENGINE_VERSION,
          snapshotSchemaVersion: SNAPSHOT_SCHEMA_VERSION,
          configHash: engine.configHash,
          seed: engine.seed,
          reason,
        },
        requestId,
      ),
      [buffer],
    );
  }

  // --- Historical mode (Milestone 11, tasks K07-K10) --------------------------

  /**
   * Reconstruct `targetTick` from the supplied save and enter historical mode.
   *
   * The main thread chose the save — it owns the database — and this side does
   * the only thing it can do with it: restore it into a second engine and step
   * that engine forward. The replay runs in slices on the host's own timer,
   * bounded by the same budget as the tick loop, so a 10 000-tick rewind
   * reports progress and leaves the port responsive instead of freezing the
   * Worker for half a minute.
   *
   * The live world is paused first. Replaying towards a moving present would
   * make the target a goalpost that shifts while you approach it.
   */
  #beginRewind(snapshot: ArrayBuffer, targetTick: number, requestId: number): void {
    const live = this.#engine;
    if (live === null) {
      throw new Error("cannot rewind before a world is initialized");
    }
    if (targetTick > live.tick) {
      throw new Error(
        `cannot rewind to tick ${targetTick}: the world has only reached ${live.tick}`,
      );
    }

    // A newer request supersedes an older one outright. Two replays sharing
    // the timer would interleave slices and the loser could still win the race
    // to install itself as "the state you are looking at".
    this.#cancelReplay();
    this.#setSpeed("paused");

    const { header, snapshot: state } = decodeDurableSnapshot(new Uint8Array(snapshot));
    const restored = SimulationEngine.fromSnapshot(state);
    verifyRestoredStateHash(header, restored.computeStateHash());

    if (restored.tick > targetTick) {
      throw new Error(
        `the supplied save is at tick ${restored.tick}, after the requested ${targetTick}; ` +
          "a rewind replays forward from an earlier save",
      );
    }

    const reconstruction = new Reconstruction({ snapshot: state, targetTick });
    this.#replay = { reconstruction, requestId, handle: null };
    this.#postRewindProgress(reconstruction.progress, requestId);
    this.#scheduleReplaySlice();
  }

  /** Run one replay slice, then either schedule the next or finish. */
  #runReplaySlice(): void {
    const job = this.#replay;
    if (job === null || this.#disposed) {
      return;
    }
    job.handle = null;

    const runtime = this.#hostRuntime;
    const sliceStart = this.#clock.now();
    while (!job.reconstruction.done) {
      job.reconstruction.advance(1);
      if (this.#clock.now() - sliceStart >= runtime.maxWorkerSliceMs) {
        break;
      }
    }

    this.#postRewindProgress(job.reconstruction.progress, job.requestId);

    if (!job.reconstruction.done) {
      this.#scheduleReplaySlice();
      return;
    }

    this.#replay = null;
    this.#historical = job.reconstruction.engine;
    this.#enterHistoricalMode(job.requestId);
  }

  #scheduleReplaySlice(): void {
    const job = this.#replay;
    if (job === null) {
      return;
    }
    job.handle = this.#scheduler.schedule(() => {
      this.#runReplaySlice();
    }, 0);
  }

  #cancelReplay(): void {
    const job = this.#replay;
    if (job === null) {
      return;
    }
    if (job.handle !== null) {
      this.#scheduler.cancel(job.handle);
    }
    this.#replay = null;
  }

  #postRewindProgress(progress: ReconstructionProgress, requestId: number): void {
    this.#port.post(
      requestEnvelope(
        "REWIND_PROGRESS",
        {
          targetTick: progress.targetTick,
          fromTick: progress.fromTick,
          currentTick: progress.currentTick,
          ticksReplayed: progress.ticksReplayed,
          ticksTotal: progress.ticksTotal,
        },
        requestId,
      ),
    );
  }

  /** Announce the preview and paint it once; a paused world needs no stream. */
  #enterHistoricalMode(requestId: number): void {
    const historical = this.#historical;
    const live = this.#engine;
    if (historical === null || live === null) {
      return;
    }
    this.#port.post(
      requestEnvelope(
        "HISTORICAL_MODE_READY",
        {
          tick: historical.tick,
          presentTick: live.tick,
          stateHash: historical.computeStateHash(),
          earliestTick: 0,
        },
        requestId,
      ),
    );
    this.#emitHistoricalProjection();
  }

  /**
   * Push one full projection of whichever world is now on screen.
   *
   * Entering or leaving a preview replaces every pixel: terrain, vegetation and
   * organisms all belong to a different tick. The cadence timers are bypassed
   * on purpose — this is not a frame of an animation, it is the answer to
   * "show me that tick".
   */
  #emitHistoricalProjection(): void {
    this.#emitTerrainNow();
    // The cadence timers are reset rather than respected: this is the answer to
    // "show me that tick", not a frame of a stream, and a preview that painted
    // 200 ms late would look like the rewind had failed.
    this.#lastRenderAt = Number.NEGATIVE_INFINITY;
    this.#lastVegetationAt = Number.NEGATIVE_INFINITY;
    this.#lastTelemetryAt = Number.NEGATIVE_INFINITY;
    this.#emitRenderSnapshot();
    this.#emitVegetationIfDue();
    this.#emitTelemetry();
  }

  /**
   * Leave historical mode. The live world is exactly where it was left: it was
   * never stepped, so there is nothing to restore and nothing to reload.
   */
  #returnToPresent(): void {
    this.#cancelReplay();
    if (this.#historical === null) {
      return;
    }
    this.#historical = null;
    this.#emitHistoricalProjection();
  }

  /**
   * Answer with the bytes that become a new world's origin (task K10).
   *
   * Serializes the PREVIEW, not the live world, and strips the parent's queued
   * future first: commands the parent has waiting for a later tick are its
   * future, not the history this branch inherits. The main thread writes the
   * result under a new manifest; nothing here touches the source world, which
   * is why branching cannot damage it.
   */
  #answerBranchRequest(branchTick: number, requestId: number): void {
    const historical = this.#historical;
    if (historical === null) {
      this.#reportError(
        "a branch can only be created from an open historical preview",
        false,
        "CREATE_BRANCH",
        requestId,
      );
      return;
    }
    if (historical.tick !== branchTick) {
      this.#reportError(
        `branch point ${branchTick} does not match the previewed tick ${historical.tick}`,
        false,
        "CREATE_BRANCH",
        requestId,
      );
      return;
    }

    const origin = prepareBranchSnapshot(historical.serialize(), branchTick);
    const restored = SimulationEngine.fromSnapshot(origin);
    const stateHash = restored.computeStateHash();
    const bytes = encodeDurableSnapshot({
      snapshot: origin,
      stateHash,
      configHash: restored.configHash,
    });
    const buffer = bytes.buffer as ArrayBuffer;

    this.#port.post(
      requestEnvelope(
        "SNAPSHOT_DATA",
        {
          buffer,
          tick: branchTick,
          stateHash,
          engineVersion: ENGINE_VERSION,
          snapshotSchemaVersion: SNAPSHOT_SCHEMA_VERSION,
          configHash: restored.configHash,
          seed: restored.seed,
          reason: "branch" as const,
        },
        requestId,
      ),
      [buffer],
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

// --- Command DTO conversion (Milestone 9) -------------------------------------

/** Map the wire kind names onto the engine's numeric InterventionKind. */
const COMMAND_KIND_BY_NAME = {
  setGlobalTemperature: InterventionKind.SetGlobalTemperature,
  paintTemperature: InterventionKind.PaintTemperature,
  paintMoisture: InterventionKind.PaintMoisture,
  paintFertility: InterventionKind.PaintFertility,
  raiseTerrain: InterventionKind.RaiseTerrain,
  lowerTerrain: InterventionKind.LowerTerrain,
  addBiomass: InterventionKind.AddBiomass,
  removeBiomass: InterventionKind.RemoveBiomass,
  meteor: InterventionKind.Meteor,
} as const;

/** Convert a decoded wire request into an engine command input. */
function commandInputFromDto(request: CommandRequestDto): CommandInput {
  const targetTick =
    request.targetTick === null || request.targetTick === undefined
      ? {}
      : { targetTick: request.targetTick };
  if (request.kind === "setGlobalTemperature") {
    return {
      kind: InterventionKind.SetGlobalTemperature,
      offsetCentiC: request.offsetCentiC,
      ...targetTick,
    };
  }
  if (request.kind === "meteor") {
    return {
      kind: InterventionKind.Meteor,
      centerXLU: request.centerXLU,
      centerYLU: request.centerYLU,
      radiusLU: request.radiusLU,
      ...targetTick,
    };
  }
  return {
    kind: COMMAND_KIND_BY_NAME[request.kind],
    radiusLU: request.radiusLU,
    strength: request.strength,
    falloff: request.falloff === "hard" ? BrushFalloff.Hard : BrushFalloff.Linear,
    samplesXLU: [...request.samplesXLU],
    samplesYLU: [...request.samplesYLU],
    ...targetTick,
  };
}

// --- Species/history DTO conversion (Milestone 8) ----------------------------
//
// The engine's query results use its native units (Q fractions, position
// sub-units); the DTOs speak the UI's units (unit fractions, location units).
// The conversion lives here because the host is the one module that
// legitimately imports both packages — the same reason the display labels are
// copied here.

/** Species with `endReason === Split`, for the extinct-count telemetry split. */
function countSplitSpecies(engine: SimulationEngine): number {
  let split = 0;
  for (const record of engine.species.records) {
    if (record.endReason === 1) {
      split += 1;
    }
  }
  return split;
}

function speciesSummaryDto(summary: SpeciesSummary): SpeciesSummaryDto {
  return {
    id: summary.id,
    parentSpeciesId: summary.parentSpeciesId,
    originTick: summary.originTick,
    endTick: summary.endTick,
    endReason: summary.endReason,
    population: summary.population,
    plantEnergyConsumed: summary.plantEnergyConsumed,
    meatEnergyConsumed: summary.meatEnergyConsumed,
    carnivoreDetected: summary.carnivoreDetected,
    centroidDiet: summary.centroidDietQ / Q,
  };
}

function speciesDetailsDto(details: SpeciesDetails): SpeciesDetailsDto {
  return {
    ...speciesSummaryDto(details),
    founderEntityId: details.founderEntityId,
    generationAtOrigin: details.generationAtOrigin,
    totalBirths: details.totalBirths,
    totalDeaths: details.totalDeaths,
    totalKills: details.totalKills,
    centroidTraits: details.centroidTraits.map((value) => value / Q),
    originCentroid: details.originCentroid.map((value) => value / Q),
    candidatePasses: details.candidatePasses,
    stabilityIntervalsRequired: details.stabilityIntervalsRequired,
    childIds: details.childIds,
    meanAgeTicks: details.meanAgeTicks,
    meanEnergyFraction: details.meanEnergyRatioQ / Q,
    series: {
      ticks: details.series.ticks,
      population: details.series.population,
      meanSize: details.series.meanSizeQ.map((value) => value / Q),
      meanSpeed: details.series.meanSpeedQ.map((value) => value / Q),
      meanDiet: details.series.meanDietQ.map((value) => value / Q),
    },
  };
}

function historySliceDto(slice: HistorySlice): HistorySliceDto {
  return {
    tick: slice.tick,
    droppedEventCount: slice.droppedEventCount,
    events: slice.events.map((event) => ({
      id: event.id,
      tick: event.tick,
      type: event.type,
      severity: event.severity,
      speciesIds: event.speciesIds,
      entityIds: event.entityIds,
      region:
        event.regionRadiusPos < 0
          ? null
          : {
              xLU: event.regionXPos / POS_SCALE,
              yLU: event.regionYPos / POS_SCALE,
              radiusLU: event.regionRadiusPos / POS_SCALE,
            },
      payloadVersion: event.payloadVersion,
      payload: event.payload,
    })),
    worldSeries: slice.worldSeries,
  };
}
