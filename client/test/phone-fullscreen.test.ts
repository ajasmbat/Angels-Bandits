// Phone fullscreen (M5): the pure decisions behind the JOIN-tap fullscreen,
// the re-enter pill, the iPhone install sheet and the one-time install chip.
// Expected values come from the ticket: Android/iPad (touch + API) go
// fullscreen on join and get a pill when windowed; iPhone (no API, not
// standalone) gets the sheet exactly once; the home-screen app and desktop
// get nothing; flags survive blocked storage without throwing.

import { describe, expect, it } from "vitest";
import {
  type FlagStore,
  type FullscreenEnv,
  INSTALL_KEY,
  type InstallEnv,
  SHEET_KEY,
  fullscreenPlan,
  installChipPlan,
  isIos,
  readFlag,
  writeFlag,
} from "../src/ui/phone-fullscreen";

/** An Android phone in Chrome, at the join card. */
const android: FullscreenEnv = {
  touch: true,
  ios: false,
  standalone: false,
  fsApi: true,
  fsActive: false,
  joined: false,
  inFlight: false,
  sheetSeen: false,
};

/** An iPhone in Safari: no page Fullscreen API. */
const iphone: FullscreenEnv = { ...android, ios: true, fsApi: false };

describe("fullscreenPlan", () => {
  it("Android touch + API, before join → auto (the JOIN tap requests it)", () => {
    expect(fullscreenPlan(android)).toBe("auto");
  });

  it("joined and windowed (left fullscreen) → pill", () => {
    expect(fullscreenPlan({ ...android, joined: true })).toBe("pill");
  });

  it("already fullscreen → none (no pill, no second request)", () => {
    expect(fullscreenPlan({ ...android, fsActive: true })).toBe("none");
    expect(fullscreenPlan({ ...android, joined: true, fsActive: true })).toBe(
      "none",
    );
  });

  it("a request still in flight → none (the pill never flashes)", () => {
    expect(fullscreenPlan({ ...android, joined: true, inFlight: true })).toBe(
      "none",
    );
  });

  it("desktop → none, even with the API and after joining", () => {
    expect(fullscreenPlan({ ...android, touch: false })).toBe("none");
    expect(fullscreenPlan({ ...android, touch: false, joined: true })).toBe(
      "none",
    );
  });

  it("standalone (home-screen app) → none", () => {
    expect(fullscreenPlan({ ...android, standalone: true })).toBe("none");
    expect(fullscreenPlan({ ...android, standalone: true, joined: true })).toBe(
      "none",
    );
  });

  it("standalone beats no-API: the installed iPhone app never sees the sheet", () => {
    expect(fullscreenPlan({ ...iphone, standalone: true })).toBe("none");
  });

  it("iPhone (no API, not standalone), not yet seen → install sheet", () => {
    expect(fullscreenPlan(iphone)).toBe("ios-install-sheet");
  });

  it("iPhone after the sheet was shown once → none", () => {
    expect(fullscreenPlan({ ...iphone, sheetSeen: true })).toBe("none");
  });

  it("iPhone never gets the pill (nothing to re-enter)", () => {
    expect(fullscreenPlan({ ...iphone, sheetSeen: true, joined: true })).toBe(
      "none",
    );
  });

  it("Android without the API (in-app webview) → none, not Share steps", () => {
    expect(fullscreenPlan({ ...android, fsApi: false })).toBe("none");
  });
});

describe("installChipPlan", () => {
  const ready: InstallEnv = {
    touch: true,
    standalone: false,
    hasPrompt: true,
    firstLifeOver: true,
    offered: false,
  };

  it("offers once the prompt is in hand and the first life is over", () => {
    expect(installChipPlan(ready)).toBe(true);
  });

  it("not before the first life ends", () => {
    expect(installChipPlan({ ...ready, firstLifeOver: false })).toBe(false);
  });

  it("not without a deferred prompt", () => {
    expect(installChipPlan({ ...ready, hasPrompt: false })).toBe(false);
  });

  it("only once", () => {
    expect(installChipPlan({ ...ready, offered: true })).toBe(false);
  });

  it("not on desktop or in the installed app", () => {
    expect(installChipPlan({ ...ready, touch: false })).toBe(false);
    expect(installChipPlan({ ...ready, standalone: true })).toBe(false);
  });
});

describe("isIos", () => {
  it("matches iPhone and iPad user agents", () => {
    expect(
      isIos({
        userAgent:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
      }),
    ).toBe(true);
    expect(
      isIos({ userAgent: "Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X)" }),
    ).toBe(true);
  });

  it("matches iPadOS's desktop UA by its touch points, not a real Mac", () => {
    const mac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)";
    expect(isIos({ userAgent: mac, maxTouchPoints: 5 })).toBe(true);
    expect(isIos({ userAgent: mac, maxTouchPoints: 0 })).toBe(false);
  });

  it("does not match Android", () => {
    expect(
      isIos({
        userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 7) Chrome/120",
        maxTouchPoints: 5,
      }),
    ).toBe(false);
  });
});

describe("one-time flags", () => {
  function memoryStore(): FlagStore & { data: Map<string, string> } {
    const data = new Map<string, string>();
    return {
      data,
      getItem: (k) => data.get(k) ?? null,
      setItem: (k, v) => {
        data.set(k, v);
      },
    };
  }

  it("a dismissed sheet stays dismissed: write then read round-trips", () => {
    const store = memoryStore();
    expect(readFlag(store, SHEET_KEY)).toBe(false);
    writeFlag(store, SHEET_KEY);
    expect(readFlag(store, SHEET_KEY)).toBe(true);
    // ...and the persisted flag turns the sheet off on the next visit.
    expect(
      fullscreenPlan({ ...iphone, sheetSeen: readFlag(store, SHEET_KEY) }),
    ).toBe("none");
  });

  it("keys are independent", () => {
    const store = memoryStore();
    writeFlag(store, SHEET_KEY);
    expect(readFlag(store, INSTALL_KEY)).toBe(false);
  });

  it("blocked storage (getItem/setItem throw) reads unset and never throws", () => {
    const blocked: FlagStore = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    expect(() => writeFlag(blocked, SHEET_KEY)).not.toThrow();
    expect(readFlag(blocked, SHEET_KEY)).toBe(false);
  });

  it("no storage at all reads unset", () => {
    expect(readFlag(undefined, SHEET_KEY)).toBe(false);
    expect(() => writeFlag(undefined, SHEET_KEY)).not.toThrow();
  });
});
