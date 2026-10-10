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
import { emulatedMouse, watchTouches } from "./touch-input";

/** W4: the keyboard's trigger. */
export const FIRE_KEY = "Enter";

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
  /** M8 auto-fire's own trigger: separate, so its release never drops a
   * FIRE held by hand. */
  private auto = false;
  private nextSeq = 0;
  private side = 1; // +1 / −1: alternate wingtips

  constructor(target: Window = window) {
    watchTouches(target);
    target.addEventListener("mousedown", (e: MouseEvent) => {
      // A tap's compatibility echo is not a trigger pull (touch FIRE calls
      // setTrigger itself) — tapping an icon or the canvas must not shoot.
      if (e.button === 0 && !emulatedMouse(e)) this.setTrigger(true);
    });
    target.addEventListener("mouseup", (e: MouseEvent) => {
      if (e.button === 0 && !emulatedMouse(e)) this.setTrigger(false);
    });
    target.addEventListener("blur", () => {
      this.setTrigger(false);
    });
    // W4: ENTER is a trigger too (the KEYBOARD scheme's) — never while a
    // field or button has the focus, nor on the join card, where Enter
    // means PLAY.
    target.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.code !== FIRE_KEY || e.repeat) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "BUTTON") return;
      if (target.document?.getElementById("join")?.classList.contains("open")) {
        return;
      }
      this.setTrigger(true);
    });
    target.addEventListener("keyup", (e: KeyboardEvent) => {
      if (e.code === FIRE_KEY) this.setTrigger(false);
    });
  }

  /** Hold/release the trigger (mouse handlers and the QA harness). */
  setTrigger(held: boolean): void {
    this.trigger = held;
  }

  /** Hold/release auto-fire's trigger (M8, game/auto-fire.ts). */
  setAutoTrigger(held: boolean): void {
    this.auto = held;
  }

  /** Whether the trigger is held by hand (mouse, touch FIRE, QA). */
  get triggerHeld(): boolean {
    return this.trigger;
  }

  /** Overheat-locked — auto-fire's per-frame read (no allocation). */
  get locked(): boolean {
    return this.heat.locked;
  }

  /** Whether either trigger is held — the H2 hole assist stands down while
   * the pilot is shooting, and touch free-look never opens (M8). */
  get firing(): boolean {
    return this.trigger || this.auto;
  }

  /** HUD state: heat 0..1 and whether the guns are overheat-locked. */
  get state(): { heat: number; locked: boolean } {
    return { heat: Math.min(1, this.heat.heat), locked: this.heat.locked };
  }

  /** Drop the trigger and reset heat (death → respawn). */
  reset(now: number): void {
    this.heat = createGunHeat(now);
    this.auto = false;
  }

  /**
   * Advance the heat model to `now` (ms) and, if the trigger is held and the
   * model allows it, produce at most one shot this frame. Pass
   * `allowFire: false` to keep cooling but suppress shots entirely
   * (free-look: aim is meaningless mid-orbit, and no shot ⇒ no heat build).
   */
  update(now: number, flight: FlightState, allowFire = true): Shot | null {
    this.heat = cooledGunHeat(this.heat, now);
    if (!this.firing || !allowFire || !canFire(this.heat, now)) return null;
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
