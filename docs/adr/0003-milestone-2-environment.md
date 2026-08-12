# ADR 0003 — Milestone 2: procedural environment

Status: accepted · Date: 2026-08-12 · Engine 0.1.1 → 0.2.0 · Tasks C01–C09

Milestone 2 gives the engine a world: a deterministic procedural map, moisture, temperature,
fertility, biomes, a plant biomass field with logistic growth, and a founder region. `step()`
stops being empty — phase 1 of the tick order (docs/03 §7) now runs.

## 1. Value noise

docs/03 §15 asks for "deterministic project-owned integer lattice/value noise" without
specifying one. The implementation hashes lattice points from `(seed, salt, ix, iy)` and
interpolates bilinearly with smoothstep weights, entirely in Q integer math — the same reason
the trig LUT avoids `Math.sin`: a float-derived field could differ in the last bit between
platforms and silently fork a world.

Each field (three elevation octaves, moisture, temperature, fertility) draws from its own salt,
so they are independent rather than correlated views of one field, and none of them touches the
PRNG. **World generation makes no PRNG draws at all**, so the generator's state after
construction is exactly its seeded state regardless of how the map turned out.

Octave wavelengths must be powers of two, which the config validator enforces: it keeps the
lattice aligned to the grid so the fractional position inside a lattice cell is an exact Q value.

## 2. Calibration decisions, with the data behind them

Two constants are mine, not the specification's, and both were chosen by measurement over a
12-seed suite rather than by taste:

- **`edgeFalloffCells = 16`.** The border fade guarantees the ocean rim docs/03 §15 asks for,
  but its width decides how much land survives. Measured first-attempt validity: 40 cells →
  3/12 seeds valid; 32 → 5/12; 24 → 9/12; 16 → 10/12. A wide fade drowned most worlds and made
  retries the norm, which is exactly the "population always extinct"-class failure docs/07 §12
  warns about, one level up.
- **`waterInfluencePasses = 24`.** The moisture formula in docs/03 §16 averages ≈0.42 with a
  short water reach, below the 0.62 forest threshold, so forest was nearly absent (2.4% of
  cells, present in 7/12 seeds). Widening the coastal gradient to 24 cells gives wet coasts and
  dry interiors: forest in 9/12 seeds and all six biome classes represented on average. This is
  ecological texture the later milestones need, not cosmetics — thermal and dietary selection
  require somewhere to be different from somewhere else.

The temperature, fertility and capacity-suitability coefficients are also implementation
choices: docs/03 §§17-18 and §20 give the _shape_ of each formula and a target range, not
numbers. They live in `SimulationConfig` (`world.climate`, `world.fertility`,
`plants.capacitySuitability`) so they can be swept later. The generated temperature field spans
about -13 °C … +33 °C, matching the "roughly -15 °C to +35 °C" of docs/03 §17, and is verified
to be colder toward the poles.

Suitability curves are triangular rather than bell-shaped: exact in integer math, monotone, and
honest about being a modelling choice rather than a physical law.

## 3. A fractional growth accumulator — an addition to authoritative state

The docs/03 §14 array list does not include it; the implementation adds
`plantGrowthRemainderQ: Uint16Array` and hashes and serializes it.

The reason is a defect the first implementation had. Integer biomass with a truncated logistic
step means a cell whose true growth is below one unit per step grows by zero — forever. With
the docs/08 §5 numbers, a grassland cell needs ≈84 biomass before its growth rounds up to one
unit, and a mountain cell needs ≈683. The seed bank stops at
`plantMinRegenThreshold = 16`, so every cell grazed into that gap froze permanently, silently,
and only in some biomes. A regression test now drives every biome from a sparse start and
asserts it grows.

The fix carries the fraction between steps instead of rounding it away. The alternative —
forcing a minimum of one unit per step — was rejected because it would have made slow biomes
recover up to seven times faster than configured, biasing exactly the ecological differences
between biomes that the config is trying to express.

## 4. Founder region

docs/03 §26 asks for "a deterministic viable fertile land region". The implementation labels
connected land components by flood fill in ascending cell order, takes the largest (ties by
lowest label), and inside it picks the cell with the highest box-blurred plant capacity, blurred
over the founder spawn radius. Blurring matters: the single most fertile cell can be a one-cell
islet, while the blurred maximum is a genuinely productive neighbourhood. Ties break on lowest
cell index.

## 5. Validity and retry

A world is rejected — not repaired — when land fraction falls outside 35–70%, the largest
connected land component is too small, total plant capacity is too low, or fewer than three
biome classes are present. Retry uses a sub-seed derived from `(seed, attempt)`; attempt 0 uses
the seed unchanged, so "seed X gives world X" holds for every world valid on the first try,
which is the normal case. Exhausting `generationMaxRetries` throws with the per-attempt reasons
rather than shipping a degraded world.

All ten calibration seeds in the test suite produce a valid world, which is the MVP gate of
docs/07 §12 for world generation.

## 6. Performance

Measured on the development machine: world generation ≈90 ms, one environment update ≈2 ms
(1 ms growth + 1 ms gradient), 100 000 ticks ≈8 s. At 1× the environment updates once per
second, so it costs about 0.2% of the tick budget.

Three hot loops were rewritten after measurement, not before: the moisture dilation, the flood
fill and the gradient pass all allocated a four-element neighbour array per cell per pass —
about 1.5 million allocations per world — which CLAUDE.md's "no allocation in hot loops" rule
exists to prevent. Direct index arithmetic with explicit border tests cut generation from 122 ms
to 90 ms and preserved behaviour exactly (the founder region is unchanged).

## 7. Soak test shape

Milestone 2 acceptance asks for a 100k-tick environment soak. It asserts invariants (no biomass
above capacity, no remainder out of range, no vegetation in water, growth saturating rather than
running away) and pins the final state hash.

Determinism is checked against that recorded hash rather than by running a second engine: it
halves the runtime and is strictly stronger, because a golden also catches drift between
platforms and engine versions, which two runs in one process cannot. The CI determinism matrix
runs it on macOS, Windows and Node 24.

`vitest.config.ts` now sets a 60 s default test timeout. The acceptance tests generate whole
worlds and run thousands of authoritative ticks; the default 5 s budget failed them for being
slow rather than for being wrong.

## 8. Versioning

| Constant                  | Change            | Reason                                                                                                                                                             |
| ------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ENGINE_VERSION`          | 0.1.1 → **0.2.0** | The canonical hash stream now includes the environment arrays, and `step()` runs a phase.                                                                          |
| `CONFIG_SCHEMA_VERSION`   | 2 → **3**         | New `world.generation`, `world.validity`, `world.moisture`, `world.climate`, `world.fertility`, `plants.initialBiomassFractionQ` and `plants.capacitySuitability`. |
| `SNAPSHOT_SCHEMA_VERSION` | 2 → **3**         | Snapshots carry the environment arrays and the founder region.                                                                                                     |
| `PROTOCOL_VERSION`        | unchanged (1)     | No wire shape changed.                                                                                                                                             |

All golden hashes were regenerated, and the frozen inventory of hashed config fields grew from
113 to 140 entries.

## 9. Explicitly not done

No organisms. No SoA organism store, genome, brain, sensing, movement, spatial hash or feeding —
those are Milestone 3 (tasks D01–D13). The founder region is _selected_ and stored, but nothing
spawns into it yet. `internal.ts` still exposes exactly one member (`rng`) and has no phase
callers.
