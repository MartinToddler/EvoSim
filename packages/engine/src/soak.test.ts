import { describe, expect, it } from "vitest";
import { SimulationEngine } from "./SimulationEngine";
import {
  NO_SOAK_VIOLATIONS,
  SOAK_CONFIG,
  SOAK_FOUNDERS,
  SOAK_SEED,
  checkSoakInvariants,
  deathsByCauseTotal,
  measureBrainDrift,
} from "./fixtures/soakWorld";
import { engineFromSnapshot } from "./snapshot/deserialize";
import { totalPlantBiomass, totalPlantCapacity } from "./world/plants";

/**
 * 100 000-tick evolutionary soak (task E07; docs/07 §6, Milestone 4 acceptance
 * "multiple generations; 100k soak; deterministic replay").
 *
 * docs/07 §6 asks a soak to prove the absence of six things over a long run: no
 * invalid numbers, no count corruption, no ID collision, no dead-entity leak,
 * snapshots that still round-trip, and a repeatable hash. Milestone 4 adds the
 * pressure that makes those failures reachable — every tick can now allocate and
 * release slots, so 100 000 ticks churn through tens of thousands of identities.
 *
 * The world and the invariant sweep both live in `fixtures/soakWorld`, shared
 * with the 1 000 000-tick release soak (`pnpm soak:long`, task L06), so the long
 * run checks exactly what this one checks (docs/07 §6 asks for both).
 */

const SOAK_TICKS = 100_000;

/**
 * State hash after 100 000 ticks of the soak world. Regenerate together with the
 * golden fixture whenever ENGINE_VERSION changes.
 *
 * Engine 0.7.0 moved it with no ecological change: the founder region and the
 * (empty) command log joined the canonical stream, event payloads became
 * signed 32-bit words, and the config digest gained the interventions section.
 * No command ever runs in this world — the population trajectory is unchanged
 * from 0.6.0, exactly as 0.6.0's was from 0.5.0. Notable, still: 100 000 ticks
 * of real evolution end with ONE species — the evolved diversity is a
 * continuous cloud, and the detector correctly refuses to split a cloud
 * (docs/05 §7); the synthetic split fixtures prove the other direction.
 */
const GOLDEN_SOAK_HASH = "a7e2b5e223c8657a";

describe("100k tick evolutionary soak (task E07)", () => {
  // This is a HANG DETECTOR, not a performance assertion: docs/07 §8 forbids
  // enforcing an arbitrary CI wall clock on unknown hardware, which is the rule
  // ADR 0007 §1 had to restate after a 300 s budget failed `pnpm verify` without
  // any hash being wrong.
  //
  // Measured on the Milestone 5 machine: ~1 810 s standalone, and 1 881 s inside
  // the parallel suite, where it competes with the 10 000-tick golden fixture and
  // the two acceptance suites. Milestone 5 is what made it expensive — carrion
  // sensing scales with population x carcass density, and this world packs up to
  // 4 096 carcasses into 2 304 spatial cells (ADR 0008 §7) — so the 1 800 000 ms
  // budget that fitted Milestone 4's ~350 s soak now trips on the real thing.
  //
  // 5 400 000 ms keeps roughly 3x headroom over the observed cost, the same ratio
  // ADR 0007 chose for the global budget.
  it(
    "runs 100k ticks of live evolution without corruption and reproduces its hash",
    { timeout: 5_400_000 },
    () => {
      const engine = new SimulationEngine({ seed: SOAK_SEED, config: SOAK_CONFIG });
      const { environment, organisms } = engine;
      const capacity = totalPlantCapacity(environment);
      const seenIds = new Set<number>();

      let peakPopulation = organisms.liveCount;
      let peakGeneration = 0;
      let troughPopulation = organisms.liveCount;
      // Swept every 997 ticks: prime, so the samples never line up with the
      // 20-tick environment cadence or the 40-tick reproduction cooldown.
      const CHECK_EVERY = 997;

      for (let done = 0; done < SOAK_TICKS; done += CHECK_EVERY) {
        engine.stepMany(Math.min(CHECK_EVERY, SOAK_TICKS - done));

        const violations = checkSoakInvariants(engine, seenIds);
        expect(`tick ${engine.tick}: ${JSON.stringify(violations)}`).toBe(
          `tick ${engine.tick}: ${JSON.stringify(NO_SOAK_VIOLATIONS)}`,
        );

        peakPopulation = Math.max(peakPopulation, organisms.liveCount);
        troughPopulation = Math.min(troughPopulation, organisms.liveCount);
        for (let slot = 0; slot < organisms.slotHighWater; slot += 1) {
          if (organisms.alive[slot] === 1) {
            peakGeneration = Math.max(peakGeneration, organisms.generation[slot] as number);
          }
        }
      }

      expect(engine.tick).toBe(SOAK_TICKS);
      // Determinism is pinned against a recorded hash rather than by running a
      // second engine: it halves the time and is strictly stronger, because a
      // golden also catches drift across platforms and engine versions, which
      // two runs in the same process cannot.
      const soakHash = engine.computeStateHash();

      // --- Environment invariants -----------------------------------------
      // Per-cell capacity, remainder range and vegetated-water checks now run
      // inside `checkSoakInvariants` on EVERY sweep rather than once here, so
      // a cell that overfilled mid-run and drained again can no longer pass.
      const finalBiomass = totalPlantBiomass(environment);
      expect(finalBiomass).toBeGreaterThanOrEqual(0);
      expect(finalBiomass).toBeLessThanOrEqual(capacity);

      // --- Evolution actually happened -----------------------------------
      // Deliberately loose: docs/07 §1 forbids asserting a specific
      // evolutionary story, so these only claim that the machinery ran.
      expect(organisms.totalBirths).toBeGreaterThan(SOAK_FOUNDERS * 20);
      expect(organisms.totalDeaths).toBeGreaterThan(SOAK_FOUNDERS * 10);
      expect(peakGeneration).toBeGreaterThan(20);
      expect(peakPopulation).toBeGreaterThan(SOAK_FOUNDERS * 4);
      // The lineage survives the whole run: a soak of an extinct world would
      // silently stop testing anything after the last death.
      expect(organisms.liveCount).toBeGreaterThan(0);
      // And it boom-crashes rather than sitting at one density. That is what makes
      // this world the right soak subject: slots are recycled in bulk, repeatedly,
      // which is the pressure the identity and free-list invariants above exist to
      // survive.
      expect(troughPopulation).toBeLessThan(peakPopulation / 4);

      // Deaths are fully attributed, and no cause counter overflowed.
      expect(deathsByCauseTotal(engine)).toBe(organisms.totalDeaths);

      // Entity IDs are monotonic and never reused: every birth consumed exactly
      // one, so the counter and the birth total agree forever.
      expect(organisms.nextEntityId).toBe(organisms.totalBirths + 1);

      // --- Mutation has not destroyed the brains (docs/07 §12) ------------
      // docs/07 §12 lists "mutation destroys brain too fast" as a calibration
      // failure to monitor, and this run is the deepest lineage the suite has:
      // sixty-odd generations of accumulated brain mutation. The observable is
      // whether a surviving controller still resembles the founder controller it
      // descends from, measured as cosine similarity against the founder weight
      // vector — 1.0 is the founder brain, 0.0 an unrelated one.
      //
      // Both bounds are deliberately loose, because docs/07 §1 forbids asserting
      // an evolutionary story: they separate "drifting under selection" from
      // "erased", nothing finer. An unrelated 400-dimensional brain would score
      // about 1/sqrt(400) = 0.05, so 0.2 is four times the noise floor. Measured
      // on this world during the Milestone 4 review: 0.976 at generation 8, 0.947
      // at 16 and 0.873 at 34, with the worst individual still at 0.824 and
      // 0.0008% of weights on the clamp (ADR 0007 §3).
      const drift = measureBrainDrift(engine);
      expect(drift.brainsMeasured).toBe(organisms.liveCount);
      expect(drift.meanSimilarity).toBeGreaterThan(0.2);
      // The other half of the failure mode: weights piling onto the clamp would
      // mean the sigma is saturating brains rather than exploring with them.
      expect(drift.clampedFraction).toBeLessThan(0.05);

      expect(soakHash).toBe(GOLDEN_SOAK_HASH);

      // --- Snapshots still round-trip after 100k ticks --------------------
      const restored = engineFromSnapshot(engine.serialize());
      expect(restored.computeStateHash()).toBe(soakHash);
      expect(restored.organisms.freeCount).toBe(organisms.freeCount);
      expect(restored.organisms.nextEntityId).toBe(organisms.nextEntityId);
      // Resuming a 100 000-tick save must continue identically, which is the
      // part a hash comparison at the snapshot tick alone cannot prove.
      restored.stepMany(500);
      engine.stepMany(500);
      expect(restored.computeStateHash()).toBe(engine.computeStateHash());
    },
  );
});
