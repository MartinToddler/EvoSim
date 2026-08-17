import type { EngineContext } from "../EngineContext";
import { GENE_COUNT } from "../genetics/genes";
import { mutateBrainWeights, mutateEcologicalGenes } from "../genetics/mutation";
import { ANGLE_STEPS, POS_SCALE, TRIG_SCALE, qmul } from "../math/fixed";
import { cosLut, sinLut } from "../math/trigLut";
import { bodyMass, currentRadiusPos, maxEnergyForOrganism } from "../organisms/phenotype";
import { MORPH_GENE_COUNT } from "../morphology/morphGenes";
import { mutateMorphologyGenes } from "../morphology/morphMutation";
import { mutateTopology } from "../brain/topologyMutation";
import { NEURAL_WEIGHT_COUNT, TOPOLOGY_WORD_COUNT } from "../brain/NeuralTopology";
import { spawnOrganism } from "../organisms/spawn";

/**
 * Asexual reproduction — phase 14 of the authoritative tick order
 * (docs/04 §19, docs/08 §16, docs/10 §15, tasks E01/E02/E05/E06).
 *
 * ## Two passes, and why
 *
 * Pass 1 collects every eligible parent in ascending slot order; pass 2 performs
 * the births. Splitting them makes "a newborn cannot itself reproduce on its
 * birth tick" structurally impossible rather than a condition to remember:
 * deaths are finalized in phase 13, so the free list is usually non-empty and a
 * child can land in a slot *below* the parent that produced it (docs/10 §14). A
 * single ascending pass would then walk into newborns and let one lineage
 * reproduce twice or more in the same tick.
 *
 * It also fixes the cap-rejection order. docs/10 §15 accepts that ascending
 * parent order biases access to the hard population cap, and requires the bias
 * to be diagnosed rather than hidden behind a shuffle.
 *
 * ## Energy cannot be created by a birth
 *
 * The parent pays `parentMaxEnergy × offspringInvestment` in full. The child
 * receives that amount clamped to *its own* maximum energy, which derives from
 * its birth mass (45% of adult radius by default) and is therefore far smaller
 * than the parent's.
 *
 * When the investment exceeds what a newborn body can hold, the surplus is
 * destroyed and counted in `OrganismStore.birthEnergyDiscarded`. That is the
 * conservative direction for the invariant — energy is never conjured — and it
 * is also the trade-off docs/07 §13 asks for: charging the parent only the
 * usable part would make every offspring-investment gene above the saturation
 * point free, and a free gene drifts to its maximum.
 *
 * ## PRNG draws per birth
 *
 * Two for placement (heading, then distance), then mutation's 416
 * classification draws plus its deltas — in that order. A birth refused by the
 * population cap draws NOTHING: capacity is checked before any draw, so the cap
 * is a pure gate and cannot shift the random stream of the organisms after it.
 */

/** Result of one placement search, in world sub-units. */
interface ChildPlacement {
  xPos: number;
  yPos: number;
  /** Heading the child is born facing: the direction it was placed in. */
  angle: number;
}

/**
 * Find a spawn point for a child (docs/08 §16).
 *
 * One heading and one distance are drawn. If that point is water or outside the
 * world, the search rotates through `spawnAngleCandidates` evenly spaced
 * headings from the drawn one, keeping the distance; if none is valid the child
 * is placed exactly on its parent, as docs/08 §16 prescribes.
 *
 * Rotating rather than redrawing keeps the draw count at two whatever the
 * terrain around the parent looks like. A variable count would be deterministic
 * too, but it would make one parent's local coastline shift the random stream of
 * every organism born after it in the same tick — a coupling that is impossible
 * to reason about later.
 */
function findChildPlacement(ctx: EngineContext, parentSlot: number): ChildPlacement {
  const { organisms, environment, config, rng } = ctx;
  const reproduction = config.reproduction;

  const parentX = organisms.x[parentSlot] as number;
  const parentY = organisms.y[parentSlot] as number;

  const baseAngle = rng.nextInt(ANGLE_STEPS);
  const minPos = reproduction.childSpawnDistanceMinLU * POS_SCALE;
  const maxPos = reproduction.childSpawnDistanceMaxLU * POS_SCALE;
  const distancePos = minPos + rng.nextInt(maxPos - minPos + 1);

  const worldMaxPos = config.world.sizeLU * POS_SCALE - 1;
  const candidates = reproduction.spawnAngleCandidates;
  const angleStep = Math.trunc(ANGLE_STEPS / candidates);

  for (let i = 0; i < candidates; i += 1) {
    const angle = (baseAngle + i * angleStep) & (ANGLE_STEPS - 1);
    const xPos = parentX + Math.trunc((distancePos * cosLut(angle)) / TRIG_SCALE);
    const yPos = parentY + Math.trunc((distancePos * sinLut(angle)) / TRIG_SCALE);
    if (xPos < 0 || yPos < 0 || xPos > worldMaxPos || yPos > worldMaxPos) {
      continue;
    }
    if (environment.isWaterCell(environment.cellIndexFromPosition(xPos, yPos))) {
      continue;
    }
    return { xPos, yPos, angle };
  }

  // Nowhere valid nearby. The child is born on top of its parent facing the
  // drawn heading, and soft collisions separate them next tick. A parent
  // standing in water therefore produces a child in water — that is ecology,
  // not a special case to patch around.
  return { xPos: parentX, yPos: parentY, angle: baseAngle };
}

/**
 * Maximum energy of a parent's body as it stands this tick.
 *
 * Every reproduction cost is a fraction of this, so it is computed once per
 * candidate from the same development value the physiology phase just used.
 */
function parentMaxEnergy(ctx: EngineContext, slot: number): number {
  const { organisms, phenotypes, physical, config } = ctx;
  const radius = currentRadiusPos(
    phenotypes.adultRadiusPos[slot] as number,
    organisms.developmentQ[slot] as number,
  );
  return maxEnergyForOrganism(
    physical,
    slot,
    bodyMass(physical, slot, radius, config.organism.massScalePerRadiusSquared),
    config,
  );
}

/** What one birth costs its parent (docs/04 §19, docs/08 §16, M15). */
export interface ReproductionCost {
  /** Energy handed to the child, before the newborn's own capacity clamp. */
  investment: number;
  /** What the parent actually spends: the investment plus construction overhead. */
  paid: number;
  /** Energy the parent must still hold afterwards. */
  reserve: number;
  /** Energy the parent needs before the birth: paid + reserve. */
  required: number;
}

/**
 * Compute the energy a parent must be holding to afford one birth.
 *
 * ## Building a complex body costs more than filling it (M15)
 *
 * The child receives `investment`; the parent pays `investment ×
 * offspringCostFactor`, and the difference is destroyed rather than banked. A
 * heavy, plated body plan is therefore dearer to reproduce than a light one at
 * the same offspring-investment gene — the trade-off that stops armor from
 * being paid for only in upkeep.
 *
 * The factor is the PARENT's, not the child's, for two reasons. The child's
 * genome is a mutated copy of the parent's, so the parent's body plan is what
 * the construction actually builds to within one mutation; and the cost has to
 * be knowable at the eligibility check, before a slot is allocated and before
 * any PRNG is drawn. Reading it from the child would make affordability depend
 * on a body that does not exist yet.
 */
export function reproductionEnergyCost(ctx: EngineContext, slot: number): ReproductionCost {
  const maxEnergy = parentMaxEnergy(ctx, slot);
  const investment = qmul(maxEnergy, ctx.phenotypes.offspringInvestmentQ[slot] as number);
  // `offspringCostFactorQ` is floored at Q by construction, so `paid` can never
  // fall below `investment` and a birth can never create energy. Asserted by
  // `birthNeverCreatesEnergy` in functionalMorphology.test.ts rather than left
  // to the reader of two files.
  const paid = qmul(investment, ctx.physical.offspringCostFactorQ[slot] as number);
  const reserve = qmul(maxEnergy, ctx.config.reproduction.minParentReserveFractionQ);
  return { investment, paid, reserve, required: paid + reserve };
}

/**
 * Whether one organism satisfies every hard reproduction condition
 * (docs/04 §19). Exported for the eligibility tests.
 *
 * The brain's reproduce output is a *request*, never a permission: an organism
 * whose controller demands offspring still cannot have any while immature,
 * underdeveloped, on cooldown or short of energy. That is what stops
 * "reproduce always" from being a winning genome on its own.
 */
export function canReproduce(ctx: EngineContext, slot: number): boolean {
  const { organisms, phenotypes, scratch, config } = ctx;

  if (organisms.alive[slot] !== 1) {
    return false;
  }
  if ((scratch.reproduceQ[slot] as number) < config.reproduction.reproduceOutputThresholdQ) {
    return false;
  }
  if ((organisms.reproductionCooldown[slot] as number) > 0) {
    return false;
  }
  if ((organisms.ageTicks[slot] as number) < (phenotypes.maturityAgeTicks[slot] as number)) {
    return false;
  }
  if ((organisms.developmentQ[slot] as number) < config.organism.reproductionMinDevelopmentQ) {
    return false;
  }
  return (organisms.energy[slot] as number) >= reproductionEnergyCost(ctx, slot).required;
}

/** Phase 14 — every eligible parent produces at most one child (docs/04 §19). */
export function resolveReproduction(ctx: EngineContext): void {
  const { organisms, genomes, scratch, config, rng } = ctx;

  // Pass 1: eligibility, decided against state that no birth has touched yet.
  scratch.resetReproducers();
  for (let slot = 0; slot < organisms.slotHighWater; slot += 1) {
    if (canReproduce(ctx, slot)) {
      scratch.noteReproducer(slot);
    }
  }

  // Pass 2: births, in ascending parent slot order (docs/10 §15).
  const cooldownTicks = config.reproduction.reproductionCooldownTicks;
  for (let i = 0; i < scratch.reproducerCount; i += 1) {
    const parentSlot = scratch.reproducers[i] as number;

    // Checked before any PRNG draw, so a capped world consumes no randomness.
    if (!organisms.canAllocate()) {
      organisms.capRejectedBirths += 1;
      continue;
    }

    const { investment, paid } = reproductionEnergyCost(ctx, parentSlot);
    const placement = findChildPlacement(ctx, parentSlot);

    // The child's genome is mutated in scratch BEFORE it is handed to the
    // spawner. Mutating in place after the spawn would be wrong, not merely
    // wasteful: the newborn's energy clamp and its whole phenotype would then be
    // derived from its parent's body rather than from the genome it actually
    // inherited, and a mutation of adultSize would silently disagree with the
    // energy the child was given.
    const geneBase = genomes.geneOffset(parentSlot);
    scratch.childGenes.set(genomes.genes.subarray(geneBase, geneBase + GENE_COUNT));
    // The whole weight block, not just the feed-forward part. The scratch buffer
    // is reused across every birth in the phase, so a partial copy would leave
    // the previous child's recurrent and memory weights in the tail and hand
    // them to this one — inheritance from an unrelated organism, through a
    // buffer that is neither hashed nor snapshotted.
    const weightBase = genomes.weightOffset(parentSlot);
    scratch.childBrainWeights.set(
      genomes.brainWeights.subarray(weightBase, weightBase + NEURAL_WEIGHT_COUNT),
    );
    const morphBase = genomes.morphOffset(parentSlot);
    scratch.childMorphGenes.set(
      genomes.morphGenes.subarray(morphBase, morphBase + MORPH_GENE_COUNT),
    );
    const topologyBase = genomes.topologyOffset(parentSlot);
    scratch.childTopology.set(
      genomes.topology.subarray(topologyBase, topologyBase + TOPOLOGY_WORD_COUNT),
    );
    // Ecology, then body, then network shape, then weights. The order fixes the
    // PRNG stream and is part of ENGINE_VERSION (M14 inserted the body block,
    // M16 the topology block).
    mutateEcologicalGenes(scratch.childGenes, 0, rng, config);
    mutateMorphologyGenes(scratch.childMorphGenes, 0, rng, config);
    mutateTopology(scratch.childTopology, 0, rng, config);
    mutateBrainWeights(scratch.childBrainWeights, 0, rng, config);

    const childSlot = spawnOrganism(ctx, {
      xPos: placement.xPos,
      yPos: placement.yPos,
      angle: placement.angle,
      genes: scratch.childGenes,
      morphGenes: scratch.childMorphGenes,
      topology: scratch.childTopology,
      brainWeights: scratch.childBrainWeights,
      generation: (organisms.generation[parentSlot] as number) + 1,
      parentEntityId: organisms.entityId[parentSlot] as number,
      // The child starts in its parent's species; species analysis may move it
      // later (docs/04 §19, docs/05 §7). Milestone 8 owns that.
      speciesId: organisms.speciesId[parentSlot] as number,
      energy: { kind: "absolute", units: investment },
    });
    // canAllocate() was true and nothing since could have consumed the slot.
    /* c8 ignore next 3 */
    if (childSlot < 0) {
      continue;
    }

    // The child was endowed with what its own newborn body can hold; the parent
    // pays the full investment plus its body plan's construction overhead either
    // way, and every unit of the difference is destroyed. Energy is never
    // created by a birth, and the overhead is a real cost rather than a transfer.
    organisms.birthEnergyDiscarded += paid - (organisms.energy[childSlot] as number);
    organisms.energy[parentSlot] = (organisms.energy[parentSlot] as number) - paid;
    organisms.reproductionCooldown[parentSlot] = cooldownTicks;
  }
}
