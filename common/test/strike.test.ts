// X1 missile strikes — the shared pure model. Every client flies the same
// missile from one broadcast, so the arc must be a pure function that lands
// exactly on its target; the picker must never aim at a plane; the blast
// falloff and the telegraph floor are the fairness contract. Expected values
// are the ticket's spec literals (20 m, 1.8 s, 12 m lethal), not recomputed
// from the implementation.

import { generateCity, mulberry32 } from "@angels-bandits/common/city";
import { buildCityIndex } from "@angels-bandits/common/collision";
import { CITY_SEED, MAX_HP, WORLD_SIZE } from "@angels-bandits/common/constants";
import {
  MISSILE_FLIGHT_MS,
  type MissilePlane,
  type MissileStrike,
  decodeMissile,
  encodeMissile,
  missileDamage,
  missileImpactAt,
  missilePathClear,
  missilePosAt,
  missileWhistleAt,
  pickMissileTarget,
  planMissile,
  predictedPos,
} from "@angels-bandits/common/strike";
import {
  type Vec3,
  canonicalize,
  wrapDistance,
} from "@angels-bandits/common/world";
import { describe, expect, it } from "vitest";

const city = generateCity(CITY_SEED);
const index = buildCityIndex(city);

/** A low plane flying through the city: random spot, 40–140 m up, 60–140
 * m/s on a random heading. */
function randomPlane(rand: () => number): MissilePlane {
  const heading = rand() * Math.PI * 2;
  const speed = 60 + 80 * rand();
  return {
    pos: { x: rand() * WORLD_SIZE, y: 40 + 100 * rand(), z: rand() * WORLD_SIZE },
    vel: {
      x: Math.cos(heading) * speed,
      y: (rand() * 2 - 1) * 8,
      z: Math.sin(heading) * speed,
    },
  };
}

/** Plan up to `n` real strikes around random planes (seeded). */
function plannedStrikes(seed: number, n: number): MissileStrike[] {
  const rand = mulberry32(seed);
  const out: MissileStrike[] = [];
  for (let i = 0; out.length < n && i < n * 6; i++) {
    const subject = randomPlane(rand);
    const target = pickMissileTarget(rand, subject, [subject], index);
    if (!target) continue;
    const s = planMissile(rand, i + 1, target, 1_000_000 + i * 997, city);
    if (s) out.push(s);
  }
  return out;
}

describe("pickMissileTarget", () => {
  it("never targets within 20 m of any plane's predicted (or current) position", () => {
    const rand = mulberry32(0xa11);
    let picked = 0;
    for (let trial = 0; trial < 400; trial++) {
      const planes = [0, 1, 2, 3].map(() => randomPlane(rand));
      // Crowd two wingmen close to the subject: the hard case.
      const s = planes[0] as MissilePlane;
      for (const w of planes.slice(1, 3)) {
        w.pos = canonicalize({
          x: s.pos.x + (rand() * 2 - 1) * 60,
          y: s.pos.y,
          z: s.pos.z + (rand() * 2 - 1) * 60,
        });
        w.vel = { ...s.vel, x: s.vel.x + (rand() * 2 - 1) * 20 };
      }
      const target = pickMissileTarget(rand, s, planes, index);
      if (!target) continue;
      picked++;
      for (const p of planes) {
        expect(wrapDistance(predictedPos(p), target.to)).toBeGreaterThanOrEqual(20);
        expect(wrapDistance(p.pos, target.to)).toBeGreaterThanOrEqual(20);
      }
      // ...and lands 25–80 m from where the subject will be.
      const d = wrapDistance(predictedPos(s), target.to);
      expect(d).toBeGreaterThanOrEqual(25);
      expect(d).toBeLessThanOrEqual(80);
    }
    expect(picked).toBeGreaterThan(300); // the picker really finds targets
  });

  it("keeps lethal hits rare for planes that keep flying — straight or turning hard", () => {
    // The plane keeps its speed and turns at a constant rate from launch to
    // impact (0 = straight; 0.6 rad/s ≈ a hard sustained break).
    const rand = mulberry32(0x5eed);
    const dt = 0.05;
    for (const turn of [0, 0.25, 0.6]) {
      let lethal = 0;
      let strikes = 0;
      for (let trial = 0; trial < 300; trial++) {
        const plane = randomPlane(rand);
        const target = pickMissileTarget(rand, plane, [plane], index);
        if (!target) continue;
        strikes++;
        const p = { ...plane.pos };
        const v = { ...plane.vel };
        const dir = rand() < 0.5 ? -1 : 1;
        for (let t = 0; t < MISSILE_FLIGHT_MS / 1000 - 1e-9; t += dt) {
          const a = turn * dir * dt;
          const vx = v.x * Math.cos(a) - v.z * Math.sin(a);
          v.z = v.x * Math.sin(a) + v.z * Math.cos(a);
          v.x = vx;
          p.x += v.x * dt;
          p.y = Math.max(0, p.y + v.y * dt);
          p.z += v.z * dt;
        }
        if (missileDamage(wrapDistance(canonicalize(p), target.to)) >= MAX_HP) {
          lethal++;
        }
      }
      expect(strikes).toBeGreaterThan(200);
      if (turn === 0) expect(lethal).toBe(0);
      else expect(lethal / strikes).toBeLessThan(0.05);
    }
  });
});

describe("the telegraph", () => {
  it("announces every strike at least 1.8 s before impact, whistle included", () => {
    const strikes = plannedStrikes(0x7e1e, 120);
    expect(strikes.length).toBeGreaterThan(100);
    for (const s of strikes) {
      // The broadcast happens at launch (t0): the whole flight is warning.
      expect(missileImpactAt(s) - s.t0).toBeGreaterThanOrEqual(1800);
      // The whistle starts after the broadcast and ≥ 1.8 s before impact.
      expect(missileWhistleAt(s)).toBeGreaterThanOrEqual(s.t0);
      expect(missileImpactAt(s) - missileWhistleAt(s)).toBeGreaterThanOrEqual(1800);
    }
  });
});

describe("missilePosAt", () => {
  const strikes = plannedStrikes(0xa7c, 60);

  it("is pure and hits the chosen target exactly", () => {
    const a: Vec3 = { x: 0, y: 0, z: 0 };
    const b: Vec3 = { x: 0, y: 0, z: 0 };
    for (const s of strikes) {
      const mid = s.t0 + 1234;
      missilePosAt(s, mid, a);
      missilePosAt(s, s.t0 + 4000, b); // unrelated call in between
      missilePosAt(s, mid, b);
      expect(b).toEqual(a);
      expect(missilePosAt(s, s.t0, a)).toEqual(s.from);
      expect(missilePosAt(s, missileImpactAt(s), a)).toEqual(s.to);
      expect(missilePosAt(s, missileImpactAt(s) + 5000, a)).toEqual(s.to);
      expect(missilePosAt(s, s.t0 - 5000, a)).toEqual(s.from);
    }
  });

  it("flies a continuous, canonical arc above the ground", () => {
    const prev: Vec3 = { x: 0, y: 0, z: 0 };
    const cur: Vec3 = { x: 0, y: 0, z: 0 };
    for (const s of strikes) {
      missilePosAt(s, s.t0, prev);
      for (let t = s.t0 + 20; t <= missileImpactAt(s); t += 20) {
        missilePosAt(s, t, cur);
        expect(cur.x).toBeGreaterThanOrEqual(0);
        expect(cur.x).toBeLessThan(WORLD_SIZE);
        expect(cur.z).toBeGreaterThanOrEqual(0);
        expect(cur.z).toBeLessThan(WORLD_SIZE);
        expect(cur.y).toBeGreaterThanOrEqual(0);
        // ≤ 20 ms of flight per step: never a teleport, seam included.
        expect(wrapDistance(prev, cur)).toBeLessThan(15);
        prev.x = cur.x;
        prev.y = cur.y;
        prev.z = cur.z;
      }
    }
  });

  it("only plans arcs that clear the city on the way in", () => {
    for (const s of strikes) expect(missilePathClear(s, city)).toBe(true);
  });

  it("crosses the wire unchanged", () => {
    for (const s of strikes) {
      const wire = JSON.parse(JSON.stringify(encodeMissile(s)));
      expect(decodeMissile(wire)).toEqual(s);
    }
    expect(decodeMissile([1, 2, 3])).toBeNull();
    expect(decodeMissile("nope")).toBeNull();
  });
});

describe("missileDamage", () => {
  it("is lethal within 12 m and falls off to nothing at the blast edge", () => {
    expect(missileDamage(0)).toBeGreaterThanOrEqual(MAX_HP);
    expect(missileDamage(11.9)).toBeGreaterThanOrEqual(MAX_HP);
    expect(missileDamage(12)).toBeGreaterThanOrEqual(MAX_HP);
    expect(missileDamage(12.5)).toBeLessThan(MAX_HP / 2 + 10);
    expect(missileDamage(45)).toBe(0);
    expect(missileDamage(200)).toBe(0);
    let last = Number.POSITIVE_INFINITY;
    for (let d = 0; d <= 60; d += 0.5) {
      const dmg = missileDamage(d);
      expect(dmg).toBeLessThanOrEqual(last);
      expect(dmg).toBeGreaterThanOrEqual(0);
      last = dmg;
    }
  });
});
