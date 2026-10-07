// O1: the procedural patterns are FILTERED, not point-sampled.
//
// A hard step() on a repeating term (a window grid, a stripe, a joint) is a
// point sample: once a pixel spans the period the result flips frame to
// frame and the city sparkles. There is no GPU here, so this asserts on the
// shader sources: every repeating pattern goes through the fwidth-based
// helpers, and fwidth() itself is only ever taken at the top level of the
// main body (derivatives are undefined in non-uniform control flow).

import { describe, expect, it } from "vitest";
import { AB_AA_GLSL } from "../src/render/aa-glsl";
import { BUILDING_SHADER_SOURCE } from "../src/render/buildings-material";
import { GROUND_SHADER_SOURCE } from "../src/render/sky";

/** Brace depth at every `fwidth(` in a main-body snippet. */
function fwidthDepths(src: string): number[] {
  const depths: number[] = [];
  let depth = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (src.startsWith("fwidth(", i)) depths.push(depth);
  }
  return depths;
}

/** Any step() whose argument list reads a repeating term directly. A mod()
 * inside an abHash() key (L3's time slots) is a per-cell random, not a
 * periodic pattern, and is excluded. */
const BARE_PERIODIC_STEP = /step\((?![^;]*abHash)[^;]*\b(fract|mod)\(/;

/** The line declaring `name` (up to its semicolon). */
const declaration = (src: string, name: string): string => {
  const at = src.indexOf(`float ${name} =`);
  expect(at, `${name} is declared`).toBeGreaterThanOrEqual(0);
  return src.slice(at, src.indexOf(";", at));
};

describe("the shared AA helpers", () => {
  it("are compiled into both the buildings and the ground", () => {
    for (const fn of ["abLine(", "abDetail(", "abEdge(", "abPeriodic("]) {
      expect(AB_AA_GLSL).toContain(`float ${fn}`);
    }
    expect(BUILDING_SHADER_SOURCE.fragmentPars).toContain(AB_AA_GLSL);
    expect(GROUND_SHADER_SOURCE.fragmentPars).toContain(AB_AA_GLSL);
  });
});

describe("window grid (buildings)", () => {
  const color = BUILDING_SHADER_SOURCE.fragmentColor;
  const emissive = BUILDING_SHADER_SOURCE.fragmentEmissive;

  it("takes its derivatives at the top level only", () => {
    const depths = fwidthDepths(color);
    expect(depths.length).toBeGreaterThan(0);
    for (const d of depths) expect(d).toBe(0);
    expect(color).toContain("fwidth(vMeters)");
  });

  it("filters the pane and the masonry surround — no hard step on the cell", () => {
    expect(declaration(color, "pane")).toContain("winDetail");
    expect(declaration(color, "surround")).not.toMatch(/\bstep\(/);
    expect(color).not.toMatch(/step\(paneLo/);
  });

  it("resolves the lit decision to its expected share once sub-pixel", () => {
    // The fade is the LAST word on `lit` in the grid block: after the coin
    // flip, the L3 crossfade and the L12 occupancy switch.
    const fade = color.indexOf("lit = mix(pLitAA");
    expect(fade).toBeGreaterThan(color.indexOf("float lit ="));
    expect(fade).toBeGreaterThan(color.indexOf("uOccupancy"));
    expect(color.slice(fade, color.indexOf(";", fade))).toContain("winDetail");
    expect(declaration(color, "pLitAA")).toContain("floorDetail");
  });

  it("fades the per-window colour and interior to their means", () => {
    expect(emissive).toMatch(/mixT = mix\(mixMean, mixT, winDetail\)/);
    expect(emissive).toMatch(
      /litWindow = mix\(litMeanCol, litWindow, winDetail\)/,
    );
  });

  it("has no bare step() on a fract()/mod() grid term", () => {
    for (const line of color.split("\n")) {
      expect(line).not.toMatch(BARE_PERIODIC_STEP);
    }
  });
});

describe("ground markings", () => {
  const main = GROUND_SHADER_SOURCE.fragmentMain;
  const pars = GROUND_SHADER_SOURCE.fragmentPars;

  it("takes its derivatives once, at the top level, before any branch", () => {
    const depths = fwidthDepths(main);
    expect(depths).toEqual([0]);
    expect(main.indexOf("fwidth(vWorldXZ)")).toBeLessThan(main.indexOf("if ("));
  });

  it("draws every marking through the AA helpers", () => {
    expect(declaration(main, "abStripe")).toContain("abLine(");
    expect(declaration(main, "abZebra")).toContain("abEdge(");
    expect(declaration(main, "abDash")).toContain("abLine(");
    expect(declaration(main, "abDashOn")).toContain("abDetail(");
    expect(declaration(main, "abEdgeLine")).toContain("abLine(");
    expect(declaration(main, "abWear")).toContain("abDetail(");
    expect(declaration(main, "abJoint")).toContain("abLine(");
    expect(declaration(main, "abCurb")).toContain("abEdge(");
    expect(declaration(pars, "stripe")).toContain("abDetail(");
    expect(declaration(pars, "jx")).toContain("abLine(");
  });

  it("has no bare step() on a fract()/mod() pattern term", () => {
    for (const line of `${pars}\n${main}`.split("\n")) {
      expect(line).not.toMatch(BARE_PERIODIC_STEP);
    }
  });
});
