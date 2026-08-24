// Where ANGE-4KO2W2's two halves meet the combat authority: does a QUANTISED
// pose ever change a hit-validation verdict, and does the DERIVED range slack
// still admit a legitimate max-range hit while rejecting an out-of-range one
// at every delay the server will honour?
//
// The pure math is proved in common/test/net.test.ts; this drives the real
// Combat engine, which is the only thing that can answer "does the rule
// actually behave the same".

import { mulberry32 } from "@angels-bandits/common/city";
import {
  BULLET_RANGE,
  INTERP_DELAY_MAX_MS,
  INTERP_FLOOR_MS,
  MAX_ALTITUDE,
  PLAYER_RADIUS,
  WORLD_SIZE,
} from "@angels-bandits/common/constants";
import {
  POS_QUANT_ERROR_M,
  hitRangeBudgetFor,
  quantisePose,
} from "@angels-bandits/common/net";
import type { Pose } from "@angels-bandits/common/protocol";
import {
  type Vec3,
  canonicalize,
  wrapDistance,
} from "@angels-bandits/common/world";
import { describe, expect, it } from "vitest";
import { Combat } from "../src/combat";

const T = 10_000; // past SPAWN_PROTECTION_MS for everyone
const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };
const poseAt = (p: Vec3): Pose => ({
  pos: canonicalize(p),
  quat: { ...IDENTITY },
  speed: 65,
});

/** Fire one bullet and immediately claim it. Fresh engine per call so heat,
 * cadence and HP can never bleed between samples. */
const claim = (
  shooterPos: Vec3,
  targetPos: Vec3,
  now: number,
  delayMs?: number,
): boolean => {
  const combat = new Combat();
  combat.addPlayer("s", 0);
  combat.addPlayer("t", 0);
  combat.fire("s", 1, now);
  return combat.hit(
    "s",
    "t",
    1,
    shooterPos,
    shooterPos,
    targetPos,
    now,
    delayMs,
  ).ok;
};

describe("quantisation vs hit validation", () => {
  it("never flips a verdict across a large seeded sample of engagement geometry", () => {
    const rand = mulberry32(0x4b02_0202);
    const budget = hitRangeBudgetFor(INTERP_FLOOR_MS);
    let checked = 0;
    let worstPosError = 0;
    for (let i = 0; i < 4000; i++) {
      // Shooter anywhere in the world (seam included), target on a random
      // bearing at a random distance across the whole legal envelope.
      const shooter = poseAt({
        x: rand() * WORLD_SIZE,
        y: rand() * MAX_ALTITUDE,
        z: rand() * WORLD_SIZE,
      });
      const bearing = rand() * Math.PI * 2;
      const pitch = rand() * Math.PI - Math.PI / 2;
      const dist = rand() * 700;
      const target = poseAt({
        x: shooter.pos.x + Math.cos(pitch) * Math.sin(bearing) * dist,
        // Altitude stays inside the band validatePose already clamps every
        // on-record pose to — the wire never carries anything else.
        y: Math.min(
          MAX_ALTITUDE,
          Math.max(0, shooter.pos.y + Math.sin(pitch) * dist),
        ),
        z: shooter.pos.z + Math.cos(pitch) * Math.cos(bearing) * dist,
      });
      const trueDist = wrapDistance(shooter.pos, target.pos);
      // Skip only the razor band the quantisation step could physically
      // straddle — 0.17 m out of a 534 m budget.
      if (Math.abs(trueDist - budget) <= 2 * POS_QUANT_ERROR_M) continue;

      const qs = quantisePose(shooter);
      const qt = quantisePose(target);
      worstPosError = Math.max(
        worstPosError,
        wrapDistance(qs.pos, shooter.pos),
        wrapDistance(qt.pos, target.pos),
      );
      expect(claim(qs.pos, qt.pos, T)).toBe(claim(shooter.pos, target.pos, T));
      checked++;
    }
    expect(checked).toBeGreaterThan(3900);
    expect(worstPosError).toBeLessThanOrEqual(POS_QUANT_ERROR_M);
    // The band that could ever disagree is 23x narrower than one plane.
    expect(2 * POS_QUANT_ERROR_M).toBeLessThan(PLAYER_RADIUS);
  });

  it("cannot move a hit across the target's own hit sphere", () => {
    // The strongest statement about precision: the whole quantisation error
    // is a small fraction of a plane's collision radius, so no quantised pose
    // can turn a miss into a hit or the reverse at the geometry level either.
    expect(POS_QUANT_ERROR_M / PLAYER_RADIUS).toBeLessThan(0.05);
  });
});

describe("the derived slack at every delay the server honours", () => {
  it("admits a legitimate max-range hit at the LARGEST delay and still rejects out of range", () => {
    const budget = hitRangeBudgetFor(INTERP_DELAY_MAX_MS);
    const shooter = { x: 1000, y: 300, z: 1000 };
    const inRange = { x: 1000 + budget - 1, y: 300, z: 1000 };
    const outOfRange = { x: 1000 + budget + 1, y: 300, z: 1000 };
    expect(claim(shooter, inRange, T, INTERP_DELAY_MAX_MS)).toBe(true);
    expect(claim(shooter, outOfRange, T, INTERP_DELAY_MAX_MS)).toBe(false);
  });

  it("admits a max-range hit at the FLOOR too — a tighter window, not a broken one", () => {
    const budget = hitRangeBudgetFor(INTERP_FLOOR_MS);
    const shooter = { x: 1000, y: 300, z: 1000 };
    expect(claim(shooter, { x: 1000 + budget - 1, y: 300, z: 1000 }, T)).toBe(
      true,
    );
    expect(claim(shooter, { x: 1000 + budget + 1, y: 300, z: 1000 }, T)).toBe(
      false,
    );
    // A shot inside the gun's actual range is never at the mercy of the slack.
    expect(claim(shooter, { x: 1000 + BULLET_RANGE, y: 300, z: 1000 }, T)).toBe(
      true,
    );
  });

  it("moves the accept/reject boundary WITH the delay", () => {
    // One geometry, judged twice: beyond the floor's budget, inside the max's.
    const between =
      (hitRangeBudgetFor(INTERP_FLOOR_MS) +
        hitRangeBudgetFor(INTERP_DELAY_MAX_MS)) /
      2;
    const shooter = { x: 1000, y: 300, z: 1000 };
    const target = { x: 1000 + between, y: 300, z: 1000 };
    expect(claim(shooter, target, T, INTERP_FLOOR_MS)).toBe(false);
    expect(claim(shooter, target, T, INTERP_DELAY_MAX_MS)).toBe(true);
  });

  it("treats an undeclared or nonsense delay as the FLOOR — the tightest budget", () => {
    const shooter = { x: 1000, y: 300, z: 1000 };
    const target = {
      x: 1000 + hitRangeBudgetFor(INTERP_FLOOR_MS) + 1,
      y: 300,
      z: 1000,
    };
    // Over the floor's budget: no way to buy past it by lying downward…
    expect(claim(shooter, target, T)).toBe(false);
    expect(claim(shooter, target, T, Number.NaN)).toBe(false);
    expect(claim(shooter, target, T, 0)).toBe(false);
    // …and lying upward is capped at the ceiling, never beyond it.
    const beyondMax = {
      x: 1000 + hitRangeBudgetFor(INTERP_DELAY_MAX_MS) + 1,
      y: 300,
      z: 1000,
    };
    expect(claim(shooter, beyondMax, T, 1e9)).toBe(false);
  });

  it("is torus-aware at every delay: the budget is a wrapped distance, never a raw one", () => {
    // Shooter just west of the seam, target just east of it: 20 m apart on
    // the torus, 1980 m apart if you subtract coordinates.
    expect(
      claim({ x: 1990, y: 300, z: 100 }, { x: 10, y: 300, z: 100 }, T),
    ).toBe(true);
  });
});
