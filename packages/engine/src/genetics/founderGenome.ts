import { Q } from "../math/fixed";
import { GENE_COUNT, Gene, HUE_DEGREES, geneFromQ } from "./genes";
import { RESOURCE_COUNT, Resource } from "../world/resources";

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

  // M17 processing loci, chosen so the founder's FOLIAGE and MEAT efficiencies
  // are bit-for-bit the plant and meat efficiencies the single `diet` locus
  // gave it through Milestone 16. docs/08 §19 specified that founder as diet
  // -0.60, which resolved to 0.84 on plants and 0.36 on meat; efficiency is
  // `floor + span × process²`, so the loci that reproduce those are
  // sqrt(0.80) ≈ 0.894 and sqrt(0.25) = 0.50. Preserving them exactly is what
  // keeps the ecology Milestones 0-13 calibrated intact across the split.
  genes[Gene.Process + Resource.Foliage] = 3663; // 0.894 → 0.84 on foliage
  genes[Gene.Process + Resource.Meat] = 2048; // 0.50  → 0.36 on meat

  // The four channels the founder has never met sit exactly where its meat
  // ability sits: mediocre, not absent. Absent would be a categorical gate
  // wearing a number, and a founder that cannot touch four of six channels
  // makes every intermediate toward them start from zero return (docs/11 §M17,
  // "poorly matched food is still edible, badly").
  genes[Gene.Process + Resource.Browse] = 2048;
  genes[Gene.Process + Resource.Fruit] = 2048;
  genes[Gene.Process + Resource.Roots] = 2048;
  genes[Gene.Process + Resource.Defended] = 2048;

  // No resistance at all: the founder pays full price for defended growth, so
  // resistance is something a lineage buys rather than something it starts with.
  genes[Gene.ToxinResistance] = 0;
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

/**
 * The founder's total processing investment, summed over all six channels.
 *
 * The free allowance for M17's digestive upkeep. Derived from
 * {@link FOUNDER_GENE_Q} rather than written down, so a later milestone that
 * moves a founder processing locus cannot silently leave the allowance behind
 * and start charging the founder for being itself.
 */
export const FOUNDER_PROCESS_TOTAL_Q: number = (() => {
  let total = 0;
  for (let resource = 0; resource < RESOURCE_COUNT; resource += 1) {
    total += FOUNDER_GENE_Q[Gene.Process + resource] as number;
  }
  return total;
})();
