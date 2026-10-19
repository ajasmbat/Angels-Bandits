// Z1 airship fleet — the shared, pure half (S4's sky boss, made a fleet).
// The SERVER keeps FLEET_SIZE war airships over a room (server/src/boss.ts
// FleetDirector). Each one flies its own LANE (FLEET_LANES): a straight
// course across the torus that closes on itself, at a fixed altitude and
// speed. So a ship is one small broadcast (its id, its lane, when it came on
// and where along the lane it was then), and from there its pose is a pure
// function of (ship, synced clock) — the L2 movers' trick — so every client
// draws, collides with and shoots at the same hulls at the same server
// instant. What only the server knows is streamed: each ship's HP (one
// integer), the flak shells (each one a muzzle, a burst point and a fuse)
// and, when a ship is shot down, its crash — the whole hull tilting
// nose-down along the D4 wreck path to the impact the server swept once.
//
// Draw == collide: the hull is ONE table of parts (BOSS_PARTS) — S9's
// solids of revolution lathed from one station table, and boxes. The three
// hull classes (SHIP_CLASSES: picket, cruiser, carrier) are that table
// scaled along the hull and across it (SHIP_PARTS), which keeps every solid
// of revolution a solid of revolution and every box a box. The renderer
// builds the base hull once and scales each instance by its class (client/
// src/render/boss.ts, boss-hull.ts); collideBoss tests the class's scaled
// parts with the same exact distance fields (bossPartSdf).
//
// Clearance by construction: the lanes come in LAYERS, and every lane of a
// line layer runs along that layer's one heading (forward or back), at its
// own offset across it. Two ships of a layer can close along the heading
// but never across it, and the offsets keep their hulls apart; the bands
// and the lines keep the layers apart, so no two hulls ever meet
// (common/test/boss.test.ts checks it over time). K1: the war in the
// streets — two of the layers cruise the avenues under the roofline and the
// third skims the rooftops, its altitude following the skyline;
// fleetplan.ts proves every lane clear of the city, and plans a
// break-through where it cannot be. T1: the supertall canyon — threads down
// the cores' avenues, orbits round the mega-towers and berths at their
// spire docks, all of it proved clear the same way.
//
// Not re-exported from common/src/index.ts; import "@angels-bandits/common/boss".

import type { Building } from "./city/index";
import { landmarkProfile } from "./city/landmarks";
import { LANDMARK_BLOCKS } from "./city/layout";
import type { MoverBox, MoverHit } from "./city/movers";
import { type CityIndex, collideCity, hitsGround } from "./collision";
import {
  BLOCK_PITCH,
  BOT_AIM_JITTER,
  BOT_REACTION_MS,
  BULLET_DAMAGE,
  BULLET_RANGE,
  HELI_ALT_MAX,
  HELI_HULL,
  HIT_RADIUS,
  MAX_HP,
  NEWS_HELI_ALT_MIN,
  RESPAWN_SPEED,
  WORLD_SIZE,
  WRECK_MAX_MS,
  WRECK_STEP_MS,
} from "./constants";
import {
  type Vec3,
  wrapCoord,
  wrapDelta,
  wrapDeltaAxis,
  wrapDistance,
} from "./world/index";
import { type WreckHit, wreckPosAt, wreckVelAt } from "./wreck";

/** The fleet's wire model: what decodeShip / fleetPoseAt / FLEET_LANES
 * build from a ship record. The welcome carries it; a client built for
 * another one reloads rather than fly different hulls than the server
 * collides with. Bump it with any change to the lanes, the classes or the
 * records. K1: 2 — the lanes came down into the streets. T1: 3 — the
 * threads, orbits and berths round the supertalls. */
export const FLEET_MODEL = 3;

/** DamageMsg shooter id for flak, and the AwardMsg victim id of a downed
 * ship. Player ids are base64url and bots `bot:<room>:<n>`, so it can never
 * name a plane (like MISSILE_SHOOTER_ID). */
export const BOSS_ID = "@boss";
/** Bot contacts for weak point k of ship s are `@boss:<s>:<k>` (server
 * only). */
export const BOSS_CONTACT_PREFIX = "@boss:";

// --- The hull -----------------------------------------------------------------
//
// S9: the LZ 129's silhouette, made a dieselpunk carrier. The envelope is a
// body of revolution — 254 m nose to tail, 42 m across (≈ 6:1), an elliptic
// nose, a long parallel body and a long ogive to a pointed tail — drawn by
// lathing ONE station table (BOSS_PROFILE) and collided against the same
// table exactly (the 2-D distance to the profile in the meridian half-plane:
// a solid of revolution's distance field). Everything that hangs off it is
// either a small solid of revolution of its own (the engine cars with their
// pusher props, the gas-cell blisters, the mooring cone) or a box drawn as a
// box (fins, struts, the control car, the hangar keel, the catapult deck,
// the turrets). Z1: this is the BASE hull; no ship flies it unscaled.

export type BossPartKind =
  | "hull"
  | "fin"
  | "gondola"
  | "engine"
  | "cell"
  | "turret"
  | "strut"
  | "deck";

/** A body of revolution's profile: (x, r) stations along the part's own +X
 * axis (part-local x, ascending), radius r ≥ 0. It is closed to the axis at
 * both ends — an end station with r > 0 is a flat disc (a cut). */
export type BossProfile = readonly (readonly [x: number, r: number])[];

/** One part of the hull in its own frame: +X the nose, +Y up, +Z starboard
 * (the MoverBox convention), centre and bounding half-extents in m. `piece`
 * is the section it falls with when the boss breaks up (0 fore, 1 mid, 2
 * aft). `rev` null: the box IS the part; otherwise the part is the solid of
 * revolution of `rev` about its local X axis through the centre (the box
 * bounds it exactly: hx the profile's furthest x, hy = hz its widest r). */
export interface BossPart {
  kind: BossPartKind;
  x: number;
  y: number;
  z: number;
  hx: number;
  hy: number;
  hz: number;
  piece: 0 | 1 | 2;
  rev: BossProfile | null;
}

/**
 * THE envelope, hull frame, tail to nose: x and radius, m. Max radius 21 m
 * from x = 40 to 78 (the gas cells' parallel body), 254 m long overall.
 */
export const BOSS_PROFILE: BossProfile = [
  [-128, 0],
  [-127, 2.2],
  [-124, 4.2],
  [-118, 6.6],
  [-108, 9.2],
  [-94, 11.9],
  [-78, 14.4],
  [-60, 16.6],
  [-40, 18.4],
  [-20, 19.7],
  [0, 20.5],
  [20, 20.9],
  [40, 21],
  [78, 21],
  [88, 20.7],
  [97, 19.9],
  [105, 18.5],
  [111, 16.7],
  [116, 14.4],
  [120, 11.6],
  [123, 8.4],
  [125, 4.6],
  [126, 0],
];

/** Where the envelope is cut into the three break-up sections, hull x. */
export const BOSS_CUT_FORE = 52;
export const BOSS_CUT_AFT = -56;

/** A profile's radius at local x (0 off its ends). Pure. */
export function profileR(profile: BossProfile, x: number): number {
  const n = profile.length;
  if (n === 0) return 0;
  const first = profile[0] as readonly [number, number];
  const last = profile[n - 1] as readonly [number, number];
  if (x < first[0] || x > last[0]) return 0;
  for (let i = 1; i < n; i++) {
    const b = profile[i] as readonly [number, number];
    if (x > b[0]) continue;
    const a = profile[i - 1] as readonly [number, number];
    const span = b[0] - a[0];
    return span <= 1e-9
      ? Math.max(a[1], b[1])
      : a[1] + ((b[1] - a[1]) * (x - a[0])) / span;
  }
  return last[1];
}

/** The stations of `profile` between x0 and x1 (cut ends interpolated),
 * shifted so `cx` is 0. */
function sliceProfile(
  profile: BossProfile,
  x0: number,
  x1: number,
  cx: number,
): BossProfile {
  const out: [number, number][] = [[x0 - cx, profileR(profile, x0)]];
  for (const [x, r] of profile) if (x > x0 && x < x1) out.push([x - cx, r]);
  out.push([x1 - cx, profileR(profile, x1)]);
  return out;
}

const box = (
  kind: BossPartKind,
  piece: 0 | 1 | 2,
  x: number,
  y: number,
  z: number,
  hx: number,
  hy: number,
  hz: number,
): BossPart => ({ kind, x, y, z, hx, hy, hz, piece, rev: null });

/** A solid of revolution centred at (x, y, z), its axis along hull X. */
const rev = (
  kind: BossPartKind,
  piece: 0 | 1 | 2,
  x: number,
  y: number,
  z: number,
  profile: BossProfile,
): BossPart => {
  let hx = 0;
  let r = 0;
  for (const [px, pr] of profile) {
    hx = Math.max(hx, Math.abs(px));
    r = Math.max(r, pr);
  }
  return { kind, x, y, z, hx, hy: r, hz: r, piece, rev: profile };
};

/** An envelope section from hull x0 to x1 (centred on its middle). */
const envelope = (piece: 0 | 1 | 2, x0: number, x1: number): BossPart =>
  rev(
    "hull",
    piece,
    (x0 + x1) / 2,
    0,
    0,
    sliceProfile(BOSS_PROFILE, x0, x1, (x0 + x1) / 2),
  );

/** An engine car: a streamlined nacelle (nose +X) with its four-blade
 * pusher prop's disc at the tail — the disc is solid, like a plane's. */
export const ENGINE_PROFILE: BossProfile = [
  [-7.1, 0],
  [-7, 4],
  [-6.6, 4],
  [-6.5, 1.2],
  [-5, 2.2],
  [-2, 2.9],
  [1, 3],
  [4, 2.7],
  [5.8, 1.8],
  [6.5, 0],
];
/** An armoured gas-cell blister: a spindle half sunk into the envelope. */
export const CELL_PROFILE: BossProfile = [
  [-7, 0],
  [-5, 1.8],
  [-2, 2.7],
  [2, 2.7],
  [5, 1.8],
  [7, 0],
];
/** The mooring cone on the nose. */
const CONE_PROFILE: BossProfile = [
  [-3, 1.6],
  [1, 0.9],
  [3, 0],
];

/** Envelope radius at hull x (the surface a part sits on). */
const skin = (x: number): number => profileR(BOSS_PROFILE, x);
/** Engine cars: hull x, and their lateral / vertical offset. */
const ENGINE_X = [30, 30, -30, -30] as const;
const ENGINE_Z = 27;
const ENGINE_Y = -11;
/** The catapult deck's top (rails and carriage stand on it), hull y. */
export const BOSS_DECK_Y = 22;

/**
 * THE hull. Order is protocol: weak points and turrets index into it (7 weak
 * points, 6 turrets, as on S4's hull — the wire's HP array and the flak
 * schedule are unchanged), and the renderer's bones are these, in this
 * order.
 */
export const BOSS_PARTS: readonly BossPart[] = [
  envelope(1, BOSS_CUT_AFT, BOSS_CUT_FORE), // 0 mid section
  envelope(0, BOSS_CUT_FORE, 126), // 1 fore section
  rev("hull", 0, 127, 0, 0, CONE_PROFILE), // 2 mooring cone
  envelope(2, -128, BOSS_CUT_AFT), // 3 aft section
  box("gondola", 0, 86, -23.5, 0, 8, 3.2, 3.2), // 4 control car
  box("fin", 2, -103, 18, 0, 16, 12, 0.9), // 5 dorsal fin
  box("fin", 2, -103, -18, 0, 16, 12, 0.9), // 6 ventral fin
  box("fin", 2, -103, 0, 18, 16, 0.9, 12), // 7 starboard fin
  box("fin", 2, -103, 0, -18, 16, 0.9, 12), // 8 port fin
  box("gondola", 1, -4, -22.5, 0, 20, 3, 5.5), // 9 hangar keel
  rev("engine", 1, ENGINE_X[0], ENGINE_Y, ENGINE_Z, ENGINE_PROFILE), // 10 fore stbd
  rev("engine", 1, ENGINE_X[1], ENGINE_Y, -ENGINE_Z, ENGINE_PROFILE), // 11 fore port
  rev("engine", 1, ENGINE_X[2], ENGINE_Y, ENGINE_Z, ENGINE_PROFILE), // 12 aft stbd
  rev("engine", 1, ENGINE_X[3], ENGINE_Y, -ENGINE_Z, ENGINE_PROFILE), // 13 aft port
  rev("cell", 1, 14, 6, Math.sqrt(skin(14) ** 2 - 36) - 0.3, CELL_PROFILE), // 14 stbd
  rev("cell", 1, -18, 6, -(Math.sqrt(skin(-18) ** 2 - 36) - 0.3), CELL_PROFILE), // 15 port
  rev("cell", 1, -32, skin(-32) - 0.3, 0, CELL_PROFILE), // 16 dorsal
  box("turret", 0, 98, skin(98) + 1, 0, 3, 2, 3), // 17 dorsal, fore
  box("turret", 1, -46, skin(-46) + 1.2, 0, 3, 2, 3), // 18 dorsal, aft
  box("turret", 1, 42, -19.4 - 1.2, 8, 3, 2, 3), // 19 ventral turrets
  box("turret", 1, 42, -19.4 - 1.2, -8, 3, 2, 3), // 20
  box("turret", 1, -42, -Math.sqrt(skin(-42) ** 2 - 64) - 1.2, 8, 3, 2, 3), // 21
  box("turret", 1, -42, -Math.sqrt(skin(-42) ** 2 - 64) - 1.2, -8, 3, 2, 3), // 22
  box("strut", 1, ENGINE_X[0], ENGINE_Y, 20, 2.2, 0.5, 5), // 23 engine struts
  box("strut", 1, ENGINE_X[1], ENGINE_Y, -20, 2.2, 0.5, 5), // 24
  box("strut", 1, ENGINE_X[2], ENGINE_Y, 20, 2.2, 0.5, 5), // 25
  box("strut", 1, ENGINE_X[3], ENGINE_Y, -20, 2.2, 0.5, 5), // 26
  // 27 the catapult deck: its box reaches 0.9 m over the deck plate — the
  // rails, the carriage and the deck crew stand in that headroom.
  box(
    "deck",
    1,
    20,
    (19.5 + BOSS_DECK_Y + 0.9) / 2,
    0,
    30,
    (BOSS_DECK_Y + 0.9 - 19.5) / 2,
    2.6,
  ),
];

const reach = (f: (p: BossPart) => number): number =>
  Math.max(...BOSS_PARTS.map(f));
/** Furthest any part reaches from the hull centre, per axis, m (reject
 * tests: the hull is never further than this from its centre). */
export const BOSS_REACH_X = reach((p) => Math.abs(p.x) + p.hx);
export const BOSS_REACH_Y = reach((p) => Math.abs(p.y) + p.hy);
export const BOSS_REACH_Z = reach((p) => Math.abs(p.z) + p.hz);
/** Plan-view reach of the hull from its centre (its length and beam), m. */
export const BOSS_REACH_XZ = Math.hypot(BOSS_REACH_X, BOSS_REACH_Z);
/** Bounding radius of the whole hull about its centre, m. */
export const BOSS_RADIUS = Math.hypot(BOSS_REACH_X, BOSS_REACH_Y, BOSS_REACH_Z);

/** The weak points: indices into BOSS_PARTS (4 engine cars, then 3 gas
 * cells). */
export const BOSS_WEAK_POINTS: readonly number[] = [10, 11, 12, 13, 14, 15, 16];
/** A weak point's bullet target: a sphere this big round its box centre, m —
 * the plane hit radius, so a round that would hit a plane there hits it. */
export const BOSS_WEAK_RADIUS = HIT_RADIUS;

/** Flak turrets: their BOSS_PARTS index and which way they face (+1 dorsal,
 * -1 ventral). The muzzle is the middle of that face. */
export const BOSS_TURRETS: readonly { part: number; up: 1 | -1 }[] = [
  { part: 17, up: 1 },
  { part: 18, up: 1 },
  { part: 19, up: -1 },
  { part: 20, up: -1 },
  { part: 21, up: -1 },
  { part: 22, up: -1 },
];

// --- The exact shape ------------------------------------------------------------

/** Squared distance from (px, py) to the segment a–b. */
function segD2(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const ex = bx - ax;
  const ey = by - ay;
  const len2 = ex * ex + ey * ey;
  const u =
    len2 <= 1e-18
      ? 0
      : Math.min(1, Math.max(0, ((px - ax) * ex + (py - ay) * ey) / len2));
  const dx = px - (ax + ex * u);
  const dy = py - (ay + ey * u);
  return dx * dx + dy * dy;
}

/** Signed distance from a point at axial x / radial rho (≥ 0) to a solid of
 * revolution: negative inside. Exact — the solid's surface is the profile
 * polyline swept round, so the nearest surface point lies in the point's own
 * meridian half-plane. */
export function revSdf(profile: BossProfile, x: number, rho: number): number {
  const n = profile.length;
  const first = profile[0] as readonly [number, number];
  const last = profile[n - 1] as readonly [number, number];
  let d2 = Number.POSITIVE_INFINITY;
  if (first[1] > 0) d2 = segD2(x, rho, first[0], 0, first[0], first[1]);
  for (let i = 1; i < n; i++) {
    const a = profile[i - 1] as readonly [number, number];
    const b = profile[i] as readonly [number, number];
    d2 = Math.min(d2, segD2(x, rho, a[0], a[1], b[0], b[1]));
  }
  if (last[1] > 0) {
    d2 = Math.min(d2, segD2(x, rho, last[0], last[1], last[0], 0));
  }
  const d = Math.sqrt(d2);
  return rho < profileR(profile, x) ? -d : d;
}

/** Signed distance from a part-local point to part `p`'s solid (negative
 * inside). Exact for both shapes. */
export function bossPartSdf(
  p: BossPart,
  lx: number,
  ly: number,
  lz: number,
): number {
  if (p.rev) return revSdf(p.rev, lx, Math.hypot(ly, lz));
  const qx = Math.abs(lx) - p.hx;
  const qy = Math.abs(ly) - p.hy;
  const qz = Math.abs(lz) - p.hz;
  const out = Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0));
  return out + Math.min(Math.max(qx, qy, qz), 0);
}

/** Signed distance from world `pos` to part `p` placed as `b` (its box from
 * bossPartBoxInto / bossPiecePartBoxInto), torus-aware. */
export function bossPartSdfAt(p: BossPart, b: MoverBox, pos: Vec3): number {
  const dx = wrapDeltaAxis(b.x, pos.x);
  const dz = wrapDeltaAxis(b.z, pos.z);
  const c = Math.cos(b.yaw);
  const s = Math.sin(b.yaw);
  return bossPartSdf(p, c * dx - s * dz, pos.y - b.y, s * dx + c * dz);
}

// --- Hull classes (Z1) ------------------------------------------------------------

/** The two launch rigs: the belly hangar's trapeze, the dorsal catapult. */
export const LAUNCH_BELLY = 0;
export const LAUNCH_CATAPULT = 1;
export type LaunchKind = 0 | 1;

export const SHIP_PICKET = 0;
export const SHIP_CRUISER = 1;
export const SHIP_CARRIER = 2;
export type ShipClassId = 0 | 1 | 2;

/** One hull class: the base hull scaled `sx` along its length and `sr`
 * across it (radius, height and beam), its full HP, the turrets it arms
 * (indices into BOSS_TURRETS) and the launch rigs it carries. */
export interface ShipClass {
  name: string;
  sx: number;
  sr: number;
  hp: number;
  turrets: readonly number[];
  rigs: readonly LaunchKind[];
}

/** Picket ≈ 91 m nose to tail, cruiser ≈ 142 m, carrier ≈ 198 m — each a
 * little slimmer than the last is long, so the three read as three ships,
 * not one at three distances. HP: one plane's sustained fire on the hull
 * (BULLET_DAMAGE a round, ten a second) downs a picket in about 2 s and a
 * carrier in about 3 s; rounds into an engine car or a gas cell do
 * FLEET_WEAK_MULT times that. Only cruisers (one ventral gun) and carriers
 * (a dorsal and a ventral gun) are armed. */
export const SHIP_CLASSES: readonly ShipClass[] = [
  {
    name: "PICKET",
    sx: 0.36,
    sr: 0.4,
    hp: 140,
    turrets: [],
    rigs: [LAUNCH_BELLY],
  },
  {
    name: "CRUISER",
    sx: 0.56,
    sr: 0.54,
    hp: 175,
    turrets: [2],
    rigs: [LAUNCH_BELLY],
  },
  {
    name: "CARRIER",
    sx: 0.78,
    sr: 0.66,
    hp: 210,
    turrets: [0, 3],
    rigs: [LAUNCH_BELLY, LAUNCH_CATAPULT],
  },
];

/** A round into a live engine car or gas cell does this many times a hull
 * round's BULLET_DAMAGE — a short burst on one weak point sets a ship
 * burning. */
export const FLEET_WEAK_MULT = 3;
/** Damage of one round, by what it hit (k: weak point, −1 the hull). */
export const shipRoundDamage = (k: number): number =>
  k >= 0 ? BULLET_DAMAGE * FLEET_WEAK_MULT : BULLET_DAMAGE;

const scaleProfile = (p: BossProfile, sx: number, sr: number): BossProfile =>
  p.map(([x, r]) => [x * sx, r * sr] as const);

/** Part `p` of the base hull, scaled to class `c`: exact — a solid of
 * revolution about hull X scaled sx along and sr across is the solid of its
 * scaled profile, and a box scales to a box. */
function scalePart(p: BossPart, c: ShipClass): BossPart {
  return {
    kind: p.kind,
    piece: p.piece,
    x: p.x * c.sx,
    y: p.y * c.sr,
    z: p.z * c.sr,
    hx: p.hx * c.sx,
    hy: p.hy * c.sr,
    hz: p.hz * c.sr,
    rev: p.rev ? scaleProfile(p.rev, c.sx, c.sr) : null,
  };
}

/** Each class's hull, in BOSS_PARTS order — THE shapes collideBoss tests
 * and the renderer draws (the base hull scaled per instance). */
export const SHIP_PARTS: readonly (readonly BossPart[])[] = SHIP_CLASSES.map(
  (c) => BOSS_PARTS.map((p) => scalePart(p, c)),
);

/** Each class's envelope profile — the silhouettes SKY1's painted armada
 * reuses, so a far ship and a real one are the same shape. */
export const SHIP_PROFILES: readonly BossProfile[] = SHIP_CLASSES.map((c) =>
  scaleProfile(BOSS_PROFILE, c.sx, c.sr),
);

/** How far a class's hull reaches from its centre, m: per axis (x along
 * the hull), in plan view and in all (the reject tests). */
export interface ShipReach {
  x: number;
  y: number;
  z: number;
  xz: number;
  r: number;
}
export const SHIP_REACH: readonly ShipReach[] = SHIP_CLASSES.map((c) => {
  const x = BOSS_REACH_X * c.sx;
  const y = BOSS_REACH_Y * c.sr;
  const z = BOSS_REACH_Z * c.sr;
  return { x, y, z, xz: Math.hypot(x, z), r: Math.hypot(x, y, z) };
});
/** The furthest any class reaches in plan view, m. */
export const FLEET_REACH_XZ = Math.max(...SHIP_REACH.map((r) => r.xz));

/** A weak point's bullet target per class: a sphere this big round its box
 * centre, m — the plane hit radius on the base hull, scaled across. */
export const SHIP_WEAK_R: readonly number[] = SHIP_CLASSES.map((c) =>
  Math.max(3, BOSS_WEAK_RADIUS * c.sr),
);

// --- Lanes and layers -----------------------------------------------------------
//
// K1: the war in the streets. T1: the supertall canyon — the fleet lives
// among the towers. Six LAYERS:
//  - layer 0 cruises the x-avenues (the street centrelines z = k·BLOCK_PITCH)
//    and layer 1 the z-avenues, each lane at a fixed altitude below the
//    roofline: pickets and cruisers, their beams inside the avenue's lot
//    lines (street.ts LOT_LINE), between the towers;
//  - layer 2 skims the rooftops along mid-block lines (x = (k + ½)·
//    BLOCK_PITCH), each lane's altitude following the skyline up and down —
//    its PROFILE, fitted to the city by fleetplan.ts planFleet and installed
//    on both sides (installFleetPlan). T1: only the lines that never cross
//    a core or a mega-tower (the ring's roofs, SKYLINE_RING_MAX_HEIGHT);
//  - layer 3 THREADS the cores' canyons: z-avenues through the supertalls,
//    at a fixed altitude half way up their walls;
//  - layer 4 ORBITS the four mega-towers (the landmarks): one circle each,
//    hugging the shaft's facades inside the landmark's own block;
//  - layer 5 lies MOORED at the mega-towers' spire docks: one berth each,
//    alongside a face, swaying slightly on its mast — the dock, its cargo
//    cables and the lit gangway are the renderer's (client/src/render/
//    moorings.ts), never solid (thin rigging, like the cranes' cables).
// Layers 0–3 are straight lines with one heading each (forward or back), so
// a layer's lanes each run a line of their own; an orbit and a berth never
// leave their landmark's block. The bands keep the rest apart: the street
// layers under the helicopters, the orbits over them, the threads and the
// berths over the orbits (a berth sits beside its tower's orbit, never on
// a thread's avenue), and the rooftops' lines are nobody else's. So no two
// hulls ever meet (common/test/boss.test.ts checks it over time).

/** The street layers' hull bands, m (on extents): layer 0 16 m over the
 * bots' canyon patrol (BOT_CANYON_ALT_MAX) — their street spawns are
 * vetoed out of a hull's path (RoomBots.spawnClear sees the fleet) — and
 * through the tower cranes' jibs (CRANE_MAST_MAX: the planned
 * break-throughs); layer 1 10 m over it and 11.8 m under the helicopters'
 * rotor blur (HELI_ALT_MIN − 1.3 × the hull's half-height, as
 * newsheli.test.ts reckons it). */
export const FLEET_STREET_BANDS: readonly (readonly [number, number])[] = [
  [86, 130],
  [140, 176],
];
/** The rooftop layer's band, m (on extents): 15 m over the helicopters'
 * rotor blur, and 15 m under the news heli's belly — so under the deck.
 * Over the ring's 281 m roofs (SKYLINE_RING_MAX_HEIGHT and its roof
 * structures) a carrier still has 20 m beneath it (FLEET_ROOF_CLEAR). */
export const FLEET_ROOF_MIN = HELI_ALT_MAX + HELI_HULL[1] * 1.3 + 15;
export const FLEET_ALT_MAX = NEWS_HELI_ALT_MIN - HELI_HULL[1] - 15;
/** T1: the orbits' band, m (on extents) — from the rooftop band's floor
 * (15 m over the helicopters' rotor blur), up to 10 m under the threads'
 * and the berths'. */
export const FLEET_ORBIT_BAND: readonly [number, number] = [
  FLEET_ROOF_MIN,
  300,
];
/** T1: the threads' and the berths' band, m (on extents) — 10 m over the
 * orbits, and under RESPAWN_ALTITUDE less a player's radius and a margin
 * (the respawn veto still sees every hull) and the blimp's belly. */
export const FLEET_HIGH_BAND: readonly [number, number] = [310, 365];
/** The band every real ship's hull stays inside, m (on extents). */
export const FLEET_ALT_MIN = (
  FLEET_STREET_BANDS[0] as readonly number[]
)[0] as number;
/** A rooftop hull's belly keeps at least this over every roof, roof
 * structure and crane under it, m — "just over the rooftops". */
export const FLEET_ROOF_CLEAR = 20;
/** The steepest a rooftop ship climbs or sinks along its lane, rise per
 * metre run: it rises and settles level, as an airship does (its pitch
 * stays 0), never jumps. */
export const FLEET_ROOF_SLOPE = 0.2;
/** A profile's sample spacing along its lane, m (divides WORLD_SIZE). */
export const FLEET_PROFILE_STEP = 5;

/** T1: how a lane is flown — a straight torus loop, a circle round a
 * mega-tower, or a berth at its dock. */
export const PATH_LINE = 0;
export const PATH_ORBIT = 1;
export const PATH_MOOR = 2;
export type LanePath = 0 | 1 | 2;

/** T1: a moored ship's sway on its mast: its heading swings ±this, rad,
 * and it bobs ±this, m, once round its cycle. A berth's "lane" IS that
 * cycle — `s` runs round MOOR_CYCLE m at its lane's 1 m/s, so its pose
 * stays a pure function of (lane, s) like every other ship's. */
export const MOOR_SWAY_YAW = 0.025;
export const MOOR_SWAY_BOB = 0.6;
export const MOOR_CYCLE = 36;
/** ...and how far either side, across its berth, a hull's end swings with
 * it, per metre of half-length (sin of the sway, rounded up). */
export const MOOR_SWING = 0.026;
/** T1: the gap a berth leaves between its hull's beam and the tower's
 * face, m — the gangway's span (the renderer's). */
export const MOOR_GAP = 8;
/** T1: an orbit's inner beam keeps this off the shaft's corners, m. */
export const ORBIT_GAP = 8;

/** A layer: a heading (lines) or a kind of path. */
export interface FleetLayer {
  /** A line layer's heading: (p, q) coprime whole numbers, so a lane along
   * it closes on itself after p tiles in x and q in z (0, 0 off a line). */
  p: number;
  q: number;
  /** The unit heading (forward). */
  dx: number;
  dz: number;
  /** A line's length before it closes, m: WORLD_SIZE·√(p² + q²). */
  length: number;
  /** How far apart, across the heading, a lane's own parallel images lie,
   * m: WORLD_SIZE / √(p² + q²). Two lanes `a` and `b` are never nearer
   * than (b.u − a.u) taken round this. */
  across: number;
  /** K1: a street layer's lanes cruise avenues at fixed altitudes; the
   * rooftop layer's follow their profiles. T1: the threads cruise avenues
   * too; the orbits and berths are not on one. */
  street: boolean;
  /** T1: how its lanes are flown. */
  path: LanePath;
  /** The layer's hull band, m (on extents). */
  band: readonly [number, number];
}
const fleetLayer = (
  p: number,
  q: number,
  street: boolean,
  band: readonly [number, number],
  path: LanePath = PATH_LINE,
): FleetLayer => {
  const n = Math.hypot(p, q);
  return {
    p,
    q,
    dx: n > 0 ? p / n : 0,
    dz: n > 0 ? q / n : 0,
    length: WORLD_SIZE * n,
    across: n > 0 ? WORLD_SIZE / n : 0,
    street,
    path,
    band,
  };
};
export const LAYER_STREET_X = 0;
export const LAYER_STREET_Z = 1;
export const LAYER_ROOF = 2;
export const LAYER_THREAD = 3;
export const LAYER_ORBIT = 4;
export const LAYER_MOOR = 5;
export type FleetLayerId = 0 | 1 | 2 | 3 | 4 | 5;
/** Layer 0 along +x, layers 1 to 3 along +z; the orbits and the berths. */
export const FLEET_LAYERS: readonly FleetLayer[] = [
  fleetLayer(1, 0, true, FLEET_STREET_BANDS[0] as readonly [number, number]),
  fleetLayer(0, 1, true, FLEET_STREET_BANDS[1] as readonly [number, number]),
  fleetLayer(0, 1, false, [FLEET_ROOF_MIN, FLEET_ALT_MAX]),
  fleetLayer(0, 1, true, FLEET_HIGH_BAND),
  fleetLayer(0, 0, false, FLEET_ORBIT_BAND, PATH_ORBIT),
  fleetLayer(0, 0, false, FLEET_HIGH_BAND, PATH_MOOR),
];

/** One lane: who flies it, in which layer, on which line (`cross`: the
 * avenue's or the mid-block line's fixed coordinate — z for layer 0, x for
 * the other lines), at what altitude (the hull's centre: a fixed lane's
 * own; a rooftop lane's fallback, the top of its band, when no plan is
 * installed), how far across the layer's heading (`u`), and how fast along
 * it (m/s; negative flies it backwards). T1: an orbit's centre (cx, cz)
 * and radius `r` (its speed is along the circle, positive anticlockwise
 * seen from above: +x towards +z); a berth's hull centre (cx, cz) and the
 * heading it lies on (`yaw`, MoverBox's convention), its speed the sway
 * cycle's 1 m/s. */
export interface FleetLane {
  cls: ShipClassId;
  layer: FleetLayerId;
  cross: number;
  alt: number;
  u: number;
  v: number;
  cx: number;
  cz: number;
  r: number;
  yaw: number;
  /** T1: the landmark slot an orbit or a berth belongs to (−1 on a line). */
  tower: number;
}

/** [class, layer, line, speed, altitude (fixed lanes; null: the
 * rooftops')] per line lane. */
const LANE_ROWS: readonly (readonly [
  ShipClassId,
  FleetLayerId,
  number,
  number,
  number | null,
])[] = [
  // Layer 0, the x-avenues: three pickets, a cruiser. The z = 200 avenue
  // runs through a tower crane's jib (the planned break-through): its
  // picket's envelope spans the jib's height.
  [0, 0, 0, 13.5, 107],
  [0, 0, 200, -12, 100],
  [1, 0, 1000, -9.5, 112.5],
  [0, 0, 1400, -15, 108],
  // Layer 1, the z-avenues: a picket, two cruisers.
  [1, 1, 200, 11.5, 158],
  [0, 1, 800, -14, 153],
  [1, 1, 1400, -10, 158],
  // Layer 2, the rooftops: two carriers on the mid-block lines that cross
  // no core and no mega-tower, over the ring's roofs.
  [2, 2, 100, 8, null],
  [2, 2, 1900, -9, null],
  // T1 layer 3, the threads: a cruiser down the x = 600 avenue through
  // Downtown's supertalls, a picket down x = 1200 through Midtown's — half
  // way up the canyon walls — and a picket down x = 1000, along Midtown's
  // west face and on over the ring's roofs, where a squadron can leave its
  // rig (squadron.ts departClear).
  [1, 3, 600, 9, 335],
  [0, 3, 1200, -11, 331],
  [0, 3, 1000, 12.5, 331],
];

/** T1: [class, landmark slot, radius, speed, altitude] per orbit: one round
 * each mega-tower, the radius its shaft's half-diagonal in the band plus
 * the hull's half-beam and ORBIT_GAP (fleetplan.ts proves it clear). */
const ORBIT_ROWS: readonly (readonly [
  ShipClassId,
  number,
  number,
  number,
  number,
])[] = [
  [0, 0, 63, 9, 266],
  [1, 1, 76, -8, 271],
  [0, 2, 72, -9.5, 266],
  [1, 3, 70, 8.5, 271],
];

/** T1: [class, landmark slot, face, altitude] per berth: one cruiser at
 * each mega-tower's spire dock, alongside the face (0 +x, 1 +z, 2 −x,
 * 3 −z) that keeps it off the threads' avenues. */
const MOOR_ROWS: readonly (readonly [ShipClassId, number, number, number])[] = [
  [1, 0, 2, 338],
  [1, 1, 1, 338],
  [1, 2, 3, 338],
  [1, 3, 0, 338],
];

/** The across-heading offset `u` of the line at `cross` in `layer`: a lane
 * along +x runs at z = u, one along +z at x = −u. */
const laneU = (layer: FleetLayer, cross: number): number =>
  layer.dz === 0 ? cross : wrapCoord(-cross);

/** A landmark slot's centre and its tier-1 shaft's half side (every
 * landmark's tier 1 runs from the podium's top far past the deck, so it is
 * THE shaft the orbits and berths sit beside). */
function shaftOf(slot: number): { x: number; z: number; half: number } {
  const [bx, bz] = LANDMARK_BLOCKS[slot] as readonly [number, number];
  const t = landmarkProfile(slot).tiers[1] as { width: number };
  return {
    x: bx * BLOCK_PITCH + BLOCK_PITCH / 2,
    z: bz * BLOCK_PITCH + BLOCK_PITCH / 2,
    half: t.width / 2,
  };
}

const lineLane = ([cls, layer, cross, v, alt]: (typeof LANE_ROWS)[number]) => {
  const ly = FLEET_LAYERS[layer] as FleetLayer;
  const reach = (SHIP_REACH[cls] as ShipReach).y;
  return {
    cls,
    layer,
    cross,
    alt: alt ?? ly.band[1] - reach,
    u: laneU(ly, cross),
    v,
    cx: 0,
    cz: 0,
    r: 0,
    yaw: 0,
    tower: -1,
  };
};

const orbitLane = ([cls, slot, r, v, alt]: (typeof ORBIT_ROWS)[number]) => {
  const c = shaftOf(slot);
  return {
    cls,
    layer: LAYER_ORBIT as FleetLayerId,
    cross: 0,
    alt,
    u: 0,
    v,
    cx: c.x,
    cz: c.z,
    r,
    yaw: 0,
    tower: slot,
  };
};

const moorLane = ([cls, slot, face, alt]: (typeof MOOR_ROWS)[number]) => {
  const c = shaftOf(slot);
  const reach = SHIP_REACH[cls] as ShipReach;
  const d = c.half + MOOR_GAP + reach.z;
  // Out from the face (nx, nz); the hull runs along the face, its heading
  // the face's tangent (MoverBox yaw: local +X = (cos yaw, −sin yaw)).
  const nx = face === 0 ? 1 : face === 2 ? -1 : 0;
  const nz = face === 1 ? 1 : face === 3 ? -1 : 0;
  return {
    cls,
    layer: LAYER_MOOR as FleetLayerId,
    cross: 0,
    alt,
    u: 0,
    v: 1,
    cx: wrapCoord(c.x + nx * d),
    cz: wrapCoord(c.z + nz * d),
    r: 0,
    yaw: nx !== 0 ? Math.PI / 2 : 0,
    tower: slot,
  };
};

/** Every lane — one ship each, so this many ships fly at once (at most). */
export const FLEET_LANES: readonly FleetLane[] = [
  ...LANE_ROWS.map(lineLane),
  ...ORBIT_ROWS.map(orbitLane),
  ...MOOR_ROWS.map(moorLane),
];
/** The fleet's size: one ship per lane. */
export const FLEET_SIZE = FLEET_LANES.length;
/** Does `lane` cruise an avenue (vs skim the rooftops, orbit a tower or
 * lie at a berth)? */
export const laneStreet = (lane: number): boolean =>
  (FLEET_LAYERS[(FLEET_LANES[lane] as FleetLane).layer] as FleetLayer).street;
/** T1: how `lane` is flown. */
export const lanePath = (lane: number): LanePath =>
  (FLEET_LAYERS[(FLEET_LANES[lane] as FleetLane).layer] as FleetLayer).path;
/** T1: how long `lane` is before it closes on itself, m — a line's
 * length, an orbit's circumference, a berth's sway cycle. */
export function laneLength(lane: number): number {
  const ln = FLEET_LANES[lane] as FleetLane;
  const ly = FLEET_LAYERS[ln.layer] as FleetLayer;
  if (ly.path === PATH_ORBIT) return 2 * Math.PI * ln.r;
  if (ly.path === PATH_MOOR) return MOOR_CYCLE;
  return ly.length;
}

// --- The plan (K1) ----------------------------------------------------------------

/** A planned break-through: something the lane cannot clear but the ship
 * smashes as it passes (fleetplan.ts laneClearance) — a tower crane (its
 * site id) or a standing prop (its id). `s` is where along the lane
 * (canonical, [0, length)) the obstacle's centre is, and `half` how far
 * either side of it along the lane any part of it reaches, m. */
export interface LaneBreak {
  kind: "crane" | "prop";
  id: number;
  s: number;
  half: number;
}

/** The fleet's fit to the city: per lane, its altitude profile (samples
 * every FLEET_PROFILE_STEP m along it — the lane closes on itself, so the
 * last runs back into the first — or null: a street lane's altitude is
 * fixed) and its planned break-throughs, ascending along it. A pure
 * function of the generated city (fleetplan.ts planFleet); both sides
 * install the same one, so every pose here stays a pure function of (ship,
 * plan, clock). */
export interface FleetPlan {
  readonly alt: readonly (Float64Array | null)[];
  readonly breaks: readonly (readonly LaneBreak[])[];
}

let activePlan: FleetPlan | null = null;
/** Each lane's lowest and highest centre altitude under the plan. */
const laneLo = new Float64Array(FLEET_LANES.length);
const laneHi = new Float64Array(FLEET_LANES.length);
const NO_BREAKS: readonly LaneBreak[] = [];

/** Install the fleet's plan (null: none — every lane flies its fallback
 * altitude). Both sides call it once with planFleet of the city they fly. */
export function installFleetPlan(plan: FleetPlan | null): void {
  if (plan) {
    if (plan.alt.length !== FLEET_LANES.length) {
      throw new Error("fleet plan: one profile per lane");
    }
    plan.alt.forEach((p, i) => {
      const ly = FLEET_LAYERS[
        (FLEET_LANES[i] as FleetLane).layer
      ] as FleetLayer;
      if (p && p.length * FLEET_PROFILE_STEP !== ly.length) {
        throw new Error(`fleet plan: lane ${i}'s profile does not close`);
      }
    });
  }
  activePlan = plan;
  FLEET_LANES.forEach((ln, i) => {
    const p = plan?.alt[i];
    // T1: a berth bobs on its mast.
    const bob = lanePath(i) === PATH_MOOR ? MOOR_SWAY_BOB : 0;
    let lo = ln.alt - bob;
    let hi = ln.alt + bob;
    if (p) {
      lo = Number.POSITIVE_INFINITY;
      hi = Number.NEGATIVE_INFINITY;
      for (const a of p) {
        lo = Math.min(lo, a);
        hi = Math.max(hi, a);
      }
    }
    laneLo[i] = lo;
    laneHi[i] = hi;
  });
}
installFleetPlan(null);

/** The installed plan, or null. */
export const fleetPlan = (): FleetPlan | null => activePlan;

/** `lane`'s planned break-throughs (none without a plan). */
export const laneBreaks = (lane: number): readonly LaneBreak[] =>
  activePlan?.breaks[lane] ?? NO_BREAKS;

/** The lowest / highest centre altitude `lane` ever flies, m. */
export const laneAltLo = (lane: number): number => laneLo[lane] as number;
export const laneAltHi = (lane: number): number => laneHi[lane] as number;

/** Where along its profile's samples (`n` of them) position `s` falls:
 * the sample index into `profIdx`, the fraction past it returned. */
function profileAt(s: number, n: number): number {
  let u = s / FLEET_PROFILE_STEP;
  u -= Math.floor(u / n) * n;
  let i = Math.floor(u);
  if (i >= n || i < 0) i = 0;
  profIdx = i;
  return u - i;
}
let profIdx = 0;

/** `lane`'s centre altitude at along-lane position `s` (unwrapped), m:
 * its profile's, linear between samples, or its fixed altitude. Pure in
 * (lane, s, plan); allocation-free. */
export function laneAltAt(lane: number, s: number): number {
  const p = activePlan?.alt[lane];
  if (!p) return (FLEET_LANES[lane] as FleetLane).alt;
  const n = p.length;
  const f = profileAt(s, n);
  const a = p[profIdx] as number;
  const b = p[profIdx + 1 === n ? 0 : profIdx + 1] as number;
  return a + (b - a) * f;
}

/** `lane`'s climb at `s`: metres of rise per metre along (0 for a street
 * lane). */
export function laneClimbAt(lane: number, s: number): number {
  const p = activePlan?.alt[lane];
  if (!p) return 0;
  const n = p.length;
  profileAt(s, n);
  const a = p[profIdx] as number;
  const b = p[profIdx + 1 === n ? 0 : profIdx + 1] as number;
  return (b - a) / FLEET_PROFILE_STEP;
}

// --- Ships ----------------------------------------------------------------------

/** A ship shot down: its crash, exactly as it crosses the wire. Its centre
 * follows the D4 wreck path (p, v, t = the down's time, spin, end), its
 * heading turns slowly from `yaw` and its nose drops (SHIP_FALL_PITCH). */
export interface ShipDown {
  t: number;
  p: Vec3;
  v: Vec3;
  yaw: number;
  spin: 1 | -1;
  /** ms after `t` when it hits (server-swept), ≤ WRECK_MAX_MS. */
  end: number;
  hit: WreckHit;
  /** Where it hits: the bottom of the sweep sphere that touched first (an
   * air burst: under its centre), canonical. Swept once against the city as
   * it stood at the down. */
  at: Vec3;
  /** The building it came down on (index into the city), or −1. */
  b: number;
}

/** One ship of the fleet, as both sides hold it. `s0` canonical along its
 * lane on the wire's 0.1 m grid. */
export interface FleetShip {
  /** Room-unique, ascending. */
  id: number;
  /** Its lane (index into FLEET_LANES): its class, layer, altitude, speed. */
  lane: number;
  /** When it came on, server ms. */
  t0: number;
  /** Where along its lane it was at t0, m. */
  s0: number;
  /** Its full HP (its class's, × the room's tuning). */
  hp0: number;
  /** Its crash, once it was shot down. */
  down: ShipDown | null;
}

/** A ship's class. */
export const shipClass = (s: FleetShip): ShipClassId =>
  (FLEET_LANES[s.lane] as FleetLane).cls;

/** A ship's pose: centre (canonical x/z), the yaw its frame carries
 * (local +X = world (cos yaw, −sin yaw), MoverBox's convention), the nose's
 * pitch (0 in flight; negative falling) and its unit plan heading. */
export interface ShipPose {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  hx: number;
  hz: number;
}

export const blankPose = (): ShipPose => ({
  x: 0,
  y: 0,
  z: 0,
  yaw: 0,
  pitch: 0,
  hx: 1,
  hz: 0,
});

/** A lane's pose at along-lane position `s`, into `out`. Pure. T1: a line
 * runs straight across the torus; an orbit goes round its circle (`s` the
 * arc length from +x, anticlockwise: +x towards +z); a berth holds its
 * dock, swaying and bobbing round its cycle (`s` its phase). */
export function lanePoseInto(lane: number, s: number, out: ShipPose): ShipPose {
  const ln = FLEET_LANES[lane] as FleetLane;
  const ly = FLEET_LAYERS[ln.layer] as FleetLayer;
  const sg = ln.v < 0 ? -1 : 1;
  if (ly.path === PATH_ORBIT) {
    const th = s / ln.r;
    const c = Math.cos(th);
    const sn = Math.sin(th);
    out.x = wrapCoord(ln.cx + ln.r * c);
    out.y = ln.alt;
    out.z = wrapCoord(ln.cz + ln.r * sn);
    out.hx = -sn * sg;
    out.hz = c * sg;
  } else if (ly.path === PATH_MOOR) {
    const ph = (2 * Math.PI * s) / MOOR_CYCLE;
    const yaw = ln.yaw + MOOR_SWAY_YAW * Math.sin(ph);
    out.x = ln.cx;
    out.y = ln.alt + MOOR_SWAY_BOB * Math.cos(ph);
    out.z = ln.cz;
    out.hx = Math.cos(yaw);
    out.hz = -Math.sin(yaw);
  } else {
    // The lane's origin: `u` across the heading from the layer's own.
    out.x = wrapCoord(-ly.dz * ln.u + ly.dx * s);
    out.y = laneAltAt(lane, s);
    out.z = wrapCoord(ly.dx * ln.u + ly.dz * s);
    out.hx = ly.dx * sg;
    out.hz = ly.dz * sg;
  }
  out.yaw = Math.atan2(-out.hz, out.hx);
  out.pitch = 0;
  return out;
}

/** Z1: the same pose as fleetPoseAt, into a Float64Array at `o`: [x, y, z,
 * yaw, pitch, hx, hz] — what a per-frame loop over the whole fleet reads
 * (a typed array's doubles are never boxed; a plain object's fields are).
 * Bit for bit fleetPoseAt's: the same functions into a scratch pose. */
export function fleetPoseInto64(
  ship: FleetShip,
  t: number,
  out: Float64Array,
  o: number,
): void {
  const d = ship.down;
  if (d !== null && t >= d.t) {
    fallPoseInto(d, t, pose64);
  } else {
    const ln = FLEET_LANES[ship.lane] as FleetLane;
    const s = ship.s0 + (ln.v * ((t > ship.t0 ? t : ship.t0) - ship.t0)) / 1000;
    lanePoseInto(ship.lane, s, pose64);
  }
  out[o] = pose64.x;
  out[o + 1] = pose64.y;
  out[o + 2] = pose64.z;
  out[o + 3] = pose64.yaw;
  out[o + 4] = pose64.pitch;
  out[o + 5] = pose64.hx;
  out[o + 6] = pose64.hz;
}
const pose64: ShipPose = {
  x: 0.5,
  y: 0.5,
  z: 0.5,
  yaw: 0.5,
  pitch: 0.5,
  hx: 0.5,
  hz: 0.5,
};

/** Where along its lane a ship is at `t` (unwrapped), m. */
export const shipAlong = (s: FleetShip, t: number): number =>
  s.s0 + ((FLEET_LANES[s.lane] as FleetLane).v * (t - s.t0)) / 1000;

/** How far a falling ship's nose drops, rad (the asymptote), and how fast
 * it gets there (time constant, s). */
export const SHIP_FALL_PITCH = 0.55;
export const SHIP_FALL_PITCH_TAU_S = 2.2;
/** How fast a falling ship's heading turns, rad/s (× its spin). */
export const SHIP_FALL_YAW_RATE = 0.07;

/** A crashing ship's pose at server time `t` (clamped to its fall). */
export function fallPoseInto(d: ShipDown, t: number, out: ShipPose): ShipPose {
  wreckPosAt(d, t, out);
  const s = Math.min(Math.max(t - d.t, 0), d.end) / 1000;
  out.yaw = d.yaw + d.spin * SHIP_FALL_YAW_RATE * s;
  out.hx = Math.cos(out.yaw);
  out.hz = -Math.sin(out.yaw);
  out.pitch = -SHIP_FALL_PITCH * (1 - Math.exp(-s / SHIP_FALL_PITCH_TAU_S));
  return out;
}

/**
 * THE ship pose: where `ship` is at server time `t`, into `out` — flying
 * its lane until it went down, then falling. A pure function of the ship's
 * record and the clock; outside [t0, its crash] the path's ends clamp.
 */
export function fleetPoseAt(
  ship: FleetShip,
  t: number,
  out: ShipPose,
): ShipPose {
  const d = ship.down;
  if (d && t >= d.t) return fallPoseInto(d, t, out);
  return lanePoseInto(ship.lane, shipAlong(ship, Math.max(t, ship.t0)), out);
}

/** Its velocity at `t`, m/s (zero before it came on and once it hit).
 * T1: an orbit's is along its circle; a berth's is nil (its sway is a few
 * centimetres a second). */
export function shipVelAt(ship: FleetShip, t: number, out: Vec3): Vec3 {
  const d = ship.down;
  if (d && t >= d.t) return wreckVelAt(d, t, out);
  const ln = FLEET_LANES[ship.lane] as FleetLane;
  const ly = FLEET_LAYERS[ln.layer] as FleetLayer;
  const on = t >= ship.t0 ? 1 : 0;
  const along = shipAlong(ship, Math.max(t, ship.t0));
  if (ly.path === PATH_MOOR) {
    out.x = 0;
    out.y = 0;
    out.z = 0;
    return out;
  }
  if (ly.path === PATH_ORBIT) {
    const th = along / ln.r;
    out.x = -Math.sin(th) * ln.v * on;
    out.y = 0;
    out.z = Math.cos(th) * ln.v * on;
    return out;
  }
  out.x = ly.dx * ln.v * on;
  // K1: a rooftop ship rises and settles along its profile.
  out.y = laneClimbAt(ship.lane, along) * ln.v * on;
  out.z = ly.dz * ln.v * on;
  return out;
}

/** Is the ship intact and in the air at `t`? */
export const shipPresent = (s: FleetShip, t: number): boolean =>
  t >= s.t0 && !(s.down !== null && t >= s.down.t);

/** Is it falling (shot down, not yet hit) at `t`? */
export const shipFalling = (s: FleetShip, t: number): boolean =>
  s.down !== null && t >= s.down.t && t < s.down.t + s.down.end;

/** Has its crash landed by `t`? */
export const shipLanded = (s: FleetShip, t: number): boolean =>
  s.down !== null && t >= s.down.t + s.down.end;

// --- The ship frame ---------------------------------------------------------------

/** World delta (from the ship's centre) → ship frame, into `out`: the yaw
 * undone, then the pitch (about the ship's own +Z). */
export function shipLocalInto(
  pose: ShipPose,
  dx: number,
  dy: number,
  dz: number,
  out: Vec3,
): Vec3 {
  const c = Math.cos(pose.yaw);
  const s = Math.sin(pose.yaw);
  const ax = c * dx - s * dz;
  const az = s * dx + c * dz;
  const cp = Math.cos(pose.pitch);
  const sp = Math.sin(pose.pitch);
  out.x = cp * ax + sp * dy;
  out.y = -sp * ax + cp * dy;
  out.z = az;
  return out;
}

/** Ship-frame point (lx, ly, lz) placed by `pose` into canonical world
 * `out` — the inverse of shipLocalInto. */
export function shipPointInto(
  pose: ShipPose,
  lx: number,
  ly: number,
  lz: number,
  out: Vec3,
): Vec3 {
  const cp = Math.cos(pose.pitch);
  const sp = Math.sin(pose.pitch);
  const ax = cp * lx - sp * ly;
  const ay = sp * lx + cp * ly;
  const c = Math.cos(pose.yaw);
  const s = Math.sin(pose.yaw);
  out.x = wrapCoord(pose.x + c * ax + s * lz);
  out.y = pose.y + ay;
  out.z = wrapCoord(pose.z - s * ax + c * lz);
  return out;
}

/** Does a sphere at ship-frame `l` touch class `cls`'s hull? The box
 * first, then a solid of revolution's exact distance. */
function hullTouches(cls: ShipClassId, l: Vec3, radius: number): boolean {
  const parts = SHIP_PARTS[cls] as readonly BossPart[];
  const r2 = radius * radius;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i] as BossPart;
    const qx = l.x - p.x;
    const qy = l.y - p.y;
    const qz = l.z - p.z;
    const ex = Math.max(0, Math.abs(qx) - p.hx);
    const ey = Math.max(0, Math.abs(qy) - p.hy);
    const ez = Math.max(0, Math.abs(qz) - p.hz);
    if (ex * ex + ey * ey + ez * ez > r2) continue;
    if (p.rev === null || revSdf(p.rev, qx, Math.hypot(qy, qz)) <= radius) {
      return true;
    }
  }
  return false;
}

/** Signed distance from ship-frame `l` to class `cls`'s hull (negative
 * inside): the least over its parts. */
export function shipSdf(cls: ShipClassId, l: Vec3): number {
  let d = Number.POSITIVE_INFINITY;
  for (const p of SHIP_PARTS[cls] as readonly BossPart[]) {
    d = Math.min(d, bossPartSdf(p, l.x - p.x, l.y - p.y, l.z - p.z));
  }
  return d;
}

/** The centre of weak point `k` (its part's centre) of a class `cls` ship
 * at `pose`. */
export function weakPointInto(
  pose: ShipPose,
  cls: ShipClassId,
  k: number,
  out: Vec3,
): Vec3 {
  const p = (SHIP_PARTS[cls] as readonly BossPart[])[
    BOSS_WEAK_POINTS[k] as number
  ] as BossPart;
  return shipPointInto(pose, p.x, p.y, p.z, out);
}

/** Turret `k`'s muzzle (the middle of its outer face) on a class `cls`
 * ship at `pose`. */
export function turretMuzzleInto(
  pose: ShipPose,
  cls: ShipClassId,
  k: number,
  out: Vec3,
): Vec3 {
  const t = BOSS_TURRETS[k] as { part: number; up: 1 | -1 };
  const p = (SHIP_PARTS[cls] as readonly BossPart[])[t.part] as BossPart;
  return shipPointInto(pose, p.x, p.y + t.up * p.hy, p.z, out);
}

// --- The room's fleet, as both sides hold it -------------------------------------

/** A room's fleet on both sides: its ships — flying, or shot down and
 * falling, or landed and not yet cleared — and the launches still on (or
 * just off) their rigs, oldest first. Mutated in place (a mover field holds
 * it, like the news heli's slot). */
export interface FleetSlot {
  ships: FleetShip[];
  launches: BossLaunch[];
}

export const emptyFleetSlot = (): FleetSlot => ({ ships: [], launches: [] });

/** The ship with this id, or null. */
export function shipById(slot: FleetSlot, id: number): FleetShip | null {
  for (const s of slot.ships) if (s.id === id) return s;
  return null;
}

/** How many ships are intact and in the air at `t`. */
export function shipsUp(slot: FleetSlot, t: number): number {
  let n = 0;
  for (const s of slot.ships) if (shipPresent(s, t)) n++;
  return n;
}

const hitPose = blankPose();
const hitLocal: Vec3 = { x: 0, y: 0, z: 0 };

/**
 * The mover-field query: the first ship (intact, or falling) a sphere at
 * `pos` touches at server time `t`, or null — kind "boss" for a flying
 * hull, "bossDebris" for a falling one, the ship's id. Cheap rejects first
 * (its layer's altitude band, then plan distance), so it can sit in the bot
 * probe loop.
 */
export function collideBoss(
  slot: FleetSlot,
  pos: Vec3,
  radius: number,
  t: number,
): MoverHit | null {
  const ships = slot.ships;
  for (let i = 0; i < ships.length; i++) {
    const ship = ships[i] as FleetShip;
    if (t < ship.t0) continue;
    const d = ship.down;
    const falling = d !== null && t >= d.t;
    if (d !== null && falling && t >= d.t + d.end) continue;
    const lane = FLEET_LANES[ship.lane] as FleetLane;
    const reach = SHIP_REACH[lane.cls] as ShipReach;
    if (
      !falling &&
      (pos.y < laneAltLo(ship.lane) - reach.y - radius ||
        pos.y > laneAltHi(ship.lane) + reach.y + radius)
    ) {
      continue;
    }
    fleetPoseAt(ship, t, hitPose);
    const dx = wrapDeltaAxis(hitPose.x, pos.x);
    const dz = wrapDeltaAxis(hitPose.z, pos.z);
    const dy = pos.y - hitPose.y;
    if (falling) {
      const rr = reach.r + radius;
      if (dx * dx + dy * dy + dz * dz > rr * rr) continue;
    } else {
      const rr = reach.xz + radius;
      if (dx * dx + dz * dz > rr * rr) continue;
    }
    shipLocalInto(hitPose, dx, dy, dz, hitLocal);
    if (hullTouches(lane.cls, hitLocal, radius)) {
      return { kind: falling ? "bossDebris" : "boss", id: ship.id };
    }
  }
  return null;
}

/** Seconds of straight run-out a respawn must have clear of every ship. */
export const BOSS_SPAWN_RUNOUT_S = 6;
/** ...by this margin, m. */
export const BOSS_SPAWN_MARGIN = 30;

/**
 * Is a spawn at `pos` flying `yaw` (flight convention: yaw 0 faces −Z) at
 * `speed` clear of every ship — intact or falling — for its first
 * BOSS_SPAWN_RUNOUT_S, by BOSS_SPAWN_MARGIN? Spawn protection does not stop
 * a crash, so a spawn must never be pointed into a hull. `yaw` null (not
 * known yet) asks for every heading: the whole run-out disc must be clear.
 */
export function bossSpawnClear(
  slot: FleetSlot,
  pos: Vec3,
  yaw: number | null,
  speed: number,
  now: number,
): boolean {
  if (slot.ships.length === 0) return true;
  const fx = yaw === null ? 0 : -Math.sin(yaw);
  const fz = yaw === null ? 0 : -Math.cos(yaw);
  const margin =
    yaw === null
      ? BOSS_SPAWN_MARGIN + speed * BOSS_SPAWN_RUNOUT_S
      : BOSS_SPAWN_MARGIN;
  for (let s = 0; s <= BOSS_SPAWN_RUNOUT_S; s += 0.25) {
    spawnAt.x = wrapCoord(pos.x + fx * speed * s);
    spawnAt.y = pos.y;
    spawnAt.z = wrapCoord(pos.z + fz * speed * s);
    if (collideBoss(slot, spawnAt, margin, now + s * 1000)) return false;
    if (yaw === null) break;
  }
  return true;
}
const spawnAt: Vec3 = { x: 0, y: 0, z: 0 };

// --- The crash -------------------------------------------------------------------

/** What a falling ship is swept against: the room's city as it stands. */
export interface BossSweepWorld {
  buildings: readonly Building[];
  index?: CityIndex;
}

/** A crashing ship leaves with its flight velocity and this much more
 * sink, m/s. */
const FALL_KICK_DOWN = -2;
/** T1: how hard a moored ship lurches into its tower as it goes down,
 * m/s. */
export const MOOR_LURCH = 4;

/** The spheres a falling hull is swept with: stations along its envelope,
 * each as wide as the envelope there (never under 2 m), per class. */
const SWEEP_STATIONS: readonly (readonly { x: number; r: number }[])[] =
  SHIP_PROFILES.map((prof) => {
    const first = prof[0] as readonly [number, number];
    const last = prof[prof.length - 1] as readonly [number, number];
    const out: { x: number; r: number }[] = [];
    let x = first[0] + 1;
    while (x < last[0]) {
      const r = Math.max(2, profileR(prof, x));
      out.push({ x, r });
      x += Math.max(2, r * 0.8);
    }
    out.push({ x: last[0] - 1, r: Math.max(2, profileR(prof, last[0] - 1)) });
    return out;
  });

const sweepPose = blankPose();
const contactAt: Vec3 = { x: 0, y: 0, z: 0 };

interface Contact {
  hit: WreckHit;
  r: number;
  building: Building | null;
}

function crashContactAt(
  cls: ShipClassId,
  d: ShipDown,
  ms: number,
  world: BossSweepWorld,
): Contact | null {
  fallPoseInto(d, ms, sweepPose);
  for (const st of SWEEP_STATIONS[cls] as readonly { x: number; r: number }[]) {
    shipPointInto(sweepPose, st.x, 0, 0, contactAt);
    if (hitsGround(contactAt, st.r)) {
      return { hit: "ground", r: st.r, building: null };
    }
    const b = collideCity(contactAt, st.r, world.buildings, world.index);
    if (b) return { hit: "city", r: st.r, building: b };
  }
  return null;
}

/**
 * Sweep a crash for its first solid (the D4 recipe: fixed WRECK_STEP_MS
 * steps, then bisection). Nothing by WRECK_MAX_MS → it bursts in the air
 * there. Deterministic in its inputs.
 */
function crashImpact(
  cls: ShipClassId,
  d: ShipDown,
  world: BossSweepWorld,
): Pick<ShipDown, "end" | "hit" | "at" | "b"> {
  let lo = 0;
  for (let ms = WRECK_STEP_MS; ms <= WRECK_MAX_MS; ms += WRECK_STEP_MS) {
    let c = crashContactAt(cls, d, d.t + ms, world);
    if (!c) {
      lo = ms;
      continue;
    }
    let hi = ms;
    // The contact of the latest touching time is the one reported: keep a
    // copy, bisection overwrites the scratch.
    let at = { ...contactAt };
    for (let i = 0; i < 6; i++) {
      const mid = (lo + hi) / 2;
      const h = crashContactAt(cls, d, d.t + mid, world);
      if (h) {
        hi = mid;
        c = h;
        at = { ...contactAt };
      } else lo = mid;
    }
    return {
      end: Math.round(hi * 10) / 10,
      hit: c.hit,
      at: { x: at.x, y: Math.max(0, at.y - c.r), z: at.z },
      b: c.building ? world.buildings.indexOf(c.building) : -1,
    };
  }
  const pose = fallPoseInto(d, d.t + WRECK_MAX_MS, blankPose());
  const reach = SHIP_REACH[cls] as ShipReach;
  return {
    end: WRECK_MAX_MS,
    hit: "air",
    at: { x: pose.x, y: Math.max(0, pose.y - reach.y), z: pose.z },
    b: -1,
  };
}

/**
 * `ship` is shot down at server time `t`: its crash — leaving from exactly
 * where it flew with its flight velocity (and a little sink), its nose
 * dropping as it falls — swept once against `world` for where it lands.
 * Pure.
 */
export function shipCrash(
  ship: FleetShip,
  t: number,
  world: BossSweepWorld,
): ShipDown {
  const along = shipAlong(ship, Math.max(t, ship.t0));
  const pose = lanePoseInto(ship.lane, along, blankPose());
  const ln = FLEET_LANES[ship.lane] as FleetLane;
  const v = ln.v;
  // T1: a berth's ship lurches off its mast into its tower's face (its
  // dock is on the face, so its hull scrapes down it as it goes).
  const moored = lanePath(ship.lane) === PATH_MOOR;
  let vx = pose.hx * Math.abs(v);
  let vz = pose.hz * Math.abs(v);
  if (moored) {
    const c = shaftOf(ln.tower);
    const nx = wrapDeltaAxis(ln.cx, c.x);
    const nz = wrapDeltaAxis(ln.cz, c.z);
    const n = Math.hypot(nx, nz);
    vx = (nx / n) * MOOR_LURCH;
    vz = (nz / n) * MOOR_LURCH;
  }
  const d: ShipDown = {
    t,
    p: { x: pose.x, y: pose.y, z: pose.z },
    v: {
      x: vx,
      y: FALL_KICK_DOWN + (moored ? 0 : laneClimbAt(ship.lane, along) * v),
      z: vz,
    },
    yaw: pose.yaw,
    spin: ship.id % 2 === 0 ? 1 : -1,
    end: WRECK_MAX_MS,
    hit: "air",
    at: { x: 0, y: 0, z: 0 },
    b: -1,
  };
  return { ...d, ...crashImpact(shipClass(ship), d, world) };
}

// --- Launches -----------------------------------------------------------------
//
// S9: the airships are carriers. An enemy plane is launched from one of them
// instead of the street: dropped from the belly hangar's trapeze (every
// class) or flung off the dorsal catapult (carriers only). The server picks
// the ship, the rig and the start time (server/src/boss.ts planLaunch), so a
// launch is one small broadcast — everything else is a pure function of the
// ship, the launch and the clock: where the plane hangs and the exact pose
// it is released at, which is the bot's spawn.

/** Start to release, ms, per kind. Never longer than the kill-cam, so a
 * launch planned at the death releases on the bot's normal respawn time. */
export const LAUNCH_SEQ_MS: readonly number[] = [2400, 1800];
/** A rig stays busy this long after a release, ms. */
export const LAUNCH_RESET_MS = 1000;
/** After release the bot flies its launch run straight (its stick neutral)
 * and the fleet is not solid to it, for this long, ms. */
export const LAUNCH_GRACE_MS: readonly number[] = [1800, 1500];
/** Release speed (the respawn speed) and pitch: a dive off the hook, a
 * gentle climb off the deck, rad. */
export const LAUNCH_SPEED = RESPAWN_SPEED;
export const LAUNCH_PITCH: readonly number[] = [-0.32, 0.08];
/** K1: the belly drop's pitch off a ship cruising an avenue — a shallow
 * slide off the hook down the street, not a dive into it, rad. */
export const LAUNCH_STREET_PITCH = -0.1;
/** The release pitch of rig `kind` on a ship of a street lane or not. */
export const launchPitch = (kind: LaunchKind, street: boolean): number =>
  kind === LAUNCH_BELLY && street
    ? LAUNCH_STREET_PITCH
    : (LAUNCH_PITCH[kind] as number);
/** The belly bay (base hull frame): its centre x, the plane stowed inside
 * the keel, and how far the trapeze lowers it, m — scaled with the hull. */
export const BAY_X = -4;
export const BAY_STOW_Y = -21.5;
const BAY_HANG_Y = -31;
/** The catapult run along the deck, base hull x, and the plane's height
 * over the deck plate (its wheels on the carriage — never scaled), m. */
export const CATAPULT_FROM_X = 12;
export const CATAPULT_TO_X = 42;
export const DECK_PLANE_H = 1.6;

/** One launch, exactly as broadcast. */
export interface BossLaunch {
  id: number;
  /** The ship that launches it. */
  ship: number;
  kind: LaunchKind;
  /** When the sequence starts, server ms. */
  t0: number;
}

export const launchReleaseAt = (l: BossLaunch): number =>
  l.t0 + (LAUNCH_SEQ_MS[l.kind] as number);
/** When its rig is free again, ms. */
export const launchDoneAt = (l: BossLaunch): number =>
  launchReleaseAt(l) + LAUNCH_RESET_MS;

/** The launched plane's pose in the ship's frame (x nose, y up, z
 * starboard), its nose along +X pitched by `pitch` (rad, + up). */
export interface LaunchLocal {
  x: number;
  y: number;
  z: number;
  pitch: number;
}

const smooth = (u: number): number => {
  const c = Math.min(1, Math.max(0, u));
  return c * c * (3 - 2 * c);
};

/** Where the plane is on its rig of a class `cls` ship at server time `t`
 * (clamped to the sequence: at and after release, the release pose) — off
 * a ship cruising an avenue when `street` (K1: a shallower belly drop).
 * Pure. */
export function launchLocalAt(
  l: BossLaunch,
  cls: ShipClassId,
  t: number,
  out: LaunchLocal,
  street = false,
): LaunchLocal {
  const c = SHIP_CLASSES[cls] as ShipClass;
  const s =
    Math.min(Math.max(t - l.t0, 0), LAUNCH_SEQ_MS[l.kind] as number) / 1000;
  if (l.kind === LAUNCH_BELLY) {
    // Doors 0–0.6 s, lowered 0.6–1.7 s, tipped nose-down to the release
    // pitch 1.7–2.4 s.
    out.x = BAY_X * c.sx;
    out.y =
      (BAY_STOW_Y + (BAY_HANG_Y - BAY_STOW_Y) * smooth((s - 0.6) / 1.1)) * c.sr;
    out.z = 0;
    out.pitch = launchPitch(LAUNCH_BELLY, street) * smooth((s - 1.7) / 0.7);
    return out;
  }
  // Steam 0–0.6 s, then the run: constant acceleration over 1.2 s, the nose
  // lifting to the release pitch over its last 0.4 s.
  const u = Math.min(1, Math.max(0, (s - 0.6) / 1.2));
  out.x = (CATAPULT_FROM_X + (CATAPULT_TO_X - CATAPULT_FROM_X) * u * u) * c.sx;
  out.y = BOSS_DECK_Y * c.sr + DECK_PLANE_H;
  out.z = 0;
  out.pitch = (LAUNCH_PITCH[1] as number) * smooth((s - 1.4) / 0.4);
  return out;
}

/** The release: where the bot spawns (the plane's pose on the rig at the
 * release instant, placed by the ship's pose then), its flight yaw (yaw 0
 * faces −Z) and pitch, and its speed. Pure. */
export function launchSpawnAt(
  ship: FleetShip,
  l: BossLaunch,
): { pos: Vec3; yaw: number; pitch: number; speed: number } {
  const t = launchReleaseAt(l);
  const pose = fleetPoseAt(ship, t, blankPose());
  const at = launchLocalAt(
    l,
    shipClass(ship),
    t,
    { x: 0, y: 0, z: 0, pitch: 0 },
    laneStreet(ship.lane),
  );
  const pos = shipPointInto(pose, at.x, at.y, at.z, { x: 0, y: 0, z: 0 });
  return {
    pos,
    yaw: Math.atan2(-pose.hx, -pose.hz),
    pitch: at.pitch,
    speed: LAUNCH_SPEED,
  };
}

/** A launch on the wire: [id, ship, kind, t0]. */
export type WireLaunch = [id: number, ship: number, kind: number, t0: number];

export const encodeLaunch = (l: BossLaunch): WireLaunch => [
  l.id,
  l.ship,
  l.kind,
  l.t0,
];

export function decodeLaunch(w: unknown): BossLaunch | null {
  if (!Array.isArray(w) || w.length !== 4 || !w.every(finite)) return null;
  const [id, ship, kind, t0] = w as number[];
  if (kind !== LAUNCH_BELLY && kind !== LAUNCH_CATAPULT) return null;
  return { id: id as number, ship: ship as number, kind, t0: t0 as number };
}

// --- Hits ---------------------------------------------------------------------

/** rayBox's running interval (module scratch: the hit test allocates
 * nothing — it runs per round per frame near the zeppelin). */
let slabT0 = 0;
let slabT1 = 0;

/** Clip the running interval to one axis's slab; false once it is empty. */
function slab(o: number, d: number, h: number): boolean {
  if (Math.abs(d) < 1e-12) return Math.abs(o) <= h;
  let a = (-h - o) / d;
  let b = (h - o) / d;
  if (a > b) {
    const t = a;
    a = b;
    b = t;
  }
  if (a > slabT0) slabT0 = a;
  if (b < slabT1) slabT1 = b;
  return slabT0 <= slabT1;
}

/** Distance along a unit ray from `o` to an oriented box, or Infinity.
 * `o` is a delta from the box centre in world axes. */
export function rayBox(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  box: MoverBox,
  maxDist: number,
): number {
  const c = Math.cos(box.yaw);
  const s = Math.sin(box.yaw);
  // World → box frame (the inverse of placeLocal's rotation).
  const lox = c * ox - s * oz;
  const loz = s * ox + c * oz;
  const ldx = c * dx - s * dz;
  const ldz = s * dx + c * dz;
  slabT0 = 0;
  slabT1 = maxDist;
  if (!slab(lox, ldx, box.hx)) return Number.POSITIVE_INFINITY;
  if (!slab(oy, dy, box.hy)) return Number.POSITIVE_INFINITY;
  if (!slab(loz, ldz, box.hz)) return Number.POSITIVE_INFINITY;
  return slabT0;
}

/**
 * Distance along a ray (origin `o`, direction `d`, both in a solid of
 * revolution's own frame: axis +X) to the solid, or Infinity. Analytic: per
 * profile segment the surface is a cone frustum, y² + z² = (a + k·t·dx)²,
 * one quadratic in t; the end discs are planes. 0 when `o` is inside.
 */
export function rayRev(
  profile: BossProfile,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  maxDist: number,
): number {
  if (revSdf(profile, ox, Math.hypot(oy, oz)) <= 0) return 0;
  let best = Number.POSITIVE_INFINITY;
  const n = profile.length;
  for (let i = 1; i < n; i++) {
    const pa = profile[i - 1] as readonly [number, number];
    const pb = profile[i] as readonly [number, number];
    const x0 = pa[0];
    const r0 = pa[1];
    const x1 = pb[0];
    const r1 = pb[1];
    if (x1 - x0 <= 1e-9) {
      // A step: the annulus between r0 and r1 in the plane x = x0.
      if (Math.abs(dx) < 1e-12) continue;
      const t = (x0 - ox) / dx;
      if (!(t >= 0 && t < best && t <= maxDist)) continue;
      const rr = Math.hypot(oy + t * dy, oz + t * dz);
      if (rr >= Math.min(r0, r1) && rr <= Math.max(r0, r1)) best = t;
      continue;
    }
    const k = (r1 - r0) / (x1 - x0);
    const a = r0 + k * (ox - x0);
    const A = dy * dy + dz * dz - k * k * dx * dx;
    const B = 2 * (oy * dy + oz * dz - a * k * dx);
    const C = oy * oy + oz * oz - a * a;
    let ta = Number.NaN;
    let tb = Number.NaN;
    if (Math.abs(A) < 1e-12) {
      if (Math.abs(B) > 1e-12) ta = -C / B;
    } else {
      const disc = B * B - 4 * A * C;
      if (disc < 0) continue;
      const sq = Math.sqrt(disc);
      ta = (-B - sq) / (2 * A);
      tb = (-B + sq) / (2 * A);
    }
    for (let j = 0; j < 2; j++) {
      const t = j === 0 ? ta : tb;
      if (!(t >= 0 && t < best && t <= maxDist)) continue;
      const x = ox + t * dx;
      if (x < x0 - 1e-9 || x > x1 + 1e-9 || a + k * t * dx < 0) continue;
      best = t;
    }
  }
  // The end discs (a cut section's open faces).
  for (let j = 0; j < 2; j++) {
    const pe = profile[j === 0 ? 0 : n - 1] as readonly [number, number];
    const xe = pe[0];
    const re = pe[1];
    if (re <= 0 || Math.abs(dx) < 1e-12) continue;
    const t = (xe - ox) / dx;
    if (!(t >= 0 && t < best && t <= maxDist)) continue;
    if (Math.hypot(oy + t * dy, oz + t * dz) <= re) best = t;
  }
  return best;
}

/** Distance along a unit ray from `o` (a delta from the part's centre, world
 * axes) to part `p` placed as `box`, or Infinity: the box for a box part,
 * the box then the exact solid for a solid of revolution. */
export function rayPart(
  p: BossPart,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  box: MoverBox,
  maxDist: number,
): number {
  const t = rayBox(ox, oy, oz, dx, dy, dz, box, maxDist);
  if (p.rev === null || t === Number.POSITIVE_INFINITY) return t;
  const c = Math.cos(box.yaw);
  const s = Math.sin(box.yaw);
  return rayRev(
    p.rev,
    c * ox - s * oz,
    oy,
    s * ox + c * oz,
    c * dx - s * dz,
    dy,
    s * dx + c * dz,
    maxDist,
  );
}

/** Distance along a unit ray from `o` (a delta from the centre) to a sphere,
 * or Infinity. */
function raySphere(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  radius: number,
  maxDist: number,
): number {
  const b = ox * dx + oy * dy + oz * dz;
  const c = ox * ox + oy * oy + oz * oz - radius * radius;
  if (c <= 0) return 0;
  const disc = b * b - c;
  if (disc < 0) return Number.POSITIVE_INFINITY;
  const t = -b - Math.sqrt(disc);
  return t >= 0 && t <= maxDist ? t : Number.POSITIVE_INFINITY;
}

/** Distance along a unit ray from `o` (a delta from the box centre, in the
 * box's own axes) to an axis-aligned box of half-extents h, or Infinity. */
function rayAabb(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  hx: number,
  hy: number,
  hz: number,
  maxDist: number,
): number {
  slabT0 = 0;
  slabT1 = maxDist;
  if (!slab(ox, dx, hx)) return Number.POSITIVE_INFINITY;
  if (!slab(oy, dy, hy)) return Number.POSITIVE_INFINITY;
  if (!slab(oz, dz, hz)) return Number.POSITIVE_INFINITY;
  return slabT0;
}

/** What a round meets first along its line. */
export interface BossRayHit {
  /** The weak point hit (index into BOSS_WEAK_POINTS), or -1: the hull. */
  weak: number;
  dist: number;
}

/** Weak point index of each BOSS_PARTS part (−1: not one). */
const WEAK_OF: readonly number[] = BOSS_PARTS.map((_, i) =>
  BOSS_WEAK_POINTS.indexOf(i),
);
const rayO: Vec3 = { x: 0, y: 0, z: 0 };
const rayD: Vec3 = { x: 0, y: 0, z: 0 };

/**
 * The first thing on a class `cls` ship at `pose` a round from `origin`
 * along unit `dir` meets within `maxDist`: a weak point (its sphere or its
 * own shape) or the hull (every other part). Null: a miss. The test runs in
 * the ship's frame, where its parts are axis-aligned and exact.
 */
export function shipRayHit(
  pose: ShipPose,
  cls: ShipClassId,
  origin: Vec3,
  dir: Vec3,
  maxDist: number,
): BossRayHit | null {
  shipLocalInto(
    pose,
    wrapDeltaAxis(pose.x, origin.x),
    origin.y - pose.y,
    wrapDeltaAxis(pose.z, origin.z),
    rayO,
  );
  // A direction turns like a delta (no translation).
  shipLocalInto(pose, dir.x, dir.y, dir.z, rayD);
  const parts = SHIP_PARTS[cls] as readonly BossPart[];
  const weakR = SHIP_WEAK_R[cls] as number;
  let bestWeak = -1;
  let bestDist = Number.POSITIVE_INFINITY;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i] as BossPart;
    const ox = rayO.x - p.x;
    const oy = rayO.y - p.y;
    const oz = rayO.z - p.z;
    const k = WEAK_OF[i] as number;
    let d = rayAabb(
      ox,
      oy,
      oz,
      rayD.x,
      rayD.y,
      rayD.z,
      p.hx,
      p.hy,
      p.hz,
      maxDist,
    );
    if (p.rev !== null && d !== Number.POSITIVE_INFINITY) {
      d = rayRev(p.rev, ox, oy, oz, rayD.x, rayD.y, rayD.z, maxDist);
    }
    if (k >= 0) {
      d = Math.min(
        d,
        raySphere(ox, oy, oz, rayD.x, rayD.y, rayD.z, weakR, maxDist),
      );
    }
    if (d < bestDist) {
      bestDist = d;
      bestWeak = k;
    }
  }
  return bestDist === Number.POSITIVE_INFINITY
    ? null
    : { weak: bestWeak, dist: bestDist };
}

/** How far past a weak point's own sphere the server's ray test still
 * credits it, m — absorbs the claimed time's rounding. */
export const BOSS_HIT_SLACK = 3;

/**
 * The server's judgement of a round claimed to hit weak point `k` (or the
 * hull, k = −1) of a class `cls` ship at `pose`, along the claimed line,
 * within BULLET_RANGE: a hull claim stands when the round meets the ship at
 * all; a weak-point claim only when `k` is what it meets first — never
 * through the envelope, never another weak point. The slack only ever
 * widens `k`'s own sphere.
 */
export function shipHitValid(
  pose: ShipPose,
  cls: ShipClassId,
  k: number,
  origin: Vec3,
  dir: Vec3,
): boolean {
  if (!Number.isInteger(k) || k < -1 || k >= BOSS_WEAK_POINTS.length) {
    return false;
  }
  const first = shipRayHit(pose, cls, origin, dir, BULLET_RANGE);
  if (k === -1) return first !== null;
  if (first && first.weak === k) return true;
  // Not first on the exact line: still fair if the round passed within the
  // slack of k's sphere before anything else stopped it.
  weakPointInto(pose, cls, k, slackAt);
  const off = wrapDelta(slackAt, origin);
  const t = raySphere(
    off.x,
    off.y,
    off.z,
    dir.x,
    dir.y,
    dir.z,
    (SHIP_WEAK_R[cls] as number) + BOSS_HIT_SLACK,
    BULLET_RANGE,
  );
  if (t === Number.POSITIVE_INFINITY) return false;
  return !first || first.dist >= t;
}
const slackAt: Vec3 = { x: 0, y: 0, z: 0 };

// --- Flak ---------------------------------------------------------------------

/** Turret reach, m: no shell at anything further, or nearer than MIN. */
export const BOSS_FLAK_RANGE = 460;
export const BOSS_FLAK_MIN_RANGE = 60;
/** A turret's traverse: its target within this of its face normal, rad —
 * so a plane level with the hull's flanks is in every turret's blind band. */
export const BOSS_FLAK_CONE = 1.45;
/** Shell speed, m/s, and the shortest fuse any shell is given, ms: every
 * shell is in the air (tracer drawn) at least this long — the telegraph. */
export const BOSS_FLAK_SPEED = 260;
export const BOSS_FLAK_MIN_FUSE_MS = 1200;
/** Aim wander, rad — the bots' own cap, never tighter. */
export const BOSS_FLAK_JITTER = BOT_AIM_JITTER;
/** A turret holds fire this long on a new target, ms — never quicker than a
 * bot's reaction. */
export const BOSS_FLAK_REACTION_MS = Math.max(900, BOT_REACTION_MS);
/** One shell per turret per this, ms. */
export const BOSS_FLAK_INTERVAL_MS = 1800;
/** The burst as drawn, m — and as judged, smaller (the victim's slack). */
export const BOSS_FLAK_BURST_R = 14;
export const BOSS_FLAK_DAMAGE_R = 11;
/** Damage at the burst's centre, falling to 0 at BOSS_FLAK_DAMAGE_R. */
export const BOSS_FLAK_DAMAGE = 22;
/** No plane takes more flak than this in any rolling second, across every
 * turret. */
export const BOSS_FLAK_DPS_CAP = 30;

/** A plane as a turret sees it. */
export interface FlakTarget {
  pos: Vec3;
  vel: Vec3;
}

/**
 * Where turret `k` (muzzle `muzzle`, facing `up`) puts a shell at `target`:
 * lead on its velocity for the shell's flight, then wandered by up to
 * BOSS_FLAK_JITTER inside a cone (uniform over the disc). Null when the
 * target is out of range or outside the turret's traverse. The fuse is never
 * under BOSS_FLAK_MIN_FUSE_MS. Deterministic in `rand`.
 */
export function flakSolution(
  muzzle: Vec3,
  up: 1 | -1,
  target: FlakTarget,
  rand: () => number,
): { to: Vec3; fuse: number } | null {
  const d = wrapDelta(muzzle, target.pos);
  const dist = Math.hypot(d.x, d.y, d.z);
  if (dist > BOSS_FLAK_RANGE || dist < BOSS_FLAK_MIN_RANGE) return null;
  if ((d.y * up) / dist < Math.cos(BOSS_FLAK_CONE)) return null;
  // Lead: where it will be when a shell gets there (one refinement).
  let fuse = Math.max(BOSS_FLAK_MIN_FUSE_MS / 1000, dist / BOSS_FLAK_SPEED);
  let ax = d.x + target.vel.x * fuse;
  let ay = d.y + target.vel.y * fuse;
  let az = d.z + target.vel.z * fuse;
  fuse = Math.max(
    BOSS_FLAK_MIN_FUSE_MS / 1000,
    Math.hypot(ax, ay, az) / BOSS_FLAK_SPEED,
  );
  ax = d.x + target.vel.x * fuse;
  ay = d.y + target.vel.y * fuse;
  az = d.z + target.vel.z * fuse;
  const len = Math.hypot(ax, ay, az) || 1;
  // A basis square to the aim line (u, w unit), then a uniform point in the
  // jitter disc: the wander is never more than BOSS_FLAK_JITTER off the aim.
  const steep = Math.abs(ay / len) >= 0.9;
  const hx = steep ? 1 : 0;
  const hy = steep ? 0 : 1;
  let ux = -az * hy;
  let uy = az * hx;
  let uz = ax * hy - ay * hx;
  const ul = Math.hypot(ux, uy, uz) || 1;
  ux /= ul;
  uy /= ul;
  uz /= ul;
  const wx = (ay * uz - az * uy) / len;
  const wy = (az * ux - ax * uz) / len;
  const wz = (ax * uy - ay * ux) / len;
  const rad = Math.sqrt(rand()) * Math.tan(BOSS_FLAK_JITTER) * len;
  const ang = rand() * Math.PI * 2;
  const ou = Math.cos(ang) * rad;
  const ow = Math.sin(ang) * rad;
  const q = (v: number) => Math.round(v * 10) / 10;
  const qc = (v: number) => {
    const c = q(wrapCoord(v));
    return c >= WORLD_SIZE ? 0 : c;
  };
  return {
    to: {
      x: qc(muzzle.x + ax + ux * ou + wx * ow),
      y: q(muzzle.y + ay + uy * ou + wy * ow),
      z: qc(muzzle.z + az + uz * ou + wz * ow),
    },
    fuse: Math.round(fuse * 1000),
  };
}

/** Damage a plane `d` m from a burst takes (never more than a quarter of a
 * full plane). */
export function flakDamage(d: number): number {
  if (!(d >= 0) || d >= BOSS_FLAK_DAMAGE_R) return 0;
  return Math.min(
    MAX_HP / 4,
    (BOSS_FLAK_DAMAGE * (BOSS_FLAK_DAMAGE_R - d)) / BOSS_FLAK_DAMAGE_R,
  );
}

/** Z1: the fleet's guns are light — a share of S4's shell damage and of
 * the per-plane cap (the first carrier's old tier-1 scale). */
export const FLEET_FLAK_SCALE = 0.35;

/** One shell, exactly as broadcast: from its muzzle at its firing to its
 * burst point (both canonical on the 0.1 m grid), so a shell needs no ship
 * to draw — it outlives the one that fired it. */
export interface BossFlak {
  id: number;
  from: Vec3;
  to: Vec3;
  /** Fired at, server ms; bursts at t0 + fuse. */
  t0: number;
  fuse: number;
}

/** The shell's position at server time `ms` (clamped to its flight): a
 * straight line from the muzzle to the burst point. */
export function flakPosAt(f: BossFlak, ms: number, out: Vec3): Vec3 {
  const u = Math.min(1, Math.max(0, (ms - f.t0) / f.fuse));
  const dx = wrapDeltaAxis(f.from.x, f.to.x);
  const dz = wrapDeltaAxis(f.from.z, f.to.z);
  out.x = wrapCoord(f.from.x + dx * u);
  out.y = f.from.y + (f.to.y - f.from.y) * u;
  out.z = wrapCoord(f.from.z + dz * u);
  return out;
}

/** A canonical coordinate on the wire's 0.1 m grid. */
export const gridCoord = (v: number): number => {
  const c = Math.round(wrapCoord(v) * 10) / 10;
  return c >= WORLD_SIZE ? 0 : c;
};

// --- Credit -------------------------------------------------------------------

/** A dealer needs this share of the damage to be credited with the kill. */
export const BOSS_CREDIT_MIN_SHARE = 0.1;

export interface BossCredit {
  /** Every dealer, most damage first (ties: lower id first). */
  dealers: { id: string; damage: number; share: number }[];
  /** The dealers who earned the kill (share ≥ BOSS_CREDIT_MIN_SHARE). */
  credited: string[];
  /** Who dealt the most — the medal and the headline. */
  top: string | null;
}

/** Split the credit for a downed boss by damage dealt. Pure. */
export function bossCredit(damage: ReadonlyMap<string, number>): BossCredit {
  let total = 0;
  for (const v of damage.values()) if (v > 0) total += v;
  const dealers = [...damage]
    .filter(([, v]) => v > 0)
    .map(([id, v]) => ({ id, damage: v, share: total > 0 ? v / total : 0 }))
    .sort(
      (a, b) => b.damage - a.damage || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  return {
    dealers,
    credited: dealers
      .filter((d) => d.share >= BOSS_CREDIT_MIN_SHARE)
      .map((d) => d.id),
    top: dealers[0]?.id ?? null,
  };
}

// --- Schedule -------------------------------------------------------------------

export interface FleetTuning {
  /** A downed ship's lane is flown again this long after it went down, ms
   * (never while its crash is still falling). */
  refillMs: number;
  /** ...by a ship coming on out of every human's sight when one can be
   * found; past this much longer it comes on anyway, ms. */
  refillWaitMs: number;
  /** Every ship's HP multiplier (tests and QA fly paper hulls). */
  hpScale: number;
}

export const FLEET_TUNING: FleetTuning = {
  refillMs: 12_000,
  refillWaitMs: 20_000,
  hpScale: 1,
};

/** AB_BOSS_FAST=1 (tests and QA only): paper hulls, quick refills. */
export const FLEET_FAST_TUNING: FleetTuning = {
  refillMs: 3000,
  refillWaitMs: 2000,
  hpScale: 0.1,
};

/** A class's full HP under `hpScale` (whole, ≥ 1). */
export const shipFullHp = (cls: ShipClassId, hpScale: number): number =>
  Math.max(1, Math.round((SHIP_CLASSES[cls] as ShipClass).hp * hpScale));

/** A new ship comes on out of sight: at least this far, plan view, from
 * every human (past the fog), m. */
export const FLEET_HIDE_M = 900;

/**
 * Where along `lane` a ship coming on at `t` should start: of `tries`
 * evenly spaced spots (offset by `phase`, 0..1), the one furthest from its
 * nearest human — out of sight, so it drifts in from the haze. Returns the
 * spot (on the 0.1 m grid) and that distance (Infinity with no humans).
 */
export function hiddenLaneSpot(
  lane: number,
  humans: readonly Vec3[],
  phase: number,
  tries = 24,
): { s0: number; clear: number } {
  const len = laneLength(lane);
  let best = 0;
  let bestClear = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < tries; i++) {
    const s = (((i + phase) / tries) * len) % len;
    lanePoseInto(lane, s, spotPose);
    let clear = Number.POSITIVE_INFINITY;
    for (const h of humans) {
      clear = Math.min(
        clear,
        wrapDistance(
          { x: h.x, y: 0, z: h.z },
          { x: spotPose.x, y: 0, z: spotPose.z },
        ),
      );
    }
    if (clear > bestClear) {
      bestClear = clear;
      best = s;
    }
  }
  const s0 = Math.round(best * 10) / 10;
  return { s0: s0 >= len ? 0 : s0, clear: bestClear };
}
const spotPose = blankPose();

// --- Wire ---------------------------------------------------------------------

/** A ship on the wire: integers only, exactly reconstructible —
 * [id, lane, t0, s0 ×10, hp0]. */
export type WireShip = [
  id: number,
  lane: number,
  t0: number,
  s0: number,
  hp0: number,
];

export function encodeShip(s: FleetShip): WireShip {
  return [s.id, s.lane, s.t0, Math.round(s.s0 * 10), s.hp0];
}

const finite = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);

/** Inverse of encodeShip (with no crash); null for anything malformed. */
export function decodeShip(w: unknown): FleetShip | null {
  if (!Array.isArray(w) || w.length !== 5 || !w.every(finite)) return null;
  const [id, lane, t0, s0, hp0] = w as number[];
  if (!Number.isInteger(lane) || (lane as number) < 0) return null;
  if ((lane as number) >= FLEET_LANES.length || (hp0 as number) < 1) {
    return null;
  }
  return {
    id: id as number,
    lane: lane as number,
    t0: t0 as number,
    s0: (s0 as number) / 10,
    hp0: hp0 as number,
    down: null,
  };
}

/** A shell on the wire: [id, from ×10 (x, y, z), to ×10 (x, y, z), t0,
 * fuse]. */
export type WireFlak = [
  id: number,
  fx: number,
  fy: number,
  fz: number,
  tx: number,
  ty: number,
  tz: number,
  t0: number,
  fuse: number,
];

export function encodeFlak(f: BossFlak): WireFlak {
  return [
    f.id,
    Math.round(f.from.x * 10),
    Math.round(f.from.y * 10),
    Math.round(f.from.z * 10),
    Math.round(f.to.x * 10),
    Math.round(f.to.y * 10),
    Math.round(f.to.z * 10),
    f.t0,
    f.fuse,
  ];
}

export function decodeFlak(w: unknown): BossFlak | null {
  if (!Array.isArray(w) || w.length !== 9 || !w.every(finite)) return null;
  const [id, fx, fy, fz, tx, ty, tz, t0, fuse] = w as number[];
  if ((fuse as number) <= 0) return null;
  return {
    id: id as number,
    from: {
      x: (fx as number) / 10,
      y: (fy as number) / 10,
      z: (fz as number) / 10,
    },
    to: {
      x: (tx as number) / 10,
      y: (ty as number) / 10,
      z: (tz as number) / 10,
    },
    t0: t0 as number,
    fuse: fuse as number,
  };
}

const HITS: readonly WreckHit[] = [
  "city",
  "ground",
  "river",
  "tree",
  "mover",
  "air",
];
const isVec = (v: unknown): v is Vec3 =>
  typeof v === "object" &&
  v !== null &&
  finite((v as Vec3).x) &&
  finite((v as Vec3).y) &&
  finite((v as Vec3).z);

/** Shape check for a crash off the wire (a client never trusts a NaN). */
export function isShipDown(d: unknown): d is ShipDown {
  if (typeof d !== "object" || d === null) return false;
  const q = d as Record<string, unknown>;
  return (
    finite(q.t) &&
    isVec(q.p) &&
    isVec(q.v) &&
    finite(q.yaw) &&
    (q.spin === 1 || q.spin === -1) &&
    finite(q.end) &&
    (q.end as number) >= 0 &&
    (q.end as number) <= WRECK_MAX_MS &&
    HITS.includes(q.hit as WreckHit) &&
    isVec(q.at) &&
    Number.isInteger(q.b) &&
    (q.b as number) >= -1
  );
}

/** A room's whole fleet, as a welcome replays it: every ship (flying,
 * falling, or landed a moment ago), each one's HP and crash (null: still
 * flying) in the same order, and the launches still on their rigs (a joiner
 * sees the plane hang). */
export interface WireFleetState {
  s: WireShip[];
  hp: number[];
  d: (ShipDown | null)[];
  l?: WireLaunch[];
}

/** Install a welcome's fleet into a slot (null clears it — a resume into
 * another room must not keep the old room's ships). Returns each ship's HP
 * by id, to hold beside it. */
export function applyFleetState(
  slot: FleetSlot,
  state: WireFleetState | null | undefined,
): Map<number, number> {
  const hp = new Map<number, number>();
  slot.ships = [];
  slot.launches = [];
  if (!state || !Array.isArray(state.s)) return hp;
  state.s.forEach((w, i) => {
    const ship = decodeShip(w);
    if (!ship) return;
    const d = state.d?.[i];
    ship.down = isShipDown(d) ? d : null;
    slot.ships.push(ship);
    const v = state.hp?.[i];
    hp.set(
      ship.id,
      finite(v) ? Math.max(0, Math.min(ship.hp0, v)) : ship.down ? 0 : ship.hp0,
    );
  });
  if (Array.isArray(state.l)) {
    for (const w of state.l) {
      const l = decodeLaunch(w);
      if (l && shipById(slot, l.ship)) slot.launches.push(l);
    }
  }
  return hp;
}
