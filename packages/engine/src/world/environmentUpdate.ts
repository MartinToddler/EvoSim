import type { DeepReadonly } from "@eon/shared";
import type { SimulationConfig } from "../config/SimulationConfig";
import type { EnvironmentStore } from "./EnvironmentStore";
import { growPlants } from "./plants";

/**
 * Scheduled environment update — phase 1 of the authoritative tick order
 * (docs/03 §7), run every `time.environmentInterval` ticks (task C07).
 *
 * Deliberately NOT run every tick: plant growth is a slow ecological process,
 * and 65 536 cells per tick would dominate the tick budget for no ecological
 * gain. The growth rates in docs/08 §5 are therefore per environment step, not
 * per tick.
 */
export function updateEnvironment(
  environment: EnvironmentStore,
  config: DeepReadonly<SimulationConfig>,
): void {
  growPlants(environment, config);
}
