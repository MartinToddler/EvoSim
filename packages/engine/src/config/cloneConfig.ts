import { type DeepReadonly, deepCloneJson } from "@eon/shared";
import type { SimulationConfig } from "./SimulationConfig";

/** A configuration that cannot be mutated through its type. */
export type ReadonlySimulationConfig = DeepReadonly<SimulationConfig>;

/**
 * Deep copy of a configuration as a fresh, mutable, unfrozen value.
 *
 * Use this to build a config variant (sweep experiments, tests) from a frozen
 * one, and to hand a caller-owned copy out of the engine.
 *
 * Note on the type system: `DeepReadonly` only stops direct assignment such as
 * `config.world.sizeLU = 1`. TypeScript ignores property `readonly` modifiers
 * when checking assignability, so a deeply readonly config still satisfies
 * `SimulationConfig`. The real guarantee is the runtime deep freeze applied by
 * the engine — the type is documentation and a first line of defence, not the
 * enforcement mechanism.
 */
export function cloneConfig(config: ReadonlySimulationConfig): SimulationConfig {
  return deepCloneJson(config);
}
