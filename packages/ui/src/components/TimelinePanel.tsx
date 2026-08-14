import { useMemo, useState } from "react";
import type { WorldDisplayDto, WorldEventDto } from "@eon/protocol";
import { formatInt, formatYear } from "../format";
import { speciesName } from "./SpeciesPanel";

/**
 * Milestone 8 history timeline (task I06 UI, docs/06 §13).
 *
 * Two views of the same bounded event log: a marker strip laid out on the
 * authoritative time axis, and a reverse-chronological list with severity
 * filtering. Clicking either selects the event; events that reference species
 * link into the species inspector.
 *
 * There is deliberately NO rewind here: dragging time to travel belongs to
 * Milestone 11, and this panel only ever reads history.
 */

export interface TimelinePanelProps {
  /** Accumulated events, oldest first (the session keeps them bounded). */
  events: readonly WorldEventDto[];
  /** Events lost before the oldest retained one (engine + client bounds). */
  droppedBeforeOldest: number;
  currentTick: number;
  ticksPerSimYear: number;
  display: WorldDisplayDto | null;
  onSelectSpecies: (speciesId: number) => void;
  onClose: () => void;
}

const STRIP_WIDTH = 560;
const STRIP_HEIGHT = 46;
const STRIP_PAD = 10;

/** Icons per event type, aligned with the engine's WorldEventType order. */
const EVENT_ICONS: readonly string[] = ["🌍", "🌿", "🪦", "📈", "📉", "🩸", "🥩", "☄️", "🚧", "🎮"];

function eventIcon(type: number): string {
  return EVENT_ICONS[type] ?? "•";
}

function eventLabel(event: WorldEventDto, display: WorldDisplayDto | null): string {
  const raw = display?.eventTypeLabels[event.type] ?? `event ${event.type}`;
  // "speciesSplit" -> "species split", for humans.
  return raw.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
}

function severityLabel(severity: number, display: WorldDisplayDto | null): string {
  return display?.eventSeverityLabels[severity] ?? String(severity);
}

export function TimelinePanel(props: TimelinePanelProps): React.JSX.Element {
  const [minSeverity, setMinSeverity] = useState(0);
  const [selectedEventId, setSelectedEventId] = useState<number | null>(null);

  const visible = useMemo(
    () => props.events.filter((event) => event.severity >= minSeverity),
    [props.events, minSeverity],
  );
  const selected = visible.find((event) => event.id === selectedEventId) ?? null;
  const horizon = Math.max(props.currentTick, 1);
  const toX = (tick: number): number =>
    STRIP_PAD + (tick / horizon) * (STRIP_WIDTH - 2 * STRIP_PAD);

  return (
    <aside className="timeline-panel" aria-label="History timeline">
      <div className="panel-title-row">
        <h2>History</h2>
        <div className="panel-title-actions">
          <div
            className="timeline-filter"
            role="radiogroup"
            aria-label="Minimum event severity to show"
          >
            {["all", "notable", "major"].map((label, severity) => (
              <button
                key={label}
                type="button"
                role="radio"
                aria-checked={minSeverity === severity}
                className={minSeverity === severity ? "is-selected" : ""}
                onClick={() => {
                  setMinSeverity(severity);
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <button type="button" onClick={props.onClose} aria-label="Close history panel">
            ✕
          </button>
        </div>
      </div>

      {props.events.length === 0 ? (
        <p className="hint">No events yet. History is written as the world lives.</p>
      ) : (
        <>
          <svg
            className="timeline-strip"
            width="100%"
            height={STRIP_HEIGHT}
            viewBox={`0 0 ${STRIP_WIDTH} ${STRIP_HEIGHT}`}
            preserveAspectRatio="none"
            role="img"
            aria-label={`${visible.length} events across ${formatYear(horizon, props.ticksPerSimYear)}`}
          >
            <line
              className="timeline-axis"
              x1={STRIP_PAD}
              y1={STRIP_HEIGHT - 12}
              x2={STRIP_WIDTH - STRIP_PAD}
              y2={STRIP_HEIGHT - 12}
            />
            {visible.map((event) => (
              <line
                key={event.id}
                className={`timeline-marker severity-${event.severity}${
                  selectedEventId === event.id ? " is-selected" : ""
                }`}
                x1={toX(event.tick)}
                y1={event.severity === 2 ? 6 : event.severity === 1 ? 14 : 20}
                x2={toX(event.tick)}
                y2={STRIP_HEIGHT - 12}
              />
            ))}
          </svg>

          <ol className="timeline-list">
            {[...visible].reverse().map((event) => (
              <li key={event.id}>
                <button
                  type="button"
                  className={`timeline-event severity-${event.severity}${
                    selectedEventId === event.id ? " is-selected" : ""
                  }`}
                  aria-pressed={selectedEventId === event.id}
                  onClick={() => {
                    setSelectedEventId(selectedEventId === event.id ? null : event.id);
                  }}
                >
                  <span className="timeline-event-icon" aria-hidden="true">
                    {eventIcon(event.type)}
                  </span>
                  <span className="timeline-event-name">{eventLabel(event, props.display)}</span>
                  <span className="timeline-event-time">
                    {formatYear(event.tick, props.ticksPerSimYear)}
                  </span>
                </button>
                {selectedEventId === event.id && selected !== null ? (
                  <div className="timeline-event-detail">
                    <dl>
                      <dt>Severity</dt>
                      <dd>{severityLabel(event.severity, props.display)}</dd>
                      <dt>Tick</dt>
                      <dd>{formatInt(event.tick)}</dd>
                      {event.speciesIds.length > 0 ? (
                        <>
                          <dt>Species</dt>
                          <dd>
                            {event.speciesIds.map((speciesId, index) => (
                              <span key={`${event.id}-${speciesId}-${String(index)}`}>
                                {index > 0 ? ", " : ""}
                                <button
                                  type="button"
                                  className="link-button"
                                  onClick={() => {
                                    props.onSelectSpecies(speciesId);
                                  }}
                                >
                                  {speciesName(speciesId)}
                                </button>
                              </span>
                            ))}
                          </dd>
                        </>
                      ) : null}
                      {event.entityIds.length > 0 ? (
                        <>
                          <dt>Organisms</dt>
                          <dd>{event.entityIds.map((id) => `#${id}`).join(", ")}</dd>
                        </>
                      ) : null}
                      {event.region !== null ? (
                        <>
                          <dt>Where</dt>
                          <dd>
                            ({event.region.xLU.toFixed(0)}, {event.region.yLU.toFixed(0)})
                          </dd>
                        </>
                      ) : null}
                    </dl>
                  </div>
                ) : null}
              </li>
            ))}
          </ol>

          {props.droppedBeforeOldest > 0 ? (
            <p className="hint">
              {formatInt(props.droppedBeforeOldest)} older events left the in-memory log
              (persistence arrives with Milestone 10).
            </p>
          ) : null}
        </>
      )}
    </aside>
  );
}
