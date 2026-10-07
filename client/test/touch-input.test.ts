// M1 touch controls: the pure mapping in game/touch-input.ts, plus the
// emulated-mouse guard as FlightInputSource and Guns see it. ui/
// touch-controls.ts is the thin DOM adapter and is not exercised here. The
// guard keeps module state (`watching`, `lastTouchAt`), so those tests load
// a fresh copy of the modules per test and drive `performance.now` by hand.

import {
  MAX_SPEED,
  MIN_SPEED,
  THROTTLE_RATE,
} from "@angels-bandits/common/constants";
import {
  type FlightState,
  createFlightState,
  stepFlight,
} from "@angels-bandits/common/flight";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FlightInputSource } from "../src/game/flight-input";
import {
  SENSITIVITY_STEPS,
  type TouchAimState,
  type TouchPoint,
  type Viewport,
  createTouchAim,
  loadSensitivity,
  nextSensitivity,
  sliderSpeed,
  speedSlider,
  throttleCommand,
  touchInput,
} from "../src/game/touch-input";

const VIEW: Viewport = { w: 1000, h: 500 };
const finger = (id: number, x: number, y: number): TouchPoint => ({
  id,
  x,
  y,
});

/** Feed a sequence of touch frames through touchInput. */
function run(
  frames: readonly (readonly TouchPoint[])[],
  sensitivity = 1,
  v: Viewport = VIEW,
  start: TouchAimState = createTouchAim(VIEW),
): TouchAimState {
  let s = start;
  for (const f of frames) s = touchInput(s, f, v, sensitivity);
  return s;
}

describe("touchInput — one-finger aim drag", () => {
  it("starts centred with no fingers", () => {
    const s = createTouchAim(VIEW);
    expect(s).toMatchObject({ aimX: 500, aimY: 250, looking: false });
    expect(s.fingers).toEqual([]);
  });

  it("a fresh touch only baselines — the aim does not jump to the finger", () => {
    const s = run([[finger(1, 900, 450)]]);
    expect(s.aimX).toBe(500);
    expect(s.aimY).toBe(250);
  });

  it("moves the aim by drag × sensitivity", () => {
    const s = run([[finger(1, 100, 100)], [finger(1, 140, 70)]], 1.5);
    expect(s.aimX).toBe(500 + 40 * 1.5);
    expect(s.aimY).toBe(250 - 30 * 1.5);
  });

  it("accumulates relative drags across frames", () => {
    const s = run(
      [[finger(1, 0, 0)], [finger(1, 10, 5)], [finger(1, 30, 15)]],
      2,
    );
    expect(s.aimX).toBe(500 + 30 * 2);
    expect(s.aimY).toBe(250 + 15 * 2);
  });

  it("clamps the aim to the viewport", () => {
    const s = run([[finger(1, 0, 0)], [finger(1, 5000, -5000)]], 3);
    expect(s.aimX).toBe(VIEW.w);
    expect(s.aimY).toBe(0);
  });

  it("re-clamps when the viewport shrinks under a held aim", () => {
    const wide = run([[finger(1, 0, 0)], [finger(1, 450, 200)]]);
    expect(wide.aimX).toBe(950);
    const small: Viewport = { w: 600, h: 300 };
    const s = touchInput(wide, [finger(1, 450, 200)], small, 1);
    expect(s.aimX).toBe(600);
    expect(s.aimY).toBe(300);
  });

  it("releasing every finger holds the last aim", () => {
    const s = run([[finger(1, 0, 0)], [finger(1, 40, 20)], []]);
    expect(s.aimX).toBe(540);
    expect(s.aimY).toBe(270);
    expect(s.fingers).toEqual([]);
  });
});

describe("touchInput — adding or lifting a finger never jumps the aim", () => {
  const held = run([[finger(1, 100, 100)], [finger(1, 120, 100)]]);

  it("adding a second finger freezes the aim", () => {
    const s = touchInput(
      held,
      [finger(1, 400, 400), finger(2, 50, 50)],
      VIEW,
      1,
    );
    expect(s.aimX).toBe(held.aimX);
    expect(s.aimY).toBe(held.aimY);
  });

  it("the survivor of a lifted pair re-baselines instead of jumping", () => {
    let s = touchInput(held, [finger(1, 120, 100), finger(2, 50, 50)], VIEW, 1);
    // Finger 1 lifts; finger 2 is far from where finger 1 was.
    s = touchInput(s, [finger(2, 700, 400)], VIEW, 1);
    expect(s.aimX).toBe(held.aimX);
    expect(s.aimY).toBe(held.aimY);
    // ...and its NEXT move drags from its own baseline.
    s = touchInput(s, [finger(2, 710, 395)], VIEW, 1);
    expect(s.aimX).toBe(held.aimX + 10);
    expect(s.aimY).toBe(held.aimY - 5);
  });

  it("a different finger replacing the only one in one event does not jump", () => {
    const s = touchInput(held, [finger(7, 900, 10)], VIEW, 1);
    expect(s.aimX).toBe(held.aimX);
    expect(s.aimY).toBe(held.aimY);
  });

  it("lift then a fresh touch elsewhere does not jump", () => {
    const s = run([[], [finger(3, 10, 490)]], 1, VIEW, held);
    expect(s.aimX).toBe(held.aimX);
    expect(s.aimY).toBe(held.aimY);
  });
});

describe("touchInput — two fingers are free-look", () => {
  it("flags looking and holds the aim while two fingers drag", () => {
    const s = run([
      [finger(1, 100, 100), finger(2, 200, 100)],
      [finger(1, 130, 90), finger(2, 250, 110)],
    ]);
    expect(s.looking).toBe(true);
    expect(s.aimX).toBe(500);
    expect(s.aimY).toBe(250);
  });

  it("accumulates the mean drag of the fingers seen both times", () => {
    const s = run([
      [finger(1, 100, 100), finger(2, 200, 100)],
      [finger(1, 130, 90), finger(2, 250, 110)],
      [finger(1, 140, 90), finger(2, 260, 110)],
    ]);
    expect(s.lookDx).toBe((30 + 50) / 2 + 10);
    expect(s.lookDy).toBe((-10 + 10) / 2 + 0);
  });

  it("a brand-new pair adds no look delta", () => {
    const s = run([
      [finger(1, 100, 100), finger(2, 200, 100)],
      [finger(3, 900, 400), finger(4, 10, 10)],
    ]);
    expect(s.lookDx).toBe(0);
    expect(s.lookDy).toBe(0);
  });

  it("dropping back to one finger ends free-look", () => {
    const s = run([
      [finger(1, 100, 100), finger(2, 200, 100)],
      [finger(1, 100, 100)],
    ]);
    expect(s.looking).toBe(false);
  });
});

describe("throttle slider", () => {
  it("maps the slider ends to MIN/MAX speed and clamps beyond", () => {
    expect(sliderSpeed(0)).toBe(MIN_SPEED);
    expect(sliderSpeed(1)).toBe(MAX_SPEED);
    expect(sliderSpeed(-1)).toBe(MIN_SPEED);
    expect(sliderSpeed(2)).toBe(MAX_SPEED);
  });

  it("speedSlider is sliderSpeed's inverse, clamped", () => {
    for (const k of [0, 0.25, 0.5, 0.8, 1]) {
      expect(speedSlider(sliderSpeed(k))).toBeCloseTo(k, 12);
    }
    expect(speedSlider(MIN_SPEED - 10)).toBe(0);
    expect(speedSlider(MAX_SPEED + 10)).toBe(1);
  });

  it("released or with no time step it commands nothing", () => {
    expect(throttleCommand(null, 60, 1 / 60)).toBe(0);
    expect(throttleCommand(1, 60, 0)).toBe(0);
    expect(throttleCommand(1, 60, -0.01)).toBe(0);
  });

  it("lands exactly on the knob within one step when the gap is small", () => {
    const dt = 1 / 60;
    const knob = speedSlider(65.3);
    let f: FlightState = {
      ...createFlightState({ x: 0, y: 300, z: 0 }),
      targetSpeed: 65,
    };
    const cmd = throttleCommand(knob, f.targetSpeed, dt);
    expect(Math.abs(cmd)).toBeLessThan(1);
    f = stepFlight(f, { turn: 0, pitch: 0, roll: 0, throttle: cmd }, dt);
    expect(f.targetSpeed).toBeCloseTo(65.3, 9);
  });

  it("saturates at full W/S rate and approaches a far knob without overshoot", () => {
    for (const [from, to] of [
      [MIN_SPEED, MAX_SPEED],
      [MAX_SPEED, MIN_SPEED],
      [50, 77.7],
    ] as const) {
      const dt = 1 / 60;
      const knob = speedSlider(to);
      let f: FlightState = {
        ...createFlightState({ x: 0, y: 300, z: 0 }),
        targetSpeed: from,
      };
      const first = throttleCommand(knob, f.targetSpeed, dt);
      expect(Math.abs(first)).toBe(1);
      const dir = Math.sign(to - from);
      let frames = 0;
      while (Math.abs(f.targetSpeed - to) > 1e-9 && frames < 1000) {
        const cmd = throttleCommand(knob, f.targetSpeed, dt);
        f = stepFlight(f, { turn: 0, pitch: 0, roll: 0, throttle: cmd }, dt);
        // Never past the knob in the direction of travel.
        expect((f.targetSpeed - to) * dir).toBeLessThanOrEqual(1e-9);
        frames++;
      }
      expect(f.targetSpeed).toBeCloseTo(to, 9);
      // At full W/S rate: no faster than THROTTLE_RATE allows.
      const minFrames = Math.abs(to - from) / (THROTTLE_RATE * dt);
      expect(frames).toBeGreaterThanOrEqual(Math.floor(minFrames));
      // ...and once there, it holds.
      const hold = throttleCommand(knob, f.targetSpeed, dt);
      expect(Math.abs(hold)).toBeLessThan(1e-6);
    }
  });

  it("adds to W/S in FlightInputSource.read() and clamps to −1..1", () => {
    const { win, fire } = stubWindow();
    const input = new FlightInputSource(win);
    input.setTouchThrottle(0.6);
    expect(input.read().throttle).toBeCloseTo(0.6, 12);
    fire("keydown", { code: "KeyW" });
    expect(input.read().throttle).toBe(1);
    fire("keyup", { code: "KeyW" });
    fire("keydown", { code: "KeyS" });
    expect(input.read().throttle).toBeCloseTo(-0.4, 12);
  });
});

describe("aim sensitivity persistence", () => {
  const store = (initial: string | null = null) => {
    let v = initial;
    return {
      localStorage: {
        getItem: () => v,
        setItem: (_k: string, s: string) => {
          v = s;
        },
      },
      get value() {
        return v;
      },
    } as unknown as Pick<Window, "localStorage"> & { value: string | null };
  };
  const throwing = {
    get localStorage(): Storage {
      throw new Error("SecurityError: storage blocked");
    },
  } as Pick<Window, "localStorage">;
  const throwingCalls = {
    localStorage: {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    },
  } as unknown as Pick<Window, "localStorage">;

  it("loads the default when absent or junk", () => {
    expect(loadSensitivity(store())).toBe(1.5);
    expect(loadSensitivity(store("banana"))).toBe(1.5);
    expect(loadSensitivity(store("1.25"))).toBe(1.5);
  });

  it("loads a stored step", () => {
    expect(loadSensitivity(store("3"))).toBe(3);
  });

  it("loads the default when reading storage throws", () => {
    expect(loadSensitivity(throwing)).toBe(1.5);
    expect(loadSensitivity(throwingCalls)).toBe(1.5);
  });

  it("steps through every value, wrapping, and persists each", () => {
    const t = store();
    let s: number = SENSITIVITY_STEPS[0];
    const seen: number[] = [s];
    for (let i = 0; i < SENSITIVITY_STEPS.length; i++) {
      s = nextSensitivity(s, t);
      expect(t.value).toBe(String(s));
      seen.push(s);
    }
    expect(seen).toEqual([...SENSITIVITY_STEPS, SENSITIVITY_STEPS[0]]);
    expect(loadSensitivity(t)).toBe(s);
  });

  it("an unknown current value steps to the first step", () => {
    expect(nextSensitivity(1.25, store())).toBe(SENSITIVITY_STEPS[0]);
  });

  it("still steps when storage throws (this visit only)", () => {
    expect(nextSensitivity(1.5, throwing)).toBe(2);
    expect(nextSensitivity(1.5, throwingCalls)).toBe(2);
  });
});

// --- Emulated-mouse guard ----------------------------------------------------

interface StubEvent {
  button?: number;
  code?: string;
  clientX?: number;
  clientY?: number;
  movementX?: number;
  movementY?: number;
  relatedTarget?: unknown;
  sourceCapabilities?: { firesTouchEvents?: boolean };
  preventDefault?: () => void;
}

function stubWindow() {
  const handlers: Record<string, ((e: StubEvent) => void)[]> = {};
  const win = {
    innerWidth: 1280,
    innerHeight: 800,
    addEventListener(type: string, fn: (e: StubEvent) => void) {
      const list = handlers[type] ?? [];
      list.push(fn);
      handlers[type] = list;
    },
  };
  const fire = (type: string, ev: StubEvent = {}) => {
    for (const fn of handlers[type] ?? []) fn(ev);
    return ev;
  };
  return { win: win as unknown as Window, fire };
}

describe("emulated-mouse guard", () => {
  let now = 0;
  // A fresh module graph per test: `watching` and `lastTouchAt` are module
  // state, and FlightInputSource/Guns must share the copy under test.
  async function fresh() {
    vi.resetModules();
    const touch = await import("../src/game/touch-input");
    const { FlightInputSource } = await import("../src/game/flight-input");
    const { Guns } = await import("../src/game/guns");
    const { win, fire } = stubWindow();
    const input = new FlightInputSource(win);
    const guns = new Guns(win);
    const flight = createFlightState({ x: 0, y: 300, z: 0 });
    /** Whether the trigger is held: a fresh heat model fires on the first
     * update with the trigger down, and never without it. */
    const firing = () => {
      guns.reset(now - 10_000);
      return guns.update(now, flight) !== null;
    };
    return { touch, input, guns, fire, firing };
  }

  beforeEach(() => {
    now = 10_000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("flags a mouse event whose source fires touch events", async () => {
    const { touch } = await fresh();
    const ev = { sourceCapabilities: { firesTouchEvents: true } };
    expect(touch.emulatedMouse(ev as unknown as MouseEvent)).toBe(true);
  });

  it("never flags a real mouse when no touch has happened", async () => {
    const { touch } = await fresh();
    const ev = { sourceCapabilities: { firesTouchEvents: false } };
    expect(touch.emulatedMouse(ev as unknown as MouseEvent)).toBe(false);
    expect(touch.emulatedMouse({} as MouseEvent)).toBe(false);
  });

  it("flags mouse events within 700 ms of a touch, not at or after", async () => {
    const { touch, fire } = await fresh();
    fire("touchend");
    now += 699;
    expect(touch.emulatedMouse({} as MouseEvent)).toBe(true);
    now += 1;
    expect(touch.emulatedMouse({} as MouseEvent)).toBe(false);
  });

  it("stamps touchstart, touchend and touchcancel", async () => {
    for (const type of ["touchstart", "touchend", "touchcancel"]) {
      const { touch, fire } = await fresh();
      fire(type);
      now += 300;
      expect(touch.emulatedMouse({} as MouseEvent)).toBe(true);
    }
  });

  it("a tap's echo never moves the cursor", async () => {
    const { input, fire } = await fresh();
    fire("touchend");
    now += 100;
    fire("mousemove", {
      clientX: 10,
      clientY: 10,
      movementX: 40,
      movementY: 0,
    });
    expect(input.pointerPx()).toBeNull();
    expect(input.takeLookDelta()).toEqual({ dx: 0, dy: 0 });
  });

  it("an iOS-style echo (no sourceCapabilities) after a long press is caught", async () => {
    const { input, fire } = await fresh();
    fire("touchstart");
    now += 2000; // a long press outlasts any window from touchstart...
    fire("touchend"); // ...but the lift is stamped too
    now += 50;
    fire("mousemove", { clientX: 10, clientY: 10 });
    expect(input.pointerPx()).toBeNull();
  });

  it("a tap's echo never pulls (or releases) the trigger", async () => {
    const { fire, firing, guns } = await fresh();
    fire("touchend");
    now += 100;
    fire("mousedown", { button: 0 });
    expect(firing()).toBe(false);
    // Touch FIRE holds the trigger itself; an echo mouseup must not drop it.
    guns.setTrigger(true);
    fire("mouseup", { button: 0 });
    expect(firing()).toBe(true);
  });

  it("a tap's echo never zooms or fades steering out", async () => {
    const { input, fire } = await fresh();
    fire("touchend");
    now += 100;
    fire("mousedown", { button: 2 });
    expect(input.aimHeld()).toBe(false);
    fire("mouseout", { relatedTarget: null });
    input.tick(1);
    expect(input.presence()).toBe(1);
  });

  it("a real mouse still moves the cursor, fires, zooms and fades", async () => {
    const { input, fire, firing } = await fresh();
    fire("touchend");
    now += 700; // the echo window has passed
    fire("mousemove", { clientX: 10, clientY: 20, movementX: 5, movementY: 0 });
    expect(input.pointerPx()).toEqual({ x: 10, y: 20 });
    expect(input.takeLookDelta()).toEqual({ dx: 5, dy: 0 });
    fire("mousedown", { button: 0 });
    expect(firing()).toBe(true);
    fire("mouseup", { button: 0 });
    expect(firing()).toBe(false);
    fire("mousedown", { button: 2 });
    expect(input.aimHeld()).toBe(true);
    fire("mouseout", { relatedTarget: null });
    input.tick(1);
    expect(input.presence()).toBeLessThan(0.05);
  });

  it("the touch aim is the cursor, and keeps steering present", async () => {
    const { input, fire } = await fresh();
    fire("mousemove", { clientX: 1, clientY: 1 });
    fire("mouseout", { relatedTarget: null });
    input.setTouchAim(640, 100);
    input.tick(1);
    expect(input.pointerPx()).toEqual({ x: 640, y: 100 });
    expect(input.presence()).toBe(1);
  });
});
