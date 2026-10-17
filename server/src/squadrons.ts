// E1 Air force, server side: the room's SQUADRONS — the cheap tier that
// lets a wave field hundreds of real enemy planes (common/src/squadron.ts is
// the shared arithmetic, server/src/waves.ts the war that launches them).
//
// Every enemy plane is a member of one squadron: an ordinary RoomBots bot
// (roster, Combat, rounds — everything that already knows enemies) whose
// flight its squadron writes every tick (RoomBots.setSquadFlight). A
// squadron is up to SQUAD_SIZE planes on the slots of one virtual ANCHOR,
// which flies a coarse plan low over the roofline grid. Per tick, fly():
//
//  - each squadron re-plans when its plan runs out (a patrol lane, a strike
//    stream at a point near a human, an escort loop round an airship),
//    steps its anchor (stepAnchor: terrain-following, airships avoided),
//    and writes every plane in formation onto its slot — off the anchor
//    pose QUANTISED exactly as the wire carries it, so a client's expanded
//    row is the very pose the server shoots at;
//  - the aces are chosen (chooseAces): the squadron planes nearest the
//    humans PROMOTE to the full brain, up to aceCap(humans); an ace DEMOTES
//    back onto its slot only once it and its slot are past every human's
//    far plane — and never while on a bomb run;
//  - a squadron plane shoots only at a human in its forward cone at short
//    range, in bursts, each burst charged to that human's DangerBudget
//    (layer "squadron"): squadrons add to the danger the director already
//    rations, never past it.
//
// A squadron is LAUNCHED off one rig of one airship: its slot-0 plane is
// the launch the fleet planned, every plane waits dead on the rig, and at
// the release the whole squadron leaves together, fanned out of one point
// over SQUAD_FORM_UP_MS (so nobody sees wingmen appear).

import type { BossLaunch, launchSpawnAt } from "@angels-bandits/common/boss";
import { mulberry32 } from "@angels-bandits/common/city";
import { WORLD_SIZE } from "@angels-bandits/common/constants";
import type { FlightState } from "@angels-bandits/common/flight";
import type { Pose, SpawnState } from "@angels-bandits/common/protocol";
import {
  FORM_BOX,
  FORM_ECHELON,
  FORM_FINGER,
  FORM_REACH,
  FORM_TRAIL,
  FORM_WEDGE,
  PLAN_ESCORT,
  PLAN_LANE,
  PLAN_STREAM,
  PROMOTE_M,
  type RooflineGrid,
  SQUAD_CLEAR,
  SQUAD_CRUISE_CAP,
  SQUAD_FIRE_RANGE,
  SQUAD_FORM_UP_MS,
  SQUAD_PREF_MAX,
  SQUAD_SIZE,
  SQUAD_SPEED_MAX,
  SQUAD_SPEED_MIN,
  type SquadAnchor,
  type SquadObstacle,
  type SquadPlan,
  type SquadRow,
  type SquadStepStats,
  attitudeQuatInto,
  chooseAces,
  decodeSquadRow,
  encodeSquadRow,
  floorAhead,
  planYaw,
  slotPoseInto,
  squadInCone,
  stepAnchor,
} from "@angels-bandits/common/squadron";
import {
  type Vec3,
  wrapCoord,
  wrapDistance,
} from "@angels-bandits/common/world";
import type { BotShot, RoomBots } from "./bots";
import type { Combat } from "./combat";
import type { DangerBudget } from "./danger";

/** A squadron re-plans after this long, ms (a seeded draw in the range). */
const PLAN_MIN_MS = 20_000;
const PLAN_MAX_MS = 45_000;
/** A strike stream counts as arrived this close to its point, m — wider
 * than its turning circle, so it never orbits a point it cannot hit. */
const STREAM_ARRIVE_M = 260;
/** An escort loop's gap outside its airship's reach, m. */
const ESCORT_GAP_M = 70;
/** A squadron's guns: a burst at one human lasts this long, ms… */
const BURST_MS = 900;
/** …and the same squadron starts no other at that human within this. */
const BURST_GAP_MS = 2500;
/** The anchor's steering decision runs every this-many ticks (5 Hz). */
const DECIDE_EVERY = 4;
/** Speed change toward the cruise speed, m/s². */
const SPEED_EASE = 6;

/** A flying human as the squadrons see it. */
export interface SquadHuman {
  id: string;
  pos: Vec3;
}

/** An airship as the squadrons see it this tick: an obstacle and an escort
 * centre. */
export interface SquadShip {
  id: number;
  pos: Vec3;
  /** Plan reach and half-height, m. */
  r: number;
  h: number;
}

interface Squad {
  sid: number;
  /** Slot → its plane's id (null once that plane is gone for good). */
  ids: (string | null)[];
  id0: string;
  form: number;
  anchor: SquadAnchor;
  plan: SquadPlan;
  planUntil: number;
  /** Escort: the airship's id. */
  escort: number | null;
  pref: number;
  cruise: number;
  /** When the formation began to open (release), ms. */
  formedAt: number;
  rand: () => number;
  /** In the air (released, or staged). */
  flying: boolean;
  /** The rig launch that carries it (slot 0's), until released. */
  launch: BossLaunch | null;
  /** This tick's quantised anchor pose and how far open the formation is. */
  anchorPose: Pose;
  spread: number;
  /** Per slot, reused: the flight and pose its plane is given. */
  flights: FlightState[];
  poses: Pose[];
  /** When a burst at each human ends / may start again, ms. */
  burstUntil: Map<string, number>;
  burstNext: Map<string, number>;
}

/** One squadron's row for this tick's snapshot, and where it is. */
export interface SquadWire {
  row: SquadRow;
  pos: Vec3;
  sid: number;
}

const newPose = (): Pose => ({
  pos: { x: 0, y: 0, z: 0 },
  quat: { x: 0, y: 0, z: 0, w: 1 },
  speed: 0,
});

/** Formations by plan: strike streams fly columns or boxes, escorts
 * echelons or fingers, patrols wedges or fingers. */
const FORMS_FOR: readonly (readonly number[])[] = [
  [FORM_WEDGE, FORM_FINGER, FORM_WEDGE],
  [FORM_TRAIL, FORM_BOX],
  [FORM_ECHELON, FORM_FINGER],
];

export class RoomSquadrons {
  private readonly squads = new Map<number, Squad>();
  private readonly memberOf = new Map<string, { sq: Squad; slot: number }>();
  private readonly rand: () => number;
  private nextSid = 1;
  private ticks = 0;
  /** Telemetry: hard-floor lifts (should stay 0), promotions, demotions,
   * bursts started and refused by the budget. */
  readonly stats: SquadStepStats & {
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

  /** Squadrons in the room (any plane up, on a rig or an ace). */
  get count(): number {
    return this.squads.size;
  }

  /** Is `id` a squadron's plane flown by the brain right now? */
  isAce(id: string): boolean {
    return this.memberOf.has(id) && !this.bots.isSquad(id);
  }

  /** The aces in the room right now (ids). */
  aces(): string[] {
    const out: string[] = [];
    for (const id of this.memberOf.keys()) {
      if (this.combat.isAlive(id) && !this.bots.isSquad(id)) out.push(id);
    }
    return out;
  }

  /** The rig launch `id`'s squadron leaves on, while it waits there. */
  launchOf(id: string): { lead: string; launch: BossLaunch } | null {
    const m = this.memberOf.get(id);
    if (!m || m.sq.flying || !m.sq.launch) return null;
    return { lead: m.sq.id0, launch: m.sq.launch };
  }

  /** Has `id`'s squadron left its rig? */
  released(id: string): boolean {
    return this.memberOf.get(id)?.sq.flying ?? false;
  }

  /**
   * A new squadron of `ids` (minted in one run: slot k is ids[k]) waiting
   * on its rig for `launch` — or, without one, `staged` in the air already
   * (AB_AIRFORCE: the bench's instant air force).
   */
  add(
    ids: readonly string[],
    now: number,
    launch: BossLaunch | null,
    staged?: { pos: Vec3; yaw: number },
  ): void {
    const rand = mulberry32(Math.floor(this.rand() * 0xffffffff));
    const kind = (Math.floor(rand() * 3) % 3) as 0 | 1 | 2;
    const forms = FORMS_FOR[kind] as readonly number[];
    const form = forms[Math.floor(rand() * forms.length)] as number;
    const at = staged?.pos ?? { x: 0, y: 0, z: 0 };
    const sq: Squad = {
      sid: this.nextSid++,
      ids: Array.from({ length: SQUAD_SIZE }, (_, k) => ids[k] ?? null),
      id0: ids[0] as string,
      form,
      anchor: {
        pos: { ...at },
        yaw: staged?.yaw ?? 0,
        pitch: 0,
        roll: 0,
        speed: SQUAD_SPEED_MIN,
        steer: staged?.yaw ?? 0,
        steerNeed: 0,
      },
      plan: {
        kind: PLAN_LANE,
        axis: "x",
        cross: at.z,
        dir: 1,
        center: { ...at },
        radius: 0,
      },
      planUntil: 0,
      escort: null,
      pref: rand() * SQUAD_PREF_MAX,
      cruise: SQUAD_SPEED_MIN + rand() * (SQUAD_SPEED_MAX - SQUAD_SPEED_MIN),
      formedAt: staged ? now - SQUAD_FORM_UP_MS : now,
      rand,
      flying: !!staged,
      launch,
      anchorPose: newPose(),
      spread: staged ? 1 : 0,
      flights: [],
      poses: [],
      burstUntil: new Map(),
      burstNext: new Map(),
    };
    for (let k = 0; k < SQUAD_SIZE; k++) {
      sq.flights.push({
        pos: { x: 0, y: 0, z: 0 },
        yaw: 0,
        pitch: 0,
        roll: 0,
        bank: 0,
        rollRate: 0,
        speed: SQUAD_SPEED_MIN,
        targetSpeed: SQUAD_SPEED_MIN,
      });
      sq.poses.push(newPose());
    }
    this.squads.set(sq.sid, sq);
    ids.forEach((id, slot) => this.memberOf.set(id, { sq, slot }));
    if (staged) this.pose(sq, now);
  }

  /** `id`'s squadron leaves its rig at `spawn` (the launch's release pose):
   * its anchor starts there, the formation folded into that point. */
  depart(id: string, spawn: ReturnType<typeof launchSpawnAt>, now: number) {
    const m = this.memberOf.get(id);
    if (!m || m.sq.flying) return;
    const sq = m.sq;
    sq.flying = true;
    sq.launch = null;
    sq.formedAt = now;
    const a = sq.anchor;
    a.pos.x = spawn.pos.x;
    a.pos.y = spawn.pos.y;
    a.pos.z = spawn.pos.z;
    a.yaw = spawn.yaw;
    a.steer = spawn.yaw;
    a.pitch = spawn.pitch;
    a.speed = spawn.speed;
    this.pose(sq, now);
  }

  /** `id` flies: onto its slot (its squadron already departed) — the spawn
   * the room broadcasts for it. */
  join(id: string): SpawnState | null {
    const m = this.memberOf.get(id);
    if (!m || !m.sq.flying) return null;
    const { sq, slot } = m;
    const f = sq.flights[slot] as FlightState;
    this.bots.setSquadFlight(id, f, sq.poses[slot] as Pose);
    return { pos: { ...f.pos }, yaw: f.yaw, speed: f.speed };
  }

  /** Is a launch released at `pos` heading `yaw` clear for a squadron — over
   * the roofline the anchor follows, along its first stretch? */
  departClear(pos: Vec3, yaw: number): boolean {
    return floorAhead(this.grid, pos, yaw) <= pos.y;
  }

  /** `id` is gone for good: off its slot; an emptied squadron is dropped. */
  forget(id: string): void {
    const m = this.memberOf.get(id);
    if (!m) return;
    this.memberOf.delete(id);
    m.sq.ids[m.slot] = null;
    if (m.sq.ids.every((x) => x === null)) this.squads.delete(m.sq.sid);
  }

  /** Everything gone (the war off, the room empty). */
  reset(): void {
    this.squads.clear();
    this.memberOf.clear();
  }

  /** Promote `id` now whatever the distances (a bomb run's pilot); false
   * when it is not a squadron plane in formation. */
  promote(id: string): boolean {
    if (!this.memberOf.has(id) || !this.bots.isSquad(id)) return false;
    if (!this.combat.isAlive(id)) return false;
    this.bots.promote(id);
    this.stats.promotions++;
    return true;
  }

  /**
   * One tick of every squadron in the air: plans, anchors, slots; then the
   * aces; then the guns. `locked`: aces that may not demote (on a bomb
   * run). `cap`: the aces the squadrons may field. `fire`: the chance a squadron's lined-up burst is taken (its
   * wave's grade). Returns this tick's trigger pulls, for the room's bot
   * fire path.
   */
  fly(
    now: number,
    dt: number,
    humans: readonly SquadHuman[],
    ships: readonly SquadShip[],
    locked: (id: string) => boolean,
    cap: number,
    fire: number,
    budget?: DangerBudget,
  ): BotShot[] {
    this.ticks++;
    const obstacles: readonly SquadObstacle[] = ships;
    for (const sq of this.squads.values()) {
      if (!sq.flying) continue;
      if (now >= sq.planUntil || this.arrived(sq)) {
        this.replan(sq, now, humans, ships);
      }
      if (sq.plan.kind === PLAN_ESCORT) {
        const ship = ships.find((s) => s.id === sq.escort);
        if (ship) sq.plan.center = ship.pos;
        else sq.planUntil = now; // its airship went down: re-plan next tick
      }
      const a = sq.anchor;
      a.speed += Math.max(
        -SPEED_EASE * dt,
        Math.min(SPEED_EASE * dt, sq.cruise - a.speed),
      );
      stepAnchor(
        a,
        planYaw(sq.plan, a.pos),
        sq.pref,
        this.grid,
        obstacles,
        dt,
        (this.ticks + sq.sid) % DECIDE_EVERY === 0,
        this.stats,
      );
      this.pose(sq, now);
    }
    this.promoteAndDemote(humans, locked, cap);
    return this.guns(now, humans, fire, budget);
  }

  /** This tick's rows: every squadron with a plane in formation. */
  wire(now: number): SquadWire[] {
    const out: SquadWire[] = [];
    for (const sq of this.squads.values()) {
      if (!sq.flying) continue;
      let mask = 0;
      const hp: number[] = [];
      let prot = false;
      for (let k = 0; k < SQUAD_SIZE; k++) {
        const id = sq.ids[k];
        if (!id || !this.combat.isAlive(id) || !this.bots.isSquad(id)) {
          continue;
        }
        mask |= 1 << k;
        hp.push(this.combat.hpOf(id));
        if (this.combat.isProtected(id, now)) prot = true;
      }
      if (mask === 0) continue;
      out.push({
        sid: sq.sid,
        pos: sq.anchorPose.pos,
        row: {
          id0: sq.id0,
          anchor: sq.anchorPose,
          form: sq.form,
          spread: sq.spread,
          prot,
          mask,
          hp,
        },
      });
    }
    return out;
  }

  /** Has `sq` reached what its plan was flying to? */
  private arrived(sq: Squad): boolean {
    if (sq.plan.kind !== PLAN_STREAM) return false;
    return wrapDistance(sq.anchor.pos, sq.plan.center) < STREAM_ARRIVE_M;
  }

  /** A fresh plan for `sq` (seeded): a strike stream at a point near a
   * human, an escort loop round the nearest airship, or a patrol lane
   * along the nose's nearest axis. */
  private replan(
    sq: Squad,
    now: number,
    humans: readonly SquadHuman[],
    ships: readonly SquadShip[],
  ): void {
    const r = sq.rand();
    const a = sq.anchor;
    const plan = sq.plan;
    sq.planUntil = now + PLAN_MIN_MS + sq.rand() * (PLAN_MAX_MS - PLAN_MIN_MS);
    sq.escort = null;
    if (r < 0.25 && ships.length > 0) {
      let best = ships[0] as SquadShip;
      for (const s of ships) {
        if (wrapDistance(s.pos, a.pos) < wrapDistance(best.pos, a.pos)) {
          best = s;
        }
      }
      plan.kind = PLAN_ESCORT;
      plan.center = best.pos;
      plan.radius = best.r + FORM_REACH + ESCORT_GAP_M;
      plan.dir = sq.rand() < 0.5 ? 1 : -1;
      sq.escort = best.id;
      return;
    }
    if (r < 0.6) {
      const h =
        humans.length > 0 && sq.rand() < 0.7
          ? (humans[Math.floor(sq.rand() * humans.length)] as SquadHuman)
          : null;
      // A point it can reach under its cruise cap (never a supertall's
      // roof, which it would only circle).
      for (let tries = 0; tries < 8; tries++) {
        const ang = sq.rand() * Math.PI * 2;
        const off = h ? 150 + sq.rand() * 250 : 0;
        const base = h?.pos ?? {
          x: sq.rand() * WORLD_SIZE,
          y: 0,
          z: sq.rand() * WORLD_SIZE,
        };
        const x = wrapCoord(base.x + Math.cos(ang) * off);
        const z = wrapCoord(base.z + Math.sin(ang) * off);
        if (this.grid.ahead(x, z) + SQUAD_CLEAR > SQUAD_CRUISE_CAP) continue;
        plan.kind = PLAN_STREAM;
        plan.center = { x, y: 0, z };
        return;
      }
    }
    // A lane along the world axis nearest the nose (no U-turn), through
    // where the squadron is now.
    const fx = -Math.sin(a.yaw);
    const fz = -Math.cos(a.yaw);
    plan.kind = PLAN_LANE;
    if (Math.abs(fx) > Math.abs(fz)) {
      plan.axis = "x";
      plan.dir = fx > 0 ? 1 : -1;
      plan.cross = a.pos.z;
    } else {
      plan.axis = "z";
      plan.dir = fz > 0 ? 1 : -1;
      plan.cross = a.pos.x;
    }
  }

  /** The anchor's quantised pose, the spread, and every slot's flight and
   * pose (the planes in formation are given theirs). */
  private pose(sq: Squad, now: number): void {
    const a = sq.anchor;
    const ap = sq.anchorPose;
    ap.pos.x = a.pos.x;
    ap.pos.y = a.pos.y;
    ap.pos.z = a.pos.z;
    attitudeQuatInto(a.yaw, a.pitch, a.roll, ap.quat);
    ap.speed = a.speed;
    sq.spread = Math.min(
      1,
      Math.max(0, (now - sq.formedAt) / SQUAD_FORM_UP_MS),
    );
    // Through the wire's quantisation: what every client will derive.
    const q = decodeSquadRow(
      encodeSquadRow({
        id0: sq.id0,
        anchor: ap,
        form: sq.form,
        spread: sq.spread,
        prot: false,
        mask: 0,
        hp: [],
      }),
    );
    ap.pos = q.anchor.pos;
    ap.quat = q.anchor.quat;
    ap.speed = q.anchor.speed;
    sq.spread = q.spread;
    for (let k = 0; k < SQUAD_SIZE; k++) {
      const pose = sq.poses[k] as Pose;
      slotPoseInto(ap, sq.form, k, sq.spread, pose);
      const f = sq.flights[k] as FlightState;
      f.pos.x = pose.pos.x;
      f.pos.y = pose.pos.y;
      f.pos.z = pose.pos.z;
      f.yaw = a.yaw;
      f.pitch = a.pitch;
      f.roll = a.roll;
      f.bank = a.roll;
      f.speed = a.speed;
      f.targetSpeed = a.speed;
      const id = sq.ids[k];
      if (id && this.combat.isAlive(id) && this.bots.isSquad(id)) {
        this.bots.setSquadFlight(id, f, pose);
      }
    }
  }

  /** chooseAces over every plane in the air, then the hand-overs. */
  private promoteAndDemote(
    humans: readonly SquadHuman[],
    locked: (id: string) => boolean,
    cap: number,
  ): void {
    if (humans.length === 0 && this.aces().length === 0) return;
    const cands: {
      id: string;
      dist: number;
      slotDist: number;
      ace: boolean;
      locked: boolean;
    }[] = [];
    for (const sq of this.squads.values()) {
      if (!sq.flying) continue;
      const anchorDist = nearest(sq.anchorPose.pos, humans);
      for (let k = 0; k < SQUAD_SIZE; k++) {
        const id = sq.ids[k];
        if (!id || !this.combat.isAlive(id)) continue;
        const squad = this.bots.isSquad(id);
        // A whole squadron far out of reach is no candidate (cheap reject).
        if (squad && anchorDist - FORM_REACH > PROMOTE_M) continue;
        const slotDist = nearest((sq.poses[k] as Pose).pos, humans);
        const pos = squad ? null : this.bots.contactOf(id)?.pos;
        cands.push({
          id,
          dist: pos ? nearest(pos, humans) : slotDist,
          slotDist,
          ace: !squad,
          locked: !squad && locked(id),
        });
      }
    }
    const { promote, demote } = chooseAces(cands, cap);
    for (const id of demote) {
      const m = this.memberOf.get(id);
      if (!m) continue;
      this.bots.setSquadFlight(
        id,
        m.sq.flights[m.slot] as FlightState,
        m.sq.poses[m.slot] as Pose,
      );
      this.stats.demotions++;
    }
    for (const id of promote) {
      this.bots.promote(id);
      this.stats.promotions++;
    }
  }

  /** The squadrons' trigger pulls this tick. */
  private guns(
    now: number,
    humans: readonly SquadHuman[],
    fire: number,
    budget?: DangerBudget,
  ): BotShot[] {
    const shots: BotShot[] = [];
    if (humans.length === 0) return shots;
    for (const sq of this.squads.values()) {
      if (!sq.flying || sq.spread < 1) continue;
      const fwd = forwardOf(sq.anchor);
      for (const h of humans) {
        if (
          wrapDistance(sq.anchorPose.pos, h.pos) >
          SQUAD_FIRE_RANGE + FORM_REACH
        ) {
          continue;
        }
        const lined: string[] = [];
        for (let k = 0; k < SQUAD_SIZE; k++) {
          const id = sq.ids[k];
          if (!id || !this.combat.isAlive(id) || !this.bots.isSquad(id)) {
            continue;
          }
          if (squadInCone((sq.poses[k] as Pose).pos, fwd, h.pos))
            lined.push(id);
        }
        if (lined.length === 0) continue;
        if (now >= (sq.burstUntil.get(h.id) ?? 0)) {
          // A new burst: the gap, the grade's trigger discipline, and the
          // human's danger budget.
          if (now < (sq.burstNext.get(h.id) ?? 0)) continue;
          sq.burstNext.set(h.id, now + BURST_GAP_MS);
          if (sq.rand() >= fire) continue;
          if (budget && !budget.allowsIds("squadron", [h.id], now, [h])) {
            this.stats.burstsRefused++;
            continue;
          }
          budget?.chargeIds("squadron", [h.id], now);
          sq.burstUntil.set(h.id, now + BURST_MS);
          this.stats.bursts++;
        }
        for (const id of lined) {
          const shot = this.bots.squadShot(id, h.id);
          if (shot) shots.push(shot);
        }
      }
    }
    return shots;
  }
}

/** The nearest human to `p`, m (∞ with none). */
function nearest(p: Vec3, humans: readonly SquadHuman[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (const h of humans) {
    const d = wrapDistance(p, h.pos);
    if (d < best) best = d;
  }
  return best;
}

function forwardOf(a: SquadAnchor): Vec3 {
  const cp = Math.cos(a.pitch);
  return {
    x: -Math.sin(a.yaw) * cp,
    y: Math.sin(a.pitch),
    z: -Math.cos(a.yaw) * cp,
  };
}
