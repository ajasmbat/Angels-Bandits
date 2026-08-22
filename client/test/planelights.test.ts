// Aviation-light math (ticket ANGE-L7F2OS): the anti-collision strobe is a
// pure function of (plane id, synced server time) — every client computes the
// same on/off state for the same instant, with per-id phases so no two
// planes flash together. Expected values below come from the published
// pattern spec: a double flash (two STROBE_FLASH_MS pulses, the second
// starting 180 ms after the first) every STROBE_PERIOD_MS.

import { describe, expect, it } from "vitest";
import {
  LIGHT_MOUNTS,
  STROBE_FLASH_MS,
  STROBE_PERIOD_MS,
  strobeOn,
  strobePhaseMs,
} from "../src/render/planelights";

describe("strobe phase determinism", () => {
  it("same plane id + same synced time → same on/off state (independent computations agree)", () => {
    // Two "clients" evaluating the same wall of instants must agree exactly.
    for (let t = 0; t < STROBE_PERIOD_MS * 3; t += 37) {
      expect(strobeOn("player-abc", t)).toBe(strobeOn("player-abc", t));
    }
    expect(strobePhaseMs("player-abc")).toBe(strobePhaseMs("player-abc"));
  });

  it("follows the double-flash pattern relative to the plane's phase", () => {
    const id = "bot:3";
    const p = strobePhaseMs(id);
    // First pulse: on just after phase start, off after STROBE_FLASH_MS.
    expect(strobeOn(id, p + 10)).toBe(true);
    expect(strobeOn(id, p + STROBE_FLASH_MS + 20)).toBe(false);
    // Second pulse starts 180 ms in.
    expect(strobeOn(id, p + 180 + 10)).toBe(true);
    expect(strobeOn(id, p + 180 + STROBE_FLASH_MS + 20)).toBe(false);
    // Dark for the rest of the period, and periodic.
    expect(strobeOn(id, p + STROBE_PERIOD_MS / 2)).toBe(false);
    expect(strobeOn(id, p + STROBE_PERIOD_MS + 10)).toBe(true);
  });

  it("gives distinct ids distinct phases inside [0, STROBE_PERIOD_MS)", () => {
    const ids = ["bot:1", "bot:2", "player-x9", "player-y7"];
    const phases = ids.map(strobePhaseMs);
    for (const p of phases) {
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThan(STROBE_PERIOD_MS);
    }
    expect(new Set(phases).size).toBe(ids.length);
  });
});

describe("light mounts (game-local: forward −Z, right +X)", () => {
  it("puts green on the RIGHT wingtip and red on the LEFT, mirrored", () => {
    expect(LIGHT_MOUNTS.navR.x).toBeGreaterThan(0);
    expect(LIGHT_MOUNTS.navL.x).toBeLessThan(0);
    expect(LIGHT_MOUNTS.navL.x).toBeCloseTo(-LIGHT_MOUNTS.navR.x, 6);
    expect(LIGHT_MOUNTS.navL.y).toBe(LIGHT_MOUNTS.navR.y);
    expect(LIGHT_MOUNTS.navL.z).toBe(LIGHT_MOUNTS.navR.z);
  });

  it("puts the white tail light aft (+Z) and the exhaust at the nose (−Z), both on centerline", () => {
    expect(LIGHT_MOUNTS.tail.z).toBeGreaterThan(0);
    expect(LIGHT_MOUNTS.tail.x).toBe(0);
    expect(LIGHT_MOUNTS.exhaust.z).toBeLessThan(0);
    expect(LIGHT_MOUNTS.strobe.x).toBe(0);
  });
});
