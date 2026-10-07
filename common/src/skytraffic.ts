// Sky traffic scenery (L10): airliners crossing far overhead and the drone
// light show. Pure schedules of (seed, synced server clock), in the
// fireworks/storm idiom — every client computes the same airliner in the same
// part of the sky and the same drone show over the same plaza at the same
// instant, with nothing on the wire and no Math.random.
//
// Both are LIGHT, not geometry: the airliners live on the sky dome (out of
// the flight band entirely) and the drones are points of light, the
// searchlight exception — so neither is a collision concern. The news
// helicopter, which IS solid, lives in city/newsheli.ts.

import { PLAZA_BLOCKS, mulberry32 } from "./city/index";
import { BLOCK_PITCH } from "./constants";

// --- Airliners ---------------------------------------------------------------

/** One airliner slot per this much time; most slots fly one, ms. */
export const AIRLINER_SLOT_MS = 40000;
/** Fraction of slots that carry a flight. */
const AIRLINER_CHANCE = 0.75;
/** Flight altitude band above the viewer, m — far above MAX_ALTITUDE (800). */
export const AIRLINER_ALT_MIN = 1000;
export const AIRLINER_ALT_MAX = 1600;
/** Cruise speed band, m/s, and the half-length of the straight track, m —
 * long enough that both ends sit within a few degrees of the horizon. */
const AIRLINER_SPEED_MIN = 210;
const AIRLINER_SPEED_MAX = 250;
export const AIRLINER_HALF_TRACK = 9000;
/** Closest horizontal approach to the viewer band, m (signed). */
const AIRLINER_OFFSET_MAX = 3500;
/** Longest a flight can last, ms — how far back airlinersAt must look. */
const AIRLINER_MAX_MS = ((2 * AIRLINER_HALF_TRACK) / AIRLINER_SPEED_MIN) * 1000;

/**
 * One crossing. The track is a straight line in a plane `alt` metres above
 * the VIEWER (the sky-dome idiom: direction-only, like the moon), so every
 * client sees the airliner in the same direction at the same time.
 */
export interface Airliner {
  /** Slot number — a stable id. */
  id: number;
  /** Server time the flight enters at one horizon, ms, and its duration, ms. */
  startMs: number;
  durMs: number;
  /** Track heading in XZ, rad, and closest horizontal pass, m (signed). */
  heading: number;
  offset: number;
  alt: number;
  speed: number;
  /** Phase into the strobe cycle, 0..1. */
  strobe: number;
}

/** Per-slot stream, salted apart from storm/fireworks/movers streams. */
const slotRand = (seed: number, n: number, salt: number): (() => number) =>
  mulberry32((seed ^ salt ^ Math.imul(n, 0x9e3779b9)) >>> 0);

function airlinerOf(seed: number, n: number): Airliner | null {
  const rand = slotRand(seed, n, 0x41495252);
  if (rand() >= AIRLINER_CHANCE) return null;
  const speed =
    AIRLINER_SPEED_MIN + rand() * (AIRLINER_SPEED_MAX - AIRLINER_SPEED_MIN);
  return {
    id: n,
    startMs: n * AIRLINER_SLOT_MS + rand() * AIRLINER_SLOT_MS,
    durMs: ((2 * AIRLINER_HALF_TRACK) / speed) * 1000,
    heading: rand() * Math.PI * 2,
    offset: (rand() * 2 - 1) * AIRLINER_OFFSET_MAX,
    alt: AIRLINER_ALT_MIN + rand() * (AIRLINER_ALT_MAX - AIRLINER_ALT_MIN),
    speed,
    strobe: rand(),
  };
}

/** Every airliner in the sky at server time `timeMs`, oldest first. */
export function airlinersAt(seed: number, timeMs: number): Airliner[] {
  const out: Airliner[] = [];
  const last = Math.floor(timeMs / AIRLINER_SLOT_MS);
  const first = last - Math.ceil(AIRLINER_MAX_MS / AIRLINER_SLOT_MS) - 1;
  for (let n = first; n <= last; n++) {
    const a = airlinerOf(seed, n);
    if (a && timeMs >= a.startMs && timeMs < a.startMs + a.durMs) out.push(a);
  }
  return out;
}

/**
 * Where an airliner is relative to the viewer at `timeMs`, m (y is up).
 * Writes into `out`. Also returns the unit heading in `out` via hx/hz so the
 * renderer can lay the wing lights out without another trig call.
 */
export function airlinerOffsetInto(
  a: Airliner,
  timeMs: number,
  out: { x: number; y: number; z: number; hx: number; hz: number },
): typeof out {
  const u = -AIRLINER_HALF_TRACK + (a.speed * (timeMs - a.startMs)) / 1000;
  const hx = Math.cos(a.heading);
  const hz = Math.sin(a.heading);
  out.x = u * hx - a.offset * hz;
  out.y = a.alt;
  out.z = u * hz + a.offset * hx;
  out.hx = hx;
  out.hz = hz;
  return out;
}

// --- Drone light show --------------------------------------------------------

/** Drones in the show. */
export const DRONE_COUNT = 200;
/** One show per period, starting a seeded 0..jitter into it, ms: shows are
 * 6-10 min apart, ~8 min on average. */
export const DRONE_SHOW_PERIOD_MS = 480000;
const DRONE_SHOW_JITTER_MS = 120000;
/** Show length, ms. */
export const DRONE_SHOW_MS = 60000;
/** Formation centre altitude band, m. */
export const DRONE_ALT_MIN = 180;
export const DRONE_ALT_MAX = 260;

/** One scheduled show. `x`/`z` are a plaza centre (canonical). */
export interface DroneShow {
  startMs: number;
  x: number;
  y: number;
  z: number;
  /** Index into PLAZA_BLOCKS. */
  plaza: number;
  /** Formation yaw at start, rad (it turns slowly so every side sees it). */
  spin: number;
}

/** The show in period n — always scheduled; whether it is ON is time's job. */
export function droneShowOf(seed: number, n: number): DroneShow {
  const rand = slotRand(seed, n, 0x44524f4e);
  const startMs = n * DRONE_SHOW_PERIOD_MS + rand() * DRONE_SHOW_JITTER_MS;
  const plaza = Math.floor(rand() * PLAZA_BLOCKS.length) % PLAZA_BLOCKS.length;
  const [bx, bz] = PLAZA_BLOCKS[plaza] ?? [0, 0];
  return {
    startMs,
    x: (bx + 0.5) * BLOCK_PITCH,
    y: Math.round(DRONE_ALT_MIN + rand() * (DRONE_ALT_MAX - DRONE_ALT_MIN)),
    z: (bz + 0.5) * BLOCK_PITCH,
    plaza,
    spin: rand() * Math.PI * 2,
  };
}

/** The show playing at `timeMs`, or null between shows. */
export function droneShowAt(seed: number, timeMs: number): DroneShow | null {
  const show = droneShowOf(seed, Math.floor(timeMs / DRONE_SHOW_PERIOD_MS));
  const age = timeMs - show.startMs;
  return age >= 0 && age < DRONE_SHOW_MS ? show : null;
}

/** The formations, in show order. 0 = parked on the plaza floor. */
export const DRONE_SHAPES = [
  "ground",
  "globe",
  "ring",
  "heart",
  "star",
] as const;

/** Keyframes: [seconds into the show, formation index]. Between two keys
 * with different formations the drones morph; equal keys are a hold. */
const KEYS: readonly (readonly [number, number])[] = [
  [0, 0],
  [8, 1],
  [15, 1],
  [18, 2],
  [27, 2],
  [30, 3],
  [39, 3],
  [42, 4],
  [51, 4],
  [58, 0],
  [60, 0],
];

/** Which two formations the show is between at `ageMs`, and how far, 0..1
 * (eased). The renderer uses the same answer to blend the colours. */
export function droneKeyframe(ageMs: number): {
  from: number;
  to: number;
  k: number;
} {
  const s = Math.min(Math.max(ageMs / 1000, 0), DRONE_SHOW_MS / 1000);
  for (let i = 1; i < KEYS.length; i++) {
    const a = KEYS[i - 1];
    const b = KEYS[i];
    if (!a || !b || s > b[0]) continue;
    const lin = b[0] > a[0] ? (s - a[0]) / (b[0] - a[0]) : 1;
    return { from: a[1], to: b[1], k: lin * lin * (3 - 2 * lin) };
  }
  return { from: 0, to: 0, k: 1 };
}

const GOLDEN = 2.399963229728653;

/** Drone i's spot in formation `shape`, in the show's local frame (m, y up,
 * relative to the formation centre, before the spin). */
function shapePoint(
  shape: number,
  i: number,
  centreY: number,
  out: { x: number; y: number; z: number },
): void {
  const u = (i + 0.5) / DRONE_COUNT;
  const a = u * Math.PI * 2;
  switch (DRONE_SHAPES[shape]) {
    case "globe": {
      const phi = Math.acos(1 - 2 * u);
      const theta = i * GOLDEN;
      out.x = 38 * Math.sin(phi) * Math.cos(theta);
      out.y = 38 * Math.cos(phi);
      out.z = 38 * Math.sin(phi) * Math.sin(theta);
      return;
    }
    case "ring": {
      // Two rings: an outer one in the display plane and a tilted inner one.
      const inner = i % 4 === 0;
      const r = inner ? 26 : 48;
      out.x = r * Math.cos(a);
      out.y = r * Math.sin(a) * (inner ? 0.35 : 1);
      out.z = inner ? r * Math.sin(a) * 0.94 : 0;
      return;
    }
    case "heart": {
      const s = Math.sin(a);
      out.x = 3 * 16 * s * s * s;
      out.y =
        3 *
        (13 * Math.cos(a) -
          5 * Math.cos(2 * a) -
          2 * Math.cos(3 * a) -
          Math.cos(4 * a));
      out.z = 0;
      return;
    }
    case "star": {
      // Walk the outline of a five-point star at constant parameter speed.
      const seg = u * 10;
      const k = Math.floor(seg);
      const f = seg - k;
      const r0 = k % 2 === 0 ? 52 : 21;
      const r1 = k % 2 === 0 ? 21 : 52;
      const a0 = (k / 10) * Math.PI * 2 + Math.PI / 2;
      const a1 = ((k + 1) / 10) * Math.PI * 2 + Math.PI / 2;
      const x0 = r0 * Math.cos(a0);
      const y0 = r0 * Math.sin(a0);
      out.x = x0 + (r1 * Math.cos(a1) - x0) * f;
      out.y = y0 + (r1 * Math.sin(a1) - y0) * f;
      out.z = 0;
      return;
    }
    default: {
      // Parked in a grid on the plaza floor, 2 m up.
      const cols = 20;
      out.x = ((i % cols) - (cols - 1) / 2) * 6;
      out.y = 2 - centreY;
      out.z = (Math.floor(i / cols) - (DRONE_COUNT / cols - 1) / 2) * 6;
      return;
    }
  }
}

const pa = { x: 0, y: 0, z: 0 };
const pb = { x: 0, y: 0, z: 0 };

/**
 * Drone i's canonical-frame position at `timeMs`, written into `out`: the
 * plaza centre plus the morphing formation, spun slowly about +Y. Pure in
 * (show, i, time); allocation-free so the renderer can call it 200x a frame.
 */
export function dronePointInto(
  show: DroneShow,
  i: number,
  timeMs: number,
  out: { x: number; y: number; z: number },
): typeof out {
  const age = timeMs - show.startMs;
  const key = droneKeyframe(age);
  shapePoint(key.from, i, show.y, pa);
  shapePoint(key.to, i, show.y, pb);
  const lx = pa.x + (pb.x - pa.x) * key.k;
  const ly = pa.y + (pb.y - pa.y) * key.k;
  const lz = pa.z + (pb.z - pa.z) * key.k;
  const spin = show.spin + (age / 1000) * 0.12;
  const c = Math.cos(spin);
  const s = Math.sin(spin);
  out.x = show.x + c * lx + s * lz;
  out.y = show.y + ly;
  out.z = show.z - s * lx + c * lz;
  return out;
}
