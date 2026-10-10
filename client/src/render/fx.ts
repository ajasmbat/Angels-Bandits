// Kill explosions (T5 art pass): a pooled expanding additive shell plus a
// spray of glowing particles, per death event. Canonical world centers,
// placed at the torus image nearest the viewer every frame — the renderer's
// one placement rule (wrapPlacement), same as tracers and planes.
// Impact sparks (gun-feel pass) live here too: every burst shares ONE
// THREE.Points, so all sparks on screen cost a single extra draw call.

import type { Vec3 } from "@angels-bandits/common/world";
import * as THREE from "three";
import { nearestImageInto } from "./wrapPlacement";

const POOL = 6;
const LIFE_MS = 1100;
const SHELL_MAX_RADIUS = 26;
const PARTICLES = 28;
const PARTICLE_SPEED = 34; // m/s initial spray
const PARTICLE_GRAVITY = 22; // m/s² pull-down for the ember arc
const SHELL_COLOR = 0xffa04d;
const EMBER_COLOR = 0xffc46b;

const SPARK_BURSTS = 10;
const SPARK_PARTICLES = 12;
const SPARK_LIFE_MS = 380;
const SPARK_SPEED = 26; // m/s initial spray
const SPARK_GRAVITY = 30; // m/s² pull-down
const SPARK_COLOR = 0xffc46b; // matches tracer rounds — the bullet's spray
/** Parked altitude for particles of idle burst slots (never on screen). */
const SPARK_PARKED_Y = -9999;

const scratchImage: Vec3 = { x: 0, y: 0, z: 0 };

interface SparkBurst {
  center: Vec3;
  velocities: Float32Array;
  bornAt: number;
}

/** Pooled impact sparks: one shared Points for every live burst (1 draw). */
export class Sparks {
  readonly points: THREE.Points;
  private readonly bursts: SparkBurst[] = [];
  private readonly positions: THREE.BufferAttribute;

  /** `color`: the default is the bullet's own spray; U1's shield glance
   * gets a second pool in blue-white. */
  constructor(color: number = SPARK_COLOR) {
    const geometry = new THREE.BufferGeometry();
    this.positions = new THREE.BufferAttribute(
      new Float32Array(SPARK_BURSTS * SPARK_PARTICLES * 3),
      3,
    );
    for (let i = 0; i < SPARK_BURSTS * SPARK_PARTICLES; i++) {
      this.positions.setXYZ(i, 0, SPARK_PARKED_Y, 0);
    }
    geometry.setAttribute("position", this.positions);
    this.points = new THREE.Points(
      geometry,
      new THREE.PointsMaterial({
        color,
        size: 1.1,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    // Positions are rewritten every frame — never trust a cached bound.
    this.points.frustumCulled = false;
    for (let i = 0; i < SPARK_BURSTS; i++) {
      this.bursts.push({
        center: { x: 0, y: 0, z: 0 },
        velocities: new Float32Array(SPARK_PARTICLES * 3),
        bornAt: Number.NEGATIVE_INFINITY,
      });
    }
  }

  /** Spray a burst at a canonical world position (a bullet's hit point). */
  burst(center: Vec3, now: number): void {
    const slot = this.bursts.reduce((a, b) => (a.bornAt <= b.bornAt ? a : b));
    slot.bornAt = now;
    slot.center = { ...center };
    for (let i = 0; i < SPARK_PARTICLES; i++) {
      const theta = Math.random() * Math.PI * 2;
      const cosPhi = Math.random() * 2 - 1;
      const sinPhi = Math.sqrt(1 - cosPhi * cosPhi);
      const speed = SPARK_SPEED * (0.35 + 0.65 * Math.random());
      slot.velocities[i * 3] = Math.cos(theta) * sinPhi * speed;
      slot.velocities[i * 3 + 1] = cosPhi * speed;
      slot.velocities[i * 3 + 2] = Math.sin(theta) * sinPhi * speed;
    }
  }

  /** Fly live sparks ballistically around the viewer; park expired ones. */
  update(viewer: Vec3, now: number): void {
    // P4: draw up to the last live burst's slot only — nothing at rest.
    let end = 0;
    for (let s = 0; s < this.bursts.length; s++) {
      const burst = this.bursts[s] as SparkBurst;
      const age = now - burst.bornAt;
      const base = s * SPARK_PARTICLES;
      if (age <= SPARK_LIFE_MS) end = base + SPARK_PARTICLES;
      if (age > SPARK_LIFE_MS) {
        if (this.positions.getY(base) !== SPARK_PARKED_Y) {
          for (let i = 0; i < SPARK_PARTICLES; i++) {
            this.positions.setXYZ(base + i, 0, SPARK_PARKED_Y, 0);
          }
        }
        continue;
      }
      const p = nearestImageInto(scratchImage, viewer, burst.center);
      const t = age / 1000; // seconds since burst — analytic, no integration
      for (let i = 0; i < SPARK_PARTICLES; i++) {
        const vx = burst.velocities[i * 3] ?? 0;
        const vy = burst.velocities[i * 3 + 1] ?? 0;
        const vz = burst.velocities[i * 3 + 2] ?? 0;
        this.positions.setXYZ(
          base + i,
          p.x + vx * t,
          p.y + vy * t - 0.5 * SPARK_GRAVITY * t * t,
          p.z + vz * t,
        );
      }
    }
    // three still issues a (counted) draw for an empty range: hide instead.
    this.points.geometry.setDrawRange(0, end);
    this.points.visible = end > 0;
    this.positions.needsUpdate = true;
  }
}

interface Explosion {
  /** Ember positions relative to the centre, integrated per frame. */
  local: Float32Array;
  velocities: Float32Array;
  center: Vec3;
  bornAt: number;
  /** W2: size multiplier — a bomb load going up is a bigger fireball. */
  scale: number;
}

const scratchShell = new THREE.Matrix4();
const scratchTint = new THREE.Color();
const SHELL_LIT = new THREE.Color(SHELL_COLOR);
const EMBER_LIT = new THREE.Color(EMBER_COLOR);

/**
 * P4: every live explosion in TWO draws however many there are — the shells
 * one InstancedMesh, the embers one Points (each slot was its own shell and
 * Points before: 2 draws an explosion, up to 12 when a bomb carpet lands).
 * Both are additive, so each one's fade rides its colour (instance colour,
 * vertex colour) instead of a per-object opacity: src × α + dst with the
 * colour pre-multiplied is the same sum. Live slots are packed to the front
 * each frame, so nothing is drawn at rest.
 */
export class Explosions {
  readonly group = new THREE.Group();
  private readonly pool: Explosion[] = [];
  private readonly shells: THREE.InstancedMesh;
  private readonly embers: THREE.Points;
  private readonly emberPos: THREE.BufferAttribute;
  private readonly emberCol: THREE.BufferAttribute;

  constructor() {
    this.shells = new THREE.InstancedMesh(
      new THREE.IcosahedronGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
      POOL,
    );
    this.shells.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < POOL; i++) this.shells.setColorAt(i, SHELL_LIT);
    this.shells.instanceColor?.setUsage(THREE.DynamicDrawUsage);
    // Placed at the torus image nearest the viewer every frame.
    this.shells.frustumCulled = false;
    const geometry = new THREE.BufferGeometry();
    this.emberPos = new THREE.BufferAttribute(
      new Float32Array(POOL * PARTICLES * 3),
      3,
    );
    this.emberPos.setUsage(THREE.DynamicDrawUsage);
    this.emberCol = new THREE.BufferAttribute(
      new Float32Array(POOL * PARTICLES * 3),
      3,
    );
    this.emberCol.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("position", this.emberPos);
    geometry.setAttribute("color", this.emberCol);
    this.embers = new THREE.Points(
      geometry,
      new THREE.PointsMaterial({
        color: 0xffffff,
        vertexColors: true,
        size: 1.6,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    this.embers.frustumCulled = false;
    this.group.add(this.shells, this.embers);
    for (let i = 0; i < POOL; i++) {
      this.pool.push({
        local: new Float32Array(PARTICLES * 3),
        velocities: new Float32Array(PARTICLES * 3),
        center: { x: 0, y: 0, z: 0 },
        bornAt: Number.NEGATIVE_INFINITY,
        scale: 1,
      });
    }
  }

  /** Fire an explosion at a canonical world position (W2: `scale` sizes
   * the shell and the ember spray — 1 for a plane's death). */
  explode(center: Vec3, now: number, scale = 1): void {
    let slot = this.pool[0] as Explosion;
    for (const fx of this.pool) if (fx.bornAt < slot.bornAt) slot = fx;
    slot.bornAt = now;
    slot.scale = scale;
    slot.center.x = center.x;
    slot.center.y = center.y;
    slot.center.z = center.z;
    for (let i = 0; i < PARTICLES; i++) {
      // Uniform-ish sphere spray, biased slightly upward for the fireball read.
      const theta = Math.random() * Math.PI * 2;
      const cosPhi = Math.random() * 2 - 1;
      const sinPhi = Math.sqrt(1 - cosPhi * cosPhi);
      const speed = PARTICLE_SPEED * scale * (0.4 + 0.6 * Math.random());
      slot.velocities[i * 3] = Math.cos(theta) * sinPhi * speed;
      slot.velocities[i * 3 + 1] = (cosPhi * 0.8 + 0.35) * speed;
      slot.velocities[i * 3 + 2] = Math.sin(theta) * sinPhi * speed;
    }
    slot.local.fill(0);
  }

  /** Explosions drawn last frame (QA). */
  get liveCount(): number {
    return this.shells.count;
  }

  /** Age shells/particles and re-place every live explosion. Call per frame. */
  update(viewer: Vec3, now: number, dt: number): void {
    let live = 0;
    const pos = this.emberPos.array as Float32Array;
    const col = this.emberCol.array as Float32Array;
    for (let s = 0; s < this.pool.length; s++) {
      const fx = this.pool[s] as Explosion;
      const age = now - fx.bornAt;
      if (age > LIFE_MS) continue;
      const t = age / LIFE_MS;
      const p = nearestImageInto(scratchImage, viewer, fx.center);
      // Shell: fast expansion easing out, fading to nothing.
      const ease = 1 - (1 - t) * (1 - t);
      const r = 0.5 + SHELL_MAX_RADIUS * fx.scale * ease;
      scratchShell.makeScale(r, r, r).setPosition(p.x, p.y, p.z);
      this.shells.setMatrixAt(live, scratchShell);
      this.shells.setColorAt(
        live,
        scratchTint.copy(SHELL_LIT).multiplyScalar(0.85 * (1 - t)),
      );
      // Embers: ballistic drift about the centre, faded through the colour.
      const fade = 1 - t * t;
      const er = EMBER_LIT.r * fade;
      const eg = EMBER_LIT.g * fade;
      const eb = EMBER_LIT.b * fade;
      const local = fx.local;
      const vel = fx.velocities;
      const base = live * PARTICLES * 3;
      for (let i = 0; i < PARTICLES * 3; i += 3) {
        const vy = (vel[i + 1] as number) - PARTICLE_GRAVITY * dt;
        vel[i + 1] = vy;
        const lx = (local[i] as number) + (vel[i] as number) * dt;
        const ly = (local[i + 1] as number) + vy * dt;
        const lz = (local[i + 2] as number) + (vel[i + 2] as number) * dt;
        local[i] = lx;
        local[i + 1] = ly;
        local[i + 2] = lz;
        pos[base + i] = p.x + lx;
        pos[base + i + 1] = p.y + ly;
        pos[base + i + 2] = p.z + lz;
        col[base + i] = er;
        col[base + i + 1] = eg;
        col[base + i + 2] = eb;
      }
      live++;
    }
    this.shells.count = live;
    this.shells.instanceMatrix.needsUpdate = true;
    if (this.shells.instanceColor) this.shells.instanceColor.needsUpdate = true;
    this.embers.geometry.setDrawRange(0, live * PARTICLES);
    this.emberPos.needsUpdate = true;
    this.emberCol.needsUpdate = true;
    this.group.visible = live > 0;
  }
}

/** W2: shock rings — a bomb's blast front racing out across the street or
 * the roof it hit, and the ring round a bomb load going up in the air. */
const RING_POOL = 8;
const RING_LIFE_MS = 650;
const RING_COLOR = new THREE.Color(0xffd9a0);

interface Ring {
  center: Vec3;
  bornAt: number;
  radius: number;
}

/**
 * W2: pooled shock rings — every live ring in ONE draw (an InstancedMesh of
 * a flat additive annulus, laid level), expanding to its radius and fading
 * through its colour. Placed at the torus image nearest the viewer every
 * frame; nothing is drawn at rest.
 */
export class ShockRings {
  readonly group = new THREE.Group();
  private readonly pool: Ring[] = [];
  private readonly mesh: THREE.InstancedMesh;

  constructor() {
    const geo = new THREE.RingGeometry(0.82, 1, 48, 1);
    geo.rotateX(-Math.PI / 2);
    this.mesh = new THREE.InstancedMesh(
      geo,
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
      RING_POOL,
    );
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < RING_POOL; i++) this.mesh.setColorAt(i, RING_COLOR);
    this.mesh.instanceColor?.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.group.add(this.mesh);
    // Hidden until the first ring (boot's prewarm shows it once, so its
    // program is compiled before a bomb ever lands).
    this.group.visible = false;
    for (let i = 0; i < RING_POOL; i++) {
      this.pool.push({
        center: { x: 0, y: 0, z: 0 },
        bornAt: Number.NEGATIVE_INFINITY,
        radius: 0,
      });
    }
  }

  /** A ring out to `radius` m from a canonical world position. */
  ring(center: Vec3, radius: number, now: number): void {
    let slot = this.pool[0] as Ring;
    for (const r of this.pool) if (r.bornAt < slot.bornAt) slot = r;
    slot.bornAt = now;
    slot.radius = radius;
    slot.center.x = center.x;
    slot.center.y = center.y + 0.6;
    slot.center.z = center.z;
  }

  /** Rings drawn last frame (QA). */
  get liveCount(): number {
    return this.mesh.count;
  }

  update(viewer: Vec3, now: number): void {
    let live = 0;
    for (const r of this.pool) {
      const age = now - r.bornAt;
      if (age > RING_LIFE_MS) continue;
      const t = age / RING_LIFE_MS;
      const p = nearestImageInto(scratchImage, viewer, r.center);
      const k = 1 - (1 - t) * (1 - t) * (1 - t);
      const s = 1 + r.radius * k;
      scratchShell.makeScale(s, 1, s).setPosition(p.x, p.y, p.z);
      this.mesh.setMatrixAt(live, scratchShell);
      this.mesh.setColorAt(
        live,
        scratchTint.copy(RING_COLOR).multiplyScalar(0.9 * (1 - t)),
      );
      live++;
    }
    this.mesh.count = live;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.group.visible = live > 0;
  }
}
