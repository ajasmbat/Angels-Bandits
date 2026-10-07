// L11 the river (city/river.ts): the channel, its bridges and its boats, as
// the ground everything collides with. Expected values are worked from the
// module's constants: the channel spans z 1040..1160 (centre 1100, half 60),
// the water is at y = −22, a deck is y −2.5..0 and 40 m wide on every
// north–south street line (x = k·200), parapets and railings stand 1.1 m.

import {
  CONSTRUCTION_BLOCKS,
  LANDMARK_BLOCKS,
  PLAZA_BLOCKS,
  generateCity,
  mulberry32,
} from "@angels-bandits/common/city";
import { natureFor } from "@angels-bandits/common/city/nature";
import {
  BOAT_CABIN_HEIGHT,
  BOAT_HULL_HEIGHT,
  BRIDGE_CLEARANCE,
  BRIDGE_DECK_DEPTH,
  BRIDGE_HALF_WIDTH,
  type BoatBox,
  type BoatPose,
  PARAPET_HEIGHT,
  RIVER_CENTER_Z,
  RIVER_HALF_WIDTH,
  RIVER_ROW,
  RIVER_WATER_Y,
  boatBoxInto,
  bridgeBoxes,
  collideBoats,
  minAltitude,
  riverBoats,
} from "@angels-bandits/common/city/river";
import {
  buildCityIndex,
  collideCity,
  hitsGround,
  losClear,
} from "@angels-bandits/common/collision";
import { BLOCK_PITCH, WORLD_SIZE } from "@angels-bandits/common/constants";
import {
  decodeSnapshotEntry,
  encodeSnapshotEntry,
} from "@angels-bandits/common/net";
import { type Vec3, wrapDeltaAxis } from "@angels-bandits/common/world";
import { describe, expect, it } from "vitest";

const R = 2; // player sphere radius, m
const city = generateCity(42);

describe("the river row", () => {
  it("is block row 5, centred on z = 1100, 120 m wide, holding no hand-placed block", () => {
    expect(RIVER_ROW).toBe(5);
    expect(RIVER_CENTER_Z).toBe(1100);
    expect(2 * RIVER_HALF_WIDTH).toBe(120);
    for (const [, bz] of [
      ...LANDMARK_BLOCKS,
      ...PLAZA_BLOCKS,
      ...CONSTRUCTION_BLOCKS,
    ]) {
      expect(bz).not.toBe(RIVER_ROW);
    }
  });

  it("holds no buildings: every footprint stays out of z 1000..1200", () => {
    expect(city.length).toBeGreaterThan(0);
    for (const b of city) {
      const z0 = b.z - b.depth / 2;
      const z1 = b.z + b.depth / 2;
      expect(z1 <= 1000 || z0 >= 1200).toBe(true);
    }
  });

  it("is deterministic: two generations of seed 42 agree byte for byte", () => {
    expect(JSON.stringify(generateCity(42))).toBe(JSON.stringify(city));
  });

  it("plants no tree over the channel (decks carry no tree pits)", () => {
    for (const t of natureFor(42, city).trees) {
      expect(Math.abs(t.z - RIVER_CENTER_Z)).toBeGreaterThanOrEqual(
        RIVER_HALF_WIDTH,
      );
    }
  });
});

describe("hitsGround over the river", () => {
  it("is open air over the channel between bridges, down to the water", () => {
    expect(hitsGround({ x: 100, y: -15, z: 1100 }, R)).toBe(false);
    expect(hitsGround({ x: 100, y: -19.9, z: 1100 }, R)).toBe(false);
    // Sphere bottom at −22: touching the water.
    expect(hitsGround({ x: 100, y: -20, z: 1100 }, R)).toBe(true);
  });

  it("is solid bank below street level outside the channel walls", () => {
    expect(hitsGround({ x: 100, y: -15, z: 1020 }, R)).toBe(true);
    expect(hitsGround({ x: 100, y: -15, z: 500 }, R)).toBe(true);
    // A wing tip 1 m from the wall (z face at 1040) touches it.
    expect(hitsGround({ x: 100, y: -15, z: 1041 }, R)).toBe(true);
    expect(hitsGround({ x: 100, y: -15, z: 1043 }, R)).toBe(false);
  });

  it("keeps the old ground everywhere else (y = 0, not before)", () => {
    expect(hitsGround({ x: 0, y: 1.5, z: 500 }, R)).toBe(true);
    expect(hitsGround({ x: 0, y: 2.5, z: 500 }, R)).toBe(false);
  });

  it("stops a plane at the embankment railing, broken where a bridge meets it", () => {
    // Railing at |z − 1100| 60..60.5, y 0..1.1: skimming at 2.5 m clips it.
    expect(hitsGround({ x: 100, y: 2.5, z: 1160.25 }, R)).toBe(true);
    expect(hitsGround({ x: 100, y: 3.5, z: 1160.25 }, R)).toBe(false);
  });
});

describe("bridges", () => {
  it("leave at least 18 m of clearance between the water and the deck", () => {
    expect(BRIDGE_CLEARANCE).toBe(19.5);
    expect(BRIDGE_CLEARANCE).toBeGreaterThanOrEqual(18);
    expect(BRIDGE_HALF_WIDTH).toBe(20);
  });

  it("are one deck + two parapets per north–south street, decks flush with the street", () => {
    const boxes = bridgeBoxes();
    expect(boxes.length).toBe((WORLD_SIZE / BLOCK_PITCH) * 3);
    const decks = boxes.filter((b) => b.y0 < 0);
    expect(decks.map((d) => d.x)).toEqual(
      Array.from({ length: WORLD_SIZE / BLOCK_PITCH }, (_, i) => i * 200),
    );
    for (const d of decks) {
      expect(d.y1).toBe(0);
      expect(d.y0).toBe(-BRIDGE_DECK_DEPTH);
      expect(d.hz).toBe(RIVER_HALF_WIDTH);
    }
  });

  it("decks are solid and the air under them is clear, on every bridge", () => {
    const mid = (RIVER_WATER_Y - BRIDGE_DECK_DEPTH) / 2; // −12.25
    for (const b of bridgeBoxes()) {
      if (b.y0 >= 0) continue; // parapet
      for (const dz of [-55, 0, 55]) {
        const z = RIVER_CENTER_Z + dz;
        // Inside the deck slab.
        expect(hitsGround({ x: b.x, y: -1.25, z }, R)).toBe(true);
        // Under it: clear at mid-clearance and right up to the underside.
        expect(hitsGround({ x: b.x, y: mid, z }, R)).toBe(false);
        expect(hitsGround({ x: b.x, y: -4.6, z }, R)).toBe(false);
        expect(hitsGround({ x: b.x, y: -4.4, z }, R)).toBe(true);
        // A deck is a street: flying low over it still clears.
        expect(hitsGround({ x: b.x, y: 3.5, z }, R)).toBe(false);
      }
    }
  });

  it("stops a plane skimming a parapet (bridge edge at |dx| 19.5..20)", () => {
    expect(
      hitsGround({ x: 400 + 19.75, y: PARAPET_HEIGHT + 1.5, z: 1100 }, R),
    ).toBe(true);
    expect(
      hitsGround({ x: 400 + 10, y: PARAPET_HEIGHT + 1.5, z: 1100 }, R),
    ).toBe(false);
  });
});

describe("the torus seam", () => {
  it("is continuous: every probe agrees with its images one world away", () => {
    const rand = mulberry32(11);
    for (let i = 0; i < 4000; i++) {
      const p = {
        x: rand() * WORLD_SIZE,
        y: -22 + rand() * 30,
        z: 1000 + rand() * 200,
      };
      const here = hitsGround(p, R);
      expect(hitsGround({ ...p, x: p.x + WORLD_SIZE }, R)).toBe(here);
      expect(hitsGround({ ...p, x: p.x - WORLD_SIZE }, R)).toBe(here);
      expect(hitsGround({ ...p, z: p.z - WORLD_SIZE }, R)).toBe(here);
    }
  });

  it("carries the x = 0 bridge across the seam: its deck is solid on both sides", () => {
    expect(hitsGround({ x: 1995, y: -1, z: 1100 }, R)).toBe(true);
    expect(hitsGround({ x: 5, y: -1, z: 1100 }, R)).toBe(true);
    expect(hitsGround({ x: 1975, y: -1, z: 1100 }, R)).toBe(false);
    // Under it, a sight line straight through the seam is clear...
    expect(
      losClear({ x: 1950, y: -10, z: 1100 }, { x: 50, y: -10, z: 1100 }, []),
    ).toBe(true);
    // ...and one through the deck is not.
    expect(
      losClear({ x: 1990, y: 5, z: 1100 }, { x: 10, y: -10, z: 1100 }, []),
    ).toBe(false);
  });
});

describe("losClear and the river's solids", () => {
  it("is blocked by a deck between a plane above it and one under it", () => {
    expect(
      losClear({ x: 600, y: 10, z: 1100 }, { x: 600, y: -10, z: 1100 }, []),
    ).toBe(false);
  });

  it("sees under a bridge, down the channel", () => {
    expect(
      losClear({ x: 500, y: -10, z: 1100 }, { x: 700, y: -10, z: 1100 }, []),
    ).toBe(true);
  });

  it("is blocked by the embankment, clear straight up out of the channel", () => {
    // Crosses street level at z = 1000 — inside the bank.
    expect(
      losClear({ x: 100, y: -10, z: 1100 }, { x: 100, y: 10, z: 900 }, []),
    ).toBe(false);
    expect(
      losClear({ x: 100, y: -10, z: 1100 }, { x: 100, y: 60, z: 1110 }, []),
    ).toBe(true);
  });

  it("agrees with collision: a segment any sphere sample hits is never clear", () => {
    // Independent truth: march each segment with the collision primitives
    // (river ground AND the real city) as POINT samples — a sphere of any
    // size grazes boxes the line itself misses. Every sample inside a solid
    // must imply a blocked line; the converse need not hold (a line can clip
    // a corner between two samples).
    const index = buildCityIndex(city);
    const solid = (p: Vec3, r: number) =>
      hitsGround(p, r) || collideCity(p, r, city, index) !== null;
    const rand = mulberry32(7);
    const point = (): Vec3 => ({
      x: 300 + rand() * 400,
      y: -21 + rand() * 40,
      z: 960 + rand() * 280,
    });
    let hitSegments = 0;
    for (let i = 0; i < 1500; i++) {
      const a = point();
      const b = point();
      if (solid(a, 0) || solid(b, 0)) continue;
      let hit = false;
      for (let k = 0; k <= 300 && !hit; k++) {
        const t = k / 300;
        hit = solid(
          {
            x: a.x + (b.x - a.x) * t,
            y: a.y + (b.y - a.y) * t,
            z: a.z + (b.z - a.z) * t,
          },
          0,
        );
      }
      if (hit) {
        hitSegments++;
        expect(losClear(a, b, city)).toBe(false);
      }
    }
    expect(hitSegments).toBeGreaterThan(100);
  });
});

describe("the legal floor and the wire", () => {
  it("lets a plane down to the water over the channel only", () => {
    expect(minAltitude(1100)).toBe(RIVER_WATER_Y);
    expect(minAltitude(1100 + WORLD_SIZE)).toBe(RIVER_WATER_Y);
    expect(minAltitude(1020)).toBe(0);
    expect(minAltitude(500)).toBe(0);
  });

  it("round-trips a snapshot of a plane under a bridge (y = −15)", () => {
    const entry = {
      id: "p1",
      pose: {
        pos: { x: 600, y: -15, z: 1100 },
        quat: { x: 0, y: 0, z: 0, w: 1 },
        speed: 60,
      },
      hp: 100,
      prot: false,
    };
    expect(decodeSnapshotEntry(encodeSnapshotEntry(entry)).pose.pos.y).toBe(
      -15,
    );
  });
});

describe("boats", () => {
  const boats = riverBoats(42);
  const pose: BoatPose = { x: 0, y: 0, z: 0, yaw: 0 };
  const box = (i: number, t: number): BoatBox => {
    const boat = boats[i];
    if (!boat) throw new Error("no boat");
    return boatBoxInto(boat, t, pose, {
      x: 0,
      z: 0,
      hx: 0,
      hz: 0,
      y0: 0,
      y1: 0,
    });
  };

  it("are a pure function of the seed", () => {
    expect(riverBoats(42)).toEqual(boats);
    expect(riverBoats(43)).not.toEqual(boats);
  });

  it("stay on the water inside the channel, under every deck, and never overlap", () => {
    for (let t = 0; t < 3_600_000; t += 7_919) {
      const bs = boats.map((_, i) => box(i, t));
      for (const b of bs) {
        expect(Math.abs(b.z - RIVER_CENTER_Z) + b.hz).toBeLessThan(
          RIVER_HALF_WIDTH,
        );
        expect(b.y1).toBeLessThan(-BRIDGE_DECK_DEPTH);
        expect(b.y1 - b.y0).toBeGreaterThan(
          BOAT_HULL_HEIGHT + BOAT_CABIN_HEIGHT,
        );
      }
      for (let i = 0; i < bs.length; i++) {
        for (let j = i + 1; j < bs.length; j++) {
          const a = bs[i] as BoatBox;
          const b = bs[j] as BoatBox;
          const apart =
            Math.abs(wrapDeltaAxis(a.x, b.x)) > a.hx + b.hx ||
            Math.abs(a.z - b.z) > a.hz + b.hz;
          expect(apart).toBe(true);
        }
      }
    }
  });

  it("are solid where they are drawn, and only there", () => {
    const t = 123_456;
    const b = box(3, t);
    expect(collideBoats({ x: b.x, y: b.y1 - 0.5, z: b.z }, R, boats, t)).toBe(
      3,
    );
    expect(collideBoats({ x: b.x, y: b.y1 + 2.5, z: b.z }, R, boats, t)).toBe(
      -1,
    );
    expect(
      collideBoats({ x: b.x + b.hx + 2.5, y: b.y1 - 0.5, z: b.z }, R, boats, t),
    ).toBe(-1);
  });
});
