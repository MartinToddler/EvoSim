import {
  type DebugPixelBuffer,
  type EnvironmentDebugFields,
  type EnvironmentDebugLayerId,
  createDebugPixelBuffer,
  paintEnvironmentLayer,
} from "@eon/renderer";
import { memo, useCallback, useEffect, useRef } from "react";
import {
  DEBUG_CANVAS_PIXELS,
  type DebugCamera,
  type DebugViewport,
  GRIDLINE_MIN_ZOOM,
  cellIndexAt,
  centeredCamera,
  debugViewport,
  panCamera,
  visibleCellRange,
  zoomCameraAt,
} from "./debugCamera";

/**
 * Canvas 2D projection of one environment layer, with pan, zoom and a hover probe.
 *
 * This is a development tool, not the Milestone 6 renderer. It is deliberately
 * Canvas 2D and deliberately imperative:
 *
 * - the pixels come from `@eon/renderer`'s pure painter and the camera maths from
 *   `debugCamera.ts`, so the only thing this file adds is blitting, canvas
 *   overlays and pointer plumbing;
 * - camera state lives in a ref and the canvas is redrawn imperatively, so
 *   dragging never re-renders React (CLAUDE.md React boundary: high-frequency
 *   view state does not belong in React state);
 * - the hovered cell is reported upward only when it actually changes, which is a
 *   selection event, not a stream;
 * - the component is memoized, so a hover reported upward cannot bounce back down
 *   as a re-render of the map.
 *
 * No simulation decision is made here, and no field value is computed here.
 */

/** Bytes per pixel in the painter's RGBA output. */
const RGBA_STRIDE = 4;

export interface EnvironmentFieldCanvasProps {
  readonly fields: EnvironmentDebugFields;
  readonly layer: EnvironmentDebugLayerId;
  /**
   * Identity of the map being shown (`DebugWorldModel.worldKey`).
   *
   * The camera recenters when this changes — a different planet has no continuity
   * with the last view. It must NOT be derived from the tick: advancing time
   * re-reads the same world into new arrays, and resetting the camera for that
   * would throw away the region the user was inspecting.
   */
  readonly worldKey: string;
  /** Founder region marker, in grid cells. */
  readonly markerGridX: number;
  readonly markerGridY: number;
  readonly markerRadiusCells: number;
  /** Any change to this value recenters the camera on request. */
  readonly recenterToken: number;
  /** Called with the hovered cell index, or null when the pointer leaves the grid. */
  readonly onHoverCellChange: (cellIndex: number | null) => void;
}

function EnvironmentFieldCanvasImpl({
  fields,
  layer,
  worldKey,
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
  const cameraRef = useRef<DebugCamera>(centeredCamera(debugViewport(fields.size)));
  const draggingRef = useRef<{ pointerId: number; lastX: number; lastY: number } | null>(null);
  const hoveredRef = useRef<number | null>(null);
  /** Last (world, token) pair the camera was reset for; see the recenter effect. */
  const recenteredForRef = useRef<string | null>(null);

  const viewport: DebugViewport = debugViewport(fields.size);

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
    context.fillRect(0, 0, DEBUG_CANVAS_PIXELS, DEBUG_CANVAS_PIXELS);
    context.drawImage(source, 0, 0, size, size, camera.panX, camera.panY, mapPixels, mapPixels);

    // World bounds, so the edge of the map is visible when zoomed out.
    context.strokeStyle = "rgba(255, 255, 255, 0.45)";
    context.lineWidth = 1;
    context.strokeRect(camera.panX + 0.5, camera.panY + 0.5, mapPixels - 1, mapPixels - 1);

    if (camera.zoom >= GRIDLINE_MIN_ZOOM) {
      drawCellGrid(context, camera, debugViewport(size));
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

    const expectedBytes = fields.size * fields.size * RGBA_STRIDE;
    if (pixelsRef.current === null || pixelsRef.current.length !== expectedBytes) {
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

  // A different world resets the camera; panning a fresh planet from the last
  // view is disorienting and there is no continuity between two seeds. Advancing
  // time is NOT a different world, so the guard compares the map's identity
  // rather than re-running whenever the field arrays are replaced.
  useEffect(() => {
    const key = `${worldKey}|${recenterToken}`;
    if (recenteredForRef.current === key) {
      return;
    }
    recenteredForRef.current = key;
    cameraRef.current = centeredCamera(debugViewport(fields.size));
    draw();
  }, [worldKey, recenterToken, fields, draw]);

  // Wheel zoom is registered manually because it must be non-passive to
  // preventDefault the page scroll.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) {
      return;
    }
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const point = canvasPoint(canvas, event.clientX, event.clientY);
      cameraRef.current = zoomCameraAt(
        cameraRef.current,
        debugViewport(fields.size),
        point.x,
        point.y,
        event.deltaY < 0,
      );
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
      cameraRef.current = panCamera(
        cameraRef.current,
        point.x - dragging.lastX,
        point.y - dragging.lastY,
        viewport,
      );
      dragging.lastX = point.x;
      dragging.lastY = point.y;
      draw();
      return;
    }

    reportHover(cellIndexAt(cameraRef.current, viewport, point.x, point.y));
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
      width={DEBUG_CANVAS_PIXELS}
      height={DEBUG_CANVAS_PIXELS}
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

/**
 * Memoized: the hovered cell this component reports travels up to the view and
 * comes back down as a re-render of the whole panel. Every prop here is either a
 * primitive or an object that changes only when the world does, so the map's
 * subtree can sit out a hover entirely.
 */
export const EnvironmentFieldCanvas = memo(EnvironmentFieldCanvasImpl);

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

/** Environment cell boundaries (docs/06 §18 debug overlay: environment grid). */
function drawCellGrid(
  context: CanvasRenderingContext2D,
  camera: DebugCamera,
  viewport: DebugViewport,
): void {
  const range = visibleCellRange(camera, viewport);
  const mapPixels = camera.zoom * viewport.gridSize;

  context.strokeStyle = "rgba(0, 0, 0, 0.25)";
  context.lineWidth = 1;
  context.beginPath();
  for (let gx = range.firstColumn; gx <= range.lastColumn; gx += 1) {
    const x = Math.round(camera.panX + gx * camera.zoom) + 0.5;
    context.moveTo(x, camera.panY);
    context.lineTo(x, camera.panY + mapPixels);
  }
  for (let gy = range.firstRow; gy <= range.lastRow; gy += 1) {
    const y = Math.round(camera.panY + gy * camera.zoom) + 0.5;
    context.moveTo(camera.panX, y);
    context.lineTo(camera.panX + mapPixels, y);
  }
  context.stroke();
}

/** Founder spawn region (docs/03 §26) — the one annotation this view draws. */
function drawFounderMarker(
  context: CanvasRenderingContext2D,
  camera: DebugCamera,
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
