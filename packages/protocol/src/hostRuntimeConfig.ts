/**
 * Host runtime configuration — everything that shapes HOSTING of a simulation
 * rather than the simulation itself.
 *
 * Why this is not part of SimulationConfig (docs/02 §9, docs/08 §3):
 * authoritative state must be a pure function of seed + config + commands +
 * engine version, and the engine's canonical state hash covers its config. If
 * wall-clock pacing lived in that config, changing the render snapshot rate
 * from 15 Hz to 20 Hz would change every world hash even though not a single
 * organism behaved differently. Splitting the two keeps "same hash" meaning
 * "same evolution".
 *
 * These values live in @eon/protocol because the Worker host is their consumer:
 * they travel with INIT_NEW_WORLD/LOAD_WORLD and configure scheduling, render
 * cadence and autosave. The pure engine never sees them — it knows nothing
 * about Workers, browsers or real time (docs/02 §3).
 *
 * Defaults are the v0.1 values from docs/08 §3-4.
 */
export interface HostRuntimeConfig {
  schemaVersion: number;

  /** Wall-clock pacing target at 1× (docs/02 §8). */
  targetTicksPerSecond1x: number;
  /** Render snapshot rate at normal speeds. */
  normalRenderSnapshotsPerSecond: number;
  /** Render snapshot rate in MAX mode. */
  maxModeRenderSnapshotsPerSecond: number;
  /** MAX-mode worker batch slice budget in milliseconds before yielding. */
  maxWorkerSliceMs: number;

  /**
   * Autosave check cadence in ticks. Persistence is a host action: it copies
   * authoritative state out, it never changes it, so this cannot affect a
   * world's evolution.
   */
  autosaveCheckInterval: number;

  /**
   * Ticks per simulated year — a display divisor for "year N" in the UI and
   * statistics labels. No authoritative rule consumes it. If a future feature
   * ever makes years ecologically meaningful (seasons, for example), it must
   * move back into SimulationConfig with a CONFIG_SCHEMA_VERSION bump, because
   * it would then affect state.
   */
  ticksPerSimYear: number;

  /** Maximum organisms promoted to the detailed render layer (docs/06 §3). */
  maxDetailedRenderedOrganisms: number;

  /**
   * Vegetation field rate. docs/06 §2 puts plant display at ~2-5 Hz: biomass
   * only changes when the environment phase runs, and a 64 KB field is far too
   * big to resend at frame rate for something that moves this slowly.
   */
  vegetationSnapshotsPerSecond: number;

  /** HUD telemetry rate. Every one of these is a React render, so it is low. */
  telemetrySnapshotsPerSecond: number;

  /**
   * Largest tick debt the scheduler will try to repay after falling behind.
   *
   * A backgrounded tab accrues wall-clock time it never got to spend. Without a
   * ceiling it would come back owing thousands of ticks and sprint through them
   * at full CPU; with one it resumes from where it is and reports that it fell
   * behind. This changes *when* ticks happen, never what they do.
   */
  maxCatchUpTicks: number;

  /**
   * Hard cap on ticks executed in one scheduler slice.
   *
   * The slice normally ends on its millisecond budget. This is the backstop for
   * when the clock does not advance between reads — a coarse timer, or a fake
   * clock in a test — where a purely time-based loop would never terminate.
   */
  maxTicksPerSlice: number;

  /**
   * Render snapshot buffers in the recycling pool (docs/02 §10).
   *
   * Three is the smallest number that keeps the Worker busy while the renderer
   * holds one: one being filled, one in flight, one held for hit-testing. Fewer
   * causes avoidable dropped snapshots; more just costs memory.
   */
  renderBufferPoolSize: number;
}

/**
 * Bumped to 2 for Milestone 6: the worker host needs cadences and scheduling
 * bounds that did not exist when this shape was first written. Nothing here is
 * authoritative, so this bump cannot change a single world hash — which is
 * precisely why these values live in this file and not in `SimulationConfig`
 * (ADR 0002 §4).
 */
export const HOST_RUNTIME_CONFIG_SCHEMA_VERSION = 2;

export const DEFAULT_HOST_RUNTIME_CONFIG: HostRuntimeConfig = Object.freeze({
  schemaVersion: HOST_RUNTIME_CONFIG_SCHEMA_VERSION,
  targetTicksPerSecond1x: 20,
  normalRenderSnapshotsPerSecond: 15,
  maxModeRenderSnapshotsPerSecond: 5,
  maxWorkerSliceMs: 10,
  autosaveCheckInterval: 2000,
  ticksPerSimYear: 2000,
  maxDetailedRenderedOrganisms: 250,
  vegetationSnapshotsPerSecond: 4,
  telemetrySnapshotsPerSecond: 2,
  maxCatchUpTicks: 200,
  maxTicksPerSlice: 2048,
  renderBufferPoolSize: 3,
});
