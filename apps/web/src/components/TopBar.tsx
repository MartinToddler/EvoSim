import type {
  HostRuntimeConfig,
  SimulationSpeed,
  TelemetryDto,
  WorldSummaryDto,
} from "@eon/protocol";

/**
 * Minimal Milestone 6 top bar (docs/06 §9).
 *
 * Shows exactly what M6 requires — world identity, simulated year and tick,
 * population, measured TPS, and the run controls. Species count, save state and
 * the tool palette belong to later milestones and are deliberately absent
 * rather than stubbed.
 *
 * Every value here comes from the low-frequency telemetry stream (2 Hz), never
 * from a render snapshot: React must not hold organism data (CLAUDE.md React
 * boundary).
 */

const SPEED_BUTTONS: readonly { speed: SimulationSpeed; label: string; title: string }[] = [
  { speed: "x1", label: "1×", title: "20 ticks per second" },
  { speed: "x5", label: "5×", title: "100 ticks per second" },
  { speed: "x20", label: "20×", title: "400 ticks per second" },
  { speed: "x100", label: "100×", title: "2000 ticks per second" },
  { speed: "max", label: "MAX", title: "Unpaced — as fast as this machine allows" },
];

export interface TopBarProps {
  world: WorldSummaryDto | null;
  hostRuntime: HostRuntimeConfig | null;
  telemetry: TelemetryDto | null;
  speed: SimulationSpeed;
  debugOverlay: boolean;
  onSpeedChange: (speed: SimulationSpeed) => void;
  onToggleDebug: () => void;
  onFitWorld: () => void;
}

function formatNumber(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

/** Compact magnitude for biomass, which runs into the hundreds of millions. */
function formatCompact(value: number): string {
  return value.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 1 });
}

export function TopBar(props: TopBarProps): React.JSX.Element {
  const { world, hostRuntime, telemetry, speed } = props;
  const running = speed !== "paused";
  const tick = telemetry?.tick ?? 0;
  const ticksPerYear = hostRuntime?.ticksPerSimYear ?? 2000;
  const year = Math.floor(tick / ticksPerYear);

  // A world that cannot keep up is worth saying out loud: at 100× on a slow
  // machine the difference between "requested" and "achieved" is the whole
  // explanation for why time feels wrong.
  const behind = telemetry?.behindTarget === true;
  const tps = telemetry?.achievedTicksPerSecond ?? 0;

  return (
    <header className="topbar">
      <span className="brand">EON</span>

      <div className="stat-group">
        <div className="stat">
          <span className="stat-label">World seed</span>
          <span className="stat-value">{world?.seedHex ?? "—"}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Year</span>
          <span className="stat-value">{formatNumber(year)}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Tick</span>
          <span className="stat-value">{formatNumber(tick)}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Population</span>
          <span className="stat-value">{formatNumber(telemetry?.population ?? 0)}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Carcasses</span>
          <span className="stat-value">{formatNumber(telemetry?.carcassCount ?? 0)}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Plants</span>
          <span className="stat-value">{formatCompact(telemetry?.plantBiomass ?? 0)}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Generation</span>
          <span className="stat-value">{formatNumber(telemetry?.maxGeneration ?? 0)}</span>
        </div>
        <div className="stat">
          <span className="stat-label" title="Ticks per second actually achieved">
            TPS
          </span>
          <span className={behind ? "stat-value warn" : "stat-value"}>
            {tps.toFixed(tps < 100 ? 1 : 0)}
            {behind ? " ▼" : ""}
          </span>
        </div>
      </div>

      <div className="controls" role="group" aria-label="Simulation speed">
        <button
          type="button"
          aria-pressed={!running}
          title="Pause the simulation"
          onClick={() => {
            props.onSpeedChange("paused");
          }}
        >
          ❚❚
        </button>
        {SPEED_BUTTONS.map((button) => (
          <button
            key={button.speed}
            type="button"
            aria-pressed={speed === button.speed}
            title={button.title}
            onClick={() => {
              props.onSpeedChange(button.speed);
            }}
          >
            {button.label}
          </button>
        ))}
      </div>

      <div className="controls" role="group" aria-label="View">
        <button type="button" title="Frame the whole world" onClick={props.onFitWorld}>
          Fit
        </button>
        <button
          type="button"
          aria-pressed={props.debugOverlay}
          title="Toggle the environment grid overlay"
          onClick={props.onToggleDebug}
        >
          Grid
        </button>
      </div>
    </header>
  );
}
