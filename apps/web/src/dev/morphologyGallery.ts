import {
  DEFAULT_CONFIG,
  MORPH_CHANNEL_STRIDE,
  MORPH_GENE_COUNT,
  MORPH_GENE_NAMES,
  MorphologyStore,
  Xoshiro128,
  createFounderMorphGenes,
  deriveMorphology,
  GenomeStore,
  mutateMorphologyGenes,
  writeMorphChannels,
  type MorphGene,
} from "@eon/engine";

/**
 * Sample bodies for the morphology gallery (M14, docs/11 §M14).
 *
 * The gallery exists to answer one question honestly: *does the morphology a
 * genome describes actually look like something, across the whole space the
 * engine can reach?* An illustration drawn by hand would answer a different
 * question, so every body here comes out of the production pipeline —
 * `createFounderMorphGenes` → `mutateMorphologyGenes` → `deriveMorphology` →
 * `writeMorphChannels` — and the renderer paints the resulting channel bytes
 * with the same function the detail layer uses.
 *
 * This module is pure and Pixi-free so it can be unit-tested in Node.
 */

/** One gallery entry: a labelled channel block. */
export interface GalleryBody {
  readonly label: string;
  readonly channels: Uint8Array;
  /** Generations of ordinary mutation between the founder and this body. */
  readonly generations: number;
}

/** Develop one morphological genome and encode it exactly as a snapshot would. */
function encode(genes: Uint16Array, hueDeg: number): Uint8Array {
  const genomes = new GenomeStore(1);
  genomes.morphGenes.set(genes, 0);
  const morphology = new MorphologyStore(1);
  deriveMorphology(morphology, genomes, 0, hueDeg, DEFAULT_CONFIG);
  const channels = new Uint8Array(MORPH_CHANNEL_STRIDE);
  writeMorphChannels(morphology, 0, channels, 0);
  return channels;
}

/**
 * A lineage: the founder body, then the same genome after successive rounds of
 * ordinary mutation.
 *
 * This is the view that shows inheritance rather than variety — consecutive
 * entries are parent and child, so a reader can see that a body drifts instead
 * of being redrawn.
 */
export function buildLineage(
  seed: number,
  steps: number,
  generationsPerStep: number,
): GalleryBody[] {
  const rng = Xoshiro128.fromSeed(seed);
  const genes = createFounderMorphGenes(DEFAULT_CONFIG.organism.morphology);
  const bodies: GalleryBody[] = [
    { label: "founder", channels: encode(genes, 120), generations: 0 },
  ];
  for (let step = 1; step <= steps; step += 1) {
    for (let generation = 0; generation < generationsPerStep; generation += 1) {
      mutateMorphologyGenes(genes, 0, rng, DEFAULT_CONFIG);
    }
    const generations = step * generationsPerStep;
    bodies.push({
      label: `+${generations} generations`,
      channels: encode(genes, 120),
      generations,
    });
  }
  return bodies;
}

/**
 * Independent lineages from one founder: what a population looks like after the
 * same number of generations along different random paths.
 */
export function buildRadiation(seed: number, lineages: number, generations: number): GalleryBody[] {
  const bodies: GalleryBody[] = [];
  for (let lineage = 0; lineage < lineages; lineage += 1) {
    // Vary the stream per lineage rather than the rules: every body here is
    // reachable by the same ordinary mutation the engine applies at a birth.
    const rng = Xoshiro128.fromSeed(seed + lineage * 7919);
    const genes = createFounderMorphGenes(DEFAULT_CONFIG.organism.morphology);
    for (let generation = 0; generation < generations; generation += 1) {
      mutateMorphologyGenes(genes, 0, rng, DEFAULT_CONFIG);
    }
    bodies.push({
      label: `lineage ${lineage + 1}`,
      channels: encode(genes, (lineage * 37) % 360),
      generations,
    });
  }
  return bodies;
}

/**
 * One body per extreme of a single locus, with everything else at the founder
 * value: the gallery's answer to "what does this gene do?".
 */
export function buildLocusSweep(gene: MorphGene, samples: number): GalleryBody[] {
  const bodies: GalleryBody[] = [];
  for (let i = 0; i < samples; i += 1) {
    const genes = createFounderMorphGenes(DEFAULT_CONFIG.organism.morphology);
    genes[gene] = Math.round((i / Math.max(1, samples - 1)) * 65535);
    bodies.push({
      label: `${MORPH_GENE_NAMES[gene] ?? `gene ${gene}`} ${Math.round((i / Math.max(1, samples - 1)) * 100)}%`,
      channels: encode(genes, 120),
      generations: 0,
    });
  }
  return bodies;
}

/** Every locus name, for the sweep selector. */
export function locusOptions(): { gene: MorphGene; name: string }[] {
  return Array.from({ length: MORPH_GENE_COUNT }, (_, index) => ({
    gene: index as MorphGene,
    name: MORPH_GENE_NAMES[index] ?? `gene ${index}`,
  }));
}
