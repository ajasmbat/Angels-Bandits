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

import {
  type Building,
  CITY_GRID,
  type LocalBox,
} from "@angels-bandits/common/city";
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
  pickShimmerVentsInto,
} from "./atmo-post";
import { FogBanks } from "./fogbanks";
import type { Heat } from "./fx";
import { Litter } from "./litter";
import type { FinalPass, ShaftsPass } from "./post";
import { shimmerClock } from "./post";
import { QUALITY_PROFILES, type QualityTier } from "./quality";
import type { NearPass } from "./reactions";
import { roofDetailsFor } from "./roof-details";
import { type StandingLayer, StandingMask } from "./standing-watch";
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
  /** J1: live blasts' heat (render/fx.ts heatSources) — the first
   * `heatCount` of `heat` shimmer ahead of the roof vents. */
  heat?: readonly Heat[];
  heatCount?: number;
}

/** J1: a blast's heat column — from a little under the blast to well over
 * it, wide — per unit of blast size, m. The ripple's amplitude and period
 * are the vents' own (the shader is shared and untouched). */
const BLAST_SHIMMER_BELOW = 8;
const BLAST_SHIMMER_HEIGHT = 36;
const BLAST_SHIMMER_HALF_WIDTH = 10;
/** A blast column shimmers at full strength to here, gone by the range, m:
 * wider than a vent's reach, the column is wider too. */
const BLAST_SHIMMER_FULL = 260;
const BLAST_SHIMMER_RANGE = 560;

/** A metre coordinate into [0, WORLD_SIZE) (module level: no closure a pick). */
const wrap = (c: number): number =>
  ((c % WORLD_SIZE) + WORLD_SIZE) % WORLD_SIZE;

/**
 * D8: the shimmer's anchors, per building — a small box under each exhaust
 * stack top (roofDetailsFor's vents, in vent order), building-local. A
 * stack on a roof that fell shimmers no more.
 */
export function atmosphereFxStandingLayer(
  buildings: readonly Building[],
): StandingLayer {
  const cache = new Map<number, readonly LocalBox[]>();
  return {
    boxes(index: number): readonly LocalBox[] {
      let boxes = cache.get(index);
      if (!boxes) {
        const b = buildings[index] as Building;
        boxes = roofDetailsFor(b).vents.map((v) => {
          const x = wrapDeltaAxis(b.x, v.x);
          const z = wrapDeltaAxis(b.z, v.z);
          return {
            x0: x - 0.3,
            x1: x + 0.3,
            y0: v.y - 1,
            y1: v.y,
            z0: z - 0.3,
            z1: z + 0.3,
          };
        });
        cache.set(index, boxes);
      }
      return boxes;
    },
  };
}

/** Shimmer slots, wanted first, then strongest (no closure a frame). */
const bySlotRank = (a: ShimmerSlot, b: ShimmerSlot): number =>
  Number(b.on) - Number(a.on) || b.level - a.level;

export class AtmosphereFx {
  readonly fogBanks: FogBanks;
  readonly litter: Litter;
  private readonly wind: Wind = { x: 1, z: 0, strength: 0 };
  private readonly buildings: readonly Building[];
  private readonly buildingsByBlock: Map<number, Building[]>;
  private readonly ventsByBlock = new Map<number, ShimmerVent[]>();
  /** D8: each cached vent's building index and its index among that
   * building's vents (the standing mask's item), packed b·256 + k. */
  private readonly ventOwner = new Map<ShimmerVent, number>();
  private readonly indexOf = new Map<Building, number>();
  private readonly standing: StandingMask;
  private readonly candidates: ShimmerVent[] = [];
  /** The shimmer pick's id lists (scratch, reused each pick). */
  private readonly prevIds: number[] = [];
  private readonly wantedIds: number[] = [];
  private slots: ShimmerSlot[] = [];
  private pickTick = Number.NaN;
  private lastWorldMs: number | null = null;
  private shimmerOn = true;
  private glareOn = true;
  private shaftsStrength = 0;
  private readonly v = new THREE.Vector3();
  private readonly w = new THREE.Vector3();
  private readonly img: Vec3 = { x: 0, y: 0, z: 0 };
  /** J1: a blast column's foot (scratch). */
  private readonly heatAt: Vec3 = { x: 0, y: 0, z: 0 };
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
    buildings.forEach((b, i) => this.indexOf.set(b, i));
    this.standing = new StandingMask(
      buildings,
      atmosphereFxStandingLayer(buildings),
    );
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
    this.standing.update(); // D8: picks read it at 4 Hz
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
      // Fields written directly (S8): `set(mx, my, mz)` boxed its doubles.
      const p = this.v;
      p.x = mx * 1000 + cam.position.x;
      p.y = my * 1000 + cam.position.y;
      p.z = mz * 1000 + cam.position.z;
      p.project(cam);
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
        const owner = this.indexOf.get(b) ?? -1;
        for (let k = 0; k < stacks.length; k++) {
          const s = stacks[k] as { x: number; y: number; z: number };
          // Id from the canonical position (stable on every client; two
          // stacks never share a decimetre).
          const id = Math.round(s.x * 10) * 40_000 + Math.round(s.z * 10);
          const vent = { id, x: s.x, y: s.y, z: s.z };
          vents.push(vent);
          this.ventOwner.set(vent, owner * 256 + k);
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
      const bx = Math.floor(wrap(f.cameraPos.x) / BLOCK_PITCH);
      const bz = Math.floor(wrap(f.cameraPos.z) / BLOCK_PITCH);
      const grid = CITY_GRID;
      // P3: the 3×3 window refills in one pick; never the whole city.
      if (this.ventsByBlock.size > 36) {
        this.ventsByBlock.clear();
        this.ventOwner.clear();
      }
      for (let i = -1; i <= 1; i++) {
        for (let j = -1; j <= 1; j++) {
          const cx = (((bx + i) % grid) + grid) % grid;
          const cz = (((bz + j) % grid) + grid) % grid;
          const vents = this.ventsFor(cx, cz);
          for (let q = 0; q < vents.length; q++) {
            const vent = vents[q] as ShimmerVent;
            // D8: not over a roof that is no longer there.
            const own = this.ventOwner.get(vent) ?? -1;
            if (own >= 0 && this.standing.isHidden(own >> 8, own & 255)) {
              continue;
            }
            this.candidates.push(vent);
          }
        }
      }
      // S8: allocation-free — scratch id lists and plain loops (the pick
      // used to build a filtered, mapped and sorted copy each tick).
      const prev = this.prevIds;
      prev.length = 0;
      for (let q = 0; q < this.slots.length; q++) {
        const s = this.slots[q] as ShimmerSlot;
        if (s.on) prev.push(s.vent.id);
      }
      const wanted = pickShimmerVentsInto(
        this.candidates,
        prev,
        this.ventDist,
        this.ventVisible,
        this.wantedIds,
      );
      for (let q = 0; q < this.slots.length; q++) {
        const s = this.slots[q] as ShimmerSlot;
        let on = false;
        for (let w = 0; w < wanted.length; w++) {
          if (wanted[w] === s.vent.id) on = true;
        }
        s.on = on;
      }
      for (let w = 0; w < wanted.length; w++) {
        const id = wanted[w] as number;
        let have = false;
        for (let q = 0; q < this.slots.length; q++) {
          if ((this.slots[q] as ShimmerSlot).vent.id === id) have = true;
        }
        if (have) continue;
        for (let q = 0; q < this.candidates.length; q++) {
          const vent = this.candidates[q] as ShimmerVent;
          if (vent.id !== id) continue;
          this.slots.push({ vent, level: 0, on: true });
          break;
        }
      }
    }
    // Fades on the world clock; a column fully faded out frees its slot.
    for (let q = 0; q < this.slots.length; q++) {
      const s = this.slots[q] as ShimmerSlot;
      s.level = Math.min(
        1,
        Math.max(0, s.level + ((s.on ? 1 : -1) * dt) / SHIMMER_FADE_S),
      );
    }
    // In place (per frame: no new array).
    let kept = 0;
    for (let q = 0; q < this.slots.length; q++) {
      const s = this.slots[q] as ShimmerSlot;
      if (s.on || s.level > 0) this.slots[kept++] = s;
    }
    this.slots.length = kept;
    if (this.slots.length > SHIMMER_SLOTS) {
      this.slots.sort(bySlotRank);
      this.slots.length = SHIMMER_SLOTS;
    }
    const a = u.uShimA?.value as THREE.Vector4[];
    const b = u.uShimB?.value as THREE.Vector4[];
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2);
    let n = 0;
    // J1: blasts first — they pre-empt vents; vents fill what is left.
    const heat = f.heat;
    const heatCount = heat ? Math.min(f.heatCount ?? 0, heat.length) : 0;
    for (let q = 0; q < heatCount && n < SHIMMER_SLOTS; q++) {
      const h = (heat as readonly Heat[])[q] as Heat;
      const d = Math.hypot(
        wrapDeltaAxis(this.eye.x, h.x),
        h.y - this.eye.y,
        wrapDeltaAxis(this.eye.z, h.z),
      );
      const level =
        h.level * (1 - smooth(BLAST_SHIMMER_FULL, BLAST_SHIMMER_RANGE, d));
      if (level <= 0.001 || d < 4) continue;
      this.heatAt.x = h.x;
      this.heatAt.y = h.y - BLAST_SHIMMER_BELOW * h.size;
      this.heatAt.z = h.z;
      if (
        this.projectColumn(
          cam,
          this.heatAt,
          BLAST_SHIMMER_HEIGHT * h.size,
          BLAST_SHIMMER_HALF_WIDTH * h.size,
          d,
          tanHalf,
          level,
          a[n] as THREE.Vector4,
          b[n] as THREE.Vector4,
        )
      ) {
        n++;
      }
    }
    for (let q = 0; q < this.slots.length && n < SHIMMER_SLOTS; q++) {
      const s = this.slots[q] as ShimmerSlot;
      // ventDist, inline: a double returned from the arrow was boxed.
      const d = Math.hypot(
        wrapDeltaAxis(this.eye.x, s.vent.x),
        s.vent.y - this.eye.y,
        wrapDeltaAxis(this.eye.z, s.vent.z),
      );
      const level =
        s.level * (1 - smooth(SHIMMER_FULL, SHIMMER_RANGE * 1.1, d));
      if (level <= 0.001 || d < 4) continue;
      if (
        this.projectColumn(
          cam,
          s.vent,
          SHIMMER_HEIGHT,
          SHIMMER_HALF_WIDTH,
          d,
          tanHalf,
          level,
          a[n] as THREE.Vector4,
          b[n] as THREE.Vector4,
        )
      ) {
        n++;
      }
    }
    (u.uShimCount as THREE.IUniform).value = n;
    (u.uShimTime as THREE.IUniform).value = shimmerClock(world / 1000);
    (u.uAspect as THREE.IUniform).value = cam.aspect;
  }

  /**
   * Project one shimmer column — `height` up from canonical `foot`,
   * `halfWidth` wide, `d` m from the eye — into a FinalPass slot. False
   * when it is behind the camera or well off screen (slot untouched).
   */
  private projectColumn(
    cam: THREE.PerspectiveCamera,
    foot: Vec3,
    height: number,
    halfWidth: number,
    d: number,
    tanHalf: number,
    level: number,
    slotA: THREE.Vector4,
    slotB: THREE.Vector4,
  ): boolean {
    const base = nearestImageInto(this.img, cam.position, foot);
    // Fields written directly (S8): `set(...)` takes its doubles as
    // arguments, and V8 boxed every one — ~1.3 KB a frame over six slots.
    const v = this.v;
    const w = this.w;
    v.x = base.x;
    v.y = base.y;
    v.z = base.z;
    v.project(cam);
    w.x = base.x;
    w.y = base.y + height;
    w.z = base.z;
    w.project(cam);
    if (v.z > 1 || w.z > 1) return false; // behind the camera
    if (Math.abs(v.x) > 1.3 || Math.abs(v.y) > 1.3) return false;
    slotA.x = (v.x * 0.5 + 0.5) * cam.aspect;
    slotA.y = v.y * 0.5 + 0.5;
    slotA.z = (w.x * 0.5 + 0.5) * cam.aspect;
    slotA.w = w.y * 0.5 + 0.5;
    slotB.x = halfWidth / (2 * d * tanHalf);
    slotB.y = level;
    slotB.z = 0;
    slotB.w = 0;
    return true;
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
