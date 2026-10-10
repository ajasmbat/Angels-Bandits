// W3 rooftop AA nests, server side: one RoomAa per room. The nests fight
// on the pilots' side — every gun tracks the carrier's enemy planes (W1)
// and nothing else, fires bursts (light nests) or flak (heavy guns on the
// tallest towers), and every hit is rolled HERE (common/src/aa.ts is the
// arithmetic); clients only draw the bursts. index.ts wires the results to
// Combat (aaDamage — enemies only), the D4 wreck path and the wire.
//
// A nest is MANNED while its D9 prop (PROP_NEST) stands and its roof
// structure is still in its building's `b.roof` (a collapsed deck takes it
// with it, D8). It goes down like any roof prop — enemy rounds (strafing,
// or stray fire), any blast (bombs, missiles, meteors, wreck impacts, chain
// explosions) — becomes a ruin, and is re-manned when its building's D5
// rebuild restores the prop.
//
// Per nest and tick: the nearest live, unprotected enemy in range and in
// sight (losClear, re-checked at most every LOS_RECHECK_MS) is tracked —
// the gun slews toward the lead point at its rate caps, and fires once the
// aim is inside the cone and its reaction time has passed. A light burst's
// hit is rolled at the shot and lands after the rounds' flight — if the
// target is still alive and still in sight then. A heavy shell bursts at
// its fuse and hurts every enemy near the burst point. AA rounds never
// break the city.
//
// The enemies fight back: an enemy with a manned nest dead ahead inside
// its gun cone and in sight opens up on it (STRAFE_*), and an enemy the AA
// hits is sometimes PROVOKED (rising edge, per intensity) — for a while its
// patrol detours to the nest that hit it (RoomBots.setDetours).

import {
  type AaBurst,
  type AaNest,
  type GunAim,
  aaFlakDamage,
  aaGun,
  aaLevel,
  aaManned,
  aaSightFrom,
  aimError,
  aimOf,
  burstAim,
  burstHitChance,
  burstPoint,
  leadOf,
  slewGun,
} from "@angels-bandits/common/aa";
import { type Building, mulberry32 } from "@angels-bandits/common/city";
import type { PropState } from "@angels-bandits/common/city/props";
import { losClear } from "@angels-bandits/common/collision";
import type { Intensity } from "@angels-bandits/common/waves";
import {
  type Vec3,
  wrapDelta,
  wrapDistance,
} from "@angels-bandits/common/world";

/** A target's sight line is re-checked this often while it is held, ms. */
export const LOS_RECHECK_MS = 300;
/** Enemy strafing: a nest within this, m, and inside this cone off the
 * enemy's nose, rad, draws a round every STRAFE_INTERVAL_MS, hitting with
 * STRAFE_HIT and taking STRAFE_DAMAGE off the nest's prop. */
export const STRAFE_RANGE = 300;
export const STRAFE_CONE = 0.14;
export const STRAFE_INTERVAL_MS = 120;
export const STRAFE_HIT = 0.6;
export const STRAFE_DAMAGE = 7;
/** A provoked enemy detours to its nest this long, ms, then is left alone
 * this long before it can be provoked again; the detour point is this far
 * over the nest, m (the patrol never aims it at the deck). */
export const PROVOKE_MS = 15_000;
export const PROVOKE_COOLDOWN_MS = 20_000;
export const PROVOKE_LIFT = 60;

/** An enemy plane as the guns see it. */
export interface AaEnemy {
  id: string;
  pos: Vec3;
  vel: Vec3;
  /** Spawn-protected (fresh off the rig): no AA at it. */
  prot: boolean;
}

/** What the room's city looks like to the guns this tick. */
export interface AaWorld {
  buildings: readonly Building[];
  props: PropState;
  /** Fallen bridge spans (losClear's `gaps`). */
  gaps: number;
}

/** One hit the room settles: `damage` off enemy `target`, from nest `nest`
 * (its prop id) whose pivot is `from`. */
export interface AaHit {
  nest: number;
  target: string;
  damage: number;
  from: Vec3;
}

/** One enemy round at a nest: the room broadcasts `fired` for `enemy` and
 * (when it hits and the city is breakable) damages the nest's prop. */
export interface AaStrafe {
  enemy: string;
  nest: number;
  hit: boolean;
}

export interface AaTick {
  /** Bursts fired this tick (the `aa` broadcast). */
  bursts: AaBurst[];
  /** Hits landing this tick. */
  hits: AaHit[];
  /** Enemy rounds at nests this tick. */
  strafes: AaStrafe[];
}

interface Gun {
  nest: AaNest;
  aim: GunAim;
  targetId: string | null;
  /** When it took its target, and when it may next fire, ms. */
  since: number;
  nextFireAt: number;
  /** Its target's sight line: when last checked, and the verdict. */
  losAt: number;
  los: boolean;
}

/** A burst on its way: lands at `due`. A light one carries its rolled
 * damage (0: the roll missed — nothing to land); a heavy one its burst
 * point. */
interface Pending {
  due: number;
  nest: number;
  target: string;
  damage: number;
  heavy: boolean;
  to: Vec3;
}

interface Provoked {
  nest: number;
  until: number;
  /** Not provokable again before this, ms. */
  calmUntil: number;
}

export class RoomAa {
  private readonly rand: () => number;
  private readonly guns: Gun[];
  private pending: Pending[] = [];
  private readonly provoked = new Map<string, Provoked>();
  /** Each enemy's next strafe round, ms. */
  private readonly strafeAt = new Map<string, number>();
  private lastMs = Number.NaN;
  private readonly want: GunAim = { yaw: 0, pitch: 0 };
  private readonly sight: Vec3 = { x: 0, y: 0, z: 0 };
  /** Shots fired, hits landed, enemies the AA downed (the balance sim). */
  readonly stats = { bursts: 0, hits: 0, downs: 0, strafes: 0 };

  constructor(
    seed: number,
    readonly nests: readonly AaNest[],
  ) {
    this.rand = mulberry32((seed ^ 0xaa5e57) >>> 0);
    this.guns = nests.map((nest) => ({
      nest,
      aim: { yaw: nest.yaw0, pitch: 0.2 },
      targetId: null,
      since: 0,
      nextFireAt: 0,
      losAt: Number.NEGATIVE_INFINITY,
      los: false,
    }));
  }

  /** Is nest `n` manned (common/src/aa.ts aaManned)? */
  manned(n: AaNest, world: AaWorld): boolean {
    return aaManned(n, world.buildings, world.props);
  }

  /**
   * One tick. `enemies`: the carrier's planes in the air (the ONLY things
   * the guns may hit). Returns the bursts, the hits due and the strafes.
   */
  tick(
    now: number,
    enemies: readonly AaEnemy[],
    level: Intensity,
    world: AaWorld,
  ): AaTick {
    const dt = Number.isFinite(this.lastMs)
      ? Math.min(0.25, Math.max(0, (now - this.lastMs) / 1000))
      : 0;
    this.lastMs = now;
    const out: AaTick = { bursts: [], hits: [], strafes: [] };
    const tuning = aaLevel(level);
    const byId = new Map<string, AaEnemy>();
    for (const e of enemies) byId.set(e.id, e);

    // Land what is due first (it was fired at what was there then).
    this.land(now, byId, tuning, world, out);

    for (const g of this.guns) {
      if (!this.manned(g.nest, world)) {
        g.targetId = null;
        continue;
      }
      this.aimAndFire(g, now, dt, enemies, byId, level, world, out);
    }

    this.strafe(now, enemies, world, out);
    // Forget enemies that are gone.
    for (const id of [...this.strafeAt.keys()]) {
      if (!byId.has(id)) this.strafeAt.delete(id);
    }
    for (const [id, p] of [...this.provoked]) {
      if (!byId.has(id) && now >= p.until) this.provoked.delete(id);
    }
    return out;
  }

  /** Enemies this nest's fire provoked: where each detours now (the
   * patrol point over its nest), for RoomBots.setDetours. */
  detours(now: number): Map<string, Vec3> {
    const out = new Map<string, Vec3>();
    for (const [id, p] of this.provoked) {
      if (now >= p.until) continue;
      const n = this.nests.find((x) => x.id === p.nest);
      if (n) out.set(id, { x: n.x, y: n.y + PROVOKE_LIFT, z: n.z });
    }
    return out;
  }

  /** `id` took AA damage from `nest` at `now` — maybe provoke it (rising
   * edge: not while provoked or calming down). Call from the room. */
  noteHit(id: string, nest: number, level: Intensity, now: number): void {
    const p = this.provoked.get(id);
    if (p && now < p.calmUntil) return;
    if (this.rand() >= aaLevel(level).provoke) {
      // Not this time; it can be provoked by the next hit.
      return;
    }
    this.provoked.set(id, {
      nest,
      until: now + PROVOKE_MS,
      calmUntil: now + PROVOKE_MS + PROVOKE_COOLDOWN_MS,
    });
  }

  /** The room is empty / the war is off: no bursts in the air, no grudges. */
  reset(): void {
    this.pending = [];
    this.provoked.clear();
    this.strafeAt.clear();
    for (const g of this.guns) {
      g.targetId = null;
      g.los = false;
      g.losAt = Number.NEGATIVE_INFINITY;
    }
  }

  // --- The guns ------------------------------------------------------------

  private aimAndFire(
    g: Gun,
    now: number,
    dt: number,
    enemies: readonly AaEnemy[],
    byId: ReadonlyMap<string, AaEnemy>,
    level: Intensity,
    world: AaWorld,
    out: AaTick,
  ): void {
    const gun = aaGun(g.nest);
    const pivot: Vec3 = { x: g.nest.x, y: g.nest.y, z: g.nest.z };
    // Keep the target while it is still valid and in sight; else the
    // nearest in range (two sight checks at most per tick).
    let target = g.targetId !== null ? byId.get(g.targetId) : undefined;
    if (target && (target.prot || !leadOf(pivot, target, gun))) {
      target = undefined;
    }
    if (target && now - g.losAt >= LOS_RECHECK_MS) {
      g.los = this.inSight(g.nest, target.pos, world);
      g.losAt = now;
      if (!g.los) target = undefined;
    }
    if (!target) {
      g.targetId = null;
      let checks = 0;
      const cands = enemies
        .filter((e) => !e.prot)
        .map((e) => ({ e, d: wrapDistance(pivot, e.pos) }))
        .filter((c) => c.d <= gun.range && c.d >= gun.minRange)
        .sort((a, b) => a.d - b.d || (a.e.id < b.e.id ? -1 : 1));
      for (const c of cands) {
        if (checks++ >= 2) break;
        if (!this.inSight(g.nest, c.e.pos, world)) continue;
        target = c.e;
        g.targetId = c.e.id;
        g.since = now;
        g.los = true;
        g.losAt = now;
        break;
      }
    }
    if (!target) {
      // Nothing to shoot: drift back toward the rest heading.
      this.want.yaw = g.nest.yaw0;
      this.want.pitch = 0.25;
      slewGun(g.aim, this.want, dt * 0.25, gun);
      return;
    }
    const lead = leadOf(pivot, target, gun);
    if (!lead) return;
    aimOf(lead.d, this.want);
    slewGun(g.aim, this.want, dt, gun);
    if (now < g.nextFireAt || now - g.since < gun.reactionMs) return;
    if (aimError(g.aim, this.want) > gun.cone) return;
    // Within the elevation limits (slewGun clamped the aim; a target above
    // pitchMax stays out of the cone).
    const shot = burstAim(lead.d, target, lead.flight, gun, this.rand);
    const roll = this.rand();
    const to = burstPoint(pivot, shot.d);
    const fl = Math.round(lead.flight * 1000);
    out.bursts.push({ n: g.nest.id, t0: now, to, fl });
    this.stats.bursts++;
    g.nextFireAt = now + gun.intervalMs;
    const tuning = aaLevel(level);
    if (g.nest.heavy) {
      this.pending.push({
        due: now + fl,
        nest: g.nest.id,
        target: target.id,
        damage: 0,
        heavy: true,
        to,
      });
      return;
    }
    const dist = Math.hypot(lead.d.x, lead.d.y, lead.d.z);
    const hit = roll < burstHitChance(dist, shot.miss, gun, tuning);
    if (hit) {
      this.pending.push({
        due: now + fl + gun.burstMs / 2,
        nest: g.nest.id,
        target: target.id,
        damage: tuning.burstDamage,
        heavy: false,
        to,
      });
    }
  }

  /** Is `pos` in sight of nest `n` (its own sandbags never block it)? */
  private inSight(n: AaNest, pos: Vec3, world: AaWorld): boolean {
    return losClear(
      aaSightFrom(n, this.sight),
      pos,
      world.buildings,
      world.gaps,
    );
  }

  /** Land every burst due by `now`: a light one on its (still living, still
   * visible) target, a heavy one on every enemy near its burst point. */
  private land(
    now: number,
    byId: ReadonlyMap<string, AaEnemy>,
    tuning: ReturnType<typeof aaLevel>,
    world: AaWorld,
    out: AaTick,
  ): void {
    if (this.pending.length === 0) return;
    const kept: Pending[] = [];
    for (const p of this.pending) {
      if (p.due > now) {
        kept.push(p);
        continue;
      }
      const nest = this.nests.find((n) => n.id === p.nest);
      if (!nest) continue;
      const from = { x: nest.x, y: nest.y, z: nest.z };
      if (!p.heavy) {
        const t = byId.get(p.target);
        if (!t || t.prot) continue;
        // The target ducked behind a tower since the shot: the rounds hit
        // the tower.
        if (!this.inSight(nest, t.pos, world)) continue;
        out.hits.push({ nest: p.nest, target: t.id, damage: p.damage, from });
        this.stats.hits++;
        continue;
      }
      for (const e of byId.values()) {
        if (e.prot) continue;
        const dmg = aaFlakDamage(wrapDistance(e.pos, p.to), tuning);
        if (dmg <= 0) continue;
        out.hits.push({ nest: p.nest, target: e.id, damage: dmg, from });
        this.stats.hits++;
      }
    }
    this.pending = kept;
  }

  // --- The enemies fight back ---------------------------------------------

  private strafe(
    now: number,
    enemies: readonly AaEnemy[],
    world: AaWorld,
    out: AaTick,
  ): void {
    for (const e of enemies) {
      const speed = Math.hypot(e.vel.x, e.vel.y, e.vel.z);
      if (speed < 1) continue;
      if (now < (this.strafeAt.get(e.id) ?? Number.NEGATIVE_INFINITY)) {
        continue;
      }
      let best: AaNest | null = null;
      let bestD = STRAFE_RANGE;
      for (const n of this.nests) {
        const d = wrapDelta(e.pos, aaSightFrom(n, this.sight));
        const dist = Math.hypot(d.x, d.y, d.z);
        if (dist > bestD || dist < 20) continue;
        const cos =
          (d.x * e.vel.x + d.y * e.vel.y + d.z * e.vel.z) / (dist * speed);
        if (cos < Math.cos(STRAFE_CONE)) continue;
        if (!this.manned(n, world)) continue;
        best = n;
        bestD = dist;
      }
      if (!best) continue;
      if (
        !losClear(
          e.pos,
          aaSightFrom(best, this.sight),
          world.buildings,
          world.gaps,
        )
      ) {
        continue;
      }
      this.strafeAt.set(e.id, now + STRAFE_INTERVAL_MS);
      out.strafes.push({
        enemy: e.id,
        nest: best.id,
        hit: this.rand() < STRAFE_HIT,
      });
      this.stats.strafes++;
    }
  }
}
