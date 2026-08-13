import { Q, clamp, qmul } from "../math/fixed";
import type { EngineContext } from "../EngineContext";
import { currentRadiusPos, massFromRadiusPos } from "../organisms/phenotype";

/**
 * Carcass creation and decay (docs/03 §23, docs/08 §15, task F01).
 *
 * Creation runs inside phase 13, between capturing a dead organism's state and
 * releasing its slot. Decay is phase 15 and runs on the
 * `time.carcassDecayInterval` cadence.
 *
 * Nothing here knows what killed the organism. A carcass is left by starvation,
 * old age, drowning, thermal stress and combat alike, which is what keeps
 * scavenging a general ecological opportunity rather than a reward attached to
 * predation.
 */

/**
 * Smallest decay a decay step may take from a carcass that still has meat.
 *
 * Decay is a fraction, and an integer fraction of a small number truncates to
 * zero: at the default 0.49% per step a carcass holding fewer than 205 units
 * would lose nothing, forever, and would sit in the world holding a slot until
 * something ate it. One unit is the smallest possible non-zero integer
 * decrement, so it makes decay strictly monotone and guarantees termination
 * without introducing a second rate to tune — docs/08 §15 asks for exactly that:
 * simple, monotonic, deterministic.
 */
export const MIN_CARCASS_DECAY_UNITS = 1;

/**
 * Meat a body is worth (docs/03 §23):
 * `mass × meatPerMass` plus a bounded share of whatever energy it still held.
 *
 * The energy share is converted at the same rate meat is worth to an eater
 * (`plants.meatEnergyPerUnit`), so at most `remainingEnergyToMeatMaxFractionQ`
 * of the dead organism's energy can ever be recovered by whoever eats it. That
 * bound is the conservative direction: energy is destroyed by dying, never
 * multiplied.
 *
 * The mass term is a different thing and deliberately so — it is the ecological
 * energy content of a body, on the same footing as the plant field's
 * `plantEnergyPerBiomass`, not a refund of what the organism spent growing.
 */
export function carcassMeatUnits(ctx: EngineContext, slot: number): number {
  const { organisms, phenotypes, config } = ctx;
  const { carcass } = config.organism;

  const radius = currentRadiusPos(
    phenotypes.adultRadiusPos[slot] as number,
    organisms.developmentQ[slot] as number,
  );
  const mass = massFromRadiusPos(radius, config.organism.massScalePerRadiusSquared);
  const bodyMeat = mass * carcass.meatPerMass;

  const energyPerUnit = config.plants.meatEnergyPerUnit;
  const recoverable = qmul(
    Math.max(organisms.energy[slot] as number, 0),
    carcass.remainingEnergyToMeatMaxFractionQ,
  );
  const energyMeat = energyPerUnit > 0 ? Math.trunc(recoverable / energyPerUnit) : 0;

  return bodyMeat + energyMeat;
}

/**
 * Leave a carcass where an organism died.
 *
 * Returns the carcass slot, or -1 when the cap was reached or the body was worth
 * no meat at all. A zero-meat carcass is not created: it would occupy a capped
 * slot, be sensed as food, and give nothing to whoever swam across the world
 * for it.
 *
 * Must be called while the organism's row is still intact — after
 * `releaseSlot` its position, mass and species are gone.
 */
export function createCarcass(ctx: EngineContext, slot: number): number {
  const { organisms, carcasses } = ctx;
  const meat = carcassMeatUnits(ctx, slot);
  if (meat <= 0) {
    return -1;
  }
  return carcasses.create(
    organisms.entityId[slot] as number,
    organisms.x[slot] as number,
    organisms.y[slot] as number,
    meat,
    organisms.speciesId[slot] as number,
  );
}

/**
 * Decay fraction for one carcass this step, in Q (docs/03 §23, docs/08 §15).
 *
 * `base × (1 + hotBonus)`, where the bonus ramps linearly from zero at
 * `hotDecayMinTemperatureCentiC` to `hotDecayBonusMaxQ` at
 * `hotDecayFullBonusTemperatureCentiC` and saturates above it. Warm carrion
 * rots faster; frozen carrion keeps.
 */
export function carcassDecayFractionQ(temperatureCentiC: number, ctx: EngineContext): number {
  const { carcass } = ctx.config.organism;
  const span = carcass.hotDecayFullBonusTemperatureCentiC - carcass.hotDecayMinTemperatureCentiC;
  const above = temperatureCentiC - carcass.hotDecayMinTemperatureCentiC;
  const hotnessQ = clamp(Math.trunc((above * Q) / span), 0, Q);
  const bonusQ = qmul(carcass.hotDecayBonusMaxQ, hotnessQ);
  return qmul(carcass.baseCarcassDecayFractionQPerDecayStep, Q + bonusQ);
}

/**
 * Phase 15 — every carcass loses meat, ages, and disappears once empty.
 *
 * Ascending slot order. Releasing a slot inside the loop is safe because the
 * loop bound is the high-water mark rather than the live count, and a released
 * row is cleared and therefore skipped if the free stack hands it straight back
 * — which it cannot do here, because nothing creates a carcass during this
 * phase.
 */
export function decayCarcasses(ctx: EngineContext): void {
  const { carcasses, environment, config } = ctx;
  const ageStep = config.time.carcassDecayInterval;

  for (let slot = 0; slot < carcasses.slotHighWater; slot += 1) {
    if (carcasses.active[slot] !== 1) {
      continue;
    }

    const cell = environment.cellIndexFromPosition(
      carcasses.x[slot] as number,
      carcasses.y[slot] as number,
    );
    const fractionQ = carcassDecayFractionQ(environment.getTemperatureCentiC(cell), ctx);
    const remaining = carcasses.remainingMeat[slot] as number;
    let loss = qmul(remaining, fractionQ);
    if (loss < MIN_CARCASS_DECAY_UNITS && fractionQ > 0) {
      loss = MIN_CARCASS_DECAY_UNITS;
    }
    carcasses.decay(slot, loss);

    if ((carcasses.remainingMeat[slot] as number) <= 0) {
      carcasses.release(slot);
      continue;
    }
    carcasses.ageTicks[slot] = (carcasses.ageTicks[slot] as number) + ageStep;
  }
}
