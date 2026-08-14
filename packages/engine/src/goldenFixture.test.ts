import { describe, expect, it } from "vitest";
import { SimulationEngine } from "./SimulationEngine";
import { DEFAULT_CONFIG } from "./config/defaultConfig";
import { hashConfig } from "./config/hashConfig";
import { FIXTURE_COMMANDS } from "./fixtures/fixtureCommands";
import goldenFixture from "./fixtures/goldenStateHashes.json";
import { CONFIG_SCHEMA_VERSION, ENGINE_VERSION } from "./version";

/**
 * Mandatory deterministic fixture (task B08; CLAUDE.md, docs/07 §3):
 *
 *   seed:     0xE0A12026
 *   config:   DEFAULT_CONFIG
 *   commands: FIXTURE_COMMANDS (one command of every intervention kind, M9)
 *
 * If these assertions fail after an intentional engine change: bump
 * ENGINE_VERSION, regenerate hashes with
 * `pnpm headless --seed 0xE0A12026 --ticks 10000 --checkpoints 0,1,10,100,1000,10000 --fixture-commands`,
 * update the fixture file and add a CHANGELOG entry. UI-only changes must
 * NEVER alter these hashes.
 */
describe("golden deterministic fixture", () => {
  it("fixture belongs to the current engine and config schema version", () => {
    expect(goldenFixture.engineVersion).toBe(ENGINE_VERSION);
    expect(goldenFixture.configSchemaVersion).toBe(CONFIG_SCHEMA_VERSION);
  });

  it("fixture command log matches the canonical module, so the two cannot drift", () => {
    expect(goldenFixture.commands).toEqual(
      FIXTURE_COMMANDS.map((input) => JSON.parse(JSON.stringify(input)) as unknown),
    );
  });

  it("DEFAULT_CONFIG hash matches the fixture", () => {
    expect(hashConfig(DEFAULT_CONFIG)).toBe(goldenFixture.configHash);
  });

  // 10 000 ticks of the populated reference world: 188 s standalone, 520 s
  // observed inside the parallel suite. The budget is a hang detector sized like
  // the soaks', not a wall-clock assertion (docs/07 §8).
  it("state hashes match at ticks 0, 1, 10, 100, 1000, 10000", { timeout: 1_800_000 }, () => {
    const seed = Number.parseInt(goldenFixture.seedHex, 16);
    expect(seed).toBe(0xe0a12026);

    const engine = new SimulationEngine({ seed, config: DEFAULT_CONFIG });
    for (const input of FIXTURE_COMMANDS) {
      const result = engine.queueCommand(input);
      expect(result.accepted).toBe(true);
    }
    const expected = goldenFixture.checkpoints as Record<string, string>;
    const checkpointTicks = Object.keys(expected)
      .map((key) => Number.parseInt(key, 10))
      .sort((a, b) => a - b);
    expect(checkpointTicks).toEqual([0, 1, 10, 100, 1_000, 10_000]);

    for (const target of checkpointTicks) {
      engine.stepMany(target - engine.tick);
      expect(`${target}:${engine.computeStateHash()}`).toBe(
        `${target}:${expected[String(target)]}`,
      );
    }
  });
});
