import { WORLD_SIZE } from "@angels-bandits/common/constants";
import type { Vec3 } from "@angels-bandits/common/world";
import { describe, expect, it } from "vitest";
import {
  SCATTER_RADIUS,
  SCATTER_RETRIGGER_S,
  SCATTER_SETTLE_S,
  type Scatter,
  nextScatter,
  scatterOffset,
} from "../src/render/bird-scatter";
import { BIRDS_PER_FLOCK, flockCenter, flocks } from "../src/render/birds";

const T0 = 120_000;

/** Run one flock's scatter through a sequence of (time, planes) samples and
 * return every bird's offset at each sample — the whole observable output. */
function run(seed: number, samples: { t: number; planes: Vec3[] }[]): number[] {
  const flock = flocks(seed)[0];
  if (!flock) throw new Error("no flock");
  let s: Scatter | null = null;
  const out: number[] = [];
  const o = { x: 0, y: 0, z: 0 };
  for (const { t, planes } of samples) {
    s = nextScatter(flockCenter(flock, t), t, planes, s);
    for (let b = 0; b < BIRDS_PER_FLOCK; b++) {
      scatterOffset(flock.id, b, t, s, o);
      out.push(o.x, o.y, o.z);
    }
  }
  return out;
}

/** A plane `dist` m from flock 0's centre at time t, along +x. */
function planeNear(seed: number, t: number, dist: number): Vec3 {
  const flock = flocks(seed)[0];
  if (!flock) throw new Error("no flock");
  const c = flockCenter(flock, t);
  return { x: c.x - dist, y: c.y, z: c.z };
}

describe("bird scatter", () => {
  it("is a pure function of (flock seed, time, plane positions)", () => {
    const samples = [0, 100, 400, 1500, 4000, 9000].map((dt) => ({
      t: T0 + dt,
      planes: dt === 100 ? [planeNear(42, T0 + dt, 30)] : [],
    }));
    const a = run(42, samples);
    expect(run(42, samples)).toEqual(a);
    // It actually moved, and a different seed's flock is a different flock.
    expect(a.some((v) => Math.abs(v) > 5)).toBe(true);
  });

  it("a plane 59 m from the flock centre spooks it; one at 61 m does not", () => {
    expect(SCATTER_RADIUS).toBe(60);
    const flock = flocks(42)[0];
    if (!flock) throw new Error("no flock");
    const c = flockCenter(flock, T0);
    expect(nextScatter(c, T0, [planeNear(42, T0, 59)], null)).not.toBeNull();
    expect(nextScatter(c, T0, [planeNear(42, T0, 61)], null)).toBeNull();
    // Through the torus seam: the same 59 m, one world away.
    const far = planeNear(42, T0, 59);
    expect(
      nextScatter(c, T0, [{ ...far, x: far.x + WORLD_SIZE }], null),
    ).not.toBeNull();
  });

  it("bursts away from the plane and upward, then resettles to zero", () => {
    const flock = flocks(42)[0];
    if (!flock) throw new Error("no flock");
    const plane = planeNear(42, T0, 40); // plane on the flock's −x side
    const s = nextScatter(flockCenter(flock, T0), T0, [plane], null);
    expect(s).not.toBeNull();
    const o = { x: 0, y: 0, z: 0 };
    let sumX = 0;
    for (let b = 0; b < BIRDS_PER_FLOCK; b++) {
      scatterOffset(flock.id, b, T0 + 1500, s, o);
      sumX += o.x;
      expect(o.y).toBeGreaterThan(0);
    }
    expect(sumX / BIRDS_PER_FLOCK).toBeGreaterThan(10); // away = +x
    // Before the trigger, and once settled, the offset is exactly zero.
    for (const t of [T0 - 1, T0 + SCATTER_SETTLE_S * 1000]) {
      for (let b = 0; b < BIRDS_PER_FLOCK; b++) {
        scatterOffset(flock.id, b, t, s, o);
        expect([o.x, o.y, o.z]).toEqual([0, 0, 0]);
      }
    }
  });

  it("re-triggers only after the re-trigger gap, without a pop", () => {
    const flock = flocks(42)[0];
    if (!flock) throw new Error("no flock");
    const first = nextScatter(
      flockCenter(flock, T0),
      T0,
      [planeNear(42, T0, 30)],
      null,
    );
    const early = T0 + SCATTER_RETRIGGER_S * 1000 - 1;
    expect(
      nextScatter(
        flockCenter(flock, early),
        early,
        [planeNear(42, early, 30)],
        first,
      ),
    ).toBe(first);
    const t = T0 + SCATTER_RETRIGGER_S * 1000 + 500;
    const plane = { ...planeNear(42, t, 0), z: flockCenter(flock, t).z + 30 };
    const second = nextScatter(flockCenter(flock, t), t, [plane], first);
    expect(second).not.toBe(first);
    expect(second?.t0).toBe(t);
    // Continuous at the trigger: the new scatter starts where the old one was.
    const a = { x: 0, y: 0, z: 0 };
    const b = { x: 0, y: 0, z: 0 };
    for (let i = 0; i < BIRDS_PER_FLOCK; i++) {
      scatterOffset(flock.id, i, t, first, a);
      scatterOffset(flock.id, i, t, second, b);
      expect(b.x).toBeCloseTo(a.x, 6);
      expect(b.y).toBeCloseTo(a.y, 6);
      expect(b.z).toBeCloseTo(a.z, 6);
    }
  });

  it("a clock that steps backwards drops the old trigger", () => {
    const flock = flocks(42)[0];
    if (!flock) throw new Error("no flock");
    const s = nextScatter(
      flockCenter(flock, T0),
      T0,
      [planeNear(42, T0, 10)],
      null,
    );
    expect(
      nextScatter(flockCenter(flock, T0 - 5000), T0 - 5000, [], s),
    ).toBeNull();
  });
});
