import { describe, expect, it } from "vitest";
import { Camera } from "./Camera";

/**
 * Camera geometry (task G08).
 *
 * Pure math, so it is tested as pure math. The properties below are the ones a
 * user feels immediately when they are wrong: zoom that drifts away from the
 * cursor, panning that loses the world off the edge of the screen, a "fit"
 * button that does not fit.
 */

const WORLD = 4096;

function camera(width = 800, height = 600): Camera {
  const instance = new Camera(WORLD);
  instance.setViewport(width, height);
  instance.fitWorld();
  return instance;
}

describe("construction and fit", () => {
  it("starts centred on the world", () => {
    const view = camera();
    expect(view.centerXLU).toBe(WORLD / 2);
    expect(view.centerYLU).toBe(WORLD / 2);
  });

  it("fits the world into the shorter viewport axis", () => {
    const view = camera(800, 600);
    expect(view.zoom).toBeCloseTo(600 / WORLD, 10);
    // The whole world fits vertically; horizontally there is room to spare.
    const bounds = view.visibleBounds();
    expect(bounds.minYLU).toBeCloseTo(0, 6);
    expect(bounds.maxYLU).toBeCloseTo(WORLD, 6);
    expect(bounds.minXLU).toBeLessThan(0);
  });
});

describe("coordinate transforms", () => {
  it("round-trips screen to world and back", () => {
    const view = camera();
    view.setZoom(4);
    view.centerOn(1000, 2000);
    for (const [x, y] of [
      [0, 0],
      [400, 300],
      [799, 599],
    ]) {
      const world = view.screenToWorld(x as number, y as number);
      const screen = view.worldToScreen(world.xLU, world.yLU);
      expect(screen.x).toBeCloseTo(x as number, 6);
      expect(screen.y).toBeCloseTo(y as number, 6);
    }
  });

  it("puts the camera centre at the viewport centre", () => {
    const view = camera();
    view.setZoom(2);
    view.centerOn(1500, 1500);
    const screen = view.worldToScreen(1500, 1500);
    expect(screen.x).toBeCloseTo(400, 6);
    expect(screen.y).toBeCloseTo(300, 6);
  });
});

describe("zoom", () => {
  it("keeps the world point under the pointer exactly still", () => {
    // The property that makes wheel zoom feel like zooming rather than
    // teleporting.
    const view = camera();
    view.setZoom(4);
    view.centerOn(2000, 2000);
    const anchorX = 620;
    const anchorY = 140;
    const before = view.screenToWorld(anchorX, anchorY);

    view.zoomAroundScreen(anchorX, anchorY, 1.8);
    const after = view.screenToWorld(anchorX, anchorY);

    expect(after.xLU).toBeCloseTo(before.xLU, 6);
    expect(after.yLU).toBeCloseTo(before.yLU, 6);
    expect(view.zoom).toBeCloseTo(4 * 1.8, 6);
  });

  it("never zooms out past the fitted world", () => {
    const view = camera();
    view.zoomAroundScreen(400, 300, 0.01);
    expect(view.zoom).toBeCloseTo(view.minZoom, 10);
  });

  it("never zooms in past the ceiling", () => {
    const view = camera();
    view.setZoom(1e9);
    expect(view.zoom).toBe(Camera.MAX_ZOOM);
  });

  it("ignores a non-finite zoom instead of producing NaN coordinates", () => {
    const view = camera();
    view.setZoom(4);
    view.setZoom(Number.NaN);
    expect(view.zoom).toBe(4);
    view.zoomAroundScreen(10, 10, Number.POSITIVE_INFINITY);
    expect(Number.isFinite(view.zoom)).toBe(true);
    expect(Number.isFinite(view.centerXLU)).toBe(true);
  });
});

describe("panning and clamping", () => {
  it("moves the world with the pointer", () => {
    const view = camera();
    view.setZoom(8);
    view.centerOn(2000, 2000);
    view.panByScreen(80, -40);
    // Dragging right moves the camera left, so the world appears to follow the
    // pointer.
    expect(view.centerXLU).toBeCloseTo(2000 - 80 / 8, 6);
    expect(view.centerYLU).toBeCloseTo(2000 + 40 / 8, 6);
  });

  it("cannot be panned off the world", () => {
    const view = camera();
    view.setZoom(8);
    for (let i = 0; i < 200; i += 1) {
      view.panByScreen(500, 500);
    }
    const bounds = view.visibleBounds();
    expect(bounds.maxXLU).toBeLessThanOrEqual(WORLD + 1e-6);
    expect(bounds.maxYLU).toBeLessThanOrEqual(WORLD + 1e-6);

    for (let i = 0; i < 400; i += 1) {
      view.panByScreen(-500, -500);
    }
    const back = view.visibleBounds();
    expect(back.minXLU).toBeGreaterThanOrEqual(-1e-6);
    expect(back.minYLU).toBeGreaterThanOrEqual(-1e-6);
  });

  it("centres an axis that the viewport cannot fill", () => {
    // At minimum zoom on a wide viewport the world is narrower than the screen
    // horizontally; there is no pan position that fills it, so it is centred.
    const view = camera(1600, 400);
    view.panByScreen(-9999, 0);
    expect(view.centerXLU).toBeCloseTo(WORLD / 2, 6);
  });

  it("keeps the view valid when the viewport is resized", () => {
    const view = camera(1200, 900);
    view.setZoom(Camera.MAX_ZOOM);
    view.centerOn(100, 100);
    view.setViewport(300, 200);
    expect(view.zoom).toBeGreaterThanOrEqual(view.minZoom);
    const bounds = view.visibleBounds();
    expect(bounds.minXLU).toBeGreaterThanOrEqual(-1e-6);
    expect(bounds.minYLU).toBeGreaterThanOrEqual(-1e-6);
  });

  it("survives a degenerate viewport", () => {
    const view = new Camera(WORLD);
    view.setViewport(0, 0);
    expect(view.viewportWidth).toBeGreaterThan(0);
    expect(view.viewportHeight).toBeGreaterThan(0);
    expect(Number.isFinite(view.zoom)).toBe(true);
  });
});

describe("state", () => {
  it("reports a detached snapshot of itself", () => {
    const view = camera();
    view.setZoom(3);
    view.centerOn(500, 700);
    const state = view.state();
    expect(state.zoom).toBe(view.zoom);
    state.zoom = 999;
    expect(view.zoom).not.toBe(999);
  });
});
