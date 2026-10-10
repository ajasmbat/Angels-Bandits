// DT1 engine fire: the middle of a wounded plane's three damage stages.
// Below SMOKE_HP_FRAC it trails smoke (smoke.ts); below FIRE_HP_FRAC its
// engine burns — flames licking back from the nose; past
// MISSING_PANELS_FROM its skin panels go missing (plane.ts, in the shader).
//
// Snapshot HP drives it, so every client sees the same fire. The flames
// ride the D1 impact particle pool (impacts.ts wreckFire — no new draw,
// nothing allocated per frame), rate-capped per plane and scaled by the
// tier's wreck-fire share, so a sky full of burning planes cannot crowd out
// the hit sparks.

import { MAX_HP } from "@angels-bandits/common/constants";
import type { Vec3 } from "@angels-bandits/common/world";
import * as THREE from "three";
import type { Impacts } from "./impacts";
import { isEnemyId } from "./planelights";
import type { QuatLike } from "./trails";

/** Below this share of MAX_HP the engine burns (smoke starts at 0.3). */
export const FIRE_HP_FRAC = 0.18;
/** Flames and extra smoke puffs per second per burning plane, full share. */
const FIRE_RATE = 16;
const SMOKE_RATE = 4;
/** Flame scatter about the engine, m. */
const SPREAD = 0.7;
/** The engine in game-local coords (forward −Z): the biplane's radial, the
 * fighter's V12 just aft of the spinner. */
const ENGINE_BIPLANE = new THREE.Vector3(0, 0, -2.9);
const ENGINE_FIGHTER = new THREE.Vector3(0, 0.1, -3.2);

/** Does a plane at this HP have its engine on fire? Dead planes never do. */
export function fireActive(hp: number): boolean {
  return hp > 0 && hp < MAX_HP * FIRE_HP_FRAC;
}

const scratchQuat = new THREE.Quaternion();
const scratchVec = new THREE.Vector3();
const scratchAt: Vec3 = { x: 0, y: 0, z: 0 };

export class PlaneFires {
  /** Fractional emission carried per plane (only burning planes). */
  private readonly acc = new Map<string, { fire: number; smoke: number }>();
  private share = 1;

  constructor(private readonly impacts: Impacts) {}

  /** Quality: the tier's share of the flame emission (wreckFire). */
  setShare(share: number): void {
    this.share = share;
  }

  /**
   * One plane's frame: if `hp` has it burning, emit this frame's flames at
   * its engine (`pos` canonical, `quat` its attitude; null: at `pos`).
   */
  emit(
    id: string,
    pos: Vec3,
    quat: QuatLike | null,
    hp: number,
    dt: number,
    now: number,
  ): void {
    if (!fireActive(hp)) {
      if (this.acc.size > 0) this.acc.delete(id);
      return;
    }
    let a = this.acc.get(id);
    if (!a) {
      a = { fire: 0, smoke: 0 };
      this.acc.set(id, a);
    }
    a.fire += FIRE_RATE * this.share * dt;
    a.smoke += SMOKE_RATE * this.share * dt;
    const fire = Math.floor(a.fire);
    const smoke = Math.floor(a.smoke);
    a.fire -= fire;
    a.smoke -= smoke;
    if (fire === 0 && smoke === 0) return;
    if (quat) {
      scratchQuat.set(quat.x, quat.y, quat.z, quat.w);
      scratchVec
        .copy(isEnemyId(id) ? ENGINE_FIGHTER : ENGINE_BIPLANE)
        .applyQuaternion(scratchQuat);
    } else {
      scratchVec.set(0, 0, 0);
    }
    scratchAt.x = pos.x + scratchVec.x;
    scratchAt.y = pos.y + scratchVec.y;
    scratchAt.z = pos.z + scratchVec.z;
    this.impacts.wreckFire(scratchAt, fire, smoke, SPREAD, now);
  }

  /** Forget a plane (left the room). */
  drop(id: string): void {
    this.acc.delete(id);
  }
}
