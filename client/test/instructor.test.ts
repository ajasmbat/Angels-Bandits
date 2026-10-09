// Mouse-aim instructor in the loop (F7, ANGE-U8PO2C). Everything the game
// flies with — the chase camera (lag, turn lead), the cursor ray through it,
// aimError → instructorInput → stepFlight — stepped together, frame by frame,
// with no renderer. Guards F6's step response (until now only numbers in
// instructor.ts comments) and the near-vertical flat spin: a cursor held a
// little above the pipper used to pin the nose at PITCH_LIMIT while the
// lagging eye rose past it, the cursor ray crossed the zenith, its heading
// flipped 180° and the turn command saturated for good.
//
// stepFlight has no ground and no city, so runs start below SOFT_CEILING
// (a climb above it mushes) and dives simply fall through y = 0.

import { RESPAWN_SPEED } from "@angels-bandits/common/constants";
import {
  type FlightState,
  createFlightState,
  flightAxes,
  handlingRates,
  stepFlight,
} from "@angels-bandits/common/flight";
import type { Vec3 } from "@angels-bandits/common/world";
import { describe, expect, it } from "vitest";
import { ChaseCamera } from "../src/game/camera";
import {
  type InstructorState,
  aimError,
  aimView,
  angleBetween,
  createInstructor,
  instructorInput,
} from "../src/game/instructor";
import { BASE_FOV } from "../src/game/zoom";

const DEG = Math.PI / 180;
const ASPECT = 16 / 9;
const FPS = [30, 60, 144];

/** Records nothing — the loop only needs ChaseCamera's state (storm idiom). */
const stubCamera = () =>
  ({
    position: { set: () => {} },
    lookAt: () => {},
  }) as unknown as import("three").PerspectiveCamera;

const axes = { right: { x: 0, y: 0, z: 0 }, up: { x: 0, y: 0, z: 0 } };
/** Heading of the airframe's wing line (its right axis), rad. */
function wingHeading(f: FlightState): number {
  const r = flightAxes(f, axes).right;
  return Math.atan2(r.z, r.x);
}

/** One player: plane, chase eye and instructor, stepped like main.ts does. */
class Loop {
  readonly cam = stubCamera();
  readonly chase = new ChaseCamera();
  ins: InstructorState = createInstructor();
  /** Heading swept so far, rad (sum of |Δ|, so a spin can't cancel out).
   * F7: the heading of the WING LINE (the airframe's right axis) — the
   * nose's yaw flips by π over the top and is undefined at vertical, while
   * the wings keep their heading through a loop and turn with any spin. */
  swept = 0;
  /** The same, counted only while the nose is steeper than 70°: a
   * pirouette's signature. */
  steepSwept = 0;

  constructor(public f: FlightState) {
    this.chase.snapTo(f);
  }

  /** The eye-relative view the instructor reads this frame. */
  frame(): { eye: Vec3; at: Vec3 } {
    return this.chase.aimFrame(this.f, 0);
  }

  /** One frame with the cursor at `ndc`. */
  step(ndc: { x: number; y: number }, dt: number, throttle = 0.6): void {
    const view = aimView(this.f, this.frame(), BASE_FOV, ASPECT, ndc);
    const err = aimError(this.f, view.aimDir, view.pipperDir);
    const rates = handlingRates(this.f.speed, false);
    const none = { yaw: 0, pitch: 0 };
    this.ins = instructorInput(err, none, false, dt, this.ins, rates);
    const turn = this.ins.turn;
    const wing0 = wingHeading(this.f);
    this.f = stepFlight(
      this.f,
      { turn, pitch: this.ins.pitch, roll: 0, throttle },
      dt,
    );
    const dWing = wingHeading(this.f) - wing0;
    const swing = Math.abs(Math.atan2(Math.sin(dWing), Math.cos(dWing)));
    this.swept += swing;
    if (Math.abs(this.f.pitch) > 70 * DEG) this.steepSwept += swing;
    // The turn lead reads the commanded yaw rate, as main's leadYawRate does.
    const lead = -turn * rates.turnRate;
    this.chase.update(this.cam, this.f, dt, undefined, undefined, 0, lead);
  }
}

/** World direction (from the eye) → cursor NDC, the inverse of cursorRay. */
function project(
  dir: Vec3,
  frame: { eye: Vec3; at: Vec3 },
): {
  x: number;
  y: number;
} {
  const f = {
    x: frame.at.x - frame.eye.x,
    y: frame.at.y - frame.eye.y,
    z: frame.at.z - frame.eye.z,
  };
  const fl = Math.hypot(f.x, f.y, f.z);
  f.x /= fl;
  f.y /= fl;
  f.z /= fl;
  const rl = Math.hypot(f.z, f.x);
  const r = { x: -f.z / rl, z: f.x / rl };
  const u = { x: -r.z * f.y, y: r.z * f.x - r.x * f.z, z: r.x * f.y };
  const depth = dir.x * f.x + dir.y * f.y + dir.z * f.z;
  const t = Math.tan((BASE_FOV * DEG) / 2);
  return {
    x: (dir.x * r.x + dir.z * r.z) / depth / (t * ASPECT),
    y: (dir.x * u.x + dir.y * u.y + dir.z * u.z) / depth / t,
  };
}

/** Plane at `pitch`, flying at constant `speed`, mid-map. */
function plane(y: number, speed: number, pitch = 0): FlightState {
  return {
    ...createFlightState({ x: 1000, y, z: 1000 }),
    pitch,
    speed,
    targetSpeed: speed,
  };
}

/**
 * Cursor kept on a world point 30° to the left of the nose, 3 km out at the
 * nose's own elevation. Airspeed is pinned so the loop is measured at one
 * speed. Returns the worst overshoot past the point and the time after which
 * the pipper stays within 1.5° of it.
 */
function stepResponse(
  speed: number,
  fps: number,
  pitch0 = 0,
): { overshoot: number; settle: number } {
  const dt = 1 / fps;
  const loop = new Loop(plane(200, speed, pitch0));
  const D = 3000;
  const step = 30 * DEG;
  const target = {
    x: loop.f.pos.x - Math.sin(step) * Math.cos(pitch0) * D,
    y: loop.f.pos.y + Math.sin(pitch0) * D,
    z: loop.f.pos.z - Math.cos(step) * Math.cos(pitch0) * D,
  };
  const ndcOn = () => {
    const fr = loop.frame();
    const eye = {
      x: loop.f.pos.x + fr.eye.x,
      y: loop.f.pos.y + fr.eye.y,
      z: loop.f.pos.z + fr.eye.z,
    };
    const dir = {
      x: target.x - eye.x,
      y: target.y - eye.y,
      z: target.z - eye.z,
    };
    return { fr, ndc: project(dir, fr) };
  };
  let overshoot = 0;
  let settle = 0;
  const frames = Math.round(3 / dt);
  for (let i = 0; i < frames; i++) {
    loop.step(ndcOn().ndc, dt, 0);
    loop.f = { ...loop.f, speed, targetSpeed: speed };
    const { fr, ndc } = ndcOn();
    const v = aimView(loop.f, fr, BASE_FOV, ASPECT, ndc);
    const gap = angleBetween(v.aimDir, v.pipperDir);
    // (pipper × aim).y > 0 while the point is still to the left; once it
    // goes negative the pipper has run past it.
    const left = v.pipperDir.z * v.aimDir.x - v.pipperDir.x * v.aimDir.z > 0;
    if (!left) overshoot = Math.max(overshoot, gap);
    if (gap > 1.5 * DEG) settle = (i + 1) * dt;
  }
  return { overshoot, settle };
}

describe("instructor step response (F6, camera in the loop)", () => {
  for (const speed of [40, 65, 90]) {
    for (const fps of FPS) {
      it(`30° step at ${speed} m/s, ${fps} fps: overshoot < 0.5°, settled < 0.8 s`, () => {
        const { overshoot, settle } = stepResponse(speed, fps);
        expect(overshoot).toBeLessThan(0.5 * DEG);
        expect(settle).toBeLessThan(0.8);
        expect(settle).toBeGreaterThan(0.2); // it did have to fly there
      });
    }
  }

  for (const pitchDeg of [45, 65]) {
    for (const fps of FPS) {
      it(`30° step in a ${pitchDeg}° climb, ${fps} fps: overshoot < 0.5°, settled < 0.8 s`, () => {
        const { overshoot, settle } = stepResponse(65, fps, pitchDeg * DEG);
        expect(overshoot).toBeLessThan(0.5 * DEG);
        expect(settle).toBeLessThan(0.8);
      });
    }
  }
});

/** Hold the cursor at `ndc` for `secs` from level flight at full speed. */
function hold(
  ndc: { x: number; y: number },
  y0: number,
  secs: number,
  fps = 60,
) {
  const dt = 1 / fps;
  const loop = new Loop(plane(y0, 90));
  let extreme = 0;
  for (let i = 0; i < Math.round(secs / dt); i++) {
    loop.step(ndc, dt);
    if (Math.abs(loop.f.pitch) > Math.abs(extreme)) extreme = loop.f.pitch;
  }
  return { swept: loop.swept, steepSwept: loop.steepSwept, extreme };
}

describe("no flat spin near vertical (F7)", () => {
  for (const fps of FPS) {
    // The pipper sits at NDC y ≈ 0.26 in level flight at 90 m/s (C1's chase
    // geometry; ≈ 0.10 behind the old lagging eye), so "just above" it is
    // 0.43 — the same margin as before.
    it(`cursor just above the pipper (0, 0.43) climbs, no turn — ${fps} fps`, () => {
      const { swept, extreme } = hold({ x: 0, y: 0.43 }, 200, 6, fps);
      expect(swept).toBeLessThan(10 * DEG);
      expect(extreme).toBeGreaterThan(60 * DEG);
    });

    // F7: there is no limit any more — held there it pulls over the top.
    it(`cursor held high (0, 0.5) climbs to the limit, no turn — ${fps} fps`, () => {
      const { swept, extreme } = hold({ x: 0, y: 0.5 }, 200, 6, fps);
      expect(swept).toBeLessThan(10 * DEG);
      expect(extreme).toBeGreaterThan(60 * DEG);
    });

    it(`cursor held low (0, −0.5) dives to the limit, no turn — ${fps} fps`, () => {
      const { swept, extreme } = hold({ x: 0, y: -0.5 }, 590, 6, fps);
      expect(swept).toBeLessThan(10 * DEG);
      expect(extreme).toBeLessThan(-60 * DEG);
    });
  }

  it("a cursor a hair off-centre while vertical drifts, it doesn't pirouette", () => {
    // Was ~330° in 6 s, all of it at vertical; heading authority now fades
    // out near vertical. F7: the nose no longer stops there — it goes over
    // the top and the cursor's right offset is an honest turn once it can
    // turn again — so the spin is counted while the nose is steep.
    expect(hold({ x: 0.1, y: 0.5 }, 200, 6).steepSwept).toBeLessThan(90 * DEG);
    expect(hold({ x: 0.1, y: -0.5 }, 590, 6).steepSwept).toBeLessThan(90 * DEG);
  });

  for (const ndc of [
    { x: 0.3, y: 0.35 },
    { x: 0.6, y: 0.35 },
  ]) {
    it(`near vertical, a cursor up and right (${ndc.x}, ${ndc.y}) brings the nose off it and turns right`, () => {
      // F7: there is no pitch limit to sit at any more; start the eye
      // settled behind an 82° climb instead.
      const dt = 1 / 60;
      const loop = new Loop(plane(100, 90, 82 * DEG));
      for (let i = 0; i < 1 / dt; i++) {
        loop.f = stepFlight(
          loop.f,
          { turn: 0, pitch: 0, roll: 0, throttle: 0 },
          dt,
        );
        loop.chase.update(loop.cam, loop.f, dt);
      }
      let off = -1;
      let turn = 0;
      for (let i = 0; i < 2 / dt; i++) {
        loop.step(ndc, dt);
        turn += loop.ins.turn * dt;
        if (off < 0 && Math.abs(loop.f.pitch) < 75 * DEG) off = (i + 1) * dt;
      }
      expect(off).toBeGreaterThan(0);
      expect(off).toBeLessThan(2);
      // The pilot's right, upright or (over the top) inverted, and no
      // pirouette on the way.
      expect(turn).toBeGreaterThan(0.2);
      expect(loop.steepSwept).toBeLessThan(90 * DEG);
    });
  }

  for (const pitchDeg of [65, 75]) {
    it(`the aim error is continuous around the screen border in a ${pitchDeg}° climb`, () => {
      // Settle the eye behind a steady climb, then walk the cursor around the
      // whole border in small steps: no jump between neighbouring samples.
      const loop = new Loop(plane(100, RESPAWN_SPEED, pitchDeg * DEG));
      for (let i = 0; i < 180; i++) {
        loop.f = stepFlight(
          loop.f,
          { turn: 0, pitch: 0, roll: 0, throttle: 0 },
          1 / 60,
        );
        loop.chase.update(loop.cam, loop.f, 1 / 60);
      }
      const fr = loop.frame();
      const n = 200;
      const border: { x: number; y: number }[] = [];
      for (let k = 0; k < n; k++) border.push({ x: -1 + (2 * k) / n, y: 1 });
      for (let k = 0; k < n; k++) border.push({ x: 1, y: 1 - (2 * k) / n });
      for (let k = 0; k < n; k++) border.push({ x: 1 - (2 * k) / n, y: -1 });
      for (let k = 0; k <= n; k++) border.push({ x: -1, y: -1 + (2 * k) / n });
      let prev: { yaw: number; pitch: number } | null = null;
      let worst = 0;
      for (const ndc of border) {
        const v = aimView(loop.f, fr, BASE_FOV, ASPECT, ndc);
        const e = aimError(loop.f, v.aimDir, v.pipperDir);
        if (prev) {
          worst = Math.max(
            worst,
            Math.abs(e.yaw - prev.yaw),
            Math.abs(e.pitch - prev.pitch),
          );
        }
        prev = e;
      }
      expect(worst).toBeLessThan(5 * DEG);
    });
  }
});
