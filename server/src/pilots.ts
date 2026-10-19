// I1 Individual pilots, server side: the room's air force — the cheap tier
// that lets a wave field hundreds of real enemy planes, each one ALONE
// (common/src/pilots.ts is the shared brain, server/src/waves.ts the war
// that launches them).
//
// Every air-force plane is an ordinary RoomBots bot (roster, Combat,
// rounds — everything that already knows enemies) whose flight its pilot
// writes every tick (RoomBots.setPilotFlight), and goes on the wire as its
// own snapshot entry like any bot. Per tick, fly():
//
//  - every pilot in the air thinks, aims and flies (flyPilots: its own
//    intent and personality, terrain-following, airships and supertalls
//    avoided; a staggered fraction re-plans each tick);
//  - the aces are chosen (chooseAces): the pilots nearest the humans
//    PROMOTE to the full brain, up to aceCap(humans); an ace DEMOTES back
//    to its pilot — from the very flight it is in — only once it is past
//    every human's far plane, and never while on a bomb run;
//  - a pilot shoots only at a human in its forward cone at short range, in
//    bursts, each burst charged to that human's DangerBudget (layer
//    "pilot"): the air force adds to the danger the director already
//    rations, never past it.
//
// A pilot is LAUNCHED alone off one rig of one airship: it waits dead on
// the rig and leaves at its own release, on its own heading — the room's
// launches are planned one plane at a time with jittered releases, so the
// sky fills plane by plane.

import type { BossLaunch, launchSpawnAt } from "@angels-bandits/common/boss";
import { mulberry32 } from "@angels-bandits/common/city";
import type { FlightState } from "@angels-bandits/common/flight";
import {
  type AceCandidate,
  INTENT_FLEE,
  PILOT_FIRE_RANGE,
  PROMOTE_M,
  type Pilot,
  type PilotHuman,
  type PilotObstacle,
  type PilotShip,
  type PilotStats,
  type PilotWorld,
  type RooflineGrid,
  attitudeQuatInto,
  chooseAces,
  floorAhead,
  flyPilots,
  newPilot,
  pilotInCone,
  settlePilot,
} from "@angels-bandits/common/pilots";
import type { Pose, SpawnState } from "@angels-bandits/common/protocol";
import { type Vec3, wrapDeltaAxis } from "@angels-bandits/common/world";
import type { BotShot, RoomBots } from "./bots";
import type { Combat } from "./combat";
import type { DangerBudget } from "./danger";

/** A pilot's guns: a burst at one human lasts this long, ms… */
const BURST_MS = 900;
/** …and the same pilot starts no other within this, ms. */
const BURST_GAP_MS = 2500;
/** The tiers are chosen every this-many ticks (5 Hz): a promotion 200 ms
 * late is still 600 m out. */
const ACES_EVERY = 4;

export type { PilotHuman, PilotShip };

interface RoomPilot {
  p: Pilot;
  /** In the air (released, or staged). */
  flying: boolean;
  /** The rig launch that carries it, until released. */
  launch: BossLaunch | null;
  /** The flight and pose its plane is given (reused). */
  flight: FlightState;
  pose: Pose;
  /** When its burst ends / may start again, ms, and at whom. */
  burstUntil: number;
  burstNext: number;
  burstAt: string | null;
}

export class RoomPilots {
  private readonly pilots = new Map<string, RoomPilot>();
  /** The pilots the brain flies now (promoted, not yet handed back; a dead
   * one stays until it is forgotten). */
  private readonly aceIds = new Set<string>();
  private readonly rand: () => number;
  private nextIdx = 0;
  private ticks = 0;
  /** This tick's flying pilots (reused). */
  private readonly flown: Pilot[] = [];
  private readonly hpOf = (p: Pilot): number => this.combat.hpOf(p.id);
  /** Telemetry: hard-floor lifts (should stay ~0), promotions, demotions,
   * bursts started and refused by the budget. */
  readonly stats: PilotStats & {
    promotions: number;
    demotions: number;
    bursts: number;
    burstsRefused: number;
  } = {
    clamps: 0,
    promotions: 0,
    demotions: 0,
    bursts: 0,
    burstsRefused: 0,
  };

  constructor(
    seed: number,
    private readonly bots: RoomBots,
    private readonly combat: Combat,
    private readonly grid: RooflineGrid,
  ) {
    this.rand = mulberry32((seed ^ 0x5a17d00d) >>> 0);
  }

  /** Pilots in the room (up, on a rig or an ace). */
  get count(): number {
    return this.pilots.size;
  }

  /** Is `id` an air-force plane flown by the brain right now? */
  isAce(id: string): boolean {
    return this.pilots.has(id) && !this.bots.isPilot(id);
  }

  /** The aces in the room right now (ids). */
  aces(): string[] {
    const out: string[] = [];
    for (const id of this.aceIds) if (this.combat.isAlive(id)) out.push(id);
    return out;
  }

  /** The rig launch `id` leaves on, while it waits there. */
  launchOf(id: string): BossLaunch | null {
    const rp = this.pilots.get(id);
    return rp && !rp.flying ? rp.launch : null;
  }

  /**
   * A new pilot `id` waiting on its rig for `launch` — or, without one,
   * `staged` in the air already (AB_AIRFORCE: the bench's instant air
   * force). Its personality is a seeded draw of the room's.
   */
  add(
    id: string,
    now: number,
    launch: BossLaunch | null,
    staged?: { pos: Vec3; yaw: number; speed: number },
  ): void {
    const seed = Math.floor(this.rand() * 0xffffffff);
    const p = newPilot(
      id,
      this.nextIdx++,
      seed,
      staged?.pos ?? { x: 0, y: 0, z: 0 },
      staged?.yaw ?? 0,
      staged?.speed ?? 0,
    );
    const rp: RoomPilot = {
      p,
      flying: !!staged,
      launch,
      flight: {
        pos: { x: 0, y: 0, z: 0 },
        yaw: 0,
        pitch: 0,
        roll: 0,
        bank: 0,
        rollRate: 0,
        speed: 0,
        targetSpeed: 0,
      },
      pose: {
        pos: { x: 0, y: 0, z: 0 },
        quat: { x: 0, y: 0, z: 0, w: 1 },
        speed: 0,
      },
      burstUntil: 0,
      burstNext: now,
      burstAt: null,
    };
    this.pilots.set(id, rp);
    if (staged) this.pose(rp);
  }

  /** `id` leaves its rig at `spawn` (its launch's release pose) — or, staged,
   * from where it waits — and flies: the spawn the room broadcasts for it.
   * Null when it is not a pilot. */
  depart(
    id: string,
    spawn: ReturnType<typeof launchSpawnAt> | null,
  ): SpawnState | null {
    const rp = this.pilots.get(id);
    if (!rp) return null;
    const p = rp.p;
    if (spawn && !rp.flying) {
      p.pos.x = spawn.pos.x;
      p.pos.y = spawn.pos.y;
      p.pos.z = spawn.pos.z;
      p.yaw = spawn.yaw;
      p.steer = spawn.yaw;
      p.pitch = spawn.pitch;
      p.speed = spawn.speed;
    }
    rp.flying = true;
    rp.launch = null;
    this.pose(rp);
    this.bots.setPilotFlight(id, rp.flight, rp.pose);
    return { pos: { ...p.pos }, yaw: p.yaw, speed: p.speed };
  }

  /** Is a launch released at `pos` heading `yaw` clear for a pilot — over
   * the roofline it follows, along its first stretch? */
  departClear(pos: Vec3, yaw: number): boolean {
    return floorAhead(this.grid, pos, yaw) <= pos.y;
  }

  /** `id` is gone for good. */
  forget(id: string): void {
    this.pilots.delete(id);
    this.aceIds.delete(id);
  }

  /** Everything gone (the war off, the room empty). */
  reset(): void {
    this.pilots.clear();
    this.aceIds.clear();
  }

  /** Promote `id` now whatever the distances (a bomb run's pilot); false
   * when it is not a pilot in the air. */
  promote(id: string): boolean {
    const rp = this.pilots.get(id);
    if (!rp?.flying || !this.bots.isPilot(id)) return false;
    if (!this.combat.isAlive(id)) return false;
    this.bots.promote(id);
    this.aceIds.add(id);
    this.stats.promotions++;
    return true;
  }

  /**
   * One tick of every pilot in the air: brains and flights; then the aces;
   * then the guns. `locked`: aces that may not demote (on a bomb run).
   * `cap`: the aces the air force may field. `fire`: the chance a pilot's
   * lined-up burst is taken (its wave's grade). Returns this tick's trigger
   * pulls, for the room's bot fire path.
   */
  fly(
    now: number,
    dt: number,
    humans: readonly PilotHuman[],
    ships: readonly PilotShip[],
    locked: (id: string) => boolean,
    cap: number,
    fire: number,
    budget?: DangerBudget,
  ): BotShot[] {
    this.ticks++;
    const flown = this.flown;
    flown.length = 0;
    for (const rp of this.pilots.values()) {
      if (!rp.flying || !this.bots.isPilot(rp.p.id)) continue;
      if (!this.combat.isAlive(rp.p.id)) continue;
      flown.push(rp.p);
    }
    const world: PilotWorld = { now, humans, ships, grid: this.grid };
    const obstacles: readonly PilotObstacle[] = ships;
    flyPilots(flown, world, dt, this.ticks, this.hpOf, obstacles, this.stats);
    for (const p of flown) {
      const rp = this.pilots.get(p.id) as RoomPilot;
      this.pose(rp);
      this.bots.setPilotFlight(p.id, rp.flight, rp.pose);
    }
    if (this.ticks % ACES_EVERY === 0) {
      this.promoteAndDemote(humans, locked, cap);
    }
    return this.guns(now, humans, fire, budget);
  }

  /** The pilot's flight and pose for its plane. */
  private pose(rp: RoomPilot): void {
    const p = rp.p;
    const f = rp.flight;
    f.pos.x = p.pos.x;
    f.pos.y = p.pos.y;
    f.pos.z = p.pos.z;
    f.yaw = p.yaw;
    f.pitch = p.pitch;
    f.roll = p.roll;
    f.bank = p.roll;
    f.speed = p.speed;
    f.targetSpeed = p.speed;
    const pose = rp.pose;
    pose.pos.x = p.pos.x;
    pose.pos.y = p.pos.y;
    pose.pos.z = p.pos.z;
    attitudeQuatInto(p.yaw, p.pitch, p.roll, pose.quat);
    pose.speed = p.speed;
  }

  /** chooseAces over every plane in the air, then the hand-overs. */
  private promoteAndDemote(
    humans: readonly PilotHuman[],
    locked: (id: string) => boolean,
    cap: number,
  ): void {
    if (humans.length === 0 && this.aceIds.size === 0) return;
    const cands: AceCandidate[] = [];
    // The pilots within reach of a human…
    for (const p of this.flown) {
      if (!this.combat.isAlive(p.id)) continue;
      const dist = nearest(p.pos, humans);
      if (dist > PROMOTE_M) continue;
      cands.push({ id: p.id, dist, ace: false, locked: false });
    }
    // …and every ace, wherever it is.
    for (const id of this.aceIds) {
      const pos = this.bots.contactOf(id)?.pos;
      if (!pos) continue;
      cands.push({
        id,
        dist: nearest(pos, humans),
        ace: true,
        locked: locked(id),
      });
    }
    const { promote, demote } = chooseAces(cands, cap);
    for (const id of demote) {
      const rp = this.pilots.get(id);
      const f = this.bots.flightOf(id);
      if (!rp || !f) continue;
      // Its pilot takes over the flight the brain left it in.
      const p = rp.p;
      p.pos.x = f.pos.x;
      p.pos.y = f.pos.y;
      p.pos.z = f.pos.z;
      p.yaw = f.yaw;
      p.pitch = f.pitch;
      p.roll = f.roll;
      p.speed = f.speed;
      settlePilot(p, this.grid);
      this.pose(rp);
      this.bots.setPilotFlight(id, rp.flight, rp.pose);
      this.aceIds.delete(id);
      this.stats.demotions++;
    }
    for (const id of promote) {
      this.bots.promote(id);
      this.aceIds.add(id);
      this.stats.promotions++;
    }
  }

  /** The pilots' trigger pulls this tick. */
  private guns(
    now: number,
    humans: readonly PilotHuman[],
    fire: number,
    budget?: DangerBudget,
  ): BotShot[] {
    const shots: BotShot[] = [];
    if (humans.length === 0) return shots;
    for (const p of this.flown) {
      // A fleeing pilot runs; it does not turn to shoot.
      if (p.intent === INTENT_FLEE || !this.bots.isPilot(p.id)) continue;
      const rp = this.pilots.get(p.id) as RoomPilot;
      const fwd = forwardOf(p);
      for (const h of humans) {
        const dx = wrapDeltaAxis(p.pos.x, h.pos.x);
        const dz = wrapDeltaAxis(p.pos.z, h.pos.z);
        if (dx * dx + dz * dz > PILOT_FIRE_RANGE * PILOT_FIRE_RANGE) continue;
        if (!pilotInCone(p.pos, fwd, h.pos)) continue;
        if (now >= rp.burstUntil || rp.burstAt !== h.id) {
          // A new burst: the gap, its trigger discipline (the grade, and
          // the skilled hold out for a cleaner shot), and the human's
          // danger budget.
          if (now < rp.burstNext) continue;
          rp.burstNext = now + BURST_GAP_MS * (1.4 - p.persona.aggression);
          if (p.rand() >= fire * (0.6 + 0.4 * p.persona.aggression)) continue;
          if (budget && !budget.allowsIds("pilot", [h.id], now, [h])) {
            this.stats.burstsRefused++;
            continue;
          }
          budget?.chargeIds("pilot", [h.id], now);
          rp.burstUntil = now + BURST_MS;
          rp.burstAt = h.id;
          this.stats.bursts++;
        }
        const shot = this.bots.pilotShot(p.id, h.id);
        if (shot) shots.push(shot);
        break;
      }
    }
    return shots;
  }
}

/** The nearest human to `p`, m (∞ with none). Inline torus math: this
 * runs per pilot, per promotion pass. */
function nearest(p: Vec3, humans: readonly PilotHuman[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < humans.length; i++) {
    const h = (humans[i] as PilotHuman).pos;
    const dx = wrapDeltaAxis(p.x, h.x);
    const dy = h.y - p.y;
    const dz = wrapDeltaAxis(p.z, h.z);
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 < best) best = d2;
  }
  return Math.sqrt(best);
}

function forwardOf(p: Pilot): Vec3 {
  const cp = Math.cos(p.pitch);
  return {
    x: -Math.sin(p.yaw) * cp,
    y: Math.sin(p.pitch),
    z: -Math.cos(p.yaw) * cp,
  };
}
