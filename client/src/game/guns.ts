// The trigger: hold the left mouse button to fire bursts. Steps the SAME
// shared heat model the server validates with (common/combat) — the HUD
// meter and the server's accept/reject can only disagree by clock jitter.
// Shots alternate wingtip gun points and inherit the plane's velocity
// (PLAN.md), so a diving attack's bullets don't lag behind the plane.

import {
  type GunHeat,
  canFire,
  cooledGunHeat,
  createGunHeat,
  firedGunHeat,
} from "@angels-bandits/common/combat";
import { BULLET_SPEED } from "@angels-bandits/common/constants";
import { type FlightState, flightForward } from "@angels-bandits/common/flight";
import type { Vec3 } from "@angels-bandits/common/world";
import * as THREE from "three";

/** Gun muzzle in plane-local coords (wings span ±4.5 m, guns just inboard). */
const GUN_OFFSET_X = 3.5;
const GUN_OFFSET_Y = 0;
const GUN_OFFSET_Z = -0.8; // slightly ahead of the wing's leading edge

export interface Shot {
  seq: number;
  /** World-space muzzle position (canonical-ish; Bullets canonicalizes). */
  origin: Vec3;
  vel: Vec3;
}

const scratchEuler = new THREE.Euler();
const scratchOffset = new THREE.Vector3();

export class Guns {
  private heat: GunHeat = createGunHeat();
  private trigger = false;
  private nextSeq = 0;
  private side = 1; // +1 / −1: alternate wingtips

  constructor(target: Window = window) {
    target.addEventListener("mousedown", (e: MouseEvent) => {
      if (e.button === 0) this.setTrigger(true);
    });
    target.addEventListener("mouseup", (e: MouseEvent) => {
      if (e.button === 0) this.setTrigger(false);
    });
    target.addEventListener("blur", () => {
      this.setTrigger(false);
    });
  }

  /** Hold/release the trigger (mouse handlers and the QA harness). */
  setTrigger(held: boolean): void {
    this.trigger = held;
  }

  /** HUD state: heat 0..1 and whether the guns are overheat-locked. */
  get state(): { heat: number; locked: boolean } {
    return { heat: Math.min(1, this.heat.heat), locked: this.heat.locked };
  }

  /** Drop the trigger and reset heat (death → respawn). */
  reset(now: number): void {
    this.heat = createGunHeat(now);
  }

  /**
   * Advance the heat model to `now` (ms) and, if the trigger is held and the
   * model allows it, produce at most one shot this frame. Pass
   * `allowFire: false` to keep cooling but suppress shots entirely
   * (free-look: aim is meaningless mid-orbit, and no shot ⇒ no heat build).
   */
  update(now: number, flight: FlightState, allowFire = true): Shot | null {
    this.heat = cooledGunHeat(this.heat, now);
    if (!this.trigger || !allowFire || !canFire(this.heat, now)) return null;
    this.heat = firedGunHeat(this.heat, now);
    this.side = -this.side;

    scratchEuler.set(flight.pitch, flight.yaw, flight.roll, "YXZ");
    scratchOffset
      .set(this.side * GUN_OFFSET_X, GUN_OFFSET_Y, GUN_OFFSET_Z)
      .applyEuler(scratchEuler);
    const fwd = flightForward(flight);
    const speed = BULLET_SPEED + flight.speed;
    return {
      seq: this.nextSeq++,
      origin: {
        x: flight.pos.x + scratchOffset.x,
        y: flight.pos.y + scratchOffset.y,
        z: flight.pos.z + scratchOffset.z,
      },
      vel: { x: fwd.x * speed, y: fwd.y * speed, z: fwd.z * speed },
    };
  }
}
