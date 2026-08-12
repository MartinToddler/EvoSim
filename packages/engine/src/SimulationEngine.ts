import { assert, deepFreezeJson } from "@eon/shared";
import { cloneConfig, type ReadonlySimulationConfig } from "./config/cloneConfig";
import { hashConfig } from "./config/hashConfig";
import { validateConfig } from "./config/validateConfig";
import { computeStateHash } from "./hashState";
import { attachEngineInternals } from "./internal";
import { Xoshiro128, type Xoshiro128State } from "./random/Xoshiro128";
import { type EngineCoreSnapshot, SnapshotCompatibilityError } from "./snapshot/EngineSnapshot";
import { ENGINE_VERSION, SNAPSHOT_SCHEMA_VERSION } from "./version";
import type { EnvironmentStore, ReadonlyEnvironmentView } from "./world/EnvironmentStore";
import { createWorld } from "./world/createWorld";
import {
  type EnvironmentSnapshot,
  captureEnvironment,
  restoreEnvironment,
} from "./world/environmentSnapshot";
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
 * Module-private restore channel.
 *
 * `fromSnapshot` must build an engine whose world comes from the snapshot
 * rather than from generation, without reopening the "set tick and PRNG to
 * anything" door that ADR 0002 §2 closed. The token is a module-level symbol
 * that is never exported, so this second constructor argument cannot be forged
 * from outside this file even by JavaScript callers who ignore the types.
 */
const RESTORE_TOKEN = Symbol("eon.engine.restore");

interface EngineRestoreState {
  readonly token: symbol;
  readonly tick: number;
  readonly rngState: Xoshiro128State;
  readonly environment: EnvironmentSnapshot;
  readonly generationAttempt: number;
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
 * - the environment is published as a `ReadonlyEnvironmentView`; the writable
 *   store is reachable only through that same internal channel (ADR 0004 §1);
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
  /**
   * Deterministically chosen region where founders will spawn (docs/03 §26).
   * Frozen, and part of the canonical state hash: Milestone 3 spawns into it,
   * so two worlds that disagree about it are different worlds.
   */
  readonly founderRegion: Readonly<FounderRegion>;
  /** Which generation attempt produced this world; 0 means the seed worked directly. */
  readonly generationAttempt: number;

  readonly #rng: Xoshiro128;
  readonly #environment: EnvironmentStore;
  #tick = 0;

  constructor(options: SimulationEngineOptions, restore?: EngineRestoreState) {
    if (restore !== undefined && restore.token !== RESTORE_TOKEN) {
      throw new SnapshotCompatibilityError(
        "the engine restore channel is package-internal; use SimulationEngine.fromSnapshot()",
      );
    }

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

    if (restore === undefined) {
      // World generation is a pure function of (seed, config) and deliberately
      // does not touch the PRNG, so the generator's state after construction is
      // exactly its seeded state whatever the world turned out to look like.
      const world = createWorld(this.config, this.seed);
      this.#environment = world.environment;
      this.founderRegion = deepFreezeJson({ ...world.founderRegion });
      this.generationAttempt = world.attempt;
    } else {
      // Restoring deliberately does NOT regenerate the world first. The
      // snapshot carries every authoritative array and the founder region, so
      // generation would be ~90 ms of work thrown away — and worse, it would
      // silently substitute the pristine map's founder region for the saved
      // one once terrain editing lands (docs/03 §25).
      this.#environment = restoreEnvironment(restore.environment, this.config);
      this.founderRegion = deepFreezeJson({ ...restore.environment.founderRegion });
      this.generationAttempt = restore.generationAttempt;
      this.#tick = restore.tick;
      this.#rng.restoreState(restore.rngState);
    }

    attachEngineInternals(this, { rng: this.#rng, environment: this.#environment });

    // Freeze the instance itself, not just the config. `readonly` is erased at
    // runtime, so without this a caller could assign `engine.configHash` and
    // change the world's state hash without changing a single simulation value.
    // Private fields (#tick, #rng, #environment) live in internal slots that
    // Object.freeze does not touch, so the engine can still advance its state.
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
        `snapshot generationAttempt must be a non-negative safe integer, got ${snapshot.generationAttempt}`,
      );
    }

    return new SimulationEngine(
      { seed: snapshot.seed, config: snapshot.config },
      {
        token: RESTORE_TOKEN,
        tick: snapshot.tick,
        rngState: snapshot.rngState,
        environment: snapshot.environment,
        generationAttempt: snapshot.generationAttempt,
      },
    );
  }

  /**
   * Authoritative environment grid (docs/03 §14), published read-only.
   *
   * A frozen projection over the live arrays — no copy, no mutating members,
   * and no way to reach the store by casting. Engine phase code takes the
   * writable store from `internal.ts` instead.
   */
  get environment(): ReadonlyEnvironmentView {
    return this.#environment.readonlyView;
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
      updateEnvironment(this.#environment, this.config); // 1 scheduledEnvironmentUpdate
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
      generationAttempt: this.generationAttempt,
      environment: captureEnvironment(this.#environment, this.founderRegion),
    };
  }
}
