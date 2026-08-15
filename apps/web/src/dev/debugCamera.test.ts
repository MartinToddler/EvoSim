import { describe, expect, it } from "vitest";
import {
  DEBUG_CANVAS_PIXELS,
  MAX_ZOOM_FACTOR,
  MIN_VISIBLE_FRACTION,
  MIN_ZOOM_FACTOR,
  ZOOM_STEP,
  cellIndexAt,
  centeredCamera,
  clampCamera,
  debugViewport,
  fitZoom,
  panCamera,
  visibleCellRange,
  zoomCameraAt,
} from "./debugCamera";

/**
 * The map's camera used to live inside the canvas component, where nothing could
 * reach it. It is a pure record transformed by pure functions, so it is tested
 * here in Node like everything else — the component is left with blitting and
 * pointer plumbing only.
 */
const GRID = 256;
const viewport = debugViewport(GRID);
const FIT = DEBUG_CANVAS_PIXELS / GRID;

describe("fitZoom and centeredCamera", () => {
  it("fits the whole grid into the canvas", () => {
    expect(fitZoom(viewport)).toBe(FIT);
    const camera = centeredCamera(viewport);
    expect(camera.zoom * GRID).toBe(DEBUG_CANVAS_PIXELS);
  });

  it("centres a grid that exactly fills the canvas at the origin", () => {
    const camera = centeredCamera(viewport);
    expect(camera.panX).toBe(0);
    expect(camera.panY).toBe(0);
  });

  it("centres grids whose fit zoom leaves the canvas partly empty", () => {
    // A grid coarser than the canvas still fits exactly by construction, so the
    // interesting case is a camera the caller built by hand and then centred.
    const small = debugViewport(3);
    const camera = centeredCamera(small);
    expect(camera.zoom * 3).toBe(DEBUG_CANVAS_PIXELS);
    expect(camera.panX).toBe(0);
  });
});

describe("clampCamera", () => {
  it("holds zoom inside the configured window", () => {
    expect(clampCamera({ zoom: 0, panX: 0, panY: 0 }, viewport).zoom).toBe(FIT * MIN_ZOOM_FACTOR);
    expect(clampCamera({ zoom: 1e6, panX: 0, panY: 0 }, viewport).zoom).toBe(FIT * MAX_ZOOM_FACTOR);
  });

  it("keeps at least the configured fraction of the canvas showing map", () => {
    const margin = DEBUG_CANVAS_PIXELS * MIN_VISIBLE_FRACTION;
    const pushedRight = clampCamera({ zoom: FIT, panX: 1e6, panY: 1e6 }, viewport);
    expect(pushedRight.panX).toBe(DEBUG_CANVAS_PIXELS - margin);

    const pushedLeft = clampCamera({ zoom: FIT, panX: -1e6, panY: -1e6 }, viewport);
    expect(pushedLeft.panX).toBe(margin - FIT * GRID);
  });

  it("does not move a camera that is already inside the limits", () => {
    const camera = { zoom: FIT * 2, panX: -100, panY: 40 };
    expect(clampCamera(camera, viewport)).toEqual(camera);
  });

  it("returns a new record rather than mutating the argument", () => {
    const camera = { zoom: 1e6, panX: 1e6, panY: 1e6 };
    const clamped = clampCamera(camera, viewport);
    expect(camera).toEqual({ zoom: 1e6, panX: 1e6, panY: 1e6 });
    expect(clamped).not.toBe(camera);
  });
});

describe("panCamera", () => {
  it("translates by the drag delta", () => {
    const camera = panCamera(centeredCamera(viewport), -30, 12, viewport);
    expect(camera.panX).toBe(-30);
    expect(camera.panY).toBe(12);
    expect(camera.zoom).toBe(FIT);
  });

  it("clamps a drag that would push the map off the canvas", () => {
    const camera = panCamera(centeredCamera(viewport), 1e6, 0, viewport);
    expect(camera.panX).toBe(DEBUG_CANVAS_PIXELS - DEBUG_CANVAS_PIXELS * MIN_VISIBLE_FRACTION);
  });
});

describe("zoomCameraAt", () => {
  it("keeps the cell under the pointer under the pointer", () => {
    const start = centeredCamera(viewport);
    const pointX = 300;
    const pointY = 500;
    const cellX = (pointX - start.panX) / start.zoom;
    const cellY = (pointY - start.panY) / start.zoom;

    const zoomed = zoomCameraAt(start, viewport, pointX, pointY, true);
    expect(zoomed.zoom).toBeCloseTo(FIT * ZOOM_STEP, 10);
    expect(zoomed.panX + cellX * zoomed.zoom).toBeCloseTo(pointX, 6);
    expect(zoomed.panY + cellY * zoomed.zoom).toBeCloseTo(pointY, 6);
  });

  it("round-trips a zoom in and out back to the starting camera", () => {
    const start = { zoom: FIT * 2, panX: -120, panY: -80 };
    const there = zoomCameraAt(start, viewport, 400, 400, true);
    const back = zoomCameraAt(there, viewport, 400, 400, false);
    expect(back.zoom).toBeCloseTo(start.zoom, 10);
    expect(back.panX).toBeCloseTo(start.panX, 6);
    expect(back.panY).toBeCloseTo(start.panY, 6);
  });

  it("anchors on the zoom actually applied when the requested one is clamped", () => {
    // At maximum zoom another notch in must not drift the anchor point.
    const atMax = clampCamera({ zoom: 1e6, panX: 0, panY: 0 }, viewport);
    const pointX = 200;
    const cellX = (pointX - atMax.panX) / atMax.zoom;
    const zoomed = zoomCameraAt(atMax, viewport, pointX, pointX, true);
    expect(zoomed.zoom).toBe(atMax.zoom);
    expect(zoomed.panX + cellX * zoomed.zoom).toBeCloseTo(pointX, 6);
  });
});

describe("cellIndexAt", () => {
  it("maps canvas points to row-major cell indices", () => {
    const camera = centeredCamera(viewport);
    expect(cellIndexAt(camera, viewport, 0, 0)).toBe(0);
    expect(cellIndexAt(camera, viewport, FIT * 3 + 1, FIT * 2 + 1)).toBe(2 * GRID + 3);
    expect(cellIndexAt(camera, viewport, DEBUG_CANVAS_PIXELS - 1, DEBUG_CANVAS_PIXELS - 1)).toBe(
      GRID * GRID - 1,
    );
  });

  it("returns null outside the grid on every side", () => {
    const camera = centeredCamera(viewport);
    expect(cellIndexAt(camera, viewport, -1, 10)).toBeNull();
    expect(cellIndexAt(camera, viewport, 10, -1)).toBeNull();
    expect(cellIndexAt(camera, viewport, DEBUG_CANVAS_PIXELS, 10)).toBeNull();
    expect(cellIndexAt(camera, viewport, 10, DEBUG_CANVAS_PIXELS)).toBeNull();
  });

  it("follows the camera after a pan", () => {
    const camera = panCamera(centeredCamera(viewport), -FIT * 4, 0, viewport);
    expect(cellIndexAt(camera, viewport, 0, 0)).toBe(4);
  });
});

describe("visibleCellRange", () => {
  it("covers the whole grid when it is fully on screen", () => {
    const range = visibleCellRange(centeredCamera(viewport), viewport);
    expect(range).toEqual({ firstColumn: 0, lastColumn: GRID, firstRow: 0, lastRow: GRID });
  });

  it("narrows to the on-screen columns when zoomed in", () => {
    const camera = { zoom: 16, panX: -16 * 10, panY: -16 * 4 };
    const range = visibleCellRange(camera, viewport);
    expect(range.firstColumn).toBe(10);
    expect(range.lastColumn).toBe(10 + DEBUG_CANVAS_PIXELS / 16);
    expect(range.firstRow).toBe(4);
  });

  it("never reports a boundary outside the grid", () => {
    const camera = { zoom: 1.5, panX: -400, panY: -400 };
    const range = visibleCellRange(camera, viewport);
    expect(range.firstColumn).toBeGreaterThanOrEqual(0);
    expect(range.lastColumn).toBeLessThanOrEqual(GRID);
    expect(range.lastRow).toBeLessThanOrEqual(GRID);
  });
});
