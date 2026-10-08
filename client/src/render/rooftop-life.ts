// L8 Rooftop life (ANGE-972BJX, client-only dressing): rooftop parties under
// string lights with a few dancers, glowing pools, spinning AC and
// cooling-tower fans, flags and banners on short poles, and blinking aviation
// lights on the antenna masts of tall roofs.
//
// Layout is the pure seam rooftopLifeFor(): deterministic per building from
// its own position and dimensions via a salted mulberry32 stream (never
// Math.random, never a torus image), so every client dresses identical roofs.
// It reads roofStyleFor (which roofs are flat) and roofClutterFor (what is
// already standing there) — both pure, so their own streams never shift.
//
// The renderer is TWO draw calls, both from static buffers baked once:
//  - one additive Points cloud (the MoverLights idiom) for every bulb, pool
//    rim light and aviation light, twinkling/blinking in the vertex shader;
//  - one baked mesh of every prop. Each vertex carries its prop's canonical
//    pivot and an animation tag, so fan blades spin, flag cloth waves and
//    dancers bob on the GPU, and the pool tops paint their own caustics.
// Both shaders place each prop at the torus image nearest the camera from its
// PIVOT (the nearestImage idiom, done on the GPU), so nothing is uploaded per
// frame — the only per-frame work is one uniform. Animation runs on the
// synced server clock folded into a LOOP_MS loop that every frequency below
// divides, so all clients agree and the fold never jumps.
//
// Everything here is the accepted non-collidable rooftop clutter exception:
// figures and props stand ≤ 2 m above their own base, flag poles are thinner
// and shorter than the existing antenna masts, and lights are light.

import { type Building, mulberry32 } from "@angels-bandits/common/city";
import {
  EMISSIVE_BEACON,
  LANDMARK_HEIGHT,
  WORLD_SIZE,
} from "@angels-bandits/common/constants";
import * as THREE from "three";
import { emissiveBoost, luminance } from "./emissive";
import { QUALITY_PROFILES, type QualityTier } from "./quality";
import { roofClutterFor } from "./roofclutter";
import { RoofKind, roofStyleFor } from "./roofs";

// --- Layout rules --------------------------------------------------------

/** Parties and pools only on flat roofs below this — the flight band's
 * mid-rises, far under the searchlight stations (the ten tallest, ~190 m+). */
export const LIFE_MAX_HEIGHT = 120;
/** Flags fly on roofs below this (antenna masts own the tall ones). */
export const FLAG_MAX_HEIGHT = 150;
/** Smallest top-roof side (BOTH sides) that hosts a party / a pool, m. */
export const PARTY_MIN_ROOF = 22;
export const POOL_MIN_ROOF = 20;
export const PARTY_CHANCE = 0.16;
export const POOL_CHANCE = 0.12;
export const FLAG_CHANCE = 0.16;
export const COOLING_CHANCE = 0.14;
/** Share of AC boxes (all but the first — steam.ts vents from acBoxes[0])
 * that carry a spinning condenser fan. */
export const AC_FAN_CHANCE = 0.45;
/** Everything stays this far inside the roof edge: the parapet lip
 * (facade-garnish.ts, 1.1 m thick, centred on the edge) plus a margin. */
export const ROOF_INSET = 1.6;
/** Keep-out margin around existing clutter and between new props, m. */
const CLEARANCE = 0.6;

/** Prop height caps, measured from each prop's own base. */
export const PROP_MAX_HEIGHT = 2;
export const POLE_MAX_HEIGHT = 4;

/** String lights hang between these heights over the party deck, m. */
const STRAND_TOP = 3.4;
const STRAND_SAG = 0.8;
const BULB_PITCH = 1.1;
/** The deck's outline festoon: lower than the strands, sagging per span. */
const OUTLINE_TOP = 2.9;
const OUTLINE_SAG = 0.35;
const OUTLINE_SPAN = 5;
/** Pool slab: the water surface sits this far above the roof deck, inside a
 * coping rim this wide and tall. */
export const POOL_WATER_TOP = 0.25;
export const POOL_COPING_WIDTH = 0.35;
export const POOL_COPING_HEIGHT = 0.3;
const RIM_LIGHT_PITCH = 2.4;
/** Aviation lights sit this far above the mast top — clear of roofclutter's
 * 0.35 m tip sphere. */
const AVIATION_LIFT = 0.85;
/** Every flag streams the same way — one wind for the whole city. */
export const WIND_YAW = 0.7;

// --- Synced clock ----------------------------------------------------------

/** Animation loop, ms of synced server time. Every frequency below is an
 * INTEGER number of cycles per loop, so folding the epoch-scale clock into
 * [0, 1) never shows a seam. */
export const LOOP_MS = 120_000;
export const CYCLES_PER_LOOP = {
  /** 120 BPM: two beats a second. */
  beat: 240,
  /** Dancer sway, one a second. */
  sway: 120,
  /** Flag wave, 1.5 Hz. */
  flag: 180,
  /** Aviation flash, every 1.5 s. */
  blink: 80,
  /** Bulb shimmer and the multicolour chase. */
  twinkle: 300,
  chase: 90,
  /** Pool caustic layers. */
  causticA: 36,
  causticB: 52,
} as const;
/** Fan speeds, whole revolutions per loop (0.8–1.8 rev/s). */
const FAN_REVS_MIN = 96;
const FAN_REVS_SPAN = 120;

/** The loop phase in [0, 1) for a synced time in ms — float64 on the CPU, so
 * the GPU only ever sees a small number. */
export const loopPhase = (timeMs: number): number =>
  (((timeMs % LOOP_MS) + LOOP_MS) % LOOP_MS) / LOOP_MS;

// --- Layout types ----------------------------------------------------------

export interface Bulb {
  x: number;
  y: number;
  z: number;
  /** Index into BULB_HUES (warm parties use 0 only). */
  hue: number;
  /** Position along its strand — the chase pattern's phase. */
  index: number;
}

export interface Dancer {
  x: number;
  z: number;
  /** Roof deck height (the figure's base). */
  y: number;
  yaw: number;
  phase: number;
  tone: number;
}

export interface Party {
  /** Deck rectangle (axis-aligned), canonical center + half extents. */
  x: number;
  z: number;
  y: number;
  halfW: number;
  halfD: number;
  multicolor: boolean;
  beatPhase: number;
  bulbs: Bulb[];
  dancers: Dancer[];
}

export interface Pool {
  x: number;
  z: number;
  /** Roof deck height (the slab's base). */
  y: number;
  /** Water half extents (the coping rim is outside these). */
  halfW: number;
  halfD: number;
  rimLights: { x: number; y: number; z: number }[];
}

export interface Fan {
  x: number;
  z: number;
  /** Base of the fan unit (roof deck, or the AC box top it sits on). */
  y: number;
  radius: number;
  /** Cooling-tower cell body under the shroud, 0 for an AC-mounted fan. */
  body: number;
  /** Shroud height above the body. */
  shroud: number;
  revs: number;
  phase: number;
}

export interface Flag {
  x: number;
  z: number;
  y: number;
  pole: number;
  banner: boolean;
  /** Cloth length along the wind, and height. */
  clothW: number;
  clothH: number;
  /** Three stripe colours, indices into FLAG_COLORS. */
  stripes: [number, number, number];
  phase: number;
}

export interface AviationLight {
  x: number;
  y: number;
  z: number;
}

export interface RooftopLife {
  party: Party | null;
  pool: Pool | null;
  fans: Fan[];
  flags: Flag[];
  aviation: AviationLight[];
}

/** An axis-aligned keep-out rectangle in canonical coordinates. */
interface Rect {
  x: number;
  z: number;
  hw: number;
  hd: number;
}
const overlaps = (a: Rect, b: Rect, margin: number): boolean =>
  Math.abs(a.x - b.x) < a.hw + b.hw + margin &&
  Math.abs(a.z - b.z) < a.hd + b.hd + margin;

const EMPTY = (): RooftopLife => ({
  party: null,
  pool: null,
  fans: [],
  flags: [],
  aviation: [],
});

/** Why a roof stays bare: landmarks (the beacon is the read), helipads (the
 * pad must stay clear) and towers whose top tier has a sky hole or gate. */
export function rooftopLifeAllowed(b: Building): boolean {
  if (b.height >= LANDMARK_HEIGHT) return false;
  const topIndex = b.tiers.length - 1;
  if (topIndex < 0) return false;
  if (roofStyleFor(b).tierKinds[topIndex] === RoofKind.HELIPAD) return false;
  if (
    b.holes?.some(
      (h) =>
        (h.kind === "sky" || h.kind === "gate") && h.tierIndex === topIndex,
    )
  ) {
    return false;
  }
  return true;
}

/**
 * Deterministic rooftop life for one building's TOP tier roof. Every roll is
 * drawn for every building in a fixed order (the roofStyleFor idiom), so one
 * rule's gate never shifts another rule's outcome.
 */
export function rooftopLifeFor(b: Building): RooftopLife {
  const life = EMPTY();
  if (!rooftopLifeAllowed(b)) return life;
  const top = b.tiers[b.tiers.length - 1];
  if (!top) return life;

  // Own salt: roofClutterFor and roofStyleFor hash the same (x, z, height).
  const rand = mulberry32(
    (Math.imul(b.x, 2246822519) ^
      Math.imul(b.z, 3266489917) ^
      Math.imul(b.height, 668265263) ^
      0x5bd1e995) >>>
      0,
  );
  const rParty = rand();
  const rPartySide = rand();
  const rPartyMulti = rand();
  const rPartyBeat = rand();
  const rPool = rand();
  const rFlag = rand();
  const rFlagCorners = rand();
  const rCooling = rand();
  // A sub-stream for the variable-length details, seeded from the main one,
  // so how many dancers one party has never moves the next building's rolls.
  const detail = mulberry32((rand() * 4294967296) >>> 0);

  const kind = roofStyleFor(b).tierKinds[b.tiers.length - 1];
  const flat = kind === RoofKind.MEMBRANE || kind === RoofKind.GRAVEL;
  const clutter = roofClutterFor(b);
  const halfW = top.width / 2;
  const halfD = top.depth / 2;
  const innerW = halfW - ROOF_INSET;
  const innerD = halfD - ROOF_INSET;
  const minSide = Math.min(top.width, top.depth);
  const y = b.height;

  const taken: Rect[] = [
    ...clutter.waterTowers.map((t) => ({
      x: t.x,
      z: t.z,
      hw: t.radius,
      hd: t.radius,
    })),
    ...clutter.acBoxes.map((a) => ({
      x: a.x,
      z: a.z,
      hw: a.width / 2,
      hd: a.depth / 2,
    })),
    ...clutter.masts.map((m) => ({ x: m.x, z: m.z, hw: 0.3, hd: 0.3 })),
  ];
  const free = (r: Rect) => taken.every((t) => !overlaps(r, t, CLEARANCE));
  // Along the roof's LONG axis: the party takes one end, a pool the other.
  const longX = top.width >= top.depth;
  const innerLong = longX ? innerW : innerD;
  const innerShort = longX ? innerD : innerW;
  const endRect = (side: number, long: number, short: number): Rect => {
    const along = side * (innerLong - long / 2);
    return longX
      ? { x: b.x + along, z: b.z, hw: long / 2, hd: short / 2 }
      : { x: b.x, z: b.z + along, hw: short / 2, hd: long / 2 };
  };
  const placeEnd = (preferred: number, long: number, short: number) => {
    for (const side of [preferred, -preferred]) {
      const r = endRect(side, long, short);
      if (free(r)) return { rect: r, side };
    }
    return null;
  };

  // --- Party: a deck at one end of the roof, strands across it.
  let partySide = 0;
  if (flat && b.height < LIFE_MAX_HEIGHT && minSide >= PARTY_MIN_ROOF) {
    if (rParty < PARTY_CHANCE) {
      const long = Math.min(innerLong, 22);
      const short = Math.min(innerShort * 2, 14);
      const spot = placeEnd(rPartySide < 0.5 ? -1 : 1, long, short);
      if (spot) {
        partySide = spot.side;
        life.party = buildParty(
          spot.rect,
          y,
          longX,
          rPartyMulti < 0.4,
          rPartyBeat,
          detail,
        );
        taken.push(spot.rect);
      }
    }
  }

  // --- Pool: the other end when there is a party, either end otherwise.
  if (flat && b.height < LIFE_MAX_HEIGHT && minSide >= POOL_MIN_ROOF) {
    if (rPool < POOL_CHANCE) {
      const long = Math.min(innerLong * 0.7, 14);
      const short = Math.min(innerShort * 1.2, 7);
      const preferred =
        partySide !== 0 ? -partySide : rPool < POOL_CHANCE / 2 ? -1 : 1;
      const spot = placeEnd(preferred, long, short);
      if (spot) {
        life.pool = buildPool(spot.rect, y);
        taken.push(spot.rect);
      }
    }
  }

  // --- Condenser fans on the AC boxes (never acBoxes[0]: steam's vent).
  clutter.acBoxes.forEach((box, i) => {
    const rHas = detail();
    const rRevs = detail();
    const rPhase = detail();
    if (i === 0 || rHas >= AC_FAN_CHANCE) return;
    life.fans.push({
      x: box.x,
      z: box.z,
      y: box.y + box.height,
      radius: Math.min(box.width, box.depth) * 0.36,
      body: 0,
      shroud: 0.3,
      revs: FAN_REVS_MIN + Math.floor(rRevs * FAN_REVS_SPAN),
      phase: rPhase,
    });
  });

  // --- Cooling-tower cells: a short row of boxy cells with big fans.
  if (rCooling < COOLING_CHANCE && minSide >= 18) {
    const cells = 1 + Math.floor(detail() * 3);
    const cell = 3 + detail() * 1;
    const body = 1.2 + detail() * 0.2;
    const along = detail() < 0.5;
    for (let tries = 0; tries < 6; tries++) {
      const rowLong = cells * cell;
      const hw = (along ? rowLong : cell) / 2;
      const hd = (along ? cell : rowLong) / 2;
      const r: Rect = {
        x: b.x + (detail() * 2 - 1) * Math.max(0, innerW - hw),
        z: b.z + (detail() * 2 - 1) * Math.max(0, innerD - hd),
        hw,
        hd,
      };
      if (hw > innerW || hd > innerD || !free(r)) continue;
      taken.push(r);
      for (let c = 0; c < cells; c++) {
        const off = -rowLong / 2 + cell * (c + 0.5);
        life.fans.push({
          x: r.x + (along ? off : 0),
          z: r.z + (along ? 0 : off),
          y,
          radius: cell * 0.42,
          body,
          shroud: 0.6,
          revs: FAN_REVS_MIN + Math.floor(detail() * FAN_REVS_SPAN),
          phase: detail(),
        });
      }
      break;
    }
  }

  // --- Flags and banners on short poles at the roof corners.
  if (rFlag < FLAG_CHANCE && b.height < FLAG_MAX_HEIGHT) {
    const count = rFlagCorners < 0.4 ? 2 : 1;
    const first = Math.floor(rFlagCorners * 4) % 4;
    for (let k = 0; k < count; k++) {
      // Opposite corners when there are two — a pair reads as a pair.
      const corner = (first + k * 2) % 4;
      const sx = corner & 1 ? 1 : -1;
      const sz = corner & 2 ? 1 : -1;
      const banner = detail() < 0.35;
      const flag: Flag = {
        x: b.x + sx * innerW,
        z: b.z + sz * innerD,
        y,
        pole: 3.6 + detail() * 0.4,
        banner,
        clothW: banner ? 1.0 : 2.0 + detail() * 0.4,
        clothH: banner ? 2.2 : 1.2 + detail() * 0.2,
        stripes: [
          Math.floor(detail() * FLAG_COLORS.length),
          Math.floor(detail() * FLAG_COLORS.length),
          Math.floor(detail() * FLAG_COLORS.length),
        ],
        phase: detail(),
      };
      if (free({ x: flag.x, z: flag.z, hw: 0.3, hd: 0.3 })) {
        life.flags.push(flag);
        taken.push({ x: flag.x, z: flag.z, hw: 0.3, hd: 0.3 });
      }
    }
  }

  // --- Aviation lights on every antenna mast (roofclutter's tall roofs).
  for (const m of clutter.masts) {
    life.aviation.push({ x: m.x, y: m.y + m.height + AVIATION_LIFT, z: m.z });
  }

  return life;
}

function buildParty(
  r: Rect,
  y: number,
  longX: boolean,
  multicolor: boolean,
  beatPhase: number,
  rand: () => number,
): Party {
  // Strands run ACROSS the deck (along its short axis), spaced along it.
  const long = longX ? r.hw : r.hd;
  const short = longX ? r.hd : r.hw;
  const strands = Math.max(2, Math.min(5, Math.round((long * 2) / 4.5)));
  const bulbs: Bulb[] = [];
  for (let s = 0; s < strands; s++) {
    const along = -long + ((s + 0.5) * (long * 2)) / strands;
    const n = Math.max(2, Math.round((short * 2) / BULB_PITCH));
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const across = -short + t * short * 2;
      const by = y + STRAND_TOP - STRAND_SAG * 4 * t * (1 - t);
      bulbs.push({
        x: r.x + (longX ? along : across),
        y: by,
        z: r.z + (longX ? across : along),
        hue: multicolor ? (i % (BULB_HUES.length - 1)) + 1 : 0,
        index: i + s * 3,
      });
    }
  }
  // A festoon outline around the deck — the rectangle of light that reads
  // as "party" from chase-cam distance. Posts every ~5 m, a shallow sag
  // between them.
  const corners = [
    [-r.hw, -r.hd],
    [r.hw, -r.hd],
    [r.hw, r.hd],
    [-r.hw, r.hd],
  ] as const;
  let edgeIndex = 0;
  corners.forEach(([ax, az], c) => {
    const [bx, bz] = corners[(c + 1) % 4] ?? corners[0];
    const len = Math.hypot(bx - ax, bz - az);
    const spans = Math.max(1, Math.round(len / OUTLINE_SPAN));
    const n = Math.max(2, Math.round(len / BULB_PITCH));
    for (let i = 0; i < n; i++) {
      const t = i / n;
      const local = (t * spans) % 1;
      bulbs.push({
        x: r.x + ax + (bx - ax) * t,
        y: y + OUTLINE_TOP - OUTLINE_SAG * 4 * local * (1 - local),
        z: r.z + az + (bz - az) * t,
        hue: multicolor ? (edgeIndex % (BULB_HUES.length - 1)) + 1 : 0,
        index: edgeIndex++,
      });
    }
  });
  const dancerCount = 3 + Math.floor(rand() * 5);
  const dancers: Dancer[] = [];
  for (let i = 0; i < dancerCount; i++) {
    const rx = rand();
    const rz = rand();
    const rYaw = rand();
    const rPhase = rand();
    const rTone = rand();
    const d: Dancer = {
      x: r.x + (rx * 2 - 1) * Math.max(0, r.hw - 1),
      z: r.z + (rz * 2 - 1) * Math.max(0, r.hd - 1),
      y,
      yaw: rYaw * Math.PI * 2,
      phase: beatPhase + rPhase * 0.15,
      tone: Math.floor(rTone * DANCER_TONES.length),
    };
    // Personal space: drop a dancer who would stand inside another.
    if (dancers.every((o) => Math.hypot(o.x - d.x, o.z - d.z) > 0.9)) {
      dancers.push(d);
    }
  }
  return {
    x: r.x,
    z: r.z,
    y,
    halfW: r.hw,
    halfD: r.hd,
    multicolor,
    beatPhase,
    bulbs,
    dancers,
  };
}

function buildPool(r: Rect, y: number): Pool {
  const halfW = r.hw - POOL_COPING_WIDTH;
  const halfD = r.hd - POOL_COPING_WIDTH;
  const rimLights: Pool["rimLights"] = [];
  const ly = y + POOL_COPING_HEIGHT + 0.1;
  const side = (fromX: number, fromZ: number, dx: number, dz: number) => {
    const len = Math.hypot(dx, dz);
    const n = Math.max(1, Math.round(len / RIM_LIGHT_PITCH));
    for (let i = 0; i < n; i++) {
      const t = i / n;
      rimLights.push({ x: fromX + dx * t, y: ly, z: fromZ + dz * t });
    }
  };
  // Lights sit on the coping's center line, walking the four sides.
  const cw = halfW + POOL_COPING_WIDTH / 2;
  const cd = halfD + POOL_COPING_WIDTH / 2;
  side(r.x - cw, r.z - cd, 2 * cw, 0);
  side(r.x + cw, r.z - cd, 0, 2 * cd);
  side(r.x + cw, r.z + cd, -2 * cw, 0);
  side(r.x - cw, r.z + cd, 0, -2 * cd);
  return { x: r.x, z: r.z, y, halfW, halfD, rimLights };
}

// --- Palettes (linear — GLSL space) -------------------------------------

/** Bloom threshold (main.ts) — the fills and the pool stay under it. */
export const BLOOM_THRESHOLD = 0.72;
/** String-light bulbs and pool rim lights glow (over the threshold) but stay
 * under the SIGN rung — party lights, not signage. */
export const BULB_LUMINANCE = 0.85;
export const RIM_LIGHT_LUMINANCE = 0.8;
/** Aviation obstruction red peaks at the BEACON rung; the trough is dark. */
export const AVIATION_LUMINANCE = EMISSIVE_BEACON;
const AVIATION_TROUGH = 0.08;
export const BULB_HUES = [
  new THREE.Color(1.0, 0.74, 0.42), // warm festoon white
  new THREE.Color(1.0, 0.24, 0.2), // red
  new THREE.Color(1.0, 0.7, 0.18), // amber
  new THREE.Color(0.3, 1.0, 0.45), // green
  new THREE.Color(0.3, 0.55, 1.0), // blue
  new THREE.Color(1.0, 0.3, 0.85), // magenta
] as const;
const RIM_LIGHT_COLOR = new THREE.Color(0.55, 0.95, 1.0);
const AVIATION_COLOR = new THREE.Color(1.0, 0.1, 0.06);
/** Shimmer depth of a steady bulb, and the chase's dim floor. */
const TWINKLE_DEPTH = 0.15;
const CHASE_FLOOR = 0.45;

/** Pool water: turquoise emissive with a caustic shimmer. The three terms'
 * PEAK luminances sum under the bloom threshold — the pool reads as lit
 * water, never as a lamp; only its rim lights bloom. */
export const POOL_WATER_COLOR = new THREE.Color(0.12, 0.85, 0.82);
export const POOL_BASE_LUMINANCE = 0.34;
export const POOL_EDGE_LUMINANCE = 0.1;
export const POOL_CAUSTIC_LUMINANCE = 0.18;

/** Party figures pick up the string lights; flags are softly floodlit. Both
 * are LIGHT on the albedo (≤ 0.85 albedo × gain stays far under bloom). */
export const DANCER_FILL = 0.45;
export const FLAG_FILL = 0.3;
const DANCER_FILL_TINT = new THREE.Color(1.0, 0.78, 0.55);

/** sRGB hexes, converted to linear by THREE.Color. */
const DANCER_TONES = [
  0xd23a4a, 0x2f6fd8, 0xf2c94c, 0xe8e8e8, 0x2bb673, 0x9b51e0, 0x222831,
] as const;
const SKIN_TONES = [0xc68642, 0x8d5524, 0xe0ac69, 0xf1c27d] as const;
const LEG_TONE = 0x1e2430;
export const FLAG_COLORS = [
  0xc8102e, 0xffffff, 0x0033a0, 0xffcd00, 0x009a44, 0x00a3e0, 0xff6a13,
] as const;
const POLE_TONE = 0xb8bcc2;
const HOUSING_TONE = 0x9aa1aa;
const BLADE_TONE = 0x3a3f46;
const CELL_TONE = 0x8a929c;
const POOL_TILE_TONE = 0x5aa7b5;
const COPING_TONE = 0xc9c3b6;

// --- Torus wrap (GLSL + its TS mirror) ------------------------------------

/** The nearest-image offset along one axis — the TS mirror of the shaders'
 * `floor((cameraPosition.xz - pivot.xz) / W + 0.5) * W`. */
export const wrapOffset = (camera: number, pivot: number): number =>
  Math.floor((camera - pivot) / WORLD_SIZE + 0.5) * WORLD_SIZE;

const W_GLSL = WORLD_SIZE.toFixed(1);
const TAU = "6.28318530718";

// --- Baking --------------------------------------------------------------

/** Animation tags (aAnim.x) — the shader branches on these. */
export const PropPart = {
  STATIC: 0,
  BLADE: 1,
  CLOTH: 2,
  DANCER: 3,
  WATER: 4,
} as const;
/** Fold distances: a part this far from the camera collapses to its pivot. */
const FOLD_DANCER = 260;
const FOLD_SMALL = 460;
const FOLD_NEVER = 4000;
/** The baked-vertex budget across the whole city. */
export const PROP_VERTEX_BUDGET = 150_000;

export interface BakedProps {
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  /** xyz canonical pivot, w fold distance. */
  pivots: Float32Array;
  /** part, phase, a, b (meaning depends on the part). */
  anims: Float32Array;
  vertexCount: number;
}

class Baker {
  readonly p: number[] = [];
  readonly n: number[] = [];
  readonly c: number[] = [];
  readonly pv: number[] = [];
  readonly an: number[] = [];
  pivot = { x: 0, y: 0, z: 0, fold: FOLD_NEVER };

  /** Append a (non-indexed) geometry, already in pivot-local meters. */
  add(
    g: THREE.BufferGeometry,
    color: THREE.Color,
    anim: readonly [number, number, number, number],
  ): void {
    const flat = g.index ? g.toNonIndexed() : g;
    const pos = flat.getAttribute("position");
    const nor = flat.getAttribute("normal");
    for (let i = 0; i < pos.count; i++) {
      this.p.push(pos.getX(i), pos.getY(i), pos.getZ(i));
      this.n.push(nor.getX(i), nor.getY(i), nor.getZ(i));
      this.c.push(color.r, color.g, color.b);
      const { x, y, z, fold } = this.pivot;
      this.pv.push(x, y, z, fold);
      this.an.push(anim[0], anim[1], anim[2], anim[3]);
    }
    if (flat !== g) flat.dispose();
    g.dispose();
  }

  /** Append raw triangles (cloth) with per-triangle colours. */
  addTriangles(
    tris: { p: number[]; n: [number, number, number]; color: THREE.Color }[],
    anims: number[][],
  ): void {
    tris.forEach((t, k) => {
      for (let v = 0; v < 3; v++) {
        this.p.push(t.p[v * 3] ?? 0, t.p[v * 3 + 1] ?? 0, t.p[v * 3 + 2] ?? 0);
        this.n.push(t.n[0], t.n[1], t.n[2]);
        this.c.push(t.color.r, t.color.g, t.color.b);
        const { x, y, z, fold } = this.pivot;
        this.pv.push(x, y, z, fold);
        const a = anims[k * 3 + v] ?? [0, 0, 0, 0];
        this.an.push(a[0] ?? 0, a[1] ?? 0, a[2] ?? 0, a[3] ?? 0);
      }
    });
  }
}

/** A unit box with its base at y = 0, scaled and placed in pivot space. */
const box = (
  w: number,
  h: number,
  d: number,
  x = 0,
  yBase = 0,
  z = 0,
): THREE.BufferGeometry =>
  new THREE.BoxGeometry(w, h, d).translate(x, yBase + h / 2, z);

const hex = (h: number) => new THREE.Color(h);

/**
 * Bake every prop of every roof into one static vertex set. Pure (THREE's
 * CPU-side geometry only — no GPU, no DOM), so the vertex budget is testable.
 */
export function bakeRooftopProps(lives: readonly RooftopLife[]): BakedProps {
  const k = new Baker();
  const still = [PropPart.STATIC, 0, 0, 0] as const;

  for (const life of lives) {
    if (life.pool) {
      const pool = life.pool;
      k.pivot = { x: pool.x, y: pool.y, z: pool.z, fold: FOLD_NEVER };
      const ww = pool.halfW * 2;
      const wd = pool.halfD * 2;
      // Water surface: a plane carrying the WATER tag, POOL_WATER_TOP above
      // the deck — the taller coping rim hides the gap beneath it.
      const slab = new THREE.PlaneGeometry(ww, wd).rotateX(-Math.PI / 2);
      slab.translate(0, POOL_WATER_TOP, 0);
      k.add(slab, hex(POOL_TILE_TONE), [
        PropPart.WATER,
        0,
        pool.halfW,
        pool.halfD,
      ]);
      // Coping rim: four stone kerbs around the water.
      const cw = POOL_COPING_WIDTH;
      const ch = POOL_COPING_HEIGHT;
      const stone = hex(COPING_TONE);
      k.add(
        box(ww + 2 * cw, ch, cw, 0, 0, -(pool.halfD + cw / 2)),
        stone,
        still,
      );
      k.add(box(ww + 2 * cw, ch, cw, 0, 0, pool.halfD + cw / 2), stone, still);
      k.add(box(cw, ch, wd, -(pool.halfW + cw / 2), 0, 0), stone, still);
      k.add(box(cw, ch, wd, pool.halfW + cw / 2, 0, 0), stone, still);
    }

    for (const d of life.party?.dancers ?? []) {
      k.pivot = { x: d.x, y: d.y, z: d.z, fold: FOLD_DANCER };
      const anim = [PropPart.DANCER, d.phase, d.yaw, 0] as const;
      const shirt = hex(DANCER_TONES[d.tone] ?? DANCER_TONES[0]);
      const skin = hex(SKIN_TONES[d.tone % SKIN_TONES.length] ?? 0xc68642);
      const legs = hex(LEG_TONE);
      // Facing is applied in the shader (yaw + sway), so bake facing +z.
      k.add(box(0.34, 0.8, 0.2), legs, anim);
      k.add(box(0.42, 0.6, 0.24, 0, 0.8), shirt, anim);
      k.add(box(0.22, 0.22, 0.22, 0, 1.43), skin, anim);
      // Hands up: two arms raised in a V from the shoulders (tops ≤ 1.9 m).
      for (const s of [-1, 1]) {
        const arm = new THREE.BoxGeometry(0.09, 0.5, 0.09)
          .translate(0, 0.25, 0)
          .rotateZ(-s * 0.45)
          .translate(s * 0.24, 1.36, 0);
        k.add(arm, shirt, anim);
      }
    }

    for (const f of life.fans) {
      k.pivot = { x: f.x, y: f.y, z: f.z, fold: FOLD_SMALL };
      if (f.body > 0) {
        k.add(
          box(f.radius * 2.38, f.body, f.radius * 2.38),
          hex(CELL_TONE),
          still,
        );
      }
      const shroud = new THREE.CylinderGeometry(
        f.radius,
        f.radius,
        f.shroud,
        10,
        1,
        true,
      ).translate(0, f.body + f.shroud / 2, 0);
      k.add(shroud, hex(HOUSING_TONE), still);
      const bladeY = f.body + f.shroud * 0.7;
      const blade = [PropPart.BLADE, f.phase, f.revs, 0] as const;
      const span = f.radius * 1.84;
      const chord = Math.max(0.12, f.radius * 0.3);
      // Two crossed blade planes, top face only — a shrouded fan is only
      // ever seen from above or edge-on.
      const plane = (w: number, d: number) =>
        new THREE.PlaneGeometry(w, d)
          .rotateX(-Math.PI / 2)
          .translate(0, bladeY, 0);
      k.add(plane(span, chord), hex(BLADE_TONE), blade);
      k.add(plane(chord, span), hex(BLADE_TONE), blade);
    }

    for (const f of life.flags) {
      k.pivot = { x: f.x, y: f.y, z: f.z, fold: FOLD_SMALL };
      k.add(
        new THREE.CylinderGeometry(0.05, 0.07, f.pole, 5, 1, true).translate(
          0,
          f.pole / 2,
          0,
        ),
        hex(POLE_TONE),
        still,
      );
      bakeCloth(k, f);
    }
  }

  return {
    positions: new Float32Array(k.p),
    normals: new Float32Array(k.n),
    colors: new Float32Array(k.c),
    pivots: new Float32Array(k.pv),
    anims: new Float32Array(k.an),
    vertexCount: k.p.length / 3,
  };
}

/** Cloth: a 5 × 3 grid streaming along WIND_YAW from the pole top, baked
 * two-sided (back faces carry flipped normals), each stripe its own colour.
 * aAnim = (CLOTH, phase, u = meters from the pole, banner ? 1 : 0). */
function bakeCloth(k: Baker, f: Flag): void {
  const NU = 5;
  const NV = 3;
  const tx = Math.cos(WIND_YAW);
  const tz = Math.sin(WIND_YAW);
  // Horizontal normal of the cloth plane (t × up).
  const nx = -tz;
  const nz = tx;
  const top = f.pole - 0.08;
  const at = (iu: number, iv: number): [number, number, number, number] => {
    const u = (iu / NU) * f.clothW;
    const v = (iv / NV) * f.clothH;
    return [tx * u, top - v, tz * u, u];
  };
  const tris: {
    p: number[];
    n: [number, number, number];
    color: THREE.Color;
  }[] = [];
  const anims: number[][] = [];
  for (let iv = 0; iv < NV; iv++) {
    // Flags stripe horizontally; banners read as one long vertical field.
    const stripe = f.banner ? f.stripes[0] : f.stripes[iv];
    const color = hex(FLAG_COLORS[stripe ?? 0] ?? FLAG_COLORS[0]);
    for (let iu = 0; iu < NU; iu++) {
      const a = at(iu, iv);
      const b = at(iu + 1, iv);
      const c = at(iu + 1, iv + 1);
      const d = at(iu, iv + 1);
      const quads: [number, number, number, number][][] = [
        [a, d, c],
        [a, c, b],
      ];
      for (const q of quads) {
        for (const side of [1, -1]) {
          const order = side === 1 ? q : [q[0], q[2], q[1]];
          const p: number[] = [];
          for (const v of order) {
            if (!v) continue;
            p.push(v[0], v[1], v[2]);
            anims.push([PropPart.CLOTH, f.phase, v[3], f.banner ? 1 : 0]);
          }
          tris.push({ p, n: [nx * side, 0, nz * side], color });
        }
      }
    }
  }
  k.addTriangles(tris, anims);
}

// --- Lights --------------------------------------------------------------

/** Light modes (aLight.x). */
const LightMode = {
  TWINKLE: 0,
  CHASE: 1,
  BLINK: 2,
  STEADY: 3,
  HAZE: 4,
} as const;

export interface BakedLights {
  positions: Float32Array;
  colors: Float32Array;
  sizes: Float32Array;
  /** mode, phase. */
  modes: Float32Array;
  count: number;
}

const BULB_SIZE = 1.0;
/** The party's warm haze: one big faint sprite over the deck, pulsing on
 * the beat — far under the bloom threshold, it only lifts the deck. */
export const HAZE_LUMINANCE = 0.12;
const HAZE_COLOR = new THREE.Color(1.0, 0.62, 0.4);
const HAZE_LIFT = 1.6;
const HAZE_SCALE = 1.5;
const RIM_SIZE = 0.8;
const AVIATION_SIZE = 2.4;

/** Every rooftop light, peak colours already lifted to their rungs. */
export function bakeRooftopLights(lives: readonly RooftopLife[]): BakedLights {
  const pos: number[] = [];
  const col: number[] = [];
  const size: number[] = [];
  const mode: number[] = [];
  const scratch = new THREE.Color();
  const push = (
    x: number,
    y: number,
    z: number,
    c: THREE.Color,
    target: number,
    s: number,
    m: number,
    phase: number,
  ) => {
    scratch.copy(c).multiplyScalar(emissiveBoost(c, target));
    pos.push(x, y, z);
    col.push(scratch.r, scratch.g, scratch.b);
    size.push(s);
    mode.push(m, phase);
  };
  for (const life of lives) {
    const party = life.party;
    if (party) {
      for (const bulb of party.bulbs) {
        const hue = BULB_HUES[bulb.hue] ?? BULB_HUES[0];
        push(
          bulb.x,
          bulb.y,
          bulb.z,
          hue,
          BULB_LUMINANCE,
          BULB_SIZE,
          party.multicolor ? LightMode.CHASE : LightMode.TWINKLE,
          party.multicolor ? bulb.index / 6 : (bulb.index * 0.618) % 1,
        );
      }
      push(
        party.x,
        party.y + HAZE_LIFT,
        party.z,
        HAZE_COLOR,
        HAZE_LUMINANCE,
        HAZE_SCALE * Math.max(party.halfW, party.halfD) * 2,
        LightMode.HAZE,
        party.beatPhase,
      );
    }
    for (const l of life.pool?.rimLights ?? []) {
      push(
        l.x,
        l.y,
        l.z,
        RIM_LIGHT_COLOR,
        RIM_LIGHT_LUMINANCE,
        RIM_SIZE,
        LightMode.STEADY,
        0,
      );
    }
    // Obstruction lights flash in unison city-wide, as real ones do.
    for (const a of life.aviation) {
      push(
        a.x,
        a.y,
        a.z,
        AVIATION_COLOR,
        AVIATION_LUMINANCE,
        AVIATION_SIZE,
        LightMode.BLINK,
        0,
      );
    }
  }
  return {
    positions: new Float32Array(pos),
    colors: new Float32Array(col),
    sizes: new Float32Array(size),
    modes: new Float32Array(mode),
    count: pos.length / 3,
  };
}

// --- Shaders ---------------------------------------------------------------

/** Distinct program keys (three keys programs on onBeforeCompile.toString(),
 * and sibling patches can collide silently — see movers.ts). */
export const ROOFTOP_LIGHTS_CACHE_KEY = "ab-rooftop-lights";
export const ROOFTOP_PROPS_CACHE_KEY = "ab-rooftop-props";

/** Bulbs fade out over this camera distance (aviation lights never do). */
const LIGHT_FADE_NEAR = 520;
const LIGHT_FADE_FAR = 900;
/** Far points never shrink below this many drawing-buffer pixels. */
const LIGHT_MIN_PX = 2.5;

const glsl = (n: number) => n.toFixed(4);

const LIGHTS_VERTEX_PARS = /* glsl */ `
uniform float uLoop;
attribute float aSize;
attribute vec2 aLight;
`;

const LIGHTS_VERTEX_MAIN = /* glsl */ `
// Nearest torus image of this point (the nearestImage idiom, on the GPU).
transformed.xz += floor((cameraPosition.xz - transformed.xz) / ${W_GLSL} + 0.5) * ${W_GLSL};
float abDist = distance(transformed, cameraPosition);
float abK = 1.0;
if (aLight.x < 0.5) {
  // Festoon shimmer: a slow, shallow breath per bulb.
  abK = 1.0 - ${glsl(TWINKLE_DEPTH)} * (0.5 + 0.5 * sin(${TAU} * (uLoop * ${CYCLES_PER_LOOP.twinkle.toFixed(1)} + aLight.y)));
} else if (aLight.x < 1.5) {
  // Multicolour chase: a bright band walks along each strand.
  float c = fract(uLoop * ${CYCLES_PER_LOOP.chase.toFixed(1)} - aLight.y);
  abK = mix(${glsl(CHASE_FLOOR)}, 1.0, smoothstep(0.6, 0.8, c) * (1.0 - smoothstep(0.85, 1.0, c)));
} else if (aLight.x < 2.5) {
  // Aviation flash: on for ~30% of the period, a dark trough between.
  float c = fract(uLoop * ${CYCLES_PER_LOOP.blink.toFixed(1)} + aLight.y);
  abK = mix(${glsl(AVIATION_TROUGH)}, 1.0, smoothstep(0.0, 0.06, c) * (1.0 - smoothstep(0.26, 0.34, c)));
} else if (aLight.x > 3.5) {
  // Party haze: breathes with the music, on the dancers' beat.
  abK = 0.75 + 0.25 * abs(sin(3.14159265 * (uLoop * ${CYCLES_PER_LOOP.beat.toFixed(1)} + aLight.y)));
}
// Party and pool lights fade with distance (no fog on additive points —
// the V1 lesson); obstruction lights carry across the whole city.
if (aLight.x < 1.5 || aLight.x > 2.5) {
  abK *= 1.0 - smoothstep(${glsl(LIGHT_FADE_NEAR)}, ${glsl(LIGHT_FADE_FAR)}, abDist);
}
#if defined( USE_COLOR_ALPHA )
  vColor.rgb *= abK;
#elif defined( USE_COLOR )
  vColor *= abK;
#endif
`;

/** The props' vertex animation. Runs in beginnormal (normals) and
 * begin_vertex (positions) — both inside main(), so locals carry over. */
const PROPS_VERTEX_PARS = /* glsl */ `
uniform float uLoop;
attribute vec4 aPivot;
attribute vec4 aAnim;
varying float vAbPart;
varying vec3 vAbLocal;
varying vec2 vAbHalf;
mat2 abRot(float a) { float c = cos(a); float s = sin(a); return mat2(c, -s, s, c); }
`;

const PROPS_BEGIN_NORMAL = /* glsl */ `
float abPart = aAnim.x;
float abAngle = 0.0;
float abBob = 0.0;
float abWave = 0.0;
vec2 abT = vec2(${glsl(Math.cos(WIND_YAW))}, ${glsl(Math.sin(WIND_YAW))});
vec2 abN = vec2(-abT.y, abT.x);
if (abPart > 0.5 && abPart < 1.5) {
  // Fan blades: whole revolutions per loop, about the pivot's vertical axis.
  abAngle = ${TAU} * fract(uLoop * aAnim.z + aAnim.y);
} else if (abPart > 2.5 && abPart < 3.5) {
  // Dancers: face their yaw, sway once a second, bob on every beat.
  abAngle = aAnim.z + 0.45 * sin(${TAU} * (uLoop * ${CYCLES_PER_LOOP.sway.toFixed(1)} + aAnim.y));
  abBob = 0.09 * abs(sin(3.14159265 * (uLoop * ${CYCLES_PER_LOOP.beat.toFixed(1)} + aAnim.y)));
} else if (abPart > 1.5 && abPart < 2.5) {
  // Cloth: a travelling wave that grows away from the pole. Banners hang
  // and so only ripple.
  float u = aAnim.z;
  float amp = (aAnim.w > 0.5 ? 0.05 : 0.11) * u;
  float ph = ${TAU} * (uLoop * ${CYCLES_PER_LOOP.flag.toFixed(1)} + aAnim.y) - u * 3.2;
  abWave = amp * sin(ph);
  // Tilt the normal by the wave's slope along the cloth.
  float slope = (aAnim.w > 0.5 ? 0.05 : 0.11) * (sin(ph) - u * 3.2 * cos(ph));
  float side = sign(dot(objectNormal.xz, abN));
  objectNormal.xz = normalize(objectNormal.xz - side * slope * abT);
}
if (abAngle != 0.0) objectNormal.xz = abRot(abAngle) * objectNormal.xz;
`;

const PROPS_BEGIN_VERTEX = /* glsl */ `
vAbPart = abPart;
vAbLocal = transformed;
vAbHalf = aAnim.zw;
if (abAngle != 0.0) transformed.xz = abRot(abAngle) * transformed.xz;
transformed.y += abBob;
transformed.xz += abN * abWave;
// Nearest torus image of the PIVOT, so a prop never splits across images.
vec3 abPivot = aPivot.xyz;
abPivot.xz += floor((cameraPosition.xz - abPivot.xz) / ${W_GLSL} + 0.5) * ${W_GLSL};
// Fold far small parts into their pivot (degenerate — no raster cost).
if (distance(abPivot, cameraPosition) > aPivot.w) transformed = vec3(0.0);
transformed += abPivot;
`;

const PROPS_FRAGMENT_PARS = /* glsl */ `
uniform float uLoop;
varying float vAbPart;
varying vec3 vAbLocal;
varying vec2 vAbHalf;
`;

const poolColor = (target: number) =>
  POOL_WATER_COLOR.clone().multiplyScalar(
    emissiveBoost(POOL_WATER_COLOR, target),
  );
const vec3 = (c: THREE.Color) =>
  `vec3(${glsl(c.r)}, ${glsl(c.g)}, ${glsl(c.b)})`;

const PROPS_FRAGMENT_EMISSIVE = /* glsl */ `
if (vAbPart > 3.5) {
  // Pool water: lit turquoise, brighter at the walls (the underwater lamps),
  // with two drifting caustic layers. Sub-bloom by construction.
  vec2 q = vAbLocal.xz;
  float edge = min(vAbHalf.x - abs(q.x), vAbHalf.y - abs(q.y));
  float edgeK = 1.0 - smoothstep(0.0, 1.4, edge);
  float tA = ${TAU} * uLoop * ${CYCLES_PER_LOOP.causticA.toFixed(1)};
  float tB = ${TAU} * uLoop * ${CYCLES_PER_LOOP.causticB.toFixed(1)};
  float w1 = sin(q.x * 1.9 + sin(q.y * 1.3 + tA) * 1.4);
  float w2 = sin(q.y * 2.3 + sin(q.x * 1.1 - tB) * 1.6);
  float caustic = pow(1.0 - abs(w1 + w2) * 0.5, 5.0);
  totalEmissiveRadiance = ${vec3(poolColor(POOL_BASE_LUMINANCE))}
    + ${vec3(poolColor(POOL_EDGE_LUMINANCE))} * edgeK
    + ${vec3(poolColor(POOL_CAUSTIC_LUMINANCE))} * caustic;
  diffuseColor.rgb *= 0.25;
} else if (vAbPart > 2.5) {
  totalEmissiveRadiance += diffuseColor.rgb * ${vec3(DANCER_FILL_TINT)} * ${glsl(DANCER_FILL)};
} else if (vAbPart > 1.5) {
  totalEmissiveRadiance += diffuseColor.rgb * ${glsl(FLAG_FILL)};
}
`;

/** Worst-case pool water luminance — every term at its peak. */
export const poolPeakLuminance = (): number =>
  luminance(poolColor(POOL_BASE_LUMINANCE)) +
  luminance(poolColor(POOL_EDGE_LUMINANCE)) +
  luminance(poolColor(POOL_CAUSTIC_LUMINANCE));

/** The shader sources, for QA/tests (no GPU needed). */
export const ROOFTOP_SHADER_SOURCE = {
  lightsVertex: LIGHTS_VERTEX_MAIN,
  propsNormal: PROPS_BEGIN_NORMAL,
  propsVertex: PROPS_BEGIN_VERTEX,
  propsEmissive: PROPS_FRAGMENT_EMISSIVE,
} as const;

/** Soft round glow, procedural like every other sprite in the repo. */
function glowTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d");
  if (!g) return new THREE.Texture();
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.2, "rgba(255,255,255,0.85)");
  grad.addColorStop(0.5, "rgba(255,255,255,0.22)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

/** The rooftop-life renderer: two static draws, one uniform per frame. */
export class RooftopLifeRenderer {
  readonly group = new THREE.Group();
  readonly lights: THREE.Points;
  readonly props: THREE.Mesh;
  readonly counts: {
    parties: number;
    bulbs: number;
    dancers: number;
    pools: number;
    fans: number;
    flags: number;
    aviation: number;
    lights: number;
    propVertices: number;
  };
  private readonly loop = { value: 0 };

  constructor(buildings: readonly Building[]) {
    const lives = buildings.map(rooftopLifeFor);

    const lit = bakeRooftopLights(lives);
    const lightGeometry = new THREE.BufferGeometry();
    lightGeometry.setAttribute(
      "position",
      new THREE.BufferAttribute(lit.positions, 3),
    );
    lightGeometry.setAttribute(
      "color",
      new THREE.BufferAttribute(lit.colors, 3),
    );
    lightGeometry.setAttribute(
      "aSize",
      new THREE.BufferAttribute(lit.sizes, 1),
    );
    lightGeometry.setAttribute(
      "aLight",
      new THREE.BufferAttribute(lit.modes, 2),
    );
    const lightMaterial = new THREE.PointsMaterial({
      size: 1, // per-point meters via aSize
      sizeAttenuation: true,
      map: glowTexture(),
      vertexColors: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      // Additive + fog brightens the distant scene (the V1 lesson).
      fog: false,
    });
    lightMaterial.customProgramCacheKey = () => ROOFTOP_LIGHTS_CACHE_KEY;
    lightMaterial.onBeforeCompile = (shader) => {
      shader.uniforms.uLoop = this.loop;
      shader.vertexShader = shader.vertexShader
        .replace(
          "uniform float size;",
          `uniform float size;\n${LIGHTS_VERTEX_PARS}`,
        )
        .replace(
          "#include <begin_vertex>",
          `#include <begin_vertex>\n${LIGHTS_VERTEX_MAIN}`,
        )
        .replace("gl_PointSize = size;", "gl_PointSize = size * aSize;")
        .replace(
          "#include <logdepthbuf_vertex>",
          `gl_PointSize = max(gl_PointSize, ${glsl(LIGHT_MIN_PX)});\n#include <logdepthbuf_vertex>`,
        );
    };
    this.lights = new THREE.Points(lightGeometry, lightMaterial);
    // Positions are canonical; the shader moves them next to the camera.
    this.lights.frustumCulled = false;

    const baked = bakeRooftopProps(lives);
    const propGeometry = new THREE.BufferGeometry();
    propGeometry.setAttribute(
      "position",
      new THREE.BufferAttribute(baked.positions, 3),
    );
    propGeometry.setAttribute(
      "normal",
      new THREE.BufferAttribute(baked.normals, 3),
    );
    propGeometry.setAttribute(
      "color",
      new THREE.BufferAttribute(baked.colors, 3),
    );
    propGeometry.setAttribute(
      "aPivot",
      new THREE.BufferAttribute(baked.pivots, 4),
    );
    propGeometry.setAttribute(
      "aAnim",
      new THREE.BufferAttribute(baked.anims, 4),
    );
    const propMaterial = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.9,
      metalness: 0.05,
    });
    propMaterial.customProgramCacheKey = () => ROOFTOP_PROPS_CACHE_KEY;
    propMaterial.onBeforeCompile = (shader) => {
      shader.uniforms.uLoop = this.loop;
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", `#include <common>\n${PROPS_VERTEX_PARS}`)
        .replace(
          "#include <beginnormal_vertex>",
          `#include <beginnormal_vertex>\n${PROPS_BEGIN_NORMAL}`,
        )
        .replace(
          "#include <begin_vertex>",
          `#include <begin_vertex>\n${PROPS_BEGIN_VERTEX}`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <common>",
          `#include <common>\n${PROPS_FRAGMENT_PARS}`,
        )
        .replace(
          "#include <emissivemap_fragment>",
          `#include <emissivemap_fragment>\n${PROPS_FRAGMENT_EMISSIVE}`,
        );
    };
    // The mesh stays at the origin (identity model matrix): positions leave
    // the vertex shader already in world space, at the camera's torus image,
    // so lighting and fog read the wrapped position.
    this.props = new THREE.Mesh(propGeometry, propMaterial);
    this.props.frustumCulled = false;

    this.group.add(this.props, this.lights);

    this.counts = {
      parties: lives.filter((l) => l.party).length,
      bulbs: lives.reduce((n, l) => n + (l.party?.bulbs.length ?? 0), 0),
      dancers: lives.reduce((n, l) => n + (l.party?.dancers.length ?? 0), 0),
      pools: lives.filter((l) => l.pool).length,
      fans: lives.reduce((n, l) => n + l.fans.length, 0),
      flags: lives.reduce((n, l) => n + l.flags.length, 0),
      aviation: lives.reduce((n, l) => n + l.aviation.length, 0),
      lights: lit.count,
      propVertices: baked.vertexCount,
    };
  }

  /** `timeMs` is synced server time, so every client animates in phase. */
  update(timeMs: number): void {
    this.loop.value = loopPhase(timeMs);
  }

  /** O3: Low drops the string-light sprites; pools, fans and flags stay. */
  setQuality(tier: QualityTier): void {
    this.lights.visible = QUALITY_PROFILES[tier].rooftopLights;
  }
}
