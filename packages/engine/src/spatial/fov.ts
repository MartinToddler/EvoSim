/**
 * Scale of the cached half-FOV cosine and of the forward basis used in every
 * visibility test (docs/04 §12).
 *
 * The tests compare `(d·f)²` with `cos² · |d|²` so they need no square root per
 * candidate. At full TRIG_SCALE precision that product would reach ~2.6e18 and
 * lose exactness above 2^53; at this scale the worst case is ~1.6e14. The cost
 * is an angular resolution of a fraction of a degree at the FOV boundary, which
 * no ecological outcome can depend on.
 *
 * It lives in its own module because both sides of the vision calculation need
 * it: `organisms/phenotype.ts` caches the scaled cosine, and `spatial/queries.ts`
 * scales the heading basis to match. Keeping it in `queries.ts` while `queries.ts`
 * needs the phenotype's body radius would make those two modules import each
 * other, and an import cycle that happens to work today because every use sits
 * inside a function body is not a property worth relying on.
 */
export const FOV_COS_SCALE = 256;
