import { describe, expect, it, vi } from "vitest";
import { attachLifecycle, type LifecycleEvents, type LifecycleTarget } from "./lifecycle";

/**
 * Lifecycle pause/resume (task M03). Every case here is about *whose* decision
 * a pause was: the app may undo its own, never the user's.
 */

class FakeEvents implements LifecycleEvents {
  readonly listeners = new Map<string, Set<() => void>>();

  addEventListener(type: string, listener: () => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener();
    }
  }

  count(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}

function fakeTarget(startPaused = false): LifecycleTarget & {
  hidden: boolean;
  paused: boolean;
  calls: string[];
} {
  const state = {
    hidden: false,
    paused: startPaused,
    calls: [] as string[],
    isHidden: () => state.hidden,
    isPaused: () => state.paused,
    pause: () => {
      state.paused = true;
      state.calls.push("pause");
    },
    resume: () => {
      state.paused = false;
      state.calls.push("resume");
    },
    saveOnHide: () => {
      state.calls.push("save");
    },
  };
  return state;
}

describe("attachLifecycle", () => {
  it("pauses a running world when the page is hidden and resumes it when shown", () => {
    const target = fakeTarget();
    const doc = new FakeEvents();
    const win = new FakeEvents();
    attachLifecycle(target, doc, win);

    target.hidden = true;
    doc.emit("visibilitychange");
    expect(target.paused).toBe(true);
    expect(target.calls).toEqual(["pause", "save"]);

    target.hidden = false;
    doc.emit("visibilitychange");
    expect(target.paused).toBe(false);
    expect(target.calls).toEqual(["pause", "save", "resume"]);
  });

  it("does not start a world the USER had paused", () => {
    const target = fakeTarget(true);
    const doc = new FakeEvents();
    attachLifecycle(target, doc, new FakeEvents());

    target.hidden = true;
    doc.emit("visibilitychange");
    target.hidden = false;
    doc.emit("visibilitychange");

    expect(target.paused).toBe(true);
    expect(target.calls).toEqual(["save"]);
  });

  it("saves on every hide, not only the first", () => {
    const target = fakeTarget();
    const doc = new FakeEvents();
    attachLifecycle(target, doc, new FakeEvents());

    for (let i = 0; i < 3; i += 1) {
      target.hidden = true;
      doc.emit("visibilitychange");
      target.hidden = false;
      doc.emit("visibilitychange");
    }
    expect(target.calls.filter((call) => call === "save")).toHaveLength(3);
  });

  it("pauses and saves on pagehide, the last event a phone reliably delivers", () => {
    const target = fakeTarget();
    const win = new FakeEvents();
    attachLifecycle(target, new FakeEvents(), win);

    win.emit("pagehide");
    expect(target.paused).toBe(true);
    expect(target.calls).toEqual(["pause", "save"]);
  });

  it("a resume after a pagehide-pause still restores the user's speed", () => {
    const target = fakeTarget();
    const doc = new FakeEvents();
    const win = new FakeEvents();
    attachLifecycle(target, doc, win);

    win.emit("pagehide");
    target.hidden = false;
    doc.emit("visibilitychange");
    expect(target.paused).toBe(false);
  });

  it("detaching removes both listeners and leaves the world alone", () => {
    const target = fakeTarget();
    const doc = new FakeEvents();
    const win = new FakeEvents();
    const detach = attachLifecycle(target, doc, win);

    target.hidden = true;
    doc.emit("visibilitychange");
    detach();

    expect(doc.count("visibilitychange")).toBe(0);
    expect(win.count("pagehide")).toBe(0);
    // Still paused: teardown is not a resume.
    expect(target.paused).toBe(true);

    target.hidden = false;
    doc.emit("visibilitychange");
    expect(target.paused).toBe(true);
  });

  it("never calls resume without a matching lifecycle pause", () => {
    const target = fakeTarget();
    const doc = new FakeEvents();
    attachLifecycle(target, doc, new FakeEvents());

    const resume = vi.spyOn(target, "resume");
    doc.emit("visibilitychange"); // visible, and nothing had hidden it
    expect(resume).not.toHaveBeenCalled();
  });
});
