// City soundscape mix (L2): the pure seam behind ambience.ts, the same split
// as spatial.ts — no WebAudio in here. Where the listener is (altitude, how
// near a street, a plaza, inside a hole) and how fast it flies become one
// 0..1 gain per ambient layer; the adapter only multiplies those into its
// fixed node graph. Everything positional goes through the torus API.

import {
  CITY_GRID,
  type HoleSpan,
  PLAZA_BLOCKS,
  mulberry32,
} from "@angels-bandits/common/city";
import {
  ROADWAY_HALF,
  offCenterline,
} from "@angels-bandits/common/city/street";
import {
  BLOCK_PITCH,
  BOOST_MAX_SPEED,
  CLOUD_BASE,
  FOG_DISTANCE,
  MAX_ALTITUDE,
  MIN_SPEED,
  WORLD_SIZE,
} from "@angels-bandits/common/constants";
import {
  type Vec3,
  canonicalize,
  wrapDeltaAxis,
} from "@angels-bandits/common/world";

/** Per-layer gains, each 0..1 — the adapter scales them by its own weights. */
export interface AmbientMix {
  /** Street traffic hum: a distant city floor plus the street you are over. */
  traffic: number;
  /** Ceiling for the occasional car horn — only near a street, down low. */
  horn: number;
  /** Distant sirens (each siren adds its own distance falloff, sirenGain). */
  siren: number;
  /** Plaza music and crowd murmur. */
  plaza: number;
  /** Air noise: grows with altitude and airspeed, sheltered inside a hole. */
  wind: number;
  /** Tunnel reverb send: 1 inside an H1 hole, 0 everywhere else. */
  reverb: number;
}

/** Hermite 0→1 between edges a < b (GLSL smoothstep). */
const smoothstep = (a: number, b: number, v: number): number => {
  const t = Math.max(0, Math.min(1, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** The whole city bed fades from full at street level to nothing at the
 * cloud base — above the deck the city is gone, only wind remains. */
const cityBed = (y: number): number => 1 - smoothstep(0, CLOUD_BASE, y);

/** Street-level detail (the street right under you, horns, plaza music)
 * belongs to the canyons: full below ~15 m, gone by ~180 m. */
const STREET_EAR_LOW = 15;
const STREET_EAR_HIGH = 180;
/** Street proximity: full over the roadway, gone by mid-block. */
const STREET_EAR_REACH = 90;
/** The traffic you hear from anywhere in the city, as a share of full. */
const TRAFFIC_FLOOR = 0.3;
/** Plaza music carries further than a single street, m. */
const PLAZA_EAR_NEAR = 70;
const PLAZA_EAR_REACH = 260;
const PLAZA_EAR_HIGH = 260;
/** Wind share at rest (sea level, MIN_SPEED), from altitude, from speed. */
const WIND_BASE = 0.2;
const WIND_ALT = 0.45;
const WIND_SPEED = 0.35;
/** A hole's walls shelter you from the airstream. */
const WIND_HOLE_SHELTER = 0.5;

/**
 * Per-layer gains for a listener at `cameraPos` flying at `speed` m/s,
 * `nearestStreetDist` meters off the nearest street centerline (streetDistance),
 * `plazaDist` meters from the nearest plaza center (plazaDistance), and
 * `inHole` when inside an H1 hole's clear volume (insideHole).
 *
 * Invariants (tested): every city layer is non-increasing with altitude and
 * zero at/above CLOUD_BASE; wind is non-decreasing with altitude and speed;
 * reverb is non-zero only inside a hole. Writes into `out` when given, so the
 * frame loop allocates nothing.
 */
export function ambientMix(
  cameraPos: Vec3,
  speed: number,
  nearestStreetDist: number,
  plazaDist: number,
  inHole: boolean,
  out: AmbientMix = {
    traffic: 0,
    horn: 0,
    siren: 0,
    plaza: 0,
    wind: 0,
    reverb: 0,
  },
): AmbientMix {
  const y = cameraPos.y;
  const bed = cityBed(y);
  const low = 1 - smoothstep(STREET_EAR_LOW, STREET_EAR_HIGH, y);
  const street =
    1 - smoothstep(ROADWAY_HALF, STREET_EAR_REACH, nearestStreetDist);
  const plaza =
    (1 - smoothstep(PLAZA_EAR_NEAR, PLAZA_EAR_REACH, plazaDist)) *
    (1 - smoothstep(STREET_EAR_LOW, PLAZA_EAR_HIGH, y));
  const speed01 = Math.max(
    0,
    Math.min(1, (speed - MIN_SPEED) / (BOOST_MAX_SPEED - MIN_SPEED)),
  );
  const wind =
    WIND_BASE +
    WIND_ALT * smoothstep(0, MAX_ALTITUDE, y) +
    WIND_SPEED * speed01;

  out.traffic = bed * (TRAFFIC_FLOOR + (1 - TRAFFIC_FLOOR) * street * low);
  out.horn = bed * street * low;
  out.siren = bed;
  out.plaza = bed * plaza;
  out.wind = wind * (inHole ? WIND_HOLE_SHELTER : 1);
  out.reverb = inHole ? 1 : 0;
  return out;
}

/** Meters from `p` to the nearest street centerline (either axis). */
export function streetDistance(p: Vec3): number {
  return Math.min(offCenterline(p.x), offCenterline(p.z));
}

/** Horizontal torus distance from `p` to the nearest plaza block center, m. */
export function plazaDistance(p: Vec3): number {
  let best = Number.POSITIVE_INFINITY;
  for (const [bx, bz] of PLAZA_BLOCKS) {
    const dx = wrapDeltaAxis(p.x, (bx + 0.5) * BLOCK_PITCH);
    const dz = wrapDeltaAxis(p.z, (bz + 0.5) * BLOCK_PITCH);
    best = Math.min(best, Math.hypot(dx, dz));
  }
  return best;
}

/** Reverb starts this far outside a mouth — the echo greets you at the
 * entrance instead of snapping on halfway in, m. */
const HOLE_MOUTH_MARGIN = 6;

/** True when `p` is inside any hole's clear volume (mouth margin included). */
export function insideHole(spans: readonly HoleSpan[], p: Vec3): boolean {
  for (const span of spans) {
    const { axis, width, height } = span.hole;
    const dx = wrapDeltaAxis(span.center.x, p.x);
    const dz = wrapDeltaAxis(span.center.z, p.z);
    const along = axis === "x" ? dx : dz;
    const across = axis === "x" ? dz : dx;
    if (
      Math.abs(along) <= span.length / 2 + HOLE_MOUTH_MARGIN &&
      Math.abs(across) <= width / 2 &&
      Math.abs(p.y - span.center.y) <= height / 2
    ) {
      return true;
    }
  }
  return false;
}

// --- Sirens: one shared schedule on the synced server clock --------------

/** The siren schedule is cut into slots; at most one siren runs per slot. */
export const SIREN_SLOT_MS = 45_000;
/** How long one siren drives, ms (fades in and out inside this). */
export const SIREN_RUN_MS = 22_000;
/** Share of slots that carry a siren. */
const SIREN_CHANCE = 0.75;
const SIREN_FADE_MS = 3_000;
/** Responder speed along its street, m/s. */
const SIREN_SPEED = 16;
/** Sirens sit at roof-of-car height. */
const SIREN_Y = 1.5;
/** Full volume within this range; inverse falloff past it, m. */
const SIREN_REF = 120;
/** Salted stream so the siren schedule never shares draws with the city. */
const SIREN_SALT = 0x51e7a5;

/** One siren audible on the schedule: where it is and its fade 0..1. */
export interface Siren {
  pos: Vec3;
  level: number;
}

/**
 * The siren driving at server time `timeMs`, or null — a pure function of
 * (seed, clock), so every client hears the same responder on the same street.
 * A null clock (not yet synced) is silence, never "time zero".
 */
export function sirenAt(seed: number, timeMs: number | null): Siren | null {
  if (timeMs === null || !Number.isFinite(timeMs)) return null;
  const slot = Math.floor(timeMs / SIREN_SLOT_MS);
  const rng = mulberry32(
    (seed ^ SIREN_SALT ^ Math.imul(slot, 0x9e3779b1)) >>> 0,
  );
  if (rng() >= SIREN_CHANCE) return null;
  const start = rng() * (SIREN_SLOT_MS - SIREN_RUN_MS);
  const local = timeMs - slot * SIREN_SLOT_MS - start;
  if (local < 0 || local > SIREN_RUN_MS) return null;
  const alongX = rng() < 0.5;
  const line = Math.floor(rng() * CITY_GRID) * BLOCK_PITCH;
  const from = rng() * WORLD_SIZE;
  const dir = rng() < 0.5 ? 1 : -1;
  const along = from + (dir * SIREN_SPEED * local) / 1000;
  return {
    pos: canonicalize(
      alongX
        ? { x: along, y: SIREN_Y, z: line }
        : { x: line, y: SIREN_Y, z: along },
    ),
    level: Math.min(
      1,
      local / SIREN_FADE_MS,
      (SIREN_RUN_MS - local) / SIREN_FADE_MS,
    ),
  };
}

/** A siren's distance falloff: carries far further than an engine, but goes
 * quiet at the haze line like everything else (spatial.ts's rule), 0..1. */
export function sirenGain(distance: number): number {
  if (distance >= FOG_DISTANCE) return 0;
  return (
    Math.min(1, SIREN_REF / Math.max(distance, 1)) *
    (1 - distance / FOG_DISTANCE)
  );
}
