import {
  MAX_SPEED,
  MIN_SPEED,
  RESPAWN_ALTITUDE,
  RESPAWN_SPEED,
  SOFT_CEILING,
  WORLD_SIZE,
} from "@angels-bandits/common/constants";
import {
  type FlightInput,
  type FlightState,
  createFlightState,
  stepFlight,
} from "@angels-bandits/common/flight";
import { describe, expect, it } from "vitest";

// Expected values are worked examples from PLAN.md / the ticket plan (speeds,
// distances, clamps), never recomputed via the implementation.

const NEUTRAL: FlightInput = { pitch: 0, turn: 0, roll: 0, throttle: 0 };

/** Run the sim for `seconds` at a fixed 60 Hz step. */
function fly(
  state: FlightState,
  input: FlightInput,
  seconds: number,
): FlightState {
  const dt = 1 / 60;
  let s = state;
  for (let i = 0; i < Math.round(seconds * 60); i++)
    s = stepFlight(s, input, dt);
  return s;
}

/** Level cruise at an exact speed, facing -Z (yaw 0), for worked examples. */
function cruiseAt(
  speed: number,
  pos: { x: number; y: number; z: number },
): FlightState {
  return { pos, yaw: 0, pitch: 0, roll: 0, speed, targetSpeed: speed };
}

describe("createFlightState (spawn)", () => {
  it("spawns level at mid altitude and combat speed, position canonicalized", () => {
    const s = createFlightState({ x: -5, y: RESPAWN_ALTITUDE, z: 2005 });
    expect(s.pos).toEqual({ x: 1995, y: RESPAWN_ALTITUDE, z: 5 });
    expect(s.pitch).toBe(0);
    expect(s.roll).toBe(0);
    expect(s.speed).toBe(RESPAWN_SPEED);
    expect(s.targetSpeed).toBe(RESPAWN_SPEED);
  });
});

describe("stepFlight: throttle", () => {
  it("W held raises target speed, clamped to MAX_SPEED (90 per PLAN.md)", () => {
    const end = fly(
      cruiseAt(65, { x: 500, y: 300, z: 500 }),
      { ...NEUTRAL, throttle: 1 },
      5,
    );
    expect(end.targetSpeed).toBe(MAX_SPEED);
    expect(end.speed).toBeGreaterThan(65);
    expect(end.speed).toBeLessThanOrEqual(MAX_SPEED);
  });

  it("S held lowers target speed, clamped to MIN_SPEED (40 per PLAN.md)", () => {
    const end = fly(
      cruiseAt(65, { x: 500, y: 300, z: 500 }),
      { ...NEUTRAL, throttle: -1 },
      5,
    );
    expect(end.targetSpeed).toBe(MIN_SPEED);
    expect(end.speed).toBeLessThan(65);
    expect(end.speed).toBeGreaterThanOrEqual(MIN_SPEED);
  });
});

describe("stepFlight: energy rule", () => {
  it("diving adds speed beyond the throttle target", () => {
    // 40° nose-down at cruise: level flight would hold 60, the dive must not.
    const start: FlightState = {
      ...cruiseAt(60, { x: 500, y: 500, z: 500 }),
      pitch: -0.7,
    };
    const end = fly(start, NEUTRAL, 3);
    expect(end.speed).toBeGreaterThan(62);
  });

  it("never exceeds MAX_SPEED even in a sustained full-throttle dive", () => {
    let s: FlightState = {
      ...cruiseAt(MAX_SPEED, { x: 500, y: 3000, z: 500 }),
      pitch: -1.2,
    };
    const dt = 1 / 60;
    for (let i = 0; i < 60 * 20; i++) {
      s = stepFlight(s, { ...NEUTRAL, throttle: 1 }, dt);
      expect(s.speed).toBeLessThanOrEqual(MAX_SPEED);
    }
  });

  it("climbing bleeds speed toward MIN_SPEED and never below it (mush, no stall)", () => {
    // 45° climb at min throttle from cruise speed.
    let s: FlightState = {
      ...cruiseAt(65, { x: 500, y: 100, z: 500 }),
      pitch: 0.78,
    };
    s.targetSpeed = MIN_SPEED;
    const dt = 1 / 60;
    let min = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 60 * 30; i++) {
      s = stepFlight(s, NEUTRAL, dt);
      min = Math.min(min, s.speed);
      expect(s.speed).toBeGreaterThanOrEqual(MIN_SPEED);
    }
    expect(min).toBeLessThan(48); // it really did bleed most of the way down
  });

  it("a hard flat turn bleeds speed below the throttle target", () => {
    const end = fly(
      cruiseAt(MAX_SPEED, { x: 500, y: 300, z: 500 }),
      { ...NEUTRAL, turn: 1 },
      10,
    );
    expect(end.speed).toBeLessThan(MAX_SPEED - 5);
    expect(end.speed).toBeGreaterThanOrEqual(MIN_SPEED);
  });
});

describe("stepFlight: steering", () => {
  it("full right deflection turns right (yaw decreases) at a capped, finite rate", () => {
    const end = fly(
      cruiseAt(65, { x: 500, y: 300, z: 500 }),
      { ...NEUTRAL, turn: 1 },
      2,
    );
    expect(end.yaw).toBeLessThan(-1); // really turning
    expect(end.yaw).toBeGreaterThan(-2.5); // ...but nowhere near instant
  });

  it("holding full pull-up caps pitch below vertical (no flip past 90°)", () => {
    const end = fly(
      cruiseAt(65, { x: 500, y: 300, z: 500 }),
      { ...NEUTRAL, pitch: 1 },
      10,
    );
    expect(end.pitch).toBeGreaterThan(1); // steep climb reached
    expect(end.pitch).toBeLessThan(Math.PI / 2); // never vertical
  });

  it("a right turn auto-banks into the turn, and the bank levels out after release", () => {
    const banked = fly(
      cruiseAt(65, { x: 500, y: 300, z: 500 }),
      { ...NEUTRAL, turn: 1 },
      2,
    );
    expect(banked.roll).toBeLessThan(-0.3);
    const leveled = fly(banked, NEUTRAL, 3);
    expect(Math.abs(leveled.roll)).toBeLessThan(0.1);
  });

  it("A/D roll assist rolls the plane directly", () => {
    const end = fly(
      cruiseAt(65, { x: 500, y: 300, z: 500 }),
      { ...NEUTRAL, roll: 1 },
      0.5,
    );
    expect(end.roll).toBeGreaterThan(0.4);
  });

  it("attitude holds when input is neutral (mouse-aim: no auto-level of pitch)", () => {
    const start: FlightState = {
      ...cruiseAt(65, { x: 500, y: 500, z: 500 }),
      pitch: 0.3,
    };
    const end = fly(start, NEUTRAL, 2);
    expect(end.pitch).toBeCloseTo(0.3, 6);
  });
});

describe("stepFlight: soft ceiling", () => {
  it("a sustained full-power climb tops out within 150 m above SOFT_CEILING (600 m)", () => {
    let s: FlightState = {
      ...cruiseAt(MAX_SPEED, { x: 500, y: 550, z: 500 }),
      pitch: 1.2,
    };
    const dt = 1 / 60;
    let apex = 0;
    for (let i = 0; i < 60 * 120; i++) {
      s = stepFlight(s, { ...NEUTRAL, throttle: 1, pitch: 1 }, dt);
      apex = Math.max(apex, s.pos.y);
    }
    expect(apex).toBeLessThanOrEqual(SOFT_CEILING + 150);
    expect(apex).toBeGreaterThan(SOFT_CEILING); // it's a soft fade, not a wall at 600
  });

  it("mushes back down: pinned nose-up above the ceiling, the plane still descends", () => {
    const start: FlightState = {
      ...cruiseAt(MIN_SPEED, { x: 500, y: 780, z: 500 }),
      pitch: 1.2,
    };
    const end = fly(start, { ...NEUTRAL, pitch: 1 }, 20);
    expect(end.pos.y).toBeLessThan(700);
  });

  it("does not touch normal climbs below the ceiling", () => {
    // 30° climb at 60 m/s for 5 s gains sin(30°)·60·5 = 150 m.
    const start: FlightState = {
      ...cruiseAt(60, { x: 500, y: 100, z: 500 }),
      pitch: Math.PI / 6,
    };
    const end = fly(start, NEUTRAL, 5);
    expect(end.pos.y).toBeGreaterThan(230);
  });
});

describe("stepFlight: purity", () => {
  it("mutates neither the state nor the input it is given", () => {
    const state = cruiseAt(65, { x: 500, y: 300, z: 500 });
    const input: FlightInput = {
      pitch: 0.5,
      turn: -0.5,
      roll: 0.2,
      throttle: 1,
    };
    Object.freeze(state);
    Object.freeze(state.pos);
    Object.freeze(input);
    expect(() => stepFlight(state, input, 1 / 60)).not.toThrow();
  });
});

describe("stepFlight: level cruise kinematics", () => {
  it("covers 100 m in 2 s at 50 m/s, facing -Z", () => {
    const end = fly(cruiseAt(50, { x: 100, y: 300, z: 300 }), NEUTRAL, 2);
    expect(end.pos.z).toBeCloseTo(200, 4);
    expect(end.pos.x).toBeCloseTo(100, 4);
    expect(end.pos.y).toBeCloseTo(300, 4);
    expect(end.speed).toBeCloseTo(50, 4);
  });

  it("wraps across the north seam: z=100 minus 150 m of flight lands at z=1950", () => {
    const end = fly(cruiseAt(50, { x: 100, y: 300, z: 100 }), NEUTRAL, 3);
    expect(end.pos.z).toBeCloseTo(1950, 4);
  });

  it("keeps the position canonical in [0, WORLD_SIZE) on every single step", () => {
    let s = cruiseAt(90, { x: 100, y: 300, z: 30 });
    const dt = 1 / 60;
    for (let i = 0; i < 60 * 30; i++) {
      s = stepFlight(s, NEUTRAL, dt);
      expect(s.pos.z).toBeGreaterThanOrEqual(0);
      expect(s.pos.z).toBeLessThan(WORLD_SIZE);
      expect(s.pos.x).toBeGreaterThanOrEqual(0);
      expect(s.pos.x).toBeLessThan(WORLD_SIZE);
    }
  });
});
