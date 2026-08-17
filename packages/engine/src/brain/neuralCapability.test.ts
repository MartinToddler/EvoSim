import { Resource } from "../world/resources";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../config/defaultConfig";
import { Q } from "../math/fixed";
import {
  BRAIN_HIDDEN_COUNT,
  BRAIN_INPUT_COUNT,
  BRAIN_OUTPUT_COUNT,
  BrainInput,
  BrainOutput,
  hoWeightIndex,
  ihWeightIndex,
  ioWeightIndex,
} from "./BrainLayout";
import { inferBrain, positiveOutputQ } from "./inferBrain";
import {
  BRAIN_MEMORY_COUNT,
  NEURAL_WEIGHT_COUNT,
  TOPOLOGY_CONNECTION_WORD,
  TOPOLOGY_HIDDEN_WORD,
  TOPOLOGY_INPUT_WORD,
  TOPOLOGY_MEMORY_WORD,
  TOPOLOGY_RECURRENT_WORD,
  TOPOLOGY_WORD_COUNT,
  memoryGateWeightIndex,
  memoryReadWeightIndex,
  memorySkipWeightIndex,
  memoryValueWeightIndex,
  recurrentWeightIndex,
  setMaskBit,
} from "./NeuralTopology";

/**
 * M16 capability fixtures (docs/11 §M16, ADR 0030).
 *
 * ## What these prove, and what they deliberately do not
 *
 * Each test below hand-builds a network and shows that **the architecture can
 * represent** a behaviour: approaching food, avoiding a threat, acting
 * differently depending on an internal state, alternating on a cycle, and
 * holding a bearing across many ticks from nothing but a generic register and a
 * cue.
 *
 * None of these networks is installed into any organism. They are not founder
 * brains, not templates, not a library the engine draws on, and nothing outside
 * this file ever constructs them. That distinction is the whole point of the
 * exercise, and ADR 0027 is unambiguous about why: a behaviour the engine
 * *provides* is a scripted role, while a behaviour the engine can merely
 * *express* is a place evolution is allowed to go. M16's job is to widen the
 * second set without adding anything to the first.
 *
 * The persistent-bearing fixture is the one worth reading twice. It is built
 * from `memory0` and an ordinary cue, and at no point does the engine know that
 * the number in that register is a direction. If a lineage ever evolves
 * something similar, nothing in the code will recognise it as "going home" —
 * which is exactly the property that makes it a discovery rather than a
 * feature.
 */

const { weightScale } = DEFAULT_CONFIG.brain;

/** A network under construction: masks plus weights, nothing else. */
interface Network {
  topology: Uint16Array;
  weights: Int16Array;
}

function emptyNetwork(): Network {
  return {
    topology: new Uint16Array(TOPOLOGY_WORD_COUNT),
    weights: new Int16Array(NEURAL_WEIGHT_COUNT),
  };
}

function enableInput(net: Network, input: number): void {
  setMaskBit(net.topology, 0, TOPOLOGY_INPUT_WORD, input, true);
}

function enableHidden(net: Network, hidden: number): void {
  setMaskBit(net.topology, 0, TOPOLOGY_HIDDEN_WORD, hidden, true);
}

function enableRecurrent(net: Network, hidden: number): void {
  setMaskBit(net.topology, 0, TOPOLOGY_RECURRENT_WORD, hidden, true);
}

function enableMemory(net: Network, memory: number): void {
  setMaskBit(net.topology, 0, TOPOLOGY_MEMORY_WORD, memory, true);
}

/** Wire one connection: switch its bit on and give it a weight. */
function wire(net: Network, index: number, weight: number): void {
  setMaskBit(net.topology, 0, TOPOLOGY_CONNECTION_WORD, index, true);
  net.weights[index] = weight;
}

/** One organism's persistent state across a run of ticks. */
interface Body {
  hiddenPrev: Int16Array;
  memory: Int16Array;
}

function newBody(): Body {
  return {
    hiddenPrev: new Int16Array(BRAIN_HIDDEN_COUNT),
    memory: new Int16Array(BRAIN_MEMORY_COUNT),
  };
}

/** Run one tick and return the mapped intents. */
function tick(net: Network, body: Body, sensors: Int16Array): Int16Array {
  const hidden = new Int16Array(BRAIN_HIDDEN_COUNT);
  const outputs = new Int16Array(BRAIN_OUTPUT_COUNT);
  inferBrain(
    sensors,
    0,
    net.weights,
    0,
    hidden,
    0,
    outputs,
    0,
    weightScale,
    net.topology,
    0,
    body.hiddenPrev,
    0,
    body.memory,
    0,
  );
  return outputs;
}

/** A sensor block with `bias` pinned, as the sensing phase always writes it. */
function sensors(values: Partial<Record<number, number>> = {}): Int16Array {
  const block = new Int16Array(BRAIN_INPUT_COUNT);
  block[BrainInput.Bias] = Q;
  for (const [index, value] of Object.entries(values)) {
    block[Number(index)] = value as number;
  }
  return block;
}

describe("the architecture can represent reflexes (M16)", () => {
  it("approaching food: turn toward the lateral plant gradient", () => {
    // The simplest thing a brain can be, and the one the founder already is:
    // one skip connection from a gradient to a steering output.
    const net = emptyNetwork();
    enableInput(net, BrainInput.ResourceGradientLateral + Resource.Foliage);
    wire(
      net,
      ioWeightIndex(BrainOutput.Turn, BrainInput.ResourceGradientLateral + Resource.Foliage),
      2 * weightScale,
    );

    const body = newBody();
    const rightward = tick(
      net,
      body,
      sensors({ [BrainInput.ResourceGradientLateral + Resource.Foliage]: Q / 2 }),
    );
    const leftward = tick(
      net,
      body,
      sensors({ [BrainInput.ResourceGradientLateral + Resource.Foliage]: -Q / 2 }),
    );
    expect(rightward[BrainOutput.Turn] as number).toBeGreaterThan(0);
    expect(leftward[BrainOutput.Turn] as number).toBeLessThan(0);
  });

  it("avoiding a threat: throttle down when danger is ahead", () => {
    const net = emptyNetwork();
    enableInput(net, BrainInput.Bias);
    enableInput(net, BrainInput.TerrainDangerForward);
    wire(net, ioWeightIndex(BrainOutput.Throttle, BrainInput.Bias), weightScale);
    wire(
      net,
      ioWeightIndex(BrainOutput.Throttle, BrainInput.TerrainDangerForward),
      -2 * weightScale,
    );

    const body = newBody();
    const clear = tick(net, body, sensors());
    const blocked = tick(net, body, sensors({ [BrainInput.TerrainDangerForward]: Q }));
    expect(positiveOutputQ(clear[BrainOutput.Throttle] as number)).toBeGreaterThan(
      positiveOutputQ(blocked[BrainOutput.Throttle] as number),
    );
  });
});

describe("the architecture can represent internal state (M16)", () => {
  it("state-dependent action: the same sensory input drives opposite eating", () => {
    // A latch on memory0, written when energy is high, read into the eat
    // output. The *same* plant reading produces a different intent depending on
    // what the register holds — which is the definition of state-dependence and
    // is impossible without memory.
    const net = emptyNetwork();
    enableInput(net, BrainInput.Energy);
    enableInput(net, BrainInput.LocalResource + Resource.Foliage);
    enableHidden(net, 0);
    enableMemory(net, 0);

    // Hidden unit 0 tracks energy, and drives both halves of the register:
    // gate open whenever energy is readable at all, value = the energy sign.
    wire(net, ihWeightIndex(0, BrainInput.Energy), 4 * weightScale);
    wire(net, memoryGateWeightIndex(0, 0), 4 * weightScale);
    wire(net, memoryValueWeightIndex(0, 0), 4 * weightScale);
    // The register drives eating directly.
    wire(net, memorySkipWeightIndex(BrainOutput.Eat, 0), 2 * weightScale);

    const wellFed = newBody();
    tick(net, wellFed, sensors({ [BrainInput.Energy]: Q }));
    const hungry = newBody();
    tick(net, hungry, sensors({ [BrainInput.Energy]: -Q }));

    // Now show them an identical world and read a different decision.
    const identical = sensors({ [BrainInput.LocalResource + Resource.Foliage]: Q / 2 });
    const fedEat = positiveOutputQ(tick(net, wellFed, identical)[BrainOutput.Eat] as number);
    const hungryEat = positiveOutputQ(tick(net, hungry, identical)[BrainOutput.Eat] as number);
    expect(fedEat).not.toBe(hungryEat);
    expect(wellFed.memory[0] as number).toBeGreaterThan(hungry.memory[0] as number);
  });

  it("temporal alternation: a recurrent unit flips sign every tick", () => {
    // One hidden unit whose only input is its own previous activation, through a
    // negative weight. Nothing in the world changes; the output alternates
    // anyway, which is behaviour no purely feed-forward network can produce.
    const net = emptyNetwork();
    enableInput(net, BrainInput.Bias);
    enableHidden(net, 0);
    enableRecurrent(net, 0);
    wire(net, ihWeightIndex(0, BrainInput.Bias), weightScale >> 1);
    wire(net, recurrentWeightIndex(0), -2 * weightScale);
    wire(net, hoWeightIndex(BrainOutput.Attack, 0), weightScale);

    const body = newBody();
    const constant = sensors();
    const series: number[] = [];
    for (let t = 0; t < 6; t += 1) {
      series.push(tick(net, body, constant)[BrainOutput.Attack] as number);
    }
    // Consecutive ticks differ in sign at least once, and the series is not
    // constant — the network is driving itself.
    expect(new Set(series).size).toBeGreaterThan(1);
    let flips = 0;
    for (let t = 1; t < series.length; t += 1) {
      if (Math.sign(series[t] as number) !== Math.sign(series[t - 1] as number)) {
        flips += 1;
      }
    }
    expect(flips).toBeGreaterThan(1);
  });

  it("a persistent strategy: a bearing survives many ticks after its cue is gone", () => {
    // memory0 latches a value while a cue is present and holds it afterwards,
    // and the held value steers. The engine has no idea the number is a
    // direction; nothing here is called `home`.
    const net = emptyNetwork();
    enableInput(net, BrainInput.CreatureLateral);
    enableInput(net, BrainInput.CreatureProximity);
    enableHidden(net, 0);
    enableHidden(net, 1);
    enableMemory(net, 0);

    // Hidden 0 carries the bearing; hidden 1 is the "cue present" gate.
    wire(net, ihWeightIndex(0, BrainInput.CreatureLateral), 4 * weightScale);
    wire(net, ihWeightIndex(1, BrainInput.CreatureProximity), 4 * weightScale);
    wire(net, memoryValueWeightIndex(0, 0), 4 * weightScale);
    wire(net, memoryGateWeightIndex(0, 1), 4 * weightScale);
    wire(net, memoryReadWeightIndex(2, 0), 0);
    wire(net, memorySkipWeightIndex(BrainOutput.Turn, 0), 2 * weightScale);

    const body = newBody();
    // The cue is present, with a bearing to the right.
    tick(
      net,
      body,
      sensors({ [BrainInput.CreatureProximity]: Q, [BrainInput.CreatureLateral]: Q / 2 }),
    );
    const latched = body.memory[0] as number;
    expect(latched).toBeGreaterThan(0);

    // The cue vanishes. `creatureProximity` reads -Q with nothing in range,
    // which closes the gate, and the register must hold.
    let steering = 0;
    for (let t = 0; t < 40; t += 1) {
      steering = tick(net, body, sensors({ [BrainInput.CreatureProximity]: -Q }))[
        BrainOutput.Turn
      ] as number;
    }
    expect(body.memory[0] as number).toBe(latched);
    expect(steering).toBeGreaterThan(0);
  });
});

describe("memory obeys the rules it is given (M16)", () => {
  it("a register that is masked off holds nothing", () => {
    const net = emptyNetwork();
    enableInput(net, BrainInput.Bias);
    enableHidden(net, 0);
    // Everything wired to write memory0 — but the register itself is inactive.
    wire(net, ihWeightIndex(0, BrainInput.Bias), 4 * weightScale);
    wire(net, memoryGateWeightIndex(0, 0), 4 * weightScale);
    wire(net, memoryValueWeightIndex(0, 0), 4 * weightScale);

    const body = newBody();
    for (let t = 0; t < 5; t += 1) {
      tick(net, body, sensors());
    }
    expect(body.memory[0]).toBe(0);
  });

  it("a masked-off connection keeps its weight, so switching it back on restores it", () => {
    // The property that makes structural change reversible rather than a cliff.
    const net = emptyNetwork();
    enableInput(net, BrainInput.LocalResource + Resource.Foliage);
    const index = ioWeightIndex(BrainOutput.Eat, BrainInput.LocalResource + Resource.Foliage);
    wire(net, index, 2 * weightScale);

    const body = newBody();
    const world = sensors({ [BrainInput.LocalResource + Resource.Foliage]: Q });
    const wired = tick(net, body, world)[BrainOutput.Eat] as number;

    setMaskBit(net.topology, 0, TOPOLOGY_CONNECTION_WORD, index, false);
    const cut = tick(net, body, world)[BrainOutput.Eat] as number;
    expect(cut).toBe(0);
    expect(net.weights[index]).toBe(2 * weightScale);

    setMaskBit(net.topology, 0, TOPOLOGY_CONNECTION_WORD, index, true);
    const restored = tick(net, body, world)[BrainOutput.Eat] as number;
    expect(restored).toBe(wired);
  });

  it("an inactive sensory channel is not read, whatever the world says", () => {
    const net = emptyNetwork();
    const index = ioWeightIndex(BrainOutput.Eat, BrainInput.LocalResource + Resource.Foliage);
    wire(net, index, 2 * weightScale);
    // The connection is wired but the input channel is off.
    const body = newBody();
    expect(
      tick(net, body, sensors({ [BrainInput.LocalResource + Resource.Foliage]: Q }))[
        BrainOutput.Eat
      ],
    ).toBe(0);
    enableInput(net, BrainInput.LocalResource + Resource.Foliage);
    expect(
      tick(net, body, sensors({ [BrainInput.LocalResource + Resource.Foliage]: Q }))[
        BrainOutput.Eat
      ] as number,
    ).toBeGreaterThan(0);
  });

  it("a register is always exactly one tick old when it is read", () => {
    // Memory is written after the outputs are read, so a network cannot see in
    // tick N the value it decided to store in tick N. Without that ordering a
    // register would be a zero-delay loop and "memory" would mean nothing.
    const net = emptyNetwork();
    enableInput(net, BrainInput.Bias);
    enableHidden(net, 0);
    enableMemory(net, 0);
    wire(net, ihWeightIndex(0, BrainInput.Bias), 4 * weightScale);
    wire(net, memoryGateWeightIndex(0, 0), 4 * weightScale);
    wire(net, memoryValueWeightIndex(0, 0), 4 * weightScale);
    wire(net, memorySkipWeightIndex(BrainOutput.Attack, 0), 4 * weightScale);

    const body = newBody();
    // Tick 1 writes the register; its own output must still see the old zero.
    const first = tick(net, body, sensors())[BrainOutput.Attack] as number;
    expect(first).toBe(0);
    expect(body.memory[0] as number).toBeGreaterThan(0);
    // Tick 2 reads what tick 1 stored.
    const second = tick(net, body, sensors())[BrainOutput.Attack] as number;
    expect(second).toBeGreaterThan(0);
  });
});
