import { useCallback, useState } from "react";
import { formatInt } from "../format";

/**
 * Historical navigation panel (Milestone 11, tasks K07–K10; docs/06 §§13, 29–30).
 *
 * Three states, and the panel has to make which one you are in unmistakable:
 * the present, a reconstruction in flight, and a read-only preview of an
 * earlier tick.
 *
 * ## Dragging selects; releasing rewinds
 *
 * docs/06 §13: "Dragging timeline only selects time; explicit action starts
 * rewind." That is also the only practical design — a pointer drag emits dozens
 * of values a second and each one would queue a replay of thousands of ticks.
 * The scrubber therefore keeps a local selection and raises `onRewind` on
 * release (pointer up, or key up for keyboard users), not on every change.
 *
 * ## Dependency-free, like the other panels
 *
 * Plain view models and callbacks; no engine, protocol or storage types.
 */

export interface HistoryPanelProps {
  mode: "live" | "reconstructing" | "historical";
  /** Tick of the live world. The present, and the top of the scrubber's range. */
  presentTick: number;
  /** Earliest tick this world can reach: 0, or the branch point for a branch. */
  originTick: number;
  /** Tick being previewed, or null in the present. */
  historicalTick: number | null;
  progress: { ticksReplayed: number; ticksTotal: number } | null;
  /** Ticks with a stored save, where a rewind needs no replay at all. */
  saveTicks: readonly number[];
  message: string;
  failed: boolean;
  /**
   * False when the world has never been saved. Rewinding needs a save to replay
   * from, so the panel explains that rather than offering a control that cannot
   * work.
   */
  canRewind: boolean;
  onRewind: (tick: number) => void;
  onReturnToPresent: () => void;
  onBranch: (name: string) => void;
}

function progressPercent(replayed: number, total: number): number {
  if (total <= 0) {
    return 100;
  }
  return Math.min(100, Math.max(0, (replayed / total) * 100));
}

export function HistoryPanel(props: HistoryPanelProps): React.JSX.Element {
  const { mode, presentTick, originTick, historicalTick, progress, saveTicks } = props;
  const busy = mode === "reconstructing";
  const previewing = mode === "historical";

  const [selected, setSelected] = useState<number | null>(null);
  const [branchName, setBranchName] = useState("");

  // What the handle points at: the tick being dragged, else the previewed tick,
  // else the present.
  const position = selected ?? historicalTick ?? presentTick;

  const commit = useCallback(
    (value: number) => {
      setSelected(null);
      if (value !== historicalTick) {
        props.onRewind(value);
      }
    },
    [historicalTick, props],
  );

  const span = presentTick - originTick;

  return (
    <section className="panel history-panel" aria-label="History">
      <header className="panel__header">
        <h2>History</h2>
        <span className={previewing ? "history-panel__badge" : "history-panel__badge--live"}>
          {previewing ? "Historical preview — read only" : "Live"}
        </span>
      </header>

      {previewing ? (
        <p className="history-panel__notice" role="status">
          Viewing tick {formatInt(historicalTick ?? 0)} of {formatInt(presentTick)}. The world is
          paused and interventions are disabled. Branch from this tick to change what happens next.
        </p>
      ) : null}

      {!props.canRewind ? (
        <p className="history-panel__notice">
          Save this world to explore its history: a rewind replays from the nearest save.
        </p>
      ) : null}

      <label className="history-panel__scrubber">
        <span className="visually-hidden">Timeline</span>
        <input
          type="range"
          min={originTick}
          max={Math.max(originTick, presentTick)}
          step={1}
          value={position}
          disabled={busy || !props.canRewind || span <= 0}
          list="history-panel-saves"
          onChange={(event) => {
            setSelected(Number(event.target.value));
          }}
          onPointerUp={(event) => {
            commit(Number((event.target as HTMLInputElement).value));
          }}
          onKeyUp={(event) => {
            commit(Number((event.target as HTMLInputElement).value));
          }}
          aria-valuetext={`tick ${formatInt(position)}`}
          data-testid="history-scrubber"
        />
        <datalist id="history-panel-saves">
          {saveTicks.map((tick) => (
            <option key={tick} value={tick} />
          ))}
        </datalist>
      </label>

      <div className="history-panel__range">
        <span>tick {formatInt(originTick)}</span>
        <span data-testid="history-position">tick {formatInt(position)}</span>
        <span>now {formatInt(presentTick)}</span>
      </div>

      {progress !== null ? (
        <div className="history-panel__progress" role="status">
          <div
            className="history-panel__bar"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progressPercent(progress.ticksReplayed, progress.ticksTotal))}
          >
            <div
              className="history-panel__fill"
              style={{ width: `${progressPercent(progress.ticksReplayed, progress.ticksTotal)}%` }}
            />
          </div>
          <span>
            Replaying {formatInt(progress.ticksReplayed)} of {formatInt(progress.ticksTotal)} ticks
          </span>
        </div>
      ) : null}

      <div className="history-panel__actions">
        <button
          type="button"
          disabled={busy || !previewing}
          onClick={props.onReturnToPresent}
          data-testid="return-to-present"
        >
          Return to present
        </button>
      </div>

      {previewing ? (
        <div className="history-panel__branch">
          <label>
            <span className="visually-hidden">Branch name</span>
            <input
              type="text"
              value={branchName}
              placeholder={`Branch at ${formatInt(historicalTick ?? 0)}`}
              onChange={(event) => {
                setBranchName(event.target.value);
              }}
              data-testid="branch-name"
            />
          </label>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              props.onBranch(
                branchName.trim() === ""
                  ? `Branch at ${formatInt(historicalTick ?? 0)}`
                  : branchName.trim(),
              );
              setBranchName("");
            }}
            data-testid="create-branch"
          >
            Branch from this tick
          </button>
        </div>
      ) : null}

      <p className={props.failed ? "history-panel__message--failed" : "history-panel__message"}>
        {props.message}
      </p>
    </section>
  );
}
