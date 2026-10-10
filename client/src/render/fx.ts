// Kill explosions (T5 art pass, J1 juice): per blast a white-hot core, a
// fireball and a cooler outer shell, a shockwave ring facing the viewer and
// a long spray of embers — all pooled, all additive. Canonical world centers,
// placed at the torus image nearest the viewer every frame — the renderer's
// one placement rule (wrapPlacement), same as tracers and planes.
// Impact sparks (gun-feel pass) live here too: every burst shares ONE
// THREE.Points, so all sparks on screen cost a single extra draw call.

import { EMISSIVE_TRACER } from "@angels-bandits/common/constants";
import type { Vec3 } from "@angels-bandits/common/world";
import * as THREE from "three";
import { luminance } from "./emissive";
import { nearestImageInto } from "./wrapPlacement";

/** J1: blasts alive at once (the oldest is recycled) — a carrier break-up
 * and a D9 chain reaction together stay under it. */
const POOL = 10;
/** The shells' and ring's life, and the embers' (they hang on), ms. */
const LIFE_MS = 1100;
const EMBER_LIFE_MS = 1800;
const PARTICLES = 44;
const PARTICLE_SPEED = 38; // m/s initial spray
const PARTICLE_GRAVITY = 18; // m/s² pull-down for the ember arc
const EMBER_DRAG = 0.9; // per second: embers slow and hang in the air

/**
 * J1's HDR budget (PLAN's emissive ladder: tracers stay the brightest
 * thing on screen). Each layer's colour is scaled to a PEAK linear
 * luminance; the layers are additive and can all overlap one pixel at the
 * instant of the blast, so it is their SUM — with an ember on top — that
 * must stay under EMISSIVE_TRACER. Checked at import below.
 */
export const CORE_PEAK = 0.4;
export const FIREBALL_PEAK = 0.3;
export const OUTER_PEAK = 0.15;
export const RING_PEAK = 0.15;
export const EMBER_PEAK = 0.45;
export const FIREBALL_PEAK_SUM =
  CORE_PEAK + FIREBALL_PEAK + OUTER_PEAK + RING_PEAK;
if (FIREBALL_PEAK_SUM + EMBER_PEAK >= EMISSIVE_TRACER) {
  throw new Error("fx: the explosion's summed peak outshines the tracers");
}

const CORE_COLOR = 0xfff0c0;
const SHELL_COLOR = 0xffa04d;
const OUTER_COLOR = 0xff5a1f;
const RING_COLOR = 0xffd8a0;
const EMBER_COLOR = 0xffc46b;
/** Radii a size-1 blast's layers reach, m. */
const CORE_RADIUS = 10;
const SHELL_MAX_RADIUS = 26;
const OUTER_RADIUS = 36;
const RING_RADIUS = 80;
/** Shells drawn per blast (core, fireball, outer). */
const LAYERS = 3;
/** A blast's heat column shimmers this long, ms (atmosphere-fx.ts). */
export const HEAT_MS = 1600;
/** Most blasts handed to the shimmer at once. */
export const HEAT_MAX = 2;

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
  /** J1: the slow-mo FX clock's lag behind wall time, ms (see Explosions). */
  lag = 0;
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
    slot.bornAt = now - this.lag;
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
      const age = now - this.lag - burst.bornAt;
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
  /** Birth on the FX clock (wall stamp − the slow-mo lag at the time). */
  bornAt: number;
  /** 1 a kill, ~0.6 a mid-air pop, up to 2 the carrier. */
  size: number;
}

/** One blast's heat, for the shimmer (canonical centre, 0..1 level). */
export interface Heat {
  x: number;
  y: number;
  z: number;
  size: number;
  level: number;
}

const scratchShell = new THREE.Matrix4();
const scratchTint = new THREE.Color();
const scratchEye = new THREE.Vector3();
const scratchAt = new THREE.Vector3();
const scratchScale = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const lit = (hex: number, peak: number): THREE.Color => {
  const c = new THREE.Color(hex);
  return c.multiplyScalar(peak / luminance(c));
};
const CORE_LIT = lit(CORE_COLOR, CORE_PEAK);
const SHELL_LIT = lit(SHELL_COLOR, FIREBALL_PEAK);
const OUTER_LIT = lit(OUTER_COLOR, OUTER_PEAK);
const RING_LIT = lit(RING_COLOR, RING_PEAK);
const EMBER_LIT = lit(EMBER_COLOR, EMBER_PEAK);

const easeOut = (t: number): number => 1 - (1 - t) * (1 - t);

/**
 * P4: every live explosion in THREE draws however many there are — every
 * shell layer one InstancedMesh, the shockwave rings one InstancedMesh, the
 * embers one Points. All additive, so each one's fade rides its colour
 * (instance colour, vertex colour) instead of a per-object opacity: src × α
 * + dst with the colour pre-multiplied is the same sum. Live slots are
 * packed to the front each frame, so nothing is drawn at rest.
 *
 * J1: everything here ages on the slow-mo FX clock — `lag` (set by the
 * frame loop from game/juice.ts FxClock) maps the wall stamps callers pass,
 * and update()'s dt is the FX dt. Nothing else in the world is re-timed.
 */
export class Explosions {
  readonly group = new THREE.Group();
  /** J1: how far the FX clock is behind wall time, ms. */
  lag = 0;
  private readonly pool: Explosion[] = [];
  private readonly shells: THREE.InstancedMesh;
  private readonly rings: THREE.InstancedMesh;
  private readonly embers: THREE.Points;
  private readonly emberPos: THREE.BufferAttribute;
  private readonly emberCol: THREE.BufferAttribute;
  /** J1: heatSources()' views (the first N it returns are live). */
  readonly heat: Heat[] = [];

  constructor() {
    const additive = (): THREE.MeshBasicMaterial =>
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
    this.shells = new THREE.InstancedMesh(
      new THREE.IcosahedronGeometry(1, 1),
      additive(),
      POOL * LAYERS,
    );
    this.rings = new THREE.InstancedMesh(
      new THREE.RingGeometry(0.86, 1, 48),
      additive(),
      POOL,
    );
    for (const mesh of [this.shells, this.rings]) {
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      for (let i = 0; i < mesh.count; i++) mesh.setColorAt(i, SHELL_LIT);
      mesh.instanceColor?.setUsage(THREE.DynamicDrawUsage);
      // Placed at the torus image nearest the viewer every frame.
      mesh.frustumCulled = false;
      mesh.count = 0;
    }
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
        size: 1.8,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    this.embers.frustumCulled = false;
    this.group.add(this.shells, this.rings, this.embers);
    for (let i = 0; i < POOL; i++) {
      this.pool.push({
        local: new Float32Array(PARTICLES * 3),
        velocities: new Float32Array(PARTICLES * 3),
        center: { x: 0, y: 0, z: 0 },
        bornAt: Number.NEGATIVE_INFINITY,
        size: 1,
      });
    }
    for (let i = 0; i < HEAT_MAX; i++) {
      this.heat.push({ x: 0, y: 0, z: 0, size: 1, level: 0 });
    }
  }

  /** Fire an explosion at a canonical world position. `now` is a wall
   * stamp (a future one staggers a chain); `size` scales the whole blast
   * (1 a kill, ~0.6 a mid-air pop, up to 2 the carrier). */
  explode(center: Vec3, now: number, size = 1): void {
    let slot = this.pool[0] as Explosion;
    for (const fx of this.pool) if (fx.bornAt < slot.bornAt) slot = fx;
    slot.bornAt = now - this.lag;
    slot.size = size;
    slot.center.x = center.x;
    slot.center.y = center.y;
    slot.center.z = center.z;
    const speed0 = PARTICLE_SPEED * Math.sqrt(size);
    for (let i = 0; i < PARTICLES; i++) {
      // Uniform-ish sphere spray, biased slightly upward for the fireball read.
      const theta = Math.random() * Math.PI * 2;
      const cosPhi = Math.random() * 2 - 1;
      const sinPhi = Math.sqrt(1 - cosPhi * cosPhi);
      const speed = speed0 * (0.25 + 0.75 * Math.random());
      slot.velocities[i * 3] = Math.cos(theta) * sinPhi * speed;
      slot.velocities[i * 3 + 1] = (cosPhi * 0.8 + 0.35) * speed;
      slot.velocities[i * 3 + 2] = Math.sin(theta) * sinPhi * speed;
    }
    slot.local.fill(0);
  }

  /** Explosions drawn last frame (QA). */
  get liveCount(): number {
    return this.rings.count;
  }

  /**
   * J1: the freshest blasts' heat for the shimmer, newest first: writes up
   * to HEAT_MAX into `heat` (reused views — read them before the next call)
   * and returns how many. Level is 1 at the blast, 0 at HEAT_MS.
   */
  heatSources(now: number): number {
    const t = now - this.lag;
    let n = 0;
    let before = Number.POSITIVE_INFINITY;
    for (let k = 0; k < HEAT_MAX; k++) {
      let best: Explosion | null = null;
      for (let s = 0; s < this.pool.length; s++) {
        const fx = this.pool[s] as Explosion;
        const age = t - fx.bornAt;
        if (age < 0 || age > HEAT_MS || fx.bornAt >= before) continue;
        if (best === null || fx.bornAt > best.bornAt) best = fx;
      }
      if (best === null) break;
      before = best.bornAt;
      const h = this.heat[n] as Heat;
      h.x = best.center.x;
      h.y = best.center.y;
      h.z = best.center.z;
      h.size = best.size;
      h.level = 1 - (t - best.bornAt) / HEAT_MS;
      n++;
    }
    return n;
  }

  /** Age every layer and re-place every live explosion. Call per frame
   * with the wall `now` and the FX dt (slow-mo scaled). */
  update(viewer: Vec3, now: number, dt: number): void {
    const t0 = now - this.lag;
    let live = 0;
    let shells = 0;
    const pos = this.emberPos.array as Float32Array;
    const col = this.emberCol.array as Float32Array;
    const drag = Math.exp(-EMBER_DRAG * dt);
    scratchEye.set(viewer.x, viewer.y, viewer.z);
    for (let s = 0; s < this.pool.length; s++) {
      const fx = this.pool[s] as Explosion;
      const age = t0 - fx.bornAt;
      if (age < 0 || age > EMBER_LIFE_MS) continue;
      const p = nearestImageInto(scratchImage, viewer, fx.center);
      const k = fx.size;
      const t = Math.min(1, age / LIFE_MS);
      if (t < 1) {
        // Core: a white-hot flash, gone in the first third.
        const tc = Math.min(1, t / 0.32);
        const rc = 0.5 + CORE_RADIUS * k * easeOut(tc);
        this.shell(shells++, p, rc, CORE_LIT, (1 - tc) * (1 - tc));
        // Fireball: fast expansion easing out, fading to nothing.
        const rf = 0.5 + SHELL_MAX_RADIUS * k * easeOut(t);
        this.shell(shells++, p, rf, SHELL_LIT, 1 - t);
        // Outer shell: cooler, slower, swelling after the fireball.
        const to = Math.max(0, (t - 0.08) / 0.92);
        const ro = 0.5 + OUTER_RADIUS * k * easeOut(easeOut(to));
        this.shell(shells++, p, ro, OUTER_LIT, to > 0 ? (1 - to) * 0.9 : 0);
        // Shockwave ring: a thin band racing out, always facing the viewer.
        const tr = Math.min(1, t / 0.55);
        const rr = 1 + RING_RADIUS * k * easeOut(tr);
        scratchAt.set(p.x, p.y, p.z);
        scratchShell.lookAt(scratchAt, scratchEye, UP);
        scratchShell.scale(scratchScale.setScalar(rr));
        scratchShell.setPosition(p.x, p.y, p.z);
        this.rings.setMatrixAt(live, scratchShell);
        this.rings.setColorAt(
          live,
          scratchTint.copy(RING_LIT).multiplyScalar((1 - tr) * (1 - tr)),
        );
        live++;
      }
      // Embers: ballistic drift about the centre with drag, faded through
      // the colour; they outlive the fireball and hang in the air.
      const te = age / EMBER_LIFE_MS;
      const fade = (1 - te) * (1 - te);
      const er = EMBER_LIT.r * fade;
      const eg = EMBER_LIT.g * fade * (1 - 0.35 * te); // cooling to red
      const eb = EMBER_LIT.b * fade * (1 - te);
      const local = fx.local;
      const vel = fx.velocities;
      const base = s * PARTICLES * 3;
      for (let i = 0; i < PARTICLES * 3; i += 3) {
        const vx = (vel[i] as number) * drag;
        const vy = ((vel[i + 1] as number) - PARTICLE_GRAVITY * dt) * drag;
        const vz = (vel[i + 2] as number) * drag;
        vel[i] = vx;
        vel[i + 1] = vy;
        vel[i + 2] = vz;
        const lx = (local[i] as number) + vx * dt;
        const ly = (local[i + 1] as number) + vy * dt;
        const lz = (local[i + 2] as number) + vz * dt;
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
    }
    // Idle slots' embers go dark (their colour, not their draw range: the
    // embers keep one fixed range per slot so a slot never shifts).
    let lastLive = -1;
    for (let s = 0; s < this.pool.length; s++) {
      const age = t0 - (this.pool[s] as Explosion).bornAt;
      if (age >= 0 && age <= EMBER_LIFE_MS) {
        lastLive = s;
        continue;
      }
      const base = s * PARTICLES * 3;
      if (col[base] !== 0) col.fill(0, base, base + PARTICLES * 3);
    }
    this.shells.count = shells;
    this.rings.count = live;
    for (const mesh of [this.shells, this.rings]) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    this.embers.geometry.setDrawRange(0, (lastLive + 1) * PARTICLES);
    this.emberPos.needsUpdate = true;
    this.emberCol.needsUpdate = true;
    this.group.visible = lastLive >= 0;
  }

  /** One shell instance: radius `r` at `p`, `tint` × `fade`. */
  private shell(
    i: number,
    p: Vec3,
    r: number,
    tint: THREE.Color,
    fade: number,
  ): void {
    scratchShell.makeScale(r, r, r).setPosition(p.x, p.y, p.z);
    this.shells.setMatrixAt(i, scratchShell);
    this.shells.setColorAt(i, scratchTint.copy(tint).multiplyScalar(fade));
  }
}
