/**
 * Plant resource channels (M17, docs/11 §M17).
 *
 * Milestones 0–16 had one edible field — "plant biomass" — plus carcass meat.
 * A world with a single plant resource has a single plant strategy: eat more of
 * it. There is nothing for a lineage to specialize *into*, so morphology and
 * brains had nothing ecological to differentiate over and every place offered
 * the same living in a different quantity.
 *
 * M17 splits the plant field into five channels that differ in **what it costs
 * to get at them** and **where they grow**, and leaves meat exactly where it
 * was. Six channels in total, bounded at compile time, stored as five
 * `Uint16Array`s of `cellCount` each rather than five arrays per cell.
 *
 * ## These are resources, not diets
 *
 * The names describe the *food*, never the eater. ADR 0027 forbids the engine
 * from holding a category that decides behaviour, and "this cell holds 3000
 * units of roots" is a fact about the cell. There is no `Grazer`, `Browser` or
 * `Frugivore` anywhere in the engine, no enum with those names, and no branch
 * that asks what kind of eater an organism is. What an organism gets out of a
 * channel is a continuous number derived from its genome, and every organism
 * can eat every channel — badly, if it is badly matched.
 *
 * That last point is load-bearing and was learned the hard way. The original
 * carcass rule was a categorical gate ("you may only eat meat if your meat
 * efficiency beats your plant efficiency") and it created a measured fitness
 * valley that made scavenging intermediates unreachable (ADR 0021 §5d, ADR
 * 0025). A gate of the form "you cannot process this" is that same defect with
 * a different noun. Poorly matched food is edible, badly.
 *
 * ## Why five, and why these five
 *
 * Each channel exists to make a *different* thing expensive, so that no single
 * body plan or genome is best at all of them:
 *
 * ```text
 *   Foliage    common, cheap, fast regrowth      — the Milestone 0-16 field
 *   Browse     dense and tough                   — costs bite force
 *   Fruit      concentrated and slow to return   — costs travel
 *   Roots      persistent, hidden                — costs excavation effort
 *   Defended   rich but toxic                    — costs resistance, or health
 * ```
 *
 * A channel whose cost could be paid with the same trait as another channel's
 * would be decoration: two names for one niche. The four costs are deliberately
 * paid from four different budgets — mouth morphology, movement, limb
 * morphology and a metabolic gene — so that being good at one does not come
 * with being good at the next.
 */

/** The channels an organism can eat from. Meat is last and is not a cell field. */
export const Resource = {
  /** Low vegetation: everywhere, cheap to process, grows back quickly. */
  Foliage: 0,
  /** Tough vegetation: dense and abundant where it grows, but hard to bite. */
  Browse: 1,
  /** Concentrated growth: high value per unit, low capacity, slow to return. */
  Fruit: 2,
  /** Below ground: persists where nothing else does, but has to be dug out. */
  Roots: 3,
  /** Chemically defended: the richest plant channel, and it fights back. */
  Defended: 4,
  /** Carcass meat — the existing predation and scavenging path, unchanged. */
  Meat: 5,
} as const;

export type Resource = (typeof Resource)[keyof typeof Resource];

/** Channels stored as environment fields. Meat lives in `CarcassStore`. */
export const PLANT_RESOURCE_COUNT = 5;

/** Every channel an organism has a processing efficiency for. */
export const RESOURCE_COUNT = 6;

/** Human-readable channel names, indexed by value. Diagnostics and DTOs. */
export const RESOURCE_NAMES: readonly string[] = [
  "foliage",
  "browse",
  "fruit",
  "roots",
  "defended",
  "meat",
];

/**
 * Where one channel's field starts inside the flat per-cell arrays.
 *
 * Resource-major (`resource * cellCount + cell`) rather than cell-major, because
 * growth, capacity recomputation and the statistics sweep all walk one channel
 * across every cell. Cell-major would stride those loops by five and waste most
 * of every cache line; the only pass that wants all five of one cell is feeding,
 * which touches one cell per organism and pays a predictable five-way gather
 * either way.
 */
export function resourceOffset(resource: number, cellCount: number): number {
  return resource * cellCount;
}
