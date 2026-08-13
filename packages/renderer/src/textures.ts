import { Graphics, Rectangle, Texture, type Renderer } from "pixi.js";

/**
 * Procedurally generated sprite textures (docs/06 §§3-4, docs/10 §24).
 *
 * Generated once at startup rather than loaded as assets: the shapes are simple,
 * and generating them keeps the build free of binary art that would have to be
 * versioned, hashed and served. Every texture is created here and destroyed by
 * `EonRenderer.destroy`; nothing allocates a texture per frame or per organism.
 *
 * ## Fixed frames
 *
 * Each texture is generated into an explicit square frame centred on the
 * origin. Without a frame, `generateTexture` would size the texture to the
 * drawn bounds, and the scale factor mapping "body radius in location units" to
 * "sprite scale" would silently depend on the artwork. With a frame the mapping
 * is one constant, {@link SPRITE_FRAME}, and changing a shape cannot change how
 * big organisms appear.
 */

/** Frame edge length, in texture units, for every generated sprite. */
export const SPRITE_FRAME = 64;

export interface RendererTextures {
  /**
   * Organism body: a blunt teardrop pointing along +X, so a rotated sprite
   * visibly shows heading. Drawn white to be tinted per organism.
   */
  body: Texture;
  /**
   * Close-up overlay: eye, jaw hint and contour, in dark ink on transparency.
   * Never tinted — it is drawn over the tinted body to add the phenotype
   * detail docs/06 §3 asks for at LOD 2.
   */
  detail: Texture;
  /** Carrion blob, tinted once. */
  carcass: Texture;
  destroy(): void;
}

function frame(): Rectangle {
  return new Rectangle(-SPRITE_FRAME / 2, -SPRITE_FRAME / 2, SPRITE_FRAME, SPRITE_FRAME);
}

/** Outline of the body, shared by the body fill and the detail contour. */
function traceBody(graphics: Graphics): void {
  graphics
    .moveTo(30, 0)
    .quadraticCurveTo(18, -22, -4, -21)
    .quadraticCurveTo(-28, -18, -28, 0)
    .quadraticCurveTo(-28, 18, -4, 21)
    .quadraticCurveTo(18, 22, 30, 0);
}

export function createRendererTextures(renderer: Renderer): RendererTextures {
  const bodyGraphics = new Graphics();
  traceBody(bodyGraphics);
  bodyGraphics.fill({ color: 0xffffff });
  const body = renderer.generateTexture({
    target: bodyGraphics,
    frame: frame(),
    resolution: 4,
    antialias: true,
  });
  bodyGraphics.destroy();

  const detailGraphics = new Graphics();
  // Contour first, so the eye and jaw sit on top of it.
  traceBody(detailGraphics);
  detailGraphics.stroke({ color: 0x101418, width: 2.5, alpha: 0.85 });
  // Eye, forward and slightly off the mid-line: one eye reads as a direction,
  // two symmetrical eyes read as a face and hide which way the animal points.
  detailGraphics.circle(12, -7, 4.5).fill({ color: 0x0d1114, alpha: 0.9 });
  detailGraphics.circle(13.5, -8, 1.6).fill({ color: 0xffffff, alpha: 0.9 });
  // Jaw hint at the nose.
  detailGraphics
    .moveTo(30, 0)
    .lineTo(20, -6)
    .moveTo(30, 0)
    .lineTo(20, 6)
    .stroke({ color: 0x0d1114, width: 2, alpha: 0.8 });
  const detail = renderer.generateTexture({
    target: detailGraphics,
    frame: frame(),
    resolution: 4,
    antialias: true,
  });
  detailGraphics.destroy();

  const carcassGraphics = new Graphics();
  carcassGraphics
    .moveTo(20, 0)
    .quadraticCurveTo(14, -16, -2, -14)
    .quadraticCurveTo(-20, -12, -18, 2)
    .quadraticCurveTo(-16, 15, 2, 15)
    .quadraticCurveTo(16, 14, 20, 0)
    .fill({ color: 0xffffff });
  const carcass = renderer.generateTexture({
    target: carcassGraphics,
    frame: frame(),
    resolution: 4,
    antialias: true,
  });
  carcassGraphics.destroy();

  return {
    body,
    detail,
    carcass,
    destroy(): void {
      body.destroy(true);
      detail.destroy(true);
      carcass.destroy(true);
    },
  };
}
