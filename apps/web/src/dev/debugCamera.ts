/**
 * Camera arithmetic for the environment debug map (Milestone 2.5).
 *
 * Pure functions over a plain {@link DebugCamera} record: no DOM, no canvas, no
 * React, no engine. The canvas component keeps the live camera in a ref and does
 * nothing to it but call these, which is what lets the map's pan/zoom/probe
 * behaviour be tested in Node like the rest of the project's logic.
 *
 * Nothing here is authoritative. A camera decides which cells are on screen and
 * never what a cell contains.
 */

/** Backing-store resolution of the map canvas. CSS scales the element down. */
export const DEBUG_CANVAS_PIXELS = 768;
/** Multiplicative zoom per wheel notch. */
export const ZOOM_STEP = 1.2;
/** Zoom limits as multiples of the fit-to-canvas zoom. */
export const MIN_ZOOM_FACTOR = 0.5;
export const MAX_ZOOM_FACTOR = 12;
/** Draw cell gridlines once a cell is at least this many device pixels across. */
export const GRIDLINE_MIN_ZOOM = 8;
/** Fraction of the canvas that must keep showing the map while panning. */
export const MIN_VISIBLE_FRACTION = 0.25;

export interface DebugCamera {
  /** Device pixels per environment cell. */
  readonly zoom: number;
  /** Canvas-space position of the grid's top-left corner. */
  readonly panX: number;
  readonly panY: number;
}

export interface DebugViewport {
  /** Canvas backing-store edge in device pixels; the canvas is square. */
  readonly canvasPixels: number;
  /** Environment grid edge in cells. */
  readonly gridSize: number;
}

export function debugViewport(gridSize: number): DebugViewport {
  return { canvasPixels: DEBUG_CANVAS_PIXELS, gridSize };
}

/** Zoom at which the whole grid exactly fills the canvas. */
export function fitZoom(viewport: DebugViewport): number {
  return viewport.canvasPixels / viewport.gridSize;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Clamp zoom to the configured window and pan so the map cannot be dragged
 * entirely off the canvas — at least {@link MIN_VISIBLE_FRACTION} of the canvas
 * keeps showing map.
 */
export function clampCamera(camera: DebugCamera, viewport: DebugViewport): DebugCamera {
  const fit = fitZoom(viewport);
  const zoom = clampNumber(camera.zoom, fit * MIN_ZOOM_FACTOR, fit * MAX_ZOOM_FACTOR);

  const mapPixels = zoom * viewport.gridSize;
  const margin = viewport.canvasPixels * MIN_VISIBLE_FRACTION;
  const minPan = margin - mapPixels;
  const maxPan = viewport.canvasPixels - margin;
  return {
    zoom,
    panX: clampNumber(camera.panX, minPan, maxPan),
    panY: clampNumber(camera.panY, minPan, maxPan),
  };
}

/** Fit-to-canvas camera with the grid centred. */
export function centeredCamera(viewport: DebugViewport): DebugCamera {
  const zoom = fitZoom(viewport);
  const offset = (viewport.canvasPixels - zoom * viewport.gridSize) / 2;
  return { zoom, panX: offset, panY: offset };
}

/** Move the camera by a canvas-space delta (a drag). */
export function panCamera(
  camera: DebugCamera,
  deltaX: number,
  deltaY: number,
  viewport: DebugViewport,
): DebugCamera {
  return clampCamera(
    { zoom: camera.zoom, panX: camera.panX + deltaX, panY: camera.panY + deltaY },
    viewport,
  );
}

/**
 * Zoom one notch about a canvas-space point, keeping the cell under that point
 * under it. The zoom is clamped first, so the anchor is preserved with respect
 * to the zoom actually applied rather than the one requested.
 */
export function zoomCameraAt(
  camera: DebugCamera,
  viewport: DebugViewport,
  pointX: number,
  pointY: number,
  zoomIn: boolean,
): DebugCamera {
  const cellX = (pointX - camera.panX) / camera.zoom;
  const cellY = (pointY - camera.panY) / camera.zoom;

  const requested = camera.zoom * (zoomIn ? ZOOM_STEP : 1 / ZOOM_STEP);
  const { zoom } = clampCamera({ ...camera, zoom: requested }, viewport);

  return clampCamera({ zoom, panX: pointX - cellX * zoom, panY: pointY - cellY * zoom }, viewport);
}

/** Cell index under a canvas-space point, or null when the point is off-grid. */
export function cellIndexAt(
  camera: DebugCamera,
  viewport: DebugViewport,
  x: number,
  y: number,
): number | null {
  const gridX = Math.floor((x - camera.panX) / camera.zoom);
  const gridY = Math.floor((y - camera.panY) / camera.zoom);
  if (gridX < 0 || gridY < 0 || gridX >= viewport.gridSize || gridY >= viewport.gridSize) {
    return null;
  }
  return gridY * viewport.gridSize + gridX;
}

export interface VisibleCellRange {
  readonly firstColumn: number;
  readonly lastColumn: number;
  readonly firstRow: number;
  readonly lastRow: number;
}

/**
 * Inclusive range of cell boundaries that intersect the canvas, so the gridline
 * overlay draws only what is on screen instead of all 257 lines of a 256² grid.
 */
export function visibleCellRange(camera: DebugCamera, viewport: DebugViewport): VisibleCellRange {
  const { canvasPixels, gridSize } = viewport;
  return {
    firstColumn: Math.max(0, Math.floor(-camera.panX / camera.zoom)),
    lastColumn: Math.min(gridSize, Math.ceil((canvasPixels - camera.panX) / camera.zoom)),
    firstRow: Math.max(0, Math.floor(-camera.panY / camera.zoom)),
    lastRow: Math.min(gridSize, Math.ceil((canvasPixels - camera.panY) / camera.zoom)),
  };
}
