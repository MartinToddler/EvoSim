import { useCallback, useEffect, useRef, useState } from "react";
import type {
  EntityDetailsDto,
  HostRuntimeConfig,
  SimulationSpeed,
  TelemetryDto,
  WorkerErrorDto,
  WorldSummaryDto,
} from "@eon/protocol";
import { WorldSession } from "./app/WorldSession";
import { InspectorPanel } from "./components/InspectorPanel";
import { TopBar } from "./components/TopBar";
import { DEFAULT_SEED, readSeedFromLocation } from "./app/seed";
import "./styles/app.css";

/**
 * Milestone 6 application shell.
 *
 * ## What React holds, and what it does not
 *
 * State here is world metadata, 2 Hz telemetry, the selected entity ID and its
 * details — the list docs/10 §23 marks safe. No organism coordinate ever enters
 * React state, so a world of 8192 organisms causes exactly the same number of
 * renders as an empty one: two per second.
 *
 * The canvas is not a React-managed element either. It is created imperatively
 * by the session effect and removed on cleanup, which keeps Pixi's WebGL
 * context and React's reconciler out of each other's way — and makes
 * StrictMode's deliberate double-mount harmless instead of a source of two
 * simulations sharing one canvas.
 */
export function App(): React.JSX.Element {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const sessionRef = useRef<WorldSession | null>(null);

  const [world, setWorld] = useState<WorldSummaryDto | null>(null);
  const [hostRuntime, setHostRuntime] = useState<HostRuntimeConfig | null>(null);
  const [telemetry, setTelemetry] = useState<TelemetryDto | null>(null);
  const [speed, setSpeed] = useState<SimulationSpeed>("x1");
  const [selectedEntityId, setSelectedEntityId] = useState<number | null>(null);
  const [details, setDetails] = useState<EntityDetailsDto | null>(null);
  const [selectionGone, setSelectionGone] = useState(false);
  const [error, setError] = useState<WorkerErrorDto | null>(null);
  const [debugOverlay, setDebugOverlay] = useState(false);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport === null) {
      return;
    }
    const canvas = document.createElement("canvas");
    viewport.appendChild(canvas);

    const session = WorldSession.start({
      canvas,
      viewport,
      seed: readSeedFromLocation(globalThis.location?.search ?? ""),
      // Worlds open running: the point of this milestone is that you can open
      // the page and watch organisms live.
      initialSpeed: "x1",
      callbacks: {
        onWorldReady: (readyWorld, runtime) => {
          setWorld(readyWorld);
          setHostRuntime(runtime);
        },
        onTelemetry: (next) => {
          setTelemetry(next);
        },
        onSelectionChange: (entityId) => {
          setSelectedEntityId(entityId);
          setSelectionGone(false);
          if (entityId === null) {
            setDetails(null);
          }
        },
        onEntityDetails: (payload) => {
          setDetails(payload.details);
          setSelectionGone(payload.details === null);
        },
        onError: (workerError) => {
          setError(workerError);
        },
      },
    });
    sessionRef.current = session;

    // Stop producing pictures nobody is looking at. The simulation keeps
    // ticking: a hidden tab should still evolve, it just should not paint.
    const onVisibility = (): void => {
      session.setRenderStream(!document.hidden);
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      session.destroy();
      sessionRef.current = null;
      canvas.remove();
    };
  }, []);

  const changeSpeed = useCallback((next: SimulationSpeed) => {
    setSpeed(next);
    sessionRef.current?.setSpeed(next);
  }, []);

  const toggleDebug = useCallback(() => {
    setDebugOverlay((previous) => {
      const next = !previous;
      sessionRef.current?.setDebugOverlay(next);
      return next;
    });
  }, []);

  const fitWorld = useCallback(() => {
    sessionRef.current?.fitWorld();
  }, []);

  const clearSelection = useCallback(() => {
    sessionRef.current?.clearSelection();
  }, []);

  const focusSelection = useCallback(() => {
    sessionRef.current?.focusSelected();
  }, []);

  return (
    <div className="app">
      <div className="viewport" ref={viewportRef} />

      <TopBar
        world={world}
        hostRuntime={hostRuntime}
        telemetry={telemetry}
        speed={speed}
        debugOverlay={debugOverlay}
        onSpeedChange={changeSpeed}
        onToggleDebug={toggleDebug}
        onFitWorld={fitWorld}
      />

      {world === null && error === null ? (
        <div className="banner">
          <strong>Generating world {DEFAULT_SEED}…</strong>
          <p className="hint">Procedural terrain, plants and the founder population.</p>
        </div>
      ) : null}

      <InspectorPanel
        selectedEntityId={selectedEntityId}
        details={details}
        gone={selectionGone}
        onClear={clearSelection}
        onFocus={focusSelection}
      />

      {error !== null ? (
        <div className="error-banner" role="alert">
          <strong>{error.fatal ? "Simulation stopped" : "Worker warning"}</strong>
          <div>{error.message}</div>
          <div className="hint">
            engine {error.engineVersion}
            {error.tick === null ? "" : ` · tick ${error.tick}`}
            {error.whileHandling === null ? "" : ` · handling ${error.whileHandling}`}
          </div>
        </div>
      ) : null}
    </div>
  );
}
