// Server-flown backfill bots for one room — pure bookkeeping like room.ts
// and combat.ts: no sockets, no clocks of its own (tick takes `now`), and no
// Math.random (per-bot mulberry32 seeded from the room seed), so tests are
// deterministic.
//
// The sim is the SHARED flight model: every bot holds a FlightState advanced
// with stepFlight at snapshot cadence (dt = 1/TICK_DOWN_HZ), so a bot can
// never out-fly the envelope players have — its brain only chooses inputs.
// The 4-state brain decides every BOT_DECISION_EVERY-th tick (~5 Hz):
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
import {
  nearestStreet,
  nextIntersection,
} from "@angels-bandits/common/city/street";
import {
  collideCity,
  hitsGround,
  losClear,
} from "@angels-bandits/common/collision";
import {
  BOT_AIM_JITTER,
  BOT_CANYON_ALT_MAX,
  BOT_CANYON_ALT_MIN,
  BOT_CANYON_GLIDE,
  BOT_CANYON_HOP,
  BOT_CANYON_PROBE_ALT,
  BOT_CANYON_PROBE_RADIUS,
  BOT_CANYON_PROBE_TIMES,
  BOT_CANYON_SHARE,
  BOT_CANYON_SLOW_RADIUS,
  BOT_CANYON_STRAIGHT_CHANCE,
  BOT_CANYON_TURN_YAW,
  BOT_CANYON_WAYPOINT_RADIUS,
  BOT_CEILING_ALT,
  BOT_CEILING_HYST,
  BOT_CEILING_LOOKAHEAD_S,
  BOT_DECISION_EVERY,
  BOT_DETECT_RANGE,
  BOT_EVADE_MS,
  BOT_FAN_PITCH,
  BOT_FAN_TIMES,
  BOT_FAN_YAW,
  BOT_FIRE_CONE,
  BOT_FIRE_RANGE,
  BOT_INPUT_CAP,
  BOT_LOS_MEMORY_MS,
  BOT_LOS_TESTS_MAX,
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
  PITCH_LIMIT,
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

/**
 * Candidate heading offsets (yaw, pitch) sampled around the pursuit vector.
 * Deliberately UNORDERED: the angle a yaw offset subtends shrinks as the base
 * pitch steepens, so no fixed order is "nearest the pursuit vector" for every
 * aim — fanAround ranks them by real dot product when it needs to.
 */
const FAN: readonly (readonly [number, number])[] = (() => {
  const out: [number, number][] = [[0, 0]];
  for (const p of BOT_FAN_PITCH) out.push([0, p], [0, -p]);
  for (const y of BOT_FAN_YAW) {
    out.push([y, 0], [-y, 0]);
    for (const p of BOT_FAN_PITCH) out.push([y, p], [y, -p], [-y, p], [-y, -p]);
  }
  return out;
})();

interface Bot {
  entry: RosterEntry;
  flight: FlightState;
  input: FlightInput;
  state: BotState;
  targetId: string | null;
  /** Earliest time the trigger may be pulled at the current target, ms. */
  fireAllowedAt: number;
  /** When the current target was last actually SEEN, ms — the memory window
   * that carries a chase through a building. */
  lastSeenAt: number;
  waypoint: Vec3 | null;
  /** Seeded once and fixed for life: does this bot patrol the streets? It
   * steers PATROL only — ENGAGE follows the target into either layer. */
  canyon: boolean;
  /** The altitude this bot calls home, m: the floor an EVADE dives back to,
   * and for a canyon bot the height it flies its street lattice at (drawn
   * across the band, so canyon bots stagger vertically instead of flying a
   * conga line). High bots all share BOT_PATROL_ALT_MIN — their patrol
   * altitude is still redrawn per waypoint, exactly as before. */
  bandY: number;
  /** Which street line the canyon patrol is flying, and which way along it. */
  travel: { axis: "x" | "z"; dir: 1 | -1 } | null;
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
    // Disposition, then this bot's slot inside its band — both drawn ONCE, so
    // a bot keeps its layer through every respawn (see respawn()).
    const canyon = rand() < BOT_CANYON_SHARE;
    const bandY = canyon
      ? BOT_CANYON_ALT_MIN + rand() * (BOT_CANYON_ALT_MAX - BOT_CANYON_ALT_MIN)
      : BOT_PATROL_ALT_MIN;
    this.bots.set(entry.id, {
      entry,
      flight: this.flightFromSpawn(spawn),
      input: NEUTRAL,
      state: "PATROL",
      targetId: null,
      fireAllowedAt: 0,
      lastSeenAt: Number.NEGATIVE_INFINITY,
      waypoint: null,
      canyon,
      bandY,
      travel: null,
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
    bot.lastSeenAt = Number.NEGATIVE_INFINITY;
    bot.waypoint = null;
    bot.travel = null;
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
    // RECOVER keeps its hysteresis: once in it, only a WIDE clearance releases
    // it, or the brain flaps back to PATROL/ENGAGE and immediately re-steers
    // toward the obstacle.
    // Latched up front: `decide` sets bot.state = "ENGAGE" before it knows
    // whether the fan can find a heading, so asking "am I already recovering?"
    // later would answer no every time and re-draw the break turn each
    // decision — the exact flapping the hysteresis exists to prevent.
    const wasRecover = bot.state === "RECOVER";
    const margin = wasRecover ? BOT_RECOVER_CLEAR : 1;
    const ceiling = this.nearCeiling(bot.flight, margin);
    const recover = (dive: boolean): void => {
      if (!wasRecover) bot.breakTurn = this.clearSide(bot.flight);
      // Down among the towers a recovery also has to SLOW: turn radius is
      // speed / 0.765 rad/s, so the bot that keeps full power through a
      // pull-up needs 100 m to change direction and has maybe 60 m of probe.
      bot.state = "RECOVER";
      const canyon = !dive && bot.flight.pos.y < BOT_CANYON_PROBE_ALT;
      bot.input = {
        // The ceiling dives back under the cloud deck; every other danger
        // (ground, tier boxes ≤ 250 m) pulls up — never both at once.
        pitch: dive ? -BOT_INPUT_CAP : BOT_INPUT_CAP,
        turn: bot.breakTurn * BOT_INPUT_CAP * 0.6,
        roll: 0,
        throttle: canyon ? -1 : 1,
      };
    };

    // The storm ceiling and the altitude floor stay HARD overrides in every
    // state — a bot chasing a diving human still pulls up (and weather must
    // never kill a bot, ST1's rule).
    if (ceiling || bot.flight.pos.y < BOT_MIN_ALT) {
      recover(ceiling);
      return;
    }

    // Terrain ahead of the NOSE. For PATROL and EVADE this is still the hard
    // override it always was; ENGAGE gets first refusal through the fan below,
    // because a binary override can only ever produce avoidance, never weaving.
    const fwd = flightForward(bot.flight);
    const blocked = this.blockedAlong(bot.flight, fwd.x, fwd.z, fwd.y, margin);

    if (now < bot.evadeUntil) {
      if (blocked) {
        recover(false);
        return;
      }
      bot.state = "EVADE";
      // Break turn + dive toward canyon altitude: hold the turn and let the
      // nose drop while above the canyon band (RECOVER guards the floor).
      const divePitch = bot.flight.pos.y > bot.bandY ? -0.35 : 0;
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

    const target = this.acquire(bot, now, contacts);
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
      // The fan's first candidate IS the pursuit vector, so an unobstructed
      // chase steers exactly as it always did (steerToward reads direction
      // only, so a normalized survivor and the raw lead vector are the same
      // command). A blocked line yields the nearest clear heading instead of
      // cancelling the chase.
      const heading = this.fanAround(bot, aim, margin);
      if (heading) {
        // Weaving means the terrain is close, and turn radius is speed / 0.765
        // rad/s — so the bot that keeps its throttle buried is the bot that
        // cannot make the gap. Only a clear pursuit line gets full power.
        this.steerToward(
          bot,
          heading.dir,
          bot.aimJitterYaw,
          bot.aimJitterPitch,
          heading.direct ? 1 : -1,
        );
        return;
      }
      // Every heading in the fan is blocked: genuinely boxed in, so RECOVER
      // survives as the last-resort guard it was always meant to be.
      recover(false);
      return;
    }

    if (blocked) {
      recover(false);
      return;
    }

    // PATROL: the street lattice down low, seeded waypoint wander up high.
    bot.state = "PATROL";
    bot.targetId = null;
    if (bot.canyon) {
      this.canyonPatrol(bot);
      return;
    }
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

  /**
   * Fly the street lattice: hold the centerline to the next intersection,
   * then take a seeded straight/left/right. Two concessions to the flight
   * model, both measured: bleed throttle into a corner (turn radius is
   * speed / 0.765 rad/s, so slowing is the ONLY way to tighten it), and hop
   * — a 90° turn sweeps ~52 m, wider than any roadway, so it must cross the
   * block corner and wants vertical margin over whatever stands there.
   */
  private canyonPatrol(bot: Bot): void {
    // Reaching a waypoint is a GROUND-TRACK test: the lattice is a plan-view
    // graph and altitude is the glide's business. Measuring it in 3D strands a
    // bot that is still high above the intersection it is aiming at.
    let d = bot.waypoint
      ? wrapDelta(bot.flight.pos, bot.waypoint)
      : { x: 0, y: 0, z: 0 };
    if (!bot.waypoint || Math.hypot(d.x, d.z) < BOT_CANYON_WAYPOINT_RADIUS) {
      bot.waypoint = this.nextCanyonWaypoint(bot);
      d = wrapDelta(bot.flight.pos, bot.waypoint);
    }
    const flat = Math.hypot(d.x, d.z);
    const yawErr = Math.abs(wrapAngle(Math.atan2(-d.x, -d.z) - bot.flight.yaw));
    const turning = yawErr > BOT_CANYON_TURN_YAW;
    const slowing = turning || flat < BOT_CANYON_SLOW_RADIUS;
    // The hop raises the TARGET altitude (never the commanded climb), then the
    // glide caps how steeply the bot may descend toward it — so arriving from
    // RESPAWN_ALTITUDE is a slope down the lattice, not a plunge.
    const targetY = bot.waypoint.y + (slowing ? BOT_CANYON_HOP : 0);
    const dy = Math.max(targetY - bot.flight.pos.y, -flat * BOT_CANYON_GLIDE);
    // Never accelerate on a canyon patrol: turn radius is speed / 0.765 rad/s,
    // so a street-grid bot has to arrive at a corner near MIN_SPEED or its arc
    // cuts the block. Throttle only ever holds or bleeds here; a chase (ENGAGE)
    // is free to firewall it.
    this.steerToward(bot, { x: d.x, y: dy, z: d.z }, 0, 0, slowing ? -1 : 0);
  }

  /** The next lattice intersection to fly to, at this bot's band altitude. */
  private nextCanyonWaypoint(bot: Bot): Vec3 {
    const fwd = flightForward(bot.flight);
    if (!bot.travel) {
      // Joining the lattice (a fresh spawn is still up at RESPAWN_ALTITUDE):
      // adopt the street below, heading whichever way we already face.
      const street = nearestStreet(bot.flight.pos);
      bot.travel = {
        axis: street.axis,
        dir: (street.axis === "x" ? fwd.x : fwd.z) >= 0 ? 1 : -1,
      };
      const p = nextIntersection(bot.flight.pos, street, bot.travel.dir);
      return { x: p.x, y: bot.bandY, z: p.z };
    }
    // Standing on an intersection: carry straight on, or turn onto the cross
    // street. Both draws come from the per-bot stream, never Math.random.
    const at = bot.waypoint ?? bot.flight.pos;
    if (bot.rand() >= BOT_CANYON_STRAIGHT_CHANCE) {
      bot.travel = {
        axis: bot.travel.axis === "x" ? "z" : "x",
        dir: bot.rand() < 0.5 ? 1 : -1,
      };
    }
    const p = nextIntersection(
      at,
      {
        axis: bot.travel.axis,
        centerline: bot.travel.axis === "x" ? at.z : at.x,
      },
      bot.travel.dir,
    );
    return { x: p.x, y: bot.bandY, z: p.z };
  }

  /**
   * The contact this bot should hunt: the nearest living, unprotected one in
   * detect range that it can actually SEE (never self).
   *
   * Above the rooftops every sight line is clear, so this is free for a high
   * patrol; in a canyon it is what stops a bot locking onto a human on the far
   * side of a skyscraper and flying lead pursuit into the wall.
   *
   * Contacts are walked nearest-first and the walk stops at the first one
   * visible, so the common case costs a single sight test; BOT_LOS_TESTS_MAX
   * bounds the worst case.
   */
  private acquire(
    bot: Bot,
    now: number,
    contacts: readonly BotContact[],
  ): BotContact | null {
    const inRange: { c: BotContact; dist: number }[] = [];
    for (const c of contacts) {
      if (c.id === bot.entry.id || c.prot) continue;
      const dist = wrapDistance(bot.flight.pos, c.pos);
      if (dist <= BOT_DETECT_RANGE) inRange.push({ c, dist });
    }
    inRange.sort((a, b) => a.dist - b.dist);
    // Nearest first, stopping at the first one actually visible. The budget
    // bounds the WORK, not the candidate set: truncating to the nearest few
    // would let a knot of contacts behind one tower blind a bot to a human in
    // open air right in front of it.
    let tests = BOT_LOS_TESTS_MAX;
    for (const { c } of inRange) {
      if (tests-- <= 0) break;
      if (losClear(bot.flight.pos, c.pos, this.buildings)) {
        bot.lastSeenAt = now;
        return c;
      }
    }

    // Nothing in sight: keep pressing the CURRENT target through a short
    // memory window. Returning the same contact id matters — decide() only
    // re-arms the reaction delay when the id CHANGES, so a flickering sight
    // line must not look like a new acquisition.
    if (bot.targetId && now - bot.lastSeenAt <= BOT_LOS_MEMORY_MS) {
      for (const c of contacts) {
        if (c.id !== bot.targetId || c.prot) continue;
        if (wrapDistance(bot.flight.pos, c.pos) > BOT_DETECT_RANGE) break;
        return c;
      }
    }
    return null;
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

  /**
   * The nearest heading to `aim` that the probes report clear, or null when
   * every candidate is blocked. Walks the pre-sorted FAN table and returns
   * the first survivor — see FAN for why that IS the best-dot-product pick.
   */
  private fanAround(
    bot: Bot,
    aim: Vec3,
    margin: number,
  ): { dir: Vec3; direct: boolean } | null {
    const len = Math.hypot(aim.x, aim.y, aim.z);
    if (len === 0) return null;
    const baseYaw = Math.atan2(-aim.x, -aim.z);
    const basePitch = Math.asin(clamp(aim.y / len, -1, 1));
    const at = (dYaw: number, dPitch: number): Vec3 =>
      flightForward({
        yaw: baseYaw + dYaw,
        pitch: clamp(basePitch + dPitch, -PITCH_LIMIT, PITCH_LIMIT),
      });

    // The overwhelmingly common case: the pursuit line is clear over the long
    // steering horizon, and the chase steers exactly as it always did.
    const straight = at(0, 0);
    if (
      !this.blockedAlong(
        bot.flight,
        straight.x,
        straight.z,
        straight.y,
        margin,
        BOT_FAN_TIMES,
      )
    ) {
      return { dir: straight, direct: true };
    }

    // Blocked, so it is worth ranking the alternatives properly: score each
    // candidate by its actual dot product with the desired pursuit direction
    // and take the best survivor.
    const ranked = FAN.map(([dYaw, dPitch]) => {
      const dir = at(dYaw, dPitch);
      return {
        dir,
        dot: (dir.x * aim.x + dir.y * aim.y + dir.z * aim.z) / len,
      };
    }).sort((a, b) => b.dot - a.dot);

    // Two horizons, and the order is the point. First insist on a heading that
    // stays clear long enough to still be able to turn; only if nothing
    // survives that does the bot settle for one that merely survives the short
    // "am I about to hit it" look. Both are explicit — falling back to the
    // altitude default would hand a HIGH bot a 2.6 s horizon, which is LONGER
    // than the first pass and so could never rescue it.
    for (const times of [BOT_FAN_TIMES, BOT_CANYON_PROBE_TIMES]) {
      for (const { dir } of ranked) {
        if (
          !this.blockedAlong(bot.flight, dir.x, dir.z, dir.y, margin, times)
        ) {
          return { dir, direct: false };
        }
      }
    }
    return null;
  }

  /**
   * Probe a direction (unit horizontal dx/dz plus vertical dy) for danger.
   *
   * The profile is chosen by ALTITUDE, not disposition, so a high patroller
   * diving into a chase gets the canyon probes too. Among the towers the long
   * samples are actively harmful: they reach past an intersection into the
   * cross-street facade, which reports danger on ~76% of the ticks of a turn
   * that hits nothing. `times` overrides the horizon for callers that are
   * CHOOSING a heading rather than deciding whether to abandon one.
   */
  private blockedAlong(
    flight: FlightState,
    dx: number,
    dz: number,
    dy: number,
    margin = 1,
    times?: readonly number[],
  ): boolean {
    const canyon = flight.pos.y < BOT_CANYON_PROBE_ALT;
    const radius =
      (canyon ? BOT_CANYON_PROBE_RADIUS : BOT_PROBE_RADIUS) * margin;
    for (const t of times ??
      (canyon ? BOT_CANYON_PROBE_TIMES : BOT_PROBE_TIMES)) {
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

  /** Which break-turn direction has clearer air? Probes the nose swung ±60°,
   * over the fan's longer STEERING horizon: this picks which way to go, and a
   * 0.9 s look cannot see far enough to make that choice well. */
  private clearSide(flight: FlightState): 1 | -1 {
    const fwd = flightForward(flight);
    const swing = Math.PI / 3;
    // turn=+1 decreases yaw; a yaw change of -swing rotates the nose to the
    // "turn right" side. Test both and prefer the unblocked one.
    for (const times of [BOT_FAN_TIMES, BOT_CANYON_PROBE_TIMES]) {
      for (const dir of [1, -1] as const) {
        const yaw = flight.yaw - dir * swing;
        const cosP = Math.cos(flight.pitch);
        if (
          !this.blockedAlong(
            flight,
            -Math.sin(yaw) * cosP,
            -Math.cos(yaw) * cosP,
            fwd.y,
            1,
            times,
          )
        ) {
          return dir;
        }
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
