// Fullscreen seam: the document-like interface behind the HUD button and the
// F shortcut. Tests inject plain mock objects (vitest runs in a node env —
// same injectable-target idiom as Scoreboard's `target: Window`); expected
// calls come from the Fullscreen API spec: standard `requestFullscreen` /
// `exitFullscreen`, `webkit`-prefixed fallbacks for older Safari, and
// `fullscreenEnabled` falsy on iPhones (no fullscreen at all).

import { describe, expect, it } from "vitest";
import {
  type FullscreenDoc,
  isFullscreen,
  isFullscreenSupported,
  toggleFullscreen,
  watchFullscreen,
} from "../src/ui/fullscreen";

/** Mock doc recording which API entry points the toggle actually called. */
function mockDoc(overrides: Partial<FullscreenDoc> = {}) {
  const calls: string[] = [];
  const doc: FullscreenDoc = {
    fullscreenEnabled: true,
    documentElement: {
      requestFullscreen: () => {
        calls.push("request");
        return Promise.resolve();
      },
      webkitRequestFullscreen: () => calls.push("webkitRequest"),
    },
    exitFullscreen: () => {
      calls.push("exit");
      return Promise.resolve();
    },
    webkitExitFullscreen: () => calls.push("webkitExit"),
    ...overrides,
  };
  return { doc, calls };
}

describe("isFullscreenSupported", () => {
  it("is true when the standard fullscreenEnabled flag is set", () => {
    expect(
      isFullscreenSupported({ fullscreenEnabled: true, documentElement: {} }),
    ).toBe(true);
  });

  it("is true on webkit-only documents (old Safari)", () => {
    expect(
      isFullscreenSupported({
        webkitFullscreenEnabled: true,
        documentElement: {},
      }),
    ).toBe(true);
  });

  it("is false when neither flag exists (iPhone Safari)", () => {
    expect(isFullscreenSupported({ documentElement: {} })).toBe(false);
  });

  it("is false when the flags exist but are false", () => {
    expect(
      isFullscreenSupported({
        fullscreenEnabled: false,
        webkitFullscreenEnabled: false,
        documentElement: {},
      }),
    ).toBe(false);
  });
});

describe("isFullscreen", () => {
  it("reads the standard fullscreenElement", () => {
    const { doc } = mockDoc({ fullscreenElement: {} });
    expect(isFullscreen(doc)).toBe(true);
  });

  it("reads the webkit fullscreenElement", () => {
    const { doc } = mockDoc({ webkitFullscreenElement: {} });
    expect(isFullscreen(doc)).toBe(true);
  });

  it("is false when neither is set (windowed)", () => {
    const { doc } = mockDoc();
    expect(isFullscreen(doc)).toBe(false);
  });
});

describe("toggleFullscreen", () => {
  it("windowed → requests fullscreen on the document element", () => {
    const { doc, calls } = mockDoc();
    toggleFullscreen(doc);
    expect(calls).toEqual(["request"]);
  });

  it("windowed, webkit-only → falls back to webkitRequestFullscreen", () => {
    const calls: string[] = [];
    toggleFullscreen({
      webkitFullscreenEnabled: true,
      documentElement: {
        webkitRequestFullscreen: () => calls.push("webkitRequest"),
      },
    });
    expect(calls).toEqual(["webkitRequest"]);
  });

  it("fullscreen → exits via the standard API", () => {
    const { doc, calls } = mockDoc({ fullscreenElement: {} });
    toggleFullscreen(doc);
    expect(calls).toEqual(["exit"]);
  });

  it("fullscreen, webkit-only → exits via webkitExitFullscreen", () => {
    const { doc, calls } = mockDoc({
      webkitFullscreenElement: {},
      exitFullscreen: undefined,
    });
    toggleFullscreen(doc);
    expect(calls).toEqual(["webkitExit"]);
  });

  it("unsupported document → touches nothing (F is a no-op on iPhone)", () => {
    const { doc, calls } = mockDoc({ fullscreenEnabled: undefined });
    toggleFullscreen(doc);
    expect(calls).toEqual([]);
  });
});

describe("watchFullscreen", () => {
  /** Doc that also records change listeners so the test can fire them. */
  function watchableDoc() {
    const listeners = new Map<string, () => void>();
    const { doc } = mockDoc();
    doc.addEventListener = (type: string, cb: () => void) =>
      listeners.set(type, cb);
    return { doc, listeners };
  }

  it("reports the state on every fullscreenchange (Esc-exit included)", () => {
    const { doc, listeners } = watchableDoc();
    const seen: boolean[] = [];
    watchFullscreen((on) => seen.push(on), doc);
    doc.fullscreenElement = {};
    listeners.get("fullscreenchange")?.();
    doc.fullscreenElement = undefined; // browser-owned Esc exit
    listeners.get("fullscreenchange")?.();
    expect(seen).toEqual([true, false]);
  });

  it("hears the webkit-prefixed change event too", () => {
    const { doc, listeners } = watchableDoc();
    const seen: boolean[] = [];
    watchFullscreen((on) => seen.push(on), doc);
    doc.webkitFullscreenElement = {};
    listeners.get("webkitfullscreenchange")?.();
    expect(seen).toEqual([true]);
  });
});
