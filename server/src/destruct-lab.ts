// DL1 Destruction Lab, server side: every lab trigger through the room's
// REAL destruction pipeline — the same rays (applyShotDamage), missile and
// bomb strikes (the room's missile director, landed by landMissile), D5
// demolition plans and D2 chunk damage the game uses — so whatever the lab
// shows is what the game does. Nothing here builds debris or plans a
// collapse of its own: a broken chunk goes through tickDestruction's
// planner like any other, a demolition through stageCollapse like the
// director's.
//
// Some triggers play out over time (sustained fire, a chain across the
// block): they queue steps the room ticks through (`tickLab`) before its
// destruction tick, so what they break rides that tick's batch.
//
// Also the lab's arena reset (every building and crane rebuilt, every prop
// restored, the craters gone — through the rebuild and props broadcasts the
// game already has) and its telemetry (the destruction tick's cost).

import { type Building, chunkId, tierGrids } from "@angels-bandits/common/city";
import {
  type CollapseWire,
  DIR_NEG_X,
  DIR_NEG_Z,
  DIR_POS_X,
  DIR_POS_Z,
  PANCAKE,
  TOPPLE,
  demolitionPlan,
} from "@angels-bandits/common/city/collapse";
import { cellIndex } from "@angels-bandits/common/city/destruction";
import { pieceMoving } from "@angels-bandits/common/city/physpose";
import {
  BLOCK_PITCH,
  BULLET_RANGE,
  CHUNK_HP,
} from "@angels-bandits/common/constants";
import type { LabTrigger } from "@angels-bandits/common/destruct-lab";
import type { RebuildWire } from "@angels-bandits/common/director";
import type { MissileStrike } from "@angels-bandits/common/strike";
import {
  type Vec3,
  canonicalize,
  wrapDeltaAxis,
} from "@angels-bandits/common/world";
import {
  type RoomCity,
  applyShotDamage,
  rebuildBuilding,
  rebuildCrane,
  stageCollapse,
} from "./destruction";

/** Sustained fire: rounds per tick, for how long, ms, and their spread at
 * the aim point, m. */
export const SHOOT_ROUNDS_PER_TICK = 6;
export const SHOOT_MS = 1600;
const SHOOT_SPREAD_M = 2.5;
/** A chain across the block: the gap between felling one tower and the
 * next, ms. */
export const CHAIN_STEP_MS = 1400;
/** A bomb leaves its plane this far above the aim point, m; a missile is
 * launched this far off it, m, and this much higher. */
const BOMB_DROP_M = 160;
const MISSILE_RANGE_M = 520;
const MISSILE_RISE_M = 90;
/** The lab's telemetry window, ticks, and its cadence, ms. */
export const LAB_STATS_WINDOW = 200;
export const LAB_STATS_MS = 500;

/** One queued step: fire a burst, or fell a tower. */
type Step =
  | { at: number; k: "burst"; o: Vec3; p: Vec3; seed: number }
  | { at: number; k: "fell"; b: number; style: number; dir: number };

/** What the room must broadcast after a trigger or a lab tick. */
export interface LabOutput {
  collapses: CollapseWire[];
  missiles: MissileStrike[];
}

/** One Destruction Lab room's server state. */
export class DestructLab {
  private queue: Step[] = [];
  /** Destruction tick costs, ms (a ring), and the heaviest build. */
  private readonly ticks = new Float64Array(LAB_STATS_WINDOW);
  private nTicks = 0;
  private head = 0;
  private lastTick = 0;
  /** DS1: the physics step's costs, ms (a ring like `ticks`). */
  private readonly phys = new Float64Array(LAB_STATS_WINDOW);
  private nPhys = 0;
  private physHead = 0;
  private lastPhys = 0;
  private builds: number[] = [];
  private lastSent = Number.NEGATIVE_INFINITY;

  /** Steps still to play (QA/tests). */
  get pending(): number {
    return this.queue.length;
  }

  /**
   * Set `t` off in `city` at `now`. `missiles` mints and flies strikes (the
   * room's missile director). Returns what to broadcast now; timed steps
   * come out of tickLab.
   */
  trigger(
    city: RoomCity,
    t: LabTrigger,
    now: number,
    missiles: { allocId(): number; inject(s: MissileStrike): void },
  ): LabOutput {
    const out: LabOutput = { collapses: [], missiles: [] };
    const b = city.buildings[t.b];
    if (!b) return out;
    switch (t.k) {
      case "shoot": {
        const p = t.p as Vec3;
        const o = shooterEye(b, p, t.o);
        for (let at = now; at < now + SHOOT_MS; at += 50) {
          this.queue.push({ at, k: "burst", o, p, seed: at - now + t.b });
        }
        break;
      }
      case "bomb":
      case "missile": {
        const p = t.p as Vec3;
        const s: MissileStrike =
          t.k === "bomb"
            ? {
                id: missiles.allocId(),
                kind: "bomb",
                from: canonicalize({ x: p.x, y: p.y + BOMB_DROP_M, z: p.z }),
                to: p,
                t0: now,
                vy: -6,
              }
            : {
                id: missiles.allocId(),
                kind: "cruise",
                from: missileFrom(b, p),
                to: p,
                t0: now,
              };
        missiles.inject(s);
        out.missiles.push(s);
        break;
      }
      case "pancake":
      case "topple": {
        const w = fell(
          city,
          t.b,
          t.k === "topple" ? TOPPLE : PANCAKE,
          t.d ?? DIR_POS_X,
          now,
        );
        if (w) out.collapses.push(w);
        break;
      }
      case "shear":
        shearCorner(city, t.b, t.c ?? 3);
        break;
      case "charge":
        floorCharge(city, t.b, t.f ?? 1);
        break;
      case "lean":
        leanCharge(city, t.b, t.f ?? 1, t.d ?? 1);
        break;
      case "neighbour": {
        const w = fell(city, t.b, TOPPLE, towardNeighbour(city, t.b), now);
        if (w) out.collapses.push(w);
        break;
      }
      case "chain": {
        const order = blockOrder(city.buildings, t.b);
        order.forEach((step, i) => {
          this.queue.push({
            at: now + i * CHAIN_STEP_MS,
            k: "fell",
            b: step.b,
            style: TOPPLE,
            dir: step.dir,
          });
        });
        break;
      }
    }
    this.queue.sort((a, b) => a.at - b.at);
    return out;
  }

  /** Play the steps due by `now` (before the room's destruction tick). */
  tickLab(city: RoomCity, now: number): LabOutput {
    const out: LabOutput = { collapses: [], missiles: [] };
    let k = 0;
    while (k < this.queue.length && (this.queue[k] as Step).at <= now) {
      const s = this.queue[k] as Step;
      k++;
      if (s.k === "burst") burst(city, s.o, s.p, s.seed);
      else {
        const w = fell(city, s.b, s.style, s.dir, now);
        if (w) out.collapses.push(w);
      }
    }
    if (k > 0) this.queue.splice(0, k);
    return out;
  }

  /** The arena whole again: every damaged building and felled crane
   * rebuilt, every downed prop restored, every crater filled, every queued
   * step dropped. Returns the rebuild wires to broadcast (the props'
   * restorations and craters ride the next props batch). */
  reset(city: RoomCity, now: number): RebuildWire[] {
    this.queue = [];
    const wires: RebuildWire[] = [];
    const touched = new Set<number>();
    for (const w of [...city.collapses.records]) {
      if (w.k === 1) {
        rebuildCrane(city, w.b);
        wires.push({ k: 1, b: w.b, at: now, go: true });
      } else touched.add(w.b);
    }
    city.buildings.forEach((b, i) => {
      if (b.damage) touched.add(i);
    });
    for (const i of [...touched].sort((a, b) => a - b)) {
      rebuildBuilding(city, i);
      wires.push({ k: 0, b: i, at: now, go: true });
    }
    city.impacts = [];
    const props = city.props;
    for (const id of props.slot.state.downIds()) {
      props.slot.state.restore(id);
      props.out.restored.push(id);
    }
    props.blasts = [];
    props.crushes = [];
    props.landings = [];
    props.repairs = [];
    for (const c of props.craters) props.out.cratersGone.push(c.id);
    props.craters.length = 0;
    return wires;
  }

  /** Note a collapse build outside the tick (a demolition trigger), ms. */
  noteBuild(ms: number): void {
    this.builds.push(ms);
    if (this.builds.length > 32) this.builds.shift();
  }

  /** Note one destruction tick's cost, ms, and the heaviest collapse build
   * in it (0 for none). */
  noteTick(ms: number, buildMs = 0): void {
    this.lastTick = ms;
    this.ticks[this.head] = ms;
    this.head = (this.head + 1) % LAB_STATS_WINDOW;
    this.nTicks = Math.min(LAB_STATS_WINDOW, this.nTicks + 1);
    if (buildMs > 0) this.builds.push(buildMs);
    if (this.builds.length > 32) this.builds.shift();
  }

  /** DS1: note one physics step's cost, ms. */
  notePhysics(ms: number): void {
    this.lastPhys = ms;
    this.phys[this.physHead] = ms;
    this.physHead = (this.physHead + 1) % LAB_STATS_WINDOW;
    this.nPhys = Math.min(LAB_STATS_WINDOW, this.nPhys + 1);
  }

  /** The telemetry message, at most every LAB_STATS_MS (null between). */
  stats(
    city: RoomCity,
    now: number,
  ): {
    last: number;
    p99: number;
    build: number;
    live: number;
    boxes: number;
    bodies?: number;
    budget?: number;
    physLast?: number;
    physP99?: number;
  } | null {
    if (now - this.lastSent < LAB_STATS_MS) return null;
    this.lastSent = now;
    const n = this.nTicks;
    const sorted = Array.from(this.ticks.subarray(0, n)).sort((a, b) => a - b);
    const p99 =
      n > 0 ? (sorted[Math.min(n - 1, Math.floor(n * 0.99))] ?? 0) : 0;
    let live = 0;
    let boxes = 0;
    for (const c of city.collapses.list) {
      boxes += c.n;
      if (c.phys) {
        // DS1: the pieces its bodies are moving now.
        if (c.phys.settled) continue;
        for (let i = 0; i < c.n; i++) {
          if (pieceMoving(c.phys.state(i, now))) live++;
        }
      } else if (now < c.t0 + c.endMs) live += c.n;
    }
    const round = (v: number) => Math.round(v * 1000) / 1000;
    const out = {
      last: round(this.lastTick),
      p99: round(p99),
      build: round(Math.max(0, ...this.builds)),
      live,
      boxes,
    };
    const physics = city.physics;
    if (!physics) return out;
    const np = this.nPhys;
    const ps = Array.from(this.phys.subarray(0, np)).sort((a, b) => a - b);
    return {
      ...out,
      bodies: physics.active,
      budget: physics.budget,
      physLast: round(this.lastPhys),
      physP99: round(
        np > 0 ? (ps[Math.min(np - 1, Math.floor(np * 0.99))] ?? 0) : 0,
      ),
    };
  }
}

/** Where the rounds come from: the lab's eye when it is in gun range of the
 * aim point, else a point out in front of the face the aim point is on. */
function shooterEye(b: Building, p: Vec3, eye: Vec3 | undefined): Vec3 {
  if (eye) {
    const d = Math.hypot(
      wrapDeltaAxis(eye.x, p.x),
      p.y - eye.y,
      wrapDeltaAxis(eye.z, p.z),
    );
    if (d > 1 && d < BULLET_RANGE * 0.9) return eye;
  }
  let nx = wrapDeltaAxis(b.x, p.x);
  let nz = wrapDeltaAxis(b.z, p.z);
  const len = Math.hypot(nx, nz) || 1;
  nx /= len;
  nz /= len;
  return canonicalize({ x: p.x + nx * 120, y: p.y + 10, z: p.z + nz * 120 });
}

/** A cruise missile's launch point: out along the line from the tower to
 * the aim point, and up. */
function missileFrom(b: Building, p: Vec3): Vec3 {
  let nx = wrapDeltaAxis(b.x, p.x);
  let nz = wrapDeltaAxis(b.z, p.z);
  const len = Math.hypot(nx, nz);
  if (len < 1) {
    nx = 1;
    nz = 0;
  } else {
    nx /= len;
    nz /= len;
  }
  return canonicalize({
    x: p.x + nx * MISSILE_RANGE_M,
    y: p.y + MISSILE_RISE_M,
    z: p.z + nz * MISSILE_RANGE_M,
  });
}

/** Small seeded jitter, −1..1. */
function jitter(seed: number, salt: number): number {
  let h =
    Math.imul(seed + 0x9e3779b9, 0x85ebca6b) ^ Math.imul(salt, 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x27d4eb2f);
  h ^= h >>> 13;
  return ((h >>> 0) / 4294967296) * 2 - 1;
}

/** One tick of sustained fire: SHOOT_ROUNDS_PER_TICK rays from `o` at `p`,
 * spread like a stream of tracers. */
function burst(city: RoomCity, o: Vec3, p: Vec3, seed: number): void {
  for (let r = 0; r < SHOOT_ROUNDS_PER_TICK; r++) {
    const tx =
      wrapDeltaAxis(o.x, p.x) + jitter(seed, r * 3 + 1) * SHOOT_SPREAD_M;
    const ty = p.y - o.y + jitter(seed, r * 3 + 2) * SHOOT_SPREAD_M;
    const tz =
      wrapDeltaAxis(o.z, p.z) + jitter(seed, r * 3 + 3) * SHOOT_SPREAD_M;
    const len = Math.hypot(tx, ty, tz) || 1;
    applyShotDamage(city, o, { x: tx / len, y: ty / len, z: tz / len }, null);
  }
}

/** D5's demolition of tower `b` (`style`, `dir`), recorded — null when
 * nothing above its bottom band still stands. */
function fell(
  city: RoomCity,
  b: number,
  style: number,
  dir: number,
  now: number,
): CollapseWire | null {
  const building = city.buildings[b];
  if (!building) return null;
  const plan = demolitionPlan(
    building,
    b,
    style === TOPPLE ? TOPPLE : PANCAKE,
    dir,
    city.tuning,
  );
  return plan ? stageCollapse(city, plan, b, now, null) : null;
}

/** Break chunk (tier 0, ix, iy, iz) of building `b` outright (D2 damage —
 * it joins the tick's batch and the planner sees it). */
function breakCell(
  city: RoomCity,
  b: number,
  ix: number,
  iy: number,
  iz: number,
): void {
  const building = city.buildings[b] as Building;
  const g = tierGrids(building)[0];
  if (!g || ix < 0 || iy < 0 || iz < 0) return;
  if (ix >= g.nx || iy >= g.ny || iz >= g.nz) return;
  city.damage.damageChunk(
    chunkId(b, 0, cellIndex(g, ix, iy, iz)),
    CHUNK_HP * 4,
  );
}

/** Cut away corner `corner`'s support: the wing along its x edge (the half
 * of the depth nearest it) loses its base and the slot beside it, so it is
 * left hanging and shears off (collapse.ts shearDir). A building too small
 * to have a wing loses that corner column's bottom two bands instead. */
function shearCorner(city: RoomCity, b: number, corner: number): void {
  const building = city.buildings[b] as Building;
  const g = tierGrids(building)[0];
  if (!g) return;
  const cx = corner & 1 ? g.nx - 1 : 0;
  const cz = corner & 2 ? g.nz - 1 : 0;
  if (g.nx < 3 || g.ny < 3) {
    breakCell(city, b, cx, 0, cz);
    breakCell(city, b, cx, 1, cz);
    return;
  }
  const half = Math.max(1, Math.floor(g.nz / 2));
  const z0 = corner & 2 ? g.nz - half : 0;
  const z1 = corner & 2 ? g.nz - 1 : half - 1;
  const inner = corner & 1 ? cx - 1 : cx + 1;
  for (let iz = z0; iz <= z1; iz++) {
    breakCell(city, b, cx, 0, iz);
    for (let iy = 0; iy < g.ny; iy++) breakCell(city, b, inner, iy, iz);
  }
  // The row past the wing's end, so it hangs free on that side too.
  const past = corner & 2 ? z0 - 1 : z1 + 1;
  if (past >= 0 && past < g.nz) {
    for (let iy = 0; iy < g.ny; iy++) breakCell(city, b, cx, iy, past);
  }
}

/** A demolition charge on tier 0's floor band `f`: every chunk of it. */
function floorCharge(city: RoomCity, b: number, f: number): void {
  const building = city.buildings[b] as Building;
  const g = tierGrids(building)[0];
  if (!g) return;
  for (let iz = 0; iz < g.nz; iz++) {
    for (let ix = 0; ix < g.nx; ix++) breakCell(city, b, ix, f, iz);
  }
}

/** DS1: floor band `f` of tier 0 blown out on the `dir` side — the two
 * thirds of its bays toward that side — so its columns fail there and the
 * column planner leans the tower over toward it (a hinge on the line of
 * the columns left standing). */
function leanCharge(city: RoomCity, b: number, f: number, dir: number): void {
  const building = city.buildings[b] as Building;
  const g = tierGrids(building)[0];
  if (!g) return;
  const alongX = dir === DIR_NEG_X || dir === DIR_POS_X;
  const n = alongX ? g.nx : g.nz;
  const keep = Math.max(1, Math.floor(n / 3));
  for (let iz = 0; iz < g.nz; iz++) {
    for (let ix = 0; ix < g.nx; ix++) {
      const i = alongX ? ix : iz;
      // Toward +: everything past the kept third; toward −: before it.
      const plus = dir === DIR_POS_X || dir === DIR_POS_Z;
      if (plus ? i >= keep : i < n - keep) breakCell(city, b, ix, f, iz);
    }
  }
}

const DIRS = [DIR_NEG_X, DIR_POS_X, DIR_NEG_Z, DIR_POS_Z] as const;

/** The direction (DIR_*) of tower `b`'s nearest neighbour it could reach
 * falling (within its height, across its own width), or +x. */
export function towardNeighbour(city: RoomCity, b: number): number {
  const self = city.buildings[b];
  if (!self) return DIR_POS_X;
  let best = DIR_POS_X;
  let bestD = Number.POSITIVE_INFINITY;
  city.buildings.forEach((o, i) => {
    if (i === b) return;
    const dx = wrapDeltaAxis(self.x, o.x);
    const dz = wrapDeltaAxis(self.z, o.z);
    for (const d of DIRS) {
      const alongX = d === DIR_NEG_X || d === DIR_POS_X;
      const sign = d === DIR_POS_X || d === DIR_POS_Z ? 1 : -1;
      const along = (alongX ? dx : dz) * sign;
      const across = Math.abs(alongX ? dz : dx);
      const reach = alongX ? o.width : o.depth;
      const lateral =
        (alongX ? self.depth + o.depth : self.width + o.width) / 2;
      if (along <= 0 || across > lateral) continue;
      const gap = along - (alongX ? self.width : self.depth) / 2 - reach / 2;
      if (gap > self.height * 0.9) continue;
      if (gap < bestD) {
        bestD = gap;
        best = d;
      }
    }
  });
  return best;
}

/** The towers of tower `b`'s block, in felling order along the block's
 * longer axis (starting from `b`'s end), each toppling toward the next
 * (the last one on, the same way). */
export function blockOrder(
  buildings: readonly Building[],
  b: number,
): { b: number; dir: number }[] {
  const self = buildings[b];
  if (!self) return [];
  const bx = Math.floor(self.x / BLOCK_PITCH);
  const bz = Math.floor(self.z / BLOCK_PITCH);
  const members: { i: number; x: number; z: number }[] = [];
  buildings.forEach((o, i) => {
    if (Math.floor(o.x / BLOCK_PITCH) !== bx) return;
    if (Math.floor(o.z / BLOCK_PITCH) !== bz) return;
    if (o.height < 30) return;
    members.push({
      i,
      x: wrapDeltaAxis(self.x, o.x),
      z: wrapDeltaAxis(self.z, o.z),
    });
  });
  if (members.length === 0) return [];
  const spanX =
    Math.max(...members.map((m) => m.x)) - Math.min(...members.map((m) => m.x));
  const spanZ =
    Math.max(...members.map((m) => m.z)) - Math.min(...members.map((m) => m.z));
  const alongX = spanX >= spanZ;
  const key = (m: { x: number; z: number }) => (alongX ? m.x : m.z);
  members.sort((p, q) => key(p) - key(q) || p.i - q.i);
  // Start from b's end: reverse when b sits in the far half.
  const at = members.findIndex((m) => m.i === b);
  if (at >= members.length / 2) members.reverse();
  return members.map((m, k) => {
    const next = members[k + 1] ?? members[k - 1];
    const towardPositive = next
      ? k + 1 < members.length
        ? key(next) > key(m)
        : key(m) > key(next)
      : true;
    const dir = alongX
      ? towardPositive
        ? DIR_POS_X
        : DIR_NEG_X
      : towardPositive
        ? DIR_POS_Z
        : DIR_NEG_Z;
    return { b: m.i, dir };
  });
}
