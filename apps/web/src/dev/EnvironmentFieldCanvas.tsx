import {
  type DebugPixelBuffer,
  type EnvironmentDebugFields,
  type EnvironmentDebugLayerId,
  createDebugPixelBuffer,
  paintEnvironmentLayer,
} from "@eon/renderer";
import { useCallback, useEffect, useRef } from "react";

/**
 * Canvas 2D projection of one environment layer, with pan, zoom and a hover probe.
 *
 * This is a development tool, not the Milestone 6 renderer. It is deliberately
 * Canvas 2D and deliberately imperative:
 *
 * - the pixels come from `@eon/renderer`'s pure painter, so the only thing this
 *   file adds is blitting, camera arithmetic and pointer handling;
 * - camera state lives in a ref and the canvas is redrawn imperatively, so
 *   dragging never re-renders React (CLAUDE.md React boundary: high-frequency
 *   view state does not belong in React state);
 * - the hovered cell is reported upward only when it actually changes, which is a
 *   selection event, not a stream.
 *
 * No simulation decision is made here, and no field value is computed here.
 */

/** Backing-store resolution. CSS scales the element; nearest-neighbour keeps cells crisp. */
const CANVAS_PIXELS = 768;
/** Multiplicative zoom per wheel notch. */
const ZOOM_STEP = 1.2;
/** Zoom limits as multiples of the fit-to-canvas zoom. */
const MIN_ZOOM_FACTOR = 0.5;
const MAX_ZOOM_FACTOR = 12;
/** Draw cell gridlines once a cell is at least this many device pixels across. */
const GRIDLINE_MIN_ZOOM = 8;
/** Fraction of the canvas that must keep showing the map while panning. */
const MIN_VISIBLE_FRACTION = 0.25;

interface Camera {
  /** Device pixels per environment cell. */
  zoom: number;
  /** Canvas-space position of the grid's top-left corner. */
  panX: number;
  panY: number;
}

export interface EnvironmentFieldCanvasProps {
  readonly fields: EnvironmentDebugFields;
  readonly layer: EnvironmentDebugLayerId;
  /** Founder region marker, in grid cells. */
  readonly markerGridX: number;
  readonly markerGridY: number;
  readonly markerRadiusCells: number;
  /** Any change to this value recenters the camera; a new world does so anyway. */
  readonly recenterToken: number;
  /** Called with the hovered cell index, or null when the pointer leaves the grid. */
  readonly onHoverCellChange: (cellIndex: number | null) => void;
}

function fitZoom(size: number): number {
  return CANVAS_PIXELS / size;
}

function clampCamera(camera: Camera, size: number): void {
  const fit = fitZoom(size);
  camera.zoom = Math.min(Math.max(camera.zoom, fit * MIN_ZOOM_FACTOR), fit * MAX_ZOOM_FACTOR);

  const mapPixels = camera.zoom * size;
  const margin = CANVAS_PIXELS * MIN_VISIBLE_FRACTION;
  const minPan = margin - mapPixels;
  const maxPan = CANVAS_PIXELS - margin;
  camera.panX = Math.min(Math.max(camera.panX, minPan), maxPan);
  camera.panY = Math.min(Math.max(camera.panY, minPan), maxPan);
}

function centeredCamera(size: number): Camera {
  const zoom = fitZoom(size);
  const offset = (CANVAS_PIXELS - zoom * size) / 2;
  return { zoom, panX: offset, panY: offset };
}

export function EnvironmentFieldCanvas({
  fields,
  layer,
  markerGridX,
  markerGridY,
  markerRadiusCells,
  recenterToken,
  onHoverCellChange,
}: EnvironmentFieldCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  /** Offscreen canvas holding one texel per environment cell. */
  const sourceRef = useRef<HTMLCanvasElement | null>(null);
  const pixelsRef = useRef<DebugPixelBuffer | null>(null);
  const cameraRef = useRef<Camera>(centeredCamera(fields.size));
  const draggingRef = useRef<{ pointerId: number; lastX: number; lastY: number } | null>(null);
  const hoveredRef = useRef<number | null>(null);

  /** Blit the offscreen layer image, then the debug overlays, at the current camera. */
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const source = sourceRef.current;
    if (canvas === null || source === null) {
      return;
    }
    const context = canvas.getContext("2d");
    if (context === null) {
      return;
    }

    const camera = cameraRef.current;
    const { size } = fields;
    const mapPixels = camera.zoom * size;

    context.imageSmoothingEnabled = false;
    context.fillStyle = "#0b0d10";
    context.fillRect(0, 0, CANVAS_PIXELS, CANVAS_PIXELS);
    context.drawImage(source, 0, 0, size, size, camera.panX, camera.panY, mapPixels, mapPixels);

    // World bounds, so the edge of the map is visible when zoomed out.
    context.strokeStyle = "rgba(255, 255, 255, 0.45)";
    context.lineWidth = 1;
    context.strokeRect(camera.panX + 0.5, camera.panY + 0.5, mapPixels - 1, mapPixels - 1);

    if (camera.zoom >= GRIDLINE_MIN_ZOOM) {
      drawCellGrid(context, camera, size);
    }
    drawFounderMarker(context, camera, markerGridX, markerGridY, markerRadiusCells);
  }, [fields, markerGridX, markerGridY, markerRadiusCells]);

  // Repaint the offscreen layer image whenever the world or the layer changes.
  useEffect(() => {
    if (sourceRef.current === null) {
      sourceRef.current = document.createElement("canvas");
    }
    const source = sourceRef.current;
    source.width = fields.size;
    source.height = fields.size;

    if (pixelsRef.current === null || pixelsRef.current.length !== fields.size * fields.size * 4) {
      pixelsRef.current = createDebugPixelBuffer(fields);
    }
    const pixels = pixelsRef.current;
    paintEnvironmentLayer(fields, layer, pixels);

    const context = source.getContext("2d");
    if (context === null) {
      throw new Error("Canvas 2D context unavailable; the debug view needs it to show a world.");
    }
    context.putImageData(new ImageData(pixels, fields.size, fields.size), 0, 0);
    draw();
  }, [fields, layer, draw]);

  // A new world resets the camera; panning a fresh planet from the last view is
  // disorienting and there is no continuity between two seeds. The token lets the
  // UI ask for the same reset explicitly.
  useEffect(() => {
    cameraRef.current = centeredCamera(fields.size);
    draw();
  }, [fields, recenterToken, draw]);

  // Wheel zoom is registered manually because it must be non-passive to
  // preventDefault the page scroll.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) {
      return;
    }
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const camera = cameraRef.current;
      const point = canvasPoint(canvas, event.clientX, event.clientY);
      const cellX = (point.x - camera.panX) / camera.zoom;
      const cellY = (point.y - camera.panY) / camera.zoom;

      camera.zoom *= event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
      clampCamera(camera, fields.size);
      // Keep the cell under the pointer under the pointer.
      camera.panX = point.x - cellX * camera.zoom;
      camera.panY = point.y - cellY * camera.zoom;
      clampCamera(camera, fields.size);
      draw();
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      canvas.removeEventListener("wheel", onWheel);
    };
  }, [fields, draw]);

  const reportHover = useCallback(
    (cellIndex: number | null) => {
      if (hoveredRef.current !== cellIndex) {
        hoveredRef.current = cellIndex;
        onHoverCellChange(cellIndex);
      }
    },
    [onHoverCellChange],
  );

  const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    const canvas = canvasRef.current;
    if (canvas === null) {
      return;
    }
    const point = canvasPoint(canvas, event.clientX, event.clientY);
    draggingRef.current = { pointerId: event.pointerId, lastX: point.x, lastY: point.y };
    canvas.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    const canvas = canvasRef.current;
    if (canvas === null) {
      return;
    }
    const point = canvasPoint(canvas, event.clientX, event.clientY);
    const dragging = draggingRef.current;

    if (dragging !== null && dragging.pointerId === event.pointerId) {
      const camera = cameraRef.current;
      camera.panX += point.x - dragging.lastX;
      camera.panY += point.y - dragging.lastY;
      dragging.lastX = point.x;
      dragging.lastY = point.y;
      clampCamera(camera, fields.size);
      draw();
      return;
    }

    reportHover(cellIndexAt(cameraRef.current, fields.size, point.x, point.y));
  };

  const endDrag = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    const dragging = draggingRef.current;
    if (dragging !== null && dragging.pointerId === event.pointerId) {
      draggingRef.current = null;
      canvasRef.current?.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <canvas
      ref={canvasRef}
      className="eon-debug-canvas"
      width={CANVAS_PIXELS}
      height={CANVAS_PIXELS}
      role="img"
      aria-label={`Environment ${layer} layer, ${fields.size} by ${fields.size} cells. Numeric values are listed beside the map.`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onPointerLeave={() => {
        reportHover(null);
      }}
    />
  );
}

/** Pointer position in canvas backing-store pixels. */
function canvasPoint(
  canvas: HTMLCanvasElement,
  clientX: number,
  clientY: number,
): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  const scaleX = rect.width === 0 ? 1 : canvas.width / rect.width;
  const scaleY = rect.height === 0 ? 1 : canvas.height / rect.height;
  return { x: (clientX - rect.left) * scaleX, y: (clientY - rect.top) * scaleY };
}

/** Cell index under a canvas-space point, or null when outside the grid. */
function cellIndexAt(camera: Camera, size: number, x: number, y: number): number | null {
  const gridX = Math.floor((x - camera.panX) / camera.zoom);
  const gridY = Math.floor((y - camera.panY) / camera.zoom);
  if (gridX < 0 || gridY < 0 || gridX >= size || gridY >= size) {
    return null;
  }
  return gridY * size + gridX;
}

/** Environment cell boundaries (docs/06 §18 debug overlay: environment grid). */
function drawCellGrid(context: CanvasRenderingContext2D, camera: Camera, size: number): void {
  const firstVisible = Math.max(0, Math.floor(-camera.panX / camera.zoom));
  const lastVisible = Math.min(size, Math.ceil((CANVAS_PIXELS - camera.panX) / camera.zoom));
  const firstRow = Math.max(0, Math.floor(-camera.panY / camera.zoom));
  const lastRow = Math.min(size, Math.ceil((CANVAS_PIXELS - camera.panY) / camera.zoom));

  context.strokeStyle = "rgba(0, 0, 0, 0.25)";
  context.lineWidth = 1;
  context.beginPath();
  for (let gx = firstVisible; gx <= lastVisible; gx += 1) {
    const x = Math.round(camera.panX + gx * camera.zoom) + 0.5;
    context.moveTo(x, camera.panY);
    context.lineTo(x, camera.panY + camera.zoom * size);
  }
  for (let gy = firstRow; gy <= lastRow; gy += 1) {
    const y = Math.round(camera.panY + gy * camera.zoom) + 0.5;
    context.moveTo(camera.panX, y);
    context.lineTo(camera.panX + camera.zoom * size, y);
  }
  context.stroke();
}

/** Founder spawn region (docs/03 §26) — the one annotation this view draws. */
function drawFounderMarker(
  context: CanvasRenderingContext2D,
  camera: Camera,
  gridX: number,
  gridY: number,
  radiusCells: number,
): void {
  const centreX = camera.panX + (gridX + 0.5) * camera.zoom;
  const centreY = camera.panY + (gridY + 0.5) * camera.zoom;
  const radius = Math.max(4, radiusCells * camera.zoom);

  for (const [color, width] of [
    ["rgba(0, 0, 0, 0.75)", 4],
    ["rgba(255, 235, 120, 0.95)", 2],
  ] as const) {
    context.strokeStyle = color;
    context.lineWidth = width;
    context.beginPath();
    context.arc(centreX, centreY, radius, 0, Math.PI * 2);
    context.moveTo(centreX - radius - 6, centreY);
    context.lineTo(centreX + radius + 6, centreY);
    context.moveTo(centreX, centreY - radius - 6);
    context.lineTo(centreX, centreY + radius + 6);
    context.stroke();
  }
}
