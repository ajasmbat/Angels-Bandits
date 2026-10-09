// U6 cave-ins — the ceiling of a deep bore comes down, with warning, and a
// plane flying through has to dodge it. Shared verbatim by client and
// server, D3's idiom (city/collapse.ts) applied to the tunnels:
//
//   1. WHEN and WHERE are the server's (server/src/caveins.ts): it places a
//      cave-in ahead of a plane deep in a bore, or at random elsewhere
//      underground, and broadcasts one small event — `CaveIn`.
//   2. EVERYTHING ELSE is a pure function of that event and the synced
//      clock: `buildCaveIn` derives its pieces (rocks, concrete slabs, steel
//      beams) from the event alone, and `caveInPieceInto` is THE pose of a
//      piece at a time. The renderer draws exactly that box and
//      `collideCaveIns` collides exactly that box (draw == collide); a late
//      joiner rebuilds the same pieces from the same record.
//
// Own module rather than D3's Collapse: a collapse's pieces turn only about
// the world x/z axes round a building's centre, while a cave-in's sit in a
// curved bore's own frame (yawed along it).
//
// THE LIFE OF ONE (ms after t0):
//   0 … WARN          the warning: pieces sit in the ceiling, 0.3 m proud
//                     (inside the bore's lining, so never hit before the
//                     ceiling itself); clients rumble, shake, spill dust
//                     from the cracks over the blocked region and flicker
//                     the lamps there;
//   WARN … +STAGGER   pieces let go, bottom of each pile first, and fall
//                     tumbling onto the floor or the piece under them;
//   … + RUBBLE        rubble narrows the bore;
//   … + SINK          it settles into the floor and is gone.
//
// ALWAYS A GAP. Each cave-in leaves one of three 12 m lanes open — along
// the left wall, the right wall or down the middle (`gap`) — full height,
// through every phase. No piece's reach (over its whole tumble) ever
// crosses into the lane: common/test/caveins.test.ts proves it, and that a
// plane reacting 0.5 s after it can see the warning reaches the lane.
//
// TORUS. Pieces are placed from the bore's unwrapped centreline and
// stored canonical; every query measures through wrapDeltaAxis.
//
// Allocation-free on the query side (O5): collision runs in every bot
// probe and every crash check.

import {
  BOOST_MAX_SPEED,
  MAX_SPEED,
  MIN_SPEED,
  WORLD_SIZE,
} from "../constants";
import { type Vec3, wrapDeltaAxis } from "../world/index";
import { mulberry32 } from "./rng";
import {
  BORE_FLOOR_Y,
  BORE_HEIGHT,
  BORE_WIDTH,
  LINTEL_MIN,
  RAMP_GRADE,
  TUNNELS,
  type Tunnel,
  type TunnelPoint,
  tunnelPointInto,
} from "./tunnels";

// --- Timing and shape -----------------------------------------------------------

/** The warning, ms: rumble, dust and flicker before anything falls. */
export const CAVEIN_WARN_MS = 2000;
/** Pieces let go over this, ms after the warning (bottom of a pile first). */
export const CAVEIN_STAGGER_MS = 1000;
/** Rubble lies this long, ms, then settles into the floor over SINK. */
export const CAVEIN_RUBBLE_MS = 18_000;
export const CAVEIN_SINK_MS = 3000;
/** Fall acceleration, m/s² (a touch over g: rock reads heavy on screen). */
export const CAVEIN_GRAVITY = 12;
/** The zone along the bore, m: the event's s ± LEN / 2. */
export const CAVEIN_LEN = 20;
/** Width of the open lane, m: 2.4 × the 2.5 × PLAYER_RADIUS the floor asks. */
export const CAVEIN_GAP = 12;
/** The debris keeps this far off the lane's edge, m (curvature, rounding). */
export const CAVEIN_LANE_MARGIN = 0.6;
/** Placement ahead of a plane: its reference speed × this, s — the
 * warning plus the beat before it reaches the falling rock. */
export const CAVEIN_LEAD_S = 2.9;
/** Every plane heading into a zone sees at least this much warning at
 * BOOST_MAX_SPEED, s (the ticket's 1.2 s at cruise, at the fastest a plane
 * can go after placement). */
export const CAVEIN_FAIR_S = 1.2;
/** Live cave-ins in one bore keep at least this far apart, m (no S-bend of
 * two lanes, no rubble narrowing a second fall). */
export const CAVEIN_SEPARATION = 200;
/** Live cave-ins in a room, at most (the renderer's capacity). */
export const CAVEIN_MAX = 6;
/** Pieces per cave-in, at most. */
export const CAVEIN_PIECES_MAX = 48;

/** The open lane: 0 along the left wall (lat > 0), 1 along the right wall,
 * 2 down the middle. */
export type CaveInGap = 0 | 1 | 2;

const H = BORE_WIDTH / 2;
/** The deep bore's floor and ceiling. */
export const CAVEIN_FLOOR = BORE_FLOOR_Y;
export const CAVEIN_CEIL = Math.min(BORE_FLOOR_Y + BORE_HEIGHT, -LINTEL_MIN);
/** A piece sits this far proud of the ceiling through the warning, m. */
const PROUD = 0.3;
/** Lanes are drawn from the walls; the zone's piles in the rest. */
const ALONG_CELLS = 4;
const CELL_LAT = 5.8;
/** A cell's pile: at least PILE_MIN m, plus up to PILE_RAND, plus up to
 * PILE_WALL toward the wall; at most PILE_LAYERS pieces. */
const PILE_MIN = 3;
const PILE_RAND = 6;
const PILE_WALL = 5;
const PILE_LAYERS = 4;
const WARN_S = CAVEIN_WARN_MS / 1000;
const STAGGER_S = CAVEIN_STAGGER_MS / 1000;

/** The open lane's lateral bounds, m (+ left of +s). */
export function caveInLane(gap: CaveInGap): [number, number] {
  if (gap === 0) return [H - CAVEIN_GAP, H];
  if (gap === 1) return [-H, -H + CAVEIN_GAP];
  return [-CAVEIN_GAP / 2, CAVEIN_GAP / 2];
}

/** The lane's centre line, lateral m: what bots and H3 steer to. */
export const caveInGapLat = (gap: CaveInGap): number =>
  gap === 0 ? H - CAVEIN_GAP / 2 : gap === 1 ? -H + CAVEIN_GAP / 2 : 0;

/** The blocked regions across the bore, lateral [lo, hi] pairs. */
export function caveInDebris(gap: CaveInGap): [number, number][] {
  const m = CAVEIN_LANE_MARGIN;
  if (gap === 0) return [[-H, H - CAVEIN_GAP - m]];
  if (gap === 1) return [[-H + CAVEIN_GAP + m, H]];
  return [
    [-H, -CAVEIN_GAP / 2 - m],
    [CAVEIN_GAP / 2 + m, H],
  ];
}

// --- Where ------------------------------------------------------------------------

/** Stretches no cave-in may cover, by bore: Crosstown's metro hall (its
 * glass is the bore's wall there). */
const NO_GO: readonly { tunnel: number; s0: number; s1: number }[] = [
  { tunnel: 0, s0: 400, s1: 568 },
];

/** The arc lengths a cave-in's CENTRE may take in `t`: inside the deep,
 * covered run (floor at BORE_FLOOR_Y, under the full ceiling, past both
 * ramps and river sills) with the zone and a margin clear of either end,
 * less the no-go stretches. Sorted [s0, s1] intervals. */
export function caveInRanges(t: Tunnel): [number, number][] {
  const [a, b] = t.ends;
  const half = CAVEIN_LEN / 2 + 8;
  const d0 = a.flat + (a.top - BORE_FLOOR_Y) / RAMP_GRADE + half;
  const d1 = t.length - b.flat - (b.top - BORE_FLOOR_Y) / RAMP_GRADE - half;
  let out: [number, number][] = [[d0, d1]];
  for (const n of NO_GO) {
    if (n.tunnel !== t.id) continue;
    const next: [number, number][] = [];
    for (const [r0, r1] of out) {
      const c0 = n.s0 - CAVEIN_LEN / 2;
      const c1 = n.s1 + CAVEIN_LEN / 2;
      if (r1 <= c0 || r0 >= c1) next.push([r0, r1]);
      else {
        if (r0 < c0) next.push([r0, c0]);
        if (r1 > c1) next.push([c1, r1]);
      }
    }
    out = next;
  }
  return out;
}

const RANGES: readonly (readonly [number, number][])[] = TUNNELS.map((t) =>
  caveInRanges(t),
);

/** May a cave-in be centred at `s` in bore `tunnel`? */
export function caveInSpotOk(tunnel: number, s: number): boolean {
  const r = RANGES[tunnel];
  if (!r) return false;
  for (const [a, b] of r) if (s >= a && s <= b) return true;
  return false;
}

/** Where a cave-in goes ahead of a plane at arc length `s`, travelling
 * `dir` (+1: increasing s) at `speed` m/s: CAVEIN_LEAD_S at its reference
 * speed (never under MAX_SPEED), so a cruising plane meets the falling rock
 * just after the warning ends. */
export const caveInLeadM = (speed: number): number =>
  Math.max(speed, MAX_SPEED) * CAVEIN_LEAD_S;

/** A plane as the fairness rule sees it, in one bore's frame. */
export interface CaveInPlane {
  /** Arc length (beyond either end along the end leg's extension), m. */
  s: number;
  /** Lateral offset, m, and height, m. */
  lat: number;
  y: number;
  /** Velocity along +s, m/s. */
  vs: number;
}

/**
 * The lead rule for one plane and a cave-in centred at `s`: fair when the
 * plane is heading away, is far enough out that even at BOOST_MAX_SPEED it
 * sees CAVEIN_FAIR_S of warning before it reaches the zone, or is close
 * enough to clear the whole zone before anything falls even at MIN_SPEED.
 * A plane well above the street or far off the bore's line is not in it
 * (it would have to come in through a portal or a mouth, both more than
 * 150 m of bore from any deep zone).
 */
export function caveInFairFor(p: CaveInPlane, s: number): boolean {
  if (p.y > 30 || Math.abs(p.lat) > H + 20) return true;
  const half = CAVEIN_LEN / 2;
  // Distance to the zone's near edge along the plane's travel; a plane
  // barely moving along the bore is taken as heading in, either way.
  const ahead = (dir: number): number =>
    dir > 0 ? s - half - p.s : p.s - (s + half);
  const ok = (dir: number): boolean => {
    const d = ahead(dir);
    if (d <= -CAVEIN_LEN) return true; // past it, flying away
    if (d >= CAVEIN_FAIR_S * BOOST_MAX_SPEED) return true;
    return d + CAVEIN_LEN < (MIN_SPEED * CAVEIN_WARN_MS) / 1000;
  };
  if (Math.abs(p.vs) < 1) return ok(1) && ok(-1);
  return ok(p.vs > 0 ? 1 : -1);
}

// --- The event ----------------------------------------------------------------------

/** One cave-in, exactly as broadcast. `s` on the 0.1 m grid. */
export interface CaveInEvent {
  id: number;
  tunnel: number;
  s: number;
  /** Server clock at warning start, ms. */
  t0: number;
  gap: CaveInGap;
}

/** On the wire: [id, tunnel, s × 10, t0, gap]. */
export type WireCaveIn = [
  id: number,
  tunnel: number,
  s: number,
  t0: number,
  gap: number,
];

export const encodeCaveIn = (e: CaveInEvent): WireCaveIn => [
  e.id,
  e.tunnel,
  Math.round(e.s * 10),
  Math.round(e.t0),
  e.gap,
];

export function decodeCaveIn(w: unknown): CaveInEvent | null {
  if (
    !Array.isArray(w) ||
    w.length !== 5 ||
    !w.every((v) => typeof v === "number" && Number.isFinite(v))
  ) {
    return null;
  }
  const [id, tunnel, s, t0, gap] = w as number[];
  if (!TUNNELS[tunnel as number]) return null;
  if (gap !== 0 && gap !== 1 && gap !== 2) return null;
  const e: CaveInEvent = {
    id: id as number,
    tunnel: tunnel as number,
    s: (s as number) / 10,
    t0: t0 as number,
    gap,
  };
  return caveInSpotOk(e.tunnel, e.s) ? e : null;
}

// --- The pieces ---------------------------------------------------------------------

export const PIECE_ROCK = 0;
export const PIECE_SLAB = 1;
export const PIECE_BEAM = 2;

/**
 * One cave-in's pieces, built from its event alone. Per-piece arrays. A
 * piece is a box: half extents (hx along its own axis — the bore's way
 * plus a small yaw jitter — hy up, hz across), yawed by `yaw` (three's
 * Y-rotation convention: local +X → world (cos yaw, −sin yaw)), tumbling by
 * `phi` about its local x (`axis` 0) or z (1).
 */
export interface CaveIn extends CaveInEvent {
  /** The zone's centre, canonical, and the bore heading there. */
  readonly x: number;
  readonly z: number;
  readonly th: number;
  readonly n: number;
  readonly kind: Uint8Array;
  readonly px: Float64Array;
  readonly pz: Float64Array;
  /** Lateral offset of each piece in the bore, m (for the warning's dust). */
  readonly lat: Float64Array;
  readonly hx: Float64Array;
  readonly hy: Float64Array;
  readonly hz: Float64Array;
  readonly yaw: Float64Array;
  readonly axis: Uint8Array;
  /** Tumble at rest (a multiple of π/2) and the wobble on the way down. */
  readonly phiEnd: Float64Array;
  readonly wobble: Float64Array;
  /** Start height, rest height (centre), s after t0 it lets go, s it falls. */
  readonly y0: Float64Array;
  readonly yRest: Float64Array;
  readonly start: Float64Array;
  readonly fall: Float64Array;
  /** Half height at rest. */
  readonly restHy: Float64Array;
  /** Ms after t0: everything down, the rubble starts to settle, gone. */
  readonly downMs: number;
  readonly clearMs: number;
  readonly endMs: number;
}

const wrap = (v: number): number =>
  ((v % WORLD_SIZE) + WORLD_SIZE) % WORLD_SIZE;

/** Lateral reach of a box over its whole tumble about `axis`, yawed `j`
 * off the bore. */
function fallReach(
  axis: number,
  j: number,
  hx: number,
  hy: number,
  hz: number,
): number {
  const s = Math.abs(Math.sin(j));
  const c = Math.abs(Math.cos(j));
  return axis === 0
    ? s * hx + c * Math.hypot(hy, hz)
    : s * Math.hypot(hx, hy) + c * hz;
}

/** Rest half extents after `k` quarter turns about `axis`: [x, y, z]. */
function restDims(
  axis: number,
  k: number,
  hx: number,
  hy: number,
  hz: number,
): [number, number, number] {
  if (k % 2 === 0) return [hx, hy, hz];
  return axis === 0 ? [hx, hz, hy] : [hy, hx, hz];
}

interface RawPiece {
  kind: number;
  s: number;
  lat: number;
  hx: number;
  hy: number;
  hz: number;
  j: number;
  axis: number;
  k: number;
  wobble: number;
  yRest: number;
  restHy: number;
  /** s after t0 it lets go, and s it falls. */
  start: number;
  fall: number;
}

const ptScratch: TunnelPoint = { x: 0, z: 0, th: 0 };

/** The pieces of `e`: pure in the event (seeded by its id), so the server,
 * every client and every late joiner build the same ones. */
export function buildCaveIn(e: CaveInEvent): CaveIn {
  const t = TUNNELS[e.tunnel] as Tunnel;
  const rand = mulberry32((Math.imul(e.id + 1, 0x9e3779b1) ^ 0xca5e1) >>> 0);
  const half = CAVEIN_LEN / 2;
  const ca = CAVEIN_LEN / ALONG_CELLS;
  const [laneLo, laneHi] = caveInLane(e.gap);
  const pieces: RawPiece[] = [];
  const regions = caveInDebris(e.gap);
  for (const [la, lb] of regions) {
    const nl = Math.max(1, Math.round((lb - la) / CELL_LAT));
    const cw = (lb - la) / nl;
    const heights = new Float64Array(ALONG_CELLS * nl);
    // When the top of each cell's pile lands, s after t0: a piece let go
    // onto it lands after it, never through it still falling.
    const landed = new Float64Array(ALONG_CELLS * nl);
    const timing = (hy: number, yRest: number, under: number) => {
      const fall = Math.sqrt(
        (2 * Math.max(0, CAVEIN_CEIL - PROUD + hy - yRest)) / CAVEIN_GRAVITY,
      );
      const free = WARN_S + STAGGER_S * rand();
      const start = under > 0 ? Math.max(free, under + 0.08 - fall) : free;
      return { start, fall };
    };
    const cellLat = (il: number) => la + (il + 0.5) * cw;
    // How far a piece centred in column il may reach across before it
    // meets the lane (the region's lane-side bound already keeps MARGIN).
    const room = (il: number): number => {
      const c = cellLat(il);
      const toLane = c < laneLo ? laneLo - c : c - laneHi;
      return toLane - CAVEIN_LANE_MARGIN - 0.1;
    };
    // One beam per region, half the time: across two cells along a column.
    // This region's share of the pieces.
    const cap = pieces.length + Math.floor(CAVEIN_PIECES_MAX / regions.length);
    if (rand() < 0.6 && pieces.length < cap) {
      const il = Math.floor(rand() * nl);
      const ia = rand() < 0.5 ? 0 : 2;
      let hx = ca - 0.35;
      const hy = 0.28;
      const hz = 0.28;
      const j = (rand() - 0.5) * 0.12;
      const k = rand() < 0.5 ? 0 : 2;
      // Fits its two cells at rest, and never reaches the lane falling.
      while (
        (Math.abs(Math.cos(j)) * hx + Math.abs(Math.sin(j)) * hz > ca - 0.15 ||
          fallReach(1, j, hx, hy, hz) > room(il)) &&
        hx > 1
      ) {
        hx *= 0.9;
      }
      const top = Math.max(
        heights[ia * nl + il] as number,
        heights[(ia + 1) * nl + il] as number,
      );
      const rest = restDims(1, k, hx, hy, hz);
      const yRest = CAVEIN_FLOOR + top + rest[1];
      const under = Math.max(
        landed[ia * nl + il] as number,
        landed[(ia + 1) * nl + il] as number,
      );
      const tm = timing(hy, yRest, under);
      landed[ia * nl + il] = tm.start + tm.fall;
      landed[(ia + 1) * nl + il] = tm.start + tm.fall;
      pieces.push({
        kind: PIECE_BEAM,
        s: e.s - half + (ia + 1) * ca,
        lat: cellLat(il),
        hx,
        hy,
        hz,
        j,
        axis: 1,
        k,
        wobble: (rand() - 0.5) * 0.5,
        yRest,
        restHy: rest[1],
        start: tm.start,
        fall: tm.fall,
      });
      heights[ia * nl + il] = top + 2 * rest[1];
      heights[(ia + 1) * nl + il] = top + 2 * rest[1];
    }
    // Each cell piles up toward a seeded height — higher toward the wall,
    // as rock slides off a fall — so the rubble narrows the bore at the
    // height planes fly, not just underfoot.
    for (let ia = 0; ia < ALONG_CELLS; ia++) {
      for (let il = 0; il < nl; il++) {
        const toLane = Math.min(
          Math.abs(cellLat(il) - laneLo),
          Math.abs(cellLat(il) - laneHi),
        );
        const target =
          PILE_MIN + rand() * PILE_RAND + (toLane / (lb - la)) * PILE_WALL;
        for (let layer = 0; layer < PILE_LAYERS; layer++) {
          if (pieces.length >= cap) break;
          if ((heights[ia * nl + il] as number) >= target) break;
          const slab = rand() < 0.25;
          let hx: number;
          let hy: number;
          let hz: number;
          if (slab) {
            hx = 1.5 + rand() * 0.7;
            hy = 0.3 + rand() * 0.15;
            hz = 1.5 + rand() * 0.8;
          } else {
            hx = 1 + rand() * 1.1;
            hy = 0.9 + rand() * 0.8;
            hz = 1 + rand() * 1.2;
          }
          const j = (rand() - 0.5) * 0.4;
          const axis = rand() < 0.5 ? 0 : 1;
          const k = slab ? (rand() < 0.5 ? 0 : 2) : 1 + Math.floor(rand() * 3);
          const wobble = (rand() - 0.5) * 0.7;
          const ds = (rand() - 0.5) * 0.6;
          const dl = (rand() - 0.5) * 0.6;
          // Shrink until it fits its cell at rest and never reaches the
          // lane on the way down.
          const fits = (): boolean => {
            const [rx, , rz] = restDims(axis, k, hx, hy, hz);
            const sj = Math.abs(Math.sin(j));
            const cj = Math.abs(Math.cos(j));
            return (
              cj * rx + sj * rz <= ca / 2 - 0.15 - Math.abs(ds) &&
              sj * rx + cj * rz <= cw / 2 - 0.15 - Math.abs(dl) &&
              fallReach(axis, j, hx, hy, hz) <= room(il) - Math.abs(dl)
            );
          };
          let guard = 0;
          while (!fits() && guard++ < 40) {
            hx *= 0.92;
            hy *= 0.92;
            hz *= 0.92;
          }
          if (!fits()) continue;
          const rest = restDims(axis, k, hx, hy, hz);
          const cell = ia * nl + il;
          const top = heights[cell] as number;
          const yRest = CAVEIN_FLOOR + top + rest[1];
          const tm = timing(hy, yRest, landed[cell] as number);
          landed[cell] = tm.start + tm.fall;
          pieces.push({
            kind: slab ? PIECE_SLAB : PIECE_ROCK,
            s: e.s - half + (ia + 0.5) * ca + ds,
            lat: cellLat(il) + dl,
            hx,
            hy,
            hz,
            j,
            axis,
            k,
            wobble,
            yRest,
            restHy: rest[1],
            start: tm.start,
            fall: tm.fall,
          });
          heights[cell] = top + 2 * rest[1];
        }
      }
    }
  }

  const n = pieces.length;
  const f64 = () => new Float64Array(n);
  const out = {
    ...e,
    x: 0,
    z: 0,
    th: 0,
    n,
    kind: new Uint8Array(n),
    px: f64(),
    pz: f64(),
    lat: f64(),
    hx: f64(),
    hy: f64(),
    hz: f64(),
    yaw: f64(),
    axis: new Uint8Array(n),
    phiEnd: f64(),
    wobble: f64(),
    y0: f64(),
    yRest: f64(),
    start: f64(),
    fall: f64(),
    restHy: f64(),
    downMs: 0,
    clearMs: 0,
    endMs: 0,
  };
  tunnelPointInto(t, e.s, ptScratch);
  out.x = wrap(ptScratch.x);
  out.z = wrap(ptScratch.z);
  out.th = ptScratch.th;
  let down = 0;
  for (let i = 0; i < n; i++) {
    const p = pieces[i] as RawPiece;
    tunnelPointInto(t, p.s, ptScratch);
    const th = ptScratch.th;
    out.kind[i] = p.kind;
    out.px[i] = wrap(ptScratch.x - Math.sin(th) * p.lat);
    out.pz[i] = wrap(ptScratch.z + Math.cos(th) * p.lat);
    out.lat[i] = p.lat;
    out.hx[i] = p.hx;
    out.hy[i] = p.hy;
    out.hz[i] = p.hz;
    out.yaw[i] = -(th + p.j);
    out.axis[i] = p.axis;
    out.phiEnd[i] = (p.k * Math.PI) / 2;
    out.wobble[i] = p.wobble;
    const y0 = CAVEIN_CEIL - PROUD + p.hy;
    out.y0[i] = y0;
    out.yRest[i] = p.yRest;
    out.restHy[i] = p.restHy;
    out.start[i] = p.start;
    out.fall[i] = p.fall;
    down = Math.max(down, p.start + p.fall);
  }
  out.downMs = down * 1000;
  out.clearMs = out.downMs + CAVEIN_RUBBLE_MS;
  out.endMs = out.clearMs + CAVEIN_SINK_MS;
  return out;
}

// --- The pose -----------------------------------------------------------------------

/** One piece's pose: centre (canonical x/z), half extents, yaw, tumble. */
export interface CaveInPose {
  x: number;
  y: number;
  z: number;
  hx: number;
  hy: number;
  hz: number;
  yaw: number;
  axis: number;
  phi: number;
  /** Drawn and solid at all (false once it has settled away). */
  visible: boolean;
  /** Still in the air (or about to let go): falling rock, not rubble. */
  falling: boolean;
}

export const blankCaveInPose = (): CaveInPose => ({
  x: 0,
  y: 0,
  z: 0,
  hx: 0,
  hy: 0,
  hz: 0,
  yaw: 0,
  axis: 0,
  phi: 0,
  visible: false,
  falling: false,
});

/**
 * THE pose of piece `i` of `c` at server time `tMs`, into `out` — the
 * renderer draws it and collideCaveIns collides it. Closed form and
 * allocation-free. Before t0 (a render clock trails the message) it is not
 * there yet.
 */
export function caveInPieceInto(
  c: CaveIn,
  i: number,
  tMs: number,
  out: CaveInPose,
): CaveInPose {
  const ms = tMs - c.t0;
  out.x = c.px[i] as number;
  out.z = c.pz[i] as number;
  out.yaw = c.yaw[i] as number;
  out.axis = c.axis[i] as number;
  out.hx = c.hx[i] as number;
  out.hy = c.hy[i] as number;
  out.hz = c.hz[i] as number;
  if (!(ms >= 0) || ms >= c.endMs) {
    out.visible = false;
    out.falling = false;
    out.y = c.y0[i] as number;
    out.phi = 0;
    return out;
  }
  out.visible = true;
  const tau = ms / 1000 - (c.start[i] as number);
  const fall = c.fall[i] as number;
  const phiEnd = c.phiEnd[i] as number;
  if (tau <= 0) {
    out.y = c.y0[i] as number;
    out.phi = 0;
    out.falling = true;
    return out;
  }
  if (tau < fall) {
    const u = tau / fall;
    out.y = (c.y0[i] as number) - 0.5 * CAVEIN_GRAVITY * tau * tau;
    out.phi = phiEnd * u + (c.wobble[i] as number) * Math.sin(Math.PI * u);
    out.falling = true;
    return out;
  }
  out.phi = phiEnd;
  out.falling = false;
  const yRest = c.yRest[i] as number;
  if (ms < c.clearMs) {
    out.y = yRest;
    return out;
  }
  // Settling away: down into the floor until its top is under it.
  const u = (ms - c.clearMs) / CAVEIN_SINK_MS;
  const restHy = c.restHy[i] as number;
  out.y = yRest - u * (yRest - CAVEIN_FLOOR + restHy + 0.05);
  return out;
}

// --- Collision ------------------------------------------------------------------------

const scratchPose = blankCaveInPose();

/** Does a sphere at offset (dx, dy, dz) from the pose's centre touch it? */
export function sphereHitsCaveInPiece(
  p: CaveInPose,
  dx: number,
  dy: number,
  dz: number,
  radius: number,
): boolean {
  // Un-yaw: local +X is (cos yaw, −sin yaw), local +Z (sin yaw, cos yaw).
  const cy = Math.cos(p.yaw);
  const sy = Math.sin(p.yaw);
  let lx = dx * cy - dz * sy;
  let ly = dy;
  let lz = dx * sy + dz * cy;
  // Un-tumble: rotate by −phi about local x (0) or z (1).
  if (p.phi !== 0) {
    const c = Math.cos(p.phi);
    const s = Math.sin(p.phi);
    if (p.axis === 0) {
      const y = ly * c + lz * s;
      lz = -ly * s + lz * c;
      ly = y;
    } else {
      const x = lx * c + ly * s;
      ly = -lx * s + ly * c;
      lx = x;
    }
  }
  const ex = Math.max(0, Math.abs(lx) - p.hx);
  const ey = Math.max(0, Math.abs(ly) - p.hy);
  const ez = Math.max(0, Math.abs(lz) - p.hz);
  return ex * ex + ey * ey + ez * ez <= radius * radius;
}

/** Reach of a zone round its centre, plan view, m (its length, the bore's
 * width and a margin for the yaw jitter). */
const ZONE_REACH = Math.hypot(CAVEIN_LEN / 2 + 6, H + 2);

/** What a cave-in collision reports. Allocated only on a hit. */
export interface CaveInHit {
  caveIn: CaveIn;
  piece: number;
  falling: boolean;
}

/**
 * The first cave-in piece a sphere at `pos` touches at server time `tMs`,
 * or null. Torus-correct; a per-event reject (time, height, plan) first,
 * then per piece.
 */
export function collideCaveIns(
  pos: Vec3,
  radius: number,
  list: readonly CaveIn[],
  tMs: number,
): CaveInHit | null {
  if (pos.y - radius > CAVEIN_CEIL + 2) return null;
  for (let e = 0; e < list.length; e++) {
    const c = list[e] as CaveIn;
    const ms = tMs - c.t0;
    if (!(ms >= 0) || ms >= c.endMs) continue;
    const ex = wrapDeltaAxis(c.x, pos.x);
    const ez = wrapDeltaAxis(c.z, pos.z);
    const reach = ZONE_REACH + radius;
    if (ex * ex + ez * ez > reach * reach) continue;
    for (let i = 0; i < c.n; i++) {
      const p = caveInPieceInto(c, i, tMs, scratchPose);
      if (!p.visible) continue;
      const dx = wrapDeltaAxis(p.x, pos.x);
      const dy = pos.y - p.y;
      const dz = wrapDeltaAxis(p.z, pos.z);
      const b = Math.hypot(p.hx, p.hy, p.hz) + radius;
      if (dx * dx + dy * dy + dz * dz > b * b) continue;
      if (sphereHitsCaveInPiece(p, dx, dy, dz, radius)) {
        return { caveIn: c, piece: i, falling: p.falling };
      }
    }
  }
  return null;
}

// --- The slot ------------------------------------------------------------------------

/** A room's live cave-ins on both sides (the MoverField's `caveins`):
 * built once per event, in arrival order. Mutated in place. */
export interface CaveInSlot {
  list: CaveIn[];
}

export const emptyCaveInSlot = (): CaveInSlot => ({ list: [] });

/** Add `e` (built) unless its id is already held. Returns the built one. */
export function addCaveIn(slot: CaveInSlot, e: CaveInEvent): CaveIn | null {
  for (const c of slot.list) if (c.id === e.id) return null;
  const c = buildCaveIn(e);
  slot.list.push(c);
  return c;
}

/** Drop every cave-in over at `tMs` (allocation-free when none is). */
export function pruneCaveIns(slot: CaveInSlot, tMs: number): void {
  const list = slot.list;
  for (let i = list.length - 1; i >= 0; i--) {
    const c = list[i] as CaveIn;
    if (tMs >= c.t0 + c.endMs) list.splice(i, 1);
  }
}

/** Is `c` live (warned, falling or rubble) at `tMs`? */
export const caveInLive = (c: CaveIn, tMs: number): boolean =>
  tMs >= c.t0 && tMs < c.t0 + c.endMs;

/**
 * The next live cave-in on bore `tunnel` for a plane at arc length `s`
 * travelling `dir`: the nearest whose zone starts within `ahead` m and
 * whose far end is not more than `past` m behind. What bots and the H3
 * save steer to (each into its lane), or null.
 */
export function nextCaveInAhead(
  list: readonly CaveIn[],
  tunnel: number,
  s: number,
  dir: 1 | -1,
  tMs: number,
  ahead = 260,
  past = 15,
): CaveIn | null {
  let best: CaveIn | null = null;
  let bestD = Number.POSITIVE_INFINITY;
  for (let i = 0; i < list.length; i++) {
    const c = list[i] as CaveIn;
    if (c.tunnel !== tunnel || !caveInLive(c, tMs)) continue;
    const d = dir * (c.s - s);
    if (d + CAVEIN_LEN / 2 + past < 0 || d - CAVEIN_LEN / 2 > ahead) continue;
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}

// --- Shake -----------------------------------------------------------------------------

/** Felt within this of the zone, m. */
const SHAKE_RADIUS = 160;

/** The shake cave-in `c` puts on a camera at `pos` at `tMs`, 0..1 (of the
 * collapse jolt's peak): a tremor building through the warning, the jolt
 * as the rock comes down, nothing once it rests. Pure. */
export function caveInShake(c: CaveIn, pos: Vec3, tMs: number): number {
  const ms = tMs - c.t0;
  if (!(ms >= 0) || ms > c.downMs + 600) return 0;
  const dx = wrapDeltaAxis(c.x, pos.x);
  const dz = wrapDeltaAxis(c.z, pos.z);
  const dy = pos.y - (CAVEIN_FLOOR + CAVEIN_CEIL) / 2;
  const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const f = Math.max(0, 1 - d / SHAKE_RADIUS);
  if (f === 0) return 0;
  if (ms < CAVEIN_WARN_MS) return f * (0.12 + 0.28 * (ms / CAVEIN_WARN_MS));
  const u = (ms - CAVEIN_WARN_MS) / (c.downMs + 600 - CAVEIN_WARN_MS);
  return f * 0.9 * (1 - u) ** 1.5;
}
