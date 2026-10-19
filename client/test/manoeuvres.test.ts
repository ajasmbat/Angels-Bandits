// FC1 one-key manoeuvres (game/manoeuvres.ts): each macro, flown through the
// real flight model with the player's defaults, must do what it says and
// hand back — the quick 180 reverses the heading (an Immelmann where the
// half loop is clear, a flat U-turn toward the open side where it is not),
// the barrel-roll dodge rolls a full turn and steps the plane off its line,
// and nothing ever holds the stick past its timeout.

import {
  type FlightState,
  createFlightState,
  flightForward,
  realRoll,
  stepFlight,
} from "@angels-bandits/common/flight";
import { DEFAULT_TUNING } from "@angels-bandits/common/tuning";
import type { Vec3 } from "@angels-bandits/common/world";
import { describe, expect, it } from "vitest";
import {
  type Solid,
  cancelManoeuvre,
  createManoeuvre,
  createManoeuvreStick,
  flatClear,
  loopClear,
  manoeuvreActive,
  startDodge,
  startUTurn,
  stepManoeuvre,
} from "../src/game/manoeuvres";

const DT = 1 / 60;
const DEG = Math.PI / 180;
const open: Solid = () => false;

/** Level at `y`, heading north (yaw 0 faces −Z), at `speed`. */
function plane(y: number, speed = 70): FlightState {
  return {
    ...createFlightState({ x: 1000, y, z: 1000 }, 0, DEFAULT_TUNING),
    speed,
  };
}

/** Fly the macro to its end; returns the final state and the time it took. */
function fly(
  m: ReturnType<typeof createManoeuvre>,
  start: FlightState,
): { flight: FlightState; t: number; path: Vec3[] } {
  const out = createManoeuvreStick();
  let flight = start;
  let t = 0;
  const path: Vec3[] = [];
  while (stepManoeuvre(m, flight, DT, out) && t < 10) {
    flight = stepFlight(
      flight,
      { turn: out.turn, pitch: out.pitch, roll: out.roll, throttle: 1 },
      DT,
      DEFAULT_TUNING,
    );
    path.push(flight.pos);
    t += DT;
  }
  return { flight, t, path };
}

/** cos of the angle between the level headings of two states. */
function headingCos(a: FlightState, b: FlightState): number {
  const fa = flightForward(a);
  const fb = flightForward(b);
  const la = Math.hypot(fa.x, fa.z) || 1;
  const lb = Math.hypot(fb.x, fb.z) || 1;
  return (fa.x * fb.x + fa.z * fb.z) / (la * lb);
}

describe("quick 180", () => {
  it("is an Immelmann in open sky: heading reversed, higher, wings level", () => {
    const start = plane(150);
    const m = createManoeuvre();
    startUTurn(m, start, open, 480, 1);
    expect(m.kind).toBe("loop");
    const { flight, t } = fly(m, start);
    expect(manoeuvreActive(m)).toBe(false);
    expect(t).toBeLessThan(5);
    expect(headingCos(start, flight)).toBeLessThan(-0.85);
    expect(flight.pos.y).toBeGreaterThan(start.pos.y + 60);
    expect(Math.abs(realRoll(flight))).toBeLessThan(10 * DEG);
  });

  it("turns flat where the loop would break the ceiling", () => {
    const start = plane(150);
    expect(loopClear(start, open, 200)).toBe(false);
    const m = createManoeuvre();
    startUTurn(m, start, open, 200, 1);
    expect(m.kind).toBe("flat");
    const { flight, path } = fly(m, start);
    expect(manoeuvreActive(m)).toBe(false);
    expect(headingCos(start, flight)).toBeLessThan(-0.8);
    // A U-turn, not a climb: it stays near its height all the way round
    // (an 80° bank's pull still lifts a little).
    for (const p of path) expect(Math.abs(p.y - 150)).toBeLessThan(40);
  });

  it("turns flat toward the open side when a wall stands on the other", () => {
    const start = plane(60);
    // A wall 25 m to the plane's left (−X) the whole way along, under a
    // deck at 120 m (no room to loop).
    const wallLeft: Solid = (p, r) => p.x - r < 975 || p.y + r > 120;
    expect(flatClear(start, 1, 40, wallLeft)).toBeLessThan(1);
    expect(flatClear(start, -1, 40, wallLeft)).toBe(1);
    const m = createManoeuvre();
    startUTurn(m, start, wallLeft, 480, 1);
    expect(m.kind).toBe("flat");
    expect(m.side).toBe(-1);
    const { path } = fly(m, start);
    for (const p of path) expect(p.x).toBeGreaterThan(975);
  });

  it("refuses the loop when a deck sits over the half loop", () => {
    const start = plane(100);
    const deck: Solid = (p, r) => p.y + r > 180;
    expect(loopClear(start, deck, 480)).toBe(false);
  });
});

describe("barrel-roll dodge", () => {
  it("rolls a full turn toward its side and steps off the line", () => {
    for (const side of [1, -1]) {
      const start = plane(200);
      const m = createManoeuvre();
      startDodge(m, start, side);
      const { flight, t, path } = fly(m, start);
      expect(manoeuvreActive(m)).toBe(false);
      expect(t).toBeGreaterThan(0.8);
      expect(t).toBeLessThan(2.5);
      // The first part of the roll goes the asked way (+roll = left wing
      // down).
      expect(
        Math.sign(realRoll({ ...start, ...firstRolled(start, side) })),
      ).toBe(side);
      // Ends near wings level, still going roughly the same way…
      expect(Math.abs(realRoll(flight))).toBeLessThan(25 * DEG);
      expect(headingCos(start, flight)).toBeGreaterThan(0.7);
      // …but off its line: a corkscrew, not a roll in place.
      const end = path[path.length - 1] as Vec3;
      const off = Math.hypot(end.x - 1000, end.y - 200);
      expect(off).toBeGreaterThan(3);
    }
  });
});

/** The pose a quarter second into a dodge toward `side`. */
function firstRolled(start: FlightState, side: number): FlightState {
  const m = createManoeuvre();
  startDodge(m, start, side);
  const out = createManoeuvreStick();
  let f = start;
  for (let i = 0; i < 15; i++) {
    stepManoeuvre(m, f, DT, out);
    f = stepFlight(
      f,
      { turn: out.turn, pitch: out.pitch, roll: out.roll, throttle: 1 },
      DT,
      DEFAULT_TUNING,
    );
  }
  return f;
}

describe("hand-back", () => {
  it("writes a zero stick and reports done once cancelled", () => {
    const start = plane(200);
    const m = createManoeuvre();
    startDodge(m, start, 1);
    cancelManoeuvre(m);
    const out = createManoeuvreStick();
    expect(stepManoeuvre(m, start, DT, out)).toBe(false);
    expect(out).toEqual({ turn: 0, pitch: 0, roll: 0 });
  });

  it("never holds the stick past its timeout", () => {
    const start = plane(200);
    const m = createManoeuvre();
    startUTurn(m, start, open, 480, 1);
    const out = createManoeuvreStick();
    // A frozen plane never gets over the top: the macro must still let go.
    let steps = 0;
    while (stepManoeuvre(m, start, DT, out)) steps++;
    expect(steps * DT).toBeLessThanOrEqual(5.01);
    expect(manoeuvreActive(m)).toBe(false);
  });
});
