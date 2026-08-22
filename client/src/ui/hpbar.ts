// Target HP bar (approved concept 1): a slim cyan bar above the plane the
// LOCAL player damaged in the last ~3 s, fading linearly. The pure tracker is
// the tested seam — main.ts records only damage broadcasts where
// shooterId === selfId, so ownership is by construction. The sprite half is a
// torus-aware billboard in the nametag idiom (placed via nearestImage by the
// caller each frame).

import { MAX_HP } from "@angels-bandits/common/constants";
import * as THREE from "three";

/** How long the bar lingers after the last hit, ms (linear fade to zero). */
export const HPBAR_LINGER_MS = 3000;

/** Meters above the target's position the bar floats (under the nametag). */
export const HPBAR_ALTITUDE = 4;

/** Pure ownership + linger state: latest locally-damaged target wins. */
export class HpBarTracker {
  private targetId: string | null = null;
  private hp = 0;
  private hitAt = Number.NEGATIVE_INFINITY;

  /** A damage broadcast we caused (caller filters shooterId === selfId). */
  recordDamage(targetId: string, hp: number, now: number): void {
    this.targetId = targetId;
    this.hp = hp;
    this.hitAt = now;
  }

  /** The target died or left — never show a stale bar over its respawn. */
  clear(targetId: string): void {
    if (this.targetId === targetId) this.targetId = null;
  }

  /** What the bar shows this frame, or null once faded out. */
  current(
    now: number,
  ): { targetId: string; hp: number; alpha: number } | null {
    if (this.targetId === null) return null;
    const alpha = 1 - (now - this.hitAt) / HPBAR_LINGER_MS;
    if (alpha <= 0) return null;
    return { targetId: this.targetId, hp: this.hp, alpha };
  }
}

/** Billboard half: slim cyan fill over a dark backing (HUD palette). */
export class HpBarSprite {
  readonly sprite: THREE.Sprite;
  private readonly canvas: HTMLCanvasElement;
  private readonly texture: THREE.CanvasTexture;
  private drawnHp = -1;

  constructor() {
    this.canvas = document.createElement("canvas");
    this.canvas.width = 64;
    this.canvas.height = 8;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: this.texture,
        transparent: true,
        depthWrite: false,
      }),
    );
    this.sprite.scale.set(10, 1.25, 1); // meters — nametag-legible at range
    this.sprite.visible = false;
  }

  /** Show the bar at `hp`, `alpha` (redraws only when hp changes). */
  show(hp: number, alpha: number): void {
    if (hp !== this.drawnHp) {
      this.drawnHp = hp;
      const ctx = this.canvas.getContext("2d");
      if (ctx) {
        ctx.clearRect(0, 0, 64, 64);
        ctx.fillStyle = "#0c0b18cc";
        ctx.fillRect(0, 0, 64, 8);
        ctx.strokeStyle = "#27e0c055";
        ctx.strokeRect(0.5, 0.5, 63, 7);
        ctx.fillStyle = "#27e0c0";
        ctx.fillRect(1, 1, 62 * Math.min(1, Math.max(0, hp / MAX_HP)), 6);
      }
      this.texture.needsUpdate = true;
    }
    this.sprite.material.opacity = alpha;
    this.sprite.visible = true;
  }

  hide(): void {
    this.sprite.visible = false;
  }
}
