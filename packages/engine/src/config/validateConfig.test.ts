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

/**
 * Schema shape enforcement.
 *
 * `hashConfig` serializes whatever keys the object has, so an unknown field
 * would be ignored by every rule and still change the world hash — and a
 * missing one would hand `undefined` to a hot loop. Both must fail loudly at
 * construction rather than quietly define a different world.
 */
describe("validateConfig schema shape", () => {
  it("rejects an unknown field", () => {
    const config = mutatedConfig((c) => {
      (c.time as unknown as Record<string, number>)["extraCadence"] = 7;
    });
    expect(() => validateConfig(config)).toThrowError(/time\.extraCadence is not a field/);
  });

  it("rejects a misspelled field, which would otherwise be silently ignored", () => {
    const config = mutatedConfig((c) => {
      const time = c.time as unknown as Record<string, number>;
      time["enviromentInterval"] = time["environmentInterval"] as number;
      delete time["environmentInterval"];
    });
    expect(() => validateConfig(config)).toThrowError(ConfigValidationError);
  });

  it("rejects a host runtime value pasted into the authoritative config", () => {
    // ADR 0002 §4: hosting values must never reach the config digest, or a
    // render cadence would change world identity.
    const config = mutatedConfig((c) => {
      (c as unknown as Record<string, number>)["targetTicksPerSecond1x"] = 20;
    });
    expect(() => validateConfig(config)).toThrowError(/targetTicksPerSecond1x is not a field/);
  });

  it("rejects a missing field", () => {
    const config = mutatedConfig((c) => {
      delete (c.world as unknown as Record<string, unknown>)["seaLevelQ"];
    });
    expect(() => validateConfig(config)).toThrowError(/world\.seaLevelQ is missing/);
  });

  it("rejects a field of the wrong type", () => {
    const config = mutatedConfig((c) => {
      (c.limits as unknown as Record<string, unknown>)["maxOrganisms"] = "8192";
    });
    expect(() => validateConfig(config)).toThrowError(/limits\.maxOrganisms must be a number/);
  });

  it("rejects an object where a number belongs", () => {
    const config = mutatedConfig((c) => {
      (c.world as unknown as Record<string, unknown>)["sizeLU"] = { value: 4096 };
    });
    expect(() => validateConfig(config)).toThrowError(/world\.sizeLU must be a number, got object/);
  });

  it("rejects an unknown field inside an array element", () => {
    const config = mutatedConfig((c) => {
      const octaves = c.world.generation.elevationOctaves as unknown as Record<string, number>[];
      (octaves[0] as Record<string, number>)["persistence"] = 2048;
    });
    expect(() => validateConfig(config)).toThrowError(/elevationOctaves\[0\]\.persistence/);
  });

  it("still allows tables whose length is a tuning choice", () => {
    // Array LENGTH is free (the octave stack is a calibration decision); only
    // the element shape is fixed.
    const config = mutatedConfig((c) => {
      c.world.generation.elevationOctaves = [
        { wavelengthCells: 64, weightQ: 2048 },
        { wavelengthCells: 16, weightQ: 2048 },
      ];
    });
    expect(() => validateConfig(config)).not.toThrow();
  });
});

describe("validateConfig world geometry bounds", () => {
  it("rejects a grid too large to allocate, with a config error rather than a RangeError", () => {
    const config = mutatedConfig((c) => {
      c.world.envGridSize = 8192;
      c.world.envCellSizeLU = 512;
      c.world.sizeLU = 8192 * 512;
      c.world.spatialCellSizeLU = 512;
    });
    expect(() => validateConfig(config)).toThrowError(/world\.envGridSize must not exceed/);
  });

  it("rejects a world whose fixed-point positions would leave the Int32 range", () => {
    const config = mutatedConfig((c) => {
      // 2^24 LU * 256 sub-units per LU overflows Int32 position storage.
      c.world.sizeLU = 2 ** 24;
      c.world.envGridSize = 4096;
      c.world.envCellSizeLU = 4096;
      c.world.spatialCellSizeLU = 4096;
    });
    expect(() => validateConfig(config)).toThrowError(/fixed-point positions/);
  });

  it("accepts the largest grid that still fits", () => {
    const config = mutatedConfig((c) => {
      c.world.envGridSize = 4096;
      c.world.envCellSizeLU = 1024;
      c.world.sizeLU = 4096 * 1024;
      c.world.spatialCellSizeLU = 1024;
    });
    expect(() => validateConfig(config)).not.toThrow();
  });
});
