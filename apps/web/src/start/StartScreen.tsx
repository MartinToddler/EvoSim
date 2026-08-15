import { ENGINE_VERSION } from "@eon/engine";
import type { StartWorldView } from "./startWorlds";

/**
 * The application's first screen (ADR 0025; docs/01 §9 states 1–2).
 *
 * EON no longer boots straight into a running simulation: creating a world is
 * a decision, and so is reopening one. This screen offers exactly those two
 * decisions — New World, or one of the stored worlds — and nothing here
 * advances authoritative time, because no engine exists yet.
 */

export interface StartScreenProps {
  /** Null while the stored-world list is still being read. */
  worlds: readonly StartWorldView[] | null;
  /** Human-readable storage failure, or null. */
  error: string | null;
  onNewWorld: () => void;
  onLoadWorld: (worldId: string) => void;
}

function formatInt(value: number): string {
  return value.toLocaleString("en-US");
}

function formatSavedAt(iso: string): string {
  const time = Date.parse(iso);
  return Number.isNaN(time) ? iso : new Date(time).toLocaleString();
}

export function StartScreen(props: StartScreenProps): React.JSX.Element {
  const { worlds } = props;
  return (
    <div className="start-screen" data-testid="start-screen">
      <header className="start-screen__header">
        <h1>EON</h1>
        <p>
          A deterministic world of evolving life. Create a new world from a seed, or continue one
          you have kept.
        </p>
        <p className="start-screen__version">engine {ENGINE_VERSION}</p>
      </header>

      <div className="start-screen__actions">
        <button
          type="button"
          className="start-screen__primary"
          onClick={props.onNewWorld}
          data-testid="start-new-world"
        >
          New World
        </button>
      </div>

      <section className="start-screen__worlds" aria-label="Saved worlds">
        <h2>Load World</h2>
        {props.error !== null ? (
          <p className="start-screen__error" role="alert">
            Saved worlds are unavailable: {props.error}
          </p>
        ) : worlds === null ? (
          <p className="start-screen__hint">Reading saved worlds…</p>
        ) : worlds.length === 0 ? (
          <p className="start-screen__hint" data-testid="start-no-worlds">
            No saved worlds yet. Every world you create is kept from its very first tick.
          </p>
        ) : (
          <ul className="start-screen__list">
            {worlds.map((world) => (
              <li key={world.worldId} className="start-screen__row" data-testid="start-world-row">
                <div className="start-screen__row-main">
                  <span className="start-screen__name">{world.worldName}</span>
                  <span className="start-screen__meta">
                    {world.seedHex} · tick {formatInt(world.latestTick)} · {world.saveCount} save
                    {world.saveCount === 1 ? "" : "s"} · {formatSavedAt(world.savedAtIso)}
                  </span>
                  {world.branch === null ? null : (
                    <span className="start-screen__meta">
                      branched from{" "}
                      {world.branch.parentName === null
                        ? "a deleted world"
                        : world.branch.parentName}{" "}
                      at tick {formatInt(world.branch.branchTick)}
                    </span>
                  )}
                  {world.loadable ? null : (
                    <span className="start-screen__meta start-screen__stale">
                      saved by engine {world.engineVersion}; this build runs {ENGINE_VERSION}
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => {
                    props.onLoadWorld(world.worldId);
                  }}
                  disabled={!world.loadable}
                  data-testid="start-load-world"
                >
                  Load
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
