// Server-flown backfill bots for one room — pure bookkeeping like room.ts
// and combat.ts: no sockets, no clocks of its own (tick takes `now`), and no
// Math.random (per-bot mulberry32 seeded from the room seed), so tests are
// deterministic.
//
// The sim is the SHARED flight model: every bot holds a FlightState advanced
// with stepFlight at snapshot cadence (dt = 1/TICK_DOWN_HZ), so a bot can
// never out-fly the envelope players have — its brain only chooses inputs.
// The 4-state brain decides every BOT_DECISION_EVERY-th tick (5 Hz — the
// constant tracks TICK_DOWN_HZ so a faster snapshot cadence does not silently
// sharpen bot reflexes):
//
//   PATROL  — seeded waypoint wander in the mid-altitude band.
//   ENGAGE  — lead pursuit of the nearest contact in BOT_DETECT_RANGE; all
//             direction/distance math via wrapDelta/wrapDistance, so bots
//             chase straight through the torus seam.
//   EVADE   — break turn + dive for a beat after taking fire or with a
//             threat parked close behind.
//   RECOVER — hard override: nose probes against the SAME tier boxes and
//             ground players collide with → pull up / turn to the clear side.
//
// Bots never send hit claims: tick() emits trigger pulls (BotShot) and
// applyBotFire routes them through the existing Combat seam — same heat
// model, damage, spawn protection, kill credit, and respawn as humans.

import { type Building, mulberry32 } from "@angels-bandits/common/city";
import { collideCity, hitsGround } from "@angels-bandits/common/collision";
import {
  BOT_AIM_JITTER,
  BOT_CEILING_ALT,
  BOT_CEILING_HYST,
  BOT_CEILING_LOOKAHEAD_S,
  BOT_DECISION_EVERY,
  BOT_DETECT_RANGE,
  BOT_EVADE_MS,
  BOT_FIRE_CONE,
  BOT_FIRE_RANGE,
  BOT_INPUT_CAP,
  BOT_MIN_ALT,
  BOT_PATROL_ALT_MAX,
  BOT_PATROL_ALT_MIN,
  BOT_PROBE_RADIUS,
  BOT_PROBE_TIMES,
  BOT_REACTION_MS,
  BOT_RECOVER_CLEAR,
  BOT_STEER_GAIN,
  BOT_THREAT_RANGE,
  BOT_WAYPOINT_RADIUS,
  BULLET_RANGE,
  BULLET_SPEED,
  HIT_RADIUS,
  PLAYER_RADIUS,
  TICK_DOWN_HZ,
  WORLD_SIZE,
} from "@angels-bandits/common/constants";
import {
  type FlightInput,
  type FlightState,
  createFlightState,
  flightForward,
  stepFlight,
} from "@angels-bandits/common/flight";
import type {
  Pose,
  RosterEntry,
  SpawnState,
} from "@angels-bandits/common/protocol";
import {
  type Vec3,
  canonicalize,
  wrapDelta,
  wrapDistance,
} from "@angels-bandits/common/world";
import type { Combat, HitResult } from "./combat";

/** Sim step, s — bots advance at snapshot cadence (the server's first sim loop). */
const BOT_DT = 1 / TICK_DOWN_HZ;

export type BotState = "PATROL" | "ENGAGE" | "EVADE" | "RECOVER";

/** One living combatant as the brain sees it (bots included — id-filtered). */
export interface BotContact {
  id: string;
  pos: Vec3;
  /** World velocity, m/s — lead pursuit aims ahead along it. */
  vel: Vec3;
  /** Spawn-protected contacts are skipped (their hits would be void anyway). */
  prot: boolean;
}

/** One trigger pull emitted by tick() — index.ts routes it through Combat. */
export interface BotShot {
  botId: string;
  targetId: string;
  /** Bot-local bullet id, same contract as a client's fire seq. */
  seq: number;
  origin: Vec3;
  /** Unit nose vector at the moment of firing. */
  dir: Vec3;
}

export interface BotTickResult {
  shots: BotShot[];
  /** Bots that flew into a building or the ground this tick (marked dead
   * here; the caller settles the death through Combat.crash). */
  crashes: string[];
}

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));

/** Smallest signed angle equivalent, in [-π, π]. */
const wrapAngle = (a: number): number => {
  const twoPi = Math.PI * 2;
  const m = ((a % twoPi) + twoPi) % twoPi;
  return m > Math.PI ? m - twoPi : m;
};

const NEUTRAL: FlightInput = { pitch: 0, turn: 0, roll: 0, throttle: 0 };

interface Bot {
  entry: RosterEntry;
  flight: FlightState;
  input: FlightInput;
  state: BotState;
  targetId: string | null;
  /** Earliest time the trigger may be pulled at the current target, ms. */
  fireAllowedAt: number;
  waypoint: Vec3 | null;
  evadeUntil: number;
  /** Break-turn direction for EVADE/RECOVER, seeded per episode. */
  breakTurn: 1 | -1;
  /** Aim wander resampled each decision — the seeded miss source. */
  aimJitterYaw: number;
  aimJitterPitch: number;
  alive: boolean;
  nextSeq: number;
  rand: () => number;
}

export class RoomBots {
  private readonly bots = new Map<string, Bot>();
  private nextIndex = 1;
  private tickCount = 0;
  /** Room-level stream: mints per-bot seeds so bots stay deterministic. */
  private readonly rand: () => number;

  constructor(
    private readonly roomId: string,
    seed: number,
    /** The seeded city — the SAME Building[] players collide with. */
    private readonly buildings: readonly Building[],
  ) {
    this.rand = mulberry32(seed);
  }

  get count(): number {
    return this.bots.size;
  }

  ids(): string[] {
    return [...this.bots.keys()];
  }

  /** Spawn one bot at `spawn` (deterministic BANDIT-<n> identity). */
  spawn(spawn: SpawnState): RosterEntry {
    const n = this.nextIndex++;
    const entry: RosterEntry = {
      id: `bot:${this.roomId}:${n}`,
      name: `BANDIT-${n}`,
      isBot: true,
    };
    const rand = mulberry32(Math.floor(this.rand() * 0xffffffff));
    this.bots.set(entry.id, {
      entry,
      flight: this.flightFromSpawn(spawn),
      input: NEUTRAL,
      state: "PATROL",
      targetId: null,
      fireAllowedAt: 0,
      waypoint: null,
      evadeUntil: Number.NEGATIVE_INFINITY,
      breakTurn: 1,
      aimJitterYaw: 0,
      aimJitterPitch: 0,
      alive: true,
      nextSeq: 1,
      rand,
    });
    return entry;
  }

  remove(id: string): void {
    this.bots.delete(id);
  }

  /**
   * Sync the population to `desired`: spawn (via `pickSpawn`) or despawn
   * (idle first — see pickDespawn) until the counts match. The caller
   * mirrors the returned changes into the room roster and Combat.
   */
  syncTo(
    desired: number,
    pickSpawn: () => SpawnState,
  ): { spawned: RosterEntry[]; despawned: string[] } {
    const spawned: RosterEntry[] = [];
    const despawned: string[] = [];
    while (this.bots.size < desired) spawned.push(this.spawn(pickSpawn()));
    while (this.bots.size > desired) {
      const victim = this.pickDespawn();
      if (!victim) break;
      this.bots.delete(victim);
      despawned.push(victim);
    }
    return { spawned, despawned };
  }

  /**
   * The bot that should yield its seat: idle first — PATROL, then RECOVER,
   * then EVADE, then a bot dogfighting another bot; one ENGAGEd with a human
   * only as the last resort (a seat must still free up when every bot is).
   */
  pickDespawn(): string | null {
    const rank = (b: Bot): number => {
      switch (b.state) {
        case "PATROL":
          return 0;
        case "RECOVER":
          return 1;
        case "EVADE":
          return 2;
        case "ENGAGE":
          // Bot ids are minted with the "bot:" prefix; humans are UUIDs.
          return b.targetId?.startsWith("bot:") ? 3 : 4;
      }
    };
    let best: Bot | null = null;
    for (const b of this.bots.values()) {
      if (!best || rank(b) < rank(best)) best = b;
    }
    return best?.entry.id ?? null;
  }

  stateOf(id: string): BotState | undefined {
    return this.bots.get(id)?.state;
  }

  targetOf(id: string): string | null {
    return this.bots.get(id)?.targetId ?? null;
  }

  flightOf(id: string): FlightState | undefined {
    return this.bots.get(id)?.flight;
  }

  /** The wire pose of a living bot (Euler YXZ → quat, Three.js order). */
  poseOf(id: string): Pose | null {
    const bot = this.bots.get(id);
    if (!bot || !bot.alive) return null;
    const { pos, yaw, pitch, roll, speed } = bot.flight;
    const cy = Math.cos(yaw / 2);
    const sy = Math.sin(yaw / 2);
    const cx = Math.cos(pitch / 2);
    const sx = Math.sin(pitch / 2);
    const cz = Math.cos(roll / 2);
    const sz = Math.sin(roll / 2);
    return {
      pos,
      quat: {
        x: sx * cy * cz + cx * sy * sz,
        y: cx * sy * cz - sx * cy * sz,
        z: cx * cy * sz - sx * sy * cz,
        w: cx * cy * cz + sx * sy * sz,
      },
      speed,
    };
  }

  /** Position + velocity of a living bot, for building contact lists. */
  contactOf(id: string): { pos: Vec3; vel: Vec3 } | null {
    const bot = this.bots.get(id);
    if (!bot || !bot.alive) return null;
    const fwd = flightForward(bot.flight);
    const { speed } = bot.flight;
    return {
      pos: bot.flight.pos,
      vel: { x: fwd.x * speed, y: fwd.y * speed, z: fwd.z * speed },
    };
  }

  /** The bot took validated damage: break off for a beat (EVADE). */
  onDamaged(id: string, now: number): void {
    const bot = this.bots.get(id);
    if (!bot || !bot.alive) return;
    bot.evadeUntil = now + BOT_EVADE_MS;
    bot.breakTurn = bot.rand() < 0.5 ? -1 : 1;
  }

  /** Death settled by Combat: freeze until respawn() reseeds the flight. */
  setDead(id: string): void {
    const bot = this.bots.get(id);
    if (bot) bot.alive = false;
  }

  /** Server-issued respawn (same sampler as humans): fresh flight state. */
  respawn(id: string, spawn: SpawnState): void {
    const bot = this.bots.get(id);
    if (!bot) return;
    bot.alive = true;
    bot.flight = this.flightFromSpawn(spawn);
    bot.input = NEUTRAL;
    bot.state = "PATROL";
    bot.targetId = null;
    bot.waypoint = null;
    bot.evadeUntil = Number.NEGATIVE_INFINITY;
  }

  /**
   * Advance every living bot one sim tick: brain every BOT_DECISION_EVERY-th
   * call, shared stepFlight always, then the same collision geometry players
   * die to. `contacts` is the coherent start-of-tick view of all living
   * combatants (bots included; each bot skips itself by id).
   */
  tick(now: number, contacts: readonly BotContact[]): BotTickResult {
    this.tickCount++;
    const decide = this.tickCount % BOT_DECISION_EVERY === 0;
    const shots: BotShot[] = [];
    const crashes: string[] = [];

    for (const bot of this.bots.values()) {
      if (!bot.alive) continue;
      if (decide) this.decide(bot, now, contacts);
      bot.flight = stepFlight(bot.flight, bot.input, BOT_DT);

      // Identical geometry to players: tier boxes + ground, PLAYER_RADIUS.
      if (
        hitsGround(bot.flight.pos) ||
        collideCity(bot.flight.pos, PLAYER_RADIUS, this.buildings)
      ) {
        bot.alive = false;
        crashes.push(bot.entry.id);
        continue;
      }

      const shot = this.maybeFire(bot, now, contacts);
      if (shot) shots.push(shot);
    }
    return { shots, crashes };
  }

  // --- brain ---

  private decide(bot: Bot, now: number, contacts: readonly BotContact[]): void {
    // RECOVER is a hard override of everything else — with hysteresis: once
    // in it, only a WIDE clearance releases it, or the brain flaps back to
    // PATROL/ENGAGE and immediately re-steers toward the obstacle.
    const margin = bot.state === "RECOVER" ? BOT_RECOVER_CLEAR : 1;
    const ceiling = this.nearCeiling(bot.flight, margin);
    if (ceiling || this.inDanger(bot.flight, margin)) {
      if (bot.state !== "RECOVER") {
        bot.state = "RECOVER";
        bot.breakTurn = this.clearSide(bot.flight);
      }
      bot.input = {
        // The ceiling dives back under the cloud deck; every other danger
        // (ground, tier boxes ≤ 250 m) pulls up — never both at once.
        pitch: ceiling ? -BOT_INPUT_CAP : BOT_INPUT_CAP,
        turn: bot.breakTurn * BOT_INPUT_CAP * 0.6,
        roll: 0,
        throttle: 1,
      };
      return;
    }

    if (now < bot.evadeUntil) {
      bot.state = "EVADE";
      // Break turn + dive toward canyon altitude: hold the turn and let the
      // nose drop while above the canyon band (RECOVER guards the floor).
      const divePitch = bot.flight.pos.y > BOT_PATROL_ALT_MIN ? -0.35 : 0;
      bot.input = {
        pitch: clamp(
          (divePitch - bot.flight.pitch) * BOT_STEER_GAIN,
          -BOT_INPUT_CAP,
          BOT_INPUT_CAP,
        ),
        turn: bot.breakTurn * BOT_INPUT_CAP,
        roll: 0,
        throttle: 1,
      };
      return;
    }

    const target = this.acquire(bot, contacts);
    if (target) {
      if (bot.targetId !== target.id) {
        bot.targetId = target.id;
        bot.fireAllowedAt = now + BOT_REACTION_MS;
      }
      bot.state = "ENGAGE";
      const d = wrapDelta(bot.flight.pos, target.pos);
      const dist = Math.hypot(d.x, d.y, d.z);

      // A threat parked close behind → break off instead of dragging it.
      const fwd = flightForward(bot.flight);
      const along = d.x * fwd.x + d.y * fwd.y + d.z * fwd.z;
      if (dist < BOT_THREAT_RANGE && along < 0) {
        bot.evadeUntil = now + BOT_EVADE_MS;
        bot.breakTurn = bot.rand() < 0.5 ? -1 : 1;
        bot.state = "EVADE";
        return;
      }

      // Lead pursuit: aim where the target will be when a bullet arrives,
      // wandered by the seeded jitter (resampled per decision).
      bot.aimJitterYaw = (bot.rand() * 2 - 1) * BOT_AIM_JITTER;
      bot.aimJitterPitch = (bot.rand() * 2 - 1) * BOT_AIM_JITTER;
      const t = dist / BULLET_SPEED;
      const aim: Vec3 = {
        x: d.x + target.vel.x * t,
        y: d.y + target.vel.y * t,
        z: d.z + target.vel.z * t,
      };
      this.steerToward(bot, aim, bot.aimJitterYaw, bot.aimJitterPitch, 1);
      return;
    }

    // PATROL: seeded waypoint wander in the mid-altitude band.
    bot.state = "PATROL";
    bot.targetId = null;
    if (
      !bot.waypoint ||
      wrapDistance(bot.flight.pos, bot.waypoint) < BOT_WAYPOINT_RADIUS
    ) {
      bot.waypoint = {
        x: bot.rand() * WORLD_SIZE,
        y:
          BOT_PATROL_ALT_MIN +
          bot.rand() * (BOT_PATROL_ALT_MAX - BOT_PATROL_ALT_MIN),
        z: bot.rand() * WORLD_SIZE,
      };
    }
    this.steerToward(bot, wrapDelta(bot.flight.pos, bot.waypoint), 0, 0, 0);
  }

  /** Nearest living, unprotected contact within detect range (never self). */
  private acquire(
    bot: Bot,
    contacts: readonly BotContact[],
  ): BotContact | null {
    let best: BotContact | null = null;
    let bestDist = BOT_DETECT_RANGE;
    for (const c of contacts) {
      if (c.id === bot.entry.id || c.prot) continue;
      const dist = wrapDistance(bot.flight.pos, c.pos);
      if (dist <= bestDist) {
        best = c;
        bestDist = dist;
      }
    }
    return best;
  }

  /** Proportional rate steering toward the (torus) delta `d`, inputs capped
   * below the player envelope. Jitter offsets the commanded attitude. */
  private steerToward(
    bot: Bot,
    d: Vec3,
    jitterYaw: number,
    jitterPitch: number,
    throttle: number,
  ): void {
    const len = Math.hypot(d.x, d.y, d.z);
    if (len === 0) return;
    const desiredYaw = Math.atan2(-d.x, -d.z) + jitterYaw;
    const yawErr = wrapAngle(desiredYaw - bot.flight.yaw);
    const desiredPitch = Math.asin(clamp(d.y / len, -1, 1)) + jitterPitch;
    const pitchErr = desiredPitch - bot.flight.pitch;
    bot.input = {
      // turn +1 decreases yaw, so a positive yaw error needs negative turn.
      turn: clamp(-yawErr * BOT_STEER_GAIN, -BOT_INPUT_CAP, BOT_INPUT_CAP),
      pitch: clamp(pitchErr * BOT_STEER_GAIN, -BOT_INPUT_CAP, BOT_INPUT_CAP),
      roll: 0,
      throttle,
    };
  }

  /** Would the current climb breach the bot ceiling soon? Predictive like
   * the nose probes: vertical speed over the pitch-down turnaround time, so
   * even a max-rate zoom climb tops out under CLOUD_BASE (ST1: weather must
   * never kill a bot). `margin` > 1 is RECOVER's exit hysteresis — it
   * demands BOT_CEILING_HYST of clearance below before releasing. */
  private nearCeiling(flight: FlightState, margin = 1): boolean {
    const climb = Math.max(0, flightForward(flight).y * flight.speed);
    const limit = BOT_CEILING_ALT - (margin - 1) * BOT_CEILING_HYST;
    return flight.pos.y + climb * BOT_CEILING_LOOKAHEAD_S > limit;
  }

  /** Would holding this course hit something soon? Ground margin + nose
   * probes against the shared tier boxes at BOT_PROBE_TIMES of lookahead.
   * `margin` scales the probe radius (RECOVER's exit hysteresis). */
  private inDanger(flight: FlightState, margin = 1): boolean {
    if (flight.pos.y < BOT_MIN_ALT) return true;
    const fwd = flightForward(flight);
    return this.blockedAlong(flight, fwd.x, fwd.z, fwd.y, margin);
  }

  /** Probe a direction (unit horizontal dx/dz plus vertical dy) for danger. */
  private blockedAlong(
    flight: FlightState,
    dx: number,
    dz: number,
    dy: number,
    margin = 1,
  ): boolean {
    const radius = BOT_PROBE_RADIUS * margin;
    for (const t of BOT_PROBE_TIMES) {
      const s = flight.speed * t;
      const p = canonicalize({
        x: flight.pos.x + dx * s,
        y: flight.pos.y + dy * s,
        z: flight.pos.z + dz * s,
      });
      if (p.y - radius <= 0) return true;
      if (collideCity(p, radius, this.buildings)) return true;
    }
    return false;
  }

  /** Which break-turn direction has clearer air? Probes the nose swung ±60°. */
  private clearSide(flight: FlightState): 1 | -1 {
    const fwd = flightForward(flight);
    const swing = Math.PI / 3;
    // turn=+1 decreases yaw; a yaw change of -swing rotates the nose to the
    // "turn right" side. Test both and prefer the unblocked one.
    for (const dir of [1, -1] as const) {
      const yaw = flight.yaw - dir * swing;
      const cosP = Math.cos(flight.pitch);
      if (
        !this.blockedAlong(
          flight,
          -Math.sin(yaw) * cosP,
          -Math.cos(yaw) * cosP,
          fwd.y,
        )
      ) {
        return dir;
      }
    }
    return 1;
  }

  /** Trigger discipline: ENGAGEd, past the reaction delay, inside fire range,
   * nose within the aim cone of the target's true bearing → one trigger pull
   * (Combat's token bucket and heat model gate the actual cadence). */
  private maybeFire(
    bot: Bot,
    now: number,
    contacts: readonly BotContact[],
  ): BotShot | null {
    if (bot.state !== "ENGAGE" || !bot.targetId) return null;
    if (now < bot.fireAllowedAt) return null;
    const target = contacts.find((c) => c.id === bot.targetId);
    if (!target) return null;
    const d = wrapDelta(bot.flight.pos, target.pos);
    const dist = Math.hypot(d.x, d.y, d.z);
    if (dist > BOT_FIRE_RANGE || dist === 0) return null;
    const fwd = flightForward(bot.flight);
    const along = (d.x * fwd.x + d.y * fwd.y + d.z * fwd.z) / dist;
    if (along < Math.cos(BOT_FIRE_CONE)) return null;
    return {
      botId: bot.entry.id,
      targetId: bot.targetId,
      seq: bot.nextSeq++,
      origin: bot.flight.pos,
      dir: fwd,
    };
  }

  private flightFromSpawn(spawn: SpawnState): FlightState {
    return {
      ...createFlightState(spawn.pos, spawn.yaw),
      speed: spawn.speed,
      targetSpeed: spawn.speed,
    };
  }
}

/** World velocity implied by a wire pose: nose direction × speed — the
 * quaternion-rotated -Z axis, expanded (no Three.js on the server). */
export function poseVelocity(pose: Pose): Vec3 {
  const { x, y, w } = pose.quat;
  const z = pose.quat.z;
  return {
    x: (-2 * w * y - 2 * x * z) * pose.speed,
    y: (2 * w * x - 2 * y * z) * pose.speed,
    z: (-1 + 2 * x * x + 2 * y * y) * pose.speed,
  };
}

/**
 * Route one bot trigger pull through the SAME Combat seam humans use:
 * fire() (heat model, token bucket, spawn-protection forfeit), then — when
 * the hitscan ray meets the target's hit sphere — hit() (damage, kill
 * credit, protection checks). No claim path, no loosened validation.
 * `targetPos` is the target's authoritative on-record position, or null if
 * it is gone/dead this tick.
 */
export function applyBotFire(
  combat: Combat,
  shot: BotShot,
  targetPos: Vec3 | null,
  now: number,
): { accepted: boolean; hit: HitResult | null } {
  const fired = combat.fire(shot.botId, shot.seq, now);
  if (!fired.ok) return { accepted: false, hit: null };
  if (!targetPos) return { accepted: true, hit: null };

  const d = wrapDelta(shot.origin, targetPos);
  const along = d.x * shot.dir.x + d.y * shot.dir.y + d.z * shot.dir.z;
  if (along < 0 || along > BULLET_RANGE) return { accepted: true, hit: null };
  const px = d.x - shot.dir.x * along;
  const py = d.y - shot.dir.y * along;
  const pz = d.z - shot.dir.z * along;
  if (px * px + py * py + pz * pz > HIT_RADIUS * HIT_RADIUS) {
    return { accepted: true, hit: null };
  }
  const hit = combat.hit(
    shot.botId,
    shot.targetId,
    shot.seq,
    shot.origin,
    shot.origin,
    targetPos,
    now,
  );
  return { accepted: true, hit };
}
