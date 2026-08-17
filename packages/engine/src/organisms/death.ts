import { createCarcass } from "../ecology/carcasses";
import type { EngineContext } from "../EngineContext";
import { SpeciesEndReason } from "../evolution/SpeciesStore";
import { EventSeverity, WorldEventType } from "../history/EventStore";

/**
 * Death causes (docs/04 §22).
 *
 * The numbering is a storage contract: it is hashed through the per-cause
 * counters and will be serialized into timeline events. `None` occupies 0 so a
 * zeroed scratch row means "not dying".
 */
export const DeathCause = {
  None: 0,
  Starvation: 1,
  Combat: 2,
  Thermal: 3,
  OldAge: 4,
  Drowning: 5,
  Meteor: 6,
  Other: 7,
} as const;

export type DeathCause = (typeof DeathCause)[keyof typeof DeathCause];

export const DEATH_CAUSE_COUNT = 8;

/** Human-readable cause names, indexed by cause value. Diagnostics only. */
export const DEATH_CAUSE_NAMES: readonly string[] = [
  "none",
  "starvation",
  "combat",
  "thermal",
  "oldAge",
  "drowning",
  "meteor",
  "other",
];

/**
 * Death finalization — phase 13 of the authoritative tick order
 * (docs/04 §22, docs/10 §14, task D13).
 *
 * Deaths are collected during the physiology phase and finalized here, in
 * ascending slot order. Nothing dies in the middle of another phase: an
 * organism that is doomed still finishes the tick it is in, so a later phase
 * never has to ask whether the entity it is looking at still exists.
 *
 * Slots are released here, before reproduction would run. That makes LIFO slot
 * reuse part of the deterministic semantics rather than an accident — a child
 * born on the same tick lands in the slot of the most recently released
 * organism (docs/10 §14).
 *
 * The carcass is created BEFORE the slot is released, in the order docs/10 §14
 * prescribes: the body's position, mass and species only exist while the row
 * does. Every cause leaves a carcass, combat included and combat not specially —
 * a starved organism is as edible as a killed one, which is what keeps
 * scavenging available to lineages that never learn to fight.
 *
 * Species accounting happens here too (docs/10 §14 "species counters"): the
 * member is removed from its registry record, and the death that empties a
 * species marks the extinction at THIS tick and emits the event (docs/05 §8) —
 * extinction is a fact of the death, not something the next scheduled analysis
 * discovers late.
 */
export function finalizeDeaths(ctx: EngineContext, tick: number): void {
  const { organisms, genomes, scratch, species, events } = ctx;

  for (let slot = 0; slot < organisms.slotHighWater; slot += 1) {
    if (scratch.pendingDeath[slot] !== 1) {
      continue;
    }
    scratch.pendingDeath[slot] = 0;
    if (organisms.alive[slot] !== 1) {
      continue;
    }

    const cause = scratch.deathCause[slot] as number;
    scratch.deathCause[slot] = DeathCause.None;
    organisms.deathsByCause[cause] = (organisms.deathsByCause[cause] as number) + 1;
    organisms.totalDeaths += 1;

    const speciesId = organisms.speciesId[slot] as number;
    if (species.recordDeath(speciesId) === 0) {
      species.endSpecies(speciesId, tick, SpeciesEndReason.Extinct);
      events.append({
        tick,
        type: WorldEventType.SpeciesExtinct,
        severity: EventSeverity.Notable,
        speciesIds: [speciesId],
        entityIds: [organisms.entityId[slot] as number],
        regionXPos: organisms.x[slot] as number,
        regionYPos: organisms.y[slot] as number,
        regionRadiusPos: 0,
        payloadVersion: 1,
        payload: [cause],
      });
    }

    createCarcass(ctx, slot);
    genomes.clearSlot(slot);
    // Memory dies with the organism (M16). Leaving it behind would let a
    // recycled slot hand the dead occupant's registers to whoever lands there
    // next, which is storage order leaking into biology.
    ctx.neural.clearSlot(slot);
    organisms.releaseSlot(slot);
  }
}

/** Mark a slot as dying this tick. The first cause recorded wins. */
export function markDeath(ctx: EngineContext, slot: number, cause: DeathCause): void {
  if (ctx.scratch.pendingDeath[slot] === 1) {
    return;
  }
  ctx.scratch.pendingDeath[slot] = 1;
  ctx.scratch.deathCause[slot] = cause;
}
