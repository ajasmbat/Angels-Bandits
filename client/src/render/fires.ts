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
  /** Flames owed, carried frame to frame (a typed slot: storing a double
   * into a plain field boxes it every frame — P4's allocation table). */
  acc: Float64Array;
}

export class FireRenderer {
  private readonly emitters = new Map<number, Emitter>();
  private share = 1;
  private lastMs = Number.NaN;
  /** The fires within FIRE_DRAW_M this frame: ids and squared distances, grown
   * (rarely) past the room's FIRE_MAX, never per frame. */
  private nearId = new Float64Array(64);
  private nearD = new Float64Array(64);
  private count = 0;
  /** update()'s state for the pre-bound walks (no iterator per frame). */
  private fires: ReadonlySet<number> = new Set();
  private viewer: Vec3 = { x: 0, y: 0, z: 0 };

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
    this.fires = fires;
    this.emitters.forEach(this.forgetOut);
    if (fires.size === 0 || this.share <= 0) return;
    // The near list is two typed arrays (no allocation once they have grown
    // to the room's FIRE_MAX).
    this.viewer = viewer;
    this.count = 0;
    fires.forEach(this.collect);
    const count = this.count;
    const ids = this.nearId;
    const ds = this.nearD;
    if (count > FIRES_DRAWN) {
      // Partial selection of the nearest FIRES_DRAWN (count ≤ FIRE_MAX).
      for (let i = 0; i < FIRES_DRAWN; i++) {
        let best = i;
        for (let j = i + 1; j < count; j++) {
          if ((ds[j] as number) < (ds[best] as number)) best = j;
        }
        const tid = ids[i] as number;
        const td = ds[i] as number;
        ids[i] = ids[best] as number;
        ds[i] = ds[best] as number;
        ids[best] = tid;
        ds[best] = td;
      }
    }
    const n = Math.min(count, FIRES_DRAWN);
    for (let i = 0; i < n; i++) {
      const e = this.emitters.get(ids[i] as number) as Emitter;
      const acc = e.acc;
      acc[0] = (acc[0] as number) + FIRE_RATE * this.share * dt;
      const fire = Math.floor(acc[0] as number);
      if (fire <= 0) continue;
      acc[0] = (acc[0] as number) - fire;
      const smoke = Math.round((fire * SMOKE_RATE) / FIRE_RATE);
      this.impacts.wreckFire(e.at, fire, smoke, SPREAD, now);
    }
  }

  /** update()'s prune step (pre-bound). */
  private readonly forgetOut = (_e: Emitter, id: number): void => {
    if (!this.fires.has(id)) this.emitters.delete(id);
  };

  /** update()'s near-list step (pre-bound). */
  private readonly collect = (id: number): void => {
    // D8: a chunk this client already holds broken or fallen burns no
    // more — the server's own cleanup reaches us a tick or more later, and
    // a fire licking out of air is a skeleton of its own.
    if (this.gone(id)) return;
    const e = this.emitter(id);
    if (!e) return;
    // wrapDistance's components, compared squared: the same ordering and
    // cut without a double boxed per call (P4 allocation table).
    const v = this.viewer;
    const dx = wrapDeltaAxis(e.at.x, v.x);
    const dy = v.y - e.at.y;
    const dz = wrapDeltaAxis(e.at.z, v.z);
    const d = dx * dx + dy * dy + dz * dz;
    if (d > FIRE_DRAW_M * FIRE_DRAW_M) return;
    if (this.count >= this.nearId.length) {
      const grow = (a: Float64Array) => {
        const b = new Float64Array(a.length * 2);
        b.set(a);
        return b;
      };
      this.nearId = grow(this.nearId);
      this.nearD = grow(this.nearD);
    }
    this.nearId[this.count] = id;
    this.nearD[this.count] = d;
    this.count++;
  };

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
    e = { at, acc: new Float64Array(1) };
    this.emitters.set(id, e);
    return e;
  }
}
