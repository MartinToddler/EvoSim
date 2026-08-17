import { assert, type DeepReadonly } from "@eon/shared";
import type { SimulationConfig } from "../config/SimulationConfig";
import { Q, clamp, clampQ, qdiv, qmul } from "../math/fixed";
import { GenomeStore } from "../organisms/GenomeStore";
import { createFounderMorphGenes } from "./founderMorphGenome";
import { MorphologyStore, deriveMorphology } from "./morphDevelopment";
import { MORPH_GENE_COUNT, MORPH_GENE_RAW_MAX } from "./morphGenes";

/**
 * Functional morphology: the developed body as physics (M15, docs/11 §M15).
 *
 * ```text
 * MorphologyGenotype -> deriveMorphology -> MorphologyPhenotype   (M14: shape)
 *                                                ↓ this file
 *                                          PhysicalPhenotype      (M15: physics)
 *                                                ↓ derivePhenotype
 *                                          the numbers the tick reads
 * ```
 *
 * M14 gave every organism a body that is inherited, evolvable and drawn from
 * the genome. It had no consequence: two lineages could look nothing alike and
 * behave identically. M15 closes that gap in exactly one place — here — so the
 * picture and the physics cannot disagree. There is no second interpretation of
 * a body anywhere in the engine, and nothing downstream of this file reads a
 * morphological gene.
 *
 * ## Everything is relative to the founder body
 *
 * Every factor below is a Q multiplier that is **exactly 1.0 for the founder
 * morphology**. That is a deliberate choice with three consequences:
 *
 * - the calibrated MVP ecology is the physics of the founder body, so M15 does
 *   not silently re-tune a world that was measured over Milestones 0–13;
 * - a coefficient reads as "how much does *diverging* from the founder in this
 *   direction change this quantity", which is the only question selection asks;
 * - `validateConfig` can assert neutrality instead of assuming it.
 *
 * The reference is computed once per config from the founder genome itself, so
 * it cannot drift away from the body founders actually grow.
 *
 * ## Every benefit is costed (CLAUDE.md "Trade-off rule")
 *
 * No factor here is a free improvement. The costs are wired through quantities
 * the engine already bills:
 *
 * | Direction            | Buys                            | Pays with                                    |
 * | -------------------- | ------------------------------- | -------------------------------------------- |
 * | bulk (any structure) | reserves, bite size, carrion    | basal, movement, growth, attack fee, offspring |
 * | girth                | energy storage, bulk            | drag, water performance                      |
 * | slenderness          | water performance               | thermal tolerance                            |
 * | limb area            | thrust, turning, paddling, accel| bulk, upkeep, movement cost, construction    |
 * | limb rest angle      | thrust **or** turning           | the other one                                |
 * | segments             | turning                         | bulk                                         |
 * | plating              | armor value                     | mass, speed, upkeep, construction, offspring |
 * | mouth                | attack, bite size               | jaw upkeep, turning, bulk                    |
 * | head                 | attack                          | bulk, fore/aft span, so turning              |
 * | tail                 | thrust, water performance       | bulk, fore/aft span, so turning              |
 * | sensors              | vision range and arc            | vision upkeep, which is range²×arc           |
 * | sensor placement     | range **or** arc                | the other one                                |
 *
 * Two loci are pure allocation with no dominant setting — appendage rest angle
 * splits limb area between forward thrust and lateral control, and sensor
 * placement trades vision range against vision arc. A body cannot maximize both
 * halves of either. Nothing in the table is a pure cost either: a trait that can
 * only ever be a liability is driven to zero and stops carrying information,
 * which is the trade-off rule's failure mode read backwards.
 *
 * ## Physically neutral loci, and why
 *
 * Front taper, rear taper, tail taper, segment proportion, armor distribution,
 * appendage front bias, both pigment shifts, pigment contrast, pattern frequency
 * and pattern orientation have **no** physical effect. They are shaping and
 * colouring parameters: length and width already say how big a body is, and
 * assigning physics to taper would be inventing a mechanism the geometry does
 * not model. The pigment and pattern loci are deliberately left informational —
 * they are the substrate a later milestone builds visual signalling on, and
 * giving them a survival effect now would pre-decide what a colour means.
 */

/**
 * Normalized morphological expressions, all in `[0, Q]` except `bulkQ`.
 *
 * These are the *drivers*: each one is a scale-free statement about a body that
 * can be compared against the founder's. Keeping them separate from the factors
 * is what makes the physics auditable — every factor below is a sum of named
 * differences on this struct, and nothing else.
 */
export interface MorphologyExpressions {
  /**
   * Body bulk in Q multiples of the adult radius squared. NOT normalized: this
   * is an absolute area, and mass is the one quantity with an unambiguous
   * physical scale, so it is used as a ratio to the founder's bulk rather than
   * as a position in a range.
   */
  bulkQ: number;
  /** Body width against its configured range. */
  girthQ: number;
  /** Length-to-width ratio against the most slender body the config allows. */
  slendernessQ: number;
  /** Limb area as a share of total soft-tissue area. */
  propulsionQ: number;
  /** The share of limb area swept rearward: forward thrust. */
  sweptLimbQ: number;
  /** The share of limb area held laterally: turning authority. */
  lateralLimbQ: number;
  /** Segment count against its configured range. */
  segmentationQ: number;
  /** Tail length against its configured range. */
  tailQ: number;
  /** Plated share of the body: coverage × plate expression. */
  armorQ: number;
  /** Mouth size against its configured range. */
  mouthQ: number;
  /** Head proportion against its configured range. */
  headQ: number;
  /** Sensor size against its configured range. */
  sensorQ: number;
  /** Sensor placement: 0 fully lateral, Q fully forward. */
  forwardQ: number;
  /** Lateral silhouette against the widest body the config allows. */
  dragQ: number;
  /** Fore/aft silhouette against the longest body the config allows. */
  spanQ: number;
}

/** Scales the aggregate expressions are normalized against. */
interface MorphologyNormalizers {
  readonly maxSilhouetteWidthQ: number;
  readonly maxSilhouetteLengthQ: number;
  readonly maxAspectQ: number;
}

/**
 * The neutral point of the physics, derived once per config.
 *
 * `founder` is the expression vector of the body `createFounderMorphGenes`
 * grows; `normalizers` are the extreme values the config can express. Both are
 * pure functions of the config, so this is derived state on exactly the same
 * footing as `PhenotypeStore` and `MorphologyStore`: never hashed, never
 * serialized, rebuilt on restore.
 */
export interface MorphologyReference {
  readonly normalizers: MorphologyNormalizers;
  readonly founder: Readonly<MorphologyExpressions>;
}

/**
 * Physical phenotype cache, one entry per organism slot.
 *
 * Every field is a Q multiplier applied to a quantity the simulation already
 * had, so morphology cannot introduce a new mechanism — only re-weight the ones
 * the MVP measured. Derived, bounded, and neither hashed nor serialized.
 */
export class PhysicalPhenotypeStore {
  readonly capacity: number;

  /** Body mass multiplier: the whole body's area against the founder's. */
  readonly massFactorQ: Uint16Array;
  /** Maximum-energy multiplier: a stout body carries deeper reserves. */
  readonly energyStoreFactorQ: Uint16Array;
  /** Basal upkeep multiplier for maintained structure (limbs, plating, jaw). */
  readonly basalFactorQ: Uint16Array;
  /** Movement-cost multiplier: what the propulsive apparatus burns to push. */
  readonly movementCostFactorQ: Uint16Array;
  /** Energy-per-grown-mass multiplier: dense and complex tissue is dearer. */
  readonly growthCostFactorQ: Uint16Array;

  /** Top-speed multiplier: rearward limb area against drag and plating. */
  readonly maxSpeedFactorQ: Uint16Array;
  /** Acceleration multiplier: thrust against realized mass. */
  readonly accelFactorQ: Uint16Array;
  /** Turn-rate multiplier: segmentation and lateral limbs against length. */
  readonly turnFactorQ: Uint16Array;
  /** Multiplier on the water speed penalty: terrain performance. */
  readonly waterSpeedFactorQ: Uint16Array;

  /** Effective-armor multiplier from plate coverage and expression. */
  readonly armorFactorQ: Uint16Array;
  /** Attack-power multiplier from the feeding structure and head. */
  readonly attackFactorQ: Uint16Array;
  /** Bite-size multiplier from the feeding structure. */
  readonly biteFactorQ: Uint16Array;

  /** Vision-range multiplier from sensor size and forward placement. */
  readonly visionRangeFactorQ: Uint16Array;
  /** Field-of-view multiplier from sensor size and lateral placement. */
  readonly visionFovFactorQ: Uint16Array;

  /** Thermal-tolerance multiplier: compact bodies hold heat better. */
  readonly thermalToleranceFactorQ: Uint16Array;
  /** Contact-extent multiplier: the silhouette an organism actually occupies. */
  readonly collisionFactorQ: Uint16Array;
  /**
   * How well the body gets at buried food (M17), 1.0 at the founder.
   *
   * Limb investment, reused. Roots are the channel whose cost is excavation,
   * and the apparatus that excavates is the same apparatus M15 already bills
   * for movement — so a digging lineage pays the limb bill twice over, once to
   * carry the limbs and once to move them, and gets a channel nothing else can
   * reach in exchange. That is a trade rather than a bonus.
   *
   * It multiplies the bite, never gates it. A limbless body still takes roots,
   * slowly, because a channel nobody can enter without the right morphology is
   * a fitness valley with a resource behind it.
   */
  readonly digFactorQ: Uint16Array;
  /** Offspring construction overhead the parent pays on top of the investment. */
  readonly offspringCostFactorQ: Uint16Array;

  constructor(capacity: number) {
    assert(
      Number.isSafeInteger(capacity) && capacity > 0,
      `physical phenotype capacity must be positive, got ${capacity}`,
    );
    this.capacity = capacity;
    this.massFactorQ = new Uint16Array(capacity);
    this.energyStoreFactorQ = new Uint16Array(capacity);
    this.basalFactorQ = new Uint16Array(capacity);
    this.movementCostFactorQ = new Uint16Array(capacity);
    this.growthCostFactorQ = new Uint16Array(capacity);
    this.maxSpeedFactorQ = new Uint16Array(capacity);
    this.accelFactorQ = new Uint16Array(capacity);
    this.turnFactorQ = new Uint16Array(capacity);
    this.waterSpeedFactorQ = new Uint16Array(capacity);
    this.armorFactorQ = new Uint16Array(capacity);
    this.attackFactorQ = new Uint16Array(capacity);
    this.biteFactorQ = new Uint16Array(capacity);
    this.visionRangeFactorQ = new Uint16Array(capacity);
    this.visionFovFactorQ = new Uint16Array(capacity);
    this.thermalToleranceFactorQ = new Uint16Array(capacity);
    this.collisionFactorQ = new Uint16Array(capacity);
    this.digFactorQ = new Uint16Array(capacity);
    this.offspringCostFactorQ = new Uint16Array(capacity);
  }
}

/** Position of `value` inside `[min, max]`, in `[0, Q]`. */
function rangeExprQ(value: number, min: number, max: number): number {
  if (max <= min) {
    return 0;
  }
  return clampQ(Math.trunc(((value - min) * Q) / (max - min)));
}

/** `value / scale` in `[0, Q]`, with a guard for a degenerate scale. */
function shareExprQ(value: number, scale: number): number {
  if (scale <= 0) {
    return 0;
  }
  return clampQ(Math.trunc((value * Q) / scale));
}

/**
 * Reusable expression buffer.
 *
 * `derivePhysical` runs once per spawn and once per live slot on restore, never
 * inside the tick loop, but a per-call object would still be an allocation on a
 * path that runs thousands of times at world creation. The engine is
 * single-threaded and this value never escapes the call, so one shared buffer is
 * safe and matches how the spatial queries already return their results.
 */
const scratchExpressions: MorphologyExpressions = {
  bulkQ: 0,
  girthQ: 0,
  slendernessQ: 0,
  propulsionQ: 0,
  sweptLimbQ: 0,
  lateralLimbQ: 0,
  segmentationQ: 0,
  tailQ: 0,
  armorQ: 0,
  mouthQ: 0,
  headQ: 0,
  sensorQ: 0,
  forwardQ: 0,
  dragQ: 0,
  spanQ: 0,
};

/**
 * Measure one developed body.
 *
 * Areas are computed in Q multiples of the adult radius squared, the same units
 * `massScalePerRadiusSquared` already works in, so `bulkQ` is directly
 * comparable to the unit body the MVP's mass formula assumes.
 *
 * Exported for the tests and the inspector; `out` is written in place so the
 * caller decides whether anything is allocated.
 */
export function computeMorphologyExpressions(
  morphology: MorphologyStore,
  slot: number,
  reference: MorphologyReference,
  config: DeepReadonly<SimulationConfig>,
  out: MorphologyExpressions,
): void {
  measure(morphology, slot, reference.normalizers, config, out);
}

function measure(
  morphology: MorphologyStore,
  slot: number,
  normalizers: MorphologyNormalizers,
  config: DeepReadonly<SimulationConfig>,
  out: MorphologyExpressions,
): void {
  const m = config.organism.morphology;
  const p = config.organism.physicalMorphology;

  const lengthQ = morphology.bodyLengthQ[slot] as number;
  const widthQ = morphology.bodyWidthQ[slot] as number;
  const headProportionQ = morphology.headProportionQ[slot] as number;
  const tailLengthQ = morphology.tailLengthQ[slot] as number;
  const pairs = morphology.appendagePairs[slot] as number;
  const segments = morphology.segmentCount[slot] as number;

  // Soft tissue: trunk, head, tail and limbs, each as an area in radius² units.
  const trunkAreaQ = qmul(lengthQ, widthQ);
  const headAreaQ = qmul(qmul(lengthQ, headProportionQ), widthQ);
  const tailAreaQ = qmul(
    qmul(lengthQ, tailLengthQ),
    qmul(widthQ, morphology.tailWidthQ[slot] as number),
  );
  const limbLengthQ = qmul(widthQ >> 1, morphology.appendageLengthQ[slot] as number);
  const limbThicknessQ = qmul(limbLengthQ, morphology.appendageThicknessQ[slot] as number);
  const limbAreaQ = 2 * pairs * qmul(limbLengthQ, limbThicknessQ);
  const softTissueQ = trunkAreaQ + headAreaQ + tailAreaQ + limbAreaQ;

  // Dense tissue: plating over the trunk and head, and the jaw apparatus filling
  // its share of the head. Both are mass an organism carries without gaining any
  // soft tissue for it, which is why they are weighted up rather than counted
  // once. Segmentation adds structure on the same principle.
  const denseAreaQ =
    qmul(
      trunkAreaQ + headAreaQ,
      qmul(morphology.armorCoverageQ[slot] as number, morphology.plateExpressionQ[slot] as number),
    ) + qmul(headAreaQ, morphology.mouthSizeQ[slot] as number);
  const segmentStructureQ = Math.max(0, segments - 1) * qmul(trunkAreaQ, p.segmentStructureQ);

  out.bulkQ = softTissueQ + qmul(denseAreaQ, p.plateDensityQ) + segmentStructureQ;

  // Limb area is expressed as a SHARE of the body rather than as an absolute:
  // a paddle is only propulsive relative to what it has to push, so growing the
  // trunk dilutes the same limbs instead of leaving them equally effective.
  const propulsionQ = shareExprQ(limbAreaQ, softTissueQ);
  const sweepQ = rangeExprQ(
    morphology.appendageAngleSteps[slot] as number,
    m.appendageAngleMinSteps,
    m.appendageAngleMaxSteps,
  );
  out.propulsionQ = propulsionQ;
  out.sweptLimbQ = qmul(propulsionQ, sweepQ);
  out.lateralLimbQ = qmul(propulsionQ, Q - sweepQ);

  out.girthQ = rangeExprQ(widthQ, m.bodyWidthMinQ, m.bodyWidthMaxQ);
  out.slendernessQ = shareExprQ(morphology.aspectQ[slot] as number, normalizers.maxAspectQ);
  out.segmentationQ = rangeExprQ(segments, m.minSegments, m.maxSegments);
  out.tailQ = rangeExprQ(tailLengthQ, m.tailLengthMinQ, m.tailLengthMaxQ);
  out.armorQ = qmul(
    morphology.armorCoverageQ[slot] as number,
    morphology.plateExpressionQ[slot] as number,
  );
  out.mouthQ = rangeExprQ(morphology.mouthSizeQ[slot] as number, m.mouthSizeMinQ, m.mouthSizeMaxQ);
  out.headQ = rangeExprQ(headProportionQ, m.headProportionMinQ, m.headProportionMaxQ);
  out.sensorQ = rangeExprQ(
    morphology.sensorSizeQ[slot] as number,
    m.sensorSizeMinQ,
    m.sensorSizeMaxQ,
  );
  out.forwardQ = clampQ(morphology.sensorPlacementQ[slot] as number);
  out.dragQ = shareExprQ(
    morphology.silhouetteWidthQ[slot] as number,
    normalizers.maxSilhouetteWidthQ,
  );
  out.spanQ = shareExprQ(
    morphology.silhouetteLengthQ[slot] as number,
    normalizers.maxSilhouetteLengthQ,
  );
}

/** Fresh, zeroed expression buffer. Tests and the inspector; never the hot path. */
export function createMorphologyExpressions(): MorphologyExpressions {
  return { ...scratchExpressions };
}

/**
 * Build the physical reference for one config.
 *
 * Two synthetic bodies are developed through the ordinary interpreter: the
 * founder, which fixes the neutral point, and the all-maxima genome, which fixes
 * the normalizing scales. Deriving both rather than declaring them is what stops
 * the physics from disagreeing with the bodies the engine actually grows.
 *
 * The extreme genome really is the extreme for every quantity normalized against
 * it: silhouette length and width are monotone non-decreasing in every locus
 * that feeds them. Slenderness is the one exception — it is largest at maximum
 * length and *minimum* width — so its scale is taken from the config bounds
 * directly.
 */
export function createMorphologyReference(
  config: DeepReadonly<SimulationConfig>,
): MorphologyReference {
  const morphologyConfig = config.organism.morphology;
  const genomes = new GenomeStore(2);
  const morphology = new MorphologyStore(2);

  genomes.morphGenes.set(createFounderMorphGenes(morphologyConfig), genomes.morphOffset(0));
  genomes.morphGenes.fill(
    MORPH_GENE_RAW_MAX,
    genomes.morphOffset(1),
    genomes.morphOffset(1) + MORPH_GENE_COUNT,
  );
  // Hue is irrelevant to every physical quantity, so any value derives the same
  // reference; zero is used to make that independence obvious.
  deriveMorphology(morphology, genomes, 0, 0, config);
  deriveMorphology(morphology, genomes, 1, 0, config);

  const normalizers: MorphologyNormalizers = {
    maxSilhouetteWidthQ: Math.max(1, morphology.silhouetteWidthQ[1] as number),
    maxSilhouetteLengthQ: Math.max(1, morphology.silhouetteLengthQ[1] as number),
    maxAspectQ: Math.max(1, qdiv(morphologyConfig.bodyLengthMaxQ, morphologyConfig.bodyWidthMinQ)),
  };

  const founder = createMorphologyExpressions();
  measure(morphology, 0, normalizers, config, founder);
  return { normalizers, founder };
}

/**
 * Derive one slot's physical phenotype from its developed body.
 *
 * Pure in the same sense as `deriveMorphology`: the developed body, the
 * reference and the config, and nothing else. No world state, no position, no
 * tick, no PRNG — which is what makes the result safe to leave out of the state
 * hash and rebuild on restore.
 */
export function derivePhysical(
  physical: PhysicalPhenotypeStore,
  morphology: MorphologyStore,
  slot: number,
  reference: MorphologyReference,
  config: DeepReadonly<SimulationConfig>,
): void {
  const p = config.organism.physicalMorphology;
  const expressions = scratchExpressions;
  measure(morphology, slot, reference.normalizers, config, expressions);
  const founder = reference.founder;

  const lo = p.minFactorQ;
  const hi = p.maxFactorQ;

  // Differences from the founder body. Every factor below is a weighted sum of
  // these and nothing else, which is what makes the physics auditable.
  const dGirth = expressions.girthQ - founder.girthQ;
  const dSlenderness = expressions.slendernessQ - founder.slendernessQ;
  const dPropulsion = expressions.propulsionQ - founder.propulsionQ;
  const dSwept = expressions.sweptLimbQ - founder.sweptLimbQ;
  const dLateral = expressions.lateralLimbQ - founder.lateralLimbQ;
  const dSegmentation = expressions.segmentationQ - founder.segmentationQ;
  const dTail = expressions.tailQ - founder.tailQ;
  const dArmor = expressions.armorQ - founder.armorQ;
  const dMouth = expressions.mouthQ - founder.mouthQ;
  const dHead = expressions.headQ - founder.headQ;
  const dSensor = expressions.sensorQ - founder.sensorQ;
  const dForward = expressions.forwardQ - founder.forwardQ;
  const dDrag = expressions.dragQ - founder.dragQ;
  const dSpan = expressions.spanQ - founder.spanQ;

  // Mass is the one quantity with an unambiguous physical scale, so it is a
  // RATIO of areas rather than a position in a range. The gain damps how much
  // of that ratio reaches the simulation; the clamp is a hard ceiling where
  // extra bulk stops adding mass — and, because reserves and bite size are both
  // mass-driven, stops adding anything at all while still costing agility and
  // contact extent. A saturated body is a dead end, not a free lunch.
  const bulkRatioQ = qdiv(expressions.bulkQ, Math.max(1, founder.bulkQ));
  const massFactorQ = clamp(Q + qmul(p.massBulkGainQ, bulkRatioQ - Q), lo, hi);
  const dMass = massFactorQ - Q;
  physical.massFactorQ[slot] = massFactorQ;

  physical.energyStoreFactorQ[slot] = clamp(Q + qmul(p.storeGirthGainQ, dGirth), lo, hi);

  // Maintained structure: limbs, plating and jaw muscle. Sensors are absent on
  // purpose — their upkeep is billed through the vision cost, which already
  // scales as range² × arc, and billing them here as well would charge the same
  // tissue twice.
  physical.basalFactorQ[slot] = clamp(
    Q +
      qmul(p.basalLimbGainQ, dPropulsion) +
      qmul(p.basalArmorGainQ, dArmor) +
      qmul(p.basalMouthGainQ, dMouth),
    lo,
    hi,
  );

  // Locomotion is not free at the point of use. Basal upkeep bills the tissue
  // for existing; this bills it for pushing, which is what stops a large
  // propulsive apparatus from being worth having in a world with nowhere to go.
  physical.movementCostFactorQ[slot] = clamp(
    Q + qmul(p.movementLimbGainQ, dPropulsion) + qmul(p.movementDragGainQ, dDrag),
    lo,
    hi,
  );

  physical.growthCostFactorQ[slot] = clamp(
    Q + qmul(p.growthArmorGainQ, dArmor) + qmul(p.growthLimbGainQ, dPropulsion),
    lo,
    hi,
  );

  // Thrust comes from rearward-swept limbs and from an undulating tail; drag and
  // the dead weight of plating take it away.
  physical.maxSpeedFactorQ[slot] = clamp(
    Q +
      qmul(p.speedThrustGainQ, dSwept) +
      qmul(p.speedTailGainQ, dTail) -
      qmul(p.speedDragGainQ, dDrag) -
      qmul(p.speedArmorGainQ, dArmor),
    lo,
    hi,
  );

  physical.accelFactorQ[slot] = clamp(
    Q + qmul(p.accelThrustGainQ, dSwept) - qmul(p.accelMassGainQ, dMass),
    lo,
    hi,
  );

  // Yaw is resisted by the whole fore/aft extent — body, head and tail together,
  // which is exactly what the silhouette span measures — and by mass carried out
  // at the nose. A segmented body bends; laterally held limbs push against the
  // turn.
  physical.turnFactorQ[slot] = clamp(
    Q +
      qmul(p.turnSegmentGainQ, dSegmentation) +
      qmul(p.turnLateralGainQ, dLateral) -
      qmul(p.turnSpanGainQ, dSpan) -
      qmul(p.turnMouthGainQ, dMouth),
    lo,
    hi,
  );

  physical.waterSpeedFactorQ[slot] = clamp(
    Q +
      qmul(p.waterStreamlineGainQ, dSlenderness) +
      qmul(p.waterPaddleGainQ, dPropulsion) +
      qmul(p.waterTailGainQ, dTail) -
      qmul(p.waterGirthGainQ, dGirth),
    lo,
    hi,
  );

  physical.armorFactorQ[slot] = clamp(Q + qmul(p.armorPlateGainQ, dArmor), lo, hi);

  physical.attackFactorQ[slot] = clamp(
    Q + qmul(p.attackMouthGainQ, dMouth) + qmul(p.attackHeadGainQ, dHead),
    lo,
    hi,
  );

  physical.biteFactorQ[slot] = clamp(Q + qmul(p.biteMouthGainQ, dMouth), lo, hi);

  physical.visionRangeFactorQ[slot] = clamp(
    Q + qmul(p.visionRangeSensorGainQ, dSensor) + qmul(p.visionRangeForwardGainQ, dForward),
    lo,
    hi,
  );
  physical.visionFovFactorQ[slot] = clamp(
    Q + qmul(p.visionFovSensorGainQ, dSensor) - qmul(p.visionFovForwardGainQ, dForward),
    lo,
    hi,
  );

  // Surface area against volume: a slender body sheds heat faster, so the same
  // genetic tolerance covers a narrower band of temperatures.
  physical.thermalToleranceFactorQ[slot] = clamp(
    Q - qmul(p.thermalSlendernessGainQ, dSlenderness),
    lo,
    hi,
  );

  physical.collisionFactorQ[slot] = clamp(Q + qmul(p.collisionSilhouetteGainQ, dSpan), lo, hi);
  // M17. Driven by limb share against the founder's, like every other factor
  // here, so the founder digs at exactly 1.0 and neither gains nor loses.
  physical.digFactorQ[slot] = clamp(Q + qmul(p.digLimbGainQ, dPropulsion), lo, hi);

  // Construction OVERHEAD, and overhead cannot be negative. The parent pays
  // `investment x this factor` while the child receives `investment`, so a
  // factor below 1 would have the parent pay out less than the child receives —
  // a birth that creates energy, which is the one thing reproduction must never
  // do. The floor is Q rather than `lo` for that reason and no other: a body
  // plan simpler than the founder's builds without waste, not at a profit.
  //
  // Found by the twelve-seed sweep, which crashed on a negative
  // `birthEnergyDiscarded` (ADR 0029 §3f). The golden fixture's own seed never
  // produced a parent light enough to trip it.
  physical.offspringCostFactorQ[slot] = clamp(
    Q + qmul(p.offspringBulkGainQ, dMass) + qmul(p.offspringArmorGainQ, dArmor),
    Q,
    hi,
  );
}

/**
 * Contact extent in world sub-units: the body radius scaled by the silhouette
 * the organism actually occupies.
 *
 * Used for soft separation, combat reach and mouth range, so what an organism
 * bumps into, what it can hit and what it can eat all agree with what is drawn.
 */
export function contactRadiusPos(
  physical: PhysicalPhenotypeStore,
  slot: number,
  radiusPos: number,
): number {
  return qmul(radiusPos, physical.collisionFactorQ[slot] as number);
}
