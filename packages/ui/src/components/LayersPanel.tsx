import {
  BIOME_COLORS,
  BIOME_NAMES,
  DENSITY_SATURATION_COUNT,
  WORLD_LAYERS,
  worldLayerLegendStops,
  type WorldLayerId,
} from "@eon/renderer/palette";
import type { WorldDisplayDto } from "@eon/protocol";
import { formatCompact } from "../format";

/**
 * World layer picker and legend (task H05, docs/06 §7).
 *
 * Selecting a layer recolours the terrain texture from display planes that are
 * already on the main thread — the Worker is never asked anything, so flipping
 * through layers at any speed cannot touch the simulation. One layer is active
 * at a time, with an opacity slider (docs/06 §7 "one heavy overlay at a time,
 * opacity control").
 */

export interface LayersPanelProps {
  active: WorldLayerId;
  opacity: number;
  /** Legend ranges; null before the world is ready. */
  display: WorldDisplayDto | null;
  onSelect: (layer: WorldLayerId) => void;
  onOpacity: (opacity: number) => void;
}

/** Human endpoints for the active layer's legend. */
function legendEndpoints(layer: WorldLayerId, display: WorldDisplayDto | null): [string, string] {
  switch (layer) {
    case "temperature":
      return [
        `${(display?.temperatureDisplayMinC ?? -25).toFixed(0)} °C`,
        `${(display?.temperatureDisplayMaxC ?? 35).toFixed(0)} °C`,
      ];
    case "moisture":
    case "fertility":
    case "vegetation":
      return ["0%", "100%"];
    case "capacity":
      return ["0", `${formatCompact(display?.capacityDisplayReference ?? 0)} units`];
    case "density":
      return ["0", `${DENSITY_SATURATION_COUNT}+ / cell`];
    case "elevation":
      return ["low", "high"];
    default:
      return ["", ""];
  }
}

export function LayersPanel(props: LayersPanelProps): React.JSX.Element {
  const activeInfo = WORLD_LAYERS.find((layer) => layer.id === props.active);
  const stops = worldLayerLegendStops(props.active);
  const [lowLabel, highLabel] = legendEndpoints(props.active, props.display);

  return (
    <aside className="layers-panel" aria-label="World layers">
      <h2>World layers</h2>
      <div className="layer-list" role="radiogroup" aria-label="Active layer">
        {WORLD_LAYERS.map((layer) => (
          <button
            key={layer.id}
            type="button"
            role="radio"
            // aria-checked alone: aria-pressed belongs to toggle buttons and
            // contradicts the radio role for assistive tech.
            aria-checked={props.active === layer.id}
            onClick={() => {
              props.onSelect(layer.id);
            }}
          >
            {layer.label}
          </button>
        ))}
      </div>

      {props.active === "biome" ? (
        <ul className="legend-swatches">
          {BIOME_NAMES.map((name, index) => {
            const [r, g, b] = BIOME_COLORS[index] ?? [255, 0, 255];
            return (
              <li key={name}>
                <span
                  className="swatch"
                  style={{ background: `rgb(${r},${g},${b})` }}
                  aria-hidden="true"
                />
                {name}
              </li>
            );
          })}
        </ul>
      ) : null}

      {stops.length > 1 && props.active !== "biome" ? (
        <div className="legend">
          <div
            className="legend-ramp"
            aria-hidden="true"
            style={{ background: `linear-gradient(to right, ${stops.join(", ")})` }}
          />
          <div className="legend-labels">
            <span>
              {activeInfo?.lowLabel} {lowLabel}
            </span>
            <span>
              {highLabel} {activeInfo?.highLabel}
            </span>
          </div>
        </div>
      ) : null}

      {props.active !== "terrain" ? (
        <label className="opacity-control">
          Layer opacity
          <input
            type="range"
            min={20}
            max={100}
            value={Math.round(props.opacity * 100)}
            onChange={(event) => {
              props.onOpacity(Number(event.target.value) / 100);
            }}
          />
        </label>
      ) : (
        <p className="hint">The default view: biomes shaded by relief, greened by living plants.</p>
      )}
      {activeInfo?.source === "render-snapshot" ? (
        <p className="hint">Computed from the live render stream on this side of the Worker.</p>
      ) : null}
    </aside>
  );
}
