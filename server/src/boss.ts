// S4 sky boss, server side: WHEN a raid comes, what the zeppelin's turrets
// shoot at, what its weak points have left, who hurt it, and how it comes
// apart. One BossDirector per room. index.ts and the bot-sim harness both
// drive exactly this, so the sim measures the boss the live server flies.
//
// The rules:
//  - a raid starts only while a human is in the room: the first one
//    tuning.firstMin..firstMax after a human arrived, then (C2) period ±
//    jitter after the last raid ENDED — flew off, or its last section came
//    down (common/src/boss.ts nextRaidAt) — so one is nearly always up. A
//    room left to its bots finishes a raid in progress but never starts one;
//  - each turret fires at most every BOSS_FLAK_INTERVAL_MS, at the nearest
//    plane in its range, traverse and line of sight — never a spawn-protected
//    plane or one that (re)spawned in the last respawnQuietMs — and only
//    after holding BOSS_FLAK_REACTION_MS on a new target (the bots' rule);
//  - a burst hurts by distance from the plane's (extrapolated) on-record
//    pose, never more than BOSS_FLAK_DPS_CAP to any plane in a rolling second;
//  - a weak-point hit is judged on the round's whole line against the
//    zeppelin's own pose (bossHitValid), for players and bots alike.

import {
  BOSS_CONTACT_PREFIX,
  BOSS_FLAK_DPS_CAP,
  BOSS_FLAK_INTERVAL_MS,
  BOSS_FLAK_REACTION_MS,
  BOSS_TUNING,
  BOSS_TURRETS,
  BOSS_WEAK_POINTS,
  type BossDown,
  type BossFlak,
  type BossLaunch,
  type BossPiece,
  type BossRaid,
  type BossSweepWorld,
  type BossTuning,
  LAUNCH_BELLY,
  LAUNCH_CATAPULT,
  LAUNCH_SEQ_MS,
  type LaunchKind,
  type WireBossState,
  blankPose,
  bossHitValid,
  bossPoseAt,
  bossPresent,
  bossVelAt,
  breakUp,
  emptyBossSlot,
  encodeLaunch,
  encodeRaid,
  flakDamage,
  flakSolution,
  launchDoneAt,
  launchReleaseAt,
  nextRaidAt,
  periodFromStart,
  planRaid,
  raidEgressAt,
  raidEnd,
  raidMaxHp,
  turretMuzzleInto,
  weakPointInto,
} from "@angels-bandits/common/boss";
import {
  type Building,
  chunkBuilding,
  chunkId,
  tierGrids,
} from "@angels-bandits/common/city";
import { losClear } from "@angels-bandits/common/collision";
import {
  BULLET_DAMAGE,
  INTERP_DELAY_MAX_MS,
  POSE_AGE_MAX_MS,
} from "@angels-bandits/common/constants";
import { type Vec3, wrapDistance } from "@angels-bandits/common/world";
import type { BotRoundHit } from "./bots";
import type { Combat, SpeedCapFn } from "./combat";
import type { RoomCity } from "./destruction";

/** A plane as the director sees it this tick: its on-record pose (the
 * caller extrapolates a human's to `now`), velocity, and protection. */
export interface BossPlane {
  id: string;
  pos: Vec3;
  vel: Vec3;
  prot: boolean;
}

/** The room's city as it stands: turret sight lines, and the sweep. */
export type BossWorld = BossSweepWorld;

/** What one tick produced, in broadcast order. */
export interface BossTickResult {
  /** A raid that started this tick (broadcast `boss`). */
  started: BossRaid | null;
  /** Shells fired this tick (broadcast `flak`). */
  flak: BossFlak[];
  /** Shells that burst this tick and who they hurt. */
  bursts: { flak: BossFlak; victims: { id: string; damage: number }[] }[];
  /** Falling sections that hit this tick: where, and the building they hit
   * (null: the street), for the city's damage. */
  landed: { piece: BossPiece; at: Vec3; building: Building | null }[];
}

/** No flak for this long after a (re)spawn, ms (X1's respawn quiet rule). */
const RESPAWN_QUIET_MS = 5000;
/** A finished raid stays in the welcome this long after its end, ms, so a
 * joiner still sees the wreck's last moments; after it the room has none. */
const WELCOME_TAIL_MS = 5000;
/** A claimed hit time is held to this window before `now`, ms: the round's
 * flight plus the oldest render clock a client may legally draw at. */
export const BOSS_CLAIM_LOOKBACK_MS =
  1000 + POSE_AGE_MAX_MS + INTERP_DELAY_MAX_MS;
/** A claimed round's direction must sit this close to the shooter's
 * on-record nose at the shot, rad: the pose behind it is up to
 * POSE_AGE_MAX_MS old, and a plane turns while the claim is in flight. */
export const BOSS_DIR_CONE = 0.5;

interface Turret {
  targetId: string | null;
  /** When the current target was taken, ms. */
  since: number;
  nextFireAt: number;
}

export class BossDirector {
  /** The room's boss as both sides hold it — the room's mover field holds
   * this very object, so bots, wrecks and crash checks see it. */
  readonly slot = emptyBossSlot();
  /** Every weak point's HP on the current raid (empty with none). */
  hp: number[] = [];
  private humanSince: number | null = null;
  private nextAt: number | null = null;
  private lastStart: number | null = null;
  private nextRaid = 1;
  private nextShell = 1;
  private readonly damageBy = new Map<string, number>();
  private turrets: Turret[] = [];
  private shells: BossFlak[] = [];
  private readonly settledPieces = new Set<number>();
  private readonly spawns = new Map<string, number>();
  /** Flak taken per plane in the last second. */
  private readonly taken = new Map<string, { t: number; dmg: number }[]>();
  private hpDirty = false;
  /** S9: the carrier's launches by bot id (a launch leaves this map when
   * its bot is released; the slot keeps it until its rig has reset), the
   * deaths already offered a launch (bot id → its respawn time), and the
   * next launch id. */
  private readonly launchByBot = new Map<string, BossLaunch>();
  private readonly offered = new Map<string, number>();
  private nextLaunch = 1;
  private readonly pose = blankPose();
  private readonly at: Vec3 = { x: 0, y: 0, z: 0 };

  constructor(
    private readonly rand: () => number,
    private readonly tuning: BossTuning = BOSS_TUNING,
  ) {}

  /** A plane (re)spawned or came back: no flak at it for a beat. */
  noteSpawn(id: string, now: number): void {
    this.spawns.set(id, now);
  }

  /** A plane left the room: it draws no flak. Its damage credit stays for
   * the raid (A2): a W2 drop is not a leave, and a pilot who resumes and
   * finishes the boss is owed it — bossDowned only credits members still in
   * the room, and every new raid starts the ledger over. */
  forget(id: string): void {
    this.launchByBot.delete(id);
    this.offered.delete(id);
    this.spawns.delete(id);
    this.taken.delete(id);
    for (const t of this.turrets) if (t.targetId === id) t.targetId = null;
  }

  /** Shells in the air (B3: the bots dodge their bursts). Read-only. */
  shellsInFlight(): readonly BossFlak[] {
    return this.shells;
  }

  /** The raid on, intact and in the air at `t`. */
  activeRaid(t: number): BossRaid | null {
    return bossPresent(this.slot, t) ? this.slot.raid : null;
  }

  /** Has the room a raid in progress — flying, or its sections falling? */
  busy(now: number): boolean {
    const r = this.slot.raid;
    if (!r) return false;
    const d = this.slot.down;
    if (d && d.id === r.id) {
      return d.pieces.some((_, i) => !this.settledPieces.has(i));
    }
    return now < raidEnd(r);
  }

  /** True once since the last call when a hit changed the HP. */
  takeHpChanged(): boolean {
    const dirty = this.hpDirty;
    this.hpDirty = false;
    return dirty;
  }

  /** The welcome's replay (null: no raid worth showing). */
  state(now: number): WireBossState | null {
    const r = this.slot.raid;
    if (!r) return null;
    const d =
      this.slot.down && this.slot.down.id === r.id ? this.slot.down : null;
    const over = d ? d.t + Math.max(...d.pieces.map((p) => p.end)) : raidEnd(r);
    if (now > over + WELCOME_TAIL_MS) return null;
    const ls = (this.slot.launches ?? []).filter((l) => launchDoneAt(l) > now);
    return {
      r: encodeRaid(r),
      hp: [...this.hp],
      ...(d && { d }),
      ...(ls.length > 0 && { l: ls.map(encodeLaunch) }),
    };
  }

  /** Living weak points as bot contacts (`@boss:<k>`), while it flies. */
  contacts(now: number): { id: string; pos: Vec3; vel: Vec3 }[] {
    const r = this.activeRaid(now);
    if (!r) return [];
    const pose = bossPoseAt(r, now, this.pose);
    const vel = bossVelAt(r, now, { x: 0, y: 0, z: 0 });
    const out: { id: string; pos: Vec3; vel: Vec3 }[] = [];
    for (let k = 0; k < BOSS_WEAK_POINTS.length; k++) {
      if (!((this.hp[k] ?? 0) > 0)) continue;
      out.push({
        id: `${BOSS_CONTACT_PREFIX}${k}`,
        pos: weakPointInto(pose, k, { x: 0, y: 0, z: 0 }),
        vel,
      });
    }
    return out;
  }

  /**
   * One tick: the schedule, the turrets, the bursts due and the sections
   * that hit. `humans`: a human is in the room. `planes`: the living planes
   * in the air.
   */
  tick(
    now: number,
    humans: boolean,
    planes: readonly BossPlane[],
    world: BossWorld,
  ): BossTickResult {
    const out: BossTickResult = {
      started: null,
      flak: [],
      bursts: [],
      landed: [],
    };
    for (const [id, t] of this.spawns) {
      if (now - t >= RESPAWN_QUIET_MS) this.spawns.delete(id);
    }
    this.schedule(now, humans, out);
    const raid = this.activeRaid(now);
    if (raid) this.fireTurrets(now, raid, planes, world, out);
    this.settleShells(now, planes, out);
    this.settlePieces(now, out, world);
    // S9: a launch whose rig has reset is history.
    const ls = this.slot.launches;
    if (ls && ls.length > 0 && launchDoneAt(ls[0] as BossLaunch) <= now) {
      this.slot.launches = ls.filter((l) => launchDoneAt(l) > now);
    }
    return out;
  }

  /**
   * S9: offer a dead bot (`botId`, due back at `respawnAt`) a launch from
   * the carrier. Once per death. Only while the zeppelin is intact and on
   * station through the release; on a free station (the deck catapult and
   * the belly trapeze alternate, either takes the launch when the other is
   * busy); timed to release AT `respawnAt` (never before `now`, so at most
   * a tick late); and only when `clear` passes its release run. Returns
   * the launch (to broadcast) or null — the bot respawns as usual.
   */
  planLaunch(
    botId: string,
    respawnAt: number,
    now: number,
    clear: (raid: BossRaid, l: BossLaunch) => boolean,
  ): BossLaunch | null {
    if (this.launchByBot.has(botId)) return null;
    if (this.offered.get(botId) === respawnAt) return null;
    this.offered.set(botId, respawnAt);
    const raid = this.activeRaid(now);
    if (!raid) return null;
    const first: LaunchKind =
      this.nextLaunch % 2 === 0 ? LAUNCH_BELLY : LAUNCH_CATAPULT;
    for (const kind of [
      first,
      first === LAUNCH_BELLY ? LAUNCH_CATAPULT : LAUNCH_BELLY,
    ] as const) {
      const t0 = Math.max(now, respawnAt - (LAUNCH_SEQ_MS[kind] as number));
      const l: BossLaunch = { id: this.nextLaunch, raid: raid.id, kind, t0 };
      const release = launchReleaseAt(l);
      // On station (not running out) and still up at the release.
      if (release >= raidEgressAt(raid) || !this.activeRaid(release)) continue;
      const busy = (this.slot.launches ?? []).some(
        (o) => o.kind === kind && launchDoneAt(o) > t0,
      );
      if (busy || !clear(raid, l)) continue;
      this.nextLaunch++;
      this.launchByBot.set(botId, l);
      this.slot.launches = [...(this.slot.launches ?? []), l];
      return l;
    }
    return null;
  }

  /** S9: the launch `botId` is waiting on, or null. */
  launchOf(botId: string): BossLaunch | null {
    return this.launchByBot.get(botId) ?? null;
  }

  /** S9: `botId` left its rig (released, or fell back to a street spawn). */
  released(botId: string): void {
    this.launchByBot.delete(botId);
  }

  private schedule(now: number, humans: boolean, out: BossTickResult): void {
    if (!humans) {
      this.humanSince = null;
      if (!this.busy(now)) this.nextAt = null;
      return;
    }
    if (this.humanSince === null) this.humanSince = now;
    if (this.busy(now)) return;
    if (this.nextAt === null) {
      this.nextAt = nextRaidAt(
        periodFromStart(this.tuning) ? this.lastStart : this.lastEnd(),
        this.humanSince,
        this.rand,
        this.tuning,
      );
    }
    if (now < this.nextAt) return;
    const raid = planRaid(this.rand, this.nextRaid++, now, this.tuning);
    this.slot.raid = raid;
    this.slot.down = null;
    this.hp = raidMaxHp(raid);
    this.damageBy.clear();
    this.settledPieces.clear();
    this.launchByBot.clear();
    this.slot.launches = [];
    this.shells = [];
    this.turrets = BOSS_TURRETS.map((_, k) => ({
      targetId: null,
      since: now,
      // Staggered, so six turrets never open up in one volley.
      nextFireAt: now + (k * BOSS_FLAK_INTERVAL_MS) / BOSS_TURRETS.length,
    }));
    this.lastStart = now;
    this.nextAt = null;
    out.started = raid;
  }

  /** When the last raid was over: its run-out done or, once it went down,
   * its last section landed. Null before the first raid. */
  private lastEnd(): number | null {
    const r = this.slot.raid;
    if (!r) return null;
    const d = this.slot.down;
    if (d && d.id === r.id) {
      return d.t + Math.max(0, ...d.pieces.map((p) => p.end));
    }
    return raidEnd(r);
  }

  private fireTurrets(
    now: number,
    raid: BossRaid,
    planes: readonly BossPlane[],
    world: BossWorld,
    out: BossTickResult,
  ): void {
    const pose = bossPoseAt(raid, now, this.pose);
    for (let k = 0; k < this.turrets.length; k++) {
      const turret = this.turrets[k] as Turret;
      if (now < turret.nextFireAt) continue;
      const up = (BOSS_TURRETS[k] as { up: 1 | -1 }).up;
      const muzzle = turretMuzzleInto(pose, k, this.at);
      // Nearest plane it may and can shoot at: range and traverse
      // (flakSolution's own geometry, with a throwaway draw), then sight.
      const ranked = planes
        .filter((p) => !p.prot && !this.spawns.has(p.id))
        .map((p) => ({ p, d: wrapDistance(muzzle, p.pos) }))
        .sort((a, b) => a.d - b.d);
      let target: BossPlane | null = null;
      for (const { p } of ranked) {
        if (!flakSolution(muzzle, up, p, () => 0)) continue;
        if (!losClear(muzzle, p.pos, world.buildings)) continue;
        target = p;
        break;
      }
      if (!target) {
        turret.targetId = null;
        continue;
      }
      if (target.id !== turret.targetId) {
        // A new target: the reaction delay starts now (the bots' rule).
        turret.targetId = target.id;
        turret.since = now;
      }
      if (now - turret.since < BOSS_FLAK_REACTION_MS) continue;
      const sol = flakSolution(muzzle, up, target, this.rand);
      if (!sol) continue;
      const shell: BossFlak = {
        id: this.nextShell++,
        turret: k,
        to: sol.to,
        t0: now,
        fuse: sol.fuse,
      };
      this.shells.push(shell);
      out.flak.push(shell);
      turret.nextFireAt = now + BOSS_FLAK_INTERVAL_MS;
    }
  }

  /** Shells whose fuse ran out by `now`: hurt every plane in the burst,
   * under the per-second cap. A shell outlives its boss (it is in the air). */
  private settleShells(
    now: number,
    planes: readonly BossPlane[],
    out: BossTickResult,
  ): void {
    if (this.shells.length === 0) return;
    const left: BossFlak[] = [];
    for (const f of this.shells) {
      if (f.t0 + f.fuse > now) {
        left.push(f);
        continue;
      }
      const victims: { id: string; damage: number }[] = [];
      for (const p of planes) {
        if (p.prot || this.spawns.has(p.id)) continue;
        const raw = flakDamage(wrapDistance(p.pos, f.to));
        if (raw <= 0) continue;
        const damage = this.capped(p.id, raw, now);
        if (damage > 0) victims.push({ id: p.id, damage });
      }
      out.bursts.push({ flak: f, victims });
    }
    this.shells = left;
  }

  /** `raw` flak damage to `id` at `now`, cut to what its rolling second
   * still allows; recorded. */
  private capped(id: string, raw: number, now: number): number {
    const log = (this.taken.get(id) ?? []).filter((e) => now - e.t < 1000);
    let sum = 0;
    for (const e of log) sum += e.dmg;
    const damage = Math.max(0, Math.min(raw, BOSS_FLAK_DPS_CAP - sum));
    if (damage > 0) log.push({ t: now, dmg: damage });
    this.taken.set(id, log);
    return damage;
  }

  private settlePieces(
    now: number,
    out: BossTickResult,
    world: BossWorld,
  ): void {
    const d = this.slot.down;
    if (!d) return;
    d.pieces.forEach((piece, i) => {
      if (this.settledPieces.has(i) || now < d.t + piece.end) return;
      this.settledPieces.add(i);
      // Where and what it hit were swept at the down, against the city as
      // it stood then (an earlier section's landing must not move them).
      out.landed.push({
        piece,
        at: piece.at,
        building: piece.b >= 0 ? (world.buildings[piece.b] ?? null) : null,
      });
    });
  }

  /**
   * Is a round from `origin` along unit `dir`, meeting weak point `k` at
   * server time `t`, a fair hit? The boss must be intact and in the air at
   * `t`, `k` alive, and `k` the first thing on the line (bossHitValid).
   */
  validHit(k: number, origin: Vec3, dir: Vec3, t: number): boolean {
    const r = this.activeRaid(t);
    if (!r) return false;
    const alive = this.hp.map((v) => v > 0);
    return bossHitValid(bossPoseAt(r, t, this.pose), k, origin, dir, alive);
  }

  /**
   * One validated round on weak point `k` by `shooterId` at `now`:
   * BULLET_DAMAGE off it, credited. Reaching zero across every weak point
   * brings it down — its break-up swept against `world` right here, once.
   * Null when nothing was applied (no raid, `k` already spent).
   */
  damage(
    shooterId: string,
    k: number,
    now: number,
    world: BossSweepWorld,
  ): { hp: number[]; down: BossDown | null } | null {
    const r = this.activeRaid(now);
    if (!r || !((this.hp[k] ?? 0) > 0)) return null;
    const dealt = Math.min(this.hp[k] as number, BULLET_DAMAGE);
    this.hp[k] = (this.hp[k] as number) - dealt;
    this.damageBy.set(shooterId, (this.damageBy.get(shooterId) ?? 0) + dealt);
    this.hpDirty = true;
    let down: BossDown | null = null;
    if (this.hp.every((v) => v <= 0)) {
      down = breakUp(r, now, world);
      this.slot.down = down;
      this.shells = this.shells.filter((f) => f.t0 + f.fuse > now);
    }
    return { hp: [...this.hp], down };
  }

  /** Damage dealt this raid, by pilot (the credit split's input). */
  damageLedger(): ReadonlyMap<string, number> {
    return this.damageBy;
  }
}

/** A shooter-side `bossHit` claim's fields, shape-checked by the caller. */
export interface BossHitClaim {
  wp: number;
  seq: number;
  origin: Vec3;
  dir: Vec3;
  t: number;
}

/**
 * Judge one `bossHit` claim and, when it stands, apply it. The fired round
 * is spent through Combat.claimBullet (existence, age, one hit, origin — a
 * plane hit's rules); its claimed direction must sit inside BOSS_DIR_CONE of
 * the nose kept at the shot; the claimed time is held to
 * BOSS_CLAIM_LOOKBACK_MS; then the round's line is re-run against the
 * armour at that time. Null when refused.
 */
export function claimBossHit(
  combat: Combat,
  boss: BossDirector,
  shooterId: string,
  claim: BossHitClaim,
  shooterPos: Vec3,
  now: number,
  world: BossSweepWorld,
  shooterCap?: SpeedCapFn,
): { hp: number[]; down: BossDown | null } | null {
  const { wp, dir } = claim;
  if (!Number.isInteger(wp) || wp < 0 || wp >= BOSS_WEAK_POINTS.length) {
    return null;
  }
  const len = Math.hypot(dir.x, dir.y, dir.z);
  if (!(Math.abs(len - 1) < 1e-3)) return null;
  const t = Math.min(now, Math.max(now - BOSS_CLAIM_LOOKBACK_MS, claim.t));
  // Cheap refusals first: no boss, or that weak point is spent.
  if (!boss.activeRaid(t) || !((boss.hp[wp] ?? 0) > 0)) return null;
  const bullet = combat.claimBullet(
    shooterId,
    claim.seq,
    claim.origin,
    shooterPos,
    now,
    shooterCap,
  );
  if (!bullet.ok) return null;
  if (bullet.dir) {
    const cos =
      bullet.dir.x * dir.x + bullet.dir.y * dir.y + bullet.dir.z * dir.z;
    if (cos < Math.cos(BOSS_DIR_CONE)) return null;
  }
  if (!boss.validHit(wp, claim.origin, dir, t)) return null;
  return boss.damage(shooterId, wp, now, world);
}

/** The weak point a bot contact id names, or -1 (not a boss contact). */
export function bossContactIndex(id: string): number {
  if (!id.startsWith(BOSS_CONTACT_PREFIX)) return -1;
  const k = Number(id.slice(BOSS_CONTACT_PREFIX.length));
  return Number.isInteger(k) && k >= 0 && k < BOSS_WEAK_POINTS.length ? k : -1;
}

/**
 * A bot round that met a weak point this tick (F4's swept rounds): the same
 * judgement as a player's claim — the round spent through Combat, its line
 * re-run against the armour at `now` — then applied. Null when refused.
 */
export function landBotBossRound(
  combat: Combat,
  boss: BossDirector,
  round: BotRoundHit,
  now: number,
  world: BossSweepWorld,
): { hp: number[]; down: BossDown | null } | null {
  const k = bossContactIndex(round.shot.targetId);
  if (k < 0) return null;
  return claimBossHit(
    combat,
    boss,
    round.shot.botId,
    {
      wp: k,
      seq: round.shot.seq,
      origin: round.shot.origin,
      dir: round.shot.dir,
      t: now,
    },
    round.shooterPos,
    now,
    world,
  );
}

/** D2/D3: one falling section hit at `at`: blow out the room city's chunks
 * around it, and — when it came down on a building — shear the floor band
 * BOSS_CRUSH_DEPTH floors under the hit, so the floors above it pancake
 * (D3's planner does the rest on the next destruction tick). A collapse it
 * sets off is credited to `by` (the top dealer). Returns the chunks
 * destroyed. Deterministic in the city and the point. */
export const BOSS_IMPACT_RADIUS = 34;
export const BOSS_IMPACT_DAMAGE = 1400;
export const BOSS_CRUSH_DEPTH = 3;
export function applyBossImpact(
  city: RoomCity,
  at: Vec3,
  by: string | null,
  building: Building | null = null,
): number[] {
  const out = city.damage.damageAt(at, BOSS_IMPACT_RADIUS, BOSS_IMPACT_DAMAGE);
  if (building) out.push(...crushUnder(city, building, at));
  for (const id of out) city.breakers.set(chunkBuilding(id), by);
  return out;
}

/** The floor band BOSS_CRUSH_DEPTH floors under where a section hit
 * building `b` at `at` — counted down through the tiers, so a squat crown
 * shears the tier under it — destroyed across that tier's footprint.
 * Nothing when there are not that many floors under the hit. */
function crushUnder(city: RoomCity, b: Building, at: Vec3): number[] {
  const index = city.buildings.indexOf(b);
  const grids = tierGrids(b);
  // The tier at the height it was hit (the highest one starting under it).
  let tier = -1;
  grids.forEach((g, k) => {
    if (g.baseY <= at.y + 1) tier = k;
  });
  const g = grids[tier];
  if (!g) return [];
  let band = Math.min(
    g.ny - 1,
    Math.max(0, Math.floor((at.y + 1 - g.baseY) / g.ch)),
  );
  for (let n = 0; n < BOSS_CRUSH_DEPTH; n++) {
    band--;
    if (band < 0) {
      tier--;
      const under = grids[tier];
      if (!under) return [];
      band = under.ny - 1;
    }
  }
  const crushed = grids[tier] as (typeof grids)[number];
  const out: number[] = [];
  const per = crushed.nx * crushed.nz;
  for (let c = band * per; c < (band + 1) * per; c++) {
    const id = chunkId(index, tier, c);
    if (city.damage.destroyChunk(id)) out.push(id);
  }
  return out;
}
