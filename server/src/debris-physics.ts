// DS1 progressive collapse with physics — one room's Rapier world of falling
// debris, in the GameHost (so in the player's sim worker; the Node shell
// never builds one: `?mp=1` keeps D3's closed-form collapses).
//
// A collapse is still PLANNED as it always was (the structural planner of a
// physics room picks which bays fall, pancake or lean, where it failed), and
// its debris is still BUILT from the wire (collapse.ts buildCollapse: storey
// slabs, facade sheets, columns). What changes is how those pieces move:
// they become rigid bodies here, and a hierarchy of pre-fractured groups
// breaks down as the collapse goes —
//
//   SECTION (everything that let go, one compound body)
//     → BANDS (a floor band each) → BAYS (a chunk each) → PIECES.
//
//   - PANCAKE: the block above the failed floor and the failed floor itself
//     let go together; every floor under them is HELD (fixed) by its columns
//     until something strikes it harder than its columns carry (a multiple
//     of the static load on it) — so floors give one after another as the
//     block drives down, floor by floor. A facade sheet peels off its floor
//     as the floor lets go.
//   - LEAN (a topple): the section hinges on the line of its last standing
//     columns (city/structure.ts hingeLine), a revolute joint at the failed
//     floor; past the tilt it can bend no further the hinge snaps and the
//     section breaks into its floors.
//   - Anything that strikes something faster than the fracture threshold
//     breaks into its next level; a piece that has lain still freezes into
//     static rubble (a fixed body the next collapse piles onto).
//   - Strikes on OTHER buildings become chain impacts (the room lands them as
//     D5 blasts, so C1's dominoes now come from real contacts).
//   - Budget: at most `budget` moving bodies (the quality tier's, × the lab's
//     physBudget): a fracture that would pass it breaks coarser, or not at
//     all; a collapse that would start past it, or far from the camera
//     (PHYS_LOD_M), stays analytic.
//
// Every host tick the world steps to the host clock in fixed 1/20 s steps —
// one a tick (tools/physics-bench.ts: a Rapier step over 400 moving slabs
// is ~3 ms, so finer steps would put the tick over its budget; pieces are
// metres thick and the falls short, so a 50 ms step tunnels nothing that
// shows) — and writes one frame (city/physpose.ts): the room's own registry ingests
// it (the bots collide with exactly that) and the worker transfers the same
// Float32Array to the page. When a collapse has settled its final frame
// carries REC_SETTLED, and its rubble heap follows.

import {
  type Building,
  chunkCell,
  chunkTier,
  solids,
  tierGrids,
} from "@angels-bandits/common/city";
import {
  type Collapse,
  type CollapseImpact,
  DIR_NEG_X,
  DIR_NEG_Z,
  DIR_POS_X,
  DIR_POS_Z,
  KIND_BUILDING,
  PANCAKE,
  ROLE_SHEET,
  ROLE_SLAB,
  impactScale,
  standingOf,
} from "@angels-bandits/common/city/collapse";
import {
  PIECE_FROZEN,
  PIECE_HELD,
  PIECE_MOVING,
  PIECE_STRIDE,
  PhysRegistry,
  RECORD_HEAD,
  REC_SETTLED,
  type RubbleHeap,
  heapRecord,
} from "@angels-bandits/common/city/physpose";
import {
  MATERIAL_DENSITY,
  hingeLine,
} from "@angels-bandits/common/city/structure";
import { CHAIN_COALESCE_M, WORLD_SIZE } from "@angels-bandits/common/constants";
import type { DestructionTuning } from "@angels-bandits/common/destruction-tuning";
import { canonicalize, wrapDeltaAxis } from "@angels-bandits/common/world";
import type {
  PhysicsFrame,
  PhysicsHost,
  PhysicsImpact,
  PhysicsRoom,
  PhysicsView,
} from "./physics-port";

export type { PhysicsFrame, PhysicsImpact, PhysicsRoom, PhysicsView };
import RAPIER from "@dimforge/rapier3d-compat";

let ready = false;

/** Load Rapier's WASM (once; the sim worker awaits it before its host). */
export async function initDebrisPhysics(): Promise<void> {
  if (ready) return;
  await RAPIER.init();
  ready = true;
}

/** Has initDebrisPhysics() finished? */
export const debrisPhysicsReady = (): boolean => ready;

/** Moving bodies each quality tier allows (client/src/render/quality.ts
 * tiers). */
export const PHYS_BUDGET = {
  high: 400,
  medium: 250,
  low: 150,
  mobile: 80,
} as const;
export type PhysTier = keyof typeof PHYS_BUDGET;

/** A collapse further than this from the camera stays analytic, m (it is
 * in the fog, and its rubble is the closed form's). */
export const PHYS_LOD_M = 650;
/** The fixed step, s — one per 20 Hz host tick — and the most steps one
 * tick may take (behind by more, the world skips ahead: debris slows, the
 * tick never spirals). */
export const PHYS_STEP_S = 1 / 20;
const MAX_STEPS = 8;
/** The worker's step budget, ms, p99 — what the governor holds it to. */
export const PHYS_STEP_BUDGET_MS = 4;
/** The governor: the window it judges, ticks; the share the budget shrinks
 * to over it; the share of the step budget under which it grows again, and
 * by how many bodies a tick; its floor; and how slow a body must be for it
 * to freeze one early, m/s. */
const GOVERN_WINDOW = 10;
const GOVERN_SHRINK = 0.92;
const GOVERN_EASE = 0.6;
const GOVERN_GROW = 4;
const GOVERN_MIN = 24;
const GOVERN_STILL_V = 1.5;
/** New bodies a tick's break-ups may make, at most; a crack that finds the
 * tick's share spent waits for the next. */
const SPAWN_MAX = 48;
/** A held floor lets go when a strike on it passes this many times the
 * weight it carries. */
const HOLD_FACTOR = 3;
/** A held floor that nothing struck lets go this long after the closed
 * form's crush front would have reached it, s. */
const HOLD_SLACK_S = 1.5;
/** The share of a strike's momentum that breaking a floor's columns
 * takes. */
const CRUSH_LOSS = 0.12;
/** A floor struck harder than this (as a speed lost in a step, m/s) is
 * crushed flat. */
const CRUSH_SPEED = 3;
/** A shock's memory: the share left after a tick. */
const SHOCK_DECAY = 0.5;
/** Strikes slower than this never become chain impacts, m/s. */
const IMPACT_SPEED_MIN = 4;
/** A piece lying this still (m/s, rad/s) for FREEZE_S freezes into rubble;
 * nothing moves longer than FREEZE_MAX_S. */
const FREEZE_V = 0.3;
const FREEZE_W = 0.2;
const FREEZE_S = 1.2;
const FREEZE_MAX_S = 30;
/** Colliders sit this far inside the drawn box (touching faces never start
 * in contact), m. */
const SKIN = 0.04;
/** A leaning section that has not turned on for this long, s, has stalled
 * on what stands under its falling side. */
const LEAN_STALL_S = 0.4;
/** …its tilt gaining under this, rad; it bears down at most this often
 * without progress before its hinge tears. */
const LEAN_PROGRESS = 0.012;
/** A hinge torn under this tilt, rad, never turned: its section breaks
 * into bays rather than floors. */
const LEAN_TORN_TILT = 0.6;
const LEAN_BEARS = 3;
/** What a bearing-down drives through the floors under it with, m/s, and
 * the spacing of its impacts along the edge, m (one a bay). */
const BEAR_SPEED = 20;
const BEAR_SPACING = 18;
const BEAR_POINTS = 6;
/** A leaning section is kicked over this fast, rad/s (it never balances on
 * its hinge). */
const LEAN_KICK = 0.06;
/** Settled pieces under this volume merge into the heap, m³. */
const MERGE_M3 = 6;
/** The heap: grid cell, m; the share of the collapse's volume that is fine
 * rubble; its highest point, m (always flyable over). */
const HEAP_CELL = 1.5;
const HEAP_SHARE = 0.05;
const HEAP_MAX_M = 6;
/** The heap's grid at most this many cells a side (240 m at 1.5 m), and
 * how far a vertex is knocked up or down, m. */
const HEAP_CELLS_MAX = 160;
const HEAP_KNOCK_M = 0.9;

const HELD = 0;
const FREE = 1;
const FROZEN = 2;
/** Breaking up: still in the world for its children to start from, no
 * longer counted against the budget. */
const SPLITTING = 3;

const LEVEL_SECTION = 0;
const LEVEL_BAND = 1;
const LEVEL_BAY = 2;
const LEVEL_PIECE = 3;

/** One rigid body and the pieces it carries. */
interface Group {
  pc: PhysCollapse;
  body: RAPIER.RigidBody;
  colliders: number[];
  pieces: number[];
  /** Per piece: its centre in the body's frame. */
  local: Float64Array;
  level: number;
  state: number;
  mass: number;
  /** HELD: lets go at this host ms at the latest, and above this force. */
  releaseAt: number;
  capacity: number;
  /** FREE: host ms it started moving; seconds it has lain still. */
  freeSince: number;
  still: number;
  /** LEAN: the hinge, its anchor and the tilt it snaps at, rad. */
  joint: RAPIER.ImpulseJoint | null;
  anchor: RAPIER.RigidBody | null;
  snapAt: number;
  /** A strike this step asked it to break (`deep`: into its bays). */
  crack: boolean;
  /** The speed it has lost to strikes lately, m/s (decaying), and whether
   * it was struck through a floor this step (moved on, no shock). */
  shock: number;
  through: boolean;
  deep: boolean;
  /** LEAN: how long its tilt has not grown past `stallTilt`, s, and how
   * many times it has borne down since it last made progress. */
  stall: number;
  stallTilt: number;
  bears: number;
  /** Its velocity at the start of this tick (its shock is judged on it). */
  tx: number;
  ty: number;
  tz: number;
  /** Its velocity before this step (a strike is judged on it). */
  vx: number;
  vy: number;
  vz: number;
  /** This step: the force on it, summed over its contacts — from moving
   * debris on a held floor, from anything but a held floor on moving
   * debris — and what struck a held floor. */
  load: number;
  hit: number;
  strikers: Group[] | null;
}

/** One collapse in the world. */
interface PhysCollapse {
  c: Collapse;
  depth: number;
  groups: Group[];
  /** Per piece: the group carrying it (null once merged away). */
  of: (Group | null)[];
  /** Merged into the heap (hidden). */
  merged: Uint8Array;
  /** Per piece: the share of its height it keeps (crushed slabs < 1). */
  squash: Float32Array;
  settled: boolean;
  sentFinal: boolean;
  heap: RubbleHeap | null;
  /** Its heap in the world (a fixed heightfield), once settled. */
  heapBody: RAPIER.RigidBody | null;
  /** Chain impacts landed, per building and in all. */
  hits: Map<number, { x: number; y: number; z: number }[]>;
  hitCount: number;
}

/** A neighbour's (or the collapse's own building's) solids as fixed
 * colliders, at the torus image the debris meets it at. */
interface StaticBuilding {
  index: number;
  ox: number;
  oz: number;
  version: number;
  body: RAPIER.RigidBody;
  colliders: number[];
}

let epochs = 0;

/**
 * One room's debris world. `add` takes a collapse (or declines: the caller
 * keeps it analytic), `step` advances it to the host clock, `takeImpacts`
 * drains the chain impacts it found and `takeFrame` the frame to send.
 */
export class DebrisPhysics implements PhysicsHost {
  readonly registry = new PhysRegistry();
  private world: RAPIER.World;
  private queue: RAPIER.EventQueue;
  private readonly room: PhysicsRoom;
  private collapses: PhysCollapse[] = [];
  private byCollider = new Map<number, Group>();
  /** Each debris collider's mass (its share of its group's). */
  private colliderMass = new Map<number, number>();
  private buildingOf = new Map<number, number>();
  private statics = new Map<number, StaticBuilding>();
  private impacts: PhysicsImpact[] = [];
  private pendingHeaps: number[] = [];
  private time = Number.NaN;
  private epoch = ++epochs;
  private view: PhysicsView | null = null;
  /** Moving bodies now, and the most there ever were. */
  active = 0;
  peakActive = 0;
  /** The last step's cost, ms (benches, the lab's telemetry). */
  lastStepMs = 0;
  /** The governed budget (≤ the tier's), and the last steps' costs. */
  private governed = Number.POSITIVE_INFINITY;
  private readonly costs = new Float64Array(GOVERN_WINDOW);
  private costAt = 0;
  /** Bodies made by break-ups this tick (SPAWN_MAX). */
  private spawned = 0;

  constructor(room: PhysicsRoom, view?: PhysicsView) {
    if (!ready) throw new Error("debris physics used before init");
    this.room = room;
    this.view = view ?? null;
    this.world = this.makeWorld();
    this.queue = new RAPIER.EventQueue(true);
  }

  private makeWorld(): RAPIER.World {
    const w = new RAPIER.World({ x: 0, y: -this.room.tuning.gravity, z: 0 });
    w.timestep = PHYS_STEP_S;
    // The ground: one slab under the whole torus (and its seam's margin).
    const ground = w.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    w.createCollider(
      RAPIER.ColliderDesc.cuboid(WORLD_SIZE, 5, WORLD_SIZE)
        .setTranslation(WORLD_SIZE / 2, -5, WORLD_SIZE / 2)
        .setFriction(this.room.tuning.physFriction),
      ground,
    );
    return w;
  }

  /** The camera and its tier's body budget. */
  setView(view: PhysicsView): void {
    this.view = view;
  }

  /** The moving-body budget now. */
  get budget(): number {
    return Math.min(
      this.maxBudget,
      Math.max(GOVERN_MIN, Math.floor(this.governed)),
    );
  }

  /** The tier's budget (× the lab's physBudget): the most it ever allows. */
  get maxBudget(): number {
    const base = this.view?.budget ?? PHYS_BUDGET.high;
    return Math.max(1, Math.round(base * this.room.tuning.physBudget));
  }

  /**
   * The governor: the step's cost over the last GOVERN_WINDOW ticks against
   * PHYS_STEP_BUDGET_MS. Over it, the budget shrinks (and the slowest,
   * nearly still bodies freeze to get under it); well under it, it grows
   * back toward the tier's. So a fast machine runs the tier's full budget
   * and a slow or busy one keeps the worker inside its step budget.
   */
  private govern(ms: number): void {
    this.costs[this.costAt] = ms;
    this.costAt = (this.costAt + 1) % GOVERN_WINDOW;
    // The window's second-worst tick: one stray spike is not a trend.
    let first = 0;
    let worst = 0;
    for (let k = 0; k < GOVERN_WINDOW; k++) {
      const c = this.costs[k] as number;
      if (c > first) {
        worst = first;
        first = c;
      } else if (c > worst) worst = c;
    }
    const max = this.maxBudget;
    if (worst > PHYS_STEP_BUDGET_MS && this.active > GOVERN_MIN) {
      this.governed = Math.max(
        GOVERN_MIN,
        Math.min(this.governed, this.active) * GOVERN_SHRINK,
      );
      this.costs.fill(0);
    } else if (worst < PHYS_STEP_BUDGET_MS * GOVERN_EASE) {
      this.governed = Math.min(max, this.governed + GOVERN_GROW);
    }
    if (this.governed > max) this.governed = max;
    // Over the budget now: the slowest bodies that are all but still go.
    let over = this.active - this.budget;
    if (over <= 0) return;
    const still: Group[] = [];
    for (const pc of this.collapses) {
      if (pc.settled) continue;
      for (const g of pc.groups) {
        if (g.state !== FREE || g.joint) continue;
        const v = g.body.linvel();
        if (v.x * v.x + v.y * v.y + v.z * v.z < GOVERN_STILL_V * GOVERN_STILL_V)
          still.push(g);
      }
    }
    still.sort((a, b) => a.still - b.still).reverse();
    for (const g of still) {
      if (over-- <= 0) break;
      this.freeze(g);
    }
  }

  /** Collapses still moving (not settled). */
  get moving(): number {
    let n = 0;
    for (const pc of this.collapses) if (!pc.settled) n++;
    return n;
  }

  /** Bodies in the world (moving, held and frozen). */
  get bodies(): number {
    return this.world.bodies.len();
  }

  /** Everything gone: a room reset (a new epoch — the page drops its poses). */
  reset(): void {
    this.world.free();
    this.queue.free();
    this.world = this.makeWorld();
    this.queue = new RAPIER.EventQueue(true);
    this.collapses = [];
    this.byCollider.clear();
    this.colliderMass.clear();
    this.buildingOf.clear();
    this.statics.clear();
    this.impacts = [];
    this.pendingHeaps = [];
    this.active = 0;
    this.governed = Number.POSITIVE_INFINITY;
    this.costs.fill(0);
    this.epoch = ++epochs;
    this.registry.clear();
  }

  /** Free the WASM memory (the room is gone). */
  dispose(): void {
    this.world.free();
    this.queue.free();
  }

  /**
   * Simulate collapse `c` (a link `depth` down a chain)? False — and the
   * caller keeps it analytic — for a crane, a collapse far from the camera,
   * or one that would start past the moving-body budget.
   */
  add(c: Collapse, depth: number): boolean {
    if (c.kind !== KIND_BUILDING) return false;
    const b = this.room.buildings[c.building];
    if (!b) return false;
    if (this.view) {
      const dx = wrapDeltaAxis(this.view.x, c.x);
      const dz = wrapDeltaAxis(this.view.z, c.z);
      if (dx * dx + dz * dz > PHYS_LOD_M * PHYS_LOD_M) return false;
    }
    if (this.active + 2 > this.budget) return false;
    if (Number.isNaN(this.time)) this.time = c.t0;
    const pc: PhysCollapse = {
      c,
      depth,
      groups: [],
      of: new Array<Group | null>(c.n).fill(null),
      merged: new Uint8Array(c.n),
      squash: new Float32Array(c.n).fill(1),
      settled: false,
      sentFinal: false,
      heap: null,
      heapBody: null,
      hits: new Map(),
      hitCount: 0,
    };
    this.collapses.push(pc);
    this.ensureStatics(c);
    const all: number[] = [];
    for (let i = 0; i < c.n; i++) all.push(i);
    const startOf = (pieces: readonly number[]) => {
      let s = Number.POSITIVE_INFINITY;
      for (const i of pieces) s = Math.min(s, c.start[i] as number);
      return c.t0 + s * 1000;
    };
    if (c.style === PANCAKE) {
      // The block above the failed floor, and that floor, let go together;
      // every floor under them is held by its columns.
      const fail = c.fail;
      const block: number[] = [];
      const bands = new Map<number, number[]>();
      for (const i of all) {
        const bottom = (c.oy[i] as number) - (c.hy[i] as number);
        if (bottom >= fail - 0.05) {
          block.push(i);
          continue;
        }
        const key = this.bandOf(b, c, i);
        const list = bands.get(key);
        if (list) list.push(i);
        else bands.set(key, [i]);
      }
      const keys = [...bands.keys()].sort((x, y) => y - x);
      // Mass above each band, top down: what its columns carry.
      let above = this.massOf(c, block);
      const go = startOf(block.length > 0 ? block : all);
      let first = true;
      for (const key of keys) {
        const list = bands.get(key) as number[];
        const top = Math.max(
          ...list.map((i) => (c.oy[i] as number) + (c.hy[i] as number)),
        );
        // The floor that gave: right under the block (or the top floor).
        const failed = first && (block.length === 0 || top >= fail - 0.6);
        first = false;
        const g = this.makeGroup(pc, list, LEVEL_BAND, !failed, null);
        g.releaseAt = failed ? go : startOf(list) + HOLD_SLACK_S * 1000 + 400;
        g.capacity =
          HOLD_FACTOR * this.room.tuning.gravity * Math.max(above, g.mass);
        above += g.mass;
      }
      if (block.length > 0) {
        const g = this.makeGroup(pc, block, LEVEL_SECTION, true, null);
        g.releaseAt = go;
      }
    } else {
      // A lean: the whole section on a hinge at its failed floor.
      const g = this.makeGroup(pc, all, LEVEL_SECTION, true, null);
      g.releaseAt = startOf(all);
      this.hinge(g, b);
    }
    return true;
  }

  /** Forget collapse `id` (a rebuild took its building back). */
  remove(id: number): void {
    const k = this.collapses.findIndex((pc) => pc.c.id === id);
    if (k < 0) return;
    const pc = this.collapses[k] as PhysCollapse;
    for (const g of [...pc.groups]) this.destroy(g);
    if (pc.heapBody) this.world.removeRigidBody(pc.heapBody);
    this.collapses.splice(k, 1);
    this.registry.drop(pc.c.id, pc.c.building);
  }

  /** The floor band key (tier · 4096 + iy) of piece `i`. */
  private bandOf(b: Building, c: Collapse, i: number): number {
    const tier = chunkTier(c.chunk[i] as number);
    const g = tierGrids(b)[tier];
    if (!g) return 0;
    const iy = Math.floor(chunkCell(c.chunk[i] as number) / (g.nx * g.nz));
    return tier * 4096 + iy;
  }

  private massOf(c: Collapse, pieces: readonly number[]): number {
    let m = 0;
    for (const i of pieces) m += this.pieceMass(c, i);
    return m;
  }

  private pieceMass(c: Collapse, i: number): number {
    const vol =
      8 * (c.hx[i] as number) * (c.hy[i] as number) * (c.hz[i] as number);
    return (
      vol *
      (MATERIAL_DENSITY[c.mat[i] as number] ?? 300) *
      this.room.tuning.physMass
    );
  }

  /**
   * A body for `pieces` of `pc`, posed where they are now: at their
   * standing places (`from` null) or riding `from` (a group breaking up —
   * same rotation, its velocity at their place). One collider per bay
   * above the bay level (a bay's pieces tile its solid), per piece below.
   */
  private makeGroup(
    pc: PhysCollapse,
    pieces: readonly number[],
    level: number,
    held: boolean,
    from: Group | null,
  ): Group {
    const c = pc.c;
    // Each piece's centre in world space now.
    const wx = new Float64Array(pieces.length);
    const wy = new Float64Array(pieces.length);
    const wz = new Float64Array(pieces.length);
    let rot = { x: 0, y: 0, z: 0, w: 1 };
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (let k = 0; k < pieces.length; k++) {
      const i = pieces[k] as number;
      if (from) {
        const p = this.pieceWorld(from, i);
        wx[k] = p.x;
        wy[k] = p.y;
        wz[k] = p.z;
      } else {
        wx[k] = c.x + (c.ox[i] as number);
        wy[k] = c.oy[i] as number;
        wz[k] = c.z + (c.oz[i] as number);
      }
      cx += wx[k] as number;
      cy += wy[k] as number;
      cz += wz[k] as number;
    }
    cx /= pieces.length;
    cy /= pieces.length;
    cz /= pieces.length;
    if (from) rot = from.body.rotation();
    const desc = held
      ? RAPIER.RigidBodyDesc.fixed()
      : RAPIER.RigidBodyDesc.dynamic();
    desc.setTranslation(cx, cy, cz).setRotation(rot);
    if (from && !held) {
      const v = from.body.linvel();
      const w = from.body.angvel();
      const o = from.body.translation();
      const rx = cx - o.x;
      const ry = cy - o.y;
      const rz = cz - o.z;
      desc.setLinvel(
        v.x + (w.y * rz - w.z * ry),
        v.y + (w.z * rx - w.x * rz),
        v.z + (w.x * ry - w.y * rx),
      );
      desc.setAngvel(w);
    }
    const body = this.world.createRigidBody(desc);
    // Local centres: R⁻¹ (world − origin).
    const local = new Float64Array(pieces.length * 3);
    const inv = { x: -rot.x, y: -rot.y, z: -rot.z, w: rot.w };
    for (let k = 0; k < pieces.length; k++) {
      const l = rotateBy(
        inv,
        (wx[k] as number) - cx,
        (wy[k] as number) - cy,
        (wz[k] as number) - cz,
      );
      local[k * 3] = l.x;
      local[k * 3 + 1] = l.y;
      local[k * 3 + 2] = l.z;
    }
    const g: Group = {
      pc,
      body,
      colliders: [],
      pieces: [...pieces],
      local,
      level,
      state: held ? HELD : FREE,
      mass: 0,
      releaseAt: Number.POSITIVE_INFINITY,
      capacity: Number.POSITIVE_INFINITY,
      freeSince: this.time,
      still: 0,
      joint: null,
      anchor: null,
      snapAt: Number.POSITIVE_INFINITY,
      crack: false,
      shock: 0,
      through: false,
      deep: false,
      stall: 0,
      stallTilt: 0,
      bears: 0,
      tx: 0,
      ty: 0,
      tz: 0,
      vx: 0,
      vy: 0,
      vz: 0,
      load: 0,
      hit: 0,
      strikers: null,
    };
    this.collide(g);
    this.setThresholds(g);
    // It starts at its parent's speed: no shock from being born.
    const v0 = body.linvel();
    g.tx = v0.x;
    g.ty = v0.y;
    g.tz = v0.z;
    for (const i of pieces) pc.of[i] = g;
    pc.groups.push(g);
    if (!held) this.active++;
    this.peakActive = Math.max(this.peakActive, this.active);
    return g;
  }

  /** (Re)build `g`'s colliders from its pieces as they are (squashed
   * slabs included): a box per floor band — its pieces' local bounds — for
   * a section or a floor, per bay for a bay, per piece for a piece. (Rapier
   * keeps narrow-phase pairs between a body's own colliders: few boxes on
   * a big body are what keeps a falling tower cheap. The plane never meets
   * these — it collides with the drawn pieces.) */
  private collide(g: Group): void {
    const pc = g.pc;
    const c = pc.c;
    const b = this.room.buildings[c.building] as Building;
    for (const h of g.colliders) {
      const col = this.world.getCollider(h);
      if (col) this.world.removeCollider(col, false);
      this.byCollider.delete(h);
      this.colliderMass.delete(h);
    }
    g.colliders = [];
    g.mass = 0;
    const units = new Map<number, number[]>();
    for (let k = 0; k < g.pieces.length; k++) {
      const i = g.pieces[k] as number;
      const key =
        g.level >= LEVEL_PIECE
          ? i
          : g.level === LEVEL_BAY
            ? -1 - (c.chunk[i] as number)
            : -1 - 0x4000000 - this.bandOf(b, c, i);
      const u = units.get(key);
      if (u) u.push(k);
      else units.set(key, [k]);
    }
    const friction = this.room.tuning.physFriction;
    for (const ks of units.values()) {
      let x0 = Number.POSITIVE_INFINITY;
      let x1 = Number.NEGATIVE_INFINITY;
      let y0 = Number.POSITIVE_INFINITY;
      let y1 = Number.NEGATIVE_INFINITY;
      let z0 = Number.POSITIVE_INFINITY;
      let z1 = Number.NEGATIVE_INFINITY;
      let m = 0;
      for (const k of ks) {
        const i = g.pieces[k] as number;
        const lx = g.local[k * 3] as number;
        const ly = g.local[k * 3 + 1] as number;
        const lz = g.local[k * 3 + 2] as number;
        const hy = (c.hy[i] as number) * (pc.squash[i] as number);
        x0 = Math.min(x0, lx - (c.hx[i] as number));
        x1 = Math.max(x1, lx + (c.hx[i] as number));
        y0 = Math.min(y0, ly - hy);
        y1 = Math.max(y1, ly + hy);
        z0 = Math.min(z0, lz - (c.hz[i] as number));
        z1 = Math.max(z1, lz + (c.hz[i] as number));
        m += this.pieceMass(c, i);
      }
      const hx = Math.max(0.05, (x1 - x0) / 2 - SKIN);
      const hy = Math.max(0.05, (y1 - y0) / 2 - SKIN);
      const hz = Math.max(0.05, (z1 - z0) / 2 - SKIN);
      const col = this.world.createCollider(
        RAPIER.ColliderDesc.cuboid(hx, hy, hz)
          .setTranslation((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2)
          .setMass(m)
          .setFriction(friction)
          .setRestitution(0.05)
          .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS),
        g.body,
      );
      g.colliders.push(col.handle);
      this.byCollider.set(col.handle, g);
      this.colliderMass.set(col.handle, m);
      g.mass += m;
    }
  }

  /**
   * Crush `g` flat (a floor that gave, or an upright one slammed from above
   * or into the ground): every piece keeps `rubbleRatio` of its height, and
   * each bay's pieces of a kind (slabs, facade, steel) re-stack from where
   * the lowest stood — the floor loses its height, so what rests on it
   * comes down through it. D3's crush, in physics. False when it already
   * was.
   */
  private crush(g: Group, band = -1): boolean {
    const pc = g.pc;
    const c = pc.c;
    const b = this.room.buildings[c.building] as Building;
    const keep = this.room.tuning.rubbleRatio;
    const stacks = new Map<number, number[]>();
    for (let k = 0; k < g.pieces.length; k++) {
      const i = g.pieces[k] as number;
      if ((pc.squash[i] as number) < 1) continue;
      if (band >= 0 && this.bandOf(b, c, i) !== band) continue;
      const key = (c.chunk[i] as number) * 4 + (c.role[i] as number);
      const st = stacks.get(key);
      if (st) st.push(k);
      else stacks.set(key, [k]);
    }
    if (stacks.size === 0) return false;
    for (const ks of stacks.values()) {
      // In the body's frame, bottom-up (a group's pieces never rotate in it).
      ks.sort(
        (a, b) =>
          (g.local[a * 3 + 1] as number) - (g.local[b * 3 + 1] as number),
      );
      let base = Number.POSITIVE_INFINITY;
      for (const k of ks) {
        const i = g.pieces[k] as number;
        base = Math.min(
          base,
          (g.local[k * 3 + 1] as number) - (c.hy[i] as number),
        );
      }
      for (const k of ks) {
        const i = g.pieces[k] as number;
        const hy = (c.hy[i] as number) * keep;
        pc.squash[i] = keep;
        g.local[k * 3 + 1] = base + hy;
        base += 2 * hy;
      }
    }
    this.collide(g);
    this.setThresholds(g);
    return true;
  }

  /** Force-event thresholds: a held floor reports what passes its
   * capacity; a moving body what could break it or count as a strike. */
  private setThresholds(g: Group): void {
    const f =
      g.state === HELD
        ? Number.isFinite(g.capacity)
          ? g.capacity
          : g.mass * this.room.tuning.gravity * HOLD_FACTOR
        : (g.mass * Math.min(this.room.tuning.physFracture, IMPACT_SPEED_MIN)) /
          PHYS_STEP_S;
    // Each collider reports its share: a strike spread over a compound's
    // many boxes still adds up to the whole (events.ts sums them).
    for (const h of g.colliders) {
      const share = (this.colliderMass.get(h) ?? g.mass) / (g.mass || 1);
      this.world.getCollider(h)?.setContactForceEventThreshold(f * share);
    }
  }

  /** Where piece `i` of group `g` is now, world space. */
  private pieceWorld(g: Group, i: number): { x: number; y: number; z: number } {
    const k = g.pieces.indexOf(i);
    const t = g.body.translation();
    const p = rotateBy(
      g.body.rotation(),
      g.local[k * 3] as number,
      g.local[k * 3 + 1] as number,
      g.local[k * 3 + 2] as number,
    );
    return { x: t.x + p.x, y: t.y + p.y, z: t.z + p.z };
  }

  /** A lean's hinge: a revolute joint on the line of the last standing
   * columns at the section's base (or its base edge on the fall side). */
  private hinge(g: Group, b: Building): void {
    const c = g.pc.c;
    let base = Number.POSITIVE_INFINITY;
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    let com = 0;
    let mass = 0;
    const alongX = c.dir === DIR_NEG_X || c.dir === DIR_POS_X;
    for (let i = 0; i < c.n; i++) {
      base = Math.min(base, (c.oy[i] as number) - (c.hy[i] as number));
      const o = alongX ? (c.ox[i] as number) : (c.oz[i] as number);
      const h = alongX ? (c.hx[i] as number) : (c.hz[i] as number);
      lo = Math.min(lo, o - h);
      hi = Math.max(hi, o + h);
      const m = this.pieceMass(c, i);
      com += o * m;
      mass += m;
    }
    com /= mass || 1;
    const sign = c.dir === DIR_POS_X || c.dir === DIR_POS_Z ? 1 : -1;
    // The fall-side base edge (D3's pivot) unless columns still stand
    // under the section inside it: then their line — but always behind
    // the mass centre, so the section goes over rather than rocking back.
    let pivot = sign > 0 ? hi : lo;
    const line = hingeLine(b, standingOf(b), base, c.dir);
    if (Number.isFinite(line) && line > lo + 1 && line < hi - 1) {
      const margin = 0.12 * (hi - lo);
      pivot =
        sign > 0 ? Math.min(line, com - margin) : Math.max(line, com + margin);
    }
    const px = alongX ? c.x + pivot : c.x;
    const pz = alongX ? c.z : c.z + pivot;
    // The section's mass centre must lie past the hinge, toward the fall.
    const anchor = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(px, base, pz),
    );
    const o = g.body.translation();
    const axis = alongX ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 };
    const joint = this.world.createImpulseJoint(
      RAPIER.JointData.revolute(
        { x: 0, y: 0, z: 0 },
        { x: px - o.x, y: base - o.y, z: pz - o.z },
        axis,
      ),
      anchor,
      g.body,
      true,
    );
    joint.setContactsEnabled(false);
    g.joint = joint;
    g.anchor = anchor;
    g.snapAt = this.room.tuning.toppleBreak;
  }

  /** Let a held group go (moving at `v`, when struck through). Returns
   * what it became: itself, or its parts once its sheets peeled off. */
  private release(g: Group, v?: { x: number; y: number; z: number }): Group[] {
    if (g.state !== HELD) return [];
    g.state = FREE;
    g.freeSince = this.time;
    g.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
    if (v) g.body.setLinvel(v, true);
    g.tx = v?.x ?? 0;
    g.ty = v?.y ?? 0;
    g.tz = v?.z ?? 0;
    this.active++;
    this.peakActive = Math.max(this.peakActive, this.active);
    this.setThresholds(g);
    if (g.joint) {
      // Over it goes: a kick toward the fall side.
      const c = g.pc.c;
      const w =
        c.dir === DIR_POS_X
          ? { x: 0, y: 0, z: -LEAN_KICK }
          : c.dir === DIR_NEG_X
            ? { x: 0, y: 0, z: LEAN_KICK }
            : c.dir === DIR_POS_Z
              ? { x: LEAN_KICK, y: 0, z: 0 }
              : { x: -LEAN_KICK, y: 0, z: 0 };
      g.body.setAngvel(w, true);
    }
    // A floor's facade sheets peel off as it goes.
    if (g.level === LEVEL_BAND) {
      const c = g.pc.c;
      const sheets = g.pieces.filter((i) => c.role[i] === ROLE_SHEET);
      if (sheets.length > 0 && sheets.length < g.pieces.length) {
        const parts = this.split(
          g,
          [
            g.pieces.filter((i) => c.role[i] !== ROLE_SHEET),
            ...sheets.map((i) => [i]),
          ],
          LEVEL_BAND,
          true,
        );
        if (parts) return parts;
      }
    }
    return [g];
  }

  /**
   * Break `g` into `parts` (piece lists) at `level`, within the budget —
   * coarser (neighbouring parts merged) when the budget is short, not at
   * all when it is spent. `peel` gives the single parts an outward push
   * (a facade sheet coming away). Returns the parts, or null when it did
   * not break.
   */
  private split(
    g: Group,
    parts: number[][],
    level: number,
    peel = false,
  ): Group[] | null {
    let list = parts.filter((p) => p.length > 0);
    if (list.length < 2) return null;
    // At most SPAWN_MAX new bodies a tick: a big break-up spreads over a
    // few ticks rather than spiking one step.
    const room =
      Math.min(this.budget - this.active, SPAWN_MAX - this.spawned) +
      (g.state === FREE ? 1 : 0);
    if (room < 2) return null;
    if (list.length > room) {
      // Merge runs of neighbours (parts come in spatial order).
      const k = Math.ceil(list.length / room);
      const merged: number[][] = [];
      for (let j = 0; j < list.length; j += k) {
        merged.push(list.slice(j, j + k).flat());
      }
      list = merged;
      if (list.length < 2) return null;
    }
    const pc = g.pc;
    const c = pc.c;
    // Out of the budget before the parts come in (never over it, even
    // for the instant in between).
    if (g.state === FREE) this.active--;
    g.state = SPLITTING;
    const made: Group[] = [];
    for (const p of list) made.push(this.makeGroup(pc, p, level, false, g));
    this.spawned += made.length;
    this.destroy(g);
    if (peel) {
      for (const m of made) {
        if (m.pieces.length !== 1) continue;
        const i = m.pieces[0] as number;
        if (c.role[i] !== ROLE_SHEET) continue;
        // Outward from the building's centre, a tip off the wall.
        const t = m.body.translation();
        const ox = wrapDeltaAxis(c.x, t.x);
        const oz = wrapDeltaAxis(c.z, t.z);
        const len = Math.hypot(ox, oz) || 1;
        const v = m.body.linvel();
        m.body.setLinvel(
          { x: v.x + (2.5 * ox) / len, y: v.y, z: v.z + (2.5 * oz) / len },
          true,
        );
        m.body.setAngvel(
          { x: (0.6 * oz) / len, y: 0, z: (-0.6 * ox) / len },
          true,
        );
      }
    }
    return made;
  }

  /** Remove `g`'s body (and hinge) from the world. */
  private destroy(g: Group): void {
    if (g.joint) this.world.removeImpulseJoint(g.joint, true);
    if (g.anchor) this.world.removeRigidBody(g.anchor);
    for (const h of g.colliders) {
      this.byCollider.delete(h);
      this.colliderMass.delete(h);
    }
    this.world.removeRigidBody(g.body);
    if (g.state === FREE) this.active--;
    g.joint = null;
    g.anchor = null;
    const k = g.pc.groups.indexOf(g);
    if (k >= 0) g.pc.groups.splice(k, 1);
    g.state = -1;
  }

  /** Break `g` one level down (a strike, or a snapped hinge) — or, `deep`,
   * straight into its bays, crushed (a hinge torn before it could turn:
   * the section crumbles down onto what held it). */
  private crack(g: Group, deep = false): void {
    const c = g.pc.c;
    const b = this.room.buildings[c.building];
    if (!b || g.state !== FREE || g.level >= LEVEL_PIECE) return;
    if (this.spawned >= SPAWN_MAX - 1) {
      // This tick's break-ups are spent: it breaks next tick.
      g.crack = true;
      g.deep = deep;
      return;
    }
    const by = (key: (i: number) => number): number[][] => {
      const m = new Map<number, number[]>();
      for (const i of g.pieces) {
        const k = key(i);
        const l = m.get(k);
        if (l) l.push(i);
        else m.set(k, [i]);
      }
      return [...m.entries()].sort((x, y) => x[0] - y[0]).map((e) => e[1]);
    };
    if (g.level === LEVEL_SECTION && !deep) {
      if (
        this.split(
          g,
          by((i) => this.bandOf(b, c, i)),
          LEVEL_BAND,
        )
      )
        return;
    }
    if (g.level <= LEVEL_BAND) {
      const bays = this.split(
        g,
        by((i) => c.chunk[i] as number),
        LEVEL_BAY,
      );
      if (bays) {
        // Torn off its hinge before it could turn: it crumbles where it
        // is, every bay crushed — the section comes down on itself.
        if (deep) for (const bay of bays) this.crush(bay);
        return;
      }
    }
    this.split(
      g,
      by((i) => i),
      LEVEL_PIECE,
    );
  }

  /** The solids of every building the debris of `c` can reach, as fixed
   * colliders at the image it meets them at (shared between collapses). */
  private ensureStatics(c: Collapse): void {
    const b = this.room.buildings[c.building];
    if (!b) return;
    const reach = b.height + 30;
    for (let i = 0; i < this.room.buildings.length; i++) {
      const o = this.room.buildings[i] as Building;
      const dx = wrapDeltaAxis(c.x, o.x);
      const dz = wrapDeltaAxis(c.z, o.z);
      if (Math.abs(dx) > reach + o.width / 2) continue;
      if (Math.abs(dz) > reach + o.depth / 2) continue;
      const ox = c.x + dx;
      const oz = c.z + dz;
      const key =
        i * 9 +
        (Math.round((ox - o.x) / WORLD_SIZE) + 1) * 3 +
        (Math.round((oz - o.z) / WORLD_SIZE) + 1);
      if (this.statics.has(key)) continue;
      const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
      const sb: StaticBuilding = {
        index: i,
        ox,
        oz,
        version: -1,
        body,
        colliders: [],
      };
      this.statics.set(key, sb);
      this.refreshStatic(sb);
    }
  }

  /** Re-collide `sb` with its building's solids if they changed. */
  private refreshStatic(sb: StaticBuilding): void {
    const b = this.room.buildings[sb.index] as Building;
    const version = b.damage?.version ?? 0;
    if (version === sb.version) return;
    sb.version = version;
    for (const h of sb.colliders) {
      const col = this.world.getCollider(h);
      // Wake what rested on it: its support may be gone.
      if (col) this.world.removeCollider(col, true);
      this.buildingOf.delete(h);
    }
    sb.colliders = [];
    const friction = this.room.tuning.physFriction;
    for (const s of solids(b)) {
      const col = this.world.createCollider(
        RAPIER.ColliderDesc.cuboid(s.width / 2, s.height / 2, s.depth / 2)
          .setTranslation(sb.ox + s.dx, s.baseY + s.height / 2, sb.oz + s.dz)
          .setFriction(friction),
        sb.body,
      );
      sb.colliders.push(col.handle);
      this.buildingOf.set(col.handle, sb.index);
    }
  }

  /** Advance to host time `now`, ms. */
  step(now: number): void {
    if (this.collapses.length === 0) {
      this.time = now;
      this.lastStepMs = 0;
      return;
    }
    const began = performance.now();
    if (
      Number.isNaN(this.time) ||
      now - this.time > MAX_STEPS * 4 * PHYS_STEP_S * 1000
    ) {
      this.time = now - MAX_STEPS * PHYS_STEP_S * 1000;
    }
    for (const sb of this.statics.values()) this.refreshStatic(sb);
    const g = this.room.tuning.gravity;
    const wg = this.world.gravity;
    if (wg.y !== -g) this.world.gravity = { x: 0, y: -g, z: 0 };
    let steps = 0;
    while (this.time + PHYS_STEP_S * 1000 <= now && steps < MAX_STEPS) {
      this.time += PHYS_STEP_S * 1000;
      steps++;
      this.schedule();
      this.remember();
      this.world.step(this.queue);
      this.events();
      this.afterStep();
    }
    if (steps > 0) this.afterTick(steps * PHYS_STEP_S);
    this.lastStepMs = performance.now() - began;
    this.govern(this.lastStepMs);
    this.spawned = 0;
  }

  /** Held groups whose time has come let go. */
  private schedule(): void {
    for (const pc of this.collapses) {
      if (pc.settled) continue;
      for (const g of [...pc.groups]) {
        if (g.state === HELD && this.time >= g.releaseAt) {
          if (this.active + 1 <= this.budget) {
            this.release(g);
          } else if (this.time >= g.releaseAt + 5000) {
            // Never room for it: it stays where it stood, as rubble.
            g.state = FROZEN;
          }
        }
      }
    }
  }

  /** Every moving group's velocity before the step. */
  private remember(): void {
    for (const pc of this.collapses) {
      if (pc.settled) continue;
      for (const g of pc.groups) {
        if (g.state !== FREE) continue;
        const v = g.body.linvel();
        g.vx = v.x;
        g.vy = v.y;
        g.vz = v.z;
      }
    }
  }

  /** Groups with a force summed this step (reset after). */
  private touched: Group[] = [];

  /**
   * The step's contact force events, summed per group: a held floor whose
   * load passes its capacity gives — and the strike goes on through it
   * (momentum shared with the floor, less what breaking its columns took,
   * so floors go one after another, faster as the falling mass grows); a
   * moving group struck harder than the fracture threshold breaks; a
   * strike on another building is a chain impact.
   */
  private events(): void {
    const touched = this.touched;
    this.queue.drainContactForceEvents((ev) => {
      const h1 = ev.collider1();
      const h2 = ev.collider2();
      const f = ev.totalForceMagnitude();
      const g1 = this.byCollider.get(h1);
      const g2 = this.byCollider.get(h2);
      for (const [g, other, oh] of [
        [g1, g2, h2],
        [g2, g1, h1],
      ] as const) {
        if (!g || g.state < 0) continue;
        if (g.state === HELD) {
          if (!other || other.state !== FREE) continue;
          if (g.load === 0 && g.hit === 0) touched.push(g);
          g.load += f;
          if (!g.strikers) g.strikers = [];
          if (!g.strikers.includes(other)) g.strikers.push(other);
          continue;
        }
        if (g.state !== FREE) continue;
        if (other && other.state === HELD) continue;
        if (g.load === 0 && g.hit === 0) touched.push(g);
        g.hit += f;
        const bi = this.buildingOf.get(oh);
        if (bi !== undefined && bi !== g.pc.c.building) this.strike(g, bi);
      }
    });
    if (touched.length === 0) return;
    const through = new Set<Group>();
    for (const g of touched) {
      if (g.state !== HELD || g.load <= g.capacity || !g.strikers) continue;
      if (this.active + 1 > this.budget) continue;
      // Momentum through the floor: the falling column above it — its
      // strikers and everything of the collapse coming down on them — and
      // the floor move on together (the crush front gathers mass).
      const floorY = g.body.translation().y;
      const column: Group[] = [];
      for (const s of g.strikers) if (s.state === FREE) column.push(s);
      for (const o of g.pc.groups) {
        if (o.state !== FREE || column.includes(o)) continue;
        if (o.vy < -0.5 && o.body.translation().y > floorY) column.push(o);
      }
      let m = g.mass;
      let px = 0;
      let py = 0;
      let pz = 0;
      for (const s of column) {
        m += s.mass;
        px += s.mass * s.vx;
        py += s.mass * s.vy;
        pz += s.mass * s.vz;
        through.add(s);
      }
      const k = (1 - CRUSH_LOSS) / m;
      const v = { x: px * k, y: py * k, z: pz * k };
      for (const s of column) s.body.setLinvel(v, true);
      // The floor that gave is crushed under what came through it (its
      // facade sheets peel off as it goes: crush what is left of it).
      for (const part of this.release(g, v)) this.crush(part);
    }
    // The column struck through moves on at its new speed: no shock.
    for (const g of through) g.through = true;
    for (const g of touched) {
      g.load = 0;
      g.hit = 0;
      g.strikers = null;
    }
    touched.length = 0;
  }

  /**
   * Leaning section `g` bears down on its own building's floors under its
   * falling side: an impact there, at its lowest point, as hard as a chain
   * impact gets (its weight, not its speed, is what crushes them).
   */
  private bear(g: Group): void {
    const pc = g.pc;
    const c = pc.c;
    const t = this.room.tuning;
    // Whatever buildings it rests on — its own stump, or a neighbour it
    // has leant onto — at the points it touches them.
    const sx = c.dir === DIR_POS_X ? 1 : c.dir === DIR_NEG_X ? -1 : 0;
    const sz = c.dir === DIR_POS_Z ? 1 : c.dir === DIR_NEG_Z ? -1 : 0;
    const points: { b: number; x: number; y: number; z: number }[] = [];
    for (const h of g.colliders) {
      const col = this.world.getCollider(h);
      if (!col) continue;
      this.world.contactPairsWith(col, (other) => {
        const bi = this.buildingOf.get(other.handle);
        if (bi === undefined) return;
        this.world.contactPair(col, other, (m) => {
          for (let k = 0; k < m.numSolverContacts(); k++) {
            const p = m.solverContactPoint(k);
            if (points.length >= BEAR_POINTS) return;
            if (
              points.some(
                (q) =>
                  Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z) < BEAR_SPACING,
              )
            )
              continue;
            points.push({ b: bi, x: p.x, y: p.y, z: p.z });
          }
        });
      });
    }
    if (points.length > 0) {
      let mass = 0;
      for (const i of g.pieces)
        mass +=
          8 * (c.hx[i] as number) * (c.hy[i] as number) * (c.hz[i] as number);
      for (const p of points) {
        const w = canonicalize({ x: p.x, y: 0, z: p.z });
        this.impacts.push({
          t: this.time,
          building: p.b,
          x: w.x,
          y: Math.max(0, p.y - 1),
          z: w.z,
          e: t.chainEnergyMax,
          // On through it, the way it leans, and down.
          vx: sx * BEAR_SPEED,
          vy: -BEAR_SPEED,
          vz: sz * BEAR_SPEED,
          vol: mass / points.length,
          source: c.id,
          depth: pc.depth,
        });
      }
      return;
    }
    // The section's base on its falling side, in its own frame: the
    // lowest local y, the furthest along the fall direction.
    const alongX = c.dir === DIR_NEG_X || c.dir === DIR_POS_X;
    const sign = c.dir === DIR_POS_X || c.dir === DIR_POS_Z ? 1 : -1;
    let base = Number.POSITIVE_INFINITY;
    let edge = Number.NEGATIVE_INFINITY;
    let vol = 0;
    for (let k = 0; k < g.pieces.length; k++) {
      const i = g.pieces[k] as number;
      const hy = (c.hy[i] as number) * (pc.squash[i] as number);
      base = Math.min(base, (g.local[k * 3 + 1] as number) - hy);
      const a = alongX ? g.local[k * 3] : g.local[k * 3 + 2];
      const h = alongX ? c.hx[i] : c.hz[i];
      edge = Math.max(edge, sign * (a as number) + (h as number));
      vol +=
        8 * (c.hx[i] as number) * (c.hy[i] as number) * (c.hz[i] as number);
    }
    if (!Number.isFinite(base)) return;
    // Across the whole edge, a bay in from it: what it bears on.
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    for (let k = 0; k < g.pieces.length; k++) {
      const i = g.pieces[k] as number;
      const a = (alongX ? g.local[k * 3 + 2] : g.local[k * 3]) as number;
      const h = (alongX ? c.hz[i] : c.hx[i]) as number;
      lo = Math.min(lo, a - h);
      hi = Math.max(hi, a + h);
    }
    const reach = sign * (edge - 6);
    const n = Math.max(1, Math.round((hi - lo) / BEAR_SPACING));
    const o = g.body.translation();
    const q = g.body.rotation();
    for (let j = 0; j < n; j++) {
      const across = lo + ((j + 0.5) * (hi - lo)) / n;
      const p = alongX
        ? rotateBy(q, reach, base, across)
        : rotateBy(q, across, base, reach);
      const w = canonicalize({ x: o.x + p.x, y: 0, z: o.z + p.z });
      this.impacts.push({
        t: this.time,
        building: c.building,
        x: w.x,
        y: Math.max(0, o.y + p.y - 1),
        z: w.z,
        e: t.chainEnergyMax,
        // Down through the floors under it.
        vx: 0,
        vy: -BEAR_SPEED,
        vz: 0,
        vol: vol / n,
        source: c.id,
        depth: pc.depth,
      });
    }
  }

  /** Debris group `g` struck building `index`: a chain impact, coalesced. */
  private strike(g: Group, index: number): void {
    const pc = g.pc;
    const t = this.room.tuning;
    if (pc.depth >= t.chainDepthMax) return;
    if (pc.hitCount >= t.chainImpactsMax) return;
    const v = { x: g.vx, y: g.vy, z: g.vz };
    const speed = Math.hypot(v.x, v.y, v.z);
    if (speed < IMPACT_SPEED_MIN) return;
    const p = g.body.translation();
    const list = pc.hits.get(index) ?? [];
    if (list.length >= t.chainImpactsPerBuilding) return;
    for (const o of list) {
      if (Math.hypot(o.x - p.x, o.y - p.y, o.z - p.z) < CHAIN_COALESCE_M)
        return;
    }
    list.push({ x: p.x, y: p.y, z: p.z });
    pc.hits.set(index, list);
    pc.hitCount++;
    const c = pc.c;
    let vol = 0;
    for (const i of g.pieces) {
      vol +=
        8 * (c.hx[i] as number) * (c.hy[i] as number) * (c.hz[i] as number);
    }
    const w = canonicalize({ x: p.x, y: 0, z: p.z });
    this.impacts.push({
      t: this.time,
      building: index,
      x: w.x,
      y: p.y,
      z: w.z,
      e: impactScale(vol, speed, t),
      vx: v.x,
      vy: v.y,
      vz: v.z,
      vol,
      source: c.id,
      depth: pc.depth,
    });
  }

  /** Cracks, hinges snapping, pieces freezing, collapses settling. */
  private afterStep(): void {
    const dt = PHYS_STEP_S;
    for (const pc of this.collapses) {
      if (pc.settled) continue;
      for (const g of [...pc.groups]) {
        if (g.state !== FREE || !(g.joint || g.crack)) continue;
        if (g.joint) {
          // Tilt: the angle of the body's up axis off the vertical.
          const up = rotateBy(g.body.rotation(), 0, 1, 0);
          const tilt = Math.acos(Math.min(1, Math.max(-1, up.y)));
          // Leaning onto what stands under its falling side, it stalls:
          // it bears down on those floors (an impact on its own building,
          // which the room lands as a blast — they give, and come down as
          // a collapse of their own, and it goes on over). After
          // LEAN_BEARS that changed nothing, the hinge tears instead.
          if (tilt - g.stallTilt > LEAN_PROGRESS) {
            g.stallTilt = tilt;
            g.stall = 0;
            g.bears = 0;
          } else {
            g.stall += dt;
          }
          let snap =
            tilt > g.snapAt || this.time - g.freeSince > FREEZE_MAX_S * 1000;
          if (g.stall >= LEAN_STALL_S) {
            g.stall = 0;
            g.stallTilt = tilt;
            if (g.bears++ >= LEAN_BEARS) snap = true;
            else this.bear(g);
            g.body.wakeUp();
          }
          if (snap) {
            this.world.removeImpulseJoint(g.joint, true);
            if (g.anchor) this.world.removeRigidBody(g.anchor);
            g.joint = null;
            g.anchor = null;
            g.crack = true;
            g.deep = tilt < LEAN_TORN_TILT;
          }
        }
        if (g.crack) {
          g.crack = false;
          if (!g.joint) this.crack(g, g.deep);
        }
      }
    }
  }

  /**
   * Once per host tick (`dt` s of steps): each moving group's shock — the
   * speed it lost over the tick beyond gravity's pull, with a tick's memory
   * (Rapier stops a slab over several steps) — crushes an upright-or-not
   * floor or breaks a group; what has lain still freezes; a collapse with
   * nothing left moving or held settles.
   */
  private afterTick(dt: number): void {
    const gravity = this.room.tuning.gravity;
    for (const pc of this.collapses) {
      if (pc.settled) continue;
      let live = 0;
      for (const g of [...pc.groups]) {
        if (g.state === HELD) {
          live++;
          continue;
        }
        if (g.state !== FREE) continue;
        live++;
        const v = g.body.linvel();
        const dvx = v.x - g.tx;
        const dvy = v.y - g.ty + gravity * dt;
        const dvz = v.z - g.tz;
        g.shock = g.through
          ? 0
          : g.shock * SHOCK_DECAY +
            Math.sqrt(dvx * dvx + dvy * dvy + dvz * dvz);
        g.through = false;
        g.tx = v.x;
        g.ty = v.y;
        g.tz = v.z;
        if (!g.joint && g.shock > CRUSH_SPEED) {
          if (g.level > LEVEL_SECTION && this.crush(g)) {
            // A floor slammed: crushed flat along its own storeys (a
            // stack leaning on a facade slumps down it).
            g.shock = 0;
          } else if (g.shock > this.room.tuning.physFracture) {
            this.crack(g);
            if (g.state !== FREE) continue;
          }
        }
        // A section still on its hinge never freezes: it bears down or
        // tears free first.
        if (g.joint) continue;
        const w = g.body.angvel();
        const slow =
          v.x * v.x + v.y * v.y + v.z * v.z < FREEZE_V * FREEZE_V &&
          w.x * w.x + w.y * w.y + w.z * w.z < FREEZE_W * FREEZE_W;
        g.still = slow ? g.still + dt : 0;
        if (
          g.still >= FREEZE_S ||
          this.time - g.freeSince > FREEZE_MAX_S * 1000
        ) {
          this.freeze(g);
        }
      }
      if (live === 0) this.settle(pc);
    }
  }

  /** `g` lies still: a fixed body from now on (rubble to pile onto). */
  private freeze(g: Group): void {
    if (g.joint) {
      this.world.removeImpulseJoint(g.joint, true);
      if (g.anchor) this.world.removeRigidBody(g.anchor);
      g.joint = null;
      g.anchor = null;
    }
    g.body.setBodyType(RAPIER.RigidBodyType.Fixed, false);
    g.state = FROZEN;
    this.active--;
  }

  /** Every piece of `pc` is frozen: merge the small ones, raise its heap. */
  private settle(pc: PhysCollapse): void {
    pc.settled = true;
    const c = pc.c;
    let merged = 0;
    for (let i = 0; i < c.n; i++) {
      const vol =
        8 * (c.hx[i] as number) * (c.hy[i] as number) * (c.hz[i] as number);
      if (vol < MERGE_M3) {
        pc.merged[i] = 1;
        merged += vol;
      }
    }
    pc.heap = this.raiseHeap(pc, merged);
    if (pc.heap) pc.heapBody = this.groundHeap(pc.c, pc.heap);
    this.pendingHeaps.push(this.collapses.indexOf(pc));
  }

  /**
   * The fine rubble of a settled collapse: its pieces' plan coverage,
   * blurred into a mound holding HEAP_SHARE of their volume (plus what was
   * merged), roughened by a hash, never over HEAP_MAX_M, zero at its rim.
   */
  private raiseHeap(pc: PhysCollapse, extra: number): RubbleHeap | null {
    const c = pc.c;
    let x0 = Number.POSITIVE_INFINITY;
    let x1 = Number.NEGATIVE_INFINITY;
    let z0 = Number.POSITIVE_INFINITY;
    let z1 = Number.NEGATIVE_INFINITY;
    const pose = new Float64Array(c.n * 3);
    const span = new Float64Array(c.n);
    let total = extra;
    for (let i = 0; i < c.n; i++) {
      const g = pc.of[i];
      if (!g || g.state < 0) continue;
      const p = this.pieceWorld(g, i);
      const x = wrapDeltaAxis(c.x, p.x);
      const z = wrapDeltaAxis(c.z, p.z);
      pose[i * 3] = x;
      pose[i * 3 + 1] = p.y;
      pose[i * 3 + 2] = z;
      const r = Math.max(
        c.hx[i] as number,
        c.hz[i] as number,
        c.hy[i] as number,
      );
      span[i] = r;
      x0 = Math.min(x0, x - r);
      x1 = Math.max(x1, x + r);
      z0 = Math.min(z0, z - r);
      z1 = Math.max(z1, z + r);
      total +=
        HEAP_SHARE *
        8 *
        (c.hx[i] as number) *
        (c.hy[i] as number) *
        (c.hz[i] as number);
    }
    if (!(x1 > x0) || !(z1 > z0)) return null;
    const pad = 2 * HEAP_CELL;
    x0 -= pad;
    z0 -= pad;
    const nx = Math.min(HEAP_CELLS_MAX, Math.ceil((x1 + pad - x0) / HEAP_CELL));
    const nz = Math.min(HEAP_CELLS_MAX, Math.ceil((z1 + pad - z0) / HEAP_CELL));
    const row = nx + 1;
    const w = new Float32Array(row * (nz + 1));
    for (let i = 0; i < c.n; i++) {
      if (!pc.of[i] || pc.merged[i]) continue;
      const x = pose[i * 3] as number;
      const z = pose[i * 3 + 2] as number;
      const r = span[i] as number;
      const weight = Math.max(0, pose[i * 3 + 1] as number) + 1;
      const a0 = Math.max(0, Math.floor((x - r - x0) / HEAP_CELL));
      const a1 = Math.min(nx, Math.ceil((x + r - x0) / HEAP_CELL));
      const b0 = Math.max(0, Math.floor((z - r - z0) / HEAP_CELL));
      const b1 = Math.min(nz, Math.ceil((z + r - z0) / HEAP_CELL));
      for (let j = b0; j <= b1; j++) {
        for (let k = a0; k <= a1; k++) {
          w[j * row + k] = (w[j * row + k] as number) + weight;
        }
      }
    }
    // Blur: three box passes, radius 2 — each separable (a 5-tap average
    // along x, then along z: the same as the 5 × 5 one, edges included).
    const tmp = new Float32Array(w.length);
    for (let pass = 0; pass < 3; pass++) {
      for (let j = 0; j <= nz; j++) {
        for (let k = 0; k <= nx; k++) {
          let sum = 0;
          let n = 0;
          for (let kk = Math.max(0, k - 2); kk <= Math.min(nx, k + 2); kk++) {
            sum += w[j * row + kk] as number;
            n++;
          }
          tmp[j * row + k] = sum / n;
        }
      }
      for (let j = 0; j <= nz; j++) {
        for (let k = 0; k <= nx; k++) {
          let sum = 0;
          let n = 0;
          for (let jj = Math.max(0, j - 2); jj <= Math.min(nz, j + 2); jj++) {
            sum += tmp[jj * row + k] as number;
            n++;
          }
          w[j * row + k] = sum / n;
        }
      }
    }
    let sum = 0;
    for (let k = 0; k < w.length; k++) sum += w[k] as number;
    if (!(sum > 0)) return null;
    const scale = total / (sum * HEAP_CELL * HEAP_CELL);
    const h = new Float32Array(w.length);
    let top = 0;
    for (let j = 0; j <= nz; j++) {
      for (let k = 0; k <= nx; k++) {
        const at = j * row + k;
        if (j === 0 || k === 0 || j === nz || k === nx) continue;
        // Rubble, not a dune: each vertex scaled and knocked up or down
        // a little by its own hash (where there is rubble at all).
        const base = (w[at] as number) * scale;
        const rough = 0.75 + 0.5 * hash3(c.id, k, j);
        const knock =
          base > 0.3 ? HEAP_KNOCK_M * (hash3(c.id + 7919, k, j) - 0.5) : 0;
        const v = Math.min(HEAP_MAX_M, Math.max(0, base * rough + knock));
        h[at] = v;
        top = Math.max(top, v);
      }
    }
    return { x0, z0, cell: HEAP_CELL, nx, nz, h, top };
  }

  /** `heap` in the world: what the next collapse's debris piles onto. */
  private groundHeap(c: Collapse, heap: RubbleHeap): RAPIER.RigidBody {
    // Rapier's heightfield: rows along z, columns along x, column-major,
    // centred on its collider.
    const rows = heap.nz;
    const cols = heap.nx;
    const h = new Float32Array((rows + 1) * (cols + 1));
    for (let i = 0; i <= cols; i++) {
      for (let j = 0; j <= rows; j++) {
        h[i * (rows + 1) + j] = heap.h[j * (cols + 1) + i] as number;
      }
    }
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(
        c.x + heap.x0 + (cols * heap.cell) / 2,
        0,
        c.z + heap.z0 + (rows * heap.cell) / 2,
      ),
    );
    this.world.createCollider(
      RAPIER.ColliderDesc.heightfield(rows, cols, h, {
        x: cols * heap.cell,
        y: 1,
        z: rows * heap.cell,
      }).setFriction(this.room.tuning.physFriction),
      body,
    );
    return body;
  }

  /** Chain impacts found since the last call, earliest first. */
  takeImpacts(): PhysicsImpact[] {
    const out = this.impacts;
    this.impacts = [];
    return out;
  }

  /**
   * The frame for this tick: every collapse still moving, and each that
   * settled since the last frame (its final frame, REC_SETTLED, and its
   * heap). Null when there is nothing to send. The room's own registry
   * ingests it before it is returned.
   */
  takeFrame(): PhysicsFrame | null {
    let size = 0;
    for (const pc of this.collapses) {
      if (pc.sentFinal) continue;
      size += RECORD_HEAD + pc.c.n * PIECE_STRIDE;
    }
    if (size === 0) return null;
    const data = new Float32Array(size);
    let o = 0;
    for (const pc of this.collapses) {
      if (pc.sentFinal) continue;
      const c = pc.c;
      data[o] = c.id;
      data[o + 1] = c.building;
      data[o + 2] = c.n;
      data[o + 3] = pc.settled ? REC_SETTLED : 0;
      o += RECORD_HEAD;
      for (const g of pc.groups) this.writeGroup(g, data, o);
      for (let i = 0; i < c.n; i++) {
        if (pc.merged[i] || !pc.of[i]) {
          // Merged into the heap: out of sight, under the street.
          const at = o + i * PIECE_STRIDE;
          data[at] = 0;
          data[at + 1] = -200;
          data[at + 2] = 0;
          data[at + 6] = 1;
          data[at + 7] = PIECE_FROZEN;
          data[at + 8] = 1;
        }
      }
      o += c.n * PIECE_STRIDE;
      if (pc.settled) pc.sentFinal = true;
    }
    let heaps: Float32Array | null = null;
    if (this.pendingHeaps.length > 0) {
      const rows: number[] = [];
      for (const k of this.pendingHeaps) {
        const pc = this.collapses[k];
        if (pc?.heap) rows.push(...heapRecord(pc.c.id, pc.c.building, pc.heap));
      }
      this.pendingHeaps = [];
      if (rows.length > 0) heaps = Float32Array.from(rows);
    }
    const frame = { t: this.time, epoch: this.epoch, data, heaps };
    this.registry.ingest(frame.t, frame.epoch, data, heaps);
    return frame;
  }

  /** Group `g`'s pieces into the record whose piece block starts at `o`. */
  private writeGroup(g: Group, data: Float32Array, o: number): void {
    const c = g.pc.c;
    const t = g.body.translation();
    const q = g.body.rotation();
    const state =
      g.state === FREE
        ? PIECE_MOVING
        : g.state === HELD
          ? PIECE_HELD
          : PIECE_FROZEN;
    for (let k = 0; k < g.pieces.length; k++) {
      const i = g.pieces[k] as number;
      const p = rotateBy(
        q,
        g.local[k * 3] as number,
        g.local[k * 3 + 1] as number,
        g.local[k * 3 + 2] as number,
      );
      const at = o + i * PIECE_STRIDE;
      data[at] = t.x + p.x - c.x;
      data[at + 1] = t.y + p.y;
      data[at + 2] = t.z + p.z - c.z;
      data[at + 3] = q.x;
      data[at + 4] = q.y;
      data[at + 5] = q.z;
      data[at + 6] = q.w;
      data[at + 7] = state;
      data[at + 8] = g.pc.squash[i] as number;
    }
  }
}

/** Rotate (x, y, z) by unit quaternion `q`. */
function rotateBy(
  q: { x: number; y: number; z: number; w: number },
  x: number,
  y: number,
  z: number,
): { x: number; y: number; z: number } {
  const tx = 2 * (q.y * z - q.z * y);
  const ty = 2 * (q.z * x - q.x * z);
  const tz = 2 * (q.x * y - q.y * x);
  return {
    x: x + q.w * tx + (q.y * tz - q.z * ty),
    y: y + q.w * ty + (q.z * tx - q.x * tz),
    z: z + q.w * tz + (q.x * ty - q.y * tx),
  };
}

/** A hash of three integers into [0, 1). */
function hash3(a: number, b: number, c: number): number {
  let h = Math.imul(a + 1, 0x9e3779b1);
  h = Math.imul(h ^ (b + 0x632be5ab), 0x85ebca6b);
  h = Math.imul(h ^ (c + 7), 0xc2b2ae35);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}
