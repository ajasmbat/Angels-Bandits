// F10 horizon-locked chase camera ("make the camera not move with plane but
// stay straight"): with Camera roll LEVEL (the default) the camera's up is
// world-up and its right stays horizontal — the horizon never tilts — when
// the plane rolls onto a wing, rolls inverted, or flies a whole loop, and a
// loop passes the zenith with no snap: the view swings round smoothly with
// the plane held on screen. aimFrame (what the cursor ray is cast through)
// is exactly the camera shown. FOLLOW PLANE is F7's camera.

import { BULLET_RANGE, MAX_SPEED } from "@angels-bandits/common/constants";
import {
  type FlightState,
  createFlightState,
  flightForward,
  handlingRates,
  realRoll,
  stepFlight,
} from "@angels-bandits/common/flight";
import type { Vec3 } from "@angels-bandits/common/world";
import { afterEach, describe, expect, it } from "vitest";
import { ChaseCamera } from "../src/game/camera";
import {
  LEVEL_AIM_MAX_ELEV,
  type ViewBasis,
  aimError,
  aimView,
  createInstructor,
  instructorInput,
  viewBasis,
} from "../src/game/instructor";
import { createRollControl, stepRollControl } from "../src/game/roll-control";
import { tuning } from "../src/game/tuning";
import { BASE_FOV } from "../src/game/zoom";

const DEG = Math.PI / 180;
const ASPECT = 16 / 9;
const FPS = [30, 60, 144];

afterEach(() => {
  tuning.cameraRoll = 0;
});

/** Records the rendered camera: position, look-at and the up lookAt used. */
function stubCamera() {
  const shot = {
    pos: { x: 0, y: 0, z: 0 },
    look: { x: 0, y: 0, z: 0 },
    up: { x: 0, y: 1, z: 0 },
  };
  const cam = {
    position: {
      set: (x: number, y: number, z: number) => {
        shot.pos = { x, y, z };
      },
    },
    up: {
      set: (x: number, y: number, z: number) => {
        shot.up = { x, y, z };
      },
    },
    lookAt: (x: number, y: number, z: number) => {
      shot.look = { x, y, z };
    },
  } as unknown as import("three").PerspectiveCamera;
  return { shot, cam };
}

const basis = (): ViewBasis => ({
  fx: 0,
  fy: 0,
  fz: 0,
  rx: 0,
  ry: 0,
  rz: 0,
  ux: 0,
  uy: 0,
  uz: 0,
});

/** The rendered camera's basis (lookAt's: forward, right, up). */
function rendered(shot: ReturnType<typeof stubCamera>["shot"]): ViewBasis {
  const b = basis();
  viewBasis(shot.pos, shot.look, shot.up, b);
  return b;
}

/** The plane's position on the rendered screen, NDC (±1 at the edges). */
function onScreen(b: ViewBasis, eye: Vec3, plane: Vec3) {
  const d = { x: plane.x - eye.x, y: plane.y - eye.y, z: plane.z - eye.z };
  const z = d.x * b.fx + d.y * b.fy + d.z * b.fz;
  const t = Math.tan((BASE_FOV * DEG) / 2);
  return {
    x: (d.x * b.rx + d.y * b.ry + d.z * b.rz) / (z * t * ASPECT),
    y: (d.x * b.ux + d.y * b.uy + d.z * b.uz) / (z * t),
    ahead: z,
  };
}

const cruise = (): FlightState => ({
  ...createFlightState({ x: 1000, y: 300, z: 1000 }, 0),
  speed: MAX_SPEED,
});

/** A plane, its roll control and the chase camera, stepped like main. */
class Rig {
  readonly chase = new ChaseCamera();
  readonly cam = stubCamera();
  readonly rc = createRollControl();
  constructor(
    public f: FlightState,
    readonly dt: number,
  ) {
    this.chase.snapTo(f);
  }
  step(key: number, pitch = 0, turn = 0): void {
    const roll = stepRollControl(
      this.rc,
      {
        key,
        auto: null,
        mode: "off",
        roll: realRoll(this.f),
        pitch: this.f.pitch,
      },
      this.dt,
    );
    this.f = stepFlight(this.f, { turn, pitch, roll, throttle: 1 }, this.dt);
    this.chase.update(this.cam.cam, this.f, this.dt);
  }
}

const angle = (a: Vec3, b: Vec3): number =>
  Math.acos(
    Math.max(
      -1,
      Math.min(
        1,
        (a.x * b.x + a.y * b.y + a.z * b.z) /
          (Math.hypot(a.x, a.y, a.z) * Math.hypot(b.x, b.y, b.z)),
      ),
    ),
  );

describe("F10 camera roll LEVEL (default): the horizon never tilts", () => {
  it("is the default", () => {
    expect(tuning.cameraRoll).toBe(0);
  });

  for (const target of [90, 180, -90]) {
    it(`rolled to ${target}° in level flight: up within 1° of world-up, right level`, () => {
      const rig = new Rig(cruise(), 1 / 60);
      const key = target > 0 ? 1 : -1;
      while (Math.abs(realRoll(rig.f)) < Math.abs(target) * DEG - 0.02) {
        if (Math.abs(target) === 180 && Math.abs(realRoll(rig.f)) > 170 * DEG)
          break;
        rig.step(key);
      }
      for (let i = 0; i < 60; i++) rig.step(0);
      expect(Math.abs(realRoll(rig.f))).toBeGreaterThan(
        (Math.abs(target) - 12) * DEG,
      );
      const up = rig.chase.up;
      expect(angle(up, { x: 0, y: 1, z: 0 })).toBeLessThan(1 * DEG);
      const b = rendered(rig.cam.shot);
      expect(Math.abs(b.ry)).toBeLessThan(Math.sin(1 * DEG));
      expect(b.uy).toBeGreaterThan(0.9); // upright, not upside down
    });
  }

  for (const fps of FPS) {
    it(`a full stick loop: no roll, no snap, the plane on screen — ${fps} fps`, () => {
      const dt = 1 / fps;
      const rig = new Rig(cruise(), dt);
      let prevView: Vec3 | null = null;
      let maxView = 0;
      let maxRight = 0;
      let maxOff = 0;
      let swept = 0;
      let a = Math.atan2(flightForward(rig.f).y, -flightForward(rig.f).z);
      for (let t = 0; swept < 2 * Math.PI && t < 15; t += dt) {
        rig.step(0, 1);
        const fw = flightForward(rig.f);
        const a1 = Math.atan2(fw.y, -fw.z);
        swept += Math.atan2(Math.sin(a1 - a), Math.cos(a1 - a));
        a = a1;
        const shot = rig.cam.shot;
        expect(shot.up).toEqual({ x: 0, y: 1, z: 0 });
        const b = rendered(shot);
        maxRight = Math.max(maxRight, Math.abs(b.ry));
        const view = { x: b.fx, y: b.fy, z: b.fz };
        if (prevView) maxView = Math.max(maxView, angle(view, prevView));
        prevView = view;
        const s = onScreen(b, shot.pos, rig.f.pos);
        expect(s.ahead).toBeGreaterThan(0);
        maxOff = Math.max(maxOff, Math.abs(s.x), Math.abs(s.y));
      }
      if (fps === 60) {
        console.log(
          `level camera through a loop: max view change ${(maxView / DEG).toFixed(2)}°/frame, plane within ${(maxOff * 100).toFixed(0)}% of the frame`,
        );
      }
      expect(swept).toBeGreaterThanOrEqual(2 * Math.PI); // a whole loop
      expect(maxRight).toBeLessThan(1e-9); // never a roll
      // No snap: the view swings round the top at most ~4 rad/s (and the
      // ordinary chase lag) — a few degrees a frame even at 30 fps.
      expect(maxView).toBeLessThan(Math.max(3 * DEG, 4.5 * dt));
      expect(maxOff).toBeLessThan(0.8);
      // Out of the loop the camera is upright behind the plane again (not
      // upside down: it swung round the top, it never rolled over).
      expect(rendered(rig.cam.shot).uy).toBeGreaterThan(0.8);
    });
  }

  it("aimFrame is the camera shown: same eye, look-at and up", () => {
    const rig = new Rig(cruise(), 1 / 60);
    for (let i = 0; i < 40; i++) rig.step(-1, 0.6, 0.3);
    for (let i = 0; i < 30; i++) rig.step(0, 1);
    const fr = rig.chase.aimFrame(rig.f, 0);
    const p = rig.f.pos;
    const s = rig.cam.shot;
    expect(fr.eye.x + p.x).toBeCloseTo(s.pos.x, 9);
    expect(fr.eye.y + p.y).toBeCloseTo(s.pos.y, 9);
    expect(fr.eye.z + p.z).toBeCloseTo(s.pos.z, 9);
    expect(fr.at.x + p.x).toBeCloseTo(s.look.x, 9);
    expect(fr.at.y + p.y).toBeCloseTo(s.look.y, 9);
    expect(fr.at.z + p.z).toBeCloseTo(s.look.z, 9);
    expect(fr.up).toEqual(s.up);
  });

  it("mouse aim at a knife-edge: the nose goes where the cursor is on screen", () => {
    // Banked 90° with the horizon level, a cursor up-right of the pipper:
    // the pipper must move up-right ON SCREEN — toward the cursor — not
    // along the plane's own sideways axes.
    const rig = new Rig(cruise(), 1 / 60);
    while (realRoll(rig.f) < 88 * DEG) rig.step(1);
    for (let i = 0; i < 30; i++) rig.step(0);
    const shot0 = { ...rig.cam.shot };
    const b0 = rendered(shot0);
    const pipper = (f: FlightState) => {
      const fw = flightForward(f);
      return onScreen(b0, shot0.pos, {
        x: f.pos.x + fw.x * BULLET_RANGE,
        y: f.pos.y + fw.y * BULLET_RANGE,
        z: f.pos.z + fw.z * BULLET_RANGE,
      });
    };
    const p0 = pipper(rig.f);
    const ndc = { x: p0.x + 0.3, y: p0.y + 0.3 };
    let ins = createInstructor();
    for (let i = 0; i < 12; i++) {
      const fr = rig.chase.aimFrame(rig.f, 0);
      const v = aimView(rig.f, fr, BASE_FOV, ASPECT, ndc);
      const err = aimError(rig.f, v.aimDir, v.pipperDir);
      const none = { yaw: 0, pitch: 0 };
      ins = instructorInput(
        err,
        none,
        false,
        1 / 60,
        ins,
        handlingRates(rig.f.speed, false),
      );
      rig.f = stepFlight(
        rig.f,
        { turn: ins.turn, pitch: ins.pitch, roll: 0, throttle: 1 },
        1 / 60,
      );
      rig.chase.update(rig.cam.cam, rig.f, 1 / 60);
    }
    const p1 = pipper(rig.f);
    const moved = { x: p1.x - p0.x, y: p1.y - p0.y };
    const dir = Math.atan2(moved.y, moved.x);
    expect(Math.hypot(moved.x, moved.y)).toBeGreaterThan(0.05);
    expect(Math.abs(dir - Math.PI / 4)).toBeLessThan(30 * DEG);
  });

  for (const y of [0.5, 0.9]) {
    it(`a mouse cursor held high (0, ${y}): climbs steep and settles — no flip, no hunting`, () => {
      const dt = 1 / 60;
      const rig = new Rig(cruise(), dt);
      let ins = createInstructor();
      let flips = 0;
      let prevYaw = rig.f.yaw;
      let prevView: Vec3 | null = null;
      let maxView = 0;
      for (let t = 0; t < 8; t += dt) {
        const fr = rig.chase.aimFrame(rig.f, 0);
        const v = aimView(rig.f, fr, BASE_FOV, ASPECT, { x: 0, y });
        const elev = Math.asin(
          v.aimDir.y / Math.hypot(v.aimDir.x, v.aimDir.y, v.aimDir.z),
        );
        expect(elev).toBeLessThanOrEqual(LEVEL_AIM_MAX_ELEV + 1e-9);
        const err = aimError(rig.f, v.aimDir, v.pipperDir);
        const none = { yaw: 0, pitch: 0 };
        ins = instructorInput(
          err,
          none,
          false,
          dt,
          ins,
          handlingRates(rig.f.speed, false),
        );
        rig.step(0, ins.pitch, ins.turn);
        if (
          Math.abs(
            Math.atan2(
              Math.sin(rig.f.yaw - prevYaw),
              Math.cos(rig.f.yaw - prevYaw),
            ),
          ) > 2
        )
          flips++;
        prevYaw = rig.f.yaw;
        const b = rendered(rig.cam.shot);
        const view = { x: b.fx, y: b.fy, z: b.fz };
        if (prevView) maxView = Math.max(maxView, angle(view, prevView));
        prevView = view;
      }
      expect(flips).toBe(0); // never over the top
      expect(rig.f.pitch).toBeGreaterThan(60 * DEG); // it did climb
      expect(rig.f.pitch).toBeLessThan(85 * DEG);
      expect(maxView).toBeLessThan(2 * DEG);
    });
  }
});

describe("F10 camera roll FOLLOW PLANE: F7's camera", () => {
  it("on a wing the view rolls with the plane", () => {
    tuning.cameraRoll = 1;
    const rig = new Rig(cruise(), 1 / 60);
    while (realRoll(rig.f) < 88 * DEG) rig.step(1);
    for (let i = 0; i < 60; i++) rig.step(0);
    expect(rig.chase.up.y).toBeLessThan(0.3);
    expect(Math.abs(rendered(rig.cam.shot).ry)).toBeGreaterThan(0.7);
  });

  it("halfway between: half the roll", () => {
    tuning.cameraRoll = 0.5;
    const rig = new Rig(cruise(), 1 / 60);
    while (realRoll(rig.f) < 88 * DEG) rig.step(1);
    for (let i = 0; i < 60; i++) rig.step(0);
    const tilt = Math.acos(rig.chase.up.y);
    expect(tilt).toBeGreaterThan(30 * DEG);
    expect(tilt).toBeLessThan(60 * DEG);
  });
});
