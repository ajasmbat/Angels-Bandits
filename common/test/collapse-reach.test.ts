// D11 fairness: a collapse kills only what it visibly reaches. Under D10 a
// toppling tower threw its top storeys up to ~2× its height (a 305 m tower's
// chunks landed 600 m out), killing planes far outside the strip the
// director warns about. Every tall tower of the seed city, felled every way,
// is held to COLLAPSE_TOPPLE_REACH tower-heights — every pose of every piece
// and the swept bounds the crash check rejects by — never above its own top
// plus a little, and never touches a plane holding 600 m from it, on any
// torus image.

import {
  type Building,
  generateCity,
  makeBuilding,
} from "@angels-bandits/common/city";
import {
  type Collapse,
  CollapseField,
  DIR_NEG_X,
  DIR_NEG_Z,
  DIR_POS_X,
  DIR_POS_Z,
  PANCAKE,
  TOPPLE,
  blankPose,
  collapseWire,
  collideCollapses,
  demolitionPlan,
  piecePose,
} from "@angels-bandits/common/city/collapse";
import {
  CITY_SEED,
  COLLAPSE_TOPPLE_REACH,
  PLAYER_RADIUS,
  WORLD_SIZE,
} from "@angels-bandits/common/constants";
import { describe, expect, it } from "vitest";

const SEED_CITY = generateCity(CITY_SEED);
/** The towers a far-away kill came from: everything 250 m and up. */
const TALL = SEED_CITY.map((b, i) => [b, i] as const)
  .filter(([b]) => b.height >= 250)
  .map(([, i]) => i);
const STYLES = [
  [PANCAKE, 0],
  [TOPPLE, DIR_NEG_X],
  [TOPPLE, DIR_POS_X],
  [TOPPLE, DIR_NEG_Z],
  [TOPPLE, DIR_POS_Z],
] as const;
/** How far above its top a piece may rise (a hinge's swing, a bounce). */
const TOP_MARGIN = 80;
/** Sampling step over the fall, ms. */
const STEP_MS = 100;

/** Tower `i` felled `style`/`dir` at t0 = 0 on a fresh copy of the city. */
function felled(i: number, style: number, dir: number): Collapse | null {
  const city = SEED_CITY.map((b) => makeBuilding({ ...b, damage: undefined }));
  const field = new CollapseField();
  field.bind(city);
  const plan = demolitionPlan(city[i] as Building, i, style as 0 | 1, dir);
  return plan ? field.add(collapseWire(plan, i, 1, 0)) : null;
}

describe("D11 a collapse's lethal reach", () => {
  it("covers the seed city's tall towers", () => {
    expect(TALL.length).toBeGreaterThan(10);
  });

  it("every piece, every instant, and the swept bounds stay within COLLAPSE_TOPPLE_REACH heights and under the top", () => {
    const pose = blankPose();
    let worst = 0;
    let worstAt = "";
    let over = 0;
    let overAt = "";
    for (const i of TALL) {
      const h = (SEED_CITY[i] as Building).height;
      for (const [style, dir] of STYLES) {
        const c = felled(i, style, dir);
        if (!c) continue;
        const b = c.bounds;
        const at = `building ${i} (${Math.round(h)} m) style ${style} dir ${dir}`;
        const note = (r: number, up: number, what: string) => {
          if (r > worst) {
            worst = r;
            worstAt = `${at}: ${what}`;
          }
          if (up > over) {
            over = up;
            overAt = `${at}: ${what}`;
          }
        };
        note(Math.max(-b.x0, b.x1, -b.z0, b.z1) / h, b.y1 - h, "bounds");
        for (let t = 0; t <= c.endMs + STEP_MS; t += STEP_MS) {
          for (let k = 0; k < c.n; k++) {
            piecePose(c, k, t, pose);
            note(
              (Math.hypot(pose.x, pose.z) + Math.hypot(pose.hx, pose.hz)) / h,
              pose.y - pose.hy - h,
              `piece ${k} at ${t} ms`,
            );
          }
        }
      }
    }
    expect(worst, worstAt).toBeLessThanOrEqual(COLLAPSE_TOPPLE_REACH);
    expect(worst).toBeGreaterThan(0.8); // a topple still falls its length
    expect(over, overAt).toBeLessThanOrEqual(TOP_MARGIN);
  });

  it("never touches a plane holding 600 m off, at any altitude, on any torus image", () => {
    const dirs = 16;
    const alts = [8, 40, 120, 250, 400, 600];
    for (const i of TALL) {
      const tower = SEED_CITY[i] as Building;
      for (const [style, dir] of STYLES) {
        const c = felled(i, style, dir);
        if (!c) continue;
        for (let t = 0; t <= c.endMs + 2000; t += 400) {
          for (let d = 0; d < dirs; d++) {
            const a = (d / dirs) * Math.PI * 2;
            for (const y of alts) {
              const x = tower.x + Math.cos(a) * 600;
              const z = tower.z + Math.sin(a) * 600;
              for (const img of [0, WORLD_SIZE]) {
                const hit = collideCollapses(
                  { x: x + img, y, z: z - img },
                  PLAYER_RADIUS,
                  [c],
                  t,
                );
                expect(hit).toBeNull();
              }
            }
          }
        }
      }
    }
  });
});
