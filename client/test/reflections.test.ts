import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { EMISSIVE_WINDOW, WORLD_SIZE } from "@angels-bandits/common/constants";
import { describe, expect, it } from "vitest";
import {
  BOUNCE_LUMINANCE_CAP,
  BUILDING_SHADER_SOURCE,
  GRAZING_REFLECTANCE,
} from "../src/render/buildings-material";
import { QUALITY_PROFILES } from "../src/render/quality";
import {
  ProbeSchedule,
  QA_REFILL_STEP,
  REFILL_FACES_PER_FRAME,
  REFILL_JUMP,
  REFLECTION_PARS_GLSL,
  REFL_F0,
  REFL_LUMA_CAP,
  REFL_MOON_ALLOWANCE,
  capReflection,
  glassFresnel,
} from "../src/render/reflections";
import { readRenderOptions } from "../src/render/renderopts";
import { roofLightGlsl } from "../src/render/window-pattern";

const BLOOM_THRESHOLD = 0.72;
const at = (x: number, z: number, y = 80) => ({ x, y, z });

/** A schedule already past its first (spread) fill, at `share`. */
function running(share: number): ProbeSchedule {
  const s = new ProbeSchedule();
  s.setShare(share);
  while (s.refills === 0) s.frame();
  return s;
}

describe("S6 probe schedule — amortised", () => {
  it("never draws more than one face per frame once filled", () => {
    for (const share of [1, 0.5, 0.34]) {
      const s = running(share);
      for (let f = 0; f < 600; f++) {
        expect(s.frame().faces.length).toBeLessThanOrEqual(1);
      }
    }
  });

  it("refreshes every face within ceil(6 / share) frames", () => {
    for (const share of [1, 0.5, 0.34]) {
      const s = running(share);
      const last = new Array(6).fill(0);
      const bound = Math.ceil(6 / share);
      for (let f = 1; f <= 600; f++) {
        for (const face of s.frame().faces) last[face] = f;
        if (f > bound) {
          for (const l of last) expect(f - l).toBeLessThanOrEqual(bound);
        }
      }
    }
  });

  it("renders nothing when the tier is off (Mobile)", () => {
    expect(QUALITY_PROFILES.mobile.reflections).toBe(0);
    const s = new ProbeSchedule();
    s.setShare(QUALITY_PROFILES.mobile.reflections);
    s.requestRefill(true);
    for (let f = 0; f < 60; f++) expect(s.frame().faces).toHaveLength(0);
  });
});

describe("S6 probe schedule — three cubes, crossfaded", () => {
  it("never draws into a cube the shader is reading", () => {
    const s = running(1);
    for (let f = 0; f < 200; f++) {
      if (f === 50) s.requestRefill(false);
      if (f === 120) s.requestRefill(true);
      const prev = s.prev;
      const cur = s.cur;
      const plan = s.frame();
      // What was drawn was never on screen while it was drawn...
      if (plan.faces.length > 0) expect([prev, cur]).not.toContain(plan.target);
      // ...and the next back is free again, rotation or snap alike.
      expect([s.prev, s.cur]).not.toContain(s.back);
    }
  });

  it("crossfades monotonically and rotates onto the image it showed", () => {
    const s = running(1);
    let shown = { prev: s.prev, cur: s.cur, blend: s.blend };
    for (let f = 0; f < 60; f++) {
      s.frame();
      if (s.blend === 0) {
        // A rotation: the new prev is the cube that was fully shown.
        expect(shown.blend).toBe(1);
        expect(s.prev).toBe(shown.cur);
      } else if (shown.prev !== shown.cur) {
        // (Right after a snap prev === cur: any blend is the same image.)
        expect(s.blend).toBeGreaterThanOrEqual(shown.blend);
        expect(s.blend).toBeLessThanOrEqual(1);
      }
      shown = { prev: s.prev, cur: s.cur, blend: s.blend };
    }
    expect(s.rotations).toBeGreaterThan(5);
  });
});

describe("S6 probe schedule — refills", () => {
  it("spreads an organic refill over two frames, then snaps", () => {
    const s = running(1);
    s.requestRefill(false);
    const a = s.frame();
    expect(a.faces).toEqual([0, 1, 2].slice(0, REFILL_FACES_PER_FRAME));
    const target = a.target;
    const b = s.frame();
    expect(b.faces).toEqual([3, 4, 5]);
    expect(s.prev).toBe(target);
    expect(s.cur).toBe(target);
    expect(s.blend).toBe(1);
    expect(s.back).not.toBe(target);
  });

  it("draws a sync (QA) refill in one frame", () => {
    const s = running(1);
    s.requestRefill(true);
    expect(s.frame().faces).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("refills on a camera jump, but not on a seam crossing", () => {
    const s = running(1);
    const before = s.refills;
    s.observe(at(WORLD_SIZE - 1, 500));
    s.observe(at(1, 500)); // across the seam: 2 m on the torus
    s.frame();
    s.frame();
    expect(s.refills).toBe(before);
    s.observe(at(1 + REFILL_JUMP + 10, 500));
    s.frame();
    s.frame();
    expect(s.refills).toBe(before + 1);
  });

  it("refills on a QA eye CHANGE only — never on the call alone", () => {
    const s = running(1);
    const base = s.refills;
    const eye = at(300, 900, 175);
    s.observeQaEye(eye);
    s.frame();
    expect(s.refills).toBe(base + 1);
    // The flicker harness's frozen / still arms: the same eye every frame.
    for (let f = 0; f < 10; f++) {
      s.observeQaEye({ ...eye });
      s.frame();
    }
    // Its pan arm: 1.5 m a frame.
    for (let f = 0; f < 20; f++) {
      s.observeQaEye(at(300 + 1.5 * f, 900, 175));
      s.frame();
    }
    expect(s.refills).toBe(base + 1);
    // A different view.
    s.observeQaEye(at(300 + 30 + QA_REFILL_STEP, 900, 175));
    expect(s.frame().faces).toHaveLength(6);
    expect(s.refills).toBe(base + 2);
  });

  it("refills when the tier switches the probe back on", () => {
    const s = running(1);
    const base = s.refills;
    s.setShare(0);
    s.frame();
    s.setShare(0.5);
    s.frame();
    s.frame();
    expect(s.refills).toBe(base + 1);
  });
});

describe("S6 reflections never become a ladder rung", () => {
  it("caps the sample and spans F0 → the glass's grazing cap", () => {
    expect(capReflection(10)).toBe(REFL_LUMA_CAP);
    expect(capReflection(0.1)).toBe(0.1);
    expect(glassFresnel(1, GRAZING_REFLECTANCE.glass)).toBeCloseTo(REFL_F0);
    expect(glassFresnel(0, GRAZING_REFLECTANCE.glass)).toBeCloseTo(
      GRAZING_REFLECTANCE.glass,
    );
  });

  it("keeps the summed glass pixel under the bloom threshold", () => {
    // The worst glass pixel: a capped reflection at full grazing Fresnel, the
    // street bounce at its cap, the moon on the glass. The unlit-pane sheen
    // and the wet sheen are REPLACED on a reflecting pane, never stacked.
    const reflection =
      glassFresnel(0, GRAZING_REFLECTANCE.glass) *
      capReflection(Number.POSITIVE_INFINITY);
    const sum = reflection + BOUNCE_LUMINANCE_CAP + REFL_MOON_ALLOWANCE;
    expect(sum).toBeLessThan(BLOOM_THRESHOLD);
    expect(sum).toBeLessThan(EMISSIVE_WINDOW);
  });
});

describe("S6 shader seams", () => {
  it("mirrors only intact, unlit GLASS panes, behind the tier switch", () => {
    const em = BUILDING_SHADER_SOURCE.fragmentEmissive;
    expect(em).toContain("if (uReflOn > 0.5 && vArch < 0.5)");
    expect(em).toContain(
      "pane * (1.0 - lit) * facade * (1.0 - shopBand * glass * shopLit)",
    );
    expect(em).toContain("abRefl(reflect(viewRay, vObjNormal)");
    // Before the convex replacements, which must still win over it.
    expect(em.indexOf("abRefl(")).toBeLessThan(em.indexOf(roofLightGlsl()));
    expect(BUILDING_SHADER_SOURCE.fragmentPars).toContain(REFLECTION_PARS_GLSL);
    expect(REFLECTION_PARS_GLSL).toContain("textureLod(uReflPrev");
    expect(REFLECTION_PARS_GLSL).toContain("textureLod(uReflCur");
  });

  it("gives every reflecting material a new program cache key", () => {
    const src = (f: string) =>
      readFileSync(resolve(__dirname, "../src/render", f), "utf8");
    expect(src("buildings-material.ts")).toMatch(/d2-broken-s6-refl"/);
    expect(src("sky.ts")).toContain('"ab-ground-paint-g1-s6-refl"');
    expect(src("river.ts")).toContain('"ab-river-water-s6-refl"');
  });

  it("?refl=0 turns the probe off; it ships on", () => {
    expect(readRenderOptions("", 2).reflections).toBe(true);
    expect(readRenderOptions("?refl=0", 2).reflections).toBe(false);
  });
});
