import type { EngineContext } from "../EngineContext";
import { BRAIN_INPUT_COUNT, BRAIN_WEIGHT_COUNT, BrainOutput } from "./BrainLayout";
import { inferBrain, positiveOutputQ } from "./inferBrain";

/**
 * Brains and intents — phase 4 of the authoritative tick order (docs/03 §9,
 * task D08).
 *
 * Every living organism's network runs against the sensor block written by
 * phase 3, and its outputs land in the intent arrays. Nothing is *acted on*
 * here: intents are declarations, and the later phases resolve them together
 * so that no organism gains an advantage from having a lower slot index
 * (food is allocated proportionally, damage is applied simultaneously).
 *
 * Runs over live slots in ascending order. The order cannot matter — each
 * organism reads only its own sensors and writes only its own intents — but it
 * is fixed anyway, because "cannot matter today" is not a property that
 * survives refactoring.
 */
export function runBrainsAndBuildIntents(ctx: EngineContext): void {
  const { organisms, genomes, scratch, config } = ctx;
  const weightScale = config.brain.weightScale;
  const outputs = scratch.outputValues;

  for (let slot = 0; slot < organisms.slotHighWater; slot += 1) {
    if (organisms.alive[slot] !== 1) {
      continue;
    }

    inferBrain(
      scratch.sensorValues,
      slot * BRAIN_INPUT_COUNT,
      genomes.brainWeights,
      slot * BRAIN_WEIGHT_COUNT,
      scratch.hiddenValues,
      0,
      outputs,
      0,
      weightScale,
    );

    scratch.throttleQ[slot] = positiveOutputQ(outputs[BrainOutput.Throttle] as number);
    // Turn keeps its raw signed value: negative left, positive right.
    scratch.turnQ[slot] = outputs[BrainOutput.Turn] as number;
    scratch.eatQ[slot] = positiveOutputQ(outputs[BrainOutput.Eat] as number);
    scratch.attackQ[slot] = positiveOutputQ(outputs[BrainOutput.Attack] as number);
    scratch.reproduceQ[slot] = positiveOutputQ(outputs[BrainOutput.Reproduce] as number);
  }
}
