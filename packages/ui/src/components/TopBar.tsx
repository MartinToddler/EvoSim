import { useCallback, useEffect, useRef, useState } from "react";
import {
  SPEED_MULTIPLIER,
  type HostRuntimeConfig,
  type SimulationSpeed,
  type TelemetryDto,
  type WorldSummaryDto,
} from "@eon/protocol";
import { formatCompact, formatInt } from "../format";

/**
 * Milestone 7 top bar (task H01/H02, docs/06 §9).
 *
 * Shows world identity, simulated time, population, species, run state and
 * measured TPS, and hosts the run controls. Everything numeric comes from the
 * 2 Hz telemetry stream — never from a render snapshot (CLAUDE.md React
 * boundary).
 *
 * One docs/06 §9 item is deliberately a placeholder still: **save state**
 * belongs to Milestone 10 persistence and is absent entirely. The species
 * count became real with the Milestone 8 registry.
 */

const SPEED_BUTTONS: readonly { speed: SimulationSpeed; label: string }[] = [
  { speed: "x1", label: "1×" },
  { speed: "x5", label: "5×" },
  { speed: "x20", label: "20×" },
  { speed: "x100", label: "100×" },
  { speed: "max", label: "MAX" },
];

/**
 * Tooltip for a speed button, derived from the runtime's real 1× rate rather
 * than hardcoded — a host configured to pace differently must not have its
 * buttons promise the default rates.
 */
function speedTitle(speed: SimulationSpeed, hostRuntime: HostRuntimeConfig | null): string {
  if (speed === "max") {
    return "Unpaced — as fast as this machine allows";
  }
  const base = hostRuntime?.targetTicksPerSecond1x ?? 20;
  return `${formatInt(SPEED_MULTIPLIER[speed] * base)} ticks per second`;
}

export interface TopBarProps {
  world: WorldSummaryDto | null;
  hostRuntime: HostRuntimeConfig | null;
  telemetry: TelemetryDto | null;
  speed: SimulationSpeed;
  debugOverlay: boolean;
  statsOpen: boolean;
  layersOpen: boolean;
  speciesOpen: boolean;
  treeOpen: boolean;
  timelineOpen: boolean;
  toolsOpen: boolean;
  onSpeedChange: (speed: SimulationSpeed) => void;
  /** Resume from pause at the last running speed. */
  onResume: () => void;
  onToggleDebug: () => void;
  onFitWorld: () => void;
  onToggleStats: () => void;
  onToggleLayers: () => void;
  onToggleSpecies: () => void;
  onToggleTree: () => void;
  onToggleTimeline: () => void;
  onToggleTools: () => void;
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
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The confirmation tick clears itself; the timer must not outlive the
  // component, and a re-click must restart the interval instead of letting the
  // first click's timer cut the second confirmation short.
  useEffect(() => {
    return () => {
      if (copiedTimer.current !== null) {
        clearTimeout(copiedTimer.current);
      }
    };
  }, []);
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
      if (copiedTimer.current !== null) {
        clearTimeout(copiedTimer.current);
      }
      copiedTimer.current = setTimeout(() => {
        setCopied(false);
        copiedTimer.current = null;
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
          <span className="stat-label" title="Detected evolutionary lineages alive right now">
            Species
          </span>
          <button
            type="button"
            className="stat-value seed-button"
            title={
              telemetry === null
                ? undefined
                : `${formatInt(telemetry.activeSpeciesCount)} living / ` +
                  `${formatInt(telemetry.extinctSpeciesCount)} extinct / ` +
                  `${formatInt(telemetry.totalSpeciesCount)} ever. Click for the species panel.`
            }
            onClick={props.onToggleSpecies}
          >
            {telemetry === null ? "—" : formatInt(telemetry.activeSpeciesCount)}
          </button>
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
            title={speedTitle(button.speed, hostRuntime)}
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
          aria-pressed={props.speciesOpen}
          title="Living species and the species inspector"
          onClick={props.onToggleSpecies}
        >
          Species
        </button>
        <button
          type="button"
          aria-pressed={props.treeOpen}
          title="Tree of Life: every lineage, split and extinction"
          onClick={props.onToggleTree}
        >
          Tree
        </button>
        <button
          type="button"
          aria-pressed={props.timelineOpen}
          title="World history: splits, extinctions, booms, crashes"
          onClick={props.onToggleTimeline}
        >
          History
        </button>
        <button
          type="button"
          aria-pressed={props.toolsOpen}
          title="Intervention tools: climate, ecology, terrain, catastrophe"
          onClick={props.onToggleTools}
        >
          Tools
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
