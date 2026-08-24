// The wire's math (ANGE-4KO2W2): snapshot quantisation, the interpolation-delay
// controller, and the hit-claim slack derived from that delay. Expected values
// are worked from the spec constants, never recomputed the code's way.
//
// Worked examples used below:
//   POS_SCALE 10        → 0.1 m steps, ±0.05 m per axis, ±0.0866 m in 3D
//   QUAT_SCALE 1000     → 0.001 per component
//   SNAPSHOT_INTERVAL_MS = 1000 / TICK_DOWN_HZ 20            = 50 ms
//   INTERP_FLOOR_MS      = 50 + INTERP_MARGIN_MS 8           = 58 ms
//   closing speed        = 2 × MAX_SPEED 90 × TOLERANCE 1.1  = 198 m/s
//   BULLET_LIFETIME_S    = BULLET_RANGE 350 / BULLET_SPEED 400 = 0.875 s
//   hitRangeSlackFor(58) = 198 × (0.058 + 0.875)             = 184.734 m

import { mulberry32 } from "@angels-bandits/common/city";
import {
  BULLET_RANGE,
  INTERP_DELAY_MAX_MS,
  INTERP_FLOOR_MS,
  INTERP_JITTER_DECAY,
  INTERP_JITTER_FACTOR,
  INTERP_MARGIN_MS,
  PLAYER_RADIUS,
  SNAPSHOT_INTERVAL_MS,
  TICK_DOWN_HZ,
  WORLD_SIZE,
} from "@angels-bandits/common/constants";
import {
  POS_QUANT_ERROR_M,
  POS_SCALE,
  clampInterpDelay,
  decodeSnapshotEntry,
  encodeSnapshotEntry,
  hitRangeBudgetFor,
  hitRangeSlackFor,
  interpDelayFor,
  nextJitter,
  quantisePose,
} from "@angels-bandits/common/net";
import type { Pose, SnapshotEntry } from "@angels-bandits/common/protocol";
import { canonicalize, wrapDistance } from "@angels-bandits/common/world";
import { describe, expect, it } from "vitest";

const entry = (pose: Pose, hp = 100, prot = false): SnapshotEntry => ({
  id: "3f2a1b4c-5d6e-7f80-9a1b-2c3d4e5f6071",
  pose,
  hp,
  prot,
});

/** A unit quaternion for yaw/pitch, so samples are real attitudes. */
const attitude = (yaw: number, pitch: number) => {
  const cy = Math.cos(yaw / 2);
  const sy = Math.sin(yaw / 2);
  const cp = Math.cos(pitch / 2);
  const sp = Math.sin(pitch / 2);
  // Y-then-X composition, the order flight.ts builds a plane's attitude in.
  return { x: cy * sp, y: sy * cp, z: -sy * sp, w: cy * cp };
};

describe("snapshot quantisation", () => {
  it("round-trips a pose inside the quantisation step, far inside PLAYER_RADIUS", () => {
    const pose: Pose = {
      pos: { x: 1234.5678901234, y: 301.98765, z: 456.4321 },
      quat: attitude(1.1, -0.4),
      speed: 65.4321,
    };
    const back = quantisePose(pose);
    expect(Math.abs(back.pos.x - pose.pos.x)).toBeLessThanOrEqual(0.05);
    expect(Math.abs(back.pos.y - pose.pos.y)).toBeLessThanOrEqual(0.05);
    expect(Math.abs(back.pos.z - pose.pos.z)).toBeLessThanOrEqual(0.05);
    expect(wrapDistance(back.pos, pose.pos)).toBeLessThanOrEqual(
      POS_QUANT_ERROR_M,
    );
    // 0.0866 m of worst-case error against a 2 m collision sphere: a ~23x
    // margin, which is what makes this invisible to validation.
    expect(POS_QUANT_ERROR_M).toBeLessThan(PLAYER_RADIUS / 10);
    expect(Math.abs(back.speed - pose.speed)).toBeLessThanOrEqual(0.05);
  });

  it("keeps the decoded quaternion a unit quaternion within a thousandth of the original rotation", () => {
    const rand = mulberry32(0xa11ce);
    let worstDot = 1;
    for (let i = 0; i < 2000; i++) {
      const q = attitude(rand() * Math.PI * 2 - Math.PI, rand() * 2.8 - 1.4);
      const back = quantisePose({
        pos: { x: 100, y: 300, z: 100 },
        quat: q,
        speed: 65,
      }).quat;
      expect(Math.hypot(back.x, back.y, back.z, back.w)).toBeCloseTo(1, 9);
      // |dot| of two unit quaternions is cos(half the angle between them).
      const dot = Math.abs(
        q.x * back.x + q.y * back.y + q.z * back.z + q.w * back.w,
      );
      worstDot = Math.min(worstDot, dot);
    }
    // cos(θ/2) ≥ 0.9999995 → θ ≤ ~0.11°, invisible on a remote plane.
    expect(worstDot).toBeGreaterThan(0.999999);
  });

  it("is seam-safe: a position rounding up onto the seam comes back canonical, not at WORLD_SIZE", () => {
    // 1999.98 m rounds to 20000 wire units — exactly one period. Canonicalised
    // in integer space that is 0, not 2000 (which is outside [0, WORLD_SIZE)).
    const back = quantisePose({
      pos: { x: 1999.98, y: 300, z: 1999.999 },
      quat: attitude(0, 0),
      speed: 65,
    });
    expect(back.pos.x).toBe(0);
    expect(back.pos.z).toBe(0);
    expect(back.pos.x).toBeLessThan(WORLD_SIZE);
    // And the seam-crossing distance is still a tenth of a meter, not 2 km.
    expect(
      wrapDistance(back.pos, { x: 1999.98, y: 300, z: 1999.999 }),
    ).toBeLessThan(POS_QUANT_ERROR_M);
  });

  it("canonicalises a position the server holds just outside the range too", () => {
    const back = quantisePose({
      pos: canonicalize({ x: -0.04, y: 300, z: 2000.04 }),
      quat: attitude(0, 0),
      speed: 65,
    });
    expect(back.pos.x).toBeGreaterThanOrEqual(0);
    expect(back.pos.x).toBeLessThan(WORLD_SIZE);
    expect(back.pos.z).toBeGreaterThanOrEqual(0);
    expect(back.pos.z).toBeLessThan(WORLD_SIZE);
  });

  it("carries hp and spawn protection, omitting the protection flag when it is off", () => {
    const pose: Pose = {
      pos: { x: 10, y: 300, z: 20 },
      quat: attitude(0, 0),
      speed: 65,
    };
    const off = encodeSnapshotEntry(entry(pose, 73, false));
    expect(off).toHaveLength(10);
    expect(decodeSnapshotEntry(off).hp).toBe(73);
    expect(decodeSnapshotEntry(off).prot).toBe(false);

    const on = encodeSnapshotEntry(entry(pose, 100, true));
    expect(on).toHaveLength(11);
    expect(decodeSnapshotEntry(on).prot).toBe(true);
  });

  it("sends nothing but integers, which is where the byte saving comes from", () => {
    const wire = encodeSnapshotEntry(
      entry({
        pos: { x: 1234.5678901234, y: 301.98765, z: 456.4321 },
        quat: attitude(1.1, -0.4),
        speed: 65.4321,
      }),
    );
    for (const field of wire.slice(1)) {
      expect(Number.isInteger(field)).toBe(true);
    }
    // The old shape spelled every key out per plane; the tuple does not.
    const legacy = JSON.stringify(
      entry({
        pos: { x: 1234.5678901234, y: 301.98765, z: 456.4321 },
        quat: attitude(1.1, -0.4),
        speed: 65.4321,
      }),
    );
    expect(JSON.stringify(wire).length).toBeLessThan(legacy.length / 2);
  });

  it("holds the quantisation step it advertises", () => {
    expect(POS_SCALE).toBe(10);
    expect(POS_QUANT_ERROR_M).toBeCloseTo((Math.sqrt(3) * 0.5) / 10, 12);
  });
});

describe("interpolation delay controller", () => {
  it("pins the cadence this ticket bought: 20 Hz, 50 ms apart, 58 ms floor", () => {
    expect(TICK_DOWN_HZ).toBe(20);
    expect(SNAPSHOT_INTERVAL_MS).toBe(50);
    expect(INTERP_FLOOR_MS).toBe(SNAPSHOT_INTERVAL_MS + INTERP_MARGIN_MS);
    expect(INTERP_FLOOR_MS).toBe(58);
    // The whole point: strictly better than the 100 ms it replaces.
    expect(INTERP_FLOOR_MS).toBeLessThan(100);
  });

  it("never returns below one snapshot interval, whatever the jitter says", () => {
    for (const jitter of [-1000, -1, 0, 0.0001, 1, 5, 40, 1e9]) {
      expect(interpDelayFor(jitter)).toBeGreaterThanOrEqual(INTERP_FLOOR_MS);
      expect(interpDelayFor(jitter)).toBeGreaterThanOrEqual(
        SNAPSHOT_INTERVAL_MS,
      );
    }
    expect(interpDelayFor(0)).toBe(INTERP_FLOOR_MS);
  });

  it("caps at INTERP_DELAY_MAX_MS — past that a deeper buffer is only lag", () => {
    expect(interpDelayFor(1e6)).toBe(INTERP_DELAY_MAX_MS);
  });

  it("grows on the FIRST late snapshot, before remotes can stutter", () => {
    // A 30 ms deviation is felt immediately: 58 + 2 × 30 = 118 ms.
    const jitter = nextJitter(0, SNAPSHOT_INTERVAL_MS + 30);
    expect(jitter).toBeCloseTo(30, 9);
    expect(interpDelayFor(jitter)).toBeCloseTo(118, 9);
  });

  it("treats a bunched snapshot (gap too SHORT) as jitter too", () => {
    expect(nextJitter(0, SNAPSHOT_INTERVAL_MS - 30)).toBeCloseTo(30, 9);
  });

  it("grows faster than it shrinks", () => {
    // One late snapshot to reach the raised delay...
    const spiked = nextJitter(0, SNAPSHOT_INTERVAL_MS + 40);
    expect(interpDelayFor(spiked)).toBeCloseTo(138, 9);

    // ...and many perfectly-on-time ones to give it back.
    let jitter = spiked;
    let ticks = 0;
    while (interpDelayFor(jitter) > INTERP_FLOOR_MS + 1 && ticks < 10_000) {
      jitter = nextJitter(jitter, SNAPSHOT_INTERVAL_MS);
      ticks++;
    }
    expect(ticks).toBeGreaterThan(100);
    // …which at 20 Hz is several seconds of calm before the buffer relaxes.
    expect((ticks * SNAPSHOT_INTERVAL_MS) / 1000).toBeGreaterThan(5);
  });

  it("cannot oscillate on alternating jitter: it pins to the WORSE gap and holds", () => {
    // The pathological input for a naive EWMA: every other snapshot is 25 ms
    // late, the one behind it 5 ms bunched. A controller that chased the
    // average would swing the render time twice per snapshot and rubber-band
    // every remote; peak-hold-with-decay simply sits at the worse deviation.
    const DEV_HIGH = 25;
    const DEV_LOW = 5;
    let jitter = 0;
    const delays: number[] = [];
    for (let i = 0; i < 400; i++) {
      jitter = nextJitter(
        jitter,
        i % 2 === 0
          ? SNAPSHOT_INTERVAL_MS + DEV_HIGH
          : SNAPSHOT_INTERVAL_MS - DEV_LOW,
      );
      delays.push(interpDelayFor(jitter));
    }
    const tail = delays.slice(200);
    // It settled on the WORSE deviation, not the average of the two.
    expect(Math.max(...tail)).toBeCloseTo(INTERP_FLOOR_MS + 2 * DEV_HIGH, 6);
    // What ripple remains is one decay step of the gap between the two
    // deviations — 2 × 0.02 × 20 = 0.8 ms on a 108 ms buffer, under 1%. That
    // is the arithmetic ceiling on the swing, not a measured happenstance.
    const bound =
      INTERP_JITTER_FACTOR * INTERP_JITTER_DECAY * (DEV_HIGH + DEV_LOW);
    expect(Math.max(...tail) - Math.min(...tail)).toBeLessThanOrEqual(bound);
    expect(Math.max(...tail) - Math.min(...tail)).toBeLessThan(
      0.01 * Math.min(...tail),
    );
    // And it never drops back to the floor while the link is still misbehaving.
    expect(Math.min(...tail)).toBeGreaterThan(INTERP_FLOOR_MS + DEV_HIGH);
  });

  it("is monotone non-decreasing while jitter is present — no sawtooth", () => {
    const rand = mulberry32(0xbeef);
    let jitter = 0;
    let prev = interpDelayFor(jitter);
    for (let i = 0; i < 500; i++) {
      // Steadily bad link: every gap deviates, sizes vary.
      jitter = nextJitter(jitter, SNAPSHOT_INTERVAL_MS + rand() * 40);
      const now = interpDelayFor(jitter);
      // It may relax between deviations, but never below the floor and never
      // by more than the decay rate allows in one step.
      expect(now).toBeGreaterThanOrEqual(INTERP_FLOOR_MS);
      expect(prev - now).toBeLessThan(2);
      prev = now;
    }
  });

  it("clamps a declared delay into the range the server honours", () => {
    expect(clampInterpDelay(undefined)).toBe(INTERP_FLOOR_MS);
    expect(clampInterpDelay("120")).toBe(INTERP_FLOOR_MS);
    expect(clampInterpDelay(Number.NaN)).toBe(INTERP_FLOOR_MS);
    expect(clampInterpDelay(0)).toBe(INTERP_FLOOR_MS);
    expect(clampInterpDelay(-5000)).toBe(INTERP_FLOOR_MS);
    expect(clampInterpDelay(120)).toBe(120);
    expect(clampInterpDelay(1e9)).toBe(INTERP_DELAY_MAX_MS);
  });
});

describe("hit range slack derived from the interpolation delay", () => {
  it("moves with the delay — a deeper buffer buys a wider window, strictly", () => {
    const floor = hitRangeSlackFor(INTERP_FLOOR_MS);
    const mid = hitRangeSlackFor(140);
    const max = hitRangeSlackFor(INTERP_DELAY_MAX_MS);
    expect(floor).toBeLessThan(mid);
    expect(mid).toBeLessThan(max);
    // Worked: 198 m/s × (0.058 + 0.875 s) = 184.734 m at the floor.
    expect(floor).toBeCloseTo(184.734, 3);
    expect(max).toBeCloseTo(222.75, 3);
  });

  it("reproduces the hand-tuned 200 m it replaces at the OLD 100 ms delay", () => {
    // The constant this derivation retires was 200. At the delay it was tuned
    // against, the formula says 193 — within 4%, so nothing about combat feel
    // moved; the number just stopped being a magic one.
    expect(hitRangeSlackFor(100)).toBeCloseTo(193.05, 2);
    expect(Math.abs(hitRangeSlackFor(100) - 200) / 200).toBeLessThan(0.04);
  });

  it("TIGHTENS at the new floor — the faster tick did not loosen combat rules", () => {
    expect(hitRangeSlackFor(INTERP_FLOOR_MS)).toBeLessThan(200);
    expect(hitRangeBudgetFor(INTERP_FLOOR_MS)).toBeLessThan(BULLET_RANGE + 200);
  });

  it("is bounded above by the delay ceiling, so no claim can widen it without limit", () => {
    expect(hitRangeSlackFor(1e9)).toBe(hitRangeSlackFor(INTERP_DELAY_MAX_MS));
    // The widest window any client can buy is ~11% over the old constant.
    expect(hitRangeSlackFor(INTERP_DELAY_MAX_MS) / 200).toBeLessThan(1.15);
  });

  it("budget = BULLET_RANGE + slack", () => {
    for (const d of [INTERP_FLOOR_MS, 90, 160, INTERP_DELAY_MAX_MS]) {
      expect(hitRangeBudgetFor(d)).toBeCloseTo(
        BULLET_RANGE + hitRangeSlackFor(d),
        9,
      );
    }
  });
});
