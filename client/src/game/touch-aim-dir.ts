// Touch aim as a direction in the world (M7) — the pure seam. A mouse can
// park a cursor ON something; a thumb that lifts can't, so a parked screen
// point is a turn that never ends (the instructor reads any offset from the
// pipper as a turn). Instead the thumb steers a world-frame unit vector:
// a drag yaws/pitches it by a fixed angle per pixel (the same on a phone and
// a tablet), lifting leaves it where it is in the world, and the instructor
// settles the nose onto it. Each frame it is projected onto the instructor's
// cursor through the very view the instructor reads (aimDirNdc), so the
// downstream steering seam is unchanged. Renderer- and DOM-free; every
// per-frame function writes in place — no allocation. CLIENT-ONLY.

import { BULLET_RANGE } from "@angels-bandits/common/constants";
import type { FlightState } from "@angels-bandits/common/flight";
import type { Vec3 } from "@angels-bandits/common/world";

const DEG = Math.PI / 180;
/** Aim rotation per px of thumb drag at sensitivity 1, degrees. */
export const TOUCH_AIM_DEG_PER_PX = 0.18;
/** Most the aim may sit off the gun line, rad: a hard drag is a full-rate
 * turn, never a direction behind the camera. */
export const TOUCH_AIM_MAX_OFF_NOSE = 60 * DEG;
/** Most world elevation the aim may take, rad — under PITCH_LIMIT (so the
 * instructor's pitch target is always reachable) and clear of the poles,
 * where yaw is undefined. */
export const TOUCH_AIM_MAX_ELEV = 75 * DEG;
/** No aim finger for this long, s, and the aim starts easing home… */
export const TOUCH_AIM_IDLE_S = 1;
/** …onto the gun line with this time constant, s. */
export const TOUCH_AIM_RECENTRE_TAU = 1.5;

export interface AimDirState {
  /** World-frame unit vector the nose is flown onto. Mutated in place. */
  dir: Vec3;
  /** Seconds since an aim finger was last down. */
  idle: number;
}

/** Due north and level; recentre it onto a plane before use. */
export function createAimDir(): AimDirState {
  return { dir: { x: 0, y: 0, z: -1 }, idle: 0 };
}

const clamp = (v: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, v));

/** Write `fwd` = flightForward(flight) without allocating. */
function forwardInto(flight: Pick<FlightState, "yaw" | "pitch">, fwd: Vec3) {
  const cosP = Math.cos(flight.pitch);
  fwd.x = -Math.sin(flight.yaw) * cosP;
  fwd.y = Math.sin(flight.pitch);
  fwd.z = -Math.cos(flight.yaw) * cosP;
}

const fwdScratch: Vec3 = { x: 0, y: 0, z: -1 };

/** Normalise in place; a zero vector becomes `fallback`. */
function normalise(v: Vec3, fallback: Vec3): void {
  const l = Math.hypot(v.x, v.y, v.z);
  if (l < 1e-12) {
    v.x = fallback.x;
    v.y = fallback.y;
    v.z = fallback.z;
    return;
  }
  v.x /= l;
  v.y /= l;
  v.z /= l;
}

/** Hold the world elevation inside ±TOUCH_AIM_MAX_ELEV. */
function clampElevation(d: Vec3): void {
  const lim = Math.sin(TOUCH_AIM_MAX_ELEV);
  if (Math.abs(d.y) <= lim) return;
  const h = Math.hypot(d.x, d.z);
  const k = Math.cos(TOUCH_AIM_MAX_ELEV) / (h || 1);
  d.x = h > 1e-12 ? d.x * k : 0;
  d.z = h > 1e-12 ? d.z * k : -Math.cos(TOUCH_AIM_MAX_ELEV);
  d.y = Math.sign(d.y) * lim;
}

/** Aim on the gun line — respawn, settings closed, rotation, mode change. */
export function recentreAimDir(
  s: AimDirState,
  flight: Pick<FlightState, "yaw" | "pitch">,
): void {
  forwardInto(flight, s.dir);
  clampElevation(s.dir);
  s.idle = 0;
}

/**
 * A one-finger drag of (dx, dy) px, mouse convention (+x right, +y down):
 * right turns right (yaw decreases, flight.ts), down aims lower. A fixed
 * TOUCH_AIM_DEG_PER_PX × sensitivity per px — no screen size anywhere.
 */
export function dragAimDir(
  s: AimDirState,
  dx: number,
  dy: number,
  sensitivity: number,
): void {
  if (dx === 0 && dy === 0) return;
  const k = TOUCH_AIM_DEG_PER_PX * sensitivity * DEG;
  const d = s.dir;
  const yaw = Math.atan2(-d.x, -d.z) - dx * k;
  const elev = clamp(
    Math.asin(clamp(d.y, -1, 1)) - dy * k,
    -TOUCH_AIM_MAX_ELEV,
    TOUCH_AIM_MAX_ELEV,
  );
  const c = Math.cos(elev);
  d.x = -Math.sin(yaw) * c;
  d.y = Math.sin(elev);
  d.z = -Math.cos(yaw) * c;
  s.idle = 0;
}

/**
 * Once a frame: `held` is an aim finger down. TOUCH_AIM_IDLE_S after the
 * last one lifts, ease onto the gun line (τ TOUCH_AIM_RECENTRE_TAU); always
 * hold the 60° cone around the nose and the elevation limit.
 */
export function stepAimDir(
  s: AimDirState,
  flight: Pick<FlightState, "yaw" | "pitch">,
  held: boolean,
  dt: number,
): void {
  const fwd = fwdScratch;
  forwardInto(flight, fwd);
  const d = s.dir;
  s.idle = held ? 0 : s.idle + dt;
  if (s.idle > TOUCH_AIM_IDLE_S) {
    const k = 1 - Math.exp(-dt / TOUCH_AIM_RECENTRE_TAU);
    d.x += (fwd.x - d.x) * k;
    d.y += (fwd.y - d.y) * k;
    d.z += (fwd.z - d.z) * k;
    normalise(d, fwd);
  }
  const cos = d.x * fwd.x + d.y * fwd.y + d.z * fwd.z;
  if (cos < Math.cos(TOUCH_AIM_MAX_OFF_NOSE)) {
    // Back onto the cone's rim, along the great circle through the nose.
    d.x -= fwd.x * cos;
    d.y -= fwd.y * cos;
    d.z -= fwd.z * cos;
    normalise(d, fwd);
    const sin = Math.sin(TOUCH_AIM_MAX_OFF_NOSE);
    const c = Math.cos(TOUCH_AIM_MAX_OFF_NOSE);
    d.x = fwd.x * c + d.x * sin;
    d.y = fwd.y * c + d.y * sin;
    d.z = fwd.z * c + d.z * sin;
  }
  clampElevation(d);
}

/**
 * Where the instructor must see the cursor for `dir`: NDC (+y up, clamped to
 * the cursor's ±1 range) of the point BULLET_RANGE out along `dir` from the
 * plane, through `frame` (ChaseCamera.aimFrame: eye/look-at as offsets from
 * the plane) — the exact inverse of instructor.ts's cursorRay. With `dir` on
 * the gun line that point IS the pipper's, so the aim error is zero, the
 * eye's parallax included.
 */
export function aimDirNdc(
  dir: Vec3,
  frame: { eye: Vec3; at: Vec3 },
  fovDeg: number,
  aspect: number,
  out: { x: number; y: number },
): void {
  const { eye, at } = frame;
  // The camera basis, built exactly as cursorRay builds it.
  let fx = at.x - eye.x;
  let fy = at.y - eye.y;
  let fz = at.z - eye.z;
  const fl = Math.hypot(fx, fy, fz) || 1;
  fx /= fl;
  fy /= fl;
  fz /= fl;
  let rx = -fz;
  let rz = fx;
  const rl = Math.hypot(rx, rz) || 1;
  rx /= rl;
  rz /= rl;
  const ux = -rz * fy;
  const uy = rz * fx - rx * fz;
  const uz = rx * fy;
  const px = dir.x * BULLET_RANGE - eye.x;
  const py = dir.y * BULLET_RANGE - eye.y;
  const pz = dir.z * BULLET_RANGE - eye.z;
  // Behind (or beside) the eye: keep the side, push it off the edge.
  const depth = Math.max(
    px * fx + py * fy + pz * fz,
    1e-6 * Math.hypot(px, py, pz),
  );
  const t = Math.tan((fovDeg * Math.PI) / 360);
  out.x = clamp((px * rx + pz * rz) / depth / (t * aspect), -1, 1);
  out.y = clamp((px * ux + py * uy + pz * uz) / depth / t, -1, 1);
}

/**
 * Take the aim over from a cursor (a hybrid laptop's mouse put it there):
 * `ray` is the unit eye ray through it (cursorRay), `eye` the eye's offset
 * from the plane. The direction is to where that ray crosses the
 * BULLET_RANGE sphere around the plane, so the hand-over never jumps.
 */
export function aimDirFromRay(s: AimDirState, eye: Vec3, ray: Vec3): void {
  const b = eye.x * ray.x + eye.y * ray.y + eye.z * ray.z;
  const c = eye.x * eye.x + eye.y * eye.y + eye.z * eye.z;
  const t = -b + Math.sqrt(Math.max(0, b * b - c + BULLET_RANGE ** 2));
  const d = s.dir;
  d.x = eye.x + ray.x * t;
  d.y = eye.y + ray.y * t;
  d.z = eye.z + ray.z * t;
  normalise(d, ray);
  clampElevation(d);
  s.idle = 0;
}
