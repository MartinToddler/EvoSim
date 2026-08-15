/**
 * Deterministic PWA icon generator (task M01, docs/07 Milestone 13).
 *
 * Usage:
 *   pnpm icons        # rewrite apps/web/public/icons/*
 *
 * ## Why generate rather than commit a binary
 *
 * An installable web app needs raster icons — Chromium wants 192 and 512 px
 * PNGs, Android wants a maskable one with safe padding, and iOS ignores SVG for
 * the home screen entirely. Committing opaque binaries into a repository whose
 * whole premise is "every number is reproducible" is the wrong shape: nobody
 * can review a PNG diff, and nobody can tell whether it still matches the
 * favicon in `index.html`.
 *
 * So the icons are *rendered from the same shape description as the favicon*,
 * by this script, and the PNG encoder below is written out longhand — Node's
 * `zlib` supplies the only compression involved. Running it twice produces
 * byte-identical files.
 *
 * The rasteriser supersamples 4x4 per pixel because the design is circles on a
 * rounded square, and aliased circles look broken at 192 px.
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The EON mark, in a 32-unit design box — the same shape as the favicon. */
const DESIGN_BOX = 32;
const BACKDROP = "#0d1a12";
const BODY = "#7cc36a";
const EYE = "#0d1a12";
/** Corner radius of the backdrop, in design units. */
const BACKDROP_RADIUS = 7;
/** Body circle: centre and radius, in design units. */
const BODY_CENTRE = 16;
const BODY_RADIUS = 7;
/** Eye circle: centre and radius, in design units. */
const EYE_X = 19;
const EYE_Y = 13;
const EYE_RADIUS = 2;

/** Supersampling factor per axis. 4x4 = 16 samples per output pixel. */
const SUPERSAMPLE = 4;

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function parseHex(hex: string): Rgb {
  return {
    r: Number.parseInt(hex.slice(1, 3), 16),
    g: Number.parseInt(hex.slice(3, 5), 16),
    b: Number.parseInt(hex.slice(5, 7), 16),
  };
}

/** True when (x, y) in design units is inside the rounded backdrop. */
function insideBackdrop(x: number, y: number, size: number, radius: number): boolean {
  if (x < 0 || y < 0 || x > size || y > size) return false;
  const cx = Math.min(Math.max(x, radius), size - radius);
  const cy = Math.min(Math.max(y, radius), size - radius);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= radius * radius;
}

function insideCircle(x: number, y: number, cx: number, cy: number, r: number): boolean {
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

/**
 * Render the mark into RGBA pixels.
 *
 * `inset` shrinks the mark inside the canvas, in design units per side, which
 * is how the maskable variant keeps its content inside Android's safe zone
 * (the outer ~10% of a maskable icon can be cropped to any shape).
 */
function renderIcon(pixels: number, inset: number, opaque = false): Uint8Array {
  const backdrop = parseHex(BACKDROP);
  const body = parseHex(BODY);
  const eye = parseHex(EYE);
  const out = new Uint8Array(pixels * pixels * 4);

  const drawn = DESIGN_BOX + inset * 2;
  const scale = drawn / pixels;

  for (let py = 0; py < pixels; py += 1) {
    for (let px = 0; px < pixels; px += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          // Design coordinates of this sample, with the inset moving the origin.
          const dx = (px + (sx + 0.5) / SUPERSAMPLE) * scale - inset;
          const dy = (py + (sy + 0.5) / SUPERSAMPLE) * scale - inset;

          let colour: Rgb | null = null;
          if (insideCircle(dx, dy, EYE_X, EYE_Y, EYE_RADIUS)) {
            colour = eye;
          } else if (insideCircle(dx, dy, BODY_CENTRE, BODY_CENTRE, BODY_RADIUS)) {
            colour = body;
          } else if (opaque || insideBackdrop(dx, dy, DESIGN_BOX, BACKDROP_RADIUS)) {
            // `opaque` fills the corners too: iOS masks the home-screen icon
            // with its own rounded rectangle and composites what is left on
            // BLACK, so a transparent corner becomes a black notch outside the
            // mask rather than nothing.
            colour = backdrop;
          }
          if (colour !== null) {
            r += colour.r;
            g += colour.g;
            b += colour.b;
            a += 255;
          }
        }
      }
      const samples = SUPERSAMPLE * SUPERSAMPLE;
      const index = (py * pixels + px) * 4;
      // Premultiplied averaging would darken edges against transparency; the
      // colour channels are averaged over COVERED samples only.
      const covered = a / 255;
      out[index] = covered === 0 ? 0 : Math.round(r / covered);
      out[index + 1] = covered === 0 ? 0 : Math.round(g / covered);
      out[index + 2] = covered === 0 ? 0 : Math.round(b / covered);
      out[index + 3] = Math.round(a / samples);
    }
  }
  return out;
}

// --- Minimal PNG encoder -----------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) {
    c = ((CRC_TABLE[(c ^ byte) & 0xff] as number) ^ (c >>> 8)) >>> 0;
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new Uint8Array([...type].map((ch) => ch.charCodeAt(0)));
  const body = new Uint8Array(typeBytes.length + data.length);
  body.set(typeBytes, 0);
  body.set(data, typeBytes.length);

  const out = new Uint8Array(4 + body.length + 4);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(body, 4);
  view.setUint32(4 + body.length, crc32(body));
  return out;
}

/** Encode RGBA pixels as a PNG. Filter type 0 on every scanline. */
function encodePng(pixels: number, rgba: Uint8Array): Uint8Array {
  const stride = pixels * 4;
  const raw = new Uint8Array((stride + 1) * pixels);
  for (let y = 0; y < pixels; y += 1) {
    raw[y * (stride + 1)] = 0;
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }

  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, pixels);
  ihdrView.setUint32(4, pixels);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  // Level 9 and a fixed strategy so the bytes are reproducible run to run.
  const idat = new Uint8Array(deflateSync(raw, { level: 9 }));

  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const parts = [
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", new Uint8Array(0)),
  ];
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const png = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    png.set(part, at);
    at += part.length;
  }
  return png;
}

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${DESIGN_BOX} ${DESIGN_BOX}">
  <rect width="${DESIGN_BOX}" height="${DESIGN_BOX}" rx="${BACKDROP_RADIUS}" fill="${BACKDROP}"/>
  <circle cx="${BODY_CENTRE}" cy="${BODY_CENTRE}" r="${BODY_RADIUS}" fill="${BODY}"/>
  <circle cx="${EYE_X}" cy="${EYE_Y}" r="${EYE_RADIUS}" fill="${EYE}"/>
</svg>
`;

function main(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const outDir = join(here, "..", "apps", "web", "public", "icons");
  mkdirSync(outDir, { recursive: true });

  const targets: { file: string; pixels: number; inset: number; opaque?: boolean }[] = [
    { file: "icon-192.png", pixels: 192, inset: 0 },
    { file: "icon-512.png", pixels: 512, inset: 0 },
    // Maskable icons may be cropped to any shape; Android's safe zone is the
    // centre 80%, so the mark is inset by 12.5% of the design box per side and
    // the backdrop fills the frame so no crop can expose a corner.
    { file: "icon-maskable-512.png", pixels: 512, inset: DESIGN_BOX * 0.125, opaque: true },
    // iOS home screen: no transparency, no SVG, 180 px.
    { file: "apple-touch-icon.png", pixels: 180, inset: 0, opaque: true },
  ];

  for (const target of targets) {
    const png = encodePng(
      target.pixels,
      renderIcon(target.pixels, target.inset, target.opaque ?? false),
    );
    writeFileSync(join(outDir, target.file), png);
    console.log(`${target.file.padEnd(28)} ${target.pixels}x${target.pixels}  ${png.length} bytes`);
  }

  writeFileSync(join(outDir, "icon.svg"), SVG);
  console.log("icon.svg");
}

main();
