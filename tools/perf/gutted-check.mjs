// G7 gutted check: do burnt-out buildings read as black blocks or as
// orange and black checkerboards? Three measures over a gallery shot, no
// dependencies (fire-cover.mjs decodes the PNG and owns the fire mask).
//
//   node tools/perf/gutted-check.mjs <png>...
//
// Shoot the views first (tools/perf/gallery.mjs): destruction-glass (the
// user's own v32 view), inferno-gutted-mid, reference-inferno,
// high-overview-inferno, inferno-gutted. A shot's file name picks its entry
// in CHECK_VIEWS; any other PNG is measured over the whole frame and only
// reported. The HUD rects are always left out.
//
//  1. FOG BLOCK: the largest 4-connected region of FOG_CELL × FOG_CELL px
//     cells that are dark, blue-cast and flat (FOG_NAVY) inside the view's
//     city rect (`fog`: no sky — a night sky is that colour too), as a share
//     of the frame. Bound FOG_BLOCK_MAX.
//  2. FOG SHARE: how much of that rect is such cells. A gutted face with
//     near-black albedo and its lights out fogs to the night's own navy,
//     pixels ≈ (8–14, 9–21, 18–35) beside a sky of (8, 7, 13): it reads as a
//     hole in the city. Its orange rooms and slab lines break it into
//     pieces under 2 % each, so the share is what separates. Bound
//     FOG_SHARE_MAX.
//  3. CHECKERBOARD: over the view's far-LOD crop, 8 × 8 px tiles holding ≥
//     CHECKER.fire fire pixels (fire-cover's FIRE_MASK) with a luma σ ≥
//     CHECKER.sigma: burning room cells beside dark ones — what a per-cell
//     hash that never resolves to its mean leaves once a cell is ~1–3 px
//     (the dark cells are fogged ember-red far away, not black, so the
//     spread is the signal). A share of the crop's tiles. Bound CHECKER_MAX.
//
// The bounds were FIXED before the fix, against main @ 981fba4 (v32):
//   view                    fog block  fog share  checker
//   destruction-glass       0.99 %    35.21 %     7.38 %   FAIL
//   inferno-gutted-mid      0.00 %     0.01 %    13.81 %   FAIL
//   reference-inferno       0.00 %     0.00 %    16.63 %   FAIL
//   high-overview-inferno   0.01 %     0.06 %     2.29 %   FAIL
// Exits 1 when any shot breaks a bound, 2 on bad usage.

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { HUD_RECTS, decodePng, isFire } from "./fire-cover.mjs";

/** A fog-navy cell: mean sRGB luma ≤ luma, blue over red and green by ≥
 * blue, and flat (luma σ ≤ sigma) — fog over an unlit surface. */
export const FOG_NAVY = { luma: 25, blue: 5, sigma: 8 };
export const FOG_CELL = 4;
/** No fog-navy region may cover more of the frame than this (G7). */
export const FOG_BLOCK_MAX = 0.02;
/** No more of a view's city rect may be fog-navy than this. */
export const FOG_SHARE_MAX = 0.15;

/** A checker tile (8 × 8 px): its share of fire pixels and its luma σ. */
export const CHECKER = { tile: 8, fire: 0.09, sigma: 25 };
/** No more of a far-LOD crop's tiles may be checker tiles than this. */
export const CHECKER_MAX = 0.01;

/**
 * Per view, in the 1280 × 720 layout (scaled to the shot): the city rect
 * [x0, y0, x1, y1] the fog measures search (below the skyline, no sky, no
 * lit road) and the far-LOD crop the checkerboard is judged over — distant
 * gutted towers, no near flames (null: not judged).
 */
export const CHECK_VIEWS = {
  "destruction-glass": { fog: [200, 300, 760, 560], crop: [200, 30, 760, 540] },
  "inferno-gutted-mid": {
    fog: [0, 300, 1280, 720],
    crop: [800, 30, 1060, 300],
  },
  "reference-inferno": { fog: [0, 350, 1280, 720], crop: [0, 370, 1280, 560] },
  "high-overview-inferno": {
    fog: [0, 220, 1280, 720],
    crop: [180, 230, 1280, 470],
  },
  "inferno-gutted": { fog: [0, 200, 1280, 720], crop: null },
};

const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** Measure one decoded image against a view entry (or the whole frame). */
export function guttedCheck(img, view = null) {
  const { w, h, rgb } = img;
  const sx = w / 1280;
  const sy = h / 720;
  const inHud = (x, y) =>
    HUD_RECTS.some(
      ([x0, y0, x1, y1]) =>
        x >= x0 * sx && x < x1 * sx && y >= y0 * sy && y < y1 * sy,
    );

  // 1–2. Fog-navy cells inside the city rect: the largest region, the share.
  const [fx0, fy0, fx1, fy1] = view?.fog ?? [0, 0, 1280, 720];
  const cw = Math.floor(w / FOG_CELL);
  const ch = Math.floor(h / FOG_CELL);
  const navy = new Uint8Array(cw * ch);
  let fogTotal = 0;
  let fogNavy = 0;
  for (let cy = 0; cy < ch; cy++) {
    for (let cx = 0; cx < cw; cx++) {
      const x0 = cx * FOG_CELL;
      const y0 = cy * FOG_CELL;
      if (
        x0 < fx0 * sx ||
        y0 < fy0 * sy ||
        x0 + FOG_CELL > fx1 * sx ||
        y0 + FOG_CELL > fy1 * sy ||
        inHud(x0, y0)
      ) {
        continue;
      }
      fogTotal++;
      let r = 0;
      let g = 0;
      let b = 0;
      let l = 0;
      let l2 = 0;
      for (let y = y0; y < y0 + FOG_CELL; y++) {
        for (let x = x0; x < x0 + FOG_CELL; x++) {
          const i = (y * w + x) * 3;
          const v = luma(rgb[i], rgb[i + 1], rgb[i + 2]);
          r += rgb[i];
          g += rgb[i + 1];
          b += rgb[i + 2];
          l += v;
          l2 += v * v;
        }
      }
      const n = FOG_CELL * FOG_CELL;
      const m = l / n;
      const sigma = Math.sqrt(Math.max(0, l2 / n - m * m));
      if (
        m <= FOG_NAVY.luma &&
        b / n >= r / n + FOG_NAVY.blue &&
        b / n >= g / n + FOG_NAVY.blue &&
        sigma <= FOG_NAVY.sigma
      ) {
        navy[cy * cw + cx] = 1;
        fogNavy++;
      }
    }
  }
  let fogCells = 0;
  const seen = new Uint8Array(cw * ch);
  const stack = [];
  for (let s = 0; s < navy.length; s++) {
    if (!navy[s] || seen[s]) continue;
    let size = 0;
    seen[s] = 1;
    stack.push(s);
    while (stack.length > 0) {
      const c = stack.pop();
      size++;
      const x = c % cw;
      const y = (c - x) / cw;
      for (const [nx, ny] of [
        [x - 1, y],
        [x + 1, y],
        [x, y - 1],
        [x, y + 1],
      ]) {
        if (nx < 0 || ny < 0 || nx >= cw || ny >= ch) continue;
        const k = ny * cw + nx;
        if (navy[k] && !seen[k]) {
          seen[k] = 1;
          stack.push(k);
        }
      }
    }
    fogCells = Math.max(fogCells, size);
  }
  const fogBlock = (fogCells * FOG_CELL * FOG_CELL) / (w * h);

  // 2. Checker tiles over the far-LOD crop.
  const [cx0, cy0, cx1, cy1] = view?.crop ?? [0, 0, 1280, 720];
  const T = CHECKER.tile;
  let tiles = 0;
  let fireTiles = 0;
  let checker = 0;
  let sigmaSum = 0;
  for (let ty = Math.round(cy0 * sy); ty + T <= Math.round(cy1 * sy); ty += T) {
    for (
      let tx = Math.round(cx0 * sx);
      tx + T <= Math.round(cx1 * sx);
      tx += T
    ) {
      if (inHud(tx, ty) || inHud(tx + T - 1, ty + T - 1)) continue;
      tiles++;
      let fire = 0;
      let l = 0;
      let l2 = 0;
      for (let y = ty; y < ty + T; y++) {
        for (let x = tx; x < tx + T; x++) {
          const i = (y * w + x) * 3;
          const v = luma(rgb[i], rgb[i + 1], rgb[i + 2]);
          if (isFire(rgb[i], rgb[i + 1], rgb[i + 2])) fire++;
          l += v;
          l2 += v * v;
        }
      }
      const n = T * T;
      if (fire === 0) continue;
      const m = l / n;
      const sigma = Math.sqrt(Math.max(0, l2 / n - m * m));
      fireTiles++;
      sigmaSum += sigma;
      if (fire >= CHECKER.fire * n && sigma >= CHECKER.sigma) checker++;
    }
  }
  return {
    fogBlock,
    fogShare: fogNavy / Math.max(1, fogTotal),
    checker: checker / Math.max(1, tiles),
    fireSigma: fireTiles > 0 ? sigmaSum / fireTiles : 0,
    fireTiles,
    tiles,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error("usage: node tools/perf/gutted-check.mjs <png>...");
    process.exit(2);
  }
  const pct = (v) => `${(v * 100).toFixed(2)}%`;
  let failed = false;
  for (const f of files) {
    const name = basename(f).replace(/\.png$/, "");
    const view = CHECK_VIEWS[name] ?? null;
    const r = guttedCheck(decodePng(readFileSync(f)), view);
    const fogOk = r.fogBlock <= FOG_BLOCK_MAX;
    const shareOk = r.fogShare <= FOG_SHARE_MAX;
    const checkerOk = !view?.crop || r.checker <= CHECKER_MAX;
    const verdict = !view
      ? "report"
      : fogOk && shareOk && checkerOk
        ? "PASS"
        : "FAIL";
    if (verdict === "FAIL") failed = true;
    console.log(
      `${f} fog-block ${pct(r.fogBlock)}${fogOk ? "" : ` (> ${pct(FOG_BLOCK_MAX)})`} fog-share ${pct(r.fogShare)}${shareOk ? "" : ` (> ${pct(FOG_SHARE_MAX)})`} checker ${pct(r.checker)}${checkerOk ? "" : ` (> ${pct(CHECKER_MAX)})`} fire-tile-sigma ${r.fireSigma.toFixed(1)} ${verdict}`,
    );
  }
  process.exit(failed ? 1 : 0);
}
