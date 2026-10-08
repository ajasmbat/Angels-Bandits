// The elevated trains (L5, T2), shared verbatim by client and server — movers
// in the city/movers.ts sense: every pose is a pure function of (seed, server
// time), so nothing about a train is ever streamed.
//
// A LINE is a rectangle on the street lattice: two long parallel streets
// joined by two cross streets, with a quarter-circle curve at each corner
// intersection. It may straddle the torus seam — every box is canonical and
// every distance goes through wrapDeltaAxis. A viaduct carries it at
// TRAIN_DECK_TOP: deck slabs over the street centreline (chords round the
// curves), square pillars on the centreline between the traffic lanes, never
// in an intersection, and 2-3 STATIONS at block midpoints — side platforms
// under a canopy, one per track.
//
// T2: every line is DOUBLE TRACK. The outer track (the centreline rectangle
// grown by TRAIN_TRACK_OFFSET) runs one way round, the inner track the other,
// so trains pass each other all the time. Each track has its own geometry,
// length, train count and cruise speed.
//
// THE SCHEDULE. Every train on a track runs the SAME position-vs-time
// profile — dwell TRAIN_DWELL at a stop, accelerate at TRAIN_ACCEL, cruise,
// brake at TRAIN_ACCEL into the next stop — and train j runs exactly one
// headway behind train j − 1. So every point on a track sees a train exactly
// every `headway` seconds, by construction. The train count is
// ceil(lap time / TRAIN_HEADWAY) and the cruise speed is then SOLVED so the
// lap is exactly that many headways. With identical profiles the closest two
// trains ever get is around a dwell: a·((H − D)/2)² lead to lead (66 m), which
// is why a set is TRAIN_CARS = 3 cars (51 m).
//
// ONE derivation of every box, exactly like partBox for the cranes: `viaduct`
// is generated once and is what the renderer instances; `carBoxAt` is the
// only place a car's pose is written down, and both the renderer and
// collideTrain go through it. Draw == collide by construction.
//
// The viaduct and stations are STATIC, so unlike the rest of the movers they
// are solid (and drawn) whatever the clock says — collideTrain with a null
// time tests them alone. Only the cars need the server clock.
//
// Routes are chosen, not hand-placed: a seeded, biggest-first search over
// rectangles that rejects any that would bury a box in a building, sweep
// through a crane's reach, cross a low H1 hole's run-out corridor or the
// street a bot stages on to thread it, cross the river channel, or come near
// an earlier line. No route → fewer lines (possibly none), which is
// deterministic too.

import {
  BLOCK_PITCH,
  BOT_HOLE_LINEUP_MAX,
  BOT_HOLE_TURN_IN_MAX,
  CRANE_JIB_MAX,
  HOLE_CORRIDOR_MARGIN,
  HOLE_RUN_OUT,
  PLAYER_RADIUS,
  STREET_WIDTH,
  TRAIN_ACCEL,
  TRAIN_BOT_CLEAR,
  TRAIN_CANOPY_BOTTOM,
  TRAIN_CARS,
  TRAIN_CAR_GAP,
  TRAIN_CAR_HEIGHT,
  TRAIN_CAR_LENGTH,
  TRAIN_CAR_LIFT,
  TRAIN_CAR_WIDTH,
  TRAIN_CORNER_RADIUS,
  TRAIN_DECK_HALF_WIDTH,
  TRAIN_DECK_THICK,
  TRAIN_DECK_TOP,
  TRAIN_DWELL,
  TRAIN_HEADWAY,
  TRAIN_LINES_MAX,
  TRAIN_PILLAR_CLEAR,
  TRAIN_PILLAR_SIDE,
  TRAIN_PILLAR_SPACING,
  TRAIN_PLATFORM_GAP,
  TRAIN_PLATFORM_LENGTH,
  TRAIN_PLATFORM_TOP,
  TRAIN_PLATFORM_WIDTH,
  TRAIN_SPEED,
  TRAIN_SPEED_MIN,
  TRAIN_STATION_TOP,
  TRAIN_TOP,
  TRAIN_TRACK_OFFSET,
  WORLD_SIZE,
} from "../constants";
import {
  type Vec3,
  canonicalize,
  wrapCoord,
  wrapDeltaAxis,
} from "../world/index";
import { type HoleSpan, cityHoles, holeEdges } from "./holes";
import { type Building, mulberry32 } from "./index";
import { CONSTRUCTION_BLOCKS } from "./layout";
import { type MoverBox, type MoverHit, sphereHitsBox } from "./movers";
import { RIVER_CENTER_Z, RIVER_HALF_WIDTH } from "./river";
import { roofTop } from "./roof-structures";

/** One piece of a track's centreline, in the line's own unwrapped frame
 * (origin at its first corner intersection). */
type Segment =
  | {
      kind: "line";
      /** Arclength at the segment's start, m. */
      s0: number;
      len: number;
      x0: number;
      z0: number;
      /** Unit direction of increasing arclength. */
      ux: number;
      uz: number;
    }
  | {
      kind: "arc";
      s0: number;
      len: number;
      cx: number;
      cz: number;
      /** Radius, m. */
      r: number;
      /** Start angle; the point is (cx + r cos a, cz + r sin a), a grows. */
      a0: number;
      /** (cos a0, sin a0), exactly (a0 is a multiple of a quarter turn). */
      c0: number;
      s0a: number;
    };

/** One phase of the schedule profile: from `t` (s into the cycle) the lead
 * car is at travel arclength q + v·dt + a·dt²/2. */
interface Phase {
  t: number;
  q: number;
  v: number;
  a: number;
  /** The stop this phase dwells at, or -1 when moving. */
  stop: number;
}

/** One track of a line, with its own schedule. */
export interface TrainTrack {
  /** 0 = outer, 1 = inner. */
  index: 0 | 1;
  /** Lateral offset from the street centreline, m (+ is outward). */
  offset: number;
  /** +1 runs in increasing arclength, -1 against it. */
  dir: 1 | -1;
  segments: readonly Segment[];
  /** Loop length, m. */
  length: number;
  /** The lead car's TRAVEL arclength at each stop, increasing, in [0, length). */
  stops: readonly number[];
  /** stopStation[k]: which of line.stations stop k is. */
  stopStation: readonly number[];
  /** Seconds into the cycle at which the lead car comes to rest at stop k. */
  arrive: readonly number[];
  phases: readonly Phase[];
  /** Lap time, s; exactly `trains` × `headway`. */
  cycle: number;
  headway: number;
  /** Solved cruise speed, m/s. */
  speed: number;
  trains: number;
  /** Schedule offset, s. */
  t0: number;
}

/** A station: the centre of its platforms, on the street centreline. */
export interface TrainStation {
  /** Canonical centre. */
  x: number;
  z: number;
  /** Unit direction of the street, in increasing centreline arclength. */
  ux: number;
  uz: number;
}

/** What each static box is, for the renderer's palette. */
export const StaticRole = {
  Deck: 0,
  Pillar: 1,
  Platform: 2,
  Canopy: 3,
  Rail: 4,
  Post: 5,
} as const;
export type StaticRole = (typeof StaticRole)[keyof typeof StaticRole];

/** One whole line for one seed. Build once (generateTrains) and reuse. */
export interface TrainLine {
  /** 0 for the first line, 1 for the second. */
  index: number;
  /** Canonical corner intersection the loop is laid out from. */
  ox: number;
  oz: number;
  /** Corner-to-corner extents along x and z, m (BLOCK_PITCH multiples). */
  w: number;
  d: number;
  /** The outer track's direction; the inner runs the other way. */
  dir: 1 | -1;
  /** Cars per train. */
  cars: number;
  /** The street centreline loop and its length, m. */
  segments: readonly Segment[];
  length: number;
  tracks: readonly [TrainTrack, TrainTrack];
  stations: readonly TrainStation[];
  /** Every static box, canonical: deck slabs, curve chords, pillars, then
   * the stations' platforms, canopies, rails and posts. */
  viaduct: readonly MoverBox[];
  /** viaduct[i]'s role. */
  roles: readonly StaticRole[];
  /** Plan-view AABB half-extents of viaduct[i], as [ex0, ez0, ex1, ...]. */
  extents: readonly number[];
  /** viaduct, bucketed along the loop for collision queries. */
  bins: StaticBins;
}

/** Car centre-to-centre spacing along the line, m. */
export const CAR_PITCH = TRAIN_CAR_LENGTH + TRAIN_CAR_GAP;
/** Nose to tail of one set, m. */
export const TRAIN_LENGTH = TRAIN_CARS * CAR_PITCH - TRAIN_CAR_GAP;
/** Chords per quarter-circle deck curve. */
const CURVE_CHORDS = 6;
/** Chords overlap their neighbours by this much at each end, m, so the
 * outer edge of the curve has no notch (half-chord angle × deck half-width). */
const CHORD_OVERLAP = 0.8;
/** Straights are cut into deck slabs no longer than this, m — so the
 * nearest-image placement of one slab never has to span half the world. */
const DECK_SLAB_MAX = BLOCK_PITCH;
/** The car's vertical centre. */
const CAR_Y = TRAIN_DECK_TOP + TRAIN_CAR_LIFT + TRAIN_CAR_HEIGHT / 2;
const DECK_Y = TRAIN_DECK_TOP - TRAIN_DECK_THICK / 2;
const DECK_BOTTOM = TRAIN_DECK_TOP - TRAIN_DECK_THICK;
const PILLAR_HALF_HEIGHT = DECK_BOTTOM / 2;
/** Station platform, lateral from the street centreline, m. */
const PLATFORM_IN =
  TRAIN_TRACK_OFFSET + TRAIN_CAR_WIDTH / 2 + TRAIN_PLATFORM_GAP;
const PLATFORM_OUT = PLATFORM_IN + TRAIN_PLATFORM_WIDTH;
/** Parapet rail on the platform's outer edge: height, thickness, m. */
const RAIL_HEIGHT = 1.1;
const RAIL_THICK = 0.3;
/** Canopy posts: side, spacing along the platform, m. */
const POST_SIDE = 0.3;
const POST_SPACING = 12;
/** A low hole is one whose clear volume dips into the line's height band. */
const HOLE_HEADROOM = 6;
/** Extra plan-view margin round every rejection volume, m. */
const ROUTE_MARGIN = 10;
/** Every box is inside the corner-to-corner rectangle grown by this, and no
 * box reaches further inward from its edges than INNER, m. */
const OUTER = Math.max(TRAIN_DECK_HALF_WIDTH + CHORD_OVERLAP, PLATFORM_OUT);
const INNER = TRAIN_CORNER_RADIUS + OUTER;
/** Stations: tried in this order, the first that schedules wins. */
const STATION_COUNTS = [3, 2, 0] as const;
/** Doors: start opening this long after the stop, take this long, s. */
const DOOR_DELAY = 0.8;
const DOOR_TRAVEL = 1.2;
/** Static box ids: line × this + index (cars pack below 4096). */
export const STATIC_ID_BASE = 100_000;

/** Loop sizes in blocks (long, short), biggest first: a line that "loops the
 * city" wins over a tight one whenever both fit. */
const SIZES: ReadonlyArray<readonly [number, number]> = [
  [5, 2],
  [4, 2],
  [5, 1],
  [3, 2],
  [4, 1],
  [3, 1],
];

/** The route stream for line `index`, salted so it shares nothing with the
 * movers' streams. Line 0 keeps L5's salt, so its draws never moved. */
const trainRand = (seed: number, index: number): (() => number) =>
  mulberry32((seed ^ 0x6a09e667 ^ Math.imul(index, 0x9e3779b9)) >>> 0);

/** Yaw for a heading (tx, tz): local +X maps to world (cos yaw, -sin yaw). */
const yawOf = (tx: number, tz: number) => Math.atan2(-tz, tx);

/** Non-negative remainder. */
const mod = (a: number, n: number) => ((a % n) + n) % n;

/** The eight segments of a W × D loop with rounded corners, offset by `e`
 * (outward) from the street centreline: same corner centres, radius R + e. */
function buildSegments(w: number, d: number, e: number): Segment[] {
  const R = TRAIN_CORNER_RADIUS;
  const r = R + e;
  const out: Segment[] = [];
  let s = 0;
  const line = (
    x0: number,
    z0: number,
    ux: number,
    uz: number,
    len: number,
  ) => {
    out.push({ kind: "line", s0: s, len, x0, z0, ux, uz });
    s += len;
  };
  const arc = (cx: number, cz: number, a0: number) => {
    const len = (Math.PI / 2) * r;
    const c0 = Math.round(Math.cos(a0));
    const s0a = Math.round(Math.sin(a0));
    out.push({ kind: "arc", s0: s, len, cx, cz, r, a0, c0, s0a });
    s += len;
  };
  line(R, -e, 1, 0, w - 2 * R);
  arc(w - R, R, -Math.PI / 2);
  line(w + e, R, 0, 1, d - 2 * R);
  arc(w - R, d - R, 0);
  line(w - R, d + e, -1, 0, w - 2 * R);
  arc(R, d - R, Math.PI / 2);
  line(-e, d - R, 0, -1, d - 2 * R);
  arc(R, R, Math.PI);
  return out;
}

/** A point on a centreline, in the loop frame, with its unit tangent. */
export interface Frame {
  x: number;
  z: number;
  tx: number;
  tz: number;
  curve: boolean;
}

/** Point at arclength `u` (any real; wrapped into the loop). */
function frameAt(
  segments: readonly Segment[],
  length: number,
  u: number,
  out: Frame,
): Frame {
  const s = mod(u, length);
  let seg = segments[segments.length - 1] as Segment;
  for (const candidate of segments) {
    if (s < candidate.s0 + candidate.len) {
      seg = candidate;
      break;
    }
  }
  const k = s - seg.s0;
  if (seg.kind === "line") {
    out.x = seg.x0 + seg.ux * k;
    out.z = seg.z0 + seg.uz * k;
    out.tx = seg.ux;
    out.tz = seg.uz;
    out.curve = false;
    return out;
  }
  const a = seg.a0 + k / seg.r;
  out.x = seg.cx + seg.r * Math.cos(a);
  out.z = seg.cz + seg.r * Math.sin(a);
  out.tx = -Math.sin(a);
  out.tz = Math.cos(a);
  out.curve = true;
  return out;
}

/** Where the last projectS landed: segment index and distance along it. */
const proj = { seg: 0, k: 0 };

/**
 * Arclength of the point on `segments` nearest (lx, lz), loop frame; also
 * leaves the segment and the distance along it in `proj`. Straights clamp to
 * their ends; an arc only competes inside its own quarter (its ends are the
 * straights' ends), so the one atan2 is for the winner alone.
 */
function projectS(segments: readonly Segment[], lx: number, lz: number) {
  let best = Number.POSITIVE_INFINITY;
  let bestSeg = 0;
  let bestK = 0;
  let arcA = 0;
  let arcB = 0;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i] as Segment;
    if (seg.kind === "line") {
      let k = (lx - seg.x0) * seg.ux + (lz - seg.z0) * seg.uz;
      k = Math.min(seg.len, Math.max(0, k));
      const d2 =
        (lx - seg.x0 - seg.ux * k) ** 2 + (lz - seg.z0 - seg.uz * k) ** 2;
      if (d2 < best) {
        best = d2;
        bestSeg = i;
        bestK = k;
      }
      continue;
    }
    const rx = lx - seg.cx;
    const rz = lz - seg.cz;
    // Components along the quarter's start and end directions.
    const a = rx * seg.c0 + rz * seg.s0a;
    const b = -rx * seg.s0a + rz * seg.c0;
    if (a < 0 || b < 0) continue;
    const d = Math.sqrt(rx * rx + rz * rz) - seg.r;
    if (d * d < best) {
      best = d * d;
      bestSeg = i;
      bestK = -1;
      arcA = a;
      arcB = b;
    }
  }
  const seg = segments[bestSeg] as Segment;
  if (seg.kind === "arc" && bestK < 0) bestK = seg.r * Math.atan2(arcB, arcA);
  proj.seg = bestSeg;
  proj.k = bestK;
  return seg.s0 + bestK;
}

/** The same place on another track: same segment, arcs scaled by radius. */
function onTrack(track: TrainTrack, seg: number, k: number): number {
  const t = track.segments[seg] as Segment;
  return t.s0 + (t.kind === "arc" ? (k * t.r) / TRAIN_CORNER_RADIUS : k);
}

/** Static boxes bucketed by centreline arclength, so a collision query
 * tests the handful near its own projection, not every box of the line. */
export interface StaticBins {
  /** Bucket length, m. */
  size: number;
  /** Bucket b's items are items[start[b] .. start[b + 1]). */
  start: Int32Array;
  items: Int32Array;
}
/** Bucket length, and how far a box's span is grown when bucketed (the
 * projection of a nearby point onto a curve is stretched), m. */
const BIN_SIZE = 50;
const BIN_PAD = 10;

function binStatics(
  boxes: readonly MoverBox[],
  segments: readonly Segment[],
  length: number,
  ox: number,
  oz: number,
  w: number,
  d: number,
): StaticBins {
  const n = Math.ceil(length / BIN_SIZE);
  const lists: number[][] = Array.from({ length: n }, () => []);
  boxes.forEach((b, i) => {
    const s = projectS(
      segments,
      wrapDeltaAxis(ox + w / 2, b.x) + w / 2,
      wrapDeltaAxis(oz + d / 2, b.z) + d / 2,
    );
    const h = Math.hypot(b.hx, b.hz) + BIN_PAD;
    const b0 = Math.floor((s - h) / BIN_SIZE);
    const b1 = Math.floor((s + h) / BIN_SIZE);
    for (let k = b0; k <= Math.min(b1, b0 + n - 1); k++) {
      (lists[mod(k, n)] as number[]).push(i);
    }
  });
  const start = new Int32Array(n + 1);
  const items: number[] = [];
  lists.forEach((l, k) => {
    start[k] = items.length;
    items.push(...l);
  });
  start[n] = items.length;
  return { size: BIN_SIZE, start, items: Int32Array.from(items) };
}

const box = (
  x: number,
  y: number,
  z: number,
  hx: number,
  hy: number,
  hz: number,
  yaw: number,
  id: number,
): MoverBox => {
  const p = canonicalize({ x, y: 0, z });
  return { x: p.x, y, z: p.z, hx, hy, hz, yaw, kind: "viaduct", id };
};

/** Every deck and pillar box of a W × D loop laid out from (ox, oz). */
function buildViaduct(
  ox: number,
  oz: number,
  segments: readonly Segment[],
  idBase: number,
  roles: StaticRole[],
): MoverBox[] {
  const out: MoverBox[] = [];
  const R = TRAIN_CORNER_RADIUS;
  const hy = TRAIN_DECK_THICK / 2;
  const push = (b: MoverBox, role: StaticRole) => {
    out.push(b);
    roles.push(role);
  };
  for (const seg of segments) {
    if (seg.kind === "line") {
      // Deck slabs.
      const n = Math.ceil(seg.len / DECK_SLAB_MAX);
      const piece = seg.len / n;
      for (let i = 0; i < n; i++) {
        const mid = (i + 0.5) * piece;
        push(
          box(
            ox + seg.x0 + seg.ux * mid,
            DECK_Y,
            oz + seg.z0 + seg.uz * mid,
            piece / 2,
            hy,
            TRAIN_DECK_HALF_WIDTH,
            yawOf(seg.ux, seg.uz),
            idBase + out.length,
          ),
          StaticRole.Deck,
        );
      }
      continue;
    }
    // Curve: chords between evenly spaced points on the arc.
    const step = Math.PI / 2 / CURVE_CHORDS;
    for (let i = 0; i < CURVE_CHORDS; i++) {
      const a = seg.a0 + i * step;
      const b = a + step;
      const x0 = seg.cx + seg.r * Math.cos(a);
      const z0 = seg.cz + seg.r * Math.sin(a);
      const x1 = seg.cx + seg.r * Math.cos(b);
      const z1 = seg.cz + seg.r * Math.sin(b);
      const len = Math.hypot(x1 - x0, z1 - z0);
      push(
        box(
          ox + (x0 + x1) / 2,
          DECK_Y,
          oz + (z0 + z1) / 2,
          len / 2 + CHORD_OVERLAP,
          hy,
          TRAIN_DECK_HALF_WIDTH,
          yawOf((x1 - x0) / len, (z1 - z0) / len),
          idBase + out.length,
        ),
        StaticRole.Deck,
      );
    }
  }
  // Pillars: every TRAIN_PILLAR_SPACING along each street the loop runs on,
  // but only on the straights and never within TRAIN_PILLAR_CLEAR of a
  // crossing street. Measured from the corner intersection, so they sit at
  // the same offsets in every block.
  for (const seg of segments) {
    if (seg.kind !== "line") continue;
    for (
      let at = TRAIN_PILLAR_SPACING;
      at < seg.len + 2 * R;
      at += TRAIN_PILLAR_SPACING
    ) {
      const k = at - R; // along the straight, which starts R past the corner
      if (k < 0 || k > seg.len) continue;
      const toCrossing = Math.abs(
        at - Math.round(at / BLOCK_PITCH) * BLOCK_PITCH,
      );
      if (toCrossing < TRAIN_PILLAR_CLEAR) continue;
      push(
        box(
          ox + seg.x0 + seg.ux * k,
          PILLAR_HALF_HEIGHT,
          oz + seg.z0 + seg.uz * k,
          TRAIN_PILLAR_SIDE / 2,
          PILLAR_HALF_HEIGHT,
          TRAIN_PILLAR_SIDE / 2,
          yawOf(seg.ux, seg.uz),
          idBase + out.length,
        ),
        StaticRole.Pillar,
      );
    }
  }
  return out;
}

/** A candidate station: centreline arclength and the straight it is on. */
interface StationSlot {
  s: number;
  seg: number;
  k: number;
}

/** Every block midpoint on the loop's straights — 100 m from each crossing,
 * so a platform never reaches an intersection. */
function stationSlots(segments: readonly Segment[]): StationSlot[] {
  const R = TRAIN_CORNER_RADIUS;
  const out: StationSlot[] = [];
  segments.forEach((seg, i) => {
    if (seg.kind !== "line") return;
    const blocks = Math.round((seg.len + 2 * R) / BLOCK_PITCH);
    for (let m = 0; m < blocks; m++) {
      const k = (m + 0.5) * BLOCK_PITCH - R;
      out.push({ s: seg.s0 + k, seg: i, k });
    }
  });
  return out;
}

/** The `count` slots that maximise the smallest gap round the loop (first
 * such set in index order — deterministic). */
function pickStations(
  slots: readonly StationSlot[],
  count: number,
  length: number,
): StationSlot[] {
  if (count === 0 || slots.length < count) return [];
  let best: StationSlot[] = [];
  let bestGap = -1;
  const pick: number[] = [];
  const walk = (from: number) => {
    if (pick.length === count) {
      let gap = Number.POSITIVE_INFINITY;
      for (let i = 0; i < count; i++) {
        const a = (slots[pick[i] as number] as StationSlot).s;
        const b = (slots[pick[(i + 1) % count] as number] as StationSlot).s;
        gap = Math.min(gap, i + 1 < count ? b - a : b + length - a);
      }
      if (gap > bestGap + 1e-6) {
        bestGap = gap;
        best = pick.map((i) => slots[i] as StationSlot);
      }
      return;
    }
    for (let i = from; i < slots.length; i++) {
      pick.push(i);
      walk(i + 1);
      pick.pop();
    }
  };
  walk(0);
  return best;
}

/** The boxes of one station, both sides of the street. */
function stationBoxes(
  ox: number,
  oz: number,
  seg: Segment & { kind: "line" },
  k: number,
  idBase: number,
  out: MoverBox[],
  roles: StaticRole[],
): void {
  const cx = ox + seg.x0 + seg.ux * k;
  const cz = oz + seg.z0 + seg.uz * k;
  const yaw = yawOf(seg.ux, seg.uz);
  // Outward normal of the loop: the segments run counter to (−uz, ux)... the
  // rectangle lies to the LEFT of travel, so outward is (uz, −ux).
  const nx = seg.uz;
  const nz = -seg.ux;
  const half = TRAIN_PLATFORM_LENGTH / 2;
  const push = (
    lat: number,
    along: number,
    y: number,
    hx: number,
    hy: number,
    hz: number,
    role: StaticRole,
  ) => {
    out.push(
      box(
        cx + nx * lat + seg.ux * along,
        y,
        cz + nz * lat + seg.uz * along,
        hx,
        hy,
        hz,
        yaw,
        idBase + out.length,
      ),
    );
    roles.push(role);
  };
  const width = TRAIN_PLATFORM_WIDTH / 2;
  const mid = (PLATFORM_IN + PLATFORM_OUT) / 2;
  for (const side of [1, -1]) {
    push(
      side * mid,
      0,
      (TRAIN_PLATFORM_TOP + DECK_BOTTOM) / 2,
      half,
      (TRAIN_PLATFORM_TOP - DECK_BOTTOM) / 2,
      width,
      StaticRole.Platform,
    );
    push(
      side * (mid + 0.05),
      0,
      (TRAIN_CANOPY_BOTTOM + TRAIN_STATION_TOP) / 2,
      half,
      (TRAIN_STATION_TOP - TRAIN_CANOPY_BOTTOM) / 2,
      width - 0.05,
      StaticRole.Canopy,
    );
    push(
      side * (PLATFORM_OUT - RAIL_THICK / 2),
      0,
      TRAIN_PLATFORM_TOP + RAIL_HEIGHT / 2,
      half,
      RAIL_HEIGHT / 2,
      RAIL_THICK / 2,
      StaticRole.Rail,
    );
    for (let a = -2; a <= 2; a++) {
      push(
        side * (PLATFORM_OUT - RAIL_THICK - POST_SIDE / 2),
        a * POST_SPACING,
        (TRAIN_PLATFORM_TOP + TRAIN_CANOPY_BOTTOM) / 2,
        POST_SIDE / 2,
        (TRAIN_CANOPY_BOTTOM - TRAIN_PLATFORM_TOP) / 2,
        POST_SIDE / 2,
        StaticRole.Post,
      );
    }
  }
}

/** A box's plan-view AABB half-extents. */
function extentsOf(b: MoverBox): [number, number] {
  const c = Math.abs(Math.cos(b.yaw));
  const s = Math.abs(Math.sin(b.yaw));
  return [c * b.hx + s * b.hz, s * b.hx + c * b.hz];
}

/** An axis-aligned plan-view rectangle (canonical centre, half-extents). */
interface Area {
  x: number;
  z: number;
  hx: number;
  hz: number;
}

/** Does the plan-view AABB of `b` (half-extents e) overlap `a`? */
const overlaps = (b: MoverBox, ex: number, ez: number, a: Area) =>
  Math.abs(wrapDeltaAxis(a.x, b.x)) < ex + a.hx &&
  Math.abs(wrapDeltaAxis(a.z, b.z)) < ez + a.hz;

/**
 * Every plan-view area a line must stay out of, for a city.
 *
 * - Cranes: each construction block grown by CRANE_JIB_MAX — the jib sweeps
 *   that far round a mast somewhere in the block (the same rule nearCrane
 *   applies to holes).
 * - Low holes (any whose clear volume dips under TRAIN_TOP + headroom): the
 *   run-out corridor, mouths ± HOLE_RUN_OUT — where a plane threading the
 *   hole flies; and where a bot stages to thread it (B2): an arch from its
 *   cross street within 2 × BOT_HOLE_TURN_IN_MAX of the edge node, a tunnel
 *   from a parallel street up to BOT_HOLE_LINEUP_MAX before its mouth.
 * - The L11 river channel (and so its bridges' underpasses), wall to wall
 *   plus margin — a pillar may never stand in the water.
 */
export function trainExclusions(spans: readonly HoleSpan[]): Area[] {
  const out: Area[] = [
    {
      x: WORLD_SIZE / 2,
      z: RIVER_CENTER_Z,
      hx: WORLD_SIZE,
      hz: RIVER_HALF_WIDTH + ROUTE_MARGIN,
    },
  ];
  for (const [bx, bz] of CONSTRUCTION_BLOCKS) {
    const c = canonicalize({
      x: (bx + 0.5) * BLOCK_PITCH,
      y: 0,
      z: (bz + 0.5) * BLOCK_PITCH,
    });
    const h = BLOCK_PITCH / 2 + CRANE_JIB_MAX + ROUTE_MARGIN;
    out.push({ x: c.x, z: c.z, hx: h, hz: h });
  }
  for (const span of spans) {
    const { hole } = span;
    if (hole.y0 >= TRAIN_TOP + HOLE_HEADROOM) continue;
    const x = hole.axis === "x";
    const along = span.length / 2 + HOLE_RUN_OUT;
    const across = hole.width / 2 + HOLE_CORRIDOR_MARGIN + ROUTE_MARGIN;
    out.push({
      x: span.center.x,
      z: span.center.z,
      hx: x ? along : across,
      hz: x ? across : along,
    });
    if (hole.kind === "sky") continue;
    for (const edge of holeEdges([span])) {
      if (hole.kind === "arch") {
        // Staged along the CROSS street through the node, either way.
        const reach = 2 * BOT_HOLE_TURN_IN_MAX + ROUTE_MARGIN;
        const half = STREET_WIDTH / 2 + ROUTE_MARGIN;
        out.push({
          x: edge.from.x,
          z: edge.from.z,
          hx: x ? half : reach,
          hz: x ? reach : half,
        });
      } else {
        // Lined up from a parallel street, BLOCK_PITCH/2 either side.
        const back = BOT_HOLE_LINEUP_MAX / 2;
        const c = canonicalize({
          x: edge.mouthIn.x - (x ? edge.dir * back : 0),
          y: 0,
          z: edge.mouthIn.z - (x ? 0 : edge.dir * back),
        });
        const half = BLOCK_PITCH / 2 + ROUTE_MARGIN;
        out.push({
          x: c.x,
          z: c.z,
          hx: x ? back + ROUTE_MARGIN : half,
          hz: x ? half : back + ROUTE_MARGIN,
        });
      }
    }
  }
  return out;
}

/** The whole plan-view rectangle a line owns, grown by the route margin — no
 * later line may put a box in it (or loop round it). */
function lineArea(l: TrainLine): Area {
  const c = canonicalize({ x: l.ox + l.w / 2, y: 0, z: l.oz + l.d / 2 });
  return {
    x: c.x,
    z: c.z,
    hx: l.w / 2 + OUTER + ROUTE_MARGIN,
    hz: l.d / 2 + OUTER + ROUTE_MARGIN,
  };
}

/** True when any box comes within PLAYER_RADIUS + 1 m of a building's
 * footprint below the box's bottom — conservative: tier-1 footprint, whole
 * height. A street-centred line can only meet one at a curve, and the
 * curves stay ~8 m clear of every lot line. */
function buriedInCity(
  boxes: readonly MoverBox[],
  extents: readonly number[],
  buildings: readonly Building[],
  from = 0,
): boolean {
  const pad = PLAYER_RADIUS + 1;
  for (let i = from; i < boxes.length; i++) {
    const b = boxes[i] as MoverBox;
    const ex = (extents[i * 2] ?? 0) + pad;
    const ez = (extents[i * 2 + 1] ?? 0) + pad;
    for (const o of buildings) {
      if (b.y - b.hy > roofTop(o)) continue; // R2: roof structures too
      if (Math.abs(wrapDeltaAxis(o.x, b.x)) >= ex + o.width / 2) continue;
      if (Math.abs(wrapDeltaAxis(o.z, b.z)) >= ez + o.depth / 2) continue;
      return true;
    }
  }
  return false;
}

/** Does any box from index `from` on overlap an area? */
function blockedBy(
  boxes: readonly MoverBox[],
  extents: readonly number[],
  areas: readonly Area[],
  from = 0,
): boolean {
  for (let i = from; i < boxes.length; i++) {
    const b = boxes[i] as MoverBox;
    const ex = extents[i * 2] ?? 0;
    const ez = extents[i * 2 + 1] ?? 0;
    for (const a of areas) if (overlaps(b, ex, ez, a)) return true;
  }
  return false;
}

/**
 * The cruise speed that makes a lap of `length` with `stops` stations exactly
 * `trains` headways long: the SMALLER root of
 *   (K/a)·v² + (K·D − C)·v + L = 0,   C = trains · TRAIN_HEADWAY,
 * which is the branch where a faster train makes a shorter lap. NaN when no
 * speed can (the stops alone eat more than C).
 */
export function solveCruise(
  length: number,
  stops: number,
  trains: number,
): number {
  const C = trains * TRAIN_HEADWAY;
  if (stops === 0) return length / C;
  const qa = stops / TRAIN_ACCEL;
  const qb = stops * TRAIN_DWELL - C;
  const disc = qb * qb - 4 * qa * length;
  if (disc < 0) return Number.NaN;
  return (-qb - Math.sqrt(disc)) / (2 * qa);
}

/** Lap time at cruise `v` over `length` with `stops` stations, s. */
export const lapTime = (length: number, stops: number, v: number): number =>
  stops * TRAIN_DWELL + (stops * v) / TRAIN_ACCEL + length / v;

/**
 * One track's schedule, or null when it cannot run one (the line then tries
 * fewer stations). `stops` are travel arclengths, sorted, in [0, length).
 */
function schedule(
  length: number,
  stops: readonly number[],
): Pick<
  TrainTrack,
  "phases" | "arrive" | "cycle" | "headway" | "speed" | "trains"
> | null {
  const K = stops.length;
  const n0 = Math.max(
    1,
    Math.ceil(lapTime(length, K, TRAIN_SPEED) / TRAIN_HEADWAY - 1e-9),
  );
  for (const trains of [n0, n0 - 1]) {
    if (trains < 1 || trains > 64) continue;
    const v = solveCruise(length, K, trains);
    if (!(v >= TRAIN_SPEED_MIN)) continue;
    // Every leg must reach cruise, with room for a whole train between.
    const ramp = (v * v) / TRAIN_ACCEL;
    let legsOk = true;
    for (let k = 0; k < K; k++) {
      const next =
        k + 1 < K ? (stops[k + 1] as number) : (stops[0] as number) + length;
      if (next - (stops[k] as number) < ramp + 2 * TRAIN_LENGTH) legsOk = false;
    }
    if (!legsOk) continue;
    const phases: Phase[] = [];
    const arrive: number[] = [];
    let t = 0;
    if (K === 0) {
      phases.push({ t: 0, q: 0, v, a: 0, stop: -1 });
    } else {
      const tRamp = v / TRAIN_ACCEL;
      const dRamp = ramp / 2;
      for (let k = 0; k < K; k++) {
        const q = stops[k] as number;
        const next =
          k + 1 < K ? (stops[k + 1] as number) : (stops[0] as number) + length;
        arrive.push(t);
        phases.push({ t, q, v: 0, a: 0, stop: k });
        t += TRAIN_DWELL;
        phases.push({ t, q, v: 0, a: TRAIN_ACCEL, stop: -1 });
        t += tRamp;
        phases.push({ t, q: q + dRamp, v, a: 0, stop: -1 });
        const cruise = next - q - ramp;
        t += cruise / v;
        phases.push({ t, q: next - dRamp, v, a: -TRAIN_ACCEL, stop: -1 });
        t += tRamp;
      }
    }
    const cycle = trains * TRAIN_HEADWAY;
    return { phases, arrive, cycle, headway: TRAIN_HEADWAY, speed: v, trains };
  }
  return null;
}

/** The two tracks of a loop with the given stations, or null if either
 * cannot be scheduled. */
function buildTracks(
  w: number,
  d: number,
  dir: 1 | -1,
  slots: readonly StationSlot[],
  phases01: readonly [number, number],
): [TrainTrack, TrainTrack] | null {
  const out: TrainTrack[] = [];
  for (const index of [0, 1] as const) {
    const offset = index === 0 ? TRAIN_TRACK_OFFSET : -TRAIN_TRACK_OFFSET;
    const tdir: 1 | -1 = index === 0 ? dir : dir === 1 ? -1 : 1;
    const segments = buildSegments(w, d, offset);
    const last = segments[segments.length - 1] as Segment;
    const length = last.s0 + last.len;
    // A station's centre on this track, as the lead car's travel arclength
    // when the set is centred on the platform.
    const raw = slots.map((slot, station) => {
      const s = (segments[slot.seg] as Segment).s0 + slot.k;
      const q = tdir === 1 ? s : length - s;
      return {
        q: mod(q + ((TRAIN_CARS - 1) / 2) * CAR_PITCH, length),
        station,
      };
    });
    raw.sort((a, b) => a.q - b.q);
    const stops = raw.map((r) => r.q);
    const sched = schedule(length, stops);
    if (!sched) return null;
    out.push({
      index,
      offset,
      dir: tdir,
      segments,
      length,
      stops,
      stopStation: raw.map((r) => r.station),
      ...sched,
      t0: (phases01[index] as number) * sched.cycle,
    });
  }
  return out as [TrainTrack, TrainTrack];
}

/** Try to lay a line out from one origin and size; null if it does not fit. */
function tryLine(
  index: number,
  ox: number,
  oz: number,
  w: number,
  d: number,
  dir: 1 | -1,
  phases01: readonly [number, number],
  avoid: readonly Area[],
  buildings: readonly Building[],
): TrainLine | null {
  const segments = buildSegments(w, d, 0);
  const roles: StaticRole[] = [];
  const idBase = index * STATIC_ID_BASE;
  const viaduct = buildViaduct(ox, oz, segments, idBase, roles);
  const extents: number[] = [];
  for (const b of viaduct) extents.push(...extentsOf(b));
  if (blockedBy(viaduct, extents, avoid)) return null;
  if (buriedInCity(viaduct, extents, buildings)) return null;
  const last = segments[segments.length - 1] as Segment;
  const length = last.s0 + last.len;
  const slots = stationSlots(segments);
  for (const count of STATION_COUNTS) {
    const picked = pickStations(slots, count, length);
    if (picked.length !== count) continue;
    const tracks = buildTracks(w, d, dir, picked, phases01);
    if (!tracks) continue;
    const boxes = viaduct.slice();
    const boxRoles = roles.slice();
    const boxExtents = extents.slice();
    const stations: TrainStation[] = [];
    for (const slot of picked) {
      const seg = segments[slot.seg] as Segment & { kind: "line" };
      const p = canonicalize({
        x: ox + seg.x0 + seg.ux * slot.k,
        y: 0,
        z: oz + seg.z0 + seg.uz * slot.k,
      });
      stations.push({ x: p.x, z: p.z, ux: seg.ux, uz: seg.uz });
      stationBoxes(ox, oz, seg, slot.k, idBase, boxes, boxRoles);
    }
    for (let i = viaduct.length; i < boxes.length; i++) {
      boxExtents.push(...extentsOf(boxes[i] as MoverBox));
    }
    if (blockedBy(boxes, boxExtents, avoid, viaduct.length)) continue;
    if (buriedInCity(boxes, boxExtents, buildings, viaduct.length)) continue;
    return {
      index,
      ox,
      oz,
      w,
      d,
      dir,
      cars: TRAIN_CARS,
      segments,
      length,
      tracks,
      stations,
      viaduct: boxes,
      roles: boxRoles,
      extents: boxExtents,
      bins: binStatics(boxes, segments, length, ox, oz, w, d),
    };
  }
  return null;
}

/**
 * The seed's train lines (0..TRAIN_LINES_MAX), biggest loops first. `buildings`
 * MUST be generateCity(seed) — routes are fitted to it, its holes and its
 * cranes, exactly like generateMovers' cranes.
 */
export function generateTrains(
  seed: number,
  buildings: readonly Building[],
): TrainLine[] {
  const lines: TrainLine[] = [];
  const avoid = trainExclusions(cityHoles(buildings));
  const grid = WORLD_SIZE / BLOCK_PITCH;
  for (let index = 0; index < TRAIN_LINES_MAX; index++) {
    const rand = trainRand(seed, index);
    // Fixed draws first, so the search order cannot shift them. The second
    // draw was L5's car count; it is still drawn so nothing after it moved.
    const dir: 1 | -1 = rand() < 0.5 ? 1 : -1;
    rand();
    const phaseA = rand();
    // Seeded visiting order of the candidate origins (Fisher–Yates).
    const origins: number[] = [];
    for (let i = 0; i < grid * grid * 2; i++) origins.push(i);
    for (let i = origins.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const t = origins[i] as number;
      origins[i] = origins[j] as number;
      origins[j] = t;
    }
    const phaseB = rand();
    const areas = [...avoid, ...lines.map(lineArea)];
    let found: TrainLine | null = null;
    search: for (const [long, short] of SIZES) {
      for (const o of origins) {
        const alongX = o % 2 === 0;
        const cell = o >> 1;
        const ox = (cell % grid) * BLOCK_PITCH;
        const oz = Math.floor(cell / grid) * BLOCK_PITCH;
        const w = (alongX ? long : short) * BLOCK_PITCH;
        const d = (alongX ? short : long) * BLOCK_PITCH;
        found = tryLine(
          index,
          ox,
          oz,
          w,
          d,
          dir,
          [phaseA, phaseB],
          areas,
          buildings,
        );
        if (found) break search;
      }
    }
    if (!found) break;
    lines.push(found);
  }
  return lines;
}

/** Where a train is and what it is doing. */
export interface TrainState {
  /** The lead car's travel arclength (any real; wrapped where used). */
  q: number;
  /** Speed along the track, m/s. */
  v: number;
  /** Door opening, 0 shut .. 1 open. */
  doors: number;
  /** The station it is dwelling at (line.stations index), or -1. */
  station: number;
}

/** Profile phase at `tau` seconds into the cycle. */
function phaseAt(track: TrainTrack, tau: number): Phase {
  const { phases } = track;
  let p = phases[0] as Phase;
  for (let i = 1; i < phases.length; i++) {
    const c = phases[i] as Phase;
    if (c.t > tau) break;
    p = c;
  }
  return p;
}

/** Seconds into the cycle for train `j` at a server time. */
const cycleTime = (track: TrainTrack, j: number, timeMs: number) =>
  mod(timeMs / 1000 - track.t0 - j * track.headway, track.cycle);

/** The lead car's travel arclength for train `j` — allocation-free. */
export function trainHead(
  track: TrainTrack,
  j: number,
  timeMs: number,
): number {
  const tau = cycleTime(track, j, timeMs);
  const p = phaseAt(track, tau);
  const dt = tau - p.t;
  return p.q + p.v * dt + 0.5 * p.a * dt * dt;
}

/** Train `j`'s full state at a server time, into `out`. */
export function trainState(
  track: TrainTrack,
  j: number,
  timeMs: number,
  out: TrainState,
): TrainState {
  const tau = cycleTime(track, j, timeMs);
  const p = phaseAt(track, tau);
  const dt = tau - p.t;
  out.q = p.q + p.v * dt + 0.5 * p.a * dt * dt;
  out.v = p.v + p.a * dt;
  if (p.stop >= 0) {
    const open = Math.min(1, Math.max(0, (dt - DOOR_DELAY) / DOOR_TRAVEL));
    const shut = Math.min(
      1,
      Math.max(0, (TRAIN_DWELL - DOOR_DELAY - dt) / DOOR_TRAVEL),
    );
    out.doors = Math.min(open, shut);
    out.station = track.stopStation[p.stop] as number;
  } else {
    out.doors = 0;
    out.station = -1;
  }
  return out;
}

/** Seconds since a train last pulled up at stop `k` of a track — below
 * TRAIN_DWELL one is standing there. In [0, headway). */
export function stopClock(
  track: TrainTrack,
  k: number,
  timeMs: number,
): number {
  return mod(timeMs / 1000 - track.t0 - (track.arrive[k] ?? 0), track.headway);
}

/** A car's MoverHit id: line, track, train and car packed. */
export const carId = (line: number, track: number, j: number, i: number) =>
  ((line * 2 + track) * 64 + j) * 8 + i;

/** Scratch frame for the allocation-free paths. */
const scratchFrame: Frame = { x: 0, z: 0, tx: 1, tz: 0, curve: false };

/** The travel arclength of car `i` of a train whose lead car is at `q`. */
const carQ = (q: number, i: number) => q - i * CAR_PITCH;

/** On-loop arclength for a travel arclength. */
const loopS = (track: TrainTrack, q: number) => (track.dir === 1 ? q : -q);

/**
 * THE definition of where a car is: car `i` of a train whose lead car is at
 * travel arclength `q` on `track`. Writes into `out` and returns it. Cars
 * centre on the track's centreline and point along its tangent (travel
 * direction), so on a curve the ends overhang the arc by ~1 m — inside
 * TRAIN_DECK_HALF_WIDTH.
 */
export function carBoxAt(
  line: TrainLine,
  track: TrainTrack,
  q: number,
  i: number,
  id: number,
  out: MoverBox,
): MoverBox {
  const f = frameAt(
    track.segments,
    track.length,
    loopS(track, carQ(q, i)),
    scratchFrame,
  );
  out.x = wrapCoord(line.ox + f.x);
  out.y = CAR_Y;
  out.z = wrapCoord(line.oz + f.z);
  out.hx = TRAIN_CAR_LENGTH / 2;
  out.hy = TRAIN_CAR_HEIGHT / 2;
  out.hz = TRAIN_CAR_WIDTH / 2;
  out.yaw = yawOf(f.tx * track.dir, f.tz * track.dir);
  out.kind = "train";
  out.id = id;
  return out;
}

/** Car `i` of train `j` on track `t` at a server time. */
export function carBox(
  line: TrainLine,
  t: number,
  j: number,
  i: number,
  timeMs: number,
  out: MoverBox,
): MoverBox {
  const track = line.tracks[t] as TrainTrack;
  return carBoxAt(
    line,
    track,
    trainHead(track, j, timeMs),
    i,
    carId(line.index, t, j, i),
    out,
  );
}

/** True when car `i` of a train led from `q` is on a curve. */
export function carOnCurve(track: TrainTrack, q: number, i: number): boolean {
  return frameAt(
    track.segments,
    track.length,
    loopS(track, carQ(q, i)),
    scratchFrame,
  ).curve;
}

/** Every car of every train of a line at a time, canonical. Allocates — the
 * testing entry point; collision and rendering use carBoxAt with scratch. */
export function trainBoxes(line: TrainLine, timeMs: number): MoverBox[] {
  const out: MoverBox[] = [];
  for (const track of line.tracks) {
    for (let j = 0; j < track.trains; j++) {
      for (let i = 0; i < line.cars; i++) {
        out.push(carBox(line, track.index, j, i, timeMs, blankCar()));
      }
    }
  }
  return out;
}

/** A fresh car box to write into. */
export const blankCar = (): MoverBox => ({
  x: 0,
  y: 0,
  z: 0,
  hx: 0,
  hy: 0,
  hz: 0,
  yaw: 0,
  kind: "train",
  id: 0,
});

/** The point in the loop frame for a world position (the loop may straddle
 * the seam; this frame never does for a loop under half the world). */
const loopX = (line: TrainLine, x: number) =>
  wrapDeltaAxis(line.ox + line.w / 2, x) + line.w / 2;
const loopZ = (line: TrainLine, z: number) =>
  wrapDeltaAxis(line.oz + line.d / 2, z) + line.d / 2;

/** Plan-view: is `p` (grown by `pad`) near the loop's ring at all? The ring
 * is the corner-to-corner rectangle's edge band, OUTER outside it and INNER
 * inside it — every box of the line lies in it. */
function nearRing(line: TrainLine, p: Vec3, pad: number): boolean {
  const dx = Math.abs(wrapDeltaAxis(line.ox + line.w / 2, p.x));
  const dz = Math.abs(wrapDeltaAxis(line.oz + line.d / 2, p.z));
  if (dx > line.w / 2 + OUTER + pad || dz > line.d / 2 + OUTER + pad) {
    return false;
  }
  return dx > line.w / 2 - INNER - pad || dz > line.d / 2 - INNER - pad;
}

const carScratch = blankCar();

/** Car top and bottom, m. */
const CAR_TOP = CAR_Y + TRAIN_CAR_HEIGHT / 2;
const CAR_BOTTOM = CAR_Y - TRAIN_CAR_HEIGHT / 2;
/** Slack on the arclength broad phase, m: a point near a curve projects onto
 * the track up to ~50 % stretched, and a car's chord cuts inside the arc. */
const PROJECT_SLACK = 12;

/**
 * First part of a line the sphere touches, or null. `timeMs` null tests the
 * static viaduct and stations alone (the clock is not known yet, so the cars
 * are not drawn and not solid; the rest always is). Allocation-free until a
 * hit, and two compares for a query away from the line. The query is
 * projected once onto the street centreline: static boxes come from that
 * arclength's buckets, and cars only from the trains whose span of
 * arclength (on each track) is within reach.
 */
export function collideTrain(
  line: TrainLine,
  pos: Vec3,
  radius: number,
  timeMs: number | null,
): MoverHit | null {
  if (pos.y - radius > TRAIN_STATION_TOP) return null;
  if (!nearRing(line, pos, radius)) return null;
  // One projection onto the street centreline serves the static buckets and
  // (mapped onto each track) the cars' broad phase.
  const sc = projectS(line.segments, loopX(line, pos.x), loopZ(line, pos.z));
  const seg = proj.seg;
  const along = proj.k;
  const pad = radius + PROJECT_SLACK;
  const { viaduct, extents, bins } = line;
  const n = bins.start.length - 1;
  const b1 = Math.floor((sc + pad) / bins.size);
  for (let bb = Math.floor((sc - pad) / bins.size); bb <= b1; bb++) {
    const bin = mod(bb, n);
    const end = bins.start[bin + 1] as number;
    for (let m = bins.start[bin] as number; m < end; m++) {
      const i = bins.items[m] as number;
      const b = viaduct[i] as MoverBox;
      if (pos.y + radius < b.y - b.hy || pos.y - radius > b.y + b.hy) continue;
      if (
        Math.abs(wrapDeltaAxis(b.x, pos.x)) >
        (extents[i * 2] ?? 0) + radius
      ) {
        continue;
      }
      if (
        Math.abs(wrapDeltaAxis(b.z, pos.z)) >
        (extents[i * 2 + 1] ?? 0) + radius
      ) {
        continue;
      }
      if (sphereHitsBox(b, pos, radius)) return { kind: "viaduct", id: b.id };
    }
  }
  if (timeMs === null) return null;
  if (pos.y + radius < CAR_BOTTOM || pos.y - radius > CAR_TOP) return null;
  const span = (line.cars - 1) * CAR_PITCH + TRAIN_CAR_LENGTH;
  const slack = radius + TRAIN_CAR_WIDTH + PROJECT_SLACK;
  for (const track of line.tracks) {
    const s = onTrack(track, seg, along);
    const qp = track.dir === 1 ? s : -s;
    for (let j = 0; j < track.trains; j++) {
      const head = trainHead(track, j, timeMs);
      // Arclength from the set's rear end forward to the query, wrapped.
      const from = head - (line.cars - 1) * CAR_PITCH - TRAIN_CAR_LENGTH / 2;
      if (mod(qp - from + slack, track.length) > span + 2 * slack) continue;
      for (let i = 0; i < line.cars; i++) {
        const b = carBoxAt(
          line,
          track,
          head,
          i,
          carId(line.index, track.index, j, i),
          carScratch,
        );
        if (sphereHitsBox(b, pos, radius)) return { kind: "train", id: b.id };
      }
    }
  }
  return null;
}

/** collideTrain over every line. */
export function collideTrains(
  lines: readonly TrainLine[],
  pos: Vec3,
  radius: number,
  timeMs: number | null,
): MoverHit | null {
  for (const line of lines) {
    const hit = collideTrain(line, pos, radius, timeMs);
    if (hit) return hit;
  }
  return null;
}

/**
 * The altitude a canyon bot at `p` should hold, m: TRAIN_TOP +
 * TRAIN_BOT_CLEAR when any line's deck or station is within `reach`
 * plan-view (its own streets and every street crossing them), else 0. Bots
 * are not meant to thread the viaduct — players are.
 */
export function trainFloor(
  lines: readonly TrainLine[],
  p: Vec3,
  reach: number,
): number {
  for (const line of lines) {
    if (!nearRing(line, p, reach)) continue;
    const { viaduct, extents } = line;
    for (let i = 0; i < viaduct.length; i++) {
      const b = viaduct[i] as MoverBox;
      if (Math.abs(wrapDeltaAxis(b.x, p.x)) > (extents[i * 2] ?? 0) + reach) {
        continue;
      }
      if (
        Math.abs(wrapDeltaAxis(b.z, p.z)) >
        (extents[i * 2 + 1] ?? 0) + reach
      ) {
        continue;
      }
      return TRAIN_TOP + TRAIN_BOT_CLEAR;
    }
  }
  return 0;
}

/** A moment two trains on opposite tracks of a line are abreast. */
export interface TrainMeeting {
  timeMs: number;
  /** Midpoint between the two sets' middles, canonical; and the outer
   * track's heading as a box yaw. */
  x: number;
  z: number;
  yaw: number;
}

/**
 * The next time at or after `fromMs` (within `withinMs`) that a train on
 * each track of `line` passes the other, middles abreast, both doing at
 * least `minSpeed` — QA and gallery framing. Steps the clock.
 */
export function nextMeeting(
  line: TrainLine,
  fromMs: number,
  withinMs = 120_000,
  minSpeed = 0,
): TrainMeeting | null {
  const [outer, inner] = line.tracks;
  const mid = ((line.cars - 1) / 2) * CAR_PITCH;
  const a = blankCar();
  const b = blankCar();
  const sa: TrainState = { q: 0, v: 0, doors: 0, station: -1 };
  const sb: TrainState = { q: 0, v: 0, doors: 0, station: -1 };
  for (let t = fromMs; t <= fromMs + withinMs; t += 100) {
    for (let j = 0; j < outer.trains; j++) {
      trainState(outer, j, t, sa);
      if (sa.v < minSpeed) continue;
      carBoxAt(line, outer, sa.q - mid, 0, 0, a);
      for (let k = 0; k < inner.trains; k++) {
        trainState(inner, k, t, sb);
        if (sb.v < minSpeed) continue;
        carBoxAt(line, inner, sb.q - mid, 0, 0, b);
        const dx = wrapDeltaAxis(a.x, b.x);
        const dz = wrapDeltaAxis(a.z, b.z);
        // Abreast: the tracks' spacing across, within a 100 ms step along
        // (the sets close at ~40 m/s).
        if (dx * dx + dz * dz < 4 * TRAIN_TRACK_OFFSET ** 2 + 25) {
          return {
            timeMs: t,
            x: wrapCoord(a.x + dx / 2),
            z: wrapCoord(a.z + dz / 2),
            yaw: a.yaw,
          };
        }
      }
    }
  }
  return null;
}
