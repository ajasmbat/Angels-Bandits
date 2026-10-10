// F10 easy roll, measured: the roll keys through game/roll-control.ts into
// the real stepFlight with the player's tuning — roll times, a release that
// holds the bank, the double-tap snap roll, the ROLL AUTO-LEVEL modes and
// their device defaults, bank ownership (only the pilot's bank is held) and
// bounded jerk at every hand-off.

import { MAX_SPEED } from "@angels-bandits/common/constants";
import {
  type FlightState,
  createFlightState,
  realRoll,
  stepFlight,
} from "@angels-bandits/common/flight";
import { describe, expect, it } from "vitest";
import { rollKey } from "../src/game/roll-control";
import {
  DOUBLE_TAP_GAP_S,
  RELEASE_FASTER,
  type RollControlState,
  type RollLevelMode,
  TAP_MAX_S,
  createRollControl,
  defaultRollLevel,
  effectiveRollLevel,
  snapTarget,
  stepRollControl,
} from "../src/game/roll-control";
import { tuning } from "../src/game/tuning";
import { DEFAULT_SETTINGS } from "../src/ui/settings";

const DEG = Math.PI / 180;
const FPS = [30, 60, 144];

/** Cruise (full throttle), level, wings level, heading 0. */
const cruise = (): FlightState => ({
  ...createFlightState({ x: 1000, y: 300, z: 1000 }, 0),
  speed: MAX_SPEED,
});

/** One pilot: the plane and its roll control, stepped like main.ts. */
class Pilot {
  f: FlightState;
  readonly rc: RollControlState = createRollControl();
  /** Roll commands handed to stepFlight, per frame. */
  readonly cmds: number[] = [];
  t = 0;
  constructor(
    readonly dt: number,
    f: FlightState = cruise(),
    public mode: RollLevelMode = "off",
  ) {
    this.f = f;
  }
  step(key: number, auto: number | null = null): void {
    const roll = stepRollControl(
      this.rc,
      {
        key,
        auto,
        mode: this.mode,
        roll: realRoll(this.f),
        pitch: this.f.pitch,
      },
      this.dt,
    );
    this.cmds.push(roll);
    this.f = stepFlight(
      this.f,
      { turn: 0, pitch: 0, roll, throttle: 1 },
      this.dt,
    );
    this.t += this.dt;
  }
  hold(key: number, secs: number, auto: number | null = null): void {
    const n = Math.round(secs / this.dt);
    for (let i = 0; i < n; i++) this.step(key, auto);
  }
  /** Hold `key` until the roll has swept `angle` (unwrapped), return the
   * time it took. */
  timeTo(key: number, angle: number): number {
    let swept = 0;
    let r0 = realRoll(this.f);
    const t0 = this.t;
    while (swept < angle && this.t - t0 < 5) {
      this.step(key);
      const r1 = realRoll(this.f);
      swept += Math.abs(Math.atan2(Math.sin(r1 - r0), Math.cos(r1 - r0)));
      r0 = r1;
    }
    return this.t - t0;
  }
}

describe("F10 easy roll: A/D roll fast with a quick, smooth ramp", () => {
  for (const fps of FPS) {
    it(`90° in ≤ 0.35 s and a full roll in ≤ 1.3 s — ${fps} fps`, () => {
      const quarter = new Pilot(1 / fps).timeTo(-1, 90 * DEG);
      const full = new Pilot(1 / fps).timeTo(1, 360 * DEG);
      if (fps === 60) {
        console.log(
          `roll: 90° in ${quarter.toFixed(3)} s, 360° in ${full.toFixed(3)} s`,
        );
      }
      expect(quarter).toBeLessThanOrEqual(0.35);
      expect(full).toBeLessThanOrEqual(1.3);
    });
  }

  it("the ramp is smooth: the command never steps by more than the ramp allows", () => {
    for (const fps of FPS) {
      const p = new Pilot(1 / fps);
      p.hold(1, 0.5);
      p.hold(0, 0.3);
      p.hold(-1, 0.5);
      p.hold(0, 0.3);
      const maxStep = (RELEASE_FASTER / tuning.rollRamp) * p.dt + 1e-9;
      for (let i = 1; i < p.cmds.length; i++) {
        const d = Math.abs((p.cmds[i] as number) - (p.cmds[i - 1] as number));
        expect(d).toBeLessThanOrEqual(maxStep);
      }
    }
  });

  it("Q and E roll like A and D (C is free-look now)", () => {
    const held = (codes: string[]) => (c: string) => codes.includes(c);
    expect(rollKey(held(["KeyA"]))).toBe(1);
    expect(rollKey(held(["KeyQ"]))).toBe(1);
    expect(rollKey(held(["KeyD"]))).toBe(-1);
    expect(rollKey(held(["KeyE"]))).toBe(-1);
    expect(rollKey(held(["KeyA", "KeyD"]))).toBe(0);
    expect(rollKey(held(["KeyC"]))).toBe(0);
  });
});

describe("F10 a released roll holds the bank", () => {
  for (const fps of FPS) {
    it(`let go mid-roll: stops within 5° and holds for 3 s — ${fps} fps`, () => {
      const p = new Pilot(1 / fps);
      p.hold(-1, 0.25);
      const atRelease = realRoll(p.f);
      p.hold(0, 0.2);
      const settled = realRoll(p.f);
      expect(Math.abs(settled - atRelease)).toBeLessThanOrEqual(5 * DEG);
      p.hold(0, 3);
      expect(realRoll(p.f)).toBeCloseTo(settled, 9);
      expect(Math.abs(settled)).toBeGreaterThan(45 * DEG);
    });
  }

  it("a held knife-edge stays one: altitude within ±5 m over 5 s", () => {
    const p = new Pilot(1 / 60);
    while (realRoll(p.f) > -88 * DEG) p.step(-1);
    p.hold(0, 0.1);
    const y0 = p.f.pos.y;
    p.hold(0, 5);
    expect(Math.abs(p.f.pos.y - y0)).toBeLessThanOrEqual(5);
    expect(realRoll(p.f)).toBeLessThan(-85 * DEG);
  });
});

describe("F10 snap roll: a double-tap rolls onto that wing", () => {
  /** Tap `key` for `press` s, wait `gap` s, then tap again. */
  function doubleTap(p: Pilot, key: number, press = 0.08, gap = 0.12): void {
    p.hold(key, press);
    p.hold(0, gap);
    p.hold(key, press);
    p.hold(0, 1);
  }

  for (const fps of FPS) {
    it(`double-tap D from level: onto the right wing (−90°) — ${fps} fps`, () => {
      const p = new Pilot(1 / fps);
      doubleTap(p, -1);
      expect(realRoll(p.f)).toBeCloseTo(-90 * DEG, 1);
      expect(Math.abs(realRoll(p.f) + 90 * DEG)).toBeLessThan(1 * DEG);
    });
  }

  it("double-tap A from level: onto the left wing, quickly", () => {
    const p = new Pilot(1 / 60);
    p.hold(1, 0.08);
    p.hold(0, 0.12);
    const t0 = p.t;
    while (Math.abs(realRoll(p.f) - 90 * DEG) > 2 * DEG && p.t - t0 < 2) {
      p.step(p.t - t0 < 0.08 ? 1 : 0);
    }
    const t = p.t - t0;
    console.log(
      `snap roll: within 2° of 90° ${t.toFixed(3)} s after the second tap`,
    );
    expect(t).toBeLessThan(0.4);
  });

  it("from a wing, another double-tap the same way goes on to inverted", () => {
    const p = new Pilot(1 / 60);
    doubleTap(p, 1);
    doubleTap(p, 1);
    expect(Math.abs(Math.abs(realRoll(p.f)) - Math.PI)).toBeLessThan(1 * DEG);
  });

  it("slow taps or a long first press are not a snap", () => {
    const slow = new Pilot(1 / 60);
    doubleTap(slow, -1, 0.08, DOUBLE_TAP_GAP_S + 0.1);
    const long = new Pilot(1 / 60);
    doubleTap(long, -1, TAP_MAX_S + 0.1, 0.1);
    // Two plain taps: each rolls a little and holds — nowhere near a snap
    // that would end on exactly −90° or −180°.
    for (const p of [slow, long]) {
      const r = realRoll(p.f);
      expect(Math.abs(r + 90 * DEG) > 1 * DEG || Math.abs(r) < 45 * DEG).toBe(
        true,
      );
      expect(p.rc.snap).toBeNull();
    }
  });

  it("snap targets: the next multiple that way", () => {
    expect(snapTarget(0, -1, 90 * DEG)).toBeCloseTo(-90 * DEG, 12);
    expect(snapTarget(35 * DEG, 1, 90 * DEG)).toBeCloseTo(90 * DEG, 12);
    expect(snapTarget(85 * DEG, 1, 90 * DEG)).toBeCloseTo(Math.PI, 12);
    expect(snapTarget(-90 * DEG, -1, 90 * DEG)).toBeCloseTo(Math.PI, 12);
  });
});

describe("F10 roll auto-level: off by default on the desktop, gentle on touch", () => {
  it("device defaults and the stored default (null = the device's)", () => {
    expect(defaultRollLevel(false)).toBe("off");
    expect(defaultRollLevel(true)).toBe("gentle");
    expect(DEFAULT_SETTINGS.rollLevel).toBeNull();
    expect(DEFAULT_SETTINGS.cameraRoll).toBe("level");
  });

  /** Rolled to 90° by A, released, then `mode` for `secs`: the time from
   * release to wings within 2° of level (Infinity if never). */
  function levelTime(mode: RollLevelMode, secs = 6): number {
    const p = new Pilot(1 / 60, cruise(), mode);
    while (realRoll(p.f) < 88 * DEG) p.step(1);
    const t0 = p.t;
    for (let t = 0; t < secs; t += p.dt) {
      p.step(0);
      if (Math.abs(realRoll(p.f)) < 2 * DEG) return p.t - t0;
    }
    return Number.POSITIVE_INFINITY;
  }

  it("off: the bank holds; gentle and strong level it after the delay", () => {
    const off = levelTime("off");
    const gentle = levelTime("gentle");
    const strong = levelTime("strong");
    console.log(
      `auto-level from 90°: gentle ${gentle.toFixed(2)} s, strong ${strong.toFixed(2)} s (delay ${tuning.rollLevelDelay} s)`,
    );
    expect(off).toBe(Number.POSITIVE_INFINITY);
    expect(gentle).toBeGreaterThan(tuning.rollLevelDelay);
    expect(gentle).toBeLessThan(tuning.rollLevelDelay + 3.5);
    expect(strong).toBeLessThan(gentle);
    expect(strong).toBeLessThan(tuning.rollLevelDelay + 1.5);
  });

  it("the Flight Lab's mode override wins over the setting; 0 defers to it", () => {
    expect(effectiveRollLevel("off")).toBe("off");
    for (const [m, want] of [
      [1, "off"],
      [2, "gentle"],
      [3, "strong"],
    ] as const) {
      tuning.rollLevelMode = m;
      expect(effectiveRollLevel("gentle")).toBe(want);
    }
    tuning.rollLevelMode = 0;
    expect(effectiveRollLevel("strong")).toBe("strong");
  });

  it("levelling ends exactly on the wings-level path", () => {
    const p = new Pilot(1 / 60, cruise(), "strong");
    p.hold(1, 0.2);
    p.hold(0, 5);
    expect(realRoll(p.f)).toBe(0);
  });
});

describe("F10 bank ownership: only the pilot's bank is held", () => {
  it("bank nobody commanded (a stray roll) is levelled even with auto-level off", () => {
    const p = new Pilot(1 / 60, { ...cruise(), roll: 0.4, bank: 0 }, "off");
    p.hold(0, 3);
    expect(Math.abs(realRoll(p.f))).toBeLessThan(1 * DEG);
  });

  it("the instructor's bank is levelled once it lets go…", () => {
    const p = new Pilot(1 / 60);
    p.hold(0, 0.25, -1); // the bank-and-pull rolls right
    expect(realRoll(p.f)).toBeLessThan(-45 * DEG);
    p.hold(0, 3);
    expect(Math.abs(realRoll(p.f))).toBeLessThan(1 * DEG);
  });

  it("…but A/D taking it over makes it the pilot's: held on release", () => {
    const p = new Pilot(1 / 60);
    p.hold(0, 0.25, -1);
    p.hold(-1, 0.05, -1); // the pilot grabs it
    p.hold(0, 0.2, null);
    const held = realRoll(p.f);
    p.hold(0, 3);
    expect(realRoll(p.f)).toBeCloseTo(held, 9);
    expect(held).toBeLessThan(-45 * DEG);
  });

  it("A/D always overrides the instructor, with bounded jerk at the hand-off", () => {
    const p = new Pilot(1 / 60);
    p.hold(0, 0.2, -1);
    const before = p.cmds.length;
    p.hold(1, 0.4, -1); // the pilot rolls the other way
    expect(realRoll(p.f)).toBeGreaterThan(-30 * DEG);
    const maxStep = (RELEASE_FASTER / tuning.rollRamp) * p.dt + 1e-9;
    for (let i = before; i < p.cmds.length; i++) {
      const d = Math.abs((p.cmds[i] as number) - (p.cmds[i - 1] as number));
      expect(d).toBeLessThanOrEqual(maxStep);
    }
  });
});
