// S4 sky boss, client half: the renderer places exactly the boxes the
// crash check collides with (draw == collide), on the weak-point glow and
// lights' rungs of the emissive ladder; and a round the client sees meet a
// weak point is one the server's own line test accepts.

import {
  BOSS_PARTS,
  BOSS_WEAK_POINTS,
  type BossRaid,
  type BossSlot,
  blankPose,
  bossHitValid,
  bossPartBoxInto,
  bossPartSdf,
  bossPoseAt,
  collideBoss,
  weakPointInto,
} from "@angels-bandits/common/boss";
import type { MoverBox } from "@angels-bandits/common/city/movers";
import { EMISSIVE_TRACER, WORLD_SIZE } from "@angels-bandits/common/constants";
import { type Vec3, wrapDistance } from "@angels-bandits/common/world";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { bossBulletHit } from "../src/game/boss-hits";
import { SHELL_COLOR, WEAK_COLOR, boxMatrixInto } from "../src/render/boss";
import { TAG_SOLID, buildBossHull } from "../src/render/boss-hull";
import { luminance } from "../src/render/emissive";

const T0 = 1_787_000_000_000;
const raid: BossRaid = {
  id: 1,
  t0: T0,
  cx: 1950,
  cz: 40,
  th0: 2.1,
  orbitMs: 300_000,
  hpScale: 1,
};
const slot: BossSlot = { raid, down: null };
const t = T0 + 70_000;
const pose = bossPoseAt(raid, t, blankPose());
const box = (i: number): MoverBox =>
  bossPartBoxInto(pose, i, {
    x: 0,
    y: 0,
    z: 0,
    hx: 0,
    hy: 0,
    hz: 0,
    yaw: 0,
    kind: "boss",
    id: 0,
  });

describe("draw == collide (renderer)", () => {
  it("draws every hull part: solid geometry on each part's own surface", () => {
    // S9: the hull is one skinned geometry (boss-hull.ts), not instanced
    // boxes — every part, armour and weak points alike, has drawn solid
    // surface on it (client/test/boss-hull.test.ts holds the whole shape).
    const h = buildBossHull("full");
    const pos = h.geometry.getAttribute("position");
    const drawn = new Set<number>();
    for (let v = 0; v < pos.count; v++) {
      if (h.tag[v] !== TAG_SOLID) continue;
      BOSS_PARTS.forEach((p, i) => {
        const d = bossPartSdf(
          p,
          pos.getX(v) - p.x,
          pos.getY(v) - p.y,
          pos.getZ(v) - p.z,
        );
        if (Math.abs(d) < 0.2) drawn.add(i);
      });
    }
    expect([...drawn].sort((a, b) => a - b)).toEqual(
      BOSS_PARTS.map((_, i) => i),
    );
  });

  it("each instance is its collision box, at the viewer's torus image", () => {
    // A viewer across the seam from a hull near x ≈ 0/2000.
    const viewer = { x: 30, y: 300, z: WORLD_SIZE - 20 };
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const local = new THREE.Vector3();
    for (let i = 0; i < BOSS_PARTS.length; i++) {
      // S9: the box parts (a solid of revolution's box only bounds it).
      if (BOSS_PARTS[i]?.rev !== null) continue;
      const b = box(i);
      boxMatrixInto(b, viewer, m).decompose(p, q, s);
      expect(s.x).toBeCloseTo(2 * b.hx, 9);
      expect(s.y).toBeCloseTo(2 * b.hy, 9);
      expect(s.z).toBeCloseTo(2 * b.hz, 9);
      // Drawn within half a world of the viewer, and on the box's canonical
      // position modulo the torus.
      expect(Math.abs(p.x - viewer.x)).toBeLessThanOrEqual(WORLD_SIZE / 2);
      expect(Math.abs(p.z - viewer.z)).toBeLessThanOrEqual(WORLD_SIZE / 2);
      expect(wrapDistance({ x: p.x, y: p.y, z: p.z }, b)).toBeLessThan(1e-6);
      // The unit cube's corners land on the collision box's surface: solid
      // just inside each drawn corner, clear just outside.
      for (const c of [
        [1, 1, 1],
        [-1, 1, -1],
        [1, -1, -1],
      ] as const) {
        local.set(c[0] * 0.49, c[1] * 0.49, c[2] * 0.49).applyMatrix4(m);
        const inside: Vec3 = { x: local.x, y: local.y, z: local.z };
        expect(collideBoss(slot, inside, 0.05, t)).not.toBeNull();
      }
    }
  });

  it("glows under the tracers on the ladder", () => {
    // The colours' own luminance stays below the tracer rung before any
    // boost (the renderer boosts them onto the hazard and beacon rungs).
    expect(luminance(WEAK_COLOR)).toBeLessThan(EMISSIVE_TRACER);
    expect(luminance(SHELL_COLOR)).toBeLessThan(EMISSIVE_TRACER);
  });
});

describe("what the client claims, the server accepts", () => {
  it("a round flown straight at a live weak point claims it, and the server agrees", () => {
    const alive = BOSS_WEAK_POINTS.map(() => true);
    for (let k = 0; k < 4; k++) {
      const wp = weakPointInto(pose, k, { x: 0, y: 0, z: 0 });
      const origin = { x: wp.x + 30, y: wp.y - 200, z: wp.z - 20 };
      const d = { x: wp.x - origin.x, y: wp.y - origin.y, z: wp.z - origin.z };
      const len = Math.hypot(d.x, d.y, d.z);
      const dir = { x: d.x / len, y: d.y / len, z: d.z / len };
      // The frame step that crosses it.
      const prev = {
        x: origin.x + dir.x * (len - 10),
        y: origin.y + dir.y * (len - 10),
        z: origin.z + dir.z * (len - 10),
      };
      const cur = {
        x: origin.x + dir.x * (len + 1),
        y: origin.y + dir.y * (len + 1),
        z: origin.z + dir.z * (len + 1),
      };
      const hit = bossBulletHit(slot, alive, prev, cur, t);
      expect(hit?.weak).toBe(k);
      if (!hit) continue;
      expect(bossHitValid(pose, k, origin, hit.dir, alive)).toBe(true);
    }
  });

  it("armour stops a round; no clock, no raid: nothing", () => {
    const alive = BOSS_WEAK_POINTS.map(() => true);
    const mid = box(0);
    const prev = { x: mid.x, y: mid.y - 40, z: mid.z };
    const cur = { x: mid.x, y: mid.y - 10, z: mid.z };
    expect(bossBulletHit(slot, alive, prev, cur, t)?.weak).toBe(-1);
    expect(bossBulletHit(slot, alive, prev, cur, null)).toBeNull();
    expect(
      bossBulletHit({ raid: null, down: null }, alive, prev, cur, t),
    ).toBeNull();
  });
});
