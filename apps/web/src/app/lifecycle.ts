/**
 * Page lifecycle: pause when hidden, resume when shown (task M03,
 * docs/02 §20 "lifecycle pause/resume").
 *
 * ## Why a phone needs this and a desktop does not
 *
 * A backgrounded tab keeps its Worker alive on desktop, and a simulation that
 * quietly keeps running is mostly harmless there. On a phone it is a battery
 * drain the user cannot see, and the OS may suspend and resume the process at
 * arbitrary moments — so the app must decide what "away" means rather than
 * discover it.
 *
 * ## It changes scheduling, never state
 *
 * Pausing is exactly the pause button, and the pause button changes when ticks
 * run, never what a tick does (docs/02 §7). A world hidden for an hour and a
 * world watched for an hour reach the same state at the same tick. This module
 * therefore cannot affect determinism even in principle — a property the host's
 * own tests already pin down for pause/resume.
 *
 * ## What "resume" restores
 *
 * The speed the user chose, not a default: someone who left a world at 20x
 * should find it at 20x. A world the user had *already* paused stays paused —
 * hiding a paused tab must not start it running when the tab comes back.
 *
 * ## Saving on the way out
 *
 * `pagehide` is the last event a mobile browser reliably delivers before it may
 * discard the page, so it is where an autosave belongs. It is best effort by
 * construction: IndexedDB writes are asynchronous and the page may be gone
 * before one lands. That is acceptable because losing it costs the last few
 * seconds of a world that autosaves on its own cadence anyway — and because the
 * alternative, blocking teardown, is not available to a web page.
 */

export interface LifecycleTarget {
  /** True while the document is hidden (`document.visibilityState === "hidden"`). */
  isHidden(): boolean;
  /** Pause the running world. Called only when it was running. */
  pause(): void;
  /** Resume at the speed the user last chose. */
  resume(): void;
  /** True when the world is currently paused (by the user or by us). */
  isPaused(): boolean;
  /** Best-effort save before the page may be discarded. */
  saveOnHide(): void;
}

export interface LifecycleEvents {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

/**
 * Wire visibility and page-hide handling to a world.
 *
 * Returns a detach function; calling it leaves the world exactly as it is,
 * including paused-because-hidden. Detaching is teardown, not a resume.
 */
export function attachLifecycle(
  target: LifecycleTarget,
  documentEvents: LifecycleEvents,
  windowEvents: LifecycleEvents,
): () => void {
  // Only a pause WE caused may be undone. Anything else would resume a world
  // the user deliberately stopped.
  let pausedByLifecycle = false;

  const onVisibilityChange = (): void => {
    if (target.isHidden()) {
      if (!target.isPaused()) {
        target.pause();
        pausedByLifecycle = true;
      }
      target.saveOnHide();
      return;
    }
    if (pausedByLifecycle) {
      pausedByLifecycle = false;
      target.resume();
    }
  };

  const onPageHide = (): void => {
    if (!target.isPaused()) {
      target.pause();
      pausedByLifecycle = true;
    }
    target.saveOnHide();
  };

  documentEvents.addEventListener("visibilitychange", onVisibilityChange);
  windowEvents.addEventListener("pagehide", onPageHide);

  return () => {
    documentEvents.removeEventListener("visibilitychange", onVisibilityChange);
    windowEvents.removeEventListener("pagehide", onPageHide);
  };
}
