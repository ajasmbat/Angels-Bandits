// M8 fight on touch without fumbling: auto-fire's trigger (pulls on a
// solution, a minimum burst, a release delay, instant release when it may
// not fire), the deliberate two-finger free-look gate (a resting second
// finger never swings the camera), the button hit-slop that keeps a missed
// press from becoming an aim drag, and the aim friction near the reticle.

import { describe, expect, it } from "vitest";
import {
  AUTO_FIRE_MIN_MS,
  AUTO_FIRE_RELEASE_MS,
  type AutoFireInput,
  createAutoFire,
  stepAutoFire,
} from "../src/game/auto-fire";
import {
  AIM_FRICTION_GAIN,
  AIM_FRICTION_PX,
  aimFriction,
} from "../src/game/touch-aim-dir";
import {
  BUTTON_SLOP_PX,
  LOOK_MIN_PX,
  LOOK_WINDOW_MS,
  type LookGate,
  type TouchPoint,
  createLookGate,
  gateLook,
  nearControl,
} from "../src/game/touch-input";

describe("stepAutoFire", () => {
  const fight = (o: Partial<AutoFireInput> = {}): AutoFireInput => ({
    enabled: true,
    flying: true,
    solution: true,
    locked: false,
    protectedSelf: false,
    ...o,
  });
  const lost = fight({ solution: false });

  it("pulls at once on a solution, and holds while it lasts", () => {
    const s = createAutoFire();
    expect(stepAutoFire(s, lost, 0)).toBe(false);
    expect(stepAutoFire(s, fight(), 100)).toBe(true);
    expect(stepAutoFire(s, fight(), 5000)).toBe(true);
  });

  it("losing the solution releases exactly AUTO_FIRE_RELEASE_MS later", () => {
    const s = createAutoFire();
    stepAutoFire(s, fight(), 0);
    stepAutoFire(s, fight(), 1000);
    expect(stepAutoFire(s, lost, 1000)).toBe(true);
    expect(stepAutoFire(s, lost, 1000 + AUTO_FIRE_RELEASE_MS - 1)).toBe(true);
    expect(stepAutoFire(s, lost, 1000 + AUTO_FIRE_RELEASE_MS)).toBe(false);
    expect(s.firing).toBe(false);
  });

  it("…but never inside the minimum burst: a flicker still fires AUTO_FIRE_MIN_MS", () => {
    const s = createAutoFire();
    stepAutoFire(s, fight(), 0);
    expect(stepAutoFire(s, lost, 16)).toBe(true);
    // Release delay is over at 166, the burst isn't until 200.
    expect(stepAutoFire(s, lost, 16 + AUTO_FIRE_RELEASE_MS)).toBe(true);
    expect(stepAutoFire(s, lost, AUTO_FIRE_MIN_MS - 1)).toBe(true);
    expect(stepAutoFire(s, lost, AUTO_FIRE_MIN_MS)).toBe(false);
  });

  it("re-acquiring the solution cancels a pending release", () => {
    const s = createAutoFire();
    stepAutoFire(s, fight(), 0);
    stepAutoFire(s, lost, 1000);
    expect(stepAutoFire(s, fight(), 1100)).toBe(true);
    // The loss clock restarted: 1000 + 150 is no longer the release.
    expect(stepAutoFire(s, lost, 1200)).toBe(true);
    expect(stepAutoFire(s, lost, 1200 + AUTO_FIRE_RELEASE_MS - 1)).toBe(true);
    expect(stepAutoFire(s, lost, 1200 + AUTO_FIRE_RELEASE_MS)).toBe(false);
  });

  for (const [why, input] of [
    ["the setting is off", { enabled: false }],
    ["not flying (dead, settings, free-look)", { flying: false }],
    ["the guns are overheat-locked", { locked: true }],
    ["our own spawn protection is up", { protectedSelf: true }],
  ] as const) {
    it(`releases at once, even mid-burst, when ${why}`, () => {
      const s = createAutoFire();
      stepAutoFire(s, fight(), 0);
      expect(stepAutoFire(s, fight(input), 10)).toBe(false);
      expect(s.firing).toBe(false);
      // …and never pulls while it holds, solution or not.
      expect(stepAutoFire(s, fight(input), 500)).toBe(false);
    });
  }
});

describe("gateLook — two fingers only free-look on purpose", () => {
  const t = (id: number, x: number, y: number): TouchPoint => ({ id, x, y });

  /** Run a sequence of touch events through the gate; the ids that reached
   * touchInput at each. */
  const play = (
    events: { touches: TouchPoint[]; at: number; firing?: boolean }[],
  ): { ids: number[][]; gate: LookGate } => {
    let gate = createLookGate();
    const ids: number[][] = [];
    for (const e of events) {
      const r = gateLook(gate, e.touches, e.at, e.firing ?? false);
      gate = r.gate;
      ids.push(r.touches.map((p) => p.id));
    }
    return { ids, gate };
  };

  it("one finger always passes", () => {
    const { ids, gate } = play([
      { touches: [t(1, 500, 200)], at: 0 },
      { touches: [t(1, 540, 230)], at: 16 },
    ]);
    expect(ids).toEqual([[1], [1]]);
    expect(gate.primary).toBe(1);
  });

  it("a resting second finger is ignored: the first keeps aiming", () => {
    const { ids, gate } = play([
      { touches: [t(1, 500, 200)], at: 0 },
      { touches: [t(1, 500, 200), t(2, 700, 250)], at: 100 },
      { touches: [t(1, 530, 200), t(2, 702, 251)], at: 150 }, // only 1 moved
      { touches: [t(1, 560, 200), t(2, 702, 251)], at: 300 }, // window over
      { touches: [t(1, 600, 200), t(2, 760, 300)], at: 320 }, // too late now
    ]);
    expect(ids).toEqual([[1], [1], [1], [1], [1]]);
    expect(gate.missed).toBe(true);
    expect(gate.open).toBe(false);
  });

  it("both fingers moving LOOK_MIN_PX within LOOK_WINDOW_MS opens free-look", () => {
    const { ids, gate } = play([
      { touches: [t(1, 500, 200)], at: 0 },
      { touches: [t(1, 500, 200), t(2, 700, 250)], at: 100 },
      {
        touches: [t(1, 500 + LOOK_MIN_PX, 200), t(2, 700, 250 + LOOK_MIN_PX)],
        at: 100 + LOOK_WINDOW_MS,
      },
      { touches: [t(1, 560, 200), t(2, 700, 300)], at: 400 },
    ]);
    expect(ids).toEqual([[1], [1], [1, 2], [1, 2]]);
    expect(gate.open).toBe(true);
  });

  it("just short of LOOK_MIN_PX, or a millisecond past the window, stays aiming", () => {
    const short = play([
      { touches: [t(1, 500, 200), t(2, 700, 250)], at: 0 },
      {
        touches: [t(1, 500 + LOOK_MIN_PX - 0.1, 200), t(2, 700, 290)],
        at: 50,
      },
    ]);
    expect(short.ids.at(-1)).toEqual([1]);
    const late = play([
      { touches: [t(1, 500, 200), t(2, 700, 250)], at: 0 },
      { touches: [t(1, 540, 200), t(2, 700, 290)], at: LOOK_WINDOW_MS + 1 },
    ]);
    expect(late.ids.at(-1)).toEqual([1]);
    expect(late.gate.missed).toBe(true);
  });

  it("a missed pair is reset by lifting to one finger; the next pair is judged afresh", () => {
    const { ids, gate } = play([
      { touches: [t(1, 500, 200), t(2, 700, 250)], at: 0 },
      { touches: [t(1, 500, 200), t(2, 700, 250)], at: 400 }, // missed
      { touches: [t(1, 500, 200)], at: 500 },
      { touches: [t(1, 500, 200), t(3, 650, 260)], at: 600 },
      { touches: [t(1, 530, 200), t(3, 650, 300)], at: 650 },
    ]);
    expect(ids).toEqual([[1], [1], [1], [1], [1, 3]]);
    expect(gate.open).toBe(true);
  });

  it("firing (by hand or auto-fire) closes free-look and drops the pair", () => {
    const { ids, gate } = play([
      { touches: [t(1, 500, 200), t(2, 700, 250)], at: 0 },
      { touches: [t(1, 540, 200), t(2, 700, 290)], at: 50 }, // open
      { touches: [t(1, 560, 200), t(2, 700, 310)], at: 80, firing: true },
      { touches: [t(1, 600, 200), t(2, 700, 350)], at: 100 }, // still out
    ]);
    expect(ids).toEqual([[1], [1, 2], [1], [1]]);
    expect(gate.open).toBe(false);
    expect(gate.missed).toBe(true);
  });

  it("when the aiming finger lifts, the survivor takes over", () => {
    const { ids, gate } = play([
      { touches: [t(1, 500, 200), t(2, 700, 250)], at: 0 },
      { touches: [t(2, 705, 250)], at: 50 },
    ]);
    expect(ids).toEqual([[1], [2]]);
    expect(gate.primary).toBe(2);
  });

  it("no fingers resets the gate", () => {
    expect(gateLook(createLookGate(), [], 0, false).gate).toEqual(
      createLookGate(),
    );
  });
});

describe("nearControl — a missed press is not an aim finger", () => {
  const fire = { left: 100, top: 200, right: 196, bottom: 296 };
  const hidden = { left: 0, top: 0, right: 0, bottom: 0 };

  it("inside, and within BUTTON_SLOP_PX of the edge (inclusive), counts", () => {
    expect(nearControl(150, 250, [fire], BUTTON_SLOP_PX)).toBe(true);
    expect(nearControl(196 + BUTTON_SLOP_PX, 250, [fire], BUTTON_SLOP_PX)).toBe(
      true,
    );
    expect(
      nearControl(196 + BUTTON_SLOP_PX + 0.1, 250, [fire], BUTTON_SLOP_PX),
    ).toBe(false);
  });

  it("measures from the nearest corner diagonally", () => {
    const d = BUTTON_SLOP_PX / Math.SQRT2;
    expect(
      nearControl(196 + d - 0.1, 200 - d + 0.1, [fire], BUTTON_SLOP_PX),
    ).toBe(true);
    expect(
      nearControl(196 + d + 0.5, 200 - d - 0.5, [fire], BUTTON_SLOP_PX),
    ).toBe(false);
  });

  it("empty (hidden) rects never count", () => {
    expect(nearControl(0, 0, [hidden], BUTTON_SLOP_PX)).toBe(false);
    expect(nearControl(150, 250, [hidden, fire], BUTTON_SLOP_PX)).toBe(true);
  });
});

describe("aimFriction — a thumb settles onto the shot", () => {
  it("halves the drag gain within AIM_FRICTION_PX of the reticle (inclusive), full gain outside or with no target", () => {
    const reticle = { x: 400, y: 300 };
    expect(aimFriction({ x: 400, y: 300 }, reticle)).toBe(AIM_FRICTION_GAIN);
    expect(aimFriction({ x: 400 + AIM_FRICTION_PX, y: 300 }, reticle)).toBe(
      AIM_FRICTION_GAIN,
    );
    expect(
      aimFriction({ x: 400 + AIM_FRICTION_PX + 0.01, y: 300 }, reticle),
    ).toBe(1);
    expect(aimFriction({ x: 400, y: 300 }, null)).toBe(1);
  });
});
