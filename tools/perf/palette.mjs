// L9 palette: how a frame's colour is spent — the numbers the reference
// match is tuned against (a gallery shot or a reference image), no
// dependencies.
//
//   node tools/perf/palette.mjs [--hud] [--vs <ref.png>] <png>...
//
// Per image: the mean sRGB colour and luma, the luma percentiles, the
// shares of the frame that are dark, warm light (sodium windows, lamps),
// fire (fire-cover.mjs's mask), cool (blue haze, moonlit sky, glass) and
// near-white (searchlights, the moon), and a 12-bin hue histogram (30°
// bins from red, each pixel weighted by saturation × value — where the
// colour actually is). `--vs` adds each image's distance to that reference:
// the L1 distance of the two hue histograms (0 same, 2 disjoint) and the
// difference of their mean luma. All on the sRGB values as stored.
//
//   --hud        leave out the game HUD (fire-cover.mjs's HUD_RECTS)
//   --vs <png>   compare every image to this one

import { readFileSync } from "node:fs";
import { HUD_RECTS, decodePng, isFire } from "./fire-cover.mjs";

/** Share thresholds (sRGB 0..1; hue in degrees). */
export const PALETTE = {
  dark: 0.08,
  warm: { hueLo: 15, hueHi: 55, sat: 0.35, val: 0.5 },
  cool: { hueLo: 190, hueHi: 260, sat: 0.2 },
  white: { sat: 0.2, val: 0.75 },
};

function hsv(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const v = max / 255;
  const s = max === 0 ? 0 : (max - min) / max;
  let h = 0;
  if (max !== min) {
    if (max === r) h = (60 * (g - b)) / (max - min);
    else if (max === g) h = 60 * (2 + (b - r) / (max - min));
    else h = 60 * (4 + (r - g) / (max - min));
    if (h < 0) h += 360;
  }
  return [h, s, v];
}

/** The palette summary of a decoded image. */
export function palette(img, { hud = false } = {}) {
  const { w, h, rgb } = img;
  const sx = w / 1280;
  const sy = h / 720;
  const rects = hud
    ? HUD_RECTS.map(([x0, y0, x1, y1]) => [x0 * sx, y0 * sy, x1 * sx, y1 * sy])
    : [];
  const hist = new Float64Array(12);
  const lumas = [];
  let n = 0;
  let sr = 0;
  let sg = 0;
  let sb = 0;
  const share = { dark: 0, warm: 0, fire: 0, cool: 0, white: 0 };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (rects.some(([a, b, c, d]) => x >= a && x < c && y >= b && y < d)) {
        continue;
      }
      const i = (y * w + x) * 3;
      const r = rgb[i];
      const g = rgb[i + 1];
      const bl = rgb[i + 2];
      const l = (0.2126 * r + 0.7152 * g + 0.0722 * bl) / 255;
      lumas.push(l);
      sr += r;
      sg += g;
      sb += bl;
      n++;
      const [hu, s, v] = hsv(r, g, bl);
      hist[Math.floor(hu / 30) % 12] += s * v;
      if (l < PALETTE.dark) share.dark++;
      if (isFire(r, g, bl)) share.fire++;
      const W = PALETTE.warm;
      if (hu >= W.hueLo && hu <= W.hueHi && s >= W.sat && v >= W.val) {
        share.warm++;
      }
      const C = PALETTE.cool;
      if (hu >= C.hueLo && hu <= C.hueHi && s >= C.sat) share.cool++;
      if (s < PALETTE.white.sat && v >= PALETTE.white.val) share.white++;
    }
  }
  lumas.sort((a, b) => a - b);
  const pct = (p) => lumas[Math.min(n - 1, Math.floor(p * n))];
  const mass = hist.reduce((a, b) => a + b, 0) || 1;
  for (let k = 0; k < 12; k++) hist[k] /= mass;
  for (const k of Object.keys(share)) share[k] /= n;
  return {
    mean: [sr / n / 255, sg / n / 255, sb / n / 255],
    luma: {
      mean: lumas.reduce((a, b) => a + b, 0) / n,
      p10: pct(0.1),
      p50: pct(0.5),
      p90: pct(0.9),
      p99: pct(0.99),
    },
    share,
    hist: [...hist],
  };
}

/** L1 distance of two hue histograms (0 same, 2 disjoint). */
export const histDistance = (a, b) =>
  a.reduce((s, v, k) => s + Math.abs(v - (b[k] ?? 0)), 0);

const f2 = (v) => v.toFixed(2);
const pc = (v) => `${(v * 100).toFixed(1)}%`;

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const hud = args.includes("--hud");
  const vsAt = args.indexOf("--vs");
  const vsPath = vsAt >= 0 ? args[vsAt + 1] : null;
  const files = args.filter(
    (a, i) => !a.startsWith("--") && (vsAt < 0 || i !== vsAt + 1),
  );
  const ref = vsPath ? palette(decodePng(readFileSync(vsPath))) : null;
  for (const f of files) {
    const p = palette(decodePng(readFileSync(f)), { hud });
    const L = p.luma;
    let line = `${f}\n  mean rgb ${p.mean.map(f2).join(" ")}  luma mean ${f2(L.mean)} p10 ${f2(L.p10)} p50 ${f2(L.p50)} p90 ${f2(L.p90)} p99 ${f2(L.p99)}`;
    const S = p.share;
    line += `\n  dark ${pc(S.dark)}  warm ${pc(S.warm)}  fire ${pc(S.fire)}  cool ${pc(S.cool)}  white ${pc(S.white)}`;
    line += `\n  hue ${p.hist
      .map((v) =>
        Math.round(v * 100)
          .toString()
          .padStart(3),
      )
      .join("")}  (% per 30° bin from red)`;
    if (ref) {
      line += `\n  vs ref: hue distance ${f2(histDistance(p.hist, ref.hist))}  luma diff ${f2(p.luma.mean - ref.luma.mean)}`;
    }
    console.log(line);
  }
}
