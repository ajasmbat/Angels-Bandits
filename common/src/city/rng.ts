// The city's one PRNG, in its own module so every city seam (the generator,
// holes, roof structures) can import it without an import cycle through
// ./index — which re-exports it at its long-standing import site.

/** mulberry32 — tiny seeded PRNG, identical output in Node and the browser.
 * Exported so deterministic client-side dressing (roof clutter, V3 traffic)
 * reuses the same generator instead of growing a parallel one. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
