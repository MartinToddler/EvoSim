import type { DeepReadonly } from "@eon/shared";
import type { SimulationConfig } from "../config/SimulationConfig";
import type { EnvironmentStore } from "./EnvironmentStore";
import { generateEnvironment, generationSubSeed } from "./generateWorld";
import { type FounderRegion, type WorldValidity, validateWorld } from "./validateWorld";

/** Thrown when no generation attempt produced a usable world. */
export class WorldGenerationError extends Error {
  readonly attempts: readonly string[];

  constructor(message: string, attempts: readonly string[]) {
    super(message);
    this.name = "WorldGenerationError";
    this.attempts = attempts;
  }
}

export interface GeneratedWorld {
  environment: EnvironmentStore;
  founderRegion: FounderRegion;
  /** Which attempt produced this world; 0 means the seed worked directly. */
  attempt: number;
  /** Sub-seed actually used for the accepted world. */
  subSeed: number;
  validity: WorldValidity;
}

/**
 * Generate a valid world, retrying deterministically with derived sub-seeds
 * (docs/03 §15).
 *
 * Retrying is what keeps generation honest: rather than relaxing thresholds or
 * patching an unusable map, an invalid world is discarded whole and the next
 * sub-seed is tried. The number of attempts is bounded by
 * `world.generationMaxRetries`, and exhausting it is an error rather than a
 * silently degraded world.
 */
export function createWorld(config: DeepReadonly<SimulationConfig>, seed: number): GeneratedWorld {
  const failures: string[] = [];

  for (let attempt = 0; attempt < config.world.generationMaxRetries; attempt += 1) {
    const subSeed = generationSubSeed(seed, attempt);
    const environment = generateEnvironment(config, subSeed);
    const validity = validateWorld(environment, config);

    if (validity.valid && validity.founderRegion !== null) {
      return {
        environment,
        founderRegion: validity.founderRegion,
        attempt,
        subSeed,
        validity,
      };
    }
    failures.push(`attempt ${attempt} (sub-seed ${subSeed}): ${validity.reason}`);
  }

  throw new WorldGenerationError(
    `no valid world after ${config.world.generationMaxRetries} attempts for seed ${seed}`,
    failures,
  );
}
