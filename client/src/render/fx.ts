// Kill explosions (T5 art pass): a pooled expanding additive shell plus a
// spray of glowing particles, per death event. Canonical world centers,
// placed at the torus image nearest the viewer every frame — the renderer's
// one placement rule (wrapPlacement), same as tracers and planes.

import type { Vec3 } from "@angels-bandits/common/world";
import * as THREE from "three";
import { nearestImage } from "./wrapPlacement";

const POOL = 6;
const LIFE_MS = 1100;
const SHELL_MAX_RADIUS = 26;
const PARTICLES = 28;
const PARTICLE_SPEED = 34; // m/s initial spray
const PARTICLE_GRAVITY = 22; // m/s² pull-down for the ember arc
const SHELL_COLOR = 0xffa04d;
const EMBER_COLOR = 0xffc46b;

interface Explosion {
  group: THREE.Group;
  shell: THREE.Mesh;
  points: THREE.Points;
  velocities: Float32Array;
  center: Vec3;
  bornAt: number;
}

export class Explosions {
  readonly group = new THREE.Group();
  private readonly pool: Explosion[] = [];

  constructor() {
    const shellGeometry = new THREE.IcosahedronGeometry(1, 1);
    const particleGeometry = new THREE.BufferGeometry();
    particleGeometry.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(PARTICLES * 3), 3),
    );
    for (let i = 0; i < POOL; i++) {
      const shell = new THREE.Mesh(
        shellGeometry,
        new THREE.MeshBasicMaterial({
          color: SHELL_COLOR,
          transparent: true,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      );
      const points = new THREE.Points(
        particleGeometry.clone(),
        new THREE.PointsMaterial({
          color: EMBER_COLOR,
          size: 1.6,
          transparent: true,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      );
      const group = new THREE.Group();
      group.add(shell, points);
      group.visible = false;
      this.group.add(group);
      this.pool.push({
        group,
        shell,
        points,
        velocities: new Float32Array(PARTICLES * 3),
        center: { x: 0, y: 0, z: 0 },
        bornAt: Number.NEGATIVE_INFINITY,
      });
    }
  }

  /** Fire an explosion at a canonical world position. */
  explode(center: Vec3, now: number): void {
    const slot = this.pool.reduce((a, b) => (a.bornAt <= b.bornAt ? a : b));
    slot.bornAt = now;
    slot.center = { ...center };
    const positions = slot.points.geometry.getAttribute(
      "position",
    ) as THREE.BufferAttribute;
    for (let i = 0; i < PARTICLES; i++) {
      // Uniform-ish sphere spray, biased slightly upward for the fireball read.
      const theta = Math.random() * Math.PI * 2;
      const cosPhi = Math.random() * 2 - 1;
      const sinPhi = Math.sqrt(1 - cosPhi * cosPhi);
      const speed = PARTICLE_SPEED * (0.4 + 0.6 * Math.random());
      slot.velocities[i * 3] = Math.cos(theta) * sinPhi * speed;
      slot.velocities[i * 3 + 1] = (cosPhi * 0.8 + 0.35) * speed;
      slot.velocities[i * 3 + 2] = Math.sin(theta) * sinPhi * speed;
      positions.setXYZ(i, 0, 0, 0);
    }
    positions.needsUpdate = true;
    slot.group.visible = true;
  }

  /** Age shells/particles and re-place every live explosion. Call per frame. */
  update(viewer: Vec3, now: number, dt: number): void {
    for (const fx of this.pool) {
      const age = now - fx.bornAt;
      if (age > LIFE_MS) {
        fx.group.visible = false;
        continue;
      }
      const t = age / LIFE_MS;
      const p = nearestImage(viewer, fx.center);
      fx.group.position.set(p.x, p.y, p.z);
      // Shell: fast expansion easing out, fading to nothing.
      const ease = 1 - (1 - t) * (1 - t);
      fx.shell.scale.setScalar(0.5 + SHELL_MAX_RADIUS * ease);
      (fx.shell.material as THREE.MeshBasicMaterial).opacity = 0.85 * (1 - t);
      // Embers: ballistic drift in the group's local frame.
      const positions = fx.points.geometry.getAttribute(
        "position",
      ) as THREE.BufferAttribute;
      for (let i = 0; i < PARTICLES; i++) {
        const vy = (fx.velocities[i * 3 + 1] ?? 0) - PARTICLE_GRAVITY * dt;
        fx.velocities[i * 3 + 1] = vy;
        positions.setXYZ(
          i,
          positions.getX(i) + (fx.velocities[i * 3] ?? 0) * dt,
          positions.getY(i) + vy * dt,
          positions.getZ(i) + (fx.velocities[i * 3 + 2] ?? 0) * dt,
        );
      }
      positions.needsUpdate = true;
      (fx.points.material as THREE.PointsMaterial).opacity = 1 - t * t;
    }
  }
}
