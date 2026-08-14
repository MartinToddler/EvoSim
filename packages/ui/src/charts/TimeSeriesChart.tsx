import { useCallback, useMemo, useState } from "react";
import { formatYear } from "../format";
import type { SeriesPoint } from "./StatsHistory";

/**
 * Small self-contained SVG time-series chart (task H04, docs/06 §§15, 17).
 *
 * Hand-rolled rather than a charting dependency: each panel plots at most a
 * few hundred points at 2 Hz, and the docs' only charting guidance is "normal
 * web SVG/canvas, do not block on a sophisticated library" (docs/06 §14).
 *
 * The x-axis is the authoritative tick, labelled in simulated years — never
 * the sample index, because telemetry samples are wall-clock spaced and one
 * sample can span thousands of ticks at MAX speed.
 *
 * Accessibility (docs/06 §17): every chart carries its current numeric value
 * next to the title, so colour and geometry are never the only way to read
 * it; the SVG is `role="img"` with a spoken summary; hovering shows exact
 * values at a crosshair.
 */

/**
 * Series colours, assigned in fixed order (identity, never rank). These are
 * the first categorical slots of the chart palette, stepped for dark surfaces.
 */
export const CHART_SERIES_COLORS: readonly string[] = ["#3987e5", "#d95926", "#199e70", "#c98500"];

export interface ChartSeries {
  label: string;
  color: string;
  points: readonly SeriesPoint[];
}

export interface TimeSeriesChartProps {
  title: string;
  series: readonly ChartSeries[];
  /** Display divisor for the year labels on the x-axis. */
  ticksPerSimYear: number;
  /** Value formatter for labels and the hover readout. */
  formatValue: (value: number) => string;
  /** Fixed y range (e.g. [-1, 1] for a signed trait); auto-fitted when absent. */
  yDomain?: readonly [number, number];
  /** Horizontal reference line, e.g. 0 for signed values. */
  referenceY?: number;
}

const WIDTH = 280;
const HEIGHT = 84;
const PAD_LEFT = 6;
const PAD_RIGHT = 6;
const PAD_TOP = 6;
const PAD_BOTTOM = 14;

interface Scale {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  toX: (tick: number) => number;
  toY: (value: number) => number;
}

function computeScale(
  series: readonly ChartSeries[],
  yDomain: readonly [number, number] | undefined,
): Scale | null {
  let xMin = Number.POSITIVE_INFINITY;
  let xMax = Number.NEGATIVE_INFINITY;
  let yMin = Number.POSITIVE_INFINITY;
  let yMax = Number.NEGATIVE_INFINITY;
  let points = 0;
  for (const line of series) {
    for (const point of line.points) {
      points += 1;
      if (point.x < xMin) xMin = point.x;
      if (point.x > xMax) xMax = point.x;
      if (point.y < yMin) yMin = point.y;
      if (point.y > yMax) yMax = point.y;
    }
  }
  if (points < 2 || xMax <= xMin) {
    return null;
  }
  if (yDomain !== undefined) {
    yMin = yDomain[0];
    yMax = yDomain[1];
  } else {
    // Pad so lines never sit on the frame; give a flat line visible room.
    const span = yMax - yMin;
    const pad = span > 0 ? span * 0.08 : Math.max(1, Math.abs(yMax)) * 0.1;
    yMin -= pad;
    yMax += pad;
  }
  const xSpan = xMax - xMin;
  const ySpan = yMax - yMin || 1;
  const innerWidth = WIDTH - PAD_LEFT - PAD_RIGHT;
  const innerHeight = HEIGHT - PAD_TOP - PAD_BOTTOM;
  return {
    xMin,
    xMax,
    yMin,
    yMax,
    toX: (tick) => PAD_LEFT + ((tick - xMin) / xSpan) * innerWidth,
    toY: (value) => PAD_TOP + (1 - (value - yMin) / ySpan) * innerHeight,
  };
}

function pathFor(points: readonly SeriesPoint[], scale: Scale): string {
  let path = "";
  for (let i = 0; i < points.length; i += 1) {
    const point = points[i] as SeriesPoint;
    path += `${i === 0 ? "M" : "L"}${scale.toX(point.x).toFixed(1)},${scale.toY(point.y).toFixed(1)}`;
  }
  return path;
}

/** Index of the point nearest to `tick`, assuming ascending x. */
function nearestIndex(points: readonly SeriesPoint[], tick: number): number {
  let best = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < points.length; i += 1) {
    const distance = Math.abs((points[i] as SeriesPoint).x - tick);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }
  return best;
}

export function TimeSeriesChart(props: TimeSeriesChartProps): React.JSX.Element {
  const { series, yDomain, formatValue, ticksPerSimYear } = props;
  const [hoverTick, setHoverTick] = useState<number | null>(null);

  const scale = useMemo(() => computeScale(series, yDomain), [series, yDomain]);

  const onPointerMove = useCallback(
    (event: React.PointerEvent<SVGSVGElement>) => {
      if (scale === null) {
        return;
      }
      const rect = event.currentTarget.getBoundingClientRect();
      const fraction = (event.clientX - rect.left) / Math.max(1, rect.width);
      const svgX = fraction * WIDTH;
      const tick =
        scale.xMin +
        ((svgX - PAD_LEFT) / Math.max(1, WIDTH - PAD_LEFT - PAD_RIGHT)) * (scale.xMax - scale.xMin);
      setHoverTick(Math.min(scale.xMax, Math.max(scale.xMin, tick)));
    },
    [scale],
  );
  const onPointerLeave = useCallback(() => {
    setHoverTick(null);
  }, []);

  const current = series.map((line) =>
    line.points.length > 0 ? (line.points[line.points.length - 1] as SeriesPoint).y : null,
  );

  const hover =
    scale !== null && hoverTick !== null
      ? series.map((line) => {
          const index = nearestIndex(line.points, hoverTick);
          return index >= 0 ? (line.points[index] as SeriesPoint) : null;
        })
      : null;

  const summary =
    `${props.title}: ` +
    series
      .map(
        (line, i) =>
          `${line.label} ${current[i] === null ? "no data" : formatValue(current[i] as number)}`,
      )
      .join(", ");

  return (
    <figure className="chart">
      <figcaption className="chart-head">
        <span className="chart-title">{props.title}</span>
        <span className="chart-current">
          {series.map((line, i) => (
            <span key={line.label} className="chart-current-item">
              {series.length > 1 ? (
                <span className="chart-dot" style={{ background: line.color }} aria-hidden="true" />
              ) : null}
              {current[i] === null ? "—" : formatValue(current[i] as number)}
            </span>
          ))}
        </span>
      </figcaption>
      {series.length > 1 ? (
        <div className="chart-legend">
          {series.map((line) => (
            <span key={line.label} className="chart-legend-item">
              <span className="chart-dot" style={{ background: line.color }} aria-hidden="true" />
              {line.label}
            </span>
          ))}
        </div>
      ) : null}
      {scale === null ? (
        <div className="chart-empty hint">collecting…</div>
      ) : (
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          className="chart-plot"
          role="img"
          aria-label={summary}
          onPointerMove={onPointerMove}
          onPointerLeave={onPointerLeave}
        >
          {/* Recessive frame: min/max gridlines only. */}
          <line
            x1={PAD_LEFT}
            x2={WIDTH - PAD_RIGHT}
            y1={scale.toY(scale.yMax)}
            y2={scale.toY(scale.yMax)}
            className="chart-gridline"
          />
          <line
            x1={PAD_LEFT}
            x2={WIDTH - PAD_RIGHT}
            y1={scale.toY(scale.yMin)}
            y2={scale.toY(scale.yMin)}
            className="chart-gridline"
          />
          {props.referenceY !== undefined &&
          props.referenceY >= scale.yMin &&
          props.referenceY <= scale.yMax ? (
            <line
              x1={PAD_LEFT}
              x2={WIDTH - PAD_RIGHT}
              y1={scale.toY(props.referenceY)}
              y2={scale.toY(props.referenceY)}
              className="chart-reference"
            />
          ) : null}

          {series.map((line) => (
            <path
              key={line.label}
              d={pathFor(line.points, scale)}
              fill="none"
              stroke={line.color}
              strokeWidth={1.6}
              strokeLinejoin="round"
            />
          ))}

          {/* Axis extent labels: y range on the left, time range below. */}
          <text x={PAD_LEFT + 1} y={scale.toY(scale.yMax) + 7} className="chart-label">
            {formatValue(scale.yMax)}
          </text>
          <text x={PAD_LEFT + 1} y={scale.toY(scale.yMin) - 2} className="chart-label">
            {formatValue(scale.yMin)}
          </text>
          <text x={PAD_LEFT} y={HEIGHT - 3} className="chart-label">
            {formatYear(scale.xMin, ticksPerSimYear)}
          </text>
          <text x={WIDTH - PAD_RIGHT} y={HEIGHT - 3} className="chart-label" textAnchor="end">
            {formatYear(scale.xMax, ticksPerSimYear)}
          </text>

          {hover !== null && hoverTick !== null ? (
            <g>
              <line
                x1={scale.toX(hoverTick)}
                x2={scale.toX(hoverTick)}
                y1={PAD_TOP}
                y2={HEIGHT - PAD_BOTTOM}
                className="chart-crosshair"
              />
              {hover.map((point, i) =>
                point !== null ? (
                  <circle
                    key={(series[i] as ChartSeries).label}
                    cx={scale.toX(point.x)}
                    cy={scale.toY(point.y)}
                    r={2.4}
                    fill={(series[i] as ChartSeries).color}
                    stroke="#0a0f14"
                    strokeWidth={1}
                  />
                ) : null,
              )}
              <text
                x={
                  scale.toX(hoverTick) > WIDTH / 2
                    ? scale.toX(hoverTick) - 4
                    : scale.toX(hoverTick) + 4
                }
                y={PAD_TOP + 7}
                className="chart-hover-label"
                textAnchor={scale.toX(hoverTick) > WIDTH / 2 ? "end" : "start"}
              >
                {`${formatYear(hoverTick, ticksPerSimYear)} · ${hover
                  .map((point) => (point === null ? "—" : formatValue(point.y)))
                  .join(" / ")}`}
              </text>
            </g>
          ) : null}
        </svg>
      )}
    </figure>
  );
}
