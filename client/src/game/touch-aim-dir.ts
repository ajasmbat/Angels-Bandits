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
//
// F7 aerobatics: a drag rotates the aim in the VIEW's frame (right and up as
// the pilot sees them), not as world yaw/elevation, and there is no
// elevation limit — the 60° cone around the nose is the only bound. So a
// thumb dragged down-the-screen keeps the aim above the nose wherever it
// points, and the plane follows it over the top and round: touch loops.

import { BULLET_RANGE } from "@angels-bandits/common/constants";
import type { FlightState } from "@angels-bandits/common/flight";
import type { Vec3 } from "@angels-bandits/common/world";
import { type ViewBasis, viewBasis } from "./instructor";

const DEG = Math.PI / 180;
/** Aim rotation per px of thumb drag at sensitivity 1, degrees. */
export const TOUCH_AIM_DEG_PER_PX = 0.18;
/** Most the aim may sit off the gun line, rad: a hard drag is a full-rate
 * turn, never a direction behind the camera. */
export const TOUCH_AIM_MAX_OFF_NOSE = 60 * DEG;
/** No aim finger for this long, s, and the aim starts easing home… */
export const TOUCH_AIM_IDLE_S = 1;
/** …onto the gun line with this time constant, s. */
export const TOUCH_AIM_RECENTRE_TAU = 1.5;

/** While the aim cursor is within this of the lead reticle, px… */
export const AIM_FRICTION_PX = 48;
/** …a drag turns the aim this much as far (M8): a thumb settles onto the
 * shot instead of skating past it. Magnetism is untouched, so a mouse and a
 * thumb get the same pull. */
export const AIM_FRICTION_GAIN = 0.5;

/** The drag-gain factor for the cursor and the lead reticle (screen px;
 * null reticle: no target, no friction). */
export function aimFriction(
  cursor: { x: number; y: number },
  reticle: { x: number; y: number } | null,
): number {
  if (!reticle) return 1;
  return Math.hypot(cursor.x - reticle.x, cursor.y - reticle.y) <=
    AIM_FRICTION_PX
    ? AIM_FRICTION_GAIN
    : 1;
}

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
const basis: ViewBasis = {
  fx: 0,
  fy: 0,
  fz: -1,
  rx: 1,
  ry: 0,
  rz: 0,
  ux: 0,
  uy: 1,
  uz: 0,
};

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

const WORLD_UP: Vec3 = { x: 0, y: 1, z: 0 };

/** Aim on the gun line — respawn, settings closed, rotation, mode change. */
export function recentreAimDir(
  s: AimDirState,
  flight: Pick<FlightState, "yaw" | "pitch">,
): void {
  forwardInto(flight, s.dir);
  s.idle = 0;
}

/**
 * A one-finger drag of (dx, dy) px, mouse convention (+x right, +y down):
 * right turns right, down aims lower — as seen through a view whose up is
 * `up` (the chase camera's: world-up in level flight, the plane's own through
 * aerobatics). A rotation of the aim along the great circle the drag points
 * at, TOUCH_AIM_DEG_PER_PX × sensitivity per px — no screen size anywhere,
 * no poles, no elevation limit.
 */
export function dragAimDir(
  s: AimDirState,
  dx: number,
  dy: number,
  sensitivity: number,
  up: Vec3 = WORLD_UP,
): void {
  if (dx === 0 && dy === 0) return;
  const d = s.dir;
  // The view's right and up at the aim: right = aim × up, up' = right × aim
  // (an up along the aim falls back to world-up, then +X).
  let rx = d.y * up.z - d.z * up.y;
  let ry = d.z * up.x - d.x * up.z;
  let rz = d.x * up.y - d.y * up.x;
  let rl = Math.hypot(rx, ry, rz);
  if (rl < 1e-9) {
    rx = -d.z;
    ry = 0;
    rz = d.x;
    rl = Math.hypot(rx, rz);
    if (rl < 1e-9) {
      rx = 1;
      rz = 0;
      rl = 1;
    }
  }
  rx /= rl;
  ry /= rl;
  rz /= rl;
  const ux = ry * d.z - rz * d.y;
  const uy = rz * d.x - rx * d.z;
  const uz = rx * d.y - ry * d.x;
  const len = Math.hypot(dx, dy);
  const a = TOUCH_AIM_DEG_PER_PX * sensitivity * DEG * len;
  // Unit direction of the drag on that tangent plane (screen +y is down).
  const ox = (rx * dx - ux * dy) / len;
  const oy = (ry * dx - uy * dy) / len;
  const oz = (rz * dx - uz * dy) / len;
  const c = Math.cos(a);
  const sn = Math.sin(a);
  d.x = d.x * c + ox * sn;
  d.y = d.y * c + oy * sn;
  d.z = d.z * c + oz * sn;
  normalise(d, fwdScratch);
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
  frame: { eye: Vec3; at: Vec3; up?: Vec3 },
  fovDeg: number,
  aspect: number,
  out: { x: number; y: number },
): void {
  const { eye } = frame;
  // The camera basis, built exactly as cursorRay builds it.
  const b = basis;
  viewBasis(eye, frame.at, frame.up ?? WORLD_UP, b);
  const { fx, fy, fz, rx, ry, rz, ux, uy, uz } = b;
  const px = dir.x * BULLET_RANGE - eye.x;
  const py = dir.y * BULLET_RANGE - eye.y;
  const pz = dir.z * BULLET_RANGE - eye.z;
  // Behind (or beside) the eye: keep the side, push it off the edge.
  const depth = Math.max(
    px * fx + py * fy + pz * fz,
    1e-6 * Math.hypot(px, py, pz),
  );
  const t = Math.tan((fovDeg * Math.PI) / 360);
  out.x = clamp((px * rx + py * ry + pz * rz) / depth / (t * aspect), -1, 1);
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
  s.idle = 0;
}
