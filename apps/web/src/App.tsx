import { EnvironmentDebugView } from "./dev/EnvironmentDebugView";

/**
 * Application shell.
 *
 * Through Milestone 2.5 the app has exactly one screen: the environment debug
 * view. That is deliberate — the product's real screens (world list, simulation
 * screen with the Pixi renderer and the observation UI) belong to Milestones 6–7,
 * and there is nothing to observe until organisms exist in Milestone 3.
 *
 * The debug view is a development tool. When the real screens land it becomes a
 * route or the docs/06 §18 debug overlay behind a dev toggle, and it is confined to
 * `src/dev/` plus `@eon/renderer/debug` so that either move is a small one.
 */
export function App() {
  return <EnvironmentDebugView />;
}
