import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../config/defaultConfig";
import { SimulationEngine } from "../SimulationEngine";
import { createWorld } from "./createWorld";
import { ENVIRONMENT_HASH_MAGIC, hashEnvironment } from "./hashEnvironment";

const FIXTURE_SEED = 0xe0a12026;

describe("hashEnvironment", () => {
  it("is stable for the same seed and config", () => {
    const a = createWorld(DEFAULT_CONFIG, FIXTURE_SEED).environment;
    const b = createWorld(DEFAULT_CONFIG, FIXTURE_SEED).environment;
    expect(hashEnvironment(a)).toBe(hashEnvironment(b));
  });

  it("differs between seeds", () => {
    const a = createWorld(DEFAULT_CONFIG, FIXTURE_SEED).environment;
    const b = createWorld(DEFAULT_CONFIG, FIXTURE_SEED + 1).environment;
    expect(hashEnvironment(a)).not.toBe(hashEnvironment(b));
  });

  it("changes when a single authoritative cell changes", () => {
    const environment = createWorld(DEFAULT_CONFIG, FIXTURE_SEED).environment;
    const before = hashEnvironment(environment);
    environment.plantBiomass[0] = (environment.plantBiomass[0] as number) ^ 1;
    expect(hashEnvironment(environment)).not.toBe(before);
  });

  it("ignores derived caches, which are recomputed rather than saved", () => {
    const environment = createWorld(DEFAULT_CONFIG, FIXTURE_SEED).environment;
    const before = hashEnvironment(environment);
    environment.plantGradientXQ[0] = 1234;
    environment.passable[0] = environment.passable[0] === 0 ? 1 : 0;
    expect(hashEnvironment(environment)).toBe(before);
  });

  it("is not the canonical world state hash", () => {
    const engine = new SimulationEngine({ seed: FIXTURE_SEED, config: DEFAULT_CONFIG });
    expect(hashEnvironment(engine.environment)).not.toBe(engine.computeStateHash());
  });

  it("tracks the environment as ticks run", () => {
    const engine = new SimulationEngine({ seed: FIXTURE_SEED, config: DEFAULT_CONFIG });
    const atTickZero = hashEnvironment(engine.environment);
    // One full environment interval, so plant growth has run at least twice.
    engine.stepMany(DEFAULT_CONFIG.time.environmentInterval + 1);
    expect(hashEnvironment(engine.environment)).not.toBe(atTickZero);
  });

  it("reading the digest does not mutate engine state", () => {
    const engine = new SimulationEngine({ seed: FIXTURE_SEED, config: DEFAULT_CONFIG });
    const stateHash = engine.computeStateHash();
    hashEnvironment(engine.environment);
    hashEnvironment(engine.environment);
    expect(engine.computeStateHash()).toBe(stateHash);
    expect(engine.tick).toBe(0);
  });

  it("exposes a magic word distinct from the state hash magic", () => {
    // "EONE" (environment) versus "EONH" (world state hash).
    expect(ENVIRONMENT_HASH_MAGIC).toBe(0x454f4e45);
  });
});
