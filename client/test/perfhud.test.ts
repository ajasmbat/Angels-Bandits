// The dev perf HUD (P1): the URL knobs that select what the harness
// measures, the text the overlay writes, and the two things that make it
// safe to ship — it is off by default and its markup is hidden behind
// `body.perf`. Mock doc objects, same injectable-target idiom as
// ui/fullscreen's tests (vitest runs in a node env).

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { FrameStats } from "../src/render/perfmeter";
import {
  DEFAULT_AA,
  DEFAULT_RENDER_OPTIONS,
  readRenderOptions,
} from "../src/render/renderopts";
import { RESOLUTION_CEILING, RESOLUTION_FLOOR } from "../src/render/resolution";
import {
  PerfHud,
  type PerfHudDoc,
  bindPerfHudKey,
  perfHudKeyEnabled,
  perfHudText,
} from "../src/ui/perfhud";

const STATS: FrameStats = {
  count: 300,
  p50: 16.7,
  p95: 21.24,
  p99: 30,
  worst: 84.9,
  mean: 17.9,
  fps: 59.88,
  drawCalls: 311,
  drawCallsMax: 402,
};

function mockDoc() {
  const el = { textContent: null as string | null };
  const classes = new Set<string>();
  const doc: PerfHudDoc = {
    getElementById: (id) => (id === "perfhud" ? el : null),
    body: {
      classList: {
        toggle: (token, force) => {
          if (force ?? !classes.has(token)) classes.add(token);
          else classes.delete(token);
        },
      },
    },
  };
  return { doc, el, classes };
}

/**
 * The panel every existing expectation in this suite was written against —
 * a Retina display, where `defaultLimits` and the raw module constants agree
 * exactly. The 1x cases below are the ones that tell them apart.
 */
const RETINA = 2;

/** A `window`-shaped stub that records what got bound to it. */
function mockTarget() {
  const listeners: ((ev: KeyboardEvent) => void)[] = [];
  const target = {
    addEventListener: (_type: string, fn: unknown) => {
      listeners.push(fn as (ev: KeyboardEvent) => void);
    },
  } as unknown as Pick<Window, "addEventListener">;
  const press = (init: Partial<KeyboardEvent> = {}) => {
    const ev = { code: "KeyP", repeat: false, target: null, ...init };
    for (const fn of listeners) fn(ev as KeyboardEvent);
  };
  return { target, listeners, press };
}

describe("readRenderOptions", () => {
  it("defaults to the shipped configuration on a plain visit", () => {
    expect(readRenderOptions("", RETINA)).toEqual(DEFAULT_RENDER_OPTIONS);
    expect(DEFAULT_RENDER_OPTIONS.aa).toBe(DEFAULT_AA);
    expect(DEFAULT_RENDER_OPTIONS.pixelRatio).toBe("auto");
    expect(DEFAULT_RENDER_OPTIONS.perfHud).toBe(false);
  });

  it("selects each antialiasing mode the harness measures", () => {
    for (const aa of ["legacy", "off", "msaa", "smaa"] as const) {
      expect(readRenderOptions(`?aa=${aa}`, RETINA).aa).toBe(aa);
    }
  });

  it("pins the pixel ratio, clamped to the controller's own limits", () => {
    expect(readRenderOptions("?res=1", RETINA).pixelRatio).toBe(1);
    expect(readRenderOptions("?res=4", RETINA).pixelRatio).toBe(
      RESOLUTION_CEILING,
    );
    expect(readRenderOptions("?res=0.1", RETINA).pixelRatio).toBe(
      RESOLUTION_FLOOR,
    );
    expect(readRenderOptions("?res=auto", RETINA).pixelRatio).toBe("auto");
  });

  it("opens the HUD only when asked, and 0/false still mean off", () => {
    expect(readRenderOptions("?perf=1", RETINA).perfHud).toBe(true);
    expect(readRenderOptions("?perf", RETINA).perfHud).toBe(true);
    expect(readRenderOptions("?perf=0", RETINA).perfHud).toBe(false);
    expect(readRenderOptions("?perf=false", RETINA).perfHud).toBe(false);
  });

  it("falls back to the shipped default on junk — a QA typo never breaks boot", () => {
    expect(readRenderOptions("?aa=taa&res=banana", RETINA)).toEqual(
      DEFAULT_RENDER_OPTIONS,
    );
    expect(readRenderOptions("?res=-2", RETINA).pixelRatio).toBe("auto");
  });
});

describe("perfHudText", () => {
  const text = perfHudText(STATS, { ratio: 1.7, auto: true }, "msaa");

  it("leads with fps and p50, then the tail of the distribution", () => {
    const [first, second] = text.split("\n");
    expect(first).toBe("PERF  60 FPS  (p50 16.7 ms)");
    expect(second).toBe("p95 21.2  p99 30.0  WORST 84.9 ms");
  });

  it("shows the live pixel ratio and whether the scaler owns it", () => {
    expect(text).toContain("RES 1.70x auto");
    expect(perfHudText(STATS, { ratio: 2, auto: false }, "msaa")).toContain(
      "RES 2.00x pinned",
    );
  });

  it("shows draw calls and the sample count behind the numbers", () => {
    expect(text).toContain("DRAW 311 (max 402)  N 300");
  });
});

describe("PerfHud", () => {
  it("starts closed and sets no body class", () => {
    const { doc, classes } = mockDoc();
    const hud = new PerfHud(doc);
    expect(hud.isOpen).toBe(false);
    expect(classes.has("perf")).toBe(false);
  });

  it("writes nothing at all while closed", () => {
    const { doc, el } = mockDoc();
    const hud = new PerfHud(doc);
    hud.update(0, () => STATS, { ratio: 2, auto: true }, "msaa");
    expect(el.textContent).toBeNull();
  });

  it("toggles body.perf — the same idiom as body.freelook", () => {
    const { doc, classes } = mockDoc();
    const hud = new PerfHud(doc);
    hud.toggle();
    expect(classes.has("perf")).toBe(true);
    hud.toggle();
    expect(classes.has("perf")).toBe(false);
  });

  it("throttles writes, and never summarises the window it will not use", () => {
    const { doc, el } = mockDoc();
    const hud = new PerfHud(doc);
    let summarised = 0;
    const statsOf = () => {
      summarised++;
      return STATS;
    };
    hud.setOpen(true);
    hud.update(1000, statsOf, { ratio: 2, auto: true }, "msaa");
    expect(summarised).toBe(1);
    expect(el.textContent).toContain("PERF");
    // Same 250 ms bucket: nothing recomputed, nothing rewritten.
    hud.update(1100, statsOf, { ratio: 2, auto: true }, "msaa");
    expect(summarised).toBe(1);
    hud.update(1300, statsOf, { ratio: 2, auto: true }, "msaa");
    expect(summarised).toBe(2);
  });

  it("survives a document with no #perfhud element", () => {
    const hud = new PerfHud({ getElementById: () => null, body: null });
    hud.setOpen(true);
    expect(() =>
      hud.update(0, () => STATS, { ratio: 2, auto: true }, "msaa"),
    ).not.toThrow();
  });
});

describe("perf HUD markup", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

  it("ships the overlay element", () => {
    expect(html).toContain('<div id="perfhud"></div>');
  });

  it("is hidden by default and only shown under body.perf", () => {
    const rule = html.match(/#perfhud \{[^}]*\}/)?.[0] ?? "";
    expect(rule).toContain("display: none");
    expect(html).toMatch(/body\.perf #perfhud \{\s*display: block;\s*\}/);
  });

  it("cannot eat a click or a drag — it is not player UI", () => {
    const rule = html.match(/#perfhud \{[^}]*\}/)?.[0] ?? "";
    expect(rule).toContain("pointer-events: none");
    expect(rule).toContain("user-select: none");
  });
});

describe("perfHudText — the GPU skip count", () => {
  it("says nothing when every frame was timed", () => {
    const text = perfHudText(STATS, { ratio: 2, auto: true }, "off", STATS, 0);
    expect(text).toContain("GPU p50");
    expect(text).not.toContain("SKIPPED");
  });

  it("shouts when the timer dropped frames, because those are the worst ones", () => {
    const text = perfHudText(STATS, { ratio: 2, auto: true }, "off", STATS, 17);
    expect(text).toContain("!17 SKIPPED");
  });
});

describe("readRenderOptions — ?res= is clamped to THIS panel", () => {
  // The bug this replaced clamped to RESOLUTION_FLOOR/CEILING, which describe
  // the CONTROLLER's range and not the display's. On a Retina panel the two
  // are the same numbers, which is why it survived P1 unnoticed: the harness
  // pins deviceScaleFactor 2.
  it("agrees with the module constants on a Retina panel", () => {
    expect(readRenderOptions("?res=4", RETINA).pixelRatio).toBe(
      RESOLUTION_CEILING,
    );
    expect(readRenderOptions("?res=0.1", RETINA).pixelRatio).toBe(
      RESOLUTION_FLOOR,
    );
  });

  it("refuses to draw 4x the pixels on a 1x display", () => {
    // ?res=2 on a 1x panel used to be honoured literally — four times the
    // pixels of the same URL on Retina, under a five-level bloom chain, and
    // a before/after recorded there was comparable to nothing.
    expect(readRenderOptions("?res=2", 1).pixelRatio).toBe(1);
    expect(readRenderOptions("?res=1", 1).pixelRatio).toBe(1);
  });

  it("never clamps a sub-floor panel above its own ratio", () => {
    // defaultLimits pulls the FLOOR down with the ceiling, so a panel below
    // RESOLUTION_FLOOR is pinned at itself rather than upscaled to 0.75.
    expect(readRenderOptions("?res=2", 0.5).pixelRatio).toBe(0.5);
    expect(readRenderOptions("?res=0.1", 0.5).pixelRatio).toBe(0.5);
  });

  it("reads a nonsense device ratio as 1 rather than pinning zero pixels", () => {
    // defaultLimits(0) has a ceiling of 0 — a black canvas. No real panel
    // reports it; jsdom and some headless contexts do.
    for (const dpr of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(readRenderOptions("?res=2", dpr).pixelRatio).toBe(1);
    }
  });

  it("leaves the scaler alone — ?res=auto is not a ratio to clamp", () => {
    expect(readRenderOptions("?res=auto", 1).pixelRatio).toBe("auto");
    expect(readRenderOptions("", 1).pixelRatio).toBe("auto");
  });
});

describe("perfHudKeyEnabled", () => {
  it("binds P in a dev build", () => {
    expect(perfHudKeyEnabled(true, false)).toBe(true);
  });

  it("binds P in any build the URL asked the overlay for", () => {
    expect(perfHudKeyEnabled(false, true)).toBe(true);
  });

  it("does NOT bind P in a plain production visit", () => {
    expect(perfHudKeyEnabled(false, false)).toBe(false);
  });
});

describe("bindPerfHudKey", () => {
  it("registers no listener at all when disabled", () => {
    const { doc } = mockDoc();
    const hud = new PerfHud(doc);
    const { target, listeners } = mockTarget();
    bindPerfHudKey(hud, false, target);
    // Gating the REGISTRATION, not the handler: a production player does not
    // even pay a predicate per keystroke.
    expect(listeners).toHaveLength(0);
    expect(hud.isOpen).toBe(false);
  });

  it("toggles the HUD when enabled", () => {
    const { doc } = mockDoc();
    const hud = new PerfHud(doc);
    const { target, press } = mockTarget();
    bindPerfHudKey(hud, true, target);
    press();
    expect(hud.isOpen).toBe(true);
    press();
    expect(hud.isOpen).toBe(false);
  });

  it("ignores auto-repeat, other keys, and a callsign being typed", () => {
    const { doc } = mockDoc();
    const hud = new PerfHud(doc);
    const { target, press } = mockTarget();
    bindPerfHudKey(hud, true, target);
    press({ repeat: true });
    press({ code: "KeyF" });
    press({ target: { tagName: "INPUT" } as unknown as EventTarget });
    press({ target: { tagName: "TEXTAREA" } as unknown as EventTarget });
    expect(hud.isOpen).toBe(false);
  });
});
