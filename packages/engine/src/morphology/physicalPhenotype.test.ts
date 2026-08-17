import { describe, expect, it } from "vitest";
import { cloneConfig } from "../config/cloneConfig";
import { DEFAULT_CONFIG } from "../config/defaultConfig";
import { ConfigValidationError, validateConfig } from "../config/validateConfig";
import { Q } from "../math/fixed";
import { GenomeStore } from "../organisms/GenomeStore";
import { Xoshiro128 } from "../random/Xoshiro128";
import { createFounderMorphGenes } from "./founderMorphGenome";
import { MorphologyStore, deriveMorphology } from "./morphDevelopment";
import { MORPH_GENE_COUNT, MORPH_GENE_RAW_MAX, MorphGene } from "./morphGenes";
import {
  PhysicalPhenotypeStore,
  computeMorphologyExpressions,
  createMorphologyExpressions,
  createMorphologyReference,
  derivePhysical,
  type MorphologyExpressions,
} from "./physicalPhenotype";

/**
 * M15 — the developed body as physics (docs/11 §M15, ADR 0029).
 *
 * These tests exist to hold three claims that the rest of the engine assumes and
 * cannot check for itself: the founder body is exactly neutral, no factor can
 * leave its bounds, and no direction in morphology space is free.
 */

/** Every factor row on the store, so a new one cannot be added untested. */
const FACTOR_KEYS = [
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

type FactorKey = (typeof FACTOR_KEYS)[number];

const REFERENCE = createMorphologyReference(DEFAULT_CONFIG);

/** Develop and measure a set of morphological genomes in one go. */
function physicsOf(genomes: readonly Uint16Array[]): PhysicalPhenotypeStore {
  const store = new GenomeStore(Math.max(1, genomes.length));
  const morphology = new MorphologyStore(Math.max(1, genomes.length));
  const physical = new PhysicalPhenotypeStore(Math.max(1, genomes.length));
  for (let slot = 0; slot < genomes.length; slot += 1) {
    store.morphGenes.set(genomes[slot] as Uint16Array, store.morphOffset(slot));
    deriveMorphology(morphology, store, slot, 120, DEFAULT_CONFIG);
    derivePhysical(physical, morphology, slot, REFERENCE, DEFAULT_CONFIG);
  }
  return physical;
}

function founderGenes(): Uint16Array {
  return createFounderMorphGenes(DEFAULT_CONFIG.organism.morphology);
}

/** The founder body with one locus moved to `valueRaw`. */
function founderWith(gene: MorphGene, valueRaw: number): Uint16Array {
  const genes = founderGenes();
  genes[gene] = valueRaw;
  return genes;
}

function factorsAt(physical: PhysicalPhenotypeStore, slot: number): Record<FactorKey, number> {
  const out = {} as Record<FactorKey, number>;
  for (const key of FACTOR_KEYS) {
    out[key] = physical[key][slot] as number;
  }
  return out;
}

describe("the founder body is the neutral point (M15)", () => {
  it("every factor is exactly 1.0 for the founder morphology", () => {
    const physical = physicsOf([founderGenes()]);
    for (const key of FACTOR_KEYS) {
      expect(`${key}=${physical[key][0] as number}`).toBe(`${key}=${Q}`);
    }
  });

  it("neutrality survives a change to the founder body, because it is derived", () => {
    // The reference is computed from `createFounderMorphGenes`, not written
    // down, so a future milestone that reshapes the founder cannot silently
    // leave the physics centred on a body nothing grows. Simulated here by
    // shifting the ranges the founder genes are interpreted through.
    const config = cloneConfig(DEFAULT_CONFIG);
    config.organism.morphology.bodyLengthMinQ = 2048;
    config.organism.morphology.bodyLengthMaxQ = 12288;
    config.organism.morphology.tailLengthMaxQ = 2048;
    validateConfig(config);

    const reference = createMorphologyReference(config);
    const genomes = new GenomeStore(1);
    const morphology = new MorphologyStore(1);
    const physical = new PhysicalPhenotypeStore(1);
    genomes.morphGenes.set(createFounderMorphGenes(config.organism.morphology), 0);
    deriveMorphology(morphology, genomes, 0, 120, config);
    derivePhysical(physical, morphology, 0, reference, config);
    for (const key of FACTOR_KEYS) {
      expect(`${key}=${physical[key][0] as number}`).toBe(`${key}=${Q}`);
    }
  });
});

describe("derivation is pure and bounded (M15)", () => {
  it("the same genome always produces the same physics", () => {
    const rng = Xoshiro128.fromSeed(0x15a1);
    for (let trial = 0; trial < 64; trial += 1) {
      const genes = new Uint16Array(MORPH_GENE_COUNT);
      for (let i = 0; i < MORPH_GENE_COUNT; i += 1) {
        genes[i] = rng.nextInt(MORPH_GENE_RAW_MAX + 1);
      }
      const first = physicsOf([genes]);
      const second = physicsOf([genes]);
      expect(factorsAt(second, 0)).toEqual(factorsAt(first, 0));
    }
  });

  it("no factor leaves its configured bounds over the whole genome space", () => {
    const p = DEFAULT_CONFIG.organism.physicalMorphology;
    const rng = Xoshiro128.fromSeed(0x15a2);
    const genomes: Uint16Array[] = [
      founderGenes(),
      new Uint16Array(MORPH_GENE_COUNT).fill(0),
      new Uint16Array(MORPH_GENE_COUNT).fill(MORPH_GENE_RAW_MAX),
    ];
    for (let trial = 0; trial < 2_000; trial += 1) {
      const genes = new Uint16Array(MORPH_GENE_COUNT);
      for (let i = 0; i < MORPH_GENE_COUNT; i += 1) {
        genes[i] = rng.nextInt(MORPH_GENE_RAW_MAX + 1);
      }
      genomes.push(genes);
    }
    const physical = physicsOf(genomes);
    for (let slot = 0; slot < genomes.length; slot += 1) {
      for (const key of FACTOR_KEYS) {
        const value = physical[key][slot] as number;
        expect(`${key}@${slot}>=${p.minFactorQ}: ${value}`).toBe(`${key}@${slot}>=819: ${value}`);
        expect(value).toBeGreaterThanOrEqual(p.minFactorQ);
        expect(value).toBeLessThanOrEqual(p.maxFactorQ);
      }
    }
  });

  it("the clamps are a backstop, not part of the working physics", () => {
    // Every factor that a random body can reach stays strictly inside the
    // clamps for DEFAULT_CONFIG. If this starts failing, the config has grown a
    // coefficient that relies on saturation to stay sane — which reads to
    // selection as a region where extra investment is free.
    const p = DEFAULT_CONFIG.organism.physicalMorphology;
    const rng = Xoshiro128.fromSeed(0x15a3);
    const genomes: Uint16Array[] = [
      new Uint16Array(MORPH_GENE_COUNT).fill(0),
      new Uint16Array(MORPH_GENE_COUNT).fill(MORPH_GENE_RAW_MAX),
    ];
    for (let trial = 0; trial < 2_000; trial += 1) {
      const genes = new Uint16Array(MORPH_GENE_COUNT);
      for (let i = 0; i < MORPH_GENE_COUNT; i += 1) {
        genes[i] = rng.nextInt(MORPH_GENE_RAW_MAX + 1);
      }
      genomes.push(genes);
    }
    const physical = physicsOf(genomes);
    for (let slot = 0; slot < genomes.length; slot += 1) {
      for (const key of FACTOR_KEYS) {
        const value = physical[key][slot] as number;
        expect(`${key} at floor`).toBe(value === p.minFactorQ ? "never" : `${key} at floor`);
        expect(`${key} at ceiling`).toBe(value === p.maxFactorQ ? "never" : `${key} at ceiling`);
      }
    }
  });

  it("every normalized expression stays inside [0, Q]", () => {
    // The aggregate expressions are normalized against the all-maxima genome,
    // which is only the true maximum if each aggregate is monotone in every
    // locus that feeds it. This is what would catch that assumption breaking.
    const rng = Xoshiro128.fromSeed(0x15a4);
    const genomes = new GenomeStore(1);
    const morphology = new MorphologyStore(1);
    const expressions = createMorphologyExpressions();
    const normalized: (keyof MorphologyExpressions)[] = [
      "girthQ",
      "slendernessQ",
      "propulsionQ",
      "sweptLimbQ",
      "lateralLimbQ",
      "segmentationQ",
      "tailQ",
      "armorQ",
      "mouthQ",
      "headQ",
      "sensorQ",
      "forwardQ",
      "dragQ",
      "spanQ",
    ];
    for (let trial = 0; trial < 4_000; trial += 1) {
      for (let i = 0; i < MORPH_GENE_COUNT; i += 1) {
        genomes.morphGenes[i] = rng.nextInt(MORPH_GENE_RAW_MAX + 1);
      }
      deriveMorphology(morphology, genomes, 0, 0, DEFAULT_CONFIG);
      computeMorphologyExpressions(morphology, 0, REFERENCE, DEFAULT_CONFIG, expressions);
      for (const key of normalized) {
        const value = expressions[key];
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(Q);
      }
      expect(expressions.bulkQ).toBeGreaterThan(0);
    }
  });
});

describe("no morphological benefit is free (M15, CLAUDE.md trade-off rule)", () => {
  /**
   * One evolutionary direction, and what it must buy and pay.
   *
   * Written against the founder body with a single locus moved, so each row is
   * a statement about one gene rather than about a whole body plan. Both lists
   * must be non-empty: a direction with no benefit is driven to zero and stops
   * carrying information, exactly as a direction with no cost fixates.
   */
  const DIRECTIONS: readonly {
    name: string;
    genes: readonly [MorphGene, number][];
    buys: readonly FactorKey[];
    pays: readonly FactorKey[];
  }[] = [
    {
      name: "plating",
      genes: [
        [MorphGene.ArmorCoverage, MORPH_GENE_RAW_MAX],
        [MorphGene.PlateExpression, MORPH_GENE_RAW_MAX],
      ],
      buys: ["armorFactorQ"],
      pays: [
        "maxSpeedFactorQ",
        "accelFactorQ",
        "basalFactorQ",
        "growthCostFactorQ",
        "offspringCostFactorQ",
        "massFactorQ",
      ],
    },
    {
      name: "a bigger body",
      genes: [
        [MorphGene.BodyLength, MORPH_GENE_RAW_MAX],
        [MorphGene.BodyWidth, MORPH_GENE_RAW_MAX],
      ],
      buys: ["massFactorQ", "energyStoreFactorQ"],
      pays: ["accelFactorQ", "maxSpeedFactorQ", "turnFactorQ", "offspringCostFactorQ"],
    },
    {
      // Limb area is propulsive at any rest angle, so it buys movement on every
      // axis; what it costs is the tissue itself — carried, maintained and
      // built — plus the lateral silhouette it drags through the world.
      name: "longer limbs",
      genes: [
        [MorphGene.AppendageLength, MORPH_GENE_RAW_MAX],
        [MorphGene.AppendageThickness, MORPH_GENE_RAW_MAX],
      ],
      buys: ["waterSpeedFactorQ", "turnFactorQ", "maxSpeedFactorQ", "accelFactorQ"],
      pays: ["basalFactorQ", "growthCostFactorQ", "massFactorQ", "offspringCostFactorQ"],
    },
    {
      name: "a bigger mouth",
      genes: [[MorphGene.MouthSize, MORPH_GENE_RAW_MAX]],
      buys: ["attackFactorQ", "biteFactorQ"],
      pays: ["basalFactorQ", "turnFactorQ", "massFactorQ"],
    },
    {
      name: "a bigger head",
      genes: [[MorphGene.HeadProportion, MORPH_GENE_RAW_MAX]],
      buys: ["attackFactorQ"],
      pays: ["turnFactorQ", "massFactorQ"],
    },
    {
      name: "a longer tail",
      genes: [[MorphGene.TailLength, MORPH_GENE_RAW_MAX]],
      buys: ["maxSpeedFactorQ", "waterSpeedFactorQ"],
      pays: ["turnFactorQ", "massFactorQ", "accelFactorQ"],
    },
    {
      name: "bigger sensors",
      genes: [[MorphGene.SensorSize, MORPH_GENE_RAW_MAX]],
      buys: ["visionRangeFactorQ", "visionFovFactorQ"],
      // Sensory upkeep is billed through the vision cost rather than through a
      // factor, so this row's cost is asserted separately below.
      pays: [],
    },
    {
      name: "more segments",
      genes: [[MorphGene.SegmentCount, MORPH_GENE_RAW_MAX]],
      buys: ["turnFactorQ"],
      pays: ["massFactorQ"],
    },
  ];

  for (const direction of DIRECTIONS) {
    it(`${direction.name} costs something`, () => {
      let genes = founderGenes();
      for (const [gene, value] of direction.genes) {
        genes = (() => {
          const next = new Uint16Array(genes);
          next[gene] = value;
          return next;
        })();
      }
      const physical = physicsOf([founderGenes(), genes]);
      const before = factorsAt(physical, 0);
      const after = factorsAt(physical, 1);

      for (const key of direction.buys) {
        expect(`${direction.name} buys ${key}: ${after[key]} > ${before[key]}`).toBe(
          `${direction.name} buys ${key}: ${after[key]} > ${before[key]}`,
        );
        expect(after[key]).toBeGreaterThan(before[key]);
      }
      for (const key of direction.pays) {
        // Upkeep, growth and reproduction costs go UP; capabilities go DOWN.
        const isACost =
          key === "basalFactorQ" ||
          key === "growthCostFactorQ" ||
          key === "offspringCostFactorQ" ||
          key === "massFactorQ";
        if (isACost) {
          expect(after[key]).toBeGreaterThan(before[key]);
        } else {
          expect(after[key]).toBeLessThan(before[key]);
        }
      }
      expect(direction.buys.length).toBeGreaterThan(0);
    });
  }

  it("bigger sensors raise the vision upkeep they buy range with", () => {
    // Vision cost is `visionBaseCost × range² × arc`, so the sensor's cost lives
    // in the phenotype rather than in a factor. Asserted through the factors it
    // is computed from: both go up, and the cost is superlinear in range.
    const physical = physicsOf([
      founderGenes(),
      founderWith(MorphGene.SensorSize, MORPH_GENE_RAW_MAX),
    ]);
    const range = physical.visionRangeFactorQ[1] as number;
    const arc = physical.visionFovFactorQ[1] as number;
    expect(range).toBeGreaterThan(Q);
    expect(arc).toBeGreaterThan(Q);
    // (range² × arc) is the multiplier applied to `basalVisionCost`.
    const costMultiplier = (range / Q) * (range / Q) * (arc / Q);
    expect(costMultiplier).toBeGreaterThan(range / Q);
  });

  it("the limb rest angle allocates between speed and turning without a dominant setting", () => {
    const lateral = founderWith(MorphGene.AppendageAngle, 0);
    const swept = founderWith(MorphGene.AppendageAngle, MORPH_GENE_RAW_MAX);
    // Give both a real amount of limb to allocate, or the difference is noise.
    lateral[MorphGene.AppendageLength] = MORPH_GENE_RAW_MAX;
    swept[MorphGene.AppendageLength] = MORPH_GENE_RAW_MAX;
    const physical = physicsOf([lateral, swept]);
    expect(physical.maxSpeedFactorQ[1] as number).toBeGreaterThan(
      physical.maxSpeedFactorQ[0] as number,
    );
    expect(physical.turnFactorQ[1] as number).toBeLessThan(physical.turnFactorQ[0] as number);
    // Same body, same mass and same upkeep: this locus spends, it does not earn.
    expect(physical.massFactorQ[1]).toBe(physical.massFactorQ[0]);
    expect(physical.basalFactorQ[1]).toBe(physical.basalFactorQ[0]);
  });

  it("sensor placement allocates between vision range and vision arc", () => {
    const physical = physicsOf([
      founderWith(MorphGene.SensorPlacement, 0),
      founderWith(MorphGene.SensorPlacement, MORPH_GENE_RAW_MAX),
    ]);
    expect(physical.visionRangeFactorQ[1] as number).toBeGreaterThan(
      physical.visionRangeFactorQ[0] as number,
    );
    expect(physical.visionFovFactorQ[1] as number).toBeLessThan(
      physical.visionFovFactorQ[0] as number,
    );
  });

  it("no body plan is better than every other body plan at everything", () => {
    // The acceptance criterion of M15, stated as a search. A "capability" here
    // is anything selection would want more of; a "cost" is anything it would
    // want less of. If any sampled body weakly dominated all 3 000 others on
    // every axis at once, morphology would have a single right answer and the
    // whole genome would collapse onto it.
    const capabilities: FactorKey[] = [
      "energyStoreFactorQ",
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
    ];
    const costs: FactorKey[] = ["basalFactorQ", "growthCostFactorQ", "offspringCostFactorQ"];

    const rng = Xoshiro128.fromSeed(0x15a5);
    const genomes: Uint16Array[] = [
      founderGenes(),
      new Uint16Array(MORPH_GENE_COUNT).fill(0),
      new Uint16Array(MORPH_GENE_COUNT).fill(MORPH_GENE_RAW_MAX),
    ];
    for (let trial = 0; trial < 3_000; trial += 1) {
      const genes = new Uint16Array(MORPH_GENE_COUNT);
      for (let i = 0; i < MORPH_GENE_COUNT; i += 1) {
        genes[i] = rng.nextInt(MORPH_GENE_RAW_MAX + 1);
      }
      genomes.push(genes);
    }
    const physical = physicsOf(genomes);

    // A body dominates if nothing beats it on any capability or undercuts it on
    // any cost. Computed as a per-axis maximum/minimum, which is O(N) rather
    // than the O(N²) the naive phrasing suggests.
    const bestCapability = new Map<FactorKey, number>();
    const leastCost = new Map<FactorKey, number>();
    for (const key of capabilities) {
      let best = 0;
      for (let slot = 0; slot < genomes.length; slot += 1) {
        best = Math.max(best, physical[key][slot] as number);
      }
      bestCapability.set(key, best);
    }
    for (const key of costs) {
      let least = Number.POSITIVE_INFINITY;
      for (let slot = 0; slot < genomes.length; slot += 1) {
        least = Math.min(least, physical[key][slot] as number);
      }
      leastCost.set(key, least);
    }

    const dominators: number[] = [];
    for (let slot = 0; slot < genomes.length; slot += 1) {
      const dominates =
        capabilities.every(
          (key) => (physical[key][slot] as number) >= (bestCapability.get(key) as number),
        ) &&
        costs.every((key) => (physical[key][slot] as number) <= (leastCost.get(key) as number));
      if (dominates) {
        dominators.push(slot);
      }
    }
    expect(dominators).toEqual([]);
  });
});

describe("the config cannot ask for physics that has no meaning (M15)", () => {
  it("rejects gains that could drive a factor to zero", () => {
    const config = cloneConfig(DEFAULT_CONFIG);
    // Drag alone strong enough to cancel the founder's whole top speed.
    config.organism.physicalMorphology.speedDragGainQ = 3 * Q;
    expect(() => validateConfig(config)).toThrow(ConfigValidationError);
    expect(() => validateConfig(config)).toThrow(/maxSpeed factor/);
  });

  it("rejects plate tissue that is lighter than the tissue it covers", () => {
    const config = cloneConfig(DEFAULT_CONFIG);
    config.organism.physicalMorphology.plateDensityQ = Q >> 1;
    expect(() => validateConfig(config)).toThrow(/plateDensityQ/);
  });

  it("rejects factor bounds that do not bracket the founder", () => {
    const config = cloneConfig(DEFAULT_CONFIG);
    config.organism.physicalMorphology.minFactorQ = Q + 1;
    expect(() => validateConfig(config)).toThrow(/bracket Q/);
  });

  it("rejects a mass gain the heaviest body could not accelerate under", () => {
    const config = cloneConfig(DEFAULT_CONFIG);
    config.organism.physicalMorphology.accelMassGainQ = 2 * Q;
    expect(() => validateConfig(config)).toThrow(/acceleration factor/);
  });

  it("accepts the shipped configuration", () => {
    expect(() => validateConfig(cloneConfig(DEFAULT_CONFIG))).not.toThrow();
  });
});
