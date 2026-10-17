// W1 Carrier War, server side: one RoomWaves per room. Every enemy plane is
// launched by one of the room's airships (Z1: S9's belly trapeze on every
// ship, the dorsal catapult on the carriers — whichever ship is near a
// human) as part of a WAVE, and hunts the humans. There are no free-roaming
// bots any more. index.ts and the tests drive exactly this, so what the
// tests check is what the live server does.
//
// An enemy's life:
//  - LAUNCH: while the fleet is up a wave asks for planes; each one is
//    planned on a free rig of a ship near a human for the id the next
//    RoomBots spawn will mint (FleetDirector.planLaunch, its release run
//    cleared by
//    RoomBots.launchClear), then spawned DEAD on the rig: in Combat with
//    its respawn due at the release (Combat.addAwaiting), in the roster,
//    and announced (`playerJoined`, `bossLaunch`);
//  - RELEASE: index.ts's respawn pass hands the due id to release(), which
//    flies it off the rig (S9's launch pose, stick-neutral grace) — or, when
//    its ship went down first, despawns it;
//  - HUNT: the brain's contacts are the flying humans only (humanContacts)
//    and each enemy hunts its quarry (assignQuarries: nearest, spread);
//  - DOWN: any death the room settles is reported here (downed) — the
//    onEnemyDowned hook — and after its kill-cam the plane's respawn falls
//    due with no launch: release() despawns it. Nothing ever street-spawns
//    or relaunches a downed enemy.
//
// A wave: WAVE_BREATHER (the banner) → WAVE_LIVE (launching, then fighting)
// → over when every plane of it is down → the next wave's breather. Z1: a
// ship going down takes the planes still on its rigs with it; the ones it
// already launched fight on. The last human out (reset) or the war switched
// off (a lab, AB_WAVES=0) despawns everything.
//
// E1 the AIR FORCE: while the fleet is up and a human flies, the room also
// keeps its level's air force in the sky (common/src/waves.ts AIR_FORCE,
// less the wave's own planes): SQUADRONS (server/src/squadrons.ts), each
// launched off one rig like a wave plane — every plane of it waiting on the
// rig, the whole squadron released together — and refilled as they go
// down. They are not the wave (its `left` never counts them): a wave stays
// its W1 aces, the air force is the sky it is fought in. fly() flies them
// each tick (flyForce), before the brain's own tick; their nearest planes promote to
// aces (up to the room's ace cap less the wave's planes).

import {
  type BossLaunch,
  type FleetShip,
  LAUNCH_GRACE_MS,
  LAUNCH_SEQ_MS,
  SHIP_REACH,
  blankPose,
  encodeLaunch,
  fleetPoseAt,
  launchReleaseAt,
  launchSpawnAt,
  shipClass,
} from "@angels-bandits/common/boss";
import { mulberry32 } from "@angels-bandits/common/city";
import { WORLD_SIZE } from "@angels-bandits/common/constants";
import type {
  RosterEntry,
  ServerMsg,
  SpawnState,
} from "@angels-bandits/common/protocol";
import {
  SQUAD_CRUISE_CAP,
  SQUAD_FLOOR_ALT,
  SQUAD_SIZE,
  SQUAD_SPEED_MIN,
  aceCap,
  floorAhead,
} from "@angels-bandits/common/squadron";
import {
  INTENSITY_DEFAULT,
  type Intensity,
  WAVE_BREATHER,
  WAVE_BREATHER_MS,
  WAVE_FIRST_DELAY_MS,
  WAVE_IDLE,
  WAVE_LIVE,
  type WaveState,
  airForceFor,
  assignQuarries,
  encodeWaves,
  idleWaves,
  nextWaveSize,
  waveGrade,
} from "@angels-bandits/common/waves";
import type { Vec3 } from "@angels-bandits/common/world";
import type { FleetDirector } from "./boss";
import type { BotContact, BotShot, RoomBots } from "./bots";
import type { Combat, Death } from "./combat";
import type { DangerBudget } from "./danger";
import { RoomSquadrons, type SquadHuman, type SquadShip } from "./squadrons";

/** One enemy plane: who launched it, in which wave. The seam later tickets
 * build on (enemy bombs, rooftop AA, juice). */
export interface EnemyPlane {
  id: string;
  /** The id of the airship that launched it. */
  carrier: number;
  /** Its wave, 1-based. */
  wave: number;
  /** When its launch was planned, server ms. */
  launchedAt: number;
  /** Down (shot, crashed, scuttled) and waiting out its kill-cam. */
  down: boolean;
  /** E1: one of the air force's squadron planes (its `wave` is the wave on
   * at its launch, but it is never the wave's). */
  squad: boolean;
}

/** `by`: the killer's id (a pilot, BOSS_ID, MISSILE_SHOOTER_ID…) or null. */
export type EnemyDownedListener = (
  enemy: EnemyPlane,
  by: string | null,
  cause: Death["cause"],
  now: number,
) => void;

/** What RoomWaves needs from the room that it does not own. */
export interface WaveHost {
  /** A new enemy joins the roster (rooms.addBot + `playerJoined`). */
  addEnemy(entry: RosterEntry, now: number): void;
  /** An enemy leaves the room for good: every per-plane record forgotten,
   * the roster left, `playerLeft` sent. RoomWaves has already removed it
   * from RoomBots, Combat and the carrier. */
  removeEnemy(id: string): void;
  /** Broadcast to the room. */
  send(msg: ServerMsg): void;
  /** Settle a scuttle's death: broadcast it like any other (no wreck, no
   * city blast) — the room's death path calls downed() back. */
  death(death: Death, now: number): void;
}

/** A flying human as the war sees it: on-record position and velocity. */
export interface WaveHuman {
  id: string;
  pos: Vec3;
  vel: Vec3;
  prot: boolean;
  hp: number;
}

/** Launches a tick may plan, at most. */
const LAUNCHES_PER_TICK = 2;
/** E1: squadron launches a tick may plan, at most (after the wave's). */
const SQUAD_LAUNCHES_PER_TICK = 2;
/** E1 (AB_AIRFORCE): staged squadrons a tick may put in the air — the
 * live launch pace, so a bench's refills cost what a room's do. */
const STAGED_PER_TICK = SQUAD_LAUNCHES_PER_TICK;
/** A launch is planned to release this long after it is planned, ms (the
 * longer of the two rigs' sequences, so either rig can take it). */
const LAUNCH_LEAD_MS = Math.max(...LAUNCH_SEQ_MS);

/** The bot contact list for a carrier war: the flying humans and nothing
 * else — no other enemy, no weak point of the carrier. */
export function humanContacts(humans: readonly WaveHuman[]): BotContact[] {
  return humans.map((h) => ({
    id: h.id,
    pos: h.pos,
    vel: h.vel,
    prot: h.prot,
    hp: h.hp,
  }));
}

export class RoomWaves {
  /** The room's enemy intensity; read at each wave's start. */
  intensity: Intensity = INTENSITY_DEFAULT;
  private readonly rand: () => number;
  private readonly enemyById = new Map<string, EnemyPlane>();
  private readonly listeners: EnemyDownedListener[] = [];
  /** The wave on or coming (1-based; 0 before any), and waves started. */
  private wave = 0;
  private started = 0;
  private phase: WaveState["phase"] = WAVE_IDLE;
  private phaseAt = 0;
  /** Planes the live wave has still to launch, and its size. */
  private toLaunch = 0;
  private size = 0;
  /** The last wave size (the next one grows from it), null before any. */
  private lastSize: number | null = null;
  /** What was last broadcast, to send only changes. */
  private sent = "";
  /** E1: the room's squadrons — its air force. */
  readonly squadrons: RoomSquadrons;
  /** E1: field the level's air force (off: the W1 waves alone — a lab
   * without it, the W1 tests). */
  airForce = true;
  /** E1 (AB_AIRFORCE=n, the benches): put an air force of exactly this
   * many planes in the air at once, off no rig; null in a live room. */
  staged: number | null = null;

  constructor(
    seed: number,
    private readonly bots: RoomBots,
    private readonly boss: FleetDirector,
    private readonly combat: Combat,
    private readonly host: WaveHost,
  ) {
    this.rand = mulberry32((seed ^ 0x3a7e5) >>> 0);
    this.squadrons = new RoomSquadrons(seed, bots, combat, bots.roofline());
  }

  /** Every enemy in the room (alive, on a rig, or down in its kill-cam). */
  enemies(): readonly EnemyPlane[] {
    return [...this.enemyById.values()];
  }

  enemy(id: string): EnemyPlane | null {
    return this.enemyById.get(id) ?? null;
  }

  /** "Enemy downed by X": called for every enemy death, once. */
  onEnemyDowned(listener: EnemyDownedListener): void {
    this.listeners.push(listener);
  }

  /** The HUD's view of the war. */
  state(): WaveState {
    return {
      wave: this.wave,
      phase: this.phase,
      at: this.phaseAt,
      left: this.left(),
      size: this.size,
      downs: this.boss.downs(),
      force: this.forceUp(),
    };
  }

  /** Enemies left in the live wave: up (or on a rig) plus still to launch. */
  private left(): number {
    if (this.phase !== WAVE_LIVE) return 0;
    let n = this.toLaunch;
    for (const e of this.enemyById.values()) {
      if (!e.down && !e.squad && e.wave === this.wave) n++;
    }
    return n;
  }

  /** E1: the air force's planes up (in the air or on a rig). */
  private forceUp(): number {
    let n = 0;
    for (const e of this.enemyById.values()) if (e.squad && !e.down) n++;
    return n;
  }

  /** E1: the wave's planes up (in the air or on a rig). */
  private wavePlanesUp(): number {
    let n = 0;
    for (const e of this.enemyById.values()) if (!e.squad && !e.down) n++;
    return n;
  }

  /**
   * One tick, after the carrier's own. `on`: the war is on in this room
   * (AB_WAVES and, in a lab, its toggle). `humans`: the humans flying now.
   */
  tick(now: number, on: boolean, humans: readonly WaveHuman[]): void {
    if (!on) {
      this.reset(now);
      return;
    }
    const up = this.boss.anyUp(now);
    // The fleet over the room: its first wave after a beat. A breather with
    // no ship left waits for the refills.
    if (this.phase === WAVE_IDLE && up) {
      this.beginBreather(now + WAVE_FIRST_DELAY_MS);
    } else if (this.phase === WAVE_BREATHER && !up) {
      this.idle(now);
    }
    if (this.phase === WAVE_BREATHER && now >= this.phaseAt) {
      if (up && humans.length > 0) this.beginWave(now);
    }
    if (this.phase === WAVE_LIVE) {
      if (up && humans.length > 0) this.launch(now, humans);
      if (this.left() === 0) {
        this.lastSize = this.size;
        this.beginBreather(now + WAVE_BREATHER_MS);
      }
    }
    // E1: the air force, between waves too, while the fleet is over the
    // room and someone flies.
    if (this.airForce && this.phase !== WAVE_IDLE && humans.length > 0) {
      if (this.staged !== null) this.stageForce(now);
      else if (up) this.launchForce(now, humans);
    }
    this.hunt(humans);
    this.broadcast();
  }

  /**
   * E1: one tick of the air force — every squadron flown, its aces chosen,
   * its guns — after the respawn pass and before the brain's tick (index.ts
   * tickRoomBots). Returns its trigger pulls, routed like the brain's.
   */
  flyForce(
    now: number,
    dt: number,
    humans: readonly SquadHuman[],
    budget?: DangerBudget,
  ): BotShot[] {
    if (this.squadrons.count === 0) return [];
    const ships: SquadShip[] = [];
    for (const sh of this.boss.activeShips(now)) {
      const p = fleetPoseAt(sh, now, blankPose());
      const reach = SHIP_REACH[shipClass(sh)] as { xz: number; y: number };
      ships.push({
        id: sh.id,
        pos: { x: p.x, y: p.y, z: p.z },
        r: reach.xz,
        h: reach.y,
      });
    }
    // The wave's planes are aces whatever: the squadrons get what is left.
    const cap = Math.max(0, aceCap(humans.length) - this.wavePlanesUp());
    return this.squadrons.fly(
      now,
      dt,
      humans,
      ships,
      (id) => this.bots.runOf(id) !== null,
      cap,
      waveGrade(Math.max(1, this.wave), this.intensity).fire,
      budget,
    );
  }

  /** Z1: airship `ship` went down: the planes still on its rigs go with it
   * (gone at once — they never flew; the live wave launches them again
   * from another ship), and the ones it launched fight on. The fleet
   * counter rides the broadcast. */
  shipDown(ship: FleetShip): void {
    for (const e of [...this.enemyById.values()]) {
      if (e.carrier !== ship.id || e.down) continue;
      if (this.combat.isAlive(e.id)) continue;
      if (this.phase === WAVE_LIVE && e.wave === this.wave) this.toLaunch++;
      this.despawn(e.id);
    }
    this.broadcast();
  }

  /** The room settled `death` (any cause): mark an enemy down, once. */
  downed(death: Death, now: number): void {
    const e = this.enemyById.get(death.victimId);
    if (!e || e.down) return;
    e.down = true;
    for (const l of this.listeners) l(e, death.killerId, death.cause, now);
  }

  /**
   * `id`'s respawn fell due. An enemy whose launch is on: "wait" until its
   * release, then it flies off the rig — its spawn is returned for the
   * room's `respawn` broadcast. Anything else (shot down, or its carrier
   * gone): despawned, null. Not an enemy: undefined (a human's respawn).
   */
  release(id: string, now: number): SpawnState | "wait" | null | undefined {
    const e = this.enemyById.get(id);
    if (!e) return undefined;
    if (e.squad) return this.releaseSquad(e, now);
    const launch = this.boss.launchOf(id);
    if (launch && !e.down) {
      const ship = this.boss.activeShip(launch.ship, now);
      const at = launchReleaseAt(launch);
      if (now < at && ship) return "wait";
      this.boss.released(id);
      if (ship) return this.fly(id, ship, launch, now);
    }
    this.despawn(id);
    return null;
  }

  /** E1: a squadron plane's respawn fell due: on its rig, wait for the
   * release; at it, the whole squadron departs (the first of its planes
   * due carries it out) and each plane takes its slot. Downed, or its ship
   * gone: despawned. */
  private releaseSquad(e: EnemyPlane, now: number): SpawnState | "wait" | null {
    const id = e.id;
    if (!e.down) {
      const pending = this.squadrons.launchOf(id);
      if (pending) {
        const ship = this.boss.activeShip(pending.launch.ship, now);
        if (ship && now < launchReleaseAt(pending.launch)) return "wait";
        if (ship) {
          this.boss.released(pending.lead);
          this.squadrons.depart(id, launchSpawnAt(ship, pending.launch), now);
        }
      }
      if (this.squadrons.released(id)) {
        this.combat.respawned(id, now);
        const spawn = this.squadrons.join(id);
        if (spawn) return spawn;
      }
    }
    this.despawn(id);
    return null;
  }

  /** Everything off: every enemy despawned, the war idle, wave 1 next. */
  reset(now: number): void {
    for (const id of [...this.enemyById.keys()]) this.despawn(id);
    this.squadrons.reset();
    this.wave = 0;
    this.started = 0;
    this.lastSize = null;
    this.toLaunch = 0;
    this.size = 0;
    this.idle(now);
    this.broadcast();
  }

  private fly(
    id: string,
    ship: FleetShip,
    l: BossLaunch,
    now: number,
  ): SpawnState {
    const sp = launchSpawnAt(ship, l);
    const spawn = { pos: sp.pos, yaw: sp.yaw, speed: sp.speed };
    this.combat.respawned(id, now);
    this.bots.respawn(id, spawn, {
      pitch: sp.pitch,
      until: now + (LAUNCH_GRACE_MS[l.kind] as number),
    });
    return spawn;
  }

  /** The next wave's banner, its launches due at `startsAt`. */
  private beginBreather(startsAt: number): void {
    this.wave = this.started + 1;
    this.phase = WAVE_BREATHER;
    this.phaseAt = startsAt;
    this.size = 0;
    this.toLaunch = 0;
  }

  private beginWave(now: number): void {
    this.started = this.wave;
    this.size = nextWaveSize(this.lastSize, this.intensity, this.rand);
    this.toLaunch = this.size;
    this.phase = WAVE_LIVE;
    this.phaseAt = now;
  }

  private idle(now: number): void {
    this.phase = WAVE_IDLE;
    this.phaseAt = now;
    this.size = 0;
  }

  /** Plan this tick's launches: up to LAUNCHES_PER_TICK, each on a free
   * rig of a ship near a human, each cleared; a refusal waits for the next
   * tick. */
  private launch(now: number, humans: readonly WaveHuman[]): void {
    const near = humans.map((h) => h.pos);
    for (let n = 0; n < LAUNCHES_PER_TICK && this.toLaunch > 0; n++) {
      const id = this.bots.nextId();
      const l = this.boss.planLaunch(
        id,
        now + LAUNCH_LEAD_MS,
        now,
        near,
        (ship, l) => {
          const sp = launchSpawnAt(ship, l);
          return this.bots.launchClear(
            { pos: sp.pos, yaw: sp.yaw, speed: sp.speed },
            sp.pitch,
            LAUNCH_GRACE_MS[l.kind] as number,
            launchReleaseAt(l),
          );
        },
      );
      if (!l) return;
      const ship = this.boss.activeShip(l.ship, now);
      if (!ship) return;
      const sp = launchSpawnAt(ship, l);
      const entry = this.bots.spawn({
        pos: sp.pos,
        yaw: sp.yaw,
        speed: sp.speed,
      });
      // On the rig until its release: dead to everything, due back then.
      this.bots.setDead(entry.id);
      this.bots.setGrade(entry.id, waveGrade(this.wave, this.intensity));
      this.combat.addAwaiting(entry.id, launchReleaseAt(l));
      this.enemyById.set(entry.id, {
        id: entry.id,
        carrier: ship.id,
        wave: this.wave,
        launchedAt: now,
        down: false,
        squad: false,
      });
      this.toLaunch--;
      this.host.addEnemy(entry, now);
      this.host.send({ type: "bossLaunch", l: encodeLaunch(l), bot: entry.id });
    }
  }

  /** Each enemy in the air hunts a human (id order: stable). */
  private hunt(humans: readonly WaveHuman[]): void {
    const flying: { id: string; pos: Vec3 }[] = [];
    for (const e of this.enemyById.values()) {
      // E1: a squadron plane hunts nobody until it is an ace.
      if (e.squad && this.bots.isSquad(e.id)) continue;
      const c = this.bots.contactOf(e.id);
      if (c) flying.push({ id: e.id, pos: c.pos });
    }
    this.bots.setQuarries(assignQuarries(flying, humans));
  }

  /** E1: launch squadrons until the air force is at its level: up to
   * SQUAD_LAUNCHES_PER_TICK, each the rest of the shortfall up to
   * SQUAD_SIZE planes on one free rig of a ship near a human, its release
   * clear for a squadron (over the roofline) and for its lead's run. */
  private launchForce(now: number, humans: readonly WaveHuman[]): void {
    const near = humans.map((h) => h.pos);
    for (let n = 0; n < SQUAD_LAUNCHES_PER_TICK; n++) {
      const want =
        airForceFor(this.intensity, this.wavePlanesUp()) - this.forceUp();
      if (want <= 0) return;
      const lead = this.bots.nextId();
      const l = this.boss.planLaunch(
        lead,
        now + LAUNCH_LEAD_MS,
        now,
        near,
        (ship, l) => {
          const sp = launchSpawnAt(ship, l);
          return (
            this.squadrons.departClear(sp.pos, sp.yaw) &&
            this.bots.launchClear(
              { pos: sp.pos, yaw: sp.yaw, speed: sp.speed },
              sp.pitch,
              LAUNCH_GRACE_MS[l.kind] as number,
              launchReleaseAt(l),
            )
          );
        },
      );
      if (!l) return;
      const ship = this.boss.activeShip(l.ship, now);
      if (!ship) return;
      const sp = launchSpawnAt(ship, l);
      const ids = this.spawnSquad(Math.min(SQUAD_SIZE, want), ship.id, now, {
        pos: sp.pos,
        yaw: sp.yaw,
        speed: sp.speed,
      });
      for (const id of ids) this.combat.addAwaiting(id, launchReleaseAt(l));
      this.squadrons.add(ids, now, l);
      this.host.send({ type: "bossLaunch", l: encodeLaunch(l), bot: lead });
    }
  }

  /** E1 (AB_AIRFORCE): the staged air force — squadrons put straight into
   * the air over the city (no rig), due next tick, until there are
   * `staged` planes. */
  private stageForce(now: number): void {
    for (let n = 0; n < STAGED_PER_TICK; n++) {
      const want = (this.staged ?? 0) - this.forceUp();
      if (want <= 0) return;
      // A point whose roofline ahead it can cruise over (never beside a
      // spire it would have to climb into the deck to clear).
      const pos = { x: 0, y: 0, z: 0 };
      let yaw = 0;
      for (let tries = 0; tries < 16; tries++) {
        pos.x = this.rand() * WORLD_SIZE;
        pos.z = this.rand() * WORLD_SIZE;
        yaw = this.rand() * Math.PI * 2;
        pos.y = floorAhead(this.bots.roofline(), pos, yaw);
        if (pos.y <= SQUAD_CRUISE_CAP) break;
      }
      pos.y = Math.max(SQUAD_FLOOR_ALT, Math.min(pos.y, SQUAD_CRUISE_CAP));
      const ids = this.spawnSquad(Math.min(SQUAD_SIZE, want), -1, now, {
        pos,
        yaw,
        speed: SQUAD_SPEED_MIN,
      });
      for (const id of ids) this.combat.addAwaiting(id, now);
      this.squadrons.add(ids, now, null, { pos, yaw });
    }
  }

  /** E1: mint `n` squadron planes in one run (consecutive ids — the wire
   * derives slot k's id from slot 0's), dead until their release. */
  private spawnSquad(
    n: number,
    carrier: number,
    now: number,
    spawn: SpawnState,
  ): string[] {
    const ids: string[] = [];
    const grade = waveGrade(Math.max(1, this.wave), this.intensity);
    for (let k = 0; k < n; k++) {
      const entry = this.bots.spawn(spawn);
      this.bots.setDead(entry.id);
      this.bots.setGrade(entry.id, grade);
      ids.push(entry.id);
      this.enemyById.set(entry.id, {
        id: entry.id,
        carrier,
        wave: this.wave,
        launchedAt: now,
        down: false,
        squad: true,
      });
      this.host.addEnemy(entry, now);
    }
    return ids;
  }

  private despawn(id: string): void {
    this.enemyById.delete(id);
    this.squadrons.forget(id);
    this.bots.remove(id);
    this.combat.removePlayer(id);
    this.boss.forget(id);
    this.host.removeEnemy(id);
  }

  private broadcast(): void {
    const w = encodeWaves(this.state());
    const key = w.join(",");
    if (key === this.sent) return;
    this.sent = key;
    this.host.send({ type: "waves", w });
  }
}
