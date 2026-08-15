import type { TelemetryDto, WorldDisplayDto } from "@eon/protocol";
import { formatInt } from "../format";

/**
 * Development performance HUD (tasks L02-L04, docs/06 §18, docs/07 §§8, 11).
 *
 * CLAUDE.md requires per-phase instrumentation from the first vertical slice,
 * and Milestone 6 built the measurement: the engine reports phase boundaries,
 * the Worker host times them, and `TelemetryDto.phaseMillis` has carried the
 * result since protocol 3. Until now nothing displayed it, so the only way to
 * read a profile was a benchmark run in Node — which cannot see the renderer,
 * the transport, or a real device. This panel closes that gap, which is what
 * makes the docs/07 §8 budgets checkable in the place they are written for.
 *
 * ## What it shows and why each number is here
 *
 * - **Tick budget.** docs/07 §8: mean tick ideally < 25 ms, must be < 50 ms to
 *   sustain 20 TPS at 1×. The mean is shown against those two thresholds
 *   rather than as a bare number, because a millisecond count means nothing
 *   without the budget it is spending.
 * - **Phase breakdown.** The optimization order in docs/07 §10 begins with
 *   "profile"; this is that profile, sorted by cost so the hotspot is the top
 *   line.
 * - **Render.** Frame rate, drawn organisms and how many of them got the
 *   detail layer (docs/06 §3 LOD), so a slow frame can be attributed to draw
 *   volume rather than guessed at.
 * - **Transport.** Buffers in flight and dropped snapshots: a rising drop count
 *   is back-pressure, which is correct behaviour (docs/02 §10) and invisible
 *   without a counter.
 * - **Memory.** docs/07 §11's watch list, per category, from the Worker.
 *
 * ## It is a projection, at telemetry cadence
 *
 * Every number arrives on the ~2 Hz telemetry stream except the renderer's,
 * which the app polls at the same cadence while this panel is open. Nothing
 * here samples per frame or per tick, so opening the HUD cannot itself change
 * what it measures (CLAUDE.md React boundary).
 */

/** The renderer's own frame counters, polled by the app while this is open. */
export interface RenderPerformanceView {
  fps: number;
  drawnOrganisms: number;
  drawnCarcasses: number;
  detailedOrganisms: number;
  zoom: number;
}

export interface PerformancePanelProps {
  telemetry: TelemetryDto | null;
  render: RenderPerformanceView | null;
  /** Phase names indexing `phaseMillis`; null before the world is ready. */
  display: WorldDisplayDto | null;
  /** Retained chart samples on the main thread, for the docs/07 §11 watch. */
  chartSamples: number;
}

/**
 * docs/07 §8 tick budgets at 5 000 organisms on a modern desktop. They are
 * display thresholds only — nothing asserts them, because docs/07 §8 forbids
 * enforcing a wall clock on unknown hardware.
 */
const TICK_BUDGET_GOOD_MS = 25;
const TICK_BUDGET_LIMIT_MS = 50;

/** docs/07 §8: main render average target for 60 FPS. */
const FRAME_BUDGET_MS = 16.7;

function formatMillis(value: number): string {
  if (value >= 100) return value.toFixed(0);
  if (value >= 10) return value.toFixed(1);
  return value.toFixed(2);
}

function formatBytes(bytes: number): string {
  const KIB = 1024;
  const MIB = KIB * 1024;
  if (bytes < KIB) return `${bytes} B`;
  if (bytes < MIB) return `${(bytes / KIB).toFixed(0)} KiB`;
  return `${(bytes / MIB).toFixed(1)} MiB`;
}

/** Which budget band a mean tick falls in; drives the status word and class. */
function tickBudgetState(meanMillis: number): { label: string; tone: "ok" | "warn" | "over" } {
  if (meanMillis <= TICK_BUDGET_GOOD_MS) return { label: "within target", tone: "ok" };
  if (meanMillis <= TICK_BUDGET_LIMIT_MS) return { label: "above target", tone: "warn" };
  return { label: "over budget", tone: "over" };
}

export function PerformancePanel(props: PerformancePanelProps): React.JSX.Element {
  const { telemetry, render } = props;

  // The engine's Total phase is opened by the host around the whole tick, so it
  // IS the mean tick; the rest are its parts.
  const phases = telemetry?.phaseMillis ?? [];
  const phaseNames = props.display?.tickPhaseLabels ?? [];
  const totalIndex = phaseNames.indexOf("total");
  const meanTickMillis = phases[totalIndex] ?? 0;
  const budget = tickBudgetState(meanTickMillis);

  const parts = phases
    .map((millis, index) => ({ name: phaseNames[index] ?? `phase ${index}`, millis }))
    .filter((entry) => entry.name !== "total" && entry.millis > 0)
    .sort((a, b) => b.millis - a.millis);

  const frameMillis = render !== null && render.fps > 0 ? 1000 / render.fps : 0;

  return (
    <aside className="perf-panel" aria-label="Performance">
      <h2>Performance</h2>

      <section className="perf-section">
        <h3>Tick</h3>
        <p className={`perf-headline perf-${budget.tone}`}>
          {meanTickMillis > 0 ? `${formatMillis(meanTickMillis)} ms` : "—"}
          <span className="perf-note">
            {" "}
            mean, {budget.label} (target {TICK_BUDGET_GOOD_MS} ms, limit {TICK_BUDGET_LIMIT_MS} ms)
          </span>
        </p>
        <dl className="perf-grid">
          <div>
            <dt>Achieved</dt>
            <dd>
              {telemetry === null ? "—" : `${telemetry.achievedTicksPerSecond.toFixed(1)} TPS`}
            </dd>
          </div>
          <div>
            <dt>Target</dt>
            <dd>
              {telemetry === null
                ? "—"
                : telemetry.targetTicksPerSecond === null
                  ? "unpaced (MAX)"
                  : `${telemetry.targetTicksPerSecond.toFixed(0)} TPS`}
            </dd>
          </div>
          <div>
            <dt>Keeping up</dt>
            <dd>{telemetry === null ? "—" : telemetry.behindTarget ? "no — behind" : "yes"}</dd>
          </div>
          <div>
            <dt>Population</dt>
            <dd>{telemetry === null ? "—" : formatInt(telemetry.population)}</dd>
          </div>
        </dl>
      </section>

      <section className="perf-section">
        <h3>Phases</h3>
        {parts.length === 0 ? (
          <p className="hint">No ticks ran in the last telemetry window.</p>
        ) : (
          <ul className="perf-phases">
            {parts.map((entry) => {
              const share = meanTickMillis > 0 ? (entry.millis / meanTickMillis) * 100 : 0;
              return (
                <li key={entry.name}>
                  <span className="perf-phase-name">{entry.name}</span>
                  <span className="perf-bar" aria-hidden="true">
                    <span
                      className="perf-bar-fill"
                      style={{ width: `${Math.min(100, share).toFixed(1)}%` }}
                    />
                  </span>
                  <span className="perf-phase-value">
                    {formatMillis(entry.millis)} ms
                    <span className="perf-note"> {share.toFixed(0)}%</span>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="perf-section">
        <h3>Render</h3>
        <dl className="perf-grid">
          <div>
            <dt>Frame rate</dt>
            <dd>
              {render === null ? "—" : `${render.fps.toFixed(0)} FPS`}
              {frameMillis > 0 ? (
                <span
                  className={frameMillis > FRAME_BUDGET_MS ? "perf-note perf-warn" : "perf-note"}
                >
                  {" "}
                  {formatMillis(frameMillis)} ms/frame
                </span>
              ) : null}
            </dd>
          </div>
          <div>
            <dt>Organisms drawn</dt>
            <dd>{render === null ? "—" : formatInt(render.drawnOrganisms)}</dd>
          </div>
          <div>
            <dt>With detail (LOD)</dt>
            <dd>{render === null ? "—" : formatInt(render.detailedOrganisms)}</dd>
          </div>
          <div>
            <dt>Carcasses drawn</dt>
            <dd>{render === null ? "—" : formatInt(render.drawnCarcasses)}</dd>
          </div>
          <div>
            <dt>Buffers in flight</dt>
            <dd>{telemetry === null ? "—" : telemetry.renderBuffersInFlight}</dd>
          </div>
          <div>
            <dt>Snapshots dropped</dt>
            <dd>{telemetry === null ? "—" : formatInt(telemetry.droppedRenderSnapshots)}</dd>
          </div>
        </dl>
      </section>

      <section className="perf-section">
        <h3>Memory</h3>
        {telemetry === null ? (
          <p className="hint">Waiting for telemetry.</p>
        ) : (
          <>
            <p className="perf-headline">
              {formatBytes(telemetry.memory.engineTotalBytes)}
              <span className="perf-note">
                {" "}
                engine, {formatBytes(telemetry.memory.renderPoolBytes)} render buffers
              </span>
            </p>
            <ul className="perf-memory">
              {[...telemetry.memory.engineBytesByCategory]
                .sort((a, b) => b[1] - a[1])
                .map(([name, bytes]) => (
                  <li key={name}>
                    <span className="perf-phase-name">{name}</span>
                    <span className="perf-phase-value">{formatBytes(bytes)}</span>
                  </li>
                ))}
              <li>
                <span className="perf-phase-name">chart samples (main thread)</span>
                <span className="perf-phase-value">{formatInt(props.chartSamples)}</span>
              </li>
            </ul>
            <p className="hint">
              {formatBytes(telemetry.memory.bytesPerOrganismSlot)} per organism slot ×{" "}
              {formatInt(telemetry.memory.organismCapacity)} slots.
            </p>
          </>
        )}
      </section>
    </aside>
  );
}
