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
export function riverHit(pos: Vec3, r: number): boolean {
  // The fast path: above every parapet, nothing here can be touched.
  if (pos.y - r > PARAPET_HEIGHT) return false;
  const off = Math.abs(riverOffset(pos.z));
  // Away from the river entirely: the old flat ground.
  if (off >= RIVER_HALF_WIDTH + r + PARAPET_THICKNESS) return pos.y - r <= 0;
  // The water.
  if (pos.y - r <= RIVER_WATER_Y) return true;
  // The bank: solid below street level outside the channel walls.
  if (off >= RIVER_HALF_WIDTH - r && pos.y - r <= 0) return true;
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
  const dz = off;
  // The deck.
  if (
    inBox(
      bx,
      dz,
      pos.y,
      r,
      BRIDGE_HALF_WIDTH,
      DECK_HALF_LENGTH,
      -BRIDGE_DECK_DEPTH,
      0,
    )
  ) {
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
    DECK_HALF_LENGTH,
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
export function riverSegmentClear(from: Vec3, d: Vec3): boolean {
  const toY = from.y + d.y;
  if (Math.min(from.y, toY) > PARAPET_HEIGHT) return true;
  // The water: an end at or below it is already inside a solid.
  if (Math.min(from.y, toY) <= RIVER_WATER_Y) return false;
  const offFrom = riverOffset(from.z);
  // The bank: solid below street level outside the channel. y is monotonic
  // and the channel band convex, so checking both ends plus the one point
  // where the segment crosses street level covers every way into the bank.
  if (from.y < 0 && outsideAt(offFrom, d.z, 0)) return false;
  if (toY < 0 && outsideAt(offFrom, d.z, 1)) return false;
  if (from.y < 0 !== toY < 0 && outsideAt(offFrom, d.z, -from.y / d.y)) {
    return false;
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
    const z0 = cz - DECK_HALF_LENGTH;
    const z1 = cz + DECK_HALF_LENGTH;
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
