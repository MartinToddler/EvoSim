import { useMemo, useState } from "react";
import type { SpeciesSummaryDto, TreeSnapshotDto, WorldDisplayDto } from "@eon/protocol";
import { formatYear } from "../format";
import { speciesName } from "./SpeciesPanel";

/**
 * Milestone 8 Tree of Life (task I07, docs/06 §14, docs/05 §19).
 *
 * Plain SVG, laid out from the species registry: every species is a horizontal
 * life-bar from its origin tick to its end tick (or to now), a split draws a
 * vertical connector into its two daughters, and time runs left to right with
 * a year axis. The layout is the classic recursive one — leaves get
 * consecutive lanes, a split parent sits between its daughters — which is
 * cheap, stable, and enough for the MVP ("start simple; do not block on a
 * sophisticated phylogenetic layout library").
 *
 * Status is distinguished beyond colour (docs/06 §14): an active species ends
 * in a filled arrowhead at the present edge, an extinct one in a cross, and a
 * split in the branch connector itself; dashing marks the selected species'
 * ancestry line. Zoom is a control, pan is native scrolling.
 */

export interface TreePanelProps {
  tree: TreeSnapshotDto | null;
  /** Authoritative now, so living bars reach the present edge. */
  currentTick: number;
  ticksPerSimYear: number;
  selectedSpeciesId: number | null;
  display: WorldDisplayDto | null;
  onSelectSpecies: (speciesId: number) => void;
  onClose: () => void;
}

const LANE_HEIGHT = 26;
const PAD_TOP = 26;
const PAD_LEFT = 12;
const PAD_RIGHT = 120;
const PAD_BOTTOM = 8;
/** Pixels per simulated year at zoom 1. */
const BASE_PX_PER_YEAR = 72;
const ZOOM_LEVELS: readonly number[] = [0.25, 0.5, 1, 2, 4];

interface TreeLayout {
  lanes: Map<number, number>;
  laneCount: number;
}

/**
 * Assign a lane to every species: leaves in registry order, split parents at
 * the midpoint of their daughters. Parents precede children by ID, so one
 * pass in DESCENDING id order can rely on both daughters being placed…
 * actually the reverse: daughters have HIGHER ids, so ascending placement
 * cannot know them yet. A recursive walk from each root is simplest and the
 * registry is small.
 */
function layoutTree(species: readonly SpeciesSummaryDto[]): TreeLayout {
  const childrenOf = new Map<number, number[]>();
  const roots: number[] = [];
  for (const record of species) {
    if (record.parentSpeciesId === 0) {
      roots.push(record.id);
    } else {
      const siblings = childrenOf.get(record.parentSpeciesId) ?? [];
      siblings.push(record.id);
      childrenOf.set(record.parentSpeciesId, siblings);
    }
  }

  const lanes = new Map<number, number>();
  let nextLeafLane = 0;
  const place = (id: number): number => {
    const children = childrenOf.get(id) ?? [];
    if (children.length === 0) {
      const lane = nextLeafLane;
      nextLeafLane += 1;
      lanes.set(id, lane);
      return lane;
    }
    let sum = 0;
    for (const child of children) {
      sum += place(child);
    }
    const lane = sum / children.length;
    lanes.set(id, lane);
    return lane;
  };
  for (const root of roots) {
    place(root);
  }
  return { lanes, laneCount: Math.max(1, nextLeafLane) };
}

export function TreePanel(props: TreePanelProps): React.JSX.Element {
  const [zoomIndex, setZoomIndex] = useState(2);
  const tree = props.tree;

  const layout = useMemo(() => (tree === null ? null : layoutTree(tree.species)), [tree]);

  if (tree === null || layout === null) {
    return (
      <aside className="tree-panel" aria-label="Tree of Life">
        <div className="panel-title-row">
          <h2>Tree of Life</h2>
          <button type="button" onClick={props.onClose} aria-label="Close tree panel">
            ✕
          </button>
        </div>
        <p className="hint">Waiting for the first species snapshot…</p>
      </aside>
    );
  }

  const zoom = ZOOM_LEVELS[zoomIndex] as number;
  const pxPerTick = (BASE_PX_PER_YEAR * zoom) / props.ticksPerSimYear;
  const horizon = Math.max(props.currentTick, tree.tick, props.ticksPerSimYear);
  const width = PAD_LEFT + horizon * pxPerTick + PAD_RIGHT;
  const height = PAD_TOP + layout.laneCount * LANE_HEIGHT + PAD_BOTTOM;
  const toX = (tick: number): number => PAD_LEFT + tick * pxPerTick;
  const toY = (lane: number): number => PAD_TOP + lane * LANE_HEIGHT + LANE_HEIGHT / 2;

  // Year gridlines, thinned so labels never collide at any zoom.
  const yearStep = Math.max(1, Math.ceil(56 / (BASE_PX_PER_YEAR * zoom)));
  const gridYears: number[] = [];
  for (let year = 0; year * props.ticksPerSimYear <= horizon; year += yearStep) {
    gridYears.push(year);
  }

  const byId = new Map(tree.species.map((record) => [record.id, record]));

  return (
    <aside className="tree-panel" aria-label="Tree of Life">
      <div className="panel-title-row">
        <h2 title="Each bar is a species from origin to end; a fork is a split; ✕ is an extinction">
          Tree of Life
        </h2>
        <div className="panel-title-actions">
          <button
            type="button"
            onClick={() => {
              setZoomIndex((index) => Math.max(0, index - 1));
            }}
            disabled={zoomIndex === 0}
            aria-label="Zoom out"
          >
            −
          </button>
          <button
            type="button"
            onClick={() => {
              setZoomIndex((index) => Math.min(ZOOM_LEVELS.length - 1, index + 1));
            }}
            disabled={zoomIndex === ZOOM_LEVELS.length - 1}
            aria-label="Zoom in"
          >
            +
          </button>
          <button type="button" onClick={props.onClose} aria-label="Close tree panel">
            ✕
          </button>
        </div>
      </div>

      <div className="tree-scroll">
        <svg
          className="tree-svg"
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={`Tree of Life with ${tree.species.length} species`}
        >
          {gridYears.map((year) => {
            const x = toX(year * props.ticksPerSimYear);
            return (
              <g key={year}>
                <line
                  className="tree-grid"
                  x1={x}
                  y1={PAD_TOP - 8}
                  x2={x}
                  y2={height - PAD_BOTTOM}
                />
                <text className="tree-axis-label" x={x + 3} y={12}>
                  {formatYear(year * props.ticksPerSimYear, props.ticksPerSimYear)}
                </text>
              </g>
            );
          })}

          {tree.species.map((record) => {
            const lane = layout.lanes.get(record.id) ?? 0;
            const y = toY(lane);
            const xStart = toX(record.originTick);
            const endTick = record.endTick === 0 ? horizon : record.endTick;
            const xEnd = toX(endTick);
            const selected = props.selectedSpeciesId === record.id;
            const statusClass =
              record.endReason === 0
                ? "is-active"
                : record.endReason === 1
                  ? "is-split"
                  : "is-extinct";

            // Connector down/up to the daughters at the split tick.
            const children = tree.species.filter((other) => other.parentSpeciesId === record.id);
            const connector =
              children.length > 0 ? (
                <line
                  className="tree-connector"
                  x1={xEnd}
                  y1={toY(layout.lanes.get(children[0]?.id ?? record.id) ?? lane)}
                  x2={xEnd}
                  y2={toY(layout.lanes.get(children[children.length - 1]?.id ?? record.id) ?? lane)}
                />
              ) : null;

            return (
              <g
                key={record.id}
                className={`tree-species ${statusClass}${selected ? " is-selected" : ""}`}
                onClick={() => {
                  props.onSelectSpecies(record.id);
                }}
              >
                {/* A wide invisible hit area so a 2px bar is still tappable. */}
                <rect
                  className="tree-hit"
                  x={Math.min(xStart, xEnd) - 2}
                  y={y - LANE_HEIGHT / 2}
                  width={Math.max(6, Math.abs(xEnd - xStart) + 4)}
                  height={LANE_HEIGHT}
                >
                  <title>
                    {`${speciesName(record.id)} — ${
                      props.display?.speciesEndReasonLabels[record.endReason] ?? record.endReason
                    }, population ${record.population}${
                      record.parentSpeciesId !== 0
                        ? `, from ${speciesName(record.parentSpeciesId)}`
                        : ""
                    }`}
                  </title>
                </rect>
                {connector}
                <line className="tree-life" x1={xStart} y1={y} x2={xEnd} y2={y} />
                {record.endReason === 0 ? (
                  <path
                    className="tree-cap-active"
                    d={`M ${xEnd} ${y - 4} L ${xEnd + 7} ${y} L ${xEnd} ${y + 4} Z`}
                  />
                ) : record.endReason === 2 ? (
                  <g className="tree-cap-extinct">
                    <line x1={xEnd - 3.5} y1={y - 3.5} x2={xEnd + 3.5} y2={y + 3.5} />
                    <line x1={xEnd - 3.5} y1={y + 3.5} x2={xEnd + 3.5} y2={y - 3.5} />
                  </g>
                ) : null}
                <circle className="tree-origin" cx={xStart} cy={y} r={2.5} />
                <text className="tree-label" x={xEnd + 10} y={y + 3.5}>
                  {speciesName(record.id)}
                  {record.carnivoreDetected ? " 🥩" : ""}
                  {record.endReason === 0 ? ` · ${record.population}` : ""}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      <p className="hint tree-legend">
        ▶ living · ✕ extinct · fork = split · notch = origin
        {props.selectedSpeciesId !== null && byId.has(props.selectedSpeciesId)
          ? ` · selected: ${speciesName(props.selectedSpeciesId)}`
          : ""}
      </p>
    </aside>
  );
}
