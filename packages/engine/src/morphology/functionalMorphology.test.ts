import { describe, expect, it } from "vitest";
import { buildCombatClaims, resolveCombatSimultaneously } from "../ecology/combatClaims";
import { buildFeedingClaims } from "../ecology/feedingClaims";
import { reproductionEnergyCost } from "../ecology/reproduction";
import { engineInternals } from "../internal";
import { POS_SCALE, Q } from "../math/fixed";
import { integrateMovement } from "../organisms/movement";
import { basalCost } from "../organisms/metabolism";
import { bodyMass, currentRadiusPos, maxEnergyForOrganism } from "../organisms/phenotype";
import { queryEntity } from "../render/queryEntity";
import {
  MORPH_CHANNEL_STRIDE,
  MorphChannelIndex,
  writeMorphChannels,
} from "../render/renderSnapshot";
import { SimulationEngine } from "../SimulationEngine";
import { cloneConfig } from "../config/cloneConfig";
import { DEFAULT_CONFIG } from "../config/defaultConfig";
import { createTestWorld, spawnTestOrganism, type TestWorld } from "../testing/harness";
import { Gene } from "../genetics/genes";
import { MorphGene } from "./morphGenes";

/**
 * M15 — what a body does to the organism wearing it (docs/11 §M15, ADR 0029).
 *
 * `physicalPhenotype.test.ts` holds the derivation; this file holds the claim
 * that the derivation reaches the simulation. Each test below picks one
 * quantity the tick actually bills and shows that two bodies differing in one
 * morphological locus are billed differently — through the ordinary phases,
 * not through a shortcut.
 */

const FIXTURE_SEED = 0xe0a12026;

/** Developed-body fields that fully determine the physics. */
const MORPH_FIELDS = [
  "bodyLengthQ",
  "bodyWidthQ",
  "aspectQ",
  "segmentCount",
  "appendagePairs",
  "appendageLengthQ",
  "appendageThicknessQ",
  "appendageAngleSteps",
  "headProportionQ",
  "mouthSizeQ",
  "sensorSizeQ",
  "sensorPlacementQ",
  "tailLengthQ",
  "tailWidthQ",
  "armorCoverageQ",
  "plateExpressionQ",
  "silhouetteLengthQ",
  "silhouetteWidthQ",
] as const;

/**
 * How far two identically-drawn bodies may differ in any factor.
 *
 * Four channels per expression x one byte of quantization each x the largest
 * summed gain on a single factor (movement cost, at 1.4). Derived rather than
 * chosen, so widening it means the wire genuinely stopped describing the body.
 */
const WIRE_ROUNDING_TOLERANCE_Q = Math.ceil((4 * Q * 1.4) / 255);

/** Physical factor rows, so a new one cannot slip past these comparisons. */
const FACTOR_FIELDS = [
  "massFactorQ",
  "energyStoreFactorQ",
  "basalFactorQ",
  "movementCostFactorQ",
  "growthCostFactorQ",
  "maxSpeedFactorQ",
  "accelFactorQ",
  "turnFactorQ",
  "waterSpeedFactorQ",
  "armorFactorQ",
  "attackFactorQ",
  "biteFactorQ",
  "visionRangeFactorQ",
  "visionFovFactorQ",
  "thermalToleranceFactorQ",
  "collisionFactorQ",
  "offspringCostFactorQ",
] as const;

function smallWorldConfig(): ReturnType<typeof cloneConfig> {
  const config = cloneConfig(DEFAULT_CONFIG);
  const gridSize = 64;
  config.world.envGridSize = gridSize;
  config.world.sizeLU = gridSize * config.world.envCellSizeLU;
  config.world.generation.edgeFalloffCells = Math.max(1, Math.floor(gridSize / 8));
  config.world.founderSpawnRadiusLU = Math.min(
    config.world.founderSpawnRadiusLU,
    config.world.sizeLU / 2,
  );
  config.world.initialOrganisms = 60;
  config.limits.maxOrganisms = 2048;
  config.limits.maxCarcasses = 1024;
  const areaRatio = (gridSize * gridSize) / (256 * 256);
  config.world.validity.minFounderRegionCells = Math.max(
    16,
    Math.floor(config.world.validity.minFounderRegionCells * areaRatio),
  );
  config.world.validity.minTotalPlantCapacity = Math.floor(
    config.world.validity.minTotalPlantCapacity * areaRatio,
  );
  return config;
}

/** A flat test world with no brain-driven motion, so a phase can be read alone. */
function flatWorld(temperatureCentiC = 1800): TestWorld {
  return createTestWorld({ gridSize: 32, temperatureCentiC, seed: 0x15c0 });
}

/** Current mass of one slot, through the same helper the phases use. */
function massOf(world: TestWorld, slot: number): number {
  const { ctx } = world;
  return bodyMass(
    ctx.physical,
    slot,
    currentRadiusPos(
      ctx.phenotypes.adultRadiusPos[slot] as number,
      ctx.organisms.developmentQ[slot] as number,
    ),
    ctx.config.organism.massScalePerRadiusSquared,
  );
}

describe("a body costs what it is (M15)", () => {
  it("a bulkier body weighs more and pays more basal upkeep for the same radius", () => {
    const world = flatWorld();
    const lean = spawnTestOrganism(world, {
      xPos: 400 * POS_SCALE,
      yPos: 400 * POS_SCALE,
      silentBrain: true,
      morphGenesQ: { [MorphGene.BodyLength]: 0, [MorphGene.BodyWidth]: 0 },
    });
    const bulky = spawnTestOrganism(world, {
      xPos: 440 * POS_SCALE,
      yPos: 400 * POS_SCALE,
      silentBrain: true,
      morphGenesQ: { [MorphGene.BodyLength]: Q, [MorphGene.BodyWidth]: Q },
    });

    // Same ecological genome, so the same adult radius: any difference is body.
    expect(world.ctx.phenotypes.adultRadiusPos[bulky]).toBe(
      world.ctx.phenotypes.adultRadiusPos[lean],
    );
    const leanMass = massOf(world, lean);
    const bulkyMass = massOf(world, bulky);
    expect(bulkyMass).toBeGreaterThan(leanMass);
    expect(basalCost(world.ctx, bulky, bulkyMass)).toBeGreaterThan(
      basalCost(world.ctx, lean, leanMass),
    );
    // And it is compensated: a bigger body holds more energy.
    expect(
      maxEnergyForOrganism(world.ctx.physical, bulky, bulkyMass, world.config),
    ).toBeGreaterThan(maxEnergyForOrganism(world.ctx.physical, lean, leanMass, world.config));
  });

  it("plating turns the same attack into less damage, and costs speed to wear", () => {
    const world = flatWorld();
    const attacker = spawnTestOrganism(world, {
      xPos: 400 * POS_SCALE,
      yPos: 400 * POS_SCALE,
      silentBrain: true,
      genesQ: { [Gene.AttackPower]: Q, [Gene.Armor]: Q >> 1 },
      weights: {},
    });
    const bare = spawnTestOrganism(world, {
      xPos: 401 * POS_SCALE,
      yPos: 400 * POS_SCALE,
      silentBrain: true,
      genesQ: { [Gene.Armor]: Q >> 1 },
      morphGenesQ: { [MorphGene.ArmorCoverage]: 0, [MorphGene.PlateExpression]: 0 },
    });
    const plated = spawnTestOrganism(world, {
      xPos: 402 * POS_SCALE,
      yPos: 400 * POS_SCALE,
      silentBrain: true,
      genesQ: { [Gene.Armor]: Q >> 1 },
      morphGenesQ: { [MorphGene.ArmorCoverage]: Q, [MorphGene.PlateExpression]: Q },
    });

    // Same armor GENE; the plating is what differs.
    expect(world.ctx.phenotypes.armorQ[plated] as number).toBeGreaterThan(
      world.ctx.phenotypes.armorQ[bare] as number,
    );
    // Bought with speed and upkeep, not for free.
    expect(world.ctx.phenotypes.maxSpeedVel[plated] as number).toBeLessThan(
      world.ctx.phenotypes.maxSpeedVel[bare] as number,
    );
    expect(world.ctx.phenotypes.basalMassCoeffQ[plated] as number).toBeGreaterThan(
      world.ctx.phenotypes.basalMassCoeffQ[bare] as number,
    );

    // And it survives a real attack better. The attacker swings at whatever is
    // in contact; each target is measured on its own tick so the attribution is
    // unambiguous.
    const damageTo = (target: number): number => {
      world.ctx.scratch.attackQ[attacker] = Q;
      world.ctx.organisms.attackCooldown[attacker] = 0;
      for (const slot of [bare, plated]) {
        world.ctx.organisms.alive[slot] = slot === target ? 1 : 0;
      }
      world.ctx.spatialPost.rebuild(world.ctx.organisms);
      buildCombatClaims(world.ctx);
      resolveCombatSimultaneously(world.ctx, 1);
      const taken = world.ctx.scratch.combatDamageQ[target] as number;
      world.ctx.organisms.healthQ[target] = Q;
      for (const slot of [bare, plated]) {
        world.ctx.organisms.alive[slot] = 1;
      }
      return taken;
    };
    const bareDamage = damageTo(bare);
    const platedDamage = damageTo(plated);
    expect(bareDamage).toBeGreaterThan(0);
    expect(platedDamage).toBeLessThan(bareDamage);
  });

  it("a bigger feeding structure takes a bigger bite, and pays for the jaw", () => {
    const world = flatWorld();
    const small = spawnTestOrganism(world, {
      xPos: 400 * POS_SCALE,
      yPos: 400 * POS_SCALE,
      silentBrain: true,
      morphGenesQ: { [MorphGene.MouthSize]: 0 },
    });
    const wide = spawnTestOrganism(world, {
      xPos: 460 * POS_SCALE,
      yPos: 460 * POS_SCALE,
      silentBrain: true,
      morphGenesQ: { [MorphGene.MouthSize]: Q },
    });

    world.ctx.scratch.eatQ[small] = Q;
    world.ctx.scratch.eatQ[wide] = Q;
    buildFeedingClaims(world.ctx);
    expect(world.ctx.scratch.feedingRequest[wide] as number).toBeGreaterThan(
      world.ctx.scratch.feedingRequest[small] as number,
    );
    // The jaw is maintained tissue and mass carried at the nose.
    expect(world.ctx.physical.basalFactorQ[wide] as number).toBeGreaterThan(
      world.ctx.physical.basalFactorQ[small] as number,
    );
    expect(world.ctx.phenotypes.maxTurnSteps[wide] as number).toBeLessThan(
      world.ctx.phenotypes.maxTurnSteps[small] as number,
    );
  });

  it("a body built for water covers more ground in water, at land speed unchanged", () => {
    const world = flatWorld();
    // Slender, long-tailed, well-limbed against short, broad and limbless.
    const swimmer = spawnTestOrganism(world, {
      xPos: 400 * POS_SCALE,
      yPos: 400 * POS_SCALE,
      silentBrain: true,
      morphGenesQ: {
        [MorphGene.BodyLength]: Q,
        [MorphGene.BodyWidth]: 0,
        [MorphGene.TailLength]: Q,
        [MorphGene.AppendageLength]: Q,
      },
    });
    const wader = spawnTestOrganism(world, {
      xPos: 460 * POS_SCALE,
      yPos: 460 * POS_SCALE,
      silentBrain: true,
      morphGenesQ: {
        [MorphGene.BodyLength]: 0,
        [MorphGene.BodyWidth]: Q,
        [MorphGene.TailLength]: 0,
        [MorphGene.AppendageLength]: 0,
      },
    });
    expect(world.ctx.physical.waterSpeedFactorQ[swimmer] as number).toBeGreaterThan(
      world.ctx.physical.waterSpeedFactorQ[wader] as number,
    );

    // Put both in water at the same velocity and step the movement phase once.
    world.makeWater(25, 25);
    const { xPos, yPos } = world.cellCenter(25, 25);
    const distanceIn = (slot: number, other: number): number => {
      const { organisms } = world.ctx;
      organisms.alive[other] = 0;
      organisms.x[slot] = xPos;
      organisms.y[slot] = yPos;
      organisms.angle[slot] = 0;
      organisms.vx[slot] = 0;
      organisms.vy[slot] = 0;
      organisms.posFracX[slot] = 0;
      organisms.posFracY[slot] = 0;
      world.ctx.scratch.throttleQ[slot] = Q;
      world.ctx.scratch.turnQ[slot] = 0;
      for (let tick = 0; tick < 64; tick += 1) {
        integrateMovement(world.ctx);
        world.ctx.scratch.throttleQ[slot] = Q;
      }
      const travelled = organisms.x[slot] - xPos;
      organisms.alive[other] = 1;
      return travelled;
    };
    const swimmerDistance = distanceIn(swimmer, wader);
    const waderDistance = distanceIn(wader, swimmer);
    expect(swimmerDistance).toBeGreaterThan(0);
    expect(swimmerDistance).toBeGreaterThan(waderDistance);
  });

  it("a costlier body plan makes a birth dearer without giving the child more", () => {
    const world = flatWorld();
    const plain = spawnTestOrganism(world, {
      xPos: 400 * POS_SCALE,
      yPos: 400 * POS_SCALE,
      silentBrain: true,
      developmentQ: Q,
      ageTicks: 5_000,
      morphGenesQ: { [MorphGene.ArmorCoverage]: 0, [MorphGene.PlateExpression]: 0 },
    });
    const armored = spawnTestOrganism(world, {
      xPos: 460 * POS_SCALE,
      yPos: 460 * POS_SCALE,
      silentBrain: true,
      developmentQ: Q,
      ageTicks: 5_000,
      morphGenesQ: { [MorphGene.ArmorCoverage]: Q, [MorphGene.PlateExpression]: Q },
    });

    const plainCost = reproductionEnergyCost(world.ctx, plain);
    const armoredCost = reproductionEnergyCost(world.ctx, armored);
    // Per unit handed to the child, the armored parent spends strictly more.
    // Stated as a ratio because the founder body is not literally unplated —
    // it carries 1% coverage — so the unplated body sits a hair BELOW neutral
    // and an equality against its own investment would be asserting the wrong
    // thing.
    expect(armoredCost.paid).toBeGreaterThan(armoredCost.investment);
    expect(plainCost.paid).toBeLessThanOrEqual(plainCost.investment);
    expect(armoredCost.paid / armoredCost.investment).toBeGreaterThan(
      plainCost.paid / plainCost.investment,
    );
  });

  it("a birth never creates energy, whatever body plan the parent has", () => {
    // The invariant that caught a real defect: `offspringCostFactorQ` is an
    // overhead multiplier applied to what the PARENT pays while the child
    // receives the unmultiplied investment, so a factor below 1 would hand the
    // child more than the parent gave up. The twelve-seed sweep found it as a
    // negative `birthEnergyDiscarded`; this pins it at the source.
    const world = flatWorld();
    const plans: Partial<Record<MorphGene, number>>[] = [
      {},
      { [MorphGene.BodyLength]: 0, [MorphGene.BodyWidth]: 0 },
      { [MorphGene.BodyLength]: Q, [MorphGene.BodyWidth]: Q },
      { [MorphGene.ArmorCoverage]: 0, [MorphGene.PlateExpression]: 0 },
      { [MorphGene.ArmorCoverage]: Q, [MorphGene.PlateExpression]: Q },
      { [MorphGene.AppendageLength]: 0, [MorphGene.TailLength]: 0 },
    ];
    plans.forEach((morphGenesQ, index) => {
      const slot = spawnTestOrganism(world, {
        xPos: (300 + index * 40) * POS_SCALE,
        yPos: 300 * POS_SCALE,
        silentBrain: true,
        developmentQ: Q,
        ageTicks: 5_000,
        morphGenesQ,
      });
      const cost = reproductionEnergyCost(world.ctx, slot);
      expect(world.ctx.physical.offspringCostFactorQ[slot] as number).toBeGreaterThanOrEqual(Q);
      expect(cost.paid).toBeGreaterThanOrEqual(cost.investment);
    });
  });

  it("an evolved world never runs its discarded-energy counter backwards", () => {
    // The end-to-end form of the same invariant, through real births.
    const engine = new SimulationEngine({ seed: FIXTURE_SEED, config: smallWorldConfig() });
    let previous = 0;
    for (let step = 0; step < 12; step += 1) {
      engine.stepMany(250);
      const discarded = engine.organisms.birthEnergyDiscarded;
      expect(discarded).toBeGreaterThanOrEqual(previous);
      previous = discarded;
    }
    expect(engine.organisms.totalBirths).toBeGreaterThan(0);
  });
});

describe("the picture and the physics are the same thing (M15)", () => {
  it("the same developed body always produces the same physics", () => {
    const engine = new SimulationEngine({ seed: FIXTURE_SEED, config: smallWorldConfig() });
    engine.stepMany(3_000);
    const { context } = engineInternals(engine);
    const { organisms, morphology, physical } = context;

    // Group live organisms by the DEVELOPED body — the thing both the drawing
    // and the physics are computed from — and require the physics to agree
    // inside every group. This is the property that makes one interpretation of
    // a body the only interpretation.
    const byBody = new Map<string, number>();
    let compared = 0;
    for (let slot = 0; slot < organisms.slotHighWater; slot += 1) {
      if (organisms.alive[slot] !== 1) {
        continue;
      }
      const key = MORPH_FIELDS.map((field) => morphology[field][slot] as number).join(",");
      const first = byBody.get(key);
      if (first === undefined) {
        byBody.set(key, slot);
        continue;
      }
      compared += 1;
      for (const factor of FACTOR_FIELDS) {
        expect(physical[factor][slot]).toBe(physical[factor][first]);
      }
    }
    // The founders alone guarantee this is not a vacuous pass.
    expect(compared).toBeGreaterThan(0);
  });

  it("bodies that draw identically differ physically by only a rounding error", () => {
    // The render wire carries one byte per channel, so the drawing is a LOSSY
    // projection of the developed body while the physics reads it at full
    // precision. That is the honest limit of "what you see is what it is": two
    // organisms can round to the same picture, and when they do their physics
    // agrees to within the resolution the picture had to give up.
    //
    // The tolerance is derived rather than guessed. A factor is a weighted sum
    // of expressions; each expression is built from up to four channels, each
    // carrying up to one byte of quantization error (Q/255); and the largest
    // summed gain on any one factor is `movementLimb + movementDrag` = 1.4. So
    // the bound is 4 x (Q/255) x 1.4, rounded up. Measured worst case at the
    // time of writing: 43. If this needs widening, the wire has stopped
    // describing the body and the renderer is drawing something else.
    const engine = new SimulationEngine({ seed: FIXTURE_SEED, config: smallWorldConfig() });
    engine.stepMany(3_000);
    const { context } = engineInternals(engine);
    const { organisms, morphology, physical } = context;

    const byPicture = new Map<string, number>();
    const channels = new Uint8Array(MORPH_CHANNEL_STRIDE);
    let compared = 0;
    let worst = 0;
    for (let slot = 0; slot < organisms.slotHighWater; slot += 1) {
      if (organisms.alive[slot] !== 1) {
        continue;
      }
      writeMorphChannels(morphology, slot, channels, 0);
      const key = channels.join(",");
      const first = byPicture.get(key);
      if (first === undefined) {
        byPicture.set(key, slot);
        continue;
      }
      compared += 1;
      for (const factor of FACTOR_FIELDS) {
        const delta = Math.abs(
          (physical[factor][slot] as number) - (physical[factor][first] as number),
        );
        worst = Math.max(worst, delta);
      }
    }
    expect(compared).toBeGreaterThan(0);
    expect(worst).toBeLessThanOrEqual(WIRE_ROUNDING_TOLERANCE_Q);
  });

  it("a body drawn bigger is a body that weighs more", () => {
    // The direction of the correspondence, which is what a viewer actually
    // reads off the screen. Grouped by the drawn body-size bytes and compared
    // between the extremes of the live population, so it is a statement about
    // the projection rather than about any one organism.
    const engine = new SimulationEngine({ seed: FIXTURE_SEED, config: smallWorldConfig() });
    engine.stepMany(4_000);
    const { context } = engineInternals(engine);
    const { organisms, morphology, physical } = context;

    const rows: { drawnArea: number; massFactorQ: number }[] = [];
    const channels = new Uint8Array(MORPH_CHANNEL_STRIDE);
    for (let slot = 0; slot < organisms.slotHighWater; slot += 1) {
      if (organisms.alive[slot] !== 1) {
        continue;
      }
      writeMorphChannels(morphology, slot, channels, 0);
      rows.push({
        drawnArea:
          (channels[MorphChannelIndex.BodyLength] as number) *
          (channels[MorphChannelIndex.BodyWidth] as number),
        massFactorQ: physical.massFactorQ[slot] as number,
      });
    }
    expect(rows.length).toBeGreaterThan(50);
    rows.sort((a, b) => a.drawnArea - b.drawnArea);
    const decile = Math.max(1, Math.floor(rows.length / 10));
    const mean = (from: number, to: number): number => {
      let total = 0;
      for (let i = from; i < to; i += 1) {
        total += (rows[i] as { massFactorQ: number }).massFactorQ;
      }
      return total / (to - from);
    };
    expect(mean(rows.length - decile, rows.length)).toBeGreaterThan(mean(0, decile));
  });

  it("bodies that draw differently are, in an evolved world, physically different", () => {
    const engine = new SimulationEngine({ seed: FIXTURE_SEED, config: smallWorldConfig() });
    engine.stepMany(4_000);
    const { context } = engineInternals(engine);
    const { organisms, morphology, physical } = context;

    const pictures = new Set<string>();
    const physics = new Set<string>();
    const channels = new Uint8Array(MORPH_CHANNEL_STRIDE);
    for (let slot = 0; slot < organisms.slotHighWater; slot += 1) {
      if (organisms.alive[slot] !== 1) {
        continue;
      }
      writeMorphChannels(morphology, slot, channels, 0);
      pictures.add(channels.join(","));
      physics.add(
        [
          physical.massFactorQ[slot],
          physical.maxSpeedFactorQ[slot],
          physical.turnFactorQ[slot],
          physical.basalFactorQ[slot],
        ].join(","),
      );
    }
    expect(pictures.size).toBeGreaterThan(1);
    // Distinct pictures produce distinct physics for most of the population.
    // Not all: quantization means two nearly identical bodies can round to the
    // same factors, which is the honest limit of a Uint16 multiplier.
    expect(physics.size).toBeGreaterThan(1);
    expect(physics.size * 2).toBeGreaterThan(pictures.size);
  });
});

describe("morphology reaches the simulation (M15)", () => {
  it("two worlds differing only in the founder body run different histories", () => {
    const config = smallWorldConfig();
    const other = cloneConfig(config);
    // Move one morphological RANGE, so the founder gene means a different body
    // while every ecological gene, every brain weight and every PRNG draw is
    // identical. Any divergence is morphology having consequences.
    other.organism.morphology.bodyWidthMaxQ = 5000;

    const a = new SimulationEngine({ seed: FIXTURE_SEED, config });
    const b = new SimulationEngine({ seed: FIXTURE_SEED, config: other });
    a.stepMany(2_000);
    b.stepMany(2_000);
    expect(b.organisms.liveCount).toBeGreaterThan(0);
    expect(b.computeStateHash()).not.toBe(a.computeStateHash());
  });

  it("the physical phenotype is derived, so a restore rebuilds it exactly", () => {
    const engine = new SimulationEngine({ seed: FIXTURE_SEED, config: smallWorldConfig() });
    engine.stepMany(800);
    const restored = SimulationEngine.fromSnapshot(engine.serialize());
    expect(restored.computeStateHash()).toBe(engine.computeStateHash());

    const live = engineInternals(engine).context;
    const back = engineInternals(restored).context;
    let checked = 0;
    for (let slot = 0; slot < engine.organisms.slotHighWater; slot += 1) {
      if (engine.organisms.alive[slot] !== 1) {
        continue;
      }
      checked += 1;
      expect(back.physical.massFactorQ[slot]).toBe(live.physical.massFactorQ[slot]);
      expect(back.physical.maxSpeedFactorQ[slot]).toBe(live.physical.maxSpeedFactorQ[slot]);
      expect(back.physical.armorFactorQ[slot]).toBe(live.physical.armorFactorQ[slot]);
      expect(back.physical.offspringCostFactorQ[slot]).toBe(
        live.physical.offspringCostFactorQ[slot],
      );
      // And the phenotype it feeds.
      expect(back.phenotypes.maxSpeedVel[slot]).toBe(live.phenotypes.maxSpeedVel[slot]);
      expect(back.phenotypes.armorQ[slot]).toBe(live.phenotypes.armorQ[slot]);
      expect(back.phenotypes.visionRangePos[slot]).toBe(live.phenotypes.visionRangePos[slot]);
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("the inspector reports the body plan the engine is using", () => {
    const engine = new SimulationEngine({ seed: FIXTURE_SEED, config: smallWorldConfig() });
    engine.stepMany(2_500);
    const { context } = engineInternals(engine);

    let inspected = 0;
    for (let slot = 0; slot < engine.organisms.slotHighWater && inspected < 25; slot += 1) {
      if (engine.organisms.alive[slot] !== 1) {
        continue;
      }
      inspected += 1;
      const details = queryEntity(engine, engine.organisms.entityId[slot] as number);
      expect(details).not.toBeNull();
      const physical = details?.physical;
      expect(physical?.mass).toBeCloseTo((context.physical.massFactorQ[slot] as number) / Q, 10);
      expect(physical?.armor).toBeCloseTo((context.physical.armorFactorQ[slot] as number) / Q, 10);
      expect(physical?.maxSpeed).toBeCloseTo(
        (context.physical.maxSpeedFactorQ[slot] as number) / Q,
        10,
      );
      expect(physical?.offspringCost).toBeCloseTo(
        (context.physical.offspringCostFactorQ[slot] as number) / Q,
        10,
      );
      // Every field is present and physically meaningful.
      for (const value of Object.values(physical ?? {})) {
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBeGreaterThan(0);
      }
    }
    expect(inspected).toBeGreaterThan(0);
  });

  it("an evolved population is not all one body", () => {
    // Morphology having consequences must not collapse the population onto one
    // body plan within a few thousand ticks — that would be a dominant strategy
    // hiding in the coefficients.
    const engine = new SimulationEngine({ seed: FIXTURE_SEED, config: smallWorldConfig() });
    engine.stepMany(4_000);
    const { context } = engineInternals(engine);

    let count = 0;
    let sum = 0;
    let min = Number.POSITIVE_INFINITY;
    let max = 0;
    for (let slot = 0; slot < engine.organisms.slotHighWater; slot += 1) {
      if (engine.organisms.alive[slot] !== 1) {
        continue;
      }
      const value = context.physical.massFactorQ[slot] as number;
      count += 1;
      sum += value;
      min = Math.min(min, value);
      max = Math.max(max, value);
    }
    expect(count).toBeGreaterThan(50);
    // A live spread of body masses, not a single winner.
    expect(max - min).toBeGreaterThan(Q / 100);
    // And the mean has not run away to an extreme.
    expect(sum / count).toBeGreaterThan(Q / 2);
    expect(sum / count).toBeLessThan(2 * Q);
  });
});
