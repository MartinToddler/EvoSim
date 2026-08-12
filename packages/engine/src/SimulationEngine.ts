import { assert, deepFreezeJson } from "@eon/shared";
import { cloneConfig, type ReadonlySimulationConfig } from "./config/cloneConfig";
import { hashConfig } from "./config/hashConfig";
import { validateConfig } from "./config/validateConfig";
import { computeStateHash } from "./hashState";
import { attachEngineInternals } from "./internal";
import { Xoshiro128, type Xoshiro128State } from "./random/Xoshiro128";
import { type EngineCoreSnapshot, SnapshotCompatibilityError } from "./snapshot/EngineSnapshot";
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
  /** Deterministically chosen region where founders will spawn (docs/03 §26). */
  readonly founderRegion: FounderRegion;
  /** Which generation attempt produced this world; 0 means the seed worked directly. */
  readonly generationAttempt: number;

  readonly #rng: Xoshiro128;
  #tick = 0;

  constructor(options: SimulationEngineOptions) {
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

    // World generation is a pure function of (seed, config) and deliberately
    // does not touch the PRNG, so the generator's state after construction is
    // exactly its seeded state whatever the world turned out to look like.
    const world = createWorld(this.config, this.seed);
    this.environment = world.environment;
    this.founderRegion = world.founderRegion;
    this.generationAttempt = world.attempt;

    attachEngineInternals(this, { rng: this.#rng });

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

    const engine = new SimulationEngine({ seed: snapshot.seed, config: snapshot.config });
    engine.#tick = snapshot.tick;
    engine.#rng.restoreState(snapshot.rngState);

    // The saved environment wins over the freshly generated one: the world may
    // have grown, been grazed or been edited since generation, and only the
    // snapshot knows that history.
    const restored = restoreEnvironment(snapshot.environment, engine.config);
    engine.#adoptEnvironment(restored);

    return engine;
  }

  /** Copy restored arrays into this engine's store (the store reference is frozen). */
  #adoptEnvironment(source: EnvironmentStore): void {
    const target = this.environment;
    target.elevationQ.set(source.elevationQ);
    target.baseMoistureQ.set(source.baseMoistureQ);
    target.moistureOffsetQ.set(source.moistureOffsetQ);
    target.fertilityQ.set(source.fertilityQ);
    target.baseTemperatureCentiC.set(source.baseTemperatureCentiC);
    target.temperatureOffsetCentiC.set(source.temperatureOffsetCentiC);
    target.biome.set(source.biome);
    target.plantBiomass.set(source.plantBiomass);
    target.plantCapacity.set(source.plantCapacity);
    target.plantGrowthRemainderQ.set(source.plantGrowthRemainderQ);
    target.globalTemperatureOffsetCentiC = source.globalTemperatureOffsetCentiC;
    target.passable.set(source.passable);
    target.plantGradientXQ.set(source.plantGradientXQ);
    target.plantGradientYQ.set(source.plantGradientYQ);
  }

  /** Current authoritative tick (number of completed steps). */
  get tick(): number {
    return this.#tick;
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
    // existing ones.
    //   0 applyCommands                     — Milestone 9
    if (this.#tick % this.config.time.environmentInterval === 0) {
      updateEnvironment(this.environment, this.config); // 1 scheduledEnvironmentUpdate
    }
    //   2..17 organisms, ecology, species   — Milestones 3-8
    //   18 optionalRenderSnapshot           — Milestone 6

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
      rngState: this.getRngState(),
      config: cloneConfig(this.config),
      environment: captureEnvironment(this.environment, this.founderRegion),
    };
  }
}
