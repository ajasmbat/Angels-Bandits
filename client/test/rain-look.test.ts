// R3 rain readability (client/src/render/rain-look.ts): the streaks fall
// along gravity + wind (never a radial fan out of the flight path), thin out
// with speed, and never cover more than 8 % of the screen — checked against
// an independent Monte Carlo projection of the drop field, at the worst
// screen the resolution scaler can reach.

import { mulberry32 } from "@angels-bandits/common/city";
import { BOOST_MAX_SPEED, MIN_SPEED } from "@angels-bandits/common/constants";
import { describe, expect, it } from "vitest";
import { QUALITY_PROFILES, type QualityTier } from "../src/render/quality";
import {
  RAIN_BOX_XZ,
  RAIN_BOX_Y,
  RAIN_COVERAGE_CAP,
  RAIN_FADE_END,
  RAIN_FALL_SPEED,
  RAIN_MAX_DROPS,
  RAIN_NEAR_CUT,
  RAIN_THIN_BAND,
  type RainLook,
  STREAK_COVERAGE_BUDGET,
  type V3,
  focalPx,
  rainCount,
  rainCoverage,
  rainSpeedLook,
  streakDir,
  streakWidthPx,
} from "../src/render/rain-look";
import { RESOLUTION_FLOOR } from "../src/render/resolution";
import { lensDropsBackground } from "../src/ui/hud";

const DEG = 180 / Math.PI;
const angle = (a: V3, b: V3): number =>
  Math.acos(
    Math.min(
      1,
      (a.x * b.x + a.y * b.y + a.z * b.z) /
        (Math.hypot(a.x, a.y, a.z) * Math.hypot(b.x, b.y, b.z)),
    ),
  ) * DEG;
const look = (speed: number): RainLook =>
  rainSpeedLook(speed, { density: 0, alpha: 0, length: 0, lens: 0 });
/** The drawn share of the drops (the shader's hash threshold + band). */
const drawn = (l: RainLook): number =>
  Math.min(1, l.density * (1 + RAIN_THIN_BAND));

// The wind the drops drift with (rain.ts: 1.5–6.5 m/s), in any heading.
const FALLS: V3[] = [];
for (const drift of [0, 1.5, 6.5]) {
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2 + 0.3;
    FALLS.push({
      x: Math.cos(a) * drift,
      y: -RAIN_FALL_SPEED,
      z: Math.sin(a) * drift,
    });
  }
}
// Flight directions: every heading, level, climbing and diving.
const FLIGHTS: V3[] = [];
for (let h = 0; h < 8; h++) {
  for (const p of [-1.2, -0.5, 0, 0.5, 1.2]) {
    const yaw = (h * Math.PI) / 4;
    FLIGHTS.push({
      x: Math.cos(p) * Math.sin(yaw),
      y: Math.sin(p),
      z: Math.cos(p) * Math.cos(yaw),
    });
  }
}

describe("streak orientation", () => {
  it("is the fall itself when the camera is still", () => {
    for (const fall of FALLS) {
      const d = streakDir(fall, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
      expect(angle(d, fall)).toBeLessThan(1e-3);
      expect(Math.hypot(d.x, d.y, d.z)).toBeCloseTo(1, 9);
    }
  });

  it("stays within 30° of gravity + wind at 125 m/s, any flight direction", () => {
    let worst = 0;
    for (const fall of FALLS) {
      for (const f of FLIGHTS) {
        for (const speed of [40, 80, BOOST_MAX_SPEED]) {
          const cam = { x: f.x * speed, y: f.y * speed, z: f.z * speed };
          const d = streakDir(fall, cam, { x: 0, y: 0, z: 0 });
          worst = Math.max(worst, angle(d, fall));
        }
      }
    }
    expect(worst).toBeLessThanOrEqual(30);
  });

  it("never lines up with the flight path (the warp fan)", () => {
    // Level flight at full boost. The old streak ran along the RELATIVE
    // velocity — within a few degrees of the flight line, so every streak
    // fanned out of the vanishing point; the drop's own fall stays well
    // clear of that line even with the wind blowing straight down it.
    const line = (a: V3, b: V3): number => {
      const t = angle(a, b);
      return Math.min(t, 180 - t);
    };
    for (const fall of FALLS) {
      for (const f of FLIGHTS.filter((v) => v.y === 0)) {
        const v = BOOST_MAX_SPEED;
        const cam = { x: f.x * v, y: 0, z: f.z * v };
        const rel = { x: fall.x - cam.x, y: fall.y, z: fall.z - cam.z };
        expect(line(rel, f)).toBeLessThan(10);
        const d = streakDir(fall, cam, { x: 0, y: 0, z: 0 });
        expect(line(d, f)).toBeGreaterThan(40);
      }
    }
  });
});

describe("speed look", () => {
  it("thins, dims and shortens monotonically with speed", () => {
    let prev = look(MIN_SPEED);
    expect(prev.density).toBe(1);
    expect(prev.alpha).toBe(1);
    for (let s = MIN_SPEED + 5; s <= BOOST_MAX_SPEED; s += 5) {
      const l = look(s);
      expect(l.density).toBeLessThanOrEqual(prev.density);
      expect(l.alpha).toBeLessThanOrEqual(prev.alpha);
      expect(l.length).toBeLessThanOrEqual(prev.length);
      expect(l.lens).toBeGreaterThanOrEqual(prev.lens);
      prev = l;
    }
  });

  it("is sparse, faint and short at 80–125 m/s", () => {
    for (let s = 80; s <= BOOST_MAX_SPEED; s += 5) {
      const l = look(s);
      expect(l.density).toBeLessThanOrEqual(0.6);
      expect(l.alpha).toBeLessThanOrEqual(0.8);
      expect(l.length).toBeLessThanOrEqual(0.85);
    }
    expect(look(BOOST_MAX_SPEED).density).toBeLessThanOrEqual(0.3 + 1e-9);
  });
});

/**
 * Independent check of the analytic estimate: drop `count` seeded drops in
 * the box around a pinhole camera (16:9, `H` px tall, pitched by `pitch`),
 * keep the ones the shader draws (past the near cut, inside the box fade,
 * head on screen), project head and tail and add up length × drawn width.
 */
function monteCarlo(
  count: number,
  len: number,
  H: number,
  fov: number,
  pitch: number,
  dir: V3,
): number {
  const W = (H * 16) / 9;
  const f = focalPx(H, fov);
  const rand = mulberry32(0x5eed);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const proj = (x: number, y: number, z: number) => {
    const depth = y * sp - z * cp;
    if (depth <= 0.01) return null;
    return { u: (x / depth) * f, v: ((y * cp + z * sp) / depth) * f };
  };
  let area = 0;
  for (let i = 0; i < count; i++) {
    const x = (rand() - 0.5) * RAIN_BOX_XZ;
    const y = (rand() - 0.5) * RAIN_BOX_Y;
    const z = (rand() - 0.5) * RAIN_BOX_XZ;
    const dist = Math.hypot(x, y, z);
    if (
      dist < RAIN_NEAR_CUT ||
      Math.hypot(x, z) > RAIN_BOX_XZ * RAIN_FADE_END ||
      Math.abs(y) > RAIN_BOX_Y * RAIN_FADE_END
    ) {
      continue;
    }
    const h = proj(x, y, z);
    if (!h || Math.abs(h.u) > W / 2 || Math.abs(h.v) > H / 2) continue;
    const t = proj(x - dir.x * len, y - dir.y * len, z - dir.z * len);
    if (!t) continue;
    area += Math.hypot(t.u - h.u, t.v - h.v) * streakWidthPx(dist, f);
  }
  return area / (W * H);
}

describe("screen coverage", () => {
  it("the analytic estimate bounds a Monte Carlo projection of the field", () => {
    const down = { x: 0, y: -1, z: 0 };
    const leaning = streakDir(
      { x: 6.5, y: -RAIN_FALL_SPEED, z: 0 },
      { x: 0, y: 0, z: -BOOST_MAX_SPEED },
      { x: 0, y: 0, z: 0 },
    );
    for (const [H, fov, pitch, dir] of [
      [720, 70, 0, down],
      [720, 70, -0.35, down],
      [270, 83, 0, leaning],
      [270, 83, -0.6, down],
      [1080, 74, 0.3, leaning],
    ] as const) {
      const est = rainCoverage(RAIN_MAX_DROPS, 1, focalPx(H, fov));
      const mc = monteCarlo(RAIN_MAX_DROPS, 1, H, fov, pitch, dir);
      expect(mc).toBeLessThanOrEqual(est);
      // …and is not so loose that the cap starves the rain.
      expect(mc).toBeGreaterThan(est * 0.4);
    }
  });

  it("rain never covers more than 8 % of the screen — any speed, FOV, tier, resolution", () => {
    // The width floor is in drawing-buffer px, so the smallest buffer is the
    // worst case: a 360-px-tall phone viewport at the scaler's floor.
    const heights = [360 * RESOLUTION_FLOOR, 540, 720, 1080, 2160];
    const lens = lensCoverage();
    let worst = 0;
    for (const H of heights) {
      for (let s = MIN_SPEED; s <= BOOST_MAX_SPEED; s += 5) {
        const l = look(s);
        // Zoom 0 + speed FOV + boost kick is 70–83°; sweep past it.
        for (let fov = 70; fov <= 90; fov += 2.5) {
          const f = focalPx(H, fov);
          for (const tier of Object.keys(QUALITY_PROFILES) as QualityTier[]) {
            for (const rain of [0.3, 0.9, 1]) {
              const n = rainCount(
                rain,
                QUALITY_PROFILES[tier].rainDensity,
                l,
                f,
              );
              const cov = rainCoverage(n, l.length, f) * drawn(l) + lens;
              worst = Math.max(worst, cov);
            }
          }
        }
      }
    }
    expect(worst).toBeLessThanOrEqual(RAIN_COVERAGE_CAP);
  });

  it("the old streaks (4 m, every drop, along the flight) were far over it", () => {
    // The bug, measured with the same estimate: why the cap exists.
    const f = focalPx(720, 74);
    expect(rainCoverage(RAIN_MAX_DROPS, 4, f)).toBeGreaterThan(0.25);
  });

  it("the lens drops stay inside their share of the budget", () => {
    expect(lensCoverage()).toBeLessThanOrEqual(
      RAIN_COVERAGE_CAP - STREAK_COVERAGE_BUDGET,
    );
  });
});

/** Worst-case share of a landscape screen the lens drops cover (their outer
 * radius, vmin, over a square screen — a wider one only dilutes them). */
function lensCoverage(): number {
  const radii = [...lensDropsBackground().matchAll(/#0000 ([\d.]+)vmin/g)].map(
    (m) => Number(m[1]),
  );
  expect(radii.length).toBeGreaterThan(10);
  return radii.reduce((a, r) => a + Math.PI * r * r, 0) / (100 * 100);
}

describe("quality tiers", () => {
  it("MOBILE draws the sparsest rain", () => {
    const tiers = Object.keys(QUALITY_PROFILES) as QualityTier[];
    const mobile = QUALITY_PROFILES.mobile.rainDensity;
    for (const t of tiers) {
      if (t !== "mobile") {
        expect(mobile).toBeLessThan(QUALITY_PROFILES[t].rainDensity);
      }
    }
    const f = focalPx(720, 70);
    for (let s = MIN_SPEED; s <= BOOST_MAX_SPEED; s += 5) {
      const l = look(s);
      for (const t of tiers) {
        expect(rainCount(1, mobile, l, f)).toBeLessThanOrEqual(
          rainCount(1, QUALITY_PROFILES[t].rainDensity, l, f),
        );
      }
    }
  });

  it("the coverage cap applies after the tier", () => {
    const l = look(MIN_SPEED);
    const f = focalPx(270, 83);
    const capped = rainCount(1, 1, l, f);
    expect(capped).toBeLessThan(RAIN_MAX_DROPS);
    expect(rainCoverage(capped, l.length, f) * drawn(l)).toBeLessThanOrEqual(
      STREAK_COVERAGE_BUDGET,
    );
    // A tier already under the cap keeps its own count.
    const mobile = QUALITY_PROFILES.mobile.rainDensity;
    expect(rainCount(1, mobile, l, focalPx(1080, 70))).toBe(
      Math.round(RAIN_MAX_DROPS * mobile),
    );
  });

  it("no rain means no streaks", () => {
    expect(rainCount(0, 1, look(80), focalPx(720, 70))).toBe(0);
  });
});
