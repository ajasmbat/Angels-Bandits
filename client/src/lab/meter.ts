// FL1 Flight Lab telemetry — the pure seam: what the strip shows, measured
// from consecutive flight states (so it reads whatever the tuning really
// flies, not what the sliders promise). Rates are taken in the airframe's
// own frame (flightAxes), so they stay meaningful through loops, rolls and
// the gimbal flip; everything is eased over ~0.2 s so a number can be read.

import {
  type FlightState,
  flightAxes,
  flightForward,
} from "@angels-bandits/common/flight";
import type { Vec3 } from "@angels-bandits/common/world";

const G = 9.81;
const DEG = 180 / Math.PI;
/** Easing time constant of every reading, s. */
const EASE_S = 0.2;
/** Below this velocity turn rate, rad/s, the plane flies straight: no
 * radius. */
const STRAIGHT_RATE = 0.03;

export class FlightMeter {
  speed = 0;
  /** Eased radius of the flight path's curvature, m; null when straight. */
  turnRadius: number | null = null;
  /** Eased |roll| and |pitch| rate in the airframe, °/s. */
  rollRate = 0;
  pitchRate = 0;
  /** Eased load factor, g (1 in level flight). */
  g = 1;
  private pathRate = 0;
  private primed = false;
  private readonly fwd: Vec3 = { x: 0, y: 0, z: -1 };
  private readonly vel: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly axes = {
    right: { x: 1, y: 0, z: 0 },
    up: { x: 0, y: 1, z: 0 },
  };
  private readonly next = {
    right: { x: 1, y: 0, z: 0 },
    up: { x: 0, y: 1, z: 0 },
  };

  /** Forget the last state (a teleport is not a manoeuvre). */
  reset(): void {
    this.primed = false;
  }

  /** Read one step: `flight` is the state `dt` seconds after the last one. */
  step(flight: FlightState, dt: number): void {
    const f = flightForward(flight);
    flightAxes(flight, this.next);
    const vx = f.x * flight.speed;
    const vy = f.y * flight.speed;
    const vz = f.z * flight.speed;
    this.speed = flight.speed;
    if (!this.primed || dt <= 0) {
      this.primed = true;
      this.store(f, vx, vy, vz);
      return;
    }
    const k = 1 - Math.exp(-dt / EASE_S);
    // Path curvature: how fast the velocity's direction swings.
    const dot = Math.max(
      -1,
      Math.min(1, f.x * this.fwd.x + f.y * this.fwd.y + f.z * this.fwd.z),
    );
    const rate = Math.acos(dot) / dt;
    this.pathRate += (rate - this.pathRate) * k;
    this.turnRadius =
      this.pathRate > STRAIGHT_RATE ? flight.speed / this.pathRate : null;
    // Body rates: the nose swinging toward the old up is pitch; the right
    // wing swinging toward it is roll.
    const up = this.axes.up;
    const pitch =
      ((f.x - this.fwd.x) * up.x +
        (f.y - this.fwd.y) * up.y +
        (f.z - this.fwd.z) * up.z) /
      dt;
    const r = this.next.right;
    const roll =
      ((r.x - this.axes.right.x) * up.x +
        (r.y - this.axes.right.y) * up.y +
        (r.z - this.axes.right.z) * up.z) /
      dt;
    this.pitchRate += (Math.abs(pitch) * DEG - this.pitchRate) * k;
    this.rollRate += (Math.abs(roll) * DEG - this.rollRate) * k;
    // Load factor: the acceleration the airframe feels, gravity included.
    const ax = (vx - this.vel.x) / dt;
    const ay = (vy - this.vel.y) / dt + G;
    const az = (vz - this.vel.z) / dt;
    const g = Math.hypot(ax, ay, az) / G;
    this.g += (Math.min(g, 15) - this.g) * k;
    this.store(f, vx, vy, vz);
  }

  private store(f: Vec3, vx: number, vy: number, vz: number): void {
    this.fwd.x = f.x;
    this.fwd.y = f.y;
    this.fwd.z = f.z;
    this.vel.x = vx;
    this.vel.y = vy;
    this.vel.z = vz;
    const a = this.axes;
    const n = this.next;
    a.right.x = n.right.x;
    a.right.y = n.right.y;
    a.right.z = n.right.z;
    a.up.x = n.up.x;
    a.up.y = n.up.y;
    a.up.z = n.up.z;
  }
}
