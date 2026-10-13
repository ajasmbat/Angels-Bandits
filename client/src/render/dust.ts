// D3 collapse dust: a billowing cloud that fills the canyon for
// COLLAPSE_DUST_MS after a collapse. Two layers, the smoke and fog idioms:
//
//   1. Puffs (dressing): big soft sprites. ONE Points for every cloud (one
//      draw); each puff is a pure function of (collapse, puff index, server
//      time) — no state, so a late joiner's cloud is the same cloud. The
//      puff count scales with the quality tier; the sprite size scales up to
//      cover the same air. D10 gave the cloud three parts:
//        - the SURGE: a pyroclastic, ground-hugging wall of dust that pours
//          out of the lot when the mass hits the ground, runs out to the
//          street and then rolls along it for most of a block each way,
//          growing, slowly lifting and lingering;
//        - the COLUMN: the D3 cloud rising over the ruin;
//        - SQUIBS: dust jetting out of the facade just under each storey as
//          the crush front reaches it (collapse.ts floor events), short and
//          sharp — the look of a real progressive collapse.
//      D11 added the CURTAIN: dust thrown off the facades where the tower
//      fails (a pancake's crush front, storey by storey; a topple's falling
//      block) that pours down the faces and billows out as it falls — the
//      shape that reads as a collapse from 600 m. And LIMITS: a puff fades
//      as its sprite grows past the screen (the camera close to or inside
//      it), the whole cloud is held under DUST_COVERAGE_MAX of the frame,
//      and its colour is clamped under the bloom threshold, so a cloud
//      never flattens the frame or blows it out white.
//      Puffs fade as the camera comes into them (no hard sprite plane in the
//      face) and sit high enough that the ground clips only their soft rim.
//      The scene has no depth texture to fade against, so this stands in
//      for true soft particles.
//   2. Haze (the sight-blocking part): `dustHaze` says how deep the CAMERA is
//      in a cloud — its core or (D10) the surge corridors down the streets —
//      and storm.ts's atmosphere(), the single fog writer, thickens the haze
//      and pulls the fog in by it. That is identical on every tier
//      (quality.ts visibility parity): a Mobile player never sees further
//      through the dust than a High one.

import {
  BEAT_BREAK,
  BEAT_CRUSH,
  BEAT_GIVE,
  BEAT_LAND,
  type Collapse,
  PANCAKE,
  blankPose,
  collapseFloorEvents,
  piecePose,
} from "@angels-bandits/common/city/collapse";
import {
  BLOCK_PITCH,
  COLLAPSE_DUST_MS,
  COLLAPSE_LEAD_MS,
  STREET_WIDTH,
} from "@angels-bandits/common/constants";
import { type Vec3, wrapDeltaAxis } from "@angels-bandits/common/world";
import * as THREE from "three";
import { QUALITY_PROFILES, type QualityTier } from "./quality";
import { RENDER_ORDER } from "./render-order";
import { DUSK, LIGHT_RIG } from "./sky";
import { pushUpdateRange } from "./update-range";

/** Puffs per cloud at full quality (D11: 72 → 112, for the curtain). */
export const DUST_PUFFS = 112;
/** Clouds drawn at once (the newest win). */
const MAX_CLOUDS = 6;
/** Puff sprite size ramp, m (before the tier's coverage scale). */
const PUFF_SIZE_MIN = 14;
const PUFF_SIZE_MAX = 46;
/** Concrete dust: a warm grey a touch lighter than the night haze (D11:
 * lighter still — it catches the street glow, the moon and the fires). */
const DUST_COLOR = 0xa89d90;
const DUST_OPACITY = 0.8;
/** D11: the dust's linear colour never passes this — under the bloom
 * threshold (0.72), however many lit puffs stack in front of the camera. */
export const DUST_RGB_MAX = 0.6;
/** D11: the drawn cloud never covers more than this share of the frame
 * (Σ sprite area × alpha × the sprite's mean alpha); past it every puff's
 * alpha is scaled down to fit. */
export const DUST_COVERAGE_MAX = 0.7;
/** D11: a puff is fully drawn from this many of its own sizes away and
 * fades to nothing at DUST_NEAR_GONE — the camera close to or inside it. */
const DUST_NEAR_FULL = 1.5;
const DUST_NEAR_GONE = 0.35;
/** Mean alpha of the sprite texture over its square (the coverage sum). */
const SPRITE_MEAN_ALPHA = 0.35;
/** The fire glow in a hot puff (linear, before the clamp). */
const DUST_FIRE = [0.55, 0.22, 0.06] as const;

/** D10 puff kinds, and their shares of a cloud's puffs. */
export const PUFF_SURGE = 0;
export const PUFF_COLUMN = 1;
export const PUFF_SQUIB = 2;
export const PUFF_CURTAIN = 3;
export const PUFF_PLUME = 4;
const SURGE_SHARE = 0.28;
const COLUMN_SHARE = 0.15;
const SQUIB_SHARE = 0.12;
const CURTAIN_SHARE = 0.2;
/** D11 plume: dust boiling out where the falling mass lands (a pancake's
 * pile at its foot, a topple's debris along its line) and climbing — how
 * high (× the tower's height), how far out, its size ramp (× height) and
 * life. */
const PLUME_RISE = 0.35;
const PLUME_OUT = 0.12;
const PLUME_SIZE_0 = 0.07;
const PLUME_SIZE_1 = 0.32;
export const PLUME_LIFE_MS = 15_000;
/** D11 curtain: how far out of the face it billows (× the tower's height,
 * capped), how fast it slides down at most, m/s, the time it takes to reach
 * that speed, s, its life, ms, and its size ramp (start; end = base +
 * per-metre of height), m. */
const CURTAIN_OUT_K = 0.12;
const CURTAIN_OUT_MAX = 40;
const CURTAIN_FALL = 18;
const CURTAIN_FALL_TAU = 1.5;
export const CURTAIN_LIFE_MS = 11_000;
const CURTAIN_SIZE_0 = 12;
const CURTAIN_SIZE_1 = 24;
const CURTAIN_SIZE_PER_M = 0.25;
/** D11: the column's puffs grow with the tower (× height / this, 1..max),
 * and it climbs to COLUMN_RISE of the tower's height (≤ COLUMN_TOP_M). */
const COLUMN_SCALE_H_M = 150;
const COLUMN_SCALE_MAX = 2.2;
const COLUMN_RISE = 0.45;
const COLUMN_TOP_M = 150;
/** A curtain puff glows with the fire of the floor it left for this long. */
const CURTAIN_HOT_MS = 2200;
/** The surge: e-folding time of its run, s; how far along the street it
 * rolls past where it meets it, m (most of a block each way); how high it
 * hugs the ground, m; and how fast it lifts once it has slowed, m/s. */
const SURGE_TAU_S = 2.4;
export const SURGE_ALONG_M = 0.8 * BLOCK_PITCH;
export const SURGE_TOP_M = 14;
const SURGE_LIFT = 0.45;
/** A squib: how far it jets, m, its e-folding time, s, and its life, ms. */
const SQUIB_REACH_M = 22;
const SQUIB_TAU_S = 0.5;
export const SQUIB_LIFE_MS = 3500;

/** D10: puffs this high take the sky's light; at the street, the ground's. */
export const DUST_LIGHT_SPAN_M = 60;

/** D10: the scene lights the dust is lit by (sky.ts SkyRig, storm.ts). */
export interface DustLights {
  ambient: THREE.AmbientLight;
  hemi: THREE.HemisphereLight;
  moon: THREE.DirectionalLight;
  flash?: THREE.AmbientLight;
}

/** The rig's design-night luminance above and at street level (sky.ts DUSK
 * and LIGHT_RIG): the tints are relative to it, so the dust keeps its tuned
 * look on that night and follows the light from there. */
const lum = (hex: number, k: number) => {
  const c = new THREE.Color(hex);
  return (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) * k;
};
const REF_SKY =
  lum(DUSK.ambient, LIGHT_RIG.ambient) +
  lum(DUSK.hemiSky, LIGHT_RIG.hemi) +
  lum(DUSK.moon, LIGHT_RIG.moon) * 0.35;
const REF_GROUND =
  lum(DUSK.ambient, LIGHT_RIG.ambient) + lum(DUSK.hemiGround, LIGHT_RIG.hemi);

/** One puff: where it is and how it looks. */
export interface DustPuff {
  x: number;
  y: number;
  z: number;
  /** Sprite size, m. */
  size: number;
  /** 0..1 opacity factor. */
  alpha: number;
  /** D11: 0..1 fire glow (a curtain puff fresh off a failing floor). */
  heat?: number;
}

/** Fade envelope of a cloud `age` ms after it starts: quick swell, long
 * hang, thin out over the last 40 %. */
function envelope(age: number): number {
  if (age < 0 || age >= COLLAPSE_DUST_MS) return 0;
  const swell = Math.min(1, age / 1200);
  const tail = Math.min(1, (COLLAPSE_DUST_MS - age) / (0.4 * COLLAPSE_DUST_MS));
  return swell * tail;
}

/** D11: a curtain (or plume) puff's envelope: a quick swell, a long hang. */
function curtainEnvelope(age: number, life = CURTAIN_LIFE_MS): number {
  if (age < 0 || age >= life) return 0;
  const tail = Math.min(1, (life - age) / (0.45 * life));
  return Math.min(1, age / 400) * tail;
}

/** A squib's envelope `age` ms after its floor event: a sharp puff. */
function squibEnvelope(age: number): number {
  if (age < 0 || age >= SQUIB_LIFE_MS) return 0;
  return Math.min(1, age / 120) * (1 - age / SQUIB_LIFE_MS);
}

interface Cloud {
  x: number;
  z: number;
  r: number;
  h: number;
  /** D10: the standing footprint of what fell (centre-relative). */
  fx0: number;
  fx1: number;
  fz0: number;
  fz1: number;
  /** When the mass first hits the ground, ms after t0 (the surge starts). */
  surgeAt: number;
  /** The floor events squibs fire on (crushed storeys, a pancake's failure;
   * a topple's break-ups). */
  squibs: { t: number; x: number; y: number; z: number }[];
  /** D11: each curtain puff's source — when it leaves the tower (ms after
   * t0), where (centre-relative), and the outward direction it billows
   * along (a facade's normal; a topple's falling block: away from it). */
  curtain: Float64Array;
  /** The tower's height (the curtain's reach and size scale). */
  height: number;
  /** Every puff's seeds, HASHES per puff (D6: a hash per seed per puff per
   * frame boxed a double each). */
  seeds: Float64Array;
  /** Every puff's kind (PUFF_*). */
  kinds: Uint8Array;
}

/** Seeds kept per puff (salts 1..HASHES-1; 0 unused). */
const HASHES = 10;
/** Each collapse's cloud, worked out once (D6: it is pure in the collapse,
 * and was recomputed per puff per frame — an object and a hypot each). */
const clouds = new WeakMap<Collapse, Cloud>();

/** Where a collapse's cloud sits (centre-relative x/z) and how far it
 * reaches: the middle of where its debris comes to rest. */
function cloudOf(c: Collapse): Cloud {
  let cloud = clouds.get(c);
  if (cloud) return cloud;
  const b = c.restBounds;
  const all = c.bounds;
  let fx0 = Number.POSITIVE_INFINITY;
  let fx1 = Number.NEGATIVE_INFINITY;
  let fz0 = Number.POSITIVE_INFINITY;
  let fz1 = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < c.n; i++) {
    fx0 = Math.min(fx0, (c.ox[i] as number) - (c.hx[i] as number));
    fx1 = Math.max(fx1, (c.ox[i] as number) + (c.hx[i] as number));
    fz0 = Math.min(fz0, (c.oz[i] as number) - (c.hz[i] as number));
    fz1 = Math.max(fz1, (c.oz[i] as number) + (c.hz[i] as number));
  }
  const events = collapseFloorEvents(c);
  let surgeAt = c.endMs * 0.5;
  for (const e of events) {
    if (e.kind === BEAT_LAND) {
      surgeAt = e.t;
      break;
    }
  }
  const squibs: Cloud["squibs"] = [];
  for (const e of events) {
    const fire =
      c.style === PANCAKE
        ? e.kind === BEAT_CRUSH || e.kind === BEAT_GIVE
        : e.kind === BEAT_BREAK;
    if (fire) squibs.push({ t: e.t, x: e.x, y: e.y, z: e.z });
  }
  const height = Math.max(all.y1, 1);
  cloud = {
    x: (b.x0 + b.x1) / 2,
    z: (b.z0 + b.z1) / 2,
    r: Math.max(20, Math.hypot(b.x1 - b.x0, b.z1 - b.z0) / 2),
    h: Math.min(COLUMN_TOP_M, Math.max(25, COLUMN_RISE * all.y1)),
    fx0,
    fx1,
    fz0,
    fz1,
    surgeAt,
    squibs,
    curtain: new Float64Array(DUST_PUFFS * CURTAIN_STRIDE),
    height,
    seeds: new Float64Array(DUST_PUFFS * HASHES),
    kinds: new Uint8Array(DUST_PUFFS),
  };
  for (let k = 0; k < DUST_PUFFS; k++) {
    cloud.kinds[k] = puffKind(c.id, k);
    for (let salt = 1; salt < HASHES; salt++) {
      cloud.seeds[k * HASHES + salt] = hash01(c.id, k, salt);
    }
  }
  curtainSources(c, cloud);
  clouds.set(c, cloud);
  return cloud;
}

/** Curtain source fields per puff: t, x, y, z, nx, nz. */
const CURTAIN_STRIDE = 6;
const curtainPose = blankPose();

/**
 * D11: where each curtain and plume puff leaves the tower (pure in the
 * collapse). A CURTAIN puff comes off a falling piece part-way down its
 * fall, at its pose then — a pancake's on the facade of the block riding
 * down, out of the face nearest it; a topple's off the falling block,
 * billowing away from it. A PLUME puff is born where a piece lands, when it
 * lands: a pancake's out of the foot of the tower on the face nearest it
 * (the pile it sinks into), a topple's where its debris hits the street.
 */
function curtainSources(c: Collapse, cloud: Cloud): void {
  const out = cloud.curtain;
  const pancake = c.style === PANCAKE;
  for (let k = 0; k < DUST_PUFFS; k++) {
    const o = k * CURTAIN_STRIDE;
    const kind = cloud.kinds[k];
    if ((kind !== PUFF_CURTAIN && kind !== PUFF_PLUME) || c.n === 0) {
      out[o] = Number.POSITIVE_INFINITY;
      continue;
    }
    const seed = (j: number) => cloud.seeds[k * HASHES + j] as number;
    const i = Math.min(c.n - 1, Math.floor(seed(1) * c.n));
    const start = (c.start[i] as number) * 1000;
    const land = (c.land[i] as number) * 1000;
    const t =
      kind === PUFF_PLUME
        ? start + land + seed(4) * 400
        : start + land * (0.15 + 0.6 * seed(4));
    piecePose(
      c,
      i,
      kind === PUFF_PLUME ? Number.POSITIVE_INFINITY : t,
      curtainPose,
    );
    out[o] = t;
    out[o + 2] = curtainPose.y;
    if (pancake) {
      // Onto the footprint's face nearest the piece, at a seeded point.
      const toX0 = curtainPose.x - cloud.fx0;
      const toX1 = cloud.fx1 - curtainPose.x;
      const toZ0 = curtainPose.z - cloud.fz0;
      const toZ1 = cloud.fz1 - curtainPose.z;
      const near = Math.min(toX0, toX1, toZ0, toZ1);
      const across = seed(3);
      const alongX = near === toX0 || near === toX1;
      const sign = alongX ? (near === toX1 ? 1 : -1) : near === toZ1 ? 1 : -1;
      out[o + 1] = alongX
        ? sign > 0
          ? cloud.fx1
          : cloud.fx0
        : cloud.fx0 + (cloud.fx1 - cloud.fx0) * across;
      out[o + 3] = alongX
        ? cloud.fz0 + (cloud.fz1 - cloud.fz0) * across
        : sign > 0
          ? cloud.fz1
          : cloud.fz0;
      out[o + 4] = alongX ? sign : 0;
      out[o + 5] = alongX ? 0 : sign;
    } else {
      const a = seed(2) * Math.PI * 2;
      out[o + 1] = curtainPose.x;
      out[o + 3] = curtainPose.z;
      out[o + 4] = Math.cos(a);
      out[o + 5] = Math.sin(a);
    }
  }
}

/** Small integer hash → [0, 1) (puff seeds from the collapse id and the
 * puff index, never a position). */
function hash01(a: number, b: number, salt: number): number {
  let h =
    Math.imul(a + 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + salt, 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x27d4eb2f);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

/** D10: puff `k`'s kind in collapse `id`'s cloud (PUFF_*). */
export function puffKind(id: number, k: number): number {
  const u = hash01(id, k, 9);
  return u < SURGE_SHARE
    ? PUFF_SURGE
    : u < SURGE_SHARE + COLUMN_SHARE
      ? PUFF_COLUMN
      : u < SURGE_SHARE + COLUMN_SHARE + SQUIB_SHARE
        ? PUFF_SQUIB
        : u < SURGE_SHARE + COLUMN_SHARE + SQUIB_SHARE + CURTAIN_SHARE
          ? PUFF_CURTAIN
          : PUFF_PLUME;
}

/** The street line (a BLOCK_PITCH multiple) a run from world coordinate
 * `from` meets going `sign` (±1) — never behind it. */
function streetAhead(from: number, sign: number): number {
  return sign > 0
    ? Math.ceil(from / BLOCK_PITCH) * BLOCK_PITCH
    : Math.floor(from / BLOCK_PITCH) * BLOCK_PITCH;
}

/**
 * Puff `k` of `c`'s cloud at server time `tMs`, centre-relative (add the
 * collapse's x/z), into `out`. False while the puff is not alive.
 */
export function dustPuff(
  c: Collapse,
  k: number,
  tMs: number,
  out: DustPuff,
): boolean {
  return puffOf(c, cloudOf(c), k, tMs, out);
}

/** dustPuff with `c`'s cloud already worked out (D6: once per cloud per
 * frame, not once per puff — the same numbers). */
function puffOf(
  c: Collapse,
  cloud: Cloud,
  k: number,
  tMs: number,
  out: DustPuff,
): boolean {
  if (k >= DUST_PUFFS) return false;
  const kind = cloud.kinds[k] as number;
  out.heat = 0;
  if (kind === PUFF_SQUIB && cloud.squibs.length > 0) {
    return squibOf(c, cloud, k, tMs, out);
  }
  if (kind === PUFF_SURGE) return surgeOf(c, cloud, k, tMs, out);
  if (kind === PUFF_CURTAIN || kind === PUFF_PLUME) {
    if (Number.isFinite(cloud.curtain[k * CURTAIN_STRIDE] as number)) {
      return kind === PUFF_PLUME
        ? plumeOf(c, cloud, k, tMs, out)
        : curtainOf(c, cloud, k, tMs, out);
    }
    // No source (a collapse with nothing in it): a column puff instead.
  }
  const birth =
    COLLAPSE_LEAD_MS * 0.5 + (cloud.seeds[k * HASHES + 1] as number) * 2500;
  const age = tMs - c.t0 - birth;
  const env = envelope(age);
  if (env <= 0) return false;
  const s = age / 1000;
  const angle = (cloud.seeds[k * HASHES + 2] as number) * Math.PI * 2;
  // Rolls outward fast, then hangs: the canyon fills, it doesn't drift off.
  const reach = cloud.r * (0.3 + 0.9 * (cloud.seeds[k * HASHES + 3] as number));
  const spread = reach + 45 * (1 - Math.exp(-s / 4));
  out.x = cloud.x + Math.cos(angle) * spread;
  out.z = cloud.z + Math.sin(angle) * spread;
  out.y =
    4 +
    cloud.h * (cloud.seeds[k * HASHES + 4] as number) * (1 - Math.exp(-s / 3)) +
    0.6 * s;
  out.size =
    (PUFF_SIZE_MIN +
      (PUFF_SIZE_MAX - PUFF_SIZE_MIN) *
        Math.min(1, s / 8) *
        (0.7 + 0.3 * (cloud.seeds[k * HASHES + 5] as number))) *
    Math.min(COLUMN_SCALE_MAX, Math.max(1, cloud.height / COLUMN_SCALE_H_M));
  out.alpha = env;
  return true;
}

/** D10: a surge puff — out of the lot to the street on one side, then
 * along the street one way, hugging the ground, then lifting. */
function surgeOf(
  c: Collapse,
  cloud: Cloud,
  k: number,
  tMs: number,
  out: DustPuff,
): boolean {
  const birth = cloud.surgeAt + (cloud.seeds[k * HASHES + 1] as number) * 2500;
  const age = tMs - c.t0 - birth;
  const env = envelope(age);
  if (env <= 0) return false;
  const s = age / 1000;
  const side = Math.floor((cloud.seeds[k * HASHES + 2] as number) * 4); // −x, +x, −z, +z
  const alongX = side < 2;
  const sign = side % 2 === 0 ? -1 : 1;
  const across = cloud.seeds[k * HASHES + 3] as number;
  // Out of the lot: from the footprint's face, at a point along it…
  const face = alongX
    ? sign > 0
      ? cloud.fx1
      : cloud.fx0
    : sign > 0
      ? cloud.fz1
      : cloud.fz0;
  const startAcross = alongX
    ? cloud.fz0 + (cloud.fz1 - cloud.fz0) * across
    : cloud.fx0 + (cloud.fx1 - cloud.fx0) * across;
  // …to the street line beyond it (world coordinates for the grid).
  const worldFace = (alongX ? c.x : c.z) + face;
  const street = streetAhead(worldFace, sign) - (alongX ? c.x : c.z);
  const out1 = Math.abs(street - face);
  // …then along the street, one way, most of a block.
  const turn = (cloud.seeds[k * HASHES + 4] as number) < 0.5 ? -1 : 1;
  const along =
    SURGE_ALONG_M * (0.35 + 0.65 * (cloud.seeds[k * HASHES + 5] as number));
  const run = (out1 + along) * (1 - Math.exp(-s / SURGE_TAU_S));
  const lane =
    ((cloud.seeds[k * HASHES + 6] as number) * 2 - 1) * (STREET_WIDTH / 2 - 3);
  let u: number; // along the fall-out axis, centre-relative
  let v: number; // across it
  if (run <= out1) {
    u = face + sign * run;
    v = startAcross;
  } else {
    // In the street: spread across the roadway, rolling along it.
    u = street + lane;
    v = startAcross + turn * (run - out1);
  }
  out.x = alongX ? u : v;
  out.z = alongX ? v : u;
  const grow = Math.min(1, s / 6);
  out.size =
    (PUFF_SIZE_MIN * 0.8 + (PUFF_SIZE_MAX - PUFF_SIZE_MIN * 0.8) * grow) *
    (0.6 + 0.4 * (cloud.seeds[k * HASHES + 7] as number));
  // Ground-hugging; slowly lifting once it has slowed. Never so low that
  // the ground cuts more than the sprite's soft rim.
  const lift = SURGE_LIFT * Math.max(0, s - 3);
  out.y = Math.max(
    0.35 * out.size,
    2 + (SURGE_TOP_M - 2) * (cloud.seeds[k * HASHES + 8] as number) + lift,
  );
  out.alpha = env * 0.9;
  return true;
}

/** D11: a curtain puff — thrown off the tower where it fails, billowing out
 * of the face and pouring down it, growing as it goes; hot at first. */
function curtainOf(
  c: Collapse,
  cloud: Cloud,
  k: number,
  tMs: number,
  out: DustPuff,
): boolean {
  const o = k * CURTAIN_STRIDE;
  const age = tMs - c.t0 - (cloud.curtain[o] as number);
  const env = curtainEnvelope(age);
  if (env <= 0) return false;
  const s = age / 1000;
  const seed = (j: number) => cloud.seeds[k * HASHES + j] as number;
  const reach =
    Math.min(CURTAIN_OUT_MAX, CURTAIN_OUT_K * cloud.height) *
    (0.4 + 0.6 * seed(5));
  const outward = reach * (1 - Math.exp(-s / 0.9));
  // Slides down, gathering speed up to CURTAIN_FALL (the integral of
  // CURTAIN_FALL · (1 − e^(−s/τ))).
  const fall =
    CURTAIN_FALL *
    (0.6 + 0.4 * seed(6)) *
    (s - CURTAIN_FALL_TAU * (1 - Math.exp(-s / CURTAIN_FALL_TAU)));
  const end = CURTAIN_SIZE_1 + CURTAIN_SIZE_PER_M * Math.min(cloud.height, 480);
  out.size =
    (CURTAIN_SIZE_0 + (end - CURTAIN_SIZE_0) * Math.min(1, s / 6)) *
    (0.7 + 0.3 * seed(7));
  out.x =
    (cloud.curtain[o + 1] as number) +
    (cloud.curtain[o + 4] as number) * outward;
  out.z =
    (cloud.curtain[o + 3] as number) +
    (cloud.curtain[o + 5] as number) * outward;
  // Down the face, never through the ground (the soft rim only).
  out.y = Math.max(0.35 * out.size, (cloud.curtain[o + 2] as number) - fall);
  out.alpha = env * 0.85;
  out.heat = Math.max(0, 1 - age / CURTAIN_HOT_MS);
  return true;
}

/** D11: a plume puff — dust boiling out where the falling mass lands and
 * climbing, big and slow: the cloud a tower sinks into. */
function plumeOf(
  c: Collapse,
  cloud: Cloud,
  k: number,
  tMs: number,
  out: DustPuff,
): boolean {
  const o = k * CURTAIN_STRIDE;
  const age = tMs - c.t0 - (cloud.curtain[o] as number);
  const env = curtainEnvelope(age, PLUME_LIFE_MS);
  if (env <= 0) return false;
  const s = age / 1000;
  const seed = (j: number) => cloud.seeds[k * HASHES + j] as number;
  const h = Math.min(cloud.height, 480);
  const outward =
    PLUME_OUT * h * (0.3 + 0.7 * seed(5)) * (1 - Math.exp(-s / 1.6));
  const rise = PLUME_RISE * h * seed(6) * seed(6) * (1 - Math.exp(-s / 3.5));
  out.size =
    h *
    (PLUME_SIZE_0 + (PLUME_SIZE_1 - PLUME_SIZE_0) * Math.min(1, s / 5)) *
    (0.65 + 0.35 * seed(7));
  out.x =
    (cloud.curtain[o + 1] as number) +
    (cloud.curtain[o + 4] as number) * outward;
  out.z =
    (cloud.curtain[o + 3] as number) +
    (cloud.curtain[o + 5] as number) * outward;
  out.y = Math.max(0.35 * out.size, (cloud.curtain[o + 2] as number) + rise);
  out.alpha = env * 0.8;
  out.heat = 0;
  return true;
}

/** D10: a squib — dust jetting out of the facade just under a storey as
 * the crush front reaches it. */
function squibOf(
  c: Collapse,
  cloud: Cloud,
  k: number,
  tMs: number,
  out: DustPuff,
): boolean {
  const e = cloud.squibs[
    Math.floor((cloud.seeds[k * HASHES + 1] as number) * cloud.squibs.length)
  ] as Cloud["squibs"][number];
  const age = tMs - c.t0 - e.t - (cloud.seeds[k * HASHES + 2] as number) * 150;
  const env = squibEnvelope(age);
  if (env <= 0) return false;
  const s = age / 1000;
  const side = Math.floor((cloud.seeds[k * HASHES + 3] as number) * 4);
  const alongX = side < 2;
  const sign = side % 2 === 0 ? -1 : 1;
  const across = cloud.seeds[k * HASHES + 4] as number;
  const jet =
    SQUIB_REACH_M *
    (0.6 + 0.4 * (cloud.seeds[k * HASHES + 5] as number)) *
    (1 - Math.exp(-s / SQUIB_TAU_S));
  if (c.style === PANCAKE) {
    const face = alongX
      ? sign > 0
        ? cloud.fx1
        : cloud.fx0
      : sign > 0
        ? cloud.fz1
        : cloud.fz0;
    const at = alongX
      ? cloud.fz0 + (cloud.fz1 - cloud.fz0) * across
      : cloud.fx0 + (cloud.fx1 - cloud.fx0) * across;
    out.x = alongX ? face + sign * jet : at;
    out.z = alongX ? at : face + sign * jet;
    // Out of the windows of the storey under the one that just gave way.
    out.y =
      Math.max(2, e.y - 1 - 3 * (cloud.seeds[k * HASHES + 6] as number)) -
      0.8 * s;
  } else {
    // A break-up in the air: a burst round where the section came apart.
    const a = (cloud.seeds[k * HASHES + 6] as number) * Math.PI * 2;
    out.x = e.x + Math.cos(a) * jet * 0.6;
    out.z = e.z + Math.sin(a) * jet * 0.6;
    out.y = Math.max(
      2,
      e.y + ((cloud.seeds[k * HASHES + 7] as number) - 0.5) * 8 - 1.5 * s,
    );
  }
  out.size = 5 + 11 * Math.min(1, s / 1.6);
  out.alpha = env;
  return true;
}

/**
 * How deep a camera at `cam` is in any collapse's dust at server time
 * `tMs`, 0..1 — the sight-blocking haze's input (storm.ts atmosphere()).
 * Full inside the cloud's core below its top, easing to 0 at its rim; D10:
 * and down the streets the surge has rolled along so far, below its top.
 */
export function dustHaze(
  list: readonly Collapse[],
  cam: Vec3,
  tMs: number,
): number {
  let best = 0;
  for (let e = 0; e < list.length; e++) {
    const c = list[e] as Collapse;
    const age = tMs - c.t0 - COLLAPSE_LEAD_MS;
    const env = envelope(age);
    if (env <= 0) continue;
    const cloud = cloudOf(c);
    const dx = wrapDeltaAxis(c.x + cloud.x, cam.x);
    const dz = wrapDeltaAxis(c.z + cloud.z, cam.z);
    best = Math.max(best, surgeHaze(c, cloud, cam, tMs));
    const r = cloud.r + 45 * (1 - Math.exp(-age / 4000));
    // D6: the cheap reject first — most clouds are nowhere near the camera.
    if (dx * dx + dz * dz >= r * r) continue;
    const d = Math.hypot(dx, dz);
    if (d >= r) continue;
    const top = cloud.h + 10;
    if (cam.y >= top + 25) continue;
    const radial = d <= 0.6 * r ? 1 : 1 - (d - 0.6 * r) / (0.4 * r);
    const vertical = cam.y <= top ? 1 : 1 - (cam.y - top) / 25;
    best = Math.max(best, env * radial * vertical);
  }
  return best;
}

/** D10: the surge's share of the haze — inside a street the surge has
 * reached (out of the lot, then along the street as far as its farthest
 * puffs), under its top. */
function surgeHaze(c: Collapse, cloud: Cloud, cam: Vec3, tMs: number): number {
  const age = tMs - c.t0 - cloud.surgeAt;
  const env = envelope(age);
  if (env <= 0) return 0;
  const top = SURGE_TOP_M + 10 + SURGE_LIFT * Math.max(0, age / 1000 - 3);
  if (cam.y > top + 15) return 0;
  const vertical = cam.y <= top ? 1 : 1 - (cam.y - top) / 15;
  const x = wrapDeltaAxis(c.x, cam.x);
  const z = wrapDeltaAxis(c.z, cam.z);
  const reach = 1 - Math.exp(-age / 1000 / SURGE_TAU_S);
  let best = 0;
  for (let side = 0; side < 4; side++) {
    const alongX = side < 2;
    const sign = side % 2 === 0 ? -1 : 1;
    const face = alongX
      ? sign > 0
        ? cloud.fx1
        : cloud.fx0
      : sign > 0
        ? cloud.fz1
        : cloud.fz0;
    const street =
      streetAhead((alongX ? c.x : c.z) + face, sign) - (alongX ? c.x : c.z);
    const out1 = Math.abs(street - face);
    const run = (out1 + SURGE_ALONG_M) * reach;
    const u = alongX ? x : z; // the fall-out axis
    const v = alongX ? z : x;
    const lo = alongX ? cloud.fz0 : cloud.fx0;
    const hi = alongX ? cloud.fz1 : cloud.fx1;
    // The run out of the lot to the street…
    const outward = (u - face) * sign;
    const inLot =
      outward >= 0 && outward <= Math.min(run, out1) && v >= lo && v <= hi;
    // …and the street itself, as far as the surge has rolled.
    const inStreet =
      run > out1 &&
      Math.abs(u - street) <= STREET_WIDTH / 2 &&
      v >= lo - (run - out1) &&
      v <= hi + (run - out1);
    if (inLot || inStreet) best = Math.max(best, 0.85);
  }
  return best * env * vertical;
}

/** Upload items [0, n) of `a` this frame. */
function markRange(a: THREE.BufferAttribute, n: number): void {
  a.clearUpdateRanges();
  pushUpdateRange(a, 0, n * a.itemSize);
  a.needsUpdate = true;
}

/** THREE half: every cloud's puffs in one Points (per-point size + alpha). */
export class DustClouds {
  readonly points: THREE.Points;
  private readonly positions: THREE.BufferAttribute;
  private readonly sizes: THREE.BufferAttribute;
  private readonly alphas: THREE.BufferAttribute;
  private readonly heats: THREE.BufferAttribute;
  private readonly puff: DustPuff = { x: 0, y: 0, z: 0, size: 0, alpha: 0 };
  /** D11 QA: the frame share the drawn cloud covered last frame (after the
   * budget), and the budget's scale on every alpha (1 = under it). */
  private lastCoverage = 0;
  private lastScale = 1;
  private share = 1;
  /** D10: the light the dust is lit by, relative to the night it was tuned
   * under (1, 1, 1 there): at its top, and at street level. */
  private readonly skyTint = new THREE.Color(1, 1, 1);
  private readonly groundTint = new THREE.Color(1, 1, 1);
  private lights: DustLights | null = null;
  private readonly scratch = new THREE.Color();

  constructor() {
    const budget = MAX_CLOUDS * DUST_PUFFS;
    const geometry = new THREE.BufferGeometry();
    this.positions = new THREE.BufferAttribute(new Float32Array(budget * 3), 3);
    this.sizes = new THREE.BufferAttribute(new Float32Array(budget), 1);
    this.alphas = new THREE.BufferAttribute(new Float32Array(budget), 1);
    this.heats = new THREE.BufferAttribute(new Float32Array(budget), 1);
    for (const a of [this.positions, this.sizes, this.alphas, this.heats]) {
      a.setUsage(THREE.DynamicDrawUsage);
    }
    geometry.setAttribute("position", this.positions);
    geometry.setAttribute("aSize", this.sizes);
    geometry.setAttribute("aAlpha", this.alphas);
    geometry.setAttribute("aHeat", this.heats);
    geometry.setDrawRange(0, 0);
    // D11: a billowing, cauliflower puff — a soft core with lobes round it
    // (seeded, so every client draws the same sprite), not a flat disc.
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      const lobe = (x: number, y: number, r: number, a: number) => {
        const g = ctx.createRadialGradient(x, y, 1, x, y, r);
        g.addColorStop(0, `rgba(255,255,255,${a})`);
        g.addColorStop(0.55, `rgba(255,255,255,${a * 0.55})`);
        g.addColorStop(1, "rgba(255,255,255,0)");
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      };
      lobe(32, 32, 30, 0.6);
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * Math.PI * 2 + 0.4 * Math.sin(i * 2.3);
        const d = 11 + 4 * Math.sin(i * 1.7);
        lobe(
          32 + Math.cos(a) * d,
          32 + Math.sin(a) * d,
          13 + 3 * Math.cos(i * 2.9),
          0.45,
        );
      }
    }
    const material = new THREE.PointsMaterial({
      color: DUST_COLOR,
      map: new THREE.CanvasTexture(canvas),
      size: 1,
      transparent: true,
      opacity: DUST_OPACITY,
      depthWrite: false,
    });
    const sky = this.skyTint;
    const ground = this.groundTint;
    material.onBeforeCompile = (shader) => {
      // D10: lit by the scene — the puff's height mixes the ground light
      // (warm street glow) into the sky light (DustClouds.light).
      shader.uniforms.uDustSky = { value: sky };
      shader.uniforms.uDustGround = { value: ground };
      shader.vertexShader = shader.vertexShader
        .replace(
          "#include <common>",
          "attribute float aSize;\nattribute float aAlpha;\nattribute float aHeat;\nvarying float vAlpha;\nvarying float vDustH;\nvarying float vHeat;\n#include <common>",
        )
        .replace(
          "gl_PointSize = size;",
          `gl_PointSize = size * aSize;\n\tvAlpha = aAlpha;\n\tvHeat = aHeat;\n\tvDustH = clamp(position.y / ${DUST_LIGHT_SPAN_M.toFixed(1)}, 0.0, 1.0);`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <common>",
          "uniform vec3 uDustSky;\nuniform vec3 uDustGround;\nvarying float vAlpha;\nvarying float vDustH;\nvarying float vHeat;\n#include <common>",
        )
        .replace(
          "#include <color_fragment>",
          // D11: + the glow of the failing floor a curtain puff left, and
          // clamped under the bloom threshold BEFORE bloom — however many
          // lit puffs stack, the dust never blows out white.
          `#include <color_fragment>\n\tdiffuseColor.a *= vAlpha;\n\tdiffuseColor.rgb *= mix(uDustGround, uDustSky, vDustH);\n\tdiffuseColor.rgb += vec3(${DUST_FIRE.map((v) => v.toFixed(2)).join(", ")}) * vHeat;\n\tdiffuseColor.rgb = min(diffuseColor.rgb, vec3(${DUST_RGB_MAX.toFixed(2)}));`,
        );
    };
    material.customProgramCacheKey = () => "dust-asize-aalpha-d10-lit-d11-heat";
    this.points = new THREE.Points(geometry, material);
    this.points.frustumCulled = false;
    this.points.renderOrder = RENDER_ORDER.smoke;
  }

  /** D10: the scene's lights the dust is lit by (the sky rig the L12 cycle
   * drives, and the storm's flash). */
  setLights(lights: DustLights): void {
    this.lights = lights;
  }

  /** D10: this frame's sky / ground tints from the lights, each relative
   * to the rig's own design values (a whole-night average of ~1). */
  private light(): void {
    const l = this.lights;
    if (!l) return;
    const t = this.scratch;
    const ambient = l.ambient.intensity;
    const hemi = l.hemi.intensity;
    const flash = l.flash ? l.flash.intensity : 0;
    // Above: skylight + the hemisphere's sky + a share of the moon key.
    t.copy(l.ambient.color).multiplyScalar(ambient);
    t.r += l.hemi.color.r * hemi + l.moon.color.r * l.moon.intensity * 0.35;
    t.g += l.hemi.color.g * hemi + l.moon.color.g * l.moon.intensity * 0.35;
    t.b += l.hemi.color.b * hemi + l.moon.color.b * l.moon.intensity * 0.35;
    if (l.flash) {
      t.r += l.flash.color.r * flash;
      t.g += l.flash.color.g * flash;
      t.b += l.flash.color.b * flash;
    }
    this.skyTint.setRGB(t.r / REF_SKY, t.g / REF_SKY, t.b / REF_SKY);
    // Street level: skylight + the hemisphere's warm ground bounce.
    t.copy(l.ambient.color).multiplyScalar(ambient);
    t.r += l.hemi.groundColor.r * hemi;
    t.g += l.hemi.groundColor.g * hemi;
    t.b += l.hemi.groundColor.b * hemi;
    if (l.flash) {
      t.r += l.flash.color.r * flash;
      t.g += l.flash.color.g * flash;
      t.b += l.flash.color.b * flash;
    }
    this.groundTint.setRGB(
      t.r / REF_GROUND,
      t.g / REF_GROUND,
      t.b / REF_GROUND,
    );
  }

  /** QA/tests: the current tints. */
  get tints(): { sky: THREE.Color; ground: THREE.Color } {
    return { sky: this.skyTint, ground: this.groundTint };
  }

  /** Quality: fewer puffs on cheaper tiers, each bigger to cover the same
   * air (the haze, not the puffs, is what blocks sight). */
  setQuality(tier: QualityTier): void {
    this.share = QUALITY_PROFILES[tier].collapseDust;
  }

  /** D11 QA: the share of the frame the cloud covered last frame, and the
   * coverage budget's scale on every alpha (1 = it fitted). */
  get coverage(): { share: number; scale: number } {
    return { share: this.lastCoverage, scale: this.lastScale };
  }

  /** Re-project every live puff around the viewer. Call once per frame.
   * D11: `aspect` (the view's width / height) sizes the coverage budget. */
  update(
    list: readonly Collapse[],
    viewer: Vec3,
    serverMs: number | null,
    aspect = 16 / 9,
  ): void {
    this.light();
    let i = 0;
    let cover = 0;
    if (serverMs !== null) {
      const per = Math.max(1, Math.round(DUST_PUFFS * this.share));
      const grow = Math.sqrt(DUST_PUFFS / per);
      let clouds = 0;
      for (let e = list.length - 1; e >= 0 && clouds < MAX_CLOUDS; e--) {
        const c = list[e] as Collapse;
        const age = serverMs - c.t0;
        if (age < 0 || age > COLLAPSE_DUST_MS + 4000) continue;
        clouds++;
        const ox = viewer.x + wrapDeltaAxis(viewer.x, c.x);
        const oz = viewer.z + wrapDeltaAxis(viewer.z, c.z);
        const cloud = cloudOf(c);
        for (let k = 0; k < per; k++) {
          if (!puffOf(c, cloud, k, serverMs, this.puff)) continue;
          const px = ox + this.puff.x;
          const pz = oz + this.puff.z;
          const size = this.puff.size * grow;
          // D10: fade a puff the camera is coming into — no hard sprite
          // plane across the view (the stand-in for a depth fade). D11:
          // from DUST_NEAR_FULL of its own size, so the opacity a puff can
          // put in front of the camera is capped by its distance.
          const ddx = px - viewer.x;
          const ddy = this.puff.y - viewer.y;
          const ddz = pz - viewer.z;
          const dist = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz);
          const fade = Math.min(
            1,
            Math.max(
              0,
              (dist / size - DUST_NEAR_GONE) /
                (DUST_NEAR_FULL - DUST_NEAR_GONE),
            ),
          );
          if (fade <= 0) continue;
          const alpha = this.puff.alpha * fade;
          this.positions.setXYZ(i, px, this.puff.y, pz);
          this.sizes.setX(i, size);
          this.alphas.setX(i, alpha);
          this.heats.setX(i, this.puff.heat ?? 0);
          // Its share of the frame: three's size attenuation draws it
          // size · (H/2) / depth px across (depth ≈ distance; behind the
          // camera it counts too — conservative).
          const half = size / (2 * Math.max(dist, 1));
          cover +=
            alpha * SPRITE_MEAN_ALPHA * Math.min(1, (half * half) / aspect);
          i++;
        }
      }
    }
    // D11: the coverage budget — the whole cloud never covers more than
    // DUST_COVERAGE_MAX of the frame.
    this.lastScale = cover > DUST_COVERAGE_MAX ? DUST_COVERAGE_MAX / cover : 1;
    this.lastCoverage = cover * this.lastScale;
    if (this.lastScale < 1) {
      const a = this.alphas.array as Float32Array;
      for (let k = 0; k < i; k++) a[k] = (a[k] as number) * this.lastScale;
    }
    this.points.geometry.setDrawRange(0, i);
    // P4: three still issues a (counted) draw for an empty range.
    this.points.visible = i > 0;
    if (i > 0) {
      // D6: three calls, not a loop over a fresh array every frame.
      markRange(this.positions, i);
      markRange(this.sizes, i);
      markRange(this.alphas, i);
      markRange(this.heats, i);
    }
  }

  /** QA: puffs drawn last frame. */
  get puffCount(): number {
    return this.points.geometry.drawRange.count;
  }
}
