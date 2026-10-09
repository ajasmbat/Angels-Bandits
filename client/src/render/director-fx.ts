// D5 destruction director, seen and felt: the warning before each event and
// the construction effects of the rebuild. Cosmetic only — what falls,
// what blows and what comes back is shared state (city/collapse.ts, the
// `chunks` batches, `rebuild`); nothing here collides.
//
// The warning is never a HUD line. A tower about to come down spills dust
// out of its windows (thickest on the side it will fall to), a crane
// sheds sparks at its mast foot and hub, a gas main vents steam up through
// the street — all swelling toward the instant it happens, with a low ground
// tremor nearby. main.ts adds the rumble, the groan and the siren (sound.ts
// directorWarning, ambience `alarm`).
//
// Every particle goes into the D1 impact pool (one Points draw): no new
// material, and the tier's budget (QualityProfile.directorFx) on top of the
// pool's own share. Emission is allocation-free per frame.

import {
  type Building,
  type TierGrid,
  chunkBox,
  chunkBuilding,
  tierGrids,
} from "@angels-bandits/common/city";
import { TOPPLE } from "@angels-bandits/common/city/collapse";
import type { CraneSite } from "@angels-bandits/common/city/movers";
import {
  type DirectorEvent,
  EVENT_COLLAPSE,
  EVENT_CRANE,
  EVENT_GAS,
  GAS_COLUMN_H,
  type RebuildWire,
} from "@angels-bandits/common/director";
import {
  type Vec3,
  canonicalize,
  wrapCoord,
  wrapDeltaAxis,
} from "@angels-bandits/common/world";
import { FacadeArchetype } from "./archetypes";
import type { Explosions } from "./fx";
import { DUST_RGB, type Impacts, Kind, SPARK_RGB } from "./impacts";

/** Particles per second at full share: window dust from a warned tower,
 * steam from a warned gas main, sparks from a warned crane, welding sparks
 * on a building about to be rebuilt. */
const SPILL_RATE = 70;
const STEAM_RATE = 45;
const CRANE_RATE = 30;
const WELD_RATE = 40;
/** The rebuild's pop: particles per restored chunk, and the cap. */
const POP_PER_CHUNK = 6;
const POP_MAX_CHUNKS = 40;
/** The alarm keeps wailing this long after the event, ms. */
export const ALARM_TAIL_MS = 15_000;
/** The warning tremor: felt within this, m, at most this amount (0..1). */
const TREMOR_RANGE = 350;
const TREMOR_PEAK = 0.35;
const STEAM_RGB = [0.58, 0.6, 0.63] as const;
const FIRE_RGB = [1.0, 0.52, 0.16] as const;
const SMOKE_RGB = [0.2, 0.18, 0.21] as const;
const DUST = DUST_RGB[FacadeArchetype.OFFICE];

/** The fraction (0..1) of event `e`'s warning gone by at `serverMs`. */
export function warnProgress(e: DirectorEvent, serverMs: number): number {
  const span = Math.max(1, e.at - e.w);
  return Math.max(0, Math.min(1, (serverMs - e.w) / span));
}

/** How hard the ground shakes at `pos` from warned events (0..1): rising
 * through each warning, fading with distance. */
export function warningTremor(
  events: Iterable<DirectorEvent>,
  pos: Vec3,
  serverMs: number,
): number {
  let amount = 0;
  for (const e of events) {
    if (e.k === EVENT_GAS || serverMs < e.w || serverMs > e.at) continue;
    const d = Math.hypot(
      wrapDeltaAxis(e.x, pos.x),
      pos.y * 0.5,
      wrapDeltaAxis(e.z, pos.z),
    );
    if (d >= TREMOR_RANGE) continue;
    const near = 1 - d / TREMOR_RANGE;
    amount = Math.max(amount, TREMOR_PEAK * warnProgress(e, serverMs) * near);
  }
  return amount;
}

/** Where the nearest alarm wails (a warned event, or one that happened in
 * the last ALARM_TAIL_MS), into `out`; null when none. */
export function alarmAt(
  events: Iterable<DirectorEvent>,
  pos: Vec3,
  serverMs: number,
  out: Vec3,
): Vec3 | null {
  let best = Number.POSITIVE_INFINITY;
  for (const e of events) {
    if (serverMs < e.w || serverMs > e.at + ALARM_TAIL_MS) continue;
    const d = Math.hypot(wrapDeltaAxis(e.x, pos.x), wrapDeltaAxis(e.z, pos.z));
    if (d >= best) continue;
    best = d;
    out.x = e.x;
    out.y = 15;
    out.z = e.z;
  }
  return best < Number.POSITIVE_INFINITY ? out : null;
}

/** Outward normals of the four faces, DIR_* order (−x, +x, −z, +z). */
const FACE_NX = [-1, 1, 0, 0] as const;
const FACE_NZ = [0, 0, -1, 1] as const;

export class DirectorFx {
  private share = 1;
  private readonly at: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly n: Vec3 = { x: 0, y: 0, z: 0 };
  /** Rebuilds announced (welding until `until`, local ms). */
  private readonly welding: { r: RebuildWire; until: number }[] = [];
  private readonly rand = Math.random;

  constructor(
    private readonly impacts: Impacts,
    private readonly explosions: Explosions,
    private readonly buildings: readonly Building[],
    private readonly cranes: readonly CraneSite[],
  ) {}

  private crane(id: number): CraneSite | null {
    for (const c of this.cranes) if (c.id === id) return c;
    return null;
  }

  /** Quality: the tier's share of the director's particles. */
  setShare(share: number): void {
    this.share = share;
  }

  /** `rate`/s over `dt` s at this tier, rounded at random. */
  private emitCount(rate: number, dt: number): number {
    return Math.floor(rate * this.share * dt + this.rand());
  }

  /**
   * One frame of warnings (every warned event between its warning and the
   * instant it happens) and of announced rebuilds. `dt` is the real frame
   * time, s; `now` the local clock the particles age on.
   */
  update(
    events: Iterable<DirectorEvent>,
    serverMs: number | null,
    now: number,
    dt: number,
  ): void {
    if (serverMs !== null) {
      for (const e of events) {
        if (serverMs < e.w || serverMs > e.at) continue;
        const swell = 0.3 + 0.7 * warnProgress(e, serverMs);
        if (e.k === EVENT_COLLAPSE) this.spill(e, swell, dt, now);
        else if (e.k === EVENT_GAS) this.steam(e, swell, dt, now);
        else if (e.k === EVENT_CRANE) this.creak(e, swell, dt, now);
      }
    }
    for (let i = this.welding.length - 1; i >= 0; i--) {
      const w = this.welding[i] as { r: RebuildWire; until: number };
      if (now > w.until) {
        this.welding.splice(i, 1);
        continue;
      }
      this.weld(w.r, dt, now);
    }
  }

  /** Dust pouring out of a warned tower's windows. */
  private spill(e: DirectorEvent, swell: number, dt: number, now: number) {
    const b = this.buildings[e.b];
    if (!b) return;
    const grids = tierGrids(b);
    const n = this.emitCount(SPILL_RATE * swell, dt);
    for (let i = 0; i < n; i++) {
      // Half of it on the side it will fall to.
      // (DIR_* are the face order: −x, +x, −z, +z.)
      const face =
        this.rand() < 0.5 && e.s === TOPPLE
          ? e.d & 3
          : Math.floor(this.rand() * 4);
      const y = 8 + this.rand() * (b.height - 8);
      let g: TierGrid | null = null;
      for (let k = 0; k < grids.length; k++) {
        const t = grids[k] as TierGrid;
        if (y >= t.baseY && y < t.baseY + t.height) g = t;
      }
      if (!g) continue;
      const nx = FACE_NX[face] as number;
      const nz = FACE_NZ[face] as number;
      const along = (this.rand() * 2 - 1) * 0.9;
      // D6: canonicalize's arithmetic straight into `at` (it built two
      // objects per particle).
      this.at.x = wrapCoord(
        b.x + (nx !== 0 ? nx * (g.width / 2 + 0.5) : (along * g.width) / 2),
      );
      this.at.y = y;
      this.at.z = wrapCoord(
        b.z + (nz !== 0 ? nz * (g.depth / 2 + 0.5) : (along * g.depth) / 2),
      );
      this.n.x = nx;
      this.n.y = -0.7;
      this.n.z = nz;
      this.impacts.spray(
        Kind.DUST,
        this.at,
        this.n,
        2.5,
        0.4,
        1,
        2600,
        5,
        DUST,
        now,
      );
    }
  }

  /** Steam venting up through the street over a warned gas main. */
  private steam(e: DirectorEvent, swell: number, dt: number, now: number) {
    const n = this.emitCount(STEAM_RATE * swell, dt);
    this.n.x = 0;
    this.n.y = 1;
    this.n.z = 0;
    for (let i = 0; i < n; i++) {
      this.at.x = e.x + (this.rand() * 2 - 1) * 2;
      this.at.y = 0.3;
      this.at.z = e.z + (this.rand() * 2 - 1) * 2;
      this.impacts.spray(
        Kind.SMOKE,
        this.at,
        this.n,
        5 + 6 * swell,
        0.25,
        1,
        2200,
        3.5,
        STEAM_RGB,
        now,
      );
    }
  }

  /** Sparks shearing off a warned crane's mast foot and hub. */
  private creak(e: DirectorEvent, swell: number, dt: number, now: number) {
    const site = this.crane(e.b);
    if (!site) return;
    const n = this.emitCount(CRANE_RATE * swell, dt);
    for (let i = 0; i < n; i++) {
      const hub = this.rand() < 0.5;
      this.at.x = site.x;
      this.at.y = hub ? site.hubY : 2;
      this.at.z = site.z;
      this.n.x = this.rand() * 2 - 1;
      this.n.y = hub ? 0.2 : 0.6;
      this.n.z = this.rand() * 2 - 1;
      this.impacts.spray(
        Kind.SPARK,
        this.at,
        this.n,
        9,
        0.5,
        1,
        600,
        0.8,
        SPARK_RGB,
        now,
      );
      if (!hub && this.rand() < 0.4) {
        this.impacts.spray(
          Kind.DUST,
          this.at,
          this.n,
          2,
          0.6,
          1,
          2000,
          4,
          DUST,
          now,
        );
      }
    }
  }

  /** A gas main blew at `site`: a fireball column, smoke and broken
   * street. The blast itself (and its damage) is the server's. */
  gasBlast(site: Vec3, now: number): void {
    for (const h of [2, GAS_COLUMN_H * 0.4, GAS_COLUMN_H * 0.8]) {
      this.at.x = site.x;
      this.at.y = h;
      this.at.z = site.z;
      this.explosions.explode(this.at, now);
    }
    this.at.x = site.x;
    this.at.y = 1;
    this.at.z = site.z;
    this.n.x = 0;
    this.n.y = 1;
    this.n.z = 0;
    const k = this.share;
    this.impacts.spray(
      Kind.FIRE,
      this.at,
      this.n,
      16,
      0.35,
      Math.round(60 * k),
      1400,
      3,
      FIRE_RGB,
      now,
    );
    this.impacts.spray(
      Kind.SMOKE,
      this.at,
      this.n,
      7,
      0.5,
      Math.round(30 * k),
      6000,
      7,
      SMOKE_RGB,
      now,
    );
    this.impacts.spray(
      Kind.CHIP,
      this.at,
      this.n,
      18,
      0.8,
      Math.round(40 * k),
      1800,
      0.9,
      DUST,
      now,
    );
  }

  /** A rebuild was announced: welders on the scaffolding until it lands. */
  rebuildAnnounced(r: RebuildWire, leadMs: number, now: number): void {
    this.welding.push({ r, until: now + Math.max(500, leadMs) });
  }

  /** Welding sparks on a building (or crane site) about to be rebuilt. */
  private weld(r: RebuildWire, dt: number, now: number): void {
    const n = this.emitCount(WELD_RATE, dt);
    for (let i = 0; i < n; i++) {
      if (r.k === 0) {
        const b = this.buildings[r.b];
        if (!b) return;
        const face = Math.floor(this.rand() * 4);
        const nx = FACE_NX[face] as number;
        const nz = FACE_NZ[face] as number;
        const g = tierGrids(b)[0];
        if (!g) return;
        const along = (this.rand() * 2 - 1) * 0.9;
        const p = canonicalize({
          x: b.x + (nx !== 0 ? nx * (g.width / 2 + 1) : (along * g.width) / 2),
          y: 0,
          z: b.z + (nz !== 0 ? nz * (g.depth / 2 + 1) : (along * g.depth) / 2),
        });
        this.at.x = p.x;
        this.at.y = 3 + this.rand() * Math.min(b.height, 60);
        this.at.z = p.z;
        this.n.x = nx;
        this.n.y = 0.3;
        this.n.z = nz;
      } else {
        const site = this.crane(r.b);
        if (!site) return;
        this.at.x = site.x;
        this.at.y = 1.5;
        this.at.z = site.z;
        this.n.x = this.rand() * 2 - 1;
        this.n.y = 0.8;
        this.n.z = this.rand() * 2 - 1;
      }
      this.impacts.spray(
        Kind.SPARK,
        this.at,
        this.n,
        7,
        0.6,
        1,
        500,
        0.7,
        SPARK_RGB,
        now,
      );
    }
  }

  /** A rebuild landed: a construction pop — a puff of dust and a shower of
   * sparks — at each restored chunk (the first POP_MAX_CHUNKS). */
  rebuildPop(restored: readonly number[], now: number): void {
    const count = Math.min(
      restored.length,
      Math.ceil(POP_MAX_CHUNKS * this.share),
    );
    for (let i = 0; i < count; i++) {
      const id = restored[i] as number;
      const box = chunkBox(this.buildings, id);
      const b = this.buildings[chunkBuilding(id)];
      if (!box || !b) continue;
      const p = canonicalize({
        x: b.x + (box.x0 + box.x1) / 2,
        y: 0,
        z: b.z + (box.z0 + box.z1) / 2,
      });
      this.at.x = p.x;
      this.at.y = (box.y0 + box.y1) / 2;
      this.at.z = p.z;
      this.n.x = 0;
      this.n.y = 0.4;
      this.n.z = 0;
      this.impacts.spray(
        Kind.DUST,
        this.at,
        this.n,
        3,
        1,
        POP_PER_CHUNK,
        1800,
        6,
        DUST,
        now,
      );
      this.impacts.spray(
        Kind.SPARK,
        this.at,
        this.n,
        10,
        1,
        POP_PER_CHUNK,
        500,
        0.8,
        SPARK_RGB,
        now,
      );
    }
  }
}
