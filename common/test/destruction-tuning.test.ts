// DL1: the Destruction Lab's tuning object — every default is the constant
// it mirrors, every spec row is sane, and what leaves the lab (Copy
// settings, a share link, a stamped wire) comes back exactly, clamped.

import {
  CHAIN_BLAST_DAMAGE,
  COLLAPSE_GRAVITY,
  COLLAPSE_SLAB_STOREY,
} from "@angels-bandits/common/constants";
import {
  BUILD_KEYS,
  DEFAULT_DESTRUCTION_TUNING,
  DESTRUCTION_GROUPS,
  DESTRUCTION_PRESETS,
  DESTRUCTION_SPEC,
  DESTRUCTION_TUNING_VERSION,
  type DestructionTuning,
  buildStamp,
  decodeDestructionShare,
  destructionDiff,
  destructionSpec,
  encodeDestructionShare,
  exportDestructionTuning,
  importDestructionTuning,
  presetDestructionTuning,
  sanitizeDestructionTuning,
  tuningFromStamp,
} from "@angels-bandits/common/destruction-tuning";
import { describe, expect, it } from "vitest";

const keys = Object.keys(
  DEFAULT_DESTRUCTION_TUNING,
) as (keyof DestructionTuning)[];

describe("DL1 DestructionTuning: the spec", () => {
  it("has one spec row per field, in a known group, its default in range", () => {
    expect(DESTRUCTION_SPEC.map((s) => s.key).sort()).toEqual([...keys].sort());
    for (const s of DESTRUCTION_SPEC) {
      expect(DESTRUCTION_GROUPS).toContain(s.group);
      const d = DEFAULT_DESTRUCTION_TUNING[s.key];
      expect(d, s.key).toBeGreaterThanOrEqual(s.min);
      expect(d, s.key).toBeLessThanOrEqual(s.max);
      expect(s.hint.length, s.key).toBeGreaterThan(10);
      expect(s.step).toBeGreaterThan(0);
    }
  });

  it("every group has sliders, and the defaults are today's constants", () => {
    for (const g of DESTRUCTION_GROUPS) {
      expect(
        DESTRUCTION_SPEC.some((s) => s.group === g),
        g,
      ).toBe(true);
    }
    expect(DEFAULT_DESTRUCTION_TUNING.gravity).toBe(COLLAPSE_GRAVITY);
    expect(DEFAULT_DESTRUCTION_TUNING.slabStorey).toBe(COLLAPSE_SLAB_STOREY);
    expect(DEFAULT_DESTRUCTION_TUNING.chainBlastDamage).toBe(
      CHAIN_BLAST_DAMAGE,
    );
    expect(Object.isFrozen(DEFAULT_DESTRUCTION_TUNING)).toBe(true);
  });

  it("BUILD keys are exactly the build-scoped rows", () => {
    expect(BUILD_KEYS).toEqual(
      DESTRUCTION_SPEC.filter((s) => s.scope === "build").map((s) => s.key),
    );
    expect(BUILD_KEYS).toContain("gravity");
    expect(BUILD_KEYS).not.toContain("dustOpacity");
    expect(BUILD_KEYS).not.toContain("chainBlastDamage");
  });
});

describe("DL1 DestructionTuning: export, import and clamping", () => {
  const tuned = sanitizeDestructionTuning({
    gravity: 14.2,
    sheetShare: 0.8,
    dustCoverageMax: 0.5,
    chainDepthMax: 5,
    toppleBreak: 1.1,
  });

  it("round-trips through Copy settings and the share link, exactly", () => {
    const text = exportDestructionTuning(tuned);
    const back = importDestructionTuning(text);
    expect(back.ok && back.tuning).toEqual(tuned);
    const shared = decodeDestructionShare(encodeDestructionShare(tuned));
    expect(shared.ok && shared.tuning).toEqual(tuned);
  });

  it("exports only what differs from the default, versioned", () => {
    const o = JSON.parse(exportDestructionTuning(tuned));
    expect(o.v).toBe(DESTRUCTION_TUNING_VERSION);
    expect(Object.keys(o.d).sort()).toEqual(
      [
        "chainDepthMax",
        "dustCoverageMax",
        "gravity",
        "sheetShare",
        "toppleBreak",
      ].sort(),
    );
    expect(
      JSON.parse(exportDestructionTuning(DEFAULT_DESTRUCTION_TUNING)).d,
    ).toEqual({});
  });

  it("clamps out-of-range values, rounds whole-number fields, drops junk", () => {
    const t = sanitizeDestructionTuning({
      gravity: 1e6,
      slabStorey: -3,
      chainImpactsMax: 7.6,
      dustOpacity: Number.NaN,
      sparkAmount: "lots",
      notAField: 1,
    });
    expect(t.gravity).toBe(destructionSpec("gravity").max);
    expect(t.slabStorey).toBe(destructionSpec("slabStorey").min);
    expect(t.chainImpactsMax).toBe(8);
    expect(t.dustOpacity).toBe(DEFAULT_DESTRUCTION_TUNING.dustOpacity);
    expect(t.sparkAmount).toBe(DEFAULT_DESTRUCTION_TUNING.sparkAmount);
    expect("notAField" in t).toBe(false);
  });

  it("keeps the cross-field rules", () => {
    const t = sanitizeDestructionTuning({
      chainEnergyMin: 1.4,
      chainEnergyMax: 0.6,
      toppleBreak: 0.5,
      toppleBreakTop: 1.2,
    });
    expect(t.chainEnergyMax).toBeGreaterThanOrEqual(t.chainEnergyMin);
    expect(t.toppleBreakTop).toBeLessThanOrEqual(t.toppleBreak);
  });

  it("refuses what is not an export, or a newer one", () => {
    expect(importDestructionTuning("nope").ok).toBe(false);
    expect(importDestructionTuning('{"d":{}}').ok).toBe(false);
    expect(
      importDestructionTuning(
        JSON.stringify({ v: DESTRUCTION_TUNING_VERSION + 1, d: {} }),
      ).ok,
    ).toBe(false);
    expect(importDestructionTuning('{"v":1,"d":[]}').ok).toBe(false);
    expect(decodeDestructionShare("%%%").ok).toBe(false);
  });

  it("every preset is valid and the default preset is the defaults", () => {
    const ids = DESTRUCTION_PRESETS.map((p) => p.id);
    expect(ids).toEqual(["default", "cinematic", "realistic", "performance"]);
    for (const p of DESTRUCTION_PRESETS) {
      const t = presetDestructionTuning(p);
      expect(destructionDiff(t), p.id).toEqual(p.values);
    }
    // The phone preset trims only the dressing: nothing that collides.
    const perf = DESTRUCTION_PRESETS.find((p) => p.id === "performance");
    for (const k of Object.keys(perf?.values ?? {})) {
      expect(destructionSpec(k as keyof DestructionTuning).scope).toBe("look");
    }
  });

  it("a wire stamp carries only the build fields and comes back clamped", () => {
    expect(buildStamp(DEFAULT_DESTRUCTION_TUNING)).toBeUndefined();
    const stamp = buildStamp(tuned);
    expect(stamp).toEqual({ gravity: 14.2, sheetShare: 0.8, toppleBreak: 1.1 });
    const back = tuningFromStamp(stamp);
    expect(back.gravity).toBe(14.2);
    // Look and server fields never ride a wire.
    expect(back.dustCoverageMax).toBe(
      DEFAULT_DESTRUCTION_TUNING.dustCoverageMax,
    );
    expect(tuningFromStamp({ gravity: 999, dustOpacity: 0.1 })).toEqual({
      ...DEFAULT_DESTRUCTION_TUNING,
      gravity: destructionSpec("gravity").max,
    });
    expect(tuningFromStamp(undefined)).toBe(DEFAULT_DESTRUCTION_TUNING);
  });
});
