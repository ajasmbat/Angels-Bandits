// F7 aerobatics, flown end to end through stepFlight (ANGE-EGBXX6). F7 only
// checked its manoeuvres in an uncommitted scratch sim; these are those
// checks, made permanent. Heading and attitude are read from VECTORS — the
// nose's horizontal direction, the airframe's up (flightAxes), realRoll —
// never from raw Euler yaw, which flips by π over the top of every loop.
//
// The loops are flown at several frame rates and with jittered steps:
// rotateAttitude decomposes back to YXZ with a separate branch within a hair
// of vertical, and whether a step lands in it depends on the step phase.
//
// stepFlight has no ground and no city, so altitudes are simply numbers.

import {
  BOOST_MAX_SPEED,
  MAX_SPEED,
  MIN_SPEED,
  ROLL_RATE,
  SOFT_CEILING,
  WORLD_SIZE,
} from "@angels-bandits/common/constants";
import {
  type FlightInput,
  type FlightState,
  flightAxes,
  flightForward,
  handlingRates,
  pitchRadius,
  realRoll,
  stepFlight,
} from "@angels-bandits/common/flight";
import { describe, expect, it } from "vitest";

const DEG = Math.PI / 180;
const NEUTRAL: FlightInput = { pitch: 0, turn: 0, roll: 0, throttle: 0 };
/** Full pull at full throttle. */
const PULL: FlightInput = { ...NEUTRAL, pitch: 1, throttle: 1 };
const RATES = [30, 60, 144, 240];
/** The airframe's up within 10° of world-up / world-down. */
const UPRIGHT = Math.cos(10 * DEG);

const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));

/** Level, wings-level cruise at full-throttle speed, facing −Z (heading 0). */
function cruise(y = 300): FlightState {
  return {
    pos: { x: 1000, y, z: 1000 },
    yaw: 0,
    pitch: 0,
    roll: 0,
    bank: 0,
    rollRate: 0,
    speed: MAX_SPEED,
    targetSpeed: MAX_SPEED,
  };
}

/** Heading of the nose's horizontal part, rad (0 = −Z, + = left, as yaw). */
function heading(f: FlightState): number {
  const fw = flightForward(f);
  return Math.atan2(-fw.x, -fw.z);
}

const axes = { right: { x: 0, y: 0, z: 0 }, up: { x: 0, y: 0, z: 0 } };
/** World-y of the airframe's real up: 1 upright, −1 inverted. */
function upY(f: FlightState): number {
  return flightAxes(f, axes).up.y;
}

/** The nose's angle in the vertical plane of heading 0 (+ = climbing). */
function noseAngle(f: FlightState): number {
  const fw = flightForward(f);
  return Math.atan2(fw.y, -fw.z);
}

/** Deterministic PRNG (mulberry32): the fuzz and jitter replay exactly. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Flown {
  end: FlightState;
  /** Seconds flown. */
  t: number;
  /** Seconds spent pinned at MIN_SPEED. */
  pinned: number;
  /** World-y of the airframe's up when the nose passed the top (angle π). */
  upAtTop: number;
}

/**
 * Hold `input` until the nose has swept `sweep` rad in the vertical plane
 * (signed sum of steps, so it counts a loop's whole circle), or `maxT`.
 * `dt` is a step source, so a run can be jittered.
 */
function flySweep(
  start: FlightState,
  input: FlightInput,
  sweep: number,
  dt: () => number,
  maxT = 20,
): Flown {
  let s = start;
  let t = 0;
  let pinned = 0;
  let swept = 0;
  let upAtTop = Number.NaN;
  let a = noseAngle(s);
  while (Math.abs(swept) < sweep && t < maxT) {
    const h = dt();
    s = stepFlight(s, input, h);
    t += h;
    if (s.speed <= MIN_SPEED) pinned += h;
    const a1 = noseAngle(s);
    const before = Math.abs(swept);
    swept += wrap(a1 - a);
    a = a1;
    if (before < Math.PI && Math.abs(swept) >= Math.PI) upAtTop = upY(s);
  }
  return { end: s, t, pinned, upAtTop };
}

/** Hold `input` for exactly `n` steps of `dt`. */
function flySteps(
  start: FlightState,
  input: FlightInput,
  n: number,
  dt: number,
): FlightState {
  let s = start;
  for (let i = 0; i < n; i++) s = stepFlight(s, input, dt);
  return s;
}

/** Half roll at full A/D, exactly π: N steps sized to land on it. */
function halfRoll(s: FlightState, dir = 1, n = 75): FlightState {
  return flySteps(
    s,
    { ...NEUTRAL, roll: dir, throttle: 1 },
    n,
    Math.PI / (ROLL_RATE * n),
  );
}

const fixed = (fps: number) => () => 1 / fps;

describe("F7 loop", () => {
  for (const fps of RATES) {
    it(`full pull at full throttle closes a loop in < 8 s, ±10° heading, ±15 m altitude — ${fps} Hz`, () => {
      const start = cruise();
      const { end, t, pinned, upAtTop } = flySweep(
        start,
        PULL,
        2 * Math.PI,
        fixed(fps),
      );
      expect(t).toBeLessThan(8);
      expect(t).toBeGreaterThan(5); // it really flew the circle
      expect(Math.abs(wrap(heading(end) - heading(start)))).toBeLessThan(
        10 * DEG,
      );
      expect(Math.abs(end.pos.y - start.pos.y)).toBeLessThan(15);
      expect(pinned).toBeLessThan(0.5);
      expect(upAtTop).toBeLessThan(-UPRIGHT); // inverted over the top
      expect(upY(end)).toBeGreaterThan(UPRIGHT); // and upright out of it
    });
  }

  it("jittered steps (4–33 ms) never lose the inverted sense over the top", () => {
    // 40 loops at random step phases: some land in the near-vertical branch.
    for (let seed = 1; seed <= 40; seed++) {
      const r = rng(seed);
      const start = cruise();
      const { end, t, upAtTop } = flySweep(
        start,
        PULL,
        2 * Math.PI,
        () => 0.004 + r() * 0.029,
      );
      expect(t).toBeLessThan(8);
      expect(upAtTop).toBeLessThan(-UPRIGHT);
      expect(upY(end)).toBeGreaterThan(UPRIGHT);
      expect(Math.abs(wrap(heading(end) - heading(start)))).toBeLessThan(
        10 * DEG,
      );
      expect(Math.abs(end.pos.y - start.pos.y)).toBeLessThan(15);
    }
  });

  it("is frame-rate independent: 60 Hz and 144 Hz loops end within 2 m and 1°", () => {
    const a = flySteps(cruise(), PULL, 6 * 60, 1 / 60);
    const b = flySteps(cruise(), PULL, 6 * 144, 1 / 144);
    expect(
      Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y, a.pos.z - b.pos.z),
    ).toBeLessThan(2);
    expect(Math.abs(wrap(noseAngle(a) - noseAngle(b)))).toBeLessThan(1 * DEG);
    expect(Math.abs(upY(a) - upY(b))).toBeLessThan(0.02);
  });

  for (const [roll, label, exit] of [
    [0, "upright", Math.PI],
    [Math.PI, "rolled inverted", 0],
  ] as const) {
    it(`a state exactly at vertical (${label}) keeps its sense: the pull goes over toward its own up`, () => {
      // pitch π/2 sits right on the gimbal branch, where yaw and roll fold
      // into one angle. Off-axis (yaw 0.7) so a sign slip there shows: the
      // airframe's up points back along the heading upright and forward
      // along it rolled inverted, and the pull carries the nose that way.
      const yaw = 0.7;
      const start: FlightState = {
        ...cruise(),
        yaw,
        pitch: Math.PI / 2,
        roll,
        bank: 0,
      };
      // Neutral holds it there, the airframe's up unmoved step after step
      // (each one lands back on the branch; asin's own precision at ±1 is
      // ~1e-8).
      const up0 = { ...flightAxes(start, axes).up };
      let held = start;
      for (let i = 0; i < 31; i++) {
        held = stepFlight(held, { ...NEUTRAL, throttle: 1 }, 1 / 60);
        expect(flightForward(held).y).toBeCloseTo(1, 9);
        const up = flightAxes(held, axes).up;
        expect(
          Math.hypot(up.x - up0.x, up.y - up0.y, up.z - up0.z),
        ).toBeLessThan(1e-6);
      }
      const over = flySteps(held, PULL, 45, 1 / 60); // 0.75 rad past vertical
      expect(flightForward(over).y).toBeCloseTo(Math.cos(0.75), 2);
      expect(Math.abs(wrap(heading(over) - yaw - exit))).toBeLessThan(1 * DEG);
      expect(upY(over)).toBeLessThan(-0.6); // over the top is inverted
    });
  }
});

describe("F7 Immelmann and split-S", () => {
  for (const fps of RATES) {
    it(`Immelmann: half loop up, half roll — upright, reversed (±10°), higher — ${fps} Hz`, () => {
      const start = cruise();
      const top = flySweep(start, PULL, Math.PI, fixed(fps)).end;
      expect(upY(top)).toBeLessThan(-UPRIGHT); // inverted at the top
      const end = flySteps(
        halfRoll(top),
        { ...NEUTRAL, throttle: 1 },
        30,
        1 / 60,
      );
      expect(
        Math.abs(wrap(heading(end) - heading(start) - Math.PI)),
      ).toBeLessThan(10 * DEG);
      expect(upY(end)).toBeGreaterThan(UPRIGHT);
      expect(end.pos.y - start.pos.y).toBeGreaterThan(
        2 * pitchRadius(MIN_SPEED),
      );
    });

    it(`split-S: half roll, pull through — upright, reversed (±10°), below entry — ${fps} Hz`, () => {
      const start = cruise();
      const inverted = halfRoll(start);
      expect(upY(inverted)).toBeLessThan(-UPRIGHT);
      expect(inverted.pos.y).toBeCloseTo(start.pos.y, 6); // the roll costs no height
      const end = flySweep(inverted, PULL, Math.PI, fixed(fps)).end;
      expect(
        Math.abs(wrap(heading(end) - heading(start) - Math.PI)),
      ).toBeLessThan(10 * DEG);
      expect(upY(end)).toBeGreaterThan(UPRIGHT);
      // A half circle down at pitch radius v / PITCH_RATE, v in [MIN, MAX].
      const lost = start.pos.y - end.pos.y;
      expect(lost).toBeGreaterThan(2 * pitchRadius(MIN_SPEED));
      expect(lost).toBeLessThan(2 * pitchRadius(MAX_SPEED) + 1);
    });
  }
});

describe("F7 rolls and inverted flight", () => {
  for (const dir of [1, -1]) {
    it(`a 360° ${dir > 0 ? "left" : "right"} roll returns to the start attitude, height and heading`, () => {
      const start = cruise();
      const n = 150;
      const dt = (2 * Math.PI) / (ROLL_RATE * n);
      const input = { ...NEUTRAL, roll: dir };
      const half = flySteps(start, input, n / 2, dt);
      expect(Math.abs(realRoll(half))).toBeCloseTo(Math.PI, 9);
      const end = flySteps(half, input, n / 2, dt);
      expect(realRoll(end)).toBeCloseTo(0, 9);
      expect(end.pitch).toBeCloseTo(0, 12);
      expect(wrap(heading(end) - heading(start))).toBeCloseTo(0, 12);
      expect(end.pos.y).toBeCloseTo(start.pos.y, 9);
      expect(upY(end)).toBeCloseTo(1, 12);
    });
  }

  it("inverted level flight holds altitude ±10 m and stays inverted for 3 s with constant input", () => {
    for (const fps of RATES) {
      const start = halfRoll(cruise());
      const y0 = start.pos.y;
      let s = start;
      for (let i = 0; i < 3 * fps; i++) {
        s = stepFlight(s, { ...NEUTRAL, throttle: 1 }, 1 / fps);
        expect(Math.abs(s.pos.y - y0)).toBeLessThan(10);
        // The released roll levels to inverted, never back to upright.
        expect(Math.abs(realRoll(s))).toBeGreaterThan(Math.PI - 1 * DEG);
      }
      expect(Math.abs(realRoll(s))).toBe(Math.PI); // snapped onto it exactly
      expect(Math.abs(wrap(heading(s) - heading(start)))).toBeLessThan(1e-9);
    }
  });
});

/** The pose quaternion main.ts sends: Three.js Quaternion.setFromEuler of an
 * Euler(pitch, yaw, roll, "YXZ"), written out (common has no Three.js). */
function poseQuat(f: FlightState): {
  x: number;
  y: number;
  z: number;
  w: number;
} {
  const c1 = Math.cos(f.pitch / 2);
  const s1 = Math.sin(f.pitch / 2);
  const c2 = Math.cos(f.yaw / 2);
  const s2 = Math.sin(f.yaw / 2);
  const c3 = Math.cos(f.roll / 2);
  const s3 = Math.sin(f.roll / 2);
  return {
    x: s1 * c2 * c3 + c1 * s2 * s3,
    y: c1 * s2 * c3 - s1 * c2 * s3,
    z: c1 * c2 * s3 - s1 * s2 * c3,
    w: c1 * c2 * c3 + s1 * s2 * s3,
  };
}

/** Rotate `v` by unit quaternion `q`. */
function rotate(
  q: { x: number; y: number; z: number; w: number },
  v: { x: number; y: number; z: number },
): { x: number; y: number; z: number } {
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  return {
    x: v.x + q.w * tx + (q.y * tz - q.z * ty),
    y: v.y + q.w * ty + (q.z * tx - q.x * tz),
    z: v.z + q.w * tz + (q.x * ty - q.y * tx),
  };
}

/** One seeded random flight: inputs held for random spells, every option. */
function* fuzzFlight(
  seed: number,
  steps: number,
): Generator<[FlightState, FlightInput, number, FlightState]> {
  const r = rng(seed);
  const pick = () => {
    const u = r();
    return u < 0.15 ? 0 : u < 0.3 ? 1 : u < 0.45 ? -1 : r() * 2 - 1;
  };
  let s = cruise();
  let input: FlightInput = NEUTRAL;
  let spell = 0;
  for (let i = 0; i < steps; i++) {
    if (spell-- <= 0) {
      spell = Math.floor(r() * 120);
      input = {
        pitch: pick(),
        turn: pick(),
        roll: pick(),
        throttle: pick(),
        boost: r() < 0.1,
        cornerCap:
          r() < 0.2 ? MIN_SPEED + r() * (MAX_SPEED - MIN_SPEED) : undefined,
      };
    }
    const u = r();
    const dt =
      u < 0.01
        ? 0
        : u < 0.05
          ? 0.1
          : u < 0.1
            ? 1e-4
            : 1 / 240 + r() * (1 / 20 - 1 / 240);
    // No ground in stepFlight: a dive past the street re-enters above the
    // soft ceiling instead, so the fuzz spends time in the mush band too.
    if (s.pos.y < 0)
      s = { ...s, pos: { ...s.pos, y: SOFT_CEILING + r() * 150 } };
    const next = stepFlight(s, input, dt);
    yield [s, input, dt, next];
    s = next;
  }
}

describe("F7 fuzz", () => {
  it("10^5 random steps: finite, in range, unit pose quaternion matching the body axes, continuous nose", () => {
    // The fastest the nose can swing: boosted, and slow (the turn is
    // tightest at MIN_SPEED, F5) or fast — whichever is higher.
    const maxRate = Math.max(
      ...[MIN_SPEED, MAX_SPEED, BOOST_MAX_SPEED].map((v) => {
        const r = handlingRates(v, true);
        return r.turnRate + r.pitchRate;
      }),
    );
    const faults: string[] = [];
    const fault = (i: number, what: string) => {
      if (faults.length < 5) faults.push(`step ${i}: ${what}`);
    };
    let i = 0;
    let seams = 0;
    for (const [prev, , dt, s] of fuzzFlight(7, 100_000)) {
      const nums = [
        s.pos.x,
        s.pos.y,
        s.pos.z,
        s.yaw,
        s.pitch,
        s.roll,
        s.bank,
        s.rollRate,
        s.speed,
        s.targetSpeed,
      ];
      if (!nums.every((v) => typeof v === "number" && Number.isFinite(v)))
        fault(i, `non-finite ${JSON.stringify(s)}`);
      if (Math.abs(s.pitch) > Math.PI / 2) fault(i, `pitch ${s.pitch}`);
      if (!(s.roll > -Math.PI && s.roll <= Math.PI)) fault(i, `roll ${s.roll}`);
      if (s.speed < MIN_SPEED || s.speed > BOOST_MAX_SPEED)
        fault(i, `speed ${s.speed}`);
      if (s.targetSpeed < MIN_SPEED || s.targetSpeed > MAX_SPEED)
        fault(i, `target ${s.targetSpeed}`);
      if (
        s.pos.x < 0 ||
        s.pos.x >= WORLD_SIZE ||
        s.pos.z < 0 ||
        s.pos.z >= WORLD_SIZE
      )
        fault(i, "off the torus");
      if (
        Math.abs(s.pos.x - prev.pos.x) > WORLD_SIZE / 2 ||
        Math.abs(s.pos.z - prev.pos.z) > WORLD_SIZE / 2
      )
        seams++;

      const q = poseQuat(s);
      if (Math.abs(Math.hypot(q.x, q.y, q.z, q.w) - 1) > 1e-9)
        fault(i, "pose quat not unit");
      // The wire quat's body −Z is the nose, its body +Y the drawn up.
      const nose = rotate(q, { x: 0, y: 0, z: -1 });
      const fw = flightForward(s);
      if (Math.hypot(nose.x - fw.x, nose.y - fw.y, nose.z - fw.z) > 1e-9)
        fault(i, "pose quat nose ≠ flightForward");
      const up = rotate(q, { x: 0, y: 1, z: 0 });
      const drawn = flightAxes({ ...s, bank: 0 }, axes).up;
      if (Math.hypot(up.x - drawn.x, up.y - drawn.y, up.z - drawn.z) > 1e-9)
        fault(i, "pose quat up ≠ flightAxes up");

      // The nose never jumps: it turns at most the full boosted rates.
      const f0 = flightForward(prev);
      const dot = Math.min(1, f0.x * fw.x + f0.y * fw.y + f0.z * fw.z);
      if (Math.acos(dot) > maxRate * dt * 1.001 + 1e-6)
        fault(i, `nose jumped ${Math.acos(dot)} rad in ${dt} s`);
      i++;
    }
    expect(faults).toEqual([]);
    expect(seams).toBeGreaterThan(0); // the run really crossed the torus seam
  });

  it("is deterministic: the same inputs give the same states, bit for bit", () => {
    const a = [...fuzzFlight(11, 10_000)].map(([, , , s]) => s);
    const b = [...fuzzFlight(11, 10_000)].map(([, , , s]) => s);
    expect(b).toEqual(a);
  });
});
