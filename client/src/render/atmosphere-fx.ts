// S5 "atmosphere you can feel" — the per-frame driver, so main.ts only
// constructs it, hands it the frame and forwards the quality tier:
//   - fog banks drifting between the towers (fogbanks.ts, one draw),
//   - wind litter in the canyons, kicked up by low passes (litter.ts, one
//     draw),
//   - moon light shafts (post.ts ShaftsPass, one quarter-res draw, skipped
//     while the moon is out of view),
//   - heat shimmer over roof exhaust stacks and glare on the brightest
//     lights (FinalPass uniforms, no draw).
// The searchlight rays and the wet-roof reflections are shader-only and live
// with their owners (searchlights.ts, weather.ts).
//
// Every animated term runs on the latched WORLD clock (renderMs, which
// `__ab.pinWorld` pins) — the vent picks, the shimmer fades and the litter
// kick included — so a pinned world is a frozen atmosphere.

import { type Building, CITY_GRID } from "@angels-bandits/common/city";
import { losClear } from "@angels-bandits/common/collision";
import {
  BLOCK_PITCH,
  CLOUD_BASE,
  WORLD_SIZE,
} from "@angels-bandits/common/constants";
import { type Wind, windAt } from "@angels-bandits/common/wind";
import type { Vec3 } from "@angels-bandits/common/world";
import { wrapDeltaAxis } from "@angels-bandits/common/world";
import * as THREE from "three";
import {
  SHAFT_GAIN,
  SHIMMER_FADE_S,
  SHIMMER_HALF_WIDTH,
  SHIMMER_HEIGHT,
  SHIMMER_PICK_HZ,
  SHIMMER_RANGE,
  SHIMMER_SLOTS,
  type ShimmerVent,
  pickShimmerVents,
} from "./atmo-post";
import { FogBanks } from "./fogbanks";
import { Litter } from "./litter";
import type { FinalPass, ShaftsPass } from "./post";
import { shimmerClock } from "./post";
import { QUALITY_PROFILES, type QualityTier } from "./quality";
import type { NearPass } from "./reactions";
import { roofDetailsFor } from "./roof-details";
import { nearestImageInto } from "./wrapPlacement";

/** Cool moonlight the shafts are tinted (linear), times their gain. */
const SHAFT_TINT = new THREE.Vector3(0.78, 0.86, 1.0).multiplyScalar(
  SHAFT_GAIN,
);
/** Shimmer at full strength out to this distance, m (then fades to range). */
const SHIMMER_FULL = 70;

/** One shimmer column: its vent, fade level and whether it is wanted. */
interface ShimmerSlot {
  vent: ShimmerVent;
  level: number;
  on: boolean;
}

export interface AtmosphereFrame {
  camera: THREE.PerspectiveCamera;
  /** The chase camera's canonical position (what the streamers use). */
  cameraPos: Vec3;
  /** The latched world clock, ms (null before sync). */
  worldMs: number | null;
  /** performance.now() — only the litter's phase before sync. */
  now: number;
  /** Planes on screen (canonical), for the fog banks' clear zones. */
  planes: readonly Vec3[];
  /** L1's near passes (the litter kick). */
  passes: readonly NearPass[];
  /** The weather's haze, 0..1. */
  haze: number;
  /** The micro tier's altitude gate (litter). */
  microK: number;
  /** Unit vector toward the moon, and its visibility 0..1 (skycycle). */
  moonDir: readonly number[];
  moonVis: number;
}

export class AtmosphereFx {
  readonly fogBanks: FogBanks;
  readonly litter: Litter;
  private readonly wind: Wind = { x: 1, z: 0, strength: 0 };
  private readonly buildings: readonly Building[];
  private readonly buildingsByBlock: Map<number, Building[]>;
  private readonly ventsByBlock = new Map<number, ShimmerVent[]>();
  private readonly candidates: ShimmerVent[] = [];
  private slots: ShimmerSlot[] = [];
  private pickTick = Number.NaN;
  private lastWorldMs: number | null = null;
  private shimmerOn = true;
  private glareOn = true;
  private shaftsStrength = 0;
  private readonly v = new THREE.Vector3();
  private readonly w = new THREE.Vector3();
  private readonly img: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly eye: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly top: Vec3 = { x: 0, y: 0, z: 0 };

  constructor(
    seed: number,
    buildings: readonly Building[],
    buildingsByBlock: Map<number, Building[]>,
    private readonly finalPass: FinalPass | null,
    private readonly shafts: ShaftsPass | null,
  ) {
    this.buildings = buildings;
    this.buildingsByBlock = buildingsByBlock;
    this.fogBanks = new FogBanks(seed);
    this.litter = new Litter(seed);
  }

  /** The two scene objects (one draw each). */
  get objects(): THREE.Object3D[] {
    return [this.fogBanks.mesh, this.litter.points];
  }

  setQuality(tier: QualityTier): void {
    const p = QUALITY_PROFILES[tier];
    this.litter.setQuality(tier);
    if (this.shafts) this.shafts.tierOn = p.lightShafts;
    this.shimmerOn = p.heatShimmer;
    this.glareOn = p.glare;
    const u = this.finalPass?.uniforms;
    if (u?.uGlare) u.uGlare.value = p.glare ? 1 : 0;
    if (!p.heatShimmer) this.slots = [];
  }

  update(f: AtmosphereFrame): void {
    const t = f.worldMs ?? f.now;
    // Shafts and shimmer project through this frame's final camera pose.
    f.camera.updateMatrixWorld();
    windAt(t, this.wind);
    this.fogBanks.update(f.cameraPos, f.worldMs, f.planes, f.haze);
    this.litter.update(f.cameraPos, t, this.wind, f.passes, f.microK);
    this.updateShafts(f);
    this.updateShimmer(f);
    this.lastWorldMs = f.worldMs;
  }

  /** The moon's screen position and how strongly it throws shafts. */
  private updateShafts(f: AtmosphereFrame): void {
    if (!this.shafts) return;
    const cam = f.camera;
    // Indexed, not destructured: no iterator per frame.
    const mx = f.moonDir[0] ?? 0;
    const my = f.moonDir[1] ?? 0;
    const mz = f.moonDir[2] ?? 0;
    cam.getWorldDirection(this.w);
    const facing = this.w.x * mx + this.w.y * my + this.w.z * mz;
    let strength = 0;
    let u = 0.5;
    let v = 0.5;
    if (facing > 0.05 && f.moonVis > 0) {
      this.v
        .set(mx, my, mz)
        .multiplyScalar(1000)
        .add(cam.position)
        .project(cam);
      u = this.v.x * 0.5 + 0.5;
      v = this.v.y * 0.5 + 0.5;
      // Fade as the moon leaves the frame (its disc of shafts still reaches
      // in a little way), as it sets, and as the camera climbs into the deck.
      const out = Math.max(0, Math.max(-u, u - 1, -v, v - 1));
      const onScreen = 1 - smooth(0, 0.3, out);
      const risen = smooth(0.02, 0.14, my);
      const belowDeck =
        1 - smooth(CLOUD_BASE - 60, CLOUD_BASE - 5, cam.position.y);
      const haze = 0.8 + 0.2 * Math.min(1, Math.max(0, f.haze));
      strength =
        f.moonVis *
        onScreen *
        risen *
        belowDeck *
        haze *
        smooth(0.05, 0.3, facing);
    }
    this.shaftsStrength = strength;
    this.shafts.setSource(u, v, cam.aspect, strength);
    const tint = this.finalPass?.uniforms.uShaftTint?.value as
      | THREE.Vector3
      | undefined;
    tint?.copy(SHAFT_TINT);
  }

  /** The exhaust stacks of block (bx, bz), with stable ids. */
  private ventsFor(bx: number, bz: number): ShimmerVent[] {
    const key = bx * 1000 + bz;
    let vents = this.ventsByBlock.get(key);
    if (!vents) {
      vents = [];
      for (const b of this.buildingsByBlock.get(key) ?? []) {
        const stacks = roofDetailsFor(b).vents;
        for (const s of stacks) {
          // Id from the canonical position (stable on every client; two
          // stacks never share a decimetre).
          const id = Math.round(s.x * 10) * 40_000 + Math.round(s.z * 10);
          vents.push({ id, x: s.x, y: s.y, z: s.z });
        }
      }
      this.ventsByBlock.set(key, vents);
    }
    return vents;
  }

  private ventDist = (v: ShimmerVent): number => {
    const e = this.eye;
    return Math.hypot(
      wrapDeltaAxis(e.x, v.x),
      v.y - e.y,
      wrapDeltaAxis(e.z, v.z),
    );
  };

  private ventVisible = (v: ShimmerVent): boolean => {
    this.top.x = v.x;
    this.top.y = v.y + 1;
    this.top.z = v.z;
    return losClear(this.eye, this.top, this.buildings);
  };

  /** Pick (4 Hz), fade (world clock) and project the shimmer columns. */
  private updateShimmer(f: AtmosphereFrame): void {
    const u = this.finalPass?.uniforms;
    if (!u) return;
    const cam = f.camera;
    // The eye in canonical-equivalent coordinates (losClear wraps itself).
    this.eye.x = cam.position.x;
    this.eye.y = cam.position.y;
    this.eye.z = cam.position.z;
    const world = f.worldMs;
    if (!this.shimmerOn || world === null) {
      (u.uShimCount as THREE.IUniform).value = 0;
      return;
    }
    const dt =
      this.lastWorldMs === null
        ? 0
        : Math.min(0.25, Math.max(0, (world - this.lastWorldMs) / 1000));
    const tick = Math.floor((world / 1000) * SHIMMER_PICK_HZ);
    if (tick !== this.pickTick) {
      this.pickTick = tick;
      this.candidates.length = 0;
      const wrap = (c: number) => ((c % WORLD_SIZE) + WORLD_SIZE) % WORLD_SIZE;
      const bx = Math.floor(wrap(f.cameraPos.x) / BLOCK_PITCH);
      const bz = Math.floor(wrap(f.cameraPos.z) / BLOCK_PITCH);
      const grid = CITY_GRID;
      for (let i = -1; i <= 1; i++) {
        for (let j = -1; j <= 1; j++) {
          const cx = (((bx + i) % grid) + grid) % grid;
          const cz = (((bz + j) % grid) + grid) % grid;
          for (const v of this.ventsFor(cx, cz)) this.candidates.push(v);
        }
      }
      const wanted = pickShimmerVents(
        this.candidates,
        this.slots.filter((s) => s.on).map((s) => s.vent.id),
        this.ventDist,
        this.ventVisible,
      );
      for (const s of this.slots) s.on = wanted.includes(s.vent.id);
      for (const id of wanted) {
        if (this.slots.some((s) => s.vent.id === id)) continue;
        const vent = this.candidates.find((c) => c.id === id);
        if (vent) this.slots.push({ vent, level: 0, on: true });
      }
    }
    // Fades on the world clock; a column fully faded out frees its slot.
    for (const s of this.slots) {
      s.level = Math.min(
        1,
        Math.max(0, s.level + ((s.on ? 1 : -1) * dt) / SHIMMER_FADE_S),
      );
    }
    // In place (per frame: no new array).
    let kept = 0;
    for (const s of this.slots) if (s.on || s.level > 0) this.slots[kept++] = s;
    this.slots.length = kept;
    if (this.slots.length > SHIMMER_SLOTS) {
      this.slots.sort(
        (a, b) => Number(b.on) - Number(a.on) || b.level - a.level,
      );
      this.slots.length = SHIMMER_SLOTS;
    }
    const a = u.uShimA?.value as THREE.Vector4[];
    const b = u.uShimB?.value as THREE.Vector4[];
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2);
    let n = 0;
    for (const s of this.slots) {
      const d = this.ventDist(s.vent);
      const level =
        s.level * (1 - smooth(SHIMMER_FULL, SHIMMER_RANGE * 1.1, d));
      if (level <= 0.001 || d < 4) continue;
      const base = nearestImageInto(this.img, cam.position, s.vent);
      this.v.set(base.x, base.y, base.z).project(cam);
      this.w.set(base.x, base.y + SHIMMER_HEIGHT, base.z).project(cam);
      if (this.v.z > 1 || this.w.z > 1) continue; // behind the camera
      if (Math.abs(this.v.x) > 1.3 || Math.abs(this.v.y) > 1.3) continue;
      const slotA = a[n] as THREE.Vector4;
      const slotB = b[n] as THREE.Vector4;
      slotA.set(
        (this.v.x * 0.5 + 0.5) * cam.aspect,
        this.v.y * 0.5 + 0.5,
        (this.w.x * 0.5 + 0.5) * cam.aspect,
        this.w.y * 0.5 + 0.5,
      );
      slotB.set(SHIMMER_HALF_WIDTH / (2 * d * tanHalf), level, 0, 0);
      n++;
    }
    (u.uShimCount as THREE.IUniform).value = n;
    (u.uShimTime as THREE.IUniform).value = shimmerClock(world / 1000);
    (u.uAspect as THREE.IUniform).value = cam.aspect;
  }

  /** QA (`__ab.atmosphere()`). */
  debug(): {
    fogPuffs: number;
    litter: number;
    shimmerColumns: number;
    shafts: number;
    glare: boolean;
  } {
    return {
      fogPuffs: this.fogBanks.count,
      litter: this.litter.count,
      shimmerColumns:
        (this.finalPass?.uniforms.uShimCount?.value as number) ?? 0,
      shafts: this.shafts?.active ? this.shaftsStrength : 0,
      glare: this.glareOn,
    };
  }
}

function smooth(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
