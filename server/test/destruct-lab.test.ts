// DL1 Destruction Lab, server side. Lab-only isolation: destruction tuning
// lands only in a Destruction Lab room — a normal room and a Flight Lab room
// refuse it, normal joins never land in one, a normal room city never
// stamps a wire and a normal field never reads a stamp. And every trigger
// goes through the room's real pipeline: what it breaks is planned by
// tickDestruction, what it fells is staged like the director's, its
// strikes are the missile director's, and the arena reset rebuilds it all.

import {
  type Building,
  generateCity,
  tierGrids,
} from "@angels-bandits/common/city";
import {
  CollapseField,
  DIR_POS_X,
  TOPPLE,
  demolitionPlan,
} from "@angels-bandits/common/city/collapse";
import { CITY_SEED } from "@angels-bandits/common/constants";
import { parseLabTrigger } from "@angels-bandits/common/destruct-lab";
import {
  DEFAULT_DESTRUCTION_TUNING,
  DESTRUCTION_TUNING_VERSION,
  destructionSpec,
  exportDestructionTuning,
  sanitizeDestructionTuning,
} from "@angels-bandits/common/destruction-tuning";
import type { MissileStrike } from "@angels-bandits/common/strike";
import { describe, expect, it } from "vitest";
import { DestructLab, blockOrder } from "../src/destruct-lab";
import {
  type RoomCity,
  createRoomCity,
  setLabCity,
  stageCollapse,
  tickDestruction,
} from "../src/destruction";
import { Room, RoomManager } from "../src/room";

const SEED_CITY = generateCity(CITY_SEED);
const T0 = 2_000_000;

/** A tall plain tower with a grid big enough for every trigger. */
const TOWER = SEED_CITY.findIndex((b) => {
  const g = tierGrids(b)[0];
  return !b.holes && b.height >= 120 && !!g && g.nx >= 3 && g.ny >= 4;
});

const tuned = sanitizeDestructionTuning({
  gravity: 16,
  slabStorey: 6,
  chainBlastDamage: 500,
  dustOpacity: 0.3,
});
const tunedMsg = () => JSON.parse(exportDestructionTuning(tuned));

function labCity(): RoomCity {
  const rc = createRoomCity(SEED_CITY);
  setLabCity(rc);
  rc.tuning = tuned;
  return rc;
}

/** A missile director stand-in that just records what it was handed. */
function strikes(): {
  allocId(): number;
  inject(s: MissileStrike): void;
  list: MissileStrike[];
} {
  let next = 1;
  const list: MissileStrike[] = [];
  return { allocId: () => next++, inject: (s) => list.push(s), list };
}

/** Run the room's destruction ticks from `from` to `to` at 20 Hz, lab steps
 * first (as index.ts does); returns every collapse wire started. */
function run(lab: DestructLab, rc: RoomCity, from: number, to: number) {
  const wires = [];
  for (let t = from; t <= to; t += 50) {
    wires.push(...lab.tickLab(rc, t).collapses);
    wires.push(...tickDestruction(rc, t).collapses);
  }
  return wires;
}

describe("DL1 lab-only isolation", () => {
  it("covers a usable tower", () => {
    expect(TOWER).toBeGreaterThanOrEqual(0);
  });

  it("a normal room and a Flight Lab room refuse destruction tuning; a Destruction Lab takes it", () => {
    const normal = new Room("room-1", CITY_SEED);
    expect(normal.applyLab({ destruct: tunedMsg() })).toBe(false);
    expect(normal.destructTuning).toEqual(DEFAULT_DESTRUCTION_TUNING);
    const flight = new Room("room-2", CITY_SEED, true);
    flight.applyLab({ destruct: tunedMsg() });
    expect(flight.destructTuning).toEqual(DEFAULT_DESTRUCTION_TUNING);
    const lab = new Room("room-3", CITY_SEED, true, true);
    expect(lab.applyLab({ destruct: tunedMsg() })).toBe(true);
    expect(lab.destructTuning).toEqual(tuned);
  });

  it("a Destruction Lab is always a lab room", () => {
    expect(() => new Room("room-4", CITY_SEED, false, true)).toThrow();
  });

  it("garbage destruction tuning is clamped or ignored by the shared importer", () => {
    const lab = new Room("room-3", CITY_SEED, true, true);
    lab.applyLab({
      destruct: {
        v: DESTRUCTION_TUNING_VERSION,
        d: { gravity: 1e9, slabStorey: "big", nope: 3, chainDepthMax: 2.6 },
      },
    });
    expect(lab.destructTuning.gravity).toBe(destructionSpec("gravity").max);
    expect(lab.destructTuning.slabStorey).toBe(
      DEFAULT_DESTRUCTION_TUNING.slabStorey,
    );
    expect(lab.destructTuning.chainDepthMax).toBe(3);
    expect("nope" in lab.destructTuning).toBe(false);
    const before = { ...lab.destructTuning };
    lab.applyLab({ destruct: { d: { gravity: 5 } } });
    lab.applyLab({ destruct: { v: DESTRUCTION_TUNING_VERSION + 1, d: {} } });
    lab.applyLab({ destruct: "nope" });
    expect(lab.destructTuning).toEqual(before);
  });

  it("normal joins never land in a Destruction Lab; lab joins share the lab cap", () => {
    const rooms = new RoomManager();
    const lab = rooms.joinLab("a", "A", true);
    expect(lab?.destruct).toBe(true);
    expect(lab?.lab).toBe(true);
    const normal = rooms.join("b", "B");
    expect(normal).not.toBe(lab);
    expect(normal.destruct).toBe(false);
    const flight = rooms.joinLab("c", "C");
    expect(flight?.destruct).toBe(false);
  });

  it("only a lab city stamps its wires, and only a lab field builds from the stamp", () => {
    const normal = createRoomCity(SEED_CITY);
    // Even holding a tuned object, a normal city stamps nothing.
    normal.tuning = tuned;
    const b = normal.buildings[TOWER] as Building;
    const plan = demolitionPlan(b, TOWER, TOPPLE, DIR_POS_X);
    expect(plan).not.toBeNull();
    if (!plan) return;
    const plain = stageCollapse(normal, plan, TOWER, T0, null);
    expect(plain.dt).toBeUndefined();
    const lab = labCity();
    const labPlan = demolitionPlan(
      lab.buildings[TOWER] as Building,
      TOWER,
      TOPPLE,
      DIR_POS_X,
      lab.tuning,
    );
    if (!labPlan) throw new Error("no plan");
    const stamped = stageCollapse(lab, labPlan, TOWER, T0, null);
    expect(stamped.dt).toEqual({ gravity: 16, slabStorey: 6 });
    // The lab room's own debris was built from the stamp…
    expect(lab.collapses.list.at(-1)?.g).toBe(16);
    // …a normal field fed the same wire builds today's debris…
    const field = new CollapseField();
    field.bind(createRoomCity(SEED_CITY).buildings);
    expect(field.add(stamped)?.g).toBe(DEFAULT_DESTRUCTION_TUNING.gravity);
    // …and a lab client's field builds exactly what the room collides with.
    const client = new CollapseField();
    client.lab = true;
    client.bind(createRoomCity(SEED_CITY).buildings);
    expect(client.add(stamped)).toEqual(lab.collapses.list.at(-1));
  });
});

describe("DL1 triggers run through the real pipeline", () => {
  const parse = (raw: unknown) => {
    const t = parseLabTrigger(raw, SEED_CITY);
    if (!t) throw new Error(`bad trigger ${JSON.stringify(raw)}`);
    return t;
  };
  const face = (i: number) => {
    const b = SEED_CITY[i] as Building;
    return { x: b.x + b.width / 2 + 0.5, y: 30, z: b.z };
  };

  it("parseLabTrigger refuses junk and clamps what it keeps", () => {
    expect(parseLabTrigger(null, SEED_CITY)).toBeNull();
    expect(parseLabTrigger({ k: "nuke", b: TOWER }, SEED_CITY)).toBeNull();
    expect(parseLabTrigger({ k: "pancake", b: -1 }, SEED_CITY)).toBeNull();
    expect(parseLabTrigger({ k: "bomb", b: TOWER }, SEED_CITY)).toBeNull();
    const t = parseLabTrigger({ k: "topple", b: TOWER, d: 99 }, SEED_CITY);
    expect(t?.d).toBe(3);
    const c = parseLabTrigger({ k: "charge", b: TOWER, f: 999 }, SEED_CITY);
    expect(c?.f).toBe(
      (tierGrids(SEED_CITY[TOWER] as Building)[0]?.ny ?? 1) - 1,
    );
  });

  it("pancake and topple stage a collapse at once, stamped", () => {
    for (const k of ["pancake", "topple"]) {
      const rc = labCity();
      const out = new DestructLab().trigger(
        rc,
        parse({ k, b: TOWER, d: 1 }),
        T0,
        strikes(),
      );
      expect(out.collapses.length, k).toBe(1);
      expect(out.collapses[0]?.dt).toBeDefined();
    }
  });

  it("a floor charge and a sheared corner break chunks the planner brings down", () => {
    for (const raw of [
      { k: "charge", b: TOWER, f: 1 },
      { k: "shear", b: TOWER, c: 3 },
    ]) {
      const rc = labCity();
      const lab = new DestructLab();
      lab.trigger(rc, parse(raw), T0, strikes());
      const wires = run(lab, rc, T0, T0 + 200);
      expect(wires.length, raw.k).toBeGreaterThan(0);
      expect(wires.every((w) => w.b === TOWER)).toBe(true);
    }
  });

  it("sustained fire plays out over SHOOT_MS and breaks chunks where it aims", () => {
    const rc = labCity();
    const lab = new DestructLab();
    const p = face(TOWER);
    lab.trigger(
      rc,
      parse({ k: "shoot", b: TOWER, p, o: { x: p.x + 80, y: 40, z: p.z } }),
      T0,
      strikes(),
    );
    expect(lab.pending).toBeGreaterThan(10);
    let broke = 0;
    for (let t = T0; t <= T0 + 2000; t += 50) {
      lab.tickLab(rc, t);
      broke += tickDestruction(rc, t).broke.length;
    }
    expect(lab.pending).toBe(0);
    expect(broke).toBeGreaterThan(0);
  });

  it("bomb and missile hand the room's missile director a strike at the aim point", () => {
    for (const k of ["bomb", "missile"]) {
      const s = strikes();
      const p = face(TOWER);
      const out = new DestructLab().trigger(
        labCity(),
        parse({ k, b: TOWER, p }),
        T0,
        s,
      );
      expect(s.list).toHaveLength(1);
      expect(out.missiles).toEqual(s.list);
      expect(s.list[0]?.kind).toBe(k === "bomb" ? "bomb" : "cruise");
      expect(s.list[0]?.to.x).toBeCloseTo(p.x, 6);
    }
  });

  it("a chain across the block fells every tower of the block in turn", () => {
    const order = blockOrder(SEED_CITY, TOWER);
    const rc = labCity();
    const lab = new DestructLab();
    lab.trigger(rc, parse({ k: "chain", b: TOWER }), T0, strikes());
    expect(lab.pending).toBe(order.length);
    const wires = run(lab, rc, T0, T0 + order.length * 1500);
    const felled = new Set(wires.map((w) => w.b));
    for (const o of order) expect(felled.has(o.b)).toBe(true);
  });

  it("hitting the neighbour queues chain impacts on another building", () => {
    const rc = labCity();
    new DestructLab().trigger(
      rc,
      parse({ k: "neighbour", b: TOWER }),
      T0,
      strikes(),
    );
    expect(rc.collapses.list.length).toBe(1);
    expect(rc.impacts.length).toBeGreaterThan(0);
    expect(rc.impacts.every((i) => i.building !== TOWER)).toBe(true);
  });

  it("the arena reset rebuilds everything that broke or fell", () => {
    const rc = labCity();
    const lab = new DestructLab();
    lab.trigger(rc, parse({ k: "topple", b: TOWER, d: 0 }), T0, strikes());
    lab.trigger(
      rc,
      parse({
        k: "charge",
        b: TOWER + 1 < SEED_CITY.length ? TOWER + 1 : 0,
        f: 0,
      }),
      T0,
      strikes(),
    );
    run(lab, rc, T0, T0 + 6000);
    expect(rc.collapses.records.length).toBeGreaterThan(0);
    const wires = lab.reset(rc, T0 + 7000);
    expect(wires.length).toBeGreaterThan(0);
    expect(rc.collapses.records.length).toBe(0);
    expect(rc.damage.destroyedCount + rc.damage.fallenCount).toBe(0);
    expect(rc.buildings.every((b) => !b.damage)).toBe(true);
  });

  it("telemetry reports the tick's cost, its p99, the live pieces and the boxes", () => {
    const rc = labCity();
    const lab = new DestructLab();
    lab.trigger(rc, parse({ k: "pancake", b: TOWER }), T0, strikes());
    for (let k = 0; k < 100; k++) lab.noteTick(k === 50 ? 9 : 0.2);
    const s = lab.stats(rc, T0 + 500);
    expect(s?.boxes).toBe(rc.collapses.list[0]?.n);
    expect(s?.live).toBe(s?.boxes);
    expect(s?.p99).toBeGreaterThanOrEqual(0.2);
    expect(lab.stats(rc, T0 + 600)).toBeNull();
  });
});
