import { BrushFalloff, InterventionKind, type CommandInput } from "../commands/SimulationCommand";

/**
 * The fixed command log of the mandatory deterministic fixture (CLAUDE.md
 * "Mandatory deterministic fixture", docs/07 §3).
 *
 * From Milestone 9 the fixture is `seed 0xE0A12026 + DEFAULT_CONFIG +` THIS
 * list: one command of every intervention kind, spread across the 10 000-tick
 * horizon, all aimed at the fixture world's founder region (cell 234, 157 —
 * centre ≈ (3752, 2520) LU) so the interventions land where the population
 * lives and visibly perturb ecology, not just arrays. The golden hashes in
 * `goldenStateHashes.json` are taken over a world driven by this exact list,
 * which makes every command applier part of the golden regression net.
 *
 * The inputs carry explicit target ticks and are queued at construction time
 * in this order, so their stamped identities are fixed forever: ids and
 * sequences 1..9 in list order. Changing ANY value here changes world history
 * and therefore requires an ENGINE_VERSION bump with regenerated goldens.
 */
export const FIXTURE_COMMANDS: readonly CommandInput[] = [
  { kind: InterventionKind.SetGlobalTemperature, offsetCentiC: 300, targetTick: 50 },
  {
    kind: InterventionKind.PaintTemperature,
    radiusLU: 48,
    strength: 200,
    falloff: BrushFalloff.Linear,
    samplesXLU: [3700, 3740, 3780],
    samplesYLU: [2480, 2500, 2520],
    targetTick: 200,
  },
  {
    kind: InterventionKind.PaintMoisture,
    radiusLU: 48,
    strength: 384,
    falloff: BrushFalloff.Linear,
    samplesXLU: [3720, 3760, 3800],
    samplesYLU: [2560, 2560, 2560],
    targetTick: 500,
  },
  {
    kind: InterventionKind.PaintFertility,
    radiusLU: 48,
    strength: 256,
    falloff: BrushFalloff.Linear,
    samplesXLU: [3680, 3720],
    samplesYLU: [2440, 2440],
    targetTick: 800,
  },
  {
    kind: InterventionKind.RaiseTerrain,
    radiusLU: 32,
    strength: 192,
    falloff: BrushFalloff.Hard,
    samplesXLU: [3600, 3632],
    samplesYLU: [2400, 2400],
    targetTick: 1200,
  },
  {
    kind: InterventionKind.LowerTerrain,
    radiusLU: 32,
    strength: 192,
    falloff: BrushFalloff.Linear,
    samplesXLU: [3856, 3888],
    samplesYLU: [2600, 2600],
    targetTick: 1500,
  },
  {
    kind: InterventionKind.AddBiomass,
    radiusLU: 24,
    strength: 2000,
    falloff: BrushFalloff.Hard,
    samplesXLU: [3752],
    samplesYLU: [2520],
    targetTick: 2000,
  },
  {
    kind: InterventionKind.RemoveBiomass,
    radiusLU: 24,
    strength: 2000,
    falloff: BrushFalloff.Linear,
    samplesXLU: [3752],
    samplesYLU: [2520],
    targetTick: 2500,
  },
  {
    kind: InterventionKind.Meteor,
    centerXLU: 3752,
    centerYLU: 2520,
    radiusLU: 128,
    targetTick: 5000,
  },
];
