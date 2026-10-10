// R2 roof structures: the pure layout seam (where they stand) and the
// collision parity it exists for — what the client draws from Building.roof
// is what collideCity, losClear and the bot probes hit.

import {
  type Building,
  clearAirSpans,
  generateCity,
  inHoleAir,
} from "@angels-bandits/common/city";
import {
  BILLBOARD_LIFT,
  ROOF_STRUCTURE_INSET,
  ROOF_STRUCTURE_MAX_HEIGHT,
  type RoofStructure,
  SEARCHLIGHT_CLEAR_HALF,
  SEARCHLIGHT_CLEAR_MIN_HEIGHT,
  hasHelipad,
  roofStructuresFor,
  roofTop,
} from "@angels-bandits/common/city/roof-structures";
import {
  buildCityIndex,
  collideCity,
  losClear,
} from "@angels-bandits/common/collision";
import {
  BOT_PROBE_RADIUS,
  CITY_SEED,
  LANDMARK_HEIGHT,
  PLAYER_RADIUS,
  WORLD_SIZE,
} from "@angels-bandits/common/constants";
import { describe, expect, it } from "vitest";

const CITIES = [generateCity(CITY_SEED), generateCity(42)];
const ALL = CITIES.flat();
const city = CITIES[0] as Building[];
const index = buildCityIndex(city);
const EPS = 1e-9;

const topOf = (b: Building) => {
  const t = b.tiers[b.tiers.length - 1];
  if (!t) throw new Error("no tiers");
  return t;
};
/** A structure's footprint half extents (a round one: its bounding square). */
const half = (s: RoofStructure) => ({ w: s.width / 2, d: s.depth / 2 });
const withStructures = (cities: Building[][]) =>
  cities.flat().flatMap((b) => (b.roof ?? []).map((s) => ({ b, s })));

describe("roofStructuresFor: layout", () => {
  it("is deterministic, and generateCity stores exactly it on Building.roof", () => {
    for (const c of CITIES) {
      // H2: minus exactly what stands in a hole's clear air (clearHoleAir).
      const spans = clearAirSpans(c);
      for (const b of c) {
        expect(JSON.stringify(roofStructuresFor(b))).toBe(
          JSON.stringify(roofStructuresFor(b)),
        );
        const fresh = roofStructuresFor(b).filter(
          (r) => !inHoleAir(b, r, spans),
        );
        expect(b.roof ?? []).toEqual(fresh);
      }
    }
    // …and a real city has plenty of them, of every kind.
    const kinds = new Set(withStructures(CITIES).map(({ s }) => s.kind));
    expect([...kinds].sort()).toEqual(
      [
        "aaNest",
        "billboard",
        "billboardLeg",
        "coolingTower",
        "mast",
        "penthouse",
        "waterTank",
      ].sort(),
    );
  });

  it("keeps every structure on the top roof, inside the parapet inset, standing on the deck", () => {
    for (const { b, s } of withStructures(CITIES)) {
      const t = topOf(b);
      const { w, d } = half(s);
      expect(Math.abs(s.dx) + w).toBeLessThanOrEqual(
        t.width / 2 - ROOF_STRUCTURE_INSET + EPS,
      );
      expect(Math.abs(s.dz) + d).toBeLessThanOrEqual(
        t.depth / 2 - ROOF_STRUCTURE_INSET + EPS,
      );
      // Only a billboard panel floats (over its legs); everything else
      // stands on the roof deck.
      expect(s.baseY).toBe(
        s.kind === "billboard" ? b.height + BILLBOARD_LIFT : b.height,
      );
      expect(s.height).toBeGreaterThan(0);
      expect(s.baseY + s.height - b.height).toBeLessThanOrEqual(
        ROOF_STRUCTURE_MAX_HEIGHT,
      );
    }
  });

  it("is offset-based, so a building straddling the torus seam keeps its structures on its roof", () => {
    const seam: Building = {
      x: 3,
      z: WORLD_SIZE - 4,
      width: 60,
      depth: 50,
      height: 140,
      tiers: [{ width: 60, depth: 50, height: 140 }],
    };
    const roof = roofStructuresFor(seam);
    expect(roof.length).toBeGreaterThan(0);
    for (const s of roof) {
      const { w, d } = half(s);
      expect(Math.abs(s.dx) + w).toBeLessThanOrEqual(30 - ROOF_STRUCTURE_INSET);
      expect(Math.abs(s.dz) + d).toBeLessThanOrEqual(25 - ROOF_STRUCTURE_INSET);
    }
    // …and collide across the seam, from the far side's coordinates.
    seam.roof = roof;
    const s = roof[0] as RoofStructure;
    const pos = {
      x: (seam.x + s.dx + WORLD_SIZE) % WORLD_SIZE,
      y: s.baseY + s.height / 2,
      z: (seam.z + s.dz + WORLD_SIZE) % WORLD_SIZE,
    };
    expect(collideCity(pos, 0.5, [seam])).toBe(seam);
  });

  it("keeps landmarks and helipad roofs bare", () => {
    let pads = 0;
    for (const b of ALL) {
      if (b.height >= LANDMARK_HEIGHT) expect(b.roof).toBeUndefined();
      if (hasHelipad(b)) {
        pads++;
        expect(b.roof).toBeUndefined();
      }
    }
    expect(pads).toBeGreaterThan(5);
  });

  it("keeps the strip over every sky hole bare", () => {
    let skies = 0;
    for (const b of ALL) {
      const top = b.tiers.length - 1;
      for (const h of b.holes ?? []) {
        if (h.kind !== "sky" || h.tierIndex !== top) continue;
        skies++;
        for (const s of b.roof ?? []) {
          const across = h.axis === "x" ? s.dz : s.dx;
          const { w, d } = half(s);
          const reach = h.axis === "x" ? d : w;
          expect(Math.abs(across - h.offset)).toBeGreaterThanOrEqual(
            h.width / 2 + reach,
          );
        }
      }
    }
    expect(skies).toBeGreaterThan(0);
  });

  it("keeps the searchlight square at the centre of the tallest towers clear", () => {
    for (const b of ALL) {
      if (b.height < SEARCHLIGHT_CLEAR_MIN_HEIGHT) continue;
      for (const s of b.roof ?? []) {
        const { w, d } = half(s);
        const clearX = Math.abs(s.dx) >= SEARCHLIGHT_CLEAR_HALF + w;
        const clearZ = Math.abs(s.dz) >= SEARCHLIGHT_CLEAR_HALF + d;
        expect(clearX || clearZ).toBe(true);
      }
    }
  });

  it("puts antenna masts only on tall towers, and nothing on hand-built buildings by default", () => {
    for (const { b, s } of withStructures(CITIES)) {
      if (s.kind === "mast") expect(b.height).toBeGreaterThanOrEqual(120);
    }
    const bare: Building = {
      x: 500,
      z: 500,
      width: 60,
      depth: 60,
      height: 130,
      tiers: [{ width: 60, depth: 60, height: 130 }],
    };
    expect(bare.roof).toBeUndefined();
    expect(roofTop(bare)).toBe(130);
    bare.roof = roofStructuresFor(bare);
    expect(roofTop(bare)).toBeGreaterThan(130);
  });
});

describe("roof structures collide exactly where they are drawn", () => {
  const structures = withStructures([city]);

  it("collideCity hits every structure — linear and indexed, holes open and solid (the bot probes' mode)", () => {
    for (const { b, s } of structures) {
      const pos = {
        x: b.x + s.dx,
        y: s.baseY + s.height / 2,
        z: b.z + s.dz,
      };
      expect(collideCity(pos, PLAYER_RADIUS, city)).toBe(b);
      expect(collideCity(pos, PLAYER_RADIUS, city, index)).toBe(b);
      expect(collideCity(pos, BOT_PROBE_RADIUS, city, index, "solid")).not.toBe(
        null,
      );
    }
  });

  it("misses just above every structure's top", () => {
    for (const { b, s } of structures) {
      // A leg's top is the billboard panel's underside.
      if (s.kind === "billboardLeg") continue;
      const above = {
        x: b.x + s.dx,
        y: s.baseY + s.height + PLAYER_RADIUS + 0.01,
        z: b.z + s.dz,
      };
      const hit = collideCity(above, PLAYER_RADIUS, city, index);
      // Only a taller neighbour on the same roof (a mast in the cluster)
      // may still be there.
      if (hit === b) {
        const top = above.y - PLAYER_RADIUS;
        expect(
          (b.roof ?? []).some((o) => o !== s && o.baseY + o.height >= top),
        ).toBe(true);
      } else {
        expect(hit).toBeNull();
      }
    }
  });

  it("treats tanks and masts as cylinders: no invisible corner on a round structure", () => {
    let tanks = 0;
    for (const { b, s } of structures) {
      if (s.kind !== "waterTank") continue;
      tanks++;
      const r = s.width / 2;
      const probe = 0.5;
      const out = (r + probe + 0.05) / Math.SQRT2;
      const y = s.baseY + s.height / 2;
      // Inside the bounding square's corner, outside the drawn curve.
      const corner = { x: b.x + s.dx + out, y, z: b.z + s.dz + out };
      expect(collideCity(corner, probe, [b])).toBeNull();
      // On the curve itself: a hit.
      const side = { x: b.x + s.dx + r + probe - 0.05, y, z: b.z + s.dz };
      expect(collideCity(side, probe, [b])).toBe(b);
    }
    expect(tanks).toBeGreaterThan(20);
  });

  it("losClear is blocked through every structure and clear over it", () => {
    for (const { b, s } of structures) {
      const x = b.x + s.dx;
      const z = b.z + s.dz;
      const span = s.width / 2 + 0.6;
      const mid = s.baseY + s.height / 2;
      expect(
        losClear({ x: x - span, y: mid, z }, { x: x + span, y: mid, z }, city),
      ).toBe(false);
      if (s.kind === "billboardLeg" || s.kind === "mast") continue;
      const over = s.baseY + s.height + 0.3;
      const clear = losClear(
        { x: x - span, y: over, z },
        { x: x + span, y: over, z },
        city,
      );
      const taller = (b.roof ?? []).some(
        (o) =>
          o !== s &&
          o.baseY + o.height >= over &&
          Math.abs(o.dz - s.dz) <= o.depth / 2 &&
          Math.abs(o.dx - s.dx) <= span + o.width / 2,
      );
      expect(clear).toBe(!taller);
    }
  });

  it("leaves the open air under a billboard panel open to sight lines", () => {
    let boards = 0;
    for (const b of city) {
      for (const s of b.roof ?? []) {
        if (s.kind !== "billboard") continue;
        const legs = (b.roof ?? []).filter(
          (o) => o.kind === "billboardLeg" && o.face === s.face,
        );
        // Midway between the first two legs, across the panel.
        const [l0, l1] = legs;
        if (!l0 || !l1) continue;
        boards++;
        const ax = (l0.dx + l1.dx) / 2;
        const az = (l0.dz + l1.dz) / 2;
        const across = s.face < 2 ? { x: 1.1, z: 0 } : { x: 0, z: 1.1 };
        const y = b.height + BILLBOARD_LIFT / 2;
        const from = { x: b.x + ax - across.x, y, z: b.z + az - across.z };
        const to = { x: b.x + ax + across.x, y, z: b.z + az + across.z };
        expect(losClear(from, to, [b])).toBe(true);
        const high = s.baseY + s.height / 2;
        expect(losClear({ ...from, y: high }, { ...to, y: high }, [b])).toBe(
          false,
        );
      }
    }
    expect(boards).toBeGreaterThan(5);
  });
});
