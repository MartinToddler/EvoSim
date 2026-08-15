/**
 * Which screen the page shows.
 *
 * The app has two: the simulation, and the world generator that Milestone 2.5
 * built and Milestone 11 recovered. ADR 0004 (the generator's own) said what
 * should happen once the real screens existed — "it becomes a route or the
 * docs/06 §18 debug overlay behind a dev toggle" — and this is that route.
 *
 * A query parameter rather than a router library: the app has two screens and
 * no navigation state worth a dependency, the seed already travels the same way
 * (`?seed=`), and a link to `?view=generator&seed=0x…` is a shareable, reloadable
 * description of exactly what to look at.
 */

export type AppView = "simulation" | "generator";

/** Query key selecting the screen. */
export const VIEW_PARAM = "view";

/**
 * Read the screen from a location search string.
 *
 * Anything unrecognized falls back to the simulation: a mistyped view is a
 * request for the app, not an error worth a blank page.
 */
export function readViewFromLocation(search: string): AppView {
  const value = new URLSearchParams(search).get(VIEW_PARAM);
  return value === "generator" ? "generator" : "simulation";
}

/** Link to the other screen, preserving every other parameter (the seed above all). */
export function toggleViewHref(search: string, target: AppView): string {
  const params = new URLSearchParams(search);
  if (target === "simulation") {
    params.delete(VIEW_PARAM);
  } else {
    params.set(VIEW_PARAM, target);
  }
  const query = params.toString();
  return query === "" ? "?" : `?${query}`;
}
