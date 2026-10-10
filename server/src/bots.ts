// Server-flown bots for one room — pure bookkeeping like room.ts
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
// Tactics (B3) shape HOW a bot fights inside those states — see
// bottactics.ts for the pure rules: every bot flies a seeded style
// (aggressive / sniper / wingman, from its callsign); boom-and-zoom from
// height (extend after the pass instead of turning with the target), a
// two-ship pincer on a shared target, breaking off when hurt and coming back
// after regen (taking holes out), and a loop or barrel roll when something
// sits on its six — the one time a bot flies the full F7 envelope, and only
// after a stepFlight rollout of the whole maneuver comes back clear. Timed
// hazards (X1 missiles, S4 flak, C2's chaos) are HazardDiscs: a decision
// whose held stick would fly into one is re-stuck to a variant that misses
// it (in a street: slower; above the roofs: speed, a dive or a turn, held
// to the end of the danger). Aim and reaction scale with each human's
// rolling K/D against the bots (SkillScaler), and a bot is shy of ganging
// up on a struggling human.
//
// Tunnels (U4) are threads too, through the underground network: a bore's
// two directed edges join the graph (common/city/tunnels tunnelEdges), a
// patrol near a portal or river mouth rolls once per encounter, a chaser
// follows a target it saw go in, and both commit only after a stepFlight
// rollout of the whole pass — dive in, the bore, the climb out. The
// controller is a carrot on the bore's centreline at its guide height.
//
// W1 Carrier War: in a room these are the carrier's enemy planes. The room
// (server/src/waves.ts) spawns each one at its launch, hands the brain only
// the humans as contacts, gives each a QUARRY — the human it hunts: with
// nothing acquired, the patrol and the settle off the carrier turn the
// street lattice toward it — and a wave GRADE (aim jitter, reaction and
// trigger discipline, common/src/waves.ts). The brain itself still flies
// whatever contacts it is given, so the opt-in bot sim keeps measuring it
// bot-vs-bot.
//
// W2 bomb runs sit outside the four states too, like threads: the room's
// BombDirector (server/src/bombs.ts) hands a ready bot a run (startRun) — a
// DIVE on a rooftop near its quarry (climb to the IP over it, push over into
// a shallow glide-bomb dive, cue the release when the bomb would land on the
// roof) or a CARPET down a street toward it (the street lattice, cueing its
// wing bombs while flying along the street). The brain only flies the run
// and cues releases (BotTickResult.cues); the director decides every drop.
// A hit, a blocked nose, a missed window or the clock ends the run early;
// either way the bot dives home (the attack cooldown) and rejoins the fight.
//
// Bots never send hit claims: tick() emits trigger pulls (BotShot) and
// applyBotFire routes them through the existing Combat seam — same heat
// model, damage, spawn protection, kill credit, and respawn as humans.
// Since F4 a bot round is not hitscan: an accepted shot is launch()ed and
// flies at the same speed a human bullet does, each tick sweeping its path
// against where its target ACTUALLY went, so a target that jinks inside the
// bullet's flight time dodges it exactly as it would dodge a human's.

import {
  BOMB_G_MAX,
  BOMB_G_MIN,
  type BombRunKind,
  bombSurfaceY,
} from "@angels-bandits/common/bombs";
import { BOSS_FLAK_RANGE } from "@angels-bandits/common/boss";
import {
  BOT_STYLE_TUNING,
  type BotStyle,
  type BotStyleTuning,
  botStyle,
} from "@angels-bandits/common/botstyle";
import {
  type Building,
  type HoleEdge,
  cityHoles,
  edgeFrame,
  holeEdges,
  mulberry32,
  opensOnStreets,
  segmentThroughHole,
} from "@angels-bandits/common/city";
import {
  type CaveIn,
  caveInGapLat,
  collideCaveIns,
  nextCaveInAhead,
} from "@angels-bandits/common/city/caveins";
import { collapseZoneHit } from "@angels-bandits/common/city/collapse";
import {
  EMPTY_MOVERS,
  type MoverField,
  collideBotMovers,
} from "@angels-bandits/common/city/movers";
import { gapsOf } from "@angels-bandits/common/city/props";
import {
  RIVER_HALF_WIDTH,
  bridgeSpans,
  riverOffset,
} from "@angels-bandits/common/city/river";
import {
  LOT_LINE,
  ROADWAY_HALF,
  nextIntersection,
  offCenterline,
} from "@angels-bandits/common/city/street";
import { trainFloor } from "@angels-bandits/common/city/train";
import {
  TUNNELS,
  type Tunnel,
  type TunnelEdge,
  type TunnelEnd,
  type TunnelFrame,
  type TunnelPoint,
  edgeArc,
  edgeProgress,
  guideY,
  tunnelEdges,
  tunnelFrameInto,
  tunnelPointInto,
  tunnelTransit,
} from "@angels-bandits/common/city/tunnels";
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
  BOT_BOOM_COOLDOWN_MS,
  BOT_BOSS_FIRE_RANGE,
  BOT_BOSS_PASS_MS,
  BOT_BOSS_PASS_RANGE,
  BOT_BOSS_PREFERENCE,
  BOT_BOSS_STANDOFF,
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
  BOT_DEFEND_COOLDOWN_MS,
  BOT_DEFEND_MARGIN,
  BOT_DEFEND_MAX_ALT,
  BOT_DEFEND_MAX_S,
  BOT_DEFEND_MIN_ALT,
  BOT_DEFEND_TAIL_S,
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
  BOT_HOLE_ESCAPE_CHANCE,
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
  BOT_PINCER_OFFSET,
  BOT_PROBE_RADIUS,
  BOT_PROBE_TIMES,
  BOT_REACTION_MS,
  BOT_RECOVER_CLEAR,
  BOT_RETARGET_MARGIN,
  BOT_SKILL_GANG_PENALTY,
  BOT_SPAWN_CLEAR_AHEAD,
  BOT_SPAWN_GRACE_MS,
  BOT_SPAWN_SETTLE_MS,
  BOT_SPAWN_SPEED,
  BOT_STEER_GAIN,
  BOT_THREAT_RANGE,
  BOT_TUNNEL_CHANCE,
  BOT_TUNNEL_FOLLOW_MS,
  BOT_TUNNEL_FOLLOW_RANGE,
  BOT_TUNNEL_RANGE,
  BOT_TUNNEL_RETRY_MS,
  BOT_TUNNEL_RUNOUT,
  BOT_ZOOM_MS,
  BULLET_LIFETIME_S,
  BULLET_SPEED,
  HIT_RADIUS,
  HOLE_RUN_OUT,
  MAX_HP,
  MAX_SPEED,
  MIN_SPEED,
  PITCH_LIMIT,
  PITCH_RATE,
  PLAYER_RADIUS,
  ROLL_RATE,
  TICK_DOWN_HZ,
  TRAIN_BOT_REACH,
} from "@angels-bandits/common/constants";
import {
  type DirectorEvent,
  inDangerZone,
} from "@angels-bandits/common/director";
import {
  type FlightInput,
  type FlightState,
  createFlightState,
  flightForward,
  realRoll,
  stepFlight,
} from "@angels-bandits/common/flight";
import {
  type HazardDisc,
  liveHazards,
  pointInHazard,
} from "@angels-bandits/common/hazards";
import { inHoleSpan } from "@angels-bandits/common/medals";
import type {
  Pose,
  RosterEntry,
  SpawnState,
} from "@angels-bandits/common/protocol";
import { BOMB_FALL_MS } from "@angels-bandits/common/strike";
import { BOT_TUNING } from "@angels-bandits/common/tuning";
import type { WaveGrade } from "@angels-bandits/common/waves";
import {
  type Vec3,
  canonicalize,
  wrapDelta,
  wrapDeltaAxis,
  wrapDistance,
} from "@angels-bandits/common/world";
import {
  SkillScaler,
  type Tactic,
  chooseTactic,
  pincerOffset,
  pincerSides,
  threatOnSix,
} from "./bottactics";
import type { Combat, HitResult } from "./combat";

/** Sim step, s — bots advance at snapshot cadence (the server's first sim loop). */
const BOT_DT = 1 / TICK_DOWN_HZ;

/** One bot tick of the shared flight model, on BOT_TUNING (F10): the
 * players' roll feel — fast roll, a held bank, bank-and-pull, knife-edge
 * sink — never reaches a bot, so they fly exactly as before. Every bot
 * step goes through here (server/test/bot-tuning.test.ts). */
function botStep(f: FlightState, input: FlightInput): FlightState {
  return stepFlight(f, input, BOT_DT, BOT_TUNING);
}
/** D5: a warned event's zone stays a no-fly zone this long after it
 * happens, ms (a probe at arrival time sees past the hand-over to the
 * collapse record's own zone). */
const HAZARD_TAIL_MS = 2000;

export type BotState = "PATROL" | "ENGAGE" | "EVADE" | "RECOVER";

/** One living combatant as the brain sees it (bots included — id-filtered). */
export interface BotContact {
  id: string;
  pos: Vec3;
  /** World velocity, m/s — lead pursuit aims ahead along it. */
  vel: Vec3;
  /** Spawn-protected contacts are skipped (their hits would be void anyway). */
  prot: boolean;
  /** S4: a sky-boss weak point (`@boss:<k>`), not a plane: ranked, passed
   * at and fired on by its own rules, and never a threat on the six. */
  boss?: boolean;
  /** B3: current HP (Combat.hpOf). A bot reads its own to break off when
   * hurt; absent counts as full. */
  hp?: number;
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

/** W2: a bot on a bomb run inside its release window this tick — the room's
 * BombDirector decides whether a bomb actually falls. */
export interface BombReleaseCue {
  botId: string;
  pos: Vec3;
  vel: Vec3;
}

export interface BotTickResult {
  shots: BotShot[];
  /** W2: bomb releases cued this tick (BombDirector.drop each). */
  cues: BombReleaseCue[];
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

/** S9: the longest a launched bot settles before it may fight, ms. */
const LAUNCH_SETTLE_MS = 25_000;

/** W2 bomb runs. A dive's IP: this far over its roof, m, never above
 * DIVE_IP_MAX (well under the bot ceiling). */
const DIVE_IP_ABOVE = 140;
const DIVE_IP_MAX = 420;
/** The dive aims this far over the roof, m, at about DIVE_ANGLE (never
 * steeper than DIVE_MAX_ANGLE), throttle cut: with the bomb's fixed fall
 * the release height has to match the sink (common/src/bombs.ts). */
const DIVE_AIM_ABOVE = 70;
const DIVE_ANGLE = (22 * Math.PI) / 180;
const DIVE_MAX_ANGLE = (35 * Math.PI) / 180;
/** The height a dive keeps spare over its sink × the bomb's fall, m. */
const DIVE_SINK_SPARE = 30;
/** Below this over the roof a dive that has not released pulls out, m. */
const DIVE_ABORT_ABOVE = 60;
/** The brain cues a release when its bomb would land within this of the
 * target, m (the director's reach is the real gate). */
const DIVE_CUE_M = 30;
const CARPET_CUE_M = 70;
/** A carpet's releases need level flight: |sink| under this, m/s. */
const CARPET_SINK_MAX = 8;
/** A run's longest life, ms. */
const RUN_MS: Record<BombRunKind, number> = { dive: 40_000, carpet: 25_000 };
/** A dive climbing to its IP circles out to about this past its push-over
 * point, m, rather than overflying the roof still too low. */
const DIVE_CLIMB_STANDOFF = 250;
/** ...climbing no steeper than this gradient (~24°). */
const DIVE_CLIMB_GRADE = 0.45;

/** W2: the bomb run a bot is flying. */
interface BombRun {
  kind: BombRunKind;
  target: Vec3;
  /** The run ends (missed) at this time, ms. */
  until: number;
  /** A dive past its push-over. */
  diving: boolean;
}
const NEUTRAL: FlightInput = { pitch: 0, turn: 0, roll: 0, throttle: 0 };

/** What a bot hands stepFlight: its stick inside the pre-F7 pitch envelope
 * (the old ±PITCH_LIMIT clamp, exactly). Bots fly the shared model but never
 * loop — their recovery holds a pull for seconds, which would now go over
 * the top — and they never roll, so they stay on its exact Euler path. */
const botInput = (input: FlightInput): FlightInput => ({
  ...input,
  pitchLimit: PITCH_LIMIT,
});

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

/**
 * B3 defensive aerobatics: a loop (pull through, the shooter overshoots
 * under it) or a barrel roll (a corkscrew around the line of flight that
 * spoils its aim). The one time a bot flies stepFlight WITHOUT the
 * pitchLimit envelope — the player's full F7 model, at the bots' own
 * BOT_INPUT_CAP — and only after rolloutManeuver flew the whole thing clear.
 */
interface Maneuver {
  kind: "loop" | "roll";
  /** Roll direction for a barrel roll. */
  dir: 1 | -1;
  /** Ticks flown so far. */
  ticks: number;
}

/** The maneuver's own stick holds at least this long, s: most of one full
 * rotation at the capped rate — then it rolls out (maneuverInput). A loop
 * is flown at idle: slow is tight, and a tight loop fits under
 * BOT_DEFEND_MAX_ALT. */
const LOOP_HOLD_S = (0.8 * 2 * Math.PI) / (PITCH_RATE * BOT_INPUT_CAP);
const ROLL_HOLD_S = (0.9 * 2 * Math.PI) / (ROLL_RATE * BOT_INPUT_CAP);

/**
 * One tick of `m` from `f`: the maneuver's own stick, then a roll-out that
 * keeps pulling while the bot is still inverted and otherwise levels the
 * nose while the released roll eases upright (stepFlight's own easing) —
 * null once it is wings-level and near the horizon, or past
 * BOT_DEFEND_MAX_S. Pure in (f, m.ticks), so rolloutManeuver predicts the
 * live flight exactly.
 */
function maneuverInput(f: FlightState, m: Maneuver): FlightInput | null {
  const t = m.ticks * BOT_DT;
  if (t >= BOT_DEFEND_MAX_S) return null;
  const cap = BOT_INPUT_CAP;
  const stick: FlightInput =
    m.kind === "loop"
      ? { pitch: cap, turn: 0, roll: 0, throttle: -1 }
      : { pitch: cap * 0.45, turn: 0, roll: m.dir * cap, throttle: 1 };
  if (t < (m.kind === "loop" ? LOOP_HOLD_S : ROLL_HOLD_S)) return stick;
  const real = realRoll(f);
  // Still on the back of the loop or the far side of the roll: carry on.
  if (Math.abs(real) > Math.PI / 2) return stick;
  if (m.kind === "roll" && Math.abs(real) > 0.3) return stick;
  if (Math.abs(real) < 0.02 && Math.abs(f.pitch) < 0.1) return null;
  return {
    pitch: clamp(-f.pitch * BOT_STEER_GAIN, -cap, cap),
    turn: 0,
    roll: 0,
    throttle: 1,
  };
}

/** B3: below this HP fraction a bot neither starts, presses nor even
 * chases a pass at the zeppelin. */
const BOSS_HURT_HP = 0.6;

/** Hazard dodging (B3): how far ahead a held stick is flown against the
 * discs, s, and the clearance kept beyond PLAYER_RADIUS, m. */
const HAZARD_LOOK_S = 2.5;
const HAZARD_MARGIN = 2;

/** One committed (or candidate) pass through a tunnel (U4). */
interface TunnelThread {
  edge: TunnelEdge;
  /** The bot's band altitude: the climb-out heads back toward it. */
  bandY: number;
  /** Past the far end (sticky). */
  out: boolean;
}

/** The dive into a plaza portal from beyond its lip, and the climb out of
 * one, as slopes (rise per metre along the carrot) — steeper than the 22°
 * ramp, so a bot in the canyon band reaches the cut over the lawn. */
const PORTAL_DIVE = Math.tan((38 * Math.PI) / 180);
const PORTAL_CLIMB = Math.tan((32 * Math.PI) / 180);
/** A river mouth's approach and climb-out across the channel: level with the
 * guide line for this long, then this slope. */
const MOUTH_LEVEL = 30;
const MOUTH_SLOPE = 0.5;
/** Ticks between a room's tunnel rollouts (0.5 s at 20 Hz). */
const TUNNEL_ROLLOUT_EVERY = 10;
/** A tunnel pass hands back no later than this far past the exit, m. */
const TUNNEL_RUNOUT_MAX = 400;

/** The carrot's height `d` m beyond end `e` (whose guide height is `y0`):
 * the approach line before an entry, the climb-out after an exit. */
function beyondEnd(e: TunnelEnd, y0: number, d: number, dive: boolean): number {
  if (e.kind === "plaza") return y0 + d * (dive ? PORTAL_DIVE : PORTAL_CLIMB);
  return y0 + Math.max(0, d - MOUTH_LEVEL) * MOUTH_SLOPE;
}

const tunnelFrame: TunnelFrame = { s: 0, lat: 0, th: 0 };
const tunnelCarrot: TunnelPoint = { x: 0, z: 0, th: 0 };

const NO_CAVEINS: readonly CaveIn[] = [];

/**
 * The tunnel controller: a carrot BOT_HOLE_CARROT ahead on the bore's
 * centreline (its straight extension before the entry and after the exit),
 * at the guide height inside and on the approach / climb-out line outside.
 * U6: with a live cave-in on the bore ahead (nextCaveInAhead — warned,
 * falling or rubble), the carrot slides across into its open lane, and
 * back to the centreline once it is behind. Pure in (flight, thread,
 * cave-ins, clock), like threadInput, so a rollout predicts the live
 * flight. Null once the pass is over (hand back to the brain).
 */
function tunnelInput(
  f: FlightState,
  th: TunnelThread,
  caveins: readonly CaveIn[] = NO_CAVEINS,
  tMs = 0,
): FlightInput | null {
  const { edge } = th;
  const t = edge.tunnel;
  const L = t.length;
  tunnelFrameInto(t, f.pos, tunnelFrame);
  const p = edgeProgress(edge, tunnelFrame.s);
  if (p >= L) th.out = true;
  if (th.out) {
    const past = p - L;
    if (
      (past >= BOT_TUNNEL_RUNOUT && f.pos.y >= BOT_MIN_ALT + 5) ||
      past >= TUNNEL_RUNOUT_MAX
    ) {
      return null;
    }
  }
  const q = p + BOT_HOLE_CARROT;
  tunnelPointInto(t, edgeArc(edge, q), tunnelCarrot);
  if (caveins.length > 0 && q > 0 && q < L) {
    const c = nextCaveInAhead(caveins, t.id, tunnelFrame.s, edge.dir, tMs);
    if (c) {
      const lat = caveInGapLat(c.gap);
      tunnelCarrot.x -= Math.sin(tunnelCarrot.th) * lat;
      tunnelCarrot.z += Math.cos(tunnelCarrot.th) * lat;
    }
  }
  let y: number;
  if (q <= 0) {
    y = beyondEnd(edge.endIn, guideY(t, edgeArc(edge, 0)), -q, true);
  } else if (q >= L) {
    y = beyondEnd(edge.endOut, guideY(t, edgeArc(edge, L)), q - L, false);
    if (th.out) y = Math.min(y, Math.max(th.bandY, BOT_MIN_ALT + 10));
  } else {
    y = guideY(t, edgeArc(edge, q));
  }
  const d = {
    x: wrapDeltaAxis(f.pos.x, tunnelCarrot.x),
    y: y - f.pos.y,
    z: wrapDeltaAxis(f.pos.z, tunnelCarrot.z),
  };
  return steerInput(f, d, 0, 0, 0);
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
  /** S9: launched from the boss carrier — until this time, ms, it flies its
   * launch run stick-neutral (the run launchClear cleared) and its own
   * carrier is not solid to it. */
  carrierUntil: number;
  /** Is the current ENGAGE chasing along the street lattice (pursuit line
   * blocked) rather than flying straight at the target? */
  streetChase: boolean;
  /** The hole pass this bot is committed to (B2), or null. */
  thread: Thread | null;
  /** The tunnel pass this bot is committed to (U4), or null. */
  tunnel: TunnelThread | null;
  /** Patrol tunnel encounters by edge index: the roll's outcome. */
  tunnelRolls: Map<number, boolean>;
  /** No tunnel rollout for this bot before this time, ms. */
  tunnelRetryAt: number;
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
  /** B3: the seeded style (from the callsign number) and its tuning. */
  style: BotStyle;
  tuning: BotStyleTuning;
  /** B3: the tactic the last fight decision chose (telemetry, tests). */
  tactic: Tactic;
  /** B3: HP as of this tick's contacts, as a fraction of MAX_HP. */
  hp: number;
  /** B3: broken off since this time, ms — null while fighting. */
  breakSince: number | null;
  /** B3 boom-and-zoom: in a boom pass until, zooming (extending) until, and
   * no new boom before, ms. */
  boomUntil: number;
  zoomUntil: number;
  boomCooldownUntil: number;
  /** B3: a committed loop / barrel roll, and no new one before, ms. */
  maneuver: Maneuver | null;
  defendCooldownUntil: number;
  /** B3: holding a hazard-dodge stick until this time, ms (dodgeHazards). */
  dodgeUntil: number;
  /** B3: tactics' own seeded stream — salted off the bot's seed like
   * holeRand, so `rand`'s sequence (patrol turns, jitter) is untouched. */
  tacticRand: () => number;
  /** W1: the human this bot hunts (setQuarries), or null. */
  quarryId: string | null;
  /** W1: its wave's grade (setGrade); neutral until set. */
  grade: WaveGrade;
  /** W1: trigger discipline's own stream, salted like tacticRand. */
  fireRand: () => number;
  /** W2: the bomb run it is flying (startRun), or null. */
  run: BombRun | null;
}

/** A bot with no wave: B3's own aim, reaction and every shot taken. */
const NEUTRAL_GRADE: WaveGrade = { jitter: 1, reaction: 1, fire: 1 };
/** W1: the aim-jitter multiplier never leaves this band, whatever style ×
 * skill × grade multiply to. */
const JITTER_SCALE_MIN = 0.5;
/** W4: the share of lined-up shots an enemy still takes at a pilot in
 * Easy mode (on top of its wave's trigger discipline). */
const EASY_FIRE_SCALE = 0.5;
const JITTER_SCALE_MAX = 3;

/** B3 telemetry (the bot sim's report): what the tactics actually flew. */
export interface TacticStats {
  /** Brain decisions taken. */
  decisions: number;
  boomPasses: number;
  zooms: number;
  /** Decisions flown as one side of a pincer. */
  pincerDecisions: number;
  breakOffs: number;
  /** Defensive breaks: loops and rolls committed (by `${style}:${kind}`),
   * and the plain break when no maneuver was clear. */
  maneuvers: Record<string, number>;
  defendBreaks: number;
  /** Decisions whose stick was changed to miss a hazard disc. */
  dodges: number;
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
  /** W3: provoked enemies' patrol points (setDetours). */
  private detours: ReadonlyMap<string, Vec3> = new Map();
  /** D3 telemetry (bot sim): probes refused because they would have
   * entered an active collapse zone. */
  zoneRefusals = 0;
  /** D5: the director's warned events — each one's danger zone is a no-fly
   * zone from its warning until just after it happens (the collapse record
   * then takes over). Set by the room every tick (setHazards). */
  private hazards: readonly DirectorEvent[] = [];
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
    /**
     * B3 tactics on (styles, boom-and-zoom, pincers, break-offs, defensive
     * aerobatics, skill scaling). Like `probeMovers`, a knob only for the
     * negative control: the bot sim with it off must reproduce the pre-B3
     * numbers exactly. Hazard discs are honoured either way. Never turn it
     * off in a room.
     */
    private readonly tactics = true,
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
  /** B3: each human's rolling K/D against the bots (fed by noteDeath). */
  readonly skill = new SkillScaler();
  /** B3: timed hazards by source (setHazardDiscs), and all of them live. */
  private readonly hazardSources = new Map<string, HazardDisc[]>();
  private discs: HazardDisc[] = [];
  /** B3: who is ENGAGEd on whom as of the start of this tick. */
  private engaged = new Map<string, string[]>();
  /** B3: pincer sides — this tick's per-target assignment, and each bot's
   * last side (what keeps an assignment stable). */
  private pincerTick = new Map<string, Map<string, -1 | 1>>();
  private readonly pincerPrev = new Map<string, -1 | 1>();
  /** B3 telemetry (the bot sim's report). */
  readonly stats: TacticStats = {
    decisions: 0,
    boomPasses: 0,
    zooms: 0,
    pincerDecisions: 0,
    breakOffs: 0,
    maneuvers: {},
    defendBreaks: 0,
    dodges: 0,
  };
  /** U4: every tunnel as two directed edges (+1 then −1 per bore). */
  private readonly tunnelEdgeList: readonly TunnelEdge[] = tunnelEdges();
  /** U4: the tunnel edge each contact was last seen inside, and when. */
  private readonly tunnelSeen = new Map<string, { edge: number; at: number }>();
  /** U4: the next tick a tunnel rollout may run. They are long (a whole
   * bore, up to ~600 flight steps), so a room runs at most one every
   * TUNNEL_ROLLOUT_EVERY ticks. */
  private tunnelRolloutTick = 0;
  /** U4 telemetry (bot sim): tunnel passes bots committed to, flew to the
   * far end, and contacts' mid-bore transits by direction-agnostic count;
   * rollouts flown to decide. */
  tunnelRollouts = 0;
  tunnelCommits = 0;
  tunnelPasses = 0;
  tunnelTransits = 0;

  get count(): number {
    return this.bots.size;
  }

  /**
   * S7 THREAD THE NEEDLE: is `id` flying a hole — through one within
   * `windowMs` (the transits every contact's track already records), or
   * inside one's clear volume at `pos` right now? River bridge underpasses
   * are street-graph edges, not holes, and never count.
   */
  threading(id: string, pos: Vec3, now: number, windowMs: number): boolean {
    const transit = this.transits.get(id);
    if (
      transit &&
      now - transit.at <= windowMs &&
      this.edges[transit.edge]?.span.hole.kind !== "bridge"
    ) {
      return true;
    }
    for (const edge of this.edges) {
      // Both directions share a span: test it once, on its +1 edge.
      if (edge.dir !== 1 || edge.span.hole.kind === "bridge") continue;
      if (inHoleSpan(edge.span, pos)) return true;
    }
    return false;
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
    // With tactics off every style flies the neutral wingman tuning, which
    // is never consulted anyway (the pre-B3 brain).
    const style: BotStyle = this.tactics ? botStyle(n) : "wingman";
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
      carrierUntil: Number.NEGATIVE_INFINITY,
      streetChase: false,
      thread: null,
      tunnel: null,
      tunnelRolls: new Map(),
      tunnelRetryAt: 0,
      holeRand: mulberry32((botSeed ^ 0x2545f491) >>> 0),
      holeRolls: new Map(),
      breakTurn: 1,
      aimJitterYaw: 0,
      aimJitterPitch: 0,
      alive: true,
      nextSeq: 1,
      rand,
      style,
      tuning: BOT_STYLE_TUNING[style],
      tactic: "turnFight",
      hp: 1,
      breakSince: null,
      boomUntil: Number.NEGATIVE_INFINITY,
      zoomUntil: Number.NEGATIVE_INFINITY,
      boomCooldownUntil: Number.NEGATIVE_INFINITY,
      maneuver: null,
      defendCooldownUntil: Number.NEGATIVE_INFINITY,
      dodgeUntil: Number.NEGATIVE_INFINITY,
      tacticRand: mulberry32((botSeed ^ 0x7ac71c5) >>> 0),
      quarryId: null,
      grade: NEUTRAL_GRADE,
      fireRand: mulberry32((botSeed ^ 0x51f1e5) >>> 0),
      run: null,
    });
    return entry;
  }

  /** The id the next spawn() will mint (W1: a launch is planned for it
   * before the bot exists). */
  nextId(): string {
    return `bot:${this.roomId}:${this.nextIndex}`;
  }

  /** W1: who each bot hunts (enemy id → human id); a bot left out hunts
   * nobody. */
  setQuarries(quarries: ReadonlyMap<string, string>): void {
    for (const [id, bot] of this.bots) bot.quarryId = quarries.get(id) ?? null;
  }

  /** W3: enemies provoked by a rooftop AA nest (server/src/aa.ts) patrol
   * toward these points (over the nest) instead of their quarry while
   * listed. Replaced wholesale each call; empty = nobody detours. */
  setDetours(detours: ReadonlyMap<string, Vec3>): void {
    this.detours = detours;
  }

  quarryOf(id: string): string | null {
    return this.bots.get(id)?.quarryId ?? null;
  }

  /** W1: a bot's own HP (Combat.hpOf) — its contacts are the humans, so
   * the break-off reads it from here. */
  setHp(id: string, hp: number): void {
    const bot = this.bots.get(id);
    if (bot) bot.hp = hp / MAX_HP;
  }

  /** W1: a bot's wave grade (aim, reaction, trigger discipline). */
  setGrade(id: string, grade: WaveGrade): void {
    const bot = this.bots.get(id);
    if (bot) bot.grade = grade;
  }

  remove(id: string): void {
    this.bots.delete(id);
    this.pincerPrev.delete(id);
  }

  /** The tunnel a bot is flying (U4), or null — read-only, for the sim. */
  tunnelOf(id: string): TunnelEdge | null {
    return this.bots.get(id)?.tunnel?.edge ?? null;
  }

  /** The hole edge a bot is threading, or null — read-only, for the sim. */
  threadOf(id: string): HoleEdge | null {
    return this.bots.get(id)?.thread?.edge ?? null;
  }

  stateOf(id: string): BotState | undefined {
    return this.bots.get(id)?.state;
  }

  /** B3: a bot's seeded style, and the tactic its last fight decision chose. */
  styleOf(id: string): BotStyle | undefined {
    return this.bots.get(id)?.style;
  }

  tacticOf(id: string): Tactic | undefined {
    return this.bots.get(id)?.tactic;
  }

  /** B3: is the bot flying a committed loop / barrel roll? */
  maneuverOf(id: string): "loop" | "roll" | null {
    return this.bots.get(id)?.maneuver?.kind ?? null;
  }

  /**
   * B3: one timed-hazard source's discs, replacing that source's last set
   * (`[]` clears it). Missiles and flak come from index.ts each tick; C2's
   * chaos events push theirs under their own key. Spent discs drop out on
   * their own (each carries its end time).
   */
  setHazardDiscs(key: string, discs: readonly HazardDisc[]): void {
    if (discs.length === 0) this.hazardSources.delete(key);
    else this.hazardSources.set(key, [...discs]);
    this.discs = [...this.hazardSources.values()].flat();
  }

  /**
   * B3 skill scaling: a death settled by Combat. Only gun kills between a
   * human and a bot move the human's level — crashes, hazards and
   * bot-vs-bot never do.
   */
  noteDeath(victimId: string, killerId: string | null, cause: string): void {
    if (!this.tactics || cause !== "shot" || killerId === null) return;
    const killerBot = this.bots.has(killerId);
    const victimBot = this.bots.has(victimId);
    if (killerBot && !victimBot && !victimId.startsWith("@")) {
      this.skill.noteOutcome(victimId, false);
    } else if (!killerBot && victimBot && !killerId.startsWith("@")) {
      this.skill.noteOutcome(killerId, true);
    }
  }

  /** B3: a human left the room — their skill history goes with them. */
  forgetHuman(id: string): void {
    this.skill.forget(id);
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
    // W2: shot at on a bomb run — the run is off (the director sees it go).
    bot.run = null;
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
    bot.maneuver = null;
    bot.tunnel = null;
    bot.run = null;
  }

  /** Server-issued respawn (same sampler as humans): fresh flight state.
   * S9: `launch` — released from the boss carrier: its pitch off the rig,
   * and when its launch run (carrier grace) ends, ms. */
  respawn(
    id: string,
    spawn: SpawnState,
    launch?: { pitch: number; until: number },
  ): void {
    const bot = this.bots.get(id);
    if (!bot) return;
    bot.alive = true;
    bot.flight = this.flightFromSpawn(spawn);
    bot.flight.pitch = launch?.pitch ?? 0;
    bot.carrierUntil = launch?.until ?? Number.NEGATIVE_INFINITY;
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
    bot.tunnel = null;
    bot.tunnelRolls.clear();
    bot.holeRolls.clear();
    bot.tactic = "turnFight";
    bot.hp = 1;
    bot.breakSince = null;
    bot.boomUntil = Number.NEGATIVE_INFINITY;
    bot.zoomUntil = Number.NEGATIVE_INFINITY;
    bot.boomCooldownUntil = Number.NEGATIVE_INFINITY;
    bot.maneuver = null;
    bot.defendCooldownUntil = Number.NEGATIVE_INFINITY;
    bot.dodgeUntil = Number.NEGATIVE_INFINITY;
    bot.run = null;
    this.pincerPrev.delete(id);
  }

  // --- W2 bomb runs ---

  /** May `id` start a bomb run now: alive, settled off its carrier, not in
   * a thread, tunnel or maneuver, not evading or broken off, not hurt, and
   * not on a run already. */
  canBomb(id: string, now: number): boolean {
    const bot = this.bots.get(id);
    if (!bot?.alive || bot.run || bot.thread || bot.tunnel || bot.maneuver) {
      return false;
    }
    if (Number.isNaN(bot.graceUntil) || now < bot.graceUntil) return false;
    if (now < bot.carrierUntil + LAUNCH_SETTLE_MS) return false;
    if (now < bot.evadeUntil || bot.breakSince !== null) return false;
    return bot.hp >= BOSS_HURT_HP;
  }

  /** Fly a bomb run of `kind` at `target` (BombDirector's order). False when
   * the bot cannot take it now (the director rests it instead). */
  startRun(id: string, kind: BombRunKind, target: Vec3, now: number): boolean {
    const bot = this.bots.get(id);
    if (!bot || !this.canBomb(id, now)) return false;
    bot.run = { kind, target, until: now + RUN_MS[kind], diving: false };
    bot.state = "PATROL";
    bot.targetId = null;
    bot.attackUntil = Number.NEGATIVE_INFINITY;
    bot.boomUntil = Number.NEGATIVE_INFINITY;
    bot.zoomUntil = Number.NEGATIVE_INFINITY;
    bot.streetChase = false;
    // Off the lattice it was on: a carpet re-joins the street nearest it.
    bot.fought = true;
    bot.waypoint = null;
    bot.travel = null;
    return true;
  }

  /** The run `id` is flying, or null. */
  runOf(id: string): { kind: BombRunKind; target: Vec3 } | null {
    const run = this.bots.get(id)?.run;
    return run ? { kind: run.kind, target: run.target } : null;
  }

  /** The director made the run's last drop: pull out and go home. */
  endRun(id: string, now: number): void {
    const bot = this.bots.get(id);
    if (bot?.run) this.finishRun(bot, now);
  }

  /** A run over (done or missed): dive home like the end of an attack pass
   * and re-join the lattice, then the fight. */
  private finishRun(bot: Bot, now: number): void {
    bot.run = null;
    bot.attackCooldownUntil = now + BOT_ATTACK_COOLDOWN_MS;
    bot.fought = true;
    bot.waypoint = null;
    bot.travel = null;
  }

  /** Is the bot inside its run's release window right now? The bomb would
   * land half its ground speed × the fall ahead (common/src/bombs.ts). */
  private releaseCued(bot: Bot): boolean {
    const run = bot.run;
    if (!run) return false;
    const { flight } = bot;
    const fwd = flightForward(flight);
    const lead = (flight.speed * BOMB_FALL_MS) / 2000;
    const ix = flight.pos.x + fwd.x * lead;
    const iz = flight.pos.z + fwd.z * lead;
    const miss = Math.hypot(
      wrapDeltaAxis(run.target.x, ix),
      wrapDeltaAxis(run.target.z, iz),
    );
    if (run.kind === "dive") {
      if (
        !run.diving ||
        miss > DIVE_CUE_M ||
        flight.pos.y - run.target.y < DIVE_ABORT_ABOVE
      ) {
        return false;
      }
      // Inside the bomb's release envelope too, on whatever stands where it
      // would land (common/src/bombs.ts bombCurveOk): pushed over still
      // level and high, it would be slammed down — keep diving into it.
      const fall = BOMB_FALL_MS / 1000;
      const at = canonicalize({ x: ix, y: 0, z: iz });
      const h = flight.pos.y - bombSurfaceY(this.cityIndex, at.x, at.z);
      const g = (2 * (h + fwd.y * flight.speed * fall)) / (fall * fall);
      return g >= BOMB_G_MIN && g <= BOMB_G_MAX;
    }
    return (
      miss <= CARPET_CUE_M &&
      flight.pos.y < BOT_CANYON_PROBE_ALT &&
      Math.abs(fwd.y * flight.speed) < CARPET_SINK_MAX &&
      this.streetAxis(flight) !== null
    );
  }

  /**
   * One decision of a bomb run: the stick, or false when the run is over
   * (missed, or no clear heading — the caller recovers or fights on).
   */
  private flyRun(bot: Bot, now: number, margin: number): boolean {
    const run = bot.run as BombRun;
    bot.state = "PATROL";
    bot.targetId = null;
    const { pos } = bot.flight;
    const d = wrapDelta(pos, run.target);
    const flat = Math.hypot(d.x, d.z);
    const fwd = flightForward({ yaw: bot.flight.yaw, pitch: 0 });
    const along = flat > 0 ? (d.x * fwd.x + d.z * fwd.z) / flat : 0;
    if (run.kind === "carpet") {
      // Its bombs would now land past the target: the window is gone.
      if (along < 0 && flat > CARPET_CUE_M) {
        this.finishRun(bot, now);
        return false;
      }
      // Down the street lattice toward the target, preferring straight on
      // — the release wants a long run along one street.
      this.canyonPatrol(bot, run.target, true);
      return true;
    }
    const ipY = Math.min(run.target.y + DIVE_IP_ABOVE, DIVE_IP_MAX);
    // The push-over point: where a DIVE_ANGLE line from the IP meets the
    // aim point over the roof.
    const runIn =
      Math.max(0, ipY - run.target.y - DIVE_AIM_ABOVE) / Math.tan(DIVE_ANGLE);
    if (
      !run.diving &&
      pos.y >= ipY - 20 &&
      flat <= runIn + 60 &&
      flat >= runIn * 0.6 &&
      along > 0.9
    ) {
      run.diving = true;
    }
    if (run.diving) {
      // Past the roof, under the pull-out height, or the roof behind: a
      // dive that has not released by now has missed.
      if (pos.y - run.target.y < DIVE_ABORT_ABOVE || flat < 20 || along < 0) {
        this.finishRun(bot, now);
        return false;
      }
      const aim: Vec3 = { x: d.x, y: d.y + DIVE_AIM_ABOVE, z: d.z };
      // Never sink faster than the height left can take: a bomb falls its
      // fixed time, so its release needs |sink|·T ≤ height − a spare
      // (common/src/bombs.ts BOMB_G_MIN) — the dive shallows as it comes
      // down instead of arriving too steep to release.
      const fall = BOMB_FALL_MS / 1000;
      const sinkMax = Math.max(
        0,
        (pos.y - run.target.y - DIVE_SINK_SPARE) / fall,
      );
      const down = Math.min(
        DIVE_MAX_ANGLE,
        Math.asin(clamp(sinkMax / Math.max(1, bot.flight.speed), 0, 1)),
      );
      aim.y = Math.max(aim.y, -flat * Math.tan(down));
      this.steerToward(bot, aim, 0, 0, -1);
      return true;
    }
    // The approach. Still well under the IP and close in: circle the
    // target (the way the bot is already turning, edging out) while it
    // climbs. At height: straight for the target, and arriving too close to
    // push over, extend straight out first and come back round.
    let aim: Vec3;
    if (pos.y < ipY - 20 && flat < runIn + DIVE_CLIMB_STANDOFF && flat > 0) {
      const side = fwd.x * d.z - fwd.z * d.x >= 0 ? 1 : -1;
      const out = flat < runIn + DIVE_CLIMB_STANDOFF * 0.6 ? 0.5 : 0;
      aim = {
        x: ((-d.z * side - d.x * out) / flat) * 300,
        y: ipY - pos.y,
        z: ((d.x * side - d.z * out) / flat) * 300,
      };
    } else if (flat < runIn * 0.6) {
      aim = { x: fwd.x * 300, y: ipY - pos.y, z: fwd.z * 300 };
    } else {
      aim = { x: d.x, y: ipY - pos.y, z: d.z };
    }
    // A climb the plane can hold: steeper, it bleeds to MIN_SPEED and mushes
    // under the line its probes cleared.
    aim.y = Math.min(aim.y, Math.hypot(aim.x, aim.z) * DIVE_CLIMB_GRADE);
    // The fan picks the clear heading nearest the approach; boxed in, the
    // bot recovers this decision and comes back to the run on the next.
    const heading = this.fanAround(bot, now, aim, margin);
    if (!heading) return false;
    this.steerToward(bot, heading.dir, 0, 0, 1);
    return true;
  }

  /**
   * D3: would a probe sphere at `p` (posed at `t`) enter an active collapse
   * zone that `from` — where the bot is now — is not already inside? Probes
   * only: a bot steers clear of a collapse coming down, but the zone is not
   * solid (the debris itself is, via collideBotMovers), and a bot caught
   * inside one is never boxed in by it.
   */
  private inCollapseZone(p: Vec3, r: number, t: number, from?: Vec3): boolean {
    if (this.inHazard(p, r, t, from)) {
      this.zoneRefusals++;
      return true;
    }
    const field = this.movers.collapses;
    if (!field || field.list.length === 0) return false;
    if (!collapseZoneHit(p, r, field.list, t, from)) return false;
    this.zoneRefusals++;
    return true;
  }

  /** D5: the room's warned director events (pending() of its
   * DestructionDirector), refreshed every tick. */
  setHazards(events: readonly DirectorEvent[]): void {
    this.hazards = events;
  }

  /** Inside a warned event's zone at `t` that `from` is not already in? */
  private inHazard(p: Vec3, r: number, t: number, from?: Vec3): boolean {
    for (const e of this.hazards) {
      if (t < e.w || t > e.at + HAZARD_TAIL_MS) continue;
      if (!inDangerZone(e, p, r)) continue;
      if (from && inDangerZone(e, from)) continue;
      return true;
    }
    return false;
  }

  /**
   * Is a (re)spawn at `pos` heading `yaw` (level) safe for a bot? The spawn
   * point and BOT_SPAWN_CLEAR_AHEAD of straight-ahead flight must miss the
   * city, the trees and the L2 movers — pickBotRespawn's predicate, so a
   * canyon spawn never lands in a facade, a canopy or a crane jib.
   */
  spawnClear(pos: Vec3, yaw: number, now: number): boolean {
    const fwd = flightForward({ yaw, pitch: 0 });
    const gaps = gapsOf(this.movers);
    // Samples a probe radius apart tile the run with overlapping spheres.
    for (let s = 0; s <= BOT_SPAWN_CLEAR_AHEAD; s += BOT_PROBE_RADIUS) {
      const p = canonicalize({
        x: pos.x + fwd.x * s,
        y: pos.y,
        z: pos.z + fwd.z * s,
      });
      if (hitsGround(p, BOT_PROBE_RADIUS, gaps)) return false;
      if (collideCity(p, BOT_PROBE_RADIUS, this.buildings, this.cityIndex)) {
        return false;
      }
      // The overlapping spheres already tile the run, so trees need no sweep.
      if (collideNature(p, BOT_PROBE_RADIUS, this.nature)) return false;
      const at = now + (s / BOT_SPAWN_SPEED) * 1000;
      if (
        collideBotMovers(
          p,
          BOT_PROBE_RADIUS + BOT_MOVER_CLEAR,
          this.movers,
          // Posed when the bot gets there, like blockedAlong: a jib slews.
          at,
        ) ||
        // D3: never spawn into an active collapse.
        this.inCollapseZone(p, BOT_PROBE_RADIUS, at)
      ) {
        return false;
      }
    }
    return true;
  }

  /** S9: the mover field with the boss carrier left out — what a bot on its
   * launch run collides with (its own carrier is not solid to it yet). */
  private withoutCarrier(): MoverField {
    return { ...this.movers, boss: undefined };
  }

  /**
   * S9: is a carrier launch released at `pos` / `yaw` / `pitch` / `speed`
   * at `at` (ms) safe? Its launch run — `graceMs` of stick-neutral flight,
   * stepped exactly as tick() will fly it — must miss the ground, the
   * city, the trees and every mover but its carrier; then BOT_SPAWN_CLEAR_AHEAD
   * more of straight flight must miss everything, the carrier included, by
   * the probe margin (it is solid again by then).
   */
  launchClear(
    spawn: SpawnState,
    pitch: number,
    graceMs: number,
    at: number,
  ): boolean {
    let f = this.flightFromSpawn(spawn);
    f.pitch = pitch;
    const free = this.withoutCarrier();
    const gaps = gapsOf(this.movers);
    const runOut = (BOT_SPAWN_CLEAR_AHEAD / spawn.speed) * 1000;
    const inp = botInput(NEUTRAL); // A1: once, not per step
    for (let ms = 0; ms <= graceMs + runOut; ms += BOT_DT * 1000) {
      f = botStep(f, inp);
      const t = at + ms + BOT_DT * 1000;
      const p = f.pos;
      const after = ms >= graceMs;
      const r = after ? BOT_PROBE_RADIUS : PLAYER_RADIUS;
      if (
        hitsGround(p, r, gaps) ||
        collideCity(p, r, this.buildings, this.cityIndex) ||
        collideNature(p, r, this.nature) ||
        collideBotMovers(p, r, after ? this.movers : free, t) ||
        this.inCollapseZone(p, r, t)
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
    const cues: BombReleaseCue[] = [];
    this.rolloutsLeft = BOT_HOLE_ROLLOUTS_PER_TICK;
    this.trackTransits(now, contacts);
    const hits = this.flyRounds(now, contacts);
    this.beginTick(now, contacts);

    for (const bot of this.bots.values()) {
      if (!bot.alive) continue;
      // B3: a committed loop / roll flies its own stick (its rollout already
      // flew this exact path clear), then the level tail the rollout also
      // checked (held like a dodge, below), before the brain takes over.
      let raw = bot.maneuver ? this.maneuverStep(bot, now) : null;
      // S9: a launch run off the carrier flies stick-neutral, as cleared.
      const launched = now < bot.carrierUntil;
      if (launched) raw = botInput(NEUTRAL);
      // A hazard dodge (or a maneuver's tail) holds its rollout-checked
      // stick to its end; only a blocked path cuts it short.
      const dodging = now < bot.dodgeUntil;
      // Down among the towers the curved probe runs every tick, not just at
      // the 5 Hz decision: a decision is ~8 m of travel at MIN_SPEED, and a
      // wall on the inside of a turn closes that fast. A blocked path pulls
      // the next decision forward; it never sharpens anything else. A thread
      // is exempt: its rollout assumed the plain 5 Hz cadence, and an extra
      // decision would fly a path nobody checked.
      if (
        !raw &&
        ((decide && !dodging) ||
          (!bot.thread &&
            !bot.tunnel &&
            bot.state !== "RECOVER" &&
            bot.flight.pos.y < BOT_CANYON_PROBE_ALT &&
            this.pathBlocked(bot, now, 1)))
      ) {
        this.decide(bot, now, contacts);
        if (bot.maneuver) raw = this.maneuverStep(bot, now);
      }
      // The full F7 envelope only inside a maneuver; otherwise the bots'
      // pitch-limited, roll-free one.
      bot.flight = botStep(bot.flight, raw ?? botInput(bot.input));

      // Identical geometry to players: solids (H1 holes open) + ground, PLAYER_RADIUS —
      // plus the L2 movers a bot is allowed to hit (crane geometry and the
      // blimp; helicopters are bot-transparent, see collideBotMovers).
      if (
        // D9: a fallen bridge span is a hole here, as in the crash check
        // and every bot probe, rollout and sight line.
        hitsGround(bot.flight.pos, PLAYER_RADIUS, gapsOf(this.movers)) ||
        collideCity(
          bot.flight.pos,
          PLAYER_RADIUS,
          this.buildings,
          this.cityIndex,
        ) ||
        collideBotMovers(
          bot.flight.pos,
          PLAYER_RADIUS,
          launched ? this.withoutCarrier() : this.movers,
          now,
        ) ||
        collideNature(bot.flight.pos, PLAYER_RADIUS, this.nature)
      ) {
        bot.alive = false;
        crashes.push(bot.entry.id);
        continue;
      }

      const shot = this.maybeFire(bot, now, contacts);
      if (shot) shots.push(shot);
      // W2: a run past its clock is missed; one in its window cues a drop.
      if (bot.run && now >= bot.run.until) this.finishRun(bot, now);
      if (bot.run && this.releaseCued(bot)) {
        const c = this.contactOf(bot.entry.id);
        if (c) cues.push({ botId: bot.entry.id, pos: c.pos, vel: c.vel });
      }
    }
    return { shots, cues, hits, crashes };
  }

  /**
   * B3 per-tick bookkeeping, before anyone decides: each bot's HP off the
   * contact list, who is engaged on whom (pincers, anti-farming), and the
   * spent hazard discs dropped.
   */
  private beginTick(now: number, contacts: readonly BotContact[]): void {
    for (const c of contacts) {
      const bot = this.bots.get(c.id);
      if (bot) bot.hp = c.hp === undefined ? 1 : c.hp / MAX_HP;
    }
    this.engaged = new Map();
    for (const b of this.bots.values()) {
      if (!b.alive || b.state !== "ENGAGE" || !b.targetId) continue;
      const list = this.engaged.get(b.targetId);
      if (list) list.push(b.entry.id);
      else this.engaged.set(b.targetId, [b.entry.id]);
    }
    this.pincerTick = new Map();
    if (this.discs.length > 0) {
      for (const [key, list] of this.hazardSources) {
        const live = liveHazards(list, now);
        if (live.length === 0) this.hazardSources.delete(key);
        else this.hazardSources.set(key, live);
      }
      this.discs = [...this.hazardSources.values()].flat();
    }
  }

  /** One tick of the bot's committed maneuver: the stick to fly, or null
   * once it has handed back — the maneuver cleared, and the level tail its
   * rollout flew (BOT_DEFEND_TAIL_S of a neutral stick) held from now. */
  private maneuverStep(bot: Bot, now: number): FlightInput | null {
    const m = bot.maneuver;
    if (!m) return null;
    const input = maneuverInput(bot.flight, m);
    if (!input) {
      bot.maneuver = null;
      bot.input = NEUTRAL;
      bot.dodgeUntil = now + BOT_DEFEND_TAIL_S * 1000;
      return null;
    }
    m.ticks++;
    bot.input = input;
    return input;
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
    const gaps = gapsOf(this.movers);
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
        if (losClear(r.shot.origin, targetPos, this.buildings, gaps)) {
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
      this.trackTunnels(now, c.id, prev, c.pos);
    }
    for (const id of this.contactPrev.keys()) {
      if (seen.has(id)) continue;
      this.contactPrev.delete(id);
      this.transits.delete(id);
      this.tunnelSeen.delete(id);
    }
  }

  /**
   * U4: note a contact inside a bore (below street level, within its
   * section), with the edge its motion along the bore says it is flying —
   * what a chaser follows. A mid-bore crossing counts as a transit.
   */
  private trackTunnels(now: number, id: string, prev: Vec3, pos: Vec3): void {
    if (pos.y >= 0) return;
    for (let k = 0; k < TUNNELS.length; k++) {
      const t = TUNNELS[k] as Tunnel;
      if (tunnelTransit(t, prev, pos) !== 0) this.tunnelTransits++;
      tunnelFrameInto(t, pos, tunnelFrame);
      const s = tunnelFrame.s;
      if (s < 0 || s > t.length || Math.abs(tunnelFrame.lat) > 20) continue;
      tunnelFrameInto(t, prev, tunnelFrame);
      const ds = s - tunnelFrame.s;
      if (ds === 0) continue;
      this.tunnelSeen.set(id, { edge: 2 * k + (ds > 0 ? 0 : 1), at: now });
    }
  }

  // --- brain ---

  private decide(bot: Bot, now: number, contacts: readonly BotContact[]): void {
    this.stats.decisions++;
    bot.dodgeUntil = Number.NEGATIVE_INFINITY;
    this.decideInner(bot, now, contacts);
    // B3: whatever the brain chose, a stick that would carry the bot into a
    // timed hazard is swapped for a variant that misses it.
    this.dodgeHazards(bot, now);
  }

  private decideInner(
    bot: Bot,
    now: number,
    contacts: readonly BotContact[],
  ): void {
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
    // U4: a committed tunnel pass outranks everything the same way.
    if (bot.tunnel) {
      const input = tunnelInput(bot.flight, bot.tunnel, this.caveIns(), now);
      if (input) {
        bot.input = input;
        return;
      }
      this.endTunnel(bot);
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
    // B3: with tactics on a fresh bot settles a little longer — still
    // inside the straight run-out spawnClear cleared for it.
    if (Number.isNaN(bot.graceUntil)) {
      bot.graceUntil =
        now + BOT_SPAWN_GRACE_MS + (this.tactics ? BOT_SPAWN_SETTLE_MS : 0);
    }
    // S9: off the boss carrier, settle down the lattice into the band
    // before the first fight — a fight joined from the carrier's ~270 m
    // dives onto the roofs (the bot sim: 2× the crashes).
    const settling =
      bot.flight.pos.y > BOT_CANYON_PROBE_ALT &&
      now < bot.carrierUntil + LAUNCH_SETTLE_MS;
    if (now < bot.graceUntil || settling) {
      if (blocked) {
        recover(false);
        return;
      }
      bot.state = "PATROL";
      bot.targetId = null;
      // W1: a hunter settles down the lattice toward its quarry.
      this.canyonPatrol(bot, this.quarryPos(bot, contacts), true);
      return;
    }

    // B3: something on the six is defended first — a loop or a roll when
    // there is sky for it, the break below otherwise — then a hurt bot
    // leaves the fight, and a bot zooming out of a boom pass extends.
    if (this.tactics) {
      const six = threatOnSix(bot.entry.id, bot.flight.pos, fwd, contacts);
      const pre = chooseTactic({
        style: bot.style,
        hp: bot.hp,
        breaking: bot.breakSince !== null,
        breakingFor: bot.breakSince === null ? 0 : now - bot.breakSince,
        above: 0,
        onSix: six !== null,
        pincerSide: 0,
        boss: false,
        boomReady: false,
        skill: bot.targetId ? this.skill.levelOf(bot.targetId) : 0,
      });
      if (pre === "defend") {
        bot.tactic = "defend";
        if (!blocked && this.tryDefend(bot, now)) return;
        if (now >= bot.evadeUntil) {
          bot.evadeUntil = now + BOT_EVADE_MS;
          bot.breakTurn = bot.tacticRand() < 0.5 ? -1 : 1;
          this.stats.defendBreaks++;
        }
      } else if (pre === "breakOff") {
        if (bot.breakSince === null) {
          bot.breakSince = now;
          this.stats.breakOffs++;
        }
        bot.tactic = "breakOff";
        if (now >= bot.evadeUntil) {
          if (blocked) {
            recover(false);
            return;
          }
          this.patrol(
            bot,
            now,
            BOT_HOLE_ESCAPE_CHANCE,
            this.awayFromBoss(bot, contacts),
          );
          return;
        }
      } else {
        bot.breakSince = null;
      }
      if (now < bot.zoomUntil && now >= bot.evadeUntil) {
        if (blocked) {
          recover(false);
          return;
        }
        this.zoom(bot);
        return;
      }
    }

    // W2: a bomb run flies its own stick — until something on its six or
    // breaking off takes the bot off it. A blocked nose ends a dive; the
    // approach and a carpet recover from one (RECOVER's pull-up) and carry
    // on.
    if (bot.run) {
      if (
        now < bot.evadeUntil ||
        bot.breakSince !== null ||
        (blocked && bot.run.diving)
      ) {
        this.finishRun(bot, now);
      } else if (blocked) {
        // Climbing out to the IP, or down a street: pull up like any bot
        // and come back to the run on a later decision.
        recover(false);
        return;
      } else if (this.flyRun(bot, now, margin)) {
        return;
      } else if (bot.run) {
        recover(false);
        return;
      }
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
        bot.fireAllowedAt = now + this.reactionMs(bot, target);
        bot.boomUntil = Number.NEGATIVE_INFINITY;
      }
      bot.state = "ENGAGE";
      bot.fought = true;
      const d = wrapDelta(bot.flight.pos, target.pos);
      const dist = Math.hypot(d.x, d.y, d.z);
      const tactic = this.fightTactic(bot, now, target);
      const side = tactic === "pincer" ? this.pincerSideOf(bot, target) : 0;

      // A threat parked close behind → break off instead of dragging it —
      // or, at the end of a boom pass, ZOOM: extend and climb away instead
      // of turning with the target.
      const fwd = flightForward(bot.flight);
      const along = d.x * fwd.x + d.y * fwd.y + d.z * fwd.z;
      if (!target.boss && dist < BOT_THREAT_RANGE && along < 0) {
        if (now < bot.boomUntil) {
          bot.boomUntil = Number.NEGATIVE_INFINITY;
          bot.zoomUntil = now + BOT_ZOOM_MS;
          bot.boomCooldownUntil = bot.zoomUntil + BOT_BOOM_COOLDOWN_MS;
          this.stats.zooms++;
          if (blocked) {
            recover(false);
            return;
          }
          this.zoom(bot);
          return;
        }
        bot.evadeUntil = now + BOT_EVADE_MS;
        bot.breakTurn = bot.rand() < 0.5 ? -1 : 1;
        bot.state = "EVADE";
        return;
      }

      // The target just flew through a hole this bot can line up on: follow
      // it through rather than around. A committed follow holds ENGAGE and
      // the target (guns stay live) for the few seconds of the pass.
      if (this.followThrough(bot, now, target)) return;
      // U4: or into the tunnel it dived into.
      if (this.followTunnel(bot, now, target)) return;

      // Lead pursuit: aim where the target will be when a bullet arrives,
      // wandered by the seeded jitter (resampled per decision).
      // B3: scaled by style and by the target's skill (the draws are the
      // same either way, so `rand`'s sequence is untouched).
      const jitter = BOT_AIM_JITTER * this.jitterScale(bot, target);
      bot.aimJitterYaw = (bot.rand() * 2 - 1) * jitter;
      bot.aimJitterPitch = (bot.rand() * 2 - 1) * jitter;
      const t = leadTime(dist, bot.flight.speed);
      const aim: Vec3 = {
        x: d.x + target.vel.x * t,
        y: d.y + target.vel.y * t,
        z: d.z + target.vel.z * t,
      };
      // B3 pincer: swing out to this bot's side of the target's track,
      // converging inside gun range.
      const flank = pincerOffset(
        target.vel,
        side,
        dist,
        BOT_PINCER_OFFSET,
        BOT_FIRE_RANGE * 0.7,
      );
      if (side !== 0) {
        aim.x += flank.x;
        aim.z += flank.z;
        this.stats.pincerDecisions++;
      }
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
        this.canyonPatrol(
          bot,
          side === 0
            ? target.pos
            : canonicalize({
                x: target.pos.x + flank.x,
                y: target.pos.y,
                z: target.pos.z + flank.z,
              }),
        );
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
        // B3: a boom pass dives at full power from above the roofs; a sniper
        // inside its stand-off holds back rather than closing.
        if (now < bot.boomUntil && !low && heading.direct) throttle = 1;
        if (
          this.tactics &&
          !target.boss &&
          bot.tuning.standoff > 0 &&
          dist < bot.tuning.standoff
        ) {
          throttle = -1;
        }
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

    // B3: a hurt bot patrols out from under the zeppelin's flak. W1: a
    // hunter with nobody in sight turns the lattice toward its quarry.
    const hurt = this.tactics && bot.hp < BOSS_HURT_HP;
    this.patrol(
      bot,
      now,
      BOT_HOLE_CHANCE,
      (hurt ? this.awayFromBoss(bot, contacts) : undefined) ??
        this.quarryPos(bot, contacts),
    );
  }

  /** W1: where the bot's quarry is, from this tick's contacts (undefined:
   * no quarry, or it is not in the air). */
  private quarryPos(
    bot: Bot,
    contacts: readonly BotContact[],
  ): Vec3 | undefined {
    // W3: a provoked enemy heads for the nest that hit it.
    const detour = this.detours.get(bot.entry.id);
    if (detour) return detour;
    if (bot.quarryId === null) return undefined;
    for (const c of contacts) if (c.id === bot.quarryId) return c.pos;
    return undefined;
  }

  /** PATROL: the street lattice. Coming back from a fight, re-join the
   * NEAREST street — the waypoint picked before the chase may now be a
   * cross-country flight over the blocks. A bot breaking off (B3) takes
   * the holes it passes far more often: the way out of a fight. */
  private patrol(
    bot: Bot,
    now: number,
    holeChance = BOT_HOLE_CHANCE,
    /** Turn the lattice toward this point at each corner (a break-off
     * leaving the zeppelin's flak), instead of the seeded turns. */
    toward?: Vec3,
  ): void {
    bot.state = "PATROL";
    bot.targetId = null;
    if (bot.fought) {
      bot.fought = false;
      bot.waypoint = null;
      bot.travel = null;
    }
    const stageY = this.holeRouting(bot, now, holeChance);
    if (bot.thread) return;
    if (this.tunnelRouting(bot, now)) return;
    this.canyonPatrol(bot, toward, false, stageY);
  }

  /** A point straight away from the nearest zeppelin weak point within its
   * flak's reach (plus a margin), or undefined when none is near. */
  private awayFromBoss(
    bot: Bot,
    contacts: readonly BotContact[],
  ): Vec3 | undefined {
    let near: Vec3 | null = null;
    let best = BOSS_FLAK_RANGE + 150;
    for (const c of contacts) {
      if (!c.boss) continue;
      const d = wrapDistance(bot.flight.pos, c.pos);
      if (d < best) {
        best = d;
        near = c.pos;
      }
    }
    if (!near) return undefined;
    const d = wrapDelta(near, bot.flight.pos);
    const flat = Math.hypot(d.x, d.z) || 1;
    return canonicalize({
      x: bot.flight.pos.x + (d.x / flat) * 400,
      y: bot.flight.pos.y,
      z: bot.flight.pos.z + (d.z / flat) * 400,
    });
  }

  // --- tactics (B3) ---

  /** The tactic for a fight decision against `target` (turnFight with
   * tactics off), latching a boom pass when one starts. */
  private fightTactic(bot: Bot, now: number, target: BotContact): Tactic {
    if (!this.tactics) return "turnFight";
    const pincer = bot.tuning.pincer && !target.boss;
    let tactic = chooseTactic({
      style: bot.style,
      hp: bot.hp,
      breaking: false,
      breakingFor: 0,
      above: bot.flight.pos.y - target.pos.y,
      onSix: false,
      pincerSide: pincer ? this.pincerSideOf(bot, target) : 0,
      boss: target.boss === true,
      boomReady:
        now >= bot.boomCooldownUntil &&
        now >= bot.zoomUntil &&
        now >= bot.boomUntil,
      skill: target.boss ? 0 : this.skill.levelOf(target.id),
    });
    // The pre-fight check already ruled on HP (with its own latch).
    if (tactic === "breakOff" || tactic === "defend") tactic = "turnFight";
    if (tactic === "boomZoom") {
      bot.boomUntil = now + BOT_ATTACK_PASS_MS + BOT_ZOOM_MS;
      this.stats.boomPasses++;
    }
    bot.tactic = now < bot.boomUntil ? "boomZoom" : tactic;
    return tactic;
  }

  /** This bot's pincer side on `target` this tick (0: none). */
  private pincerSideOf(bot: Bot, target: BotContact): -1 | 0 | 1 {
    if (!this.tactics || target.boss || !bot.tuning.pincer) return 0;
    let sides = this.pincerTick.get(target.id);
    if (!sides) {
      const ids = new Set(this.engaged.get(target.id) ?? []);
      ids.add(bot.entry.id);
      const attackers: { id: string; pos: Vec3 }[] = [];
      for (const id of ids) {
        const b = this.bots.get(id);
        if (b?.alive && b.tuning.pincer) {
          attackers.push({ id, pos: b.flight.pos });
        }
      }
      sides = pincerSides(target, attackers, this.pincerPrev);
      for (const [id, side] of sides) this.pincerPrev.set(id, side);
      this.pincerTick.set(target.id, sides);
    }
    return sides.get(bot.entry.id) ?? 0;
  }

  /** The zoom after a boom pass: extend straight down the lattice at the
   * bot's own band, power held — away from the target instead of turning
   * with it. Measured: climbing the zoom (band + 25 m, still under the
   * probe split) cost the plain sim ~6 crashes on both seed sets, every one
   * a slow bot over a block, so the canyon zoom is the extension alone. */
  private zoom(bot: Bot): void {
    bot.state = "PATROL";
    bot.targetId = null;
    bot.tactic = "boomZoom";
    if (bot.fought) {
      bot.fought = false;
      bot.waypoint = null;
      bot.travel = null;
    }
    this.canyonPatrol(bot, undefined, true);
  }

  /** Aim-jitter multiplier against `target`: style × the human's skill. */
  private jitterScale(bot: Bot, target: BotContact): number {
    if (!this.tactics) return 1;
    const skill = target.boss ? 1 : this.skill.jitterScale(target.id);
    // W1: × its wave's grade, held to a sane band.
    return clamp(
      bot.tuning.jitter * skill * bot.grade.jitter,
      JITTER_SCALE_MIN,
      JITTER_SCALE_MAX,
    );
  }

  /** First-shot reaction delay against `target`, ms. */
  private reactionMs(bot: Bot, target: BotContact): number {
    if (!this.tactics) return BOT_REACTION_MS;
    const skill = target.boss ? 1 : this.skill.reactionScale(target.id);
    return BOT_REACTION_MS * bot.tuning.reaction * skill * bot.grade.reaction;
  }

  /**
   * Something sits on the six: commit to a loop or a barrel roll if the bot
   * has the sky for one — above BOT_DEFEND_MIN_ALT, off cooldown, and with
   * a rollout of the WHOLE maneuver plus a level tail clear of everything.
   * The style picks which to try first. False: fly the plain break.
   */
  private tryDefend(bot: Bot, now: number): boolean {
    if (bot.thread || bot.tunnel) return false;
    if (bot.flight.pos.y < BOT_DEFEND_MIN_ALT) return false;
    if (now < bot.defendCooldownUntil) return false;
    bot.defendCooldownUntil = now + BOT_DEFEND_COOLDOWN_MS;
    const dir: 1 | -1 = bot.tacticRand() < 0.5 ? -1 : 1;
    const kinds: ("loop" | "roll")[] =
      bot.tuning.defense === "loop" ? ["loop", "roll"] : ["roll", "loop"];
    for (const kind of kinds) {
      if (this.rolloutsLeft <= 0) return false;
      this.rolloutsLeft--;
      const m: Maneuver = { kind, dir, ticks: 0 };
      if (!this.rolloutManeuver(bot, m, now)) continue;
      bot.maneuver = m;
      bot.state = "EVADE";
      bot.thread = null;
      const key = `${bot.style}:${kind}`;
      this.stats.maneuvers[key] = (this.stats.maneuvers[key] ?? 0) + 1;
      return true;
    }
    return false;
  }

  /**
   * Fly `m` forward from the bot's live state exactly as tick() will
   * (maneuverInput every tick, the full envelope), then BOT_DEFEND_TAIL_S
   * of held level flight, against the city, the ground, the trees, the
   * movers (posed on arrival), the collapse zones and the hazard discs with
   * BOT_DEFEND_MARGIN to spare — and under BOT_CEILING_ALT the whole way.
   */
  private rolloutManeuver(bot: Bot, m: Maneuver, now: number): boolean {
    const r = PLAYER_RADIUS + BOT_DEFEND_MARGIN;
    const probe: Maneuver = { ...m };
    const gaps = gapsOf(this.movers);
    let f = bot.flight;
    let tail = -1;
    const maxSteps = Math.ceil((BOT_DEFEND_MAX_S + BOT_DEFEND_TAIL_S) / BOT_DT);
    for (let k = 1; k <= maxSteps; k++) {
      let input: FlightInput | null = null;
      if (tail < 0) {
        input = maneuverInput(f, probe);
        if (input) probe.ticks++;
        else tail = k;
      }
      if (tail > 0 && (k - tail) * BOT_DT >= BOT_DEFEND_TAIL_S) return true;
      f = botStep(f, input ?? botInput(NEUTRAL));
      const t = now + k * BOT_DT * 1000;
      if (
        f.pos.y > BOT_DEFEND_MAX_ALT ||
        hitsGround(f.pos, r, gaps) ||
        collideCity(f.pos, r, this.buildings, this.cityIndex) ||
        collideNature(f.pos, r, this.nature) ||
        collideBotMovers(f.pos, r + BOT_MOVER_CLEAR, this.movers, t) ||
        this.inCollapseZone(f.pos, r, t, bot.flight.pos) ||
        pointInHazard(f.pos, r, t - BOT_DT * 1000, t, this.discs)
      ) {
        return false;
      }
    }
    return false;
  }

  /**
   * B3 hazard dodging: if the bot — holding the stick the brain just chose,
   * or simply holding its course — would fly into a hazard disc inside
   * HAZARD_LOOK_S, try variants. Down in the canyon only one: bleed
   * speed, re-checked every decision with the brain still steering. Above
   * the roofs: speed, then dive or turn (never climb) — and the first whose
   * held flight misses
   * every disc AND stays clear of the city, trees, movers, collapse zones,
   * floor and ceiling until the danger is over is committed: held, with no
   * re-decisions, until then (dodgeUntil) — so the path it was checked on is
   * the path it flies. None clear: keep the brain's stick (a hazard is
   * survivable; a wall is not). A committed thread, tunnel pass or
   * maneuver, or a RECOVER, is never second-guessed, and a healthy bot pressing an attack
   * pass (the zeppelin's, under its flak) only ever changes its throttle —
   * the nose stays on the target.
   */
  private dodgeHazards(bot: Bot, now: number): void {
    if (this.discs.length === 0) return;
    if (bot.thread || bot.tunnel || bot.maneuver) return;
    if (bot.state === "RECOVER") return;
    const near = this.nearDiscs(bot.flight, now);
    if (near.length === 0) return;
    const base = bot.input;
    if (
      !this.inputMeetsHazard(bot.flight, base, now, near) &&
      !this.inputMeetsHazard(
        bot.flight,
        { ...NEUTRAL, throttle: base.throttle },
        now,
        near,
      )
    ) {
      return;
    }
    let until = now;
    for (const d of near) until = Math.max(until, d.t1);
    until = Math.min(until, now + HAZARD_LOOK_S * 1000) + BOT_DT * 1000;
    const cap = BOT_INPUT_CAP;
    // A healthy bot presses its pass; a hurt one takes any way out.
    const pressing =
      bot.state === "ENGAGE" && now < bot.attackUntil && bot.hp >= 0.75;
    // Down in the canyon the street is the path, and the one safe change
    // is to arrive later: bleed speed, the brain still steering (no
    // commit). Measured over 54 rooms of C2 chaos, every bolder canyon dodge
    // — firewalling it, climbing, a climb only over a roadway checked to the
    // end of the danger — traded blasts for facades: total bot deaths
    // (crashes, hazards, wrecks) 205 / 194 against 162 for this, main 222.
    if (bot.flight.pos.y < BOT_CANYON_PROBE_ALT) {
      const slow = { ...base, throttle: -1 };
      if (slow.throttle === base.throttle) return;
      if (this.inputMeetsHazard(bot.flight, slow, now, near)) return;
      bot.input = slow;
      this.stats.dodges++;
      return;
    }
    const level = { ...NEUTRAL, throttle: base.throttle };
    const variants: FlightInput[] = [
      { ...base, throttle: -1 },
      { ...base, throttle: 1 },
      { ...level, throttle: -1 },
      { ...level, throttle: 1 },
    ];
    if (!pressing) {
      // Never a climb up here: the sky above the roofs is the zeppelin's,
      // and a dodge that ends under its hull ends in RECOVER's pull-up
      // into it (measured: hull crashes 3 → 11 over 54 rooms).
      variants.push(
        { ...level, pitch: -cap * 0.5, throttle: 1 },
        { ...level, turn: cap, throttle: 1 },
        { ...level, turn: -cap, throttle: 1 },
      );
    }
    for (const v of variants) {
      if (this.inputMeetsHazard(bot.flight, v, now, near)) continue;
      if (this.heldBlocked(bot.flight, v, now, until)) continue;
      bot.input = v;
      bot.dodgeUntil = until;
      this.stats.dodges++;
      return;
    }
  }

  /** Does holding `input` from `flight` until `until` (plus half a second)
   * meet anything solid, the collapse zones, the floor or the ceiling? */
  private heldBlocked(
    flight: FlightState,
    input: FlightInput,
    now: number,
    until: number,
  ): boolean {
    const r = PLAYER_RADIUS + HAZARD_MARGIN;
    const gaps = gapsOf(this.movers);
    let f = flight;
    const steps = Math.ceil((until - now) / (BOT_DT * 1000) + 0.5 / BOT_DT);
    const inp = botInput(input); // A1: once, not per step
    for (let k = 1; k <= steps; k++) {
      f = botStep(f, inp);
      const t = now + k * BOT_DT * 1000;
      if (
        f.pos.y < BOT_MIN_ALT ||
        f.pos.y > BOT_CEILING_ALT ||
        hitsGround(f.pos, r, gaps) ||
        collideCity(f.pos, r, this.buildings, this.cityIndex) ||
        collideNature(f.pos, r, this.nature) ||
        collideBotMovers(f.pos, r + BOT_MOVER_CLEAR, this.movers, t) ||
        this.inCollapseZone(f.pos, r, t, flight.pos)
      ) {
        return true;
      }
    }
    return false;
  }

  /** The discs a bot could reach inside HAZARD_LOOK_S, live in that window. */
  private nearDiscs(f: FlightState, now: number): HazardDisc[] {
    const reach = MAX_SPEED * HAZARD_LOOK_S + PLAYER_RADIUS;
    const end = now + HAZARD_LOOK_S * 1000;
    const out: HazardDisc[] = [];
    for (const d of this.discs) {
      if (d.t1 < now || d.t0 > end) continue;
      if (wrapDistance(f.pos, d) > reach + d.r) continue;
      out.push(d);
    }
    return out;
  }

  /** Does holding `input` for HAZARD_LOOK_S from `flight` meet a disc? */
  private inputMeetsHazard(
    flight: FlightState,
    input: FlightInput,
    now: number,
    discs: readonly HazardDisc[],
  ): boolean {
    let last = now;
    for (const d of discs) last = Math.max(last, d.t1);
    const r = PLAYER_RADIUS + HAZARD_MARGIN;
    let f = flight;
    const steps = Math.round(HAZARD_LOOK_S / BOT_DT);
    const inp = botInput(input); // A1: once, not per step
    for (let k = 1; k <= steps; k++) {
      const t0 = now + (k - 1) * BOT_DT * 1000;
      if (t0 > last) return false;
      f = botStep(f, inp);
      if (pointInHazard(f.pos, r, t0, t0 + BOT_DT * 1000, discs)) return true;
    }
    return false;
  }

  // --- tunnels (U4) ---

  /**
   * A patrol's opportunistic tunnel: an entry (portal lip or river mouth)
   * within BOT_TUNNEL_RANGE, ahead of the nose and facing roughly the way
   * the bore goes in. Rolled once per encounter; a won roll tries a rollout
   * (at most one per tick, and not again for BOT_TUNNEL_RETRY_MS).
   */
  private tunnelRouting(bot: Bot, now: number): boolean {
    const pos = bot.flight.pos;
    const fwd = flightForward({ yaw: bot.flight.yaw, pitch: 0 });
    for (let i = 0; i < this.tunnelEdgeList.length; i++) {
      const edge = this.tunnelEdgeList[i] as TunnelEdge;
      const dx = wrapDeltaAxis(pos.x, edge.mouthIn.x);
      const dz = wrapDeltaAxis(pos.z, edge.mouthIn.z);
      const dist = Math.hypot(dx, dz);
      if (dist > BOT_TUNNEL_RANGE || dist < BOT_HOLE_CARROT) {
        bot.tunnelRolls.delete(i);
        continue;
      }
      // Ahead, and the bore's way in roughly along the nose.
      if ((dx * fwd.x + dz * fwd.z) / dist < 0.5) continue;
      tunnelPointInto(edge.tunnel, edgeArc(edge, 0), tunnelCarrot);
      const inX = Math.cos(tunnelCarrot.th) * edge.dir;
      const inZ = Math.sin(tunnelCarrot.th) * edge.dir;
      if (inX * fwd.x + inZ * fwd.z < 0.3) continue;
      let won = bot.tunnelRolls.get(i);
      if (won === undefined) {
        won = bot.holeRand() < BOT_TUNNEL_CHANCE;
        bot.tunnelRolls.set(i, won);
      }
      if (!won || now < bot.tunnelRetryAt) continue;
      if (this.tryTunnel(bot, edge, now)) return true;
    }
    return false;
  }

  /** A chaser's tunnel follow: its target was seen inside a bore within
   * BOT_TUNNEL_FOLLOW_MS and the bot is short of the entry it went in by. */
  private followTunnel(bot: Bot, now: number, target: BotContact): boolean {
    const seen = this.tunnelSeen.get(target.id);
    if (!seen || now - seen.at > BOT_TUNNEL_FOLLOW_MS) return false;
    if (now < bot.tunnelRetryAt) return false;
    const edge = this.tunnelEdgeList[seen.edge];
    if (!edge) return false;
    tunnelFrameInto(edge.tunnel, bot.flight.pos, tunnelFrame);
    if (edgeProgress(edge, tunnelFrame.s) > -BOT_HOLE_CARROT) return false;
    if (wrapDistance(bot.flight.pos, edge.mouthIn) > BOT_TUNNEL_FOLLOW_RANGE) {
      return false;
    }
    return this.tryTunnel(bot, edge, now);
  }

  /** Commit to `edge` if a rollout of the whole pass flies clean. */
  private tryTunnel(bot: Bot, edge: TunnelEdge, now: number): boolean {
    if (this.tickCount < this.tunnelRolloutTick) return false;
    this.tunnelRolloutTick = this.tickCount + TUNNEL_ROLLOUT_EVERY;
    this.tunnelRollouts++;
    const probe: TunnelThread = { edge, bandY: bot.bandY, out: false };
    if (!this.rolloutTunnel(bot, probe, now)) {
      bot.tunnelRetryAt = now + BOT_TUNNEL_RETRY_MS;
      return false;
    }
    const thread: TunnelThread = { edge, bandY: bot.bandY, out: false };
    const input = tunnelInput(bot.flight, thread, this.caveIns(), now);
    if (!input) return false;
    bot.tunnel = thread;
    bot.input = input;
    this.tunnelCommits++;
    return true;
  }

  /**
   * Fly `thread` forward exactly as tick() will (rolloutThread's rules, the
   * same margins), out to a horizon sized to the pass: the approach, the
   * whole bore and the climb-out at a conservative speed. Under a tunnel's
   * ceiling only the ground can be met — no building, tree, mover or
   * collapse is underground — so those samples test the ground alone.
   */
  private rolloutTunnel(bot: Bot, thread: TunnelThread, now: number): boolean {
    const r = PLAYER_RADIUS + BOT_HOLE_MARGIN;
    const { edge } = thread;
    tunnelFrameInto(edge.tunnel, bot.flight.pos, tunnelFrame);
    const before = Math.max(0, -edgeProgress(edge, tunnelFrame.s));
    const span = before + edge.tunnel.length + TUNNEL_RUNOUT_MAX;
    const horizon = span / Math.max(MIN_SPEED, bot.flight.speed * 0.75);
    let f = bot.flight;
    let input: FlightInput = NEUTRAL;
    const steps = Math.round(horizon / BOT_DT);
    const gaps = gapsOf(this.movers);
    for (let k = 0; k < steps; k++) {
      if (k === 0 || (this.tickCount + k) % BOT_DECISION_EVERY === 0) {
        const next = tunnelInput(
          f,
          thread,
          this.caveIns(),
          now + k * BOT_DT * 1000,
        );
        if (!next) return thread.out;
        input = next;
      }
      f = botStep(f, botInput(input));
      if (hitsGround(f.pos, r, gaps)) return false;
      const t = now + k * BOT_DT * 1000;
      // Below street level outside the river channel is a bore: nothing
      // but its walls (the ground, just tested) — and (U6) its cave-ins —
      // is down there. Their own margin: BOT_MOVER_CLEAR would need a 20 m
      // lane, and the lane is CAVEIN_GAP.
      if (
        f.pos.y + r < 0 &&
        Math.abs(riverOffset(f.pos.z)) > RIVER_HALF_WIDTH + r
      ) {
        const caveins = this.caveIns();
        if (caveins.length > 0 && collideCaveIns(f.pos, r, caveins, t)) {
          return false;
        }
        continue;
      }
      if (
        collideCity(f.pos, r, this.buildings, this.cityIndex) ||
        collideNature(f.pos, r, this.nature) ||
        collideBotMovers(f.pos, r + BOT_MOVER_CLEAR, this.movers, t) ||
        this.inCollapseZone(f.pos, r, t, bot.flight.pos)
      ) {
        return false;
      }
    }
    return false;
  }

  /** U6: the room's live cave-ins (none without a slot). */
  private caveIns(): readonly CaveIn[] {
    return this.movers.caveins?.list ?? NO_CAVEINS;
  }

  /** The tunnel pass is over: re-join the nearest street like a bot back
   * from a fight. */
  private endTunnel(bot: Bot): void {
    if (bot.tunnel?.out) this.tunnelPasses++;
    bot.tunnel = null;
    bot.streetChase = false;
    bot.fought = true;
    bot.waypoint = null;
    bot.travel = null;
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
  private holeRouting(
    bot: Bot,
    now: number,
    chance = BOT_HOLE_CHANCE,
  ): number | undefined {
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
        roll = { won: bot.holeRand() < chance, retryAt: 0 };
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
    // Sky holes, gates (H2: high in a tower, like a sky hole) and L11 bridge
    // underpasses are only ever FOLLOWED: a climb out of the canyon band, or
    // a dive into the river, is worth it only after a target.
    if (kind === "sky" || kind === "gate" || kind === "bridge") return null;
    // H2: so is a tunnel whose mouths open mid-block over the roofs — the
    // patrol would leave its street for the whole run-out over a block.
    if (kind === "tunnel" && !opensOnStreets(edge.span)) return null;
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
   * the 5 m thinnest hole wall (HOLE_WALL_MIN), so no wall or lintel falls
   * between two.
   * True only if the pass ends (hands back) clean inside the horizon.
   */
  private rolloutThread(bot: Bot, thread: Thread, now: number): boolean {
    const r = PLAYER_RADIUS + BOT_HOLE_MARGIN;
    let f = bot.flight;
    let input: FlightInput = NEUTRAL;
    const steps = Math.round(BOT_HOLE_ROLLOUT_S / BOT_DT);
    const gaps = gapsOf(this.movers);
    for (let k = 0; k < steps; k++) {
      if (k === 0 || (this.tickCount + k) % BOT_DECISION_EVERY === 0) {
        const next = threadInput(f, thread);
        if (!next) return true;
        input = next;
      }
      f = botStep(f, botInput(input));
      const t = now + k * BOT_DT * 1000;
      if (
        hitsGround(f.pos, r, gaps) ||
        collideCity(f.pos, r, this.buildings, this.cityIndex) ||
        collideNature(f.pos, r, this.nature) ||
        collideBotMovers(f.pos, r + BOT_MOVER_CLEAR, this.movers, t) ||
        this.inCollapseZone(f.pos, r, t, bot.flight.pos) ||
        // B3: never thread into a missile's or a shell's moment.
        pointInHazard(f.pos, r, t - BOT_DT * 1000, t, this.discs)
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
    // S4: a weak point sits ON the zeppelin's hull — a pass pressed home is
    // a pass flown into it. Inside the stand-off the bot breaks off and
    // dives home like the end of any pass.
    // B3: …and so is one pressed home hurt — the zeppelin's flak is what
    // kills a bot that keeps coming back damaged.
    const hurt = this.tactics && target.boss && bot.hp < BOSS_HURT_HP;
    if ((target.boss && dist < BOT_BOSS_STANDOFF) || hurt) {
      if (now < bot.attackUntil) {
        bot.attackUntil = now;
        bot.attackCooldownUntil = now + BOT_ATTACK_COOLDOWN_MS;
      }
      return false;
    }
    if (now < bot.attackUntil) return true;
    if (now < bot.attackCooldownUntil) return false;
    const reach = target.boss ? BOT_BOSS_PASS_RANGE : BOT_FIRE_RANGE;
    if (target.pos.y <= BOT_ENGAGE_CEILING || dist > reach) {
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
    bot.attackUntil =
      now + (target.boss ? BOT_BOSS_PASS_MS : BOT_ATTACK_PASS_MS);
    // B3: against a human, the cooldown scales with their skill — a
    // veteran gets passes more often, a novice fewer.
    const aggression =
      this.tactics && !target.boss ? this.skill.cooldownScale(target.id) : 1;
    bot.attackCooldownUntil =
      bot.attackUntil + BOT_ATTACK_COOLDOWN_MS * aggression;
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
    // L5/T2: over a train line — its own streets and every street crossing
    // them — hold above the deck and the cars. The probes would see them, but
    // dodging a viaduct down in the canyon is exactly the late, hard turn
    // that puts a bot into a facade; climbing early costs nothing.
    if (this.movers.trains) {
      targetY = Math.max(
        targetY,
        trainFloor(this.movers.trains, bot.flight.pos, TRAIN_BOT_REACH),
        trainFloor(this.movers.trains, bot.waypoint, 0),
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
    // S4: home from a pass, a bot leaves the zeppelin alone until its
    // cooldown is over — it comes down through PATROL's descent onto the
    // street lattice rather than a chase dive across the roofs.
    const resting = now >= bot.attackUntil && now < bot.attackCooldownUntil;
    for (const c of contacts) {
      if (c.id === bot.entry.id || c.prot) continue;
      if (c.boss && resting) continue;
      // B3: a hurt bot leaves the zeppelin to the healthy — chasing its
      // ground track is chasing its flak.
      if (c.boss && this.tactics && bot.hp < BOSS_HURT_HP) continue;
      const dist = wrapDistance(bot.flight.pos, c.pos);
      if (dist > BOT_DETECT_RANGE) continue;
      const score =
        dist +
        (c.boss
          ? BOT_BOSS_PREFERENCE
          : Math.max(0, c.pos.y - BOT_ENGAGE_CEILING) *
            BOT_ACQUIRE_ALT_WEIGHT) -
        (c.id === bot.targetId ? BOT_RETARGET_MARGIN : 0) +
        this.gangPenalty(bot, c);
      inRange.push({ c, score });
    }
    inRange.sort((a, b) => a.score - b.score);
    // Best first, stopping at the first one actually visible. The budget
    // bounds the WORK, not the candidate set: truncating to the nearest few
    // would let a knot of contacts behind one tower blind a bot to a human in
    // open air right in front of it.
    let tests = BOT_LOS_TESTS_MAX;
    const gaps = gapsOf(this.movers);
    for (const { c } of inRange) {
      if (tests-- <= 0) break;
      if (losClear(bot.flight.pos, c.pos, this.buildings, gaps)) {
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
        if (c.id !== bot.targetId || c.prot || (c.boss && resting)) continue;
        if (wrapDistance(bot.flight.pos, c.pos) > BOT_DETECT_RANGE) break;
        return c;
      }
    }
    return null;
  }

  /** B3 anti-farming: a struggling human (skill level < 0) ranks further
   * away for every OTHER bot already engaged on them. */
  private gangPenalty(bot: Bot, c: BotContact): number {
    if (!this.tactics || c.boss) return 0;
    const level = this.skill.levelOf(c.id);
    if (level >= 0) return 0;
    const on = this.engaged.get(c.id);
    if (!on) return 0;
    const others = on.length - (on.includes(bot.entry.id) ? 1 : 0);
    return -level * BOT_SKILL_GANG_PENALTY * others;
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
    const gaps = gapsOf(this.movers);
    for (let i = 0; i < profile.length; i++) {
      const t = profile[i] ?? 0;
      const s = flight.speed * t;
      const p = canonicalize({
        x: flight.pos.x + dx * s,
        y: flight.pos.y + dy * s,
        z: flight.pos.z + dz * s,
      });
      // A fallen bridge span's 40 m gap is wider than these samples are
      // apart, and its edges are no thinner than the deck itself, so unlike
      // a building's holes it can be probed open.
      if (hitsGround(p, radius, gaps)) return true;
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
      // D3: an active collapse is a no-fly zone — entering it, not leaving.
      if (this.inCollapseZone(p, radius, now + t * 1000, flight.pos)) {
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
    const inp = botInput(bot.input); // A1: once, not per step
    const gaps = gapsOf(this.movers);
    while (next < times.length) {
      f = botStep(f, inp);
      t += BOT_DT;
      if (t + 1e-9 < (times[next] ?? 0)) continue;
      next++;
      const p = f.pos;
      if (hitsGround(p, radius, gaps)) return true;
      if (collideCity(p, radius, this.buildings, this.cityIndex)) return true;
      if (collideNature(p, radius, this.nature)) return true;
      if (
        this.probeMovers &&
        (collideBotMovers(
          p,
          radius + BOT_MOVER_CLEAR,
          this.movers,
          now + t * 1000,
        ) ||
          this.inCollapseZone(p, radius, now + t * 1000, bot.flight.pos))
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
    // B3: boxed under the zeppelin or a falling tower, the break turn the
    // other way may still have a way out (measured: every hull and debris
    // death in the 54-room hazard sim was this pull-up, turning one way).
    if (!this.tactics) return;
    for (const pitch of [BOT_INPUT_CAP, 0, -BOT_INPUT_CAP / 2]) {
      const input = { ...climb, pitch, turn: -climb.turn };
      if (!this.arcBlocked(bot.flight, input, now, false)) {
        bot.input = input;
        bot.breakTurn = bot.breakTurn === 1 ? -1 : 1;
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
    const gaps = gapsOf(this.movers);
    const steps = Math.round(RECOVER_LOOK_S / BOT_DT);
    const inp = botInput(input); // A1: once, not per step
    for (let k = 1; k <= steps; k++) {
      f = botStep(f, inp);
      const r = PLAYER_RADIUS + BOT_MOVER_CLEAR;
      const at = now + k * BOT_DT * 1000;
      if (
        collideBotMovers(f.pos, r, this.movers, at) ||
        this.inCollapseZone(f.pos, PLAYER_RADIUS, at, flight.pos)
      ) {
        return true;
      }
      if (moversOnly) continue;
      if (
        hitsGround(f.pos, PLAYER_RADIUS, gaps) ||
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
    const range = target.boss ? BOT_BOSS_FIRE_RANGE : BOT_FIRE_RANGE;
    if (dist > range || dist === 0) return null;
    const t = leadTime(dist, bot.flight.speed);
    const lx = d.x + target.vel.x * t;
    const ly = d.y + target.vel.y * t;
    const lz = d.z + target.vel.z * t;
    const lead = Math.hypot(lx, ly, lz);
    if (lead === 0) return null;
    const fwd = flightForward(bot.flight);
    const along = (lx * fwd.x + ly * fwd.y + lz * fwd.z) / lead;
    if (along < Math.cos(BOT_FIRE_CONE)) return null;
    // W1: an early wave's trigger discipline lets some lined-up shots go —
    // W4: and half again of them at a pilot in Easy mode (their aim jitter
    // already sits at its clamp, so this is what Easy mode really buys).
    const fire =
      bot.grade.fire *
      (!target.boss && this.skill.isEasy(target.id) ? EASY_FIRE_SCALE : 1);
    if (fire < 1 && bot.fireRand() >= fire) return null;
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
  // The nose rides with the bullet: a boss claim (S4) checks the line.
  return combat.fire(shot.botId, shot.seq, now, shot.dir).ok;
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
