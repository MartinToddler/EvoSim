import { EonAssertionError, assert, deepFreezeJson } from "@eon/shared";
import { runBrainsAndBuildIntents } from "./brain/intents";
import { senseAll } from "./brain/sensors";
import { applyCommandsForTick } from "./commands/applyCommands";
import { CommandLog } from "./commands/CommandLog";
import {
  CommandRejectReason,
  validateCommandInput,
  type CommandInput,
  type CommandQueueResult,
} from "./commands/SimulationCommand";
import { cloneConfig, type ReadonlySimulationConfig } from "./config/cloneConfig";
import { hashConfig } from "./config/hashConfig";
import { validateConfig } from "./config/validateConfig";
import { CarcassStore } from "./ecology/CarcassStore";
import { captureCarcasses, restoreCarcasses } from "./ecology/carcassSnapshot";
import { decayCarcasses } from "./ecology/carcasses";
import { buildCombatClaims, resolveCombatSimultaneously } from "./ecology/combatClaims";
import { buildFeedingClaims, resolveFeedingClaims } from "./ecology/feedingClaims";
import { resolveReproduction } from "./ecology/reproduction";
import type { EngineContext } from "./EngineContext";
import { EngineScratch } from "./EngineScratch";
import { SpeciesEndReason, SpeciesStore } from "./evolution/SpeciesStore";
import { analyzeSpecies } from "./evolution/speciation";
import { TRAIT_DIMENSIONS, buildTraitRanges, writeTraitVector } from "./evolution/traitVector";
import { EventSeverity, EventStore, WorldEventType } from "./history/EventStore";
import { EventDetectors, collectStatisticsAndDetectEvents } from "./history/eventDetection";
import { StatisticsStore } from "./history/StatisticsStore";
import { computeStateHash } from "./hashState";
import { attachEngineInternals } from "./internal";
import { POS_SCALE } from "./math/fixed";
import { GenomeStore } from "./organisms/GenomeStore";
import { OrganismStore } from "./organisms/OrganismStore";
import { finalizeDeaths } from "./organisms/death";
import { applyMetabolismGrowthThermalAging } from "./organisms/metabolism";
import { integrateMovement, resolveTerrainAndSoftCollisions } from "./organisms/movement";
import { captureOrganisms, restoreOrganisms } from "./organisms/organismSnapshot";
import { PhenotypeStore } from "./organisms/phenotype";
import { spawnFounderPopulation } from "./organisms/spawn";
import { TickPhase, type TickProfiler } from "./profiling/TickProfiler";
import { Xoshiro128, type Xoshiro128State } from "./random/Xoshiro128";
import { type EngineCoreSnapshot, SnapshotCompatibilityError } from "./snapshot/EngineSnapshot";
import { SpatialGrid } from "./spatial/SpatialGrid";
import { ENGINE_VERSION, SNAPSHOT_SCHEMA_VERSION } from "./version";
import type { EnvironmentStore } from "./world/EnvironmentStore";
import { createWorld } from "./world/createWorld";
import { captureEnvironment, restoreEnvironment } from "./world/environmentSnapshot";
import { updateEnvironment } from "./world/environmentUpdate";
import type { FounderRegion } from "./world/validateWorld";

export interface SimulationEngineOptions {
  seed: number;
  /**
   * Authoritative configuration. The engine takes a frozen deep copy, so the
   * caller may keep and reuse its own object freely; later mutations of it can
   * never affect this engine.
   */
  config: ReadonlySimulationConfig;
}

/**
 * Module-private restore channel (foundation-gate ADR §2).
 *
 * `fromSnapshot` used to run the full constructor — noise fields, dilation
 * passes, flood fill, ~90 ms — and then overwrite every array from the
 * snapshot. Wasteful, and wrong twice over: the stored founder region was
 * discarded in favour of the regenerated one, and a snapshot could fail to
 * load because `createWorld` threw on a payload that needed no generation at
 * all. Since Milestone 9 the environment can be EDITED, so "regenerate and
 * overwrite" stops being merely wasteful — the snapshot is the only truth.
 *
 * The channel is a second constructor argument guarded by a module-level
 * Symbol that is never exported, so it cannot be forged even by JavaScript
 * callers who ignore the types: the single validated restore door of
 * `fromSnapshot` stays single.
 */
const RESTORE_WORLD = Symbol("eon-engine-restore-world");

interface RestoredWorld {
  channel: typeof RESTORE_WORLD;
  environment: EnvironmentStore;
  founderRegion: FounderRegion;
  generationAttempt: number;
}

/**
 * Highest tick the engine will reach. Ticks are JS safe integers rather than
 * uint32 values: at 20 ticks/s and 2000 ticks per simulated year, uint32 would
 * wrap after ~2.1 million simulated years, which is not an absurd horizon for
 * this project, while the safe-integer range covers ~4.5e12 simulated years.
 */
export const MAX_TICK = Number.MAX_SAFE_INTEGER;

/**
 * Deterministic fixed-step simulation engine (task B05, extended in Milestone 2
 * with the environment).
 *
 * The engine is pure: no browser APIs, no wall clock, no Math.random, no
 * render-frame deltas. `step()` advances exactly one authoritative tick; there
 * is deliberately no deltaTime anywhere (docs/02 §7).
 *
 * Authoritative state is a pure function of seed + config + commands + engine
 * version, and the public API is built to keep it that way:
 *
 * - the PRNG is not exposed; `getRngState()` returns a detached copy for
 *   hashing/serialization, and engine-internal phase code reaches the live
 *   generator through the package-internal channel in `internal.ts`;
 * - the config is validated, deep-copied and deep-frozen at construction, so
 *   `configHash` can never drift from the configuration actually in use;
 * - the instance itself is frozen, so identity fields cannot be reassigned;
 * - the only way to restore state is the validated
 *   {@link SimulationEngine.fromSnapshot} factory.
 *
 * Tick convention (docs/10 §3): commands scheduled for the current `tick`
 * value are applied first, phases run, then `tick` increments.
 */
export class SimulationEngine {
  readonly seed: number;
  /** Frozen authoritative configuration; mutation attempts throw. */
  readonly config: ReadonlySimulationConfig;
  /** Canonical digest of {@link config}, computed once over the frozen copy. */
  readonly configHash: string;
  /** Authoritative environment grid (docs/03 §14). */
  readonly environment: EnvironmentStore;
  /** Authoritative live organism state as Structure-of-Arrays (docs/03 §6). */
  readonly organisms: OrganismStore;
  /** Authoritative inherited state: genes and brain weights (docs/10 §7). */
  readonly genomes: GenomeStore;
  /** Authoritative carrion left by deaths (docs/03 §23). */
  readonly carcasses: CarcassStore;
  /** Authoritative species registry and split-candidate state (docs/05 §5). */
  readonly species: SpeciesStore;
  /** Authoritative timeline event log (docs/05 §12). */
  readonly events: EventStore;
  /** Authoritative event-detector state (docs/02 §9). */
  readonly detectors: EventDetectors;
  /** Derived statistics time series — serialized, never hashed (docs/05 §11). */
  readonly stats: StatisticsStore;
  /** Authoritative player command log with its application cursor (task J01). */
  readonly commands: CommandLog;
  /** Deterministically chosen region where founders spawn (docs/03 §26). */
  readonly founderRegion: FounderRegion;
  /** Which generation attempt produced this world; 0 means the seed worked directly. */
  readonly generationAttempt: number;

  readonly #rng: Xoshiro128;
  readonly #context: EngineContext;
  #tick = 0;
  /**
   * Optional phase-boundary sink (CLAUDE.md "Profiling").
   *
   * Not `readonly`, and settable after construction, because profiling is
   * attached by whatever is hosting the engine — which does not exist yet when
   * the constructor runs. It is mutable state on an otherwise frozen object,
   * and that is safe for exactly one reason: it can only ever *receive* two
   * integers. There is no path from a profiler back into authoritative state,
   * so attaching one cannot change a hash. A test asserts that.
   */
  #profiler: TickProfiler | null = null;

  constructor(options: SimulationEngineOptions, restored?: RestoredWorld) {
    assert(
      Number.isInteger(options.seed),
      `seed must be an integer, got ${options.seed}. Non-integer seeds would silently collapse ` +
        "onto the same world (1.5 and NaN both normalize to a valid uint32).",
    );
    this.seed = options.seed >>> 0;

    // Copy -> validate the copy -> freeze -> hash the same object.
    // The order matters: validating the caller's object and then copying it
    // would let a config with getters (or a Proxy) present one set of values to
    // the validator and another to the clone and the hash.
    const ownedConfig = cloneConfig(options.config);
    validateConfig(ownedConfig);
    this.config = deepFreezeJson(ownedConfig);
    this.configHash = hashConfig(this.config);

    this.#rng = Xoshiro128.fromSeed(this.seed);

    if (restored !== undefined) {
      if (restored.channel !== RESTORE_WORLD) {
        throw new EonAssertionError(
          "the restore channel cannot be forged; use SimulationEngine.fromSnapshot",
        );
      }
      // The snapshot's world is the truth: no generation, no founders, no
      // WorldCreated event — fromSnapshot restores all of that state wholesale.
      this.environment = restored.environment;
      this.founderRegion = { ...restored.founderRegion };
      this.generationAttempt = restored.generationAttempt;
    } else {
      // World generation is a pure function of (seed, config) and deliberately
      // does not touch the PRNG, so the generator's state after construction is
      // exactly its seeded state whatever the world turned out to look like.
      const world = createWorld(this.config, this.seed);
      this.environment = world.environment;
      this.founderRegion = world.founderRegion;
      this.generationAttempt = world.attempt;
    }

    const capacity = this.config.limits.maxOrganisms;
    const carcassCapacity = this.config.limits.maxCarcasses;
    this.organisms = new OrganismStore(capacity);
    this.genomes = new GenomeStore(capacity);
    this.carcasses = new CarcassStore(carcassCapacity);
    this.species = new SpeciesStore();
    this.events = new EventStore(this.config.limits.maxTimelineEventsInMemoryBeforeChunk);
    this.detectors = new EventDetectors();
    this.stats = new StatisticsStore();
    this.commands = new CommandLog();

    this.#context = {
      seed: this.seed,
      config: this.config,
      environment: this.environment,
      organisms: this.organisms,
      genomes: this.genomes,
      phenotypes: new PhenotypeStore(capacity),
      carcasses: this.carcasses,
      species: this.species,
      events: this.events,
      detectors: this.detectors,
      stats: this.stats,
      traitRanges: buildTraitRanges(this.config),
      spatialPre: new SpatialGrid(
        this.config.world.sizeLU,
        this.config.world.spatialCellSizeLU,
        capacity,
      ),
      spatialPost: new SpatialGrid(
        this.config.world.sizeLU,
        this.config.world.spatialCellSizeLU,
        capacity,
      ),
      carcassIndex: new SpatialGrid(
        this.config.world.sizeLU,
        this.config.world.spatialCellSizeLU,
        carcassCapacity,
      ),
      scratch: new EngineScratch(capacity, this.environment.cellCount, carcassCapacity),
      rng: this.#rng,
    };

    // The founder bootstrap belongs to a NEW world only. A restored engine
    // receives its species registry, population and event log from the
    // snapshot; bootstrapping first would consume entity IDs and append an
    // event that the restore would then have to unwind.
    if (restored === undefined) {
      // All founders begin Species 1 (docs/05 §5). The record must exist before
      // the first founder spawns, because spawning is what counts membership;
      // its founder is the entity ID the first spawn will be issued.
      this.species.createSpecies({
        parentSpeciesId: 0,
        originTick: 0,
        centroid: new Int32Array(TRAIT_DIMENSIONS),
        founderEntityId: this.organisms.nextEntityId,
        generationAtOrigin: 0,
      });

      // The founder population is part of the world's initial state, so it
      // exists before tick 0 is hashed. It is the only PRNG consumer in
      // Milestone 3.
      const spawned = spawnFounderPopulation(this.#context, this.founderRegion);

      // Founders share one genome, so the species' representative phenotype is
      // any founder's trait vector — frozen as the origin centroid too.
      if (spawned > 0) {
        const founderSpecies = this.species.get(1);
        writeTraitVector(
          founderSpecies.centroidTraits,
          0,
          this.#context.phenotypes,
          0,
          this.#context.traitRanges,
        );
        founderSpecies.originCentroid.set(founderSpecies.centroidTraits);
      }

      // The world's first timeline entry (docs/05 §13). Emitted before tick 0
      // is hashed, exactly like the founders it describes.
      const cellSizePos = this.environment.cellSizeLU * POS_SCALE;
      this.events.append({
        tick: 0,
        type: WorldEventType.WorldCreated,
        severity: EventSeverity.Info,
        speciesIds: [1],
        regionXPos: this.founderRegion.centerGridX * cellSizePos + (cellSizePos >> 1),
        regionYPos: this.founderRegion.centerGridY * cellSizePos + (cellSizePos >> 1),
        regionRadiusPos: this.config.world.founderSpawnRadiusLU * POS_SCALE,
        payloadVersion: 1,
        payload: [spawned],
      });
    }

    attachEngineInternals(this, { rng: this.#rng, context: this.#context });

    // Freeze the instance itself, not just the config. `readonly` is erased at
    // runtime, so without this a caller could assign `engine.configHash` and
    // change the world's state hash without changing a single simulation value.
    // Private fields (#tick, #rng) live in internal slots that Object.freeze
    // does not touch, so the engine can still advance its own state.
    // Must stay the last statement in the constructor.
    Object.freeze(this);
  }

  /**
   * Restore an engine from a core snapshot — the single validated restore path.
   *
   * Compatibility policy for MVP (docs/06 §28): schema version AND engine
   * version must match exactly. Replaying an old save under changed engine
   * semantics while pretending it is the same history is forbidden, so this
   * throws {@link SnapshotCompatibilityError} instead of silently migrating.
   */
  static fromSnapshot(snapshot: EngineCoreSnapshot): SimulationEngine {
    if (snapshot.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
      throw new SnapshotCompatibilityError(
        `snapshot schema ${snapshot.schemaVersion} is not supported (expected ${SNAPSHOT_SCHEMA_VERSION})`,
      );
    }
    if (snapshot.engineVersion !== ENGINE_VERSION) {
      throw new SnapshotCompatibilityError(
        `snapshot was produced by engine ${snapshot.engineVersion}; this engine is ${ENGINE_VERSION} ` +
          "and MVP policy requires exact engine compatibility",
      );
    }
    if (!Number.isSafeInteger(snapshot.tick) || snapshot.tick < 0) {
      throw new SnapshotCompatibilityError(
        `snapshot tick must be a non-negative safe integer, got ${snapshot.tick}`,
      );
    }
    if (!Number.isSafeInteger(snapshot.generationAttempt) || snapshot.generationAttempt < 0) {
      throw new SnapshotCompatibilityError(
        `snapshot generationAttempt must be a non-negative integer, got ${snapshot.generationAttempt}`,
      );
    }

    // Validate the config FIRST, then restore the environment against the
    // validated copy, then construct through the restore channel. No world is
    // generated: the snapshot's environment, founder region and generation
    // attempt are adopted as-is (foundation-gate ADR §2) — the world may have
    // been edited by commands since generation, and only the snapshot knows.
    const config = cloneConfig(snapshot.config);
    validateConfig(config);
    const environment = restoreEnvironment(snapshot.environment, config);

    const engine = new SimulationEngine(
      { seed: snapshot.seed, config },
      {
        channel: RESTORE_WORLD,
        environment,
        founderRegion: snapshot.environment.founderRegion,
        generationAttempt: snapshot.generationAttempt,
      },
    );
    engine.#tick = snapshot.tick;
    engine.#rng.restoreState(snapshot.rngState);

    restoreOrganisms(
      snapshot.organisms,
      engine.organisms,
      engine.genomes,
      engine.#context.phenotypes,
      engine.config,
    );
    restoreCarcasses(snapshot.carcasses, engine.carcasses);

    // The species registry, event log, detector state and statistics series
    // are restored wholesale. The species restore happens after the organisms
    // so it can be cross-checked against the population it claims to describe.
    engine.species.restore(snapshot.species);
    engine.events.restore(snapshot.history.events);
    engine.detectors.restore(snapshot.history.detectors);
    engine.stats.restore(snapshot.history.stats);
    engine.#validateSpeciesAssignments();

    // The command log restores with its cursor, which is what guarantees a
    // command is applied exactly once across save/load (task J01): applied
    // history stays behind the cursor, pending commands stay ahead of it.
    engine.commands.restore(snapshot.commands);
    engine.#validateCommandCursor();

    engine.#context.spatialPre.clear();
    engine.#context.spatialPost.clear();
    engine.#context.carcassIndex.clear();

    return engine;
  }

  /**
   * Cross-check the restored command cursor against the restored tick: every
   * applied command must target a tick the world has already executed, and
   * every pending command must target the current tick or later. A log that
   * fails this would either re-apply history or silently skip a command.
   */
  #validateCommandCursor(): void {
    const log = this.commands;
    for (let i = 0; i < log.length; i += 1) {
      const command = log.at(i);
      if (i < log.cursor && command.tick >= this.#tick) {
        throw new SnapshotCompatibilityError(
          `command ${command.id} is recorded as applied but targets tick ${command.tick}, ` +
            `not before the snapshot tick ${this.#tick}`,
        );
      }
      if (i >= log.cursor && command.tick < this.#tick) {
        throw new SnapshotCompatibilityError(
          `command ${command.id} is pending but targets tick ${command.tick}, already behind ` +
            `the snapshot tick ${this.#tick}; it could never apply`,
        );
      }
    }
  }

  /**
   * Cross-check the restored registry against the restored population: every
   * live organism must belong to an ACTIVE species record, and every record's
   * population must equal its live member count (docs/07 §4). A snapshot that
   * fails this was corrupted or hand-edited, and trusting it would let the
   * population-matches-members invariant break silently at the next split.
   */
  #validateSpeciesAssignments(): void {
    const organisms = this.organisms;
    const counts = new Map<number, number>();
    for (let slot = 0; slot < organisms.slotHighWater; slot += 1) {
      if (organisms.alive[slot] !== 1) {
        continue;
      }
      const speciesId = organisms.speciesId[slot] as number;
      if (speciesId < 1 || speciesId > this.species.count) {
        throw new SnapshotCompatibilityError(
          `live organism in slot ${slot} belongs to unknown species ${speciesId}`,
        );
      }
      counts.set(speciesId, (counts.get(speciesId) ?? 0) + 1);
    }
    for (const record of this.species.records) {
      const live = counts.get(record.id) ?? 0;
      if (record.population !== live) {
        throw new SnapshotCompatibilityError(
          `species ${record.id} claims population ${record.population} but ${live} live members exist`,
        );
      }
      if (record.endReason !== SpeciesEndReason.Active && live !== 0) {
        throw new SnapshotCompatibilityError(
          `ended species ${record.id} still has ${live} live members`,
        );
      }
    }
  }

  /** Current authoritative tick (number of completed steps). */
  get tick(): number {
    return this.#tick;
  }

  /**
   * Queue a player command (docs/02 §§7, 15; task J01).
   *
   * This is the ONLY way player input reaches authoritative state, and it does
   * not touch that state itself: an accepted command is stamped with identity
   * `(id, tick, sequence)`, recorded in the immutable log, and applied at the
   * start of its target tick by phase 0. Rejection is a deterministic ANSWER,
   * not an exception — a malformed or out-of-bounds request from a buggy UI
   * must never stop a running world.
   *
   * Without an explicit `targetTick` the command is stamped for the next tick
   * the engine will execute (the live path). An explicit tick in the past is
   * rejected (docs/10 §16); an explicit current or future tick is accepted,
   * which is what fixtures and scripted experiments use.
   */
  queueCommand(input: CommandInput): CommandQueueResult {
    const problem = validateCommandInput(input, this.config);
    if (problem !== null) {
      return { accepted: false, reason: problem.reason, detail: problem.detail };
    }
    let tick = this.#tick;
    if (input.targetTick !== undefined) {
      if (input.targetTick < this.#tick) {
        return {
          accepted: false,
          reason: CommandRejectReason.PastTick,
          detail:
            `target tick ${input.targetTick} is in the past; the next executable tick ` +
            `is ${this.#tick}`,
        };
      }
      tick = input.targetTick;
    }
    return { accepted: true, command: this.commands.accept(input, tick) };
  }

  /**
   * Attach or detach a phase profiler; `null` disables profiling.
   *
   * The engine never reads a clock (CLAUDE.md forbids it), so it reports where
   * it is and lets the host decide when that was. See `profiling/TickProfiler`.
   */
  setProfiler(profiler: TickProfiler | null): void {
    this.#profiler = profiler;
  }

  /**
   * Detached copy of the PRNG state, for hashing, serialization and tests.
   * Mutating the returned tuple cannot affect the engine.
   */
  getRngState(): Xoshiro128State {
    return this.#rng.serializeState();
  }

  /** Advance exactly one authoritative tick. */
  step(): void {
    if (this.#tick >= MAX_TICK) {
      throw new RangeError(
        `simulation tick would exceed the safe integer range (${MAX_TICK}); refusing to advance ` +
          "because tick identity would no longer be exact",
      );
    }

    // Authoritative phase order, docs/03 §7. Phases arrive milestone by
    // milestone; the numbering is fixed so insertions cannot silently reorder
    // existing ones. Reordering is an ENGINE_VERSION event.
    const ctx = this.#context;
    // Profiling is opt-in and reports boundaries only; see setProfiler.
    const profiler = this.#profiler;
    profiler?.begin(TickPhase.Commands);
    applyCommandsForTick(ctx, this.commands, this.#tick); // 0 applyCommands
    profiler?.end(TickPhase.Commands);
    if (this.#tick % this.config.time.environmentInterval === 0) {
      profiler?.begin(TickPhase.Environment);
      updateEnvironment(this.environment, this.config); // 1 scheduledEnvironmentUpdate
      profiler?.end(TickPhase.Environment);
    }
    profiler?.begin(TickPhase.SpatialRebuild);
    ctx.spatialPre.rebuild(this.organisms); //          2 buildPreMovementSpatialIndex
    ctx.carcassIndex.rebuildFrom(
      this.carcasses.slotHighWater,
      this.carcasses.active,
      this.carcasses.x,
      this.carcasses.y,
    ); //                                                 2 (carcasses, see EngineContext)
    profiler?.end(TickPhase.SpatialRebuild);
    profiler?.begin(TickPhase.Sensing);
    senseAll(ctx, this.#tick); //                       3 sense
    profiler?.end(TickPhase.Sensing);
    profiler?.begin(TickPhase.Brain);
    runBrainsAndBuildIntents(ctx); //                   4 runBrainsAndBuildIntents
    profiler?.end(TickPhase.Brain);
    profiler?.begin(TickPhase.Movement);
    integrateMovement(ctx); //                          5 integrateMovement
    resolveTerrainAndSoftCollisions(ctx); //            6 resolveTerrainAndSoftCollisions
    profiler?.end(TickPhase.Movement);
    profiler?.begin(TickPhase.SpatialRebuild);
    ctx.spatialPost.rebuild(this.organisms); //         7 buildPostMovementSpatialIndex
    profiler?.end(TickPhase.SpatialRebuild);
    profiler?.begin(TickPhase.Feeding);
    buildFeedingClaims(ctx); //                         8 buildFeedingClaims
    resolveFeedingClaims(ctx); //                       9 resolveFeedingClaims
    profiler?.end(TickPhase.Feeding);
    profiler?.begin(TickPhase.Combat);
    buildCombatClaims(ctx); //                         10 buildCombatClaims
    resolveCombatSimultaneously(ctx, this.#tick); //   11 resolveCombatSimultaneously
    profiler?.end(TickPhase.Combat);
    profiler?.begin(TickPhase.MetabolismDeath);
    applyMetabolismGrowthThermalAging(ctx); //         12 applyMetabolismGrowthThermalAging
    finalizeDeaths(ctx, this.#tick); //                13 finalizeDeathsAndCreateCarcasses
    profiler?.end(TickPhase.MetabolismDeath);
    profiler?.begin(TickPhase.Reproduction);
    resolveReproduction(ctx); //                       14 resolveReproduction
    profiler?.end(TickPhase.Reproduction);
    if (this.#tick % this.config.time.carcassDecayInterval === 0) {
      profiler?.begin(TickPhase.Carcasses);
      decayCarcasses(ctx); //                          15 scheduledCarcassDecay
      profiler?.end(TickPhase.Carcasses);
    }
    if (this.#tick % this.config.time.speciesAnalysisInterval === 0) {
      profiler?.begin(TickPhase.SpeciesAnalysis);
      analyzeSpecies(ctx, this.#tick); //              16 scheduledSpeciesAnalysis
      profiler?.end(TickPhase.SpeciesAnalysis);
    }
    if (this.#tick % this.config.time.statisticsInterval === 0) {
      profiler?.begin(TickPhase.Statistics);
      collectStatisticsAndDetectEvents(ctx, this.#tick); // 17 scheduledStatisticsAndEventDetection
      profiler?.end(TickPhase.Statistics);
    }
    //   18 optionalRenderSnapshot           — produced on the host's cadence by
    //      render/renderSnapshot.ts, deliberately NOT inside the tick: a
    //      picture is taken between ticks, never as part of one.

    this.#tick += 1;
  }

  /** Advance `count` ticks (headless fast-forward primitive). */
  stepMany(count: number): void {
    assert(
      Number.isSafeInteger(count) && count >= 0,
      `stepMany count must be a non-negative safe integer, got ${count}`,
    );
    // Float addition is sound as a guard here: any true sum above MAX_TICK
    // rounds to at least 2^53 and is rejected, and every sum that is really
    // <= MAX_TICK is exact. step() re-checks per tick regardless.
    assert(
      this.#tick + count <= MAX_TICK,
      `stepMany would exceed the maximum tick ${MAX_TICK} (tick ${this.#tick} + ${count})`,
    );
    for (let i = 0; i < count; i += 1) {
      this.step();
    }
  }

  /** Canonical authoritative state hash (see hashState.ts for the sequence). */
  computeStateHash(): string {
    return computeStateHash(this);
  }

  /** Serialize everything needed to continue this engine exactly. */
  serialize(): EngineCoreSnapshot {
    return {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      engineVersion: ENGINE_VERSION,
      seed: this.seed,
      tick: this.#tick,
      generationAttempt: this.generationAttempt,
      rngState: this.getRngState(),
      config: cloneConfig(this.config),
      environment: captureEnvironment(this.environment, this.founderRegion),
      organisms: captureOrganisms(this.organisms, this.genomes),
      carcasses: captureCarcasses(this.carcasses),
      species: this.species.capture(),
      history: {
        events: this.events.capture(),
        detectors: this.detectors.capture(),
        stats: this.stats.capture(),
      },
      commands: this.commands.capture(),
    };
  }
}
