import { generateCity } from "@angels-bandits/common/city";
import { natureFor, treeBoxes } from "@angels-bandits/common/city/nature";
import { WORLD_SIZE } from "@angels-bandits/common/constants";
import {
  CROWN_BEGIN_VERTEX_GLSL,
  CROWN_DRAW_SCALE,
  CROWN_SWAY_GLSL,
  CROWN_SWAY_MAX,
  FLUTTER_KA,
  GUST_K1,
  SWAY_ACROSS,
  SWAY_LEAN,
  crownSway,
  swayPhases,
  windAt,
} from "@angels-bandits/common/wind";
import { describe, expect, it } from "vitest";

const f32 = Math.fround;

/** Evenly spread unit vectors (a Fibonacci sphere) plus the two poles —
 * every direction an icosahedron vertex can point in, densely sampled. */
function unitVectors(n: number): { x: number; y: number; z: number }[] {
  const out = [
    { x: 0, y: 1, z: 0 },
    { x: 0, y: -1, z: 0 },
  ];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (2 * (i + 0.5)) / n;
    const r = Math.sqrt(1 - y * y);
    out.push({ x: Math.cos(golden * i) * r, y, z: Math.sin(golden * i) * r });
  }
  return out;
}

/** Server times spanning gust, flutter and veer cycles, incl. a large clock. */
const TIMES = [0, 1234, 5_000, 11_700, 33_333, 97_000, 1.7e12 + 4321];

describe("crown sway stays inside the collision volume (draw == collide)", () => {
  const nature = natureFor(42, generateCity(42));
  const dirs = unitVectors(48);

  it("every seed-42 crown vertex stays in its treeBoxes canopy box and inscribed ellipsoid", () => {
    expect(nature.trees.length).toBeGreaterThan(100);
    const d = { x: 0, z: 0 };
    let worst = 0;
    let maxSway = 0;
    let outsideBox = 0;
    for (const t of TIMES) {
      const wind = windAt(t);
      const phases = swayPhases(t);
      for (const tree of nature.trees) {
        const { canopy } = treeBoxes(tree);
        const hy = (canopy.y1 - canopy.y0) / 2;
        const cy = (canopy.y0 + canopy.y1) / 2;
        for (const v of dirs) {
          // Sway is sampled at a re-imaged position too: same answer.
          crownSway(tree.x + WORLD_SIZE, tree.z, v.y, wind, phases, d);
          maxSway = Math.max(maxSway, Math.hypot(d.x, d.z));
          // The shader's arithmetic, in float32.
          const ux = f32(f32(v.x * CROWN_DRAW_SCALE) + f32(d.x));
          const uy = f32(v.y * CROWN_DRAW_SCALE);
          const uz = f32(f32(v.z * CROWN_DRAW_SCALE) + f32(d.z));
          // World offset from the canopy centre.
          const wx = ux * canopy.hx;
          const wy = uy * hy;
          const wz = uz * canopy.hz;
          if (
            Math.abs(wx) > canopy.hx ||
            Math.abs(wz) > canopy.hz ||
            cy + wy < canopy.y0 ||
            cy + wy > canopy.y1
          ) {
            outsideBox++;
          }
          const e =
            (wx / canopy.hx) ** 2 + (wy / hy) ** 2 + (wz / canopy.hz) ** 2;
          worst = Math.max(worst, e);
        }
      }
    }
    expect(outsideBox).toBe(0);
    // Inside the solid ellipsoid with zero slack (float32 rounding aside).
    expect(worst).toBeLessThanOrEqual(1 + 1e-6);
    // ...and the sway is real, not a no-op that trivially passes.
    expect(maxSway).toBeGreaterThan(0.5 * CROWN_SWAY_MAX);
    expect(maxSway).toBeLessThanOrEqual(CROWN_SWAY_MAX);
  });

  it("sway never exceeds the draw-scale slack for any wind or vertex height", () => {
    const d = { x: 0, z: 0 };
    for (let i = 0; i < 2000; i++) {
      const t = i * 7919.37;
      crownSway(
        i * 13.1,
        i * 29.7,
        (i % 21) / 10 - 1,
        windAt(t),
        swayPhases(t),
        d,
      );
      const k = Math.min(1, Math.max(0, 0.5 + 0.5 * ((i % 21) / 10 - 1)));
      expect(Math.hypot(d.x, d.z)).toBeLessThanOrEqual(
        CROWN_SWAY_MAX * k + 1e-12,
      );
    }
  });
});

describe("wind is deterministic and torus-periodic", () => {
  it("windAt / swayPhases are pure functions of the server clock", () => {
    expect(windAt(48_123)).toEqual(windAt(48_123));
    expect(swayPhases(48_123)).toEqual(swayPhases(48_123));
    for (let t = 0; t < 600_000; t += 3_700) {
      const w = windAt(t);
      expect(Math.hypot(w.x, w.z)).toBeCloseTo(1, 12);
      expect(w.strength).toBeGreaterThanOrEqual(0.1 - 1e-12);
      expect(w.strength).toBeLessThanOrEqual(1 + 1e-12);
    }
  });

  it("re-imaging a crown by ±WORLD_SIZE never changes its sway", () => {
    const wind = windAt(77_000);
    const phases = swayPhases(77_000);
    const a = { x: 0, z: 0 };
    const b = { x: 0, z: 0 };
    for (const [x, z] of [
      [10, 20],
      [900, 900],
      [1999, 3],
    ] as const) {
      crownSway(x, z, 0.6, wind, phases, a);
      for (const [ox, oz] of [
        [WORLD_SIZE, 0],
        [-WORLD_SIZE, WORLD_SIZE],
        [0, -WORLD_SIZE],
      ] as const) {
        crownSway(x + ox, z + oz, 0.6, wind, phases, b);
        expect(b.x).toBeCloseTo(a.x, 9);
        expect(b.z).toBeCloseTo(a.z, 9);
      }
    }
  });

  it("the shader is generated from the same constants as crownSway", () => {
    expect(CROWN_SWAY_GLSL).toContain(`vec2(${GUST_K1[0]}.0, ${GUST_K1[1]}.0)`);
    expect(CROWN_SWAY_GLSL).toContain(
      `vec2(${FLUTTER_KA[0]}.0, ${FLUTTER_KA[1]}.0)`,
    );
    expect(CROWN_SWAY_GLSL).toContain(String(CROWN_SWAY_MAX));
    expect(CROWN_SWAY_GLSL).toContain(String(SWAY_LEAN));
    expect(CROWN_SWAY_GLSL).toContain(String(SWAY_ACROSS));
    expect(CROWN_SWAY_GLSL).toContain(String((2 * Math.PI) / WORLD_SIZE));
    expect(CROWN_BEGIN_VERTEX_GLSL).toContain(`* ${CROWN_DRAW_SCALE}`);
    expect(CROWN_BEGIN_VERTEX_GLSL).toContain(
      "crownSway(instanceMatrix[3].xz, position.y)",
    );
  });
});
