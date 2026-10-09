// U4 underground tunnels — a deep network under the city that planes fly
// through and come out the other side of. Shared verbatim by client and
// server, like the rest of common/city: the renderer draws exactly the walls
// this module collides, and bots probe the same function players die to.
//
// THE NETWORK is hand-placed and seed-free, like the river and the plazas:
// three bores, BORE_WIDTH × BORE_HEIGHT, floor at BORE_FLOOR_Y, each a chain
// of straight and circular (TUNNEL_RADIUS) legs, G1-continuous. Every one
// starts and ends on a straight leg. Six mouths:
//   - plaza PORTALS: an open cut in the park lawn (CUT_LENGTH long, axis-
//     aligned), its floor a ramp at RAMP_GRADE from street level down to the
//     lintel where the covered bore begins. The lip sits near the plaza's
//     middle, so the climb-out faces the open lawn;
//   - river MOUTHS: an opening in an L11 embankment wall between two bridges,
//     the bore leaving the channel at 35° off its axis, so a plane flying the
//     river peels into it. Water to lintel: 20 m (the channel is 22 m deep).
//
// THE PROFILE is closed form in s, the arc length along the centreline from
// the tunnel's start: the floor descends from each end's top (street level
// for a plaza, the water for a river mouth) at RAMP_GRADE to BORE_FLOOR_Y;
// the ceiling is BORE_HEIGHT above the floor, never above −LINTEL_MIN — and
// over a plaza cut there is no ceiling at all (open sky).
//
// THE GROUND. collision.ts hitsGround() is riverHit() && !tunnelOpen(): the
// ground (and the river's water, banks and decks) stays solid everywhere
// except inside a bore's open volume, shrunk by the sphere's radius. Outside
// s ∈ [0, L] nothing is open: a tunnel never continues as an endless slab.
//
// TORUS. Paths are stored unwrapped from their (canonical) start; every query
// measures through wrapDeltaAxis against a segment's own centre, so any
// torus image of a position works and the seam needs no special case.
//
// Allocation-free on the query side (O5): tunnelOpen runs inside every bot
// probe that reaches street level.

import { WORLD_SIZE } from "../constants";
import { type Vec3, wrapDeltaAxis } from "../world/index";
import { RIVER_HALF_WIDTH, RIVER_WATER_Y, riverOffset } from "./river";

/** Clear width of a bore, wall to wall, m. */
export const BORE_WIDTH = 36;
/** Clear height of a bore, floor to ceiling, m. */
export const BORE_HEIGHT = 24;
/** The bores' floor where they run deep, m. The lowest point of the world. */
export const BORE_FLOOR_Y = -64;
/** The ramps' slope, as rise over run (22°): every portal and mouth ramp. */
export const RAMP_GRADE = Math.tan((22 * Math.PI) / 180);
/** Radius of every bend, m. A MAX_SPEED plane turns on ~100 m. */
export const TUNNEL_RADIUS = 300;
/** A plaza portal's open cut, lip to lintel, m. */
export const CUT_LENGTH = 80;
/** The ceiling never comes within this of street level, m (the lintel). */
export const LINTEL_MIN = 2;
/** A river mouth's floor stays at the water this far past the wall, m. */
const MOUTH_SILL = 15;
/** A river-mouth bore starts this far inside the channel from its wall, m —
 * so its open volume overlaps the wall plane by far more than any radius. */
const MOUTH_INSET = 30;

const DEG = Math.PI / 180;

/** One end of a bore. */
export interface TunnelEnd {
  kind: "plaza" | "river";
  /** The floor's height at this end, m (0: the lip; the water: a mouth). */
  top: number;
  /** How far in from this end the floor stays at `top`, m. */
  flat: number;
  /** Open cut (no ceiling) from this end, m: CUT_LENGTH at a plaza, 0 at a
   * river mouth. */
  cut: number;
  /** River mouths: how far in from this end the centreline crosses the
   * embankment wall, m (0 at a plaza). */
  wall: number;
}

/** One leg of a centreline, precomputed. Lines use (x0, z0, th0); arcs add
 * their centre and turn. `bx, bz, hx, hz` bound the leg's bore (unwrapped
 * centre, half extents including half the width). */
export interface TunnelSeg {
  arc: boolean;
  /** Arc length at the leg's start, and its length, m. */
  s0: number;
  len: number;
  /** Start point (unwrapped) and heading (rad; direction (cos, sin) in x/z). */
  x0: number;
  z0: number;
  th0: number;
  /** Arcs: centre (unwrapped) and turn (+1: heading increases). */
  cx: number;
  cz: number;
  turn: 1 | -1;
  /** Lines: the midpoint (unwrapped). Arcs: heading at the arc's middle. */
  mx: number;
  mz: number;
  thMid: number;
  bx: number;
  bz: number;
  hx: number;
  hz: number;
}

/** One bore of the network. */
export interface Tunnel {
  id: number;
  name: string;
  /** Centreline length, m. */
  length: number;
  segs: readonly TunnelSeg[];
  ends: readonly [TunnelEnd, TunnelEnd];
}

type LegSpec = readonly ["line", number] | readonly ["arc", 1 | -1, number];

interface TunnelSpec {
  name: string;
  x: number;
  z: number;
  heading: number;
  legs: readonly LegSpec[];
  kinds: readonly ["plaza" | "river", "plaza" | "river"];
}

// Headings: 0 = +x, 90° = +z. Each spec closes on its portal lip (the tests
// check every cut against its plaza's lawn and every mouth against the
// bridges); the cut rectangles below are DERIVED from these paths.
const SPECS: readonly TunnelSpec[] = [
  {
    // Plaza (4,4) → plaza (8,2): an S-bend under the north-east blocks.
    name: "Crosstown",
    x: 890,
    z: 850,
    heading: 0,
    legs: [
      ["line", 102.288],
      ["arc", -1, 50],
      ["line", 242.378],
      ["arc", 1, 50],
      ["line", 102.288],
    ],
    kinds: ["plaza", "plaza"],
  },
  {
    // South river wall (mouth at x 1100) → plaza (1,7), north portal.
    name: "Riverside",
    x: 1100 + MOUTH_INSET / Math.tan(35 * DEG),
    z: 1160 - MOUTH_INSET,
    heading: 145 * DEG,
    legs: [
      ["line", 463.313],
      ["arc", 1, 35],
      ["line", 301.247],
    ],
    kinds: ["river", "plaza"],
  },
  {
    // North river wall (mouth at x 887) → north under the z seam → plaza
    // (1,7), south portal: the long way round, out the other side.
    name: "Seam Line",
    x: 887 + MOUTH_INSET / Math.tan(35 * DEG),
    z: 1040 + MOUTH_INSET,
    heading: -145 * DEG,
    legs: [
      ["line", 100],
      ["arc", 1, 55],
      ["line", 916.897],
      ["arc", -1, 90],
      ["line", 130.002],
    ],
    kinds: ["river", "plaza"],
  },
];

const nx = (th: number) => -Math.sin(th);
const nz = (th: number) => Math.cos(th);

function buildSegs(spec: TunnelSpec): { segs: TunnelSeg[]; length: number } {
  const segs: TunnelSeg[] = [];
  let x = spec.x;
  let z = spec.z;
  let th = spec.heading;
  let s = 0;
  const half = BORE_WIDTH / 2;
  for (const leg of spec.legs) {
    if (leg[0] === "line") {
      const len = leg[1];
      const dx = Math.cos(th);
      const dz = Math.sin(th);
      const mx = x + (dx * len) / 2;
      const mz = z + (dz * len) / 2;
      segs.push({
        arc: false,
        s0: s,
        len,
        x0: x,
        z0: z,
        th0: th,
        cx: 0,
        cz: 0,
        turn: 1,
        mx,
        mz,
        thMid: th,
        bx: mx,
        bz: mz,
        hx: (Math.abs(dx) * len) / 2 + Math.abs(dz) * half,
        hz: (Math.abs(dz) * len) / 2 + Math.abs(dx) * half,
      });
      x += dx * len;
      z += dz * len;
      s += len;
    } else {
      const turn = leg[1];
      const phi = leg[2] * DEG;
      const len = TUNNEL_RADIUS * phi;
      const cx = x + turn * TUNNEL_RADIUS * nx(th);
      const cz = z + turn * TUNNEL_RADIUS * nz(th);
      const th1 = th + turn * phi;
      // Bounds: the arc's chord box grown by the sagitta and half the width.
      const ex = cx - turn * TUNNEL_RADIUS * nx(th1);
      const ez = cz - turn * TUNNEL_RADIUS * nz(th1);
      const sag = TUNNEL_RADIUS * (1 - Math.cos(phi / 2));
      segs.push({
        arc: true,
        s0: s,
        len,
        x0: x,
        z0: z,
        th0: th,
        cx,
        cz,
        turn,
        mx: (x + ex) / 2,
        mz: (z + ez) / 2,
        thMid: th + (turn * phi) / 2,
        bx: (x + ex) / 2,
        bz: (z + ez) / 2,
        hx: Math.abs(ex - x) / 2 + sag + half,
        hz: Math.abs(ez - z) / 2 + sag + half,
      });
      x = ex;
      z = ez;
      th = th1;
      s += len;
    }
  }
  return { segs, length: s };
}

function buildEnd(
  kind: "plaza" | "river",
  z: number,
  heading: number,
): TunnelEnd {
  if (kind === "plaza") {
    return { kind, top: 0, flat: 0, cut: CUT_LENGTH, wall: 0 };
  }
  // How far from this end the bore crosses the embankment wall: it runs
  // straight (first/last legs are lines), heading away from the centreline.
  const off = Math.abs(riverOffset(z));
  const sin = Math.abs(Math.sin(heading));
  const wall = (RIVER_HALF_WIDTH - off) / sin;
  // The bore meets the wall obliquely: its far side wall crosses the wall
  // plane (BORE_WIDTH / 2)·|cot| later than the centreline. The floor holds
  // at the water until BOTH sides are past it — never an open volume under
  // the river's water.
  const far = wall + ((BORE_WIDTH / 2) * Math.abs(Math.cos(heading))) / sin;
  return { kind, top: RIVER_WATER_Y, flat: far + MOUTH_SILL, cut: 0, wall };
}

/** The network. Pure and seed-free: every client and server builds the same. */
export const TUNNELS: readonly Tunnel[] = SPECS.map((spec, id) => {
  const { segs, length } = buildSegs(spec);
  const last = segs[segs.length - 1] as TunnelSeg;
  const endZ = last.z0 + Math.sin(last.th0) * last.len;
  return {
    id,
    name: spec.name,
    length,
    segs,
    ends: [
      buildEnd(spec.kinds[0], spec.z, spec.heading),
      buildEnd(spec.kinds[1], endZ, last.th0 + Math.PI),
    ],
  };
});

// --- The profile -----------------------------------------------------------

/** Floor height at arc length `s`, m. Beyond the ends: the end's top. */
export function floorAt(t: Tunnel, s: number): number {
  const [a, b] = t.ends;
  const fromA = a.top - RAMP_GRADE * Math.max(0, s - a.flat);
  const fromB = b.top - RAMP_GRADE * Math.max(0, t.length - s - b.flat);
  return Math.max(BORE_FLOOR_Y, fromA, fromB);
}

/** True where `s` lies in a plaza portal's open cut (no ceiling). */
export function inCut(t: Tunnel, s: number): boolean {
  return s < t.ends[0].cut || s > t.length - t.ends[1].cut;
}

/** Ceiling height at `s`, m; +Infinity over an open cut. */
export function ceilingAt(t: Tunnel, s: number): number {
  if (inCut(t, s)) return Number.POSITIVE_INFINITY;
  return Math.min(floorAt(t, s) + BORE_HEIGHT, -LINTEL_MIN);
}

/**
 * The guide line at `s` (clamped to the bore), m: mid-height of the clear
 * section — BORE_HEIGHT / 2 over a cut's ramp, mid-way between the water and
 * the lintel at a river mouth. What bots fly and what H3 measures "up" from.
 */
export function guideY(t: Tunnel, s: number): number {
  const c = Math.min(Math.max(s, 0), t.length);
  const f = floorAt(t, c);
  if (inCut(t, c)) return f + BORE_HEIGHT / 2;
  return f + (Math.min(f + BORE_HEIGHT, -LINTEL_MIN) - f) / 2;
}

/** The slope of the guide line along +s at `s` (rise per metre). */
export function guideSlope(t: Tunnel, s: number): number {
  return (guideY(t, s + 1) - guideY(t, s - 1)) / 2;
}

// --- Frames ----------------------------------------------------------------

/** A point in a bore's own frame. */
export interface TunnelFrame {
  /** Arc length of the nearest centreline point, m (outside [0, L] beyond an
   * end, along the end leg's extension). */
  s: number;
  /** Offset off the centreline, m: + to the left of travel (+s). */
  lat: number;
  /** Heading at s, rad. */
  th: number;
}

const wrapAngle = (a: number): number => {
  const m = (((a + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  return m - Math.PI;
};

/** Project (x, z) onto segment `g`: fills `proj` (u along, lat, heading). */
const proj = { u: 0, lat: 0, th: 0 };
function project(g: TunnelSeg, x: number, z: number): void {
  if (!g.arc) {
    const dx = wrapDeltaAxis(g.mx, x);
    const dz = wrapDeltaAxis(g.mz, z);
    const c = Math.cos(g.th0);
    const sn = Math.sin(g.th0);
    proj.u = g.len / 2 + dx * c + dz * sn;
    proj.lat = -dx * sn + dz * c;
    proj.th = g.th0;
    return;
  }
  const vx = wrapDeltaAxis(g.cx, x);
  const vz = wrapDeltaAxis(g.cz, z);
  const th = Math.atan2(vz, vx) + (g.turn * Math.PI) / 2;
  const d = wrapAngle(th - g.thMid);
  proj.u = g.len / 2 + g.turn * d * TUNNEL_RADIUS;
  proj.lat = g.turn * (TUNNEL_RADIUS - Math.hypot(vx, vz));
  proj.th = th;
}

/** Joint tolerance on u, m: consecutive legs share their boundary normal. */
const U_EPS = 1e-6;

/**
 * `p` in `t`'s frame: the nearest centreline point by lateral offset, among
 * the legs whose span contains its projection — or, beyond an end, the end
 * leg's straight extension. Allocation-free with `out`.
 */
export function tunnelFrameInto(
  t: Tunnel,
  p: Vec3,
  out: TunnelFrame,
): TunnelFrame {
  let best = Number.POSITIVE_INFINITY;
  const n = t.segs.length;
  for (let i = 0; i < n; i++) {
    const g = t.segs[i] as TunnelSeg;
    project(g, p.x, p.z);
    let u = proj.u;
    if (u < -U_EPS) {
      if (i !== 0) continue;
    } else if (u > g.len + U_EPS) {
      if (i !== n - 1) continue;
    } else {
      u = Math.min(Math.max(u, 0), g.len);
    }
    const a = Math.abs(proj.lat);
    if (a < best) {
      best = a;
      out.s = g.s0 + u;
      out.lat = proj.lat;
      out.th = proj.th;
    }
  }
  return out;
}

/** A centreline point: unwrapped x/z from the tunnel's canonical start (wrap
 * it for a canonical position) and the heading there. */
export interface TunnelPoint {
  x: number;
  z: number;
  th: number;
}

/** The centreline at `s` — beyond either end, along that end's straight
 * extension. Allocation-free with `out`. */
export function tunnelPointInto(
  t: Tunnel,
  s: number,
  out: TunnelPoint,
): TunnelPoint {
  const segs = t.segs;
  let g = segs[0] as TunnelSeg;
  for (let i = 1; i < segs.length; i++) {
    const h = segs[i] as TunnelSeg;
    if (s >= h.s0) g = h;
    else break;
  }
  const u = s - g.s0;
  if (!g.arc) {
    out.x = g.x0 + Math.cos(g.th0) * u;
    out.z = g.z0 + Math.sin(g.th0) * u;
    out.th = g.th0;
    return out;
  }
  const th = g.th0 + (g.turn * u) / TUNNEL_RADIUS;
  out.x = g.cx - g.turn * TUNNEL_RADIUS * nx(th);
  out.z = g.cz - g.turn * TUNNEL_RADIUS * nz(th);
  out.th = th;
  return out;
}

// --- Collision --------------------------------------------------------------

/**
 * Is a sphere of radius `r` at `pos` wholly inside some bore's open volume
 * (its cut, ramp, bore or mouth), shrunk by `r`? hitsGround's other half:
 * where this is true the ground does not exist.
 *
 * Vertical tests take the floor's max and the ceiling's min over [s−r, s+r]
 * (both are monotone off the flat bottom), so a ramp, a lintel face or the
 * edge of a cut is met by the sphere, not its centre.
 */
export function tunnelOpen(pos: Vec3, r: number): boolean {
  // A sphere wider than a bore never fits (BOT_PROBE_RADIUS probes).
  if (r >= BORE_WIDTH / 2) return false;
  if (pos.y - r <= BORE_FLOOR_Y) return false;
  const halfW = BORE_WIDTH / 2 - r;
  for (let k = 0; k < TUNNELS.length; k++) {
    const t = TUNNELS[k] as Tunnel;
    const segs = t.segs;
    for (let i = 0; i < segs.length; i++) {
      const g = segs[i] as TunnelSeg;
      if (
        Math.abs(wrapDeltaAxis(g.bx, pos.x)) > g.hx ||
        Math.abs(wrapDeltaAxis(g.bz, pos.z)) > g.hz
      ) {
        continue;
      }
      project(g, pos.x, pos.z);
      if (proj.u < -U_EPS || proj.u > g.len + U_EPS) continue;
      if (Math.abs(proj.lat) > halfW) continue;
      const s = g.s0 + proj.u;
      if (s < 0 || s > t.length) continue;
      const floor = Math.max(floorAt(t, s - r), floorAt(t, s + r));
      if (pos.y - r <= floor) continue;
      const ceil = Math.min(ceilingAt(t, s - r), ceilingAt(t, s + r));
      if (pos.y + r >= ceil) continue;
      return true;
    }
  }
  return false;
}

/** Is (x, z) over some bore's footprint (within `margin` of its walls)? */
export function overTunnel(x: number, z: number, margin = 0): boolean {
  const half = BORE_WIDTH / 2 + margin;
  for (let k = 0; k < TUNNELS.length; k++) {
    const t = TUNNELS[k] as Tunnel;
    for (const g of t.segs) {
      if (
        Math.abs(wrapDeltaAxis(g.bx, x)) > g.hx + margin ||
        Math.abs(wrapDeltaAxis(g.bz, z)) > g.hz + margin
      ) {
        continue;
      }
      project(g, x, z);
      if (proj.u < -margin || proj.u > g.len + margin) continue;
      if (Math.abs(proj.lat) <= half) return true;
    }
  }
  return false;
}

/**
 * Does the xz box [x0, x1] × [z0, z1] (any torus image) come near a bore?
 * The cheap gate in front of losClear's sampled path.
 */
export function boxNearTunnel(
  x0: number,
  x1: number,
  z0: number,
  z1: number,
): boolean {
  const cx = (x0 + x1) / 2;
  const cz = (z0 + z1) / 2;
  const hx = (x1 - x0) / 2;
  const hz = (z1 - z0) / 2;
  for (let k = 0; k < TUNNELS.length; k++) {
    const t = TUNNELS[k] as Tunnel;
    for (const g of t.segs) {
      if (
        Math.abs(wrapDeltaAxis(g.bx, cx)) <= g.hx + hx &&
        Math.abs(wrapDeltaAxis(g.bz, cz)) <= g.hz + hz
      ) {
        return true;
      }
    }
  }
  return false;
}

// --- Mouths -------------------------------------------------------------------

/** A plaza portal's open cut, canonical axis-aligned rectangle. */
export interface PortalCut {
  tunnel: number;
  /** Which end (0: s = 0, 1: s = L). */
  end: 0 | 1;
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  /** The lip (street-level end of the ramp), canonical, and the heading a
   * plane flies to dive in (down the ramp). */
  lipX: number;
  lipZ: number;
  inHeading: number;
}

/** A river mouth: the opening in an embankment wall. */
export interface RiverMouth {
  tunnel: number;
  end: 0 | 1;
  /** −1: the low-z wall, +1: the high-z wall. */
  side: -1 | 1;
  /** Canonical x range of the opening along the wall, and its centre. */
  x0: number;
  x1: number;
  x: number;
  /** Clear opening, m: the water to the lintel. */
  y0: number;
  y1: number;
  /** Arc length where the bore crosses the wall. */
  s: number;
  /** The heading a plane flies to enter. */
  inHeading: number;
}

const wrap = (v: number): number =>
  ((v % WORLD_SIZE) + WORLD_SIZE) % WORLD_SIZE;

const scratchPt: TunnelPoint = { x: 0, z: 0, th: 0 };

function buildMouths(): { cuts: PortalCut[]; mouths: RiverMouth[] } {
  const cuts: PortalCut[] = [];
  const mouths: RiverMouth[] = [];
  for (const t of TUNNELS) {
    for (const end of [0, 1] as const) {
      const e = t.ends[end];
      const sEnd = end === 0 ? 0 : t.length;
      const p = tunnelPointInto(t, sEnd, { x: 0, z: 0, th: 0 });
      // Heading INTO the bore from this end.
      const inHeading = wrapAngle(end === 0 ? p.th : p.th + Math.PI);
      if (e.kind === "plaza") {
        const q = tunnelPointInto(
          t,
          end === 0 ? CUT_LENGTH : t.length - CUT_LENGTH,
          scratchPt,
        );
        const half = BORE_WIDTH / 2;
        const alongX = Math.abs(Math.cos(p.th)) > 0.5;
        const xs = [p.x, q.x];
        const zs = [p.z, q.z];
        const x0 = Math.min(...xs) - (alongX ? 0 : half);
        const x1 = Math.max(...xs) + (alongX ? 0 : half);
        const z0 = Math.min(...zs) - (alongX ? half : 0);
        const z1 = Math.max(...zs) + (alongX ? half : 0);
        const ox = wrap(x0) - x0;
        const oz = wrap(z0) - z0;
        cuts.push({
          tunnel: t.id,
          end,
          x0: x0 + ox,
          x1: x1 + ox,
          z0: z0 + oz,
          z1: z1 + oz,
          lipX: wrap(p.x),
          lipZ: wrap(p.z),
          inHeading,
        });
      } else {
        const sWall = end === 0 ? e.wall : t.length - e.wall;
        const w = tunnelPointInto(t, sWall, { x: 0, z: 0, th: 0 });
        const half = BORE_WIDTH / 2 / Math.abs(Math.sin(w.th));
        const x = wrap(w.x);
        const side = riverOffset(w.z) < 0 ? -1 : 1;
        mouths.push({
          tunnel: t.id,
          end,
          side,
          x0: x - half,
          x1: x + half,
          x,
          y0: RIVER_WATER_Y,
          y1: ceilingAt(t, sWall),
          s: sWall,
          inHeading,
        });
      }
    }
  }
  return { cuts, mouths };
}

const MOUTHS = buildMouths();
/** Every plaza portal's open cut. */
export const PORTAL_CUTS: readonly PortalCut[] = MOUTHS.cuts;
/** Every river mouth. */
export const RIVER_MOUTHS: readonly RiverMouth[] = MOUTHS.mouths;

/** Is (x, z) inside a plaza portal's open cut, grown by `margin`? */
export function inPortalCut(x: number, z: number, margin = 0): boolean {
  for (const c of PORTAL_CUTS) {
    const dx = wrapDeltaAxis((c.x0 + c.x1) / 2, x);
    const dz = wrapDeltaAxis((c.z0 + c.z1) / 2, z);
    if (
      Math.abs(dx) <= (c.x1 - c.x0) / 2 + margin &&
      Math.abs(dz) <= (c.z1 - c.z0) / 2 + margin
    ) {
      return true;
    }
  }
  return false;
}

/**
 * The lowest altitude a plane can legally be at above (x, z), m: the bores'
 * floor over a tunnel's footprint, else the river's (the water over the
 * channel, street level elsewhere). The server's pose clamp uses it.
 */
export function groundFloor(x: number, z: number, riverFloor: number): number {
  return overTunnel(x, z, 2) ? BORE_FLOOR_Y : riverFloor;
}

// --- The bots' graph ------------------------------------------------------------

/**
 * One directed pass through a bore: an edge of the bots' street graph, like
 * a hole's (holes.ts holeEdges). `dir` +1 flies s = 0 → L.
 */
export interface TunnelEdge {
  tunnel: Tunnel;
  dir: 1 | -1;
  /** The end it enters by and leaves by. */
  endIn: TunnelEnd;
  endOut: TunnelEnd;
  /** Where the centreline meets them (canonical), at guide height. */
  mouthIn: Vec3;
  mouthOut: Vec3;
}

/** Both directed edges of every bore, in TUNNELS order (+1 first). */
export function tunnelEdges(): TunnelEdge[] {
  const out: TunnelEdge[] = [];
  for (const t of TUNNELS) {
    const a = tunnelPointInto(t, 0, { x: 0, z: 0, th: 0 });
    const b = tunnelPointInto(t, t.length, { x: 0, z: 0, th: 0 });
    const pa = { x: wrap(a.x), y: guideY(t, 0), z: wrap(a.z) };
    const pb = { x: wrap(b.x), y: guideY(t, t.length), z: wrap(b.z) };
    out.push({
      tunnel: t,
      dir: 1,
      endIn: t.ends[0],
      endOut: t.ends[1],
      mouthIn: pa,
      mouthOut: pb,
    });
    out.push({
      tunnel: t,
      dir: -1,
      endIn: t.ends[1],
      endOut: t.ends[0],
      mouthIn: pb,
      mouthOut: pa,
    });
  }
  return out;
}

/** Distance flown along `edge` at arc length `s` (negative before its entry). */
export const edgeProgress = (edge: TunnelEdge, s: number): number =>
  edge.dir === 1 ? s : edge.tunnel.length - s;

/** The arc length `progress` along `edge`. */
export const edgeArc = (edge: TunnelEdge, progress: number): number =>
  edge.dir === 1 ? progress : edge.tunnel.length - progress;

const fa: TunnelFrame = { s: 0, lat: 0, th: 0 };
const fb: TunnelFrame = { s: 0, lat: 0, th: 0 };

/**
 * Did the straight move a → b pass `t`'s mid-section inside the bore?
 * Returns the travel direction along s (+1 / −1), or 0 for no transit — the
 * bots' transit tracking, like holes.ts segmentThroughHole.
 */
export function tunnelTransit(t: Tunnel, a: Vec3, b: Vec3): 0 | 1 | -1 {
  if (a.y > 0 && b.y > 0) return 0;
  const mid = t.length / 2;
  tunnelFrameInto(t, a, fa);
  tunnelFrameInto(t, b, fb);
  if (fa.s === fb.s || Math.sign(fa.s - mid) === Math.sign(fb.s - mid)) {
    return 0;
  }
  if (Math.abs(fb.s - fa.s) > 4 * BORE_WIDTH) return 0;
  const half = BORE_WIDTH / 2 + 2;
  if (Math.abs(fa.lat) > half || Math.abs(fb.lat) > half) return 0;
  const y = (a.y + b.y) / 2;
  const f = floorAt(t, mid);
  if (y < f - 2 || y > f + BORE_HEIGHT + 2) return 0;
  return fb.s > fa.s ? 1 : -1;
}

/** Is `p` inside some bore below street level (its cut excluded above 0)?
 * Returns the tunnel, or null. */
export function tunnelAt(p: Vec3): Tunnel | null {
  if (p.y >= 0) return null;
  for (const t of TUNNELS) {
    tunnelFrameInto(t, p, fa);
    if (fa.s < 0 || fa.s > t.length) continue;
    if (Math.abs(fa.lat) > BORE_WIDTH / 2 + 1) continue;
    if (p.y < floorAt(t, fa.s) - 1) continue;
    if (p.y > ceilingAt(t, fa.s) + 1) continue;
    return t;
  }
  return null;
}

/**
 * Is `p` under cover in a bore — inside one, under its ceiling (not in an
 * open cut or out in the channel)? Rain and other sky effects stop there.
 */
export function underCover(p: Vec3): boolean {
  if (p.y >= -LINTEL_MIN) return false;
  for (const t of TUNNELS) {
    tunnelFrameInto(t, p, fa);
    if (fa.s < 0 || fa.s > t.length || inCut(t, fa.s)) continue;
    if (Math.abs(fa.lat) > BORE_WIDTH / 2 + 1) continue;
    if (p.y > ceilingAt(t, fa.s) + 1 || p.y < floorAt(t, fa.s) - 1) continue;
    // A river mouth's in-channel stretch is open river, not cover.
    const e = t.ends;
    if (e[0].kind === "river" && fa.s < e[0].wall) continue;
    if (e[1].kind === "river" && fa.s > t.length - e[1].wall) {
      continue;
    }
    return true;
  }
  return false;
}

// --- The drawn section (the renderer's one source) --------------------------

/**
 * Where a bore's side wall begins at a river-mouth end: the arc length at
 * which that wall (lateral `side` × BORE_WIDTH / 2) meets the embankment
 * wall plane. The wall is oblique to the bore, so the two sides differ.
 * A plaza end's walls begin at the end itself.
 */
export function wallStart(t: Tunnel, end: 0 | 1, side: 1 | -1): number {
  const e = t.ends[end];
  if (e.kind !== "river") return end === 0 ? 0 : t.length;
  // Bisect on |riverOffset| crossing the wall line, inside the sill (where
  // the floor still holds at the water, both sides past the wall).
  const flat = e.flat;
  let lo = end === 0 ? 0 : t.length;
  let hi = end === 0 ? flat : t.length - flat;
  const off = (s: number) => {
    tunnelPointInto(t, s, scratchPt);
    const z = scratchPt.z + side * (BORE_WIDTH / 2) * nz(scratchPt.th);
    return Math.abs(riverOffset(z)) - RIVER_HALF_WIDTH;
  };
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (off(mid) < 0) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** One drawn cross-section: the two wall feet (unwrapped x/z), the floor,
 * and the wall top — the ceiling over a covered bore, street level over a
 * cut. */
export interface TunnelSection {
  lx: number;
  lz: number;
  rx: number;
  rz: number;
  floor: number;
  top: number;
  covered: boolean;
}

/** The section at `s`. `covered` says whether to take the ceiling (pass the
 * classification of the strip being drawn, so a strip that ends on the cut
 * boundary keeps its own top). */
export function tunnelSectionInto(
  t: Tunnel,
  s: number,
  covered: boolean,
  out: TunnelSection,
): TunnelSection {
  tunnelPointInto(t, s, scratchPt);
  const h = BORE_WIDTH / 2;
  const ox = nx(scratchPt.th) * h;
  const oz = nz(scratchPt.th) * h;
  out.lx = scratchPt.x + ox;
  out.lz = scratchPt.z + oz;
  out.rx = scratchPt.x - ox;
  out.rz = scratchPt.z - oz;
  out.floor = floorAt(t, s);
  out.covered = covered;
  out.top = covered ? Math.min(out.floor + BORE_HEIGHT, -LINTEL_MIN) : 0;
  return out;
}

/** Drawing step along a bore, m (the chord sag on a 300 m bend is 7 mm). */
export const SECTION_STEP = 4;

/**
 * The arc lengths a bore is drawn at: every SECTION_STEP, plus every place
 * the profile or the path changes slope (cut ends, sills, ramp feet, the
 * lintel clamp, leg joints) and the river walls' starts. Sorted, unique.
 */
export function tunnelSamples(t: Tunnel): number[] {
  const L = t.length;
  const set = new Set<number>();
  for (let s = 0; s < L; s += SECTION_STEP) set.add(s);
  set.add(L);
  const [a, b] = t.ends;
  const breaks = [
    a.cut,
    L - b.cut,
    a.flat,
    L - b.flat,
    a.flat + (a.top - BORE_FLOOR_Y) / RAMP_GRADE,
    L - b.flat - (b.top - BORE_FLOOR_Y) / RAMP_GRADE,
    a.flat + Math.max(0, a.top + BORE_HEIGHT + LINTEL_MIN) / RAMP_GRADE,
    L - b.flat - Math.max(0, b.top + BORE_HEIGHT + LINTEL_MIN) / RAMP_GRADE,
    wallStart(t, 0, 1),
    wallStart(t, 0, -1),
    wallStart(t, 1, 1),
    wallStart(t, 1, -1),
  ];
  for (const g of t.segs) breaks.push(g.s0);
  for (const s of breaks) if (s > 0 && s < L) set.add(s);
  return [...set].sort((x, y) => x - y);
}
