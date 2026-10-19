// FC1 collision assist (game/collision-assist.ts): a subtle nudge off a
// near-certain head-on impact. Pinned here: off is the exact identity; a
// clear path is left alone; a wall dead ahead gets a nudge whose path meets
// it LATER than the one being flown (never into a wall — and never toward
// the side a second wall closes); a moving solid (an airship) counts at the
// clock it is drawn on, and not at all with the movers hidden; the nudge
// eases in and is capped at the tuning's strength; and a full stick can't
// be asked for more of itself.

import type { Building } from "@angels-bandits/common/city";
import {
  createFlightState,
  handlingRates,
} from "@angels-bandits/common/flight";
import type { Vec3 } from "@angels-bandits/common/world";
import { afterEach, describe, expect, it } from "vitest";
import {
  type CollisionAssistWorld,
  collisionAssistError,
  collisionAssistOn,
  collisionAssistStick,
  createCollisionAssist,
  pathHit,
  stepCollisionAssist,
} from "../src/game/collision-assist";
import { FEEL_TUNING } from "../src/game/effortless";
import { resetTuning, tuning } from "../src/game/tuning";

const DT = 1 / 60;
afterEach(() => resetTuning());

/** A plain box tower centred on (x, z). */
const tower = (
  x: number,
  z: number,
  w: number,
  d: number,
  h: number,
): Building => ({
  x,
  z,
  width: w,
  depth: d,
  height: h,
  tiers: [{ width: w, depth: d, height: h }],
});

/** Level at 60 m, heading north (−Z) from z = 1000, at `speed`. */
const north = (speed = 80) => ({
  ...createFlightState({ x: 1000, y: 60, z: 1000 }, 0, tuning),
  speed,
});

/** A wall across the path 70 m ahead, wide enough to turn round. */
const wallAhead = tower(1000, 920, 60, 20, 200);

const rates = () => handlingRates(80, false, tuning);
const still = { turn: 0, pitch: 0 };

/** Step `frames` frames on the same pose (the nudge's ramp only). */
function settle(
  world: CollisionAssistWorld,
  frames: number,
  timeMs: number | null = null,
  last = still,
) {
  const s = createCollisionAssist();
  const f = north();
  for (let i = 0; i < frames; i++) {
    stepCollisionAssist(s, f, world, timeMs, true, false, rates(), last, DT);
  }
  return s;
}

describe("off is the identity", () => {
  it("stays exactly zero and leaves the command and the error untouched", () => {
    const s = createCollisionAssist();
    const world = { buildings: [wallAhead] };
    for (let i = 0; i < 30; i++) {
      stepCollisionAssist(
        s,
        north(),
        world,
        null,
        false,
        false,
        rates(),
        still,
        DT,
      );
    }
    expect(s.turn).toBe(0);
    expect(s.pitch).toBe(0);
    const cmd = { turn: 0.3125, pitch: -0.4375 };
    collisionAssistStick(s, cmd);
    expect(cmd).toEqual({ turn: 0.3125, pitch: -0.4375 });
    const err = { yaw: 0.1, pitch: -0.2 };
    collisionAssistError(s, FEEL_TUNING.normal, rates(), err);
    expect(Object.is(err.yaw, 0.1)).toBe(true);
    expect(Object.is(err.pitch, -0.2)).toBe(true);
  });

  it("is off unless both the setting and the tuning say on", () => {
    expect(collisionAssistOn(true)).toBe(true);
    expect(collisionAssistOn(false)).toBe(false);
    tuning.collisionAssist = 0;
    expect(collisionAssistOn(true)).toBe(false);
  });
});

describe("the nudge", () => {
  it("leaves a clear path alone", () => {
    const s = settle({ buildings: [tower(1300, 1000, 20, 20, 100)] }, 30);
    expect(s.turn).toBe(0);
    expect(s.pitch).toBe(0);
    expect(s.tHit).toBe(Number.POSITIVE_INFINITY);
  });

  it("steers off a wall dead ahead onto a path that meets it later", () => {
    const world = { buildings: [wallAhead] };
    const s = settle(world, 30);
    expect(s.tHit).toBeLessThan(tuning.collisionHorizon);
    expect(s.turn !== 0 || s.pitch !== 0).toBe(true);
    // The nudged path, as the assist models it (upright: turn → heading,
    // pull → climb), hits strictly later than the one being flown.
    const r = rates();
    const straight = pathHit(world, north(), 0, 0, 3, null);
    const nudged = pathHit(
      world,
      north(),
      -s.turn * r.turnRate,
      s.pitch * r.pitchRate,
      3,
      null,
    );
    expect(nudged).toBeGreaterThan(straight);
  });

  it("never turns toward a second wall that closes one side", () => {
    // Ahead, and a long wall down the right-hand side (+X): the way out is
    // left (−turn) or up — never right.
    const world = {
      buildings: [wallAhead, tower(1040, 950, 20, 140, 200)],
    };
    const s = settle(world, 30);
    expect(s.turn).toBeLessThanOrEqual(0);
    expect(s.turn !== 0 || s.pitch !== 0).toBe(true);
  });

  it("eases in, and never past the tuning's strength", () => {
    const world = { buildings: [wallAhead] };
    const one = settle(world, 1);
    expect(Math.abs(one.turn) + Math.abs(one.pitch)).toBeLessThanOrEqual(
      2 * 4 * DT + 1e-9,
    );
    tuning.collisionStrength = 0.2;
    const s = settle(world, 60);
    expect(Math.abs(s.turn)).toBeLessThanOrEqual(0.2 + 1e-9);
    expect(Math.abs(s.pitch)).toBeLessThanOrEqual(0.2 + 1e-9);
  });

  it("stands down while threading a hole or a bore", () => {
    const s = createCollisionAssist();
    const world = { buildings: [wallAhead] };
    for (let i = 0; i < 30; i++) {
      stepCollisionAssist(
        s,
        north(),
        world,
        null,
        true,
        true,
        rates(),
        still,
        DT,
      );
    }
    expect(s.turn).toBe(0);
    expect(s.pitch).toBe(0);
  });

  it("can't ask a full stick for more of itself", () => {
    // Already at full right turn and full pull: the only changes left are
    // easing off, so nothing that turns harder right or pulls harder is
    // picked.
    const world = { buildings: [wallAhead] };
    const s = settle(world, 30, null, { turn: 1, pitch: 1 });
    expect(s.turn).toBeLessThanOrEqual(0);
    expect(s.pitch).toBeLessThanOrEqual(0);
  });
});

describe("airships", () => {
  /** A 40 m hull crossing the path from the left at 20 m/s, at the path
   * 65 m ahead (z = 935) at t = 0.8 s on the movers' clock. */
  const hull = (t0: number) => ({
    buildings: [] as Building[],
    moving: (p: Vec3, r: number, ms: number) => {
      const t = (ms - t0) / 1000;
      const cx = 1000 - 16 + 20 * t;
      return Math.hypot(p.x - cx, p.y - 60, p.z - 935) < 20 + r;
    },
  });

  it("sees a hull where it will be when the plane gets there", () => {
    const s = settle(hull(5000), 30, 5000);
    expect(s.tHit).toBeLessThan(tuning.collisionHorizon);
    expect(s.turn !== 0 || s.pitch !== 0).toBe(true);
  });

  it("ignores the movers while they are hidden (no clock)", () => {
    const s = settle(hull(5000), 30, null);
    expect(s.turn).toBe(0);
    expect(s.pitch).toBe(0);
  });
});
