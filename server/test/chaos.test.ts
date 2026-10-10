// C2 constant chaos, end to end on the server's own directors: the boss is
// (nearly) always up, something breaks near the fight every few seconds,
// the city never rots past ~20 %, no player is singled out (the danger
// budget), nothing lethal comes without its warning, quakes and fires never
// start a collapse where a plane is, the schedules are deterministic, and
// AB_CHAOS=0 is an exact rollback.
//
// One room is simulated the way index.ts ticks it — gone-share hold,
// missiles (settle, land, launch), chaos, the D5 director, gunfire on the
// city, tickDestruction, rebuilds — with a scripted human and four
// wingmen circling low near the towers (they draw strikes), one of them
// respawning every 45 s. Coarse 250 ms ticks; the 60-min run is shared by
// the cadence, share, budget, telegraph and hold checks.

import {
  BOSS_TUNING,
  BOSS_WEAK_POINTS,
  type BossRaid,
  raidEnd,
  raidTier,
} from "@angels-bandits/common/boss";
import {
  CHAOS_CADENCE,
  CHAOS_METEOR,
  CHAOS_QUAKE,
  type ChaosLayer,
  QUAKE_LEAD_MS,
  chaosSlotsInWindow,
  decodeQuake,
  encodeQuake,
  holdNear,
} from "@angels-bandits/common/chaos";
import {
  type Building,
  chunkBuilding,
  generateCity,
  mulberry32,
} from "@angels-bandits/common/city";
import { generateMovers } from "@angels-bandits/common/city/movers";
import {
  CITY_SEED,
  DESTROY_CAP,
  DESTROY_CAP_D2,
} from "@angels-bandits/common/constants";
import {
  DIRECTOR_ACTION_M,
  DIRECTOR_WARN_MIN_MS,
} from "@angels-bandits/common/director";
import {
  MISSILE_TELEGRAPH_MIN_MS,
  type MissileStrike,
  decodeMissile,
  encodeMissile,
  missileImpactAt,
} from "@angels-bandits/common/strike";
import { NEXT_CARRIER_MS } from "@angels-bandits/common/waves";
import {
  type Vec3,
  wrapCoord,
  wrapDeltaAxis,
} from "@angels-bandits/common/world";
import { beforeAll, describe, expect, it } from "vitest";
import { BossDirector } from "../src/boss";
import {
  CHAOS_TUNING,
  ChaosDirector,
  type ChaosPlane,
  applyGoneHold,
  chaosTunings,
} from "../src/chaos";
import { nearBuildingProbe } from "../src/cityevents";
import { DANGER_TUNING, DangerBudget, type DangerLayer } from "../src/danger";
import {
  applyShotDamage,
  createRoomCity,
  tickDestruction,
} from "../src/destruction";
import {
  D5_TUNING,
  DESTRUCTION_TUNING,
  DestructionDirector,
  type DestructionPlane,
} from "../src/director";
import {
  DEFAULT_TUNING,
  type DirectorPlane,
  MissileDirector,
  X1_TUNING,
  applyMissileImpact,
} from "../src/strikes";

const SEED_CITY = generateCity(CITY_SEED);
const CRANES = generateMovers(CITY_SEED, SEED_CITY).cranes;
const T0 = 1_790_000_000_000;
const DT = 250;
const CENTRE = { x: 1000, z: 1000 };

/** Plan-view distance, torus-aware. */
const flat = (a: { x: number; z: number }, b: { x: number; z: number }) =>
  Math.hypot(wrapDeltaAxis(a.x, b.x), wrapDeltaAxis(a.z, b.z));

interface Flyer {
  id: string;
  human: boolean;
  r: number;
  y: number;
  speed: number;
  phase: number;
  cx: number;
  cz: number;
}

/** The scripted planes: a human circling the centre low among the towers,
 * four wingmen on their own circles around it. */
const FLYERS: Flyer[] = [
  {
    id: "human",
    human: true,
    r: 180,
    y: 70,
    speed: 50,
    phase: 0,
    cx: 0,
    cz: 0,
  },
  {
    id: "bot:a",
    human: false,
    r: 120,
    y: 60,
    speed: 55,
    phase: 1,
    cx: 60,
    cz: 0,
  },
  {
    id: "bot:b",
    human: false,
    r: 220,
    y: 90,
    speed: 60,
    phase: 2,
    cx: 0,
    cz: 70,
  },
  {
    id: "bot:c",
    human: false,
    r: 160,
    y: 110,
    speed: 52,
    phase: 3,
    cx: -80,
    cz: 0,
  },
  {
    id: "bot:d",
    human: false,
    r: 260,
    y: 80,
    speed: 58,
    phase: 4,
    cx: 0,
    cz: -60,
  },
];

function flyerAt(f: Flyer, t: number): { pos: Vec3; vel: Vec3 } {
  const w = f.speed / f.r;
  const a = f.phase + ((t - T0) / 1000) * w;
  return {
    pos: {
      x: wrapCoord(CENTRE.x + f.cx + f.r * Math.cos(a)),
      y: f.y,
      z: wrapCoord(CENTRE.z + f.cz + f.r * Math.sin(a)),
    },
    vel: { x: -f.speed * Math.sin(a), y: 0, z: f.speed * Math.cos(a) },
  };
}

interface Lethal {
  layer: DangerLayer;
  /** When it was announced, and when it hits. */
  warned: number;
  at: number;
  where: Vec3;
}

interface SimLog {
  /** Destruction near the action: landing / firing / collapse / quake times. */
  near: { t: number; kind: string }[];
  maxGone: number;
  lethal: Lethal[];
  quakes: { warned: number; t: number }[];
  /** Budget charges per plane: [time, layer]. */
  charges: Map<string, { t: number; layer: DangerLayer }[]>;
  /** Lethal things planned (or dropped) with a fresh plane near. */
  freshViolations: string[];
  /** Chunks quakes/fire broke on a building a plane was in reach of. */
  holdViolations: number;
  chaosBroke: number;
  /** Event lists for the determinism check. */
  trace: string[];
  mix: Record<string, number>;
}

/** One room, run the way index.ts ticks it, for `minutes`. */
function simulate(minutes: number, seed = 7): SimLog {
  const rc = createRoomCity(SEED_CITY, CRANES);
  const budget = new DangerBudget();
  const charges = new Map<string, { t: number; layer: DangerLayer }[]>();
  const charge = budget.charge.bind(budget);
  budget.charge = (layer, points, leadMs, now, planes) => {
    const ids = charge(layer, points, leadMs, now, planes);
    for (const id of ids) {
      const list = charges.get(id) ?? [];
      list.push({ t: now, layer });
      charges.set(id, list);
    }
    return ids;
  };
  const missiles = new MissileDirector(
    mulberry32(seed ^ 0x3155),
    DEFAULT_TUNING,
  );
  const chaos = new ChaosDirector(seed ^ 0xc4a05, CHAOS_TUNING);
  const director = new DestructionDirector(
    seed,
    mulberry32(seed ^ 0xd5d5),
    DESTRUCTION_TUNING,
  );
  const near = nearBuildingProbe(rc.buildings);
  const log: SimLog = {
    near: [],
    maxGone: 0,
    lethal: [],
    quakes: [],
    charges,
    freshViolations: [],
    holdViolations: 0,
    chaosBroke: 0,
    trace: [],
    mix: {},
  };
  const spawnedAt = new Map<string, number>();
  const noteSpawn = (id: string, pos: Vec3, t: number) => {
    spawnedAt.set(id, t);
    missiles.noteSpawn(id, pos, t);
    director.noteSpawn(id, t);
    budget.noteSpawn(id, t);
  };
  const fresh = (id: string, t: number) =>
    t - (spawnedAt.get(id) ?? Number.NEGATIVE_INFINITY) < 5000;
  const rand = mulberry32(seed ^ 0x9999);
  const human = (t: number) => flyerAt(FLYERS[0] as Flyer, t).pos;
  /** "Near the action" exactly as the D5 director means it: within
   * DIRECTOR_ACTION_M of an anchor — the human, or a plane within
   * DIRECTOR_ACTION_M of the human. */
  const noteNear = (t: number, kind: string, where: Vec3) => {
    const h = human(t);
    const anchored = FLYERS.some((f) => {
      const p = flyerAt(f, t).pos;
      return (
        flat(p, h) <= DIRECTOR_ACTION_M && flat(where, p) <= DIRECTOR_ACTION_M
      );
    });
    if (anchored) log.near.push({ t, kind });
    log.mix[kind] = (log.mix[kind] ?? 0) + 1;
  };
  /** A lethal thing planned at `t` for `where`, landing `lead` ms on: no
   * fresh plane may be near it (the budget's own nearness). */
  const checkFresh = (
    what: string,
    t: number,
    where: readonly Vec3[],
    lead: number,
    planes: readonly ChaosPlane[],
  ) => {
    for (const p of planes) {
      if (fresh(p.id, t) && budget.near(p, where, lead)) {
        log.freshViolations.push(`${what} at ${t - T0} near ${p.id}`);
      }
    }
  };
  for (const f of FLYERS) noteSpawn(f.id, flyerAt(f, T0).pos, T0 - 10_000);

  const end = T0 + minutes * 60_000;
  for (let t = T0; t < end; t += DT) {
    // A wingman respawns every 45 s (fresh for 5 s: nothing lethal near).
    if ((t - T0) % 45_000 === 0 && t > T0) {
      const f = FLYERS[1 + (((t - T0) / 45_000) % 4)] as Flyer;
      noteSpawn(f.id, flyerAt(f, t).pos, t);
    }
    const planes: ChaosPlane[] = FLYERS.map((f) => ({
      id: f.id,
      ...flyerAt(f, t),
      human: f.human,
      prot: fresh(f.id, t),
    }));
    applyGoneHold(rc);
    // Missiles (and meteors): land what is due, then launch.
    for (const m of missiles.settle(t)) {
      const broke = applyMissileImpact(rc, m);
      chaos.ignite(broke, t, rc);
      noteNear(
        t,
        m.kind === "cruise" || m.kind === "artillery" ? "missile" : m.kind,
        m.to,
      );
    }
    const dPlanes: DirectorPlane[] = planes.map((p) => ({
      ...p,
      eligible: true,
    }));
    const launched = missiles.tick(t, dPlanes, {
      nearBuilding: near,
      index: rc.index,
      buildings: rc.buildings,
      destroyedShare: rc.damage.destroyedCount / rc.damage.chunkCount,
      budget,
    });
    if (launched) {
      checkFresh("missile", t, [launched.to], 5000, planes);
      log.lethal.push({
        layer: "missile",
        warned: t,
        at: missileImpactAt(launched),
        where: launched.to,
      });
      log.trace.push(
        `M${launched.id}@${launched.t0}:${launched.to.x},${launched.to.z}`,
      );
    }
    const out = chaos.tick(t, planes, {
      city: rc,
      missiles,
      budget,
      index: rc.index,
    });
    for (const m of out.meteors) {
      checkFresh("meteor", t, [m.to], missileImpactAt(m) - t, planes);
      log.lethal.push({
        layer: "meteor",
        warned: t,
        at: missileImpactAt(m),
        where: m.to,
      });
      log.trace.push(`m${m.id}@${m.t0}:${m.to.x},${m.to.z}`);
    }
    for (const q of out.quakes) {
      log.quakes.push({ warned: t, t: q.t });
      log.trace.push(`Q${q.id}@${q.t}:${q.x},${q.z},${q.mag}`);
    }
    if (out.broke.length > 0) {
      log.chaosBroke += out.broke.length;
      for (const id of out.broke) {
        const b = rc.buildings[chunkBuilding(id)] as Building;
        if (holdNear(b, planes)) log.holdViolations++;
      }
    }
    for (const q of chaos.pendingQuakes()) {
      if (q.t > t - DT && q.t <= t) noteNear(t, "quake", human(t));
    }
    // D5: fire and warn, with the budget.
    const ds: DestructionPlane[] = planes.map((p) => ({
      id: p.id,
      pos: p.pos,
      vel: p.vel,
      human: p.human,
      protected: p.prot,
      ageMs: 0,
    }));
    const d = director.tick(t, ds, { city: rc, cranes: CRANES, budget });
    for (const e of d.warned) {
      log.lethal.push({
        layer: "director",
        warned: e.w,
        at: e.at,
        where: { x: e.x, y: 0, z: e.z },
      });
      log.trace.push(`D${e.id}@${e.at}:${e.k},${e.b}`);
    }
    for (const f of d.fired) noteNear(t, "director", f.event);
    // The fight's gunfire on the city (bot rounds, ~1 a second each).
    for (const p of planes) {
      if (rand() > DT / 1000) continue;
      const s = Math.hypot(p.vel.x, p.vel.y, p.vel.z);
      applyShotDamage(
        rc,
        p.pos,
        { x: p.vel.x / s, y: -0.1, z: p.vel.z / s },
        p.id,
      );
    }
    const { collapses } = tickDestruction(rc, t);
    for (const c of collapses) {
      const b = rc.buildings[c.b];
      if (b) noteNear(t, "collapse", { x: b.x, y: 0, z: b.z });
    }
    for (const r of director.rebuild(t, ds, {
      city: rc,
      cranes: CRANES,
      budget,
    })) {
      if (r.go && r.k === 0) chaos.rebuilt(r.b);
    }
    log.maxGone = Math.max(log.maxGone, rc.damage.goneShare);
  }
  return log;
}

let hour: SimLog;
beforeAll(() => {
  hour = simulate(60);
}, 600_000);

describe("C2 schedules are deterministic", () => {
  it("every layer's slots are pure in (seed, window), partition the timeline and keep their band", () => {
    for (const layer of [CHAOS_METEOR, CHAOS_QUAKE] as ChaosLayer[]) {
      const a = chaosSlotsInWindow(42, layer, 0, 3_600_000);
      expect(chaosSlotsInWindow(42, layer, 0, 3_600_000)).toEqual(a);
      // Abutting windows give the same slots as one long one.
      const split = [
        ...chaosSlotsInWindow(42, layer, 0, 1_234_567),
        ...chaosSlotsInWindow(42, layer, 1_234_567, 3_600_000),
      ];
      expect(split).toEqual(a);
      const [min, max] = CHAOS_CADENCE[layer] as readonly [number, number];
      for (let i = 1; i < a.length; i++) {
        const gap = (a[i] as number) - (a[i - 1] as number);
        expect(gap).toBeGreaterThanOrEqual(min - 1e-6);
        expect(gap).toBeLessThanOrEqual(max + 1e-6);
      }
      // Another seed is another timeline.
      expect(chaosSlotsInWindow(43, layer, 0, 3_600_000)).not.toEqual(a);
    }
  });

  it("the same seed and the same planes stage the same meteors, quakes, missiles and director events", () => {
    const a = simulate(4, 11).trace;
    const b = simulate(4, 11).trace;
    expect(a.length).toBeGreaterThan(20);
    expect(b).toEqual(a);
    expect(a.some((s) => s.startsWith("m"))).toBe(true);
    expect(a.some((s) => s.startsWith("Q"))).toBe(true);
  }, 300_000);

  it("quakes and every strike kind survive the wire bit for bit", () => {
    const q = { id: 3, t: T0 + 3000, dur: 5123, mag: 0.73, x: 12.3, z: 1999.9 };
    expect(decodeQuake(encodeQuake(q))).toEqual(q);
    for (const kind of ["cruise", "artillery", "meteor", "bomb"] as const) {
      const m: MissileStrike = {
        id: 4,
        kind,
        from: { x: 1.5, y: 900.1, z: 3.2 },
        to: { x: 4.4, y: 10, z: 5.5 },
        t0: T0,
      };
      expect(decodeMissile(encodeMissile(m))).toEqual(m);
    }
    // An unknown kind is refused, never guessed.
    expect(decodeMissile([1, 9, 0, 0, 0, 0, 0, 0, T0])).toBeNull();
  });
});

describe("the boss is always up", () => {
  const world = {
    buildings: SEED_CITY,
    index: createRoomCity(SEED_CITY).index,
  };

  it("is in the sky ≥ 90 % of a 30-min session nobody shoots it down in, the first 4–6 s after the human arrives", () => {
    const boss = new BossDirector(mulberry32(2), BOSS_TUNING);
    let up = 0;
    let ticks = 0;
    let first: number | null = null;
    for (let t = T0; t < T0 + 30 * 60_000; t += DT) {
      const out = boss.tick(t, true, [], world);
      if (out.started && first === null) first = out.started.t0;
      if (boss.activeRaid(t)) up++;
      ticks++;
    }
    expect(first).not.toBeNull();
    expect((first as number) - T0).toBeGreaterThanOrEqual(4000);
    expect((first as number) - T0).toBeLessThanOrEqual(6000 + DT);
    expect(up / ticks).toBeGreaterThanOrEqual(0.9);
  });

  it("W1: the next carrier comes 20 s after it is shot down, one tier up, after its sections have all landed", () => {
    const boss = new BossDirector(mulberry32(4), BOSS_TUNING);
    let raid: BossRaid | null = null;
    let t = T0;
    for (; !raid; t += DT) raid = boss.tick(t, true, [], world).started;
    // Shoot every weak point out a minute into the raid.
    t = raid.t0 + 60_000;
    boss.tick(t, true, [], world);
    let downAt: number | null = null;
    let landed: number | null = null;
    for (let k = 0; k < BOSS_WEAK_POINTS.length; k++) {
      for (let n = 0; n < 400; n++) {
        const hit = boss.damage("p", k, t, world);
        if (hit?.down) {
          downAt = hit.down.t;
          landed = hit.down.t + Math.max(...hit.down.pieces.map((p) => p.end));
        }
      }
    }
    if (downAt === null || landed === null) throw new Error("never went down");
    // Its sections are all down well inside the gap: the next carrier never
    // cuts the falling wreck short.
    expect(landed - downAt).toBeLessThan(NEXT_CARRIER_MS);
    let next: BossRaid | null = null;
    for (t += DT; t < downAt + 5 * 60_000 && !next; t += DT) {
      next = boss.tick(t, true, [], world).started;
    }
    if (!next) throw new Error("never came back");
    expect(next.t0 - downAt).toBeGreaterThanOrEqual(NEXT_CARRIER_MS);
    expect(next.t0 - downAt).toBeLessThanOrEqual(NEXT_CARRIER_MS + DT);
    expect(raidTier(next)).toBe(raidTier(raid) + 1);
    expect(next.hpScale).toBeGreaterThan(raid.hpScale);
    expect(raidEnd(next)).toBeGreaterThan(next.t0);
  });
});

describe("constant destruction, survivable (60-min room)", () => {
  it("something breaks near the action (within 400 m of the human or a plane in its fight) at least every 20 s — and every layer takes part", () => {
    const times = [T0, ...hour.near.map((e) => e.t)].sort((a, b) => a - b);
    let maxGap = 0;
    for (let i = 1; i < times.length; i++) {
      maxGap = Math.max(
        maxGap,
        (times[i] as number) - (times[i - 1] as number),
      );
    }
    console.log(
      `C2 60-min room: ${hour.near.length} destruction events near the action, max gap ${(maxGap / 1000).toFixed(1)} s; mix ${JSON.stringify(hour.mix)}; peak gone share ${(100 * hour.maxGone).toFixed(1)} %; ${hour.chaosBroke} chunks broken by quakes/fire`,
    );
    if (maxGap > 20_000) {
      for (let i = 1; i < times.length; i++) {
        const g = (times[i] as number) - (times[i - 1] as number);
        if (g > 15_000)
          console.log(
            `gap ${(g / 1000).toFixed(1)} s ending at +${((times[i] as number) - T0) / 1000} s`,
          );
      }
    }
    expect(maxGap).toBeLessThanOrEqual(20_000);
    for (const kind of ["missile", "meteor", "director", "collapse", "quake"]) {
      expect(hour.mix[kind] ?? 0).toBeGreaterThan(0);
    }
  });

  it("keeps the city's gone share (broken + fallen) at or under 20 %", () => {
    expect(hour.maxGone).toBeLessThanOrEqual(0.2);
  });

  it("never stages more lethal events near one plane than its budget allows", () => {
    const t = DANGER_TUNING;
    let charged = 0;
    for (const [, list] of hour.charges) {
      for (let i = 0; i < list.length; i++) {
        const at = (list[i] as { t: number }).t;
        const window = list.filter((c) => c.t > at - t.windowMs && c.t <= at);
        charged++;
        expect(window.length).toBeLessThanOrEqual(t.total);
        const layer = (list[i] as { layer: DangerLayer }).layer;
        expect(
          window.filter((c) => c.layer === layer).length,
        ).toBeLessThanOrEqual(t.perLayer[layer]);
      }
    }
    expect(charged).toBeGreaterThan(50);
    // Nothing lethal planned (or dropped) near a plane in its first 5 s.
    expect(hour.freshViolations).toEqual([]);
  });

  it("warns of every lethal event at least its floor ahead: strikes and meteors ≥ 1.8 s, director events and quakes ≥ 3 s", () => {
    const floor: Record<DangerLayer, number> = {
      missile: MISSILE_TELEGRAPH_MIN_MS,
      meteor: MISSILE_TELEGRAPH_MIN_MS,
      director: DIRECTOR_WARN_MIN_MS,
    };
    const seen = new Set<DangerLayer>();
    for (const e of hour.lethal) {
      seen.add(e.layer);
      expect(e.at - e.warned).toBeGreaterThanOrEqual(floor[e.layer]);
    }
    expect([...seen].sort()).toEqual(["director", "meteor", "missile"]);
    expect(hour.quakes.length).toBeGreaterThan(10);
    for (const q of hour.quakes) {
      expect(q.t - q.warned).toBeGreaterThanOrEqual(QUAKE_LEAD_MS);
      expect(QUAKE_LEAD_MS).toBeGreaterThanOrEqual(DIRECTOR_WARN_MIN_MS);
    }
  });

  it("quakes and fire never break a building a plane is in reach of (no unwarned collapse near anyone)", () => {
    expect(hour.chaosBroke).toBeGreaterThan(0);
    expect(hour.holdViolations).toBe(0);
  });
});

describe("the danger budget", () => {
  const plane = (id: string, x: number, prot = false) => ({
    id,
    pos: { x, y: 80, z: 500 },
    vel: { x: 0, y: 0, z: 0 },
    prot,
  });
  const at = (x: number): Vec3 => ({ x, y: 80, z: 500 });

  it("caps events near one plane per window, per layer, and leaves fresh planes alone", () => {
    const b = new DangerBudget();
    const p = [plane("a", 500)];
    expect(b.take("missile", [at(520)], 5000, T0, p)).toBe(true);
    expect(b.take("missile", [at(530)], 5000, T0 + 1000, p)).toBe(true);
    // Missiles' share is spent; another layer still may.
    expect(b.allows("missile", [at(540)], 5000, T0 + 2000, p)).toBe(false);
    expect(b.take("meteor", [at(540)], 4500, T0 + 2000, p)).toBe(true);
    expect(b.take("director", [at(540)], 3500, T0 + 3000, p)).toBe(true);
    expect(b.take("bomb", [at(540)], 2600, T0 + 3500, p)).toBe(true);
    // Five in the window: even an unspent layer is refused.
    expect(b.allows("cavein", [at(540)], 0, T0 + 4000, p)).toBe(false);
    // Far from the plane is not "near" it.
    expect(b.allows("missile", [at(800)], 5000, T0 + 4000, p)).toBe(true);
    // The window slides.
    expect(b.allows("cavein", [at(540)], 0, T0 + 31_000, p)).toBe(true);
    // Fresh: spawn-protected, or (re)spawned under 5 s ago.
    expect(
      b.allows("missile", [at(520)], 5000, T0, [plane("x", 500, true)]),
    ).toBe(false);
    b.noteSpawn("y", T0);
    expect(
      b.allows("missile", [at(520)], 5000, T0 + 4999, [plane("y", 500)]),
    ).toBe(false);
    expect(
      b.allows("missile", [at(520)], 5000, T0 + 5000, [plane("y", 500)]),
    ).toBe(true);
  });
});

describe("AB_CHAOS=0 is an exact rollback", () => {
  it("restores every pre-C2 tuning and switches the new layers, budget and hold off", () => {
    const off = chaosTunings({ AB_CHAOS: "0" });
    // W1: the carrier's schedule is the game loop, not a C2 layer.
    expect(off.boss).toEqual(BOSS_TUNING);
    expect(off.waves).toBe(true);
    expect(off.missile).toEqual(X1_TUNING);
    expect(off.missile.areaMinMs).toBe(20_000);
    expect(off.missile.maxInFlight).toBe(3);
    expect(off.director).toEqual(D5_TUNING);
    expect(off.director.slotScale).toBe(1);
    expect(off.director.rebuildMinMs).toBe(180_000);
    expect(off.destroyCap).toBe(DESTROY_CAP_D2);
    expect(DESTROY_CAP_D2).toBe(0.25);
    expect(off.chaos).toBeNull();
    expect(off.danger).toBeNull();
    expect(off.hold).toBe(false);
    const on = chaosTunings({});
    expect(on.boss).toEqual(BOSS_TUNING);
    expect(on.missile).toEqual(DEFAULT_TUNING);
    expect(on.director).toEqual(DESTRUCTION_TUNING);
    expect(on.chaos).toEqual(CHAOS_TUNING);
    expect(on.danger).toEqual(DANGER_TUNING);
    expect(on.destroyCap).toBe(DESTROY_CAP);
    expect(on.hold).toBe(true);
    expect(on.waves).toBe(true);
    // W1: AB_WAVES=0 switches the carrier war off, and nothing else.
    const calm = chaosTunings({ AB_WAVES: "0" });
    expect(calm.waves).toBe(false);
    expect({ ...calm, waves: true }).toEqual(on);
  });
});
