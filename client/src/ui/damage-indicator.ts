// Damage feedback (U1): getting shot reads on screen. A red vignette flash
// scaled by the damage, and a thin arc at the screen edge pointing at the
// shooter for DAMAGE_ARC_MS. The bearing is pure torus maths (wrapDeltaInto,
// so a shooter just across the seam points the short way); the DOM half is
// frame-driven transform/opacity writes, cached so an unchanged value never
// reaches the style system, and nothing here allocates per frame. No
// document access at module top level: the pure helpers import under node.

import { type Vec3, wrapDeltaInto } from "@angels-bandits/common/world";

/** How long a shooter's arc stays up after their last hit, ms. */
export const DAMAGE_ARC_MS = 1500;
/** The vignette flash's fade, ms. */
export const DAMAGE_FLASH_MS = 300;
/** Arcs shown at once — one per shooter id; a fifth replaces the oldest. */
export const DAMAGE_ARC_SLOTS = 4;
/** Vignette opacity ceiling, and opacity per HP lost (25 HP = full). */
const FLASH_MAX = 0.6;
const FLASH_PER_HP = 1 / 25;

const scratchDelta: Vec3 = { x: 0, y: 0, z: 0 };

/**
 * Where `shooter` sits relative to a view looking along `viewYaw`, as a
 * screen-clockwise angle in radians: 0 = ahead (top of the screen), +π/2 =
 * right, ±π = behind. flight.ts's yaw is counter-clockwise with forward
 * (−sin yaw, −cos yaw) on X/Z, so right is (cos yaw, −sin yaw). Altitude is
 * ignored — the arc is a compass, not a pitch ladder.
 */
export function damageBearing(me: Vec3, shooter: Vec3, viewYaw: number): number {
  const d = wrapDeltaInto(me, shooter, scratchDelta);
  const s = Math.sin(viewYaw);
  const c = Math.cos(viewYaw);
  const ahead = -d.x * s - d.z * c;
  const right = d.x * c - d.z * s;
  return Math.atan2(right, ahead);
}

/** Vignette peak opacity for one hit of `dmg` HP. */
export function flashOpacity(dmg: number): number {
  return Math.min(FLASH_MAX, Math.max(0, dmg) * FLASH_PER_HP);
}

interface ArcSlot {
  el: HTMLDivElement;
  /** Shooter id, or null for an idle slot. */
  id: string | null;
  /** The shooter's last known canonical position (frozen once they vanish). */
  pos: Vec3;
  bornAt: number;
  shownTransform: string;
  shownOpacity: string;
}

/** The vignette and the shooter arcs over `#damage-flash` / `#damage-arcs`. */
export class DamageIndicator {
  private readonly flash: HTMLDivElement;
  private readonly slots: ArcSlot[] = [];
  private flashPeak = 0;
  private flashAt = Number.NEGATIVE_INFINITY;
  private shownFlash = "";

  constructor() {
    this.flash = document.getElementById("damage-flash") as HTMLDivElement;
    const host = document.getElementById("damage-arcs") as HTMLDivElement;
    for (let i = 0; i < DAMAGE_ARC_SLOTS; i++) {
      const el = document.createElement("div");
      el.className = "arc";
      host.append(el);
      this.slots.push({
        el,
        id: null,
        pos: { x: 0, y: 0, z: 0 },
        bornAt: Number.NEGATIVE_INFINITY,
        shownTransform: "",
        shownOpacity: "",
      });
    }
  }

  /**
   * We took `dmg` HP. `shooterPos` undefined (they left, or it was us) →
   * flash only, no arc. A repeat shooter refreshes their own arc.
   */
  hit(
    shooterId: string,
    shooterPos: Vec3 | null | undefined,
    dmg: number,
    now: number,
  ): void {
    this.flashPeak = flashOpacity(dmg);
    this.flashAt = now;
    if (!shooterPos) return;
    let slot: ArcSlot | undefined;
    let oldest: ArcSlot | undefined;
    for (const s of this.slots) {
      if (s.id === shooterId) slot = s;
      if (!oldest || s.bornAt < oldest.bornAt) oldest = s;
    }
    slot ??= oldest as ArcSlot;
    slot.id = shooterId;
    slot.pos.x = shooterPos.x;
    slot.pos.y = shooterPos.y;
    slot.pos.z = shooterPos.z;
    slot.bornAt = now;
  }

  /**
   * Age and place everything. `me` is the own plane, `viewYaw` the camera's
   * real heading (free-look included); `livePos` gives a shooter's current
   * position, or null once they are gone — the arc then freezes on the last.
   */
  update(
    now: number,
    me: Vec3,
    viewYaw: number,
    livePos: (id: string) => Vec3 | null | undefined,
  ): void {
    const flashAge = now - this.flashAt;
    const flash =
      flashAge < DAMAGE_FLASH_MS
        ? this.flashPeak * (1 - flashAge / DAMAGE_FLASH_MS)
        : 0;
    const flashText = flash.toFixed(2);
    if (flashText !== this.shownFlash) {
      this.shownFlash = flashText;
      this.flash.style.opacity = flashText;
    }
    for (const s of this.slots) {
      if (s.id === null) continue;
      const age = now - s.bornAt;
      if (age >= DAMAGE_ARC_MS) {
        s.id = null;
        this.paint(s, s.shownTransform, "0");
        continue;
      }
      const live = livePos(s.id);
      if (live) {
        s.pos.x = live.x;
        s.pos.y = live.y;
        s.pos.z = live.z;
      }
      const deg = (damageBearing(me, s.pos, viewYaw) * 180) / Math.PI;
      // Full strength for the first stretch, then fade out.
      const fade = Math.min(1, (1 - age / DAMAGE_ARC_MS) * 2);
      this.paint(s, `rotate(${deg.toFixed(1)}deg)`, fade.toFixed(2));
    }
  }

  /** Death / respawn: nothing lingers into the kill-cam or the new life. */
  clear(): void {
    this.flashAt = Number.NEGATIVE_INFINITY;
    for (const s of this.slots) {
      s.id = null;
      s.bornAt = Number.NEGATIVE_INFINITY;
      this.paint(s, s.shownTransform, "0");
    }
    if (this.shownFlash !== "0.00") {
      this.shownFlash = "0.00";
      this.flash.style.opacity = "0";
    }
  }

  private paint(s: ArcSlot, transform: string, opacity: string): void {
    if (transform !== s.shownTransform) {
      s.shownTransform = transform;
      s.el.style.transform = transform;
    }
    if (opacity !== s.shownOpacity) {
      s.shownOpacity = opacity;
      s.el.style.opacity = opacity;
    }
  }
}
