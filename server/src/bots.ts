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
// Threads (B2) sit outside the four states: a pass through an H1 hole —
// taken now and then off a patrol leg, or behind a target that just flew
// one. A bot commits to one only after flying the whole pass forward with
// stepFlight on the real geometry (see rolloutThread), so a committed thread
// replays a path already known to be clear and suspends every override.
//
// Bots never send hit claims: tick() emits trigger pulls (BotShot) and
// applyBotFire routes them through the existing Combat seam — same heat
// model, damage, spawn protection, kill credit, and respawn as humans.
// Since F4 a bot round is not hitscan: an accepted shot is launch()ed and
// flies at the same speed a human bullet does, each tick sweeping its path
// against where its target ACTUALLY went, so a target that jinks inside the
// bullet's flight time dodges it exactly as it would dodge a human's.

import {
  type Building,
  type HoleEdge,
  cityHoles,
  edgeFrame,
  holeEdges,
  mulberry32,
  segmentThroughHole,
} from "@angels-bandits/common/city";
import {
  EMPTY_MOVERS,
  type MoverField,
  collideBotMovers,
} from "@angels-bandits/common/city/movers";
import { bridgeSpans } from "@angels-bandits/common/city/river";
import {
  LOT_LINE,
  ROADWAY_HALF,
  nextIntersection,
  offCenterline,
} from "@angels-bandits/common/city/street";
import { trainFloor } from "@angels-bandits/common/city/train";
import {
  type CityIndex,
  EMPTY_NATURE_INDEX,
  type NatureIndex,
  buildCityIndex,
  collideCity,
  collideNature,
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
  BOT_HOLE_CARROT,
  BOT_HOLE_CHANCE,
  BOT_HOLE_FOLLOW_MS,
  BOT_HOLE_FOLLOW_RANGE,
  BOT_HOLE_LINEUP_MAX,
  BOT_HOLE_MARGIN,
  BOT_HOLE_RETRY_MS,
  BOT_HOLE_ROLLOUTS_PER_TICK,
  BOT_HOLE_ROLLOUT_S,
  BOT_HOLE_TURN_IN_MAX,
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
  BOT_SPAWN_GRACE_MS,
  BOT_SPAWN_SPEED,
  BOT_STEER_GAIN,
  BOT_THREAT_RANGE,
  BULLET_LIFETIME_S,
  BULLET_SPEED,
  HIT_RADIUS,
  HOLE_RUN_OUT,
  PITCH_LIMIT,
  PLAYER_RADIUS,
  TICK_DOWN_HZ,
  TRAIN_BOT_REACH,
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

/** A bot round that met its target this tick (F4) — what landBotRound
 * settles through Combat.hit. */
export interface BotRoundHit {
  shot: BotShot;
  /** The shooter's position when the round landed (its on-record pose). */
  shooterPos: Vec3;
  /** Where the target was when the round met it. */
  targetPos: Vec3;
}

/** One bot round in flight. */
interface BotRound {
  shot: BotShot;
  firedAt: number;
  /** World velocity, m/s: the nose × (BULLET_SPEED + shooter airspeed) — a
   * human bullet's speed (guns.ts), so bots lead by the same rule. */
  vel: Vec3;
  /** Time, ms, the round's path has been swept up to. */
  sweptTo: number;
  /** The target's position at `sweptTo`. */
  targetAt: Vec3;
}

export interface BotTickResult {
  shots: BotShot[];
  /** Earlier rounds that met their target this tick, swept before anyone
   * moved — settle each through landBotRound. */
  hits: BotRoundHit[];
  /** Bots that flew into a building or the ground this tick (marked dead
   * here; the caller settles the death through Combat.crash). */
  crashes: string[];
}

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));

/** A contact moving further than this in one tick respawned, m. */
const TRANSIT_JUMP = 50;

/** Seconds a round fired at `shooterSpeed` takes to cover `dist` — the one
 * lead time the pursuit aim and the trigger cone both use. */
const leadTime = (dist: number, shooterSpeed: number): number =>
  dist / (BULLET_SPEED + shooterSpeed);

/**
 * Does a round at `origin + vel·t` pass within HIT_RADIUS of its target over
 * the flight window [t0, t1] s, while the target moves (linearly) from `from`
 * to `to`? The sweep is in the target's frame — the relative segment's
 * closest approach to it — so a fast crossing round cannot tunnel through a
 * 15 m hit sphere between ticks. Torus-safe: both ends go through wrapDelta.
 */
export function roundMeets(
  origin: Vec3,
  vel: Vec3,
  t0: number,
  t1: number,
  from: Vec3,
  to: Vec3,
): boolean {
  const r0 = wrapDelta(from, {
    x: origin.x + vel.x * t0,
    y: origin.y + vel.y * t0,
    z: origin.z + vel.z * t0,
  });
  const r1 = wrapDelta(to, {
    x: origin.x + vel.x * t1,
    y: origin.y + vel.y * t1,
    z: origin.z + vel.z * t1,
  });
  const dx = r1.x - r0.x;
  const dy = r1.y - r0.y;
  const dz = r1.z - r0.z;
  const len2 = dx * dx + dy * dy + dz * dz;
  const k =
    len2 > 0 ? clamp(-(r0.x * dx + r0.y * dy + r0.z * dz) / len2, 0, 1) : 0;
  const px = r0.x + dx * k;
  const py = r0.y + dy * k;
  const pz = r0.z + dz * k;
  return px * px + py * py + pz * pz <= HIT_RADIUS * HIT_RADIUS;
}

/** Smallest signed angle equivalent, in [-π, π]. */
const wrapAngle = (a: number): number => {
  const twoPi = Math.PI * 2;
  const m = ((a % twoPi) + twoPi) % twoPi;
  return m > Math.PI ? m - twoPi : m;
};

const NEUTRAL: FlightInput = { pitch: 0, turn: 0, roll: 0, throttle: 0 };

/** Proportional rate steering toward the (torus) delta `d`, inputs capped
 * below the player envelope; null for a zero delta (hold the stick). */
function steerInput(
  flight: FlightState,
  d: Vec3,
  jitterYaw: number,
  jitterPitch: number,
  throttle: number,
): FlightInput | null {
  const len = Math.hypot(d.x, d.y, d.z);
  if (len === 0) return null;
  const desiredYaw = Math.atan2(-d.x, -d.z) + jitterYaw;
  const yawErr = wrapAngle(desiredYaw - flight.yaw);
  const desiredPitch = Math.asin(clamp(d.y / len, -1, 1)) + jitterPitch;
  const pitchErr = desiredPitch - flight.pitch;
  return {
    // turn +1 decreases yaw, so a positive yaw error needs negative turn.
    turn: clamp(-yawErr * BOT_STEER_GAIN, -BOT_INPUT_CAP, BOT_INPUT_CAP),
    pitch: clamp(pitchErr * BOT_STEER_GAIN, -BOT_INPUT_CAP, BOT_INPUT_CAP),
    roll: 0,
    throttle,
  };
}

/** A street-lattice heading: travel axis and which way along it. */
type Travel = { axis: "x" | "z"; dir: 1 | -1 };

/**
 * One committed (or candidate) pass through a hole. Everything the thread
 * controller reads lives here, so a rollout can fly a copy of it and the
 * live bot then flies the original through exactly the same inputs.
 */
interface Thread {
  edge: HoleEdge;
  /** How the bot leaves: onto the street that crosses the hole's axis past
   * the exit (`edge.to`), heading this way along it — or, when null, straight
   * down H1's guaranteed-clear run-out. */
  exit: Travel | null;
  /** Every exit a rollout passed, `exit` among them. A follow keeps both
   * street turns and takes the one toward its target as it clears the far
   * mouth (pickExit) — at commit the target is still in the hole, and which
   * way it turns is not known yet. */
  exits: (Travel | null)[];
  /** The bot's band altitude: an exit street climbs back toward it. */
  bandY: number;
  /** Past the far mouth (sticky). */
  out: boolean;
}

/** Hand back once lined up on the exit street this well: m off its
 * centreline, rad off its heading. */
const EXIT_LATERAL = 5;
const EXIT_YAW = 0.2;
/** A runout hands back this short of H1's clear run-out, m — the corridor is
 * guaranteed, the merge after it is the lattice's business. */
const RUNOUT_SLACK = 20;

/** How far ahead RECOVER checks its pull-up against the movers, s. */
const RECOVER_LOOK_S = 1.2;

/** L11 bridge threads: the steepest dive into an underpass and the climb out
 * of the channel after it, as slopes (m per m along the carrot). */
const BRIDGE_DIVE = 0.8;
const BRIDGE_CLIMB = 0.3;

/**
 * The thread controller: line-follow the hole's axis (a carrot
 * BOT_HOLE_CARROT ahead on the centreline, height on the centreline), then
 * the exit street or the run-out. Pure in (flight, thread) — no clock, no
 * rand, no contacts — which is what lets a rollout predict the live flight
 * bit for bit. Returns null once the pass is over (hand back to the brain).
 */
function threadInput(f: FlightState, th: Thread): FlightInput | null {
  const { edge } = th;
  const { axis } = edge.span.hole;
  const L = BOT_HOLE_CARROT;
  const fr = edgeFrame(edge, f.pos);
  if (fr.along >= edge.span.length) th.out = true;
  if (!th.out || !th.exit) {
    if (th.out && fr.along >= edge.span.length + HOLE_RUN_OUT - RUNOUT_SLACK) {
      return null;
    }
    // Never a corner hop and never a dive steeper than the canyon glide: the
    // lintel is a few metres over the centreline.
    let dy = clamp(-fr.up, -L * BOT_CANYON_GLIDE, L * BOT_CANYON_GLIDE);
    if (edge.span.hole.kind === "bridge") {
      // L11: the river is open sky above, so the dive in may be steeper —
      // a bot in the canyon band needs it to reach the underpass inside the
      // 160 m between two decks. Past the exit the run-out climbs back
      // toward the band, so the hand-back is out of the channel and clear of
      // the next deck rather than 40 m short of it at water level. Both are
      // flown by the rollout before the bot commits.
      dy = th.out
        ? clamp(th.bandY - f.pos.y, -L * BOT_CANYON_GLIDE, L * BRIDGE_CLIMB)
        : clamp(-fr.up, -L * BRIDGE_DIVE, L * BOT_CANYON_GLIDE);
    }
    const d =
      axis === "x"
        ? { x: edge.dir * L, y: dy, z: -fr.lateral }
        : { x: -fr.lateral, y: dy, z: edge.dir * L };
    return steerInput(f, d, 0, 0, th.out ? 0 : -1);
  }
  // The exit street runs across the hole's axis through edge.to.
  const { exit } = th;
  const off = wrapDelta(edge.to, f.pos);
  const lateral = axis === "x" ? off.x : off.z;
  const fwd = flightForward({ yaw: f.yaw, pitch: 0 });
  const heading = (exit.axis === "x" ? fwd.x : fwd.z) * exit.dir;
  if (Math.abs(lateral) < EXIT_LATERAL && heading > Math.cos(EXIT_YAW)) {
    return null;
  }
  const dy = clamp(th.bandY - f.pos.y, -L * BOT_CANYON_GLIDE, L * 0.3);
  const d =
    exit.axis === "x"
      ? { x: exit.dir * L, y: dy, z: -lateral }
      : { x: -lateral, y: dy, z: exit.dir * L };
  return steerInput(f, d, 0, 0, -1);
}

/** A fresh bot's graceUntil: unstamped (NaN) for a spawn in the canyons, none
 * at all for a high one — see Bot.graceUntil. */
const streetGrace = (spawn: SpawnState): number =>
  spawn.pos.y < BOT_CANYON_PROBE_ALT ? Number.NaN : Number.NEGATIVE_INFINITY;

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
  /** End of the post-spawn straight patrol, ms — NaN until the first
   * decision after a (re)spawn stamps it (the brain has no clock of its own
   * at spawn time). Only a spawn down IN a street gets one: the grace is for
   * settling into the street before the fight, and a high (fallback) spawn
   * has no street to settle into. */
  graceUntil: number;
  /** Is the current ENGAGE chasing along the street lattice (pursuit line
   * blocked) rather than flying straight at the target? */
  streetChase: boolean;
  /** The hole pass this bot is committed to (B2), or null. */
  thread: Thread | null;
  /** Hole routing's own seeded stream — salted off the bot's seed so B1's
   * `rand` sequence (patrol turns, jitter, break turns) is untouched. */
  holeRand: () => number;
  /** Patrol hole encounters by edge index: the roll's outcome, and when a
   * won roll may next try a rollout, ms. Dropped when the edge stops being
   * a candidate, so the next pass by is a fresh roll. */
  holeRolls: Map<number, { won: boolean; retryAt: number }>;
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
  /** Rounds in flight (F4), oldest first. */
  private rounds: BotRound[] = [];
  /** Every contact's position as of the latest tick — where launch() starts
   * a round's target track. */
  private contactPos = new Map<string, Vec3>();
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
    /**
     * The solid N1 trees (park + forecourt), from the SAME seed as
     * `buildings`. Static, so the physics tick and the probes test it like
     * buildings. Sight lines (losClear) deliberately ignore it: foliage is
     * see-through, and a canopy is not cover.
     */
    private readonly nature: NatureIndex = EMPTY_NATURE_INDEX,
  ) {
    this.rand = mulberry32(seed);
    // Built once per room over the shared city array. Bots are the heaviest
    // collision consumer in the game (a physics probe per bot per tick plus
    // four nose probes per brain decision, all bots deciding on the same
    // tick), so the block index is what keeps that off the 15 Hz budget.
    this.cityIndex = buildCityIndex(buildings);
    // L11: every river bridge's underpass is an edge too (kind "bridge"),
    // appended AFTER the city's holes so their edge indices are unchanged.
    this.edges = holeEdges([...cityHoles(buildings), ...bridgeSpans()]);
  }

  /** Block index over `buildings` — see collideCity's optional 4th argument. */
  private readonly cityIndex: CityIndex;
  /** Every hole as two directed street-graph edges (H1's shared seam). */
  private readonly edges: readonly HoleEdge[];
  /** Each living contact's position last tick, for hole-transit tracking. */
  private readonly contactPrev = new Map<string, Vec3>();
  /** The last hole each contact flew through: edge index and when, ms. */
  private readonly transits = new Map<string, { edge: number; at: number }>();
  /** Rollouts left this tick (BOT_HOLE_ROLLOUTS_PER_TICK). */
  private rolloutsLeft = 0;

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
    const botSeed = Math.floor(this.rand() * 0xffffffff);
    const rand = mulberry32(botSeed);
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
      graceUntil: streetGrace(spawn),
      streetChase: false,
      thread: null,
      holeRand: mulberry32((botSeed ^ 0x2545f491) >>> 0),
      holeRolls: new Map(),
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

  /** The hole edge a bot is threading, or null — read-only, for the sim. */
  threadOf(id: string): HoleEdge | null {
    return this.bots.get(id)?.thread?.edge ?? null;
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

  /** The stick a bot is currently holding — read-only, for the sim's logs. */
  inputOf(id: string): FlightInput | undefined {
    return this.bots.get(id)?.input;
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

  /** Where a bot last was, alive or not — a crash marks it dead inside
   * tick(), before index.ts can ask poseOf(). The news heli (L10) needs it. */
  lastPosOf(id: string): Vec3 | null {
    return this.bots.get(id)?.flight.pos ?? null;
  }

  /** Death settled by Combat: freeze until respawn() reseeds the flight. */
  setDead(id: string): void {
    const bot = this.bots.get(id);
    if (!bot) return;
    bot.alive = false;
    bot.thread = null;
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
    bot.graceUntil = streetGrace(spawn);
    bot.streetChase = false;
    bot.thread = null;
    bot.holeRolls.clear();
  }

  /**
   * Is a (re)spawn at `pos` heading `yaw` (level) safe for a bot? The spawn
   * point and BOT_SPAWN_CLEAR_AHEAD of straight-ahead flight must miss the
   * city, the trees and the L2 movers — pickBotRespawn's predicate, so a
   * canyon spawn never lands in a facade, a canopy or a crane jib.
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
      if (hitsGround(p, BOT_PROBE_RADIUS)) return false;
      if (collideCity(p, BOT_PROBE_RADIUS, this.buildings, this.cityIndex)) {
        return false;
      }
      // The overlapping spheres already tile the run, so trees need no sweep.
      if (collideNature(p, BOT_PROBE_RADIUS, this.nature)) return false;
      if (
        collideBotMovers(
          p,
          BOT_PROBE_RADIUS + BOT_MOVER_CLEAR,
          this.movers,
          // Posed when the bot gets there, like blockedAlong: a jib slews.
          now + (s / BOT_SPAWN_SPEED) * 1000,
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
    this.rolloutsLeft = BOT_HOLE_ROLLOUTS_PER_TICK;
    this.trackTransits(now, contacts);
    const hits = this.flyRounds(now, contacts);

    for (const bot of this.bots.values()) {
      if (!bot.alive) continue;
      // Down among the towers the curved probe runs every tick, not just at
      // the 5 Hz decision: a decision is ~8 m of travel at MIN_SPEED, and a
      // wall on the inside of a turn closes that fast. A blocked path pulls
      // the next decision forward; it never sharpens anything else. A thread
      // is exempt: its rollout assumed the plain 5 Hz cadence, and an extra
      // decision would fly a path nobody checked.
      if (
        decide ||
        (!bot.thread &&
          bot.state !== "RECOVER" &&
          bot.flight.pos.y < BOT_CANYON_PROBE_ALT &&
          this.pathBlocked(bot, now, 1))
      ) {
        this.decide(bot, now, contacts);
      }
      bot.flight = stepFlight(bot.flight, bot.input, BOT_DT);

      // Identical geometry to players: solids (H1 holes open) + ground, PLAYER_RADIUS —
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
        collideBotMovers(bot.flight.pos, PLAYER_RADIUS, this.movers, now) ||
        collideNature(bot.flight.pos, PLAYER_RADIUS, this.nature)
      ) {
        bot.alive = false;
        crashes.push(bot.entry.id);
        continue;
      }

      const shot = this.maybeFire(bot, now, contacts);
      if (shot) shots.push(shot);
    }
    return { shots, hits, crashes };
  }

  /**
   * Put a trigger pull Combat ACCEPTED into the air (F4) — call it with the
   * same `now` as the tick that produced the shot. A rejected pull (heat,
   * cadence) never flies, exactly like a human's.
   */
  launch(shot: BotShot, now: number): void {
    const bot = this.bots.get(shot.botId);
    const targetAt = this.contactPos.get(shot.targetId);
    if (!bot?.alive || !targetAt) return;
    const v = BULLET_SPEED + bot.flight.speed;
    this.rounds.push({
      shot,
      firedAt: now,
      vel: { x: shot.dir.x * v, y: shot.dir.y * v, z: shot.dir.z * v },
      sweptTo: now,
      targetAt,
    });
  }

  /** Rounds still in flight (QA / tests). */
  roundsInFlight(): number {
    return this.rounds.length;
  }

  /**
   * Sweep every round from where its last tick left it to `now` against its
   * target's real motion over the same window. A round whose shooter died or
   * whose target is gone (or respawned) is dropped (Combat would refuse it anyway); one
   * that meets its target counts only with a clear line from the muzzle —
   * towers stop bot bullets as surely as they stop a pursuit.
   */
  private flyRounds(
    now: number,
    contacts: readonly BotContact[],
  ): BotRoundHit[] {
    this.contactPos = new Map(contacts.map((c) => [c.id, c.pos]));
    const hits: BotRoundHit[] = [];
    const flying: BotRound[] = [];
    const lifeEnd = BULLET_LIFETIME_S * 1000;
    for (const r of this.rounds) {
      const shooter = this.bots.get(r.shot.botId);
      const targetPos = this.contactPos.get(r.shot.targetId);
      if (!shooter?.alive || !targetPos) continue;
      // A target that jumped (respawned) is not the plane the round chased —
      // sweeping across the teleport could "hit" empty air between the two.
      if (wrapDistance(r.targetAt, targetPos) > TRANSIT_JUMP) continue;
      const end = Math.min(now, r.firedAt + lifeEnd);
      if (end <= r.sweptTo) continue;
      if (
        roundMeets(
          r.shot.origin,
          r.vel,
          (r.sweptTo - r.firedAt) / 1000,
          (end - r.firedAt) / 1000,
          r.targetAt,
          targetPos,
        )
      ) {
        if (losClear(r.shot.origin, targetPos, this.buildings)) {
          hits.push({
            shot: r.shot,
            shooterPos: shooter.flight.pos,
            targetPos,
          });
        }
        continue;
      }
      if (end < r.firedAt + lifeEnd) {
        flying.push({ ...r, sweptTo: end, targetAt: targetPos });
      }
    }
    this.rounds = flying;
    return hits;
  }

  /**
   * Record which contacts flew through a hole since last tick (segment vs the
   * hole's mid-plane, so a 20 Hz track never steps over a short sky hole).
   * A jump bigger than any tick's flight is a respawn, not a move; contacts
   * missing from the list (dead, left) are forgotten.
   */
  private trackTransits(now: number, contacts: readonly BotContact[]): void {
    const seen = new Set<string>();
    for (const c of contacts) {
      seen.add(c.id);
      const prev = this.contactPrev.get(c.id);
      this.contactPrev.set(c.id, c.pos);
      if (!prev || wrapDistance(prev, c.pos) > TRANSIT_JUMP) continue;
      this.edges.forEach((edge, i) => {
        // Both directions share a span: test it once, on its +1 edge.
        if (edge.dir !== 1) return;
        const dir = segmentThroughHole(edge.span, prev, c.pos);
        if (dir !== 0) {
          this.transits.set(c.id, { edge: dir === 1 ? i : i + 1, at: now });
        }
      });
    }
    for (const id of this.contactPrev.keys()) {
      if (seen.has(id)) continue;
      this.contactPrev.delete(id);
      this.transits.delete(id);
    }
  }

  // --- brain ---

  private decide(bot: Bot, now: number, contacts: readonly BotContact[]): void {
    // A committed thread outranks everything, the floor and the probes
    // included: its rollout already flew this exact path clear of the real
    // geometry, and the solid-hole probes would read the hole as a wall.
    if (bot.thread) {
      this.pickExit(bot, bot.thread, contacts);
      const input = threadInput(bot.flight, bot.thread);
      if (input) {
        bot.input = input;
        return;
      }
      this.endThread(bot);
    }
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
      // A recovery leaves the lattice as surely as a fight does: the waypoint
      // it was flying to may now be behind it, and turning back toward it is
      // what tripped the probe. PATROL re-joins the street ahead instead.
      bot.fought = true;
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
        const yawErr = wrapAngle(
          this.centredYaw(bot.flight, streetYaw) - bot.flight.yaw,
        );
        bot.input = {
          pitch: BOT_INPUT_CAP,
          turn: clamp(-yawErr * BOT_STEER_GAIN, -BOT_INPUT_CAP, BOT_INPUT_CAP),
          roll: 0,
          throttle: -1,
        };
      } else {
        bot.input = {
          // The ceiling dives back under the cloud deck; every other danger
          // (ground, tier boxes ≤ 250 m) pulls up — never both at once.
          pitch: dive ? -BOT_INPUT_CAP : BOT_INPUT_CAP,
          turn: bot.breakTurn * BOT_INPUT_CAP * 0.6,
          roll: 0,
          throttle: canyon ? -1 : 1,
        };
      }
      if (!dive) this.pullUpUnderMover(bot, now);
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
    // The curved probe only ever ENTERS a recovery early; leaving one stays
    // the straight probe's call at the hysteresis radius, as it always was —
    // a curved path sampled at that radius never clears beside a facade, and
    // the pull-up becomes a zoom climb.
    const blocked =
      this.blockedAlong(bot.flight, now, fwd.x, fwd.z, fwd.y, margin) ||
      (!wasRecover && this.pathBlocked(bot, now, 1));

    // Fresh off a spawn: fly the street straight before joining the fight.
    if (Number.isNaN(bot.graceUntil)) bot.graceUntil = now + BOT_SPAWN_GRACE_MS;
    if (now < bot.graceUntil) {
      if (blocked) {
        recover(false);
        return;
      }
      bot.state = "PATROL";
      bot.targetId = null;
      this.canyonPatrol(bot, undefined, true);
      return;
    }

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

      // The target just flew through a hole this bot can line up on: follow
      // it through rather than around. A committed follow holds ENGAGE and
      // the target (guns stay live) for the few seconds of the pass.
      if (this.followThrough(bot, now, target)) return;

      // Lead pursuit: aim where the target will be when a bullet arrives,
      // wandered by the seeded jitter (resampled per decision).
      bot.aimJitterYaw = (bot.rand() * 2 - 1) * BOT_AIM_JITTER;
      bot.aimJitterPitch = (bot.rand() * 2 - 1) * BOT_AIM_JITTER;
      const t = leadTime(dist, bot.flight.speed);
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
      // and a low bot over a block is in a maze of taller roofs: every crash
      // in the canyon sims was a slow bot over a block, and at that point no
      // stick input escapes (measured — a search over break/pull-up inputs
      // saved none). So below the probe split the bot flies straight at its
      // target only with a clear line AND the target up the street it is
      // already flying; otherwise it chases along the street lattice, the
      // same flying PATROL does safely, until the shot lines up. (Allowing
      // straight chases inside gun range too cost ~45% more crashes.)
      if (
        !passing &&
        bot.flight.pos.y < BOT_CANYON_PROBE_ALT &&
        (!heading?.direct || !this.alongStreet(bot.flight, aim))
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
        // Mid-street, below the roofline, a chase stays IN the street.
        const lane = low && !passing ? this.laneLock(bot, aim) : null;
        if (lane) {
          this.steerToward(bot, lane, 0, bot.aimJitterPitch, throttle);
          return;
        }
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
    const stageY = this.holeRouting(bot, now);
    if (bot.thread) return;
    this.canyonPatrol(bot, undefined, false, stageY);
  }

  // --- threads (B2) ---

  /**
   * A patrol's opportunistic hole: find the edges this bot's street leads
   * to, roll each once per encounter, and for a won roll stage the approach
   * and try to commit. Returns the altitude to stage at (the patrol flies
   * there instead of its band, with no corner hop), or undefined.
   *
   * Only arches and street tunnels: an arch is lined up off the cross street
   * its axis meets 55 m before the mouth; a tunnel off the parallel street,
   * jogging over onto its axis inside H1's clear corridor. Sky holes sit at
   * 69-157 m and are never worth a canyon bot's climb — they are only ever
   * followed (followThrough).
   */
  private holeRouting(bot: Bot, now: number): number | undefined {
    if (!bot.travel || this.edges.length === 0) return undefined;
    const axis = this.streetAxis(bot.flight);
    let stage: number | undefined;
    this.edges.forEach((edge, i) => {
      const window = axis ? this.holeWindow(bot, edge, axis) : null;
      if (window === null) {
        bot.holeRolls.delete(i);
        return;
      }
      let roll = bot.holeRolls.get(i);
      if (!roll) {
        roll = { won: bot.holeRand() < BOT_HOLE_CHANCE, retryAt: 0 };
        bot.holeRolls.set(i, roll);
      }
      if (!roll.won || bot.thread) return;
      // An arch's centreline is 5 m over BOT_MIN_ALT: stage a little above
      // it. A high tunnel stages under the probe split, so the street climb
      // keeps the canyon profile; the rollout covers the rest of the climb.
      stage ??= Math.min(edge.span.center.y + 4, BOT_CANYON_PROBE_ALT - 5);
      if (!window || now < roll.retryAt) return;
      if (!this.tryThread(bot, edge, now))
        roll.retryAt = now + BOT_HOLE_RETRY_MS;
    });
    return stage;
  }

  /**
   * Is `edge` ahead of this patrol? null: no. false: yes, but too far to
   * commit yet (stage only). true: inside the commit window.
   */
  private holeWindow(
    bot: Bot,
    edge: HoleEdge,
    streetAxis: "x" | "z",
  ): boolean | null {
    const { kind, axis } = edge.span.hole;
    // Sky holes and L11 bridge underpasses are only ever FOLLOWED: a dive
    // from the canyon band into the river is worth it only after a target.
    if (kind === "sky" || kind === "bridge") return null;
    const pos = bot.flight.pos;
    const fwd = flightForward({ yaw: bot.flight.yaw, pitch: 0 });
    if (kind === "arch") {
      // On the cross street through edge.from, flying toward the node.
      if (streetAxis === axis) return null;
      const d = wrapDelta(pos, edge.from);
      const across = axis === "x" ? d.x : d.z;
      if (Math.abs(across) > ROADWAY_HALF) return null;
      const ahead =
        (streetAxis === "x" ? d.x : d.z) *
        Math.sign(streetAxis === "x" ? fwd.x : fwd.z);
      if (ahead <= 0 || ahead > 2 * BOT_HOLE_TURN_IN_MAX) return null;
      return ahead <= BOT_HOLE_TURN_IN_MAX;
    }
    // Tunnel: on a street parallel to it, flying its way, mouth ahead.
    if (streetAxis !== axis) return null;
    if ((axis === "x" ? fwd.x : fwd.z) * edge.dir < Math.SQRT1_2) return null;
    const fr = edgeFrame(edge, pos);
    if (fr.along > -BOT_CANYON_SLOW_RADIUS || fr.along < -BOT_HOLE_LINEUP_MAX) {
      return null;
    }
    if (Math.abs(fr.lateral) > BLOCK_PITCH / 2) return null;
    return fr.along >= -BOT_HOLE_LINEUP_MAX / 2;
  }

  /**
   * A chaser's follow-through: its target flew through a hole within
   * BOT_HOLE_FOLLOW_MS and the bot is still short of the mouth it went in
   * by, close enough to line up — commit if the rollout passes. Otherwise
   * the chase carries on around the building (solid-hole probes, fan,
   * street chase): breaking off is the safe default, never a gamble.
   */
  private followThrough(bot: Bot, now: number, target: BotContact): boolean {
    const transit = this.transits.get(target.id);
    if (!transit || now - transit.at > BOT_HOLE_FOLLOW_MS) return false;
    const edge = this.edges[transit.edge];
    if (!edge) return false;
    const fr = edgeFrame(edge, bot.flight.pos);
    if (fr.along > -BOT_CANYON_PROBE_RADIUS) return false;
    if (wrapDistance(bot.flight.pos, edge.mouthIn) > BOT_HOLE_FOLLOW_RANGE) {
      return false;
    }
    return this.tryThread(bot, edge, now, true);
  }

  /**
   * Commit to `edge` if a rollout of some exit flies clean: the street exits
   * for an arch, the guaranteed run-out first for anything else. A follow
   * tries the street turn toward its target first (leaving the arch the
   * other way means a U-turn in a street to resume the chase); a patrol
   * picks its side with a seeded draw. Spends the room's rollout budget.
   */
  private tryThread(
    bot: Bot,
    edge: HoleEdge,
    now: number,
    follow = false,
  ): boolean {
    const across: "x" | "z" = edge.span.hole.axis === "x" ? "z" : "x";
    const first: 1 | -1 = bot.holeRand() < 0.5 ? 1 : -1;
    const streets: Travel[] = [
      { axis: across, dir: first },
      { axis: across, dir: first === 1 ? -1 : 1 },
    ];
    const { kind } = edge.span.hole;
    // Under a bridge the only way on is down the channel: a street exit
    // would turn into an embankment wall, so it is never worth a rollout.
    const order: (Travel | null)[] =
      kind === "arch"
        ? [...streets, null]
        : kind === "bridge"
          ? [null]
          : [null, ...streets];
    const passed: (Travel | null)[] = [];
    for (const exit of order) {
      // A patrol takes the first exit that flies; a follow wants both street
      // turns, so it can turn after its target (pickExit).
      if (passed.length > 0 && !(follow && exit && passed[0])) break;
      if (this.rolloutsLeft <= 0) break;
      this.rolloutsLeft--;
      const probe: Thread = {
        edge,
        exit,
        exits: [],
        bandY: bot.bandY,
        out: false,
      };
      if (this.rolloutThread(bot, probe, now)) passed.push(exit);
    }
    const exit = passed[0];
    if (exit === undefined) return false;
    const thread: Thread = {
      edge,
      exit,
      exits: passed,
      bandY: bot.bandY,
      out: false,
    };
    const input = threadInput(bot.flight, thread);
    if (!input) return false;
    bot.thread = thread;
    bot.input = input;
    return true;
  }

  /**
   * A follow's exit, chosen as the bot clears the far mouth — the decision
   * on which the controller turns to its exit, in the rollout as here: the
   * street turn toward the target if that turn's rollout passed.
   */
  private pickExit(
    bot: Bot,
    thread: Thread,
    contacts: readonly BotContact[],
  ): void {
    if (thread.out || thread.exits.length < 2) return;
    const { edge } = thread;
    if (edgeFrame(edge, bot.flight.pos).along < edge.span.length) return;
    const target = contacts.find((c) => c.id === bot.targetId);
    if (!target) return;
    const d = wrapDelta(edge.to, target.pos);
    for (const exit of thread.exits) {
      if (!exit) continue;
      if ((exit.axis === "x" ? d.x : d.z) * exit.dir > 0) thread.exit = exit;
    }
  }

  /**
   * Fly `thread` forward from the bot's live state exactly as tick() will:
   * the controller re-decides on the room's own BOT_DECISION_EVERY phase,
   * stepFlight in between, and every step is tested against the city (holes
   * OPEN), the trees, the ground and the movers (posed when the bot gets
   * there) with BOT_HOLE_MARGIN to spare. Steps are 2-4.5 m apart, under
   * the 6 m thinnest hole wall, so no wall or lintel falls between two.
   * True only if the pass ends (hands back) clean inside the horizon.
   */
  private rolloutThread(bot: Bot, thread: Thread, now: number): boolean {
    const r = PLAYER_RADIUS + BOT_HOLE_MARGIN;
    let f = bot.flight;
    let input: FlightInput = NEUTRAL;
    const steps = Math.round(BOT_HOLE_ROLLOUT_S / BOT_DT);
    for (let k = 0; k < steps; k++) {
      if (k === 0 || (this.tickCount + k) % BOT_DECISION_EVERY === 0) {
        const next = threadInput(f, thread);
        if (!next) return true;
        input = next;
      }
      f = stepFlight(f, input, BOT_DT);
      const t = now + k * BOT_DT * 1000;
      if (
        hitsGround(f.pos, r) ||
        collideCity(f.pos, r, this.buildings, this.cityIndex) ||
        collideNature(f.pos, r, this.nature) ||
        collideBotMovers(f.pos, r + BOT_MOVER_CLEAR, this.movers, t)
      ) {
        return false;
      }
    }
    return false;
  }

  /** The pass is over: hand back to the lattice. A street exit leaves the
   * bot flying that street to its next intersection; a run-out re-joins the
   * nearest street like a bot back from a fight. */
  private endThread(bot: Bot): void {
    const thread = bot.thread;
    bot.thread = null;
    bot.streetChase = false;
    if (!thread?.exit) {
      bot.fought = true;
      bot.waypoint = null;
      bot.travel = null;
      return;
    }
    const { exit, edge } = thread;
    const p = nextIntersection(
      bot.flight.pos,
      {
        axis: exit.axis,
        centerline: exit.axis === "x" ? edge.to.z : edge.to.x,
      },
      exit.dir,
    );
    bot.fought = false;
    bot.travel = exit;
    bot.waypoint = { x: p.x, y: bot.bandY, z: p.z };
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

  /**
   * A low chase's steering delta while it is over ONE street's roadway (not
   * an intersection, where turning onto the cross street is the point): up
   * that street the way the bot is already flying — at least a turn radius
   * ahead, a U-turn being wider than any street — offset toward the target
   * only as far as the roadway allows. Straight lead pursuit swung a low bot
   * 30–45° off the street axis and out of a 30 m roadway into the facades
   * within a second: once chases kept to the streets, that was the top crash
   * cause, and the sim's tuning seeds lost 26% of their crashes to this.
   * Null when the bot is off the road or in an intersection.
   */
  private laneLock(bot: Bot, aim: Vec3): Vec3 | null {
    const pos = bot.flight.pos;
    const inX = offCenterline(pos.z) <= ROADWAY_HALF; // on an x-travel street
    const inZ = offCenterline(pos.x) <= ROADWAY_HALF;
    if (inX === inZ) return null; // off the road, or in an intersection
    const axis = inX ? "x" : "z";
    const fwd = flightForward({ yaw: bot.flight.yaw, pitch: 0 });
    const dir = (axis === "x" ? fwd.x : fwd.z) >= 0 ? 1 : -1;
    const cross = axis === "x" ? pos.z : pos.x;
    const toLine = Math.round(cross / BLOCK_PITCH) * BLOCK_PITCH - cross;
    const along = (axis === "x" ? aim.x : aim.z) * dir;
    const side = (axis === "x" ? aim.z : aim.x) - toLine;
    const room = ROADWAY_HALF - BOT_CANYON_PROBE_RADIUS;
    const lateral = toLine + (along > 0 ? clamp(side, -room, room) : 0);
    const ahead = dir * Math.max(along, bot.flight.speed / 0.765);
    return axis === "x"
      ? { x: ahead, y: aim.y, z: lateral }
      : { x: lateral, y: aim.y, z: ahead };
  }

  /**
   * `yaw`, bent toward the centreline of the street it runs along when the
   * bot is over that street: aim a turn radius up the centreline. An escape
   * that only matches the street's HEADING leaves the bot flying the curb,
   * 5 m off a facade, where the hysteresis probe never clears.
   */
  private centredYaw(flight: FlightState, yaw: number): number {
    const fwd = flightForward({ yaw, pitch: 0 });
    const axis = Math.abs(fwd.x) > Math.abs(fwd.z) ? "x" : "z";
    const cross = axis === "x" ? flight.pos.z : flight.pos.x;
    if (offCenterline(cross) > LOT_LINE) return yaw;
    const toLine = Math.round(cross / BLOCK_PITCH) * BLOCK_PITCH - cross;
    const ahead = Math.max(flight.speed / 0.765, 40);
    const d =
      axis === "x"
        ? { x: Math.sign(fwd.x) * ahead, z: toLine }
        : { x: toLine, z: Math.sign(fwd.z) * ahead };
    return Math.atan2(-d.x, -d.z);
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
  private canyonPatrol(
    bot: Bot,
    toward?: Vec3,
    straight = false,
    /** Staging for a hole (B2): fly at this altitude instead of the band,
     * bleeding speed, with no corner hop — an arch lintel is at 32 m. */
    stageY?: number,
  ): void {
    // Reaching a waypoint is a GROUND-TRACK test: the lattice is a plan-view
    // graph and altitude is the glide's business. Measuring it in 3D strands a
    // bot that is still high above the intersection it is aiming at.
    let d = bot.waypoint
      ? wrapDelta(bot.flight.pos, bot.waypoint)
      : { x: 0, y: 0, z: 0 };
    if (!bot.waypoint || Math.hypot(d.x, d.z) < BOT_CANYON_WAYPOINT_RADIUS) {
      bot.waypoint = this.nextCanyonWaypoint(bot, toward, straight);
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
    let targetY = stageY ?? bot.waypoint.y + (slowing ? BOT_CANYON_HOP : 0);
    if (merge) targetY = Math.max(targetY, bot.flight.pos.y);
    // L5: over the train line — its own streets and every street crossing
    // them — hold above the deck and the cars. The probes would see them, but
    // dodging a viaduct down in the canyon is exactly the late, hard turn
    // that puts a bot into a facade; climbing early costs nothing.
    if (this.movers.train) {
      targetY = Math.max(
        targetY,
        trainFloor(this.movers.train, bot.flight.pos, TRAIN_BOT_REACH),
        trainFloor(this.movers.train, bot.waypoint, 0),
      );
    }
    const dy = Math.max(targetY - bot.flight.pos.y, -flat * BOT_CANYON_GLIDE);
    // Never accelerate on a canyon patrol: turn radius is speed / 0.765 rad/s,
    // so a street-grid bot has to arrive at a corner near MIN_SPEED or its arc
    // cuts the block. Throttle only ever holds or bleeds here; a chase (ENGAGE)
    // is free to firewall it.
    const throttle = slowing || stageY !== undefined ? -1 : 0;
    this.steerToward(bot, { x: d.x, y: dy, z: d.z }, 0, 0, throttle);
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
  private nextCanyonWaypoint(bot: Bot, toward?: Vec3, straight = false): Vec3 {
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
    } else if (!straight && bot.rand() >= BOT_CANYON_STRAIGHT_CHANCE) {
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

  /** steerInput onto the bot (a zero delta holds the stick). Jitter offsets
   * the commanded attitude. */
  private steerToward(
    bot: Bot,
    d: Vec3,
    jitterYaw: number,
    jitterPitch: number,
    throttle: number,
  ): void {
    const input = steerInput(bot.flight, d, jitterYaw, jitterPitch, throttle);
    if (input) bot.input = input;
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
      if (hitsGround(p, radius)) return true;
      // Holes count as SOLID here: point samples 16–36 m apart can land
      // inside a hole and skip its thin walls. Bots never discover a hole
      // with a probe — they fly one only as a committed thread, checked by
      // rolloutThread at 50 ms steps with the holes open.
      if (collideCity(p, radius, this.buildings, this.cityIndex, "solid")) {
        return true;
      }
      // Trees are swept like the movers below, for the same reason: a 0.5 m
      // trunk falls straight between two point samples.
      const gap = s - (i === 0 ? -s : flight.speed * (profile[i - 1] ?? 0));
      if (collideNature(p, radius + gap / 2, this.nature)) return true;
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

  /**
   * Is the path the bot will ACTUALLY fly blocked? Below the probe split only.
   * Straight-ray probes are blind to the inside of a turn: at MIN_SPEED the
   * 52 m turn radius carries the bot ~12 m off its nose line within the
   * canyon profile's 0.9 s, more than the probe radius, so a wall on the
   * inside of the arc surfaced a tick before impact. This flies the shared
   * stepFlight forward under the input the bot is holding and tests the
   * canyon profile's sample times along that curve.
   */
  private pathBlocked(bot: Bot, now: number, margin: number): boolean {
    if (bot.flight.pos.y >= BOT_CANYON_PROBE_ALT) return false;
    const radius = BOT_CANYON_PROBE_RADIUS * margin;
    let f = bot.flight;
    let t = 0;
    let next = 0;
    const times = BOT_CANYON_PROBE_TIMES;
    while (next < times.length) {
      f = stepFlight(f, bot.input, BOT_DT);
      t += BOT_DT;
      if (t + 1e-9 < (times[next] ?? 0)) continue;
      next++;
      const p = f.pos;
      if (hitsGround(p, radius)) return true;
      if (collideCity(p, radius, this.buildings, this.cityIndex)) return true;
      if (collideNature(p, radius, this.nature)) return true;
      if (
        this.probeMovers &&
        collideBotMovers(
          p,
          radius + BOT_MOVER_CLEAR,
          this.movers,
          now + t * 1000,
        )
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * RECOVER's pull-up is blind to what hangs overhead: measured, every bot
   * the mover probe failed to save died climbing at MIN_SPEED into a crane
   * jib it was passing under. So fly the held input forward first. If the
   * climb meets a mover, take the first gentler pitch whose arc is clear of
   * movers, city, trees and ground; if none is, keep the climb.
   */
  private pullUpUnderMover(bot: Bot, now: number): void {
    if (!this.probeMovers) return;
    const climb = bot.input;
    if (!this.arcBlocked(bot.flight, climb, now, true)) return;
    for (const pitch of [0, -BOT_INPUT_CAP / 2, -BOT_INPUT_CAP]) {
      const input = { ...climb, pitch };
      if (!this.arcBlocked(bot.flight, input, now, false)) {
        bot.input = input;
        return;
      }
    }
  }

  /** Does `input`, held for RECOVER_LOOK_S from `flight`, hit a mover (or,
   * unless `moversOnly`, anything else solid)? Movers posed on arrival. */
  private arcBlocked(
    flight: FlightState,
    input: FlightInput,
    now: number,
    moversOnly: boolean,
  ): boolean {
    let f = flight;
    const steps = Math.round(RECOVER_LOOK_S / BOT_DT);
    for (let k = 1; k <= steps; k++) {
      f = stepFlight(f, input, BOT_DT);
      const r = PLAYER_RADIUS + BOT_MOVER_CLEAR;
      if (collideBotMovers(f.pos, r, this.movers, now + k * BOT_DT * 1000)) {
        return true;
      }
      if (moversOnly) continue;
      if (
        hitsGround(f.pos, PLAYER_RADIUS) ||
        collideCity(f.pos, PLAYER_RADIUS, this.buildings, this.cityIndex) ||
        collideNature(f.pos, PLAYER_RADIUS, this.nature)
      ) {
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
   * nose within the aim cone of the LEAD bearing (where the target will be
   * when a round gets there — rounds have travel time since F4) → one
   * trigger pull (Combat's token bucket and heat model gate the cadence). */
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
    const t = leadTime(dist, bot.flight.speed);
    const lx = d.x + target.vel.x * t;
    const ly = d.y + target.vel.y * t;
    const lz = d.z + target.vel.z * t;
    const lead = Math.hypot(lx, ly, lz);
    if (lead === 0) return null;
    const fwd = flightForward(bot.flight);
    const along = (lx * fwd.x + ly * fwd.y + lz * fwd.z) / lead;
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
 * fire() — heat model, token bucket, spawn-protection forfeit. True when
 * accepted; the caller then launch()es the round, and whatever it meets
 * comes back from a later tick as a BotRoundHit for landBotRound. No claim
 * path, no loosened validation.
 */
export function applyBotFire(
  combat: Combat,
  shot: BotShot,
  now: number,
): boolean {
  return combat.fire(shot.botId, shot.seq, now).ok;
}

/**
 * Settle a round that met its target through Combat.hit — damage, kill
 * credit, protection, one-bullet-one-hit and the origin/range checks, with
 * the shooter's pose at landing time as its on-record position.
 */
export function landBotRound(
  combat: Combat,
  hit: BotRoundHit,
  now: number,
): HitResult {
  return combat.hit(
    hit.shot.botId,
    hit.shot.targetId,
    hit.shot.seq,
    hit.shot.origin,
    hit.shooterPos,
    hit.targetPos,
    now,
  );
}
