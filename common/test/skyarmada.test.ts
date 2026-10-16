// SKY1 cosmetic sky. What these defend: every client draws the same armada
// and dogfights from (seed, synced clock, unwrapped origin) alone; nothing
// jumps when the camera crosses a torus seam, when the clock folds over its
// loop or when a slot wraps round its window; and nothing cosmetic is ever
// visible nearer than SKY_INNER — past the fog limit, out of reach.

import {
  CLOUD_BASE,
  FOG_DISTANCE,
  WORLD_SIZE,
} from "@angels-bandits/common/constants";
import {
  FLAK_SLOTS,
  GROUP_SIZE_MAX,
  GROUP_SLOTS,
  PLANE_RADIUS_MAX,
  PLANE_WINDOW,
  SHIP_HALF_LEN,
  SHIP_RADIUS_MAX,
  SHIP_SCALE_MIN,
  SHIP_SCALE_SPAN,
  SHIP_SLOTS,
  SHIP_WINDOW,
  SKY_INNER,
  SKY_LOOP_S,
  SKY_PERIOD,
  flakPoseInto,
  newFlakPose,
  newPlanePose,
  newShipPose,
  planePoseInto,
  planeVis,
  shipPoseInto,
  shipVis,
  skyLoopTime,
  skySeed,
} from "@angels-bandits/common/skyarmada";
import { describe, expect, it } from "vitest";

const SEED = skySeed(42);
/** An epoch-ms clock like the server's. */
const T0 = 1_791_000_000_000;

/** Every ship / plane pose at loop time t from origin (ox, oz). */
function ships(seed: number, t: number, ox: number, oz: number) {
  const out = [];
  for (let i = 0; i < SHIP_SLOTS; i++) {
    out.push(shipPoseInto(seed, i, t, ox, oz, newShipPose()));
  }
  return out;
}
function planes(seed: number, t: number, ox: number, oz: number) {
  const out = [];
  for (let g = 0; g < GROUP_SLOTS; g++) {
    for (let m = 0; m < GROUP_SIZE_MAX; m++) {
      out.push(planePoseInto(seed, g, m, t, ox, oz, newPlanePose()));
    }
  }
  return out;
}

describe("sky armada — determinism", () => {
  it("the same (seed, time, origin) gives the same sky; another seed does not", () => {
    const t = skyLoopTime(T0);
    expect(ships(SEED, t, 900, 1300)).toEqual(ships(SEED, t, 900, 1300));
    expect(planes(SEED, t, 900, 1300)).toEqual(planes(SEED, t, 900, 1300));
    const other = ships(skySeed(43), t, 900, 1300);
    const same = ships(SEED, t, 900, 1300);
    const moved = other.filter(
      (p, i) => Math.abs(p.x - (same[i]?.x ?? 0)) > 1,
    ).length;
    expect(moved).toBeGreaterThan(SHIP_SLOTS * 0.9);
  });

  it("the seed and the clock fold exactly (float uniforms hold them)", () => {
    for (const s of [0, 1, 42, 0xffffffff, 123456789]) {
      const k = skySeed(s);
      expect(Number.isInteger(k)).toBe(true);
      expect(k).toBeGreaterThanOrEqual(0);
      expect(k).toBeLessThan(65536);
    }
    expect(skyLoopTime(T0 + SKY_LOOP_S * 1000)).toBeCloseTo(skyLoopTime(T0), 6);
    expect(skyLoopTime(-1000)).toBeCloseTo(SKY_LOOP_S - 1, 6);
  });
});

describe("sky armada — wrap continuity", () => {
  it("the poses do not depend on which whole torus image the origin is in, up to the window", () => {
    // The unwrapped origin moves with the camera across a seam (it never
    // jumps by WORLD_SIZE); the window divides the offset's period, so the
    // poses are the same at origin and origin + SKY_PERIOD.
    expect(SKY_PERIOD % SHIP_WINDOW).toBe(0);
    expect(SKY_PERIOD % PLANE_WINDOW).toBe(0);
    const t = 1234.5;
    const a = ships(SEED, t, 1999.5, 10);
    const b = ships(SEED, t, 1999.5 + SKY_PERIOD, 10 - SKY_PERIOD);
    a.forEach((p, i) => {
      expect(p.x).toBeCloseTo(b[i]?.x ?? Number.NaN, 4);
      expect(p.z).toBeCloseTo(b[i]?.z ?? Number.NaN, 4);
    });
  });

  it("a camera crossing the torus seam moves every visible pose by exactly its step", () => {
    // The camera flies 1 m east across x = WORLD_SIZE: the unwrapped
    // origin goes 1999.5 → 2000.5 (the canonical x wraps to 0.5, it does
    // not), so every pose shifts by −1 m — no jump.
    const t = 777;
    const a = ships(SEED, t, WORLD_SIZE - 0.5, 300);
    const b = ships(SEED, t, WORLD_SIZE + 0.5, 300);
    a.forEach((p, i) => {
      if (shipVis(p, 300, SHIP_RADIUS_MAX) <= 0) return;
      expect((b[i]?.x ?? 0) - p.x).toBeCloseTo(-1, 6);
      expect(b[i]?.z).toBeCloseTo(p.z, 6);
    });
  });

  it("the folded clock closes its loop: t → SKY_LOOP_S lands on t = 0", () => {
    const eps = 1e-3;
    const pairs: [ReturnType<typeof ships>, ReturnType<typeof ships>][] = [
      [ships(SEED, SKY_LOOP_S - eps, 400, 400), ships(SEED, 0, 400, 400)],
    ];
    for (const [a, b] of pairs) {
      a.forEach((p, i) => {
        const q = b[i];
        if (!q) throw new Error("missing");
        // A ship can sit on its window edge at the instant (both images
        // invisible); otherwise it moved < 1 cm.
        if (Math.abs(Math.abs(p.x) - SHIP_WINDOW / 2) < 1) return;
        if (Math.abs(Math.abs(p.z) - SHIP_WINDOW / 2) < 1) return;
        expect(Math.abs(q.x - p.x)).toBeLessThan(0.05);
        expect(Math.abs(q.z - p.z)).toBeLessThan(0.05);
        // A falling hull drops ≤ ~100 m/s: 1 ms of it is 10 cm.
        expect(Math.abs(q.y - p.y)).toBeLessThan(0.2);
        expect(q.burn).toBeCloseTo(p.burn, 2);
        expect(q.fade).toBeCloseTo(p.fade, 2);
      });
    }
    const pa = planes(SEED, SKY_LOOP_S - eps, 400, 400);
    const pb = planes(SEED, 0, 400, 400);
    pa.forEach((p, i) => {
      const q = pb[i];
      if (!q || !p.present) return;
      // A kill cycle can end with the loop: the downed plane under the
      // street, its replacement still faded out — both invisible.
      if (
        planeVis(p, 400, PLANE_RADIUS_MAX) <= 0 &&
        planeVis(q, 400, PLANE_RADIUS_MAX) <= 0 &&
        (p.y < 0 || q.fade <= 0)
      )
        return;
      if (Math.abs(Math.abs(p.x) - PLANE_WINDOW / 2) < 300) return;
      if (Math.abs(Math.abs(p.z) - PLANE_WINDOW / 2) < 300) return;
      // A plane flies ≤ ~100 m/s; 1 ms of it is 10 cm.
      expect(Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z)).toBeLessThan(0.5);
    });
  });

  it("frame to frame nothing visible jumps (ships, planes)", () => {
    // 20 s at 60 fps from an arbitrary instant: every visible pose moves
    // no more than it can fly in a frame; slots that wrap round their
    // window are invisible while they do, and a downed plane's replacement
    // fades in from nothing (under one 8-bit step is not seen).
    const SEEN = 1 / 255;
    const dt = 1 / 60;
    const camY = 250;
    let sp = ships(SEED, 3000, 1200, 800);
    let pp = planes(SEED, 3000, 1200, 800);
    for (let k = 1; k <= 1200; k++) {
      const t = 3000 + k * dt;
      const ns = ships(SEED, t, 1200, 800);
      const np = planes(SEED, t, 1200, 800);
      ns.forEach((p, i) => {
        const q = sp[i];
        if (!q) return;
        const seen =
          shipVis(p, camY, SHIP_RADIUS_MAX) > SEEN ||
          shipVis(q, camY, SHIP_RADIUS_MAX) > SEEN;
        if (!seen) return;
        expect(Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z)).toBeLessThan(2);
      });
      np.forEach((p, i) => {
        const q = pp[i];
        if (!q) return;
        const seen =
          planeVis(p, camY, PLANE_RADIUS_MAX) > SEEN ||
          planeVis(q, camY, PLANE_RADIUS_MAX) > SEEN;
        if (!seen) return;
        // A diving, spiralling kill is the fastest thing up: < 300 m/s.
        expect(Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z)).toBeLessThan(5);
      });
      sp = ns;
      pp = np;
    }
  });

  it("a slot wrapping round its window is invisible on both sides", () => {
    // The farthest anything is drawn, plus its reach, stays inside half
    // the window — so the wrap happens where nothing is seen.
    const hull = SHIP_HALF_LEN * (SHIP_SCALE_MIN + SHIP_SCALE_SPAN);
    expect(SHIP_RADIUS_MAX + hull).toBeLessThan(SHIP_WINDOW / 2);
    for (const t of [0, 100, 2000]) {
      for (const p of ships(SEED, t, 0, 0)) {
        if (Math.max(Math.abs(p.x), Math.abs(p.z)) > SHIP_WINDOW / 2 - 50) {
          expect(shipVis(p, 0, SHIP_RADIUS_MAX)).toBe(0);
        }
      }
      for (const p of planes(SEED, t, 0, 0)) {
        if (Math.max(Math.abs(p.x), Math.abs(p.z)) > PLANE_WINDOW / 2 - 10) {
          expect(planeVis(p, 0, PLANE_RADIUS_MAX)).toBe(0);
        }
      }
    }
  });
});

describe("sky armada — minimum distance", () => {
  it("nothing cosmetic is visible nearer than SKY_INNER (past the fog limit)", () => {
    expect(SKY_INNER).toBeGreaterThan(FOG_DISTANCE);
    let seenShips = 0;
    let seenPlanes = 0;
    for (const t of [0, 450, 901.25, 1800, 3599]) {
      for (const [ox, oz, camY] of [
        [0, 0, 20],
        [1000, 1700, 300],
        [63_000, 12, 640],
      ] as const) {
        for (const p of ships(SEED, t, ox, oz)) {
          if (shipVis(p, camY, SHIP_RADIUS_MAX) <= 0) continue;
          seenShips++;
          const hull = SHIP_HALF_LEN * p.scale;
          expect(Math.hypot(p.x, p.y - camY, p.z) - hull).toBeGreaterThan(
            SKY_INNER,
          );
        }
        for (const p of planes(SEED, t, ox, oz)) {
          if (planeVis(p, camY, PLANE_RADIUS_MAX) <= 0) continue;
          seenPlanes++;
          expect(Math.hypot(p.x, p.y - camY, p.z)).toBeGreaterThan(SKY_INNER);
        }
      }
    }
    // And the sky is busy: hundreds of ships and planes in view overall.
    expect(seenShips).toBeGreaterThan(1000);
    expect(seenPlanes).toBeGreaterThan(500);
  });

  it("ships cruise under the cloud deck; flak bursts under the ships", () => {
    const f = newFlakPose();
    for (const p of ships(SEED, 50, 0, 0)) {
      if (p.burn > 0 || p.fade < 1) continue;
      const r = 21 * p.scale;
      expect(p.y + r).toBeLessThan(CLOUD_BASE);
    }
    for (let i = 0; i < FLAK_SLOTS; i++) {
      flakPoseInto(SEED, i, 50, 0, 0, f);
      expect(f.y).toBeLessThan(CLOUD_BASE - 40);
      expect(f.age).toBeGreaterThanOrEqual(0);
      expect(f.age).toBeLessThan(f.period);
    }
  });

  it("some ships burn and fall, some planes are shot down, chasers fire", () => {
    let burning = 0;
    let downed = 0;
    let firing = 0;
    for (let t = 0; t < SKY_LOOP_S; t += 30) {
      for (const p of ships(SEED, t, 0, 0)) if (p.burn > 0) burning++;
      for (const p of planes(SEED, t, 0, 0)) {
        if (p.hitAge >= 0) downed++;
        if (p.firing) firing++;
      }
    }
    expect(burning).toBeGreaterThan(0);
    expect(downed).toBeGreaterThan(0);
    expect(firing).toBeGreaterThan(0);
  });
});
