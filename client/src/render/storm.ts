// ST2 client storm: the pure storm-clock seam. Everything here is a pure
// function of (strikes from the shared schedule, snapshot poses, the synced
// clock) — no THREE, no WebAudio, no DOM. The renderer/audio/UI adapters
// consume these outputs, so the torus math and timing are testable without a
// GPU, exactly like the traffic and freelook seams.

import {
  type Building,
  mulberry32,
  standingTopAt,
} from "@angels-bandits/common/city";
import {
  roofTopAt,
  structureCovers,
} from "@angels-bandits/common/city/roof-structures";
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
import { CITY_GLOW, HAZE_PARAMS, HAZE_WEATHER } from "./fog";
import { RENDER_ORDER } from "./render-order";
import { DUSK, FOG_NEAR } from "./sky";
import { STORM_FLASH_COLOR } from "./sky-clouds";
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
/** A1: pings() with no reveals — shared, never mutated by its readers. */
const NO_PINGS: { id: string; pos: Vec3; level: number }[] = [];

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
    // A1: the minimap asks every frame; almost always there is nothing.
    if (this.reveals.length === 0) return NO_PINGS;
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
  return turbulenceOffsetInto({ x: 0, y: 0, z: 0 }, tMs, altitude);
}

/** turbulenceOffset written into `out` (P4: remotes.update runs it per
 * plane per frame — no object built). The same values. */
export function turbulenceOffsetInto(
  out: Vec3,
  tMs: number,
  altitude: number,
): Vec3 {
  if (altitude <= CLOUD_BASE) {
    out.x = 0;
    out.y = 0;
    out.z = 0;
    return out;
  }
  const ramp = Math.min(
    1,
    (altitude - CLOUD_BASE) / (STORM_KILL_ALT - CLOUD_BASE),
  );
  const a = (SHAKE_MAX / 2) * ramp; // two sines per axis → peak = 2a
  const t = (tMs / 1000) * SHAKE_FREQ;
  out.x = (Math.sin(t * 13) + Math.sin(t * 7.3 + 1.7)) * a;
  out.y = (Math.sin(t * 11 + 0.9) + Math.sin(t * 17)) * a * 0.8;
  out.z = (Math.sin(t * 15 + 2.4) + Math.sin(t * 6.1)) * a;
  return out;
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
const BOLT_GLOW_COLOR = 0x8ea8ff; // L1: cold blue-white halo (was violet)
const BOLT_GLOW_OPACITY = 0.42;
const BOLT_CORE_RADIUS = 0.8;
const BOLT_GLOW_RADIUS = 4.6;
/** Sky flash: cold ambient pulse + fog/dome stain, ≤ 150 ms by contract. L1
 * moved it from violet to the cold blue-white of a real storm flash. */
const FLASH_MS = 140;
const FLASH_COLOR = STORM_FLASH_COLOR;
/** Peak added ambient intensity. VO1's blue-hour fill (ambient 0.75 +
 * hemisphere 1.35) is ~7x the old night's, so the flash doubled to stay a
 * visible pulse: ~3x the base fill at peak, facades still far sub-bloom. */
const FLASH_PEAK = 2.6;
/** Peak fog/sky-dome stain toward FLASH_COLOR (0..1 lerp). */
const FLASH_TINT = 0.24;
/** Simultaneously-alive bolts: schedule cadence is 8–15 s, life 280 ms, so
 * 3 slots only ever fill when kill bolts pile onto a scheduled strike. */
const BOLT_SLOTS = 3;
/** In-cloud fog band (camera above CLOUD_BASE): dense storm-grey soup. */
const IN_CLOUD_FOG_NEAR = 12;
const IN_CLOUD_FOG_FAR = 190;
const IN_CLOUD_FOG_COLOR = 0x2c3340;

/** L4 weather → atmosphere. A downpour pulls the fog's near edge in (fog FAR
 * never moves: it is the torus occlusion guarantee), thickens the height haze
 * by up to RAIN_HAZE_EXTRA, and darkens fog + dome TOGETHER by up to
 * RAIN_DARKEN (darken-only, so the horizon seam stays invisible). */
const RAIN_FOG_NEAR = 70;
const RAIN_HAZE_EXTRA = 0.6;
/** D3: inside a collapse's dust cloud (render/dust.ts dustHaze, 0..1) the
 * haze thickens by up to this and the fog closes to DUST_FOG_NEAR/FAR, m —
 * a sight-blocking brown-out that is the same on every quality tier.
 * D11: at most DUST_HAZE_MAX of it, with the fog no closer than 20 / 280 m
 * and the dust colour mixed in at most DUST_COLOR_MIX — thick, but never
 * a frame flattened to one grey. */
const DUST_HAZE_EXTRA = 6;
const DUST_FOG_NEAR = 20;
const DUST_FOG_FAR = 280;
export const DUST_HAZE_MAX = 0.6;
const DUST_COLOR_MIX = 0.45;
/** Concrete dust: the fog colour the brown-out pulls toward (sRGB). */
const DUST_FOG_COLOR = 0x4a443e;
const RAIN_DARKEN = 0.15;
/** L1: how far a full downpour flattens the clear fog curve (fog.ts
 * FOG_SHAPE, `abWeather.y`): the rain closes the mid-range in a little;
 * the cloud deck and dust flatten it all the way. */
const RAIN_FOG_FLATTEN = 0.4;

/**
 * L1: what atmosphere() did to the clear-sky colour, as ONE affine map —
 * fog = fogBase · scale + add — folding the rain dim, the in-cloud soup,
 * the flash stain and the D3 dust in their exact order. The dome puts its
 * gradient through the same map, so at SKY_FOG_STOP (gradient == fogBase)
 * the sky equals the fog at every moment. `gain` is the flash's extra
 * brightening above the stop (the dome ramps it in from zero there).
 */
export interface SkyAir {
  scale: number;
  add: THREE.Color;
  gain: number;
  /** This frame's fog colour (scene.fog.color), for the band below the stop. */
  fog: THREE.Color;
  domeVisible: boolean;
  /** L7b: the burn's lerp — the LAST step of the map — its weight and
   * colour, so the dome can thin it out high above the stop (where the
   * map need not match the fog) and keep the storm sky overhead. */
  burn: number;
  burnTint: THREE.Color;
}
/** L7 inferno: at burn level 1 the fog (and, through the SkyAir map, the
 * sky behind it) is pulled this far toward a smoky ember-brown (L7b: the
 * distance glowing through the smoke, the black columns standing out
 * against it — still dark: the haze measures ≈ sRGB 0.3 with L2's horizon
 * glow on top, under fire-cover's 0.45), and the height haze toward smoke —
 * the same on every tier (rule 2), and darken-leaning, so nothing in the
 * air nears the bloom threshold. */
// L9: 0.42 of 0x6a2a12 over the steel-blue night fog left blue above green
// in the mix — the burning city's haze read magenta (49 % of the hue mass
// at 330–360° against reference 2's 3 %); a darker umber with more green
// in it reads ember orange-red at about the same (dark) level.
const BURN_FOG_MIX = 0.4;
const BURN_FOG_COLOR = 0x5a3c0e;
const BURN_HAZE_MIX = 0.55;
const BURN_HAZE_RGB = [0.14, 0.06, 0.035] as const;

/** L2 city glow (fog.ts CITY_GLOW): the light pollution's colour (sRGB)
 * and its peak linear luminance at the horizon on a clear night (L9: see
 * the value), so the horizon glows warm, far under bloom.
 * The burning city pulls it toward ember red and up by BURN_GLOW_GAIN. */
// R1: 0xf0c0a0 (was 0xffb26e) — a mixed sodium / LED city's sky glow, warm
// but far less orange: the saturated amber read as a "red gold orange
// glowing city" behind the far skyline. Same peak (L9's), so the haze keeps
// its energy over the lit city.
export const CITY_GLOW_COLOR = 0xf0c0a0;
// L9: 0.04 (was 0.017) — reference 1's haze glows amber over the whole lit
// city (palette.mjs: the calm views' hue mass was ~80 % blue); ~1.6× the
// fog colour's own luminance, still ~1/18 of the bloom threshold.
export const CITY_GLOW_PEAK = 0.04;
const BURN_GLOW_COLOR = 0xff5520;
// L9: 0.2 (was 1.4 over a 0.017 peak) — with the clear-night peak at
// 0.04 the burning city's glow stays where L7b tuned it (≈ 0.04–0.05).
const BURN_GLOW_GAIN = 0.2;

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
  private readonly burnFogColor = new THREE.Color(BURN_FOG_COLOR);
  private readonly flashColor = new THREE.Color(FLASH_COLOR);
  /** L2: the clear-night city glow and its burning shade, at unit
   * luminance (linear). */
  private readonly glowColor = unitLuma(new THREE.Color(CITY_GLOW_COLOR));
  private readonly burnGlowColor = unitLuma(new THREE.Color(BURN_GLOW_COLOR));
  private readonly air: SkyAir = {
    scale: 1,
    add: new THREE.Color(0, 0, 0),
    gain: 1,
    fog: new THREE.Color(DUSK.sky),
    burn: 0,
    burnTint: new THREE.Color(BURN_FOG_COLOR),
    domeVisible: true,
  };
  /** Where the latest bolt came down (canonical), for the dome's in-cloud
   * lightning (L1). */
  private readonly flashAnchor: Vec3 = { x: 0, y: 0, z: 0 };

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
        if (!b.damage) return roofTopAt(b, x - b.x, z - b.z);
        // D8: a broken tower is struck where it still stands (its stump,
        // the street of a felled lot) — never at the old roof's height.
        let top = standingTopAt(b, x - b.x, z - b.z);
        for (const s of b.roof ?? []) {
          if (structureCovers(s, x - b.x, z - b.z, 0)) {
            top = Math.max(top, s.baseY + s.height);
          }
        }
        return top;
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
    this.flashAnchor.x = strike.x;
    this.flashAnchor.z = strike.z;
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

  /** One step of the air's colour chain: x → lerp(x, t, w), i.e.
   * x·(1 − w) + t·w, folded into the affine scale/add. */
  private lerpAir(t: THREE.Color, w: number): void {
    const air = this.air;
    air.scale *= 1 - w;
    air.add.multiplyScalar(1 - w);
    air.add.r += t.r * w;
    air.add.g += t.g * w;
    air.add.b += t.b * w;
  }

  /** L1: the latest bolt's ground point (canonical) — the dome lights the
   * clouds above it during the flash. */
  get lastStrike(): Readonly<Vec3> {
    return this.flashAnchor;
  }

  /** Current flash envelope 0..1 (soft 140 ms decay). */
  flashLevel(nowMs: number): number {
    const age = nowMs - this.flashAt;
    if (age < 0 || age >= FLASH_MS) return 0;
    return 1 - age / FLASH_MS;
  }

  /**
   * The single writer of storm atmosphere, called once per frame: the sky
   * flash (violet ambient pulse + fog stain) and the in-cloud fog override
   * when the CAMERA climbs into the deck — dense grey-violet soup, restored
   * smoothly below. Returns the sky's air (SkyAir: the colour chain the
   * dome repeats, the flash gain, this frame's fog colour) and whether the
   * dome should render at all (inside cloud the fog IS the sky). Tracers and all other
   * emissives are unlit materials, so the ambient pulse cannot wash them
   * out, and the stained fog peaks far below the 0.72 bloom threshold.
   *
   * L4: `wx` is the shared weather — rain haze, darker air and a flash that
   * reads brightest in a downpour all route through here, so this stays the
   * single writer of fog state (the strike schedule itself never changes:
   * strikes are server-authoritative kills).
   *
   * L2: also the city glow in the air (fog.ts CITY_GLOW) — `cityLight` is
   * the sky cycle's street-light level (dusk dims it); none inside the deck
   * or a dust cloud, dimmed with the rain, hotter and redder with `burn`.
   */
  atmosphere(
    scene: THREE.Scene,
    cameraY: number,
    nowMs: number,
    wx: SkyWeather = DRY_SKY,
    dustIn = 0,
    burn = 0,
    cityLight = 1,
  ): SkyAir {
    const f = this.flashLevel(nowMs) * wx.flash;
    const dust = Math.min(DUST_HAZE_MAX, Math.max(0, dustIn));
    // 0 below the deck → 1 fully inside; a 30 m ramp kills boundary flicker.
    const inK = Math.min(1, Math.max(0, (cameraY - CLOUD_BASE) / 30));
    this.flashLight.intensity = f * FLASH_PEAK * (1 + inK * 0.6);
    HAZE_WEATHER.x = RAIN_HAZE_EXTRA * wx.haze + DUST_HAZE_EXTRA * dust;
    // L1: the clear curve flattens back to the plain smoothstep in the
    // sight-blocking soups (fog.ts FOG_SHAPE).
    HAZE_WEATHER.y = Math.min(
      1,
      Math.max(inK, dust, RAIN_FOG_FLATTEN * wx.haze),
    );
    // L7: the city's smoke in the haze (the sky cycle rewrote it this frame).
    if (burn > 0) {
      const k = burn * BURN_HAZE_MIX;
      for (let i = 0; i < 3; i++) {
        HAZE_PARAMS[i] =
          (HAZE_PARAMS[i] as number) +
          ((BURN_HAZE_RGB[i] as number) - (HAZE_PARAMS[i] as number)) * k;
      }
    }
    const dim = 1 - RAIN_DARKEN * wx.haze;
    const glowK =
      CITY_GLOW_PEAK *
      cityLight *
      dim *
      (1 - inK) *
      (1 - Math.min(1, dust)) *
      (1 + BURN_GLOW_GAIN * burn);
    for (let i = 0; i < 3; i++) {
      const c = i === 0 ? "r" : i === 1 ? "g" : "b";
      CITY_GLOW[i] =
        glowK *
        (this.glowColor[c] +
          (this.burnGlowColor[c] - this.glowColor[c]) * burn);
    }
    CITY_GLOW[3] = burn;
    // The colour chain as an affine map x → x·scale + add (see SkyAir):
    // each lerp(t, w) is x·(1 − w) + t·w.
    const air = this.air;
    air.scale = dim;
    air.add.setRGB(0, 0, 0);
    this.lerpAir(this.cloudFogColor, inK * 0.85);
    this.lerpAir(this.flashColor, f * FLASH_TINT * (1 + inK));
    this.lerpAir(this.dustFogColor, dust * DUST_COLOR_MIX);
    // L7: the burning city's smoke, last — the dome takes it through the
    // same map, so the horizon stays seamless.
    this.lerpAir(this.burnFogColor, burn * BURN_FOG_MIX);
    air.burn = burn * BURN_FOG_MIX;
    const scale = air.scale;
    air.gain = 1 + f * 1.6;
    air.domeVisible = inK < 0.5;
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
      scene.fog.color.copy(this.fogBase).multiplyScalar(scale).add(air.add);
      if (scene.background instanceof THREE.Color) {
        scene.background.copy(scene.fog.color);
      }
      air.fog.copy(scene.fog.color);
    } else {
      air.fog.copy(this.fogBase).multiplyScalar(scale).add(air.add);
    }
    return air;
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
/** Storm-grey puff tint (L1: was a Neon Vein purple dye). */
const PUFF_COLOR = 0x2a3242;
const PUFF_OPACITY = 0.38;
/** The ceiling sheet: the deck's darker-from-below altitude read. */
const CEILING_Y = CLOUD_BASE - 3;
/** H1: the deck's materials fog as if it were this much lower — the deck
 * rose 150 m over the supertalls (CLOUD_BASE 500 → 650), and the radial fog
 * would otherwise swallow it from the street (~71 % overhead, was 25 %).
 * Capped so the deck is still fully fogged where the camera's far plane
 * (FOG_DISTANCE + 100) cuts it: from the street that is 622 m out, at a
 * lowered distance of √(622² + 500²) ≈ 798 m (fog.ts AB_FOG_LIFT). K1: the
 * deck came down under 500 m (CLOUD_BASE 440), so it reads from the street
 * by itself and is never lifted (a negative lift would fog it MORE). */
export const DECK_FOG_LIFT = Math.max(0, Math.min(CLOUD_BASE - 500, 150));
const DECK_FOG_DEFINES = { AB_FOG_LIFT: DECK_FOG_LIFT.toFixed(1) };
const CEILING_COLOR = 0x07090f;
const CEILING_OPACITY = 0.55;
/** L7b: the sheet thins from CEILING_NEAR to CEILING_FAR m from the viewer. */
const CEILING_NEAR = 220;
const CEILING_FAR = 620;

/** L7: glow spots the deck takes, its glow colour (linear) and mix. */
const DECK_GLOW_MAX = 8;
const DECK_GLOW_RGB = "vec3(1.0, 0.28, 0.05)";
const DECK_GLOW_MIX = 1.0;
/** The puffs over a fire, pulled toward ember-orange (linear). */
const PUFF_GLOW = new THREE.Color(0.95, 0.32, 0.1);

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
  /** L7: glow spots on the deck's underside (render x, z, strength, radius). */
  private readonly glowU = {
    value: Array.from({ length: DECK_GLOW_MAX }, () => new THREE.Vector4()),
  };
  private readonly glowCountU = { value: 0 };
  private readonly puffBase = new THREE.Color(PUFF_COLOR);
  private readonly puffTint = new THREE.Color();
  private glowSpots: Float32Array = new Float32Array(0);
  private glowCount = 0;

  constructor(seed: number) {
    const rand = mulberry32((seed ^ 0x5f3759df) >>> 0);
    this.layout = Array.from({ length: PUFF_COUNT }, () => ({
      x: rand() * WORLD_SIZE,
      y: PUFF_BAND_MIN + rand() * (PUFF_BAND_MAX - PUFF_BAND_MIN),
      z: rand() * WORLD_SIZE,
      s: PUFF_SCALE_MIN + rand() * (PUFF_SCALE_MAX - PUFF_SCALE_MIN),
    }));
    // L7: white material × a per-puff colour (PUFF_COLOR at rest), so the
    // puffs over a burning block can take the fire's glow without a draw.
    const material = new THREE.MeshBasicMaterial({
      map: puffTexture(),
      color: 0xffffff,
      transparent: true,
      opacity: PUFF_OPACITY,
      depthWrite: false,
    });
    material.defines = { ...DECK_FOG_DEFINES };
    this.puffs = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(1, 1),
      material,
      PUFF_COUNT,
    );
    this.puffs.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < PUFF_COUNT; i++)
      this.puffs.setColorAt(i, this.puffBase);
    (this.puffs.instanceColor as THREE.InstancedBufferAttribute).setUsage(
      THREE.DynamicDrawUsage,
    );
    this.puffs.frustumCulled = false;
    this.puffs.renderOrder = RENDER_ORDER.cloudPuffs;
    // The dark underside: one camera-following sheet just below the band.
    const ceilingMat = new THREE.MeshBasicMaterial({
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
    });
    ceilingMat.defines = { ...DECK_FOG_DEFINES };
    // L7: the underside glows ember-red over the burning blocks (a uniform
    // array of spots, by reference — no recompile as fires come and go).
    ceilingMat.onBeforeCompile = (shader) => {
      shader.uniforms.uDeckGlow = this.glowU;
      shader.uniforms.uDeckGlowCount = this.glowCountU;
      shader.vertexShader = shader.vertexShader
        .replace(
          "#include <common>",
          "#include <common>\nvarying vec2 vDeckXZ;\nvarying float vDeckR;",
        )
        .replace(
          "#include <begin_vertex>",
          "#include <begin_vertex>\nvDeckXZ = (modelMatrix * vec4(transformed, 1.0)).xz;\nvDeckR = length(position.xy);",
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <common>",
          `#include <common>
varying vec2 vDeckXZ;
varying float vDeckR;
uniform vec4 uDeckGlow[${DECK_GLOW_MAX}];
uniform int uDeckGlowCount;`,
        )
        .replace(
          "#include <color_fragment>",
          `#include <color_fragment>
float deckGlow = 0.0;
for (int i = 0; i < ${DECK_GLOW_MAX}; i++) {
  if (i >= uDeckGlowCount) break;
  vec4 g = uDeckGlow[i];
  float k = 1.0 - smoothstep(0.0, g.w, distance(vDeckXZ, g.xy));
  deckGlow += g.z * k * k;
}
deckGlow = min(deckGlow, 1.0);
// L7b: the sheet is the altitude cue OVERHEAD; seen edge-on far out it
// would lay a flat fogged lid over the whole storm sky, so it thins with
// distance from the viewer (the glow over the fires a good deal less).
float deckNear = 1.0 - smoothstep(${CEILING_NEAR.toFixed(1)}, ${CEILING_FAR.toFixed(1)}, vDeckR);
diffuseColor.rgb = mix(diffuseColor.rgb, ${DECK_GLOW_RGB}, deckGlow * ${DECK_GLOW_MIX.toFixed(2)});
diffuseColor.a = max(diffuseColor.a * mix(0.15, 1.0, deckNear), deckGlow * mix(0.45, 0.8, deckNear));`,
        );
    };
    ceilingMat.customProgramCacheKey = () => "ab-cloud-ceiling-l7b-glow";
    this.ceiling = new THREE.Mesh(
      new THREE.PlaneGeometry(2 * FOG_DISTANCE + 200, 2 * FOG_DISTANCE + 200),
      ceilingMat,
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
    this.tintPuffs();
    this.ceiling.position.set(viewer.x, CEILING_Y, viewer.z);
    // In front of the puffs from below, behind them from above (O1).
    this.ceiling.renderOrder =
      viewer.y < CEILING_Y
        ? RENDER_ORDER.cloudCeilingBelow
        : RENDER_ORDER.cloudCeilingAbove;
  }

  /**
   * L7: the fires under the deck (render/inferno.ts cloudGlow: render-space
   * x, z, strength, radius per spot) and the room's burn. The underside
   * glows over them and the puffs above take the colour; at burn 0 it is
   * exactly the old deck. Tier-independent, like the deck itself.
   */
  setGlow(spots: Float32Array, count: number, burn: number): void {
    this.glowSpots = spots;
    // Each spot's strength already carries the burn; burn 0 is no glow.
    this.glowCount = burn > 0 ? Math.min(count, DECK_GLOW_MAX) : 0;
    const u = this.glowU.value;
    for (let i = 0; i < this.glowCount; i++) {
      (u[i] as THREE.Vector4).set(
        spots[i * 4] as number,
        spots[i * 4 + 1] as number,
        spots[i * 4 + 2] as number,
        spots[i * 4 + 3] as number,
      );
    }
    this.glowCountU.value = this.glowCount;
  }

  /** Each puff's colour: PUFF_COLOR, pulled toward the fire's glow by the
   * spots under it (one pass over the puffs; nothing allocated). */
  private tintPuffs(): void {
    const n = this.glowCount;
    const attr = this.puffs.instanceColor as THREE.InstancedBufferAttribute;
    if (n === 0 && !this.puffsTinted) return;
    const arr = attr.array as Float32Array;
    let any = false;
    for (let i = 0; i < PUFF_COUNT; i++) {
      // The puff's render position is its matrix translation.
      const e = this.puffs.instanceMatrix.array as Float32Array;
      const px = e[i * 16 + 12] as number;
      const pz = e[i * 16 + 14] as number;
      let k = 0;
      for (let s = 0; s < n; s++) {
        const o = s * 4;
        const dx = px - (this.glowSpots[o] as number);
        const dz = pz - (this.glowSpots[o + 1] as number);
        const r = (this.glowSpots[o + 3] as number) * 1.3;
        const d = Math.sqrt(dx * dx + dz * dz);
        if (d >= r) continue;
        const f = 1 - d / r;
        k += (this.glowSpots[o + 2] as number) * f * f;
      }
      k = Math.min(1, k);
      if (k > 0) any = true;
      this.puffTint.copy(this.puffBase).lerp(PUFF_GLOW, k);
      arr[i * 3] = this.puffTint.r;
      arr[i * 3 + 1] = this.puffTint.g;
      arr[i * 3 + 2] = this.puffTint.b;
    }
    attr.needsUpdate = true;
    this.puffsTinted = any;
  }

  private puffsTinted = false;
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

/** `c` scaled to unit linear luminance (in place). */
function unitLuma(c: THREE.Color): THREE.Color {
  return c.multiplyScalar(1 / (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b));
}
