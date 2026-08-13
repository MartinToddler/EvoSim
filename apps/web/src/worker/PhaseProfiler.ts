import { TICK_PHASE_COUNT, TickPhase, type TickPhaseId, type TickProfiler } from "@eon/engine";

/**
 * Host-side implementation of the engine's phase profiling hooks
 * (CLAUDE.md "Profiling").
 *
 * The engine says *where* it is; this says *when* that was. Keeping the clock
 * out here is what lets the engine be instrumented without ever calling a
 * wall-clock API — see `TickProfiler` in `@eon/engine`.
 *
 * ## Sampling, not continuous measurement
 *
 * At MAX speed a world can execute thousands of ticks per second. Timing every
 * phase boundary of every tick would mean tens of thousands of clock reads per
 * second — measurable overhead, on the exact path whose speed we are trying to
 * report. So one tick in every {@link SAMPLE_INTERVAL} is measured and the rest
 * are free: `begin`/`end` return immediately when the tick is not being
 * sampled.
 *
 * The reported number is therefore "mean milliseconds per *sampled* tick", and
 * a profile is a statistical picture rather than a total. That is the right
 * trade for the thing it is used for — finding which phase dominates — and the
 * alternative measures the observer instead of the system.
 */
export const SAMPLE_INTERVAL = 32;

export class PhaseProfiler implements TickProfiler {
  readonly #now: () => number;
  readonly #startedAt = new Float64Array(TICK_PHASE_COUNT);
  readonly #totalMs = new Float64Array(TICK_PHASE_COUNT);
  readonly #samples = new Uint32Array(TICK_PHASE_COUNT);
  #sampling = false;
  #tickIndex = 0;

  constructor(now: () => number) {
    this.#now = now;
  }

  /**
   * Called by the host before each `engine.step()`, deciding whether this tick
   * is sampled. Every phase within a tick shares one decision, so a sampled
   * profile always sums consistently.
   */
  beginTick(): void {
    this.#sampling = this.#tickIndex % SAMPLE_INTERVAL === 0;
    this.#tickIndex += 1;
    if (this.#sampling) {
      this.begin(TickPhase.Total);
    }
  }

  endTick(): void {
    if (this.#sampling) {
      this.end(TickPhase.Total);
    }
    this.#sampling = false;
  }

  begin(phase: TickPhaseId): void {
    if (!this.#sampling) {
      return;
    }
    this.#startedAt[phase] = this.#now();
  }

  end(phase: TickPhaseId): void {
    if (!this.#sampling) {
      return;
    }
    this.#accumulate(phase, this.#now() - (this.#startedAt[phase] as number));
  }

  /**
   * Measure a phase the engine does not run itself — render snapshot
   * production, which happens outside `step()` on the host's cadence.
   *
   * Unconditional: these are already low-frequency, so there is nothing to
   * sample away, and a snapshot that suddenly costs 20 ms is exactly the kind
   * of thing a profile must not hide.
   */
  recordHostPhase(phase: TickPhaseId, millis: number): void {
    this.#accumulate(phase, millis);
  }

  #accumulate(phase: TickPhaseId, millis: number): void {
    this.#totalMs[phase] = (this.#totalMs[phase] as number) + millis;
    this.#samples[phase] = (this.#samples[phase] as number) + 1;
  }

  /** Mean milliseconds per sampled tick, by phase; zero where nothing ran. */
  meanMillis(): number[] {
    const out = new Array<number>(TICK_PHASE_COUNT);
    for (let phase = 0; phase < TICK_PHASE_COUNT; phase += 1) {
      const samples = this.#samples[phase] as number;
      out[phase] = samples === 0 ? 0 : (this.#totalMs[phase] as number) / samples;
    }
    return out;
  }

  /** Drop accumulated measurements, keeping the sampling cursor. */
  resetWindow(): void {
    this.#totalMs.fill(0);
    this.#samples.fill(0);
  }
}
