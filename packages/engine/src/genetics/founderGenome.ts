import { Q } from "../math/fixed";
import { GENE_COUNT, Gene, HUE_DEGREES, geneFromQ } from "./genes";

/**
 * Founder ecological genome (docs/08 §19, task D07).
 *
 * "Deliberately middle-of-road and herbivore leaning" — viable but mediocre,
 * with room left for faster, slower, bigger, sharper-eyed, carnivorous and
 * differently paced descendants (docs/07 §15). It is an ordinary inheritable
 * genome: nothing about a founder is special after it spawns, and no code path
 * grants it a survival bonus.
 *
 * Values are the normalized `geneQ` targets from docs/08 §19; the stored Uint16
 * genome is derived from them, so the table stays readable in the units the
 * specification uses.
 *
 * Changing any value here changes evolutionary history from tick 0 and is an
 * ENGINE_VERSION event (docs/08 §21).
 */
export const FOUNDER_GENE_Q: readonly number[] = (() => {
  const genes = new Array<number>(GENE_COUNT).fill(0);
  genes[Gene.AdultSize] = 1843; // 0.45
  genes[Gene.MaxSpeed] = 2048; // 0.50
  genes[Gene.Acceleration] = 2048; // 0.50
  genes[Gene.TurnRate] = 2253; // 0.55
  genes[Gene.VisionRange] = 2048; // 0.50
  genes[Gene.VisionFov] = 2048; // 0.50
  // docs/08 §19 gives diet as the signed value -0.60; stored genes are
  // unsigned, and dietSignedQ maps geneQ g onto 2g - Q, so g = (signed + Q)/2.
  genes[Gene.Diet] = (Q - 2458) >> 1; // signed -2458 → geneQ 819
  genes[Gene.AttackPower] = 410; // 0.10
  genes[Gene.Armor] = 614; // 0.15
  genes[Gene.MetabolicPace] = 2048; // 0.50
  // docs/08 §19 insists this is explicit rather than matched to the spawn
  // region, so thermal selection can act across geography from the first tick.
  // +18 °C on the -10 … +35 °C range: (1800 + 1000) / 4500 of the way up.
  genes[Gene.ThermalOptimum] = Math.trunc((2800 * Q) / 4500); // 2548 → +17.99 °C
  genes[Gene.ThermalTolerance] = 2048; // 0.50 → 13.5 °C
  genes[Gene.MaturityAge] = 1638; // 0.40 → relatively early
  genes[Gene.MaxAge] = 2048; // 0.50
  genes[Gene.OffspringInvestment] = 1843; // 0.45
  genes[Gene.Hue] = Math.trunc((120 * Q) / HUE_DEGREES); // green, 120°
  return genes;
})();

/** The founder genome as stored Uint16 gene values. */
export function createFounderGenes(): Uint16Array {
  const genes = new Uint16Array(GENE_COUNT);
  for (let i = 0; i < GENE_COUNT; i += 1) {
    genes[i] = geneFromQ(FOUNDER_GENE_Q[i] as number);
  }
  return genes;
}
