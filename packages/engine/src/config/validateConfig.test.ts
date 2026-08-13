import { describe, expect, it } from "vitest";
import { cloneConfig } from "./cloneConfig";
import type { SimulationConfig } from "./SimulationConfig";
import { DEFAULT_CONFIG } from "./defaultConfig";
import { ConfigValidationError, validateConfig } from "./validateConfig";

function mutatedConfig(mutate: (config: SimulationConfig) => void): SimulationConfig {
  const clone = cloneConfig(DEFAULT_CONFIG);
  mutate(clone);
  return clone;
}

describe("validateConfig", () => {
  it("accepts the default config", () => {
    expect(() => validateConfig(DEFAULT_CONFIG)).not.toThrow();
  });

  it("rejects an unsupported schema version", () => {
    const config = mutatedConfig((c) => {
      c.schemaVersion = 999;
    });
    expect(() => validateConfig(config)).toThrowError(ConfigValidationError);
  });

  it("rejects inconsistent world grid geometry", () => {
    const config = mutatedConfig((c) => {
      c.world.envCellSizeLU = 15; // 256 * 15 !== 4096
    });
    expect(() => validateConfig(config)).toThrowError(/envGridSize \* envCellSizeLU/);
  });

  it("rejects a spatial cell size that does not divide the world", () => {
    const config = mutatedConfig((c) => {
      c.world.spatialCellSizeLU = 33;
    });
    expect(() => validateConfig(config)).toThrowError(/spatialCellSizeLU/);
  });

  it("rejects sea level above mountain level", () => {
    const config = mutatedConfig((c) => {
      c.world.seaLevelQ = 4000;
      c.world.mountainLevelQ = 1000;
    });
    expect(() => validateConfig(config)).toThrowError(/seaLevelQ/);
  });

  it("rejects out-of-range Q fractions", () => {
    const config = mutatedConfig((c) => {
      c.mutation.ecological.perGeneMutationProbabilityQ = 5000;
    });
    expect(() => validateConfig(config)).toThrowError(/perGeneMutationProbabilityQ/);
  });

  it("rejects a brain weight count that contradicts the topology", () => {
    const config = mutatedConfig((c) => {
      c.brain.weightCount = 399;
    });
    expect(() => validateConfig(config)).toThrowError(/weightCount/);
  });

  it("rejects biome tables of the wrong length", () => {
    const config = mutatedConfig((c) => {
      c.plants.baseCapacityByBiome = [0, 1, 2];
    });
    expect(() => validateConfig(config)).toThrowError(/baseCapacityByBiome/);
  });

  it("rejects founder populations above the organism cap", () => {
    const config = mutatedConfig((c) => {
      c.world.initialOrganisms = c.limits.maxOrganisms + 1;
    });
    expect(() => validateConfig(config)).toThrowError(/initialOrganisms/);
  });

  it("rejects a water movement cost multiplier below 1.0", () => {
    const config = mutatedConfig((c) => {
      c.organism.movement.waterMovementCostMultiplierQ = 2048;
    });
    expect(() => validateConfig(config)).toThrowError(/waterMovementCostMultiplierQ/);
  });
});

describe("validateConfig must not over-constrain legitimate configurations", () => {
  /**
   * Each of these values means "this mechanism is switched off", which is a
   * legitimate ablation experiment (docs/07 §14 sweep harness). A validator
   * that demands a positive value here silently forbids whole experiments.
   */
  const ablationsThatMustBeAccepted: ReadonlyArray<[string, (c: SimulationConfig) => void]> = [
    ["growth is free", (c) => void (c.organism.energyPerGrowthMass = 0)],
    ["carcasses carry no meat", (c) => void (c.organism.carcass.meatPerMass = 0)],
    [
      "carcasses never decay",
      (c) => void (c.organism.carcass.baseCarcassDecayFractionQPerDecayStep = 0),
    ],
    ["combat deals no damage", (c) => void (c.combat.baseAttackDamageQ = 0)],
    ["no attack cooldown", (c) => void (c.combat.attackCooldownTicks = 0)],
    ["body size does not affect damage", (c) => void (c.combat.attackSizeFactorFloorQ = 4096)],
    ["attacking is free", (c) => void (c.combat.baseAttackEnergyCost = 0)],
    ["no reproduction cooldown", (c) => void (c.reproduction.reproductionCooldownTicks = 0)],
    ["children spawn on the parent", (c) => void (c.reproduction.childSpawnDistanceMinLU = 0)],
    ["water is harmless", (c) => void (c.organism.movement.waterHealthDamageQPerTick = 0)],
    ["water damage starts at once", (c) => void (c.organism.movement.waterGraceTicks = 0)],
    ["no event debounce", (c) => void (c.history.eventCooldownStatsSamples = 0)],
    ["no passive healing", (c) => void (c.organism.health.passiveHealingQPerTick = 0)],
    ["no vision upkeep", (c) => void (c.organism.basal.visionBaseCost = 0)],
    ["no mutation spread", (c) => void (c.mutation.ecological.smallSigmaQ = 0)],
  ];

  for (const [label, mutate] of ablationsThatMustBeAccepted) {
    it(`accepts a config where ${label}`, () => {
      expect(() => validateConfig(mutatedConfig(mutate))).not.toThrow();
    });
  }

  it("accepts negative temperature thresholds", () => {
    const config = mutatedConfig((c) => {
      c.world.biomeThresholds.tundraTemperatureCentiC = -1500;
      c.world.biomeThresholds.desertMinTemperatureCentiC = -200;
    });
    expect(() => validateConfig(config)).not.toThrow();
  });

  it("accepts a decay bonus of exactly Q and multipliers above Q", () => {
    const config = mutatedConfig((c) => {
      c.organism.carcass.hotDecayBonusMaxQ = 4096;
      c.organism.carcass.baseCarcassDecayFractionQPerDecayStep = 2048;
      c.organism.health.severeThermalBasalMultiplierMaxQ = 40960;
    });
    expect(() => validateConfig(config)).not.toThrow();
  });

  it("accepts a population boom threshold above +100%", () => {
    const config = mutatedConfig((c) => {
      c.history.populationBoomFractionQ = 8192;
    });
    expect(() => validateConfig(config)).not.toThrow();
  });
});

describe("validateConfig structural invariants", () => {
  it("rejects a negative energy cost", () => {
    const config = mutatedConfig((c) => {
      c.organism.energyPerGrowthMass = -1;
    });
    expect(() => validateConfig(config)).toThrowError(/energyPerGrowthMass/);
  });

  it("rejects a temperature written in whole degrees instead of centi-Celsius", () => {
    const config = mutatedConfig((c) => {
      c.world.biomeThresholds.desertMinTemperatureCentiC = 30_000;
    });
    expect(() => validateConfig(config)).toThrowError(/centi-Celsius/);
  });

  it("rejects biome thresholds in the wrong order", () => {
    const tundraAboveDesert = mutatedConfig((c) => {
      c.world.biomeThresholds.tundraTemperatureCentiC = 2000;
    });
    expect(() => validateConfig(tundraAboveDesert)).toThrowError(/tundra temperature/);

    const desertWetterThanForest = mutatedConfig((c) => {
      c.world.biomeThresholds.desertMaxMoistureQ = 3000;
    });
    expect(() => validateConfig(desertWetterThanForest)).toThrowError(/desert maximum moisture/);
  });

  it("rejects total armor immunity and immobilizing armor", () => {
    const immune = mutatedConfig((c) => {
      c.combat.maxArmorDamageReductionQ = 4096;
    });
    expect(() => validateConfig(immune)).toThrowError(/total immunity/);

    const immobile = mutatedConfig((c) => {
      c.organism.movement.armorMaxSpeedPenaltyQ = 4096;
    });
    expect(() => validateConfig(immobile)).toThrowError(/armorMaxSpeedPenaltyQ/);
  });

  it("rejects a brain value scale detached from Q", () => {
    const config = mutatedConfig((c) => {
      c.brain.valueScale = 8192;
    });
    expect(() => validateConfig(config)).toThrowError(/valueScale/);
  });

  it("rejects an asymmetric weight clamp", () => {
    const config = mutatedConfig((c) => {
      c.brain.weightMin = -4096;
    });
    expect(() => validateConfig(config)).toThrowError(/symmetric/);
  });

  it("rejects a brain size whose accumulator could lose integer exactness", () => {
    const config = mutatedConfig((c) => {
      c.brain.hiddenCount = 12;
      c.brain.weightMax = 2 ** 40;
      c.brain.weightMin = -(2 ** 40);
    });
    expect(() => validateConfig(config)).toThrowError(/accumulator/);
  });

  it("rejects plant growth in water while aquatic life is out of scope", () => {
    const config = mutatedConfig((c) => {
      c.plants.baseCapacityByBiome = [100, 36000, 52000, 7000, 10000, 4000];
    });
    expect(() => validateConfig(config)).toThrowError(/water biome/);
  });

  it("rejects decay that could exceed 100% per step at maximum heat", () => {
    const config = mutatedConfig((c) => {
      c.organism.carcass.baseCarcassDecayFractionQPerDecayStep = 4096;
      c.organism.carcass.hotDecayBonusMaxQ = 4096;
    });
    expect(() => validateConfig(config)).toThrowError(/100%/);
  });

  it("rejects a hot-decay ramp with no width, in either direction", () => {
    // The ramp's span is a divisor: an empty one divides by zero, and an
    // inverted one would make frozen carrion rot fastest.
    const empty = mutatedConfig((c) => {
      c.organism.carcass.hotDecayMinTemperatureCentiC = 2000;
      c.organism.carcass.hotDecayFullBonusTemperatureCentiC = 2000;
    });
    expect(() => validateConfig(empty)).toThrowError(/hot-decay ramp/);

    const inverted = mutatedConfig((c) => {
      c.organism.carcass.hotDecayMinTemperatureCentiC = 3500;
      c.organism.carcass.hotDecayFullBonusTemperatureCentiC = 0;
    });
    expect(() => validateConfig(inverted)).toThrowError(/hot-decay ramp/);
  });

  it("accepts a hot-decay ramp entirely below freezing", () => {
    const config = mutatedConfig((c) => {
      c.organism.carcass.hotDecayMinTemperatureCentiC = -2000;
      c.organism.carcass.hotDecayFullBonusTemperatureCentiC = -500;
    });
    expect(() => validateConfig(config)).not.toThrow();
  });

  it("rejects an attack size factor floor above Q", () => {
    // Above Q the derived span `Q - floor` is negative and a large body would
    // hit softer than a small one — the trade-off inverted by arithmetic.
    const config = mutatedConfig((c) => {
      c.combat.attackSizeFactorFloorQ = 4097;
    });
    expect(() => validateConfig(config)).toThrowError(/attackSizeFactorFloorQ/);
  });

  it("rejects a species continuity threshold at or above the split threshold", () => {
    const config = mutatedConfig((c) => {
      c.species.candidateCentroidContinuityThresholdQ = c.species.splitDistanceThresholdQ;
    });
    expect(() => validateConfig(config)).toThrowError(/continuity threshold/);
  });

  it("rejects an unreachable species analysis population", () => {
    const config = mutatedConfig((c) => {
      c.species.minDaughterPopulation = c.limits.maxOrganisms;
    });
    expect(() => validateConfig(config)).toThrowError(/minDaughterPopulation/);
  });
});

describe("validateConfig rejects values their storage cannot hold", () => {
  /**
   * A cooldown lives in a `Uint16Array` row of `OrganismStore`. Assigning a
   * larger number does not clamp it, it WRAPS: 70 000 is stored as 4 464, so the
   * organism comes off cooldown 65 536 ticks early and reproduces or attacks far
   * faster than the configuration says. Nothing downstream can detect that, so
   * the only place it can be caught is here.
   */
  const UINT16_MAX = 65535;

  it("rejects a reproduction cooldown above the Uint16 row", () => {
    const config = mutatedConfig((c) => {
      c.reproduction.reproductionCooldownTicks = UINT16_MAX + 1;
    });
    expect(() => validateConfig(config)).toThrowError(/reproductionCooldownTicks/);
  });

  it("accepts a reproduction cooldown at exactly the Uint16 bound", () => {
    const config = mutatedConfig((c) => {
      c.reproduction.reproductionCooldownTicks = UINT16_MAX;
    });
    expect(() => validateConfig(config)).not.toThrow();
  });

  it("rejects an attack cooldown above the Uint16 row", () => {
    const config = mutatedConfig((c) => {
      c.combat.attackCooldownTicks = 200_000;
    });
    expect(() => validateConfig(config)).toThrowError(/attackCooldownTicks/);
  });

  it("accepts an attack cooldown at exactly the Uint16 bound", () => {
    const config = mutatedConfig((c) => {
      c.combat.attackCooldownTicks = UINT16_MAX;
    });
    expect(() => validateConfig(config)).not.toThrow();
  });
});
