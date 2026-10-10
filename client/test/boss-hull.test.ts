// S9 war-zeppelin carrier: draw == collide. The geometry the renderer draws
// (client/src/render/boss-hull.ts) against the shape collideBoss tests
// (common/src/boss.ts bossPartSdf), both ways, within 1.5 m:
//  - every drawn SOLID vertex is inside the collision shape or within 1.5 m
//    of it (dressing within its own stated reach);
//  - every point of the collision surface is within 1.5 m of a drawn solid
//    triangle — collision never reaches more than 1.5 m outside what is
//    drawn;
// at full and light detail, and for each falling section (every solid
// vertex rides the bone of the section its part falls with, and the
// renderer's section placement is collideBoss's).

import {
  BOSS_PARTS,
  BOSS_PIECES,
  BOSS_PROFILE,
  BOSS_WEAK_POINTS,
  type BossPart,
  type BossPiecePath,
  blankPose,
  bossPartSdf,
  bossPiecePartBoxInto,
  bossRayHit,
  piecePoseAt,
  weakPointInto,
} from "@angels-bandits/common/boss";
import { mulberry32 } from "@angels-bandits/common/city";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { hullMatrixInto } from "../src/render/boss";
import {
  BONE_COUNT,
  type BossHullGeometry,
  DRESS_REACH_M,
  PENNANT_REACH_M,
  TAG_DRESS,
  TAG_SOLID,
  boneRests,
  buildBossHull,
} from "../src/render/boss-hull";

const TOL = 1.5;

/** Signed distance from a hull-frame point to the whole collision shape
 * (the union of the parts), and the part that is nearest. */
function hullSdf(x: number, y: number, z: number): { d: number; part: number } {
  let d = Number.POSITIVE_INFINITY;
  let part = -1;
  BOSS_PARTS.forEach((p, i) => {
    const di = bossPartSdf(p, x - p.x, y - p.y, z - p.z);
    if (di < d) {
      d = di;
      part = i;
    }
  });
  return { d, part };
}

/** Closest-point distance from p to triangle abc (Ericson, RTCD 5.1.5). */
function triDist(
  p: THREE.Vector3,
  a: THREE.Vector3,
  b: THREE.Vector3,
  c: THREE.Vector3,
): number {
  return new THREE.Triangle(a, b, c)
    .closestPointToPoint(p, scratch)
    .distanceTo(p);
}
const scratch = new THREE.Vector3();

/** The solid triangles of a hull geometry, bucketed in a 3 m grid. */
function solidGrid(h: BossHullGeometry) {
  const pos = h.geometry.getAttribute("position");
  const cell = 3;
  const grid = new Map<string, number[]>();
  const tris: THREE.Vector3[][] = [];
  for (let t = 0; t < pos.count / 3; t++) {
    if (h.tag[t * 3] !== TAG_SOLID) continue;
    const v = [0, 1, 2].map((k) =>
      new THREE.Vector3().fromBufferAttribute(pos, t * 3 + k),
    );
    const box = new THREE.Box3().setFromPoints(v);
    const id = tris.push(v) - 1;
    for (
      let x = Math.floor(box.min.x / cell);
      x <= Math.floor(box.max.x / cell);
      x++
    )
      for (
        let y = Math.floor(box.min.y / cell);
        y <= Math.floor(box.max.y / cell);
        y++
      )
        for (
          let z = Math.floor(box.min.z / cell);
          z <= Math.floor(box.max.z / cell);
          z++
        ) {
          const k = `${x},${y},${z}`;
          const list = grid.get(k);
          if (list) list.push(id);
          else grid.set(k, [id]);
        }
  }
  return (p: THREE.Vector3): number => {
    let best = Number.POSITIVE_INFINITY;
    const cx = Math.floor(p.x / cell);
    const cy = Math.floor(p.y / cell);
    const cz = Math.floor(p.z / cell);
    for (let x = cx - 1; x <= cx + 1; x++)
      for (let y = cy - 1; y <= cy + 1; y++)
        for (let z = cz - 1; z <= cz + 1; z++) {
          for (const id of grid.get(`${x},${y},${z}`) ?? []) {
            const t = tris[id] as THREE.Vector3[];
            best = Math.min(
              best,
              triDist(
                p,
                t[0] as THREE.Vector3,
                t[1] as THREE.Vector3,
                t[2] as THREE.Vector3,
              ),
            );
          }
        }
    return best;
  };
}

/** A random point on part p's own surface (hull frame). */
function surfacePoint(p: BossPart, rand: () => number): THREE.Vector3 {
  if (p.rev) {
    const prof = p.rev;
    // Pick a profile segment by its length, a point on it, an angle round.
    const segs: number[] = [];
    let total = 0;
    for (let i = 1; i < prof.length; i++) {
      const a = prof[i - 1] as readonly [number, number];
      const b = prof[i] as readonly [number, number];
      total += Math.hypot(b[0] - a[0], b[1] - a[1]) * Math.max(a[1], b[1], 0.1);
      segs.push(total);
    }
    const end0 = (prof[0] as readonly [number, number])[1];
    const endN = (prof[prof.length - 1] as readonly [number, number])[1];
    const discs = (Math.PI * (end0 * end0 + endN * endN)) / 2;
    const th = rand() * Math.PI * 2;
    let r = rand() * (total + discs);
    if (r > total) {
      // An end disc (a cut face).
      const first = r - total < (Math.PI * end0 * end0) / 2;
      const [x, rr] = (first ? prof[0] : prof[prof.length - 1]) as readonly [
        number,
        number,
      ];
      const rad = rr * Math.sqrt(rand());
      return new THREE.Vector3(
        p.x + x,
        p.y + rad * Math.cos(th),
        p.z + rad * Math.sin(th),
      );
    }
    let i = segs.findIndex((s) => s >= r);
    if (i < 0) i = segs.length - 1;
    const a = prof[i] as readonly [number, number];
    const b = prof[i + 1] as readonly [number, number];
    const u = rand();
    const x = a[0] + (b[0] - a[0]) * u;
    const rad = a[1] + (b[1] - a[1]) * u;
    r = rad;
    return new THREE.Vector3(
      p.x + x,
      p.y + r * Math.cos(th),
      p.z + r * Math.sin(th),
    );
  }
  // A box face, by area.
  const faces = [
    p.hy * p.hz,
    p.hy * p.hz,
    p.hx * p.hz,
    p.hx * p.hz,
    p.hx * p.hy,
    p.hx * p.hy,
  ];
  let f = rand() * faces.reduce((s, a) => s + a, 0);
  let k = 0;
  while (f > (faces[k] as number) && k < 5) f -= faces[k++] as number;
  const s = k % 2 === 0 ? 1 : -1;
  const u = rand() * 2 - 1;
  const v = rand() * 2 - 1;
  if (k < 2)
    return new THREE.Vector3(p.x + s * p.hx, p.y + u * p.hy, p.z + v * p.hz);
  if (k < 4)
    return new THREE.Vector3(p.x + u * p.hx, p.y + s * p.hy, p.z + v * p.hz);
  return new THREE.Vector3(p.x + u * p.hx, p.y + v * p.hy, p.z + s * p.hz);
}

describe("the carrier's silhouette", () => {
  it("is the LZ 129's: a ~6:1 cigar, pointed tail, blunt nose", () => {
    const first = BOSS_PROFILE[0] as readonly [number, number];
    const last = BOSS_PROFILE[BOSS_PROFILE.length - 1] as readonly [
      number,
      number,
    ];
    const length = last[0] - first[0];
    const diameter = 2 * Math.max(...BOSS_PROFILE.map(([, r]) => r));
    expect(length / diameter).toBeGreaterThan(5.8);
    expect(length / diameter).toBeLessThan(6.3);
    expect(first[1]).toBe(0);
    expect(last[1]).toBe(0);
  });
});

for (const detail of ["full", "lite"] as const) {
  describe(`draw == collide (${detail} detail)`, () => {
    const h = buildBossHull(detail);
    const pos = h.geometry.getAttribute("position");
    const rests = boneRests();

    it("every drawn solid vertex is inside the collision shape or within 1.5 m of it", () => {
      let worst = Number.NEGATIVE_INFINITY;
      let solid = 0;
      for (let i = 0; i < pos.count; i++) {
        const tag = h.tag[i];
        if (tag === TAG_SOLID || tag === TAG_DRESS) {
          const { d } = hullSdf(pos.getX(i), pos.getY(i), pos.getZ(i));
          const cap =
            tag === TAG_SOLID
              ? TOL
              : h.pennant[i]
                ? PENNANT_REACH_M
                : DRESS_REACH_M;
          if (tag === TAG_SOLID) {
            solid++;
            worst = Math.max(worst, d);
          }
          expect(d).toBeLessThanOrEqual(cap);
        }
      }
      expect(solid).toBeGreaterThan(5000);
      expect(worst).toBeLessThanOrEqual(TOL);
    });

    it("collision never reaches more than 1.5 m outside the drawn surface", () => {
      const nearest = solidGrid(h);
      const rand = mulberry32(detail === "full" ? 9 : 11);
      let checked = 0;
      BOSS_PARTS.forEach((p, i) => {
        for (let n = 0; n < 60; n++) {
          const q = surfacePoint(p, rand);
          // Only where it IS the surface of the whole shape: not buried in
          // another part.
          let buried = false;
          BOSS_PARTS.forEach((o, j) => {
            if (
              j !== i &&
              bossPartSdf(o, q.x - o.x, q.y - o.y, q.z - o.z) < -1e-3
            )
              buried = true;
          });
          if (buried) continue;
          checked++;
          const d = nearest(q);
          if (d > TOL)
            throw new Error(
              `part ${i} (${p.kind}) at ${q.toArray().map((v) => v.toFixed(2))}: ${d.toFixed(2)} m from anything drawn`,
            );
        }
      });
      expect(checked).toBeGreaterThan(800);
    });

    it("each solid vertex rides the section its part falls with", () => {
      for (let i = 0; i < pos.count; i++) {
        if (h.tag[i] !== TAG_SOLID) continue;
        const { d, part } = hullSdf(pos.getX(i), pos.getY(i), pos.getZ(i));
        if (d > 0.5) continue; // flush trim between parts: no owner
        const bone = h.bone[i] as number;
        expect(bone).toBeLessThan(BONE_COUNT);
        const section = (rests[bone] as { section: number }).section;
        // A vertex on a seam between two sections' parts is on both.
        const owners = BOSS_PARTS.flatMap((o, j) =>
          bossPartSdf(
            o,
            pos.getX(i) - o.x,
            pos.getY(i) - o.y,
            pos.getZ(i) - o.z,
          ) <=
          d + 1e-3
            ? [o.piece]
            : [],
        );
        expect(
          owners.includes(section as 0 | 1 | 2) ||
            (BOSS_PARTS[part] as BossPart).piece === section,
        ).toBe(true);
      }
    });
  });
}

describe("draw == collide while it falls", () => {
  it("the renderer places a falling section exactly where collideBoss does", () => {
    const piece: BossPiecePath = {
      k: 2,
      p: { x: 1990, y: 290, z: 12 },
      v: { x: 9, y: -2, z: -14 },
      yaw: 2.3,
      spin: -1,
    };
    const ms = 4200;
    const pose = piecePoseAt(piece, 0, 30_000, ms, blankPose());
    const viewer = { x: 20, y: 300, z: 1990 };
    const m = new THREE.Matrix4();
    const ax = (BOSS_PIECES[2] as { ax: number }).ax;
    hullMatrixInto(pose.x, pose.y, pose.z, pose.yaw, ax, viewer, m);
    for (const i of [3, 5, 7]) {
      const p = BOSS_PARTS[i] as BossPart;
      const box = bossPiecePartBoxInto(piece, pose, i, {
        x: 0,
        y: 0,
        z: 0,
        hx: 0,
        hy: 0,
        hz: 0,
        yaw: 0,
        kind: "bossDebris",
        id: 0,
      });
      const drawn = new THREE.Vector3(p.x, p.y, p.z).applyMatrix4(m);
      const dx = ((drawn.x - box.x + 3000) % 2000) - 1000;
      const dz = ((drawn.z - box.z + 3000) % 2000) - 1000;
      expect(Math.hypot(dx, drawn.y - box.y, dz)).toBeLessThan(1e-6);
    }
  });
});

describe("the weak points are real, hittable parts", () => {
  it("a round flown at each weak point's centre from outside meets it first", () => {
    const pose = {
      x: 1000,
      y: 305,
      z: 1000,
      yaw: 0.4,
      hx: Math.cos(0.4),
      hz: -Math.sin(0.4),
    };
    const alive = BOSS_WEAK_POINTS.map(() => true);
    for (let k = 0; k < BOSS_WEAK_POINTS.length; k++) {
      const p = BOSS_PARTS[BOSS_WEAK_POINTS[k] as number] as BossPart;
      const wp = weakPointInto(pose, k, { x: 0, y: 0, z: 0 });
      // From outboard of it: below an engine car, out from a flank cell, over
      // the dorsal one.
      const out =
        p.kind === "engine"
          ? [0, -1, 0]
          : p.y > 15
            ? [0, 1, 0]
            : [0, 0, Math.sign(p.z)];
      const c = Math.cos(pose.yaw);
      const s = Math.sin(pose.yaw);
      const o = {
        x: wp.x + 80 * ((out[0] as number) * c + (out[2] as number) * s),
        y: wp.y + 80 * (out[1] as number),
        z: wp.z + 80 * (-(out[0] as number) * s + (out[2] as number) * c),
      };
      const d = { x: wp.x - o.x, y: wp.y - o.y, z: wp.z - o.z };
      const len = Math.hypot(d.x, d.y, d.z);
      const hit = bossRayHit(
        pose,
        o,
        { x: d.x / len, y: d.y / len, z: d.z / len },
        400,
        alive,
      );
      expect(hit?.weak).toBe(k);
    }
  });
});
