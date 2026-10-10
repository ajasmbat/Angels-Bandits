// W1 Carrier War, server side: one RoomWaves per room. Every enemy plane is
// launched by the room's war-zeppelin carrier (S9's belly trapeze and
// dorsal catapult) as part of a WAVE, and hunts the humans. There are no
// free-roaming bots any more. index.ts and the tests drive exactly this, so
// what the tests check is what the live server does.
//
// An enemy's life:
//  - LAUNCH: while the carrier is on station a wave asks for planes; each
//    one is planned on a free rig for the id the next RoomBots spawn will
//    mint (BossDirector.planLaunch, its release run cleared by
//    RoomBots.launchClear), then spawned DEAD on the rig: in Combat with
//    its respawn due at the release (Combat.addAwaiting), in the roster,
//    and announced (`playerJoined`, `bossLaunch`);
//  - RELEASE: index.ts's respawn pass hands the due id to release(), which
//    flies it off the rig (S9's launch pose, stick-neutral grace) — or, when
//    its carrier is gone, despawns it;
//  - HUNT: the brain's contacts are the flying humans only (humanContacts)
//    and each enemy hunts its quarry (assignQuarries: nearest, spread);
//  - DOWN: any death the room settles is reported here (downed) — the
//    onEnemyDowned hook — and after its kill-cam the plane's respawn falls
//    due with no launch: release() despawns it. Nothing ever street-spawns
//    or relaunches a downed enemy.
//
// A wave: WAVE_BREATHER (the banner) → WAVE_LIVE (launching, then fighting)
// → over when every plane of it is down → the next wave's breather. The
// carrier going down scuttles every enemy it launched (no credit, no wreck)
// and the war waits for the next carrier, one tier up. The last human out
// (reset) or the war switched off (a lab, AB_WAVES=0) despawns everything.

import {
  type BossLaunch,
  type BossRaid,
  LAUNCH_GRACE_MS,
  LAUNCH_SEQ_MS,
  encodeLaunch,
  launchReleaseAt,
  launchSpawnAt,
  raidTier,
} from "@angels-bandits/common/boss";
import { mulberry32 } from "@angels-bandits/common/city";
import type {
  RosterEntry,
  ServerMsg,
  SpawnState,
} from "@angels-bandits/common/protocol";
import {
  INTENSITY_DEFAULT,
  type Intensity,
  WAVE_BREATHER,
  WAVE_BREATHER_MS,
  WAVE_FIRST_DELAY_MS,
  WAVE_IDLE,
  WAVE_LIVE,
  type WaveState,
  assignQuarries,
  encodeWaves,
  idleWaves,
  nextWaveSize,
  waveGrade,
} from "@angels-bandits/common/waves";
import type { Vec3 } from "@angels-bandits/common/world";
import type { BossDirector } from "./boss";
import type { BotContact, RoomBots } from "./bots";
import type { Combat, Death } from "./combat";

/** One enemy plane: who launched it, in which wave. The seam later tickets
 * build on (enemy bombs, rooftop AA, juice). */
export interface EnemyPlane {
  id: string;
  /** The raid id of the carrier that launched it. */
  carrier: number;
  /** Its wave, 1-based. */
  wave: number;
  /** When its launch was planned, server ms. */
  launchedAt: number;
  /** Down (shot, crashed, scuttled) and waiting out its kill-cam. */
  down: boolean;
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

/** Launches a tick may plan, at most (two rigs). */
const LAUNCHES_PER_TICK = 2;
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

  constructor(
    seed: number,
    private readonly bots: RoomBots,
    private readonly boss: BossDirector,
    private readonly combat: Combat,
    private readonly host: WaveHost,
  ) {
    this.rand = mulberry32((seed ^ 0x3a7e5) >>> 0);
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
    const tier = this.boss.slot.raid ? raidTier(this.boss.slot.raid) : 0;
    return {
      wave: this.wave,
      phase: this.phase,
      at: this.phaseAt,
      left: this.left(),
      size: this.size,
      tier,
    };
  }

  /** Enemies left in the live wave: up (or on a rig) plus still to launch. */
  private left(): number {
    if (this.phase !== WAVE_LIVE) return 0;
    let n = this.toLaunch;
    for (const e of this.enemyById.values()) {
      if (!e.down && e.wave === this.wave) n++;
    }
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
    const raid = this.boss.activeRaid(now);
    // A carrier on station: its first wave after a beat. A breather with no
    // carrier left (it flew off) waits for the next one.
    if (this.phase === WAVE_IDLE && raid) {
      this.beginBreather(now + WAVE_FIRST_DELAY_MS);
    } else if (this.phase === WAVE_BREATHER && !raid) {
      this.idle(now);
    }
    if (this.phase === WAVE_BREATHER && now >= this.phaseAt) {
      if (raid && humans.length > 0) this.beginWave(now);
    }
    if (this.phase === WAVE_LIVE) {
      if (raid && humans.length > 0) this.launch(now, raid);
      // The carrier flew off still owing planes: the wave is what is up.
      if (!raid) this.toLaunch = 0;
      if (this.left() === 0) {
        this.lastSize = this.size;
        if (raid) this.beginBreather(now + WAVE_BREATHER_MS);
        else this.idle(now);
      }
    }
    this.hunt(humans);
    this.broadcast();
  }

  /** The carrier went down: every enemy it launched goes with it — the
   * ones in the air scuttled (no credit, no wreck), the ones still on a
   * rig gone at once — and the war waits for the next carrier. */
  carrierDown(raid: BossRaid, now: number): void {
    for (const e of [...this.enemyById.values()]) {
      if (e.carrier !== raid.id || e.down) continue;
      if (!this.combat.isAlive(e.id)) {
        this.despawn(e.id);
        continue;
      }
      const death = this.combat.scuttle(e.id, now);
      if (death) {
        this.bots.setDead(e.id);
        this.host.death(death, now);
      }
    }
    if (this.phase === WAVE_LIVE) this.lastSize = this.size;
    this.toLaunch = 0;
    this.idle(now);
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
    const launch = this.boss.launchOf(id);
    const raid = this.boss.slot.raid;
    if (launch && !e.down) {
      const at = launchReleaseAt(launch);
      if (now < at && this.boss.activeRaid(now)) return "wait";
      this.boss.released(id);
      if (raid?.id === launch.raid && this.boss.activeRaid(now)) {
        return this.fly(id, raid, launch, now);
      }
    }
    this.despawn(id);
    return null;
  }

  /** Everything off: every enemy despawned, the war idle, wave 1 next. */
  reset(now: number): void {
    for (const id of [...this.enemyById.keys()]) this.despawn(id);
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
    raid: BossRaid,
    l: BossLaunch,
    now: number,
  ): SpawnState {
    const sp = launchSpawnAt(raid, l);
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

  /** Plan this tick's launches: up to LAUNCHES_PER_TICK, one per free rig,
   * each cleared; a refusal waits for the next tick. */
  private launch(now: number, raid: BossRaid): void {
    for (let n = 0; n < LAUNCHES_PER_TICK && this.toLaunch > 0; n++) {
      const id = this.bots.nextId();
      const l = this.boss.planLaunch(id, now + LAUNCH_LEAD_MS, now, (r, l) => {
        const sp = launchSpawnAt(r, l);
        return this.bots.launchClear(
          { pos: sp.pos, yaw: sp.yaw, speed: sp.speed },
          sp.pitch,
          LAUNCH_GRACE_MS[l.kind] as number,
          launchReleaseAt(l),
        );
      });
      if (!l) return;
      const sp = launchSpawnAt(raid, l);
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
        carrier: raid.id,
        wave: this.wave,
        launchedAt: now,
        down: false,
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
      const c = this.bots.contactOf(e.id);
      if (c) flying.push({ id: e.id, pos: c.pos });
    }
    this.bots.setQuarries(assignQuarries(flying, humans));
  }

  private despawn(id: string): void {
    this.enemyById.delete(id);
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
