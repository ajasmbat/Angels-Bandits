// D1 facade damage map: bounded memory (a fixed atlas of face slots, least
// recently hit evicted), records keyed by building id + facade-local cell
// (seam-safe: translating the whole scene across the seam changes nothing),
// the packed per-tier slot word the shader decodes, and blasts.

import { generateCity, mulberry32 } from "@angels-bandits/common/city";
import type { Building } from "@angels-bandits/common/city";
import { buildCityIndex } from "@angels-bandits/common/collision";
import { wrapCoord } from "@angels-bandits/common/world";
import { describe, expect, it } from "vitest";
import { FacadeFace } from "../src/game/bullet-impact";
import {
  ATLAS_HEIGHT,
  ATLAS_WIDTH,
  BLAST_RADIUS,
  DAMAGE,
  FacadeDamage,
  MAX_FACE_SLOTS,
  MAX_HOLES,
  blastFacades,
  faceSlotsFor,
} from "../src/render/damage-map";
import { QUALITY_PROFILES } from "../src/render/quality";

describe("FacadeDamage — bounded", () => {
  it("never grows: a fixed RG8 atlas, slots capped, however much is marked", () => {
    const d = new FacadeDamage();
    const bytes = d.data.length;
    expect(bytes).toBe(ATLAS_WIDTH * ATLAS_HEIGHT * 2);
    expect(ATLAS_WIDTH).toBe(512);
    expect(ATLAS_HEIGHT).toBe(576);
    const rand = mulberry32(3);
    for (let n = 0; n < 20_000; n++) {
      const b = Math.floor(rand() * 600);
      const tier = Math.floor(rand() * 3);
      const face = Math.floor(rand() * 4);
      const cx = Math.floor(rand() * 64) - 32;
      const cy = Math.floor(rand() * 96);
      if (rand() < 0.5) d.shatter(b, tier, face, cx, cy);
      else d.bulletHole(b, tier, face, cx, cy);
      expect(d.slotsUsed).toBeLessThanOrEqual(MAX_FACE_SLOTS);
    }
    expect(d.data.length).toBe(bytes);
    expect(d.slotsUsed).toBe(MAX_FACE_SLOTS);
  });

  it("ignores cells off the slot's grid without taking a slot", () => {
    const d = new FacadeDamage();
    expect(d.shatter(1, 0, 0, DAMAGE.cols - DAMAGE.colOffset, 3)).toBe(false);
    expect(d.shatter(1, 0, 0, -DAMAGE.colOffset - 1, 3)).toBe(false);
    expect(d.shatter(1, 0, 0, 0, DAMAGE.rows)).toBe(false);
    expect(d.shatter(1, 0, 0, 0, -1)).toBe(false);
    expect(d.slotsUsed).toBe(0);
  });

  it("evicts the least recently hit face, zeroing it, at the tier's cap", () => {
    const d = new FacadeDamage();
    d.setSlotCap(3);
    d.shatter(10, 0, FacadeFace.PX, 0, 5);
    d.shatter(11, 0, FacadeFace.PX, 0, 5);
    d.shatter(12, 0, FacadeFace.PX, 0, 5);
    d.bulletHole(10, 0, FacadeFace.PX, 1, 5); // 10 is recent again
    d.shatter(13, 0, FacadeFace.PX, 0, 5); // evicts 11
    expect(d.slotOf(11, 0, FacadeFace.PX)).toBe(-1);
    expect(d.read(11, 0, FacadeFace.PX, 0, 5).shattered).toBe(false);
    expect(d.read(10, 0, FacadeFace.PX, 0, 5).shattered).toBe(true);
    expect(d.read(13, 0, FacadeFace.PX, 0, 5).shattered).toBe(true);
    // 13 reused 11's slot, and it starts clean apart from its own mark.
    expect(d.read(13, 0, FacadeFace.PX, 1, 5).holes).toBe(0);
    expect(d.slotsUsed).toBe(3);
  });

  it("shrinking the cap (a cheaper tier) evicts the slots past it", () => {
    const d = new FacadeDamage();
    for (let b = 0; b < 30; b++) d.shatter(b, 0, 0, 0, 0);
    d.setSlotCap(faceSlotsFor(QUALITY_PROFILES.mobile.impacts));
    expect(d.slotsUsed).toBe(24);
    expect(d.slotCap).toBe(24);
  });

  it("accumulates: holes saturate at MAX_HOLES, scorch at 255", () => {
    const d = new FacadeDamage();
    for (let k = 0; k < 10; k++) d.bulletHole(4, 1, 2, -5, 9);
    for (let k = 0; k < 40; k++) d.scorch(4, 1, 2, -5, 9, 10);
    const c = d.read(4, 1, 2, -5, 9);
    expect(c.holes).toBe(MAX_HOLES);
    expect(c.scorch).toBe(255);
    expect(c.shattered).toBe(false);
    d.shatter(4, 1, 2, -5, 9);
    expect(d.read(4, 1, 2, -5, 9)).toEqual({
      shattered: true,
      holes: MAX_HOLES,
      scorch: 255,
    });
  });
});

describe("FacadeDamage — the packed slot word", () => {
  it("carries (slot + 1) per face in 6-bit fields, exact in float32", () => {
    const d = new FacadeDamage();
    d.shatter(7, 2, FacadeFace.PX, 0, 0); // slot 0
    d.shatter(8, 0, FacadeFace.PX, 0, 0); // slot 1 (another tier)
    d.shatter(7, 2, FacadeFace.NZ, 0, 0); // slot 2
    const word = d.packedWord(7, 2);
    const f32 = Math.fround(word);
    expect(f32).toBe(word);
    const field = (f: number) => Math.floor(word / 2 ** (6 * f)) % 64;
    expect(field(FacadeFace.PX)).toBe(1);
    expect(field(FacadeFace.NX)).toBe(0);
    expect(field(FacadeFace.PZ)).toBe(0);
    expect(field(FacadeFace.NZ)).toBe(3);
    expect(d.packedWord(8, 1)).toBe(0);
  });

  it("reports the tiers whose word changed, and the slots to upload", () => {
    const d = new FacadeDamage();
    d.setSlotCap(1);
    d.shatter(1, 0, 0, 0, 0);
    d.takeDirtyTiers(() => {});
    d.takeDirtySlots(() => {});
    d.shatter(2, 1, 0, 0, 0); // evicts building 1's face
    const tiers: number[] = [];
    d.takeDirtyTiers((k) => tiers.push(k));
    expect(tiers.sort((a, b) => a - b)).toEqual([1 * 8 + 0, 2 * 8 + 1]);
    const slots: number[] = [];
    d.takeDirtySlots((s) => slots.push(s));
    expect(slots).toEqual([0]);
  });
});

describe("blastFacades", () => {
  const city = generateCity(42);
  const index = buildCityIndex(city);
  // A building with a long +x face: blast 6 m in front of its middle.
  const bi = city.findIndex(
    (b) => b.tiers.length === 1 && b.height > 60 && b.depth > 40,
  );
  const b = city[bi] as Building;
  const centre = { x: wrapCoord(b.x + b.width / 2 + 6), y: 30, z: b.z };

  it("blows out a ring of windows that thins with distance, and scorches", () => {
    const d = new FacadeDamage();
    const site = blastFacades(d, city, index, centre, mulberry32(9));
    expect(site?.building).toBe(bi);
    expect(site?.face).toBe(FacadeFace.PX);
    expect(site?.distance).toBeCloseTo(6, 6);
    // Count shattered cells by distance band on that face.
    let near = 0;
    let nearAll = 0;
    let far = 0;
    let farAll = 0;
    for (let cy = 0; cy < DAMAGE.rows; cy++) {
      for (
        let cx = -DAMAGE.colOffset;
        cx < DAMAGE.cols - DAMAGE.colOffset;
        cx++
      ) {
        const c = d.read(bi, 0, FacadeFace.PX, cx, cy);
        if (!c.shattered && c.scorch === 0) continue;
        if (c.scorch > 80) nearAll++;
        if (c.shattered && c.scorch > 80) near++;
        if (c.scorch === 0) {
          farAll++;
          if (c.shattered) far++;
        }
      }
    }
    expect(nearAll).toBeGreaterThan(0);
    expect(near / nearAll).toBeGreaterThan(0.5);
    expect(far).toBeGreaterThan(0); // the ring reaches past the scorch
    // Nothing beyond the blast radius on that face.
    expect(farAll).toBeGreaterThan(0);
  });

  it("is deterministic for a seed, and nothing is marked out of reach", () => {
    const a = new FacadeDamage();
    const c = new FacadeDamage();
    blastFacades(a, city, index, centre, mulberry32(9));
    blastFacades(c, city, index, centre, mulberry32(9));
    expect(a.data).toEqual(c.data);
    const none = new FacadeDamage();
    const lonely = blastFacades(
      none,
      [b],
      buildCityIndex([b]),
      { x: wrapCoord(b.x + b.width / 2 + BLAST_RADIUS + 1), y: 30, z: b.z },
      mulberry32(1),
    );
    expect(lonely).toBeNull();
    expect(none.slotsUsed).toBe(0);
  });

  it("is seam-safe: the same scene shifted across the seam marks the same cells", () => {
    const tower = (x: number): Building => ({
      x,
      z: 700,
      width: 50,
      depth: 40,
      height: 70,
      tiers: [{ width: 50, depth: 40, height: 70 }],
    });
    const atSeam = [tower(5)]; // straddles x = 0
    const inland = [tower(1005)];
    const a = new FacadeDamage();
    const c = new FacadeDamage();
    blastFacades(
      a,
      atSeam,
      buildCityIndex(atSeam),
      { x: 1972, y: 25, z: 700 },
      mulberry32(4),
    );
    blastFacades(
      c,
      inland,
      buildCityIndex(inland),
      { x: 972, y: 25, z: 700 },
      mulberry32(4),
    );
    expect(a.slotsUsed).toBeGreaterThan(0);
    expect(a.data).toEqual(c.data);
  });
});
