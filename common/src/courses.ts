// S3 stunt ring courses — shared verbatim by client and server, like the
// city itself: both sides call generateCourses(seed, …) on the same city and
// get the same rings, so no ring ever crosses the wire. Only results,
// leaderboards and the record ghost do (protocol.ts).
//
// A COURSE is an ordered list of rings (centre, unit normal, radius). Fly
// forward through the start ring and the clock runs; every later ring you
// skip costs COURSE_MISS_PENALTY_MS; the finish ring stops the clock. Rings
// are light, not geometry: nothing here is solid, nothing collides.
//
// GENERATION. Six themes, each a seeded search over candidate placements
// (salted mulberry32 streams, fixed attempt caps — never a time budget, which
// would make the result depend on the machine):
//   - Bridge Run: down into the L11 channel, under five bridges, slaloming
//     between them, and back out.
//   - Canyon Run: a low weave down a street canyon, six blocks long.
//   - Landmark Spiral: a descending spiral round a landmark supertall.
//   - Viaduct Run: low over a T2 line's longest straight, the trains passing
//     underneath (every ring clears the car roofs).
//   - Sky Needles / Hole Threader: H1/H2 holes chained together — the sky
//     holes and gates up high, the tunnels and arches down low — joined by
//     straight legs or a two-ring dog-leg.
// Every candidate is checked on its REFERENCE PATH — straight legs joined by
// fillet arcs of COURSE_REF_RADIUS, the turn a plane at ~60 m/s flies — by a
// COURSE_PROBE_RADIUS sphere every COURSE_PROBE_STEP metres against the
// ground and river, every building's solids (so hole lintels and walls too),
// the solid trees, the static viaducts and every crane's sweep. Each ring
// also gets a turn check: the fillet must pass inside the ring, and two
// fillets may never overlap. A course that fails anywhere is not offered.
//
// TORUS. Candidates are built as an UNWRAPPED chain — each point the one
// before it plus a wrapDelta — so the fillet maths is plain geometry; every
// ring is canonicalized on the way out, and every pass test goes through
// wrapDeltaAxis.

import { type HoleSpan, cityHoles } from "./city/holes";
import type { Building } from "./city/index";
import { LANDMARK_BLOCKS } from "./city/layout";
import type { MoverField } from "./city/movers";
import { BRIDGE_CLEARANCE, RIVER_CENTER_Z, RIVER_WATER_Y } from "./city/river";
import { mulberry32 } from "./city/rng";
import { collideTrains } from "./city/train";
import {
  type CityIndex,
  type NatureIndex,
  collideCity,
  collideNature,
  hitsGround,
} from "./collision";
import {
  BLOCK_PITCH,
  BOOST_MAX_SPEED,
  MUSH_SINK,
  SPEED_TOLERANCE,
  TRAIN_TOP,
  WORLD_SIZE,
} from "./constants";
import { pitchRadius, turnRadius } from "./flight";
import { POS_SCALE } from "./net";
import type { GhostPath, Medal } from "./protocol";
import {
  type Vec3,
  canonicalize,
  wrapCoord,
  wrapDelta,
  wrapDeltaAxis,
  wrapDistance,
} from "./world/index";

// --- Tunables -----------------------------------------------------------------

/** Each ring skipped adds this to the run's time, ms. */
export const COURSE_MISS_PENALTY_MS = 5000;
/** A run with no ring passed for this long is abandoned, ms. */
export const COURSE_IDLE_MS = 25_000;
/** A run still going after this long is abandoned, ms (also bounds a ghost). */
export const COURSE_MAX_MS = 150_000;
/** Leaderboard rows kept per course. */
export const COURSE_BOARD_SIZE = 5;
/** At most / at least this many courses per city (fewer only when the city
 * offers fewer valid placements). */
export const COURSES_MAX = 6;
export const COURSES_MIN = 4;
/** The reference turn: between the full-deflection turn and pull-up radii
 * at 60 m/s — a pilot who slows down turns tighter than this. */
export const COURSE_REF_RADIUS = (turnRadius(60) + pitchRadius(60)) / 2;
/** Probe sphere and spacing for the reference-path sweep, m. */
export const COURSE_PROBE_RADIUS = 5;
export const COURSE_PROBE_STEP = 3;
/** Ghost sample rate, Hz. */
export const GHOST_HZ = 10;
const GHOST_DT = 1000 / GHOST_HZ;
/** Most ghost samples a run can produce (COURSE_MAX_MS at GHOST_HZ, plus
 * the start and the off-grid finish). */
export const GHOST_MAX_SAMPLES = Math.ceil(COURSE_MAX_MS / GHOST_DT) + 2;
/** Medal cut-offs as an average speed over the reference path, m/s. Gold
 * needs boost on the straights; bronze is a clean, unhurried run. */
const MEDAL_SPEEDS: Readonly<Record<Medal, number>> = {
  gold: 80,
  silver: 66,
  bronze: 54,
};
/** The fastest the pose validator lets a plane cover ground, m/s — the
 * physical floor for a run's time (validate.ts's own bound). */
export const COURSE_MAX_GROUND_SPEED =
  BOOST_MAX_SPEED * SPEED_TOLERANCE + MUSH_SINK;

/** The fillet must pass inside this share of a ring's radius. */
const RING_INNER_SHARE = 0.7;
/** Deflection beyond this is never a ring turn, rad. */
const MAX_DEFLECTION = (100 * Math.PI) / 180;
/** Crane sweep: the jib reach plus this, and up to hub + this, m. */
const CRANE_MARGIN = 10;
/** No probe above this, m — keeps every course well under the storm. */
const COURSE_CEILING = 400;
/** A pass test ignores a "segment" longer than this (a teleport), m. */
const MAX_PASS_SEGMENT = 250;

// --- Types --------------------------------------------------------------------

export interface Ring {
  /** Canonical centre. */
  pos: Vec3;
  /** Unit normal: the direction a plane flies through it. */
  n: Vec3;
  /** Radius, m. */
  r: number;
}

export type CourseTheme =
  | "bridge"
  | "canyon"
  | "spiral"
  | "viaduct"
  | "needles"
  | "holes";

export interface Course {
  /** Index in generateCourses()'s result — the wire id. */
  id: number;
  theme: CourseTheme;
  name: string;
  /** Start ring first, finish ring last. */
  rings: readonly Ring[];
  /** Reference path length (legs and fillets), m. */
  length: number;
  /** Sum of the straight-line distances ring to ring, m — the floor no run
   * can beat (the shortest way through every ring centre). */
  span: number;
  /** Medal cut-offs, ms (penalties included in the time compared). */
  medals: Readonly<Record<Medal, number>>;
}

/** What generation probes against: the same solids a crash tests. */
export interface CourseWorld {
  buildings: readonly Building[];
  /** Optional speed-up; the same answers without it. */
  index?: CityIndex;
  nature?: NatureIndex;
  /** Only the STATIC parts are read — crane sites and the viaducts. Never
   * aircraft or a room's news heli, so every room hashes the same. */
  movers?: Pick<MoverField, "cranes" | "trains">;
}

/** One waypoint of a candidate, in the unwrapped chain frame. */
interface Way {
  p: Vec3;
  r: number;
}

// --- Generation -----------------------------------------------------------------

const way = (x: number, y: number, z: number, r: number): Way => ({
  p: { x, y, z },
  r,
});

/** Shuffle in place with `rng` (Fisher–Yates). */
function shuffle<T>(items: T[], rng: () => number): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = items[i] as T;
    items[i] = items[j] as T;
    items[j] = t;
  }
  return items;
}

const len3 = (x: number, y: number, z: number) => Math.hypot(x, y, z);

/** Unit vector from a to b (chain frame — plain geometry, already unwrapped). */
function dir(a: Vec3, b: Vec3): Vec3 {
  const x = b.x - a.x;
  const y = b.y - a.y;
  const z = b.z - a.z;
  const l = len3(x, y, z) || 1;
  return { x: x / l, y: y / l, z: z / l };
}

const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;

/** Deflection at interior vertex i, rad. */
function deflection(ways: readonly Way[], i: number): number {
  const a = ways[i - 1]?.p;
  const v = ways[i]?.p;
  const b = ways[i + 1]?.p;
  if (!a || !v || !b) return 0;
  return Math.acos(Math.min(1, Math.max(-1, dot(dir(a, v), dir(v, b)))));
}

/** Fillet tangent length at vertex i (0 at the ends). */
function tangentLength(ways: readonly Way[], i: number): number {
  if (i <= 0 || i >= ways.length - 1) return 0;
  return COURSE_REF_RADIUS * Math.tan(deflection(ways, i) / 2);
}

/** Does vertex i's turn fit: inside its ring, and clear of its neighbours? */
function turnFits(ways: readonly Way[], i: number): boolean {
  const theta = deflection(ways, i);
  if (theta > MAX_DEFLECTION) return false;
  const w = ways[i] as Way;
  const inner = COURSE_REF_RADIUS * (1 / Math.cos(theta / 2) - 1);
  if (inner > w.r * RING_INNER_SHARE) return false;
  const t = tangentLength(ways, i);
  const a = (ways[i - 1] as Way).p;
  const b = (ways[i + 1] as Way).p;
  const legIn = len3(w.p.x - a.x, w.p.y - a.y, w.p.z - a.z);
  const legOut = len3(b.x - w.p.x, b.y - w.p.y, b.z - w.p.z);
  return t <= legIn / 2 && t <= legOut / 2;
}

/** Probe scratch (generation runs once per process; this is tidiness). */
const probe: Vec3 = { x: 0, y: 0, z: 0 };

/** Is a sphere of `radius` at chain point (x, y, z) clear of every solid? */
function clearAt(
  world: CourseWorld,
  x: number,
  y: number,
  z: number,
  radius: number,
): boolean {
  if (y > COURSE_CEILING) return false;
  probe.x = wrapCoord(x);
  probe.y = y;
  probe.z = wrapCoord(z);
  if (hitsGround(probe, radius)) return false;
  if (collideCity(probe, radius, world.buildings, world.index) !== null) {
    return false;
  }
  if (world.nature && collideNature(probe, radius, world.nature) !== null) {
    return false;
  }
  const movers = world.movers;
  if (!movers) return true;
  if (movers.trains && collideTrains(movers.trains, probe, radius, null)) {
    return false;
  }
  for (const crane of movers.cranes) {
    const reach = crane.jibLength + CRANE_MARGIN + radius;
    const dx = wrapDeltaAxis(crane.x, probe.x);
    const dz = wrapDeltaAxis(crane.z, probe.z);
    if (dx * dx + dz * dz < reach * reach && y < crane.hubY + CRANE_MARGIN) {
      return false;
    }
  }
  return true;
}

/**
 * Check a candidate from waypoint `from` on: the turns at vertices ≥ from,
 * every ring's own disc (a sphere of its radius at its centre) and the
 * reference path from leg from − 1 on — straight parts and fillet arcs —
 * sampled every COURSE_PROBE_STEP. Checking from > 0 re-tests only what a
 * newly appended tail can have changed.
 */
function pathClear(
  world: CourseWorld,
  ways: readonly Way[],
  from = 0,
): boolean {
  const n = ways.length;
  if (n < 2) return false;
  for (let i = Math.max(1, from - 1); i < n - 1; i++) {
    if (!turnFits(ways, i)) return false;
  }
  for (let i = Math.max(0, from); i < n; i++) {
    const w = ways[i] as Way;
    if (!clearAt(world, w.p.x, w.p.y, w.p.z, w.r)) return false;
  }
  const R = COURSE_REF_RADIUS;
  const step = COURSE_PROBE_STEP;
  const rad = COURSE_PROBE_RADIUS;
  for (let j = Math.max(0, from - 2); j < n - 1; j++) {
    const a = (ways[j] as Way).p;
    const b = (ways[j + 1] as Way).p;
    const u = dir(a, b);
    const legLen = len3(b.x - a.x, b.y - a.y, b.z - a.z);
    const t0 = tangentLength(ways, j);
    const t1 = tangentLength(ways, j + 1);
    const straight = legLen - t0 - t1;
    const count = Math.max(1, Math.ceil(straight / step));
    for (let k = 0; k <= count; k++) {
      const s = t0 + (straight * k) / count;
      if (!clearAt(world, a.x + u.x * s, a.y + u.y * s, a.z + u.z * s, rad)) {
        return false;
      }
    }
    // The fillet arc round vertex j + 1 (none at the finish).
    if (j + 1 >= n - 1) continue;
    const theta = deflection(ways, j + 1);
    if (theta < 1e-4) continue;
    const v = b;
    const c = (ways[j + 2] as Way).p;
    const uOut = dir(v, c);
    // Inner bisector, centre, and the two tangent points relative to it.
    const wx = uOut.x - u.x;
    const wy = uOut.y - u.y;
    const wz = uOut.z - u.z;
    const wl = len3(wx, wy, wz) || 1;
    const k = R / Math.cos(theta / 2);
    const cx = v.x + (wx / wl) * k;
    const cy = v.y + (wy / wl) * k;
    const cz = v.z + (wz / wl) * k;
    const ax = v.x - u.x * t1 - cx;
    const ay = v.y - u.y * t1 - cy;
    const az = v.z - u.z * t1 - cz;
    const bx = v.x + uOut.x * t1 - cx;
    const by = v.y + uOut.y * t1 - cy;
    const bz = v.z + uOut.z * t1 - cz;
    const arcSteps = Math.max(1, Math.ceil((R * theta) / step));
    const sinT = Math.sin(theta);
    for (let m = 1; m < arcSteps; m++) {
      const f = m / arcSteps;
      const p = Math.sin((1 - f) * theta) / sinT;
      const q = Math.sin(f * theta) / sinT;
      if (
        !clearAt(
          world,
          cx + p * ax + q * bx,
          cy + p * ay + q * by,
          cz + p * az + q * bz,
          rad,
        )
      ) {
        return false;
      }
    }
  }
  return true;
}

/** Reference path length: legs, with each corner's two tangents swapped for
 * its arc. */
function pathLength(ways: readonly Way[]): number {
  let total = 0;
  for (let j = 0; j < ways.length - 1; j++) {
    const a = (ways[j] as Way).p;
    const b = (ways[j + 1] as Way).p;
    total += len3(b.x - a.x, b.y - a.y, b.z - a.z);
  }
  for (let i = 1; i < ways.length - 1; i++) {
    total +=
      COURSE_REF_RADIUS * deflection(ways, i) - 2 * tangentLength(ways, i);
  }
  return total;
}

/** Bridge Run: the L11 channel, under BRIDGES consecutive bridges. */
function bridgeRun(rng: () => number, world: CourseWorld): Way[] | null {
  const BRIDGES = 5;
  const yUnder = RIVER_WATER_Y + BRIDGE_CLEARANCE / 2;
  const rUnder = Math.min(8, BRIDGE_CLEARANCE / 2 - 1.5);
  const zc = RIVER_CENTER_Z;
  const lines = WORLD_SIZE / BLOCK_PITCH;
  const cands: { i: number; d: 1 | -1; side: 1 | -1 }[] = [];
  for (let i = 0; i < lines; i++) {
    for (const d of [1, -1] as const) {
      for (const side of [1, -1] as const) cands.push({ i, d, side });
    }
  }
  for (const { i, d, side } of shuffle(cands, rng).slice(0, 12)) {
    const x0 = i * BLOCK_PITCH;
    // Drop in from over the open channel, level out well before the first
    // deck (its underside is only BRIDGE_CLEARANCE above the water).
    const ways: Way[] = [
      way(x0 - d * 150, 14, zc, 12),
      way(x0 - d * 75, -10, zc, 10),
    ];
    for (let k = 0; k < BRIDGES; k++) {
      ways.push(way(x0 + d * k * BLOCK_PITCH, yUnder, zc, rUnder));
      if (k < BRIDGES - 1) {
        const lateral = (k % 2 === 0 ? 1 : -1) * side * 24;
        ways.push(way(x0 + d * (k * BLOCK_PITCH + 100), -6, zc + lateral, 10));
      }
    }
    const xLast = x0 + d * (BRIDGES - 1) * BLOCK_PITCH;
    ways.push(way(xLast + d * 75, -10, zc, 10));
    ways.push(way(xLast + d * 150, 14, zc, 12));
    if (pathClear(world, ways)) return ways;
  }
  return null;
}

/** Canyon Run: a low weave down one street canyon, six blocks. */
function canyonRun(rng: () => number, world: CourseWorld): Way[] | null {
  const RINGS = 13;
  const lines = WORLD_SIZE / BLOCK_PITCH;
  const cands: { axis: 0 | 1; line: number; start: number; d: 1 | -1 }[] = [];
  for (const axis of [0, 1] as const) {
    for (let line = 0; line < lines; line++) {
      for (let start = 0; start < lines; start++) {
        for (const d of [1, -1] as const) cands.push({ axis, line, start, d });
      }
    }
  }
  for (const { axis, line, start, d } of shuffle(cands, rng).slice(0, 80)) {
    const c = line * BLOCK_PITCH;
    const a0 = start * BLOCK_PITCH + BLOCK_PITCH / 2;
    const ways: Way[] = [];
    for (let k = 0; k < RINGS; k++) {
      const end = k === 0 || k === RINGS - 1;
      const along = a0 + d * k * 100;
      const lateral = end ? 0 : (k % 2 === 0 ? -6 : 6) * d;
      const y = end ? 28 : k % 2 === 0 ? 24 : 34;
      ways.push(
        axis === 0
          ? way(along, y, c + lateral, 9)
          : way(c + lateral, y, along, 9),
      );
    }
    if (pathClear(world, ways)) return ways;
  }
  return null;
}

/** Landmark Spiral: 1.5 descending laps round a landmark supertall. */
function landmarkSpiral(rng: () => number, world: CourseWorld): Way[] | null {
  const RINGS = 12;
  const RADIUS = 88;
  const TOP = 196;
  const BOTTOM = 86;
  const cands: { b: readonly [number, number]; d: 1 | -1; a0: number }[] = [];
  for (const b of LANDMARK_BLOCKS) {
    for (const d of [1, -1] as const) {
      for (let a = 0; a < 8; a++) cands.push({ b, d, a0: (a * Math.PI) / 4 });
    }
  }
  for (const { b, d, a0 } of shuffle(cands, rng).slice(0, 24)) {
    const cx = b[0] * BLOCK_PITCH + BLOCK_PITCH / 2;
    const cz = b[1] * BLOCK_PITCH + BLOCK_PITCH / 2;
    const ways: Way[] = [];
    for (let k = 0; k < RINGS; k++) {
      const a = a0 + (d * k * Math.PI) / 4;
      const y = TOP - ((TOP - BOTTOM) * k) / (RINGS - 1);
      ways.push(
        way(cx + RADIUS * Math.cos(a), y, cz + RADIUS * Math.sin(a), 12),
      );
    }
    if (pathClear(world, ways)) return ways;
  }
  return null;
}

/** Viaduct Run: low over a T2 line's straight, clear of the car roofs. */
function viaductRun(rng: () => number, world: CourseWorld): Way[] | null {
  const R = 8;
  const SPACING = 70;
  const END = 20;
  const yLow = TRAIN_TOP + 4 + R;
  const lines = [...(world.movers?.trains ?? [])];
  const cands: { ox: number; oz: number; seg: StraightSeg; rev: boolean }[] =
    [];
  for (const line of lines) {
    for (const seg of line.segments) {
      if (seg.kind !== "line" || seg.len - 2 * END < 280) continue;
      for (const rev of [false, true]) {
        cands.push({ ox: line.ox, oz: line.oz, seg, rev });
      }
    }
  }
  // Longest straights first, the draw breaking ties (stable sort).
  shuffle(cands, rng).sort((p, q) => q.seg.len - p.seg.len);
  for (const { ox, oz, seg, rev } of cands.slice(0, 8)) {
    const usable = seg.len - 2 * END;
    const count = Math.floor(usable / SPACING);
    const ways: Way[] = [];
    for (let k = 0; k <= count; k++) {
      const s = END + (usable * (rev ? count - k : k)) / count;
      ways.push(
        way(
          ox + seg.x0 + seg.ux * s,
          yLow + (k % 2 === 1 ? 5 : 0),
          oz + seg.z0 + seg.uz * s,
          R,
        ),
      );
    }
    if (pathClear(world, ways)) return ways;
  }
  return null;
}

/** The fields of a train line's straight segment this module reads. */
interface StraightSeg {
  kind: "line";
  len: number;
  x0: number;
  z0: number;
  ux: number;
  uz: number;
}

/** One directed hole pass as rings: approach, the hole, and the exit. */
interface HoleFeature {
  span: HoleSpan;
  /** Unit travel direction (horizontal). */
  ux: number;
  uz: number;
  /** Canonical approach, centre and exit points. */
  pts: [Vec3, Vec3, Vec3];
  rHole: number;
}

/** Approach/exit rings stand this far outside each mouth, m (well inside
 * HOLE_RUN_OUT's guaranteed clear air). */
const HOLE_APPROACH = 50;

function holeFeatures(spans: readonly HoleSpan[]): HoleFeature[] {
  const out: HoleFeature[] = [];
  for (const span of spans) {
    const x = span.hole.axis === "x";
    const rHole = Math.min(
      10,
      Math.min(span.hole.width, span.hole.height) / 2 - 1.5,
    );
    for (const d of [1, -1] as const) {
      const ux = x ? d : 0;
      const uz = x ? 0 : d;
      const mouthIn = d === 1 ? span.entry : span.exit;
      const mouthOut = d === 1 ? span.exit : span.entry;
      out.push({
        span,
        ux,
        uz,
        rHole,
        pts: [
          canonicalize({
            x: mouthIn.x - ux * HOLE_APPROACH,
            y: span.center.y,
            z: mouthIn.z - uz * HOLE_APPROACH,
          }),
          span.center,
          canonicalize({
            x: mouthOut.x + ux * HOLE_APPROACH,
            y: span.center.y,
            z: mouthOut.z + uz * HOLE_APPROACH,
          }),
        ],
      });
    }
  }
  return out;
}

/** Append canonical `p` to the chain: the last point plus wrapDelta. */
function chainTo(ways: readonly Way[], p: Vec3, r: number): Way {
  const last = (ways[ways.length - 1] as Way).p;
  const d = wrapDelta(canonicalize(last), p);
  return way(last.x + d.x, last.y + d.y, last.z + d.z, r);
}

/** A feature's three rings appended to `ways` (chain frame). */
function withFeature(ways: readonly Way[], f: HoleFeature): Way[] {
  const out = [...ways];
  const [a, h, e] = f.pts;
  if (out.length === 0) out.push(way(a.x, a.y, a.z, 10));
  else out.push(chainTo(out, a, 10));
  out.push(chainTo(out, h, f.rHole));
  out.push(chainTo(out, e, 10));
  return out;
}

/** The two dog-leg rings joining exit `e` (heading u1) to approach `a`
 * (heading u2) round the corner where their lines meet, or null when they
 * don't meet ahead of both. Plan view; height eases from e to a. */
function dogLeg(
  e: Vec3,
  u1x: number,
  u1z: number,
  a: Vec3,
  u2x: number,
  u2z: number,
): [Vec3, Vec3] | null {
  const LEG = 40;
  const cross = u1x * u2z - u1z * u2x;
  if (Math.abs(cross) < 0.3) return null;
  // e + u1·s = a − u2·t (chain frame: a is already unwrapped against e).
  const dx = a.x - e.x;
  const dz = a.z - e.z;
  const s = (dx * u2z - dz * u2x) / cross;
  const t = (dx * u1z - dz * u1x) / cross;
  if (s < LEG + 50 || t < LEG + 50) return null;
  const total = s + t;
  const y1 = e.y + ((a.y - e.y) * (s - LEG)) / total;
  const y2 = e.y + ((a.y - e.y) * (s + LEG)) / total;
  return [
    { x: e.x + u1x * (s - LEG), y: y1, z: e.z + u1z * (s - LEG) },
    { x: e.x + u1x * s + u2x * LEG, y: y2, z: e.z + u1z * s + u2z * LEG },
  ];
}

/** Chain 2–3 holes of `kinds` with straight legs or dog-legs between. */
function holeChain(
  rng: () => number,
  world: CourseWorld,
  spans: readonly HoleSpan[],
  kinds: readonly string[],
): Way[] | null {
  const MAX_HOLES = 3;
  const MIN_HOLES = 2;
  const LINK_MIN = 60;
  const LINK_MAX = 650;
  const NEAREST = 10;
  let budget = 160; // connector checks per theme — a fixed cap, not a clock
  const features = shuffle(
    holeFeatures(spans.filter((s) => kinds.includes(s.hole.kind))),
    rng,
  );
  for (const first of features.slice(0, 14)) {
    let ways = withFeature([], first);
    if (!pathClear(world, ways)) continue;
    const used = new Set<HoleSpan>([first.span]);
    let last = first;
    while (used.size < MAX_HOLES && budget > 0) {
      const exit = last.pts[2];
      const near = features
        .filter((f) => !used.has(f.span))
        .map((f) => ({ f, d: wrapDistance(exit, f.pts[0]) }))
        .filter(({ d }) => d >= LINK_MIN && d <= LINK_MAX)
        .sort((p, q) => p.d - q.d)
        .slice(0, NEAREST);
      let next: Way[] | null = null;
      for (const { f } of near) {
        if (budget-- <= 0) break;
        const straight = withFeature(ways, f);
        if (pathClear(world, straight, ways.length - 1)) {
          next = straight;
        } else {
          const e = (ways[ways.length - 1] as Way).p;
          const a = chainTo(ways, f.pts[0], 10).p;
          const leg = dogLeg(e, last.ux, last.uz, a, f.ux, f.uz);
          if (leg) {
            const bent = [...ways];
            bent.push(way(leg[0].x, leg[0].y, leg[0].z, 12));
            bent.push(way(leg[1].x, leg[1].y, leg[1].z, 12));
            const full = withFeature(bent, f);
            if (pathClear(world, full, ways.length - 1)) next = full;
          }
        }
        if (next) {
          used.add(f.span);
          last = f;
          break;
        }
      }
      if (!next) break;
      ways = next;
    }
    if (used.size >= MIN_HOLES) return ways;
  }
  return null;
}

/** Salts for each theme's mulberry32 stream. */
const SALT = {
  bridge: 0x5b1d9e01,
  canyon: 0x5c4a7e02,
  spiral: 0x5e9a1203,
  viaduct: 0x5f1ad704,
  needles: 0x50e3d105,
  holes: 0x51a7c006,
  canyon2: 0x52c4a907,
  spiral2: 0x53b1f208,
} as const;

/** Waypoints → a Course: canonical rings, normals along the path. */
function toCourse(
  id: number,
  theme: CourseTheme,
  name: string,
  ways: readonly Way[],
): Course {
  const n = ways.length;
  const rings: Ring[] = ways.map((w, i) => {
    const prev = ways[Math.max(0, i - 1)] as Way;
    const next = ways[Math.min(n - 1, i + 1)] as Way;
    const uIn = i > 0 ? dir(prev.p, w.p) : dir(w.p, next.p);
    const uOut = i < n - 1 ? dir(w.p, next.p) : uIn;
    const sx = uIn.x + uOut.x;
    const sy = uIn.y + uOut.y;
    const sz = uIn.z + uOut.z;
    const l = len3(sx, sy, sz) || 1;
    return {
      pos: canonicalize(w.p),
      n: { x: sx / l, y: sy / l, z: sz / l },
      r: w.r,
    };
  });
  let span = 0;
  for (let i = 0; i < rings.length - 1; i++) {
    span += wrapDistance((rings[i] as Ring).pos, (rings[i + 1] as Ring).pos);
  }
  const length = pathLength(ways);
  const cut = (speed: number) => Math.round((length / speed) * 10) * 100;
  return {
    id,
    theme,
    name,
    rings,
    length,
    span,
    medals: {
      gold: cut(MEDAL_SPEEDS.gold),
      silver: cut(MEDAL_SPEEDS.silver),
      bronze: cut(MEDAL_SPEEDS.bronze),
    },
  };
}

/**
 * The city's stunt courses for `seed`: COURSES_MIN–COURSES_MAX of them when
 * the city allows, in a fixed theme order. Pure and deterministic — client
 * and server MUST pass the same seed and the same generateCity / natureFor /
 * generateMovers output, exactly as they do for collision.
 */
export function generateCourses(seed: number, world: CourseWorld): Course[] {
  const spans = cityHoles(world.buildings);
  const themes: {
    theme: CourseTheme;
    name: string;
    build: () => Way[] | null;
  }[] = [
    {
      theme: "bridge",
      name: "Bridge Run",
      build: () => bridgeRun(mulberry32(seed ^ SALT.bridge), world),
    },
    {
      theme: "canyon",
      name: "Canyon Run",
      build: () => canyonRun(mulberry32(seed ^ SALT.canyon), world),
    },
    {
      theme: "spiral",
      name: "Landmark Spiral",
      build: () => landmarkSpiral(mulberry32(seed ^ SALT.spiral), world),
    },
    {
      theme: "viaduct",
      name: "Viaduct Run",
      build: () => viaductRun(mulberry32(seed ^ SALT.viaduct), world),
    },
    {
      theme: "needles",
      name: "Sky Needles",
      build: () =>
        holeChain(mulberry32(seed ^ SALT.needles), world, spans, [
          "sky",
          "gate",
        ]),
    },
    {
      theme: "holes",
      name: "Hole Threader",
      build: () =>
        holeChain(mulberry32(seed ^ SALT.holes), world, spans, [
          "tunnel",
          "arch",
        ]),
    },
  ];
  // Back-ups, only when the city offered fewer than COURSES_MIN above.
  const extras: typeof themes = [
    {
      theme: "canyon",
      name: "Canyon Run II",
      build: () => canyonRun(mulberry32(seed ^ SALT.canyon2), world),
    },
    {
      theme: "spiral",
      name: "Landmark Spiral II",
      build: () => landmarkSpiral(mulberry32(seed ^ SALT.spiral2), world),
    },
  ];
  const courses: Course[] = [];
  for (const t of themes) {
    if (courses.length >= COURSES_MAX) break;
    const ways = t.build();
    if (ways) courses.push(toCourse(courses.length, t.theme, t.name, ways));
  }
  for (const t of extras) {
    if (courses.length >= COURSES_MIN) break;
    const ways = t.build();
    if (ways) courses.push(toCourse(courses.length, t.theme, t.name, ways));
  }
  return courses;
}

/** The medal a time earns on `course`, or null. */
export function medalFor(course: Course, timeMs: number): Medal | null {
  if (timeMs <= course.medals.gold) return "gold";
  if (timeMs <= course.medals.silver) return "silver";
  if (timeMs <= course.medals.bronze) return "bronze";
  return null;
}

// --- Passing a ring -----------------------------------------------------------

/**
 * Where the straight move from → to passes FORWARD through `ring`'s disc
 * (radius + `slack`), as the fraction along the move in [0, 1], or −1. Swept,
 * so a 20 Hz pose stream can't step over a ring; wrap-safe through
 * wrapDeltaAxis, so it works across the seam and for any torus image;
 * backward crossings never count. Allocation-free (runs per frame).
 */
export function ringCrossing(
  ring: Ring,
  from: Vec3,
  to: Vec3,
  slack = 0,
): number {
  const c = ring.pos;
  const n = ring.n;
  // The move, and its start relative to the ring centre.
  const sx = wrapDeltaAxis(from.x, to.x);
  const sy = to.y - from.y;
  const sz = wrapDeltaAxis(from.z, to.z);
  if (sx * sx + sy * sy + sz * sz > MAX_PASS_SEGMENT * MAX_PASS_SEGMENT) {
    return -1;
  }
  const ax = wrapDeltaAxis(c.x, from.x);
  const ay = from.y - c.y;
  const az = wrapDeltaAxis(c.z, from.z);
  const da = ax * n.x + ay * n.y + az * n.z;
  const ds = sx * n.x + sy * n.y + sz * n.z;
  if (ds <= 0 || da >= 0 || da + ds < 0) return -1;
  const t = -da / ds;
  const px = ax + sx * t;
  const py = ay + sy * t;
  const pz = az + sz * t;
  const r = ring.r + slack;
  return px * px + py * py + pz * pz <= r * r ? t : -1;
}

// --- Runs ---------------------------------------------------------------------

/** What the last CourseRunner.step did. */
export type CourseStep = "none" | "start" | "ring" | "finish" | "abort";

/**
 * One pilot's run state machine, shared by the client (instant, provisional
 * HUD) and the server (the official time, from accepted poses). Mutated in
 * place and allocation-free, so the client can step it every frame.
 *
 * Rules: a forward pass through any course's start ring starts it — and
 * restarts the active course through its own start ring (generation never
 * reuses a start ring later in a course); another course's start ring is
 * ignored mid-run. Rings are taken in order: passing ring j while ring
 * `next` < j is still due skips the ones between (+COURSE_MISS_PENALTY_MS
 * each). The last ring finishes. No ring for COURSE_IDLE_MS, or a run older
 * than COURSE_MAX_MS, aborts.
 */
export class CourseRunner {
  /** The active course id, −1 when idle. */
  course = -1;
  /** The next ring due. */
  next = 0;
  /** Rings skipped so far. */
  missed = 0;
  /** When the start ring was passed, and the last ring, ms (caller's clock). */
  startMs = 0;
  lastMs = 0;
  /** The course the last non-"none" step was about (the active one, or the
   * one that just finished or aborted). */
  subject = -1;
  /** The ring the last start/ring/finish step passed, where along the move
   * (0–1) and when, ms. */
  ring = -1;
  frac = 0;
  atMs = 0;
  /** Set by a finish: flown time and the official time with penalties. */
  elapsedMs = 0;
  timeMs = 0;

  constructor(
    readonly courses: readonly Course[],
    /** Extra pass radius, m — the server is generous, the client exact. */
    readonly slack = 0,
  ) {}

  get active(): boolean {
    return this.course >= 0;
  }

  /** Drop the run (death, respawn, a gap in the pose stream). Returns
   * whether there was one. */
  abort(): boolean {
    if (this.course < 0) return false;
    this.subject = this.course;
    this.course = -1;
    return true;
  }

  private pass(ring: number, t: number, tFrom: number, tTo: number): void {
    this.ring = ring;
    this.frac = t;
    this.atMs = tFrom + (tTo - tFrom) * t;
  }

  private begin(course: number, t: number, tFrom: number, tTo: number): void {
    this.pass(0, t, tFrom, tTo);
    this.course = course;
    this.subject = course;
    this.next = 1;
    this.missed = 0;
    this.startMs = this.atMs;
    this.lastMs = this.atMs;
  }

  /** Advance over the move from → to, taken between tFrom and tTo (ms). */
  step(from: Vec3, to: Vec3, tFrom: number, tTo: number): CourseStep {
    if (this.course >= 0) {
      if (
        tTo - this.lastMs > COURSE_IDLE_MS ||
        tTo - this.startMs > COURSE_MAX_MS
      ) {
        this.abort();
        return "abort";
      }
      const course = this.courses[this.course] as Course;
      const rings = course.rings;
      const t0 = ringCrossing(rings[0] as Ring, from, to, this.slack);
      if (t0 >= 0) {
        this.begin(this.course, t0, tFrom, tTo);
        return "start";
      }
      for (let j = this.next; j < rings.length; j++) {
        const t = ringCrossing(rings[j] as Ring, from, to, this.slack);
        if (t < 0) continue;
        this.pass(j, t, tFrom, tTo);
        this.missed += j - this.next;
        this.next = j + 1;
        this.lastMs = this.atMs;
        this.subject = this.course;
        if (j < rings.length - 1) return "ring";
        this.elapsedMs = this.atMs - this.startMs;
        this.timeMs = this.elapsedMs + this.missed * COURSE_MISS_PENALTY_MS;
        this.course = -1;
        return "finish";
      }
      return "none";
    }
    for (let i = 0; i < this.courses.length; i++) {
      const start = (this.courses[i] as Course).rings[0] as Ring;
      const t = ringCrossing(start, from, to, this.slack);
      if (t >= 0) {
        this.begin(i, t, tFrom, tTo);
        return "start";
      }
    }
    return "none";
  }
}

// --- Ghosts -------------------------------------------------------------------

/** One coordinate in POS_SCALE units (x/z canonical first). */
const quant = (v: number): number => Math.round(v * POS_SCALE);

/** Wrap-safe difference of two quantised horizontal coordinates — the
 * torus API's own wrapDeltaAxis, back in integer units. */
const qDelta = (from: number, to: number): number =>
  Math.round(wrapDeltaAxis(from / POS_SCALE, to / POS_SCALE) * POS_SCALE);

/**
 * Records a run's path as a GhostPath: resampled onto a GHOST_HZ grid from
 * whatever cadence positions arrive at (linear, wrap-safe), quantised to
 * POS_SCALE, delta-encoded. The server feeds it accepted poses only.
 */
export class GhostRecorder {
  private d: number[] = [];
  private samples = 0;
  private qx = 0;
  private qy = 0;
  private qz = 0;
  private t0 = 0;
  private nextT = 0;
  private lastSampleT = 0;
  private px = 0;
  private py = 0;
  private pz = 0;
  private pt = 0;

  /** Begin at `p` (the start crossing) at time `t`, ms. */
  start(p: Vec3, t: number): void {
    this.d = [];
    this.samples = 0;
    this.t0 = t;
    this.push(p.x, p.y, p.z, t);
    this.nextT = t + GHOST_DT;
    this.px = p.x;
    this.py = p.y;
    this.pz = p.z;
    this.pt = t;
  }

  /** The plane was at `p` at time `t` (ms, non-decreasing). */
  add(p: Vec3, t: number): void {
    const span = t - this.pt;
    while (this.nextT <= t && this.samples < GHOST_MAX_SAMPLES - 1) {
      const f = span > 0 ? (this.nextT - this.pt) / span : 1;
      this.push(
        this.px + wrapDeltaAxis(this.px, p.x) * f,
        this.py + (p.y - this.py) * f,
        this.pz + wrapDeltaAxis(this.pz, p.z) * f,
        this.nextT,
      );
      this.nextT += GHOST_DT;
    }
    this.px = p.x;
    this.py = p.y;
    this.pz = p.z;
    this.pt = t;
  }

  /** End at `p` (the finish crossing) at `t` and hand the path over. */
  finish(p: Vec3, t: number): GhostPath {
    this.add(p, t);
    if (t > this.lastSampleT && this.samples < GHOST_MAX_SAMPLES) {
      this.push(p.x, p.y, p.z, t);
    }
    return {
      hz: GHOST_HZ,
      durMs: Math.round(this.lastSampleT - this.t0),
      d: this.d,
    };
  }

  private push(x: number, y: number, z: number, t: number): void {
    const qx = quant(wrapCoord(x));
    const qy = quant(y);
    const qz = quant(wrapCoord(z));
    if (this.samples === 0) this.d.push(qx, qy, qz);
    else this.d.push(qDelta(this.qx, qx), qy - this.qy, qDelta(this.qz, qz));
    this.qx = qx;
    this.qy = qy;
    this.qz = qz;
    this.samples++;
    this.lastSampleT = t;
  }
}

/** A decoded ghost: canonical positions, xyz-interleaved, and its timing. */
export interface GhostTrack {
  pts: Float64Array;
  count: number;
  durMs: number;
}

/** Decode a GhostPath off the wire, or null when it is malformed. */
export function decodeGhost(path: GhostPath): GhostTrack | null {
  const d = path.d;
  if (
    path.hz !== GHOST_HZ ||
    !Array.isArray(d) ||
    d.length < 6 ||
    d.length % 3 !== 0 ||
    d.length / 3 > GHOST_MAX_SAMPLES ||
    !Number.isFinite(path.durMs) ||
    path.durMs <= 0
  ) {
    return null;
  }
  const count = d.length / 3;
  const pts = new Float64Array(d.length);
  let qx = 0;
  let qy = 0;
  let qz = 0;
  for (let k = 0; k < count; k++) {
    const dx = d[k * 3] as number;
    const dy = d[k * 3 + 1] as number;
    const dz = d[k * 3 + 2] as number;
    if (
      !Number.isInteger(dx) ||
      !Number.isInteger(dy) ||
      !Number.isInteger(dz)
    ) {
      return null;
    }
    qx = k === 0 ? dx : qx + dx;
    qy = k === 0 ? dy : qy + dy;
    qz = k === 0 ? dz : qz + dz;
    pts[k * 3] = wrapCoord(qx / POS_SCALE);
    pts[k * 3 + 1] = qy / POS_SCALE;
    pts[k * 3 + 2] = wrapCoord(qz / POS_SCALE);
  }
  return { pts, count, durMs: path.durMs };
}

/** Time of sample k, ms after the start ring. */
const sampleTime = (track: GhostTrack, k: number): number =>
  Math.min(k * GHOST_DT, track.durMs);

/**
 * The ghost's canonical position `ms` after its start ring, into `out`
 * (clamped to the path's ends). Wrap-safe interpolation, allocation-free.
 */
export function ghostPositionAt(
  track: GhostTrack,
  ms: number,
  out: Vec3,
): Vec3 {
  const last = track.count - 1;
  const k = Math.max(0, Math.min(last - 1, Math.floor(ms / GHOST_DT)));
  const ta = sampleTime(track, k);
  const tb = sampleTime(track, k + 1);
  const f = tb > ta ? Math.max(0, Math.min(1, (ms - ta) / (tb - ta))) : 1;
  const p = track.pts;
  const ax = p[k * 3] as number;
  const ay = p[k * 3 + 1] as number;
  const az = p[k * 3 + 2] as number;
  out.x = wrapCoord(ax + wrapDeltaAxis(ax, p[k * 3 + 3] as number) * f);
  out.y = ay + ((p[k * 3 + 4] as number) - ay) * f;
  out.z = wrapCoord(az + wrapDeltaAxis(az, p[k * 3 + 5] as number) * f);
  return out;
}
