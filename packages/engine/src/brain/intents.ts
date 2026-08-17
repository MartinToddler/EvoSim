import type { EngineContext } from "../EngineContext";
import { BRAIN_INPUT_COUNT, BrainOutput } from "./BrainLayout";
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
 * organism reads only its own sensors, its own memory and its own previous
 * activations, and writes only its own — but it is fixed anyway, because
 * "cannot matter today" is not a property that survives refactoring.
 *
 * M16 made this phase the only writer of authoritative neural state: the
 * network's memory registers and its carried-over hidden activations are
 * updated here, inside `inferBrain`, and nowhere else.
 */
export function runBrainsAndBuildIntents(ctx: EngineContext): void {
  const { organisms, genomes, neural, scratch, config } = ctx;
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
      genomes.weightOffset(slot),
      scratch.hiddenValues,
      0,
      outputs,
      0,
      weightScale,
      genomes.topology,
      genomes.topologyOffset(slot),
      neural.hiddenPrevQ,
      neural.hiddenOffset(slot),
      neural.memoryQ,
      neural.memoryOffset(slot),
    );

    scratch.throttleQ[slot] = positiveOutputQ(outputs[BrainOutput.Throttle] as number);
    // Turn keeps its raw signed value: negative left, positive right.
    scratch.turnQ[slot] = outputs[BrainOutput.Turn] as number;
    scratch.eatQ[slot] = positiveOutputQ(outputs[BrainOutput.Eat] as number);
    scratch.attackQ[slot] = positiveOutputQ(outputs[BrainOutput.Attack] as number);
    scratch.reproduceQ[slot] = positiveOutputQ(outputs[BrainOutput.Reproduce] as number);
  }
}
