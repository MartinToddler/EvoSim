import { assert, deepCloneJson } from "@eon/shared";
import type { SimulationConfig } from "./config/SimulationConfig";
import { hashConfig } from "./config/hashConfig";
import { validateConfig } from "./config/validateConfig";
import { computeStateHash } from "./hashState";
import { Xoshiro128, type Xoshiro128State } from "./random/Xoshiro128";
import type { EngineCoreSnapshot } from "./snapshot/EngineSnapshot";
import { ENGINE_VERSION, SNAPSHOT_SCHEMA_VERSION } from "./version";

export interface SimulationEngineOptions {
  seed: number;
  config: SimulationConfig;
}

/**
 * Deterministic fixed-step simulation engine — Milestone 1 shell (task B05).
 *
 * The engine is pure: no browser APIs, no wall clock, no Math.random, no
 * render-frame deltas. `step()` advances exactly one authoritative tick; there
 * is deliberately no deltaTime anywhere (docs/02 §7).
 *
 * Tick convention (docs/10 §3): commands scheduled for the current `tick`
 * value are applied first, phases run, then `tick` increments. Milestone 1
 * has no phases yet — the versioned phase order from docs/03 §7 is inserted
 * here milestone by milestone. The convention itself is already locked by the
 * golden hash fixture.
 */
export class SimulationEngine {
  readonly seed: number;
  readonly config: SimulationConfig;
  /** Canonical config digest, precomputed once (config is immutable per world). */
  readonly configHash: string;
  readonly rng: Xoshiro128;

  private tickValue = 0;

  constructor(options: SimulationEngineOptions) {
    validateConfig(options.config);
    this.seed = options.seed >>> 0;
    this.config = options.config;
    this.configHash = hashConfig(options.config);
    this.rng = Xoshiro128.fromSeed(this.seed);
  }

  /** Current authoritative tick (number of completed steps). */
  get tick(): number {
    return this.tickValue;
  }

  /** Advance exactly one authoritative tick. */
  step(): void {
    // Phase order docs/03 §7 — inserted from Milestone 2 onward:
    // 0 applyCommands … 18 optionalRenderSnapshot.
    this.tickValue += 1;
  }

  /** Advance `count` ticks (headless fast-forward primitive). */
  stepMany(count: number): void {
    assert(Number.isInteger(count) && count >= 0, `stepMany count must be >= 0, got ${count}`);
    for (let i = 0; i < count; i += 1) {
      this.step();
    }
  }

  /** Canonical authoritative state hash (see hashState.ts for the sequence). */
  computeStateHash(): string {
    return computeStateHash(this);
  }

  /** Serialize everything needed to continue this engine exactly (core v1). */
  serialize(): EngineCoreSnapshot {
    return {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      engineVersion: ENGINE_VERSION,
      seed: this.seed,
      tick: this.tickValue,
      rngState: this.rng.serializeState(),
      config: deepCloneJson(this.config),
    };
  }

  /** Internal: restore tick/PRNG from a validated snapshot (see snapshot/deserialize.ts). */
  restoreCore(tick: number, rngState: Xoshiro128State): void {
    assert(Number.isInteger(tick) && tick >= 0, `snapshot tick must be >= 0, got ${tick}`);
    this.tickValue = tick;
    this.rng.restoreState(rngState);
  }
}
