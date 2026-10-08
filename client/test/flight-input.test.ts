// Right-button plumbing for the aim zoom (ANGE-G9CPCV). FlightInputSource takes
// an injectable `target: Window`, so the node test env drives it with a stub
// that records listeners — the same `as unknown as` idiom storm-client.test.ts
// uses for a camera. Button 0 belongs to the guns and must stay untouched.

import {
  MAX_SPEED,
  MIN_SPEED,
  RESPAWN_ALTITUDE,
} from "@angels-bandits/common/constants";
import {
  type FlightState,
  createFlightState,
  stepFlight,
} from "@angels-bandits/common/flight";
import { describe, expect, it } from "vitest";
import { AUTO_THROTTLE, FlightInputSource } from "../src/game/flight-input";
import { throttleCommand } from "../src/game/touch-input";

interface StubEvent {
  button?: number;
  code?: string;
  prevented?: boolean;
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

const mouse = (button: number): StubEvent => ({ button });

describe("right-button aim hold", () => {
  it("starts released", () => {
    const { win } = stubWindow();
    expect(new FlightInputSource(win).aimHeld()).toBe(false);
  });

  it("holds on right mousedown and releases on right mouseup", () => {
    const { win, fire } = stubWindow();
    const input = new FlightInputSource(win);
    fire("mousedown", mouse(2));
    expect(input.aimHeld()).toBe(true);
    fire("mouseup", mouse(2));
    expect(input.aimHeld()).toBe(false);
  });

  it("ignores the left button entirely — that is the trigger", () => {
    const { win, fire } = stubWindow();
    const input = new FlightInputSource(win);
    fire("mousedown", mouse(0));
    expect(input.aimHeld()).toBe(false);
  });

  it("keeps the zoom while the trigger is pulled and released", () => {
    const { win, fire } = stubWindow();
    const input = new FlightInputSource(win);
    fire("mousedown", mouse(2));
    fire("mousedown", mouse(0));
    fire("mouseup", mouse(0));
    expect(input.aimHeld()).toBe(true);
  });

  it("force-releases on blur — a mouseup outside the window never arrives", () => {
    const { win, fire } = stubWindow();
    const input = new FlightInputSource(win);
    fire("mousedown", mouse(2));
    fire("blur");
    expect(input.aimHeld()).toBe(false);
  });

  it("still clears held keys on blur (existing behaviour)", () => {
    const { win, fire } = stubWindow();
    const input = new FlightInputSource(win);
    fire("keydown", { code: "KeyE" });
    expect(input.freeLookHeld()).toBe(true);
    fire("blur");
    expect(input.freeLookHeld()).toBe(false);
  });
});

describe("context menu", () => {
  it("suppresses it, or the browser menu eats the hold and steals focus", () => {
    const { win, fire } = stubWindow();
    new FlightInputSource(win);
    let prevented = false;
    fire("contextmenu", {
      preventDefault: () => {
        prevented = true;
      },
    });
    expect(prevented).toBe(true);
  });
});

// F5: the throttle lives at FULL. Spawns and respawns hand the flight model
// a full command (createFlightState), and whatever W/S or the touch slider
// did, letting go rides it back up.
describe("full throttle by default (F5)", () => {
  const level = (speed: number, targetSpeed: number): FlightState => ({
    pos: { x: 500, y: 300, z: 500 },
    yaw: 0,
    pitch: 0,
    roll: 0,
    speed,
    targetSpeed,
  });
  /** Fly `seconds` at 60 Hz on whatever the input source reads. */
  const fly = (f: FlightState, input: FlightInputSource, seconds: number) => {
    let s = f;
    for (let i = 0; i < seconds * 60; i++)
      s = stepFlight(s, input.read(), 1 / 60);
    return s;
  };

  it("spawns and respawns at full throttle (both go through createFlightState)", () => {
    // main.ts: welcome spawn and respawnSelf both take createFlightState and
    // override only the airspeed with the server's spawn speed.
    const spawn = createFlightState({ x: 10, y: RESPAWN_ALTITUDE, z: 20 }, 1);
    expect(spawn.targetSpeed).toBe(MAX_SPEED);
    const respawn = {
      ...createFlightState({ x: 1990, y: 300, z: 5 }),
      speed: 65,
    };
    expect(respawn.targetSpeed).toBe(MAX_SPEED);
    expect(respawn.speed).toBe(65);
  });

  it("nothing on the throttle reads AUTO_THROTTLE: the command climbs to full", () => {
    const { win } = stubWindow();
    const input = new FlightInputSource(win);
    expect(input.read().throttle).toBe(AUTO_THROTTLE);
    const end = fly(level(MIN_SPEED, MIN_SPEED), input, 6);
    expect(end.targetSpeed).toBe(MAX_SPEED);
    expect(end.speed).toBeGreaterThan(MIN_SPEED + 30);
  });

  it("S slows only while held, then the command rides back to full", () => {
    const { win, fire } = stubWindow();
    const input = new FlightInputSource(win);
    fire("keydown", { code: "KeyS" });
    expect(input.read().throttle).toBe(-1);
    const slowed = fly(level(MAX_SPEED, MAX_SPEED), input, 3);
    expect(slowed.targetSpeed).toBe(MIN_SPEED);
    fire("keyup", { code: "KeyS" });
    const back = fly(slowed, input, 4);
    expect(back.targetSpeed).toBe(MAX_SPEED);
  });

  it("W still reads full forward, and a held touch slider servoes instead of the auto throttle", () => {
    const { win, fire } = stubWindow();
    const input = new FlightInputSource(win);
    fire("keydown", { code: "KeyW" });
    expect(input.read().throttle).toBe(1);
    fire("keyup", { code: "KeyW" });
    input.setTouchThrottle(0); // finger holding the knob exactly on target
    expect(input.read().throttle).toBe(0);
    input.setTouchThrottle(null); // finger lifted
    expect(input.read().throttle).toBe(AUTO_THROTTLE);
  });

  it("a slider released mid-travel rides back to full", () => {
    const { win } = stubWindow();
    const input = new FlightInputSource(win);
    // Held at the bottom for a while, then released.
    let f = level(MAX_SPEED, MAX_SPEED);
    for (let i = 0; i < 180; i++) {
      input.setTouchThrottle(throttleCommand(0, f.targetSpeed, 1 / 60));
      f = stepFlight(f, input.read(), 1 / 60);
    }
    expect(f.targetSpeed).toBeCloseTo(MIN_SPEED, 6);
    input.setTouchThrottle(null);
    expect(fly(f, input, 4).targetSpeed).toBe(MAX_SPEED);
  });
});
