// D5 destruction director on the server: it picks near the fight (and
// prefers a tower with a plane alongside, toppling it across that plane's
// path, and towers X1 strikes have softened), always warns ≥ 3 s ahead,
// never fires on a fresh spawn, keeps the city standing over an hour of
// heavy fighting (the rebuild cycle), and every client — live or joining
// late — holds exactly the server's city throughout.

import {
  type Building,
  CityDamage,
  chunkBuilding,
  generateCity,
  makeBuilding,
  solids,
  tierGrids,
} from "@angels-bandits/common/city";
import { mulberry32 } from "@angels-bandits/common/city";
import {
  type Collapse,
  CollapseField,
  type CollapseImpact,
  type CollapseWire,
  TOPPLE,
  buildCollapse,
  collapseChunks,
  collapseImpacts,
  collapseWire,
  demolitionPlan,
} from "@angels-bandits/common/city/collapse";
import {
  type CraneSite,
  generateMovers,
} from "@angels-bandits/common/city/movers";
import { CITY_SEED } from "@angels-bandits/common/constants";
import {
  DIRECTOR_ACTION_M,
  DIRECTOR_NEAR_M,
  DIRECTOR_PATH_S,
  DIRECTOR_WARN_MIN_MS,
  type DirectorEvent,
  EVENT_COLLAPSE,
  EVENT_CRANE,
  EVENT_GAS,
  type RebuildWire,
  fallFootprint,
  inDangerZone,
  pathCrossing,
} from "@angels-bandits/common/director";
import {
  MISSILE_CHUNK_DAMAGE,
  MISSILE_CHUNK_RADIUS,
} from "@angels-bandits/common/strike";
import {
  type Vec3,
  canonicalize,
  wrapDelta,
  wrapDeltaAxis,
} from "@angels-bandits/common/world";
import { describe, expect, it } from "vitest";
import {
  type RoomCity,
  applyDeathBlast,
  applyShotDamage,
  createRoomCity,
  rebuildBuilding,
  stageCollapse,
  tickDestruction,
} from "../src/destruction";
import {
  DESTRUCTION_FAST,
  DESTRUCTION_TUNING,
  DestructionDirector,
  type DestructionPlane,
  type DestructionTuning,
} from "../src/director";

const SEED_CITY = generateCity(CITY_SEED);
const CRANES = generateMovers(CITY_SEED, SEED_CITY).cranes;
const T0 = 1_790_000_000_000;
const TOWERS_ONLY: DestructionTuning = {
  ...DESTRUCTION_TUNING,
  craneShare: 0,
  gasShare: 0,
};

const gapTo = (b: Building, p: Vec3): number =>
  Math.hypot(
    Math.max(Math.abs(wrapDeltaAxis(b.x, p.x)) - b.width / 2, 0),
    Math.max(Math.abs(wrapDeltaAxis(b.z, p.z)) - b.depth / 2, 0),
  );

const isTower = (b: Building): boolean =>
  b.height >= 80 && (tierGrids(b)[0]?.ny ?? 0) >= 3 && !b.holes;

function plane(
  id: string,
  pos: Vec3,
  vel: Vec3,
  human = true,
): DestructionPlane {
  return { id, pos, vel, human, protected: false, ageMs: 0 };
}

/** A director's pick against `rc` with `planes`, seeded `seed`. */
function pickWith(
  rc: RoomCity,
  planes: DestructionPlane[],
  seed: number,
  tuning = TOWERS_ONLY,
): DirectorEvent | null {
  const d = new DestructionDirector(CITY_SEED, mulberry32(seed), tuning);
  return d.pick(T0, planes, { city: rc, cranes: CRANES });
}

describe("the director's pick", () => {
  const rc = createRoomCity(SEED_CITY, CRANES);
  const tower = SEED_CITY.findIndex(isTower);
  const b = SEED_CITY[tower] as Building;

  it("is near the action, prefers a tower with a plane alongside, and topples it across the plane's 3 s path", () => {
    // 50 m off the tower's −x face at 40 m, flying along it (+z) at 100 m/s.
    const pos = canonicalize({ x: b.x - b.width / 2 - 50, y: 40, z: b.z - 60 });
    const p = plane("h1", pos, { x: 0, y: 0, z: 100 });
    for (let seed = 1; seed <= 12; seed++) {
      const e = pickWith(rc, [p], seed);
      expect(e).not.toBeNull();
      const ev = e as DirectorEvent;
      expect(ev.k).toBe(EVENT_COLLAPSE);
      const target = rc.buildings[ev.b] as Building;
      expect(gapTo(target, pos)).toBeLessThanOrEqual(DIRECTOR_ACTION_M);
      expect(gapTo(target, pos)).toBeLessThanOrEqual(DIRECTOR_NEAR_M);
      expect(ev.at - ev.w).toBeGreaterThanOrEqual(DIRECTOR_WARN_MIN_MS);
      // The chosen azimuth's REAL debris crosses the projected 3 s path.
      expect(ev.s).toBe(TOPPLE);
      const plan = demolitionPlan(target, ev.b, TOPPLE, ev.d);
      const c = buildCollapse(
        rc.buildings,
        collapseWire(plan as NonNullable<typeof plan>, ev.b, 1, ev.at),
      );
      const fp = c && fallFootprint(c, target);
      expect(fp).not.toBeNull();
      expect(
        pathCrossing(
          fp as NonNullable<typeof fp>,
          target.x,
          target.z,
          p.pos,
          p.vel,
          DIRECTOR_PATH_S,
        ),
      ).toBeGreaterThan(0);
      // The plane is inside the warned danger zone (bots refuse to enter).
      expect(inDangerZone(ev, { ...pos, z: pos.z + 60 }, 0)).toBe(true);
    }
  });

  it("stays away from a fight with no human in it, and from planes far from every tower", () => {
    const bot = plane(
      "bot:1",
      { x: b.x - b.width / 2 - 50, y: 40, z: b.z },
      {
        x: 0,
        y: 0,
        z: 100,
      },
      false,
    );
    expect(pickWith(rc, [bot], 1)).toBeNull();
    // Over the river, high above: nothing within 400 m to bring down.
    const high = plane(
      "h1",
      { x: 1000, y: 900, z: 1100 },
      { x: 0, y: 0, z: 0 },
    );
    const e = pickWith(rc, [high], 1);
    if (e) {
      expect(
        gapTo(rc.buildings[e.b] as Building, high.pos),
      ).toBeLessThanOrEqual(DIRECTOR_ACTION_M);
    }
  });

  it("prefers a tower softened by X1 strikes", () => {
    // Two towers close together; a plane hovering between them.
    let pair: [number, number] | null = null;
    for (let i = 0; i < SEED_CITY.length && !pair; i++) {
      const a = SEED_CITY[i] as Building;
      if (!isTower(a)) continue;
      for (let j = i + 1; j < SEED_CITY.length; j++) {
        const c = SEED_CITY[j] as Building;
        if (!isTower(c)) continue;
        const d = wrapDelta({ x: a.x, y: 0, z: a.z }, { x: c.x, y: 0, z: c.z });
        if (Math.hypot(d.x, d.z) < 120) {
          pair = [i, j];
          break;
        }
      }
    }
    expect(pair).not.toBeNull();
    const [i, j] = pair as [number, number];
    const a = SEED_CITY[i] as Building;
    const d = wrapDelta({ x: a.x, y: 0, z: a.z }, SEED_CITY[j] as Building);
    const mid = canonicalize({ x: a.x + d.x / 2, y: 260, z: a.z + d.z / 2 });
    const p = plane("h1", mid, { x: 0, y: 0, z: 0 });
    const share = (city: RoomCity, k: number) => {
      let n = 0;
      for (let seed = 1; seed <= 60; seed++) {
        if (pickWith(city, [p], seed)?.b === k) n++;
      }
      return n / 60;
    };
    const plain = createRoomCity(SEED_CITY, CRANES);
    const before = share(plain, j);
    // One X1 strike on tower j's facade (the server's own impact path).
    const struck = createRoomCity(SEED_CITY, CRANES);
    const bj = struck.buildings[j] as Building;
    struck.damage.damageAt(
      { x: bj.x + bj.width / 2, y: 30, z: bj.z },
      MISSILE_CHUNK_RADIUS,
      MISSILE_CHUNK_DAMAGE,
    );
    const after = share(struck, j);
    expect(after).toBeGreaterThanOrEqual(0.5);
    expect(after).toBeGreaterThan(before + 0.2);
  });

  it("never warns with a fresh spawn in the zone, and calls an event off if one turns up", () => {
    const pos = canonicalize({ x: b.x - b.width / 2 - 50, y: 40, z: b.z - 60 });
    const live = plane("h1", pos, { x: 0, y: 0, z: 100 });
    const city = createRoomCity(SEED_CITY, CRANES);
    const d = new DestructionDirector(CITY_SEED, mulberry32(3), TOWERS_ONLY);
    const e = d.pick(T0, [live], { city, cranes: CRANES }) as DirectorEvent;
    expect(e).not.toBeNull();
    // A protected plane parked in that zone blocks the same pick.
    const fresh = {
      ...plane("h2", { x: e.x, y: 30, z: e.z }, { x: 0, y: 0, z: 0 }),
      protected: true,
    };
    const again = new DestructionDirector(
      CITY_SEED,
      mulberry32(3),
      TOWERS_ONLY,
    );
    const blocked = again.pick(T0, [live, fresh], { city, cranes: CRANES });
    if (blocked) expect(inDangerZone(blocked, fresh.pos, 30)).toBe(false);
    // Warned, then someone respawns inside before it fires: called off.
    (d as unknown as { warned: DirectorEvent[] }).warned.push(e);
    d.noteSpawn("h3", e.at - 1000);
    const spawned = plane(
      "h3",
      { x: e.x, y: 30, z: e.z },
      { x: 0, y: 0, z: 0 },
    );
    const tick = d.tick(e.at, [live, spawned], { city, cranes: CRANES });
    expect(tick.cancelled.map((c) => c.id)).toEqual([e.id]);
    expect(tick.fired).toEqual([]);
    expect(city.collapses.list).toHaveLength(0);
  });
});

/** Planes circling low through the towers near `centres`, 80 m/s. */
function circling(centres: readonly Vec3[], t: number): DestructionPlane[] {
  return centres.map((c, k) => {
    const r = 140 + 30 * k;
    const w = 80 / r;
    const a = (t / 1000) * w + k;
    return plane(
      `h${k}`,
      canonicalize({
        x: c.x + r * Math.cos(a),
        y: 45 + 10 * k,
        z: c.z + r * Math.sin(a),
      }),
      { x: -80 * Math.sin(a), y: 0, z: 80 * Math.cos(a) },
    );
  });
}

/** One server tick as index.ts runs it, returning the messages it would
 * broadcast in order. */
function serverTick(
  rc: RoomCity,
  director: DestructionDirector,
  planes: DestructionPlane[],
  now: number,
): {
  warned: DirectorEvent[];
  fired: DirectorEvent[];
  msgs: (
    | { type: "chunks"; ids: number[] }
    | { type: "collapse"; c: CollapseWire }
    | { type: "rebuild"; r: RebuildWire }
  )[];
} {
  const world = { city: rc, cranes: CRANES };
  const d = director.tick(now, planes, world);
  const { broke, collapses } = tickDestruction(rc, now);
  const msgs: ReturnType<typeof serverTick>["msgs"] = [];
  if (broke.length > 0) msgs.push({ type: "chunks", ids: broke });
  for (const f of d.fired) {
    if (f.collapse) msgs.push({ type: "collapse", c: f.collapse });
  }
  for (const c of collapses) msgs.push({ type: "collapse", c });
  for (const r of director.rebuild(now, planes, world)) {
    msgs.push({ type: "rebuild", r });
  }
  return { warned: d.warned, fired: d.fired.map((f) => f.event), msgs };
}

/** A client's copy of the room city (fresh clone, cranes bound). */
function clientCity(): {
  buildings: Building[];
  damage: CityDamage;
  field: CollapseField;
} {
  const buildings = SEED_CITY.map((b) =>
    makeBuilding({ ...b, damage: undefined }),
  );
  const damage = new CityDamage();
  damage.bind(buildings);
  const field = new CollapseField();
  field.bind(buildings);
  field.bindCranes(CRANES);
  return { buildings, damage, field };
}

/** What every client does with a message (client/src/net/socket.ts). */
function applyMsg(
  c: ReturnType<typeof clientCity>,
  m: ReturnType<typeof serverTick>["msgs"][number],
): void {
  if (m.type === "chunks") c.damage.apply(m.ids);
  else if (m.type === "collapse") {
    c.damage.collapse(collapseChunks(m.c));
    c.field.add(m.c);
  } else if (m.r.go) {
    if (m.r.k === 0) {
      c.damage.restoreBuilding(m.r.b);
      c.field.removeBuilding(m.r.b);
    } else {
      c.field.removeCrane(m.r.b);
    }
  }
}

/** Every building's gone cells, as one comparable signature. */
const signature = (buildings: readonly Building[]): string[] =>
  buildings.map((b) =>
    b.damage ? b.damage.cells.map((c) => Array.from(c).join("")).join("|") : "",
  );

describe("the director over time", () => {
  it("warns every event ≥ 3 s before it happens, and late joiners match live clients throughout", () => {
    const rc = createRoomCity(SEED_CITY, CRANES);
    const tuning: DestructionTuning = {
      ...DESTRUCTION_FAST,
      craneShare: 0.35,
      gasShare: 0.3,
    };
    const director = new DestructionDirector(CITY_SEED, mulberry32(11), tuning);
    const live = clientCity();
    const towers = SEED_CITY.filter(isTower).slice(0, 40);
    const centres: Vec3[] = [
      { x: (CRANES[0] as CraneSite).x, y: 0, z: (CRANES[0] as CraneSite).z },
      { x: (towers[5] as Building).x, y: 0, z: (towers[5] as Building).z },
      { x: (towers[20] as Building).x, y: 0, z: (towers[20] as Building).z },
    ];
    const warnedAt = new Map<number, number>();
    const firedAt = new Map<number, number>();
    const kinds = new Set<number>();
    let rebuilt = 0;
    const rand = mulberry32(5);
    const DT = 100;
    for (let t = T0; t < T0 + 20 * 60_000; t += DT) {
      const planes = circling(centres, t);
      // Gunfire along each plane's heading.
      for (const p of planes) {
        if (rand() < 0.3) {
          const s = Math.hypot(p.vel.x, p.vel.y, p.vel.z);
          applyShotDamage(
            rc,
            p.pos,
            { x: p.vel.x / s, y: -0.05, z: p.vel.z / s },
            p.id,
          );
        }
      }
      const out = serverTick(rc, director, planes, t);
      for (const e of out.warned) {
        warnedAt.set(e.id, t);
        expect(e.at - e.w).toBeGreaterThanOrEqual(DIRECTOR_WARN_MIN_MS);
      }
      for (const e of out.fired) {
        firedAt.set(e.id, t);
        kinds.add(e.k);
      }
      for (const m of out.msgs) {
        if (m.type === "rebuild" && m.r.go) rebuilt++;
        applyMsg(live, m);
      }
      // Every 30 s: a late joiner from the welcome equals the live client,
      // and both equal the server.
      if ((t - T0) % 30_000 === 0) {
        const late = clientCity();
        late.damage.reset(rc.damage.destroyedIds());
        late.field.reset(rc.collapses.records);
        for (const w of rc.collapses.records) {
          late.damage.collapse(collapseChunks(w));
        }
        const server = signature(rc.buildings);
        expect(signature(live.buildings)).toEqual(server);
        expect(signature(late.buildings)).toEqual(server);
        const ids = rc.collapses.list.map((c) => c.id);
        expect(live.field.list.map((c) => c.id)).toEqual(ids);
        expect(late.field.list.map((c) => c.id)).toEqual(ids);
        expect([...live.field.felled]).toEqual([...rc.collapses.felled]);
        expect([...late.field.felled]).toEqual([...rc.collapses.felled]);
      }
    }
    expect(firedAt.size).toBeGreaterThanOrEqual(10);
    for (const [id, t] of firedAt) {
      const w = warnedAt.get(id);
      expect(w).toBeDefined();
      expect(t - (w as number)).toBeGreaterThanOrEqual(DIRECTOR_WARN_MIN_MS);
    }
    expect(kinds.has(EVENT_COLLAPSE)).toBe(true);
    expect(kinds.has(EVENT_GAS)).toBe(true);
    expect(kinds.has(EVENT_CRANE)).toBe(true);
    expect(rebuilt).toBeGreaterThan(0);
  }, 300_000);

  it("keeps the destroyed share of the city under 15 % over a 60-minute fight", () => {
    const rc = createRoomCity(SEED_CITY, CRANES);
    const director = new DestructionDirector(
      CITY_SEED,
      mulberry32(21),
      DESTRUCTION_TUNING,
    );
    const towers = SEED_CITY.filter(isTower);
    const centres = [3, 17, 31, 48, 66, 90].map((k) => {
      const b = towers[k % towers.length] as Building;
      return { x: b.x, y: 0, z: b.z };
    });
    const rand = mulberry32(9);
    let maxShare = 0;
    let fired = 0;
    let rebuilt = 0;
    const DT = 250;
    for (let t = T0; t < T0 + 60 * 60_000; t += DT) {
      const planes = circling(centres, t);
      // The fight: every plane firing along its heading (bot gunfire, ~4
      // rounds/s), an X1-sized strike every ~20 s and a wreck/death blast
      // every ~30 s near a random plane.
      for (const p of planes) {
        const s = Math.hypot(p.vel.x, p.vel.y, p.vel.z);
        applyShotDamage(
          rc,
          p.pos,
          { x: p.vel.x / s, y: -0.1, z: p.vel.z / s },
          p.id,
        );
      }
      if (rand() < DT / 20_000) {
        const p = planes[
          Math.floor(rand() * planes.length)
        ] as DestructionPlane;
        rc.damage.damageAt(
          { x: p.pos.x + 30, y: p.pos.y, z: p.pos.z },
          MISSILE_CHUNK_RADIUS,
          MISSILE_CHUNK_DAMAGE,
        );
      }
      if (rand() < DT / 30_000) {
        const p = planes[
          Math.floor(rand() * planes.length)
        ] as DestructionPlane;
        applyDeathBlast(rc, { x: p.pos.x, y: 20, z: p.pos.z });
      }
      const out = serverTick(rc, director, planes, t);
      fired += out.fired.length;
      for (const m of out.msgs) if (m.type === "rebuild" && m.r.go) rebuilt++;
      const d = rc.damage;
      maxShare = Math.max(
        maxShare,
        (d.destroyedCount + d.fallenCount) / d.chunkCount,
      );
    }
    console.log(
      `D5 60-min fight: ${fired} director events, ${rebuilt} rebuilds, peak destroyed share ${(100 * maxShare).toFixed(2)} %`,
    );
    expect(fired).toBeGreaterThanOrEqual(10);
    expect(rebuilt).toBeGreaterThan(10);
    expect(maxShare).toBeLessThanOrEqual(0.15);
  }, 600_000);
});

describe("chain reactions", () => {
  it("a tower toppled into a neighbour breaks it where the debris drives in, credited like the collapse", () => {
    const rc = createRoomCity(SEED_CITY, CRANES);
    let staged: { i: number; c: Collapse; hits: CollapseImpact[] } | null =
      null;
    for (let i = 0; i < rc.buildings.length && !staged; i++) {
      const b = rc.buildings[i] as Building;
      if (!isTower(b)) continue;
      for (const dir of [0, 1, 2, 3]) {
        const plan = demolitionPlan(b, i, TOPPLE, dir);
        const c =
          plan && buildCollapse(rc.buildings, collapseWire(plan, i, 0, T0));
        const hits = c ? collapseImpacts(c, rc.buildings) : [];
        if (c && plan && hits.length >= 2) {
          stageCollapse(rc, plan, i, T0, "p1");
          staged = { i, c, hits };
          break;
        }
      }
    }
    expect(staged).not.toBeNull();
    const { i, c, hits } = staged as NonNullable<typeof staged>;
    expect(rc.impacts.length).toBe(hits.length);
    const struck = new Set(hits.map((h) => h.building));
    const broke: number[] = [];
    for (let t = T0; t <= T0 + c.endMs + 1000; t += 50) {
      broke.push(...tickDestruction(rc, t).broke);
    }
    expect(rc.impacts).toHaveLength(0);
    const hitBuildings = new Set(broke.map(chunkBuilding));
    expect(hitBuildings.size).toBeGreaterThan(0);
    for (const j of hitBuildings) {
      expect(j).not.toBe(i);
      expect(struck.has(j)).toBe(true);
      expect(rc.breakers.get(j)).toBe("p1");
    }
    // Rebuilding the toppled tower drops what its debris still had queued.
    const again = createRoomCity(SEED_CITY, CRANES);
    const plan = demolitionPlan(
      again.buildings[i] as Building,
      i,
      c.style,
      c.dir,
    );
    stageCollapse(again, plan as NonNullable<typeof plan>, i, T0, null);
    expect(again.impacts.length).toBeGreaterThan(0);
    rebuildBuilding(again, i);
    expect(again.impacts).toHaveLength(0);
    expect(again.collapses.list).toHaveLength(0);
  });
});

describe("the rebuild never lands on a plane", () => {
  it("defers while a plane's projected path is inside the building", () => {
    const rc = createRoomCity(SEED_CITY, CRANES);
    const tower = SEED_CITY.findIndex(isTower);
    const b = rc.buildings[tower] as Building;
    const plan = demolitionPlan(b, tower, TOPPLE, 1);
    const w = collapseWire(plan as NonNullable<typeof plan>, tower, 1, T0);
    rc.damage.collapse(collapseChunks(w));
    rc.collapses.add(w);
    rc.firstDamageAt.set(tower, T0);
    rc.lastStructuralAt.set(tower, T0);
    const director = new DestructionDirector(
      CITY_SEED,
      mulberry32(1),
      DESTRUCTION_FAST,
    );
    const world = { city: rc, cranes: CRANES };
    // Hovering in the void where the tower's top was.
    const inside = plane(
      "h1",
      { x: b.x, y: b.height - 10, z: b.z },
      { x: 0, y: 0, z: 0 },
    );
    const late = T0 + 10 * 60_000;
    expect(director.rebuild(late, [inside], world)).toEqual([]);
    // Gone: announced, then applied once its lead has passed.
    const away = plane(
      "h1",
      { x: b.x + 600, y: 300, z: b.z },
      { x: 0, y: 0, z: 0 },
    );
    const announce = director.rebuild(late + 1000, [away], world);
    expect(announce).toEqual([{ k: 0, b: tower, at: late + 3000, go: false }]);
    // Back inside at the apply instant: still held.
    expect(director.rebuild(late + 3000, [inside], world)).toEqual([]);
    const applied = director.rebuild(late + 4000, [away], world);
    expect(applied).toEqual([{ k: 0, b: tower, at: late + 4000, go: true }]);
    expect(b.damage).toBeUndefined();
    expect(rc.collapses.list).toHaveLength(0);
    expect(solids(b)).toEqual(solids(SEED_CITY[tower] as Building));
  });
});
