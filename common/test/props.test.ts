// D9 destructible props, the shared half (common/src/city/props.ts): the
// seed-42 layout is deterministic and every kind stands where the city says
// it does; every kind's state machine (standing → hit → down → restored,
// and a replay) holds, roof props leave and rejoin `b.roof`, a fallen span
// opens its deck; every solid faller is drawn == collided over its whole
// fall and drops out once its deck is gone; fire jumps only into damaged
// neighbours; the wire round-trips and refuses malformed input.

import {
  type Building,
  CityDamage,
  chunkBuilding,
  chunkTier,
  chunksOf,
  generateCity,
  generatedRoof,
  tierGrids,
} from "@angels-bandits/common/city";
import {
  DIR_NEG_X,
  TOPPLE,
  blankPose,
  buildCollapse,
  collapseWire,
  demolitionPlan,
} from "@angels-bandits/common/city/collapse";
import { jumbotronSites } from "@angels-bandits/common/city/jumbotron-sites";
import {
  collideBotMovers,
  collideMovers,
  generateMovers,
} from "@angels-bandits/common/city/movers";
import {
  FIRE_JUMP_M,
  PROP_BRIDGE,
  PROP_CAR,
  PROP_CRANE,
  PROP_DOWN_PER_TICK,
  PROP_FUEL,
  PROP_JUMBO,
  PROP_KIND_COUNT,
  PROP_LAMP,
  PROP_POLE,
  PROP_SIGNAL,
  PROP_STATION,
  PROP_TANK,
  PROP_TAXI,
  type Prop,
  PropState,
  collapseCrushes,
  collideProps,
  decodeCrater,
  decodeIdRecords,
  encodeCrater,
  encodeIdRecords,
  fallSeconds,
  fallerPose,
  fireJumpTargets,
  generateProps,
  isExplosive,
  isFaller,
  isRoofProp,
  pickFireJump,
  propPieceInto,
  propSlot,
  propsNear,
} from "@angels-bandits/common/city/props";
import {
  BRIDGE_HALF_WIDTH,
  BRIDGE_SPAN_HALF,
  RIVER_CENTER_Z,
  RIVER_HALF_WIDTH,
  inBridgeGap,
  overChannel,
  riverHit,
  riverOffset,
  riverSegmentClear,
} from "@angels-bandits/common/city/river";

import {
  isInIntersection,
  isInRoadway,
  signalMastsForBlock,
  streetlampPositions,
} from "@angels-bandits/common/city/street";
import { collideCity, hitsGround } from "@angels-bandits/common/collision";
import { CITY_SEED, WORLD_SIZE } from "@angels-bandits/common/constants";
import { wrapDeltaAxis } from "@angels-bandits/common/world";
import { describe, expect, it } from "vitest";

const city = generateCity(CITY_SEED);
const movers = generateMovers(CITY_SEED, city);
const world = { cranes: movers.cranes, trains: movers.trains };
const layout = generateProps(CITY_SEED, city, world);
const props = layout.props;
const ofKind = (k: number): Prop[] => props.filter((p) => p.kind === k);

/** A fresh city + state bound to the layout (roof props write through). */
function fresh(): {
  buildings: Building[];
  state: PropState;
  damage: CityDamage;
} {
  const buildings = generateCity(CITY_SEED);
  const damage = new CityDamage();
  damage.bind(buildings);
  const state = new PropState();
  state.bind(layout, buildings);
  return { buildings, state, damage };
}

describe("D9 prop layout", () => {
  it("is deterministic and holds every kind", () => {
    const again = generateProps(CITY_SEED, city, world);
    expect(JSON.stringify(again.props)).toBe(JSON.stringify(props));
    props.forEach((p, i) => expect(p.id).toBe(i));
    for (let k = 0; k < PROP_KIND_COUNT; k++) {
      expect(ofKind(k).length, `kind ${k}`).toBeGreaterThan(0);
    }
    expect(ofKind(PROP_BRIDGE)).toHaveLength(10);
    expect(ofKind(PROP_STATION)).toHaveLength(3);
    expect(ofKind(PROP_JUMBO)).toHaveLength(jumbotronSites(city).length);
    expect(ofKind(PROP_CRANE)).toHaveLength(movers.cranes.length);
  });

  it("puts lamps and signal masts exactly where their renderers draw them", () => {
    const lamps = streetlampPositions();
    const ls = ofKind(PROP_LAMP);
    expect(ls).toHaveLength(lamps.length);
    ls.forEach((p, i) => {
      expect(p.x).toBe((lamps[i] as { x: number }).x);
      expect(p.z).toBe((lamps[i] as { z: number }).z);
      expect(p.ref).toBe(i);
    });
    const masts: { x: number; z: number }[] = [];
    for (let bx = 0; bx < 10; bx++) {
      for (let bz = 0; bz < 10; bz++)
        masts.push(...signalMastsForBlock(bx, bz));
    }
    const ss = ofKind(PROP_SIGNAL);
    expect(ss).toHaveLength(masts.length);
    ss.forEach((p, i) => {
      expect(p.x).toBe(masts[i]?.x);
      expect(p.z).toBe(masts[i]?.z);
    });
  });

  it("parks vehicles in the parking lane, off intersections, bridges and portals", () => {
    for (const p of props.filter(
      (q) =>
        q.kind === PROP_CAR || q.kind === PROP_TAXI || q.kind === PROP_FUEL,
    )) {
      const at = { x: p.x, y: 0, z: p.z };
      expect(isInRoadway(at)).toBe(true);
      expect(isInIntersection(at)).toBe(false);
      expect(p.y + p.hy).toBeLessThanOrEqual(3); // the street exception
      expect(collideCity({ ...at, y: p.y }, 0.5, city)).toBeNull();
    }
  });

  it("stands gas stations and poles on the promenade, off the bridges", () => {
    for (const p of [...ofKind(PROP_STATION), ...ofKind(PROP_POLE)]) {
      const off = Math.abs(riverOffset(p.z));
      expect(off).toBeGreaterThan(RIVER_HALF_WIDTH);
      expect(off + p.hz).toBeLessThan(RIVER_HALF_WIDTH + 20 + 1e-9);
      const line = Math.round(p.x / 200) * 200;
      expect(Math.abs(p.x - line) - p.hx).toBeGreaterThan(BRIDGE_HALF_WIDTH);
      expect(p.y + p.hy).toBeLessThanOrEqual(p.kind === PROP_POLE ? 9 : 3);
    }
  });

  it("names real generated roof structures of the right kind", () => {
    for (const p of props.filter((q) => isRoofProp(q.kind))) {
      const b = city[p.b] as Building;
      const r = (generatedRoof(b) ?? [])[p.ref];
      expect(r, `prop ${p.id}`).toBeDefined();
      const kind = { 7: "waterTank", 8: "billboard", 9: "mast" }[
        p.kind as 7 | 8 | 9
      ];
      expect(r?.kind).toBe(kind);
      expect(p.landY).toBe(b.height);
      expect(layout.roofProp.get(p.b * 64 + p.ref)).toBe(p.id);
    }
  });

  it("finds a prop across the seam (propsNear is wrap-safe)", () => {
    const bridge0 = props.find(
      (p) => p.kind === PROP_BRIDGE && p.ref === 0,
    ) as Prop;
    expect(bridge0.x).toBe(0);
    const seen: number[] = [];
    propsNear(layout, WORLD_SIZE - 5, RIVER_CENTER_Z, 10, (id) =>
      seen.push(id),
    );
    expect(seen).toContain(bridge0.id);
  });
});

describe("D9 prop state machine", () => {
  // One of every kind: standing, hit, down at t, restored — the same on a
  // replay. Roof props leave b.roof (collision, rays and drawing follow);
  // a span opens its deck.
  const kinds = Array.from({ length: PROP_KIND_COUNT }, (_, k) => k);
  it.each(kinds)(
    "kind %i: standing → hit → down → restored → replayed",
    (k) => {
      const { buildings, state } = fresh();
      const p = ofKind(k)[0] as Prop;
      expect(state.isDown(p.id)).toBe(false);
      expect(state.hpOf(p.id)).toBe(p.hp);
      expect(state.damage(p.id, p.hp - 1)).toBe(false);
      expect(state.hpOf(p.id)).toBe(1);
      expect(state.damage(p.id, 1, 2, "ace")).toBe(true);
      expect(state.isDown(p.id)).toBe(true);
      expect(state.damage(p.id, 50)).toBe(false); // down: no more damage
      expect(Number.isNaN(state.downAt(p.id))).toBe(true); // not stamped yet
      const [d] = state.take(5000);
      expect(d).toEqual({ id: p.id, t: 5000 });
      expect(state.downAt(p.id)).toBe(5000);
      expect(state.depthOf(p.id)).toBe(2);
      expect(state.byOf(p.id)).toBe("ace");
      expect(state.fallers.includes(p.id)).toBe(isFaller(k));
      if (k === PROP_BRIDGE) expect(state.gapMask).toBe(1 << p.ref);
      if (isRoofProp(k)) {
        const b = buildings[p.b] as Building;
        const r = (generatedRoof(b) ?? [])[p.ref];
        expect(b.roof?.includes(r as NonNullable<typeof r>) ?? false).toBe(
          false,
        );
        // Nothing about it is "damaged": b.damage stays undefined.
        expect(b.damage).toBeUndefined();
      }
      if (isExplosive(k)) {
        state.blasted(p.id, 5400);
        expect(state.blastAt(p.id)).toBe(5400);
      }
      // A replay of the same downs is the same state.
      const replay = fresh();
      replay.state.reset([
        { id: p.id, t: 5000, te: isExplosive(k) ? 5400 : -1 },
      ]);
      expect(replay.state.downIds()).toEqual(state.downIds());
      expect(replay.state.gapMask).toBe(state.gapMask);
      expect(replay.buildings[p.b]?.roof).toEqual(buildings[p.b]?.roof);
      // Restored: back to whole.
      state.restore(p.id);
      expect(state.isDown(p.id)).toBe(false);
      expect(state.hpOf(p.id)).toBe(p.hp);
      expect(state.gapMask).toBe(0);
      expect(state.fallers).toHaveLength(0);
      if (isRoofProp(k)) {
        expect(buildings[p.b]?.roof).toEqual(
          generatedRoof(buildings[p.b] as Building),
        );
      }
    },
  );

  it("holds bare records until bound, like CityDamage", () => {
    const state = new PropState();
    const p = ofKind(PROP_TANK)[0] as Prop;
    state.apply(p.id, 1000);
    const buildings = generateCity(CITY_SEED);
    state.bind(layout, buildings);
    expect(state.isDown(p.id)).toBe(true);
    expect(buildings[p.b]?.roof?.length).toBe(
      (generatedRoof(city[p.b] as Building)?.length ?? 0) - 1,
    );
  });

  it("a D5 rebuild brings a building's roof props back", () => {
    const { buildings, state } = fresh();
    const tanks = ofKind(PROP_TANK);
    const b = (tanks[0] as Prop).b;
    const mine = props.filter((p) => p.b === b && isRoofProp(p.kind));
    for (const p of mine) state.apply(p.id, 1);
    expect(state.restoreBuilding(b).sort()).toEqual(
      mine.map((p) => p.id).sort(),
    );
    expect(buildings[b]?.roof).toEqual(generatedRoof(buildings[b] as Building));
  });

  it("refuses to down anything under the hold or past the per-tick budget", () => {
    const { state } = fresh();
    const lamps = ofKind(PROP_LAMP);
    state.hold = true;
    expect(state.knockDown((lamps[0] as Prop).id)).toBe(false);
    expect(state.hpOf((lamps[0] as Prop).id)).toBe(1);
    state.hold = false;
    let downed = 0;
    for (const p of lamps.slice(0, PROP_DOWN_PER_TICK + 10)) {
      if (state.knockDown(p.id)) downed++;
    }
    expect(downed).toBe(PROP_DOWN_PER_TICK);
    expect(state.take(1)).toHaveLength(PROP_DOWN_PER_TICK);
    // The next tick has a fresh budget.
    expect(state.knockDown((lamps[PROP_DOWN_PER_TICK + 1] as Prop).id)).toBe(
      true,
    );
  });
});

describe("D9 solid fallers: draw == collide", () => {
  const fallers = [PROP_TANK, 8, 9, PROP_JUMBO, PROP_BRIDGE].map(
    (k) => ofKind(k)[0] as Prop,
  );
  it.each(fallers.map((p) => [p.id, p]))(
    "prop %i falls as the box it collides",
    (_, p) => {
      const { buildings, state } = fresh();
      const slot = { layout, state };
      const t0 = 10_000;
      state.apply(p.id, t0);
      const end = fallSeconds(p);
      const pose = blankPose();
      for (let s = -0.2; s <= end + 0.6; s += 0.1) {
        const t = t0 + s * 1000;
        const got = propPieceInto(slot, p.id, t, pose);
        expect(got).not.toBeNull();
        // Its centre is solid; 3 m beyond its largest half extent is not.
        const c = { x: p.x + pose.x, y: pose.y, z: p.z + pose.z };
        expect(collideProps(c, 0.1, slot, t)?.id).toBe(p.id);
        // The crash check and the bots see it through the mover field.
        const field = { cranes: [], aircraft: [], props: slot };
        expect(collideMovers(c, 0.1, field, t)?.id).toBe(p.id);
        expect(collideBotMovers(c, 0.1, field, t)?.kind).toMatch(/^prop/);
        const far = Math.max(pose.hx, pose.hy, pose.hz) * 1.8 + 3;
        expect(
          collideProps({ x: c.x, y: c.y + far, z: c.z }, 0.1, slot, t),
        ).toBeNull();
      }
      // Standing before it goes (a render clock trails the message).
      fallerPose(p, -1, pose);
      expect(pose).toMatchObject({ x: 0, z: 0, y: p.y, phi: 0, rest: false });
      // At rest for good, lying on the surface it lands on.
      fallerPose(p, end + 0.01, pose);
      expect(pose.rest).toBe(true);
      const half = p.kind === PROP_BRIDGE ? p.hy : p.dir <= 1 ? p.hx : p.hz;
      if (p.kind !== PROP_BRIDGE) expect(pose.y - half).toBeCloseTo(p.landY, 6);
      expect(
        collideProps(
          { x: p.x + pose.x, y: pose.y, z: p.z + pose.z },
          0.1,
          slot,
          Number.POSITIVE_INFINITY,
        )?.falling,
      ).toBe(false);
      void buildings;
    },
  );

  it("a fallen tank whose deck is gone is gone too (nothing floats)", () => {
    const { buildings, damage, state } = fresh();
    const slot = { layout, state };
    const p = ofKind(PROP_TANK)[0] as Prop;
    state.apply(p.id, 0);
    const pose = propPieceInto(
      slot,
      p.id,
      Number.POSITIVE_INFINITY,
      blankPose(),
    );
    expect(pose).not.toBeNull();
    const at = {
      x: p.x + (pose?.x ?? 0),
      y: pose?.y ?? 0,
      z: p.z + (pose?.z ?? 0),
    };
    expect(
      collideProps(at, 0.1, slot, Number.POSITIVE_INFINITY),
    ).not.toBeNull();
    // Break every top-tier chunk of its building.
    const b = buildings[p.b] as Building;
    const top = tierGrids(b).length - 1;
    damage.apply(chunksOf(b, p.b).filter((id) => chunkTier(id) === top));
    expect(
      propPieceInto(slot, p.id, Number.POSITIVE_INFINITY, blankPose()),
    ).toBeNull();
    expect(collideProps(at, 0.1, slot, Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("D9 bridge gaps", () => {
  const x = 1400; // bridge 7
  const mask = 1 << 7;
  it("open the span's deck and parapets, and only those", () => {
    const deck = { x: x + 5, y: -1.2, z: RIVER_CENTER_Z };
    expect(riverHit(deck, 0.5)).toBe(true);
    expect(riverHit(deck, 0.5, mask)).toBe(false);
    expect(hitsGround(deck, 0.5, mask)).toBe(false);
    expect(riverHit(deck, 0.5, 1 << 3)).toBe(true); // another bridge's gap
    const parapet = {
      x: x + BRIDGE_HALF_WIDTH - 0.25,
      y: 0.5,
      z: RIVER_CENTER_Z + 5,
    };
    expect(riverHit(parapet, 0.2)).toBe(true);
    expect(riverHit(parapet, 0.2, mask)).toBe(false);
    const beyond = { x, y: -1.2, z: RIVER_CENTER_Z + BRIDGE_SPAN_HALF + 3 };
    expect(riverHit(beyond, 0.5, mask)).toBe(true); // the end pieces stay
    expect(inBridgeGap(x, RIVER_CENTER_Z, mask)).toBe(true);
    expect(inBridgeGap(x, RIVER_CENTER_Z + BRIDGE_SPAN_HALF + 1, mask)).toBe(
      false,
    );
    expect(overChannel(RIVER_CENTER_Z)).toBe(true);
  });

  it("let a sight line through the hole, not through the deck", () => {
    const from = { x, y: 10, z: RIVER_CENTER_Z };
    const d = { x: 0, y: -20, z: 0 };
    expect(riverSegmentClear(from, d)).toBe(false);
    expect(riverSegmentClear(from, d, true, mask)).toBe(true);
  });
});

describe("D9 chains (pure halves)", () => {
  it("a toppled tower crushes the props its debris comes to rest on", () => {
    const b = city[343] as Building;
    const plan = demolitionPlan(b, 343, TOPPLE, DIR_NEG_X);
    expect(plan).not.toBeNull();
    const wire = collapseWire(plan as NonNullable<typeof plan>, 343, 1, 1000);
    const c = buildCollapse(city, wire);
    expect(c).not.toBeNull();
    const crushes = collapseCrushes(c as NonNullable<typeof c>, layout);
    expect(crushes.length).toBeGreaterThan(0);
    for (let i = 1; i < crushes.length; i++) {
      expect(crushes[i]?.t).toBeGreaterThanOrEqual(crushes[i - 1]?.t ?? 0);
    }
    for (const k of crushes) {
      expect(k.t).toBeGreaterThan(1000);
      const p = props[k.id] as Prop;
      expect(p.kind === PROP_BRIDGE || p.kind === PROP_CRANE).toBe(false);
    }
    // Pure: the same event, the same crushes.
    expect(
      collapseCrushes(
        buildCollapse(city, wire) as NonNullable<typeof c>,
        layout,
      ),
    ).toEqual(crushes);
  });

  it("fire jumps only to OTHER buildings' chunks within reach, and only damaged ones", () => {
    // A ground-floor chunk on a building flush against a neighbour.
    let found: { id: number; targets: number[] } | null = null;
    for (let i = 0; i < city.length && !found; i++) {
      for (const id of chunksOf(city[i] as Building, i)) {
        if (chunkTier(id) !== 0) continue;
        const targets = fireJumpTargets(city, id, []);
        if (targets.length > 0) {
          found = { id, targets: [...targets] };
          break;
        }
      }
    }
    expect(found).not.toBeNull();
    const { id, targets } = found as { id: number; targets: number[] };
    expect(fireJumpTargets(city, id, [])).toEqual(targets);
    for (const t of targets) {
      expect(chunkBuilding(t)).not.toBe(chunkBuilding(id));
      const a = city[chunkBuilding(id)] as Building;
      const o = city[chunkBuilding(t)] as Building;
      const gx = Math.abs(wrapDeltaAxis(a.x, o.x)) - a.width / 2 - o.width / 2;
      const gz = Math.abs(wrapDeltaAxis(a.z, o.z)) - a.depth / 2 - o.depth / 2;
      expect(Math.min(gx, gz)).toBeLessThanOrEqual(FIRE_JUMP_M + 1e-6);
    }
    // Whole neighbours: no jump (a roll that would jump finds no target).
    const always = () => 0;
    expect(pickFireJump(city, id, always)).toBe(-1);
    // A damaged neighbour: it can.
    const { buildings, damage } = fresh();
    const other = chunkBuilding(targets[0] as number);
    damage.apply([
      chunksOf(buildings[other] as Building, other).at(-1) as number,
    ]);
    const jump = pickFireJump(buildings, id, always);
    expect(chunkBuilding(jump)).toBe(other);
  });
});

describe("D9 wire", () => {
  it("round-trips id records and craters, and refuses malformed input", () => {
    const recs = [
      [3, 1000, -1],
      [17, 1200, 1500],
      [900, 1300, -1],
    ];
    const w = encodeIdRecords([recs[2], recs[0], recs[1]] as number[][], 3);
    expect(w.slice(0, 3)).toEqual([3, 1000, -1]);
    expect(decodeIdRecords(w, 3)).toEqual(recs);
    expect(decodeIdRecords([3, 1000], 3)).toEqual([]); // ragged
    expect(decodeIdRecords([3, 1, 0, 2], 2)).toEqual([]); // a zero gap
    expect(decodeIdRecords([3, 1, -2, 2], 2)).toEqual([]); // a negative gap
    expect(decodeIdRecords([1.5, 1], 2)).toEqual([]);
    expect(decodeIdRecords("x", 2)).toEqual([]);
    const c = { id: 4, x: 1999.9, z: 12.3, r: 4.5, t: 123456, water: true };
    const back = decodeCrater(encodeCrater(c));
    expect(back).toMatchObject({ id: 4, r: 4.5, t: 123456, water: true });
    expect(back?.x).toBeCloseTo(c.x, 6);
    expect(back?.z).toBeCloseTo(c.z, 6);
    expect(decodeCrater([1, 2, 3])).toBeNull();
    expect(decodeCrater([1, 10, 10, 0, 5, 0])).toBeNull(); // no radius
    expect(decodeCrater([1, 10, 10, "4", 5, 0])).toBeNull();
  });
});
