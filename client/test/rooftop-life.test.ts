// L8 rooftop-life layout seam: pure deterministic dressing per building —
// no Math.random, no torus image. The real seed-42 (and a second seed) city
// pins determinism, which roofs may carry life, containment, the flight-band
// height caps and the keep-outs; the clock, wrap and ladder rules are pinned
// against their TS mirrors.

import { type Building, generateCity } from "@angels-bandits/common/city";
import { COOLING_SHROUD } from "@angels-bandits/common/city/roof-structures";
import {
  EMISSIVE_SIGN,
  EMISSIVE_TRACER,
  LANDMARK_HEIGHT,
  WORLD_SIZE,
} from "@angels-bandits/common/constants";
import { describe, expect, it } from "vitest";
import { roofClutterFor } from "../src/render/roofclutter";
import { RoofKind, roofStyleFor } from "../src/render/roofs";
import {
  AVIATION_LUMINANCE,
  BLOOM_THRESHOLD,
  BULB_LUMINANCE,
  CYCLES_PER_LOOP,
  DANCER_FILL,
  FLAG_FILL,
  HAZE_LUMINANCE,
  LIFE_MAX_HEIGHT,
  LOOP_MS,
  POLE_MAX_HEIGHT,
  POOL_COPING_HEIGHT,
  POOL_COPING_WIDTH,
  PROP_MAX_HEIGHT,
  PROP_VERTEX_BUDGET,
  RIM_LIGHT_LUMINANCE,
  ROOFTOP_LIGHTS_CACHE_KEY,
  ROOFTOP_PROPS_CACHE_KEY,
  ROOF_INSET,
  type RooftopLife,
  bakeRooftopProps,
  loopPhase,
  poolPeakLuminance,
  rooftopLifeAllowed,
  rooftopLifeFor,
  wrapOffset,
} from "../src/render/rooftop-life";
import { nearestImage } from "../src/render/wrapPlacement";

const EPS = 1e-6;
const CITIES = [generateCity(42), generateCity(7)];
const ALL = CITIES.flat();

const topOf = (b: Building) => {
  const top = b.tiers[b.tiers.length - 1];
  if (!top) throw new Error("empty tiers");
  return top;
};
const topKind = (b: Building) => roofStyleFor(b).tierKinds[b.tiers.length - 1];
const isEmpty = (l: RooftopLife) =>
  l.party === null &&
  l.pool === null &&
  l.fans.length === 0 &&
  l.flags.length === 0 &&
  l.aviation.length === 0;
/** Is (x, z) ± (hw, hd) inside the top roof, `inset` in from its edge? */
const onRoof = (
  b: Building,
  x: number,
  z: number,
  hw: number,
  hd: number,
  inset: number,
) => {
  const top = topOf(b);
  return (
    Math.abs(x - b.x) + hw <= top.width / 2 - inset + EPS &&
    Math.abs(z - b.z) + hd <= top.depth / 2 - inset + EPS
  );
};

describe("rooftopLifeFor", () => {
  it("is deterministic: same building → identical layout, city-wide", () => {
    for (const city of CITIES) {
      expect(JSON.stringify(city.map(rooftopLifeFor))).toBe(
        JSON.stringify(city.map(rooftopLifeFor)),
      );
    }
    // Regenerating the city (fresh Building objects) changes nothing either.
    expect(JSON.stringify(generateCity(42).map(rooftopLifeFor))).toBe(
      JSON.stringify(CITIES[0]?.map(rooftopLifeFor)),
    );
  });

  it("never dresses helipads, sky-hole top tiers or landmarks", () => {
    let helipads = 0;
    let skyHoles = 0;
    let landmarks = 0;
    for (const b of ALL) {
      const top = b.tiers.length - 1;
      const helipad = topKind(b) === RoofKind.HELIPAD;
      const skyHole = !!b.holes?.some(
        (h) => h.kind === "sky" && h.tierIndex === top,
      );
      const landmark = b.height >= LANDMARK_HEIGHT;
      if (helipad) helipads++;
      if (skyHole) skyHoles++;
      if (landmark) landmarks++;
      if (helipad || skyHole || landmark) {
        expect(rooftopLifeAllowed(b)).toBe(false);
        expect(isEmpty(rooftopLifeFor(b))).toBe(true);
      }
    }
    // The cities really contain each case, so the rule is exercised.
    expect(helipads).toBeGreaterThan(0);
    expect(skyHoles).toBeGreaterThan(0);
    expect(landmarks).toBeGreaterThan(0);
  });

  it("puts parties and pools only on flat roofs whose style allows them", () => {
    for (const b of ALL) {
      const l = rooftopLifeFor(b);
      if (!l.party && !l.pool) continue;
      const kind = topKind(b);
      expect(kind === RoofKind.MEMBRANE || kind === RoofKind.GRAVEL).toBe(true);
      expect(b.height).toBeLessThan(LIFE_MAX_HEIGHT);
    }
  });

  it("keeps everything on the top roof, inside the parapet", () => {
    for (const b of ALL) {
      const l = rooftopLifeFor(b);
      const p = l.party;
      if (p) {
        expect(onRoof(b, p.x, p.z, p.halfW, p.halfD, ROOF_INSET)).toBe(true);
        for (const d of p.dancers) {
          expect(onRoof(b, d.x, d.z, 0.3, 0.3, ROOF_INSET)).toBe(true);
        }
        for (const bulb of p.bulbs) {
          expect(onRoof(b, bulb.x, bulb.z, 0, 0, ROOF_INSET)).toBe(true);
        }
      }
      const pool = l.pool;
      if (pool) {
        const c = POOL_COPING_WIDTH;
        expect(
          onRoof(b, pool.x, pool.z, pool.halfW + c, pool.halfD + c, ROOF_INSET),
        ).toBe(true);
      }
      for (const f of l.fans) {
        // Cooling cells are ~2.38 r wide; AC fans sit on their box.
        const half = f.body > 0 ? f.radius * 1.19 : f.radius;
        expect(
          onRoof(b, f.x, f.z, half, half, f.body > 0 ? ROOF_INSET : 0),
        ).toBe(true);
      }
      for (const f of l.flags) {
        expect(onRoof(b, f.x, f.z, 0, 0, ROOF_INSET)).toBe(true);
      }
    }
  });

  it("caps every prop at 2 m above its own base (poles at 4 m; lights exempt)", () => {
    for (const b of ALL) {
      const l = rooftopLifeFor(b);
      for (const d of l.party?.dancers ?? []) {
        expect(d.y).toBe(b.height);
      }
      for (const f of l.fans) {
        expect(f.body + f.shroud).toBeLessThanOrEqual(PROP_MAX_HEIGHT + EPS);
      }
      for (const f of l.flags) {
        expect(f.y).toBe(b.height);
        expect(f.pole).toBeLessThanOrEqual(POLE_MAX_HEIGHT);
        // The cloth hangs from the pole and never reaches the deck.
        expect(f.pole - f.clothH).toBeGreaterThan(1);
      }
      if (l.pool) {
        expect(l.pool.y).toBe(b.height);
        expect(POOL_COPING_HEIGHT).toBeLessThanOrEqual(PROP_MAX_HEIGHT);
      }
      // Bulbs are LIGHT (the accepted exception), strung over head height.
      for (const bulb of l.party?.bulbs ?? []) {
        expect(bulb.y - b.height).toBeGreaterThan(2);
        expect(bulb.y - b.height).toBeLessThan(3.6);
      }
    }
  });

  it("mounts condenser fans on AC boxes — never acBoxes[0], steam's vent", () => {
    let acFans = 0;
    for (const b of ALL) {
      const boxes = roofClutterFor(b).acBoxes;
      for (const f of rooftopLifeFor(b).fans) {
        if (f.body > 0) {
          expect(f.y).toBe(b.height);
          continue;
        }
        // R2: the big fans on top of the solid cooling towers.
        if (
          (b.roof ?? []).some(
            (s) =>
              s.kind === "coolingTower" &&
              f.y === s.baseY + s.height - COOLING_SHROUD,
          )
        ) {
          continue;
        }
        const i = boxes.findIndex(
          (box) => box.x === f.x && box.z === f.z && box.y + box.height === f.y,
        );
        expect(i).toBeGreaterThan(0);
        acFans++;
      }
    }
    expect(acFans).toBeGreaterThan(50);
  });

  it("keeps the party deck, pool and cooling cells clear of existing clutter", () => {
    for (const b of ALL) {
      const l = rooftopLifeFor(b);
      const c = roofClutterFor(b);
      const rects = [
        ...(l.party ? [{ ...l.party }] : []),
        ...(l.pool
          ? [
              {
                x: l.pool.x,
                z: l.pool.z,
                halfW: l.pool.halfW + POOL_COPING_WIDTH,
                halfD: l.pool.halfD + POOL_COPING_WIDTH,
              },
            ]
          : []),
      ];
      const items = [
        ...c.waterTowers.map((t) => ({
          x: t.x,
          z: t.z,
          hw: t.radius,
          hd: t.radius,
        })),
        ...c.acBoxes.map((a) => ({
          x: a.x,
          z: a.z,
          hw: a.width / 2,
          hd: a.depth / 2,
        })),
        ...c.masts.map((m) => ({ x: m.x, z: m.z, hw: 0.3, hd: 0.3 })),
      ];
      for (const r of rects) {
        for (const it of items) {
          const apart =
            Math.abs(r.x - it.x) >= r.halfW + it.hw ||
            Math.abs(r.z - it.z) >= r.halfD + it.hd;
          expect(apart).toBe(true);
        }
      }
      if (l.party && l.pool) {
        const p = l.party;
        const q = rects[1];
        if (!q) throw new Error("pool rect");
        expect(
          Math.abs(p.x - q.x) >= p.halfW + q.halfW ||
            Math.abs(p.z - q.z) >= p.halfD + q.halfD,
        ).toBe(true);
      }
    }
  });

  it("hangs an aviation light above every antenna mast tip", () => {
    for (const b of ALL) {
      if (!rooftopLifeAllowed(b)) continue;
      const masts = roofClutterFor(b).masts;
      const lights = rooftopLifeFor(b).aviation;
      expect(lights).toHaveLength(masts.length);
      lights.forEach((a, i) => {
        const m = masts[i];
        if (!m) throw new Error("mast");
        expect(a.x).toBe(m.x);
        expect(a.z).toBe(m.z);
        expect(a.y).toBeGreaterThan(m.y + m.height + 0.35);
      });
    }
  });

  it("populates the seed-42 city with every kind of life", () => {
    const lives = CITIES[0]?.map(rooftopLifeFor) ?? [];
    const parties = lives.filter((l) => l.party);
    expect(parties.length).toBeGreaterThan(15);
    expect(lives.filter((l) => l.pool).length).toBeGreaterThan(15);
    expect(lives.reduce((n, l) => n + l.fans.length, 0)).toBeGreaterThan(100);
    expect(lives.reduce((n, l) => n + l.flags.length, 0)).toBeGreaterThan(30);
    expect(lives.reduce((n, l) => n + l.aviation.length, 0)).toBeGreaterThan(
      20,
    );
    for (const l of parties) {
      expect(l.party?.dancers.length).toBeGreaterThanOrEqual(1);
      expect(l.party?.dancers.length).toBeLessThanOrEqual(7);
      expect(l.party?.bulbs.length).toBeGreaterThan(10);
    }
  });

  it("bakes the whole city's props inside the vertex budget", () => {
    for (const city of CITIES) {
      const baked = bakeRooftopProps(city.map(rooftopLifeFor));
      expect(baked.vertexCount).toBeGreaterThan(0);
      expect(baked.vertexCount).toBeLessThanOrEqual(PROP_VERTEX_BUDGET);
      expect(baked.vertexCount % 3).toBe(0); // whole triangles
      expect(baked.pivots.length).toBe(baked.vertexCount * 4);
      expect(baked.anims.length).toBe(baked.vertexCount * 4);
    }
  });
});

describe("rooftop-life shader rules", () => {
  it("wraps to the same torus image as nearestImage, across the seam", () => {
    const cameras = [
      { x: 5, y: 0, z: 1995 },
      { x: 1990, y: 0, z: 10 },
      { x: 1000, y: 0, z: 1000 },
      { x: -30, y: 0, z: 2040 },
    ];
    const pivots = [
      { x: 1990, y: 0, z: 5 },
      { x: 12, y: 0, z: 1980 },
      { x: 400, y: 0, z: 1700 },
      { x: 1001, y: 0, z: 3 },
    ];
    for (const cam of cameras) {
      for (const p of pivots) {
        const img = nearestImage(cam, p);
        expect(p.x + wrapOffset(cam.x, p.x)).toBeCloseTo(img.x, 6);
        expect(p.z + wrapOffset(cam.z, p.z)).toBeCloseTo(img.z, 6);
        expect(
          Math.abs(p.x + wrapOffset(cam.x, p.x) - cam.x),
        ).toBeLessThanOrEqual(WORLD_SIZE / 2);
      }
    }
  });

  it("folds the synced clock into a seamless loop all clients share", () => {
    for (const c of Object.values(CYCLES_PER_LOOP)) {
      expect(Number.isInteger(c)).toBe(true);
    }
    // Epoch-scale server time: same instant → same phase, and the loop
    // boundary is invisible (phase × integer cycles is whole at the fold).
    const t = 1_791_234_567_890;
    expect(loopPhase(t)).toBe(loopPhase(t));
    expect(loopPhase(t)).toBeGreaterThanOrEqual(0);
    expect(loopPhase(t)).toBeLessThan(1);
    expect(loopPhase(t + LOOP_MS)).toBeCloseTo(loopPhase(t), 9);
    expect(loopPhase(-1)).toBeCloseTo(1 - 1 / LOOP_MS, 9);
  });

  it("slots every emissive on the ladder: pools and fills sub-bloom", () => {
    expect(poolPeakLuminance()).toBeLessThan(BLOOM_THRESHOLD);
    expect(HAZE_LUMINANCE).toBeLessThan(BLOOM_THRESHOLD);
    // Fills are light on albedo (≤ 1): even pure white stays sub-bloom.
    expect(DANCER_FILL).toBeLessThan(BLOOM_THRESHOLD);
    expect(FLAG_FILL).toBeLessThan(BLOOM_THRESHOLD);
    for (const l of [BULB_LUMINANCE, RIM_LIGHT_LUMINANCE]) {
      expect(l).toBeGreaterThan(BLOOM_THRESHOLD);
      expect(l).toBeLessThan(EMISSIVE_SIGN);
    }
    expect(AVIATION_LUMINANCE).toBeLessThan(EMISSIVE_TRACER);
  });

  it("uses program cache keys nothing else in the repo uses", () => {
    const taken = [
      "ab-car-lights",
      "ab-plane-lights",
      "ab-plane-hero",
      "ab-plane-hero-exhaust",
      "ab-sign-marquee",
      "ab-sign-billboard",
      "ab-mover-lights",
      "ab-mover-hull",
      "ab-buildings-h1-holes",
      "ab-car-lights-siren",
      "ab-ground-paint",
      "ab-pedestrian",
      "ab-spark-asize",
      "ab-steam-asize",
      "smoke-asize",
      "vo1-sky-dome-moon",
    ];
    expect(taken).not.toContain(ROOFTOP_LIGHTS_CACHE_KEY);
    expect(taken).not.toContain(ROOFTOP_PROPS_CACHE_KEY);
    expect(ROOFTOP_LIGHTS_CACHE_KEY).not.toBe(ROOFTOP_PROPS_CACHE_KEY);
  });
});
