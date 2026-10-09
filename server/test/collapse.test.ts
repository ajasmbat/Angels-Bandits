// D3 on the server: a building shot out at its base collapses on the next
// destruction tick, the event credits the shooter, a crash into its falling
// debris is a collapse kill, a client (live or late) rebuilds exactly the
// server's collapse from the wire, and a room reset clears it in place.

import {
  type Building,
  CityDamage,
  chunkId,
  decodeChunkIds,
  generateCity,
  solids,
  tierGrids,
} from "@angels-bandits/common/city";
import {
  CollapseField,
  type CollapseWire,
  blankPose,
  collapseChunks,
  collideCollapses,
  piecePose,
} from "@angels-bandits/common/city/collapse";
import {
  collideBotMovers,
  generateMovers,
} from "@angels-bandits/common/city/movers";
import { CITY_SEED, PLAYER_RADIUS } from "@angels-bandits/common/constants";
import { describe, expect, it } from "vitest";
import {
  type RoomCity,
  applyShotDamage,
  collapseCulprit,
  createRoomCity,
  resetRoomCity,
  tickDestruction,
} from "../src/destruction";

const seedCity = generateCity(CITY_SEED);

/** A plain tower with a multi-chunk street tier. */
const target = seedCity.findIndex((b) => {
  const g = tierGrids(b)[0];
  return !b.holes && !!g && g.nx >= 2 && g.nz >= 2 && b.height >= 80;
});

/** `by` shoots out every chunk of the tower's base band: rays along +x
 * through each row of cells, at mid-band height, from outside the −x face. */
function shootOutBase(rc: RoomCity, by: string): void {
  const b = rc.buildings[target] as Building;
  const g = tierGrids(b)[0];
  if (!g) throw new Error("no grid");
  for (let iz = 0; iz < g.nz; iz++) {
    const origin = {
      x: b.x - b.width / 2 - 2,
      y: g.ch / 2,
      z: b.z - g.depth / 2 + (iz + 0.5) * g.cd,
    };
    for (let k = 0; k < 400; k++) {
      applyShotDamage(rc, origin, { x: 1, y: 0, z: 0 }, by);
      let left = 0;
      for (let ix = 0; ix < g.nx; ix++) {
        const id = chunkId(target, 0, iz * g.nx + ix);
        if (!rc.damage.isGone(id)) left++;
      }
      if (left === 0) break;
    }
  }
}

/** A client's replay of a welcome: the broken set, then every record. */
function replay(
  destroyed: number[],
  records: readonly CollapseWire[],
): { city: Building[]; field: CollapseField } {
  const city = generateCity(CITY_SEED);
  const damage = new CityDamage();
  const field = new CollapseField();
  damage.reset(destroyed);
  field.reset(records);
  for (const c of records) damage.collapse(collapseChunks(c));
  // The city exists only after the welcome (a booting client binds late).
  damage.bind(city);
  field.bind(city);
  return { city, field };
}

describe("D3 collapses on the server", () => {
  it("shooting out a tower's base collapses it on the next tick, credited to the shooter", () => {
    expect(target).toBeGreaterThanOrEqual(0);
    const rc = createRoomCity(seedCity);
    shootOutBase(rc, "ace");
    const tick = tickDestruction(rc, 10_000);
    expect(tick.broke.length).toBeGreaterThan(0);
    expect(tick.collapses.length).toBe(1);
    const wire = tick.collapses[0] as CollapseWire;
    expect(wire.b).toBe(target);
    expect(wire.t).toBe(10_000);
    expect(rc.collapseBy.get(wire.id)).toBe("ace");
    // The fallen chunks are gone from the building but not in the replay
    // set or the cap count; the next tick owes nothing.
    const fell = decodeChunkIds(wire.c);
    expect(rc.damage.fallenCount).toBe(fell.length);
    expect(fell.every((id) => rc.damage.isGone(id))).toBe(true);
    expect(fell.some((id) => rc.damage.destroyedIds().includes(id))).toBe(
      false,
    );
    expect(tickDestruction(rc, 10_050).collapses).toEqual([]);
    expect(rc.collapses.list.length).toBe(1);
  });

  it("a crash into falling debris is the collapse's; into landed rubble it is a plain crash", () => {
    const rc = createRoomCity(seedCity);
    shootOutBase(rc, "ace");
    tickDestruction(rc, 0);
    const c = rc.collapses.list[0];
    if (!c) throw new Error("no collapse");
    const pose = blankPose();
    const mid = c.t0 + c.endMs * 0.5;
    const i = c.n - 1;
    piecePose(c, i, mid, pose);
    const falling = { x: c.x + pose.x, y: pose.y, z: c.z + pose.z };
    expect(collapseCulprit(rc, falling, PLAYER_RADIUS, mid)).toEqual({
      id: c.id,
      by: "ace",
    });
    piecePose(c, i, Number.POSITIVE_INFINITY, pose);
    const rubble = { x: c.x + pose.x, y: pose.y + 1, z: c.z + pose.z };
    const late = c.t0 + c.endMs + 1000;
    expect(collapseCulprit(rc, rubble, PLAYER_RADIUS, late)).toBeNull();
    // ...but the rubble is solid, for bots too (the room's movers field).
    const movers = {
      ...generateMovers(CITY_SEED, rc.buildings),
      collapses: rc.collapses,
    };
    expect(collideBotMovers(rubble, PLAYER_RADIUS, movers, late)?.kind).toBe(
      "rubble",
    );
    expect(collideBotMovers(falling, PLAYER_RADIUS, movers, mid)?.kind).toBe(
      "debris",
    );
  });

  it("a live client and a late joiner rebuild exactly the server's collapse", () => {
    const rc = createRoomCity(seedCity);
    // Live client: welcome before anything broke, then the tick's messages.
    const live = replay([], []);
    const liveDamage = new CityDamage();
    liveDamage.bind(live.city);
    shootOutBase(rc, "ace");
    const tick = JSON.parse(JSON.stringify(tickDestruction(rc, 5_000))) as {
      broke: number[];
      collapses: CollapseWire[];
    };
    liveDamage.apply(tick.broke);
    for (const c of tick.collapses) {
      liveDamage.collapse(collapseChunks(c));
      live.field.add(c);
    }
    // Late joiner: the welcome's replay, over JSON.
    const welcome = JSON.parse(
      JSON.stringify({
        destroyed: rc.damage.destroyedIds(),
        collapses: rc.collapses.records,
      }),
    ) as { destroyed: number[]; collapses: CollapseWire[] };
    const late = replay(welcome.destroyed, welcome.collapses);

    // The same broken city, rubble and all.
    rc.buildings.forEach((b, i) => {
      expect(solids(live.city[i] as Building)).toEqual(solids(b));
      expect(solids(late.city[i] as Building)).toEqual(solids(b));
    });
    // The same debris at every moment.
    const server = rc.collapses.list[0];
    const a = live.field.list[0];
    const l = late.field.list[0];
    if (!server || !a || !l) throw new Error("missing collapse");
    const p = blankPose();
    const q = blankPose();
    const r = blankPose();
    for (let t = -100; t <= server.endMs + 500; t += 97) {
      for (let i = 0; i < server.n; i += 2) {
        piecePose(server, i, server.t0 + t, p);
        expect(piecePose(a, i, server.t0 + t, q)).toEqual(p);
        expect(piecePose(l, i, server.t0 + t, r)).toEqual(p);
      }
    }
    // ...and the same collisions.
    for (let t = 0; t <= server.endMs; t += 250) {
      for (let i = 0; i < server.n; i += 5) {
        piecePose(server, i, server.t0 + t, p);
        const at = { x: server.x + p.x, y: p.y, z: server.z + p.z };
        const want = collideCollapses(at, 2, rc.collapses.list, server.t0 + t);
        for (const f of [live.field, late.field]) {
          const got = collideCollapses(at, 2, f.list, server.t0 + t);
          expect(got?.piece).toBe(want?.piece);
          expect(got?.falling).toBe(want?.falling);
        }
      }
    }
  });

  it("a room reset clears the collapses IN PLACE (the bots hold the field)", () => {
    const rc = createRoomCity(seedCity);
    const field = rc.collapses;
    const movers = {
      ...generateMovers(CITY_SEED, rc.buildings),
      collapses: field,
    };
    shootOutBase(rc, "ace");
    tickDestruction(rc, 0);
    const c = field.list[0];
    if (!c) throw new Error("no collapse");
    const pose = piecePose(c, 0, Number.POSITIVE_INFINITY, blankPose());
    const rubble = { x: c.x + pose.x, y: pose.y, z: c.z + pose.z };
    expect(collideBotMovers(rubble, 1, movers, 1e9)).not.toBeNull();
    resetRoomCity(rc);
    expect(rc.collapses).toBe(field);
    expect(field.list.length).toBe(0);
    expect(rc.damage.fallenCount).toBe(0);
    expect(collideBotMovers(rubble, 1, movers, 1e9)).toBeNull();
    // Whole again: every building back to its generated solids.
    rc.buildings.forEach((b, i) => {
      expect(solids(b)).toEqual(solids(seedCity[i] as Building));
    });
  });
});
