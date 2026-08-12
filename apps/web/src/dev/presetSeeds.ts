/**
 * Preset seeds for the environment debug view.
 *
 * These are debugging entry points, not a curated gallery: each one was picked
 * because it exercises a different corner of world generation, so a developer can
 * reach an interesting case without hunting for a seed. `note` describes what the
 * seed produces under the CURRENT `ENGINE_VERSION` and `DEFAULT_CONFIG` — a
 * generation change can invalidate a note, so `presetSeeds.test.ts` asserts the
 * structural claims (all presets valid, the retry preset really retries) and will
 * fail rather than let the UI describe a world that no longer exists.
 */
export interface PresetSeed {
  readonly label: string;
  readonly seed: number;
  readonly note: string;
}

/** The mandatory deterministic fixture seed (CLAUDE.md, docs/07 §3). */
export const FIXTURE_SEED = 0xe0a12026;

/** Preset whose first generation attempt is rejected; see presetSeeds.test.ts. */
export const RETRY_PRESET_SEED = 0x0000002a;

export const PRESET_SEEDS: readonly PresetSeed[] = [
  {
    label: "Golden fixture",
    seed: FIXTURE_SEED,
    note:
      "The seed every golden state hash is pinned to. A dry interior with desert and tundra; " +
      "forest is technically present but only on a handful of cells, so the map reads as five " +
      "classes.",
  },
  {
    label: "Forest belt",
    seed: 0x00000001,
    note: "The most productive of the sampled seeds: high fertility and a broad forest band.",
  },
  {
    label: "Retry path",
    seed: RETRY_PRESET_SEED,
    note: "First generation attempt is rejected as invalid; the world comes from a derived sub-seed.",
  },
  {
    label: "Ocean world",
    seed: 0x000003e8,
    note: "Land share close to the 0.35 validity floor — fragmented coasts and islands.",
  },
  {
    label: "Mountain spine",
    seed: 0xe0a19be2,
    note: "An unusually large share of mountain cells, so cold high ground dominates the interior.",
  },
  {
    label: "No desert",
    seed: 0x00c0ffee,
    note: "Only five biome classes are present; useful for checking the biome rule order.",
  },
];
