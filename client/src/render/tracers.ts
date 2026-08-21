// Tracer + muzzle-flash rendering: a fixed pool of additive-blended streaks,
// one per live bullet, plus short-lived flash sprites at muzzles. Additive
// glow over the dark city reads as neon (PLAN.md presentation). Placement
// follows the one rule of the renderer: everything drawn goes through
// nearestImage relative to the viewer.

import type { Vec3 } from "@angels-bandits/common/world";
import * as THREE from "three";
import type { Bullet } from "../game/bullets";
import { nearestImage } from "./wrapPlacement";

const TRACER_POOL = 64;
const TRACER_LENGTH = 10; // meters of glowing streak
const FLASH_POOL = 8;
const FLASH_LIFE_MS = 60;

const TRACER_COLOR = 0xffc46b; // warm incandescent rounds

const up = new THREE.Vector3(0, 1, 0);
const dir = new THREE.Vector3();

export class Tracers {
  readonly group = new THREE.Group();
  private readonly streaks: THREE.Mesh[] = [];
  private readonly flashes: { sprite: THREE.Sprite; bornAt: number }[] = [];
  private readonly streakMaterial: THREE.MeshBasicMaterial;
  private readonly flashMaterial: THREE.SpriteMaterial;
  private readonly streakGeometry: THREE.CylinderGeometry;

  constructor() {
    this.streakMaterial = new THREE.MeshBasicMaterial({
      color: TRACER_COLOR,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    // Thin cylinder along Y; oriented per frame with quaternions.
    this.streakGeometry = new THREE.CylinderGeometry(
      0.18,
      0.18,
      TRACER_LENGTH,
      5,
    );
    for (let i = 0; i < TRACER_POOL; i++) {
      const mesh = new THREE.Mesh(this.streakGeometry, this.streakMaterial);
      mesh.visible = false;
      this.streaks.push(mesh);
      this.group.add(mesh);
    }
    this.flashMaterial = new THREE.SpriteMaterial({
      color: TRACER_COLOR,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    for (let i = 0; i < FLASH_POOL; i++) {
      const sprite = new THREE.Sprite(this.flashMaterial.clone());
      sprite.scale.set(4, 4, 1);
      sprite.visible = false;
      this.flashes.push({ sprite, bornAt: Number.NEGATIVE_INFINITY });
    }
    for (const f of this.flashes) this.group.add(f.sprite);
  }

  /** Pop a muzzle flash at a world position (fades out over FLASH_LIFE_MS). */
  flash(at: Vec3, now: number): void {
    const slot = this.flashes.reduce((a, b) => (a.bornAt <= b.bornAt ? a : b));
    slot.bornAt = now;
    slot.sprite.userData.at = { ...at };
  }

  /** Place streaks over `bullets` and age the flashes. Call every frame. */
  update(bullets: readonly Bullet[], viewer: Vec3, now: number): void {
    for (let i = 0; i < this.streaks.length; i++) {
      const mesh = this.streaks[i] as THREE.Mesh;
      const bullet = bullets[i];
      if (!bullet) {
        mesh.visible = false;
        continue;
      }
      const p = nearestImage(viewer, bullet.pos);
      mesh.position.set(p.x, p.y, p.z);
      dir.set(bullet.vel.x, bullet.vel.y, bullet.vel.z).normalize();
      mesh.quaternion.setFromUnitVectors(up, dir);
      mesh.visible = true;
    }
    for (const f of this.flashes) {
      const age = now - f.bornAt;
      if (age > FLASH_LIFE_MS || !f.sprite.userData.at) {
        f.sprite.visible = false;
        continue;
      }
      const at = f.sprite.userData.at as Vec3;
      const p = nearestImage(viewer, at);
      f.sprite.position.set(p.x, p.y, p.z);
      f.sprite.material.opacity = 1 - age / FLASH_LIFE_MS;
      f.sprite.visible = true;
    }
  }
}
