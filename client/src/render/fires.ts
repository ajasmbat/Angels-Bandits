// C2 spreading fire, THREE half: the room's burning chunks (the socket's
// `fires`, kept from every welcome and `fires` batch) lick flames and smoke
// out of their facades through the D1 particle pool — no new draw. Each
// fire's emitter sits on its chunk's outer face (derived once per fire from
// the shared chunk grid, common/src/chaos.ts chunkCentreInto), and only the
// FIRES_DRAWN nearest within FIRE_DRAW_M emit. Fire never hurts a plane, so
// all of it is cosmetic and scales with the tier's `chaosFx` share; its
// damage arrives as `chunks` like any other.

import { chunkCentreInto } from "@angels-bandits/common/chaos";
import {
  type Building,
  chunkBuilding,
  chunkCell,
  chunkTier,
  tierGrids,
} from "@angels-bandits/common/city";
import {
  type Vec3,
  wrapCoord,
  wrapDeltaAxis,
  wrapDistance,
} from "@angels-bandits/common/world";
import type { Impacts } from "./impacts";

/** Fires further than this from the camera do not emit, m. */
export const FIRE_DRAW_M = 700;
/** At most this many fires emit in one frame (the nearest). */
export const FIRES_DRAWN = 24;
/** Flames and smoke puffs per fire per second at full share. */
const FIRE_RATE = 9;
const SMOKE_RATE = 3;
/** How far the flames scatter round the emitter, m. */
const SPREAD = 3;

interface Emitter {
  at: Vec3;
  acc: number;
}

export class FireRenderer {
  private readonly emitters = new Map<number, Emitter>();
  private share = 1;
  private lastMs = Number.NaN;
  private readonly near: { id: number; d: number }[] = [];

  constructor(
    private readonly impacts: Impacts,
    private readonly buildings: readonly Building[],
  ) {}

  /** Quality row (chaosFx): share of the flames and smoke. */
  setQuality(share: number): void {
    this.share = Math.max(0, Math.min(1, share));
  }

  /** Per frame: emit from the nearest burning chunks. */
  update(fires: ReadonlySet<number>, viewer: Vec3, now: number): void {
    const dt = Number.isFinite(this.lastMs)
      ? Math.min(0.1, Math.max(0, (now - this.lastMs) / 1000))
      : 0;
    this.lastMs = now;
    // Forget the fires that went out.
    for (const id of this.emitters.keys()) {
      if (!fires.has(id)) this.emitters.delete(id);
    }
    if (fires.size === 0 || this.share <= 0) return;
    // The near list reuses its entries frame to frame (no allocation once
    // it has grown to the room's FIRE_MAX).
    const near = this.near;
    let count = 0;
    for (const id of fires) {
      // D8: a chunk this client already holds broken or fallen burns no
      // more — the server's own cleanup reaches us a tick or more later,
      // and a fire licking out of air is a skeleton of its own.
      if (this.gone(id)) continue;
      const e = this.emitter(id);
      if (!e) continue;
      const d = wrapDistance(e.at, viewer);
      if (d > FIRE_DRAW_M) continue;
      const slot = near[count] ?? { id: 0, d: 0 };
      slot.id = id;
      slot.d = d;
      near[count++] = slot;
    }
    if (count > FIRES_DRAWN) {
      // Partial selection of the nearest FIRES_DRAWN (count ≤ FIRE_MAX).
      for (let i = 0; i < FIRES_DRAWN; i++) {
        let best = i;
        for (let j = i + 1; j < count; j++) {
          if ((near[j] as { d: number }).d < (near[best] as { d: number }).d) {
            best = j;
          }
        }
        const t = near[i] as { id: number; d: number };
        near[i] = near[best] as { id: number; d: number };
        near[best] = t;
      }
    }
    const n = Math.min(count, FIRES_DRAWN);
    for (let i = 0; i < n; i++) {
      const e = this.emitters.get((near[i] as { id: number }).id) as Emitter;
      e.acc += FIRE_RATE * this.share * dt;
      const fire = Math.floor(e.acc);
      if (fire <= 0) continue;
      e.acc -= fire;
      const smoke = Math.round((fire * SMOKE_RATE) / FIRE_RATE);
      this.impacts.wreckFire(e.at, fire, smoke, SPREAD, now);
    }
  }

  /** D8: is chunk `id` gone in this client's damage state? */
  private gone(id: number): boolean {
    const b = this.buildings[chunkBuilding(id)];
    return (b?.damage?.cells[chunkTier(id)]?.[chunkCell(id)] ?? 0) !== 0;
  }

  /** The emitter of chunk `id`: its outer face, once. */
  private emitter(id: number): Emitter | null {
    let e = this.emitters.get(id);
    if (e) return e;
    const at: Vec3 = { x: 0, y: 0, z: 0 };
    if (!chunkCentreInto(this.buildings, id, at)) return null;
    const b = this.buildings[chunkBuilding(id)] as Building;
    const g = tierGrids(b)[chunkTier(id)];
    if (!g) return null;
    // Out to the nearer of the tier's x and z faces, a hair outside.
    const dx = wrapDeltaAxis(b.x, at.x);
    const dz = wrapDeltaAxis(b.z, at.z);
    const hw = g.width / 2;
    const hd = g.depth / 2;
    if (Math.abs(dx) / hw >= Math.abs(dz) / hd) {
      at.x = wrapCoord(b.x + Math.sign(dx || 1) * (hw + 0.6));
    } else {
      at.z = wrapCoord(b.z + Math.sign(dz || 1) * (hd + 0.6));
    }
    e = { at, acc: 0 };
    this.emitters.set(id, e);
    return e;
  }
}
