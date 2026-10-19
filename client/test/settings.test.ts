// M6 settings (client/src/ui/settings.ts): F9's FLIGHT ASSIST and FEEL
// persist under `ab-settings`, and a v1 blob saved before they existed
// keeps every value it has — adding them was not a change of shape.

import { describe, expect, it } from "vitest";
import { FEELS } from "../src/game/effortless";
import {
  DEFAULT_SETTINGS,
  MOUSE_SENS_STEPS,
  SETTINGS_KEY,
  SETTINGS_VERSION,
  type SettingsStore,
  clampSettings,
  loadSettings,
  saveSettings,
} from "../src/ui/settings";

function memoryStore(): SettingsStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => {
      data.set(k, v);
    },
  };
}

describe("F9 settings: assist and feel", () => {
  it("default to assist on, Normal", () => {
    expect(DEFAULT_SETTINGS.assist).toBe(true);
    expect(DEFAULT_SETTINGS.feel).toBe("normal");
    expect(loadSettings(memoryStore())).toMatchObject({
      assist: true,
      feel: "normal",
    });
  });

  it("every preset and the assist switch round-trip through storage", () => {
    for (const feel of FEELS) {
      for (const assist of [true, false]) {
        const store = memoryStore();
        saveSettings(store, { ...DEFAULT_SETTINGS, assist, feel });
        expect(loadSettings(store)).toMatchObject({ assist, feel });
      }
    }
  });

  it("a v1 blob from before F9 keeps its values and gets the defaults", () => {
    const store = memoryStore();
    store.setItem(
      SETTINGS_KEY,
      JSON.stringify({
        v: SETTINGS_VERSION,
        resScale: 0.6,
        master: 0.4,
        engine: 0.3,
        voice: 0.2,
        music: 0.1,
        musicOn: false,
        haptics: false,
        autoFire: true,
      }),
    );
    expect(loadSettings(store)).toEqual({
      resScale: 0.6,
      master: 0.4,
      engine: 0.3,
      voice: 0.2,
      music: 0.1,
      musicOn: false,
      haptics: false,
      autoFire: true,
      assist: true,
      feel: "normal",
      rollLevel: null,
      cameraRoll: "level",
      shake: "full",
      reducedMotion: null,
      carrierCam: true,
      stickSens: 1,
      flightData: false,
      mouseSens: 1,
      invertY: false,
      collisionAssist: true,
    });
  });

  it("junk falls back to the defaults", () => {
    expect(clampSettings({ assist: "yes", feel: "turbo" })).toMatchObject({
      assist: true,
      feel: "normal",
    });
  });
});

describe("FC1 settings: mouse sensitivity, invert Y, collision assist", () => {
  it("default to 1×, not inverted, the collision assist on", () => {
    expect(loadSettings(memoryStore())).toMatchObject({
      mouseSens: 1,
      invertY: false,
      collisionAssist: true,
    });
  });

  it("every value round-trips through storage", () => {
    for (const mouseSens of MOUSE_SENS_STEPS) {
      for (const invertY of [true, false]) {
        for (const collisionAssist of [true, false]) {
          const store = memoryStore();
          saveSettings(store, {
            ...DEFAULT_SETTINGS,
            mouseSens,
            invertY,
            collisionAssist,
          });
          expect(loadSettings(store)).toMatchObject({
            mouseSens,
            invertY,
            collisionAssist,
          });
        }
      }
    }
  });

  it("junk falls back to the defaults (a sensitivity off the steps too)", () => {
    expect(
      clampSettings({ mouseSens: 7, invertY: "yes", collisionAssist: 0 }),
    ).toMatchObject({ mouseSens: 1, invertY: false, collisionAssist: true });
  });

  it("blocked storage: the defaults on read, the write swallowed", () => {
    const blocked: SettingsStore = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    expect(loadSettings(blocked)).toEqual(DEFAULT_SETTINGS);
    expect(() =>
      saveSettings(blocked, { ...DEFAULT_SETTINGS, invertY: true }),
    ).not.toThrow();
  });
});
