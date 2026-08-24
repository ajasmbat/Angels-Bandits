// Right-button plumbing for the aim zoom (ANGE-G9CPCV). FlightInputSource takes
// an injectable `target: Window`, so the node test env drives it with a stub
// that records listeners — the same `as unknown as` idiom storm-client.test.ts
// uses for a camera. Button 0 belongs to the guns and must stay untouched.

import { describe, expect, it } from "vitest";
import { FlightInputSource } from "../src/game/flight-input";

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
