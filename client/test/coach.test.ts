// U3 first five minutes (client/src/ui/coach.ts): the pure hint queue —
// first delay, one hint at a time, timeout, gap, an action fading its hint
// and dropping ones still to come, a pause putting the hint back — the
// primer copy, and persistence through the guarded storage helpers. Blocked
// storage (a throwing `window.localStorage`, as Safari's "Block All
// Cookies" does) must read as unset and swallow writes: the Coach still
// works, it just forgets. `window` is stubbed in every storage case, and a
// WORKING store is proven first, so a bare node `window` (undefined — which
// also throws) can't make these pass on its own.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  COACH_DONE_KEY,
  Coach,
  type CoachState,
  GAP_MS,
  HINT_MS,
  HINT_ORDER,
  TOUCH_COACH_KEY,
  coachFinished,
  createCoach,
  hintText,
  noteAction,
  primerItems,
  stepCoach,
} from "../src/ui/coach";
import { readStored, writeStored } from "../src/ui/storage";

/** The first hint waits this long after the first frame (coach.ts). */
const FIRST_DELAY_MS = 2000;

/** Step `s` by `ms` in one go, active. */
const run = (s: CoachState, ms: number, active = true) =>
  stepCoach(s, ms, active);

describe("the hint queue (createCoach / stepCoach / noteAction)", () => {
  it("a done flag means nothing to show", () => {
    const s = createCoach(true);
    expect(s.queue).toEqual([]);
    expect(coachFinished(s)).toBe(true);
    expect(run(s, 60_000).showing).toBeNull();
  });

  it("waits the first delay, then shows the hints in order, each up to HINT_MS with GAP_MS between", () => {
    let s = createCoach(false);
    expect(s.queue).toEqual(HINT_ORDER);
    s = run(s, FIRST_DELAY_MS - 1);
    expect(s.showing).toBeNull();
    s = run(s, 1);
    expect(s.showing).toBe("aim");
    expect(s.queue).toEqual(["fire", "boost"]);
    s = run(s, HINT_MS - 1);
    expect(s.showing).toBe("aim");
    s = run(s, 1); // timed out
    expect(s.showing).toBeNull();
    expect(s.waitMs).toBe(GAP_MS);
    s = run(s, GAP_MS);
    expect(s.showing).toBe("fire");
    for (const next of ["boost"]) {
      s = run(run(s, HINT_MS), GAP_MS);
      expect(s.showing).toBe(next);
    }
    s = run(s, HINT_MS);
    expect(coachFinished(s)).toBe(true);
  });

  it("doing the thing fades its hint at once; doing a later one drops it from the queue", () => {
    let s = run(createCoach(false), FIRST_DELAY_MS);
    expect(s.showing).toBe("aim");
    s = noteAction(s, "boost"); // done before it was taught
    expect(s.queue).toEqual(["fire"]);
    expect(s.showing).toBe("aim");
    s = noteAction(s, "aim");
    expect(s.showing).toBeNull();
    expect(s.waitMs).toBe(GAP_MS);
    s = run(s, GAP_MS);
    expect(s.showing).toBe("fire");
    // A repeat of a finished action changes nothing.
    expect(noteAction(s, "aim")).toBe(s);
  });

  it("a pause puts the hint on screen back at the front — it resumes in full", () => {
    let s = run(run(createCoach(false), FIRST_DELAY_MS), HINT_MS - 100);
    expect(s.showing).toBe("aim");
    s = run(s, 16, false);
    expect(s.showing).toBeNull();
    expect(s.queue[0]).toBe("aim");
    expect(s.waitMs).toBeGreaterThanOrEqual(GAP_MS);
    // Paused longer: nothing moves.
    expect(run(s, 60_000, false)).toBe(s);
    s = run(s, GAP_MS);
    expect(s.showing).toBe("aim");
    expect(s.shownMs).toBe(0);
  });
});

describe("the primer and hint copy", () => {
  it("desktop names the real keys; touch names the touch controls", () => {
    const desk = new Map(primerItems(false));
    expect(desk.get("SPACE")).toBe("boost");
    expect(desk.get("C")).toBe("look around");
    expect(desk.get("A / D")).toBe("roll · double-tap: snap");
    expect(desk.get("M")).toBe("aim mode");
    const touch = primerItems(true).map(([control]) => control);
    expect(touch).toContain("FIRE");
    expect(touch).toContain("TWO FINGERS");
    expect(touch.some((c) => c === "SPACE" || c === "MOUSE")).toBe(false);
    expect(hintText("boost", false)).toBe("HOLD SPACE TO BOOST");
    expect(hintText("aim", true)).toBe("DRAG THE RIGHT SIDE TO AIM");
  });
});

// --- Persistence -------------------------------------------------------------

/** A working Storage over a Map. */
const workingStore = () => {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, val: string) => {
      data.set(k, val);
    },
  };
};

/** A minimal element: class list, children, the bits Coach touches. */
class FakeEl {
  readonly classes = new Set<string>();
  readonly classList = {
    add: (c: string) => this.classes.add(c),
    remove: (c: string) => this.classes.delete(c),
    toggle: (c: string, on?: boolean) => {
      const want = on ?? !this.classes.has(c);
      if (want) this.classes.add(c);
      else this.classes.delete(c);
      return want;
    },
    contains: (c: string) => this.classes.has(c),
  };
  textContent = "";
  hidden = false;
  className = "";
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  readonly kids: FakeEl[] = [];
  readonly listeners = new Map<string, () => void>();
  constructor(private readonly parts: Record<string, FakeEl> = {}) {}
  querySelector(sel: string): FakeEl | null {
    return this.parts[sel] ?? null;
  }
  addEventListener(type: string, fn: () => void) {
    this.listeners.set(type, fn);
  }
  append(...els: FakeEl[]) {
    this.kids.push(...els);
  }
  prepend(...els: FakeEl[]) {
    this.kids.unshift(...els);
  }
}

/** Stub the DOM the Coach reads, with `localStorage` as given (or a getter
 * that throws). */
function stubDom(storage: ReturnType<typeof workingStore> | "blocked") {
  const text = new FakeEl();
  const skip = new FakeEl();
  const hint = new FakeEl({ ".text": text, button: skip });
  const overlay = new FakeEl();
  const win = { innerWidth: 800, addEventListener() {} };
  Object.defineProperty(win, "localStorage", {
    get() {
      if (storage === "blocked") throw new DOMException("SecurityError");
      return storage;
    },
  });
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", {
    getElementById: (id: string) =>
      id === "coach-hint" ? hint : id === "touch-coach" ? overlay : null,
    createElement: () => new FakeEl(),
  });
  return { hint, text, skip, overlay };
}

describe("guarded storage (W1 helper, U3's persistence)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("a working store reads back what was written (the stub is live)", () => {
    const store = workingStore();
    vi.stubGlobal("window", { localStorage: store });
    expect(readStored("ab:x")).toBeNull();
    writeStored("ab:x", "1");
    expect(store.data.get("ab:x")).toBe("1");
    expect(readStored("ab:x")).toBe("1");
  });

  it("a throwing localStorage GETTER reads as unset and swallows writes", () => {
    stubDom("blocked");
    expect(() => window.localStorage).toThrow();
    expect(readStored("ab:x")).toBeNull();
    expect(() => writeStored("ab:x", "1")).not.toThrow();
  });

  it("throwing getItem / setItem (quota, private mode) likewise", () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => {
          throw new Error("denied");
        },
        setItem: () => {
          throw new Error("QuotaExceededError");
        },
      },
    });
    expect(readStored("ab:x")).toBeNull();
    expect(() => writeStored("ab:x", "1")).not.toThrow();
  });
});

describe("Coach — the DOM layer and its once-only flags", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("a fresh visitor gets the first hint after the first delay", () => {
    const { hint, text } = stubDom(workingStore());
    const coach = new Coach(() => false);
    coach.start();
    coach.frame(FIRST_DELAY_MS, true, false);
    expect(coach.debug().shown).toBe("aim");
    expect(hint.classes.has("on")).toBe(true);
    expect(text.textContent).toBe("MOVE THE MOUSE TO AIM");
  });

  it("an existing done flag: nothing shows", () => {
    const store = workingStore();
    store.data.set(COACH_DONE_KEY, "1");
    stubDom(store);
    const coach = new Coach(() => false);
    coach.start();
    for (let i = 0; i < 10; i++) coach.frame(1000, true, false);
    expect(coach.debug().shown).toBeNull();
    expect(coach.debug().queue).toEqual([]);
  });

  it("SKIP TIPS ends the queue and records both flags", () => {
    const store = workingStore();
    const { hint } = stubDom(store);
    const coach = new Coach(() => true);
    coach.start();
    expect(coach.debug().overlay).toBe(true);
    // "Once" is recorded the moment the touch overlay shows.
    expect(store.data.get(TOUCH_COACH_KEY)).toBe("1");
    coach.skip();
    expect(store.data.get(COACH_DONE_KEY)).toBe("1");
    expect(coach.debug()).toMatchObject({
      shown: null,
      queue: [],
      overlay: false,
    });
    expect(hint.classes.has("on")).toBe(false);
    for (let i = 0; i < 10; i++) coach.frame(1000, true, false);
    expect(coach.debug().shown).toBeNull();
  });

  it("finishing the queue records the done flag; the next visit starts finished", () => {
    const store = workingStore();
    stubDom(store);
    const coach = new Coach(() => false);
    coach.start();
    coach.frame(FIRST_DELAY_MS, true, false);
    for (const id of HINT_ORDER) coach.note(id);
    coach.frame(16, true, false);
    expect(store.data.get(COACH_DONE_KEY)).toBe("1");
    stubDom(store);
    const next = new Coach(() => false);
    next.start();
    next.frame(FIRST_DELAY_MS, true, false);
    expect(next.debug().shown).toBeNull();
  });

  it("with storage blocked the Coach still runs: hints show, skip and start don't throw", () => {
    stubDom("blocked");
    const coach = new Coach(() => true);
    expect(() => coach.start()).not.toThrow();
    expect(coach.debug().overlay).toBe(true);
    coach.frame(16, false, false); // a death closes the overlay
    coach.frame(FIRST_DELAY_MS, true, false);
    expect(coach.debug().shown).toBe("aim");
    expect(() => coach.skip()).not.toThrow();
    expect(coach.debug().shown).toBeNull();
    // Nothing was remembered: a new Coach on blocked storage teaches again.
    const again = new Coach(() => false);
    again.start();
    again.frame(FIRST_DELAY_MS, true, false);
    expect(again.debug().shown).toBe("aim");
  });
});
