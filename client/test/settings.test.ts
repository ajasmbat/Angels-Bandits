// M6 settings (client/src/ui/settings.ts): F9's FLIGHT ASSIST and FEEL
// persist under `ab-settings`, and a v1 blob saved before they existed
// keeps every value it has — adding them was not a change of shape.

import { describe, expect, it } from "vitest";
import { FEELS } from "../src/game/effortless";
import {
  DEFAULT_SETTINGS,
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
    });
  });

  it("junk falls back to the defaults", () => {
    expect(clampSettings({ assist: "yes", feel: "turbo" })).toMatchObject({
      assist: true,
      feel: "normal",
    });
  });
});
