import { Resource } from "./world/resources";
import { describe, expect, it } from "vitest";
import { createFounderTopology } from "./brain/founderTopology";
import { SimulationEngine } from "./SimulationEngine";
import { BrainOutput, BrainInput, ioWeightIndex } from "./brain/BrainLayout";
import { NEURAL_WEIGHT_COUNT } from "./brain/NeuralTopology";
import { cloneConfig } from "./config/cloneConfig";
import { DEFAULT_CONFIG } from "./config/defaultConfig";
import type { SimulationConfig } from "./config/SimulationConfig";
import { GENE_COUNT, Gene, geneFromQ } from "./genetics/genes";
import { createFounderMorphGenes } from "./morphology/founderMorphGenome";
import { createFounderGenes } from "./genetics/founderGenome";
import { TRAIT_DIMENSIONS } from "./evolution/traitVector";
import { engineInternals } from "./internal";
import { POS_SCALE, Q, qmul } from "./math/fixed";
import { DeathCause } from "./organisms/death";
import { massFromRadiusPos, maxEnergyForMass } from "./organisms/phenotype";
import { spawnOrganism } from "./organisms/spawn";
import { engineFromSnapshot } from "./snapshot/deserialize";

/**
 * Milestone 5 acceptance (docs/07 Milestone 5, §5 "Predator mechanics" and
 * "Diet selection"): predator/prey fixture, mutual combat, food/energy
 * invariants.
 *
 * Everything here runs the REAL tick loop through `SimulationEngine.step()`, so
 * the phase order, the spatial rebuilds and the scheduled decay cadence are the
 * ones the shipped engine uses. The organisms are handcrafted because docs/07 §5
 * asks for exactly that: a controlled demonstration that the mechanics work,
 * which explicitly "does not guarantee spontaneous carnivory".
 *
 * No engine code knows these genomes exist. A "predator" here is nothing but a
 * genome with a high attack gene, a carnivore diet and a controller that steers
 * at what it sees — the same three general mechanisms every organism has.
 */

const FIXTURE_SEED = 0xe0a12026;

/** Default endowment for a handcrafted adult: 90% of what its body can hold. */
const DEVELOPED_ENERGY_FRACTION_Q = qmul(Q, 3686);

/** A brain built from explicit input→output skip weights, hidden layer silent. */
function skipBrain(
  entries: readonly { output: number; input: number; weight: number }[],
): Int16Array {
  const weights = new Int16Array(NEURAL_WEIGHT_COUNT);
  for (const entry of entries) {
    weights[ioWeightIndex(entry.output, entry.input)] = entry.weight;
  }
  return weights;
}

/** Weight in real units, encoded at the config's weight scale. */
function w(value: number): number {
  return Math.trunc(value * DEFAULT_CONFIG.brain.weightScale);
}

/**
 * Hunts: full throttle, steers toward whatever creature it can see, bites
 * anything it touches, eats whatever is under it, never reproduces.
 */
const PREDATOR_BRAIN = skipBrain([
  { output: BrainOutput.Throttle, input: BrainInput.Bias, weight: w(1) },
  { output: BrainOutput.Turn, input: BrainInput.CreatureLateral, weight: w(2) },
  { output: BrainOutput.Attack, input: BrainInput.Bias, weight: w(1) },
  { output: BrainOutput.Eat, input: BrainInput.Bias, weight: w(1) },
  { output: BrainOutput.Reproduce, input: BrainInput.Bias, weight: w(-1) },
]);

/** Grazes where it stands and never moves, fights or breeds. */
const PREY_BRAIN = skipBrain([
  { output: BrainOutput.Throttle, input: BrainInput.Bias, weight: w(-1) },
  { output: BrainOutput.Turn, input: BrainInput.Bias, weight: 0 },
  { output: BrainOutput.Attack, input: BrainInput.Bias, weight: w(-1) },
  { output: BrainOutput.Eat, input: BrainInput.Bias, weight: w(1) },
  { output: BrainOutput.Reproduce, input: BrainInput.Bias, weight: w(-1) },
]);

const PREDATOR_GENES = {
  [Gene.AttackPower]: Q,
  [Gene.Armor]: 0,
  [Gene.Process + Resource.Meat]: Q, [Gene.Process + Resource.Foliage]: 0,
  [Gene.AdultSize]: Q,
  [Gene.MaxSpeed]: Q,
  [Gene.Acceleration]: Q,
  [Gene.VisionRange]: Q,
  [Gene.VisionFov]: Q,
} as const;

const PREY_GENES = {
  [Gene.AttackPower]: 0,
  [Gene.Armor]: 0,
  [Gene.Process + Resource.Foliage]: Q, [Gene.Process + Resource.Meat]: 0,
} as const;

interface PlacedOrganism {
  xPos: number;
  yPos: number;
  angle?: number;
  genesQ?: Readonly<Record<number, number>>;
  brainWeights?: Int16Array;
  speciesId?: number;
  /** Spawn already grown, so a test does not have to run a thousand ticks first. */
  mature?: boolean;
  energyFractionQ?: number;
}

/**
 * Put one handcrafted organism into a real engine.
 *
 * Reaches the engine's context through the package-internal channel, which is
 * what `internal.ts` documents it for: engine phase code and engine tests. The
 * population is spawned this way rather than by world generation because these
 * worlds set `initialOrganisms: 0` — the point is a controlled cast, not a
 * founder cohort.
 */
function place(engine: SimulationEngine, options: PlacedOrganism): number {
  const ctx = engineInternals(engine).context;
  // Since Milestone 8 every organism must belong to a registered species; the
  // engine constructor creates species 1, and casts that use higher IDs get
  // sibling records here (population is counted by spawnOrganism itself).
  while (ctx.species.count < (options.speciesId ?? 1)) {
    ctx.species.createSpecies({
      parentSpeciesId: 0,
      originTick: 0,
      centroid: new Int32Array(TRAIT_DIMENSIONS),
      founderEntityId: ctx.organisms.nextEntityId,
      generationAtOrigin: 0,
    });
  }
  const genes = createFounderGenes();
  for (const [gene, valueQ] of Object.entries(options.genesQ ?? {})) {
    genes[Number(gene) % GENE_COUNT] = geneFromQ(valueQ);
  }
  const slot = spawnOrganism(ctx, {
    xPos: options.xPos,
    yPos: options.yPos,
    angle: options.angle ?? 0,
    genes,
    morphGenes: createFounderMorphGenes(ctx.config.organism.morphology),
    topology: createFounderTopology(),
    brainWeights: options.brainWeights ?? PREY_BRAIN,
    generation: 0,
    parentEntityId: 0,
    speciesId: options.speciesId ?? 1,
    energy: {
      kind: "fractionOfMax",
      fractionQ: options.energyFractionQ ?? DEVELOPED_ENERGY_FRACTION_Q,
    },
  });
  if (slot < 0) {
    throw new Error("test organism could not be placed");
  }
  if (options.mature === true) {
    // Exactly what the store would hold for a fully developed adult; growth only
    // ever moves development up, so a Q development with age 0 simply stops
    // growing rather than shrinking back. Energy is re-derived because an adult
    // body holds more than the newborn one the spawner sized it against.
    ctx.organisms.developmentQ[slot] = Q;
    const mass = massFromRadiusPos(
      ctx.phenotypes.adultRadiusPos[slot] as number,
      ctx.config.organism.massScalePerRadiusSquared,
    );
    ctx.organisms.energy[slot] = qmul(
      maxEnergyForMass(mass, ctx.config),
      options.energyFractionQ ?? DEVELOPED_ENERGY_FRACTION_Q,
    );
  }
  return slot;
}

/** Founder-region centre in sub-units: guaranteed land in a validated world. */
function landCentre(engine: SimulationEngine): { xPos: number; yPos: number } {
  const cellSizePos = engine.environment.cellSizeLU * POS_SCALE;
  return {
    xPos: engine.founderRegion.centerGridX * cellSizePos + (cellSizePos >> 1),
    yPos: engine.founderRegion.centerGridY * cellSizePos + (cellSizePos >> 1),
  };
}

function emptyWorldConfig(mutate?: (config: SimulationConfig) => void): SimulationConfig {
  const config = cloneConfig(DEFAULT_CONFIG);
  config.world.initialOrganisms = 0;
  mutate?.(config);
  return config;
}

describe("predator/prey fixture (task F08, docs/07 §5)", () => {
  /**
   * One shared hunt: a fast, carnivorous, hard-hitting genome placed 12 LU
   * behind a stationary herbivore, run for 400 ticks of the real tick loop.
   */
  const hunt = (() => {
    const engine = new SimulationEngine({ seed: FIXTURE_SEED, config: emptyWorldConfig() });
    const centre = landCentre(engine);
    const predator = place(engine, {
      ...centre,
      angle: 0,
      genesQ: PREDATOR_GENES,
      brainWeights: PREDATOR_BRAIN,
      speciesId: 1,
      mature: true,
      energyFractionQ: Q,
    });
    const prey = place(engine, {
      xPos: centre.xPos + 12 * POS_SCALE,
      yPos: centre.yPos,
      genesQ: PREY_GENES,
      brainWeights: PREY_BRAIN,
      speciesId: 2,
      mature: true,
    });
    const predatorId = engine.organisms.entityId[predator] as number;
    const preyId = engine.organisms.entityId[prey] as number;

    let firstDamageTick = -1;
    let deathTick = -1;
    let preyHealthBefore = engine.organisms.healthQ[prey] as number;
    // The run deliberately continues past the kill: a carcass created in phase 13
    // only enters the carcass index at phase 2 of the following tick, so stopping
    // at the kill would test everything except the scavenging that follows it.
    for (let tick = 0; tick < 400; tick += 1) {
      engine.step();
      if (deathTick === -1) {
        if (engine.organisms.findSlotByEntityId(preyId) === -1) {
          deathTick = tick;
          continue;
        }
        const health = engine.organisms.healthQ[prey] as number;
        if (firstDamageTick === -1 && health < preyHealthBefore) {
          firstDamageTick = tick;
        }
        preyHealthBefore = health;
      }
    }
    return { engine, predator, predatorId, preyId, firstDamageTick, deathTick };
  })();

  it("closes the distance and wounds the prey without any predator role existing", () => {
    expect(hunt.firstDamageTick).toBeGreaterThan(0);
    // It had to travel: contact was not available on the first tick.
    expect(hunt.firstDamageTick).toBeGreaterThan(1);
  });

  it("kills the prey, and the death is attributed to combat", () => {
    expect(hunt.deathTick).toBeGreaterThan(hunt.firstDamageTick);
    expect(hunt.engine.organisms.findSlotByEntityId(hunt.preyId)).toBe(-1);
    expect(hunt.engine.organisms.deathsByCause[DeathCause.Combat]).toBe(1);
    expect(hunt.engine.organisms.deathsByCause[DeathCause.Starvation]).toBe(0);
  });

  it("credits the kill to the attacker", () => {
    const predatorSlot = hunt.engine.organisms.findSlotByEntityId(hunt.predatorId);
    expect(predatorSlot).toBeGreaterThanOrEqual(0);
    expect(hunt.engine.organisms.kills[predatorSlot]).toBe(1);
  });

  it("leaves a carcass the predator then eats", () => {
    expect(hunt.engine.carcasses.totalCreated).toBe(1);
    expect(hunt.engine.carcasses.totalMeatCreated).toBeGreaterThan(0);
    expect(hunt.engine.carcasses.totalMeatEaten).toBeGreaterThan(0);

    const predatorSlot = hunt.engine.organisms.findSlotByEntityId(hunt.predatorId);
    expect(hunt.engine.organisms.meatEnergyEaten[predatorSlot]).toBeGreaterThan(0);
  });

  it("conserves meat across creation, eating, decay and what is left lying", () => {
    const { carcasses } = hunt.engine;
    expect(
      carcasses.totalMeatEaten + carcasses.totalMeatDecayed + carcasses.totalRemainingMeat(),
    ).toBe(carcasses.totalMeatCreated);
  });

  it("charges the hunter more than an identical organism with nothing to fight", () => {
    // Attacking is not free, and the comparison is what shows it: the same
    // genome, the same brain, the same 400 ticks, with and without a target.
    // Without the cost, "attack always" would be a free genome (docs/04 §6).
    const idle = new SimulationEngine({ seed: FIXTURE_SEED, config: emptyWorldConfig() });
    const centre = landCentre(idle);
    const loner = place(idle, {
      ...centre,
      angle: 0,
      genesQ: PREDATOR_GENES,
      brainWeights: PREDATOR_BRAIN,
      speciesId: 1,
      mature: true,
      energyFractionQ: Q,
    });
    idle.stepMany(400);

    const predatorSlot = hunt.engine.organisms.findSlotByEntityId(hunt.predatorId);
    expect(hunt.engine.organisms.alive[predatorSlot]).toBe(1);
    expect(idle.organisms.alive[loner]).toBe(1);
    // The hunter is the one that swung, and it shows in the attack cooldown row.
    expect(hunt.engine.organisms.kills[predatorSlot]).toBe(1);
    expect(idle.organisms.kills[loner]).toBe(0);
    expect(idle.carcasses.totalCreated).toBe(0);
  });
});

describe("mutual kill through the real tick loop (task F05)", () => {
  it("lets two evenly matched fighters kill each other on the same tick", () => {
    const engine = new SimulationEngine({ seed: FIXTURE_SEED, config: emptyWorldConfig() });
    const centre = landCentre(engine);
    const fighters = [0, 1].map((i) =>
      place(engine, {
        xPos: centre.xPos + i * POS_SCALE,
        yPos: centre.yPos,
        genesQ: PREDATOR_GENES,
        brainWeights: PREDATOR_BRAIN,
        speciesId: 1,
        mature: true,
        energyFractionQ: Q,
      }),
    );
    // Both one blow from death, in contact, both willing to attack.
    for (const slot of fighters) {
      engine.organisms.healthQ[slot] = 1;
    }

    engine.step();

    expect(engine.organisms.liveCount).toBe(0);
    expect(engine.organisms.deathsByCause[DeathCause.Combat]).toBe(2);
    // Two bodies, two carcasses: nothing was lost to the simultaneous deaths.
    expect(engine.carcasses.liveCount).toBe(2);
    expect(engine.carcasses.totalCreated).toBe(2);
  });
});

describe("diet selection (docs/07 §5)", () => {
  /**
   * Two genotypes identical in every gene except the signed diet gene, in two
   * worlds that differ only in which food exists. docs/07 §5 asks for the
   * matching specialist to gain realized reproductive share — which is the only
   * kind of fitness this project has (docs/05 §1).
   *
   * Mutation is switched off so a lineage's diet cannot drift: with clones, the
   * diet gene is the *only* difference the result can come from.
   */
  const HERBIVORE_SPECIES = 1;
  const CARNIVORE_SPECIES = 2;
  const COHORT = 8;
  const TICKS = 900;
  const SPACING_LU = 24;

  function dietExperiment(options: { meatWorld: boolean }): Record<number, number> {
    const config = emptyWorldConfig((draft) => {
      // Clones only: no gene mutation, no brain mutation.
      draft.mutation.ecological.perGeneMutationProbabilityQ = 0;
      draft.mutation.ecological.largeMutationProbabilityQ = 0;
      draft.mutation.ecological.resetProbabilityQ = 0;
      draft.mutation.brain.perWeightMutationProbabilityQ = 0;
      draft.mutation.brain.largeWeightMutationProbabilityQ = 0;
      if (options.meatWorld) {
        // A world with no vegetation at all: capacity stays (so world validation
        // still passes) but nothing ever grows in it.
        draft.plants.initialBiomassFractionQ = 0;
        draft.plants.resources[Resource.Foliage]!.growthRateQByBiome = draft.plants.resources[Resource.Foliage]!.growthRateQByBiome.map(() => 0);
        draft.plants.resources[Resource.Foliage]!.seedBankRegenUnits = 0;
      }
    });

    const engine = new SimulationEngine({ seed: FIXTURE_SEED, config });
    const centre = landCentre(engine);
    // Eats whatever is available and breeds whenever the hard rules allow;
    // stands still so the experiment is about digestion, not about foraging.
    const brain = skipBrain([
      { output: BrainOutput.Throttle, input: BrainInput.Bias, weight: w(-1) },
      { output: BrainOutput.Eat, input: BrainInput.Bias, weight: w(1) },
      { output: BrainOutput.Reproduce, input: BrainInput.Bias, weight: w(1) },
    ]);

    const spacing = SPACING_LU * POS_SCALE;
    for (let i = 0; i < COHORT; i += 1) {
      for (const [species, dietQ] of [
        [HERBIVORE_SPECIES, 0],
        [CARNIVORE_SPECIES, Q],
      ] as const) {
        place(engine, {
          xPos: centre.xPos + (i - COHORT / 2) * spacing,
          yPos: centre.yPos + (species === HERBIVORE_SPECIES ? -spacing : spacing),
          genesQ: { [Gene.Process + Resource.Meat]: dietQ },
          brainWeights: brain,
          speciesId: species,
          mature: true,
        });
      }
    }
    // Mature adults, so births can start immediately instead of after 1 120
    // ticks of growth.
    for (let slot = 0; slot < engine.organisms.slotHighWater; slot += 1) {
      engine.organisms.ageTicks[slot] = engineInternals(engine).context.phenotypes.maturityAgeTicks[
        slot
      ] as number;
    }

    const births: Record<number, number> = { [HERBIVORE_SPECIES]: 0, [CARNIVORE_SPECIES]: 0 };
    let nextCarcassId = 1_000_000;
    for (let tick = 0; tick < TICKS; tick += 1) {
      if (options.meatWorld && tick % 20 === 0) {
        // Meat rain: one carcass under every living organism, so both genotypes
        // are offered exactly the same food in exactly the same place.
        for (let slot = 0; slot < engine.organisms.slotHighWater; slot += 1) {
          if (engine.organisms.alive[slot] !== 1) {
            continue;
          }
          engine.carcasses.create(
            nextCarcassId,
            engine.organisms.x[slot] as number,
            engine.organisms.y[slot] as number,
            600,
            engine.organisms.speciesId[slot] as number,
          );
          nextCarcassId += 1;
        }
      }
      engine.step();

      // A newborn ends its birth tick at age 0: births happen in phase 14, after
      // the phase that ages everyone.
      for (let slot = 0; slot < engine.organisms.slotHighWater; slot += 1) {
        if (engine.organisms.alive[slot] === 1 && engine.organisms.ageTicks[slot] === 0) {
          const species = engine.organisms.speciesId[slot] as number;
          births[species] = (births[species] ?? 0) + 1;
        }
      }
    }
    return births;
  }

  it("rewards the herbivore specialist in a world of plants", () => {
    const births = dietExperiment({ meatWorld: false });
    expect(births[HERBIVORE_SPECIES]).toBeGreaterThan(0);
    expect(births[HERBIVORE_SPECIES] as number).toBeGreaterThan(
      births[CARNIVORE_SPECIES] as number,
    );
  });

  it("rewards the carnivore specialist in a world of meat", () => {
    const births = dietExperiment({ meatWorld: true });
    expect(births[CARNIVORE_SPECIES]).toBeGreaterThan(0);
    expect(births[CARNIVORE_SPECIES] as number).toBeGreaterThan(
      births[HERBIVORE_SPECIES] as number,
    );
  });
});

describe("deterministic snapshot and resume with carrion", () => {
  /**
   * A world that has killed, eaten and rotted before the snapshot is taken, so
   * the carcass store has live rows, non-trivial counters AND a non-empty free
   * list — the three things a naive restore gets wrong.
   */
  function predationWorld(): SimulationEngine {
    const engine = new SimulationEngine({ seed: FIXTURE_SEED, config: emptyWorldConfig() });
    const centre = landCentre(engine);
    for (let i = 0; i < 6; i += 1) {
      place(engine, {
        xPos: centre.xPos + i * 3 * POS_SCALE,
        yPos: centre.yPos,
        genesQ: PREDATOR_GENES,
        brainWeights: PREDATOR_BRAIN,
        speciesId: 1,
        mature: true,
        energyFractionQ: Q,
      });
      place(engine, {
        xPos: centre.xPos + i * 3 * POS_SCALE,
        yPos: centre.yPos + 4 * POS_SCALE,
        genesQ: PREY_GENES,
        brainWeights: PREY_BRAIN,
        speciesId: 2,
        mature: true,
      });
    }
    return engine;
  }

  const SNAPSHOT_TICK = 250;
  const TOTAL_TICKS = 400;

  const paused = (() => {
    const engine = predationWorld();
    engine.stepMany(SNAPSHOT_TICK);
    return { snapshot: engine.serialize(), hash: engine.computeStateHash(), engine };
  })();

  it("produced carcasses and consumed some of them before the snapshot", () => {
    expect(paused.engine.carcasses.totalCreated).toBeGreaterThan(0);
    expect(paused.engine.carcasses.totalMeatEaten).toBeGreaterThan(0);
    expect(paused.engine.organisms.deathsByCause[DeathCause.Combat]).toBeGreaterThan(0);
  });

  it("restores the carcass store to the same hash", () => {
    const resumed = engineFromSnapshot(paused.snapshot);
    expect(resumed.computeStateHash()).toBe(paused.hash);
    expect(resumed.carcasses.liveCount).toBe(paused.engine.carcasses.liveCount);
    expect(resumed.carcasses.slotHighWater).toBe(paused.engine.carcasses.slotHighWater);
    expect(resumed.carcasses.freeCount).toBe(paused.engine.carcasses.freeCount);
    expect(resumed.carcasses.totalMeatCreated).toBe(paused.engine.carcasses.totalMeatCreated);
    expect(resumed.carcasses.totalMeatEaten).toBe(paused.engine.carcasses.totalMeatEaten);
    expect(resumed.carcasses.totalMeatDecayed).toBe(paused.engine.carcasses.totalMeatDecayed);
  });

  it("continues to the same state as an uninterrupted run", () => {
    const straight = predationWorld();
    straight.stepMany(TOTAL_TICKS);

    const resumed = engineFromSnapshot(paused.snapshot);
    resumed.stepMany(TOTAL_TICKS - SNAPSHOT_TICK);

    expect(resumed.tick).toBe(TOTAL_TICKS);
    expect(resumed.computeStateHash()).toBe(straight.computeStateHash());
    expect(resumed.carcasses.totalMeatCreated).toBe(straight.carcasses.totalMeatCreated);
    expect(resumed.carcasses.totalMeatEaten).toBe(straight.carcasses.totalMeatEaten);
  });

  it("is reproducible from the same seed and cast", () => {
    const first = predationWorld();
    const second = predationWorld();
    first.stepMany(TOTAL_TICKS);
    second.stepMany(TOTAL_TICKS);
    expect(second.computeStateHash()).toBe(first.computeStateHash());
    expect(second.carcasses.totalMeatEaten).toBe(first.carcasses.totalMeatEaten);
  });

  it("keeps meat conserved over the whole run", () => {
    const { carcasses } = paused.engine;
    expect(
      carcasses.totalMeatEaten + carcasses.totalMeatDecayed + carcasses.totalRemainingMeat(),
    ).toBe(carcasses.totalMeatCreated);
  });

  /**
   * One snapshot tick can be lucky. Combat and carrion state changes shape from
   * tick to tick — a cooldown counting down, a claim filed, a carcass created in
   * phase 13, a slot returned to the free list by phase 9 or 15 — so the tick a
   * save happens to land on decides which of those a naive restore would drop.
   * This saves at EVERY tick of a window in which all of it is happening, the
   * same method ADR 0007 used for reproduction.
   */
  it("resumes identically from a snapshot taken at every tick of a combat window", () => {
    const WINDOW_START = 100;
    const WINDOW = 24;
    const CONTINUE_TO = 200;

    const engine = predationWorld();
    engine.stepMany(WINDOW_START);

    const saves: { tick: number; snapshot: ReturnType<SimulationEngine["serialize"]> }[] = [];
    const hashByTick = new Map<number, string>();
    for (let i = 0; i < WINDOW; i += 1) {
      engine.step();
      saves.push({ tick: engine.tick, snapshot: engine.serialize() });
      hashByTick.set(engine.tick, engine.computeStateHash());
    }
    while (engine.tick < CONTINUE_TO) {
      engine.step();
      hashByTick.set(engine.tick, engine.computeStateHash());
    }

    // The window has to contain the state it claims to cover, or this proves
    // nothing: carcasses lying about, and a free list that has already been used.
    expect(engine.carcasses.totalCreated).toBeGreaterThan(0);
    expect(engine.carcasses.totalMeatEaten).toBeGreaterThan(0);

    for (const save of saves) {
      const resumed = engineFromSnapshot(save.snapshot);
      expect(resumed.tick).toBe(save.tick);
      expect(resumed.computeStateHash()).toBe(hashByTick.get(save.tick));
      while (resumed.tick < CONTINUE_TO) {
        resumed.step();
        expect(resumed.computeStateHash()).toBe(hashByTick.get(resumed.tick));
      }
    }
  });
});
