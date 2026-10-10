// D9 destructible props on the server (server/src/destruction.ts): a round
// downs a lamp and it goes out in the tick's batch; a street of parked cars
// blows link by link and stops at PROP_CHAIN_DEPTH_MAX, with every blast's
// instant on the wire; a seeded minute of random blasts never breaks a
// per-tick or room cap; a toppled tower crushes what it lands on; a shot
// crane is warned by the director before it falls; street props repair on
// time, roof props with their building, and a fallen span only when clear
// of planes; a falling tank credits whoever shot it; a late joiner's replay
// is the live state, a blast still to land included; and a course run
// through a fallen span is not "through the ground".

import { type Building, generateCity } from "@angels-bandits/common/city";
import { mulberry32 } from "@angels-bandits/common/city";
import { blankPose } from "@angels-bandits/common/city/collapse";
import {
  DIR_NEG_X,
  TOPPLE,
  demolitionPlan,
} from "@angels-bandits/common/city/collapse";
import { generateMovers } from "@angels-bandits/common/city/movers";
import {
  PROP_BLASTS_PER_TICK,
  PROP_BRIDGE,
  PROP_CAR,
  PROP_CHAIN_DEPTH_MAX,
  PROP_CRANE,
  PROP_DOWN_CAP,
  PROP_DOWN_PER_TICK,
  PROP_FUEL,
  PROP_HP,
  PROP_LAMP,
  PROP_TANK,
  type Prop,
  type PropDown,
  PropState,
  SPAN_REPAIR_LEAD_MS,
  SPAN_REPAIR_MS,
  buildPropLayout,
  decodeIdRecords,
  fallSeconds,
  generateProps,
  propFuseMs,
  propPieceInto,
  propRepairMs,
} from "@angels-bandits/common/city/props";
import { RIVER_CENTER_Z } from "@angels-bandits/common/city/river";
import { CITY_SEED } from "@angels-bandits/common/constants";
import {
  DIRECTOR_WARN_MIN_MS,
  EVENT_CRANE,
} from "@angels-bandits/common/director";
import { describe, expect, it } from "vitest";
import { sweptThroughSolid } from "../src/courses";
import {
  type PropsTick,
  type RoomCity,
  applyShotDamage,
  blastProps,
  createRoomCity,
  propCulprit,
  propsMessage,
  propsWireState,
  rebuildBuilding,
  stageCollapse,
  tickDestruction,
} from "../src/destruction";
import { DestructionDirector } from "../src/director";

const city = generateCity(CITY_SEED);
const movers = generateMovers(CITY_SEED, city);
const layout = generateProps(CITY_SEED, city, {
  cranes: movers.cranes,
  trains: movers.trains,
});
const room = (): RoomCity =>
  createRoomCity(city, movers.cranes, CITY_SEED, movers.trains ?? []);
const ofKind = (k: number): Prop[] => layout.props.filter((p) => p.kind === k);
const TICK = 50;

/** Tick `rc` from `t0` for `ms`, collecting every tick's props. */
function run(
  rc: RoomCity,
  t0: number,
  ms: number,
  planes: {
    pos: { x: number; y: number; z: number };
    vel: { x: number; y: number; z: number };
  }[] = [],
): PropsTick[] {
  const out: PropsTick[] = [];
  for (let t = t0; t <= t0 + ms; t += TICK) {
    out.push(tickDestruction(rc, t, planes).props);
  }
  return out;
}

describe("D9 props on the server", () => {
  it("a few rounds down a lamp, and the tick's batch says so", () => {
    const rc = room();
    const lamp = ofKind(PROP_LAMP).find((p) => p.span < 0) as Prop;
    // From the street centreline beside it, level with its head.
    const line = Math.round(lamp.x / 200) * 200;
    const alongX = Math.abs(lamp.x - line) < 20;
    const origin = alongX
      ? { x: line, y: 4, z: lamp.z }
      : { x: lamp.x, y: 4, z: Math.round(lamp.z / 200) * 200 };
    const d = alongX
      ? { x: Math.sign(lamp.x - line), y: 0, z: 0 }
      : { x: 0, y: 0, z: Math.sign(lamp.z - origin.z) };
    let rounds = 0;
    while (!rc.props.slot.state.isDown(lamp.id) && rounds < 20) {
      applyShotDamage(rc, origin, d, "ace");
      rounds++;
    }
    expect(rounds).toBe(Math.ceil((PROP_HP[PROP_LAMP] as number) / 7));
    const tick = tickDestruction(rc, 1000).props;
    expect(tick.down).toEqual([{ id: lamp.id, t: 1000 }]);
    const msg = propsMessage(tick);
    expect(decodeIdRecords(msg?.d, 2)).toEqual([[lamp.id, 1000]]);
    expect(rc.props.slot.state.byOf(lamp.id)).toBe("ace");
  });

  it("a street of parked cars blows link by link and stops at the chain's depth cap", () => {
    // 20 cars nose to tail (6 m apart) along the x = 1000 street's curb.
    const cars: Prop[] = Array.from({ length: 20 }, (_, i) => ({
      id: i,
      kind: PROP_CAR,
      x: 986.2,
      y: 0.725,
      z: 330 + 6 * i,
      hx: 0.925,
      hy: 0.725,
      hz: 2.2,
      yaw: 0,
      hp: PROP_HP[PROP_CAR] as number,
      b: -1,
      roof: 0,
      ref: -1,
      span: -1,
      dir: -1,
      landY: 0,
      seed: 0.5,
    }));
    const street = buildPropLayout(cars);
    const make = () => createRoomCity(city, [], CITY_SEED, [], street);
    const a = make();
    a.props.slot.state.knockDown(0, 0, "ace");
    const ticks = run(a, 0, 15_000);
    const state = a.props.slot.state;
    const blown = cars.filter((c) => !Number.isNaN(state.blastAt(c.id)));
    expect(blown.map((c) => c.id)).toEqual([0, 1, 2, 3, 4, 5]);
    for (const c of blown) expect(state.depthOf(c.id)).toBe(c.id);
    expect(state.isDown(6)).toBe(false); // the 6th link's blast hurts no prop
    for (const t of ticks) {
      expect(t.blasts.length).toBeLessThanOrEqual(PROP_BLASTS_PER_TICK);
      expect(t.down.length).toBeLessThanOrEqual(PROP_DOWN_PER_TICK);
    }
    // Every blast lands on the tick at or after its fuse, and the wire
    // carries that instant (clients never predict it).
    const at = new Map<number, number>();
    for (const t of ticks) for (const d of t.down) at.set(d.id, d.t);
    for (const t of ticks) {
      for (const b of t.blasts) {
        const due = (at.get(b.id) as number) + propFuseMs(b.id);
        expect(b.t).toBeGreaterThanOrEqual(due);
        expect(b.t - due).toBeLessThan(TICK);
        expect(state.blastAt(b.id)).toBe(b.t);
      }
    }
    // Deterministic: the same street, the same chain.
    const b = make();
    b.props.slot.state.knockDown(0, 0, "ace");
    expect(JSON.stringify(run(b, 0, 15_000))).toBe(JSON.stringify(ticks));
  });

  it("a seeded minute of random blasts never breaks a cap", () => {
    const rc = room();
    const rand = mulberry32(9);
    const state = rc.props.slot.state;
    const cap = Math.floor(layout.props.length * PROP_DOWN_CAP);
    let maxDepth = 0;
    for (let t = 0; t <= 60_000; t += TICK) {
      if (t % 200 === 0) {
        // Somewhere in the south-west quarter, street level to mid-rise.
        const pos = {
          x: 200 + rand() * 600,
          y: rand() * 30,
          z: 200 + rand() * 600,
        };
        rc.damage.damageAt(pos, 20, 300);
        blastProps(rc, pos, 20, 300, null, 0, t);
      }
      const tick = tickDestruction(rc, t).props;
      expect(tick.blasts.length).toBeLessThanOrEqual(PROP_BLASTS_PER_TICK);
      expect(tick.down.length).toBeLessThanOrEqual(PROP_DOWN_PER_TICK);
      expect(state.downCount).toBeLessThanOrEqual(cap);
      for (const id of state.downIds())
        maxDepth = Math.max(maxDepth, state.depthOf(id));
    }
    expect(state.downCount).toBeGreaterThan(0);
    expect(maxDepth).toBeLessThanOrEqual(PROP_CHAIN_DEPTH_MAX);
    expect(rc.props.craters.length).toBeGreaterThan(0);
  });

  it("a toppled tower crushes the props its debris lands on, as each piece lands", () => {
    const rc = room();
    const plan = demolitionPlan(
      rc.buildings[343] as Building,
      343,
      TOPPLE,
      DIR_NEG_X,
    );
    const wire = stageCollapse(
      rc,
      plan as NonNullable<typeof plan>,
      343,
      1000,
      "ace",
      0,
    );
    expect(rc.props.crushes.length).toBeGreaterThan(0);
    const due = rc.props.crushes.map((c) => c.id);
    const last = Math.max(...rc.props.crushes.map((c) => c.t));
    run(rc, 1000, last - 1000 + 200);
    for (const id of due) expect(rc.props.slot.state.isDown(id)).toBe(true);
    for (const id of due) expect(rc.props.slot.state.byOf(id)).toBe("ace");
    expect(wire.id).toBeGreaterThan(0);
  });

  it("a crane shot to 0 HP is condemned and the director warns before it falls", () => {
    const rc = room();
    const site = movers.cranes[0] as (typeof movers.cranes)[number];
    const id = layout.cranes.get(site.id) as number;
    expect(rc.props.slot.state.knockDown(id)).toBe(true);
    const tick = tickDestruction(rc, 10_000).props;
    expect(tick.condemned).toEqual([site.id]);
    const director = new DestructionDirector(CITY_SEED, mulberry32(1));
    director.condemnCrane(site.id);
    const out = director.tick(10_000, [], { city: rc, cranes: movers.cranes });
    const warned = out.warned.find(
      (e) => e.k === EVENT_CRANE && e.b === site.id,
    );
    expect(warned).toBeDefined();
    expect((warned?.at ?? 0) - 10_000).toBeGreaterThanOrEqual(
      DIRECTOR_WARN_MIN_MS,
    );
    // Still standing until the warned event fires.
    expect(rc.collapses.felled.has(site.id)).toBe(false);
  });

  it("street props repair on time, roof props with their building, a span only when clear", () => {
    const rc = room();
    const state = rc.props.slot.state;
    const lamp = ofKind(PROP_LAMP).find((p) => p.span < 0) as Prop;
    const tank = ofKind(PROP_TANK)[0] as Prop;
    const span = ofKind(PROP_BRIDGE)[3] as Prop;
    state.knockDown(lamp.id);
    state.knockDown(tank.id);
    state.knockDown(span.id);
    run(rc, 0, 0);
    expect(rc.firstDamageAt.get(tank.b)).toBe(0); // its D5 rebuild timer
    run(rc, TICK, propRepairMs(lamp.id) + TICK);
    expect(state.isDown(lamp.id)).toBe(false);
    expect(state.isDown(tank.id)).toBe(true);
    rebuildBuilding(rc, tank.b);
    expect(state.isDown(tank.id)).toBe(false);
    // The span: a plane parked in its volume holds the repair back...
    const inSpan = [
      {
        pos: { x: span.x, y: -1, z: RIVER_CENTER_Z },
        vel: { x: 0, y: 0, z: 0 },
      },
    ];
    const blocked = run(rc, SPAN_REPAIR_MS - 1000, 6000, inSpan);
    expect(blocked.some((t) => t.announced.length > 0)).toBe(false);
    expect(state.isDown(span.id)).toBe(true);
    // ...announced once clear, then called off when a plane flies in...
    let t1 = SPAN_REPAIR_MS + 5000;
    let a: PropDown | undefined;
    while (!a && t1 < SPAN_REPAIR_MS + 20_000) {
      a = tickDestruction(rc, t1).props.announced[0];
      t1 += TICK;
    }
    if (!a) throw new Error("the span repair was never announced");
    expect(a.id).toBe(span.id);
    expect(state.isDown(span.id)).toBe(true);
    const goAt = a.t;
    const called = run(rc, goAt - TICK * 2, TICK * 4, inSpan);
    expect(called.some((t) => t.restored.includes(span.id))).toBe(false);
    expect(state.isDown(span.id)).toBe(true);
    // ...and back for good when it is clear at go time.
    const later = run(rc, goAt + 100, 12_000);
    expect(later.some((t) => t.restored.includes(span.id))).toBe(true);
    expect(state.isDown(span.id)).toBe(false);
    expect(SPAN_REPAIR_LEAD_MS).toBeGreaterThan(0);
  });

  it("a falling tank credits whoever brought it down", () => {
    const rc = room();
    const tank = ofKind(PROP_TANK)[0] as Prop;
    rc.props.slot.state.damage(tank.id, 1000, 0, "ace");
    tickDestruction(rc, 5000);
    const t = 5000 + (fallSeconds(tank) * 1000) / 2;
    const pose = propPieceInto(rc.props.slot, tank.id, t, blankPose());
    const at = {
      x: tank.x + (pose?.x ?? 0),
      y: pose?.y ?? 0,
      z: tank.z + (pose?.z ?? 0),
    };
    expect(propCulprit(rc, at, 2, t)).toEqual({ id: tank.id, by: "ace" });
    // At rest it is rubble, not a kill.
    expect(
      propCulprit(rc, at, 2, 5000 + fallSeconds(tank) * 1000 + 500),
    ).toBeNull();
  });

  it("a late joiner's replay is the live state — a blast still to come included", () => {
    const rc = room();
    const fuel = ofKind(PROP_FUEL)[0] as Prop;
    const tank = ofKind(PROP_TANK)[1] as Prop;
    rc.props.slot.state.knockDown(fuel.id);
    rc.props.slot.state.knockDown(tank.id);
    tickDestruction(rc, 2000);
    // Join between the tanker going down and its blast.
    const client = generateCity(CITY_SEED);
    const replay = new PropState();
    replay.bind(layout, client);
    const w = propsWireState(rc);
    replay.reset(
      decodeIdRecords(w.d, 3).map(([id, t, te]) => ({
        id: id as number,
        t: t as number,
        te: te as number,
      })),
    );
    expect(replay.downIds()).toEqual(rc.props.slot.state.downIds());
    expect(Number.isNaN(replay.blastAt(fuel.id))).toBe(true);
    expect(client[tank.b]?.roof).toEqual(rc.buildings[tank.b]?.roof);
    // The blast lands live; the joiner hears it in the batch.
    const ticks = run(rc, 2000 + TICK, propFuseMs(fuel.id) + TICK);
    for (const t of ticks) {
      const m = propsMessage(t);
      for (const [id, at] of decodeIdRecords(m?.b, 2))
        replay.blasted(id as number, at as number);
    }
    expect(replay.blastAt(fuel.id)).toBe(rc.props.slot.state.blastAt(fuel.id));
    expect(Number.isNaN(replay.blastAt(fuel.id))).toBe(false);
  });

  it("a course run through a fallen span is not through the ground", () => {
    const rc = room();
    const span = ofKind(PROP_BRIDGE)[7] as Prop;
    const path = [
      span.x,
      -1.2,
      RIVER_CENTER_Z - 12,
      span.x,
      -1.2,
      RIVER_CENTER_Z + 12,
    ];
    const world = {
      buildings: rc.buildings,
      gaps: () => rc.props.slot.state.gapMask,
    };
    expect(sweptThroughSolid(path, world)).toBe(true); // the deck stands
    rc.props.slot.state.knockDown(span.id);
    tickDestruction(rc, 0);
    expect(sweptThroughSolid(path, world)).toBe(false);
    expect(PROP_CRANE).toBeGreaterThan(0);
  });
});
