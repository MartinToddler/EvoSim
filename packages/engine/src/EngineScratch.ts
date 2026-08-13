import {
  BRAIN_HIDDEN_COUNT,
  BRAIN_INPUT_COUNT,
  BRAIN_OUTPUT_COUNT,
  BRAIN_WEIGHT_COUNT,
} from "./brain/BrainLayout";
import { GENE_COUNT } from "./genetics/genes";

/**
 * Reusable per-tick working memory (docs/10 §4).
 *
 * Everything a phase needs to hand to a later phase lives here, allocated once
 * for the maximum population and reused every tick. CLAUDE.md forbids per-tick
 * allocation in hot loops, and at 8192 organisms × 20 sensors a fresh array per
 * organism per tick would be ~164 000 allocations per tick.
 *
 * None of this is authoritative: every field is written before it is read
 * within a single tick, so scratch is never hashed and never serialized.
 */
export class EngineScratch {
  readonly capacity: number;

  /**
   * Sensor block per organism, `BRAIN_INPUT_COUNT` values each.
   *
   * Full width rather than a shared buffer on purpose: sensing is its own phase
   * and must complete for the whole population before any brain runs, so that
   * every organism decides from the same coherent pre-decision state
   * (docs/03 §9).
   */
  readonly sensorValues: Int16Array;
  /** Hidden activations for the organism currently being inferred. */
  readonly hiddenValues: Int16Array;
  /** Raw outputs for the organism currently being inferred. */
  readonly outputValues: Int16Array;

  // --- Intents (docs/03 §9) --------------------------------------------------
  readonly throttleQ: Uint16Array;
  readonly turnQ: Int16Array;
  readonly eatQ: Uint16Array;
  readonly attackQ: Uint16Array;
  readonly reproduceQ: Uint16Array;

  // --- Movement outputs consumed by metabolism -------------------------------
  /** Realized speed as a Q fraction of the organism's effective maximum. */
  readonly speedFractionQ: Uint16Array;
  /** Realized acceleration as a Q fraction of the organism's maximum. */
  readonly accelFractionQ: Uint16Array;
  /** 1 when the organism ended the movement phase standing in water. */
  readonly inWater: Uint8Array;
  /** Soft-collision displacement accumulated before being applied. */
  readonly moveCorrectionX: Int32Array;
  readonly moveCorrectionY: Int32Array;

  // --- Feeding claims (docs/10 §12) -----------------------------------------
  /** Biomass units requested this tick; 0 when not feeding. */
  readonly feedingRequest: Uint16Array;
  /** Which food kind the request targets (see FeedingTarget). */
  readonly feedingTargetType: Uint8Array;
  /** Environment cell (plants) or carcass index the request targets; -1 if none. */
  readonly feedingTargetIndex: Int32Array;
  /** Biomass units actually granted after proportional resolution. */
  readonly feedingAllocated: Uint16Array;
  /** Total demand per environment cell, cleared through `demandedCells`. */
  readonly plantDemandPerCell: Uint32Array;
  /**
   * First claimant slot per environment cell, -1 when none, chained through
   * {@link claimNext}.
   *
   * Without this index, resolving the leftover units would have to rescan the
   * whole population once per contested cell — the O(cells × organisms) shape
   * docs/10 §12 warns against.
   */
  readonly plantClaimHead: Int32Array;
  /** Next claimant on the same cell, -1 at the end of the chain. */
  readonly claimNext: Int32Array;
  /** Cells with non-zero demand this tick, so the demand array is not swept. */
  readonly demandedCells: Int32Array;
  /** Scratch used to order one cell's claimants by ascending entity ID. */
  readonly claimants: Int32Array;

  // --- Carcass feeding claims (docs/03 §23) ----------------------------------
  /**
   * Meat demand per carcass slot, cleared through {@link demandedCarcasses}.
   *
   * Carrion is allocated by exactly the same aggregate-then-share rule as plant
   * biomass, for the same reason: applying bites inside the organism loop would
   * let the lowest slot strip a body before its neighbours were asked
   * (docs/03 §23, docs/10 §12).
   */
  readonly carcassDemand: Uint32Array;
  /** First claimant slot per carcass, -1 when none, chained through {@link claimNext}. */
  readonly carcassClaimHead: Int32Array;
  /** Carcasses with non-zero demand this tick. */
  readonly demandedCarcasses: Int32Array;

  // --- Combat claims (docs/04 §21, docs/10 §13) -----------------------------
  /**
   * Damage claimed against each target this tick, accumulated before any of it
   * is applied.
   *
   * This array is the whole reason mutual kills work: no organism dies inside
   * the attacker loop, so every attacker that was alive when the tick began gets
   * to strike, and two organisms can kill each other on the same tick.
   */
  readonly damageAccumQ: Int32Array;
  /** Largest single contribution to a target's damage, for kill attribution. */
  readonly bestDamageQ: Int32Array;
  /** Entity ID of that largest contributor; the tie-break is the lower ID. */
  readonly bestAttackerId: Uint32Array;
  /** Slot of that contributor, so the kill can be credited to a living row. */
  readonly bestAttackerSlot: Int32Array;
  /**
   * Damage actually applied to each organism by phase 11.
   *
   * Read by the physiology phase, which owns `lastDamageQ`: combat and
   * starvation/thermal damage both land on the same tick, and the field would
   * lie if the later phase simply overwrote what the earlier one did.
   */
  readonly combatDamageQ: Uint16Array;

  // --- Deaths ----------------------------------------------------------------
  readonly pendingDeath: Uint8Array;
  readonly deathCause: Uint8Array;

  // --- Reproduction (docs/04 §19) -------------------------------------------
  /**
   * Slots that passed every reproduction condition, in ascending slot order.
   *
   * Collected before any birth happens, which is what makes it impossible for a
   * newborn — which may land in a lower slot than its own parent — to be treated
   * as a parent on its birth tick.
   */
  readonly reproducers: Int32Array;
  /** One child's genome, mutated here before it is handed to the spawner. */
  readonly childGenes: Uint16Array;
  readonly childBrainWeights: Int16Array;

  #demandedCellCount = 0;
  #demandedCarcassCount = 0;
  #reproducerCount = 0;

  constructor(capacity: number, environmentCellCount: number, carcassCapacity: number) {
    this.capacity = capacity;

    this.sensorValues = new Int16Array(capacity * BRAIN_INPUT_COUNT);
    this.hiddenValues = new Int16Array(BRAIN_HIDDEN_COUNT);
    this.outputValues = new Int16Array(BRAIN_OUTPUT_COUNT);

    this.throttleQ = new Uint16Array(capacity);
    this.turnQ = new Int16Array(capacity);
    this.eatQ = new Uint16Array(capacity);
    this.attackQ = new Uint16Array(capacity);
    this.reproduceQ = new Uint16Array(capacity);

    this.speedFractionQ = new Uint16Array(capacity);
    this.accelFractionQ = new Uint16Array(capacity);
    this.inWater = new Uint8Array(capacity);
    this.moveCorrectionX = new Int32Array(capacity);
    this.moveCorrectionY = new Int32Array(capacity);

    this.feedingRequest = new Uint16Array(capacity);
    this.feedingTargetType = new Uint8Array(capacity);
    this.feedingTargetIndex = new Int32Array(capacity);
    this.feedingAllocated = new Uint16Array(capacity);
    this.plantDemandPerCell = new Uint32Array(environmentCellCount);
    this.plantClaimHead = new Int32Array(environmentCellCount).fill(-1);
    this.claimNext = new Int32Array(capacity).fill(-1);
    this.demandedCells = new Int32Array(capacity);
    this.claimants = new Int32Array(capacity);

    this.carcassDemand = new Uint32Array(carcassCapacity);
    this.carcassClaimHead = new Int32Array(carcassCapacity).fill(-1);
    // One entry per potential claimant, not per carcass: the list records the
    // carcasses that were claimed, and there can never be more of those than
    // there are organisms doing the claiming.
    this.demandedCarcasses = new Int32Array(Math.min(carcassCapacity, capacity));

    this.damageAccumQ = new Int32Array(capacity);
    this.bestDamageQ = new Int32Array(capacity);
    this.bestAttackerId = new Uint32Array(capacity);
    this.bestAttackerSlot = new Int32Array(capacity).fill(-1);
    this.combatDamageQ = new Uint16Array(capacity);

    this.pendingDeath = new Uint8Array(capacity);
    this.deathCause = new Uint8Array(capacity);

    this.reproducers = new Int32Array(capacity);
    this.childGenes = new Uint16Array(GENE_COUNT);
    this.childBrainWeights = new Int16Array(BRAIN_WEIGHT_COUNT);
  }

  /** Number of eligible parents collected this tick. */
  get reproducerCount(): number {
    return this.#reproducerCount;
  }

  /** Start a fresh reproduction pass. */
  resetReproducers(): void {
    this.#reproducerCount = 0;
  }

  /** Record an eligible parent. Called in ascending slot order. */
  noteReproducer(slot: number): void {
    this.reproducers[this.#reproducerCount] = slot;
    this.#reproducerCount += 1;
  }

  /** Number of environment cells that received a feeding claim this tick. */
  get demandedCellCount(): number {
    return this.#demandedCellCount;
  }

  /** Record that `cell` now has demand, so it can be cleared cheaply later. */
  noteDemandedCell(cell: number): void {
    this.demandedCells[this.#demandedCellCount] = cell;
    this.#demandedCellCount += 1;
  }

  /**
   * Reset the demand and claimant chain of every cell touched this tick.
   *
   * Sweeping all 65 536 cells instead would cost more than the entire feeding
   * phase in a sparsely populated world.
   */
  clearPlantDemand(): void {
    for (let i = 0; i < this.#demandedCellCount; i += 1) {
      const cell = this.demandedCells[i] as number;
      this.plantDemandPerCell[cell] = 0;
      this.plantClaimHead[cell] = -1;
    }
    this.#demandedCellCount = 0;
  }

  /** Number of carcasses that received a feeding claim this tick. */
  get demandedCarcassCount(): number {
    return this.#demandedCarcassCount;
  }

  /** Record that a carcass now has demand, so it can be cleared cheaply later. */
  noteDemandedCarcass(carcass: number): void {
    this.demandedCarcasses[this.#demandedCarcassCount] = carcass;
    this.#demandedCarcassCount += 1;
  }

  /** Reset the demand and claimant chain of every carcass touched this tick. */
  clearCarcassDemand(): void {
    for (let i = 0; i < this.#demandedCarcassCount; i += 1) {
      const carcass = this.demandedCarcasses[i] as number;
      this.carcassDemand[carcass] = 0;
      this.carcassClaimHead[carcass] = -1;
    }
    this.#demandedCarcassCount = 0;
  }
}
