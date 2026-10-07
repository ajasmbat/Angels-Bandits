// Proximity warning + avoidance assist (F4, HOTFIX ANGE-QR7P8U). The bug this
// guards: in a 40 m street canyon the warning held the stick for 2.2 s, so
// every gentle turn "hit" a facade and PULL UP sounded all the way down the
// street, and the pull-up-first escapes dragged the plane out of the city.
// A scripted closed-loop pilot flies the real seed-42 city (nature on, movers
// off) the way a player does; synthetic worlds pin the genuine alarms.

import { generateCity } from "@angels-bandits/common/city";
import { natureFor } from "@angels-bandits/common/city/nature";
import {
  buildCityIndex,
  buildNatureIndex,
} from "@angels-bandits/common/collision";
import { CITY_SEED } from "@angels-bandits/common/constants";
import {
  type FlightInput,
  type FlightState,
  createFlightState,
  handlingRates,
  stepFlight,
} from "@angels-bandits/common/flight";
import { type Vec3, wrapDelta } from "@angels-bandits/common/world";
import { describe, expect, it } from "vitest";
import { detectCrash } from "../src/game/collision";
import {
  type ProximityCue,
  type ProximityWorld,
  createAvoidance,
  stepAvoidance,
} from "../src/game/proximity";

const DT = 1 / 60;

const buildings = generateCity(CITY_SEED);
const index = buildCityIndex(buildings);
const natureIndex = buildNatureIndex(natureFor(CITY_SEED, buildings));
const CITY: ProximityWorld = { buildings, index, nature: natureIndex };

const wrapAngle = (a: number) =>
  a - 2 * Math.PI * Math.round(a / (2 * Math.PI));
const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));

/** yaw for a unit travel direction (yaw 0 faces −Z). */
const yawOf = (d: { x: number; z: number }) => Math.atan2(-d.x, -d.z);

/** A state at `pos` flying `yaw` at `speed`, throttle holding it. */
function plane(pos: Vec3, yaw: number, speed: number, pitch = 0): FlightState {
  return { ...createFlightState(pos, yaw), pitch, speed, targetSpeed: speed };
}

interface Run {
  frames: number;
  warnFrames: number;
  /** Seconds from the first warning frame to the crash, or null. */
  firstWarnAt: number | null;
  crashAt: number | null;
  cues: Set<ProximityCue>;
  maxDy: number;
  /** Where the run ended along x (the arch's exit check). */
  exitX: number;
}

/**
 * Fly `pilot` for `seconds` (or until the crash) at 60 Hz through the same
 * stepAvoidance → stepFlight → detectCrash order main.ts runs.
 */
function fly(
  start: FlightState,
  pilot: (f: FlightState) => FlightInput,
  world: ProximityWorld,
  seconds: number,
  assist: boolean,
  until?: (f: FlightState) => boolean,
): Run {
  let f = start;
  let s = createAvoidance();
  const run: Run = {
    frames: 0,
    warnFrames: 0,
    firstWarnAt: null,
    crashAt: null,
    cues: new Set(),
    maxDy: 0,
    exitX: start.pos.x,
  };
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) {
    const step = stepAvoidance(s, pilot(f), f, world, DT, assist);
    s = step.state;
    if (step.warning) {
      run.warnFrames++;
      run.firstWarnAt ??= i * DT;
    }
    if (step.cue) run.cues.add(step.cue);
    f = stepFlight(f, step.input, DT);
    run.frames++;
    run.maxDy = Math.max(run.maxDy, Math.abs(f.pos.y - start.pos.y));
    if (
      detectCrash(
        f,
        world.buildings,
        world.index,
        undefined,
        null,
        world.nature,
      )
    ) {
      run.crashAt = (i + 1) * DT;
      break;
    }
    if (until?.(f)) break;
  }
  run.exitX = f.pos.x;
  return run;
}

/**
 * Pure pursuit along a sampled path (torus-aware), pitch command 0 so any
 * altitude change is the assist's own. `cap` limits the turn command.
 */
function pursuit(path: readonly Vec3[], cap: number, lookahead = 25) {
  let at = 0;
  return (f: FlightState): FlightInput => {
    // The nearest sample, searched forward only (paths revisit the seam).
    let best = Number.POSITIVE_INFINITY;
    for (let i = at; i < Math.min(path.length, at + 40); i++) {
      const p = path[i];
      if (!p) continue;
      const d = wrapDelta(f.pos, p);
      const dist = Math.hypot(d.x, d.z);
      if (dist < best) {
        best = dist;
        at = i;
      }
    }
    const target = path[Math.min(path.length - 1, at + lookahead)] ?? f.pos;
    const d = wrapDelta(f.pos, target);
    const alpha = wrapAngle(yawOf(d) - f.yaw); // + = target to the left
    const rate =
      (2 * f.speed * Math.sin(alpha)) / Math.max(1, Math.hypot(d.x, d.z));
    const { turnRate } = handlingRates(f.speed, false);
    return {
      pitch: 0,
      turn: clamp(-rate / turnRate, -cap, cap),
      roll: 0,
      throttle: 0,
    };
  };
}

/** 1 m samples of a straight street run along −Z at x = x0, weaving
 * ±`amp` m with wavelength `wave` m. */
function weavePath(x0: number, z0: number, y: number, length: number) {
  const amp = 6;
  const wave = 280;
  const out: Vec3[] = [];
  for (let s = 0; s <= length; s++) {
    out.push({
      x: x0 + amp * Math.sin((2 * Math.PI * s) / wave),
      y,
      z: z0 - s,
    });
  }
  return out;
}

const right = (d: { x: number; z: number }) => ({ x: -d.z, z: d.x });

/**
 * A street route through `corners` (street intersections), each flown on a
 * swing-wide line: drift OUT m to the outer side over RAMP m, an R m arc
 * tangent to both streets' outer offset lines, drift back over RAMP m.
 */
function routePath(
  start: { x: number; z: number },
  corners: readonly { x: number; z: number }[],
  end: { x: number; z: number },
  y: number,
): Vec3[] {
  const OUT = 14;
  const R = 80;
  const RAMP = 150;
  const pts = [start, ...corners, end];
  const out: Vec3[] = [];
  // Along-leg offset profile: legs are straight between corner centres.
  for (let leg = 0; leg + 1 < pts.length; leg++) {
    const a = pts[leg];
    const b = pts[leg + 1];
    if (!a || !b) continue;
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const d = { x: (b.x - a.x) / len, z: (b.z - a.z) / len };
    const n = right(d);
    const before = pts[leg - 1];
    const after = pts[leg + 2];
    // Turn sign at each end: +1 right, −1 left, 0 none.
    const unit = (p: { x: number; z: number }, q: { x: number; z: number }) => {
      const l = Math.hypot(q.x - p.x, q.z - p.z);
      return { x: (q.x - p.x) / l, z: (q.z - p.z) / l };
    };
    const turnSign = (
      dIn: { x: number; z: number },
      dOut: { x: number; z: number },
    ) => Math.sign(right(dIn).x * dOut.x + right(dIn).z * dOut.z);
    const inTurn = before ? turnSign(unit(before, a), d) : 0; // turn made AT a
    const outTurn = after ? turnSign(d, unit(b, after)) : 0; // turn made AT b
    const trim = R - OUT; // the arc's tangent point, off the corner centre
    const s0 = inTurn ? trim : 0;
    const s1 = outTurn ? len - trim : len;
    for (let s = s0; s <= s1; s++) {
      // Outer side of a right turn is the left (−n), and vice versa.
      let off = 0;
      if (inTurn) off += -inTurn * OUT * clamp(1 - (s - s0) / RAMP, 0, 1);
      if (outTurn) off += -outTurn * OUT * clamp(1 - (s1 - s) / RAMP, 0, 1);
      out.push({
        x: a.x + d.x * s + n.x * off,
        y,
        z: a.z + d.z * s + n.z * off,
      });
    }
    if (outTurn && after) {
      // The arc around the corner b, centre on the inside of the turn.
      const d2len = Math.hypot(after.x - b.x, after.z - b.z);
      const d2 = { x: (after.x - b.x) / d2len, z: (after.z - b.z) / d2len };
      const side = outTurn; // +1 right
      const n1 = right(d);
      const n2 = right(d2);
      const c = {
        x: b.x + side * trim * (n1.x + n2.x),
        z: b.z + side * trim * (n1.z + n2.z),
      };
      const a0 = Math.atan2(-side * n1.z, -side * n1.x);
      const a1 = Math.atan2(-side * n2.z, -side * n2.x);
      const sweep = wrapAngle(a1 - a0);
      const steps = Math.ceil(Math.abs(sweep) * R);
      for (let k = 1; k < steps; k++) {
        const ang = a0 + (sweep * k) / steps;
        out.push({ x: c.x + R * Math.cos(ang), y, z: c.z + R * Math.sin(ang) });
      }
    }
  }
  return out;
}

describe("canyon flight is calm (a)", () => {
  // Street x = 1000 (gallery's street-low view), northbound along −Z.
  const X0 = 1000;
  const Z0 = 1900;
  for (const y of [35, 50, 70]) {
    for (const v of [50, 70, 90]) {
      it(`weaving ±6 m down a street at ${y} m, ${v} m/s`, () => {
        const path = weavePath(X0, Z0, y, Math.ceil(v * 30) + 200);
        const start = plane({ x: X0, y, z: Z0 }, 0, v);
        const off = fly(start, pursuit(path, 0.3), CITY, 30, false);
        expect(off.crashAt).toBeNull(); // the route itself is flyable
        const on = fly(start, pursuit(path, 0.3), CITY, 30, true);
        expect(on.crashAt).toBeNull();
        expect(on.warnFrames / on.frames).toBeLessThan(0.03);
        expect(on.maxDy).toBeLessThan(5);
      });
    }
  }

  for (const v of [50, 70]) {
    it(`two 90° intersection turns at ${v} m/s, 40 m`, () => {
      const y = 40;
      const path = routePath(
        { x: 1000, z: 1600 },
        [
          { x: 1000, z: 1000 }, // right onto z = 1000, eastbound
          { x: 1600, z: 1000 }, // left onto x = 1600, northbound
        ],
        { x: 1600, z: -600 },
        y,
      );
      const start = plane({ x: 1000, y, z: 1600 }, 0, v);
      const off = fly(start, pursuit(path, 1), CITY, 30, false);
      expect(off.crashAt).toBeNull();
      const on = fly(start, pursuit(path, 1), CITY, 30, true);
      expect(on.crashAt).toBeNull();
      expect(on.warnFrames / on.frames).toBeLessThan(0.03);
      expect(on.maxDy).toBeLessThan(5);
    });
  }
});

describe("genuine impacts still alarm", () => {
  // (b) An 80 × 80 × 150 m tower, the only solid, nose-on at 40 m.
  const TOWER: ProximityWorld = {
    buildings: [
      {
        x: 1000,
        z: 1000,
        width: 80,
        depth: 80,
        height: 150,
        tiers: [{ width: 80, depth: 80, height: 150 }],
      },
    ],
  };
  for (const v of [50, 70, 90]) {
    it(`head-on into a wall at ${v} m/s: warned ≥ 1 s ahead, assist saves it`, () => {
      const start = plane({ x: 1000, y: 40, z: 1540 }, 0, v);
      const hold = () => ({ pitch: 0, turn: 0, roll: 0, throttle: 0 });
      const off = fly(start, hold, TOWER, 12, false);
      expect(off.crashAt).not.toBeNull();
      expect(off.firstWarnAt).not.toBeNull();
      expect(
        (off.crashAt ?? 0) - (off.firstWarnAt ?? 0),
      ).toBeGreaterThanOrEqual(1.0);
      const on = fly(start, hold, TOWER, 12, true);
      expect(on.crashAt).toBeNull();
    });
  }

  // (c) Open ground, a −20° descent from 150 m.
  it("descending into the ground at −20°: PULL UP ≥ 1 s ahead", () => {
    const start = plane(
      { x: 1000, y: 150, z: 1000 },
      0,
      70,
      (-20 * Math.PI) / 180,
    );
    const hold = () => ({ pitch: 0, turn: 0, roll: 0, throttle: 0 });
    const off = fly(start, hold, { buildings: [] }, 12, false);
    expect(off.crashAt).not.toBeNull();
    expect(off.firstWarnAt).not.toBeNull();
    expect((off.crashAt ?? 0) - (off.firstWarnAt ?? 0)).toBeGreaterThanOrEqual(
      1.0,
    );
    expect([...off.cues]).toEqual(["pull-up"]);
  });
});

describe("H1 archway (d)", () => {
  // Landmark (2, 3): centre (500, 700), arch along x, y 8–32, ±15 m. Runs
  // start in the x = 400 street, 70 m before the mouth (x = 455), and end at
  // the exit mouth (x = 545).
  const landmark = buildings.find(
    (b) => b.x === 500 && b.z === 700 && b.holes?.[0]?.kind === "arch",
  );
  const hold = () => ({ pitch: 0, turn: 0, roll: 0, throttle: 0 });
  const exited = (f: FlightState) => f.pos.x >= 545;
  const thread = (world: ProximityWorld, v: number) => {
    const start = plane({ x: 385, y: 20, z: 700 }, -Math.PI / 2, v);
    const off = fly(start, hold, world, 10, false, exited);
    expect(off.crashAt).toBeNull();
    const on = fly(start, hold, world, 10, true, exited);
    expect(on.crashAt).toBeNull();
    expect(on.exitX).toBeGreaterThanOrEqual(545);
    expect(on.warnFrames).toBe(0);
  };

  it("threading the (2,3) arch on its centreline in the city at 50 m/s: silent", () => {
    thread(CITY, 50);
  });

  // The arch itself never reads as a wall at any speed. (In the city, from
  // 70 m/s the next block's facade 75 m past the exit is ≤ 1.2 s out by the
  // mouth — a genuine BREAK, not the arch — so the arch alone is the probe.)
  for (const v of [50, 70, 90]) {
    it(`the arch alone is silent on its centreline at ${v} m/s`, () => {
      expect(landmark).toBeDefined();
      thread({ buildings: landmark ? [landmark] : [] }, v);
    });
  }
});
