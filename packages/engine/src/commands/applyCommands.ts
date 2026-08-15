import { assert } from "@eon/shared";
import type { EngineContext } from "../EngineContext";
import { EventSeverity, WorldEventType } from "../history/EventStore";
import { POS_SCALE, Q, clamp } from "../math/fixed";
import { isqrt } from "../math/isqrt";
import { DeathCause, markDeath } from "../organisms/death";
import { recomputeDerivedRegion } from "../world/recomputeRegion";
import type { CommandLog } from "./CommandLog";
import {
  BrushFalloff,
  InterventionKind,
  type BrushCommand,
  type GlobalTemperatureCommand,
  type MeteorCommand,
  type SimulationCommand,
} from "./SimulationCommand";

/**
 * Phase 0 of the authoritative tick order: applyCommands (docs/03 §7,
 * docs/10 §16, task J01).
 *
 * Every pending command whose tick is the current tick is applied here, in
 * `(tick, sequence)` order, and NOWHERE else — no mid-tick mutation path
 * exists. Application is pure integer math and never draws from the PRNG, so
 * an intervention perturbs the world exactly where it lands and leaves the
 * random stream untouched.
 *
 * Affected-cell order is row-major over the command's bounding box, and each
 * cell receives at most ONE application per command (the strongest falloff
 * factor any stroke sample projects onto it), so neither pointer-sample density
 * nor iteration order can change what a stroke does.
 *
 * Dependent state is recomputed deterministically in the same phase
 * (docs/03 §19): climate and terrain edits re-derive biome, plant capacity and
 * passability for the touched region; the global temperature offset re-derives
 * the whole grid. Biomass edits recompute nothing — biomass is not a
 * classification input.
 *
 * Each applied command appends exactly one PlayerIntervention timeline event
 * (docs/01 §4, docs/05 §13) carrying the command's id, kind and region.
 */
export function applyCommandsForTick(ctx: EngineContext, log: CommandLog, tick: number): void {
  for (;;) {
    const next = log.peek();
    if (next === null) {
      return;
    }
    assert(
      next.tick >= tick,
      `command ${next.id} targets tick ${next.tick}, already behind the executing tick ${tick}; ` +
        "the cursor or the restore validation is broken",
    );
    if (next.tick > tick) {
      return;
    }
    applyCommand(ctx, next);
    log.advance();
  }
}

function applyCommand(ctx: EngineContext, command: SimulationCommand): void {
  switch (command.kind) {
    case InterventionKind.SetGlobalTemperature:
      applyGlobalTemperature(ctx, command);
      return;
    case InterventionKind.Meteor:
      applyMeteor(ctx, command);
      return;
    default:
      applyBrush(ctx, command);
  }
}

// --- Global temperature --------------------------------------------------------

function applyGlobalTemperature(ctx: EngineContext, command: GlobalTemperatureCommand): void {
  const { environment, config } = ctx;
  const bound = config.interventions.maxGlobalTemperatureOffsetCentiC;
  const offset = clamp(command.offsetCentiC, -bound, bound);
  environment.setGlobalTemperatureOffsetCentiC(offset);

  // Effective temperature changed everywhere, so every cell's biome and
  // capacity may have: the whole grid re-derives (docs/03 §19).
  recomputeDerivedRegion(environment, config, 0, 0, environment.size - 1, environment.size - 1);

  ctx.events.append({
    tick: command.tick,
    type: WorldEventType.PlayerIntervention,
    severity: EventSeverity.Notable,
    payloadVersion: 1,
    payload: [command.kind, command.id, offset, 0],
  });
}

// --- Brushes ---------------------------------------------------------------------

/**
 * Falloff factor in [0, Q] of a point at squared distance `distSq` from a
 * sample, both in the same integer length unit, radius `radius` in that unit.
 * Returns 0 outside the radius.
 */
function falloffFactorQ(distSq: number, radius: number, falloff: BrushFalloff): number {
  if (distSq > radius * radius) {
    return 0;
  }
  if (falloff === BrushFalloff.Hard) {
    return Q;
  }
  const dist = isqrt(distSq);
  return Math.trunc((Q * (radius - dist)) / radius);
}

function applyBrush(ctx: EngineContext, command: BrushCommand): void {
  const { environment, config } = ctx;
  const cellSize = environment.cellSizeLU;
  const size = environment.size;
  const samplesX = command.samplesXLU;
  const samplesY = command.samplesYLU;
  const radius = command.radiusLU;

  // Bounding box of the whole stroke, in cells.
  let minXLU = samplesX[0] as number;
  let maxXLU = minXLU;
  let minYLU = samplesY[0] as number;
  let maxYLU = minYLU;
  for (let i = 1; i < samplesX.length; i += 1) {
    const x = samplesX[i] as number;
    const y = samplesY[i] as number;
    if (x < minXLU) minXLU = x;
    if (x > maxXLU) maxXLU = x;
    if (y < minYLU) minYLU = y;
    if (y > maxYLU) maxYLU = y;
  }
  const gx0 = clamp(Math.floor((minXLU - radius) / cellSize), 0, size - 1);
  const gy0 = clamp(Math.floor((minYLU - radius) / cellSize), 0, size - 1);
  const gx1 = clamp(Math.floor((maxXLU + radius) / cellSize), 0, size - 1);
  const gy1 = clamp(Math.floor((maxYLU + radius) / cellSize), 0, size - 1);

  // Distances are computed in half-LU so cell centres stay integers:
  // a cell's centre is at (gx + 0.5) * cellSize LU == (2*gx + 1) * cellSize
  // half-LU. The radius scales by the same factor.
  const radius2x = radius * 2;
  const strength = command.strength;
  const falloff = command.falloff;

  let touchedCells = 0;
  for (let gy = gy0; gy <= gy1; gy += 1) {
    const cellCenterY2x = (2 * gy + 1) * cellSize;
    const rowBase = gy * size;
    for (let gx = gx0; gx <= gx1; gx += 1) {
      const cellCenterX2x = (2 * gx + 1) * cellSize;

      // One application per cell per command: the strongest factor any sample
      // projects onto this cell (max is order-free, so sample order cannot
      // matter). Early exit at Q — no sample can beat a direct hit.
      let factor = 0;
      for (let s = 0; s < samplesX.length && factor < Q; s += 1) {
        const dx = 2 * (samplesX[s] as number) - cellCenterX2x;
        const dy = 2 * (samplesY[s] as number) - cellCenterY2x;
        const f = falloffFactorQ(dx * dx + dy * dy, radius2x, falloff);
        if (f > factor) {
          factor = f;
        }
      }
      if (factor === 0) {
        continue;
      }
      const delta = Math.trunc((strength * factor) / Q);
      if (delta === 0) {
        continue;
      }
      applyBrushDelta(ctx, command.kind, rowBase + gx, delta);
      touchedCells += 1;
    }
  }

  // Climate and terrain edits change classification inputs; re-derive the
  // touched region. Biomass edits change no input and recompute nothing.
  if (
    command.kind !== InterventionKind.AddBiomass &&
    command.kind !== InterventionKind.RemoveBiomass
  ) {
    recomputeDerivedRegion(environment, config, gx0, gy0, gx1, gy1);
  }

  // Region for the timeline: the circle enclosing every sample plus the brush
  // radius, in position sub-units.
  const centerXPos = Math.trunc(((minXLU + maxXLU) * POS_SCALE) / 2);
  const centerYPos = Math.trunc(((minYLU + maxYLU) * POS_SCALE) / 2);
  const halfDiagPos = Math.trunc(
    (isqrt((maxXLU - minXLU) ** 2 + (maxYLU - minYLU) ** 2) * POS_SCALE) / 2,
  );
  ctx.events.append({
    tick: command.tick,
    type: WorldEventType.PlayerIntervention,
    severity: EventSeverity.Notable,
    regionXPos: centerXPos,
    regionYPos: centerYPos,
    regionRadiusPos: halfDiagPos + radius * POS_SCALE,
    payloadVersion: 1,
    payload: [command.kind, command.id, strength, touchedCells],
  });
}

function applyBrushDelta(
  ctx: EngineContext,
  kind: BrushCommand["kind"],
  cell: number,
  delta: number,
): void {
  const { environment, config } = ctx;
  switch (kind) {
    case InterventionKind.PaintTemperature: {
      const bound = config.interventions.maxLocalTemperatureOffsetCentiC;
      const current = environment.temperatureOffsetCentiC[cell] as number;
      environment.temperatureOffsetCentiC[cell] = clamp(current + delta, -bound, bound);
      return;
    }
    case InterventionKind.PaintMoisture: {
      const current = environment.moistureOffsetQ[cell] as number;
      environment.moistureOffsetQ[cell] = clamp(current + delta, -Q, Q);
      return;
    }
    case InterventionKind.PaintFertility: {
      const current = environment.fertilityQ[cell] as number;
      environment.fertilityQ[cell] = clamp(current + delta, 0, Q);
      return;
    }
    case InterventionKind.RaiseTerrain: {
      const current = environment.elevationQ[cell] as number;
      environment.elevationQ[cell] = clamp(current + delta, 0, Q);
      return;
    }
    case InterventionKind.LowerTerrain: {
      const current = environment.elevationQ[cell] as number;
      environment.elevationQ[cell] = clamp(current - delta, 0, Q);
      return;
    }
    case InterventionKind.AddBiomass: {
      // docs/03 §25: changes current food, not capacity. Overfill above
      // capacity is allowed up to the configured multiple (docs/03 §27) and
      // decays back at the next scheduled environment update. Water and other
      // zero-capacity cells accept nothing.
      const capacity = environment.plantCapacity[cell] as number;
      const ceiling = Math.min(
        65535,
        Math.trunc((capacity * config.interventions.biomassOverfillLimitQ) / Q),
      );
      const current = environment.plantBiomass[cell] as number;
      environment.plantBiomass[cell] = Math.min(current + delta, ceiling);
      return;
    }
    case InterventionKind.RemoveBiomass: {
      const current = environment.plantBiomass[cell] as number;
      const next = current - delta;
      environment.plantBiomass[cell] = next > 0 ? next : 0;
      if (next <= 0) {
        environment.plantGrowthRemainderQ[cell] = 0;
      }
      return;
    }
  }
}

// --- Meteor ----------------------------------------------------------------------

/**
 * METEOR (docs/03 §25): one radial catastrophe with four deterministic
 * effects, all falling off linearly from the impact centre — organism damage,
 * plant biomass loss, a terrain depression and a fertility change — plus a
 * major timeline event. No randomness: the same meteor on the same world does
 * the same thing.
 *
 * Organisms are iterated in ascending slot order (the authoritative iteration
 * convention); damage application is independent per organism, so order
 * cannot change outcomes. An organism whose health reaches zero is marked
 * dead with cause Meteor and finishes this tick like any other doomed
 * organism — phase 13 finalizes it and leaves a carcass where it stood
 * (docs/10 §14). Meteor damage does not feed `lastDamageQ`: that field is
 * combat-scoped and phase 10 clears its scratch before physiology reads it.
 */
function applyMeteor(ctx: EngineContext, command: MeteorCommand): void {
  const { environment, organisms, config } = ctx;
  const meteor = config.interventions.meteor;
  const cellSize = environment.cellSizeLU;
  const size = environment.size;
  const radius = command.radiusLU;

  // --- Environment effects, row-major over the bounding box ---
  const gx0 = clamp(Math.floor((command.centerXLU - radius) / cellSize), 0, size - 1);
  const gy0 = clamp(Math.floor((command.centerYLU - radius) / cellSize), 0, size - 1);
  const gx1 = clamp(Math.floor((command.centerXLU + radius) / cellSize), 0, size - 1);
  const gy1 = clamp(Math.floor((command.centerYLU + radius) / cellSize), 0, size - 1);
  const radius2x = radius * 2;

  for (let gy = gy0; gy <= gy1; gy += 1) {
    const cellCenterY2x = (2 * gy + 1) * cellSize;
    const rowBase = gy * size;
    for (let gx = gx0; gx <= gx1; gx += 1) {
      const cellCenterX2x = (2 * gx + 1) * cellSize;
      const dx = 2 * command.centerXLU - cellCenterX2x;
      const dy = 2 * command.centerYLU - cellCenterY2x;
      const factor = falloffFactorQ(dx * dx + dy * dy, radius2x, BrushFalloff.Linear);
      if (factor === 0) {
        continue;
      }
      const i = rowBase + gx;

      // Biomass loss: a fraction of what stands there, strongest at the centre.
      const lossQ = Math.trunc((meteor.biomassLossQ * factor) / Q);
      const biomass = environment.plantBiomass[i] as number;
      const loss = Math.trunc((biomass * lossQ) / Q);
      if (loss > 0) {
        environment.plantBiomass[i] = biomass - loss;
      }

      // Terrain depression.
      const depression = Math.trunc((meteor.depressionQ * factor) / Q);
      if (depression > 0) {
        const elevation = environment.elevationQ[i] as number;
        environment.elevationQ[i] = clamp(elevation - depression, 0, Q);
      }

      // Fertility change (signed; negative scorches).
      const fertilityDelta = Math.trunc((meteor.fertilityDeltaQ * factor) / Q);
      if (fertilityDelta !== 0) {
        const fertility = environment.fertilityQ[i] as number;
        environment.fertilityQ[i] = clamp(fertility + fertilityDelta, 0, Q);
      }
    }
  }

  // Elevation and fertility are classification inputs: re-derive the crater.
  recomputeDerivedRegion(environment, config, gx0, gy0, gx1, gy1);

  // --- Organism damage, ascending slot order ---
  // Positions are in POS_SCALE sub-units; phase 0 runs before the spatial
  // rebuild, so the stale index is deliberately not consulted.
  const centerXPos = command.centerXLU * POS_SCALE;
  const centerYPos = command.centerYLU * POS_SCALE;
  const radiusPos = radius * POS_SCALE;
  const scratch = ctx.scratch;
  let kills = 0;

  for (let slot = 0; slot < organisms.slotHighWater; slot += 1) {
    if (organisms.alive[slot] !== 1) {
      continue;
    }
    const dx = (organisms.x[slot] as number) - centerXPos;
    const dy = (organisms.y[slot] as number) - centerYPos;
    const factor = falloffFactorQ(dx * dx + dy * dy, radiusPos, BrushFalloff.Linear);
    if (factor === 0) {
      continue;
    }
    const damage = Math.trunc((meteor.damageQ * factor) / Q);
    if (damage <= 0) {
      continue;
    }
    const healthQ = organisms.healthQ[slot] as number;
    if (damage < healthQ) {
      organisms.healthQ[slot] = healthQ - damage;
      continue;
    }
    organisms.healthQ[slot] = 0;
    if (scratch.pendingDeath[slot] !== 1) {
      markDeath(ctx, slot, DeathCause.Meteor);
      kills += 1;
    }
  }

  ctx.events.append({
    tick: command.tick,
    type: WorldEventType.PlayerIntervention,
    severity: EventSeverity.Major,
    regionXPos: centerXPos,
    regionYPos: centerYPos,
    regionRadiusPos: radiusPos,
    payloadVersion: 1,
    payload: [command.kind, command.id, radius, kills],
  });
}
