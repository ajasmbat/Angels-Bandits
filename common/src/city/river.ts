// L11 the river — one block row of the city sunk into a walled channel, with
// the crossing streets carried over it on bridges. Shared verbatim by client
// and server, like the rest of common/city: the renderer draws exactly the
// boxes this module collides, and bots probe the same function players die to.
//
// THE SHAPE. Block row RIVER_ROW (z 1000–1200) holds no lots. Its middle
// 120 m is the channel: vertical embankment walls from street level (y = 0)
// down to the water at RIVER_WATER_Y. Between the bank streets' lot lines and
// the channel edges runs the promenade, at street level. Every north–south
// street crosses on a bridge whose deck top IS the street (y = 0), so the
// street lattice, its traffic, lamps and pedestrians, and the bots' street
// graph (street.ts nextIntersection) are all unchanged — the decks are just
// more street. Under each deck is BRIDGE_CLEARANCE of open air over the water.
//
// The river runs along x, so it crosses the x seam like every street does;
// its z band never touches the z seam. All tests are wrap-safe through
// wrapDeltaAxis anyway — nothing here assumes canonical input.
//
// THE GROUND. collision.ts hitsGround() delegates to riverHit(): outside the
// channel the ground is the old y = 0 plane; inside it the floor is the water.
// Spheres use the same expanded-box convention as collideCity (a box grown by
// the radius), so a wing tip touching a bank wall, a deck or a parapet counts.
//
// BOATS are pure poses of (seed, server time) on the water. They are SOLID
// (a pilot can fly a few metres over the water, so a hull is in the flight
// band): movers.ts carries the fleet in MoverField.boats and its collide
// functions test boatBoxInto(), the same box the renderer sizes from.
//
// BOTS fly under the bridges through B2's thread machinery: bridgeSpans()
// turns every underpass into a HoleSpan of kind "bridge", which bots only
// ever FOLLOW a target through (never patrol-route), rollout-checked first.

import { BLOCK_PITCH, WORLD_SIZE } from "../constants";
import { type Vec3, wrapDeltaAxis } from "../world/index";
import type { HoleSpan } from "./holes";
import { type Building, mulberry32 } from "./index";
import { LOT_LINE } from "./street";

/** The block row (bz) that is the river. Holds no landmark, plaza or
 * construction block — layout.ts's lists and this one never share a block. */
export const RIVER_ROW = 5;
/** Channel centreline, canonical z: the middle of the river row. */
export const RIVER_CENTER_Z = RIVER_ROW * BLOCK_PITCH + BLOCK_PITCH / 2;
/** Half the channel's width, wall to wall, m (a 120 m river). */
export const RIVER_HALF_WIDTH = 60;
/** The water surface, m. The channel floor for collision purposes. */
export const RIVER_WATER_Y = -22;
/** Bridge deck thickness, m: the deck occupies [−this, 0]. */
export const BRIDGE_DECK_DEPTH = 2.5;
/** Open air between the water and a deck's underside, m. */
export const BRIDGE_CLEARANCE = -BRIDGE_DECK_DEPTH - RIVER_WATER_Y;
/** Half a bridge's width across its street, m: the whole street, sidewalks
 * included, out to the lot lines — lamps and pedestrians stay on the deck. */
export const BRIDGE_HALF_WIDTH = LOT_LINE;
/** Parapets (bridge edges and the embankment railing): height and thickness, m. */
export const PARAPET_HEIGHT = 1.1;
export const PARAPET_THICKNESS = 0.5;
/** The promenade between a bank street's lot line and the channel edge, m. */
export const PROMENADE_DEPTH = BLOCK_PITCH / 2 - RIVER_HALF_WIDTH - LOT_LINE;
/** D9: half the length of a bridge's breakable middle span, m — the part of
 * the deck (and its parapets) that can collapse into the river
 * (city/props.ts). The deck either side of it, out to the walls, stays. */
export const BRIDGE_SPAN_HALF = 20;
/** Bridges in the world: one per north–south street line. */
export const BRIDGE_COUNT = WORLD_SIZE / BLOCK_PITCH;

/** True if block row `bz` (any integer, wrapped) is the river. */
export function isRiverRow(bz: number): boolean {
  const n = WORLD_SIZE / BLOCK_PITCH;
  return ((bz % n) + n) % n === RIVER_ROW;
}

/** Signed metres from the channel centreline to `z` (wrap-safe). */
export const riverOffset = (z: number): number =>
  wrapDeltaAxis(RIVER_CENTER_Z, z);

/** True if (x, z) is over open channel (between the walls), decks or not. */
export function overChannel(z: number): boolean {
  return Math.abs(riverOffset(z)) < RIVER_HALF_WIDTH;
}

/** Signed metres from the nearest north–south street line (a bridge axis). */
const bridgeOffset = (x: number): number =>
  x - Math.round(x / BLOCK_PITCH) * BLOCK_PITCH;

/** D9: which bridge (0..BRIDGE_COUNT−1) the nearest north–south street line
 * at `x` carries. Wrap-safe. */
export function bridgeIndexAt(x: number): number {
  const n = BRIDGE_COUNT;
  return (((Math.round(x / BLOCK_PITCH) % n) + n) % n) as number;
}

/** D9: is (x, z) over the open hole a fallen span left in bridge deck
 * `bridgeIndexAt(x)` — `gaps` is the bitmask of fallen spans (bit i =
 * bridge i)? Traffic, city life and street paint skip what stands there. */
export function inBridgeGap(x: number, z: number, gaps: number): boolean {
  if (gaps === 0) return false;
  if (Math.abs(riverOffset(z)) >= BRIDGE_SPAN_HALF) return false;
  if (Math.abs(bridgeOffset(x)) > BRIDGE_HALF_WIDTH) return false;
  return (gaps & (1 << bridgeIndexAt(x))) !== 0;
}

/**
 * One solid box of the river's built structure, in canonical coordinates
 * (centre x/z, half extents, vertical span). `bridgeBoxes()` lists them for
 * the renderer; riverHit and riverSegmentClear test the same numbers.
 */
export interface RiverBox {
  x: number;
  z: number;
  hx: number;
  hz: number;
  y0: number;
  y1: number;
}

/** Deck half length along z: wall to wall, overlapping each bank's coping. */
const DECK_HALF_LENGTH = RIVER_HALF_WIDTH;

/**
 * The bridges, one per north–south street line, as solid boxes: the deck and
 * its two parapets. Seed-free — the river is hand-placed like the plazas.
 */
export function bridgeBoxes(): RiverBox[] {
  const out: RiverBox[] = [];
  const lines = WORLD_SIZE / BLOCK_PITCH;
  for (let i = 0; i < lines; i++) {
    const x = i * BLOCK_PITCH;
    out.push({
      x,
      z: RIVER_CENTER_Z,
      hx: BRIDGE_HALF_WIDTH,
      hz: DECK_HALF_LENGTH,
      y0: -BRIDGE_DECK_DEPTH,
      y1: 0,
    });
    for (const side of [-1, 1]) {
      out.push({
        x: x + side * (BRIDGE_HALF_WIDTH - PARAPET_THICKNESS / 2),
        z: RIVER_CENTER_Z,
        hx: PARAPET_THICKNESS / 2,
        hz: DECK_HALF_LENGTH,
        y0: 0,
        y1: PARAPET_HEIGHT,
      });
    }
  }
  return out;
}

/** Offsets of a box's local frame, both axes in the box's half extents. */
function inBox(
  dx: number,
  dz: number,
  y: number,
  r: number,
  hx: number,
  hz: number,
  y0: number,
  y1: number,
): boolean {
  return (
    Math.abs(dx) <= hx + r &&
    Math.abs(dz) <= hz + r &&
    y + r >= y0 &&
    y - r <= y1
  );
}

/**
 * Does a sphere at `pos` touch the ground, an embankment wall or railing, a
 * bridge deck or a bridge parapet? The single ground truth: collision.ts
 * hitsGround() is this, so the client's crash check, the bot physics tick and
 * every bot probe agree on it.
 *
 * Expanded-box convention throughout: the bank (solid below y = 0 outside
 * the channel) grows by `r` into the channel, the water by `r` upward.
 */
export function riverHit(pos: Vec3, r: number, gaps = 0): boolean {
  // L4: the landmark bridges' pylons, cables and trusses — the only river
  // solids above the parapets.
  if (pos.y - r <= LANDMARK_TOP && landmarkTouch(pos, r, gaps)) return true;
  // The fast path: above every parapet, nothing else here can be touched.
  if (pos.y - r > PARAPET_HEIGHT) return false;
  const off = Math.abs(riverOffset(pos.z));
  // Away from the river entirely: the old flat ground.
  if (off >= RIVER_HALF_WIDTH + r + PARAPET_THICKNESS) return pos.y - r <= 0;
  // The water.
  if (pos.y - r <= RIVER_WATER_Y) return true;
  // The bank: solid below street level outside the channel walls.
  if (off >= RIVER_HALF_WIDTH - r && pos.y - r <= 0) return true;
  // L4: the piers against the walls.
  if (pos.y - r <= PIER_LAMP_TOP && pierHit(pos, r)) return true;
  const bx = bridgeOffset(pos.x);
  const onBridge = Math.abs(bx) <= BRIDGE_HALF_WIDTH + r;
  // The embankment railing: along both channel edges, broken by the bridges
  // (their own parapets turn the corner instead).
  if (
    Math.abs(bx) >= BRIDGE_HALF_WIDTH - r &&
    Math.abs(off - (RIVER_HALF_WIDTH + PARAPET_THICKNESS / 2)) <=
      PARAPET_THICKNESS / 2 + r &&
    pos.y - r <= PARAPET_HEIGHT
  ) {
    return true;
  }
  if (!onBridge) return false;
  // D9: a fallen middle span leaves the deck and parapets only from
  // BRIDGE_SPAN_HALF out to the walls (each half its own box: centre and
  // half length below), so the sphere may pass through the hole.
  const gap = gaps !== 0 && (gaps & (1 << bridgeIndexAt(pos.x))) !== 0;
  const dz = gap ? off - (DECK_HALF_LENGTH + BRIDGE_SPAN_HALF) / 2 : off;
  const hz = gap ? (DECK_HALF_LENGTH - BRIDGE_SPAN_HALF) / 2 : DECK_HALF_LENGTH;
  // The deck.
  if (inBox(bx, dz, pos.y, r, BRIDGE_HALF_WIDTH, hz, -BRIDGE_DECK_DEPTH, 0)) {
    return true;
  }
  // The deck's parapets.
  const px = BRIDGE_HALF_WIDTH - PARAPET_THICKNESS / 2;
  return inBox(
    Math.abs(bx) - px,
    dz,
    pos.y,
    r,
    PARAPET_THICKNESS / 2,
    hz,
    0,
    PARAPET_HEIGHT,
  );
}

/**
 * The lowest altitude a plane can legally be at above (any x, `z`), m: the
 * water over the channel, street level everywhere else. The server's pose
 * sanity clamp (validate.ts) and the wire encoding (net.ts) floor y here.
 */
export function minAltitude(z: number): number {
  return overChannel(z) ? RIVER_WATER_Y : 0;
}

/** Slab clip of segment t∈[0,1] (origin + t·d) against one box; true = hit. */
function segmentHitsBox(
  ox: number,
  oy: number,
  oz: number,
  d: Vec3,
  minX: number,
  maxX: number,
  minY: number,
  maxY: number,
  minZ: number,
  maxZ: number,
): boolean {
  // x, then y, then z — no per-call tuples (O5: losClear runs per bot
  // sight line and must allocate nothing).
  slab.t0 = 0;
  slab.t1 = 1;
  return (
    clipSlab(ox, d.x, minX, maxX) &&
    clipSlab(oy, d.y, minY, maxY) &&
    clipSlab(oz, d.z, minZ, maxZ)
  );
}

/** segmentHitsBox's running [t0, t1] — module scratch. */
const slab = { t0: 0, t1: 1 };

/** Clip slab.[t0, t1] by one axis; false once the interval is empty. */
function clipSlab(o: number, dv: number, lo: number, hi: number): boolean {
  if (dv === 0) return !(o < lo || o > hi);
  const a = (lo - o) / dv;
  const b = (hi - o) / dv;
  slab.t0 = Math.max(slab.t0, Math.min(a, b));
  slab.t1 = Math.min(slab.t1, Math.max(a, b));
  return !(slab.t0 > slab.t1);
}

/** Is the point `t` along the segment outside the channel (into the bank)? */
const outsideAt = (offFrom: number, dz: number, t: number): boolean =>
  Math.abs(offFrom + dz * t) >= RIVER_HALF_WIDTH;

/**
 * Is the straight segment from `from` along `d` (a wrapDelta, so it may run
 * across the seam) clear of the river's solids — the bank's ground, the
 * decks and the parapets? losClear's half of the river, so a deck is cover
 * and nobody sees (or is shot) through an embankment.
 *
 * Exact for segments shorter than half the world, like losClear: the segment
 * is tested in a frame centred on `from`, against the nearest image of every
 * bridge. The ground: y is monotonic along a segment, so it crosses street
 * level at most once — blocked when that crossing lies outside the channel
 * (into the bank) or when an end is under street level outside it.
 */
export function riverSegmentClear(
  from: Vec3,
  d: Vec3,
  ground = true,
  gaps = 0,
): boolean {
  const toY = from.y + d.y;
  const lowY = Math.min(from.y, toY);
  if (lowY > LANDMARK_TOP) return true;
  // L4: the landmark bridges' solids, then (low down) the piers.
  if (!landmarksClear(from, d, gaps)) return false;
  if (lowY > PARAPET_HEIGHT) return true;
  if (lowY <= PIER_LAMP_TOP && !piersClear(from, d)) return false;
  const offFrom = riverOffset(from.z);
  // U4: `ground` false skips the water and the bank — the caller has
  // sampled the ground itself (a sight line into a tunnel, where the bank
  // is not solid). The decks and railings below are tested either way.
  if (ground) {
    // The water: an end at or below it is already inside a solid.
    if (Math.min(from.y, toY) <= RIVER_WATER_Y) return false;
    // The bank: solid below street level outside the channel. y is
    // monotonic and the channel band convex, so checking both ends plus the
    // one point where the segment crosses street level covers every way
    // into the bank.
    if (from.y < 0 && outsideAt(offFrom, d.z, 0)) return false;
    if (toY < 0 && outsideAt(offFrom, d.z, 1)) return false;
    if (from.y < 0 !== toY < 0 && outsideAt(offFrom, d.z, -from.y / d.y)) {
      return false;
    }
  }
  // Bridges and railings near the segment, in a frame with `from` at the
  // origin (x, z) — the segment's own frame, so the seam needs no care.
  const cz = -offFrom; // channel centreline, local z
  const xLo = from.x + Math.min(0, d.x);
  const xHi = from.x + Math.max(0, d.x);
  const first = Math.floor((xLo - BRIDGE_HALF_WIDTH) / BLOCK_PITCH);
  const last = Math.ceil((xHi + BRIDGE_HALF_WIDTH) / BLOCK_PITCH);
  const px = BRIDGE_HALF_WIDTH - PARAPET_THICKNESS / 2;
  const t2 = PARAPET_THICKNESS / 2;
  const rail = RIVER_HALF_WIDTH + t2;
  const oy = from.y;
  for (let k = first; k <= last; k++) {
    const b = k * BLOCK_PITCH - from.x; // this bridge's centre, local x
    // D9: a fallen span splits the deck into its two end pieces.
    const gap = gaps !== 0 && (gaps & (1 << bridgeIndexAt(from.x + b))) !== 0;
    for (let piece = gap ? 0 : -1; piece <= (gap ? 1 : -1); piece++) {
      const z0 = piece === 1 ? cz + BRIDGE_SPAN_HALF : cz - DECK_HALF_LENGTH;
      const z1 = piece === 0 ? cz - BRIDGE_SPAN_HALF : cz + DECK_HALF_LENGTH;
      if (
        segmentHitsBox(
          0,
          oy,
          0,
          d,
          b - BRIDGE_HALF_WIDTH,
          b + BRIDGE_HALF_WIDTH,
          -BRIDGE_DECK_DEPTH,
          0,
          z0,
          z1,
        ) ||
        segmentHitsBox(
          0,
          oy,
          0,
          d,
          b - px - t2,
          b - px + t2,
          0,
          PARAPET_HEIGHT,
          z0,
          z1,
        ) ||
        segmentHitsBox(
          0,
          oy,
          0,
          d,
          b + px - t2,
          b + px + t2,
          0,
          PARAPET_HEIGHT,
          z0,
          z1,
        )
      ) {
        return false;
      }
    }
    // The embankment railings from this bridge to the next one, the -z
    // side first.
    const r0 = b + BRIDGE_HALF_WIDTH;
    const r1 = b + BLOCK_PITCH - BRIDGE_HALF_WIDTH;
    for (let side = -1; side <= 1; side += 2) {
      const zc = cz + side * rail;
      if (
        segmentHitsBox(0, oy, 0, d, r0, r1, 0, PARAPET_HEIGHT, zc - t2, zc + t2)
      ) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Every bridge underpass as a B2 hole span (kind "bridge", axis x): the clear
 * volume under one deck, wall to wall, water to deck. The bots' street graph
 * appends these to the city's holes, so a chaser can follow a target under a
 * bridge with the same rollout-checked thread it flies a tunnel with.
 *
 * `building` is a stand-in footprint (the deck's), never a real Building:
 * nothing reads it for a bridge — collision and rendering come from
 * riverHit / bridgeBoxes, not from these spans.
 */
export function bridgeSpans(): HoleSpan[] {
  const out: HoleSpan[] = [];
  const height = BRIDGE_CLEARANCE;
  const y = RIVER_WATER_Y + height / 2;
  const length = 2 * BRIDGE_HALF_WIDTH;
  for (let i = 0; i < WORLD_SIZE / BLOCK_PITCH; i++) {
    const x = i * BLOCK_PITCH;
    const deck: Building = {
      x,
      z: RIVER_CENTER_Z,
      width: length,
      depth: 2 * RIVER_HALF_WIDTH,
      height: 0,
      tiers: [],
    };
    const wrap = (v: number) => ((v % WORLD_SIZE) + WORLD_SIZE) % WORLD_SIZE;
    out.push({
      building: deck,
      hosts: [], // a bridge cuts no building
      hole: {
        kind: "bridge",
        axis: "x",
        tierIndex: 0,
        offset: 0,
        y0: RIVER_WATER_Y,
        width: 2 * RIVER_HALF_WIDTH,
        height,
      },
      center: { x, y, z: RIVER_CENTER_Z },
      entry: { x: wrap(x - length / 2), y, z: RIVER_CENTER_Z },
      exit: { x: wrap(x + length / 2), y, z: RIVER_CENTER_Z },
      length,
    });
  }
  return out;
}

// --- L4 Stormlit: the landmark bridges and the piers --------------------------
//
// Three of the ten street bridges are dressed as landmarks: two suspension
// bridges and a through-truss. Their deck, parapets, underpass and D9 span
// are the plain bridge's, untouched — the landmark only ADDS solids around
// them, listed below once and read by everything: riverHit and
// riverSegmentClear collide them, the renderer (client render/river-bridges)
// draws them, so a pylon, a cable or a truss brace is exactly where it kills.
//
// Each part is in its bridge's LOCAL frame: x off the street line
// (bridgeOffset), z off the channel centreline (riverOffset), y absolute.
// Nothing stands over the street itself (|x| < BRIDGE_HALF_WIDTH) above the
// deck except the truss's braces at 14.5 m, so the bots' street corridor
// (25–70 m) stays open; nothing stands under the deck (the underpass B2
// threads is the plain bridge's); the pylons stand in the water at
// |dz| = 50, outside the boat lanes (|dz| ≤ 43); anchorages stay on the
// promenade (|dz| ≤ 80, the lot line) — the train viaduct over the bank
// street sits at |dz| ≥ 93.5.
//
// D9: every member is split exactly at |dz| = BRIDGE_SPAN_HALF, and the ones
// inside are `span` — they drop with the fallen span (the faller itself is
// still the deck box). Cables, pylons and anchorages never fall.

/** What a landmark part is: the renderer's colour and light pick. */
export type LandmarkRole =
  | "pylon"
  | "crown"
  | "spire"
  | "girder"
  | "anchor"
  | "cable"
  | "suspender"
  | "chord"
  | "post"
  | "diagonal"
  | "brace";

/** A solid box of a landmark, in its bridge's local frame. */
export interface LandmarkBox {
  x: number;
  z: number;
  hx: number;
  hz: number;
  y0: number;
  y1: number;
  /** Part of the D9 breakable span: gone while the span is down. */
  span: boolean;
  role: LandmarkRole;
}

/** A solid capsule (a cable chord, a diagonal), local frame. */
export interface LandmarkStrut {
  ax: number;
  ay: number;
  az: number;
  bx: number;
  by: number;
  bz: number;
  r: number;
  span: boolean;
  role: LandmarkRole;
}

export type LandmarkKind = "suspension" | "truss";

/** One landmark bridge: its parts and their bounding box (local frame). */
export interface Landmark {
  bridge: number;
  kind: LandmarkKind;
  boxes: readonly LandmarkBox[];
  struts: readonly LandmarkStrut[];
  /** Bounding half extents and top, every part (radius included). */
  hx: number;
  hz: number;
  top: number;
}

/** The suspension pylons: centre |dz|, half depth, legs' x span, m. */
export const PYLON_DZ = 50;
const PYLON_HALF_Z = 3;
const PYLON_X0 = BRIDGE_HALF_WIDTH + 0.5;
const PYLON_X1 = BRIDGE_HALF_WIDTH + 3.5;
/** The pylons' three set-back tiers (tops, m) and the spire's tip. */
export const PYLON_TIERS = [30, 38, 44] as const;
export const PYLON_SPIRE_TOP = 48;
/** The cable planes (x off the line), the cables' collision radius, m. */
export const CABLE_X = BRIDGE_HALF_WIDTH + 2;
export const CABLE_R = 0.8;
/** Main cable: over the saddle, at mid-span, and down at the anchorage. */
const SADDLE_Y = 43;
const SAG_Y = 3.5;
const ANCHOR_DZ = 77;
const ANCHOR_Y = 2;
/** Suspender spacing along the main span, m. */
const SUSPENDER_STEP = 6.25;
/** The side girder outside each parapet (both kinds), m. */
export const GIRDER_X0 = BRIDGE_HALF_WIDTH;
export const GIRDER_X1 = BRIDGE_HALF_WIDTH + 3;
export const GIRDER_TOP = 1.2;
/** The truss: its plane (x off the line), chord heights, panel length, m. */
export const TRUSS_X = BRIDGE_HALF_WIDTH + 1.5;
export const TRUSS_TOP = 14.75;
const TRUSS_HALF_LENGTH = 50;
const TRUSS_PANEL = 10;
/** The truss's overhead braces span the street at this height, m. */
export const TRUSS_BRACE_Y0 = 14.5;

/** Which bridges are landmarks (bridge index, x = index · BLOCK_PITCH).
 * Not 4–6: the U4 river mouths' climb-outs cross those lines. */
const LANDMARK_LIST: readonly { bridge: number; kind: LandmarkKind }[] = [
  { bridge: 2, kind: "suspension" },
  { bridge: 7, kind: "truss" },
  { bridge: 8, kind: "suspension" },
];

/** Main cable height at |dz| = `a` (the parabola over the main span, a
 * straight back span to the anchorage) — the curve the chords sample. */
export function cableY(a: number): number {
  if (a <= PYLON_DZ) {
    const u = a / PYLON_DZ;
    return SAG_Y + (SADDLE_Y - SAG_Y) * u * u;
  }
  const u = Math.min(1, (a - PYLON_DZ) / (ANCHOR_DZ - PYLON_DZ));
  return SADDLE_Y + (ANCHOR_Y - SADDLE_Y) * u;
}

/** Points the main cable's chords join, dz ascending (−77 … 77). */
function cablePoints(): number[] {
  const zs = [-ANCHOR_DZ];
  for (let z = -PYLON_DZ; z <= PYLON_DZ; z += 10) zs.push(z);
  zs.push(ANCHOR_DZ);
  return zs;
}

/** Height of the drawn (chorded) cable at dz — what a suspender meets. */
function chordY(z: number): number {
  const zs = cablePoints();
  for (let i = 0; i + 1 < zs.length; i++) {
    const a = zs[i] as number;
    const b = zs[i + 1] as number;
    if (z >= a && z <= b) {
      const t = (z - a) / (b - a);
      return cableY(Math.abs(a)) * (1 - t) + cableY(Math.abs(b)) * t;
    }
  }
  return ANCHOR_Y;
}

const inSpan = (z0: number, z1: number): boolean =>
  z0 >= -BRIDGE_SPAN_HALF && z1 <= BRIDGE_SPAN_HALF;

/** A z run split at ±BRIDGE_SPAN_HALF: [z0, z1, span] pieces. */
function spanPieces(z0: number, z1: number): [number, number, boolean][] {
  const cuts = [z0, z1, -BRIDGE_SPAN_HALF, BRIDGE_SPAN_HALF]
    .filter((z) => z >= z0 && z <= z1)
    .sort((a, b) => a - b);
  const out: [number, number, boolean][] = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const a = cuts[i] as number;
    const b = cuts[i + 1] as number;
    if (b - a > 1e-9) out.push([a, b, inSpan(a, b)]);
  }
  return out;
}

function buildLandmark(bridge: number, kind: LandmarkKind): Landmark {
  const boxes: LandmarkBox[] = [];
  const struts: LandmarkStrut[] = [];
  const box = (
    x0: number,
    x1: number,
    y0: number,
    y1: number,
    z0: number,
    z1: number,
    role: LandmarkRole,
  ) => {
    for (const [a, b, span] of spanPieces(z0, z1)) {
      boxes.push({
        x: (x0 + x1) / 2,
        z: (a + b) / 2,
        hx: (x1 - x0) / 2,
        hz: (b - a) / 2,
        y0,
        y1,
        span,
        role,
      });
    }
  };
  const strut = (
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    r: number,
    role: LandmarkRole,
    span = false,
  ) => struts.push({ ax, ay, az, bx, by, bz, r, span, role });

  for (const sx of [-1, 1]) {
    const gx0 = sx > 0 ? GIRDER_X0 : -GIRDER_X1;
    // The side girder, wall to wall.
    box(
      gx0,
      gx0 + (GIRDER_X1 - GIRDER_X0),
      -BRIDGE_DECK_DEPTH,
      GIRDER_TOP,
      -RIVER_HALF_WIDTH,
      RIVER_HALF_WIDTH,
      "girder",
    );
    if (kind === "suspension") {
      const lx0 = sx > 0 ? PYLON_X0 : -PYLON_X1;
      const lx1 = sx > 0 ? PYLON_X1 : -PYLON_X0;
      const cx = sx * CABLE_X;
      for (const sz of [-1, 1]) {
        const zc = sz * PYLON_DZ;
        // An Art Deco pylon: three set-back tiers from the water, a spire.
        let y0 = RIVER_WATER_Y - 1;
        PYLON_TIERS.forEach((y1, tier) => {
          const inset = tier * 0.5;
          box(
            lx0 + inset,
            lx1 - inset,
            y0,
            y1,
            zc - PYLON_HALF_Z + inset,
            zc + PYLON_HALF_Z - inset,
            tier === 2 ? "crown" : "pylon",
          );
          y0 = y1;
        });
        box(
          cx - 0.5,
          cx + 0.5,
          y0,
          PYLON_SPIRE_TOP,
          zc - 0.5,
          zc + 0.5,
          "spire",
        );
        // The anchorage on the promenade.
        const az = sz * ANCHOR_DZ;
        box(lx0, lx1, 0, 3.5, az - 3, az + 3, "anchor");
      }
      // The main cable: straight chords of its curve, anchorage to
      // anchorage over both saddles.
      const zs = cablePoints();
      for (let i = 0; i + 1 < zs.length; i++) {
        const a = zs[i] as number;
        const b = zs[i + 1] as number;
        strut(
          cx,
          cableY(Math.abs(a)),
          a,
          cx,
          cableY(Math.abs(b)),
          b,
          CABLE_R,
          "cable",
        );
      }
      // Suspenders from the girder up to the cable.
      for (
        let z = -PYLON_DZ + SUSPENDER_STEP;
        z < PYLON_DZ - 1e-6;
        z += SUSPENDER_STEP
      ) {
        box(
          cx - 0.15,
          cx + 0.15,
          GIRDER_TOP,
          chordY(z),
          z - 0.15,
          z + 0.15,
          "suspender",
        );
      }
    } else {
      const tx = sx * TRUSS_X;
      const L = TRUSS_HALF_LENGTH;
      // Top chord, end posts down to the walls, verticals, Warren diagonals.
      box(tx - 1, tx + 1, TRUSS_TOP - 0.75, TRUSS_TOP + 0.75, -L, L, "chord");
      for (const sz of [-1, 1]) {
        strut(
          tx,
          GIRDER_TOP,
          sz * RIVER_HALF_WIDTH,
          tx,
          TRUSS_TOP,
          sz * L,
          0.6,
          "post",
        );
      }
      for (let z = -L; z <= L + 1e-6; z += TRUSS_PANEL) {
        const span = Math.abs(z) < BRIDGE_SPAN_HALF;
        boxes.push({
          x: tx,
          z,
          hx: 0.5,
          hz: 0.4,
          y0: GIRDER_TOP,
          y1: TRUSS_TOP - 0.75,
          span,
          role: "post",
        });
      }
      for (let i = 0; i < (2 * L) / TRUSS_PANEL; i++) {
        const z0 = -L + i * TRUSS_PANEL;
        const z1 = z0 + TRUSS_PANEL;
        const up = i % 2 === 0;
        strut(
          tx,
          up ? GIRDER_TOP : TRUSS_TOP,
          z0,
          tx,
          up ? TRUSS_TOP : GIRDER_TOP,
          z1,
          0.45,
          "diagonal",
          inSpan(z0, z1),
        );
      }
    }
  }
  if (kind === "truss") {
    // Overhead braces across the street, chord to chord.
    for (const z of [-50, -30, -10, 10, 30, 50]) {
      boxes.push({
        x: 0,
        z,
        hx: TRUSS_X + 1,
        hz: 0.4,
        y0: TRUSS_BRACE_Y0,
        y1: TRUSS_TOP + 0.75,
        span: Math.abs(z) < BRIDGE_SPAN_HALF,
        role: "brace",
      });
    }
  }
  let hx = 0;
  let hz = 0;
  let top = 0;
  for (const b of boxes) {
    hx = Math.max(hx, Math.abs(b.x) + b.hx);
    hz = Math.max(hz, Math.abs(b.z) + b.hz);
    top = Math.max(top, b.y1);
  }
  for (const s of struts) {
    hx = Math.max(hx, Math.abs(s.ax) + s.r, Math.abs(s.bx) + s.r);
    hz = Math.max(hz, Math.abs(s.az) + s.r, Math.abs(s.bz) + s.r);
    top = Math.max(top, s.ay + s.r, s.by + s.r);
  }
  return { bridge, kind, boxes, struts, hx, hz, top };
}

/** The landmark bridges, in LANDMARK_LIST order. */
export const LANDMARKS: readonly Landmark[] = LANDMARK_LIST.map((l) =>
  buildLandmark(l.bridge, l.kind),
);

/** Per bridge index: its landmark, or null for a plain street bridge. */
const LANDMARK_AT: readonly (Landmark | null)[] = Array.from(
  { length: BRIDGE_COUNT },
  (_, i) => LANDMARKS.find((l) => l.bridge === i) ?? null,
);

/** The landmark (or null) bridge index `i` carries. Wrapped. */
export function landmarkAt(i: number): Landmark | null {
  const n = BRIDGE_COUNT;
  return LANDMARK_AT[((i % n) + n) % n] ?? null;
}

/** The highest any landmark solid reaches, and how far off the channel
 * centreline any stands (the anchorages), m — the broad phases. */
export const LANDMARK_TOP = Math.max(...LANDMARKS.map((l) => l.top));
const LANDMARK_REACH_Z = Math.max(...LANDMARKS.map((l) => l.hz));

/** Squared distance between segment p + s·u (s ∈ [0, 1]) and strut `q`
 * (u = 0: from the point p). Ericson's closest points; allocation-free. */
function strutDist2(
  px: number,
  py: number,
  pz: number,
  ux: number,
  uy: number,
  uz: number,
  q: LandmarkStrut,
): number {
  const vx = q.bx - q.ax;
  const vy = q.by - q.ay;
  const vz = q.bz - q.az;
  const wx = px - q.ax;
  const wy = py - q.ay;
  const wz = pz - q.az;
  const a = ux * ux + uy * uy + uz * uz;
  const e = vx * vx + vy * vy + vz * vz;
  const f = vx * wx + vy * wy + vz * wz;
  const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
  let s = 0;
  let t = 0;
  if (a <= 1e-12) {
    t = clamp01(f / e);
  } else {
    const c = ux * wx + uy * wy + uz * wz;
    const b = ux * vx + uy * vy + uz * vz;
    const denom = a * e - b * b;
    s = denom > 1e-12 ? clamp01((b * f - c * e) / denom) : 0;
    t = (b * s + f) / e;
    if (t < 0) {
      t = 0;
      s = clamp01(-c / a);
    } else if (t > 1) {
      t = 1;
      s = clamp01((b - c) / a);
    }
  }
  const dx = wx + ux * s - vx * t;
  const dy = wy + uy * s - vy * t;
  const dz = wz + uz * s - vz * t;
  return dx * dx + dy * dy + dz * dz;
}

/** Does a sphere at local (x, y, z) touch landmark `lm`'s solids? */
function landmarkHit(
  x: number,
  y: number,
  z: number,
  r: number,
  lm: Landmark,
  gone: boolean,
): boolean {
  if (Math.abs(x) > lm.hx + r || Math.abs(z) > lm.hz + r) return false;
  if (y - r > lm.top) return false;
  for (const b of lm.boxes) {
    if (gone && b.span) continue;
    if (inBox(x - b.x, z - b.z, y, r, b.hx, b.hz, b.y0, b.y1)) return true;
  }
  for (const s of lm.struts) {
    if (gone && s.span) continue;
    const rr = r + s.r;
    if (strutDist2(x, y, z, 0, 0, 0, s) <= rr * rr) return true;
  }
  return false;
}

/** riverHit's landmark half: the bridge line nearest `pos`, if a landmark. */
function landmarkTouch(pos: Vec3, r: number, gaps: number): boolean {
  const z = riverOffset(pos.z);
  if (Math.abs(z) > LANDMARK_REACH_Z + r) return false;
  const lm = landmarkAt(Math.round(pos.x / BLOCK_PITCH));
  if (!lm) return false;
  const gone = gaps !== 0 && (gaps & (1 << lm.bridge)) !== 0;
  return landmarkHit(bridgeOffset(pos.x), pos.y, z, r, lm, gone);
}

/** Is the segment local origin (x, y, z) + t·d clear of landmark `lm`? */
function landmarkClear(
  x: number,
  y: number,
  z: number,
  d: Vec3,
  lm: Landmark,
  gone: boolean,
): boolean {
  // Bounding-box reject first: most sight lines pass wide of a landmark.
  if (
    !segmentHitsBox(
      x,
      y,
      z,
      d,
      -lm.hx,
      lm.hx,
      RIVER_WATER_Y - 1,
      lm.top,
      -lm.hz,
      lm.hz,
    )
  ) {
    return true;
  }
  for (const b of lm.boxes) {
    if (gone && b.span) continue;
    if (
      segmentHitsBox(
        x,
        y,
        z,
        d,
        b.x - b.hx,
        b.x + b.hx,
        b.y0,
        b.y1,
        b.z - b.hz,
        b.z + b.hz,
      )
    ) {
      return false;
    }
  }
  for (const s of lm.struts) {
    if (gone && s.span) continue;
    if (strutDist2(x, y, z, d.x, d.y, d.z, s) <= s.r * s.r) return false;
  }
  return true;
}

/** Is the segment from `from` along `d` clear of every landmark near it? */
function landmarksClear(from: Vec3, d: Vec3, gaps: number): boolean {
  const z = riverOffset(from.z);
  if (
    Math.min(z, z + d.z) > LANDMARK_REACH_Z ||
    Math.max(z, z + d.z) < -LANDMARK_REACH_Z
  ) {
    return true;
  }
  const xLo = from.x + Math.min(0, d.x);
  const xHi = from.x + Math.max(0, d.x);
  const first = Math.floor((xLo - BLOCK_PITCH / 2) / BLOCK_PITCH);
  const last = Math.ceil((xHi + BLOCK_PITCH / 2) / BLOCK_PITCH);
  for (let k = first; k <= last; k++) {
    const lm = landmarkAt(k);
    if (!lm) continue;
    const gone = gaps !== 0 && (gaps & (1 << lm.bridge)) !== 0;
    if (!landmarkClear(from.x - k * BLOCK_PITCH, from.y, z, d, lm, gone)) {
      return false;
    }
  }
  return true;
}

/** A stone jetty against one embankment wall, with lamp posts at its head:
 * canonical x, the wall it stands on (−1: low z, +1: high z). Mid-block,
 * clear of both U4 mouths' approaches and of every bridge. */
export interface Pier {
  x: number;
  side: -1 | 1;
}
export const PIERS: readonly Pier[] = [
  { x: 300, side: -1 },
  { x: 500, side: 1 },
  { x: 700, side: -1 },
  { x: 1300, side: 1 },
  { x: 1500, side: -1 },
  { x: 1900, side: 1 },
];
/** A pier's half width (x), its head's |dz| (it runs from there to the
 * wall), and its deck top, m. */
export const PIER_HALF_WIDTH = 5;
export const PIER_HEAD_DZ = 46;
export const PIER_TOP = RIVER_WATER_Y + 2.6;
/** The lamp posts at each pier head: x off the pier's centre, |dz|, half
 * thickness and top, m. */
export const PIER_LAMP_X = PIER_HALF_WIDTH - 0.8;
export const PIER_LAMP_DZ = PIER_HEAD_DZ + 0.8;
export const PIER_LAMP_HALF = 0.15;
export const PIER_LAMP_TOP = PIER_TOP + 4;

/** Every solid box of the piers, canonical (like bridgeBoxes). */
export function pierBoxes(): RiverBox[] {
  const out: RiverBox[] = [];
  const len = RIVER_HALF_WIDTH - PIER_HEAD_DZ;
  for (const p of PIERS) {
    const z = RIVER_CENTER_Z + p.side * (PIER_HEAD_DZ + len / 2);
    out.push({
      x: p.x,
      z,
      hx: PIER_HALF_WIDTH,
      hz: len / 2,
      y0: RIVER_WATER_Y - 1,
      y1: PIER_TOP,
    });
    for (const sx of [-1, 1]) {
      out.push({
        x: p.x + sx * PIER_LAMP_X,
        z: RIVER_CENTER_Z + p.side * PIER_LAMP_DZ,
        hx: PIER_LAMP_HALF,
        hz: PIER_LAMP_HALF,
        y0: PIER_TOP,
        y1: PIER_LAMP_TOP,
      });
    }
  }
  return out;
}
const PIER_BOXES = pierBoxes();

/** Does a sphere at `pos` touch a pier or its lamps? */
function pierHit(pos: Vec3, r: number): boolean {
  if (pos.y - r > PIER_LAMP_TOP) return false;
  for (const b of PIER_BOXES) {
    if (
      inBox(
        wrapDeltaAxis(b.x, pos.x),
        wrapDeltaAxis(b.z, pos.z),
        pos.y,
        r,
        b.hx,
        b.hz,
        b.y0,
        b.y1,
      )
    ) {
      return true;
    }
  }
  return false;
}

/** Is the segment from `from` along `d` clear of the piers? Local frame
 * with `from` at the origin, like the bridges. */
function piersClear(from: Vec3, d: Vec3): boolean {
  for (const b of PIER_BOXES) {
    const x = wrapDeltaAxis(b.x, from.x);
    const z = wrapDeltaAxis(b.z, from.z);
    if (
      segmentHitsBox(
        x,
        from.y,
        z,
        d,
        -b.hx,
        b.hx,
        b.y0,
        b.y1,
        -b.hz,
        b.hz,
      )
    ) {
      return false;
    }
  }
  return true;
}

// --- Boats ------------------------------------------------------------------

/** Boats on the river at once. */
export const BOAT_COUNT = 9;
/** Sub-lanes per direction, their offsets off the channel centreline (m) and
 * cruising speeds (m/s): outbound on the +z half, inbound on the −z half. */
const BOAT_SUBLANES = 3;
const BOAT_LANE_INNER = 12;
const BOAT_LANE_STEP = 13;
const BOAT_SPEED_MIN = 3.2;
const BOAT_SPEED_STEP = 1.4;
/** Salt for the boat stream (separate from every other per-seed stream). */
const BOAT_SALT = 0x6b6f6174;

/** One boat's fixed character. */
export interface Boat {
  /** Length and beam, m. */
  length: number;
  beam: number;
  /** +1 sails toward +x, −1 toward −x. */
  dir: 1 | -1;
  /** Cruising speed, m/s. */
  speed: number;
  /** Where it was at server time 0, canonical x. */
  x0: number;
  /** Lane offset from the channel centreline, m, and the bob phase. */
  lane: number;
  phase: number;
}

/** The river's boats for `seed`. Pure: every client gets the same fleet. */
export function riverBoats(seed: number): Boat[] {
  const rand = mulberry32((seed ^ BOAT_SALT) >>> 0);
  const boats: Boat[] = [];
  for (let i = 0; i < BOAT_COUNT; i++) {
    const dir: 1 | -1 = i % 2 === 0 ? 1 : -1;
    // Three sub-lanes per direction, each with ONE speed: boats sharing a
    // sub-lane keep their spacing forever, so no boat sails through another.
    const lane = Math.floor(i / 2) % BOAT_SUBLANES;
    boats.push({
      length: 14 + rand() * 18,
      beam: 4.5 + rand() * 2.5,
      dir,
      speed: BOAT_SPEED_MIN + lane * BOAT_SPEED_STEP,
      x0: ((i + rand() * 0.5) / BOAT_COUNT) * WORLD_SIZE,
      lane: dir * (BOAT_LANE_INNER + lane * BOAT_LANE_STEP),
      phase: rand() * Math.PI * 2,
    });
  }
  return boats;
}

/** Hull top above the water, and the cabin roof above that, m. */
export const BOAT_HULL_HEIGHT = 2;
export const BOAT_CABIN_HEIGHT = 2.6;
/** The hull's draught: how far the solid box reaches under the water, m. */
const BOAT_DRAUGHT = 1;

/** A boat's pose: canonical position on the water and heading (yaw, the
 * flight model's convention: 0 faces −z, +π/2 faces −x). */
export interface BoatPose {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

/** Where `boat` is at server time `tMs`. Pure, allocation-free with `out`. */
export function boatPoseInto(boat: Boat, tMs: number, out: BoatPose): BoatPose {
  const t = tMs / 1000;
  const x = boat.x0 + boat.dir * boat.speed * t;
  out.x = ((x % WORLD_SIZE) + WORLD_SIZE) % WORLD_SIZE;
  // A slow drift across the lane and a gentle bob — never out of the lane.
  out.z = RIVER_CENTER_Z + boat.lane + Math.sin(t * 0.05 + boat.phase) * 1.5;
  out.y = RIVER_WATER_Y + Math.sin(t * 0.9 + boat.phase) * 0.15;
  // Boats sail straight along x: the solid box below is axis-aligned, and
  // the drawn hull must be exactly that box.
  out.yaw = boat.dir === 1 ? -Math.PI / 2 : Math.PI / 2;
  return out;
}

/** A boat's solid volume: an axis-aligned box (boats sail along x). */
export interface BoatBox {
  x: number;
  z: number;
  hx: number;
  hz: number;
  y0: number;
  y1: number;
}

/**
 * The box `boat` fills at server time `tMs`: its whole length and beam, from
 * below the waterline to the cabin roof. One box, not hull + cabin — the
 * cabin is narrower, so this is conservative by the side decks only.
 */
export function boatBoxInto(
  boat: Boat,
  tMs: number,
  pose: BoatPose,
  out: BoatBox,
): BoatBox {
  boatPoseInto(boat, tMs, pose);
  out.x = pose.x;
  out.z = pose.z;
  out.hx = boat.length / 2;
  out.hz = boat.beam / 2;
  out.y0 = pose.y - BOAT_DRAUGHT;
  out.y1 = pose.y + BOAT_HULL_HEIGHT + BOAT_CABIN_HEIGHT;
  return out;
}

const scratchPose: BoatPose = { x: 0, y: 0, z: 0, yaw: 0 };
const scratchBox: BoatBox = { x: 0, z: 0, hx: 0, hz: 0, y0: 0, y1: 0 };

/** Index of the first boat the sphere touches at `tMs`, or -1. Allocation-
 * free: it runs inside the bot probe loop. */
export function collideBoats(
  pos: Vec3,
  r: number,
  boats: readonly Boat[],
  tMs: number,
): number {
  // Broad phase: boats never leave the water or the channel.
  if (pos.y - r > RIVER_WATER_Y + BOAT_HULL_HEIGHT + BOAT_CABIN_HEIGHT + 1) {
    return -1;
  }
  if (Math.abs(riverOffset(pos.z)) > RIVER_HALF_WIDTH + r) return -1;
  for (let i = 0; i < boats.length; i++) {
    const boat = boats[i];
    if (!boat) continue;
    const b = boatBoxInto(boat, tMs, scratchPose, scratchBox);
    if (
      inBox(
        wrapDeltaAxis(b.x, pos.x),
        wrapDeltaAxis(b.z, pos.z),
        pos.y,
        r,
        b.hx,
        b.hz,
        b.y0,
        b.y1,
      )
    ) {
      return i;
    }
  }
  return -1;
}
