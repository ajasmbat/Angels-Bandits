// Moving obstacles (L2), shared verbatim by client and server — the city
// generation trick applied to geometry that MOVES. Every pose here is a pure
// function of (seed, server snapshot clock): both sides compute identical
// boxes from their own clock, so nothing about a crane, a helicopter or the
// blimp is ever streamed. There is no moving-obstacle replication problem to
// solve. No Math.random, no clock of its own; changing the draw order or the
// hash is a client/server protocol break, exactly like generateCity.
//
// The design rule this module exists to enforce (the ticket's, and it is what
// keeps the content list open-ended): anything that LOOKS solid in the flight
// band IS solid. So a hoist cable is a box here, not decoration, and a jib is
// generated so it can never end up buried inside a facade where it would be
// an invisible killer.
//
// ONE derivation of every pose. `partBox` is the only place a crane part's
// geometry is written down; craneBoxes (rendering) and collideMovers
// (collision) both go through it. Two derivations of one pose is how
// invisible walls are born — see the note on the tier stack in collision.ts.
//
// The three clients:
//   - Tower cranes on CONSTRUCTION_BLOCKS. Mast, jib, counter-jib, hook and
//     cable; the jib slews at a constant rate, so the hazard is a function of
//     WHEN you fly the canyon, not just where.
//   - Helicopters on straight torus loops along street axes.
//   - One blimp, circling below the cloud deck with a lit banner.

import {
  BLIMP_ALT,
  BLIMP_HULL,
  BLIMP_SPEED,
  BLOCK_PITCH,
  CRANE_CABLE_SIDE,
  CRANE_COUNTER_RATIO,
  CRANE_HOOK_DROP_MAX,
  CRANE_HOOK_DROP_MIN,
  CRANE_HUB_CLEARANCE,
  CRANE_JIB_MAX,
  CRANE_JIB_MIN,
  CRANE_JIB_SIDE,
  CRANE_JIB_STEP,
  CRANE_MAST_INSET,
  CRANE_MAST_MAX,
  CRANE_MAST_MIN,
  CRANE_MAST_SIDE,
  CRANE_SLEW_MAX,
  CRANE_SLEW_MIN,
  HELI_ALT_MAX,
  HELI_ALT_MIN,
  HELI_COUNT,
  HELI_HULL,
  HELI_SPEED_MAX,
  HELI_SPEED_MIN,
  PLAYER_RADIUS,
  WORLD_SIZE,
} from "../constants";
import { type Vec3, canonicalize, wrapDeltaAxis } from "../world/index";
import { type Building, mulberry32 } from "./index";
import { CONSTRUCTION_BLOCKS } from "./layout";

/** Which part of which mover a collision landed on. */
export type MoverKind =
  | "mast"
  | "jib"
  | "counterJib"
  | "hook"
  | "cable"
  | "helicopter"
  | "blimp";

/**
 * An oriented box. `x`/`z` are canonical in [0, WORLD_SIZE); `y` is the
 * center's altitude. Half-extents are in the box's OWN frame, which is the
 * world rotated about +Y by `yaw`: local +X maps to world (cos yaw, -sin yaw)
 * in (x, z) — Three.js's Y-rotation convention, so a renderer can hand `yaw`
 * straight to setFromAxisAngle(UP, yaw) with no sign to get wrong.
 */
export interface MoverBox {
  x: number;
  y: number;
  z: number;
  /** Half-length along local +X. */
  hx: number;
  /** Half-height (local +Y is world +Y; boxes never pitch or roll). */
  hy: number;
  /** Half-width along local +Z. */
  hz: number;
  yaw: number;
  kind: MoverKind;
  /** Which crane site / aircraft route this part belongs to. */
  id: number;
}

/** What a collision query reports. Allocated only on a hit. */
export interface MoverHit {
  kind: MoverKind;
  id: number;
}

/**
 * One tower crane. Everything here is fixed for a seed; only the slew angle
 * moves. `x`/`z` are the mast centerline, canonical.
 */
export interface CraneSite {
  id: number;
  x: number;
  z: number;
  /** Hub altitude — the top of the mast, where the jib pivots, m. */
  hubY: number;
  jibLength: number;
  counterLength: number;
  /** Slew phase at t = 0, rad, and the constant slew rate, rad/s (signed). */
  theta0: number;
  omega: number;
  /** Trolley distance out along the jib, and the hook's drop below the hub, m. */
  trolleyR: number;
  hookDrop: number;
}

/**
 * One aircraft on a straight torus loop. Loops run parallel to a world axis
 * so they close on the torus exactly (the traffic-lane trick); `cross` is the
 * fixed coordinate on the other axis.
 */
export interface AircraftRoute {
  id: number;
  kind: "helicopter" | "blimp";
  axis: "x" | "z";
  cross: number;
  dir: 1 | -1;
  /** Cruise speed, m/s, and the position along `axis` at t = 0, m. */
  speed: number;
  phase: number;
  y: number;
  /** Hull half-extents, m: along travel, vertical, across. */
  hx: number;
  hy: number;
  hz: number;
}

/** Every mover in the world, for one seed. Build once and reuse. */
export interface MoverField {
  readonly cranes: readonly CraneSite[];
  readonly aircraft: readonly AircraftRoute[];
}

/** A field with nothing in it — the safe default for callers that have none. */
export const EMPTY_MOVERS: MoverField = { cranes: [], aircraft: [] };

/** Per-site PRNG stream, the same spatial-hash recipe generateCity uses for
 * its per-block streams: a site's crane depends only on (seed, bx, bz), so
 * editing CONSTRUCTION_BLOCKS cannot shift another site's geometry. */
const siteSeed = (seed: number, bx: number, bz: number) =>
  (seed ^ Math.imul(bx + 1, 73856093) ^ Math.imul(bz + 1, 19349663)) >>> 0;

/** Route PRNG stream, keyed by route index — random access, like the storm's
 * per-bucket streams. Salted so it cannot share a stream with siteSeed. */
const routeRand = (seed: number, n: number): (() => number) =>
  mulberry32((seed ^ 0x2f1b7a3d ^ Math.imul(n + 1, 0x9e3779b9)) >>> 0);

const lerp = (lo: number, hi: number, t: number) => lo + t * (hi - lo);

/**
 * The tallest building whose footprint comes within `reach` of (x, z).
 *
 * Uses each building's TOTAL height and its tier-1 footprint, both of which
 * bound the whole tier stack — deliberately conservative, because being wrong
 * here means a jib buried in a facade. Torus-correct via wrapDeltaAxis.
 */
function tallestWithin(
  buildings: readonly Building[],
  x: number,
  z: number,
  reach: number,
): number {
  let tallest = 0;
  for (const b of buildings) {
    if (b.height <= tallest) continue;
    const dx = Math.max(0, Math.abs(wrapDeltaAxis(b.x, x)) - b.width / 2);
    const dz = Math.max(0, Math.abs(wrapDeltaAxis(b.z, z)) - b.depth / 2);
    if (dx * dx + dz * dz <= reach * reach) tallest = b.height;
  }
  return tallest;
}

/**
 * Generate every mover for a seed. `buildings` MUST be generateCity(seed) —
 * crane geometry is fitted to the city around each site, so handing in a
 * different city silently produces a different (and possibly buried) crane.
 * Both sides already hold that array, so this stays a pure function of seed.
 */
export function generateMovers(
  seed: number,
  buildings: readonly Building[],
): MoverField {
  const cranes: CraneSite[] = [];
  for (const [bx, bz] of CONSTRUCTION_BLOCKS) {
    const rand = mulberry32(siteSeed(seed, bx, bz));

    // Mast: set back from one seeded edge of its block, offset along that
    // edge. The setback is what makes the jib oversail the street.
    const edge = Math.floor(rand() * 4) % 4;
    const along = lerp(0.3, 0.7, rand()) * BLOCK_PITCH;
    const near = CRANE_MAST_INSET;
    const far = BLOCK_PITCH - CRANE_MAST_INSET;
    const localX = edge === 0 ? near : edge === 1 ? far : along;
    const localZ = edge === 2 ? near : edge === 3 ? far : along;
    const p = canonicalize({
      x: bx * BLOCK_PITCH + localX,
      y: 0,
      z: bz * BLOCK_PITCH + localZ,
    });

    const wantDrop = Math.round(
      lerp(CRANE_HOOK_DROP_MIN, CRANE_HOOK_DROP_MAX, rand()),
    );
    // Fit the jib to the city. Search downward from the longest jib for the
    // first length whose entire sweep clears every building it can reach with
    // CRANE_HUB_CLEARANCE to spare, WITHOUT lifting the hub out of its band.
    // The jib always loses to the buildings, never the other way round — a
    // crane that solved a tight site by climbing above the fight would be a
    // crane nobody ever has to fly around.
    let jibLength = CRANE_JIB_MIN;
    let hubY = CRANE_MAST_MAX;
    let clear = 0;
    for (let len = CRANE_JIB_MAX; len >= CRANE_JIB_MIN; len -= CRANE_JIB_STEP) {
      const reach = len + CRANE_JIB_SIDE / 2 + PLAYER_RADIUS;
      const floor =
        tallestWithin(buildings, p.x, p.z, reach) + CRANE_HUB_CLEARANCE;
      if (floor > CRANE_MAST_MAX) continue;
      jibLength = len;
      // Raise the hub for the hook's benefit only as far as the band allows.
      hubY = Math.max(
        CRANE_MAST_MIN,
        Math.min(CRANE_MAST_MAX, floor + wantDrop),
      );
      clear = hubY - floor;
      break;
    }
    // Whatever headroom is left under the hub is the hook's; a site with none
    // parks its hook at the trolley, which is what a real crane does.
    const hookDrop = Math.max(0, Math.min(wantDrop, Math.floor(clear)));

    cranes.push({
      id: cranes.length,
      x: p.x,
      z: p.z,
      hubY,
      jibLength,
      counterLength: Math.round(jibLength * CRANE_COUNTER_RATIO),
      theta0: rand() * Math.PI * 2,
      omega:
        lerp(CRANE_SLEW_MIN, CRANE_SLEW_MAX, rand()) * (rand() < 0.5 ? -1 : 1),
      trolleyR: Math.round(lerp(0.45, 0.85, rand()) * jibLength),
      hookDrop,
    });
  }

  // Helicopters ride street-axis loops; the blimp rides one of its own, high
  // and slow. Both close on the torus exactly because the loop is axis-parallel.
  const aircraft: AircraftRoute[] = [];
  for (let i = 0; i < HELI_COUNT; i++) {
    const rand = routeRand(seed, i);
    const axis: "x" | "z" = rand() < 0.5 ? "x" : "z";
    aircraft.push({
      id: aircraft.length,
      kind: "helicopter",
      axis,
      // Street centerlines are BLOCK_PITCH multiples; fly the canyons, not
      // the rooftops, so the loop reads as following a street from above.
      cross: Math.floor(rand() * (WORLD_SIZE / BLOCK_PITCH)) * BLOCK_PITCH,
      dir: rand() < 0.5 ? 1 : -1,
      speed: lerp(HELI_SPEED_MIN, HELI_SPEED_MAX, rand()),
      phase: rand() * WORLD_SIZE,
      y: Math.round(lerp(HELI_ALT_MIN, HELI_ALT_MAX, rand())),
      hx: HELI_HULL[0],
      hy: HELI_HULL[1],
      hz: HELI_HULL[2],
    });
  }
  const blimpRand = routeRand(seed, HELI_COUNT);
  aircraft.push({
    id: aircraft.length,
    kind: "blimp",
    axis: blimpRand() < 0.5 ? "x" : "z",
    cross: Math.round(blimpRand() * WORLD_SIZE),
    dir: blimpRand() < 0.5 ? 1 : -1,
    speed: BLIMP_SPEED,
    phase: blimpRand() * WORLD_SIZE,
    y: BLIMP_ALT,
    hx: BLIMP_HULL[0],
    hy: BLIMP_HULL[1],
    hz: BLIMP_HULL[2],
  });

  return { cranes, aircraft };
}

const TAU = Math.PI * 2;

/**
 * A crane's slew angle at a server time, rad in [0, TAU).
 *
 * Deliberately the plainest expression that works: `theta0 + omega * t`, with
 * t in seconds. At epoch-ms times (~1.79e12) and omega ~0.02 rad/s the double
 * ulp of that product is ~8e-9 rad — 5e-7 m at a 65 m jib radius — and since
 * client and server evaluate this same expression, their doubles are identical
 * bit for bit. There is nothing to reduce or round.
 */
export function slewAngle(site: CraneSite, timeMs: number): number {
  const a = (site.theta0 + site.omega * (timeMs / 1000)) % TAU;
  return a < 0 ? a + TAU : a;
}

/** The parts a crane is made of, in the order craneBoxes emits them. */
const CRANE_PARTS = ["mast", "jib", "counterJib", "cable", "hook"] as const;
type CranePart = (typeof CRANE_PARTS)[number];

/**
 * THE definition of where a crane part is. Writes into `out` and returns it,
 * so the collision path can reuse one scratch box and allocate nothing while
 * still sharing this single derivation with the renderer.
 */
function partBox(
  site: CraneSite,
  part: CranePart,
  theta: number,
  out: MoverBox,
): MoverBox {
  out.yaw = theta;
  out.id = site.id;
  out.kind = part;
  if (part === "mast") {
    // Square section, so its yaw is immaterial; keep it at theta anyway so
    // every part of a crane shares one frame.
    out.x = site.x;
    out.z = site.z;
    out.y = site.hubY / 2;
    out.hx = CRANE_MAST_SIDE / 2;
    out.hy = site.hubY / 2;
    out.hz = CRANE_MAST_SIDE / 2;
    return out;
  }
  // Local +X points along the jib: world (cos theta, -sin theta) in (x, z).
  const ax = Math.cos(theta);
  const az = -Math.sin(theta);
  if (part === "jib" || part === "counterJib") {
    const len = part === "jib" ? site.jibLength : site.counterLength;
    const sign = part === "jib" ? 1 : -1;
    const mid = (sign * len) / 2;
    out.x = site.x + ax * mid;
    out.z = site.z + az * mid;
    out.y = site.hubY;
    out.hx = len / 2;
    out.hy = CRANE_JIB_SIDE / 2;
    out.hz = CRANE_JIB_SIDE / 2;
    return out;
  }
  // Cable and hook hang from the trolley, out along the jib.
  const tx = site.x + ax * site.trolleyR;
  const tz = site.z + az * site.trolleyR;
  if (part === "cable") {
    out.x = tx;
    out.z = tz;
    out.y = site.hubY - site.hookDrop / 2;
    out.hx = CRANE_CABLE_SIDE / 2;
    out.hy = site.hookDrop / 2;
    out.hz = CRANE_CABLE_SIDE / 2;
    return out;
  }
  out.x = tx;
  out.z = tz;
  out.y = site.hubY - site.hookDrop;
  out.hx = CRANE_JIB_SIDE / 2;
  out.hy = CRANE_JIB_SIDE / 2;
  out.hz = CRANE_JIB_SIDE / 2;
  return out;
}

const blankBox = (): MoverBox => ({
  x: 0,
  y: 0,
  z: 0,
  hx: 0,
  hy: 0,
  hz: 0,
  yaw: 0,
  kind: "mast",
  id: 0,
});

/**
 * Every box of one crane at a time, canonicalized: mast, jib, counter-jib,
 * cable, hook. Allocates — this is the rendering and testing entry point.
 * The collision path uses the same partBox with a scratch box instead.
 */
export function craneBoxes(site: CraneSite, timeMs: number): MoverBox[] {
  const theta = slewAngle(site, timeMs);
  return CRANE_PARTS.map((part) => {
    const box = partBox(site, part, theta, blankBox());
    const p = canonicalize({ x: box.x, y: 0, z: box.z });
    box.x = p.x;
    box.z = p.z;
    return box;
  });
}

/** One aircraft's box at a time, canonicalized. */
export function aircraftBox(route: AircraftRoute, timeMs: number): MoverBox {
  const s = route.phase + route.dir * route.speed * (timeMs / 1000);
  const along =
    route.axis === "x" ? { x: s, z: route.cross } : { x: route.cross, z: s };
  const p = canonicalize({ x: along.x, y: 0, z: along.z });
  // Local +X must point along travel: world (cos yaw, -sin yaw) = the heading.
  // +x → 0, -x → PI, +z → -PI/2, -z → PI/2.
  const yaw =
    route.axis === "x"
      ? route.dir === 1
        ? 0
        : Math.PI
      : route.dir === 1
        ? -Math.PI / 2
        : Math.PI / 2;
  return {
    x: p.x,
    y: route.y,
    z: p.z,
    hx: route.hx,
    hy: route.hy,
    hz: route.hz,
    yaw,
    kind: route.kind,
    id: route.id,
  };
}

/**
 * True when the player sphere intersects this oriented box. Exact: the
 * point-to-box distance is taken in the box's own frame, so a sphere grazing
 * a corner is handled properly rather than by an expanded-AABB approximation
 * (which for a 70 m jib would be badly wrong at the tip).
 *
 * Torus-correct: the horizontal offsets go through wrapDeltaAxis, so a crane
 * near x = 0 still catches a plane at x = WORLD_SIZE - 10.
 */
export function sphereHitsBox(
  box: MoverBox,
  pos: Vec3,
  radius: number,
): boolean {
  const dx = wrapDeltaAxis(box.x, pos.x);
  const dz = wrapDeltaAxis(box.z, pos.z);
  const dy = pos.y - box.y;
  const c = Math.cos(box.yaw);
  const s = Math.sin(box.yaw);
  const lx = c * dx - s * dz;
  const lz = s * dx + c * dz;
  const ex = Math.max(0, Math.abs(lx) - box.hx);
  const ey = Math.max(0, Math.abs(dy) - box.hy);
  const ez = Math.max(0, Math.abs(lz) - box.hz);
  return ex * ex + ey * ey + ez * ez <= radius * radius;
}

/** The collision path's scratch box. Never escapes this module: queries
 * return a fresh {kind, id} on a hit, so nothing can alias it. */
const scratch = blankBox();

/**
 * Does the sphere touch this crane? Allocation-free, and cheap enough to sit
 * inside the bot probe loop: two scalar wrapDeltaAxis calls and four compares
 * reject the overwhelming majority of queries before any trigonometry.
 */
function hitsCrane(
  site: CraneSite,
  pos: Vec3,
  radius: number,
  timeMs: number,
): MoverKind | null {
  const reach =
    Math.max(site.jibLength, site.counterLength) +
    CRANE_JIB_SIDE / 2 +
    radius +
    Math.max(CRANE_MAST_SIDE / 2, CRANE_JIB_SIDE / 2);
  if (Math.abs(wrapDeltaAxis(site.x, pos.x)) > reach) return null;
  if (Math.abs(wrapDeltaAxis(site.z, pos.z)) > reach) return null;
  // The mast runs to the ground, so only the top end bounds the crane.
  if (pos.y - radius > site.hubY + CRANE_JIB_SIDE / 2) return null;
  if (pos.y + radius < 0) return null;

  const theta = slewAngle(site, timeMs);
  for (const part of CRANE_PARTS) {
    if (sphereHitsBox(partBox(site, part, theta, scratch), pos, radius)) {
      return part;
    }
  }
  return null;
}

/**
 * First mover the sphere intersects, or null — the PLAYER-facing query.
 * Cranes first (they are the ones you fly among), then aircraft.
 */
export function collideMovers(
  pos: Vec3,
  radius: number,
  field: MoverField,
  timeMs: number,
): MoverHit | null {
  for (const site of field.cranes) {
    const kind = hitsCrane(site, pos, radius, timeMs);
    if (kind) return { kind, id: site.id };
  }
  for (const route of field.aircraft) {
    if (sphereHitsBox(aircraftBox(route, timeMs), pos, radius)) {
      return { kind: route.kind, id: route.id };
    }
  }
  return null;
}

/**
 * The BOT-facing query: crane geometry and the blimp, never helicopters.
 *
 * Bots must not die to scenery (ST1's rule for weather, applied here), so
 * everything a bot could plausibly fly into has to be something it also
 * PROBES for — and probing costs server tick time. The split earns that cost
 * where it shows: a jib sweeping a canyon in front of a player is the thing
 * that would make the AI look broken, and the blimp is 60 m of hull sitting
 * at BLIMP_ALT, right under the bot ceiling. A 13 m helicopter, usually
 * hundreds of metres away, is not worth a probe — bots pass through it.
 */
export function collideBotMovers(
  pos: Vec3,
  radius: number,
  field: MoverField,
  timeMs: number,
): MoverHit | null {
  for (const site of field.cranes) {
    const kind = hitsCrane(site, pos, radius, timeMs);
    if (kind) return { kind, id: site.id };
  }
  for (const route of field.aircraft) {
    if (route.kind !== "blimp") continue;
    if (sphereHitsBox(aircraftBox(route, timeMs), pos, radius)) {
      return { kind: route.kind, id: route.id };
    }
  }
  return null;
}
