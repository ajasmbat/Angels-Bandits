// FL1: the flight step reads every tunable from a FlightTuning now — and with
// DEFAULT_TUNING it must fly EXACTLY as main did. fixtures/flight-legacy.ts
// is main's flight.ts frozen at the commit FL1 branched from (constants and
// all); these replays drive both with the same recorded input streams and
// demand bit-equal poses (Object.is on every field, every step) — with the
// tuning omitted, as the server and bots call it, and with DEFAULT_TUNING
// passed, as the client calls it. The streams walk every branch of the step:
// level flight (the exact Euler fast path), turns, A/D rolls through
// inverted, loops over the top (the quaternion path and its gimbal branch),
// the bots' pitch envelope, boost and the post-boost tail, the corner cap's
// airbrake, dive fade, climb bleed and the soft ceiling — at several frame
// rates and with jittered steps.

import { mulberry32 } from "@angels-bandits/common/city";
import {
  BOOST_MAX_SPEED,
  MAX_SPEED,
  MIN_SPEED,
  PITCH_LIMIT,
} from "@angels-bandits/common/constants";
import {
  type FlightInput,
  type FlightState,
  createFlightState,
  handlingRates,
  pitchRadius,
  speedForRadius,
  stepFlight,
  turnRadius,
  turnRateAt,
} from "@angels-bandits/common/flight";
import { DEFAULT_TUNING } from "@angels-bandits/common/tuning";
import { describe, expect, it } from "vitest";
import * as legacy from "./fixtures/flight-legacy";

type Step = { input: FlightInput; dt: number };

const N: FlightInput = { pitch: 0, turn: 0, roll: 0, throttle: 0.6 };

/** `n` steps of `input` at a fixed `dt`. */
const hold = (input: Partial<FlightInput>, s: number, dt: number): Step[] =>
  Array.from({ length: Math.round(s / dt) }, () => ({
    input: { ...N, ...input },
    dt,
  }));

/** A jittered random stick at random frame times — a hand, recorded. */
function hand(seed: number, n: number, extra: Partial<FlightInput>): Step[] {
  const rnd = mulberry32(seed);
  const out: Step[] = [];
  let turn = 0;
  let pitch = 0;
  for (let i = 0; i < n; i++) {
    turn = Math.max(-1, Math.min(1, turn + (rnd() - 0.5) * 0.4));
    pitch = Math.max(-1, Math.min(1, pitch + (rnd() - 0.5) * 0.4));
    out.push({
      input: {
        turn,
        pitch,
        roll: rnd() < 0.2 ? (rnd() < 0.5 ? -1 : 1) : 0,
        throttle: rnd() < 0.1 ? -1 : rnd() < 0.2 ? 1 : 0.6,
        boost: rnd() < 0.15,
        ...extra,
      },
      dt: 0.004 + rnd() * 0.046,
    });
  }
  return out;
}

const FRAME_RATES = [30, 60, 144];

/** Every scenario: a start state and its recorded input stream. */
const SCENARIOS: { name: string; start: FlightState; steps: Step[] }[] = [];
for (const hz of FRAME_RATES) {
  const dt = 1 / hz;
  const mid = createFlightState({ x: 1000, y: 300, z: 1000 }, 0.3);
  SCENARIOS.push(
    {
      name: `level + throttle @${hz}`,
      start: mid,
      steps: [
        ...hold({}, 2, dt),
        ...hold({ throttle: -1 }, 2, dt),
        ...hold({ throttle: 1 }, 2, dt),
      ],
    },
    {
      name: `turns @${hz}`,
      start: mid,
      steps: [
        ...hold({ turn: 1 }, 3, dt),
        ...hold({ turn: -0.4, pitch: 0.3 }, 2, dt),
        ...hold({}, 1, dt),
      ],
    },
    {
      name: `rolls through inverted @${hz}`,
      start: mid,
      steps: [
        ...hold({ roll: 1 }, 1.3, dt),
        ...hold({ turn: 0.5 }, 1.5, dt),
        ...hold({ roll: -1, pitch: 0.4 }, 2.6, dt),
        ...hold({}, 2, dt),
      ],
    },
    {
      name: `loop over the top @${hz}`,
      start: mid,
      steps: [...hold({ pitch: 1, throttle: 1 }, 7, dt), ...hold({}, 1, dt)],
    },
    {
      name: `bot envelope @${hz}`,
      start: mid,
      steps: [
        ...hold({ pitch: 1, turn: 0.7, pitchLimit: PITCH_LIMIT }, 3, dt),
        ...hold({ pitch: -1, turn: -1, pitchLimit: PITCH_LIMIT }, 3, dt),
      ],
    },
    {
      name: `boost + post-boost tail @${hz}`,
      start: mid,
      steps: [
        ...hold({ boost: true, turn: 0.5 }, 3, dt),
        ...hold({ pitch: -0.5 }, 3, dt),
        ...hold({ turn: 1 }, 2, dt),
      ],
    },
    {
      name: `corner cap airbrake @${hz}`,
      start: { ...mid, speed: MAX_SPEED },
      steps: [
        ...hold({ cornerCap: 55, turn: 0.8 }, 2, dt),
        ...hold({ cornerCap: 20 }, 1, dt),
        ...hold({ cornerCap: 70, boost: true }, 1, dt),
        ...hold({ cornerCap: 70 }, 1, dt),
      ],
    },
    {
      name: `dive fade + climb bleed @${hz}`,
      start: mid,
      steps: [
        ...hold({ pitch: -1 }, 0.8, dt),
        ...hold({}, 4, dt),
        ...hold({ pitch: 1 }, 0.6, dt),
        ...hold({}, 3, dt),
      ],
    },
    {
      name: `soft ceiling @${hz}`,
      start: createFlightState({ x: 10, y: 690, z: 1990 }, -2),
      steps: [...hold({ pitch: 0.3, throttle: 1 }, 4, dt)],
    },
  );
}
SCENARIOS.push(
  {
    name: "jittered hand",
    start: createFlightState({ x: 500, y: 200, z: 500 }, 1),
    steps: hand(7, 3000, {}),
  },
  {
    name: "jittered hand, slow start",
    start: { ...createFlightState({ x: 1500, y: 80, z: 20 }), speed: 41 },
    steps: hand(11, 3000, { throttle: -1 }),
  },
  {
    name: "jittered bot",
    start: createFlightState({ x: 1999, y: 120, z: 3 }, 2.5),
    steps: hand(13, 3000, { pitchLimit: PITCH_LIMIT, boost: undefined }),
  },
);

const FIELDS = [
  "yaw",
  "pitch",
  "roll",
  "bank",
  "rollRate",
  "speed",
  "targetSpeed",
] as const;

/** The first field (and step) where `a` and `b` are not bit-equal, or null. */
function firstDiff(a: FlightState, b: FlightState): string | null {
  for (const k of ["x", "y", "z"] as const) {
    if (!Object.is(a.pos[k], b.pos[k])) return `pos.${k}`;
  }
  for (const k of FIELDS) {
    if (!Object.is(a[k], b[k])) return k;
  }
  return null;
}

describe("FL1 tuning parity: DEFAULT_TUNING flies exactly as main", () => {
  for (const sc of SCENARIOS) {
    it(sc.name, () => {
      let old = sc.start;
      let omitted = sc.start;
      let passed = sc.start;
      for (let i = 0; i < sc.steps.length; i++) {
        const { input, dt } = sc.steps[i] as Step;
        old = legacy.stepFlight(old, input, dt);
        omitted = stepFlight(omitted, input, dt);
        passed = stepFlight(passed, input, dt, DEFAULT_TUNING);
        const d = firstDiff(old, omitted) ?? firstDiff(old, passed);
        if (d !== null) {
          expect.fail(`${sc.name}: ${d} differs at step ${i}`);
        }
      }
      // The streams really did fly somewhere.
      expect(old.pos).not.toEqual(sc.start.pos);
    });
  }

  it("the derived helpers agree at every speed", () => {
    for (let v = 0; v <= 200; v += 0.37) {
      expect(turnRateAt(v)).toBe(legacy.turnRateAt(v));
      expect(turnRateAt(v, DEFAULT_TUNING)).toBe(legacy.turnRateAt(v));
      expect(turnRadius(v, DEFAULT_TUNING)).toBe(legacy.turnRadius(v));
      expect(pitchRadius(v, DEFAULT_TUNING)).toBe(legacy.pitchRadius(v));
      expect(speedForRadius(v, DEFAULT_TUNING)).toBe(legacy.speedForRadius(v));
      for (const boost of [false, true]) {
        expect(handlingRates(v, boost, DEFAULT_TUNING)).toEqual(
          legacy.handlingRates(v, boost),
        );
      }
    }
    expect(createFlightState({ x: 1, y: 2, z: 3 }, 4)).toEqual(
      legacy.createFlightState({ x: 1, y: 2, z: 3 }, 4),
    );
  });

  it("covers the whole speed envelope", () => {
    // Sanity on the scenarios themselves: they reach both ends.
    let lo = Number.POSITIVE_INFINITY;
    let hi = 0;
    for (const sc of SCENARIOS) {
      let s = sc.start;
      for (const { input, dt } of sc.steps) {
        s = stepFlight(s, input, dt);
        lo = Math.min(lo, s.speed);
        hi = Math.max(hi, s.speed);
      }
    }
    expect(lo).toBeLessThan(MIN_SPEED + 5);
    expect(hi).toBeGreaterThan(BOOST_MAX_SPEED - 10);
  });
});
