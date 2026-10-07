// The elevated train (L5), shared verbatim by client and server — a mover in
// the city/movers.ts sense: every pose is a pure function of (seed, server
// time), so nothing about the train is ever streamed.
//
// The line is a rectangle on the street lattice: two long parallel streets
// joined by two cross streets, with a quarter-circle curve at each corner
// intersection. It may straddle the torus seam — every box is canonical and
// every distance goes through wrapDeltaAxis. A viaduct carries it at
// TRAIN_DECK_TOP: deck slabs over the street centreline (chords round the
// curves) and square pillars on the centreline between the traffic lanes,
// never in an intersection. The cars ride the deck at constant speed.
//
// ONE derivation of every box, exactly like partBox for the cranes:
// `viaduct` is generated once and is what the renderer instances; `carBox`
// is the only place a car's pose is written down, and both the renderer and
// collideTrain go through it. Draw == collide by construction.
//
// The deck and pillars are STATIC, so unlike the rest of the movers they are
// solid (and drawn) whatever the clock says — collideTrain with a null time
// tests them alone. Only the cars need the server clock.
//
// The route is chosen, not hand-placed: a seeded, biggest-first search over
// rectangles that rejects any that would bury a box in a building, sweep
// through a crane's reach, or cross a low H1 hole's run-out corridor or the
// street a bot stages on to thread it. No route → no train (null), which is
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
  TRAIN_BOT_CLEAR,
  TRAIN_CARS_MAX,
  TRAIN_CARS_MIN,
  TRAIN_CAR_GAP,
  TRAIN_CAR_HEIGHT,
  TRAIN_CAR_LENGTH,
  TRAIN_CAR_LIFT,
  TRAIN_CAR_WIDTH,
  TRAIN_CORNER_RADIUS,
  TRAIN_DECK_HALF_WIDTH,
  TRAIN_DECK_THICK,
  TRAIN_DECK_TOP,
  TRAIN_PILLAR_CLEAR,
  TRAIN_PILLAR_SIDE,
  TRAIN_PILLAR_SPACING,
  TRAIN_SPEED,
  TRAIN_TOP,
  WORLD_SIZE,
} from "../constants";
import { type Vec3, canonicalize, wrapDeltaAxis } from "../world/index";
import { type HoleSpan, cityHoles, holeEdges } from "./holes";
import { type Building, mulberry32 } from "./index";
import { CONSTRUCTION_BLOCKS } from "./layout";
import { type MoverBox, type MoverHit, sphereHitsBox } from "./movers";

/** One piece of the loop's centreline, in the loop's own unwrapped frame
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
      /** Start angle; the point is (cx + R cos a, cz + R sin a), a grows. */
      a0: number;
    };

/** The whole line for one seed. Build once (generateTrain) and reuse. */
export interface TrainLine {
  /** Canonical corner intersection the loop is laid out from. */
  ox: number;
  oz: number;
  /** Corner-to-corner extents along x and z, m (BLOCK_PITCH multiples). */
  w: number;
  d: number;
  /** +1 runs the loop in increasing arclength, -1 against it. */
  dir: 1 | -1;
  /** Loop length, m; arclength of the lead car's nose at t = 0, m. */
  length: number;
  phase: number;
  speed: number;
  cars: number;
  segments: readonly Segment[];
  /** Every static box, canonical: deck slabs, curve chords, pillars. */
  viaduct: readonly MoverBox[];
  /** Plan-view AABB half-extents of viaduct[i], as [ex0, ez0, ex1, ...]. */
  extents: readonly number[];
}

/** Car centre-to-centre spacing along the line, m. */
const CAR_PITCH = TRAIN_CAR_LENGTH + TRAIN_CAR_GAP;
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
const PILLAR_HALF_HEIGHT = (TRAIN_DECK_TOP - TRAIN_DECK_THICK) / 2;
/** A low hole is one whose clear volume dips into the line's height band. */
const HOLE_HEADROOM = 6;
/** Extra plan-view margin round every rejection volume, m. */
const ROUTE_MARGIN = 10;
/** Every box is inside the corner-to-corner rectangle grown by this, and no
 * box reaches further inward from its edges than INNER, m. */
const OUTER = TRAIN_DECK_HALF_WIDTH + CHORD_OVERLAP;
const INNER = TRAIN_CORNER_RADIUS + TRAIN_DECK_HALF_WIDTH;

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

/** The route stream, salted so it can share nothing with the movers' streams. */
const trainRand = (seed: number): (() => number) =>
  mulberry32((seed ^ 0x6a09e667) >>> 0);

/** Yaw for a heading (tx, tz): local +X maps to world (cos yaw, -sin yaw). */
const yawOf = (tx: number, tz: number) => Math.atan2(-tz, tx);

/** The eight segments of a W × D loop with rounded corners. */
function buildSegments(w: number, d: number): Segment[] {
  const r = TRAIN_CORNER_RADIUS;
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
    out.push({ kind: "arc", s0: s, len, cx, cz, a0 });
    s += len;
  };
  line(r, 0, 1, 0, w - 2 * r);
  arc(w - r, r, -Math.PI / 2);
  line(w, r, 0, 1, d - 2 * r);
  arc(w - r, d - r, 0);
  line(w - r, d, -1, 0, w - 2 * r);
  arc(r, d - r, Math.PI / 2);
  line(0, d - r, 0, -1, d - 2 * r);
  arc(r, r, Math.PI);
  return out;
}

/** A point on the centreline, in the loop frame, with its unit tangent. */
interface Frame {
  x: number;
  z: number;
  tx: number;
  tz: number;
  curve: boolean;
}

/** Centreline point at arclength `u` (any real; wrapped into the loop). */
function frameAt(line: TrainLine, u: number, out: Frame): Frame {
  let s = u % line.length;
  if (s < 0) s += line.length;
  let seg = line.segments[line.segments.length - 1] as Segment;
  for (const candidate of line.segments) {
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
  const a = seg.a0 + k / TRAIN_CORNER_RADIUS;
  out.x = seg.cx + TRAIN_CORNER_RADIUS * Math.cos(a);
  out.z = seg.cz + TRAIN_CORNER_RADIUS * Math.sin(a);
  out.tx = -Math.sin(a);
  out.tz = Math.cos(a);
  out.curve = true;
  return out;
}

const box = (
  x: number,
  y: number,
  z: number,
  hx: number,
  hy: number,
  hz: number,
  yaw: number,
  kind: "viaduct" | "train",
  id: number,
): MoverBox => {
  const p = canonicalize({ x, y: 0, z });
  return { x: p.x, y, z: p.z, hx, hy, hz, yaw, kind, id };
};

/** Every static box of a W × D loop laid out from (ox, oz), canonical. */
function buildViaduct(
  ox: number,
  oz: number,
  w: number,
  d: number,
  segments: readonly Segment[],
): MoverBox[] {
  const out: MoverBox[] = [];
  const r = TRAIN_CORNER_RADIUS;
  const hy = TRAIN_DECK_THICK / 2;
  for (const seg of segments) {
    if (seg.kind === "line") {
      // Deck slabs.
      const n = Math.ceil(seg.len / DECK_SLAB_MAX);
      const piece = seg.len / n;
      for (let i = 0; i < n; i++) {
        const mid = (i + 0.5) * piece;
        out.push(
          box(
            ox + seg.x0 + seg.ux * mid,
            DECK_Y,
            oz + seg.z0 + seg.uz * mid,
            piece / 2,
            hy,
            TRAIN_DECK_HALF_WIDTH,
            yawOf(seg.ux, seg.uz),
            "viaduct",
            out.length,
          ),
        );
      }
      continue;
    }
    // Curve: chords between evenly spaced points on the arc.
    const step = Math.PI / 2 / CURVE_CHORDS;
    for (let i = 0; i < CURVE_CHORDS; i++) {
      const a = seg.a0 + i * step;
      const b = a + step;
      const x0 = seg.cx + r * Math.cos(a);
      const z0 = seg.cz + r * Math.sin(a);
      const x1 = seg.cx + r * Math.cos(b);
      const z1 = seg.cz + r * Math.sin(b);
      const len = Math.hypot(x1 - x0, z1 - z0);
      out.push(
        box(
          ox + (x0 + x1) / 2,
          DECK_Y,
          oz + (z0 + z1) / 2,
          len / 2 + CHORD_OVERLAP,
          hy,
          TRAIN_DECK_HALF_WIDTH,
          yawOf((x1 - x0) / len, (z1 - z0) / len),
          "viaduct",
          out.length,
        ),
      );
    }
  }
  // Pillars: every TRAIN_PILLAR_SPACING along each street the loop runs on,
  // but only on the straights and never within TRAIN_PILLAR_CLEAR of a
  // crossing street. Measured from the corner intersection, so the stations
  // sit at the same offsets in every block.
  for (const seg of segments) {
    if (seg.kind !== "line") continue;
    for (
      let at = TRAIN_PILLAR_SPACING;
      at < seg.len + 2 * r;
      at += TRAIN_PILLAR_SPACING
    ) {
      const k = at - r; // along the straight, which starts r past the corner
      if (k < 0 || k > seg.len) continue;
      const toCrossing = Math.abs(
        at - Math.round(at / BLOCK_PITCH) * BLOCK_PITCH,
      );
      if (toCrossing < TRAIN_PILLAR_CLEAR) continue;
      out.push(
        box(
          ox + seg.x0 + seg.ux * k,
          PILLAR_HALF_HEIGHT,
          oz + seg.z0 + seg.uz * k,
          TRAIN_PILLAR_SIDE / 2,
          PILLAR_HALF_HEIGHT,
          TRAIN_PILLAR_SIDE / 2,
          yawOf(seg.ux, seg.uz),
          "viaduct",
          out.length,
        ),
      );
    }
  }
  return out;
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
 * Every plan-view area the line must stay out of, for a city.
 *
 * - Cranes: each construction block grown by CRANE_JIB_MAX — the jib sweeps
 *   that far round a mast somewhere in the block (the same rule nearCrane
 *   applies to holes).
 * - Low holes (any whose clear volume dips under TRAIN_TOP + headroom): the
 *   run-out corridor, mouths ± HOLE_RUN_OUT — where a plane threading the
 *   hole flies; and where a bot stages to thread it (B2): an arch from its
 *   cross street within 2 × BOT_HOLE_TURN_IN_MAX of the edge node, a tunnel
 *   from a parallel street up to BOT_HOLE_LINEUP_MAX before its mouth.
 */
export function trainExclusions(spans: readonly HoleSpan[]): Area[] {
  const out: Area[] = [];
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

/** True when any box comes within PLAYER_RADIUS + 1 m of a building's
 * footprint below the line's top — conservative: tier-1 footprint, whole
 * height. A street-centred line can only meet one at a curve, and the
 * curves stay ~8 m clear of every lot line. */
function buriedInCity(
  boxes: readonly MoverBox[],
  extents: readonly number[],
  buildings: readonly Building[],
): boolean {
  const pad = PLAYER_RADIUS + 1;
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i] as MoverBox;
    const ex = (extents[i * 2] ?? 0) + pad;
    const ez = (extents[i * 2 + 1] ?? 0) + pad;
    for (const o of buildings) {
      if (b.y - b.hy > o.height) continue;
      if (Math.abs(wrapDeltaAxis(o.x, b.x)) >= ex + o.width / 2) continue;
      if (Math.abs(wrapDeltaAxis(o.z, b.z)) >= ez + o.depth / 2) continue;
      return true;
    }
  }
  return false;
}

/**
 * The seed's train line, or null when no loop fits the city. `buildings`
 * MUST be generateCity(seed) — the route is fitted to it, its holes and its
 * cranes, exactly like generateMovers' cranes.
 */
export function generateTrain(
  seed: number,
  buildings: readonly Building[],
): TrainLine | null {
  const rand = trainRand(seed);
  // Fixed draws first, so the search order cannot shift them.
  const dir: 1 | -1 = rand() < 0.5 ? 1 : -1;
  const cars =
    TRAIN_CARS_MIN +
    Math.min(
      TRAIN_CARS_MAX - TRAIN_CARS_MIN,
      Math.floor(rand() * (TRAIN_CARS_MAX - TRAIN_CARS_MIN + 1)),
    );
  const phase01 = rand();
  // Seeded visiting order of the candidate origins (Fisher–Yates).
  const grid = WORLD_SIZE / BLOCK_PITCH;
  const origins: number[] = [];
  for (let i = 0; i < grid * grid * 2; i++) origins.push(i);
  for (let i = origins.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = origins[i] as number;
    origins[i] = origins[j] as number;
    origins[j] = t;
  }

  const avoid = trainExclusions(cityHoles(buildings));
  for (const [long, short] of SIZES) {
    for (const o of origins) {
      const alongX = o % 2 === 0;
      const cell = o >> 1;
      const ox = (cell % grid) * BLOCK_PITCH;
      const oz = Math.floor(cell / grid) * BLOCK_PITCH;
      const w = (alongX ? long : short) * BLOCK_PITCH;
      const d = (alongX ? short : long) * BLOCK_PITCH;
      const segments = buildSegments(w, d);
      const viaduct = buildViaduct(ox, oz, w, d, segments);
      const extents: number[] = [];
      for (const b of viaduct) extents.push(...extentsOf(b));
      const blocked = viaduct.some((b, i) =>
        avoid.some((a) =>
          overlaps(b, extents[i * 2] ?? 0, extents[i * 2 + 1] ?? 0, a),
        ),
      );
      if (blocked || buriedInCity(viaduct, extents, buildings)) continue;
      const last = segments[segments.length - 1] as Segment;
      const length = last.s0 + last.len;
      return {
        ox,
        oz,
        w,
        d,
        dir,
        length,
        phase: phase01 * length,
        speed: TRAIN_SPEED,
        cars,
        segments,
        viaduct,
        extents,
      };
    }
  }
  return null;
}

/** Arclength of the lead car's centre at a server time. */
function headAt(line: TrainLine, timeMs: number): number {
  return line.phase + line.dir * line.speed * (timeMs / 1000);
}

/** Scratch frame for the allocation-free paths. */
const scratchFrame: Frame = { x: 0, z: 0, tx: 1, tz: 0, curve: false };

/**
 * THE definition of where car `i` (0 = lead) is at a server time. Writes into
 * `out` and returns it; also reports whether that car is on a curve. Cars
 * centre on the centreline and point along its tangent, so on a curve the
 * ends overhang the arc by ~1 m — inside TRAIN_DECK_HALF_WIDTH.
 */
export function carBox(
  line: TrainLine,
  i: number,
  timeMs: number,
  out: MoverBox,
): MoverBox {
  const u = headAt(line, timeMs) - line.dir * i * CAR_PITCH;
  const f = frameAt(line, u, scratchFrame);
  const p = canonicalize({ x: line.ox + f.x, y: 0, z: line.oz + f.z });
  out.x = p.x;
  out.y = CAR_Y;
  out.z = p.z;
  out.hx = TRAIN_CAR_LENGTH / 2;
  out.hy = TRAIN_CAR_HEIGHT / 2;
  out.hz = TRAIN_CAR_WIDTH / 2;
  out.yaw = yawOf(f.tx * line.dir, f.tz * line.dir);
  out.kind = "train";
  out.id = i;
  return out;
}

/** True when car `i` is rounding a corner at that time (sparks, squeal). */
export function carOnCurve(
  line: TrainLine,
  i: number,
  timeMs: number,
): boolean {
  const u = headAt(line, timeMs) - line.dir * i * CAR_PITCH;
  return frameAt(line, u, scratchFrame).curve;
}

/** Every car's box at a time, canonical. Allocates — the rendering and
 * testing entry point; collision uses carBox with a scratch box. */
export function trainBoxes(line: TrainLine, timeMs: number): MoverBox[] {
  const out: MoverBox[] = [];
  for (let i = 0; i < line.cars; i++) {
    out.push(
      carBox(line, i, timeMs, {
        x: 0,
        y: 0,
        z: 0,
        hx: 0,
        hy: 0,
        hz: 0,
        yaw: 0,
        kind: "train",
        id: i,
      }),
    );
  }
  return out;
}

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

const carScratch: MoverBox = {
  x: 0,
  y: 0,
  z: 0,
  hx: 0,
  hy: 0,
  hz: 0,
  yaw: 0,
  kind: "train",
  id: 0,
};

/**
 * First part of the line the sphere touches, or null. `timeMs` null tests
 * the static viaduct alone (the clock is not known yet, so the cars are not
 * drawn and not solid; the deck and pillars always are). Allocation-free
 * until a hit, and two compares for a query away from the line.
 */
export function collideTrain(
  line: TrainLine,
  pos: Vec3,
  radius: number,
  timeMs: number | null,
): MoverHit | null {
  if (pos.y - radius > TRAIN_TOP) return null;
  if (!nearRing(line, pos, radius)) return null;
  if (pos.y - radius <= TRAIN_DECK_TOP) {
    const { viaduct, extents } = line;
    for (let i = 0; i < viaduct.length; i++) {
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
  const carTop = CAR_Y + TRAIN_CAR_HEIGHT / 2;
  const carBottom = CAR_Y - TRAIN_CAR_HEIGHT / 2;
  if (pos.y + radius < carBottom || pos.y - radius > carTop) return null;
  const reach = TRAIN_CAR_LENGTH / 2 + TRAIN_CAR_WIDTH / 2 + radius;
  for (let i = 0; i < line.cars; i++) {
    const b = carBox(line, i, timeMs, carScratch);
    if (Math.abs(wrapDeltaAxis(b.x, pos.x)) > reach) continue;
    if (Math.abs(wrapDeltaAxis(b.z, pos.z)) > reach) continue;
    if (sphereHitsBox(b, pos, radius)) return { kind: "train", id: i };
  }
  return null;
}

/**
 * The altitude a canyon bot at `p` should hold, m: TRAIN_TOP +
 * TRAIN_BOT_CLEAR when the deck is within `reach` plan-view (the loop's own
 * streets and every street crossing them), else 0. Bots are not meant to
 * thread the viaduct — players are.
 */
export function trainFloor(line: TrainLine, p: Vec3, reach: number): number {
  if (!nearRing(line, p, reach)) return 0;
  const { viaduct, extents } = line;
  for (let i = 0; i < viaduct.length; i++) {
    const b = viaduct[i] as MoverBox;
    if (Math.abs(wrapDeltaAxis(b.x, p.x)) > (extents[i * 2] ?? 0) + reach) {
      continue;
    }
    if (Math.abs(wrapDeltaAxis(b.z, p.z)) > (extents[i * 2 + 1] ?? 0) + reach) {
      continue;
    }
    return TRAIN_TOP + TRAIN_BOT_CLEAR;
  }
  return 0;
}
