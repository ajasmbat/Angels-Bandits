// F5 corner speed manager (client/src/game/corner-speed.ts): the pure
// ceiling `cornerSpeed` and its rate limiter, against hand-built walls and
// the real seed-42 city. The closed-loop corner test flies the real
// stepFlight at 60 Hz, so it measures what a pilot actually gets.

import {
  type Building,
  cityHoles,
  generateCity,
} from "@angels-bandits/common/city";
import {
  type MoverField,
  collideMovers,
  generateMovers,
} from "@angels-bandits/common/city/movers";
import { natureFor } from "@angels-bandits/common/city/nature";
import { bridgeSpans } from "@angels-bandits/common/city/river";
import {
  buildCityIndex,
  buildNatureIndex,
  collideCity,
  collideNature,
} from "@angels-bandits/common/collision";
import {
  BLOCK_PITCH,
  CITY_SEED,
  MAX_SPEED,
  MIN_SPEED,
  PLAYER_RADIUS,
  WORLD_SIZE,
} from "@angels-bandits/common/constants";
import {
  type FlightState,
  stepFlight,
  turnRadius,
} from "@angels-bandits/common/flight";
import { type Vec3, wrapDelta } from "@angels-bandits/common/world";
import { describe, expect, it } from "vitest";
import {
  CAP_FALL_RATE,
  CAP_RISE_RATE,
  type CornerWorld,
  cornerCapInput,
  cornerSpeed,
  holeCorridors,
  stepCornerCap,
  wallEnvelope,
} from "../src/game/corner-speed";

const DT = 1 / 60;

/** Level flight at `speed` facing yaw (0 = −Z). */
const at = (pos: Vec3, yaw = 0, speed = MAX_SPEED): FlightState => ({
  pos,
  yaw,
  pitch: 0,
  roll: 0,
  speed,
  targetSpeed: MAX_SPEED,
});

/** One solid box tower, centered at (x, z). */
const tower = (
  x: number,
  z: number,
  width: number,
  depth: number,
  height = 200,
): Building => ({
  x,
  z,
  width,
  depth,
  height,
  tiers: [{ width, depth, height }],
});

/** A world of hand-built buildings — no trees, no movers, no holes. */
const worldOf = (buildings: Building[]): CornerWorld => ({
  buildings,
  index: buildCityIndex(buildings),
  corridors: [],
});

// The real city, built once.
const buildings = generateCity(CITY_SEED);
const index = buildCityIndex(buildings);
const nature = buildNatureIndex(natureFor(CITY_SEED, buildings));
const movers: MoverField = generateMovers(CITY_SEED, buildings);
const spans = [...cityHoles(buildings), ...bridgeSpans()];
const city: CornerWorld = {
  buildings,
  index,
  nature,
  movers,
  corridors: holeCorridors(spans),
};
/** The mover clock the city tests are frozen at. */
const T = 60_000;
const crashes = (p: Vec3): boolean =>
  collideCity(p, PLAYER_RADIUS, buildings, index) !== null ||
  collideNature(p, PLAYER_RADIUS, nature) !== null ||
  collideMovers(p, PLAYER_RADIUS, movers, T) !== null;

describe("cornerSpeed — open air and walls ahead", () => {
  it("open sky: MAX_SPEED, turning or not", () => {
    const empty = worldOf([]);
    const f = at({ x: 500, y: 300, z: 500 });
    expect(cornerSpeed(f, empty)).toBe(MAX_SPEED);
    expect(cornerSpeed(f, empty, 1)).toBe(MAX_SPEED);
    expect(cornerSpeed(f, empty, -1)).toBe(MAX_SPEED);
    // Above every roof of the real city too (tallest landmark 250 m).
    for (let i = 0; i < 40; i++) {
      const g = at({ x: i * 49, y: 420, z: (i * 131) % WORLD_SIZE }, i);
      expect(cornerSpeed(g, city, 1, T)).toBe(MAX_SPEED);
    }
  });

  it("a wall beyond the brake-first horizon costs nothing, even head-on", () => {
    // Brake from 90 to MIN_SPEED at 0.85 × 22 m/s², then a 29.6 m radius
    // 90° turn: ~206 m. A 400 m-wide face 215 m ahead is still free.
    const face = 400 - 215;
    const w = worldOf([tower(500, face - 100, 400, 200)]);
    expect(cornerSpeed(at({ x: 500, y: 50, z: 400 }), w)).toBe(MAX_SPEED);
  });

  it("a block corner a few degrees off the nose is a correction, not a wall", () => {
    // A 100 m block whose corner sits 2 m right of the nose line, 120 m out:
    // the nose ray clips its front face, but 4° of correction clears it.
    const w = worldOf([tower(552, 230, 100, 100)]);
    const g = at({ x: 500, y: 50, z: 400 });
    expect(cornerSpeed(g, w)).toBe(MAX_SPEED);
    // Control: the same block dead ahead is a real wall at 120 m.
    const ahead = worldOf([tower(500, 230, 100, 100)]);
    expect(cornerSpeed(g, ahead)).toBeLessThan(MAX_SPEED);
  });

  it("a wall within its stopping horizon: a speed that can brake and then turn inside the free space", () => {
    let prev = MAX_SPEED;
    for (const gap of [100, 80, 60, 45, 36]) {
      const face = 400 - gap;
      const w = worldOf([tower(500, face - 100, 400, 200)]);
      const v = cornerSpeed(at({ x: 500, y: 50, z: 400 }), w);
      expect(v).toBeLessThan(MAX_SPEED);
      expect(v).toBeLessThanOrEqual(prev); // closer ⇒ slower
      prev = v;
      // Brake at the design deceleration (0.75 × 22 m/s²) to some v_t, then
      // a full-deflection 90° turn: the forward room it needs fits the gap
      // (the march resolves the wall to 6 m, so allow one step).
      let fits = false;
      for (let vt = MIN_SPEED; vt <= v; vt += 0.5) {
        const brake = (v * v - vt * vt) / (2 * 0.75 * 22);
        if (brake + turnRadius(vt) + PLAYER_RADIUS <= gap + 6) fits = true;
      }
      expect(fits).toBe(true);
    }
  });

  it("is finite and inside [MIN_SPEED, MAX_SPEED] everywhere — a wall inside the margin is MIN_SPEED, never NaN", () => {
    const w = worldOf([tower(500, 300, 400, 200)]); // face at z = 400
    expect(cornerSpeed(at({ x: 500, y: 50, z: 404 }), w)).toBe(MIN_SPEED);
    expect(wallEnvelope(0)).toBe(MIN_SPEED);
    expect(wallEnvelope(-5)).toBe(MIN_SPEED);
    expect(wallEnvelope(50, 0)).toBe(MAX_SPEED);
    expect(wallEnvelope(50, 1e-12)).toBe(MAX_SPEED);
    expect(wallEnvelope(Number.POSITIVE_INFINITY)).toBe(MAX_SPEED);
    for (let i = 0; i < 300; i++) {
      const f = at(
        {
          x: (i * 37.3) % WORLD_SIZE,
          y: 8 + (i % 9) * 15,
          z: (i * 91.7) % WORLD_SIZE,
        },
        i * 0.7,
      );
      for (const turn of [0, 1, -1]) {
        const v = cornerSpeed(f, city, turn, T);
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(MIN_SPEED);
        expect(v).toBeLessThanOrEqual(MAX_SPEED);
      }
    }
  });

  it("a grazing face never brakes: 5° off a long wall, 10 m from it", () => {
    // A wall along z on the plane's right (x ≥ 510), 1 km long.
    const w = worldOf([tower(610, 0, 200, 1000)]);
    const yaw = -5 * (Math.PI / 180); // 5° right: toward the wall
    const v = cornerSpeed(at({ x: 500, y: 50, z: 400 }, yaw), w);
    expect(v).toBe(MAX_SPEED);
  });

  it("steep dives and climbs are the elevator's business — and the ground is never a wall", () => {
    const w = worldOf([tower(500, 300, 400, 200)]); // face 30 m ahead
    const dive = { ...at({ x: 500, y: 60, z: 430 }), pitch: -0.8 };
    expect(cornerSpeed(dive, w)).toBe(MAX_SPEED);
    // Strafing run toward the open street: the ground ahead never brakes.
    const strafe = { ...at({ x: 500, y: 30, z: 500 }), pitch: -0.4 };
    expect(cornerSpeed(strafe, worldOf([]))).toBe(MAX_SPEED);
  });
});

describe("cornerSpeed — steering intent", () => {
  // Plane on the centreline of a 40 m canyon, mid-block: walls at x = 480
  // and x = 520, running 1 km along z.
  const canyon = worldOf([
    tower(380, 500, 200, 1000),
    tower(620, 500, 200, 1000),
  ]);
  const f = at({ x: 500, y: 50, z: 500 });

  it("small corrections never brake; only a committed hard turn does", () => {
    expect(cornerSpeed(f, canyon, 0)).toBe(MAX_SPEED);
    expect(cornerSpeed(f, canyon, 0.3)).toBe(MAX_SPEED);
    expect(cornerSpeed(f, canyon, 1)).toBe(MIN_SPEED); // that arc is a wall
  });

  it("an open cross street ahead: the fastest speed whose 90° arc clears it", () => {
    // Cross street (40 m wide) centred 45 m ahead, opening to the right.
    const corner = worldOf([
      tower(380, 500, 200, 1000), // left wall, unbroken
      tower(620, 600, 200, 190), // right wall, before the corner
      tower(620, 255, 200, 390), // right wall, beyond the cross street
    ]);
    const g = at({ x: 500, y: 50, z: 520 }); // street-B centre at z = 475
    const v = cornerSpeed(g, corner, 1);
    expect(v).toBeGreaterThan(MIN_SPEED);
    expect(v).toBeLessThan(MAX_SPEED);
    // The arc at that radius from here clears the corner (z ≥ 495 block edge
    // at x ≥ 520) — the same geometry the closed loop below flies for real.
    expect(turnRadius(v)).toBeLessThan(65);
  });
});

describe("cornerSpeed — hole corridors", () => {
  /** Every in-corridor pose of every seed-42 hole: mouths and middle, both
   * directions, at the hole's centre height. */
  const poses = () => {
    const out: { pos: Vec3; yaw: number; kind: string }[] = [];
    for (const s of cityHoles(buildings)) {
      const x = s.hole.axis === "x";
      for (const dir of [1, -1]) {
        // yaw facing +x is −π/2, −x is +π/2, +z is π, −z is 0.
        const yaw = x
          ? dir === 1
            ? -Math.PI / 2
            : Math.PI / 2
          : dir === 1
            ? Math.PI
            : 0;
        for (const t of [-0.5, -0.25, 0, 0.25, 0.5]) {
          const along = t * s.length;
          out.push({
            pos: {
              x: s.center.x + (x ? along : 0),
              y: s.center.y,
              z: s.center.z + (x ? 0 : along),
            },
            yaw,
            kind: s.hole.kind,
          });
        }
      }
    }
    return out;
  };

  it("the hole's own jambs and lintel never cost speed: ±8.6° off the axis and turning hard, the same speed as dead on the axis", () => {
    const all = poses();
    expect(all.length).toBeGreaterThan(100);
    for (const { pos, yaw } of all) {
      const straight = cornerSpeed(at(pos, yaw), city, 0, T);
      for (const skew of [0.15, -0.15]) {
        for (const turn of [0, 1, -1]) {
          expect(cornerSpeed(at(pos, yaw + skew), city, turn, T)).toBe(
            straight,
          );
        }
      }
    }
  });

  it("threading a hole whose far side is open air: MAX_SPEED the whole way", () => {
    let open = 0;
    for (const { pos, yaw } of poses()) {
      // Open air past the far mouth along the axis, for the whole horizon.
      const fx = -Math.sin(yaw);
      const fz = -Math.cos(yaw);
      let clear = true;
      for (let d = 0; d <= 240 && clear; d += 4) {
        const p = { x: pos.x + fx * d, y: pos.y, z: pos.z + fz * d };
        if (collideCity(p, 4, buildings, index) || collideNature(p, 4, nature))
          clear = false;
      }
      if (!clear) continue;
      open++;
      for (const skew of [0, 0.15, -0.15]) {
        expect(cornerSpeed(at(pos, yaw + skew), city, 1, T)).toBe(MAX_SPEED);
      }
    }
    expect(open).toBeGreaterThan(40);
  });

  it("H2: lined up on any clear-air hole from 80 m out, nothing costs speed — the approach, the hole, and 40 m past the exit", () => {
    let checked = 0;
    for (const s of cityHoles(buildings)) {
      if (s.hole.kind === "arch") continue; // hand-placed run-in (H1)
      const x = s.hole.axis === "x";
      for (const dir of [1, -1]) {
        const yaw = x
          ? dir === 1
            ? -Math.PI / 2
            : Math.PI / 2
          : dir === 1
            ? Math.PI
            : 0;
        const fx = -Math.sin(yaw);
        const fz = -Math.cos(yaw);
        for (
          let along = -(s.length / 2 + 80);
          along <= s.length / 2 + 40;
          along += 10
        ) {
          const pos = {
            x: s.center.x + (x ? dir * along : 0),
            y: s.center.y,
            z: s.center.z + (x ? 0 : dir * along),
          };
          // Only where the whole horizon ahead is open air (a real wall
          // past the run-out may still, rightly, cost speed).
          let clear = true;
          for (let d = 0; d <= 240 && clear; d += 4) {
            const p = { x: pos.x + fx * d, y: pos.y, z: pos.z + fz * d };
            if (
              collideCity(p, 4, buildings, index) ||
              collideNature(p, 4, nature)
            )
              clear = false;
          }
          if (!clear) continue;
          checked++;
          expect(cornerSpeed(at(pos, yaw), city, 0, T)).toBe(MAX_SPEED);
        }
      }
    }
    expect(checked).toBeGreaterThan(100);
  });
});

describe("stepCornerCap — smooth, no oscillation", () => {
  it("falls at most CAP_FALL_RATE and recovers at most CAP_RISE_RATE, never overshooting", () => {
    expect(stepCornerCap(90, 40, DT)).toBeCloseTo(90 - CAP_FALL_RATE * DT, 9);
    expect(stepCornerCap(50, 40, 1)).toBe(40);
    expect(stepCornerCap(40, 90, DT)).toBeCloseTo(40 + CAP_RISE_RATE * DT, 9);
    expect(stepCornerCap(89.99, 90, 1)).toBe(90);
    expect(cornerCapInput(MAX_SPEED)).toBeUndefined();
    expect(cornerCapInput(60)).toBe(60);
  });

  it("flying straight at a wall: the cap is monotone non-increasing, every step within the limiter, and the plane can always still turn away", () => {
    const w = worldOf([tower(500, -100, 400, 200)]); // face at z = 0
    let f = at({ x: 500, y: 50, z: 330 });
    let cap = MAX_SPEED;
    let steps = 0;
    while (f.pos.z > 40) {
      const next = stepCornerCap(cap, cornerSpeed(f, w), DT);
      expect(next).toBeLessThanOrEqual(cap);
      expect(cap - next).toBeLessThanOrEqual(CAP_FALL_RATE * DT + 1e-9);
      cap = next;
      // A full-deflection turn at the current speed still misses the wall.
      expect(turnRadius(f.speed) + PLAYER_RADIUS).toBeLessThanOrEqual(f.pos.z);
      f = stepFlight(
        f,
        {
          pitch: 0,
          turn: 0,
          roll: 0,
          throttle: 1,
          cornerCap: cornerCapInput(cap),
        },
        DT,
      );
      steps++;
    }
    expect(steps).toBeGreaterThan(100);
    expect(cap).toBeLessThan(50); // it did brake for the wall
    expect(f.speed).toBeLessThan(50);
  });

  it("a straight avenue run with ±8° wander and ±10 m off the centreline never brakes", () => {
    // Every north–south avenue at 30 m whose 1 km run is clear of trees,
    // movers and the viaduct along its centreline band.
    let avenues = 0;
    for (let line = 0; line < WORLD_SIZE / BLOCK_PITCH; line++) {
      const x0 = line * BLOCK_PITCH;
      let clear = true;
      for (let s = 0; s <= 1100 && clear; s += 4) {
        for (const off of [-12, 0, 12]) {
          if (crashes({ x: x0 + off, y: 30, z: 1900 - s })) clear = false;
        }
      }
      if (!clear) continue;
      avenues++;
      for (let s = 0; s <= 1000; s += 5) {
        const pos = { x: x0 + 10 * Math.sin(s / 97), y: 30, z: 1900 - s };
        const yaw = ((8 * Math.PI) / 180) * Math.sin(s / 53);
        const v = cornerSpeed(at(pos, yaw), city, 0, T);
        expect(v).toBeGreaterThanOrEqual(0.95 * MAX_SPEED);
      }
    }
    expect(avenues).toBeGreaterThan(0);
  });

  it("costs ≤ 0.5 ms median per call (straight and turning hard)", () => {
    const times: number[] = [];
    for (let i = 0; i < 1200; i++) {
      const f = at(
        {
          x: (i * 37) % WORLD_SIZE,
          y: 25 + (i % 6) * 20,
          z: (i * 91) % WORLD_SIZE,
        },
        i,
      );
      const t0 = performance.now();
      cornerSpeed(f, city, i % 2 ? 1 : 0, T);
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    expect(times[times.length >> 1]).toBeLessThan(0.5);
  });
});

describe("closed loop: 90° street corners from full speed (seed 42)", () => {
  const Y = 30;
  /** Commit point before the intersection centre, m — the middle of the
   * measured 60–70 m turn-in window from 90 m/s with the manager. */
  const COMMIT = 65;

  /** Straight approach down −z on the line x = cx into the intersection at
   * (cx, cz), committing a full `dir` turn (+1 right = toward +x) at COMMIT
   * and releasing at 90° of yaw. */
  function corner(cx: number, cz: number, dir: 1 | -1, manager: boolean) {
    let f = at({ x: cx, y: Y, z: (cz + 300) % WORLD_SIZE });
    const centre = { x: cx, y: Y, z: cz };
    let cap = MAX_SPEED;
    let committed = false;
    let commitSpeed = 0;
    let capBeforeCommit = MAX_SPEED;
    for (let i = 0; i < 60 * 12; i++) {
      const d = wrapDelta(centre, f.pos);
      if (!committed && d.z <= COMMIT) {
        committed = true;
        commitSpeed = f.speed;
      }
      const done = Math.abs(f.yaw) >= Math.PI / 2;
      const turn = committed && !done ? dir : 0;
      if (manager) cap = stepCornerCap(cap, cornerSpeed(f, city, turn, T), DT);
      if (!committed) capBeforeCommit = Math.min(capBeforeCommit, cap);
      f = stepFlight(
        f,
        {
          pitch: 0,
          roll: 0,
          throttle: 1,
          turn,
          cornerCap: manager ? cornerCapInput(cap) : undefined,
        },
        DT,
      );
      if (done) f = { ...f, yaw: -dir * (Math.PI / 2) };
      if (crashes(f.pos)) return { ok: false, commitSpeed, capBeforeCommit };
      if (done && Math.abs(wrapDelta(centre, f.pos).x) > 120) break;
    }
    return { ok: true, commitSpeed, capBeforeCommit };
  }

  // Deterministic pick: every intersection and turn direction whose straight
  // approach and cross street are clear at Y, with the inner corner building
  // standing (and above Y) — the corner that has to be flown round.
  const picks: [number, number, 1 | -1][] = [];
  const n = WORLD_SIZE / BLOCK_PITCH;
  for (let ix = 0; ix < n; ix++) {
    for (let iz = 0; iz < n; iz++) {
      for (const dir of [1, -1] as const) {
        const cx = ix * BLOCK_PITCH;
        const cz = iz * BLOCK_PITCH;
        let clear = true;
        // Straight through the intersection for the whole probe horizon, so
        // the approach is a through-avenue, not a T-junction.
        for (let s = -240; s <= 300 && clear; s += 2) {
          if (crashes({ x: cx, y: Y, z: cz + s })) clear = false;
        }
        for (let s = 0; s <= 140 && clear; s += 2) {
          if (crashes({ x: cx + dir * s, y: Y, z: cz })) clear = false;
        }
        const inner = { x: cx + dir * 26, y: Y, z: cz + 26 };
        if (clear && collideCity(inner, 2, buildings, index)) {
          picks.push([cx, cz, dir]);
        }
      }
    }
  }

  it("the corner condition: a MIN_SPEED arc from the centreline clears the inner corner", () => {
    // Arc centre (R, −R) from the intersection, inner corner at (20, −20)
    // (LOT_LINE): it passes outside the inflated corner iff √2(R−20) ≤ R − r.
    const R = turnRadius(MIN_SPEED);
    expect(Math.SQRT2 * Math.max(0, R - 20)).toBeLessThanOrEqual(
      R - PLAYER_RADIUS,
    );
  });

  it(
    "≥ 20 intersections: never collides, and the straight approach was never slowed",
    { timeout: 180_000 },
    () => {
      expect(picks.length).toBeGreaterThanOrEqual(20);
      for (const [cx, cz, dir] of picks) {
        const r = corner(cx, cz, dir, true);
        expect(r.ok, `corner (${cx}, ${cz}) dir ${dir}`).toBe(true);
        expect(r.capBeforeCommit).toBe(MAX_SPEED);
        expect(r.commitSpeed).toBeGreaterThanOrEqual(0.95 * MAX_SPEED);
      }
    },
  );

  it(
    "negative control: the same pilot without the manager crashes at most corners",
    { timeout: 60_000 },
    () => {
      let crashed = 0;
      for (const [cx, cz, dir] of picks) {
        if (!corner(cx, cz, dir, false).ok) crashed++;
      }
      expect(crashed).toBeGreaterThan(picks.length / 2);
    },
  );
});
