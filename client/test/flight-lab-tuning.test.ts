// FL1 Flight Lab: the tuning's export / import — what "Copy settings" puts
// on the clipboard, what a pasted blob or a `?lab=` share link restores, and
// what a lab room accepts off the wire. A round trip must be lossless and
// idempotent; a bad or out-of-range value must be clamped (never NaN, never
// past a range); an unknown or newer version must be refused, not guessed
// at. And the Relaxed / Normal / Sharp presets, run through the converter
// main.ts flies the lab with, must be exactly the game's own F9 feels.

import {
  DEFAULT_TUNING,
  type FlightTuning,
  TUNING_PRESETS,
  TUNING_SPEC,
  TUNING_VERSION,
  decodeShare,
  encodeShare,
  exportTuning,
  feelFromTuning,
  importTuning,
  importTuningObject,
  presetTuning,
  sanitizeTuning,
  tuningSpec,
} from "@angels-bandits/common/tuning";
import { describe, expect, it } from "vitest";
import { FEEL_TUNING } from "../src/game/effortless";

const preset = (id: string) => {
  const p = TUNING_PRESETS.find((x) => x.id === id);
  if (!p) throw new Error(`no preset ${id}`);
  return presetTuning(p);
};

/** import(text) that must succeed. */
const imported = (text: string): FlightTuning => {
  const r = importTuning(text);
  if (!r.ok) throw new Error(r.error);
  return r.tuning;
};

describe("FL1 tuning export", () => {
  it("exports only what differs from the default, with a version", () => {
    expect(exportTuning(DEFAULT_TUNING)).toBe(
      JSON.stringify({ v: TUNING_VERSION, t: {} }),
    );
    const t = { ...DEFAULT_TUNING, maxSpeed: 120, invertY: 1 };
    expect(JSON.parse(exportTuning(t))).toEqual({
      v: TUNING_VERSION,
      t: { maxSpeed: 120, invertY: 1 },
    });
  });

  it("round-trips every preset losslessly and idempotently", () => {
    for (const p of TUNING_PRESETS) {
      const t = presetTuning(p);
      const text = exportTuning(t);
      const back = imported(text);
      expect(back).toEqual(t);
      expect(exportTuning(back)).toBe(text);
    }
  });

  it("round-trips a tuning with every field moved", () => {
    const t = { ...DEFAULT_TUNING };
    for (const s of TUNING_SPEC) {
      t[s.key] = s.toggle
        ? 1 - DEFAULT_TUNING[s.key]
        : s.min + (s.max - s.min) * 0.37;
    }
    const fixed = sanitizeTuning(t); // the cross-field rules may lift speeds
    expect(imported(exportTuning(fixed))).toEqual(fixed);
  });

  it("round-trips through a share link", () => {
    const t = preset("realistic-biplane");
    const code = encodeShare(t);
    expect(code).toMatch(/^[A-Za-z0-9_-]+$/); // URL-safe, no padding
    const r = decodeShare(code);
    expect(r.ok && r.tuning).toEqual(t);
    expect(decodeShare("%%%not-base64").ok).toBe(false);
    expect(decodeShare(encodeShare(DEFAULT_TUNING)).ok).toBe(true);
  });
});

describe("FL1 tuning import: versions", () => {
  it("refuses a missing, malformed or newer version", () => {
    const t = { maxSpeed: 100 };
    for (const v of [undefined, "1", 0, -1, 1.5, Number.NaN]) {
      expect(importTuningObject({ v, t }).ok).toBe(false);
    }
    const newer = importTuningObject({ v: TUNING_VERSION + 1, t });
    expect(newer.ok).toBe(false);
    if (!newer.ok) expect(newer.error).toMatch(/newer/);
    expect(importTuningObject({ v: TUNING_VERSION, t }).ok).toBe(true);
  });

  it("refuses what is not an export at all", () => {
    for (const text of [
      "",
      "nope",
      "[]",
      "null",
      "42",
      '{"v":1}',
      '{"v":1,"t":[1]}',
    ]) {
      expect(importTuning(text).ok).toBe(false);
    }
  });
});

describe("FL1 tuning import: clamping", () => {
  const load = (t: Record<string, unknown>) =>
    imported(JSON.stringify({ v: TUNING_VERSION, t }));

  it("clamps out-of-range values into each field's range", () => {
    const t = load({ maxSpeed: 9999, minSpeed: -5, rollRate: 1e9, expo: -3 });
    expect(t.maxSpeed).toBe(tuningSpec("maxSpeed").max);
    expect(t.minSpeed).toBe(tuningSpec("minSpeed").min);
    expect(t.rollRate).toBe(tuningSpec("rollRate").max);
    expect(t.expo).toBe(tuningSpec("expo").min);
  });

  it("drops non-numbers, non-finite values and unknown keys", () => {
    const t = load({
      turnRate: "fast",
      pitchRate: null,
      bankFreq: Number.NaN,
      speedResponse: Number.POSITIVE_INFINITY,
      warpDrive: 9,
      __proto__: { maxSpeed: 1 },
    });
    expect(t).toEqual(DEFAULT_TUNING);
    expect(Object.keys(t).sort()).toEqual(Object.keys(DEFAULT_TUNING).sort());
    // JSON can't carry NaN/Infinity, but a wire object can.
    const wire = sanitizeTuning({
      bankFreq: Number.NaN,
      chaseBase: Number.NEGATIVE_INFINITY,
    });
    expect(wire.bankFreq).toBe(DEFAULT_TUNING.bankFreq);
    expect(wire.chaseBase).toBe(DEFAULT_TUNING.chaseBase);
  });

  it("snaps toggles to 0 / 1", () => {
    expect(load({ assist: 0.2, invertY: 0.9, autoSlow: 7 })).toMatchObject({
      assist: 0,
      invertY: 1,
      autoSlow: 1,
    });
  });

  it("keeps top speed over slowest, and boost over top speed", () => {
    const t = load({ minSpeed: 80, maxSpeed: 40, boostMaxSpeed: 50 });
    expect(t.minSpeed).toBe(80);
    expect(t.maxSpeed).toBeGreaterThanOrEqual(t.minSpeed + 5);
    expect(t.boostMaxSpeed).toBeGreaterThanOrEqual(t.maxSpeed + 5);
    for (const v of Object.values(t)) expect(Number.isFinite(v)).toBe(true);
  });
});

describe("FL1 tuning spec and presets", () => {
  it("has one spec row per field, every default inside its range", () => {
    expect(TUNING_SPEC.map((s) => s.key).sort()).toEqual(
      Object.keys(DEFAULT_TUNING).sort(),
    );
    for (const s of TUNING_SPEC) {
      const d = DEFAULT_TUNING[s.key];
      expect(d, s.key).toBeGreaterThanOrEqual(s.min);
      expect(d, s.key).toBeLessThanOrEqual(s.max);
    }
    expect(Object.isFrozen(DEFAULT_TUNING)).toBe(true);
    expect(sanitizeTuning({})).toEqual(DEFAULT_TUNING);
  });

  it("keeps every preset value inside the spec (sanitizing changes nothing)", () => {
    for (const p of TUNING_PRESETS) {
      const t = presetTuning(p);
      for (const [k, v] of Object.entries(p.values)) {
        expect(t[k as keyof FlightTuning], `${p.id}.${k}`).toBe(v);
      }
    }
    expect(preset("default")).toEqual(DEFAULT_TUNING);
  });

  it("Relaxed / Normal / Sharp fly exactly the game's F9 feels", () => {
    expect(feelFromTuning(preset("relaxed"))).toStrictEqual(
      FEEL_TUNING.relaxed,
    );
    expect(feelFromTuning(preset("normal"))).toStrictEqual(FEEL_TUNING.normal);
    expect(feelFromTuning(preset("sharp"))).toStrictEqual(FEEL_TUNING.sharp);
    // The shipped default is the Normal feel.
    expect(feelFromTuning(DEFAULT_TUNING)).toStrictEqual(FEEL_TUNING.normal);
  });
});
