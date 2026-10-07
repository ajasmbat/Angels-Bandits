// V1 (ANGE-6OM7QM): the searchlight wash. With the camera inside a cone the
// beam drew as a flat pale sheet over most of the screen with a hard edge.
// These pin the pure falloff the beam shader is generated from: the alpha of
// every point on a cone changes smoothly as the eye crosses the wall, stays
// faint with the eye on the axis, and is gone at the near plane.

import type { Vec3 } from "@angels-bandits/common/world";
import { describe, expect, it } from "vitest";
import {
  BEAM_FALLOFF_GLSL,
  BEAM_INSIDE_FLOOR,
  BEAM_MIN_RADIUS,
  BEAM_NEAR_IN,
  BEAM_NEAR_OUT,
  BEAM_OPACITY,
  BEAM_RHO_IN,
  BEAM_RHO_OUT,
  beamAlpha,
  beamCameraFade,
  beamCameraRho,
  beamNearFade,
} from "../src/render/searchlights";

const add = (a: Vec3, b: Vec3, k = 1): Vec3 => ({
  x: a.x + b.x * k,
  y: a.y + b.y * k,
  z: a.z + b.z * k,
});
const sub = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.x - b.x,
  y: a.y - b.y,
  z: a.z - b.z,
});
const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
const len = (a: Vec3) => Math.hypot(a.x, a.y, a.z);
const unit = (a: Vec3): Vec3 => add({ x: 0, y: 0, z: 0 }, a, 1 / len(a));
const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});

/** One beam as the renderer places it: lamp, unit direction, throw, and the
 * radius at the tip (the instance scale). */
interface Beam {
  name: string;
  apex: Vec3;
  dir: Vec3;
  length: number;
  radius: number;
}

const BEAMS: Beam[] = [
  // A rooftop arc leaning off vertical, lamp on a 208 m roof.
  {
    name: "rooftop",
    apex: { x: 1057.5, y: 209.5, z: 964 },
    dir: unit({ x: -0.4, y: 1, z: 0.6 }),
    length: 420,
    radius: 34,
  },
  // A street helicopter's spot thrown down and ahead.
  {
    name: "heli spot",
    apex: { x: 400, y: 120, z: 700 },
    dir: unit({ x: 0.3, y: -1, z: -0.2 }),
    length: 140,
    radius: 11,
  },
  // A short spot at the 6 m minimum throw radius.
  {
    name: "short spot",
    apex: { x: 800, y: 45, z: 300 },
    dir: unit({ x: 0, y: -1, z: 0.4 }),
    length: 60,
    radius: 6,
  },
];

/** Two unit vectors perpendicular to `dir` and to each other. */
function basis(dir: Vec3): [Vec3, Vec3] {
  const seed =
    Math.abs(dir.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
  const u = unit(cross(dir, seed));
  return [u, cross(dir, u)];
}

/** Points on the cone's wall: `nt` stations along the throw × `na` around. */
function wall(beam: Beam, nt: number, na: number) {
  const [u, v] = basis(beam.dir);
  const out: { p: Vec3; t: number; normal: Vec3 }[] = [];
  for (let i = 1; i < nt; i++) {
    const t = i / nt;
    for (let j = 0; j < na; j++) {
      const a = (j / na) * Math.PI * 2;
      const normal = add(
        add({ x: 0, y: 0, z: 0 }, u, Math.cos(a)),
        v,
        Math.sin(a),
      );
      const axisPoint = add(beam.apex, beam.dir, beam.length * t);
      out.push({ p: add(axisPoint, normal, beam.radius * t), t, normal });
    }
  }
  return out;
}

/** The alpha the shader gives wall point `w` seen from `eye`. */
function alphaAt(
  beam: Beam,
  w: { p: Vec3; t: number; normal: Vec3 },
  eye: Vec3,
  rho: number,
): number {
  const toEye = sub(eye, w.p);
  const viewDist = len(toEye);
  return beamAlpha({
    t: w.t,
    facing: viewDist > 1e-4 ? Math.abs(dot(w.normal, toEye)) / viewDist : 0,
    viewDist,
    localRadius: beam.radius * w.t,
    rho,
  });
}

/** The eye at fraction `tc` along the beam, `rho` beam radii off the axis. */
function eyeAt(beam: Beam, tc: number, rho: number): Vec3 {
  const [u] = basis(beam.dir);
  const r = Math.max(beam.radius * tc, BEAM_MIN_RADIUS);
  return add(add(beam.apex, beam.dir, beam.length * tc), u, rho * r);
}

describe("beamCameraRho: where the eye sits relative to a beam", () => {
  for (const beam of BEAMS) {
    it(`${beam.name}: 0 on the axis, 1 on the wall, continuous past both ends`, () => {
      const rho = (e: Vec3) =>
        beamCameraRho(e, beam.apex, beam.dir, beam.length, beam.radius);
      expect(rho(eyeAt(beam, 0.5, 0))).toBeCloseTo(0, 9);
      expect(rho(eyeAt(beam, 0.5, 1))).toBeCloseTo(1, 9);
      expect(rho(eyeAt(beam, 0.8, 2.5))).toBeCloseTo(2.5, 9);
      // Behind the lamp it measures from the lamp; past the tip, from the tip.
      expect(rho(add(beam.apex, beam.dir, -10))).toBeCloseTo(
        10 / BEAM_MIN_RADIUS,
        9,
      );
      const tip = add(beam.apex, beam.dir, beam.length);
      expect(rho(add(tip, beam.dir, 5))).toBeCloseTo(5 / beam.radius, 9);
      // A walk along the axis from behind the lamp to past the tip, 1 m off
      // it, never jumps: no step moves rho by more than the step over the
      // smallest radius it can divide by (its steepest honest slope).
      const [u] = basis(beam.dir);
      const step = 0.25;
      let prev = Number.NaN;
      for (let s = -30; s <= beam.length + 30; s += step) {
        const r = rho(add(add(beam.apex, beam.dir, s), u, 1));
        if (!Number.isNaN(prev)) {
          expect(Math.abs(r - prev)).toBeLessThanOrEqual(
            (step / BEAM_MIN_RADIUS) * 1.01,
          );
        }
        prev = r;
      }
    });
  }
});

describe("beamAlpha: the falloff", () => {
  it("matches hand-computed reference values", () => {
    // Lamp end, face on, far from the eye: the full peak.
    expect(
      beamAlpha({ t: 0, facing: 1, viewDist: 1000, localRadius: 4, rho: 10 }),
    ).toBeCloseTo(BEAM_OPACITY, 12);
    // Midway, every term partial:
    //   fade (1 − 0.5)^1.5        = 0.3535534
    //   hot  0.4 + 0.6·e^−3        = 0.4298722
    //   edge smoothstep(0, .8, .4) = 0.5
    //   near q = 20 / 8 = 2.5 → x = 0.8 → 0.896
    //   cam  rho 2 → x = 0.5 → 0.25 + 0.75 · 0.5 = 0.625
    //   0.4 · 0.3535534 · 0.4298722 · 0.5 · 0.896 · 0.625 = 0.0170221
    expect(
      beamAlpha({ t: 0.5, facing: 0.4, viewDist: 20, localRadius: 8, rho: 2 }),
    ).toBeCloseTo(0.0170221, 6);
    // The tip has thinned to nothing.
    expect(
      beamAlpha({ t: 1, facing: 1, viewDist: 500, localRadius: 34, rho: 10 }),
    ).toBe(0);
  });

  it("the camera term sits at its floor inside the wall and is 1 from RHO_OUT out", () => {
    expect(beamCameraFade(0)).toBe(BEAM_INSIDE_FLOOR);
    expect(beamCameraFade(BEAM_RHO_IN)).toBe(BEAM_INSIDE_FLOOR);
    expect(beamCameraFade(BEAM_RHO_OUT)).toBe(1);
    expect(beamCameraFade(50)).toBe(1);
  });

  it("is zero at the 1 m near plane, so a clipped wall leaves no edge", () => {
    for (const r of [0, 2, 4, 12, 34]) {
      expect(beamNearFade(1, r)).toBe(0);
      expect(
        beamAlpha({ t: 0.2, facing: 1, viewDist: 1, localRadius: r, rho: 5 }),
      ).toBe(0);
    }
    // ...and full once the fragment is BEAM_NEAR_OUT local radii away.
    expect(beamNearFade(BEAM_NEAR_OUT * 20, 20)).toBe(1);
    expect(beamNearFade(BEAM_NEAR_IN * 20, 20)).toBe(0);
  });

  for (const beam of BEAMS) {
    it(`${beam.name}: alpha is continuous as the eye crosses the wall`, () => {
      const points = wall(beam, 40, 24);
      for (const tc of [0.15, 0.4, 0.7, 0.95]) {
        let prev: number[] | null = null;
        let worst = 0;
        for (let rho = 0.5; rho <= 1.5 + 1e-9; rho += 0.005) {
          const eye = eyeAt(beam, tc, rho);
          const r = beamCameraRho(
            eye,
            beam.apex,
            beam.dir,
            beam.length,
            beam.radius,
          );
          const now = points.map((w) => alphaAt(beam, w, eye, r));
          if (prev) {
            for (let i = 0; i < now.length; i++) {
              worst = Math.max(
                worst,
                Math.abs((now[i] as number) - (prev[i] as number)),
              );
            }
          }
          prev = now;
        }
        expect(worst).toBeLessThanOrEqual(0.01);
      }
    });

    it(`${beam.name}: with the eye on the axis no point of the cone tops 0.15`, () => {
      const points = wall(beam, 200, 36);
      for (const tc of [0.05, 0.2, 0.5, 0.8]) {
        const eye = eyeAt(beam, tc, 0);
        const r = beamCameraRho(
          eye,
          beam.apex,
          beam.dir,
          beam.length,
          beam.radius,
        );
        let max = 0;
        for (const w of points) max = Math.max(max, alphaAt(beam, w, eye, r));
        expect(max).toBeLessThanOrEqual(0.15);
      }
    });
  }

  it("a beam seen from well outside keeps its full falloff", () => {
    const beam = BEAMS[0] as Beam;
    const eye = eyeAt(beam, 0.3, 12);
    const r = beamCameraRho(eye, beam.apex, beam.dir, beam.length, beam.radius);
    expect(beamCameraFade(r)).toBe(1);
  });
});

describe("BEAM_FALLOFF_GLSL", () => {
  it("is generated from the same constants as the model", () => {
    for (const fn of ["abBeamCameraRho", "abBeamCameraFade", "abBeamAlpha"]) {
      expect(BEAM_FALLOFF_GLSL).toContain(`float ${fn}(`);
    }
    for (const n of [
      BEAM_MIN_RADIUS,
      BEAM_NEAR_IN,
      BEAM_NEAR_OUT,
      BEAM_RHO_IN,
      BEAM_RHO_OUT,
      BEAM_INSIDE_FLOOR,
      1 - BEAM_INSIDE_FLOOR,
    ]) {
      expect(BEAM_FALLOFF_GLSL).toContain(n.toFixed(4));
    }
  });
});
