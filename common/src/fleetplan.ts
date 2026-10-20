// K1 the war in the streets — the fleet's fit to the city (the pure half).
// Z1's lanes are now avenues and rooftop lines (common/src/boss.ts), and a
// lane is only as good as its clearance: this file proves every lane clear
// of what the city puts in its way, or plans where the ship smashes through.
//
//  - laneClearance(lane, world): everything solid near the lane's line —
//    every building's solids (its tiers, setbacks and holes' walls, so the
//    facades), its roof structures (billboards, masts, tanks, nests), the
//    static boxes (river bridges and piers, the elevated train's viaduct),
//    the tower cranes, the aircraft routes (helicopters, the blimp), the
//    standing props and the news heli's band. A STREET lane flies one
//    altitude: any unbreakable thing inside its hull's reach is a conflict,
//    and a crane or a prop there is a planned BREAK-THROUGH (the ship
//    smashes it as it passes). A ROOFTOP lane follows the skyline: its
//    profile is the lowest altitude, eased to FLEET_ROOF_SLOPE, that keeps
//    FLEET_ROOF_CLEAR over everything under it — anything that would push
//    it out of its band is a conflict.
//  - planFleet(world): every lane's profile and breaks — the FleetPlan both
//    sides install (boss.ts installFleetPlan). A pure function of the
//    generated city and its movers: no trig, no Math.random, only +, ×, max
//    and min on the same doubles, so client and server build it bit for bit.
//  - breakTouchIn(ship, brk, obstacle, from, to): on the ship's own
//    deterministic course, the first instant its hull meets a break's
//    obstacle — a crane is checked at its slew of that instant. The server
//    fells the crane (or knocks the prop down) just before it
//    (server/src/boss.ts dueBreaks), so a hull is never drawn through one.
//
// Not re-exported from common/src/index.ts; import
// "@angels-bandits/common/fleetplan".

import {
  FLEET_LANES,
  FLEET_LAYERS,
  FLEET_PROFILE_STEP,
  FLEET_ROOF_CLEAR,
  FLEET_ROOF_SLOPE,
  type FleetLane,
  type FleetLayer,
  type FleetPlan,
  type FleetShip,
  type LaneBreak,
  MOOR_SWAY_BOB,
  MOOR_SWING,
  PATH_LINE,
  PATH_MOOR,
  PATH_ORBIT,
  SHIP_REACH,
  type ShipReach,
  fleetPoseInto64,
  shipAlong,
} from "./boss";
import { type Building, baseSolids } from "./city/index";
import {
  type AircraftRoute,
  type CraneSite,
  type MoverBox,
  type MoverField,
  craneBoxesAt,
  slewAngle,
} from "./city/movers";
import type { Prop } from "./city/props";
import { bridgeBoxes, pierBoxes } from "./city/river";
import { generatedRoof } from "./city/standing";
import type { TrainLine } from "./city/train";
import { HELI_HULL, NEWS_HELI_ALT_MIN } from "./constants";
import { wrapCoord, wrapDeltaAxis } from "./world/index";

/** Horizontal and vertical margin every lane keeps to anything solid, m. */
export const LANE_MARGIN_XZ = 2;
export const LANE_MARGIN_Y = 3;
/** A helicopter's rotor blur reaches this many hull half-heights above and
 * below its centre (newsheli.test.ts's reckoning). */
const ROTOR_BLUR = 1.3;

/** An axis-aligned solid, canonical centre, m. */
export interface StaticBox {
  x: number;
  z: number;
  hx: number;
  hz: number;
  y0: number;
  y1: number;
}

/** What the fleet is fitted to: the generated city (intact) and what moves
 * through it. Everything but the buildings is optional (a hand-built test
 * city has none of it). */
export interface FleetWorld {
  buildings: readonly Building[];
  cranes?: readonly CraneSite[];
  aircraft?: readonly AircraftRoute[];
  /** Static solids that are not buildings: river bridges and piers, the
   * train viaducts (fleetWorldOf collects them). */
  statics?: readonly StaticBox[];
  /** The standing props (D9) — breakable. */
  props?: readonly Prop[];
}

/** The world the fleet is fitted to, from the generated city and its
 * movers (and its props, when the caller has them). */
export function fleetWorldOf(
  buildings: readonly Building[],
  movers?: MoverField | null,
  props?: readonly Prop[],
): FleetWorld {
  const statics: StaticBox[] = [];
  for (const b of [...bridgeBoxes(), ...pierBoxes()]) statics.push({ ...b });
  for (const line of movers?.trains ?? []) statics.push(...viaductBoxes(line));
  return {
    buildings,
    cranes: movers?.cranes ?? [],
    aircraft: movers?.aircraft ?? [],
    statics,
    ...(props && { props }),
  };
}

/** A train line's viaduct as plan-view AABBs (its own extents). */
function viaductBoxes(line: TrainLine): StaticBox[] {
  return line.viaduct.map((b: MoverBox, i) => ({
    x: b.x,
    z: b.z,
    hx: line.extents[i * 2] as number,
    hz: line.extents[i * 2 + 1] as number,
    y0: b.y - b.hy,
    y1: b.y + b.hy,
  }));
}

/** Something unbreakable a lane meets: what, where along the lane, and
 * the altitude band it fills there. */
export interface LaneConflict {
  what: string;
  s: number;
  y0: number;
  y1: number;
}

/** A lane fitted to the world. */
export interface LaneClearance {
  /** A rooftop lane's profile (FleetPlan.alt), or null. */
  alt: Float64Array | null;
  /** The planned break-throughs, ascending along the lane. */
  breaks: LaneBreak[];
  /** Everything unbreakable the lane cannot clear (none, for a lane fit to
   * fly). */
  conflicts: LaneConflict[];
  /** The least separation from the hull's bounds to anything unbreakable
   * it passes, m: the larger of the horizontal and vertical gaps. */
  clearance: number;
}

/** The lane's frame: its line's coordinate across, its length along. */
interface Frame {
  ln: FleetLane;
  ly: FleetLayer;
  reach: ShipReach;
  /** Lane runs along +x (else +z). */
  alongX: boolean;
}

const frameOf = (lane: number): Frame => {
  const ln = FLEET_LANES[lane] as FleetLane;
  const ly = FLEET_LAYERS[ln.layer] as FleetLayer;
  return {
    ln,
    ly,
    reach: SHIP_REACH[ln.cls] as ShipReach,
    alongX: ly.dz === 0,
  };
};

/** `v` taken round a lane of length `len`, into [0, len). */
const wrapLen = (v: number, len: number): number => {
  const m = v % len;
  return m < 0 ? m + len : m;
};
/** Signed shortest offset from `a` to `b` round a lane of length `len`. */
const deltaLen = (a: number, b: number, len: number): number => {
  const d = wrapLen(b - a, len);
  return d >= len / 2 ? d - len : d;
};

/** One solid as the lane sees it: its centre along (canonical), half
 * extent along, its gap across from the lane's line (≥ 0), and its band. */
interface Seen {
  what: string;
  s: number;
  half: number;
  gap: number;
  y0: number;
  y1: number;
  brk: LaneBreak | null;
}

/** One solid of the world as a plan box: what it is, its canonical centre,
 * its half extents, its band and — for a crane or a prop — the break that
 * smashes it. */
type SolidVisit = (
  what: string,
  x: number,
  z: number,
  hx: number,
  hz: number,
  y0: number,
  y1: number,
  brk: LaneBreak | null,
) => void;

/** Every solid of `world` — building solids and roof structures as
 * generated, statics, cranes (their whole reach, at any slew) and props —
 * as plan boxes. `alongX` sets the axis a break's `s` and `half` run on. */
function forEachSolid(
  world: FleetWorld,
  alongX: boolean,
  visit: SolidVisit,
): void {
  // As generated: the plan is fitted to the city before any of it breaks
  // (damage only ever takes solids away), so both sides fit the same one
  // whenever they build it.
  world.buildings.forEach((b, i) => {
    for (const sb of baseSolids(b)) {
      visit(
        `building ${i}`,
        b.x + sb.dx,
        b.z + sb.dz,
        sb.width / 2,
        sb.depth / 2,
        sb.baseY,
        sb.baseY + sb.height,
        null,
      );
    }
    for (const r of generatedRoof(b) ?? []) {
      visit(
        `roof ${i} ${r.kind}`,
        b.x + r.dx,
        b.z + r.dz,
        r.width / 2,
        r.depth / 2,
        r.baseY,
        r.baseY + r.height,
        null,
      );
    }
  });
  for (const st of world.statics ?? []) {
    visit("static", st.x, st.z, st.hx, st.hz, st.y0, st.y1, null);
  }
  for (const site of world.cranes ?? []) {
    // Everything the crane can swing — jib, counter-jib, trolley cable,
    // hook — lies inside this cylinder round its mast, at any slew.
    const r = craneReach(site);
    const brk: LaneBreak = {
      kind: "crane",
      id: site.id,
      s: wrapCoord(alongX ? site.x : site.z),
      half: r,
    };
    visit(`crane ${site.id}`, site.x, site.z, r, r, 0, craneTop(site), brk);
  }
  for (const p of world.props ?? []) {
    const brk: LaneBreak = {
      kind: "prop",
      id: p.id,
      s: wrapCoord(alongX ? p.x : p.z),
      half: alongX ? p.hx : p.hz,
    };
    visit(`prop ${p.id}`, p.x, p.z, p.hx, p.hz, p.y - p.hy, p.y + p.hy, brk);
  }
}

/** Every solid within `reach` across of the lane's line. */
function seenBy(f: Frame, world: FleetWorld, reach: number): Seen[] {
  const out: Seen[] = [];
  const cross = f.ln.cross;
  forEachSolid(world, f.alongX, (what, x, z, hx, hz, y0, y1, brk) => {
    const c = f.alongX ? z : x;
    const hc = f.alongX ? hz : hx;
    const gap = Math.max(0, Math.abs(wrapDeltaAxis(cross, c)) - hc);
    if (gap >= reach) return;
    out.push({
      what,
      s: wrapCoord(f.alongX ? x : z),
      half: f.alongX ? hx : hz,
      gap,
      y0,
      y1,
      brk,
    });
  });
  return out;
}

/** How far any part of a crane reaches from its mast's axis, m. */
export const craneReach = (site: CraneSite): number =>
  Math.max(site.jibLength, site.counterLength, site.trolleyR) +
  // A box's corner off its own axis: half its side, both ways.
  (CRANE_SIDE_MAX / 2) * Math.SQRT2;
/** The thickest crane part across (CRANE_MAST_SIDE / CRANE_JIB_SIDE), m. */
const CRANE_SIDE_MAX = 6;
/** The top of a crane's highest part (its jib), m. */
const craneTop = (site: CraneSite): number => site.hubY + CRANE_SIDE_MAX / 2;

/** An aircraft route's band, rotor blur included for a helicopter. */
const routeBand = (r: AircraftRoute): [number, number] => {
  const hy = r.kind === "helicopter" ? r.hy * ROTOR_BLUR : r.hy;
  return [r.y - hy, r.y + hy];
};

/**
 * K1: lane `lane` against `world` — its rooftop profile (null for a street
 * lane), its planned break-throughs, what it cannot clear, and how much it
 * clears everything else by. Pure. T1: an orbit or a berth is checked
 * round its tower (towerClearance).
 */
export function laneClearance(lane: number, world: FleetWorld): LaneClearance {
  const f = frameOf(lane);
  if (f.ly.path !== PATH_LINE) return towerClearance(f, world);
  const { ln, ly, reach } = f;
  const len = ly.length;
  const across = reach.z + LANE_MARGIN_XZ;
  const seen = seenBy(f, world, across);
  const conflicts: LaneConflict[] = [];
  const breaks: LaneBreak[] = [];
  let clearance = Number.POSITIVE_INFINITY;
  let alt: Float64Array | null = null;

  if (ly.street) {
    const bottom = ln.alt - reach.y;
    const top = ln.alt + reach.y;
    for (const o of seen) {
      const vgap = Math.max(o.y0 - top, bottom - o.y1);
      if (vgap < LANE_MARGIN_Y) {
        if (o.brk) {
          if (
            !breaks.some((b) => b.kind === o.brk?.kind && b.id === o.brk.id)
          ) {
            breaks.push(o.brk);
          }
          continue;
        }
        conflicts.push({ what: o.what, s: o.s, y0: o.y0, y1: o.y1 });
      }
      if (!o.brk) {
        clearance = Math.min(clearance, Math.max(vgap, o.gap - reach.z));
      }
    }
  } else {
    // The rooftops: the least altitude over every sample, then eased.
    const n = Math.round(len / FLEET_PROFILE_STEP);
    const need = new Float64Array(n);
    need.fill(ly.band[0] + reach.y);
    const span = reach.x + LANE_MARGIN_XZ + FLEET_PROFILE_STEP;
    for (const o of seen) {
      const want = o.y1 + FLEET_ROOF_CLEAR + reach.y;
      const from = Math.floor((o.s - o.half - span) / FLEET_PROFILE_STEP);
      const to = Math.ceil((o.s + o.half + span) / FLEET_PROFILE_STEP);
      for (let k = from; k <= to; k++) {
        const i = wrapLen(k, n);
        if ((need[i] as number) < want) need[i] = want;
      }
    }
    alt = easeProfile(need, FLEET_ROOF_SLOPE * FLEET_PROFILE_STEP);
    const top = ly.band[1] - reach.y;
    for (let i = 0; i < n; i++) {
      if ((alt[i] as number) > top + 1e-9) {
        // Name what pushed it up: the tallest thing under that sample.
        let worst: Seen | null = null;
        for (const o of seen) {
          const d = Math.abs(deltaLen(o.s, i * FLEET_PROFILE_STEP, len));
          if (d > o.half + span) continue;
          if (!worst || o.y1 > worst.y1) worst = o;
        }
        conflicts.push({
          what: worst?.what ?? "band",
          s: i * FLEET_PROFILE_STEP,
          y0: worst?.y0 ?? 0,
          y1: worst?.y1 ?? 0,
        });
      }
    }
    // What it clears everything by, where it passes it.
    for (const o of seen) {
      let gap = Number.POSITIVE_INFINITY;
      const from = Math.floor((o.s - o.half - reach.x) / FLEET_PROFILE_STEP);
      const to = Math.ceil((o.s + o.half + reach.x) / FLEET_PROFILE_STEP);
      for (let k = from; k <= to; k++) {
        const a = alt[wrapLen(k, n)] as number;
        gap = Math.min(gap, a - reach.y - o.y1);
      }
      clearance = Math.min(clearance, Math.max(gap, o.gap - reach.z));
    }
  }

  // The aircraft: a route parallel to the lane passes beside it (or not);
  // one across it crosses it somewhere, so only altitude keeps them apart.
  const lo = profileMin(alt, ln.alt) - reach.y;
  const hi = profileMax(alt, ln.alt) + reach.y;
  for (const r of world.aircraft ?? []) {
    const [y0, y1] = routeBand(r);
    const vgap = Math.max(y0 - hi, lo - y1);
    const parallel = (r.axis === "x") === f.alongX;
    const hgap = parallel
      ? Math.abs(wrapDeltaAxis(ln.cross, r.cross)) - r.hz - reach.z
      : Number.NEGATIVE_INFINITY;
    if (vgap < LANE_MARGIN_Y && hgap < LANE_MARGIN_XZ) {
      conflicts.push({ what: `${r.kind} ${r.id}`, s: 0, y0, y1 });
    }
    clearance = Math.min(clearance, Math.max(vgap, hgap));
  }
  // The news heli roams anywhere over the city: altitude alone.
  const newsBelly = NEWS_HELI_ALT_MIN - (HELI_HULL[1] as number);
  if (hi > newsBelly - LANE_MARGIN_Y) {
    conflicts.push({ what: "news heli", s: 0, y0: newsBelly, y1: newsBelly });
  }
  clearance = Math.min(clearance, newsBelly - hi);

  breaks.sort((a, b) => a.s - b.s || a.id - b.id);
  return { alt, breaks, conflicts, clearance };
}

/**
 * T1: an orbit or a berth against `world`. Neither ever smashes anything (a
 * crane or a prop in its reach is a conflict like any solid), and both fly
 * one altitude (a berth ± its bob):
 *  - an orbit sweeps an annulus round its tower: the hull's beam reaches no
 *    nearer the centre than r − its half-beam, its bow and stern no further
 *    than √((r + half-beam)² + half-length²); a solid conflicts when its
 *    plan box's distances from the centre meet that annulus and its band
 *    meets the hull's;
 *  - a berth holds one plan rectangle, grown by its sway (MOOR_SWING of its
 *    half-length at the ends);
 * and the aircraft routes, a line each, are checked against the same
 * footprint, the news heli by altitude alone.
 */
function towerClearance(f: Frame, world: FleetWorld): LaneClearance {
  const { ln, ly, reach } = f;
  const conflicts: LaneConflict[] = [];
  let clearance = Number.POSITIVE_INFINITY;
  const bob = ly.path === PATH_MOOR ? MOOR_SWAY_BOB : 0;
  const lo = ln.alt - reach.y - bob;
  const hi = ln.alt + reach.y + bob;
  const orbit = ly.path === PATH_ORBIT;
  const rIn = ln.r - reach.z;
  const rOut = Math.hypot(ln.r + reach.z, reach.x);
  // A berth's footprint, world axes: along its heading (x for yaw 0).
  const sx = Math.abs(Math.cos(ln.yaw));
  const sz = Math.abs(Math.sin(ln.yaw));
  const swing = reach.x * MOOR_SWING;
  const ex = reach.x * sx + reach.z * sz + swing;
  const ez = reach.x * sz + reach.z * sx + swing;
  /** Plan gap from the hull's footprint to a box (≤ 0: they overlap). */
  const planGap = (x: number, z: number, hx: number, hz: number): number => {
    const dx = Math.abs(wrapDeltaAxis(ln.cx, x));
    const dz = Math.abs(wrapDeltaAxis(ln.cz, z));
    if (!orbit) return Math.max(dx - hx - ex, dz - hz - ez);
    const near = Math.hypot(Math.max(0, dx - hx), Math.max(0, dz - hz));
    const far = Math.hypot(dx + hx, dz + hz);
    return Math.max(rIn - far, near - rOut);
  };
  forEachSolid(world, true, (what, x, z, hx, hz, y0, y1) => {
    const gap = planGap(x, z, hx, hz);
    if (gap > 400) return;
    const vgap = Math.max(y0 - hi, lo - y1);
    if (gap < LANE_MARGIN_XZ && vgap < LANE_MARGIN_Y) {
      conflicts.push({ what, s: 0, y0, y1 });
    }
    clearance = Math.min(clearance, Math.max(vgap, gap));
  });
  // The aircraft: a route is a line along its axis, at its band.
  for (const r of world.aircraft ?? []) {
    const [y0, y1] = routeBand(r);
    const vgap = Math.max(y0 - hi, lo - y1);
    const off = Math.abs(
      wrapDeltaAxis(r.axis === "x" ? ln.cz : ln.cx, r.cross),
    );
    const half = orbit ? rOut : r.axis === "x" ? ez : ex;
    const hgap = off - r.hz - half;
    if (vgap < LANE_MARGIN_Y && hgap < LANE_MARGIN_XZ) {
      conflicts.push({ what: `${r.kind} ${r.id}`, s: 0, y0, y1 });
    }
    clearance = Math.min(clearance, Math.max(vgap, hgap));
  }
  // The news heli roams anywhere over the city: altitude alone.
  const newsBelly = NEWS_HELI_ALT_MIN - (HELI_HULL[1] as number);
  if (hi > newsBelly - LANE_MARGIN_Y) {
    conflicts.push({ what: "news heli", s: 0, y0: newsBelly, y1: newsBelly });
  }
  clearance = Math.min(clearance, newsBelly - hi);
  return { alt: null, breaks: [], conflicts, clearance };
}

const profileMax = (p: Float64Array | null, fallback: number): number => {
  if (!p) return fallback;
  let m = Number.NEGATIVE_INFINITY;
  for (const a of p) m = Math.max(m, a);
  return m;
};
const profileMin = (p: Float64Array | null, fallback: number): number => {
  if (!p) return fallback;
  let m = Number.POSITIVE_INFINITY;
  for (const a of p) m = Math.min(m, a);
  return m;
};

/**
 * The least profile ≥ `need` everywhere whose step-to-step change is at
 * most `rise` — a closed loop, so it is eased round the seam too: two
 * passes each way settle every peak's slopes on both sides of it.
 */
export function easeProfile(need: Float64Array, rise: number): Float64Array {
  const n = need.length;
  const out = Float64Array.from(need);
  for (let pass = 0; pass < 2; pass++) {
    for (let k = 1; k <= n; k++) {
      const i = k % n;
      const prev = (out[k - 1] as number) - rise;
      if ((out[i] as number) < prev) out[i] = prev;
    }
    for (let k = n - 2; k >= -1; k--) {
      const i = wrapLen(k, n);
      const next = (out[(i + 1) % n] as number) - rise;
      if ((out[i] as number) < next) out[i] = next;
    }
  }
  return out;
}

/** K1: the fleet fitted to `world` — what both sides install. Pure. */
export function planFleet(world: FleetWorld): FleetPlan {
  const fits = FLEET_LANES.map((_, i) => laneClearance(i, world));
  return {
    alt: fits.map((c) => c.alt),
    breaks: fits.map((c) => c.breaks),
  };
}

// --- Break-throughs on the ship's course ------------------------------------

/** What a break is made of, as the server resolves it. */
export type BreakObstacle =
  | { kind: "crane"; site: CraneSite }
  | { kind: "prop"; prop: Prop };

/** A crane is checked this often through a pass, ms; the hull's bounds are
 * grown by what the jib's tip and the ship travel in that time. */
export const BREAK_SAMPLE_MS = 100;
/** The obstacle goes this long before the hull would touch it, ms. */
export const BREAK_LEAD_MS = 250;

/** Plan-view separating-axis test of the hull's lane-aligned bounds (centre
 * cx/cz, half extents ex/ez along world x/z) against an oriented box. */
function rectHitsBox(
  cx: number,
  cz: number,
  ex: number,
  ez: number,
  b: MoverBox,
): boolean {
  const dx = wrapDeltaAxis(cx, b.x);
  const dz = wrapDeltaAxis(cz, b.z);
  const c = Math.cos(b.yaw);
  const s = Math.sin(b.yaw);
  // The box's own axes in the world: u = (c, −s), w = (s, c).
  const ac = Math.abs(c);
  const as = Math.abs(s);
  // World axes.
  if (Math.abs(dx) > ex + ac * b.hx + as * b.hz) return false;
  if (Math.abs(dz) > ez + as * b.hx + ac * b.hz) return false;
  // The box's axes.
  if (Math.abs(dx * c - dz * s) > b.hx + ex * ac + ez * as) return false;
  if (Math.abs(dx * s + dz * c) > b.hz + ex * as + ez * ac) return false;
  return true;
}

const touchPose = new Float64Array(7);

/** The hull-vs-obstacle reach along the lane, m: how far apart their
 * centres are along it when the hull's bounds first (or last) reach the
 * obstacle's. */
const passReach = (reach: ShipReach, brk: LaneBreak, grow: number): number =>
  reach.x + brk.half + LANE_MARGIN_XZ + grow;

/**
 * K1: when the pass of `ship` by break `brk` that is under way (or next)
 * at `t` ends — its hull's tail clearing the obstacle's reach, ms. A pass
 * is smashed through once: the next touch is looked for after this.
 */
export function breakPassEnd(
  ship: FleetShip,
  brk: LaneBreak,
  t: number,
  grow = 0,
): number {
  const f = frameOf(ship.lane);
  const len = f.ly.length;
  const speed = Math.abs(f.ln.v);
  const at = shipAlong(ship, Math.max(t, ship.t0));
  const w = passReach(f.reach, brk, grow);
  let g = wrapLen((brk.s - at) * (f.ln.v < 0 ? -1 : 1), len);
  if (g > len - w) g -= len;
  return Math.max(t, ship.t0) + ((g + w) / speed) * 1000;
}

/**
 * K1: the first server time in [from, to] at which `ship`'s hull (its
 * class's bounds at its pose, grown by `grow` m) meets break `brk`'s
 * obstacle as it stands — a crane at its slew of that instant, sampled
 * every BREAK_SAMPLE_MS — or null. Only the ship's own course and the
 * clock go in: a pure function. Ignores whether the obstacle is still up
 * (the caller knows).
 */
export function breakTouchIn(
  ship: FleetShip,
  brk: LaneBreak,
  obstacle: BreakObstacle,
  from: number,
  to: number,
  grow = 0,
): number | null {
  const f = frameOf(ship.lane);
  const { ln, ly, reach } = f;
  const len = ly.length;
  const speed = Math.abs(ln.v);
  if (speed <= 0 || to < from) return null;
  // Forward distance from the hull's centre to the obstacle's at `from`.
  const at = shipAlong(ship, Math.max(from, ship.t0));
  const sg = ln.v < 0 ? -1 : 1;
  let g = wrapLen((brk.s - at) * sg, len);
  const w = passReach(reach, brk, grow);
  if (g > len - w) g -= len; // already alongside, from behind
  // The pass: from the nose reaching it to the tail clearing it.
  const t0 = Math.max(from, from + ((g - w) / speed) * 1000);
  const t1 = Math.min(to, from + ((g + w) / speed) * 1000);
  if (t1 < t0) return null;
  const slack = grow + LANE_MARGIN_XZ;
  for (let t = t0; ; t += BREAK_SAMPLE_MS) {
    const tt = Math.min(t, t1);
    fleetPoseInto64(ship, tt, touchPose, 0);
    const x = touchPose[0] as number;
    const y = touchPose[1] as number;
    const z = touchPose[2] as number;
    const ex = (f.alongX ? reach.x : reach.z) + slack;
    const ez = (f.alongX ? reach.z : reach.x) + slack;
    if (obstacle.kind === "crane") {
      const site = obstacle.site;
      // What the tip and the hull travel between samples.
      const pad =
        (Math.abs(site.omega) * craneReach(site) + speed) *
        (BREAK_SAMPLE_MS / 1000);
      for (const box of craneBoxesAt(site, slewAngle(site, tt))) {
        if (Math.abs(box.y - y) > box.hy + reach.y + LANE_MARGIN_Y) continue;
        if (rectHitsBox(x, z, ex + pad, ez + pad, box)) return tt;
      }
    } else {
      const p = obstacle.prop;
      if (
        Math.abs(p.y - y) <= p.hy + reach.y + LANE_MARGIN_Y &&
        Math.abs(wrapDeltaAxis(x, p.x)) <= ex + p.hx &&
        Math.abs(wrapDeltaAxis(z, p.z)) <= ez + p.hz
      ) {
        return tt;
      }
    }
    if (tt >= t1) return null;
  }
}
