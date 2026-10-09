// ST2 client storm: the pure storm-clock seam. Everything here is a pure
// function of (strikes from the shared schedule, snapshot poses, the synced
// clock) — no THREE, no WebAudio, no DOM. The renderer/audio/UI adapters
// consume these outputs, so the torus math and timing are testable without a
// GPU, exactly like the traffic and freelook seams.

import { type Building, mulberry32 } from "@angels-bandits/common/city";
import { roofTopAt } from "@angels-bandits/common/city/roof-structures";
import {
  CLOUD_BASE,
  EMISSIVE_TRACER,
  FOG_DISTANCE,
  STORM_KILL_ALT,
  STORM_REVEAL_MS,
  STORM_REVEAL_RADIUS,
  WORLD_SIZE,
} from "@angels-bandits/common/constants";
import { type Strike, strikesInWindow } from "@angels-bandits/common/storm";
import { type Vec3, wrapDistance } from "@angels-bandits/common/world";
import * as THREE from "three";
import { emissiveBoost } from "./emissive";
import { HAZE_WEATHER } from "./fog";
import { RENDER_ORDER } from "./render-order";
import { DUSK, FOG_NEAR } from "./sky";
import { nearestImage, nearestImageInto, uploadPrefix } from "./wrapPlacement";

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

  /** Forget the last poll: the next one only primes (a QA clock jump). */
  reset(): void {
    this.lastT = null;
  }
}

/** One active reveal: a plane the storm lit, echoing where it was lit. */
interface Reveal {
  id: string;
  pos: Vec3;
  at: number;
}

/**
 * The storm's neutral radar: every strike reveals the planes in its column
 * for STORM_REVEAL_MS — rim-flash on the model, echo blip on EVERY minimap.
 * Pure bookkeeping over revealedPlanes/revealLevel; a fresh strike replaces
 * a fading reveal at full strength.
 */
export class StormReveals {
  private reveals: Reveal[] = [];

  onStrike(
    strike: Strike,
    planes: readonly { id: string; pos: Vec3 }[],
    atMs: number,
  ): void {
    for (const p of revealedPlanes(strike, planes)) {
      // Latest reveal wins per plane — drop any older echo for the same id.
      this.reveals = this.reveals.filter((r) => r.id !== p.id);
      this.reveals.push({ id: p.id, pos: { ...p.pos }, at: atMs });
    }
  }

  /** Rim-flash intensity for one plane, 1 → 0 over STORM_REVEAL_MS. */
  levelOf(id: string, nowMs: number): number {
    for (const r of this.reveals) {
      if (r.id === id) return revealLevel(r.at, nowMs);
    }
    return 0;
  }

  /** Active minimap echoes, pruned as they expire. */
  pings(nowMs: number): { id: string; pos: Vec3; level: number }[] {
    this.reveals = this.reveals.filter((r) => revealLevel(r.at, nowMs) > 0);
    return this.reveals.map((r) => ({
      id: r.id,
      pos: r.pos,
      level: revealLevel(r.at, nowMs),
    }));
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
/** Peak added ambient intensity. VO1's blue-hour fill (ambient 0.75 +
 * hemisphere 1.35) is ~7x the old night's, so the flash doubled to stay a
 * visible pulse: ~3x the base fill at peak, facades still far sub-bloom. */
const FLASH_PEAK = 2.6;
/** Peak fog/sky-dome stain toward FLASH_COLOR (0..1 lerp). */
const FLASH_TINT = 0.24;
/** Simultaneously-alive bolts: schedule cadence is 8–15 s, life 280 ms, so
 * 3 slots only ever fill when kill bolts pile onto a scheduled strike. */
const BOLT_SLOTS = 3;
/** In-cloud fog band (camera above CLOUD_BASE): dense grey-violet soup. */
const IN_CLOUD_FOG_NEAR = 12;
const IN_CLOUD_FOG_FAR = 190;
const IN_CLOUD_FOG_COLOR = 0x3a3c52;

/** L4 weather → atmosphere. A downpour pulls the fog's near edge in (fog FAR
 * never moves: it is the torus occlusion guarantee), thickens the height haze
 * by up to RAIN_HAZE_EXTRA, and darkens fog + dome TOGETHER by up to
 * RAIN_DARKEN (darken-only, so the horizon seam stays invisible). */
const RAIN_FOG_NEAR = 70;
const RAIN_HAZE_EXTRA = 0.6;
/** D3: inside a collapse's dust cloud (render/dust.ts dustHaze, 0..1) the
 * haze thickens by up to this and the fog closes to DUST_FOG_NEAR/FAR, m —
 * a sight-blocking brown-out that is the same on every quality tier. */
const DUST_HAZE_EXTRA = 6;
const DUST_FOG_NEAR = 4;
const DUST_FOG_FAR = 140;
/** Concrete dust: the fog colour the brown-out pulls toward (sRGB). */
const DUST_FOG_COLOR = 0x4a443e;
const RAIN_DARKEN = 0.15;

/** The slice of the shared weather (common/src/weather.ts) the sky reads. */
export interface SkyWeather {
  /** Extra haze, 0..1. */
  haze: number;
  /** Lightning flash scale (dim in a dry sky, 1 in a downpour). */
  flash: number;
}
const DRY_SKY: SkyWeather = { haze: 0, flash: 1 };

/** Kill bolts linger through the kill-cam beat, not just a schedule blink. */
const KILL_BOLT_LIFE_MS = 900;

interface BoltSlot {
  group: THREE.Group;
  core: THREE.Mesh;
  glow: THREE.Mesh;
  coreMat: THREE.MeshBasicMaterial;
  glowMat: THREE.MeshBasicMaterial;
  anchor: Vec3;
  bornAt: number;
  lifeMs: number;
}

/** Reveal rim-flash tint on plane models + minimap echo color (Neon Vein
 * ping magenta). Peak emissive luminance stays under the 0.72 bloom
 * threshold by design — a silhouette glow, not a new ladder rung. */
export const REVEAL_COLOR = 0xe07bff;
/** Peak emissiveIntensity of the rim-flash (#e07bff luminance ≈ 0.4 → ~0.6). */
export const REVEAL_INTENSITY = 1.5;

export class StormRenderer {
  readonly group = new THREE.Group();
  /** Violet flash light — add to the scene next to the bolts group. */
  readonly flashLight = new THREE.AmbientLight(FLASH_COLOR, 0);
  private readonly slots: BoltSlot[] = [];
  private flashAt = Number.NEGATIVE_INFINITY;
  private readonly fogBase = new THREE.Color(DUSK.sky);
  private readonly cloudFogColor = new THREE.Color(IN_CLOUD_FOG_COLOR);
  private readonly dustFogColor = new THREE.Color(DUST_FOG_COLOR);
  private readonly flashColor = new THREE.Color(FLASH_COLOR);
  private readonly scratch = new THREE.Color();

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
      const core = new THREE.Mesh(createBoltGeometry(), coreMat);
      const glow = new THREE.Mesh(createBoltGeometry(), glowMat);
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
        lifeMs: BOLT_LIFE_MS,
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
        // R2: a bolt over a mast or penthouse strikes its top.
        return roofTopAt(b, x - b.x, z - b.z);
      }
    }
    return 0;
  }

  /** A scheduled strike: bolt from the deck to the rooftop/ground + flash. */
  strike(strike: Strike, nowMs: number): void {
    this.fire(strike, this.topYAt(strike.x, strike.z), nowMs, BOLT_LIFE_MS);
  }

  /** A kill bolt (DeathMsg cause "storm"): straight down onto the victim,
   * lingering through the kill-cam beat. */
  boltAt(pos: Vec3, nowMs: number): void {
    this.fire(
      { timeMs: Math.floor(nowMs), x: pos.x, z: pos.z },
      pos.y,
      nowMs,
      KILL_BOLT_LIFE_MS,
    );
  }

  private fire(
    strike: Strike,
    topY: number,
    nowMs: number,
    lifeMs: number,
  ): void {
    const slot = this.slots.reduce((a, b) => (a.bornAt <= b.bornAt ? a : b));
    const main = boltPolyline(strike, topY);
    const runs = [main, ...boltBranches(strike, main)];
    writeBoltTube(slot.core.geometry, runs, BOLT_CORE_RADIUS, 1);
    writeBoltTube(slot.glow.geometry, runs, BOLT_GLOW_RADIUS, 0.55);
    slot.anchor = { x: strike.x, y: 0, z: strike.z };
    slot.bornAt = nowMs;
    slot.lifeMs = lifeMs;
    slot.group.visible = true;
    this.flashAt = nowMs;
  }

  /** Age bolts and re-place them at the image nearest the viewer. */
  update(viewer: Vec3, nowMs: number): void {
    for (const slot of this.slots) {
      const age = nowMs - slot.bornAt;
      if (age > slot.lifeMs) {
        slot.group.visible = false;
        continue;
      }
      const p = nearestImage(viewer, slot.anchor);
      slot.group.position.set(p.x, p.y, p.z);
      // Hold hot for 40% of the life, then the Neon Vein afterglow fade —
      // with a deterministic arc flicker so the channel feels alive.
      const k = age / slot.lifeMs;
      const hold = k < 0.4 ? 1 : 1 - (k - 0.4) / 0.6;
      const flicker = 0.8 + 0.2 * Math.sin(age * 0.11);
      slot.coreMat.opacity = hold * flicker;
      slot.glowMat.opacity = BOLT_GLOW_OPACITY * hold * flicker;
    }
  }

  /** L12 sky cycle: the clear-sky fog colour atmosphere() builds on (the
   * in-cloud soup and the flash stain still layer over it). Call before
   * atmosphere() each frame; defaults to the VO1 night colour. */
  setFogBase(color: THREE.Color): void {
    this.fogBase.copy(color);
  }

  /** Current flash envelope 0..1 (soft 140 ms decay). */
  private flashLevel(nowMs: number): number {
    const age = nowMs - this.flashAt;
    if (age < 0 || age >= FLASH_MS) return 0;
    return 1 - age / FLASH_MS;
  }

  /**
   * The single writer of storm atmosphere, called once per frame: the sky
   * flash (violet ambient pulse + fog stain) and the in-cloud fog override
   * when the CAMERA climbs into the deck — dense grey-violet soup, restored
   * smoothly below. Returns the SkyDome tint and whether the dome should
   * render at all (inside cloud the fog IS the sky). Tracers and all other
   * emissives are unlit materials, so the ambient pulse cannot wash them
   * out, and the stained fog peaks far below the 0.72 bloom threshold.
   *
   * L4: `wx` is the shared weather — rain haze, darker air and a flash that
   * reads brightest in a downpour all route through here, so this stays the
   * single writer of fog state (the strike schedule itself never changes:
   * strikes are server-authoritative kills).
   */
  atmosphere(
    scene: THREE.Scene,
    cameraY: number,
    nowMs: number,
    wx: SkyWeather = DRY_SKY,
    dust = 0,
  ): { tint: THREE.Color; domeVisible: boolean } {
    const f = this.flashLevel(nowMs) * wx.flash;
    // 0 below the deck → 1 fully inside; a 30 m ramp kills boundary flicker.
    const inK = Math.min(1, Math.max(0, (cameraY - CLOUD_BASE) / 30));
    this.flashLight.intensity = f * FLASH_PEAK * (1 + inK * 0.6);
    HAZE_WEATHER.x = RAIN_HAZE_EXTRA * wx.haze + DUST_HAZE_EXTRA * dust;
    const dim = 1 - RAIN_DARKEN * wx.haze;
    if (scene.fog instanceof THREE.Fog) {
      const near = FOG_NEAR + (RAIN_FOG_NEAR - FOG_NEAR) * wx.haze;
      const clearNear = near + (IN_CLOUD_FOG_NEAR - near) * inK;
      const clearFar = FOG_DISTANCE + (IN_CLOUD_FOG_FAR - FOG_DISTANCE) * inK;
      // D3 dust only ever closes the fog in (never past the in-cloud soup).
      scene.fog.near = Math.min(
        clearNear,
        clearNear + (DUST_FOG_NEAR - clearNear) * dust,
      );
      scene.fog.far = Math.min(
        clearFar,
        clearFar + (DUST_FOG_FAR - clearFar) * dust,
      );
      scene.fog.color
        .copy(this.fogBase)
        .multiplyScalar(dim)
        .lerp(this.cloudFogColor, inK * 0.85)
        .lerp(this.flashColor, f * FLASH_TINT * (1 + inK))
        .lerp(this.dustFogColor, dust * 0.8);
      if (scene.background instanceof THREE.Color) {
        scene.background.copy(scene.fog.color);
      }
    }
    // Dome stain: multiplicative tint pulled toward violet and brightened.
    this.scratch
      .setRGB(dim, dim, dim)
      .lerp(this.flashColor, f * FLASH_TINT)
      .multiplyScalar(1 + f * 1.6);
    return { tint: this.scratch, domeVisible: inK < 0.5 };
  }
}

// --- Cloud deck --------------------------------------------------------------

/** Drifting puff billboards in the deck band above CLOUD_BASE. */
const PUFF_COUNT = 160;
const PUFF_BAND_MIN = CLOUD_BASE + 5;
const PUFF_BAND_MAX = CLOUD_BASE + 75;
const PUFF_SCALE_MIN = 160;
const PUFF_SCALE_MAX = 340;
/** Deck drift, m/s along +x (Neon Vein: visible slow march). */
const PUFF_DRIFT_MPS = 1.4;
/** Purple-stained puff tint over the dusk sky (Neon Vein deck dye). */
const PUFF_COLOR = 0x4a3c6e;
const PUFF_OPACITY = 0.38;
/** The ceiling sheet: the deck's darker-from-below altitude read. */
const CEILING_Y = CLOUD_BASE - 3;
const CEILING_COLOR = 0x0a0b16;
const CEILING_OPACITY = 0.55;

/** Soft multi-blob puff texture (procedural, no assets — the game's idiom). */
function puffTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    for (let i = 0; i < 5; i++) {
      const x = 40 + Math.random() * 48;
      const y = 44 + Math.random() * 40;
      const r = 26 + Math.random() * 22;
      const grad = ctx.createRadialGradient(x, y, 2, x, y, r);
      grad.addColorStop(0, "rgba(255,255,255,0.85)");
      grad.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, 128, 128);
    }
  }
  return new THREE.CanvasTexture(canvas);
}

/**
 * The storm's cloud layer: one instanced draw call of camera-facing puff
 * billboards drifting on the SYNCED clock (every client sees the identical
 * cloudscape, traffic-style), plus a translucent ceiling sheet under the
 * band that makes altitude read from below. Everything is placed at its
 * torus image nearest the viewer, so the deck wraps with the world.
 */
export class CloudDeck {
  readonly group = new THREE.Group();
  private readonly puffs: THREE.InstancedMesh;
  private readonly ceiling: THREE.Mesh;
  private readonly layout: { x: number; y: number; z: number; s: number }[];
  private readonly mat = new THREE.Matrix4();
  private readonly pos = new THREE.Vector3();
  private readonly scale = new THREE.Vector3();
  /** Per-puff scratch for the wrap placement — no allocation per frame (O3). */
  private readonly canonical: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly image: Vec3 = { x: 0, y: 0, z: 0 };

  constructor(seed: number) {
    const rand = mulberry32((seed ^ 0x5f3759df) >>> 0);
    this.layout = Array.from({ length: PUFF_COUNT }, () => ({
      x: rand() * WORLD_SIZE,
      y: PUFF_BAND_MIN + rand() * (PUFF_BAND_MAX - PUFF_BAND_MIN),
      z: rand() * WORLD_SIZE,
      s: PUFF_SCALE_MIN + rand() * (PUFF_SCALE_MAX - PUFF_SCALE_MIN),
    }));
    const material = new THREE.MeshBasicMaterial({
      map: puffTexture(),
      color: PUFF_COLOR,
      transparent: true,
      opacity: PUFF_OPACITY,
      depthWrite: false,
    });
    this.puffs = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(1, 1),
      material,
      PUFF_COUNT,
    );
    this.puffs.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.puffs.frustumCulled = false;
    this.puffs.renderOrder = RENDER_ORDER.cloudPuffs;
    // The dark underside: one camera-following sheet just below the band.
    this.ceiling = new THREE.Mesh(
      new THREE.PlaneGeometry(2 * FOG_DISTANCE + 200, 2 * FOG_DISTANCE + 200),
      new THREE.MeshBasicMaterial({
        color: CEILING_COLOR,
        transparent: true,
        opacity: CEILING_OPACITY,
        depthWrite: false,
        side: THREE.DoubleSide,
        // One pass, not three's back-then-front pair for a transparent
        // double-sided material (O3): that pair flags the material
        // needsUpdate twice a frame — two program re-checks and an extra
        // draw — and on a flat sheet it draws the same pixels one pass does.
        forceSinglePass: true,
      }),
    );
    this.ceiling.rotation.x = Math.PI / 2;
    this.group.add(this.puffs, this.ceiling);
  }

  /** Billboard + drift + wrap-place every puff. Call once per frame. */
  update(
    viewer: Vec3,
    cameraQuat: THREE.Quaternion,
    serverTimeMs: number | null,
  ): void {
    const driftX = ((serverTimeMs ?? 0) / 1000) * PUFF_DRIFT_MPS;
    for (let i = 0; i < this.layout.length; i++) {
      const p = this.layout[i] as (typeof this.layout)[number];
      const canonical = this.canonical;
      canonical.x = (p.x + driftX) % WORLD_SIZE;
      canonical.y = p.y;
      canonical.z = p.z;
      const image = nearestImageInto(this.image, viewer, canonical);
      this.pos.set(image.x, image.y, image.z);
      this.scale.set(p.s, p.s * 0.45, 1);
      this.mat.compose(this.pos, cameraQuat, this.scale);
      this.puffs.setMatrixAt(i, this.mat);
    }
    this.puffs.instanceMatrix.needsUpdate = true;
    this.ceiling.position.set(viewer.x, CEILING_Y, viewer.z);
    // In front of the puffs from below, behind them from above (O1).
    this.ceiling.renderOrder =
      viewer.y < CEILING_Y
        ? RENDER_ORDER.cloudCeilingBelow
        : RENDER_ORDER.cloudCeilingAbove;
  }
}

/** Sides of each bolt segment's open tube. */
const BOLT_SIDES = 5;
/**
 * One segment's tube in unit space: exactly the vertices and triangles
 * `CylinderGeometry(1, 1, 1, BOLT_SIDES, 1, true)` builds (two rings of
 * BOLT_SIDES + 1, the seam duplicated, top ring at +0.5).
 */
const TUBE_VERTS: readonly number[] = (() => {
  const out: number[] = [];
  for (const y of [0.5, -0.5]) {
    for (let x = 0; x <= BOLT_SIDES; x++) {
      const theta = (x / BOLT_SIDES) * Math.PI * 2;
      out.push(Math.sin(theta), y, Math.cos(theta));
    }
  }
  return out;
})();
const TUBE_INDEX: readonly number[] = (() => {
  const out: number[] = [];
  const row = BOLT_SIDES + 1;
  for (let x = 0; x < BOLT_SIDES; x++) {
    const a = x;
    const b = row + x;
    const c = row + x + 1;
    const d = x + 1;
    out.push(a, b, d, b, c, d);
  }
  return out;
})();
const TUBE_VERT_COUNT = TUBE_VERTS.length / 3;

/** Most segments one bolt can have: the main channel and every branch are
 * BOLT_ITERATIONS rounds of midpoint displacement. */
const BOLT_MAX_SEGMENTS = (1 + BOLT_BRANCH_COUNT) * 2 ** BOLT_ITERATIONS;

/**
 * A bolt slot's geometry, allocated ONCE at its full capacity (O4). It used
 * to be rebuilt per strike, so every strike created fresh GL buffers on the
 * very frame its flash lands — a first-sight upload the pre-warm could
 * never absorb (the perf harness's GL probe caught 4 buffer allocations in
 * every window with a strike in it). The index is the same for every bolt
 * (segment n's tube is TUBE_INDEX offset by n's vertices), so it uploads
 * once; a strike rewrites the position prefix and the draw range.
 */
function createBoltGeometry(): THREE.BufferGeometry {
  const index = new Uint32Array(BOLT_MAX_SEGMENTS * TUBE_INDEX.length);
  for (let n = 0; n < BOLT_MAX_SEGMENTS; n++) {
    for (let k = 0; k < TUBE_INDEX.length; k++) {
      index[n * TUBE_INDEX.length + k] =
        n * TUBE_VERT_COUNT + (TUBE_INDEX[k] as number);
    }
  }
  const geometry = new THREE.BufferGeometry();
  const position = new THREE.BufferAttribute(
    new Float32Array(BOLT_MAX_SEGMENTS * TUBE_VERT_COUNT * 3),
    3,
  );
  position.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute("position", position);
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  geometry.setDrawRange(0, 0);
  return geometry;
}

const tubeUp = new THREE.Vector3(0, 1, 0);
const tubeDir = new THREE.Vector3();
const tubeQuat = new THREE.Quaternion();
const tubeMat = new THREE.Matrix4();
const tubePos = new THREE.Vector3();
const tubeScale = new THREE.Vector3();
const tubeV = new THREE.Vector3();

/**
 * One tube (an open cylinder per segment) over a set of polylines, written
 * straight into a bolt slot's position buffer (createBoltGeometry). It used
 * to clone a CylinderGeometry per segment and merge the clones, ~2 MB of
 * garbage a strike and a frame-time spike on exactly the frame the flash
 * lands (O3 profile). The bolt material is unlit, so positions are all it
 * reads.
 */
function writeBoltTube(
  geometry: THREE.BufferGeometry,
  runs: readonly (readonly Vec3[])[],
  radius: number,
  branchScale: number,
): void {
  const attr = geometry.getAttribute("position") as THREE.BufferAttribute;
  const positions = attr.array as Float32Array;
  let n = 0; // segments written
  runs.forEach((run, runIdx) => {
    const r = radius * (runIdx === 0 ? 1 : branchScale);
    for (let i = 1; i < run.length && n < BOLT_MAX_SEGMENTS; i++) {
      const a = run[i - 1] as Vec3;
      const b = run[i] as Vec3;
      tubeDir.set(b.x - a.x, b.y - a.y, b.z - a.z);
      const len = tubeDir.length();
      if (len < 0.01) continue;
      tubeQuat.setFromUnitVectors(tubeUp, tubeDir.normalize());
      tubePos.set((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
      tubeScale.set(r, len * 1.06, r);
      tubeMat.compose(tubePos, tubeQuat, tubeScale);
      const base = n * TUBE_VERT_COUNT;
      for (let k = 0; k < TUBE_VERT_COUNT; k++) {
        tubeV
          .set(
            TUBE_VERTS[k * 3] as number,
            TUBE_VERTS[k * 3 + 1] as number,
            TUBE_VERTS[k * 3 + 2] as number,
          )
          .applyMatrix4(tubeMat);
        positions[(base + k) * 3] = tubeV.x;
        positions[(base + k) * 3 + 1] = tubeV.y;
        positions[(base + k) * 3 + 2] = tubeV.z;
      }
      n++;
    }
  });
  geometry.setDrawRange(0, n * TUBE_INDEX.length);
  uploadPrefix([attr], n * TUBE_VERT_COUNT);
}
