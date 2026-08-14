import { useCallback, useState } from "react";
import type {
  HostRuntimeConfig,
  SimulationSpeed,
  TelemetryDto,
  WorldSummaryDto,
} from "@eon/protocol";
import { formatCompact, formatInt } from "../format";

/**
 * Milestone 7 top bar (task H01/H02, docs/06 §9).
 *
 * Shows world identity, simulated time, population, run state and measured
 * TPS, and hosts the run controls. Everything numeric comes from the 2 Hz
 * telemetry stream — never from a render snapshot (CLAUDE.md React boundary).
 *
 * Two docs/06 §9 items are deliberately placeholders: **species** has no data
 * source until the Milestone 8 registry, so it shows an em dash with an
 * explanation rather than an invented number; **save state** belongs to
 * Milestone 10 persistence and is absent entirely.
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
  statsOpen: boolean;
  layersOpen: boolean;
  onSpeedChange: (speed: SimulationSpeed) => void;
  /** Resume from pause at the last running speed. */
  onResume: () => void;
  onToggleDebug: () => void;
  onFitWorld: () => void;
  onToggleStats: () => void;
  onToggleLayers: () => void;
}

/** Run-state label: the honest one, including "behind" (docs/01 §11). */
function runState(telemetry: TelemetryDto | null, speed: SimulationSpeed): string {
  if (speed === "paused") {
    return "Paused";
  }
  if (telemetry?.behindTarget === true) {
    return "Behind";
  }
  return speed === "max" ? "Max speed" : "Running";
}

export function TopBar(props: TopBarProps): React.JSX.Element {
  const { world, hostRuntime, telemetry, speed } = props;
  const paused = speed === "paused";
  const tick = telemetry?.tick ?? 0;
  const ticksPerYear = hostRuntime?.ticksPerSimYear ?? 2000;
  const year = Math.floor(tick / ticksPerYear);

  const behind = telemetry?.behindTarget === true;
  const tps = telemetry?.achievedTicksPerSecond ?? 0;
  const state = runState(telemetry, speed);
  // Refused births distort evolution (docs/01 §11), so the moment the cap
  // bites, the population number itself carries the warning.
  const capWarning = (telemetry?.capRejectedBirths ?? 0) > 0;

  const [copied, setCopied] = useState(false);
  const copySeed = useCallback(() => {
    const seedHex = world?.seedHex;
    if (seedHex === undefined) {
      return;
    }
    const clipboard = globalThis.navigator?.clipboard;
    if (clipboard === undefined) {
      return;
    }
    void clipboard.writeText(seedHex).then(() => {
      setCopied(true);
      setTimeout(() => {
        setCopied(false);
      }, 1500);
    });
  }, [world?.seedHex]);

  return (
    <header className="topbar">
      <span className="brand">EON</span>

      <div className="stat-group">
        <div className="stat">
          <span className="stat-label">World</span>
          <button
            type="button"
            className="stat-value seed-button"
            title={copied ? "Copied!" : "Copy the world seed"}
            onClick={copySeed}
          >
            {world?.seedHex ?? "—"}
            {copied ? " ✓" : ""}
          </button>
        </div>
        <div className="stat">
          <span className="stat-label">Year</span>
          <span className="stat-value">{formatInt(year)}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Tick</span>
          <span className="stat-value">{formatInt(tick)}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Population</span>
          <span
            className={capWarning ? "stat-value warn" : "stat-value"}
            title={
              capWarning
                ? `Population cap reached: ${formatInt(telemetry?.capRejectedBirths ?? 0)} births ` +
                  "refused so far. A hard cap biases evolution."
                : undefined
            }
          >
            {formatInt(telemetry?.population ?? 0)}
            {capWarning ? " ⚠" : ""}
          </span>
        </div>
        <div className="stat">
          <span className="stat-label" title="Species detection arrives with Milestone 8">
            Species
          </span>
          <span className="stat-value" title="Species detection arrives with Milestone 8">
            —
          </span>
        </div>
        <div className="stat">
          <span className="stat-label">Plants</span>
          <span className="stat-value">{formatCompact(telemetry?.plantBiomass ?? 0)}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Generation</span>
          <span className="stat-value">{formatInt(telemetry?.maxGeneration ?? 0)}</span>
        </div>
        <div className="stat">
          <span className="stat-label">State</span>
          <span className={behind ? "stat-value warn" : "stat-value"}>{state}</span>
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
          aria-pressed={!paused}
          title="Run the simulation"
          onClick={props.onResume}
        >
          ▶
        </button>
        <button
          type="button"
          aria-pressed={paused}
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
          aria-pressed={props.layersOpen}
          title="World layers: biomes, climate, fertility, plants, density"
          onClick={props.onToggleLayers}
        >
          Layers
        </button>
        <button
          type="button"
          aria-pressed={props.statsOpen}
          title="Global statistics and charts"
          onClick={props.onToggleStats}
        >
          Stats
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
