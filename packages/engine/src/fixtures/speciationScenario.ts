import { BrushFalloff } from "../commands/SimulationCommand";
import { InterventionKind } from "../commands/SimulationCommand";
import { cloneConfig, type ReadonlySimulationConfig } from "../config/cloneConfig";
import { DEFAULT_CONFIG } from "../config/defaultConfig";
import type { SimulationEngine } from "../SimulationEngine";

/**
 * The ecological speciation scenario (ADR 0025 §3; docs/07 §16 third bullet;
 * MVP release gate 6).
 *
 * A world is generated, its founder lineage spreads across one continent, and
 * at tick {@link SCENARIO_CHANNEL_TICK} a sequence of ordinary `LowerTerrain`
 * intervention commands floods a full-width equatorial channel — the product's
 * own "player as geological force" mechanic, canonical and replayable. The
 * continent becomes two, with the population already living on both sides.
 * From there, ordinary reproduction, mutation and selection diverge the two
 * isolated demes until the engine's own species detector — the same 2-means +
 * five-interval-stability machinery every world runs — declares a split.
 * Nothing assigns species membership by hand, and no organism is ever spawned
 * into either deme.
 *
 * ## How the scenario was calibrated (measured, ADR 0025 §3)
 *
 * Probes on engine 0.8.0's biology measured, on this exact world:
 *
 * - between-deme RMS gene distance before the channel and in flat control
 *   worlds: ≤ ~66 Q (mutation noise);
 * - within-population 2-means separation at stable populations: ~50–200 Q,
 *   with transient k-means artifacts on crashed populations that the engine's
 *   `minDaughterPopulation` and stability guards already reject;
 * - between-deme divergence after the channel: monotonic growth through
 *   ~430–500 Q by tick 40 000, led by size and diet.
 *
 * `splitDistanceThresholdQ` = 480 therefore sits 2–3× above the measured noise
 * ceiling and on the measured divergence trajectory: a threshold the ecology
 * can genuinely reach, which the default 901 — calibrated to refuse mutation
 * clouds on the undivided reference world — cannot at these population sizes.
 * The anti-flicker machinery (five stable analyses, centroid continuity,
 * minimum daughter population) is unchanged in kind, retuned in proportion.
 *
 * ## Why the plant capacities are pinned as absolute values
 *
 * The scenario must stay the world it was calibrated on even when
 * `DEFAULT_CONFIG`'s capacities are retuned (they were, in the same ADR).
 * Pinning them keeps this fixture's trajectory — and therefore the split this
 * test proves reachable — a pure function of (seed, config, engine version),
 * exactly like the golden fixture's.
 */

export const SCENARIO_SEED = 0xe0a12026;
export const SCENARIO_GRID_SIZE = 192;
export const SCENARIO_CHANNEL_TICK = 8_000;

/**
 * The tick by which the split must have happened. Measured: the detector
 * declares it at tick ~45 000; the horizon carries 33% headroom so the
 * assertion is "the split is reachable", not "the split lands on one tick"
 * (docs/07 §16 forbids the brittle form).
 */
export const SCENARIO_SPLIT_HORIZON = 60_000;

export const SCENARIO_CONFIG: ReadonlySimulationConfig = (() => {
  const config = cloneConfig(DEFAULT_CONFIG);
  const grid = SCENARIO_GRID_SIZE;
  config.world.envGridSize = grid;
  config.world.sizeLU = grid * config.world.envCellSizeLU;
  config.world.generation.edgeFalloffCells = Math.max(1, Math.floor(grid / 8));
  config.world.initialOrganisms = 64;
  config.world.founderSpawnRadiusLU = Math.min(
    config.world.founderSpawnRadiusLU,
    config.world.sizeLU / 4,
  );
  config.world.validity.minFounderRegionCells = Math.floor((grid * grid) / 16);
  config.world.validity.minTotalPlantCapacity = Math.floor(
    DEFAULT_CONFIG.world.validity.minTotalPlantCapacity / 32,
  );
  // Pinned to the values the scenario was calibrated against (see above);
  // deliberately NOT DEFAULT_CONFIG's retuned capacities or carcass decay.
  config.plants.baseCapacityByBiome = [0, 36000, 52000, 7000, 10000, 4000];
  config.organism.carcass.baseCarcassDecayFractionQPerDecayStep = 20;
  // The calibrated detector for this scenario's population sizes (see above).
  config.species.splitDistanceThresholdQ = 480;
  config.species.candidateCentroidContinuityThresholdQ = 160;
  return config;
})();

/**
 * Queue the channel: ordinary LowerTerrain commands, hard falloff, sixteen
 * passes so any land elevation sinks below sea level along the equator row.
 * Returns how many commands were queued. Deterministic by construction —
 * fixed geometry, fixed order, engine-stamped identities.
 */
export function queueScenarioChannel(engine: SimulationEngine): number {
  const config = engine.config;
  const sizeLU = config.world.sizeLU;
  const yLU = Math.floor(sizeLU / 2);
  const spacingLU = 16;
  const radiusLU = 48;
  const strength = config.interventions.maxTerrainBrushStrengthQ;
  const maxSamples = config.interventions.maxBrushSamplesPerCommand;
  const passes = 16;
  let queued = 0;
  for (let pass = 0; pass < passes; pass += 1) {
    for (let fromLU = 0; fromLU < sizeLU; fromLU += spacingLU * maxSamples) {
      const samplesXLU: number[] = [];
      const samplesYLU: number[] = [];
      for (let s = 0; s < maxSamples; s += 1) {
        const x = fromLU + s * spacingLU;
        if (x > sizeLU) break;
        samplesXLU.push(x);
        samplesYLU.push(yLU);
      }
      if (samplesXLU.length === 0) continue;
      const result = engine.queueCommand({
        kind: InterventionKind.LowerTerrain,
        radiusLU,
        strength,
        falloff: BrushFalloff.Hard,
        samplesXLU,
        samplesYLU,
        targetTick: SCENARIO_CHANNEL_TICK,
      });
      if (!result.accepted) {
        throw new Error(`scenario channel command rejected: ${result.detail}`);
      }
      queued += 1;
    }
  }
  return queued;
}
