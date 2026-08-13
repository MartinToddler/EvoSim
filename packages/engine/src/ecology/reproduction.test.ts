import { describe, expect, it } from "vitest";
import type { SimulationConfig } from "../config/SimulationConfig";
import type { EngineContext } from "../EngineContext";
import { Gene } from "../genetics/genes";
import { POS_SCALE, Q } from "../math/fixed";
import { applyMetabolismGrowthThermalAging } from "../organisms/metabolism";
import { currentRadiusPos, massFromRadiusPos, maxEnergyForMass } from "../organisms/phenotype";
import { createTestWorld, spawnTestOrganism, type TestWorld } from "../testing/harness";
import { canReproduce, reproductionEnergyCost, resolveReproduction } from "./reproduction";

/**
 * Reproduction (docs/04 §19, docs/08 §16, docs/07 §2 "Reproduction: maturity/
 * development, energy conservation, child generation/parent, mutation, cap
 * guard").
 *
 * Every test states its own conditions on a flat synthetic world. Reproduction
 * needs a mature, fully developed, well-fed parent, which would otherwise take
 * ~1200 ticks of physiology to reach.
 */

const MATURE_AGE = 4000;

interface ParentOptions {
  energyFractionQ?: number;
  developmentQ?: number;
  ageTicks?: number;
  genesQ?: Partial<Record<number, number>>;
  gridX?: number;
  gridY?: number;
}

/** A world holding one adult, fed and ready to reproduce. */
function worldWithAdult(
  options: ParentOptions = {},
  configure?: (config: SimulationConfig) => void,
): { world: TestWorld; ctx: EngineContext; slot: number } {
  const world = configure === undefined ? createTestWorld() : createTestWorld({ configure });
  const { xPos, yPos } = world.cellCenter(options.gridX ?? 20, options.gridY ?? 20);
  const slot = spawnTestOrganism(world, {
    xPos,
    yPos,
    genesQ: options.genesQ ?? {},
    ageTicks: options.ageTicks ?? MATURE_AGE,
    developmentQ: options.developmentQ ?? Q,
    energyFractionQ: options.energyFractionQ ?? Q,
  });
  return { world, ctx: world.ctx, slot };
}

/** Say "yes, reproduce" for one slot, as the brain phase would. */
function requestReproduction(ctx: EngineContext, slot: number): void {
  ctx.scratch.reproduceQ[slot] = Q;
}

function liveSlots(ctx: EngineContext): number[] {
  const slots: number[] = [];
  for (let slot = 0; slot < ctx.organisms.slotHighWater; slot += 1) {
    if (ctx.organisms.alive[slot] === 1) {
      slots.push(slot);
    }
  }
  return slots;
}

/** Energy held by the whole living population. */
function totalLiveEnergy(ctx: EngineContext): number {
  let total = 0;
  for (const slot of liveSlots(ctx)) {
    total += ctx.organisms.energy[slot] as number;
  }
  return total;
}

describe("reproduction eligibility (task E01)", () => {
  it("accepts a mature, developed, fed adult that asks to reproduce", () => {
    const { ctx, slot } = worldWithAdult();
    requestReproduction(ctx, slot);
    expect(canReproduce(ctx, slot)).toBe(true);
  });

  it("refuses an organism whose brain did not ask", () => {
    const { ctx, slot } = worldWithAdult();
    const threshold = ctx.config.reproduction.reproduceOutputThresholdQ;
    ctx.scratch.reproduceQ[slot] = threshold - 1;
    expect(canReproduce(ctx, slot)).toBe(false);
    ctx.scratch.reproduceQ[slot] = threshold;
    expect(canReproduce(ctx, slot)).toBe(true);
  });

  it("refuses an organism younger than its genetic maturity age", () => {
    const { ctx, slot } = worldWithAdult({ ageTicks: 0 });
    requestReproduction(ctx, slot);
    const maturity = ctx.phenotypes.maturityAgeTicks[slot] as number;

    ctx.organisms.ageTicks[slot] = maturity - 1;
    expect(canReproduce(ctx, slot)).toBe(false);
    ctx.organisms.ageTicks[slot] = maturity;
    expect(canReproduce(ctx, slot)).toBe(true);
  });

  it("refuses an organism below the development gate even when old enough", () => {
    const { ctx, slot } = worldWithAdult();
    requestReproduction(ctx, slot);
    const gate = ctx.config.organism.reproductionMinDevelopmentQ;

    ctx.organisms.developmentQ[slot] = gate - 1;
    expect(canReproduce(ctx, slot)).toBe(false);
    ctx.organisms.developmentQ[slot] = gate;
    expect(canReproduce(ctx, slot)).toBe(true);
  });

  it("refuses an organism still on reproduction cooldown", () => {
    const { ctx, slot } = worldWithAdult();
    requestReproduction(ctx, slot);
    ctx.organisms.reproductionCooldown[slot] = 1;
    expect(canReproduce(ctx, slot)).toBe(false);
    ctx.organisms.reproductionCooldown[slot] = 0;
    expect(canReproduce(ctx, slot)).toBe(true);
  });

  it("refuses a dead slot", () => {
    const { ctx, slot } = worldWithAdult();
    requestReproduction(ctx, slot);
    ctx.organisms.alive[slot] = 0;
    expect(canReproduce(ctx, slot)).toBe(false);
  });

  it("refuses a parent that cannot afford the child plus its own reserve", () => {
    const { ctx, slot } = worldWithAdult();
    requestReproduction(ctx, slot);
    const { required } = reproductionEnergyCost(ctx, slot);

    ctx.organisms.energy[slot] = required - 1;
    expect(canReproduce(ctx, slot)).toBe(false);
    ctx.organisms.energy[slot] = required;
    expect(canReproduce(ctx, slot)).toBe(true);
  });
});

describe("reproduction energy accounting (task E02)", () => {
  it("charges the investment and leaves the parent at or above its reserve", () => {
    const { ctx, slot } = worldWithAdult();
    requestReproduction(ctx, slot);

    const { investment, reserve } = reproductionEnergyCost(ctx, slot);
    const before = ctx.organisms.energy[slot] as number;
    resolveReproduction(ctx);

    const after = ctx.organisms.energy[slot] as number;
    expect(before - after).toBe(investment);
    expect(after).toBeGreaterThanOrEqual(reserve);
  });

  it("gives the child the investment when its newborn body can hold it", () => {
    // Low investment gene: 0.08 of the parent's max fits easily in a newborn.
    const { ctx, slot } = worldWithAdult({ genesQ: { [Gene.OffspringInvestment]: 0 } });
    requestReproduction(ctx, slot);

    const { investment } = reproductionEnergyCost(ctx, slot);
    resolveReproduction(ctx);

    const child = liveSlots(ctx).find((s) => s !== slot) as number;
    expect(ctx.organisms.energy[child]).toBe(investment);
    expect(ctx.organisms.birthEnergyDiscarded).toBe(0);
  });

  it("clamps the child to its own maximum and records the destroyed surplus", () => {
    // Maximum investment (0.35 of parent max) against a newborn that is 45% of
    // adult radius: the endowment cannot fit, so the surplus must be destroyed
    // rather than granted.
    const { ctx, slot } = worldWithAdult({
      genesQ: { [Gene.OffspringInvestment]: Q, [Gene.AdultSize]: Q },
    });
    requestReproduction(ctx, slot);

    const { investment } = reproductionEnergyCost(ctx, slot);
    const parentBefore = ctx.organisms.energy[slot] as number;
    resolveReproduction(ctx);

    const child = liveSlots(ctx).find((s) => s !== slot) as number;
    const childEnergy = ctx.organisms.energy[child] as number;
    const childMax = maxEnergyForMass(
      massFromRadiusPos(
        currentRadiusPos(
          ctx.phenotypes.adultRadiusPos[child] as number,
          ctx.organisms.developmentQ[child] as number,
        ),
        ctx.config.organism.massScalePerRadiusSquared,
      ),
      ctx.config,
    );

    expect(childEnergy).toBe(childMax);
    expect(childEnergy).toBeLessThan(investment);
    expect(ctx.organisms.birthEnergyDiscarded).toBe(investment - childEnergy);
    // The parent paid the full investment regardless: over-investment is a real
    // cost, which is what keeps the gene from drifting to its maximum for free.
    expect(parentBefore - (ctx.organisms.energy[slot] as number)).toBe(investment);
  });

  it("never creates energy: parent loss always equals child gain plus discard", () => {
    // Sweep the investment gene across its whole range against several body
    // sizes, so both the fits-easily and the over-invests regimes are covered.
    for (const investmentQ of [0, 1024, 2048, 3072, Q]) {
      for (const sizeQ of [0, 2048, Q]) {
        const { ctx, slot } = worldWithAdult({
          genesQ: { [Gene.OffspringInvestment]: investmentQ, [Gene.AdultSize]: sizeQ },
        });
        requestReproduction(ctx, slot);

        const parentBefore = ctx.organisms.energy[slot] as number;
        resolveReproduction(ctx);
        const parentAfter = ctx.organisms.energy[slot] as number;

        const children = liveSlots(ctx).filter((s) => s !== slot);
        expect(children).toHaveLength(1);
        const childEnergy = ctx.organisms.energy[children[0] as number] as number;

        expect(parentBefore - parentAfter).toBe(childEnergy + ctx.organisms.birthEnergyDiscarded);
        expect(childEnergy).toBeGreaterThanOrEqual(0);
        expect(parentAfter).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("balances the whole phase exactly, over hundreds of simultaneous births", () => {
    // The tests above check one birth at a time, which cannot catch an error in
    // how the phase ACCUMULATES: a discard credited to the wrong parent, or a
    // deduction applied twice, both balance per birth and not in aggregate.
    //
    // Phase 14 is the only thing running, and the only energy it may move is
    // parent -> child with the surplus destroyed. So the population's total
    // energy must fall by exactly the increase in birthEnergyDiscarded — an
    // equality, not a bound.
    const world = createTestWorld({ gridSize: 32 });
    const ctx = world.ctx;
    const { organisms } = ctx;

    const PARENTS = 400;
    for (let i = 0; i < PARENTS; i += 1) {
      const { xPos, yPos } = world.cellCenter(2 + (i % 28), 2 + Math.floor(i / 28));
      const slot = spawnTestOrganism(world, {
        xPos,
        yPos,
        ageTicks: MATURE_AGE,
        developmentQ: Q,
        energyFractionQ: Q,
        // Spread investment and size across their ranges so the run contains
        // both the fits-easily and the heavily-clamped regimes.
        genesQ: {
          [Gene.OffspringInvestment]: Math.trunc((i * Q) / PARENTS),
          [Gene.AdultSize]: Math.trunc(((i * 7) % PARENTS) * (Q / PARENTS)),
        },
      });
      requestReproduction(ctx, slot);
    }

    const energyBefore = totalLiveEnergy(ctx);
    const discardedBefore = organisms.birthEnergyDiscarded;
    resolveReproduction(ctx);

    expect(organisms.liveCount).toBe(2 * PARENTS);
    expect(totalLiveEnergy(ctx) - energyBefore).toBe(
      -(organisms.birthEnergyDiscarded - discardedBefore),
    );
    // The discard is real in this sweep, so the equality above is not the
    // trivial "nothing was destroyed" case.
    expect(organisms.birthEnergyDiscarded).toBeGreaterThan(0);

    // And nobody ended up holding more than their own body can, or less than
    // nothing — the two ways a birth could break the store's own invariant.
    for (const slot of liveSlots(ctx)) {
      const energy = organisms.energy[slot] as number;
      const radius = currentRadiusPos(
        ctx.phenotypes.adultRadiusPos[slot] as number,
        organisms.developmentQ[slot] as number,
      );
      const mass = massFromRadiusPos(radius, ctx.config.organism.massScalePerRadiusSquared);
      expect(energy).toBeGreaterThanOrEqual(0);
      expect(energy).toBeLessThanOrEqual(maxEnergyForMass(mass, ctx.config));
    }
  });
});

describe("child identity and lineage (task E05)", () => {
  it("records the parent, increments the generation and inherits the species", () => {
    const { ctx, slot } = worldWithAdult();
    ctx.organisms.generation[slot] = 7;
    ctx.organisms.speciesId[slot] = 3;
    requestReproduction(ctx, slot);
    const parentId = ctx.organisms.entityId[slot] as number;

    resolveReproduction(ctx);

    const child = liveSlots(ctx).find((s) => s !== slot) as number;
    expect(ctx.organisms.parentEntityId[child]).toBe(parentId);
    expect(ctx.organisms.generation[child]).toBe(8);
    expect(ctx.organisms.speciesId[child]).toBe(3);
    expect(ctx.organisms.entityId[child]).toBeGreaterThan(parentId);
  });

  it("starts the child as a newborn, not a small adult", () => {
    const { ctx, slot } = worldWithAdult();
    requestReproduction(ctx, slot);
    resolveReproduction(ctx);

    const child = liveSlots(ctx).find((s) => s !== slot) as number;
    expect(ctx.organisms.developmentQ[child]).toBe(ctx.config.organism.birthSizeFractionQ);
    expect(ctx.organisms.ageTicks[child]).toBe(0);
    expect(ctx.organisms.healthQ[child]).toBe(Q);
    expect(ctx.organisms.reproductionCooldown[child]).toBe(0);
    expect(ctx.organisms.plantEnergyEaten[child]).toBe(0);
  });

  it("counts the birth and puts the parent on cooldown", () => {
    const { ctx, slot } = worldWithAdult();
    requestReproduction(ctx, slot);
    const birthsBefore = ctx.organisms.totalBirths;

    resolveReproduction(ctx);

    expect(ctx.organisms.totalBirths).toBe(birthsBefore + 1);
    expect(ctx.organisms.reproductionCooldown[slot]).toBe(
      ctx.config.reproduction.reproductionCooldownTicks,
    );
  });

  it("mutates the child's genome away from the parent's over a lineage", () => {
    const { ctx, slot } = worldWithAdult();
    let differing = 0;
    // One birth changes ~1.3 genes on average, so a handful of births is needed
    // before a difference is near-certain. All descend from the same founder.
    for (let birth = 0; birth < 12; birth += 1) {
      ctx.organisms.reproductionCooldown[slot] = 0;
      ctx.organisms.energy[slot] = 1_000_000_000;
      requestReproduction(ctx, slot);
      resolveReproduction(ctx);
    }
    const parentGenes = ctx.genomes.genes.subarray(
      ctx.genomes.geneOffset(slot),
      ctx.genomes.geneOffset(slot) + 16,
    );
    for (const child of liveSlots(ctx).filter((s) => s !== slot)) {
      const childGenes = ctx.genomes.genes.subarray(
        ctx.genomes.geneOffset(child),
        ctx.genomes.geneOffset(child) + 16,
      );
      for (let i = 0; i < 16; i += 1) {
        if (childGenes[i] !== parentGenes[i]) differing += 1;
      }
    }
    expect(differing).toBeGreaterThan(0);
    // The parent's own genome is never touched by its children's mutations.
    const { ctx: fresh, slot: freshSlot } = worldWithAdult();
    expect(parentGenes).toEqual(
      fresh.genomes.genes.subarray(
        fresh.genomes.geneOffset(freshSlot),
        fresh.genomes.geneOffset(freshSlot) + 16,
      ),
    );
  });
});

describe("reproduction is asexual (CLAUDE.md scope, docs/04 §19)", () => {
  it("lets a lone organism reproduce with no other organism in the world", () => {
    // The direct statement that there is no mate requirement, no partner search
    // and no crossover: the world holds exactly one organism, and it reproduces.
    const { ctx, slot } = worldWithAdult();
    expect(ctx.organisms.liveCount).toBe(1);
    requestReproduction(ctx, slot);

    resolveReproduction(ctx);

    expect(ctx.organisms.liveCount).toBe(2);
    const child = liveSlots(ctx).find((s) => s !== slot) as number;
    expect(ctx.organisms.parentEntityId[child]).toBe(ctx.organisms.entityId[slot]);
  });

  it("spaces a parent's births by exactly the configured cooldown", () => {
    // The cooldown is decremented by the physiology phase (12), which runs before
    // reproduction (14), so a cooldown of N has to produce a gap of exactly N
    // ticks — not N-1 and not N+1.
    const { ctx, slot } = worldWithAdult();
    const cooldownTicks = ctx.config.reproduction.reproductionCooldownTicks;
    expect(cooldownTicks).toBeGreaterThan(0);

    requestReproduction(ctx, slot);
    resolveReproduction(ctx);
    expect(ctx.organisms.totalBirths).toBe(2);

    // Energy is topped up each tick so that cooldown is the ONLY thing gating the
    // second birth; without this the parent's reserve would confound the test.
    const refill = ctx.organisms.energy[slot] as number;
    for (let tick = 1; tick < cooldownTicks; tick += 1) {
      applyMetabolismGrowthThermalAging(ctx);
      ctx.organisms.energy[slot] = refill;
      requestReproduction(ctx, slot);
      resolveReproduction(ctx);
      expect(`tick ${tick}: births ${ctx.organisms.totalBirths}`).toBe(`tick ${tick}: births 2`);
    }

    applyMetabolismGrowthThermalAging(ctx);
    ctx.organisms.energy[slot] = refill;
    expect(ctx.organisms.reproductionCooldown[slot]).toBe(0);
    requestReproduction(ctx, slot);
    resolveReproduction(ctx);
    expect(ctx.organisms.totalBirths).toBe(3);
  });
});

describe("at most one child per parent per tick (docs/04 §19)", () => {
  it("produces exactly one child from one eligible parent", () => {
    const { ctx, slot } = worldWithAdult();
    requestReproduction(ctx, slot);
    resolveReproduction(ctx);
    expect(ctx.organisms.liveCount).toBe(2);
    expect(liveSlots(ctx).filter((s) => s !== slot)).toHaveLength(1);
  });

  it("does not let a newborn reproduce on its birth tick even in a lower slot", () => {
    // Free the first slot so the newborn lands BELOW its own parent, which is the
    // case a single ascending pass would get wrong (docs/10 §14 LIFO reuse).
    const world = createTestWorld();
    const ctx = world.ctx;
    const a = world.cellCenter(20, 20);
    const b = world.cellCenter(24, 20);
    const doomed = spawnTestOrganism(world, { xPos: a.xPos, yPos: a.yPos });
    const parent = spawnTestOrganism(world, {
      xPos: b.xPos,
      yPos: b.yPos,
      ageTicks: MATURE_AGE,
      developmentQ: Q,
      energyFractionQ: Q,
    });
    expect(doomed).toBe(0);
    expect(parent).toBe(1);

    ctx.genomes.clearSlot(doomed);
    ctx.organisms.releaseSlot(doomed);
    expect(ctx.organisms.freeCount).toBe(1);

    // Every slot asks to reproduce, including whichever one the newborn takes.
    ctx.scratch.reproduceQ.fill(Q);
    resolveReproduction(ctx);

    // The newborn took slot 0, below its parent in slot 1 — and produced nothing.
    expect(ctx.organisms.liveCount).toBe(2);
    expect(ctx.organisms.alive[0]).toBe(1);
    expect(ctx.organisms.parentEntityId[0]).toBe(ctx.organisms.entityId[parent]);
    expect(ctx.organisms.totalBirths).toBe(3);
  });
});

describe("deterministic child placement (task E02)", () => {
  it("places the child within the configured distance band, out of water", () => {
    const { ctx, slot } = worldWithAdult();
    requestReproduction(ctx, slot);
    const parentX = ctx.organisms.x[slot] as number;
    const parentY = ctx.organisms.y[slot] as number;
    resolveReproduction(ctx);

    const child = liveSlots(ctx).find((s) => s !== slot) as number;
    const dx = (ctx.organisms.x[child] as number) - parentX;
    const dy = (ctx.organisms.y[child] as number) - parentY;
    const distancePos = Math.sqrt(dx * dx + dy * dy);
    const { childSpawnDistanceMinLU, childSpawnDistanceMaxLU } = ctx.config.reproduction;

    // The trig LUT truncates, so allow one sub-unit of slack at each bound.
    expect(distancePos).toBeGreaterThanOrEqual(childSpawnDistanceMinLU * POS_SCALE - 2);
    expect(distancePos).toBeLessThanOrEqual(childSpawnDistanceMaxLU * POS_SCALE + 2);
    expect(
      ctx.environment.isWaterCell(
        ctx.environment.cellIndexFromPosition(
          ctx.organisms.x[child] as number,
          ctx.organisms.y[child] as number,
        ),
      ),
    ).toBe(false);
  });

  it("is a pure function of state: identical worlds place children identically", () => {
    const positions: string[] = [];
    for (let run = 0; run < 2; run += 1) {
      const { ctx, slot } = worldWithAdult();
      requestReproduction(ctx, slot);
      resolveReproduction(ctx);
      const child = liveSlots(ctx).find((s) => s !== slot) as number;
      positions.push(
        `${ctx.organisms.x[child]},${ctx.organisms.y[child]},${ctx.organisms.angle[child]}`,
      );
    }
    expect(positions[0]).toBe(positions[1]);
  });

  it("falls back to the parent's own position when every candidate is water", () => {
    const { world, ctx, slot } = worldWithAdult({ gridX: 20, gridY: 20 });
    requestReproduction(ctx, slot);

    // Flood the whole 3x3 neighbourhood INCLUDING the parent's own cell. The
    // spawn band is 2 … 8 LU against 16 LU cells, so a candidate can legitimately
    // land back inside the parent's cell — leaving that cell dry would let the
    // search succeed and never reach the fallback.
    //
    // This is therefore also the "parent standing in water" case, which
    // reproduction deliberately does not special-case: the child is born in
    // water and takes its chances (ecology/reproduction.ts).
    for (let gx = 19; gx <= 21; gx += 1) {
      for (let gy = 19; gy <= 21; gy += 1) {
        world.makeWater(gx, gy);
      }
    }
    resolveReproduction(ctx);

    const child = liveSlots(ctx).find((s) => s !== slot) as number;
    expect(ctx.organisms.x[child]).toBe(ctx.organisms.x[slot]);
    expect(ctx.organisms.y[child]).toBe(ctx.organisms.y[slot]);
  });

  it("keeps the child inside the world when the parent hugs a corner", () => {
    const world = createTestWorld();
    const ctx = world.ctx;
    const slot = spawnTestOrganism(world, {
      xPos: 0,
      yPos: 0,
      ageTicks: MATURE_AGE,
      developmentQ: Q,
      energyFractionQ: Q,
    });
    requestReproduction(ctx, slot);
    resolveReproduction(ctx);

    const child = liveSlots(ctx).find((s) => s !== slot) as number;
    expect(ctx.organisms.x[child]).toBeGreaterThanOrEqual(0);
    expect(ctx.organisms.y[child]).toBeGreaterThanOrEqual(0);
    expect(ctx.organisms.x[child]).toBeLessThan(world.worldSizePos);
    expect(ctx.organisms.y[child]).toBeLessThan(world.worldSizePos);
  });
});

describe("population cap (task E06, docs/03 §2, docs/10 §15)", () => {
  /**
   * Shrink the population cap so it can actually be reached in a unit test.
   *
   * Two other thresholds are stated as absolute organism counts and must stay
   * reachable inside the cap, so they scale down with it: the species split
   * needs 2 x minDaughterPopulation members (docs/05 §6) and the carnivore
   * lineage event needs carnivoreMinPopulation (docs/05 §15).
   */
  const capTo =
    (maxOrganisms: number) =>
    (config: SimulationConfig): void => {
      config.limits.maxOrganisms = maxOrganisms;
      config.world.initialOrganisms = maxOrganisms;
      config.species.minDaughterPopulation = 1;
      config.history.carnivoreMinPopulation = 1;
    };
  const capTwo = capTo(2);

  it("rejects the birth, counts it, and leaves the parent untouched", () => {
    const world = createTestWorld({ configure: capTwo });
    const ctx = world.ctx;
    const a = world.cellCenter(20, 20);
    const b = world.cellCenter(24, 20);
    const parent = spawnTestOrganism(world, {
      xPos: a.xPos,
      yPos: a.yPos,
      ageTicks: MATURE_AGE,
      developmentQ: Q,
      energyFractionQ: Q,
    });
    spawnTestOrganism(world, { xPos: b.xPos, yPos: b.yPos });
    expect(ctx.organisms.liveCount).toBe(2);
    expect(ctx.organisms.canAllocate()).toBe(false);

    requestReproduction(ctx, parent);
    const energyBefore = ctx.organisms.energy[parent] as number;
    const birthsBefore = ctx.organisms.totalBirths;

    resolveReproduction(ctx);

    expect(ctx.organisms.capRejectedBirths).toBe(1);
    expect(ctx.organisms.liveCount).toBe(2);
    expect(ctx.organisms.totalBirths).toBe(birthsBefore);
    // No child, no cost, and no cooldown: the parent may try again next tick.
    expect(ctx.organisms.energy[parent]).toBe(energyBefore);
    expect(ctx.organisms.reproductionCooldown[parent]).toBe(0);
  });

  it("consumes no randomness when the cap refuses a birth", () => {
    // Otherwise a full world would silently shift the PRNG stream, and the same
    // seed would diverge depending on whether the cap happened to be reached.
    const world = createTestWorld({ configure: capTwo });
    const ctx = world.ctx;
    const a = world.cellCenter(20, 20);
    const b = world.cellCenter(24, 20);
    const parent = spawnTestOrganism(world, {
      xPos: a.xPos,
      yPos: a.yPos,
      ageTicks: MATURE_AGE,
      developmentQ: Q,
      energyFractionQ: Q,
    });
    spawnTestOrganism(world, { xPos: b.xPos, yPos: b.yPos });

    requestReproduction(ctx, parent);
    const stateBefore = ctx.rng.serializeState();
    resolveReproduction(ctx);
    expect(ctx.rng.serializeState()).toEqual(stateBefore);
  });

  it("resumes births as soon as a slot is freed", () => {
    const world = createTestWorld({ configure: capTwo });
    const ctx = world.ctx;
    const a = world.cellCenter(20, 20);
    const b = world.cellCenter(24, 20);
    const parent = spawnTestOrganism(world, {
      xPos: a.xPos,
      yPos: a.yPos,
      ageTicks: MATURE_AGE,
      developmentQ: Q,
      energyFractionQ: Q,
    });
    const filler = spawnTestOrganism(world, { xPos: b.xPos, yPos: b.yPos });

    requestReproduction(ctx, parent);
    resolveReproduction(ctx);
    expect(ctx.organisms.capRejectedBirths).toBe(1);

    ctx.genomes.clearSlot(filler);
    ctx.organisms.releaseSlot(filler);
    requestReproduction(ctx, parent);
    resolveReproduction(ctx);

    expect(ctx.organisms.capRejectedBirths).toBe(1);
    expect(ctx.organisms.liveCount).toBe(2);
    expect(ctx.organisms.parentEntityId[filler]).toBe(ctx.organisms.entityId[parent]);
  });

  it("rejects in ascending parent slot order and counts every refusal", () => {
    // docs/10 §15: the bias is accepted and diagnosed, not hidden. With one free
    // slot and three eligible parents, the LOWEST slot must win and the other two
    // must both be counted.
    const world = createTestWorld({ configure: capTo(4) });
    const ctx = world.ctx;
    const parents: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const { xPos, yPos } = world.cellCenter(20 + i * 4, 20);
      parents.push(
        spawnTestOrganism(world, {
          xPos,
          yPos,
          ageTicks: MATURE_AGE,
          developmentQ: Q,
          energyFractionQ: Q,
        }),
      );
    }
    expect(parents).toEqual([0, 1, 2]);

    ctx.scratch.reproduceQ.fill(Q);
    resolveReproduction(ctx);

    expect(ctx.organisms.liveCount).toBe(4);
    expect(ctx.organisms.capRejectedBirths).toBe(2);
    expect(ctx.organisms.parentEntityId[3]).toBe(ctx.organisms.entityId[0]);
    expect(ctx.organisms.reproductionCooldown[0]).toBeGreaterThan(0);
    expect(ctx.organisms.reproductionCooldown[1]).toBe(0);
    expect(ctx.organisms.reproductionCooldown[2]).toBe(0);
  });
});
