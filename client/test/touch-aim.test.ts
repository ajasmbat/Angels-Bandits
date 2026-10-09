// M7 touch aim: a world-anchored direction (game/touch-aim-dir.ts) projected
// onto the instructor's cursor. The closed loop drives the real chase camera
// (stub THREE camera, camera.test idiom), the instructor and the flight model
// exactly as main.ts's instructor branch does — the attached sims, ported.

import { BULLET_RANGE } from "@angels-bandits/common/constants";
import {
  type FlightState,
  createFlightState,
  flightForward,
  handlingRates,
  stepFlight,
} from "@angels-bandits/common/flight";
import type { Vec3 } from "@angels-bandits/common/world";
import { describe, expect, it } from "vitest";
import { ChaseCamera } from "../src/game/camera";
import { AUTO_THROTTLE } from "../src/game/flight-input";
import {
  aimError,
  aimView,
  angleBetween,
  createInstructor,
  cursorRay,
  instructorInput,
} from "../src/game/instructor";
import { speedFov } from "../src/game/jet-camera";
import {
  type AimDirState,
  TOUCH_AIM_DEG_PER_PX,
  TOUCH_AIM_MAX_OFF_NOSE,
  aimDirFromRay,
  aimDirNdc,
  createAimDir,
  dragAimDir,
  recentreAimDir,
  stepAimDir,
} from "../src/game/touch-aim-dir";
import {
  type TouchPoint,
  type Viewport,
  createTouchAim,
  touchInput,
} from "../src/game/touch-input";
import { zoomFov } from "../src/game/zoom";

const DEG = Math.PI / 180;
const PHONE: Viewport = { w: 844, h: 390 };
const TABLET: Viewport = { w: 1180, h: 820 };
const ASPECT = PHONE.w / PHONE.h;
const SENS = 1.5; // the default sensitivity step

const stubCamera = () =>
  ({
    position: { set() {} },
    lookAt() {},
  }) as unknown as import("three").PerspectiveCamera;

const yawRateOf = (a: FlightState, b: FlightState, dt: number): number =>
  Math.abs(Math.atan2(Math.sin(b.yaw - a.yaw), Math.cos(b.yaw - a.yaw))) / dt;

/** One touch pilot: the plane, its chase eye, the instructor and the aim. */
class Sim {
  flight: FlightState;
  readonly chase = new ChaseCamera();
  readonly cam = stubCamera();
  readonly aim: AimDirState = createAimDir();
  readonly ndc = { x: 0, y: 0 };
  ins = createInstructor();
  leadYawRate = 0;

  constructor(
    readonly dt: number,
    alt = 300,
    speed = 65,
  ) {
    this.flight = {
      ...createFlightState({ x: 1000, y: alt, z: 1000 }, 0),
      speed,
    };
    // A respawn: snapped chase eye, a recentred aim.
    this.chase.snapTo(this.flight);
    recentreAimDir(this.aim, this.flight);
  }

  /** One frame of main.ts's instructor branch at zoom 0, no boost.
   * `cursor` overrides the touch aim with a fixed NDC point (old behaviour). */
  frame(held: boolean, cursor?: { x: number; y: number }): void {
    const { dt } = this;
    const frame = this.chase.aimFrame(this.flight, 0);
    const fov = zoomFov(0) + speedFov(this.flight.speed);
    stepAimDir(this.aim, this.flight, held, dt);
    aimDirNdc(this.aim.dir, frame, fov, ASPECT, this.ndc);
    const view = aimView(this.flight, frame, fov, ASPECT, cursor ?? this.ndc);
    const err = aimError(this.flight, view.aimDir, view.pipperDir);
    const rates = handlingRates(this.flight.speed, false);
    this.ins = instructorInput(
      err,
      { yaw: 0, pitch: 0 },
      false,
      dt,
      this.ins,
      rates,
    );
    this.leadYawRate = -this.ins.turn * rates.turnRate;
    this.flight = stepFlight(
      this.flight,
      {
        turn: this.ins.turn,
        pitch: this.ins.pitch,
        roll: 0,
        throttle: AUTO_THROTTLE,
      },
      dt,
    );
    this.chase.update(
      this.cam,
      this.flight,
      dt,
      undefined,
      undefined,
      0,
      this.leadYawRate,
    );
  }
}

const FPS = [30, 60, 144];

describe("hands-off after a recentre (the respawn dive)", () => {
  for (const fps of FPS) {
    it(`flies level for 6 s at 300 m and 65 m/s (${fps} fps)`, () => {
      const sim = new Sim(1 / fps);
      let maxPitch = 0;
      let maxDAlt = 0;
      for (let i = 0; i < 6 * fps; i++) {
        sim.frame(false);
        maxPitch = Math.max(maxPitch, Math.abs(sim.flight.pitch));
        maxDAlt = Math.max(maxDAlt, Math.abs(sim.flight.pos.y - 300));
      }
      expect(maxPitch).toBeLessThanOrEqual(3 * DEG);
      expect(maxDAlt).toBeLessThanOrEqual(10);
    });
  }

  it("the old screen-centre recentre noses over (the bug this guards)", () => {
    const sim = new Sim(1 / 60);
    for (let i = 0; i < 2 * 60; i++) sim.frame(false, { x: 0, y: 0 });
    expect(sim.flight.pitch).toBeLessThan(-10 * DEG);
  });
});

describe("lifting the thumb (the endless turn)", () => {
  for (const fps of FPS) {
    it(`a 120 px drag right, then lift: the turn ends (${fps} fps)`, () => {
      const sim = new Sim(1 / fps);
      const yaw0 = sim.flight.yaw;
      // Settle, then drag 120 px over 0.2 s.
      for (let i = 0; i < fps / 2; i++) sim.frame(false);
      const dragFrames = Math.round(0.2 * fps);
      for (let i = 0; i < dragFrames; i++) {
        dragAimDir(sim.aim, 120 / dragFrames, 0, SENS);
        sim.frame(true);
      }
      let maxRate = 0;
      for (let i = 0; i < 4 * fps; i++) {
        const before = sim.flight;
        sim.frame(false);
        if (i >= 2 * fps) {
          maxRate = Math.max(maxRate, yawRateOf(before, sim.flight, sim.dt));
        }
      }
      expect(maxRate).toBeLessThan(1 * DEG);
      // It did turn — right, which decreases yaw — most of the way there.
      expect(yaw0 - sim.flight.yaw).toBeGreaterThan(20 * DEG);
    });
  }
});

describe("drag → direction", () => {
  /** A 100 px one-finger drag through touchInput, drained into the aim. */
  const dragAngle = (v: Viewport): number => {
    const aim = createAimDir();
    const level = createFlightState({ x: 0, y: 300, z: 0 }, 0);
    recentreAimDir(aim, level);
    const start = { ...aim.dir };
    const f = (x: number): TouchPoint[] => [{ id: 1, x, y: v.h / 2 }];
    let s = createTouchAim(v);
    for (const x of [500, 550, 600]) s = touchInput(s, f(x), v, SENS);
    dragAimDir(aim, s.aimDx, s.aimDy, SENS);
    return angleBetween(start, aim.dir);
  };

  it("turns the same angle on a phone and on a tablet", () => {
    const phone = dragAngle(PHONE);
    const tablet = dragAngle(TABLET);
    expect(Math.abs(phone - tablet)).toBeLessThanOrEqual(1 * DEG);
    expect(phone).toBeCloseTo(100 * TOUCH_AIM_DEG_PER_PX * SENS * DEG, 6);
  });

  it("right turns right (yaw decreases), down aims lower", () => {
    const aim = createAimDir();
    recentreAimDir(aim, createFlightState({ x: 0, y: 300, z: 0 }, 0));
    dragAimDir(aim, 50, 0, 1);
    expect(Math.atan2(-aim.dir.x, -aim.dir.z)).toBeLessThan(0);
    dragAimDir(aim, 0, 50, 1);
    expect(aim.dir.y).toBeLessThan(0);
  });

  it("drags straight over the pole, no elevation limit (F7 loops)", () => {
    // Was: clamped short of the poles. A drag now rotates the aim in the
    // view's frame, so 120° of drag up from level north is 60° up, south.
    const aim = createAimDir();
    dragAimDir(aim, 0, -120 / TOUCH_AIM_DEG_PER_PX, 1);
    expect(Math.asin(aim.dir.y)).toBeCloseTo(60 * DEG, 6);
    expect(aim.dir.z).toBeGreaterThan(0);
  });
});

describe("stepAimDir", () => {
  const level = createFlightState({ x: 0, y: 300, z: 0 }, 0);

  it("holds the cone: never more than 60° off the nose", () => {
    const aim = createAimDir();
    recentreAimDir(aim, level);
    dragAimDir(aim, 500, 0, 1); // 90° of drag
    stepAimDir(aim, level, true, 1 / 60);
    expect(angleBetween(aim.dir, flightForward(level))).toBeCloseTo(
      TOUCH_AIM_MAX_OFF_NOSE,
      6,
    );
  });

  it("stays put in the world while held, and for 1 s after the lift", () => {
    const aim = createAimDir();
    recentreAimDir(aim, level);
    dragAimDir(aim, 100, 0, 1);
    const parked = { ...aim.dir };
    for (let i = 0; i < 120; i++) stepAimDir(aim, level, true, 1 / 60);
    for (let i = 0; i < 59; i++) stepAimDir(aim, level, false, 1 / 60);
    expect(angleBetween(aim.dir, parked)).toBeLessThan(1e-9);
  });

  it("then eases onto the gun line (τ 1.5 s)", () => {
    const aim = createAimDir();
    recentreAimDir(aim, level);
    dragAimDir(aim, 100, 0, 1);
    const off0 = angleBetween(aim.dir, flightForward(level));
    for (let i = 0; i < 60 + 90; i++) stepAimDir(aim, level, false, 1 / 60);
    // 1.5 s of ease ≈ one τ: about e⁻¹ of the offset left.
    const off = angleBetween(aim.dir, flightForward(level));
    expect(off / off0).toBeGreaterThan(0.3);
    expect(off / off0).toBeLessThan(0.45);
  });
});

describe("aimDirNdc — the inverse of the instructor's cursor ray", () => {
  const sim = new Sim(1 / 60);
  const frame = sim.chase.aimFrame(sim.flight, 0);
  const fov = zoomFov(0) + speedFov(sim.flight.speed);

  it("the gun line lands exactly on the pipper (zero aim error)", () => {
    const ndc = { x: 0, y: 0 };
    aimDirNdc(flightForward(sim.flight), frame, fov, ASPECT, ndc);
    const view = aimView(sim.flight, frame, fov, ASPECT, ndc);
    const err = aimError(sim.flight, view.aimDir, view.pipperDir);
    expect(Math.abs(err.yaw)).toBeLessThan(1e-9);
    expect(Math.abs(err.pitch)).toBeLessThan(1e-9);
    // …and the pipper sits above screen centre (the chase eye looks down
    // past the gun line) — why the old screen-centre recentre dived.
    expect(ndc.y).toBeGreaterThan(0.05);
  });

  it("round-trips on-screen cursors through cursorRay and aimDirFromRay", () => {
    const aim = createAimDir();
    const ndc = { x: 0, y: 0 };
    for (const [x, y] of [
      [0, 0],
      [0.5, -0.3],
      [-0.9, 0.8],
      [0.2, 0.95],
    ] as const) {
      const ray = cursorRay(frame.eye, frame.at, fov, ASPECT, x, y);
      aimDirFromRay(aim, frame.eye, ray);
      // The direction's point BULLET_RANGE out sits on the eye ray.
      const p: Vec3 = {
        x: aim.dir.x * BULLET_RANGE - frame.eye.x,
        y: aim.dir.y * BULLET_RANGE - frame.eye.y,
        z: aim.dir.z * BULLET_RANGE - frame.eye.z,
      };
      expect(angleBetween(p, ray)).toBeLessThan(1e-6);
      aimDirNdc(aim.dir, frame, fov, ASPECT, ndc);
      expect(ndc.x).toBeCloseTo(x, 9);
      expect(ndc.y).toBeCloseTo(y, 9);
    }
  });

  it("clamps off-screen directions to the cursor's ±1 range", () => {
    const aim = createAimDir();
    recentreAimDir(aim, sim.flight);
    dragAimDir(aim, 0, -400, 1); // 72° up: far above the top edge
    const ndc = { x: 0, y: 0 };
    aimDirNdc(aim.dir, frame, fov, ASPECT, ndc);
    expect(ndc.y).toBe(1);
  });
});
