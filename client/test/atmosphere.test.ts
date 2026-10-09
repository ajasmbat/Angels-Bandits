// S5 atmosphere: the pure placement and schedule seams under the fog banks,
// the wind litter, the heat shimmer and the glare — deterministic, wind-
// coherent, torus-safe, and inside the readability contract (planes and
// tracers stay on top).

import { BLOCK_PITCH, WORLD_SIZE } from "@angels-bandits/common/constants";
import { airDrift, windAt } from "@angels-bandits/common/wind";
import { wrapDeltaAxis } from "@angels-bandits/common/world";
import { describe, expect, it } from "vitest";
import {
  SHAFT_CAP,
  SHIMMER_AMP_PX,
  SHIMMER_PERIOD_S,
  SHIMMER_RANGE,
  SHIMMER_SLOTS,
  type ShimmerVent,
  TRACER_RUNG,
  flareCeiling,
  flarePeakGain,
  pickShimmerVents,
  shaftPeak,
  shimmerOffsetPx,
} from "../src/render/atmo-post";
import {
  BANK_ALT_MAX,
  BANK_ALT_MIN,
  BANK_OPACITY_MAX,
  BANK_RADIUS_MAX,
  BANK_RADIUS_MIN,
  BANK_SPACING,
  FOG_BANK_COUNT,
  GROUND_CLEAR,
  PUFFS_PER_BANK,
  PUFF_ALPHA,
  bankDensity,
  fogBankLayout,
  puffCentreInto,
} from "../src/render/fogbanks";
import {
  EDDY_RATE_MAX,
  HOP_PERIOD_MIN_S,
  KICK_ALT,
  KICK_LIFE_S,
  KICK_RADIUS,
  LITTER_PER_BLOCK,
  type LitterPose,
  kickAt,
  litterForBlock,
  litterPoseInto,
} from "../src/render/litter";
import { FEATURE_TIERS, QUALITY_PROFILES } from "../src/render/quality";

const SEED = 42;
const T0 = 1.8e12;

const wdist = (ax: number, az: number, bx: number, bz: number) =>
  Math.hypot(wrapDeltaAxis(ax, bx), wrapDeltaAxis(az, bz));

describe("fog banks — layout", () => {
  const banks = fogBankLayout(SEED);

  it("is a pure function of the seed", () => {
    expect(fogBankLayout(SEED)).toEqual(banks);
    expect(fogBankLayout(SEED + 1)).not.toEqual(banks);
  });

  it("lays out every bank, between the towers, within its bounds", () => {
    expect(banks.length).toBe(FOG_BANK_COUNT);
    for (const b of banks) {
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.x).toBeLessThan(WORLD_SIZE);
      expect(b.z).toBeGreaterThanOrEqual(0);
      expect(b.z).toBeLessThan(WORLD_SIZE);
      expect(b.y).toBeGreaterThanOrEqual(BANK_ALT_MIN);
      expect(b.y).toBeLessThanOrEqual(BANK_ALT_MAX);
      expect(b.radius).toBeGreaterThanOrEqual(BANK_RADIUS_MIN);
      expect(b.radius).toBeLessThanOrEqual(BANK_RADIUS_MAX);
      expect(b.puffs.length).toBe(PUFFS_PER_BANK);
      for (const p of b.puffs) {
        expect(Math.hypot(p.ox, p.oz)).toBeLessThanOrEqual(b.radius);
        // Never clipped by the street.
        expect(b.y + p.oy).toBeGreaterThanOrEqual(GROUND_CLEAR * p.size - 1e-9);
      }
    }
  });

  it("no two banks overlap — measured on the torus", () => {
    for (let i = 0; i < banks.length; i++) {
      for (let j = i + 1; j < banks.length; j++) {
        const a = banks[i];
        const b = banks[j];
        if (!a || !b) throw new Error("layout");
        expect(wdist(a.x, a.z, b.x, b.z)).toBeGreaterThanOrEqual(
          BANK_SPACING * (a.radius + b.radius),
        );
      }
    }
  });

  it("a whole bank obscures at most BANK_OPACITY_MAX along any ray", () => {
    expect(1 - (1 - PUFF_ALPHA) ** PUFFS_PER_BANK).toBeCloseTo(
      BANK_OPACITY_MAX,
      9,
    );
  });

  it("any 150 m sight line through the drifting layout stays mostly clear", () => {
    // Puffs as spheres of their drawn radius at full density; a seeded set
    // of eyes and directions at several instants. Two banks' worth is the
    // ceiling (the spacing keeps a short sight line from crossing more).
    const rand = (() => {
      let s = 7;
      return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 2 ** 32;
      };
    })();
    const limit = 1 - (1 - BANK_OPACITY_MAX) ** 2;
    const c = { x: 0, y: 0, z: 0 };
    let worst = 0;
    for (const t of [T0, T0 + 61_000, T0 + 600_000]) {
      const drift = airDrift(t);
      for (let n = 0; n < 1500; n++) {
        const eye = {
          x: rand() * WORLD_SIZE,
          y: 20 + rand() * 120,
          z: rand() * WORLD_SIZE,
        };
        const a = rand() * Math.PI * 2;
        const e = (rand() - 0.5) * 0.6;
        const dir = {
          x: Math.cos(a) * Math.cos(e),
          y: Math.sin(e),
          z: Math.sin(a) * Math.cos(e),
        };
        let clear = 1;
        for (const bank of banks) {
          for (const puff of bank.puffs) {
            puffCentreInto(bank, puff, t, drift, c);
            const rx = wrapDeltaAxis(eye.x, c.x);
            const ry = c.y - eye.y;
            const rz = wrapDeltaAxis(eye.z, c.z);
            const along = Math.min(
              150,
              Math.max(0, rx * dir.x + ry * dir.y + rz * dir.z),
            );
            const miss = Math.hypot(
              rx - dir.x * along,
              ry - dir.y * along,
              rz - dir.z * along,
            );
            if (miss < puff.size / 2) clear *= 1 - PUFF_ALPHA;
          }
        }
        worst = Math.max(worst, 1 - clear);
      }
    }
    expect(worst).toBeLessThanOrEqual(limit + 1e-9);
  });
});

describe("fog banks — drift and schedule", () => {
  const banks = fogBankLayout(SEED);

  it("rides the shared air rigidly: wrapped, and the spacing holds forever", () => {
    const a = { x: 0, y: 0, z: 0 };
    const b = { x: 0, y: 0, z: 0 };
    const b0 = banks[0];
    const b1 = banks[1];
    if (!b0 || !b1) throw new Error("layout");
    const p0 = b0.puffs[0];
    const p1 = b1.puffs[0];
    if (!p0 || !p1) throw new Error("layout");
    const d0 = airDrift(T0);
    puffCentreInto(b0, p0, T0, d0, a);
    puffCentreInto(b1, p1, T0, d0, b);
    const gap0 = wdist(a.x, a.z, b.x, b.z);
    for (const t of [T0 + 5_000, T0 + 300_000, T0 + 3_600_000]) {
      const d = airDrift(t);
      puffCentreInto(b0, p0, t, d, a);
      puffCentreInto(b1, p1, t, d, b);
      for (const v of [a.x, a.z, b.x, b.z]) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThan(WORLD_SIZE);
      }
      // The churn turns each puff about its own bank: the gap between two
      // banks' puffs moves by at most both offsets, never more.
      expect(Math.abs(wdist(a.x, a.z, b.x, b.z) - gap0)).toBeLessThanOrEqual(
        2 * BANK_RADIUS_MAX,
      );
    }
  });

  it("moves downwind, slowly (a frozen frame never jumps)", () => {
    const bank = banks[3];
    const puff = bank?.puffs[0];
    if (!bank || !puff) throw new Error("layout");
    const a = { x: 0, y: 0, z: 0 };
    const b = { x: 0, y: 0, z: 0 };
    for (const t of [T0, T0 + 77_000]) {
      puffCentreInto(bank, puff, t, airDrift(t), a);
      const t1 = t + 1000 / 60;
      puffCentreInto(bank, puff, t1, airDrift(t1), b);
      const dx = wrapDeltaAxis(a.x, b.x);
      const dz = wrapDeltaAxis(a.z, b.z);
      // < 10 cm a frame at 60 Hz.
      expect(Math.hypot(dx, dz)).toBeLessThan(0.1);
      const w = windAt(t);
      expect(dx * w.x + dz * w.z).toBeGreaterThan(-0.01);
    }
  });

  it("each bank forms and dissolves on its own cycle, continuously", () => {
    for (const bank of banks.slice(0, 6)) {
      let min = 1;
      let max = 0;
      let prev = bankDensity(bank, T0);
      for (let t = T0; t < T0 + bank.cycle * 1000; t += 1000) {
        const d = bankDensity(bank, t);
        expect(d).toBeGreaterThanOrEqual(0);
        expect(d).toBeLessThanOrEqual(1);
        expect(Math.abs(d - prev)).toBeLessThan(0.05);
        prev = d;
        min = Math.min(min, d);
        max = Math.max(max, d);
      }
      expect(min).toBe(0);
      expect(max).toBeGreaterThanOrEqual(0.74);
      // Wet air holds more of it, never past 1.
      expect(bankDensity(bank, T0, 1)).toBeGreaterThanOrEqual(
        bankDensity(bank, T0, 0),
      );
      expect(bankDensity(bank, T0, 5)).toBeLessThanOrEqual(1);
    }
  });
});

describe("wind litter — layout and pose", () => {
  const still = { x: 1, z: 0, strength: 0 };
  const pose: LitterPose = { dx: 0, y: 0, dz: 0, alpha: 0 };

  it("deals each block the same pieces wherever the camera is", () => {
    const a = litterForBlock(SEED, 3, 7);
    expect(litterForBlock(SEED, 3, 7)).toEqual(a);
    expect(litterForBlock(SEED, 4, 7)).not.toEqual(a);
    expect(a.length).toBe(LITTER_PER_BLOCK);
  });

  it("lies on the block's streets, wrapped, and never flicks faster than 2 s", () => {
    for (const [bx, bz] of [
      [0, 0],
      [9, 9],
      [4, 6],
    ] as const) {
      for (const p of litterForBlock(SEED, bx, bz)) {
        expect(p.x).toBeGreaterThanOrEqual(0);
        expect(p.x).toBeLessThan(WORLD_SIZE);
        // Within half a pitch of its block's centre (+ the street margin).
        const cx = (bx + 0.5) * BLOCK_PITCH;
        const cz = (bz + 0.5) * BLOCK_PITCH;
        expect(Math.abs(wrapDeltaAxis(cx, p.x))).toBeLessThanOrEqual(
          BLOCK_PITCH / 2 + 1,
        );
        expect(Math.abs(wrapDeltaAxis(cz, p.z))).toBeLessThanOrEqual(
          BLOCK_PITCH / 2 + 1,
        );
        expect(p.period).toBeGreaterThanOrEqual(HOP_PERIOD_MIN_S);
        expect(Math.abs(p.rate)).toBeLessThanOrEqual(EDDY_RATE_MAX);
        expect((2 * Math.PI) / Math.abs(p.rate)).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it("hops downwind and fades in and out at the ends of its cycle", () => {
    const wind = { x: 0.6, z: 0.8, strength: 1 };
    for (const p of litterForBlock(SEED, 2, 5)) {
      // Cycle start: invisible; mid-cycle: visible.
      const tStart = (1 - p.phase) * p.period;
      litterPoseInto(p, tStart + 1e-6, wind, [], pose);
      expect(pose.alpha).toBeLessThan(0.01);
      const tMid = tStart + 0.5 * p.period;
      litterPoseInto(p, tMid, wind, [], pose);
      expect(pose.alpha).toBeGreaterThan(0.99);
      expect(pose.y).toBeGreaterThanOrEqual(0.1);
      // Downwind of the eddy: the hop alone is travel·age along the wind.
      const along = pose.dx * wind.x + pose.dz * wind.z;
      expect(along).toBeGreaterThan(0.5 * p.travel * 0.5 - p.eddy);
    }
  });

  it("lies still in still air (no hop, no travel)", () => {
    for (const p of litterForBlock(SEED, 1, 1)) {
      litterPoseInto(p, 12.3, still, [], pose);
      expect(pose.y).toBeCloseTo(0.12, 9);
      expect(Math.hypot(pose.dx, pose.dz)).toBeLessThanOrEqual(
        p.eddy * 0.35 + 1e-9,
      );
    }
  });
});

describe("wind litter — the low-pass kick", () => {
  it("only a low, close, recent pass kicks", () => {
    expect(kickAt(5, 20, 0.5).lift).toBeGreaterThan(0);
    expect(kickAt(KICK_RADIUS, 20, 0.5).lift).toBe(0);
    expect(kickAt(5, KICK_ALT, 0.5).lift).toBe(0);
    expect(kickAt(5, 20, KICK_LIFE_S).lift).toBe(0);
    expect(kickAt(5, 20, -0.1).lift).toBe(0);
  });

  it("rises fast, then settles monotonically", () => {
    let prev = Number.POSITIVE_INFINITY;
    const peak = kickAt(0, 15, 0.2).lift;
    expect(kickAt(0, 15, 0.05).lift).toBeLessThan(peak);
    for (let age = 0.2; age < KICK_LIFE_S; age += 0.1) {
      const k = kickAt(0, 15, age).lift;
      expect(k).toBeLessThanOrEqual(prev + 1e-12);
      prev = k;
    }
    // Closer and lower kicks harder.
    expect(kickAt(10, 15, 0.5).lift).toBeGreaterThan(kickAt(30, 15, 0.5).lift);
    expect(kickAt(10, 15, 0.5).lift).toBeGreaterThan(kickAt(10, 50, 0.5).lift);
  });

  it("throws the pieces near the track up and away from it, across the seam", () => {
    const wind = { x: 1, z: 0, strength: 0.4 };
    const pose: LitterPose = { dx: 0, y: 0, dz: 0, alpha: 0 };
    const kicked: LitterPose = { dx: 0, y: 0, dz: 0, alpha: 0 };
    const p = litterForBlock(SEED, 0, 0)[0];
    if (!p) throw new Error("layout");
    const t = 100;
    litterPoseInto(p, t, wind, [], pose);
    // The pass's track sits 6 m off, on the far side of the torus seam.
    const src = {
      x: p.x + pose.dx - 6 + WORLD_SIZE,
      y: 18,
      z: p.z + pose.dz,
      tSec: t - 0.4,
    };
    litterPoseInto(p, t, wind, [src], kicked);
    expect(kicked.y).toBeGreaterThan(pose.y + 1);
    expect(kicked.dx).toBeGreaterThan(pose.dx); // thrown away from the track
  });
});

describe("heat shimmer", () => {
  it("never moves a pixel more than SHIMMER_AMP_PX, and only inside its column", () => {
    let peak = 0;
    for (let t = 0.01; t < 1; t += 0.03) {
      for (let l = -1; l <= 1; l += 0.1) {
        for (const s of [0, 0.7, 1.9, 1e9 + 0.3]) {
          const o = shimmerOffsetPx(t, l, s, 1);
          peak = Math.max(peak, Math.abs(o));
        }
      }
    }
    expect(peak).toBeLessThanOrEqual(SHIMMER_AMP_PX);
    expect(peak).toBeGreaterThan(SHIMMER_AMP_PX * 0.5);
    expect(shimmerOffsetPx(0, 0, 0.5, 1)).toBe(0);
    expect(shimmerOffsetPx(0.5, 1, 0.5, 1)).toBe(0);
    expect(shimmerOffsetPx(0.5, 0, 0.5, 0)).toBe(0);
  });

  it("ripples slowly: at most one reversal in half a second (period ≥ 2 s)", () => {
    expect(SHIMMER_PERIOD_S).toBeGreaterThanOrEqual(2);
    let reversals = 0;
    let prevStep = 0;
    let prev = shimmerOffsetPx(0.4, 0.2, 10, 1);
    for (let i = 1; i <= 30; i++) {
      const o = shimmerOffsetPx(0.4, 0.2, 10 + i / 60, 1);
      const step = o - prev;
      if (
        prevStep !== 0 &&
        step !== 0 &&
        Math.sign(step) !== Math.sign(prevStep)
      ) {
        reversals++;
      }
      if (step !== 0) prevStep = step;
      prev = o;
    }
    expect(reversals).toBeLessThanOrEqual(1);
  });

  const vents: ShimmerVent[] = Array.from({ length: 12 }, (_, i) => ({
    id: i,
    x: 20 * i,
    y: 60,
    z: 0,
  }));
  const dist = (v: ShimmerVent) => v.x; // the eye at the origin

  it("picks the nearest visible stacks, at most SHIMMER_SLOTS", () => {
    const picked = pickShimmerVents(vents, [], dist, () => true);
    expect(picked).toEqual([0, 1, 2, 3, 4, 5].slice(0, SHIMMER_SLOTS));
    const hidden = pickShimmerVents(vents, [], dist, (v) => v.id % 2 === 1);
    expect(hidden.every((id) => id % 2 === 1)).toBe(true);
    const far = pickShimmerVents(
      vents,
      [],
      (v) => v.x + SHIMMER_RANGE,
      () => true,
    );
    expect(far).toEqual([0]);
  });

  it("keeps a picked stack until it is well out of range (hysteresis)", () => {
    // Stack 11 sits just past the range: not picked fresh, but kept.
    const d = (v: ShimmerVent) => (v.id === 11 ? SHIMMER_RANGE * 1.1 : v.x);
    expect(pickShimmerVents(vents, [], d, () => true)).not.toContain(11);
    const kept = pickShimmerVents(vents, [11], d, () => true);
    expect(kept[0]).toBe(11);
    expect(kept.length).toBe(SHIMMER_SLOTS);
    // …and dropped once it is hidden or beyond the keep line.
    expect(pickShimmerVents(vents, [11], d, (v) => v.id !== 11)).not.toContain(
      11,
    );
    const gone = (v: ShimmerVent) => (v.id === 11 ? SHIMMER_RANGE * 2 : v.x);
    expect(pickShimmerVents(vents, [11], gone, () => true)).not.toContain(11);
  });
});

describe("glare and shafts stay under the tracer rung", () => {
  it("a flare is always dimmer than the light it comes from", () => {
    expect(flarePeakGain()).toBeLessThan(1);
    expect(flareCeiling()).toBeLessThan(TRACER_RUNG);
  });

  it("shafts are sub-bloom: capped per sample, a fraction of the cap", () => {
    expect(SHAFT_CAP).toBeLessThan(0.72);
    expect(shaftPeak()).toBeLessThan(0.72);
    expect(shaftPeak()).toBeLessThan(TRACER_RUNG);
  });
});

describe("quality tiers (S5)", () => {
  const rows = FEATURE_TIERS.filter((r) => r.feature.startsWith("S5"));

  it("every effect has a row on every tier", () => {
    for (const name of [
      "fog banks",
      "wind litter",
      "light shafts",
      "searchlight rays",
      "heat shimmer",
      "glare",
      "wet-roof",
    ]) {
      expect(rows.some((r) => r.feature.includes(name))).toBe(true);
    }
  });

  it("Mobile drops shafts, shimmer and glare; the haze is the same everywhere", () => {
    const m = QUALITY_PROFILES.mobile;
    expect(m.lightShafts).toBe(false);
    expect(m.heatShimmer).toBe(false);
    expect(m.glare).toBe(false);
    expect(QUALITY_PROFILES.high.lightShafts).toBe(true);
    expect(QUALITY_PROFILES.high.heatShimmer).toBe(true);
    const fog = rows.find((r) => r.feature.includes("fog banks"));
    expect(fog && [fog.high, fog.medium, fog.low, fog.mobile]).toEqual([
      "full",
      "full",
      "full",
      "full",
    ]);
    expect(m.litter).toBeLessThan(QUALITY_PROFILES.low.litter);
    expect(QUALITY_PROFILES.low.litter).toBeLessThan(
      QUALITY_PROFILES.high.litter,
    );
  });
});
