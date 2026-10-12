// L4 Stormlit: the landmark bridges and the waterfront, drawn — into the
// river's ONE structure mesh (river.ts), so none of this is a draw call.
//
// Every solid here comes from common/src/city/river.ts's LANDMARKS and
// pierBoxes() — the very boxes and capsules riverHit collides — so a pylon,
// a cable chord, a suspender or a truss brace is exactly where it kills. A
// capsule (radius r) is drawn as a square prism whose corners stay inside
// it; lamps sit inside their member's solid too.
//
// Light, on the S1 ladder: the cable necklaces, truss chord lamps, pier
// lamps and promenade rail lamps are LAMP; the pylon beacons BEACON; the
// floodlit stone and steel glow far under the bloom threshold (a lit face
// is not a light). D9: members inside a breakable span carry the span tag
// (Soup.span) and drop with it.
//
// The deck light streams (head- and taillight streaks flowing over the
// landmark decks) are tagged with Soup.stream: river.ts's structure vertex
// shader animates them along the deck, colours them by heading against the
// camera and collapses them near the camera, where traffic.ts's real cars
// read instead.

import {
  CABLE_R,
  GIRDER_X1,
  LANDMARKS,
  type LandmarkBox,
  type LandmarkStrut,
  PARAPET_HEIGHT,
  PIER_LAMP_HALF,
  PIER_LAMP_TOP,
  PYLON_SPIRE_TOP,
  PYLON_TIERS,
  RIVER_CENTER_Z,
  RIVER_HALF_WIDTH,
  pierBoxes,
} from "@angels-bandits/common/city/river";
import {
  BLOCK_PITCH,
  EMISSIVE_BEACON,
  EMISSIVE_LAMP,
} from "@angels-bandits/common/constants";
import * as THREE from "three";
import { emissiveBoost } from "./emissive";

type P3 = readonly [number, number, number];

/** What river.ts's Soup offers this module. */
export interface SoupLike {
  span: number;
  stream: [number, number, number];
  quad(
    a: P3,
    b: P3,
    c: P3,
    d: P3,
    color: THREE.Color,
    emit?: THREE.Color,
  ): void;
  box(
    x0: number,
    x1: number,
    y0: number,
    y1: number,
    z0: number,
    z1: number,
    color: THREE.Color,
    emit?: THREE.Color,
    top?: boolean,
    bottom?: boolean,
  ): void;
}

const COLORS = {
  granite: 0x6c6862,
  spire: 0x857f78,
  anchor: 0x5c5852,
  steel: 0x3a3d46,
  girder: 0x30323d,
  truss: 0x575c69,
  pier: 0x3b3c44,
  pierTop: 0x55555c,
  post: 0x22242b,
  flood: 0xffc590,
  lamp: 0xffe2b0,
  beacon: 0xff2418,
  black: 0x000000,
} as const;

/** Linear emissive RGB of `hex` at peak luminance `lum` (a ladder rung, or
 * a sub-threshold glow). */
function glow(hex: number, lum: number): THREE.Color {
  const c = new THREE.Color(hex);
  return c.multiplyScalar(emissiveBoost(c, lum));
}

const col = (hex: number) => new THREE.Color(hex);

/** Floodlit-stone glow per pylon tier (base, shaft, crown), and on the
 * spire, the anchorages, the steel — all far under the 0.72 threshold. */
const PYLON_FLOOD = [0.07, 0.045, 0.12] as const;
const SPIRE_FLOOD = 0.18;
const ANCHOR_FLOOD = 0.08;
const STEEL_GLOW = 0.05;
const TRUSS_GLOW = 0.07;
const PIER_GLOW = 0.05;

/** Lamp spacing along a cable, a truss chord, a pier edge and the
 * promenade railing, m. */
const CABLE_LAMP_STEP = 4;
/** The cable prism's and its lamp cubes' half sides, m: √2·0.4 and √3·0.45
 * are both under CABLE_R (0.8), so nothing drawn leaves the capsule. */
const CABLE_HALF = 0.4;
const CABLE_LAMP_HALF = 0.45;
if (CABLE_LAMP_HALF * Math.sqrt(3) > CABLE_R) {
  throw new Error("river-bridges: a cable lamp would poke out of its cable");
}
const CHORD_LAMP_STEP = 5;
const PIER_LAMP_STEP = 3;
export const RAIL_LAMP_STEP = 12.5;

/** A square prism from a to b, half side `h` (its corners √2·h off the
 * axis — keep that inside the capsule it draws). */
function prism(
  s: SoupLike,
  a: P3,
  b: P3,
  h: number,
  color: THREE.Color,
  emit?: THREE.Color,
): void {
  const t = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  t.normalize();
  const up =
    Math.abs(t.y) < 0.9
      ? new THREE.Vector3(0, 1, 0)
      : new THREE.Vector3(1, 0, 0);
  const u = new THREE.Vector3()
    .crossVectors(t, up)
    .normalize()
    .multiplyScalar(h);
  const v = new THREE.Vector3()
    .crossVectors(t, u)
    .normalize()
    .multiplyScalar(h);
  const corner = (p: P3, su: number, sv: number): P3 => [
    p[0] + u.x * su + v.x * sv,
    p[1] + u.y * su + v.y * sv,
    p[2] + u.z * su + v.z * sv,
  ];
  const ring = [
    [1, 1],
    [-1, 1],
    [-1, -1],
    [1, -1],
  ] as const;
  for (let i = 0; i < 4; i++) {
    const [su0, sv0] = ring[i] as readonly [number, number];
    const [su1, sv1] = ring[(i + 1) % 4] as readonly [number, number];
    s.quad(
      corner(a, su0, sv0),
      corner(a, su1, sv1),
      corner(b, su1, sv1),
      corner(b, su0, sv0),
      color,
      emit,
    );
  }
  for (const p of [a, b]) {
    s.quad(
      corner(p, 1, 1),
      corner(p, -1, 1),
      corner(p, -1, -1),
      corner(p, 1, -1),
      color,
      emit,
    );
  }
}

/** A landmark box, in world (structure-local) coordinates. */
function partBox(
  s: SoupLike,
  ox: number,
  b: LandmarkBox,
  color: THREE.Color,
  emit?: THREE.Color,
): void {
  s.box(
    ox + b.x - b.hx,
    ox + b.x + b.hx,
    b.y0,
    b.y1,
    RIVER_CENTER_Z + b.z - b.hz,
    RIVER_CENTER_Z + b.z + b.hz,
    color,
    emit,
  );
}

const strutEnds = (ox: number, q: LandmarkStrut): [P3, P3] => [
  [ox + q.ax, q.ay, RIVER_CENTER_Z + q.az],
  [ox + q.bx, q.by, RIVER_CENTER_Z + q.bz],
];

/** Lamp centres every `step` m along a → b (both ends excluded). */
function along(a: P3, b: P3, step: number): P3[] {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const n = Math.max(1, Math.round(len / step));
  const out: P3[] = [];
  for (let i = 1; i < n; i++) {
    const t = i / n;
    out.push([
      a[0] + (b[0] - a[0]) * t,
      a[1] + (b[1] - a[1]) * t,
      a[2] + (b[2] - a[2]) * t,
    ]);
  }
  return out;
}

/** A small lamp cube of half side `h` at `p`. */
function lamp(s: SoupLike, p: P3, h: number, emit: THREE.Color): void {
  s.box(
    p[0] - h,
    p[0] + h,
    p[1] - h,
    p[1] + h,
    p[2] - h,
    p[2] + h,
    col(COLORS.lamp),
    emit,
  );
}

/** Head/taillight streams per landmark deck: lane x offsets (m off the
 * street line) and the direction each flows (+1 toward +z). Right-hand
 * traffic, two streams per carriageway. */
const STREAM_LANES: readonly [number, 1 | -1][] = [
  [-8, -1],
  [-4, -1],
  [4, 1],
  [8, 1],
];
/** Streaks per stream lane, their length, and the lane speeds, m/s. Every
 * speed × the shader's 1000 s clock wrap is a whole number of 120 m laps,
 * so the wrap never jumps a streak. */
const STREAKS_PER_LANE = 9;
const STREAK_LENGTH = 4.5;
const STREAM_SPEEDS = [12, 13.2, 14.4, 12] as const;
/** The stream loop's length (wall to wall), m — the shader's modulus. */
export const STREAM_LOOP = 2 * RIVER_HALF_WIDTH;
/** Stream streak height above the deck, m. */
const STREAK_Y = 0.8;

/**
 * Every landmark bridge (its pylons, cables, suspenders, girders, truss and
 * anchorages, their lamps and floodlit faces, and the deck light streams)
 * for one world period at x offset `period`.
 */
export function emitLandmarks(s: SoupLike, period: number): void {
  const lampEmit = glow(COLORS.lamp, EMISSIVE_LAMP);
  const beaconEmit = glow(COLORS.beacon, EMISSIVE_BEACON);
  for (const lm of LANDMARKS) {
    const ox = period + lm.bridge * BLOCK_PITCH;
    const tag = (span: boolean) => {
      s.span = span ? lm.bridge + 1 : 0;
    };
    for (const b of lm.boxes) {
      tag(b.span);
      switch (b.role) {
        case "pylon":
        case "crown": {
          const tier = Math.max(
            0,
            (PYLON_TIERS as readonly number[]).indexOf(b.y1),
          );
          const flood = PYLON_FLOOD[tier] as number;
          partBox(s, ox, b, col(COLORS.granite), glow(COLORS.flood, flood));
          break;
        }
        case "spire": {
          partBox(s, ox, b, col(COLORS.spire), glow(COLORS.flood, SPIRE_FLOOD));
          // The aviation beacon just under the tip, a hair proud of it.
          const x = ox + b.x;
          const z = RIVER_CENTER_Z + b.z;
          const h = b.hx + 0.01;
          s.box(
            x - h,
            x + h,
            PYLON_SPIRE_TOP - 0.9,
            PYLON_SPIRE_TOP - 0.3,
            z - h,
            z + h,
            col(COLORS.beacon),
            beaconEmit,
          );
          break;
        }
        case "anchor":
          partBox(
            s,
            ox,
            b,
            col(COLORS.anchor),
            glow(COLORS.flood, ANCHOR_FLOOD),
          );
          break;
        case "girder":
          partBox(s, ox, b, col(COLORS.girder));
          break;
        case "suspender":
          partBox(s, ox, b, col(COLORS.steel));
          break;
        case "chord": {
          partBox(s, ox, b, col(COLORS.truss), glow(COLORS.flood, TRUSS_GLOW));
          // Lamps flush on the chord's outer face.
          const side = Math.sign(b.x);
          const x = ox + b.x + side * (b.hx + 0.01);
          const z0 = RIVER_CENTER_Z + b.z - b.hz;
          const z1 = RIVER_CENTER_Z + b.z + b.hz;
          const y = (b.y0 + b.y1) / 2;
          for (const p of along([x, y, z0], [x, y, z1], CHORD_LAMP_STEP)) {
            s.quad(
              [x, y - 0.25, p[2] - 0.25],
              [x, y - 0.25, p[2] + 0.25],
              [x, y + 0.25, p[2] + 0.25],
              [x, y + 0.25, p[2] - 0.25],
              col(COLORS.lamp),
              lampEmit,
            );
          }
          break;
        }
        case "brace": {
          partBox(s, ox, b, col(COLORS.truss), glow(COLORS.flood, TRUSS_GLOW));
          // A row of lamps flush under each brace, over the carriageway.
          const z = RIVER_CENTER_Z + b.z;
          const y = b.y0 - 0.01;
          for (let x = ox - 12; x <= ox + 12; x += 6) {
            s.quad(
              [x - 0.3, y, z - 0.3],
              [x + 0.3, y, z - 0.3],
              [x + 0.3, y, z + 0.3],
              [x - 0.3, y, z + 0.3],
              col(COLORS.lamp),
              lampEmit,
            );
          }
          break;
        }
        default:
          partBox(s, ox, b, col(COLORS.truss), glow(COLORS.flood, TRUSS_GLOW));
      }
    }
    for (const q of lm.struts) {
      tag(q.span);
      const [a, b] = strutEnds(ox, q);
      if (q.role === "cable") {
        // The cable's prism (corners √2·0.4 off the axis) and its lamps,
        // cubes just proud of it — every corner within CABLE_R of the axis.
        prism(
          s,
          a,
          b,
          CABLE_HALF,
          col(COLORS.steel),
          glow(COLORS.flood, STEEL_GLOW),
        );
        for (const p of along(a, b, CABLE_LAMP_STEP))
          lamp(s, p, CABLE_LAMP_HALF, lampEmit);
      } else {
        prism(
          s,
          a,
          b,
          q.r / Math.SQRT2,
          col(COLORS.truss),
          glow(COLORS.flood, TRUSS_GLOW),
        );
      }
    }
    s.span = 0;
    emitStreams(s, ox, lm.bridge);
  }
}

/** The deck streams of the landmark at x `ox`: horizontal + vertical
 * crossed quads, black (the shader lights them), tagged for the shader. */
function emitStreams(s: SoupLike, ox: number, bridge: number): void {
  const black = col(COLORS.black);
  STREAM_LANES.forEach(([lx, dir], lane) => {
    const speed = (STREAM_SPEEDS[lane] as number) * dir;
    for (let i = 0; i < STREAKS_PER_LANE; i++) {
      // Platoon-ish spacing: a seeded jitter on an even spread.
      const jitter = Math.sin((bridge * 7 + lane * 3 + i) * 12.9898) * 3;
      const phase =
        (((i + 0.5) / STREAKS_PER_LANE) * STREAM_LOOP + jitter + STREAM_LOOP) %
        STREAM_LOOP;
      s.stream = [phase, speed, bridge + 1];
      const x = ox + lx;
      const z0 = RIVER_CENTER_Z - STREAK_LENGTH / 2;
      const z1 = RIVER_CENTER_Z + STREAK_LENGTH / 2;
      const y = STREAK_Y;
      s.quad(
        [x - 0.3, y, z0],
        [x + 0.3, y, z0],
        [x + 0.3, y, z1],
        [x - 0.3, y, z1],
        black,
      );
      s.quad(
        [x, y - 0.3, z0],
        [x, y + 0.3, z0],
        [x, y + 0.3, z1],
        [x, y - 0.3, z1],
        black,
      );
    }
  });
  s.stream = [0, 0, 0];
}

/**
 * The piers (stone jetties with bollard lights along their edges and lamp
 * posts at their heads) for one period, from pierBoxes() — the boxes
 * riverHit collides.
 */
export function emitPiers(s: SoupLike, period: number): void {
  const lampEmit = glow(COLORS.lamp, EMISSIVE_LAMP);
  for (const b of pierBoxes()) {
    const x0 = period + b.x - b.hx;
    const x1 = period + b.x + b.hx;
    const z0 = b.z - b.hz;
    const z1 = b.z + b.hz;
    if (b.hx === PIER_LAMP_HALF) {
      // A lamp post, its top 0.4 m the lamp.
      s.box(x0, x1, b.y0, PIER_LAMP_TOP - 0.4, z0, z1, col(COLORS.post));
      s.box(
        x0,
        x1,
        PIER_LAMP_TOP - 0.4,
        b.y1,
        z0,
        z1,
        col(COLORS.lamp),
        lampEmit,
      );
      continue;
    }
    // The jetty: rough stone sides, a paved, faintly lamp-lit top.
    s.box(
      x0,
      x1,
      b.y0,
      b.y1,
      z0,
      z1,
      col(COLORS.pier),
      undefined,
      false,
      false,
    );
    s.quad(
      [x0, b.y1, z0],
      [x1, b.y1, z0],
      [x1, b.y1, z1],
      [x0, b.y1, z1],
      col(COLORS.pierTop),
      glow(COLORS.flood, PIER_GLOW),
    );
    // Bollard lights flush in the top along both long edges.
    for (const x of [x0 + 0.4, x1 - 0.4]) {
      for (let z = z0 + 1.5; z < z1 - 0.5; z += PIER_LAMP_STEP) {
        s.quad(
          [x - 0.15, b.y1 + 0.01, z - 0.15],
          [x + 0.15, b.y1 + 0.01, z - 0.15],
          [x + 0.15, b.y1 + 0.01, z + 0.15],
          [x - 0.15, b.y1 + 0.01, z + 0.15],
          col(COLORS.lamp),
          lampEmit,
        );
      }
    }
  }
}

/** Is a promenade rail lamp at canonical x (on either bank) clear of the
 * bridges, the piers' landings and the landmark anchorages? */
export function railLampAt(x: number): boolean {
  const off = x - Math.round(x / BLOCK_PITCH) * BLOCK_PITCH;
  return Math.abs(off) > GIRDER_X1 + 4;
}

/** Rail lamps flush in the railing's top (y = PARAPET_HEIGHT), one bank. */
export function emitRailLamps(
  s: SoupLike,
  span: number,
  z0: number,
  z1: number,
): void {
  const lampEmit = glow(COLORS.lamp, EMISSIVE_LAMP);
  const zc = (z0 + z1) / 2;
  const y = PARAPET_HEIGHT + 0.005;
  for (let x = RAIL_LAMP_STEP / 2; x < span; x += RAIL_LAMP_STEP) {
    if (!railLampAt(x)) continue;
    s.quad(
      [x - 0.25, y, zc - 0.18],
      [x + 0.25, y, zc - 0.18],
      [x + 0.25, y, zc + 0.18],
      [x - 0.25, y, zc + 0.18],
      col(COLORS.lamp),
      lampEmit,
    );
  }
}
