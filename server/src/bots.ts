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
//   PATROL  — fly the street lattice in the canyon band (every bot lives in
//             the city since B1 — there is no high layer).
//   ENGAGE  — lead pursuit of the nearest contact in BOT_DETECT_RANGE, aimed
//             no higher than BOT_ENGAGE_CEILING except for a brief climbing
//             attack pass at a high target; all direction/distance math via
//             wrapDelta/wrapDistance, so bots chase straight through the
//             torus seam.
//   EVADE   — for a beat after taking fire or with a threat parked close
//             behind: a break along the street down in the canyon, a break
//             turn + dive back to the band above it.
//   RECOVER — hard override: nose probes against the SAME tier boxes and
//             ground players collide with → pull up / turn to the clear side
//             (in a street: onto a clear street heading, slowing).
//
// Bots never send hit claims: tick() emits trigger pulls (BotShot) and
// applyBotFire routes them through the existing Combat seam — same heat
// model, damage, spawn protection, kill credit, and respawn as humans.

import { type Building, mulberry32 } from "@angels-bandits/common/city";
import {
  EMPTY_MOVERS,
  type MoverField,
  collideBotMovers,
} from "@angels-bandits/common/city/movers";
import {
  ROADWAY_HALF,
  nextIntersection,
  offCenterline,
} from "@angels-bandits/common/city/street";
import {
  type CityIndex,
  buildCityIndex,
  collideCity,
  hitsGround,
  losClear,
} from "@angels-bandits/common/collision";
import {
  BLOCK_PITCH,
  BOT_ACQUIRE_ALT_WEIGHT,
  BOT_AIM_JITTER,
  BOT_ATTACK_CLIMB,
  BOT_ATTACK_COOLDOWN_MS,
  BOT_ATTACK_PASS_MS,
  BOT_ATTACK_YAW,
  BOT_CANYON_ALT_MAX,
  BOT_CANYON_ALT_MIN,
  BOT_CANYON_GLIDE,
  BOT_CANYON_HOP,
  BOT_CANYON_MERGE_LEAD,
  BOT_CANYON_PROBE_ALT,
  BOT_CANYON_PROBE_RADIUS,
  BOT_CANYON_PROBE_TIMES,
  BOT_CANYON_SLOW_RADIUS,
  BOT_CANYON_STRAIGHT_CHANCE,
  BOT_CANYON_TURN_YAW,
  BOT_CANYON_WAYPOINT_RADIUS,
  BOT_CEILING_ALT,
  BOT_CEILING_HYST,
  BOT_CEILING_LOOKAHEAD_S,
  BOT_DECISION_EVERY,
  BOT_DETECT_RANGE,
  BOT_ENGAGE_CEILING,
  BOT_ENGAGE_OVERHEAD,
  BOT_EVADE_JINK,
  BOT_EVADE_JINK_MS,
  BOT_EVADE_MS,
  BOT_EVADE_STREET_LEAD,
  BOT_FAN_PITCH,
  BOT_FAN_TIMES,
  BOT_FAN_YAW,
  BOT_FIRE_CONE,
  BOT_FIRE_RANGE,
  BOT_INPUT_CAP,
  BOT_LOS_MEMORY_MS,
  BOT_LOS_TESTS_MAX,
  BOT_MIN_ALT,
  BOT_MOVER_CLEAR,
  BOT_PROBE_RADIUS,
  BOT_PROBE_TIMES,
  BOT_REACTION_MS,
  BOT_RECOVER_CLEAR,
  BOT_RETARGET_MARGIN,
  BOT_SPAWN_CLEAR_AHEAD,
  BOT_STEER_GAIN,
  BOT_THREAT_RANGE,
  BULLET_RANGE,
  BULLET_SPEED,
  HIT_RADIUS,
  PITCH_LIMIT,
  PLAYER_RADIUS,
  RESPAWN_SPEED,
  TICK_DOWN_HZ,
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
  /** The altitude this bot calls home, m: the height it flies its street
   * lattice at, and the floor an EVADE or a finished attack pass dives back
   * to (drawn across the canyon band, so bots stagger vertically instead of
   * flying a conga line). */
  bandY: number;
  /** Which street line the canyon patrol is flying, and which way along it. */
  travel: { axis: "x" | "z"; dir: 1 | -1 } | null;
  evadeUntil: number;
  /** A climbing attack pass at a high target runs until this time, ms. */
  attackUntil: number;
  /** No new attack pass before this time, ms — the dive back to the band. */
  attackCooldownUntil: number;
  /** The street heading a low RECOVER latched, rad (null: none yet). */
  escapeYaw: number | null;
  /** Has the bot left its street to fight (ENGAGE/EVADE) since it last
   * patrolled? Back in PATROL it then re-joins the NEAREST street rather than
   * flying cross-country to a waypoint picked before the fight. */
  fought: boolean;
  /** Is the current ENGAGE chasing along the street lattice (pursuit line
   * blocked) rather than flying straight at the target? */
  streetChase: boolean;
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
    /**
     * The seeded moving obstacles (L2), from the SAME seed as `buildings`.
     * Optional with an empty default so the twenty-odd existing call sites in
     * the tests keep compiling — and note that none of `server/test/**` is
     * covered by `tsc -p server` (its tsconfig is `include: ["src"]`), so a
     * required parameter here would land as a runtime surprise, not a type
     * error.
     */
    private readonly movers: MoverField = EMPTY_MOVERS,
    /**
     * Whether the nose/fan probes consider movers. The ONLY reason this is a
     * knob: it is the negative control for the probe wiring — a sim with it
     * off must actually fly bots into jibs, which is what proves the wiring
     * is load-bearing rather than decorative. Never turn it off in a room.
     */
    private readonly probeMovers = true,
  ) {
    this.rand = mulberry32(seed);
    // Built once per room over the shared city array. Bots are the heaviest
    // collision consumer in the game (a physics probe per bot per tick plus
    // four nose probes per brain decision, all bots deciding on the same
    // tick), so the block index is what keeps that off the 15 Hz budget.
    this.cityIndex = buildCityIndex(buildings);
  }

  /** Block index over `buildings` — see collideCity's optional 4th argument. */
  private readonly cityIndex: CityIndex;

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
    // This bot's slot inside the canyon band — drawn ONCE, so a bot keeps its
    // altitude through every respawn (see respawn()).
    const bandY =
      BOT_CANYON_ALT_MIN + rand() * (BOT_CANYON_ALT_MAX - BOT_CANYON_ALT_MIN);
    this.bots.set(entry.id, {
      entry,
      flight: this.flightFromSpawn(spawn),
      input: NEUTRAL,
      state: "PATROL",
      targetId: null,
      fireAllowedAt: 0,
      lastSeenAt: Number.NEGATIVE_INFINITY,
      waypoint: null,
      bandY,
      travel: null,
      evadeUntil: Number.NEGATIVE_INFINITY,
      attackUntil: Number.NEGATIVE_INFINITY,
      attackCooldownUntil: Number.NEGATIVE_INFINITY,
      escapeYaw: null,
      fought: false,
      streetChase: false,
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
    bot.attackUntil = Number.NEGATIVE_INFINITY;
    bot.attackCooldownUntil = Number.NEGATIVE_INFINITY;
    bot.escapeYaw = null;
    bot.fought = false;
    bot.streetChase = false;
  }

  /**
   * Is a (re)spawn at `pos` heading `yaw` (level) safe for a bot? The spawn
   * point and BOT_SPAWN_CLEAR_AHEAD of straight-ahead flight must miss the
   * city and the L2 movers — pickBotRespawn's predicate, so a canyon spawn
   * never lands in a facade, an arch or a crane jib.
   */
  spawnClear(pos: Vec3, yaw: number, now: number): boolean {
    const fwd = flightForward({ yaw, pitch: 0 });
    // Samples a probe radius apart tile the run with overlapping spheres.
    for (let s = 0; s <= BOT_SPAWN_CLEAR_AHEAD; s += BOT_PROBE_RADIUS) {
      const p = canonicalize({
        x: pos.x + fwd.x * s,
        y: pos.y,
        z: pos.z + fwd.z * s,
      });
      if (p.y - BOT_PROBE_RADIUS <= 0) return false;
      if (collideCity(p, BOT_PROBE_RADIUS, this.buildings, this.cityIndex)) {
        return false;
      }
      if (
        collideBotMovers(
          p,
          BOT_PROBE_RADIUS + BOT_MOVER_CLEAR,
          this.movers,
          // Posed when the bot gets there, like blockedAlong: a jib slews.
          now + (s / RESPAWN_SPEED) * 1000,
        )
      ) {
        return false;
      }
    }
    return true;
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

      // Identical geometry to players: tier boxes + ground, PLAYER_RADIUS —
      // plus the L2 movers a bot is allowed to hit (crane geometry and the
      // blimp; helicopters are bot-transparent, see collideBotMovers).
      if (
        hitsGround(bot.flight.pos) ||
        collideCity(
          bot.flight.pos,
          PLAYER_RADIUS,
          this.buildings,
          this.cityIndex,
        ) ||
        collideBotMovers(bot.flight.pos, PLAYER_RADIUS, this.movers, now)
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
      if (!wasRecover) {
        bot.breakTurn = this.clearSide(bot.flight, now);
        bot.escapeYaw = null;
      }
      bot.state = "RECOVER";
      // Down among the towers a recovery also has to SLOW: turn radius is
      // speed / 0.765 rad/s, so the bot that keeps full power through a
      // pull-up needs 100 m to change direction and has maybe 60 m of probe.
      const canyon = !dive && bot.flight.pos.y < BOT_CANYON_PROBE_ALT;
      // In a street, turn onto a clear street heading while pulling up, so
      // the recovery ends back on the lattice rather than wherever the break
      // turn happened to point. Measured: a LEVEL escape (no pull-up) chooses
      // headings that are clear straight ahead but not along the arc the
      // bot can actually fly, and crashed ~3x as often as the climb.
      const streetYaw =
        canyon && bot.flight.pos.y >= BOT_MIN_ALT
          ? this.streetEscape(bot, now)
          : null;
      if (streetYaw !== null) {
        bot.escapeYaw = streetYaw;
        const yawErr = wrapAngle(streetYaw - bot.flight.yaw);
        bot.input = {
          pitch: BOT_INPUT_CAP,
          turn: clamp(-yawErr * BOT_STEER_GAIN, -BOT_INPUT_CAP, BOT_INPUT_CAP),
          roll: 0,
          throttle: -1,
        };
        return;
      }
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
    const blocked = this.blockedAlong(
      bot.flight,
      now,
      fwd.x,
      fwd.z,
      fwd.y,
      margin,
    );

    if (now < bot.evadeUntil) {
      if (blocked) {
        recover(false);
        return;
      }
      bot.state = "EVADE";
      bot.fought = true;
      // Down in a street a break turn is a turn into the facade: run along
      // the street instead.
      const run = this.streetBreak(bot, now);
      if (run) {
        this.steerToward(bot, run, 0, 0, 0);
        return;
      }
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
      bot.fought = true;
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
      // The fight stays in the city: a brief climbing pass at a high target,
      // otherwise a chase along its ground track down among the towers.
      const passing = this.attackPass(bot, now, target, dist, aim);
      if (passing) {
        // Steep enough to bring the guns to bear, never a vertical zoom.
        aim.y = Math.min(aim.y, Math.hypot(aim.x, aim.z) * BOT_ATTACK_CLIMB);
      } else {
        this.holdBand(bot, now, target, aim);
      }
      // The fan's first candidate IS the pursuit vector, so an unobstructed
      // chase steers exactly as it always did (steerToward reads direction
      // only, so a normalized survivor and the raw lead vector are the same
      // command). A blocked line yields the nearest clear heading instead of
      // cancelling the chase.
      const heading = this.fanAround(bot, now, aim, margin);
      // Down among the towers a straight chase is a line across the blocks,
      // and weaving after a target over them is what kills canyon bots
      // (measured: every low crash in the first all-canyon sim was a slow
      // bot over a block). So below the probe split the bot flies straight
      // at its target only with a clear line AND a reason to — inside gun
      // range, or with the target up the street it is already flying. The
      // rest of the time it chases along the street lattice, the same flying
      // PATROL does safely, until the shot opens up.
      if (
        !passing &&
        bot.flight.pos.y < BOT_CANYON_PROBE_ALT &&
        (!heading?.direct ||
          (dist > BOT_FIRE_RANGE && !this.alongStreet(bot.flight, aim)))
      ) {
        if (blocked) {
          recover(false);
          return;
        }
        if (!bot.streetChase) {
          // Coming off a direct chase: the old waypoint is wherever the bot
          // was before it left the lattice.
          bot.waypoint = null;
          bot.travel = null;
          bot.streetChase = true;
        }
        this.canyonPatrol(bot, target.pos);
        return;
      }
      bot.streetChase = false;
      if (heading) {
        // Weaving means the terrain is close, and turn radius is speed / 0.765
        // rad/s — so the bot that keeps its throttle buried is the bot that
        // cannot make the gap. Only a clear pursuit line gets full power, and
        // down in a street not even that: a 90 m/s turn is ~118 m across and
        // the street is 40. Diving home after a pass bleeds speed too, so it
        // reaches the street slow enough to fly it.
        const low = bot.flight.pos.y < BOT_CANYON_PROBE_ALT;
        const diving = !passing && now < bot.attackCooldownUntil && !low;
        let throttle = heading.direct ? (low ? 0 : 1) : -1;
        if (passing) throttle = 1;
        else if (diving) throttle = -1;
        this.steerToward(
          bot,
          heading.dir,
          bot.aimJitterYaw,
          bot.aimJitterPitch,
          throttle,
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

    // PATROL: the street lattice. Coming back from a fight, re-join the
    // NEAREST street — the waypoint picked before the chase may now be a
    // cross-country flight over the blocks.
    bot.state = "PATROL";
    bot.targetId = null;
    if (bot.fought) {
      bot.fought = false;
      bot.waypoint = null;
      bot.travel = null;
    }
    this.canyonPatrol(bot);
  }

  /**
   * Is a climbing attack pass at `target` running (or starting now)? Only a
   * target above BOT_ENGAGE_CEILING earns one, only inside BOT_FIRE_RANGE with
   * the bot already lined up in plan view, and only once per pass +
   * BOT_ATTACK_COOLDOWN_MS — so a high human gets brief zoom-climb
   * shots, and the bot spends the rest of its time back in the streets.
   */
  private attackPass(
    bot: Bot,
    now: number,
    target: BotContact,
    dist: number,
    aim: Vec3,
  ): boolean {
    if (now < bot.attackUntil) return true;
    if (now < bot.attackCooldownUntil) return false;
    if (target.pos.y <= BOT_ENGAGE_CEILING || dist > BOT_FIRE_RANGE) {
      return false;
    }
    // Lined up in plan view — which a target nearly overhead never is: its
    // bearing is noise, and a pass at it would be a vertical climb through
    // the crane layer at MIN_SPEED. holdBand extends away from it instead.
    const flat = Math.hypot(aim.x, aim.z);
    const yawErr = Math.abs(
      wrapAngle(Math.atan2(-aim.x, -aim.z) - bot.flight.yaw),
    );
    if (flat < BOT_ENGAGE_OVERHEAD || yawErr > BOT_ATTACK_YAW) return false;
    bot.attackUntil = now + BOT_ATTACK_PASS_MS;
    bot.attackCooldownUntil = bot.attackUntil + BOT_ATTACK_COOLDOWN_MS;
    return true;
  }

  /**
   * Keep a pursuit (`aim`, a delta from the bot) in the canyon band: aim no
   * higher than BOT_ENGAGE_CEILING — or the bot's own band while it dives home
   * after a pass — descending no steeper than BOT_CANYON_GLIDE so it arrives
   * in a street slow and shallow enough to fly it. A target LOW enough is
   * followed down unchanged: bots chase players into the streets.
   */
  private holdBand(bot: Bot, now: number, target: BotContact, aim: Vec3): void {
    const top = now < bot.attackCooldownUntil ? bot.bandY : BOT_ENGAGE_CEILING;
    const cap = top - bot.flight.pos.y;
    if (aim.y <= cap) return;
    // Nearly underneath a high target the clamped aim has almost no
    // horizontal part, and its bearing would swing every decision — extend
    // along the current heading instead, which sets up the next pass.
    if (
      target.pos.y > BOT_ENGAGE_CEILING &&
      Math.hypot(aim.x, aim.z) < BOT_ENGAGE_OVERHEAD
    ) {
      const fwd = flightForward({ yaw: bot.flight.yaw, pitch: 0 });
      aim.x = fwd.x * BOT_EVADE_STREET_LEAD;
      aim.z = fwd.z * BOT_EVADE_STREET_LEAD;
    }
    aim.y = Math.max(cap, -Math.hypot(aim.x, aim.z) * BOT_CANYON_GLIDE);
  }

  /**
   * A low EVADE's escape run, as a steering delta: along the street the bot is
   * flying (streetAxis), toward a lead point on its centreline jinked from
   * side to side. Null above the probe split or off a street.
   */
  private streetBreak(bot: Bot, now: number): Vec3 | null {
    const { pos } = bot.flight;
    if (pos.y >= BOT_CANYON_PROBE_ALT) return null;
    const axis = this.streetAxis(bot.flight);
    if (!axis) return null;
    const centerline =
      Math.round((axis === "x" ? pos.z : pos.x) / BLOCK_PITCH) * BLOCK_PITCH;
    const fwd = flightForward({ yaw: bot.flight.yaw, pitch: 0 });
    const along = axis === "x" ? fwd.x : fwd.z;
    const lead = (along >= 0 ? 1 : -1) * BOT_EVADE_STREET_LEAD;
    const side = Math.floor(now / BOT_EVADE_JINK_MS) % 2 === 0 ? 1 : -1;
    const jink = side * bot.breakTurn * BOT_EVADE_JINK;
    return wrapDelta(
      pos,
      axis === "x"
        ? { x: pos.x + lead, y: bot.bandY, z: centerline + jink }
        : { x: centerline + jink, y: bot.bandY, z: pos.z + lead },
    );
  }

  /** Is `aim` (a plan-view delta) up the street this flight is flying? */
  private alongStreet(flight: FlightState, aim: Vec3): boolean {
    const axis = this.streetAxis(flight);
    if (!axis) return false;
    const flat = Math.hypot(aim.x, aim.z);
    if (flat === 0) return false;
    return (
      Math.abs(axis === "x" ? aim.x : aim.z) / flat >= Math.cos(BOT_ATTACK_YAW)
    );
  }

  /**
   * The travel axis of the street this flight is flying ALONG — over its
   * roadway with the nose within 45° of it — or null. In an intersection
   * either street qualifies. Past 45° the turn onto it is a ~100 m arc at
   * speed, wider than the 40 m street, so that flight is crossing, not
   * following.
   */
  private streetAxis(flight: FlightState): "x" | "z" | null {
    const fwd = flightForward({ yaw: flight.yaw, pitch: 0 });
    // A north–south street lies on a line of constant x and is travelled
    // along z (street.ts's axis convention), and vice versa.
    if (
      offCenterline(flight.pos.x) <= ROADWAY_HALF &&
      Math.abs(fwd.z) >= Math.SQRT1_2
    ) {
      return "z";
    }
    if (
      offCenterline(flight.pos.z) <= ROADWAY_HALF &&
      Math.abs(fwd.x) >= Math.SQRT1_2
    ) {
      return "x";
    }
    return null;
  }

  /**
   * A heading for a low RECOVER's pull-up to turn onto, as a yaw — clear at
   * level on the canyon probe profile — or null when there is none. The latched escape first (re-picking every decision would flap like
   * an unlatched break turn), then the street directions nearest the nose
   * (the lattice is axis-aligned, so those are the four quarter yaws; never
   * one behind the bot), then the fan's yaw offsets toward the break side.
   */
  private streetEscape(bot: Bot, now: number): number | null {
    const { flight } = bot;
    const clear = (yaw: number): boolean => {
      const d = flightForward({ yaw, pitch: 0 });
      return !this.blockedAlong(
        flight,
        now,
        d.x,
        d.z,
        0,
        1,
        BOT_CANYON_PROBE_TIMES,
      );
    };
    if (bot.escapeYaw !== null && clear(bot.escapeYaw)) return bot.escapeYaw;
    const streets = [0, Math.PI / 2, Math.PI, -Math.PI / 2]
      .map((yaw) => ({ yaw, err: Math.abs(wrapAngle(yaw - flight.yaw)) }))
      .filter((c) => c.err <= Math.PI / 2)
      .sort((a, b) => a.err - b.err)
      .map((c) => c.yaw);
    const offsets = BOT_FAN_YAW.flatMap((off) => [
      flight.yaw - bot.breakTurn * off,
      flight.yaw + bot.breakTurn * off,
    ]);
    for (const yaw of [...streets, ...offsets]) {
      if (clear(yaw)) return yaw;
    }
    return null;
  }

  /**
   * Fly the street lattice: hold the centerline to the next intersection,
   * then take a seeded straight/left/right. Two concessions to the flight
   * model, both measured: bleed throttle into a corner (turn radius is
   * speed / 0.765 rad/s, so slowing is the ONLY way to tighten it), and hop
   * — a 90° turn sweeps ~52 m, wider than any roadway, so it must cross the
   * block corner and wants vertical margin over whatever stands there.
   */
  private canyonPatrol(bot: Bot, toward?: Vec3): void {
    // Reaching a waypoint is a GROUND-TRACK test: the lattice is a plan-view
    // graph and altitude is the glide's business. Measuring it in 3D strands a
    // bot that is still high above the intersection it is aiming at.
    let d = bot.waypoint
      ? wrapDelta(bot.flight.pos, bot.waypoint)
      : { x: 0, y: 0, z: 0 };
    if (!bot.waypoint || Math.hypot(d.x, d.z) < BOT_CANYON_WAYPOINT_RADIUS) {
      bot.waypoint = this.nextCanyonWaypoint(bot, toward);
      d = wrapDelta(bot.flight.pos, bot.waypoint);
    }
    let flat = Math.hypot(d.x, d.z);
    // Off the street being joined (a bot back from a fight, over a block):
    // MERGE onto it — a shallow line to a point up the street, holding
    // altitude — rather than cutting the block corner to the intersection
    // at street height, which is exactly where the facades are.
    const merge = this.mergePoint(bot, d);
    if (merge) {
      d = merge;
      flat = Math.hypot(d.x, d.z);
    }
    const yawErr = Math.abs(wrapAngle(Math.atan2(-d.x, -d.z) - bot.flight.yaw));
    const turning = yawErr > BOT_CANYON_TURN_YAW;
    const slowing = turning || flat < BOT_CANYON_SLOW_RADIUS;
    // The hop raises the TARGET altitude (never the commanded climb), then the
    // glide caps how steeply the bot may descend toward it — so arriving from
    // RESPAWN_ALTITUDE is a slope down the lattice, not a plunge.
    let targetY = bot.waypoint.y + (slowing ? BOT_CANYON_HOP : 0);
    if (merge) targetY = Math.max(targetY, bot.flight.pos.y);
    const dy = Math.max(targetY - bot.flight.pos.y, -flat * BOT_CANYON_GLIDE);
    // Never accelerate on a canyon patrol: turn radius is speed / 0.765 rad/s,
    // so a street-grid bot has to arrive at a corner near MIN_SPEED or its arc
    // cuts the block. Throttle only ever holds or bleeds here; a chase (ENGAGE)
    // is free to firewall it.
    this.steerToward(bot, { x: d.x, y: dy, z: d.z }, 0, 0, slowing ? -1 : 0);
  }

  /**
   * Where a bot that is not over its street's roadway should steer instead of
   * the waypoint (`d`, the delta to it): a point on the street's centreline
   * up to BOT_CANYON_MERGE_LEAD further along — never past the waypoint — so
   * the merge is shallow. Null when already over the roadway (or no street).
   */
  private mergePoint(bot: Bot, d: Vec3): Vec3 | null {
    const { travel } = bot;
    if (!travel || !bot.waypoint) return null;
    const pos = bot.flight.pos;
    // The travel line's centreline is the waypoint's cross coordinate.
    const off = wrapDelta(pos, bot.waypoint);
    const lateral = travel.axis === "x" ? off.z : off.x;
    if (Math.abs(lateral) <= ROADWAY_HALF) return null;
    const along = (travel.axis === "x" ? d.x : d.z) * travel.dir;
    const lead = Math.max(0, Math.min(BOT_CANYON_MERGE_LEAD, along));
    return travel.axis === "x"
      ? { x: travel.dir * lead, y: d.y, z: lateral }
      : { x: lateral, y: d.y, z: travel.dir * lead };
  }

  /** The next lattice intersection to fly to, at this bot's band altitude —
   * on a street chase, taking whichever way at the corner heads `toward` the
   * target. */
  private nextCanyonWaypoint(bot: Bot, toward?: Vec3): Vec3 {
    const fwd = flightForward(bot.flight);
    if (!bot.travel) {
      // Joining the lattice (a fresh spawn, or a bot back from a fight that
      // may be over a block): adopt the nearest street running the way we
      // already face — a perpendicular one is a 90° turn away — heading
      // whichever way along it the nose points, and aim at an intersection
      // far enough ahead to merge onto the street before reaching it.
      const pos = bot.flight.pos;
      const axis = Math.abs(fwd.x) >= Math.abs(fwd.z) ? "x" : "z";
      const dir = (axis === "x" ? fwd.x : fwd.z) >= 0 ? 1 : -1;
      const cross = axis === "x" ? pos.z : pos.x;
      const centerline = Math.round(cross / BLOCK_PITCH) * BLOCK_PITCH;
      bot.travel = { axis, dir };
      const p = nextIntersection(
        axis === "x"
          ? { x: pos.x + dir * BOT_CANYON_SLOW_RADIUS, y: 0, z: pos.z }
          : { x: pos.x, y: 0, z: pos.z + dir * BOT_CANYON_SLOW_RADIUS },
        { axis, centerline },
        dir,
      );
      return { x: p.x, y: bot.bandY, z: p.z };
    }
    // Standing on an intersection: carry straight on, or turn onto the cross
    // street. Both draws come from the per-bot stream, never Math.random.
    const at = bot.waypoint ?? bot.flight.pos;
    if (toward) {
      bot.travel = this.chaseTurn(bot.travel, wrapDelta(at, toward));
    } else if (bot.rand() >= BOT_CANYON_STRAIGHT_CHANCE) {
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
   * A street chase's way out of an intersection: straight on, left or right
   * (never back — a U-turn is wider than any street), whichever points most
   * nearly along `d`, the plan-view delta to the target.
   */
  private chaseTurn(
    travel: { axis: "x" | "z"; dir: 1 | -1 },
    d: Vec3,
  ): { axis: "x" | "z"; dir: 1 | -1 } {
    const along = travel.axis === "x" ? d.x : d.z;
    const cross = travel.axis === "x" ? d.z : d.x;
    // Straight on wins unless the target is more off to the side than ahead.
    if (along * travel.dir >= Math.abs(cross)) return travel;
    return { axis: travel.axis === "x" ? "z" : "x", dir: cross >= 0 ? 1 : -1 };
  }

  /**
   * The contact this bot should hunt: the best-ranked living, unprotected one
   * in detect range that it can actually SEE (never self). Ranking is
   * distance plus a penalty per metre above BOT_ENGAGE_CEILING — the fight at
   * the bot's own altitude beats a nearer one up high — with the current
   * target held unless another beats it by BOT_RETARGET_MARGIN.
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
    const inRange: { c: BotContact; score: number }[] = [];
    for (const c of contacts) {
      if (c.id === bot.entry.id || c.prot) continue;
      const dist = wrapDistance(bot.flight.pos, c.pos);
      if (dist > BOT_DETECT_RANGE) continue;
      const score =
        dist +
        Math.max(0, c.pos.y - BOT_ENGAGE_CEILING) * BOT_ACQUIRE_ALT_WEIGHT -
        (c.id === bot.targetId ? BOT_RETARGET_MARGIN : 0);
      inRange.push({ c, score });
    }
    inRange.sort((a, b) => a.score - b.score);
    // Best first, stopping at the first one actually visible. The budget
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
    now: number,
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
        now,
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
          !this.blockedAlong(
            bot.flight,
            now,
            dir.x,
            dir.z,
            dir.y,
            margin,
            times,
          )
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
    now: number,
    dx: number,
    dz: number,
    dy: number,
    margin = 1,
    times?: readonly number[],
  ): boolean {
    const canyon = flight.pos.y < BOT_CANYON_PROBE_ALT;
    const radius =
      (canyon ? BOT_CANYON_PROBE_RADIUS : BOT_PROBE_RADIUS) * margin;
    const profile =
      times ?? (canyon ? BOT_CANYON_PROBE_TIMES : BOT_PROBE_TIMES);
    for (let i = 0; i < profile.length; i++) {
      const t = profile[i] ?? 0;
      const s = flight.speed * t;
      const p = canonicalize({
        x: flight.pos.x + dx * s,
        y: flight.pos.y + dy * s,
        z: flight.pos.z + dz * s,
      });
      if (p.y - radius <= 0) return true;
      if (collideCity(p, radius, this.buildings, this.cityIndex)) return true;
      if (!this.probeMovers) continue;
      // Movers need a SWEPT test, not the point sample buildings get. This
      // profile places samples 16-22 m apart at combat speed, which is fine
      // against a 40 m facade and useless against a 2.6 m crane boom — it
      // simply falls between two samples. So the mover sphere is grown to
      // half the gap to the previous sample, which makes consecutive samples
      // tile the probe ray exactly instead of dotting it. Over-avoidance is
      // the safe direction here: bots must never die to scenery.
      // The first sample also has to cover the gap back to the bot's NOSE.
      // Decisions are 200 ms apart (BOT_DECISION_EVERY at TICK_DOWN_HZ), which
      // is ~11 m of travel at combat speed — more than enough for a 6 m mast
      // to appear inside the first sample's blind spot between two decisions.
      const prev = i === 0 ? -s : flight.speed * (profile[i - 1] ?? 0);
      const swept = radius + (s - prev) / 2 + BOT_MOVER_CLEAR;
      // Posed at the ARRIVAL time, not now: `p` is where the bot will be t
      // seconds from here, and the jib slews the whole way there — over
      // max(BOT_PROBE_TIMES) that is more than PLAYER_RADIUS of tip travel,
      // so probing the present steers the bot into where the jib is going.
      if (collideBotMovers(p, swept, this.movers, now + t * 1000)) {
        return true;
      }
    }
    return false;
  }

  /** Which break-turn direction has clearer air? Probes the nose swung ±60°,
   * over the fan's longer STEERING horizon: this picks which way to go, and a
   * 0.9 s look cannot see far enough to make that choice well. */
  private clearSide(flight: FlightState, now: number): 1 | -1 {
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
            now,
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
