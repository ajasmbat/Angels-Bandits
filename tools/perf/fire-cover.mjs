// L7b fire cover: how much of a frame is FIRE — a hue/saturation/value mask
// over a PNG (a gallery shot or a reference image), no dependencies.
//
//   node tools/perf/fire-cover.mjs [--hud] [--horizon <row>] [--mask out.png] <png>...
//
// A pixel is fire when it is red-orange (hue ≤ 25° or ≥ 345°), saturated
// (S ≥ 0.45) and bright (V ≥ 0.45), all on the sRGB values as stored. The
// thresholds are FIXED here on purpose. Reference 2's fire peaks at hue
// 10–20°; the city's sodium light (street glow, warm windows, reference 1's
// lamps) sits at 20–35°, so the hue cut is what keeps a lit city from
// counting as a burning one. Haze, fog and a glowing cloud base sit under
// the value cut, so tinting the air cannot pass for fire either.
// Calibration (L7b, these thresholds): reference 2 (Apocalyptic City Under
// Fire) 24.7 %, reference 1 (Stormlit Manhattan, at peace) 3.9 %, main's
// `reference-inferno` (L7, burn 0.9) 2.5 %.
//
//   --hud           leave out the game HUD (minimap, carrier bar, tips,
//                   status panel), scaled from the 1280 × 720 layout
//   --horizon <row> also report the share below that pixel row (the city)
//   --mask <png>    write the mask (fire white, HUD grey) for one input
//
// Prints one line per input: `<file> fire <pct>% [below-horizon <pct>%]`.

import { readFileSync, writeFileSync } from "node:fs";
import { deflateSync, inflateSync } from "node:zlib";

/** Fire thresholds (sRGB, 0..1; hue in degrees). */
export const FIRE_MASK = { hueMax: 25, hueWrap: 345, sat: 0.45, val: 0.45 };

/** HUD rects in the 1280 × 720 desktop layout: [x0, y0, x1, y1]. */
const HUD_RECTS = [
  [0, 0, 250, 190], // minimap + its buttons
  [470, 0, 810, 52], // the carrier's name and bar
  [460, 615, 820, 665], // the coach tip
  [1070, 615, 1280, 720], // hull / guns / boost
];

/** Decode an 8-bit, non-interlaced PNG (grey, RGB, grey+alpha, RGBA). */
export function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let off = 8;
  let w = 0;
  let h = 0;
  let type = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const tag = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (tag === "IHDR") {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      if (data[8] !== 8 || data[12] !== 0) {
        throw new Error("only 8-bit non-interlaced PNGs");
      }
      type = data[9];
    } else if (tag === "IDAT") idat.push(data);
    else if (tag === "IEND") break;
    off += 12 + len;
  }
  const ch = { 0: 1, 2: 3, 4: 2, 6: 4 }[type];
  if (!ch) throw new Error(`PNG colour type ${type} unsupported`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const px = new Uint8Array(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? px[dst + x - ch] : 0;
      const b = y > 0 ? px[dst - stride + x] : 0;
      const c = x >= ch && y > 0 ? px[dst - stride + x - ch] : 0;
      let p = raw[src + x];
      if (f === 1) p += a;
      else if (f === 2) p += b;
      else if (f === 3) p += (a + b) >> 1;
      else if (f === 4) {
        const q = a + b - c;
        const pa = Math.abs(q - a);
        const pb = Math.abs(q - b);
        const pc = Math.abs(q - c);
        p += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      px[dst + x] = p & 255;
    }
  }
  // To RGB.
  const rgb = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    if (ch >= 3) {
      rgb[i * 3] = px[i * ch];
      rgb[i * 3 + 1] = px[i * ch + 1];
      rgb[i * 3 + 2] = px[i * ch + 2];
    } else {
      rgb[i * 3] = rgb[i * 3 + 1] = rgb[i * 3 + 2] = px[i * ch];
    }
  }
  return { w, h, rgb };
}

/** Is this sRGB pixel fire (FIRE_MASK)? */
export function isFire(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const v = max / 255;
  if (v < FIRE_MASK.val || max === min) return false;
  const s = (max - min) / max;
  if (s < FIRE_MASK.sat) return false;
  let hue;
  if (max === r) hue = (60 * (g - b)) / (max - min);
  else if (max === g) hue = 60 * (2 + (b - r) / (max - min));
  else hue = 60 * (4 + (r - g) / (max - min));
  if (hue < 0) hue += 360;
  return hue <= FIRE_MASK.hueMax || hue >= FIRE_MASK.hueWrap;
}

/** Fire share of an image (HUD rects optionally left out). */
export function fireCover(img, { hud = false, horizon = -1 } = {}) {
  const { w, h, rgb } = img;
  const sx = w / 1280;
  const sy = h / 720;
  const inHud = (x, y) =>
    hud &&
    HUD_RECTS.some(
      ([x0, y0, x1, y1]) =>
        x >= x0 * sx && x < x1 * sx && y >= y0 * sy && y < y1 * sy,
    );
  const mask = new Uint8Array(w * h);
  let n = 0;
  let fire = 0;
  let nLow = 0;
  let fireLow = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (inHud(x, y)) {
        mask[i] = 96;
        continue;
      }
      const f = isFire(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]);
      n++;
      if (f) fire++;
      if (horizon >= 0 && y >= horizon) {
        nLow++;
        if (f) fireLow++;
      }
      mask[i] = f ? 255 : 0;
    }
  }
  return {
    fire: fire / Math.max(1, n),
    below: horizon >= 0 ? fireLow / Math.max(1, nLow) : null,
    mask,
  };
}

/** A greyscale PNG of `mask` (w × h). */
function encodeGrey(w, h, mask) {
  const raw = Buffer.alloc(h * (w + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w + 1)] = 0;
    for (let x = 0; x < w; x++) raw[y * (w + 1) + 1 + x] = mask[y * w + x];
  }
  const chunk = (tag, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(tag, 4, "ascii");
    data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const opt = { hud: false, horizon: -1, mask: null };
  const files = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--hud") opt.hud = true;
    else if (a === "--horizon") opt.horizon = Number(args[++i]);
    else if (a === "--mask") opt.mask = args[++i];
    else files.push(a);
  }
  if (files.length === 0) {
    console.error(
      "usage: node tools/perf/fire-cover.mjs [--hud] [--horizon <row>] [--mask out.png] <png>...",
    );
    process.exit(2);
  }
  for (const f of files) {
    const img = decodePng(readFileSync(f));
    const r = fireCover(img, opt);
    const below =
      r.below === null ? "" : ` below-horizon ${(r.below * 100).toFixed(1)}%`;
    console.log(`${f} fire ${(r.fire * 100).toFixed(1)}%${below}`);
    if (opt.mask) writeFileSync(opt.mask, encodeGrey(img.w, img.h, r.mask));
  }
}
