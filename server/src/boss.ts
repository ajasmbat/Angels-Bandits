// Z1 airship fleet, server side (S4's sky boss, made a fleet): which ships
// fly, what each one's guns shoot at, what each one has left, who hurt it,
// and how it comes down. One FleetDirector per room. index.ts and the
// bot-sim harness both drive exactly this, so the sim measures the fleet
// the live server flies.
//
// The rules:
//  - the fleet comes on the first tick a human is flying in the room: one
//    ship on every lane (common/src/boss.ts FLEET_LANES), seeded along it.
//    A room nobody is flying in keeps the ships it has, refills nothing and
//    fires nothing;
//  - a downed ship's lane is flown again tuning.refillMs after it went down
//    (never while its crash is still falling), by a new ship coming on at
//    the spot along the lane furthest from every human — out of sight, so
//    it drifts in from the haze — or, if none is FLEET_HIDE_M clear,
//    anywhere once tuning.refillWaitMs more have passed;
//  - only the armed classes' turrets fire (SHIP_CLASSES[c].turrets), each
//    at most every BOSS_FLAK_INTERVAL_MS, at the nearest plane in its range,
//    traverse and line of sight — never a spawn-protected plane or one that
//    (re)spawned in the last RESPAWN_QUIET_MS — and only after holding
//    BOSS_FLAK_REACTION_MS on a new target (the bots' rule). The caller
//    hands it humans only — the enemy planes are not targets;
//  - a burst hurts by distance from the plane's (extrapolated) on-record
//    pose, never more than BOSS_FLAK_DPS_CAP × FLEET_FLAK_SCALE to any plane
//    in a rolling second, across every turret of the fleet;
//  - a hit is judged on the round's whole line against the ship's own pose
//    (shipHitValid), for players and bots alike. One HP integer per ship:
//    a hull round takes BULLET_DAMAGE, a weak-point round FLEET_WEAK_MULT
//    times that; at zero the ship crashes (shipCrash), swept here, once.

import {
  BOSS_CONTACT_PREFIX,
  BOSS_FLAK_DPS_CAP,
  BOSS_FLAK_INTERVAL_MS,
  BOSS_FLAK_RANGE,
  BOSS_FLAK_REACTION_MS,
  BOSS_TURRETS,
  BOSS_WEAK_POINTS,
  type BossFlak,
  type BossLaunch,
  type BossSweepWorld,
  FLEET_FLAK_SCALE,
  FLEET_HIDE_M,
  FLEET_LANES,
  FLEET_LAYERS,
  FLEET_TUNING,
  type FleetShip,
  type FleetTuning,
  LAUNCH_SEQ_MS,
  type LaneBreak,
  type LaunchKind,
  SHIP_CLASSES,
  SHIP_REACH,
  type ShipDown,
  type ShipPose,
  type WireFleetState,
  blankPose,
  emptyFleetSlot,
  encodeLaunch,
  encodeShip,
  flakDamage,
  flakSolution,
  fleetPoseAt,
  gridCoord,
  hiddenLaneSpot,
  laneBreaks,
  launchDoneAt,
  launchReleaseAt,
  shipById,
  shipClass,
  shipCrash,
  shipFullHp,
  shipHitValid,
  shipPresent,
  shipRoundDamage,
  shipVelAt,
  turretMuzzleInto,
  weakPointInto,
} from "@angels-bandits/common/boss";
import {
  type Building,
  chunkBuilding,
  chunkId,
  tierGrids,
} from "@angels-bandits/common/city";
import {
  IMPACT_SECTION,
  makeImpact,
} from "@angels-bandits/common/city/penetrate";
import { losClear } from "@angels-bandits/common/collision";
import {
  INTERP_DELAY_MAX_MS,
  POSE_AGE_MAX_MS,
} from "@angels-bandits/common/constants";
import {
  BREAK_LEAD_MS,
  type BreakObstacle,
  breakPassEnd,
  breakTouchIn,
} from "@angels-bandits/common/fleetplan";
import { type Vec3, wrapDistance } from "@angels-bandits/common/world";
import type { BotRoundHit } from "./bots";
import type { Combat, SpeedCapFn } from "./combat";
import { type RoomCity, blastProps, sweepBlast } from "./destruction";

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
  /** Ships that came on this tick (broadcast `ship`). */
  started: FleetShip[];
  /** Shells fired this tick (broadcast `flak`). */
  flak: BossFlak[];
  /** Shells that burst this tick and who they hurt. */
  bursts: { flak: BossFlak; victims: { id: string; damage: number }[] }[];
  /** Crashes that hit this tick: where, the building they hit (null: the
   * street), and the pilot credited with what they break. */
  landed: {
    ship: FleetShip;
    at: Vec3;
    building: Building | null;
    by: string | null;
  }[];
}

/** K1: a planned break-through due — `ship`'s hull is about to meet
 * break `brk` of its lane, `obstacle`, at `touch`: the caller fells the
 * crane (or knocks the prop down) at `at`, just before, so the hull is
 * never drawn through it. The ship takes BREAK_DAMAGE_SHARE of its HP at
 * `touch`. */
export interface FleetBreak {
  ship: FleetShip;
  brk: LaneBreak;
  obstacle: BreakObstacle;
  at: number;
  touch: number;
}

/** How a break's obstacle stands, as the room resolves it: its shape, and
 * whether it is still up at `t`. Null: the room has no such obstacle. */
export type BreakResolver = (
  brk: LaneBreak,
  t: number,
) => { obstacle: BreakObstacle; standing: boolean } | null;

/** K1: the AA nests' rounds do this share of their plane damage to a ship,
 * and never take it under this share of its full HP. */
export const AA_SHIP_SCALE = 0.5;
export const AA_SHIP_FLOOR = 0.25;

/** K1: a break is looked for this far ahead, ms (the obstacle goes
 * fleetplan.ts BREAK_LEAD_MS before the hull would touch it). */
export const BREAK_LOOKAHEAD_MS = 1000;
/** ...and the ship takes this share of its full HP from it (never the
 * kill: a break leaves it at least 1 HP). */
export const BREAK_DAMAGE_SHARE = 0.12;

/** What a hit did: the ship's HP after it, and its crash when it was the
 * one that brought it down. */
export interface ShipHitResult {
  ship: FleetShip;
  hp: number;
  down: ShipDown | null;
}

/** No flak for this long after a (re)spawn, ms (X1's respawn quiet rule). */
const RESPAWN_QUIET_MS = 5000;
/** A landed crash stays in the slot (and the welcome) this long, ms, so a
 * joiner still sees its last moments; after it the ship is history. */
const LANDED_TAIL_MS = 5000;
/** A pending refill looks for a hidden spot this often, ms. */
const REFILL_TRY_MS = 500;
/** A claimed hit time is held to this window before `now`, ms: the round's
 * flight plus the oldest render clock a client may legally draw at. */
export const BOSS_CLAIM_LOOKBACK_MS =
  1000 + POSE_AGE_MAX_MS + INTERP_DELAY_MAX_MS;
/** A claimed round's direction must sit this close to the shooter's
 * on-record nose at the shot, rad: the pose behind it is up to
 * POSE_AGE_MAX_MS old, and a plane turns while the claim is in flight. */
export const BOSS_DIR_CONE = 0.5;
/** A launch comes from a ship this near (plan view) some human, m. */
export const LAUNCH_NEAR_M = 900;

interface Turret {
  /** Index into BOSS_TURRETS. */
  k: number;
  targetId: string | null;
  /** When the current target was taken, ms. */
  since: number;
  nextFireAt: number;
}

export class FleetDirector {
  /** The room's fleet as both sides hold it — the room's mover field holds
   * this very object, so bots, wrecks and crash checks see it. */
  readonly slot = emptyFleetSlot();
  /** Each ship's HP, by id (a landed ship's 0 until it is pruned). */
  readonly hp = new Map<number, number>();
  private started = false;
  private nextShip = 1;
  private nextShell = 1;
  /** Z1: ships shot down this session (reset with the room's humans). */
  private downCount = 0;
  /** Damage dealt to each ship, by pilot (its credit split's input). */
  private readonly damageBy = new Map<number, Map<string, number>>();
  /** Each armed ship's turrets, by ship id. */
  private readonly turrets = new Map<number, Turret[]>();
  private shells: BossFlak[] = [];
  /** Per lane: when its next ship may come on (null: it has one). */
  private readonly refillAt: (number | null)[] = FLEET_LANES.map(() => null);
  private readonly refillTry: number[] = FLEET_LANES.map(() => 0);
  private readonly landedIds = new Set<number>();
  private readonly spawns = new Map<string, number>();
  /** Flak taken per plane in the last second. */
  private readonly taken = new Map<string, { t: number; dmg: number }[]>();
  private readonly hpChanged = new Set<number>();
  /** S9: the launches by bot id (a launch leaves this map when its bot is
   * released; the slot keeps it until its rig has reset), the deaths
   * already offered a launch (bot id → its respawn time), and the next
   * launch id and the ship that launched last (launches spread). */
  private readonly launchByBot = new Map<string, BossLaunch>();
  private readonly offered = new Map<string, number>();
  private nextLaunch = 1;
  private lastLauncher = -1;
  /** K1: per ship and break (`id:k`), how far ahead its course has been
   * searched for the next touch, ms, and the touch found (null: none yet). */
  private readonly breakScan = new Map<
    string,
    { searched: number; touch: number | null }
  >();
  /** K1: break damage still to land: [ship id, when, HP]. */
  private breakHurt: [number, number, number][] = [];
  private readonly pose = blankPose();
  private readonly at: Vec3 = { x: 0, y: 0, z: 0 };

  constructor(
    private readonly rand: () => number,
    private readonly tuning: FleetTuning = FLEET_TUNING,
  ) {}

  /** The room emptied of humans: the fleet counter starts over. */
  resetSession(): void {
    this.downCount = 0;
  }

  /** Airships shot down this session (the HUD's fleet counter). */
  downs(): number {
    return this.downCount;
  }

  /** A plane (re)spawned or came back: no flak at it for a beat. */
  noteSpawn(id: string, now: number): void {
    this.spawns.set(id, now);
  }

  /** A plane left the room: it draws no flak. Its damage credit stays (A2):
   * a W2 drop is not a leave, and a pilot who resumes and finishes a ship
   * is owed it — shipDowned only credits members still in the room. */
  forget(id: string): void {
    this.launchByBot.delete(id);
    this.offered.delete(id);
    this.spawns.delete(id);
    this.taken.delete(id);
    for (const ts of this.turrets.values()) {
      for (const t of ts) if (t.targetId === id) t.targetId = null;
    }
  }

  /** Shells in the air (B3: the bots dodge their bursts). Read-only. */
  shellsInFlight(): readonly BossFlak[] {
    return this.shells;
  }

  /** Ship `id` if it is intact and in the air at `t`. */
  activeShip(id: number, t: number): FleetShip | null {
    const s = shipById(this.slot, id);
    return s && shipPresent(s, t) ? s : null;
  }

  /** Every ship intact and in the air at `t`. */
  activeShips(t: number): FleetShip[] {
    return this.slot.ships.filter((s) => shipPresent(s, t));
  }

  /** Is any ship up at `t`? */
  anyUp(t: number): boolean {
    for (const s of this.slot.ships) if (shipPresent(s, t)) return true;
    return false;
  }

  /** The HP of every ship a hit changed since the last call, [id, hp]. */
  takeHpChanged(): [number, number][] {
    const out: [number, number][] = [];
    for (const id of this.hpChanged) out.push([id, this.hp.get(id) ?? 0]);
    this.hpChanged.clear();
    return out;
  }

  /** The welcome's replay (null: no fleet). */
  state(now: number): WireFleetState | null {
    if (this.slot.ships.length === 0) return null;
    const ls = this.slot.launches.filter((l) => launchDoneAt(l) > now);
    return {
      s: this.slot.ships.map(encodeShip),
      hp: this.slot.ships.map((s) => this.hp.get(s.id) ?? 0),
      d: this.slot.ships.map((s) => s.down),
      ...(ls.length > 0 && { l: ls.map(encodeLaunch) }),
    };
  }

  /** Living weak points of every flying ship within `range` of `near` as
   * bot contacts (`@boss:<ship>:<k>`). */
  contacts(
    now: number,
    near: Vec3,
    range: number,
  ): { id: string; pos: Vec3; vel: Vec3 }[] {
    const out: { id: string; pos: Vec3; vel: Vec3 }[] = [];
    for (const s of this.slot.ships) {
      if (!shipPresent(s, now)) continue;
      fleetPoseAt(s, now, this.pose);
      if (wrapDistance(this.pose, near) > range) continue;
      const vel = shipVelAt(s, now, { x: 0, y: 0, z: 0 });
      for (let k = 0; k < BOSS_WEAK_POINTS.length; k++) {
        out.push({
          id: `${BOSS_CONTACT_PREFIX}${s.id}:${k}`,
          pos: weakPointInto(this.pose, shipClass(s), k, { x: 0, y: 0, z: 0 }),
          vel,
        });
      }
    }
    return out;
  }

  /**
   * One tick: the fleet's schedule, the turrets, the bursts due and the
   * crashes that hit. `humans`: a human is flying in the room. `planes`:
   * the living planes in the air the turrets may shoot (the humans) — a
   * refill comes on out of their sight.
   */
  tick(
    now: number,
    humans: boolean,
    planes: readonly BossPlane[],
    world: BossWorld,
  ): BossTickResult {
    const out: BossTickResult = {
      started: [],
      flak: [],
      bursts: [],
      landed: [],
    };
    for (const [id, t] of this.spawns) {
      if (now - t >= RESPAWN_QUIET_MS) this.spawns.delete(id);
    }
    if (humans) this.schedule(now, planes, out);
    if (humans) this.fireTurrets(now, planes, world, out);
    this.settleShells(now, planes, out);
    this.landBreakHurt(now);
    this.settleCrashes(now, out, world);
    // S9: a launch whose rig has reset is history.
    const ls = this.slot.launches;
    if (ls.length > 0 && launchDoneAt(ls[0] as BossLaunch) <= now) {
      this.slot.launches = ls.filter((l) => launchDoneAt(l) > now);
    }
    return out;
  }

  /**
   * S9: offer a dead bot (`botId`, due back at `respawnAt`) a launch from
   * the fleet. Once per death. From an intact ship within LAUNCH_NEAR_M of
   * one of `near` (the humans; any ship when empty), the ship that launched
   * last only when no other will do — launches spread across the fleet; on
   * a rig its class carries that is free (a carrier's catapult and trapeze
   * alternate); timed to release AT `respawnAt` (never before `now`, so at
   * most a tick late); the ship still up at the release; and only when
   * `clear` passes the release run. Returns the launch (to broadcast) or
   * null — the bot respawns as usual.
   */
  planLaunch(
    botId: string,
    respawnAt: number,
    now: number,
    near: readonly Vec3[],
    clear: (ship: FleetShip, l: BossLaunch) => boolean,
  ): BossLaunch | null {
    if (this.launchByBot.has(botId)) return null;
    if (this.offered.get(botId) === respawnAt) return null;
    this.offered.set(botId, respawnAt);
    // Candidates by distance to their nearest human; the last launcher
    // goes to the back.
    const ranked: { s: FleetShip; d: number }[] = [];
    for (const s of this.slot.ships) {
      if (!shipPresent(s, now)) continue;
      fleetPoseAt(s, now, this.pose);
      let d = near.length === 0 ? 0 : Number.POSITIVE_INFINITY;
      for (const h of near) {
        d = Math.min(d, wrapDistance({ ...h, y: 0 }, { ...this.pose, y: 0 }));
      }
      if (d > LAUNCH_NEAR_M) continue;
      ranked.push({ s, d: s.id === this.lastLauncher ? d + 1e6 : d });
    }
    ranked.sort((a, b) => a.d - b.d || a.s.id - b.s.id);
    for (const { s } of ranked) {
      const rigs = (
        SHIP_CLASSES[shipClass(s)] as { rigs: readonly LaunchKind[] }
      ).rigs;
      const first: LaunchKind =
        rigs.length > 1 && this.nextLaunch % 2 === 1
          ? (rigs[1] as LaunchKind)
          : (rigs[0] as LaunchKind);
      for (const kind of [first, ...rigs.filter((k) => k !== first)]) {
        const t0 = Math.max(now, respawnAt - (LAUNCH_SEQ_MS[kind] as number));
        const l: BossLaunch = { id: this.nextLaunch, ship: s.id, kind, t0 };
        if (!shipPresent(s, launchReleaseAt(l))) continue;
        const busy = this.slot.launches.some(
          (o) => o.ship === s.id && o.kind === kind && launchDoneAt(o) > t0,
        );
        if (busy || !clear(s, l)) continue;
        this.nextLaunch++;
        this.lastLauncher = s.id;
        this.launchByBot.set(botId, l);
        this.slot.launches = [...this.slot.launches, l];
        return l;
      }
    }
    return null;
  }

  /**
   * K1: the break-throughs due by `now + BREAK_LOOKAHEAD_MS` on the ships'
   * own courses: each flying ship's next touch of every standing obstacle
   * its lane plans to smash (fleetplan.ts breakTouchIn), once each. The
   * ship's damage is queued for the touch (landed by `tick`).
   */
  dueBreaks(now: number, resolve: BreakResolver): FleetBreak[] {
    const out: FleetBreak[] = [];
    const to = now + BREAK_LOOKAHEAD_MS;
    const live = new Set<string>();
    for (const ship of this.slot.ships) {
      if (!shipPresent(ship, now)) continue;
      const breaks = laneBreaks(ship.lane);
      for (let k = 0; k < breaks.length; k++) {
        const brk = breaks[k] as LaneBreak;
        const key = `${ship.id}:${k}`;
        live.add(key);
        const got = resolve(brk, now);
        if (!got) continue;
        let scan = this.breakScan.get(key);
        if (!scan) {
          scan = { searched: Math.max(now, ship.t0), touch: null };
          this.breakScan.set(key, scan);
        }
        if (scan.touch === null && scan.searched < to) {
          scan.touch = breakTouchIn(ship, brk, got.obstacle, scan.searched, to);
          scan.searched = to;
        }
        const touch = scan.touch;
        if (touch === null) continue;
        // This pass is spoken for: the next search starts past it.
        scan.touch = null;
        scan.searched = breakPassEnd(ship, brk, touch);
        const at = Math.max(now, touch - BREAK_LEAD_MS);
        // Already down (felled before, by anything): nothing to smash.
        const standing = resolve(brk, at);
        if (!standing?.standing || !shipPresent(ship, touch)) continue;
        out.push({ ship, brk, obstacle: standing.obstacle, at, touch });
        this.breakHurt.push([
          ship.id,
          touch,
          Math.round(ship.hp0 * BREAK_DAMAGE_SHARE),
        ]);
      }
    }
    for (const key of [...this.breakScan.keys()]) {
      if (!live.has(key)) this.breakScan.delete(key);
    }
    return out;
  }

  /**
   * K1: the city's AA nests hit ship `id` for `dmg` at `now`: chip damage
   * that never takes a ship under AA_SHIP_FLOOR of its full HP — the kill
   * stays the pilots'. Returns the HP taken.
   */
  aaChip(id: number, dmg: number, now: number): number {
    const s = this.activeShip(id, now);
    const hp = this.hp.get(id) ?? 0;
    if (!s || !(dmg > 0)) return 0;
    const floor = Math.ceil(s.hp0 * AA_SHIP_FLOOR);
    const next = Math.max(floor, hp - dmg * AA_SHIP_SCALE);
    if (next >= hp) return 0;
    this.hp.set(id, next);
    this.hpChanged.add(id);
    return hp - next;
  }

  /** K1: land the break damage due by `now` (never the kill). */
  private landBreakHurt(now: number): void {
    if (this.breakHurt.length === 0) return;
    const left: [number, number, number][] = [];
    for (const e of this.breakHurt) {
      const [id, t, dmg] = e;
      if (t > now) {
        left.push(e);
        continue;
      }
      const s = this.activeShip(id, now);
      const hp = this.hp.get(id) ?? 0;
      if (!s || hp <= 1) continue;
      this.hp.set(id, Math.max(1, hp - dmg));
      this.hpChanged.add(id);
    }
    this.breakHurt = left;
  }

  /** S9: the launch `botId` is waiting on, or null. */
  launchOf(botId: string): BossLaunch | null {
    return this.launchByBot.get(botId) ?? null;
  }

  /** S9: `botId` left its rig (released, or fell back to a street spawn). */
  released(botId: string): void {
    this.launchByBot.delete(botId);
  }

  /** The fleet's first fill, then each downed lane's refill. */
  private schedule(
    now: number,
    planes: readonly BossPlane[],
    out: BossTickResult,
  ): void {
    if (!this.started) {
      this.started = true;
      // The sky is full the moment the war begins: every lane, seeded spots.
      FLEET_LANES.forEach((lane, i) => {
        const len = (FLEET_LAYERS[lane.layer] as { length: number }).length;
        const s0 = Math.round(this.rand() * len * 10) / 10;
        out.started.push(this.comeOn(i, now, s0 >= len ? 0 : s0));
      });
      return;
    }
    for (let lane = 0; lane < FLEET_LANES.length; lane++) {
      const due = this.refillAt[lane];
      if (due === null || due === undefined || now < due) continue;
      if (now < (this.refillTry[lane] as number)) continue;
      this.refillTry[lane] = now + REFILL_TRY_MS;
      const spot = hiddenLaneSpot(
        lane,
        planes.map((p) => p.pos),
        this.rand(),
      );
      const late = now >= due + this.tuning.refillWaitMs;
      if (spot.clear < FLEET_HIDE_M && !late) continue;
      out.started.push(this.comeOn(lane, now, spot.s0));
    }
  }

  private comeOn(lane: number, now: number, s0: number): FleetShip {
    const cls = (FLEET_LANES[lane] as { cls: 0 | 1 | 2 }).cls;
    const ship: FleetShip = {
      id: this.nextShip++,
      lane,
      t0: Math.round(now),
      s0,
      hp0: shipFullHp(cls, this.tuning.hpScale),
      down: null,
    };
    this.slot.ships.push(ship);
    this.hp.set(ship.id, ship.hp0);
    this.refillAt[lane] = null;
    const guns = (SHIP_CLASSES[cls] as { turrets: readonly number[] }).turrets;
    if (guns.length > 0) {
      this.turrets.set(
        ship.id,
        guns.map((k, j) => ({
          k,
          targetId: null,
          since: now,
          // Staggered across the fleet, so its guns never open up in one
          // volley.
          nextFireAt:
            now + ((ship.id * 7 + j * 3) % 10) * (BOSS_FLAK_INTERVAL_MS / 10),
        })),
      );
    }
    return ship;
  }

  private fireTurrets(
    now: number,
    planes: readonly BossPlane[],
    world: BossWorld,
    out: BossTickResult,
  ): void {
    if (planes.length === 0) return;
    for (const [id, guns] of this.turrets) {
      const ship = this.activeShip(id, now);
      if (!ship) continue;
      if (!guns.some((g) => now >= g.nextFireAt)) continue;
      const cls = shipClass(ship);
      const pose: ShipPose = fleetPoseAt(ship, now, this.pose);
      // Nothing in range of the ship at all: its guns hold.
      const reach = (SHIP_REACH[cls] as { r: number }).r + BOSS_FLAK_RANGE;
      if (!planes.some((p) => wrapDistance(pose, p.pos) <= reach)) continue;
      for (const turret of guns) {
        if (now < turret.nextFireAt) continue;
        const up = (BOSS_TURRETS[turret.k] as { up: 1 | -1 }).up;
        const muzzle = turretMuzzleInto(pose, cls, turret.k, this.at);
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
          from: {
            x: gridCoord(muzzle.x),
            y: Math.round(muzzle.y * 10) / 10,
            z: gridCoord(muzzle.z),
          },
          to: sol.to,
          t0: now,
          fuse: sol.fuse,
        };
        this.shells.push(shell);
        out.flak.push(shell);
        turret.nextFireAt = now + BOSS_FLAK_INTERVAL_MS;
      }
    }
  }

  /** Shells whose fuse ran out by `now`: hurt every plane in the burst,
   * under the per-second cap. A shell outlives its ship (it is in the
   * air). */
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
        const raw = flakDamage(wrapDistance(p.pos, f.to)) * FLEET_FLAK_SCALE;
        if (raw <= 0) continue;
        const damage = this.capped(p.id, raw, now);
        if (damage > 0) victims.push({ id: p.id, damage });
      }
      out.bursts.push({ flak: f, victims });
    }
    this.shells = left;
  }

  /** `raw` flak damage to `id` at `now`, cut to what its rolling second
   * still allows (BOSS_FLAK_DPS_CAP × FLEET_FLAK_SCALE); recorded. */
  private capped(id: string, raw: number, now: number): number {
    const log = (this.taken.get(id) ?? []).filter((e) => now - e.t < 1000);
    let sum = 0;
    for (const e of log) sum += e.dmg;
    const cap = BOSS_FLAK_DPS_CAP * FLEET_FLAK_SCALE;
    const damage = Math.max(0, Math.min(raw, cap - sum));
    if (damage > 0) log.push({ t: now, dmg: damage });
    this.taken.set(id, log);
    return damage;
  }

  /** Crashes that hit by `now` (once each), and the landed ones pruned. */
  private settleCrashes(
    now: number,
    out: BossTickResult,
    world: BossWorld,
  ): void {
    for (const s of this.slot.ships) {
      const d = s.down;
      if (!d || this.landedIds.has(s.id) || now < d.t + d.end) continue;
      this.landedIds.add(s.id);
      // Where and what it hit were swept at the down, against the city as
      // it stood then (another crash's landing must not move them).
      const top = this.topDealer(s.id);
      out.landed.push({
        ship: s,
        at: d.at,
        building: d.b >= 0 ? (world.buildings[d.b] ?? null) : null,
        by: top,
      });
    }
    if (this.landedIds.size === 0) return;
    const keep = this.slot.ships.filter((s) => {
      const d = s.down;
      return !(d && now >= d.t + d.end + LANDED_TAIL_MS);
    });
    if (keep.length === this.slot.ships.length) return;
    for (const s of this.slot.ships) {
      if (keep.includes(s)) continue;
      this.landedIds.delete(s.id);
      this.hp.delete(s.id);
      this.damageBy.delete(s.id);
    }
    this.slot.ships = keep;
  }

  /** The pilot who dealt ship `id` the most, or null. */
  private topDealer(id: number): string | null {
    let top: string | null = null;
    let most = 0;
    for (const [who, v] of this.damageBy.get(id) ?? []) {
      if (v > most || (v === most && top !== null && who < top)) {
        most = v;
        top = who;
      }
    }
    return top;
  }

  /**
   * Is a round from `origin` along unit `dir`, meeting ship `id`'s weak
   * point `k` (or its hull, −1) at server time `t`, a fair hit? The ship
   * must be intact and in the air at `t` (shipHitValid).
   */
  validHit(id: number, k: number, origin: Vec3, dir: Vec3, t: number): boolean {
    const s = this.activeShip(id, t);
    if (!s) return false;
    return shipHitValid(
      fleetPoseAt(s, t, this.pose),
      shipClass(s),
      k,
      origin,
      dir,
    );
  }

  /**
   * One validated round on ship `id` (weak point `k`, or its hull −1) by
   * `shooterId` at `now`: its damage off the ship's HP, credited. Reaching
   * zero brings it down — its crash swept against `world` right here, once,
   * and its lane due a refill. Null when nothing was applied (no such ship
   * up).
   */
  damage(
    shooterId: string,
    id: number,
    k: number,
    now: number,
    world: BossSweepWorld,
  ): ShipHitResult | null {
    const s = this.activeShip(id, now);
    const left = this.hp.get(id) ?? 0;
    if (!s || !(left > 0)) return null;
    const dealt = Math.min(left, shipRoundDamage(k));
    const hp = left - dealt;
    this.hp.set(id, hp);
    let ledger = this.damageBy.get(id);
    if (!ledger) {
      ledger = new Map();
      this.damageBy.set(id, ledger);
    }
    ledger.set(shooterId, (ledger.get(shooterId) ?? 0) + dealt);
    this.hpChanged.add(id);
    let down: ShipDown | null = null;
    if (hp <= 0) {
      down = shipCrash(s, now, world);
      s.down = down;
      this.downCount++;
      this.turrets.delete(id);
      this.refillAt[s.lane] = Math.max(
        now + this.tuning.refillMs,
        down.t + down.end,
      );
      // Its rigs go with it.
      this.slot.launches = this.slot.launches.filter(
        (l) => l.ship !== id || launchReleaseAt(l) <= now,
      );
    }
    return { ship: s, hp, down };
  }

  /** Damage dealt to ship `id`, by pilot (the credit split's input). */
  damageLedger(id: number): ReadonlyMap<string, number> {
    return this.damageBy.get(id) ?? new Map();
  }
}

/** A shooter-side `bossHit` claim's fields, shape-checked by the caller. */
export interface BossHitClaim {
  ship: number;
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
 * BOSS_CLAIM_LOOKBACK_MS; then the round's line is re-run against the ship
 * at that time. Null when refused.
 */
export function claimBossHit(
  combat: Combat,
  fleet: FleetDirector,
  shooterId: string,
  claim: BossHitClaim,
  shooterPos: Vec3,
  now: number,
  world: BossSweepWorld,
  shooterCap?: SpeedCapFn,
): ShipHitResult | null {
  const { ship, wp, dir } = claim;
  if (!Number.isInteger(ship)) return null;
  if (!Number.isInteger(wp) || wp < -1 || wp >= BOSS_WEAK_POINTS.length) {
    return null;
  }
  const len = Math.hypot(dir.x, dir.y, dir.z);
  if (!(Math.abs(len - 1) < 1e-3)) return null;
  const t = Math.min(now, Math.max(now - BOSS_CLAIM_LOOKBACK_MS, claim.t));
  // Cheap refusal first: no such ship up then.
  if (!fleet.activeShip(ship, t) || !fleet.activeShip(ship, now)) return null;
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
  if (!fleet.validHit(ship, wp, claim.origin, dir, t)) return null;
  return fleet.damage(shooterId, ship, wp, now, world);
}

/** The ship and weak point a bot contact id names, or null (not a fleet
 * contact). */
export function bossContactIndex(
  id: string,
): { ship: number; k: number } | null {
  if (!id.startsWith(BOSS_CONTACT_PREFIX)) return null;
  const [s, k] = id.slice(BOSS_CONTACT_PREFIX.length).split(":").map(Number);
  if (!Number.isInteger(s) || !Number.isInteger(k)) return null;
  return (k as number) >= 0 && (k as number) < BOSS_WEAK_POINTS.length
    ? { ship: s as number, k: k as number }
    : null;
}

/**
 * A bot round that met a ship's weak point this tick (F4's swept rounds):
 * the same judgement as a player's claim — the round spent through Combat,
 * its line re-run against the ship at `now` — then applied. Null when
 * refused.
 */
export function landBotBossRound(
  combat: Combat,
  fleet: FleetDirector,
  round: BotRoundHit,
  now: number,
  world: BossSweepWorld,
): ShipHitResult | null {
  const c = bossContactIndex(round.shot.targetId);
  if (!c) return null;
  return claimBossHit(
    combat,
    fleet,
    round.shot.botId,
    {
      ship: c.ship,
      wp: c.k,
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

/** D2/D3: a crash hit at `at`: blow out the room city's chunks around it,
 * and — when it came down on a building — shear the floor band
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
  /** P1: the section's velocity as it hit and the server time: it ploughs
   * on through what it hit (sweepBlast) and the big blast lands where it
   * comes to rest. Omitted: the blast lands at `at` at once. */
  sweep?: { vel: Vec3; now: number },
): number[] {
  const out: number[] = [];
  if (sweep) {
    const rec = makeImpact(IMPACT_SECTION, sweep.now, at, sweep.vel);
    const blast = { r: BOSS_IMPACT_RADIUS, damage: BOSS_IMPACT_DAMAGE };
    sweepBlast(city, rec, by, 0, blast);
  } else {
    out.push(
      ...city.damage.damageAt(at, BOSS_IMPACT_RADIUS, BOSS_IMPACT_DAMAGE),
    );
    blastProps(city, at, BOSS_IMPACT_RADIUS, BOSS_IMPACT_DAMAGE, by); // D9
  }
  if (building) out.push(...crushUnder(city, building, at));
  for (const id of out) city.breakers.set(chunkBuilding(id), by);
  return out;
}

/** K1: a ship downed over an avenue comes down between its streetwalls:
 * as it lands its flanks plough into both — a P1 sweep out of each side of
 * the hull (FLANK_SPEED across, carried on along the street by its fall),
 * landing FLANK_BLAST where each comes to rest. Credited like the crash.
 * Deterministic in the city, the crash and the time. */
export const FLANK_SPEED = 14;
export const FLANK_BLAST = { r: 16, damage: 900 };
export function applyFlankSweeps(
  city: RoomCity,
  ship: FleetShip,
  at: Vec3,
  vel: Vec3,
  by: string | null,
  now: number,
): void {
  const d = ship.down;
  if (!d) return;
  const pose = fleetPoseAt(ship, d.t + d.end, blankPose());
  // Port of the heading (hx, hz) in plan view.
  const ax = pose.hz;
  const az = -pose.hx;
  const reach = SHIP_REACH[shipClass(ship)] as { y: number; z: number };
  for (const side of [-1, 1]) {
    const rec = makeImpact(
      IMPACT_SECTION,
      now,
      {
        x: at.x + ax * side * reach.z * 0.5,
        y: Math.max(2, at.y + reach.y * 0.5),
        z: at.z + az * side * reach.z * 0.5,
      },
      {
        x: ax * side * FLANK_SPEED + vel.x * 0.5,
        y: 0,
        z: az * side * FLANK_SPEED + vel.z * 0.5,
      },
    );
    sweepBlast(city, rec, by, 0, FLANK_BLAST);
  }
}

/** The floor band BOSS_CRUSH_DEPTH floors under where a crash hit building
 * `b` at `at` — counted down through the tiers, so a squat crown shears
 * the tier under it — destroyed across that tier's footprint. Nothing when
 * there are not that many floors under the hit. */
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
