import {
  CONFIG_SCHEMA_VERSION,
  DEFAULT_CONFIG,
  ENGINE_VERSION,
  SimulationEngine,
  WorldGenerationError,
  hashEnvironment,
} from "@eon/engine";
import {
  type EnvironmentDebugFields,
  type EnvironmentDebugSummary,
  summarizeEnvironmentFields,
} from "@eon/renderer";
import { type Result, err, ok } from "@eon/shared";
import { captureEnvironmentDebugFields } from "./captureEnvironmentDebugFields";

/**
 * World creation and read-out for the environment debug view (Milestone 2.5).
 *
 * The engine runs on the main thread here, synchronously. That is a deliberate
 * limitation of a development tool, not a design proposal: the Worker host,
 * scheduler and render snapshot protocol belong to Milestone 6 (tasks G01–G04),
 * and building half of them now would be the "architecture by debug tool" mistake
 * this milestone is explicitly told to avoid. Generating a 256² world costs on the
 * order of 100 ms, which a button press can afford.
 *
 * Nothing here decides anything: it constructs an engine from a seed, reads state
 * out of it, and formats it. All simulation rules stay in `@eon/engine`.
 */

/** Immutable read-out of one world state, safe to hold in React state. */
export interface DebugWorldModel {
  readonly seed: number;
  readonly tick: number;
  readonly engineVersion: string;
  readonly configSchemaVersion: number;
  /** Digest of the authoritative config; identifies the tuning, not the world. */
  readonly configHash: string;
  /** Digest of the environment arrays alone — "is this the same map?". */
  readonly environmentHash: string;
  /** Canonical world state hash — comparable with `pnpm headless` output. */
  readonly stateHash: string;
  /** 0 when the seed produced a valid world directly; higher after a retry. */
  readonly generationAttempt: number;
  readonly founderRegion: {
    readonly centerCellIndex: number;
    readonly centerGridX: number;
    readonly centerGridY: number;
    readonly componentCells: number;
  };
  /** Founder spawn radius converted to whole cells, for the map marker. */
  readonly founderRadiusCells: number;
  readonly fields: EnvironmentDebugFields;
  readonly summary: EnvironmentDebugSummary;
}

/** Read the current state of an engine into an immutable model. */
export function readDebugWorldModel(engine: SimulationEngine): DebugWorldModel {
  const fields = captureEnvironmentDebugFields(engine);
  return {
    seed: engine.seed,
    tick: engine.tick,
    engineVersion: ENGINE_VERSION,
    configSchemaVersion: CONFIG_SCHEMA_VERSION,
    configHash: engine.configHash,
    environmentHash: hashEnvironment(engine.environment),
    stateHash: engine.computeStateHash(),
    generationAttempt: engine.generationAttempt,
    founderRegion: {
      centerCellIndex: engine.founderRegion.centerCellIndex,
      centerGridX: engine.founderRegion.centerGridX,
      centerGridY: engine.founderRegion.centerGridY,
      componentCells: engine.founderRegion.componentCells,
    },
    founderRadiusCells: Math.max(
      1,
      Math.ceil(engine.config.world.founderSpawnRadiusLU / engine.environment.cellSizeLU),
    ),
    fields,
    summary: summarizeEnvironmentFields(fields),
  };
}

/**
 * Create a world from a seed.
 *
 * World generation can legitimately fail: every generation attempt may produce an
 * unusable map, and the engine then throws rather than shipping a degraded world
 * (ADR 0003 §5). A debug view must show that failure with its reasons instead of
 * a blank canvas, so the error is returned as a value.
 */
export function createDebugWorld(seed: number): Result<SimulationEngine, string> {
  try {
    return ok(new SimulationEngine({ seed, config: DEFAULT_CONFIG }));
  } catch (error: unknown) {
    if (error instanceof WorldGenerationError) {
      return err([error.message, ...error.attempts].join("\n"));
    }
    return err(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Advance a world by `ticks` authoritative ticks and re-read it.
 *
 * Present so the "current biomass" layer can be seen doing something: at tick 0
 * biomass is a fixed fraction of capacity everywhere, so the layer only becomes
 * informative once plant growth has run. It calls `stepMany` and nothing else —
 * no rule, rate or cadence is reimplemented here.
 */
export function advanceDebugWorld(
  engine: SimulationEngine,
  ticks: number,
): Result<DebugWorldModel, string> {
  try {
    engine.stepMany(ticks);
    return ok(readDebugWorldModel(engine));
  } catch (error: unknown) {
    return err(error instanceof Error ? error.message : String(error));
  }
}
