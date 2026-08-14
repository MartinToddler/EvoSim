import { describe, expect, it } from "vitest";
import { Gene } from "../genetics/genes";
import { Q } from "../math/fixed";
import { DeathCause, finalizeDeaths, markDeath } from "../organisms/death";
import { buildCombatClaims, resolveCombatSimultaneously } from "../ecology/combatClaims";
import { createTestWorld, spawnTestOrganism, type TestWorld } from "../testing/harness";
import { SpeciesEndReason } from "../evolution/SpeciesStore";
import { EventSeverity, EventStore, WorldEventType } from "./EventStore";
import {
  CARNIVORE_MIN_INTERVAL_ENERGY,
  CARNIVORE_PERSIST_SAMPLES,
  MASS_EXTINCTION_WINDOW_SAMPLES,
  POPULATION_BASELINE_WINDOW_SAMPLES,
  collectStatisticsAndDetectEvents,
} from "./eventDetection";
import { SpeciesStatMetric, WorldStatMetric } from "./StatisticsStore";

/**
 * Event system fixtures (docs/05 §§12–17, task I06): emission, payloads,
 * detector state, and — fixture 11 — the absence of duplicate event spam.
 */

/** Advance the harness detectors by one statistics sample at a given tick. */
function sample(world: TestWorld, tick: number): void {
  collectStatisticsAndDetectEvents(world.ctx, tick);
}

function eventsOfType(world: TestWorld, type: number): readonly number[] {
  return world.ctx.events.events.filter((e) => e.type === type).map((e) => e.tick);
}

function plantHerd(world: TestWorld, count: number, gridBase = 8): number[] {
  const slots: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const { xPos, yPos } = world.cellCenter(gridBase + (i % 8), 8 + Math.trunc(i / 8));
    slots.push(spawnTestOrganism(world, { xPos, yPos, silentBrain: true }));
  }
  return slots;
}

describe("EventStore", () => {
  it("assigns dense IDs, keeps order, and answers eventsSince", () => {
    const store = new EventStore(8);
    for (let i = 0; i < 3; i += 1) {
      store.append({
        tick: i * 10,
        type: WorldEventType.PopulationBoom,
        severity: EventSeverity.Notable,
        payloadVersion: 1,
        payload: [i],
      });
    }
    expect(store.events.map((e) => e.id)).toEqual([1, 2, 3]);
    expect(store.latestEventId).toBe(3);
    expect(store.eventsSince(1).map((e) => e.id)).toEqual([2, 3]);
    expect(store.eventsSince(3)).toEqual([]);
  });

  it("drops the OLDEST events beyond its capacity and counts them", () => {
    const store = new EventStore(4);
    for (let i = 0; i < 7; i += 1) {
      store.append({
        tick: i,
        type: WorldEventType.SpeciesExtinct,
        severity: EventSeverity.Notable,
        payloadVersion: 1,
        payload: [],
      });
    }
    expect(store.events).toHaveLength(4);
    expect(store.events.map((e) => e.id)).toEqual([4, 5, 6, 7]);
    expect(store.droppedEventCount).toBe(3);
    expect(store.nextEventId).toBe(8);
  });

  it("round-trips through capture/restore exactly", () => {
    const store = new EventStore(8);
    store.append({
      tick: 42,
      type: WorldEventType.FirstPredation,
      severity: EventSeverity.Major,
      speciesIds: [1, 2],
      entityIds: [7, 9],
      regionXPos: 100,
      regionYPos: 200,
      regionRadiusPos: 0,
      payloadVersion: 1,
      payload: [3, 4],
    });
    const restored = new EventStore(8);
    restored.restore(store.capture());
    expect(restored.events).toEqual(store.events);
    expect(restored.nextEventId).toBe(store.nextEventId);
    expect(restored.droppedEventCount).toBe(store.droppedEventCount);
  });
});

describe("species lifecycle events", () => {
  it("emits SpeciesExtinct exactly once, at the tick the last member dies", () => {
    const world = createTestWorld();
    const slots = plantHerd(world, 3);
    for (const slot of slots) {
      markDeath(world.ctx, slot, DeathCause.Starvation);
    }
    finalizeDeaths(world.ctx, 777);

    const record = world.ctx.species.get(1);
    expect(record.endReason).toBe(SpeciesEndReason.Extinct);
    expect(record.endTick).toBe(777);
    expect(record.population).toBe(0);

    const extinctions = eventsOfType(world, WorldEventType.SpeciesExtinct);
    expect(extinctions).toEqual([777]);
  });
});

describe("first predation (docs/05 §14, fixture 11)", () => {
  function combatWorld(): { world: TestWorld; hunter: number; prey: number } {
    const world = createTestWorld();
    const { xPos, yPos } = world.cellCenter(20, 20);
    // A strong attacker directly on top of a frail victim; attack intent is
    // forced through scratch, exactly as the brain phase would set it.
    const hunter = spawnTestOrganism(world, {
      xPos,
      yPos,
      silentBrain: true,
      developmentQ: Q,
      ageTicks: 3000,
      genesQ: { [Gene.AttackPower]: Q, [Gene.AdultSize]: Q },
    });
    const prey = spawnTestOrganism(world, {
      xPos: xPos + 10,
      yPos,
      silentBrain: true,
      genesQ: { [Gene.AdultSize]: 0, [Gene.Armor]: 0 },
    });
    world.ctx.organisms.healthQ[prey] = 1;
    world.ctx.scratch.attackQ[hunter] = Q;
    return { world, hunter, prey };
  }

  it("emits FirstPredation once with attacker, victim, species and position", () => {
    const { world, hunter, prey } = combatWorld();
    const preyId = world.ctx.organisms.entityId[prey] as number;
    const hunterId = world.ctx.organisms.entityId[hunter] as number;

    world.ctx.spatialPost.rebuild(world.ctx.organisms);
    buildCombatClaims(world.ctx);
    resolveCombatSimultaneously(world.ctx, 55);

    const events = world.ctx.events.events.filter((e) => e.type === WorldEventType.FirstPredation);
    expect(events).toHaveLength(1);
    const event = events[0] as NonNullable<(typeof events)[0]>;
    expect(event.tick).toBe(55);
    expect(event.severity).toBe(EventSeverity.Major);
    expect(event.entityIds).toEqual([hunterId, preyId]);
    expect(event.speciesIds).toEqual([1, 1]);
    expect(event.regionXPos).toBe(world.ctx.organisms.x[prey]);
    expect(world.ctx.detectors.firstPredationRecorded).toBe(true);
    expect(world.ctx.species.get(1).totalKills).toBe(1);
  });

  it("never emits a second FirstPredation for later kills", () => {
    const { world } = combatWorld();
    world.ctx.spatialPost.rebuild(world.ctx.organisms);
    buildCombatClaims(world.ctx);
    resolveCombatSimultaneously(world.ctx, 55);
    finalizeDeaths(world.ctx, 55);

    // A second hunt, ticks later.
    const { xPos, yPos } = world.cellCenter(30, 30);
    const hunter2 = spawnTestOrganism(world, {
      xPos,
      yPos,
      silentBrain: true,
      developmentQ: Q,
      ageTicks: 3000,
      genesQ: { [Gene.AttackPower]: Q, [Gene.AdultSize]: Q },
    });
    const prey2 = spawnTestOrganism(world, {
      xPos: xPos + 10,
      yPos,
      silentBrain: true,
      genesQ: { [Gene.AdultSize]: 0 },
    });
    world.ctx.organisms.healthQ[prey2] = 1;
    world.ctx.scratch.attackQ[hunter2] = Q;
    world.ctx.spatialPost.rebuild(world.ctx.organisms);
    buildCombatClaims(world.ctx);
    resolveCombatSimultaneously(world.ctx, 200);

    const events = world.ctx.events.events.filter((e) => e.type === WorldEventType.FirstPredation);
    expect(events).toHaveLength(1);
    expect(world.ctx.species.get(1).totalKills).toBe(2);
  });
});

describe("boom and crash (docs/05 §16, fixture 11)", () => {
  it("requires a full baseline window before judging, then fires once per excursion", () => {
    const world = createTestWorld();
    plantHerd(world, 60);

    // Baseline builds over the first 10 samples: no events possible.
    let tick = 0;
    for (let s = 0; s < POPULATION_BASELINE_WINDOW_SAMPLES; s += 1) {
      sample(world, tick);
      tick += 100;
    }
    expect(eventsOfType(world, WorldEventType.PopulationCrash)).toEqual([]);

    // The herd collapses from 60 to 10: -83% and -50 absolute.
    const organisms = world.ctx.organisms;
    let killed = 0;
    for (let slot = 0; slot < organisms.slotHighWater && killed < 50; slot += 1) {
      if (organisms.alive[slot] === 1) {
        markDeath(world.ctx, slot, DeathCause.Starvation);
        killed += 1;
      }
    }
    finalizeDeaths(world.ctx, tick);

    sample(world, tick);
    expect(eventsOfType(world, WorldEventType.PopulationCrash)).toEqual([tick]);

    // The population stays at 10 for many samples: the cooldown plus the
    // baseline catching up must prevent every duplicate.
    for (let s = 0; s < 25; s += 1) {
      tick += 100;
      sample(world, tick);
    }
    expect(eventsOfType(world, WorldEventType.PopulationCrash)).toHaveLength(1);
  });

  it("emits PopulationBoom on a +75% and +32 absolute rise", () => {
    const world = createTestWorld();
    plantHerd(world, 40);
    let tick = 0;
    for (let s = 0; s < POPULATION_BASELINE_WINDOW_SAMPLES; s += 1) {
      sample(world, tick);
      tick += 100;
    }
    plantHerd(world, 40, 24); // 40 -> 80: +100%, +40 absolute
    sample(world, tick);
    expect(eventsOfType(world, WorldEventType.PopulationBoom)).toEqual([tick]);
  });

  it("stays silent below the relative threshold or the absolute floor", () => {
    const world = createTestWorld();
    plantHerd(world, 40);
    let tick = 0;
    for (let s = 0; s < POPULATION_BASELINE_WINDOW_SAMPLES; s += 1) {
      sample(world, tick);
      tick += 100;
    }
    plantHerd(world, 20, 24); // +50% < +75%
    sample(world, tick);
    expect(eventsOfType(world, WorldEventType.PopulationBoom)).toEqual([]);
  });
});

describe("carnivore lineage (docs/05 §15)", () => {
  it("requires persistence, population and adequate observation, then badges once", () => {
    const world = createTestWorld();
    plantHerd(world, 12);
    const record = world.ctx.species.get(1);
    const intake = CARNIVORE_MIN_INTERVAL_ENERGY * 10;

    let tick = 0;
    // Four qualifying intervals: meat-heavy intake, streak grows, no event.
    for (let s = 0; s < CARNIVORE_PERSIST_SAMPLES - 1; s += 1) {
      record.meatEnergyConsumed += intake;
      sample(world, tick);
      tick += 100;
    }
    expect(record.carnivoreStreak).toBe(CARNIVORE_PERSIST_SAMPLES - 1);
    expect(record.carnivoreDetected).toBe(false);

    // The fifth consecutive qualifying interval fires, as the world first.
    record.meatEnergyConsumed += intake;
    sample(world, tick);
    expect(record.carnivoreDetected).toBe(true);
    const events = world.ctx.events.events.filter(
      (e) => e.type === WorldEventType.CarnivoreLineageDetected,
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.severity).toBe(EventSeverity.Major);
    expect(events[0]?.speciesIds).toEqual([1]);

    // Further meat-heavy samples never re-emit.
    for (let s = 0; s < 6; s += 1) {
      tick += 100;
      record.meatEnergyConsumed += intake;
      sample(world, tick);
    }
    expect(
      world.ctx.events.events.filter((e) => e.type === WorldEventType.CarnivoreLineageDetected),
    ).toHaveLength(1);
  });

  it("a plant-heavy interval resets the streak; a starved interval leaves it", () => {
    const world = createTestWorld();
    plantHerd(world, 12);
    const record = world.ctx.species.get(1);
    const intake = CARNIVORE_MIN_INTERVAL_ENERGY * 10;

    record.meatEnergyConsumed += intake;
    sample(world, 0);
    expect(record.carnivoreStreak).toBe(1);

    // Starvation interval: intake below the observation floor — streak holds.
    sample(world, 100);
    expect(record.carnivoreStreak).toBe(1);

    // Plant-dominated interval: streak resets.
    record.plantEnergyConsumed += intake;
    sample(world, 200);
    expect(record.carnivoreStreak).toBe(0);
  });
});

describe("population cap episodes (task E06)", () => {
  it("emits once per pressure episode, not once per interval", () => {
    const world = createTestWorld();
    plantHerd(world, 4);
    const organisms = world.ctx.organisms;

    organisms.capRejectedBirths = 5;
    sample(world, 0);
    organisms.capRejectedBirths = 12; // pressure continues
    sample(world, 100);
    organisms.capRejectedBirths = 12; // one quiet interval ends the episode
    sample(world, 200);
    organisms.capRejectedBirths = 20; // a new episode begins
    sample(world, 300);

    const events = eventsOfType(world, WorldEventType.PopulationCapReached);
    expect(events).toEqual([0, 300]);
  });
});

describe("mass extinction (docs/05 §17)", () => {
  it("fires when enough of the starting species die inside the window, once per window", () => {
    const world = createTestWorld();
    // Ten species of four organisms each; species 1 gets the first herd.
    const bySpecies: number[][] = [plantHerd(world, 4, 4)];
    for (let s = 2; s <= 10; s += 1) {
      world.ctx.species.createSpecies({
        parentSpeciesId: 0,
        originTick: 0,
        centroid: new Int32Array(15),
        founderEntityId: 1,
        generationAtOrigin: 0,
      });
      const slots: number[] = [];
      for (let i = 0; i < 4; i += 1) {
        const { xPos, yPos } = world.cellCenter(4 + s * 3 + i, 30);
        slots.push(spawnTestOrganism(world, { xPos, yPos, silentBrain: true, speciesId: s }));
      }
      bySpecies.push(slots);
    }

    let tick = 0;
    for (let s = 0; s <= MASS_EXTINCTION_WINDOW_SAMPLES; s += 1) {
      sample(world, tick);
      tick += 100;
    }
    expect(eventsOfType(world, WorldEventType.MassExtinction)).toEqual([]);

    // Five of ten species (50% >= 40%) die inside the next window.
    for (const slots of bySpecies.slice(0, 5)) {
      for (const slot of slots) {
        markDeath(world.ctx, slot, DeathCause.Starvation);
      }
    }
    finalizeDeaths(world.ctx, tick);
    sample(world, tick);

    const events = world.ctx.events.events.filter((e) => e.type === WorldEventType.MassExtinction);
    expect(events).toHaveLength(1);
    expect(events[0]?.severity).toBe(EventSeverity.Major);
    expect(events[0]?.speciesIds).toEqual([1, 2, 3, 4, 5]);

    // The following samples see the same five extinctions but may not re-fire:
    // the next window must START after the event.
    for (let s = 0; s < MASS_EXTINCTION_WINDOW_SAMPLES + 5; s += 1) {
      tick += 100;
      sample(world, tick);
    }
    expect(
      world.ctx.events.events.filter((e) => e.type === WorldEventType.MassExtinction),
    ).toHaveLength(1);
  });
});

describe("statistics sampling (docs/05 §10)", () => {
  it("records world sample metrics with interval deltas", () => {
    const world = createTestWorld();
    plantHerd(world, 10);
    sample(world, 0);

    const stats = world.ctx.stats;
    expect(stats.worldSampleCount).toBe(1);
    const population = stats.worldSeries(WorldStatMetric.Population);
    expect(population.ticks).toEqual([0]);
    expect(population.values).toEqual([10]);
    // Ten spawns count as ten births in the first interval.
    expect(stats.worldSeries(WorldStatMetric.BirthsInterval).values).toEqual([10]);
    expect(stats.worldSeries(WorldStatMetric.ActiveSpecies).values).toEqual([1]);

    // Second sample: no changes -> zero deltas, same levels.
    sample(world, 100);
    expect(stats.worldSeries(WorldStatMetric.BirthsInterval).values).toEqual([10, 0]);
    expect(stats.worldSeries(WorldStatMetric.Population).values).toEqual([10, 10]);
  });

  it("records per-species series only while the species lives", () => {
    const world = createTestWorld();
    const slots = plantHerd(world, 6);
    sample(world, 0);
    sample(world, 100);
    for (const slot of slots) {
      markDeath(world.ctx, slot, DeathCause.Starvation);
    }
    finalizeDeaths(world.ctx, 150);
    sample(world, 200);

    const series = world.ctx.stats.speciesSeries(1, SpeciesStatMetric.Population);
    expect(series.ticks).toEqual([0, 100]);
    expect(series.values).toEqual([6, 6]);
  });
});
