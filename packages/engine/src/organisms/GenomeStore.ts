import { assert } from "@eon/shared";
import { HASH_TAG, type StateHash } from "../math/hash";
import { BRAIN_WEIGHT_COUNT } from "../brain/BrainLayout";
import { GENE_COUNT } from "../genetics/genes";

/**
 * Inherited state: 16 ecological genes and 400 brain weights per slot
 * (docs/10 §7, task D02).
 *
 * Both are packed into one flat TypedArray each, indexed by
 * `slot * stride + field`, so copying a parent's genome to a child is a single
 * `TypedArray.set` over a subarray rather than 416 property reads.
 *
 * Slots here line up 1:1 with {@link OrganismStore} slots.
 */
export class GenomeStore {
  readonly capacity: number;
  /** `capacity * GENE_COUNT` quantized ecological genes. */
  readonly genes: Uint16Array;
  /** `capacity * BRAIN_WEIGHT_COUNT` Int16 network weights. */
  readonly brainWeights: Int16Array;

  constructor(capacity: number) {
    assert(
      Number.isSafeInteger(capacity) && capacity > 0,
      `genome capacity must be positive, got ${capacity}`,
    );
    this.capacity = capacity;
    this.genes = new Uint16Array(capacity * GENE_COUNT);
    this.brainWeights = new Int16Array(capacity * BRAIN_WEIGHT_COUNT);
  }

  /** Offset of a slot's gene block. */
  geneOffset(slot: number): number {
    return slot * GENE_COUNT;
  }

  /** Offset of a slot's weight block. */
  weightOffset(slot: number): number {
    return slot * BRAIN_WEIGHT_COUNT;
  }

  /** Read one gene. */
  gene(slot: number, gene: number): number {
    return this.genes[slot * GENE_COUNT + gene] as number;
  }

  /** Overwrite a slot's genome and brain from external arrays. */
  writeGenome(slot: number, genes: ArrayLike<number>, weights: ArrayLike<number>): void {
    assert(genes.length === GENE_COUNT, `expected ${GENE_COUNT} genes, got ${genes.length}`);
    assert(
      weights.length === BRAIN_WEIGHT_COUNT,
      `expected ${BRAIN_WEIGHT_COUNT} weights, got ${weights.length}`,
    );
    this.genes.set(genes, this.geneOffset(slot));
    this.brainWeights.set(weights, this.weightOffset(slot));
  }

  /** Copy one slot's genome and brain onto another (the child's starting point). */
  copyGenome(fromSlot: number, toSlot: number): void {
    const geneFrom = this.geneOffset(fromSlot);
    this.genes.set(this.genes.subarray(geneFrom, geneFrom + GENE_COUNT), this.geneOffset(toSlot));
    const weightFrom = this.weightOffset(fromSlot);
    this.brainWeights.set(
      this.brainWeights.subarray(weightFrom, weightFrom + BRAIN_WEIGHT_COUNT),
      this.weightOffset(toSlot),
    );
  }

  /** Zero a slot's genome and brain; called when its organism dies. */
  clearSlot(slot: number): void {
    this.genes.fill(0, this.geneOffset(slot), this.geneOffset(slot) + GENE_COUNT);
    this.brainWeights.fill(
      0,
      this.weightOffset(slot),
      this.weightOffset(slot) + BRAIN_WEIGHT_COUNT,
    );
  }

  /**
   * Hash the used prefix of both arrays (see OrganismStore.hashInto for why a
   * prefix is enough). Genomes are authoritative: they are inherited state,
   * not a derived cache.
   */
  hashInto(hasher: StateHash, usedSlots: number): void {
    hasher.array(HASH_TAG.u16, this.genes.subarray(0, usedSlots * GENE_COUNT));
    hasher.array(HASH_TAG.i16, this.brainWeights.subarray(0, usedSlots * BRAIN_WEIGHT_COUNT));
  }
}
