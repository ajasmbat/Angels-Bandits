// The L2 moving-obstacle seam. What these tests are actually defending:
//
//   1. Poses are a pure function of (seed, server time). That is the whole
//      reason nothing is streamed — if it drifts, two clients disagree about
//      where a solid object is and one of them dies to nothing.
//   2. The boxes you COLLIDE are the boxes you DRAW. Two derivations of one
//      pose is how invisible walls happen; there is exactly one here and this
//      file proves the collision path uses it.
//   3. Nothing is buried. A jib inside a facade would be a lethal volume you
//      cannot see, which is strictly worse than shipping no cranes at all.
//   4. The jib MOVES — the same flight path is safe or fatal depending on when
//      you fly it. That is the item that turns decoration into gameplay.
//
// Worked numbers for the shipped city (seed 42, WORLD_SIZE 2000, 200 m blocks,
// CONSTRUCTION_BLOCKS (6,6) (6,0) (0,6)): three cranes, all with the full
// CRANE_JIB_MAX = 70 m jib, hubs at 62 / 81 / 87 m — inside the 62-96 m band,
// which is the canyon band the fight happens in. At CRANE_SLEW_MIN..MAX a tip
// at 70 m travels 15-27 m in 15 s, comfortably more than PLAYER_RADIUS.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  type Building,
  CONSTRUCTION_BLOCKS,
  generateCity,
} from "@angels-bandits/common/city";
import { mulberry32 } from "@angels-bandits/common/city";
import {
  type AircraftRoute,
  type CraneSite,
  type MoverBox,
  type MoverField,
  aircraftBox,
  collideBotMovers,
  collideMovers,
  craneBoxes,
  generateMovers,
  slewAngle,
  sphereHitsBox,
} from "@angels-bandits/common/city/movers";
import { isInRoadway } from "@angels-bandits/common/city/street";
import {
  type CityIndex,
  buildCityIndex,
  collideCity,
} from "@angels-bandits/common/collision";
import {
  BLOCK_PITCH,
  BOT_PROBE_TIMES,
  CITY_SEED,
  CRANE_HUB_CLEARANCE,
  CRANE_JIB_MAX,
  CRANE_JIB_MIN,
  CRANE_JIB_SIDE,
  CRANE_MAST_MAX,
  CRANE_MAST_MIN,
  CRANE_MAST_SIDE,
  PLAYER_RADIUS,
  RESPAWN_ALTITUDE,
  WORLD_SIZE,
} from "@angels-bandits/common/constants";
import { type Vec3, wrapDeltaAxis } from "@angels-bandits/common/world";
import { describe, expect, it, vi } from "vitest";

const city = generateCity(CITY_SEED);
const cityIndex = buildCityIndex(city);
const field = generateMovers(CITY_SEED, city);

/** A server-clock-sized time, so nothing is ever tested at a cosy t = 0. */
const T0 = 1_787_000_000_000;

/** Every box of every mover at one time — the rendering view of the world. */
function allBoxes(f: MoverField, t: number): MoverBox[] {
  return [
    ...f.cranes.flatMap((c) => craneBoxes(c, t)),
    ...f.aircraft.map((a) => aircraftBox(a, t)),
  ];
}

describe("generateMovers: the shipped field", () => {
  it("puts one crane on every construction block and nowhere else", () => {
    expect(field.cranes).toHaveLength(CONSTRUCTION_BLOCKS.length);
    const blocks = field.cranes
      .map(
        (c) =>
          `${Math.floor(c.x / BLOCK_PITCH)},${Math.floor(c.z / BLOCK_PITCH)}`,
      )
      .sort();
    expect(blocks).toEqual(
      CONSTRUCTION_BLOCKS.map(([bx, bz]) => `${bx},${bz}`).sort(),
    );
  });

  it("keeps every hub inside the canyon band and every jib buildable", () => {
    for (const c of field.cranes) {
      expect(c.hubY).toBeGreaterThanOrEqual(CRANE_MAST_MIN);
      expect(c.hubY).toBeLessThanOrEqual(CRANE_MAST_MAX);
      expect(c.jibLength).toBeGreaterThanOrEqual(CRANE_JIB_MIN);
      expect(c.jibLength).toBeLessThanOrEqual(CRANE_JIB_MAX);
      expect(c.counterLength).toBeLessThan(c.jibLength);
      expect(c.hookDrop).toBeGreaterThanOrEqual(0);
      // The hook may never hang below the clearance line the jib bought.
      expect(c.hubY - c.hookDrop).toBeGreaterThan(0);
    }
  });

  it("stands every mast on private land, never in the roadway", () => {
    // The S1 street contract is the oracle — no curb offset re-derived here.
    const half = CRANE_MAST_SIDE / 2;
    for (const c of field.cranes) {
      for (const dx of [-half, half]) {
        for (const dz of [-half, half]) {
          expect(isInRoadway({ x: c.x + dx, y: 0, z: c.z + dz })).toBe(false);
        }
      }
    }
  });

  it("oversails the street — a jib that stayed inside its block is not a hazard", () => {
    // A block is BLOCK_PITCH wide, so a jib reaching past half the block from
    // an inset mast is what puts it over a canyon. This is the design intent,
    // stated as a test so a future retune cannot quietly lose it.
    for (const c of field.cranes) {
      expect(c.jibLength).toBeGreaterThan(BLOCK_PITCH / 4);
    }
  });

  it("flies helicopters below the blimp, and the blimp below the cloud deck", () => {
    const blimp = field.aircraft.filter((a) => a.kind === "blimp");
    expect(blimp).toHaveLength(1);
    for (const heli of field.aircraft.filter((a) => a.kind === "helicopter")) {
      expect(heli.y).toBeLessThan(blimp[0]?.y ?? 0);
    }
  });
});

describe("purity: the claim that nothing has to be streamed", () => {
  // The repo has no browser test environment, so "client and server agree" is
  // proven the same way generateCity's agreement is: the module cannot consult
  // anything that differs between the two. A seeded PRNG and a caller-supplied
  // clock are the only inputs there are.
  const sources = ["../src/city/movers.ts", "../src/fireworks.ts"].map((rel) =>
    readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8"),
  );

  it("never reaches for a clock or an unseeded random", () => {
    for (const src of sources) {
      const code = src
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("*"))
        .filter((line) => !line.trimStart().startsWith("//"))
        .join("\n");
      expect(code).not.toMatch(/Math\.random/);
      expect(code).not.toMatch(/Date\.now/);
      expect(code).not.toMatch(/performance\.now/);
      expect(code).not.toMatch(/new Date/);
    }
  });

  it("gives byte-identical poses for the same (seed, time), twice", () => {
    const a = allBoxes(generateMovers(CITY_SEED, city), T0 + 1234);
    const b = allBoxes(generateMovers(CITY_SEED, city), T0 + 1234);
    expect(a).toEqual(b);
  });

  it("gives byte-identical poses from a freshly imported module", async () => {
    // Two tabs are two module instances. Nothing may be memoised across them.
    const before = allBoxes(field, T0 + 77_777);
    vi.resetModules();
    const mod = await import("@angels-bandits/common/city/movers");
    const cityMod = await import("@angels-bandits/common/city");
    const after = allBoxes(
      mod.generateMovers(CITY_SEED, cityMod.generateCity(CITY_SEED)),
      T0 + 77_777,
    );
    expect(after).toEqual(before);
  });

  it("gives a different world for a different seed", () => {
    const other = generateMovers(CITY_SEED + 1, generateCity(CITY_SEED + 1));
    expect(allBoxes(other, T0)).not.toEqual(allBoxes(field, T0));
  });
});

describe("slewAngle", () => {
  it("stays in [0, 2pi) at epoch-ms times and at negative phases", () => {
    for (const c of field.cranes) {
      for (const t of [0, 1000, T0, T0 + 987_654_321]) {
        const a = slewAngle(c, t);
        expect(a).toBeGreaterThanOrEqual(0);
        expect(a).toBeLessThan(Math.PI * 2);
      }
    }
  });

  it("advances by omega per second, with epoch-ms precision to spare", () => {
    const c = field.cranes[0] as CraneSite;
    const dt = 10_000;
    const step = slewAngle(c, T0 + dt) - slewAngle(c, T0);
    const wrapped = step < -Math.PI ? step + Math.PI * 2 : step;
    expect(wrapped).toBeCloseTo(c.omega * (dt / 1000), 6);
  });

  it("turns a full revolution in a readable few minutes", () => {
    for (const c of field.cranes) {
      const period = (Math.PI * 2) / Math.abs(c.omega);
      expect(period).toBeGreaterThan(200);
      expect(period).toBeLessThan(500);
    }
  });
});

describe("collision: the boxes you collide are the boxes you draw", () => {
  /** Brute force: does the sphere touch ANY rendered box? */
  const bruteForce = (pos: Vec3, radius: number, t: number) =>
    allBoxes(field, t).some((b) => sphereHitsBox(b, pos, radius));

  it("agrees with a brute-force scan of craneBoxes/aircraftBox over 4000 samples", () => {
    // The same shape as collision.test.ts's indexed-vs-linear parity test: the
    // fast path and the honest path must never disagree, ever. Samples are
    // drawn ON the geometry (jittered just past each box's own half-extents)
    // rather than uniformly over the map — a 2.6 m jib is a vanishing target
    // in a 2 km world, and a parity test made of misses proves nothing.
    const rand = mulberry32(0xb0a7);
    const mismatches: string[] = [];
    let hits = 0;
    for (let i = 0; i < 4000; i++) {
      const t = T0 + rand() * 600_000;
      const boxes = allBoxes(field, t);
      const box = boxes[Math.floor(rand() * boxes.length)] as MoverBox;
      const ax = Math.cos(box.yaw);
      const az = -Math.sin(box.yaw);
      // Local offset, up to 1.6x the box, then rotated back into the world.
      const lx = (rand() * 2 - 1) * box.hx * 1.6;
      const lz = (rand() * 2 - 1) * (box.hz + PLAYER_RADIUS) * 1.6;
      const pos: Vec3 = {
        x: box.x + ax * lx - az * lz,
        y: box.y + (rand() * 2 - 1) * (box.hy + PLAYER_RADIUS) * 1.6,
        z: box.z + az * lx + ax * lz,
      };
      const fast = collideMovers(pos, PLAYER_RADIUS, field, t) !== null;
      const slow = boxes.some((b) => sphereHitsBox(b, pos, PLAYER_RADIUS));
      if (fast) hits++;
      if (fast !== slow) {
        mismatches.push(
          `t=${t} pos=(${pos.x.toFixed(1)},${pos.y.toFixed(1)},${pos.z.toFixed(1)}) fast=${fast} slow=${slow}`,
        );
      }
    }
    expect(mismatches.slice(0, 5)).toEqual([]);
    // Vacuity guards, both directions: the sampler must produce real hits AND
    // real misses, or "they agree" is trivially true.
    expect(hits).toBeGreaterThan(400);
    expect(hits).toBeLessThan(3600);
  });

  it("reports the part it hit, and the crane it belongs to", () => {
    const c = field.cranes[0] as CraneSite;
    const hit = collideMovers(
      { x: c.x, y: c.hubY / 2, z: c.z },
      PLAYER_RADIUS,
      field,
      T0,
    );
    expect(hit).toEqual({ kind: "mast", id: c.id });
  });

  it("finds only air well clear of every mover", () => {
    expect(
      collideMovers({ x: 0, y: 1000, z: 0 }, PLAYER_RADIUS, field, T0),
    ).toBeNull();
  });
});

describe("collision is torus-correct", () => {
  /** A hand-built crane straddling the seam: mast at x = 4, jib reaching back
   * across x = 0 into the far side of the world. */
  const seamCrane: CraneSite = {
    id: 0,
    x: 4,
    z: 1000,
    hubY: 80,
    jibLength: 60,
    counterLength: 20,
    theta0: Math.PI, // local +X points at world -X: straight across the seam
    omega: 0,
    trolleyR: 30,
    hookDrop: 15,
  };
  const seamField: MoverField = { cranes: [seamCrane], aircraft: [] };

  it("catches a plane at x ~ WORLD_SIZE - 10 with a crane at x = 4", () => {
    // theta = PI puts local +X along world -X, so the jib runs 4 -> -56, i.e.
    // 4 -> WORLD_SIZE - 56 once wrapped. x = 1990 is 14 m out along it.
    const hit = collideMovers(
      { x: WORLD_SIZE - 10, y: 80, z: 1000 },
      PLAYER_RADIUS,
      seamField,
      0,
    );
    expect(hit?.kind).toBe("jib");
  });

  it("does not catch a plane a whole world away from the same crane", () => {
    expect(
      collideMovers({ x: 1004, y: 80, z: 1000 }, PLAYER_RADIUS, seamField, 0),
    ).toBeNull();
  });

  it("canonicalizes every rendered box", () => {
    for (const b of allBoxes(field, T0 + 4321)) {
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.x).toBeLessThan(WORLD_SIZE);
      expect(b.z).toBeGreaterThanOrEqual(0);
      expect(b.z).toBeLessThan(WORLD_SIZE);
    }
  });
});

describe("the jib MOVES — this is the test that proves movers move", () => {
  it("collides on a path through the swept jib, and misses it 15 s later", () => {
    const found: string[] = [];
    for (const c of field.cranes) {
      // A point on the jib right now, two thirds out along the boom.
      const theta = slewAngle(c, T0);
      const r = (c.jibLength * 2) / 3;
      const pos: Vec3 = {
        x: c.x + Math.cos(theta) * r,
        y: c.hubY,
        z: c.z - Math.sin(theta) * r,
      };
      expect(collideMovers(pos, PLAYER_RADIUS, field, T0)?.kind).toBe("jib");
      // The identical point 15 s later: the jib has slewed off it. At the
      // shipped slew rates that is 15-27 m of tip travel, and the boom is only
      // CRANE_JIB_SIDE wide.
      expect(collideMovers(pos, PLAYER_RADIUS, field, T0 + 15_000)).toBeNull();
      found.push(`crane ${c.id}`);
    }
    expect(found).toHaveLength(field.cranes.length);
  });

  it("is symmetric — a point that is clear now is fatal once the jib arrives", () => {
    const c = field.cranes[0] as CraneSite;
    const period = (Math.PI * 2) / Math.abs(c.omega);
    // Half a revolution ahead, aimed where the jib WILL be.
    const later = T0 + (period / 2) * 1000;
    const theta = slewAngle(c, later);
    const r = (c.jibLength * 2) / 3;
    const pos: Vec3 = {
      x: c.x + Math.cos(theta) * r,
      y: c.hubY,
      z: c.z - Math.sin(theta) * r,
    };
    expect(collideMovers(pos, PLAYER_RADIUS, field, T0)).toBeNull();
    expect(collideMovers(pos, PLAYER_RADIUS, field, later)?.kind).toBe("jib");
  });

  it("moves further than a player radius inside one probe horizon", () => {
    // The property server/src/bots.ts depends on. A probe samples a point the
    // bot reaches up to max(BOT_PROBE_TIMES) seconds from now, so it must pose
    // the crane at the ARRIVAL time; asking "is the jib there now?" is asking
    // the wrong question. Worth stating the size honestly: at the shipped slew
    // rates the tip travels 1.5-2.7 m over 2.6 s, against a sphere window of
    // PLAYER_RADIUS + CRANE_JIB_SIDE / 2 = 3.3 m. So the lead is not the
    // difference between hitting and missing on any single sample — it is a
    // systematic bias, and a probe without it steers into the jib's future
    // position every time.
    const horizon = Math.max(...BOT_PROBE_TIMES);
    for (const c of field.cranes) {
      const travel = Math.abs(c.omega) * horizon * c.jibLength;
      expect(travel).toBeGreaterThan(PLAYER_RADIUS);
    }
  });

  it("flips a fixed point from fatal to clear well inside one slew period", () => {
    // The unambiguous version of the same fact, at the horizon where the jib
    // has certainly cleared the sphere.
    const c = field.cranes[0] as CraneSite;
    const r = c.jibLength;
    const theta = slewAngle(c, T0);
    const pos: Vec3 = {
      x: c.x + Math.cos(theta) * r * 0.95,
      y: c.hubY,
      z: c.z - Math.sin(theta) * r * 0.95,
    };
    expect(collideMovers(pos, PLAYER_RADIUS, field, T0)).not.toBeNull();
    expect(collideMovers(pos, PLAYER_RADIUS, field, T0 + 15_000)).toBeNull();
  });
});

describe("nothing is buried: a jib inside a facade is an invisible killer", () => {
  /**
   * Walk every crane part's centerline in 1 m steps and ask the CITY whether
   * that sphere is inside a building. collideCity grows each tier box by the
   * radius, so a "no hit" answer here is conservative in the safe direction.
   */
  function partSweepClear(
    boxes: MoverBox[],
    buildings: readonly Building[],
    index: CityIndex,
  ): string[] {
    const bad: string[] = [];
    for (const b of boxes) {
      const ax = Math.cos(b.yaw);
      const az = -Math.sin(b.yaw);
      const radius = Math.max(b.hz, b.hy);
      for (let s = -b.hx; s <= b.hx; s += 1) {
        const p = { x: b.x + ax * s, y: b.y, z: b.z + az * s };
        const hit = collideCity(p, radius, buildings, index);
        if (hit) {
          bad.push(
            `${b.kind}#${b.id} at s=${s.toFixed(0)} inside building at (${hit.x.toFixed(0)}, ${hit.z.toFixed(0)}) h=${hit.height}`,
          );
          break;
        }
      }
    }
    return bad;
  }

  it("keeps every crane box clear of every building across a full revolution", () => {
    const bad: string[] = [];
    let sampled = 0;
    for (const c of field.cranes) {
      const period = ((Math.PI * 2) / Math.abs(c.omega)) * 1000;
      for (let i = 0; i < 64; i++) {
        const t = T0 + (period * i) / 64;
        bad.push(...partSweepClear(craneBoxes(c, t), city, cityIndex));
        sampled++;
      }
    }
    expect(bad.slice(0, 8)).toEqual([]);
    expect(sampled).toBe(field.cranes.length * 64);
  });

  it("keeps the clearance the generator promised above the tallest neighbour", () => {
    for (const c of field.cranes) {
      const reach = c.jibLength + CRANE_JIB_SIDE / 2 + PLAYER_RADIUS;
      let tallest = 0;
      for (const b of city) {
        const dx = Math.max(0, Math.abs(wrapDeltaAxis(b.x, c.x)) - b.width / 2);
        const dz = Math.max(0, Math.abs(wrapDeltaAxis(b.z, c.z)) - b.depth / 2);
        if (dx * dx + dz * dz <= reach * reach)
          tallest = Math.max(tallest, b.height);
      }
      expect(c.hubY - c.hookDrop).toBeGreaterThanOrEqual(
        tallest + CRANE_HUB_CLEARANCE,
      );
    }
  });
});

describe("respawn can never drop a player inside a mover", () => {
  // server/src/respawn.ts picks a purely random x/z at RESPAWN_ALTITUDE with
  // NO geometry check, on the grounds that the altitude is above every
  // rooftop. L2 adds the first solid geometry up there, so that assumption
  // stops being free and becomes this invariant.
  it("clears RESPAWN_ALTITUDE by a player radius at every sampled time", () => {
    const violations: string[] = [];
    for (let i = 0; i < 64; i++) {
      const t = T0 + i * 5_000;
      for (const b of allBoxes(field, t)) {
        const lo = b.y - b.hy - PLAYER_RADIUS;
        const hi = b.y + b.hy + PLAYER_RADIUS;
        if (lo <= RESPAWN_ALTITUDE && RESPAWN_ALTITUDE <= hi) {
          violations.push(
            `${b.kind}#${b.id} spans ${lo.toFixed(1)}..${hi.toFixed(1)}`,
          );
        }
      }
    }
    expect(violations.slice(0, 5)).toEqual([]);
  });
});

describe("collideBotMovers: what bots are allowed to hit", () => {
  it("is blind to helicopters", () => {
    const heli = field.aircraft.find(
      (a) => a.kind === "helicopter",
    ) as AircraftRoute;
    const box = aircraftBox(heli, T0);
    const pos = { x: box.x, y: box.y, z: box.z };
    // Solid to a player...
    expect(collideMovers(pos, PLAYER_RADIUS, field, T0)?.kind).toBe(
      "helicopter",
    );
    // ...and thin air to a bot, which is why bots need not probe for one.
    expect(collideBotMovers(pos, PLAYER_RADIUS, field, T0)).toBeNull();
  });

  it("is NOT blind to the blimp — 60 m of hull under the bot ceiling", () => {
    const blimp = field.aircraft.find(
      (a) => a.kind === "blimp",
    ) as AircraftRoute;
    const box = aircraftBox(blimp, T0);
    const pos = { x: box.x, y: box.y, z: box.z };
    expect(collideBotMovers(pos, PLAYER_RADIUS, field, T0)?.kind).toBe("blimp");
  });

  it("sees every crane part a player sees", () => {
    for (const c of field.cranes) {
      for (const box of craneBoxes(c, T0)) {
        const pos = { x: box.x, y: box.y, z: box.z };
        expect(collideBotMovers(pos, PLAYER_RADIUS, field, T0)).not.toBeNull();
      }
    }
  });
});

describe("aircraft routes close on the torus", () => {
  it("returns to the same pose after one lap", () => {
    for (const a of field.aircraft) {
      const lapMs = (WORLD_SIZE / a.speed) * 1000;
      const start = aircraftBox(a, T0);
      const lap = aircraftBox(a, T0 + lapMs);
      expect(lap.x).toBeCloseTo(start.x, 6);
      expect(lap.z).toBeCloseTo(start.z, 6);
      expect(lap.yaw).toBe(start.yaw);
    }
  });

  it("points its hull along travel", () => {
    for (const a of field.aircraft) {
      const t0 = aircraftBox(a, T0);
      const t1 = aircraftBox(a, T0 + 100);
      // Local +X maps to world (cos yaw, -sin yaw); travel must agree with it.
      const ax = Math.cos(t0.yaw);
      const az = -Math.sin(t0.yaw);
      const dx = wrapDeltaAxis(t0.x, t1.x);
      const dz = wrapDeltaAxis(t0.z, t1.z);
      expect(ax * dx + az * dz).toBeGreaterThan(0);
    }
  });
});
