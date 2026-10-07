// Signage layout seam (S2): pure deterministic placement derived from
// (world seed, building) — no Math.random, no THREE (mirrors the
// roofClutterFor idiom). Hand-built worked examples pin the rules; the real
// seed-42 city pins determinism and roadway safety in aggregate. Street
// geometry facts come from the S1 contract (isInRoadway), never re-derived.

import { type Building, generateCity } from "@angels-bandits/common/city";
import { isInRoadway } from "@angels-bandits/common/city/street";
import { CITY_SEED, EMISSIVE_SIGN } from "@angels-bandits/common/constants";
import { describe, expect, it } from "vitest";
import {
  SIGN_PALETTE,
  type SignPlacement,
  signageFor,
} from "../src/render/signage";
import {
  ANIM_CHASE,
  ANIM_GLYPH_TICKER,
  ANIM_LED_TICKER,
  ANIM_VIDEO,
  BROKEN_SHARE_MAX,
  BUZZ_RANGE_M,
  BrokenNeon,
  CHASE_GAP,
  CHASE_OFF,
  CHASE_ON,
  LED_MEAN,
  SIGN_LOOP_S,
  STUTTER_BURST_MAX_MS,
  STUTTER_DIP,
  STUTTER_FLASH_MS,
  STUTTER_SLOT_MS,
  VIDEO_BACKDROP,
  VIDEO_CUT_S,
  VIDEO_FIELD_S,
  VIDEO_PAN_S,
  VIDEO_SPIN_S,
  burstIn,
  buzzLevel,
  chaseGain,
  chaseStep,
  fieldGain,
  glyphScroll,
  inBurst,
  ledGain,
  ledScroll,
  rungPalette,
  signAnimations,
  signClock,
  spinGain,
  stutterAt,
  videoMode,
} from "../src/render/signage-anim";
import { signShaderChunks } from "../src/render/signage-shader";

// Mid-block slab at (500, 500): 120×120 footprint leaves a 25 m clearance
// between each facade and the curb ((200 − 120) / 2 − 15) — signs fit.
const MIDRISE: Building = {
  x: 500,
  z: 500,
  width: 120,
  depth: 120,
  height: 60,
  tiers: [{ width: 120, depth: 120, height: 60 }],
};

// Maximum footprint: the facade sits ON the curb line (clearance 0), so no
// flush-mounted sign can stay out of the roadway on any face.
const MAX_FOOTPRINT: Building = {
  x: 500,
  z: 500,
  width: 170,
  depth: 170,
  height: 60,
  tiers: [{ width: 170, depth: 170, height: 60 }],
};

// Setback tower: marquees must respect TIER-1 (height 50), not the legacy
// 160 m total height.
const TOWER: Building = {
  x: 900,
  z: 300,
  width: 120,
  depth: 120,
  height: 160,
  tiers: [
    { width: 120, depth: 120, height: 50 },
    { width: 40, depth: 40, height: 110 },
  ],
};

const SEED = 42;

/** All four ground corners of a sign panel (outer face included). */
function panelCorners(s: SignPlacement): { x: number; z: number }[] {
  const half = s.width / 2;
  const out = s.depth / 2;
  if (s.axis === "x") {
    return [
      { x: s.x + s.dir * out, z: s.z - half },
      { x: s.x + s.dir * out, z: s.z + half },
      { x: s.x - s.dir * out, z: s.z - half },
      { x: s.x - s.dir * out, z: s.z + half },
    ];
  }
  return [
    { x: s.x - half, z: s.z + s.dir * out },
    { x: s.x + half, z: s.z + s.dir * out },
    { x: s.x - half, z: s.z - s.dir * out },
    { x: s.x + half, z: s.z - s.dir * out },
  ];
}

describe("signageFor — marquees", () => {
  it("is deterministic: same (building, seed) → identical layout", () => {
    expect(JSON.stringify(signageFor(MIDRISE, SEED))).toBe(
      JSON.stringify(signageFor(MIDRISE, SEED)),
    );
  });

  it("changes with the world seed", () => {
    expect(JSON.stringify(signageFor(MIDRISE, SEED))).not.toBe(
      JSON.stringify(signageFor(MIDRISE, 43)),
    );
  });

  it("dresses a mid-block slab with at least one marquee", () => {
    expect(signageFor(MIDRISE, SEED).marquees.length).toBeGreaterThan(0);
  });

  it("skips every face of a max-footprint building (facade on the curb)", () => {
    expect(signageFor(MAX_FOOTPRINT, SEED).marquees).toHaveLength(0);
  });

  it("keeps marquee dims in the plan's ranges: 2–3 wide, 8–25 tall, bottom 4–8 up", () => {
    for (const m of signageFor(MIDRISE, SEED).marquees) {
      expect(m.width).toBeGreaterThanOrEqual(2);
      expect(m.width).toBeLessThanOrEqual(3);
      expect(m.height).toBeGreaterThanOrEqual(8);
      expect(m.height).toBeLessThanOrEqual(25);
      expect(m.y).toBeGreaterThanOrEqual(4);
      expect(m.y).toBeLessThanOrEqual(8);
    }
  });

  it("caps marquees at the TIER-1 face, never the total building height", () => {
    const tier1Top = 50;
    const marquees = signageFor(TOWER, SEED).marquees;
    expect(marquees.length).toBeGreaterThan(0);
    for (const m of marquees) {
      expect(m.y + m.height).toBeLessThanOrEqual(tier1Top);
    }
  });

  it("mounts marquees flush on a tier-1 facade plane", () => {
    // MIDRISE facade planes: x or z at 440 / 560 (500 ± 60); a flush sign's
    // center sits depth/2 outside one of them.
    for (const m of signageFor(MIDRISE, SEED).marquees) {
      const facadeCoord = m.axis === "x" ? m.x : m.z;
      const expected = 500 + m.dir * (60 + m.depth / 2);
      expect(facadeCoord).toBeCloseTo(expected, 6);
    }
  });

  it("never puts any part of any sign in the roadway, across the whole seed-42 city", () => {
    for (const b of generateCity(CITY_SEED)) {
      const s = signageFor(b, CITY_SEED);
      for (const sign of [...s.marquees, ...s.billboards, ...s.strips]) {
        for (const c of panelCorners(sign)) {
          expect(isInRoadway({ x: c.x, y: 0, z: c.z })).toBe(false);
        }
      }
    }
  });

  it("keeps every sign in canonical [0, 2000) coordinates", () => {
    for (const b of generateCity(CITY_SEED)) {
      const s = signageFor(b, CITY_SEED);
      for (const sign of [...s.marquees, ...s.billboards, ...s.strips]) {
        expect(sign.x).toBeGreaterThanOrEqual(0);
        expect(sign.x).toBeLessThan(2000);
        expect(sign.z).toBeGreaterThanOrEqual(0);
        expect(sign.z).toBeLessThan(2000);
      }
    }
  });
});

describe("signageFor — billboards", () => {
  it("keeps billboard dims in the plan's 8×5 to 16×9 m envelope, lower facade", () => {
    let seen = 0;
    for (const b of generateCity(CITY_SEED)) {
      for (const bb of signageFor(b, CITY_SEED).billboards) {
        seen++;
        expect(bb.width).toBeGreaterThanOrEqual(8);
        expect(bb.width).toBeLessThanOrEqual(16);
        expect(bb.height).toBeGreaterThanOrEqual(5);
        expect(bb.height).toBeLessThanOrEqual(9);
        // Lower facade: the whole quad stays on tier 1.
        const tier1 = b.tiers[0];
        expect(tier1).toBeDefined();
        if (tier1) expect(bb.y + bb.height).toBeLessThanOrEqual(tier1.height);
      }
    }
    expect(seen).toBeGreaterThan(0);
  });

  it("caps billboards at the plan's 0–2 per street-facing facade", () => {
    for (const b of generateCity(CITY_SEED)) {
      expect(signageFor(b, CITY_SEED).billboards.length).toBeLessThanOrEqual(8);
    }
  });

  it("concentrates signage near landmarks: hot block outdraws a far side street", () => {
    // Block (2, 3) is a LANDMARK_BLOCK (center 500, 700 — heat 1); block
    // (1, 0) (center 300, 100) is ≥3 blocks from every landmark AND plaza
    // (wrap-aware Chebyshev, verified by hand) — heat 0. Same dims, same
    // seed: only the block position differs.
    const dims = {
      width: 120,
      depth: 120,
      height: 60,
      tiers: [{ width: 120, depth: 120, height: 60 }],
    };
    const hot = signageFor({ x: 500, z: 700, ...dims }, SEED);
    const cold = signageFor({ x: 300, z: 100, ...dims }, SEED);
    const count = (s: ReturnType<typeof signageFor>) =>
      s.marquees.length + s.billboards.length;
    expect(count(hot)).toBeGreaterThan(count(cold));
  });
});

describe("signageFor — storefront strips", () => {
  it("bands every sidewalk-facing facade: 4 strips on the mid-block slab", () => {
    expect(signageFor(MIDRISE, SEED).strips).toHaveLength(4);
  });

  it("skips strips where the facade sits on the curb", () => {
    expect(signageFor(MAX_FOOTPRINT, SEED).strips).toHaveLength(0);
  });

  it("sits the band above the shop-glow line (shader shop band tops at 4 m)", () => {
    // 4.0 is SHOP_BAND_HEIGHT in buildings-material.ts — the storefront
    // glass the strip must clear.
    for (const s of signageFor(MIDRISE, SEED).strips) {
      expect(s.y).toBeGreaterThanOrEqual(4);
      expect(s.height).toBeLessThanOrEqual(1);
    }
  });

  it("runs the strip along the facade without reaching the corners", () => {
    for (const s of signageFor(MIDRISE, SEED).strips) {
      // MIDRISE faces are 120 m long, centered on 500.
      expect(s.width).toBeLessThan(120);
      const along = s.axis === "x" ? s.z : s.x;
      expect(along).toBeCloseTo(500, 6);
    }
  });
});

describe("signageFor — neon spill", () => {
  it("pools under a dense hotspot cluster, never under a bare facade", () => {
    // Landmark-block building (heat 1) — dense facades spill; the
    // max-footprint building has no signs at all, so nothing to spill.
    const hot = signageFor(
      {
        x: 500,
        z: 700,
        width: 120,
        depth: 120,
        height: 60,
        tiers: [{ width: 120, depth: 120, height: 60 }],
      },
      SEED,
    );
    expect(hot.spills.length).toBeGreaterThan(0);
    expect(signageFor(MAX_FOOTPRINT, SEED).spills).toHaveLength(0);
  });

  it("centers every pool on the sidewalk — never in the roadway", () => {
    for (const b of generateCity(CITY_SEED)) {
      for (const p of signageFor(b, CITY_SEED).spills) {
        expect(isInRoadway({ x: p.x, y: 0, z: p.z })).toBe(false);
        expect(p.x).toBeGreaterThanOrEqual(0);
        expect(p.x).toBeLessThan(2000);
        expect(p.z).toBeGreaterThanOrEqual(0);
        expect(p.z).toBeLessThan(2000);
      }
    }
  });

  it("keeps pool radii in the lamp-glow ballpark (2–8 m)", () => {
    for (const b of generateCity(CITY_SEED)) {
      for (const p of signageFor(b, CITY_SEED).spills) {
        expect(p.radius).toBeGreaterThanOrEqual(2);
        expect(p.radius).toBeLessThanOrEqual(8);
      }
    }
  });
});

// --- L7 animated signage: the schedule seam (signage-anim.ts) ---

/** The whole city's sign lists, in the Signage renderer's order. */
function citySigns(seed: number) {
  const layouts = generateCity(seed).map((b) => signageFor(b, seed));
  return {
    marquees: layouts.flatMap((s) => s.marquees),
    billboards: layouts.flatMap((s) => s.billboards),
    strips: layouts.flatMap((s) => s.strips),
  };
}
const CITY = citySigns(CITY_SEED);
const ANIM = signAnimations(
  CITY.marquees,
  CITY.billboards,
  CITY.strips,
  CITY_SEED,
);
const ALL_ANIMS = [...ANIM.marquees, ...ANIM.billboards, ...ANIM.strips];

describe("signAnimations — deterministic in time", () => {
  it("assigns the same animation to the same sign on every client", () => {
    const again = signAnimations(
      CITY.marquees,
      CITY.billboards,
      CITY.strips,
      CITY_SEED,
    );
    expect(JSON.stringify(again)).toBe(JSON.stringify(ANIM));
  });

  it("runs every animated kind somewhere in the seed-42 city", () => {
    const kinds = new Set(ALL_ANIMS.map((a) => a.kind));
    for (const k of [
      ANIM_GLYPH_TICKER,
      ANIM_CHASE,
      ANIM_VIDEO,
      ANIM_LED_TICKER,
    ]) {
      expect(kinds.has(k)).toBe(true);
    }
  });

  it("maps synced ms onto one wrapped shader clock", () => {
    const L = SIGN_LOOP_S * 1000;
    for (const ms of [0, 1234.5, 1_791_337_653_270, -5000]) {
      expect(signClock(ms)).toBeGreaterThanOrEqual(0);
      expect(signClock(ms)).toBeLessThan(SIGN_LOOP_S);
      expect(signClock(ms + L)).toBeCloseTo(signClock(ms), 6);
    }
  });

  it("is the same frame at t = L as at t = 0 (the clock wrap is invisible)", () => {
    for (const a of ALL_ANIMS) {
      if (a.kind === ANIM_GLYPH_TICKER) {
        const d = glyphScroll(a, SIGN_LOOP_S) - glyphScroll(a, 0);
        expect(Math.abs(d - Math.round(d))).toBeLessThan(1e-9);
      }
      if (a.kind === ANIM_CHASE) {
        expect((chaseStep(a, SIGN_LOOP_S) - chaseStep(a, 0)) % 3).toBe(0);
      }
      if (a.kind === ANIM_LED_TICKER) {
        expect(ledScroll(a, SIGN_LOOP_S)).toBeCloseTo(ledScroll(a, 0), 6);
      }
      if (a.kind === ANIM_VIDEO) {
        expect(videoMode(a, SIGN_LOOP_S)).toBe(videoMode(a, 0));
      }
    }
    // Pure-time shader periods divide the loop exactly.
    for (const period of [VIDEO_FIELD_S, VIDEO_SPIN_S, VIDEO_PAN_S]) {
      expect(SIGN_LOOP_S % period).toBe(0);
    }
    // Video cuts are ≥ 8 s apart and keep the 3-programme rotation aligned.
    for (const cut of VIDEO_CUT_S) {
      expect(cut).toBeGreaterThanOrEqual(8);
      expect((SIGN_LOOP_S / cut) % 3).toBe(0);
    }
  });

  it("stutters identically for the same (tube, synced ms)", () => {
    const seed = ANIM.broken[0]?.seed ?? 1;
    const tube = new BrokenNeon([{ seed, center: { x: 0, y: 0, z: 0 } }]);
    for (let ms = 0; ms < 5 * 60_000; ms += 7) {
      expect(tube.level(0, ms)).toBe(stutterAt(seed, ms));
    }
  });
});

describe("broken neon — rare, and never reads as a flicker bug", () => {
  it("breaks at most 2% of signs (and at least one), across several worlds", () => {
    for (const seed of [CITY_SEED, 7, 1234]) {
      const c = seed === CITY_SEED ? CITY : citySigns(seed);
      const a =
        seed === CITY_SEED
          ? ANIM
          : signAnimations(c.marquees, c.billboards, c.strips, seed);
      const total = c.marquees.length + c.billboards.length + c.strips.length;
      expect(a.broken.length).toBeGreaterThan(0);
      expect(a.broken.length / total).toBeLessThanOrEqual(BROKEN_SHARE_MAX);
      // Only neon tubes break, each at most once.
      const flagged = [...a.marquees, ...a.strips].filter(
        (x) => x.brokenSlot >= 0,
      );
      expect(flagged).toHaveLength(a.broken.length);
      expect(a.billboards.every((x) => x.brokenSlot === -1)).toBe(true);
    }
  });

  it("keeps bursts ≤ 1.5 s and ≥ 20 s apart (analytic, 2 h of slots)", () => {
    const slots = (2 * 3_600_000) / STUTTER_SLOT_MS;
    for (const { seed } of ANIM.broken) {
      let lastEnd = Number.NEGATIVE_INFINITY;
      let bursts = 0;
      for (let s = 0; s < slots; s++) {
        const b = burstIn(seed, s);
        if (!b) continue;
        bursts++;
        const start = s * STUTTER_SLOT_MS + b.start;
        expect(b.duration).toBeLessThanOrEqual(STUTTER_BURST_MAX_MS);
        expect(start - lastEnd).toBeGreaterThanOrEqual(20_000);
        lastEnd = start + b.duration;
      }
      // "Occasionally": it does happen, but nowhere near every slot.
      expect(bursts).toBeGreaterThan(0);
      expect(bursts).toBeLessThan(slots);
    }
  });

  it("agrees when sampled every 10 ms: short bursts, long gaps, gentle dips", () => {
    // Collect violations and assert once — 10 min × 100 Hz per tube.
    const bad: string[] = [];
    let bursts = 0;
    for (const { seed } of ANIM.broken.slice(0, 3)) {
      let runStart = -1;
      let lastEnd = Number.NEGATIVE_INFINITY;
      let lastDip = Number.NEGATIVE_INFINITY;
      let wasDipped = false;
      for (let ms = 0; ms <= 10 * 60_000; ms += 10) {
        const on = inBurst(seed, ms);
        if (on && runStart < 0) {
          runStart = ms;
          bursts++;
          if (ms - lastEnd < 20_000) bad.push(`gap ${seed}@${ms}`);
        }
        if (!on && runStart >= 0) {
          if (ms - runStart > STUTTER_BURST_MAX_MS + 10) {
            bad.push(`long ${seed}@${ms}`);
          }
          lastEnd = ms;
          runStart = -1;
        }
        const level = stutterAt(seed, ms);
        // Never black, never brighter than healthy.
        if (level < STUTTER_DIP || level > 1) bad.push(`level ${seed}@${ms}`);
        const dipped = level < 1;
        if (dipped && !on) bad.push(`dip outside burst ${seed}@${ms}`);
        if (dipped && !wasDipped) {
          // ≤ 3 dips per second (photosensitivity guidance).
          if (ms - lastDip < STUTTER_FLASH_MS - 10)
            bad.push(`fast ${seed}@${ms}`);
          lastDip = ms;
        }
        wasDipped = dipped;
      }
    }
    expect(bad).toEqual([]);
    expect(bursts).toBeGreaterThan(0);
  });

  it("buzzes only up close: 1 at the tube, falling to silence at 45 m", () => {
    expect(buzzLevel(0)).toBe(1);
    expect(buzzLevel(BUZZ_RANGE_M)).toBe(0);
    expect(buzzLevel(500)).toBe(0);
    let prev = 1;
    for (let d = 0; d <= BUZZ_RANGE_M; d += 0.5) {
      const v = buzzLevel(d);
      expect(v).toBeLessThanOrEqual(prev);
      prev = v;
    }
  });
});

describe("animated signage — peak stays on the SIGN rung", () => {
  it("never lifts a sign above its tint: every effect gain ≤ 1", () => {
    for (const g of [
      CHASE_ON,
      CHASE_OFF,
      CHASE_GAP,
      VIDEO_BACKDROP,
      LED_MEAN,
    ]) {
      expect(g).toBeGreaterThanOrEqual(0);
      expect(g).toBeLessThanOrEqual(1);
    }
    for (let bulb = 0; bulb < 9; bulb++) {
      for (let step = -3; step < 6; step++) {
        expect(chaseGain(bulb, step)).toBeLessThanOrEqual(1);
      }
    }
    for (const lit of [true, false]) {
      for (let dot = 0; dot <= 1; dot += 0.25) {
        for (let fade = 0; fade <= 1; fade += 0.25) {
          expect(ledGain(lit, dot, fade)).toBeLessThanOrEqual(1);
          expect(ledGain(lit, dot, fade)).toBeGreaterThanOrEqual(0);
        }
      }
    }
    for (let x = -3; x <= 3; x += 0.01) {
      expect(fieldGain(x)).toBeLessThanOrEqual(1 + 1e-12);
      expect(spinGain(x * 10)).toBeLessThanOrEqual(1 + 1e-12);
    }
  });

  it("mixes video colour fields only between hues ON the rung", () => {
    const lum = (c: { r: number; g: number; b: number }) =>
      0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    for (const c of rungPalette(SIGN_PALETTE, EMISSIVE_SIGN)) {
      expect(lum(c)).toBeCloseTo(EMISSIVE_SIGN, 9);
    }
  });

  it("runs the very constants the tests pin (TS → GLSL interpolation)", () => {
    const f = (x: number) => x.toFixed(6);
    const strip = signShaderChunks("strip", 1, ANIM.broken.length);
    expect(strip.fragmentColor).toContain(f(LED_MEAN));
    expect(strip.fragmentPars).toContain(f(SIGN_LOOP_S));
    expect(strip.fragmentPars).toContain(f(EMISSIVE_SIGN));
    const marquee = signShaderChunks("marquee", 16, ANIM.broken.length);
    for (const g of [CHASE_ON, CHASE_OFF, CHASE_GAP]) {
      expect(marquee.fragmentColor).toContain(f(g));
    }
    const billboard = signShaderChunks("billboard", 8, ANIM.broken.length);
    expect(billboard.fragmentColor).toContain(f(VIDEO_BACKDROP));
    expect(billboard.fragmentColor).toContain(f(VIDEO_SPIN_S));
    expect(billboard.fragmentMap).toContain(f(VIDEO_PAN_S));
    // The stutter array is sized for every broken tube.
    expect(strip.vertexPars).toContain(
      `SIGN_STUTTER_VEC4S ${Math.ceil(ANIM.broken.length / 4)}`,
    );
  });
});
