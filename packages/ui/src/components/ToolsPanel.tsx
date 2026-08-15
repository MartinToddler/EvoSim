import { useState } from "react";
import type { BrushFalloffDto, BrushKindDto, WorldDisplayDto } from "@eon/protocol";

/**
 * Player tool palette (Milestone 9, docs/06 §10).
 *
 * Grouped exactly as the docs group them — Climate, Ecology, Terrain,
 * Catastrophe — with each tool stating its radius/strength and whether the
 * effect persists. Descriptions talk about PRESSURE ("reduces plant
 * resources"), never promised biology ("creates predators"): the docs are
 * explicit that outcomes are the ecosystem's to decide.
 *
 * The panel renders controls and reports intents upward; it holds no engine
 * value and can change nothing itself. Strength sliders are bounded by the
 * config-derived limits shipped in `WorldDisplayDto.interventions`, so the UI
 * cannot promise a value the engine would reject.
 */

/** A canvas tool selection reported upward; null means observation mode. */
export interface ToolSelection {
  kind: BrushKindDto | "meteor";
  radiusLU: number;
  strength: number;
  falloff: BrushFalloffDto;
}

export interface ToolsPanelProps {
  display: WorldDisplayDto | null;
  /** Currently armed canvas tool, or null while observing. */
  active: ToolSelection | null;
  /** Pending (not yet applied) commands, from telemetry — visible while paused. */
  pendingCommandCount: number;
  onSelect: (tool: ToolSelection | null) => void;
  onApplyGlobalTemperature: (offsetCentiC: number) => void;
  onClose?: () => void;
}

interface ToolInfo {
  kind: BrushKindDto | "meteor";
  label: string;
  group: string;
  /** Pressure description (docs/06 §10). */
  effect: string;
  persistent: boolean;
  /** Strength sign for signed brushes: +1 or -1 relative to the slider value. */
  sign: 1 | -1;
}

const TOOLS: readonly ToolInfo[] = [
  {
    kind: "paintTemperature",
    label: "Warm",
    group: "Climate",
    effect: "Raises local temperature. Shifts thermal stress and biome edges.",
    persistent: true,
    sign: 1,
  },
  {
    kind: "paintTemperature",
    label: "Cool",
    group: "Climate",
    effect: "Lowers local temperature. Shifts thermal stress and biome edges.",
    persistent: true,
    sign: -1,
  },
  {
    kind: "paintMoisture",
    label: "Wet",
    group: "Climate",
    effect: "Raises local moisture. Changes plant capacity and biomes.",
    persistent: true,
    sign: 1,
  },
  {
    kind: "paintMoisture",
    label: "Dry",
    group: "Climate",
    effect: "Lowers local moisture. Reduces plant capacity.",
    persistent: true,
    sign: -1,
  },
  {
    kind: "paintFertility",
    label: "Enrich",
    group: "Ecology",
    effect: "Raises soil fertility, growing the local plant capacity.",
    persistent: true,
    sign: 1,
  },
  {
    kind: "paintFertility",
    label: "Deplete",
    group: "Ecology",
    effect: "Lowers soil fertility, shrinking the local plant capacity.",
    persistent: true,
    sign: -1,
  },
  {
    kind: "addBiomass",
    label: "Add plants",
    group: "Ecology",
    effect: "Adds edible biomass now. Excess decays back toward capacity.",
    persistent: false,
    sign: 1,
  },
  {
    kind: "removeBiomass",
    label: "Remove plants",
    group: "Ecology",
    effect: "Removes edible biomass now; it can regrow.",
    persistent: false,
    sign: 1,
  },
  {
    kind: "raiseTerrain",
    label: "Raise",
    group: "Terrain",
    effect: "Lifts the land. Can drain shallows into new land.",
    persistent: true,
    sign: 1,
  },
  {
    kind: "lowerTerrain",
    label: "Lower",
    group: "Terrain",
    effect: "Sinks the land. Can flood lowlands; organisms there must swim.",
    persistent: true,
    sign: 1,
  },
  {
    kind: "meteor",
    label: "Meteor",
    group: "Catastrophe",
    effect: "Impact damage, plant loss, a crater and scorched soil. Click to aim.",
    persistent: true,
    sign: 1,
  },
];

const GROUPS = ["Climate", "Ecology", "Terrain", "Catastrophe"] as const;

/** Strength bound for a tool from the shipped config limits. */
function strengthBound(kind: BrushKindDto | "meteor", display: WorldDisplayDto): number {
  const bounds = display.interventions;
  switch (kind) {
    case "paintTemperature":
      return bounds.maxTemperatureBrushStrengthCentiC;
    case "paintMoisture":
      return bounds.maxMoistureBrushStrengthQ;
    case "paintFertility":
      return bounds.maxFertilityBrushStrengthQ;
    case "raiseTerrain":
    case "lowerTerrain":
      return bounds.maxTerrainBrushStrengthQ;
    case "addBiomass":
    case "removeBiomass":
      return bounds.maxBiomassBrushStrengthUnits;
    case "meteor":
      return 0;
  }
}

function radiusBounds(
  kind: BrushKindDto | "meteor",
  display: WorldDisplayDto,
): { min: number; max: number } {
  const bounds = display.interventions;
  return kind === "meteor"
    ? { min: bounds.meteorMinRadiusLU, max: bounds.meteorMaxRadiusLU }
    : { min: bounds.minBrushRadiusLU, max: bounds.maxBrushRadiusLU };
}

/** Human units for a strength value of a given kind. */
function strengthLabel(kind: BrushKindDto | "meteor", value: number): string {
  switch (kind) {
    case "paintTemperature":
      return `${(value / 100).toFixed(1)} °C`;
    case "paintMoisture":
    case "paintFertility":
    case "raiseTerrain":
    case "lowerTerrain":
      return `${((value / 4096) * 100).toFixed(1)}%`;
    default:
      return `${value} units`;
  }
}

/** The TOOLS row a selection corresponds to: kind plus strength sign. */
function toolIndexOf(selection: ToolSelection | null): number | null {
  if (selection === null) {
    return null;
  }
  const index = TOOLS.findIndex(
    (tool) =>
      tool.kind === selection.kind &&
      (tool.kind === "meteor" || Math.sign(selection.strength) === tool.sign),
  );
  return index < 0 ? null : index;
}

export function ToolsPanel(props: ToolsPanelProps): React.JSX.Element {
  const display = props.display;
  // The armed row derives from the CHOSEN tool (props.active), so a reopened
  // panel shows the remembered tool. Warm and Cool share a kind and differ by
  // strength sign, which toolIndexOf resolves.
  const activeIndex = toolIndexOf(props.active);
  const [radiusLU, setRadiusLU] = useState(() => props.active?.radiusLU ?? 32);
  /** Strength as a positive slider fraction of the bound, in percent. */
  const [strengthPercent, setStrengthPercent] = useState(50);
  const [globalOffsetC, setGlobalOffsetC] = useState(0);

  if (display === null) {
    return (
      <aside className="tools-panel" aria-label="Intervention tools">
        <h2>Tools</h2>
        <p className="hint">Waiting for the world…</p>
      </aside>
    );
  }
  const bounds = display.interventions;

  const arm = (index: number | null): void => {
    if (index === null) {
      props.onSelect(null);
      return;
    }
    const info = TOOLS[index] as ToolInfo;
    const radius = radiusBounds(info.kind, display);
    const clampedRadius = Math.min(Math.max(radiusLU, radius.min), radius.max);
    if (clampedRadius !== radiusLU) {
      setRadiusLU(clampedRadius);
    }
    const bound = strengthBound(info.kind, display);
    const strength = Math.max(1, Math.round((bound * strengthPercent) / 100)) * info.sign;
    props.onSelect({
      kind: info.kind,
      radiusLU: clampedRadius,
      strength: info.kind === "meteor" ? 0 : strength,
      falloff: "linear",
    });
  };

  // Re-arm with current slider values whenever they move while a tool is armed.
  const rearm = (nextRadius: number, nextStrengthPercent: number): void => {
    setRadiusLU(nextRadius);
    setStrengthPercent(nextStrengthPercent);
    if (activeIndex !== null) {
      const info = TOOLS[activeIndex] as ToolInfo;
      const bound = strengthBound(info.kind, display);
      props.onSelect({
        kind: info.kind,
        radiusLU: nextRadius,
        strength:
          info.kind === "meteor"
            ? 0
            : Math.max(1, Math.round((bound * nextStrengthPercent) / 100)) * info.sign,
        falloff: "linear",
      });
    }
  };

  const activeInfo = activeIndex === null ? null : (TOOLS[activeIndex] as ToolInfo);
  const activeRadius = activeInfo === null ? null : radiusBounds(activeInfo.kind, display);

  return (
    <aside className="tools-panel" aria-label="Intervention tools">
      <div className="panel-title-row">
        <h2>Tools</h2>
        {props.onClose !== undefined ? (
          <button type="button" className="panel-close" onClick={props.onClose}>
            Close
          </button>
        ) : null}
      </div>

      <div className="tool-groups" role="radiogroup" aria-label="Canvas tool">
        <button
          type="button"
          role="radio"
          aria-checked={activeIndex === null}
          onClick={() => {
            arm(null);
          }}
        >
          Observe
        </button>
        {GROUPS.map((group) => (
          <div className="tool-group" key={group}>
            <h3>{group}</h3>
            {TOOLS.map((tool, index) =>
              tool.group === group ? (
                <button
                  key={`${tool.kind}:${tool.label}`}
                  type="button"
                  role="radio"
                  aria-checked={activeIndex === index}
                  onClick={() => {
                    arm(activeIndex === index ? null : index);
                  }}
                >
                  {tool.label}
                </button>
              ) : null,
            )}
          </div>
        ))}
      </div>

      {activeInfo !== null && activeRadius !== null ? (
        <div className="tool-settings">
          <p className="hint">{activeInfo.effect}</p>
          <p className="hint">
            {activeInfo.persistent ? "Persistent effect." : "One-off effect; the world responds."}{" "}
            {activeInfo.kind === "meteor"
              ? "Click the world to strike."
              : "Drag on the world to paint."}
          </p>
          <label className="opacity-control">
            Radius {radiusLU} LU
            <input
              type="range"
              min={activeRadius.min}
              max={activeRadius.max}
              value={Math.min(Math.max(radiusLU, activeRadius.min), activeRadius.max)}
              onChange={(event) => {
                rearm(Number(event.target.value), strengthPercent);
              }}
            />
          </label>
          {activeInfo.kind !== "meteor" ? (
            <label className="opacity-control">
              Strength{" "}
              {strengthLabel(
                activeInfo.kind,
                Math.max(
                  1,
                  Math.round((strengthBound(activeInfo.kind, display) * strengthPercent) / 100),
                ),
              )}
              <input
                type="range"
                min={5}
                max={100}
                value={strengthPercent}
                onChange={(event) => {
                  rearm(radiusLU, Number(event.target.value));
                }}
              />
            </label>
          ) : null}
        </div>
      ) : null}

      <div className="tool-settings">
        <h3>Global temperature</h3>
        <p className="hint">Persistent world-wide offset. Applied as one command.</p>
        <label className="opacity-control">
          Offset {(globalOffsetC / 100).toFixed(1)} °C
          <input
            type="range"
            min={-bounds.maxGlobalTemperatureOffsetCentiC}
            max={bounds.maxGlobalTemperatureOffsetCentiC}
            step={10}
            value={globalOffsetC}
            onChange={(event) => {
              setGlobalOffsetC(Number(event.target.value));
            }}
          />
        </label>
        <button
          type="button"
          onClick={() => {
            props.onApplyGlobalTemperature(globalOffsetC);
          }}
        >
          Apply global offset
        </button>
      </div>

      {props.pendingCommandCount > 0 ? (
        <p className="hint" role="status">
          {props.pendingCommandCount} intervention
          {props.pendingCommandCount === 1 ? "" : "s"} queued — applies when the simulation runs.
        </p>
      ) : null}
    </aside>
  );
}
