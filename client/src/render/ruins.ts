// D8 ruins smoulder. Once a building section has come down, its lot keeps
// smoking for RUIN_SMOKE_MS — a thin column off the stump and a couple off
// the rubble, with embers glowing in them for the first RUIN_EMBER_MS — so
// a felled lot reads as a fresh ruin long after D3's dust has settled.
//
// Cosmetic (smoke never hurts a plane), through the D1 particle pool's
// wreck-fire emitter: no new draw. Emitters are pure in the collapse (its
// id, rest bounds and building), so every client smokes the same lot from
// the same spots; only the RUINS_DRAWN nearest within RUIN_DRAW_M emit, and
// the rate scales with the tier's chaosFx share (fires.ts's idiom).

import { type Building, standingTopAt } from "@angels-bandits/common/city";
import {
  type Collapse,
  KIND_BUILDING,
} from "@angels-bandits/common/city/collapse";
import {
  type Vec3,
  wrapCoord,
  wrapDeltaAxis,
} from "@angels-bandits/common/world";
import type { Impacts } from "./impacts";

/** How long a ruin smoulders after its last piece lands, ms. */
export const RUIN_SMOKE_MS = 90_000;
/** Embers glow in the smoke this long, ms. */
const RUIN_EMBER_MS = 30_000;
/** Ruins further than this do not smoke, m; at most this many at once. */
const RUIN_DRAW_M = 700;
const RUINS_DRAWN = 4;
/** Smoke puffs per second per ruin when fresh (fading to a wisp). */
const SMOKE_RATE = 6;
/** Emitters per ruin: the stump, then two spots on the rubble. */
const EMITTERS = 3;
/** Puffs scatter this far round an emitter, m. */
const SPREAD = 3;

interface Near {
  c: Collapse;
  d: number;
}

/** Small integer hash → [0, 1) (seeded by the collapse id, never a pose). */
function hash01(a: number, b: number): number {
  let h = Math.imul(a + 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 17, 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x27d4eb2f);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

export class RuinSmoke {
  private share = 1;
  private lastMs = Number.NaN;
  /** Fractional puffs owed per collapse id. */
  private readonly acc = new Map<number, number>();
  private readonly near: Near[] = [];
  private readonly at: Vec3 = { x: 0, y: 0, z: 0 };

  constructor(
    private readonly impacts: Impacts,
    private readonly buildings: readonly Building[],
  ) {}

  /** Quality row (chaosFx): share of the smoke. */
  setQuality(share: number): void {
    this.share = Math.max(0, Math.min(1, share));
  }

  /** Per frame: the nearest fresh ruins smoke. `renderMs` is the clock
   * debris poses on; `now` the wall clock the particle pool ages on. */
  update(
    collapses: readonly Collapse[],
    viewer: Vec3,
    renderMs: number | null,
    now: number,
  ): void {
    const dt = Number.isFinite(this.lastMs)
      ? Math.min(0.1, Math.max(0, (now - this.lastMs) / 1000))
      : 0;
    this.lastMs = now;
    if (renderMs === null || this.share <= 0 || collapses.length === 0) {
      if (this.acc.size > 0) this.acc.clear();
      return;
    }
    let count = 0;
    for (const c of collapses) {
      if (c.kind !== KIND_BUILDING) continue;
      const age = renderMs - (c.t0 + c.endMs);
      if (age < 0 || age >= RUIN_SMOKE_MS) {
        this.acc.delete(c.id);
        continue;
      }
      const r = c.restBounds;
      const dx = wrapDeltaAxis(viewer.x, c.x + (r.x0 + r.x1) / 2);
      const dz = wrapDeltaAxis(viewer.z, c.z + (r.z0 + r.z1) / 2);
      const d = Math.hypot(dx, dz);
      if (d > RUIN_DRAW_M) continue;
      const slot = this.near[count] ?? { c, d };
      slot.c = c;
      slot.d = d;
      this.near[count++] = slot;
    }
    // Partial selection of the nearest RUINS_DRAWN.
    for (let i = 0; i < Math.min(count, RUINS_DRAWN); i++) {
      let best = i;
      for (let j = i + 1; j < count; j++) {
        if ((this.near[j] as Near).d < (this.near[best] as Near).d) best = j;
      }
      const t = this.near[i] as Near;
      this.near[i] = this.near[best] as Near;
      this.near[best] = t;
    }
    for (let i = 0; i < Math.min(count, RUINS_DRAWN); i++) {
      const c = (this.near[i] as Near).c;
      const age = renderMs - (c.t0 + c.endMs);
      const fade = 1 - age / RUIN_SMOKE_MS;
      let owed =
        (this.acc.get(c.id) ?? hash01(c.id, 99)) +
        SMOKE_RATE * this.share * fade * dt;
      while (owed >= 1) {
        owed -= 1;
        const k = Math.floor(hash01(c.id, Math.floor(now / 97)) * EMITTERS);
        if (!this.emitter(c, k)) continue;
        const ember = age < RUIN_EMBER_MS && hash01(c.id, now) < 0.35 ? 1 : 0;
        this.impacts.wreckFire(this.at, ember, 1, SPREAD, now);
      }
      this.acc.set(c.id, owed);
    }
  }

  /** Emitter `k` of ruin `c` into `this.at`: 0 the stump's standing top
   * over the building centre (skipped when nothing stands there), else a
   * fixed spot on top of the rubble. */
  private emitter(c: Collapse, k: number): boolean {
    const r = c.restBounds;
    if (k === 0) {
      const b = this.buildings[c.building];
      if (!b) return false;
      const top = standingTopAt(b, 0, 0);
      if (top <= 0) return false;
      this.at.x = wrapCoord(c.x);
      this.at.y = top;
      this.at.z = wrapCoord(c.z);
      return true;
    }
    const u = hash01(c.id, k * 2);
    const v = hash01(c.id, k * 2 + 1);
    this.at.x = wrapCoord(c.x + r.x0 + (r.x1 - r.x0) * u);
    this.at.y = r.y1;
    this.at.z = wrapCoord(c.z + r.z0 + (r.z1 - r.z0) * v);
    return true;
  }
}
