// ST2 client storm: the pure storm-clock seam. Everything here is a pure
// function of (strikes from the shared schedule, snapshot poses, the synced
// clock) — no THREE, no WebAudio, no DOM. The renderer/audio/UI adapters
// consume these outputs, so the torus math and timing are testable without a
// GPU, exactly like the traffic and freelook seams.

import { type Building, mulberry32 } from "@angels-bandits/common/city";
import {
  CLOUD_BASE,
  EMISSIVE_TRACER,
  STORM_KILL_ALT,
  STORM_REVEAL_MS,
  STORM_REVEAL_RADIUS,
} from "@angels-bandits/common/constants";
import { type Strike, strikesInWindow } from "@angels-bandits/common/storm";
import { type Vec3, wrapDistance } from "@angels-bandits/common/world";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { emissiveBoost } from "./emissive";
import { nearestImage } from "./wrapPlacement";

/** Speed of sound, m/s — thunder trails the flash by wrapDistance / this. */
const SOUND_SPEED_MPS = 340;
/** Thunder is inaudible past this torus distance, m (< the 1414 m max). */
const THUNDER_RANGE = 1400;

/**
 * The planes a strike reveals: horizontal torus distance within
 * STORM_REVEAL_RADIUS. Altitude is deliberately ignored — the bolt is a
 * full-height column, so height never hides you from the storm's radar.
 */
export function revealedPlanes<T extends { pos: Vec3 }>(
  strike: Strike,
  planes: readonly T[],
): T[] {
  return planes.filter(
    (p) =>
      wrapDistance({ x: strike.x, y: p.pos.y, z: strike.z }, p.pos) <=
      STORM_REVEAL_RADIUS,
  );
}

/** Reveal intensity 1 → 0 over STORM_REVEAL_MS from the strike moment. */
export function revealLevel(struckAtMs: number, nowMs: number): number {
  const age = nowMs - struckAtMs;
  if (age < 0 || age >= STORM_REVEAL_MS) return 0;
  return 1 - age / STORM_REVEAL_MS;
}

/** Milliseconds between a strike's flash and its thunder at `listener` —
 * the shortest torus path from the strike's ground point, at 340 m/s. */
export function thunderDelayMs(strike: Strike, listener: Vec3): number {
  const dist = wrapDistance({ x: strike.x, y: 0, z: strike.z }, listener);
  return (dist / SOUND_SPEED_MPS) * 1000;
}

/** Thunder loudness 0..1: full overhead, gone past THUNDER_RANGE. */
export function thunderGain(distM: number): number {
  return Math.max(0, 1 - distM / THUNDER_RANGE);
}

/** Peak per-axis turbulence displacement at full ramp, m. Worst-case 3-axis
 * magnitude √(1.8² + 1.44² + 1.8²) ≈ 2.93 stays under the 3 m readability cap. */
const SHAKE_MAX = 1.8;
/** Base turbulence frequency scale (Neon Vein: medium sway, low frequency). */
const SHAKE_FREQ = 0.9;

/**
 * Visual-only turbulence displacement while inside the cloud deck: layered
 * sines of the clock, amplitude ramping from CLOUD_BASE up to full at
 * STORM_KILL_ALT. Pure of (time, altitude) — it never reads or writes flight
 * state, so the streamed pose is untouched by construction.
 */
/**
 * Frame-by-frame strike consumer: polls the shared schedule over abutting
 * half-open [last, now) windows on the synced snapshot clock, per the ST1
 * contract — every scheduled strike is delivered exactly once, and the first
 * tick only primes (no replay of strikes from before we joined).
 */
export class StrikeFeed {
  private lastT: number | null = null;

  constructor(private readonly seed: number) {}

  poll(nowServerMs: number | null): Strike[] {
    if (nowServerMs === null) return [];
    if (this.lastT === null || nowServerMs < this.lastT) {
      this.lastT = nowServerMs; // prime (or clock stepped backward — resync)
      return [];
    }
    const strikes = strikesInWindow(this.seed, this.lastT, nowServerMs);
    this.lastT = nowServerMs;
    return strikes;
  }
}

/** Bolt origin height above the deck, m — the channel starts in the cloud. */
const BOLT_TOP_Y = CLOUD_BASE + 40;
/** Midpoint-displacement iterations: 2^5 = 32 segments on the main channel. */
const BOLT_ITERATIONS = 5;
/** Horizontal wander per unit of remaining segment length (Neon Vein jag). */
const BOLT_JAG = 0.2;
/** Side branches per bolt (Neon Vein: 3). */
const BOLT_BRANCH_COUNT = 3;

/** Per-strike PRNG: the strike's schedule slot is already unique, so its
 * time and cell hash to a stable per-bolt stream on every client. */
const strikeRand = (strike: Strike, salt: number): (() => number) =>
  mulberry32(
    (Math.imul(strike.timeMs & 0xffffffff, 0x9e3779b9) ^
      Math.imul(strike.x * 8 + salt, 0x85ebca6b) ^
      Math.imul(strike.z * 8, 0xc2b2ae35)) >>>
      0,
  );

/** Midpoint-displacement polyline between two local points. */
function displace(
  from: Vec3,
  to: Vec3,
  jag: number,
  rand: () => number,
): Vec3[] {
  let pts = [from, to];
  for (let it = 0; it < BOLT_ITERATIONS; it++) {
    const next: Vec3[] = [pts[0] as Vec3];
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1] as Vec3;
      const b = pts[i] as Vec3;
      const len = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
      next.push(
        {
          x: (a.x + b.x) / 2 + (rand() - 0.5) * len * jag,
          y: (a.y + b.y) / 2 + (rand() - 0.5) * len * jag * 0.35,
          z: (a.z + b.z) / 2 + (rand() - 0.5) * len * jag,
        },
        b,
      );
    }
    pts = next;
  }
  return pts;
}

/**
 * The main lightning channel for a strike, as OFFSETS from the strike's
 * ground anchor: from inside the cloud deck down to (0, topY, 0) — the
 * renderer places the whole thing at the strike's nearest torus image.
 * Deterministic per strike, so every client draws the identical bolt.
 */
export function boltPolyline(strike: Strike, topY: number): Vec3[] {
  const rand = strikeRand(strike, 1);
  const from = {
    x: (rand() - 0.5) * 110,
    // Kill bolts strike planes above the deck — always start above them.
    y: Math.max(BOLT_TOP_Y, topY + 120),
    z: (rand() - 0.5) * 110,
  };
  return displace(from, { x: 0, y: topY, z: 0 }, BOLT_JAG, rand);
}

/** Side branches: thin forks hung off points of the main channel, angling
 * down and out. Same determinism contract as the main channel. */
export function boltBranches(strike: Strike, main: readonly Vec3[]): Vec3[][] {
  const rand = strikeRand(strike, 2);
  const branches: Vec3[][] = [];
  for (let b = 0; b < BOLT_BRANCH_COUNT; b++) {
    const root = main[4 + Math.floor(rand() * main.length * 0.6)];
    if (!root) continue;
    const end = {
      x: root.x + (rand() - 0.5) * 160,
      y: root.y - 40 - rand() * 110,
      z: root.z + (rand() - 0.5) * 160,
    };
    branches.push(displace(root, end, BOLT_JAG * 1.4, rand));
  }
  return branches;
}

export function turbulenceOffset(tMs: number, altitude: number): Vec3 {
  if (altitude <= CLOUD_BASE) return { x: 0, y: 0, z: 0 };
  const ramp = Math.min(
    1,
    (altitude - CLOUD_BASE) / (STORM_KILL_ALT - CLOUD_BASE),
  );
  const a = (SHAKE_MAX / 2) * ramp; // two sines per axis → peak = 2a
  const t = (tMs / 1000) * SHAKE_FREQ;
  return {
    x: (Math.sin(t * 13) + Math.sin(t * 7.3 + 1.7)) * a,
    y: (Math.sin(t * 11 + 0.9) + Math.sin(t * 17)) * a * 0.8,
    z: (Math.sin(t * 15 + 2.4) + Math.sin(t * 6.1)) * a,
  };
}

// --- Renderer (Neon Vein, the human-approved concept 2) ---------------------
// A white-hot core wrapped in a violet-magenta halo with a lingering 280 ms
// afterglow; the sky flash is a violet-tinted ambient pulse, 140 ms, capped
// well below the tracer rung so combat readability survives every strike.

/** Bolt afterglow life, ms (Neon Vein's lingering fade). */
const BOLT_LIFE_MS = 280;
/** Core luminance sits just under the tracer rung: lightning is scenery. */
const BOLT_CORE_LUMA = EMISSIVE_TRACER - 0.05;
const BOLT_CORE_COLOR = 0xf4eeff;
const BOLT_GLOW_COLOR = 0xb46cff; // violet-magenta halo
const BOLT_GLOW_OPACITY = 0.42;
const BOLT_CORE_RADIUS = 0.8;
const BOLT_GLOW_RADIUS = 4.6;
/** Sky flash: violet ambient pulse + fog/dome stain, ≤ 150 ms by contract. */
const FLASH_MS = 140;
const FLASH_COLOR = 0xa678ff;
/** Peak added ambient intensity (base scene ambient is 0.5). */
const FLASH_PEAK = 1.3;
/** Peak fog/sky-dome stain toward FLASH_COLOR (0..1 lerp). */
const FLASH_TINT = 0.24;
/** Simultaneously-alive bolts: schedule cadence is 8–15 s, life 280 ms, so
 * 3 slots only ever fill when kill bolts pile onto a scheduled strike. */
const BOLT_SLOTS = 3;

interface BoltSlot {
  group: THREE.Group;
  core: THREE.Mesh;
  glow: THREE.Mesh;
  coreMat: THREE.MeshBasicMaterial;
  glowMat: THREE.MeshBasicMaterial;
  anchor: Vec3;
  bornAt: number;
}

/** Reveal ping fed to the minimap: where a plane was when the storm lit it. */
export interface StormPing {
  pos: Vec3;
  at: number;
}

export class StormRenderer {
  readonly group = new THREE.Group();
  /** Violet flash light — add to the scene next to the bolts group. */
  readonly flashLight = new THREE.AmbientLight(FLASH_COLOR, 0);
  private readonly slots: BoltSlot[] = [];
  private flashAt = Number.NEGATIVE_INFINITY;
  private readonly fogBase = new THREE.Color();
  private readonly flashColor = new THREE.Color(FLASH_COLOR);
  private readonly scratch = new THREE.Color();
  private fogBaseCaptured = false;

  constructor(private readonly buildings: readonly Building[]) {
    const coreBoost = emissiveBoost(
      new THREE.Color(BOLT_CORE_COLOR),
      BOLT_CORE_LUMA,
    );
    for (let i = 0; i < BOLT_SLOTS; i++) {
      const coreMat = new THREE.MeshBasicMaterial({
        color: BOLT_CORE_COLOR,
        transparent: true,
        depthWrite: false,
        fog: false,
      });
      coreMat.color.multiplyScalar(coreBoost);
      const glowMat = new THREE.MeshBasicMaterial({
        color: BOLT_GLOW_COLOR,
        transparent: true,
        opacity: BOLT_GLOW_OPACITY,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
      });
      const core = new THREE.Mesh(new THREE.BufferGeometry(), coreMat);
      const glow = new THREE.Mesh(new THREE.BufferGeometry(), glowMat);
      core.frustumCulled = false;
      glow.frustumCulled = false;
      const group = new THREE.Group();
      group.add(glow, core);
      group.visible = false;
      this.group.add(group);
      this.slots.push({
        group,
        core,
        glow,
        coreMat,
        glowMat,
        anchor: { x: 0, y: 0, z: 0 },
        bornAt: Number.NEGATIVE_INFINITY,
      });
    }
  }

  /** Rooftop height under a canonical (x, z), 0 over streets and plazas.
   * Footprints never cross the seam (max 170 m inside 200 m blocks), so a
   * plain AABB test against canonical centers is wrap-correct. */
  private topYAt(x: number, z: number): number {
    for (const b of this.buildings) {
      if (
        Math.abs(x - b.x) <= b.width / 2 &&
        Math.abs(z - b.z) <= b.depth / 2
      ) {
        return b.height;
      }
    }
    return 0;
  }

  /** A scheduled strike: bolt from the deck to the rooftop/ground + flash. */
  strike(strike: Strike, nowMs: number): void {
    this.fire(strike, this.topYAt(strike.x, strike.z), nowMs);
  }

  /** A kill bolt (DeathMsg cause "storm"): straight down onto the victim. */
  boltAt(pos: Vec3, nowMs: number): void {
    this.fire({ timeMs: Math.floor(nowMs), x: pos.x, z: pos.z }, pos.y, nowMs);
  }

  private fire(strike: Strike, topY: number, nowMs: number): void {
    const slot = this.slots.reduce((a, b) => (a.bornAt <= b.bornAt ? a : b));
    const main = boltPolyline(strike, topY);
    const runs = [main, ...boltBranches(strike, main)];
    slot.core.geometry.dispose();
    slot.glow.geometry.dispose();
    slot.core.geometry = boltTube(runs, BOLT_CORE_RADIUS, 1);
    slot.glow.geometry = boltTube(runs, BOLT_GLOW_RADIUS, 0.55);
    slot.anchor = { x: strike.x, y: 0, z: strike.z };
    slot.bornAt = nowMs;
    slot.group.visible = true;
    this.flashAt = nowMs;
  }

  /** Age bolts and re-place them at the image nearest the viewer. */
  update(viewer: Vec3, nowMs: number): void {
    for (const slot of this.slots) {
      const age = nowMs - slot.bornAt;
      if (age > BOLT_LIFE_MS) {
        slot.group.visible = false;
        continue;
      }
      const p = nearestImage(viewer, slot.anchor);
      slot.group.position.set(p.x, p.y, p.z);
      // Hold hot for 40% of the life, then the Neon Vein afterglow fade —
      // with a deterministic arc flicker so the channel feels alive.
      const k = age / BOLT_LIFE_MS;
      const hold = k < 0.4 ? 1 : 1 - (k - 0.4) / 0.6;
      const flicker = 0.8 + 0.2 * Math.sin(age * 0.11);
      slot.coreMat.opacity = hold * flicker;
      slot.glowMat.opacity = BOLT_GLOW_OPACITY * hold * flicker;
    }
  }

  /** Current flash envelope 0..1 (soft 140 ms decay). */
  private flashLevel(nowMs: number): number {
    const age = nowMs - this.flashAt;
    if (age < 0 || age >= FLASH_MS) return 0;
    return 1 - age / FLASH_MS;
  }

  /**
   * Drive the sky-flash pulse: violet ambient light plus a fog stain toward
   * the flash color. The dome tint is returned for the SkyDome to apply, so
   * this stays the single writer of storm atmosphere. Tracers and all other
   * emissives are unlit materials — an ambient pulse cannot wash them out,
   * and the stained fog peaks far below the 0.72 bloom threshold.
   */
  applyFlash(scene: THREE.Scene, nowMs: number): THREE.Color {
    const f = this.flashLevel(nowMs);
    this.flashLight.intensity = f * FLASH_PEAK;
    if (scene.fog && !this.fogBaseCaptured) {
      this.fogBase.copy(scene.fog.color);
      this.fogBaseCaptured = true;
    }
    if (scene.fog) {
      scene.fog.color
        .copy(this.fogBase)
        .lerp(this.flashColor, f * FLASH_TINT);
      if (scene.background instanceof THREE.Color) {
        scene.background.copy(scene.fog.color);
      }
    }
    // Dome stain: multiplicative tint pulled toward violet and brightened.
    this.scratch
      .setRGB(1, 1, 1)
      .lerp(this.flashColor, f * FLASH_TINT)
      .multiplyScalar(1 + f * 1.6);
    return this.scratch;
  }
}

/** Merge one tube (open cylinders per segment) over a set of polylines. */
function boltTube(
  runs: readonly (readonly Vec3[])[],
  radius: number,
  branchScale: number,
): THREE.BufferGeometry {
  const template = new THREE.CylinderGeometry(1, 1, 1, 5, 1, true);
  const up = new THREE.Vector3(0, 1, 0);
  const dir = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const mat = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const parts: THREE.BufferGeometry[] = [];
  runs.forEach((run, runIdx) => {
    const r = radius * (runIdx === 0 ? 1 : branchScale);
    for (let i = 1; i < run.length; i++) {
      const a = run[i - 1] as Vec3;
      const b = run[i] as Vec3;
      dir.set(b.x - a.x, b.y - a.y, b.z - a.z);
      const len = dir.length();
      if (len < 0.01) continue;
      quat.setFromUnitVectors(up, dir.normalize());
      pos.set((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
      scale.set(r, len * 1.06, r);
      mat.compose(pos, quat, scale);
      parts.push(template.clone().applyMatrix4(mat));
    }
  });
  template.dispose();
  const merged = mergeGeometries(parts);
  for (const part of parts) part.dispose();
  return merged ?? new THREE.BufferGeometry();
}
