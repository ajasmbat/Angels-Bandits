// Z1 airship fleet: draw == collide, per hull class. The geometry the
// renderer draws (client/src/render/boss-hull.ts buildShipHull — the base
// hull, which every instance scales by its class) against the shape
// collideBoss tests (common/src/boss.ts SHIP_PARTS — the same part table
// scaled the same way), both ways, within 1.5 m:
//  - every drawn SOLID vertex, scaled to the class, is inside that class's
//    collision shape or within 1.5 m of it (dressing within its own stated
//    reach);
//  - every point of a class's collision surface is within 1.5 m of a drawn
//    solid triangle (scaled) — collision never reaches more than 1.5 m
//    outside what is drawn;
// at full and light detail, for every class; and the renderer's placement
// of a ship (flying or pitched in its crash) is collideBoss's.

import {
  BOSS_PARTS,
  BOSS_PROFILE,
  BOSS_WEAK_POINTS,
  type BossPart,
  SHIP_CLASSES,
  SHIP_PARTS,
  type ShipClassId,
  type ShipDown,
  blankPose,
  bossPartSdf,
  fallPoseInto,
  shipPointInto,
  shipRayHit,
  weakPointInto,
} from "@angels-bandits/common/boss";
import { mulberry32 } from "@angels-bandits/common/city";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { shipMatrixInto } from "../src/render/boss";
import {
  type BossHullGeometry,
  DRESS_REACH_M,
  PENNANT_REACH_M,
  TAG_DRESS,
  TAG_ESCORT,
  TAG_SOLID,
  buildShipHull,
} from "../src/render/boss-hull";

const TOL = 1.5;
const CLASSES: readonly ShipClassId[] = [0, 1, 2];

/** Signed distance from a ship-frame point to class `cls`'s whole
 * collision shape (the union of its parts). */
function hullSdf(cls: ShipClassId, x: number, y: number, z: number): number {
  let d = Number.POSITIVE_INFINITY;
  for (const p of SHIP_PARTS[cls] as readonly BossPart[]) {
    d = Math.min(d, bossPartSdf(p, x - p.x, y - p.y, z - p.z));
  }
  return d;
}

/** Closest-point distance from p to triangle abc. */
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

/** The solid triangles of a hull geometry scaled to class `cls`, bucketed
 * in a 3 m grid. */
function solidGrid(h: BossHullGeometry, cls: ShipClassId) {
  const c = SHIP_CLASSES[cls] as { sx: number; sr: number };
  const pos = h.geometry.getAttribute("position");
  const cell = 3;
  const grid = new Map<string, number[]>();
  const tris: THREE.Vector3[][] = [];
  for (let t = 0; t < pos.count / 3; t++) {
    if (h.tag[t * 3] !== TAG_SOLID) continue;
    const v = [0, 1, 2].map((k) => {
      const p = new THREE.Vector3().fromBufferAttribute(pos, t * 3 + k);
      return p.set(p.x * c.sx, p.y * c.sr, p.z * c.sr);
    });
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

/** A random point on part p's own surface (ship frame). */
function surfacePoint(p: BossPart, rand: () => number): THREE.Vector3 {
  if (p.rev) {
    const prof = p.rev;
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
    const r = rand() * (total + discs);
    if (r > total) {
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
    return new THREE.Vector3(
      p.x + x,
      p.y + rad * Math.cos(th),
      p.z + rad * Math.sin(th),
    );
  }
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

describe("the fleet's silhouettes", () => {
  it("the base hull is the LZ 129's: a ~6:1 cigar, pointed tail, blunt nose", () => {
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

  it("the three classes are three shapes, not one at three sizes", () => {
    const fineness = SHIP_CLASSES.map((c) => (6.05 * c.sx) / c.sr);
    expect(new Set(fineness.map((f) => f.toFixed(2))).size).toBe(3);
  });

  it("no ship flies the escort scouts", () => {
    const h = buildShipHull("full");
    expect(h.tag.includes(TAG_ESCORT)).toBe(false);
  });
});

for (const detail of ["full", "lite"] as const) {
  const h = buildShipHull(detail);
  const pos = h.geometry.getAttribute("position");
  for (const cls of CLASSES) {
    const c = SHIP_CLASSES[cls] as { sx: number; sr: number; name: string };
    describe(`draw == collide (${c.name}, ${detail} detail)`, () => {
      it("every drawn solid vertex is inside the collision shape or within 1.5 m of it", () => {
        let worst = Number.NEGATIVE_INFINITY;
        let solid = 0;
        for (let i = 0; i < pos.count; i++) {
          const tag = h.tag[i];
          if (tag !== TAG_SOLID && tag !== TAG_DRESS) continue;
          const d = hullSdf(
            cls,
            pos.getX(i) * c.sx,
            pos.getY(i) * c.sr,
            pos.getZ(i) * c.sr,
          );
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
        expect(solid).toBeGreaterThan(5000);
        expect(worst).toBeLessThanOrEqual(TOL);
      });

      it("collision never reaches more than 1.5 m outside the drawn surface", () => {
        const nearest = solidGrid(h, cls);
        const rand = mulberry32((detail === "full" ? 9 : 11) + cls);
        const parts = SHIP_PARTS[cls] as readonly BossPart[];
        let checked = 0;
        parts.forEach((p, i) => {
          for (let n = 0; n < 40; n++) {
            const q = surfacePoint(p, rand);
            let buried = false;
            parts.forEach((o, j) => {
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
        expect(checked).toBeGreaterThan(500);
      });
    });
  }
}

describe("the renderer places every ship where collideBoss does", () => {
  it("flying and crashing, on the viewer's torus image", () => {
    const down: ShipDown = {
      t: 0,
      p: { x: 1995, y: 585, z: 8 },
      v: { x: 9, y: -2, z: -11 },
      yaw: 2.3,
      spin: -1,
      end: 9000,
      hit: "city",
      at: { x: 0, y: 0, z: 0 },
      b: -1,
    };
    const viewer = { x: 20, y: 300, z: 1990 };
    const m = new Float32Array(16);
    const p64 = new Float64Array(7);
    for (const cls of CLASSES) {
      for (const ms of [0, 2500, 6000]) {
        const pose = fallPoseInto(down, ms, blankPose());
        p64.set([
          pose.x,
          pose.y,
          pose.z,
          pose.yaw,
          pose.pitch,
          pose.hx,
          pose.hz,
        ]);
        shipMatrixInto(p64, 0, cls, viewer, m, 0);
        const mat = new THREE.Matrix4().fromArray(m);
        for (const i of [0, 4, 10, 17, 27]) {
          const base = BOSS_PARTS[i] as BossPart;
          const scaled = (SHIP_PARTS[cls] as readonly BossPart[])[
            i
          ] as BossPart;
          // The base part's centre under the instance matrix…
          const drawn = new THREE.Vector3(base.x, base.y, base.z).applyMatrix4(
            mat,
          );
          // …is the class's scaled part centre placed by the pose.
          const want = shipPointInto(pose, scaled.x, scaled.y, scaled.z, {
            x: 0,
            y: 0,
            z: 0,
          });
          const dx = ((drawn.x - want.x + 3000) % 2000) - 1000;
          const dz = ((drawn.z - want.z + 3000) % 2000) - 1000;
          expect(Math.hypot(dx, drawn.y - want.y, dz)).toBeLessThan(1e-3);
        }
        // On the viewer's image: within half a world of it.
        expect(Math.abs((m[12] as number) - viewer.x)).toBeLessThanOrEqual(
          1000,
        );
        expect(Math.abs((m[14] as number) - viewer.z)).toBeLessThanOrEqual(
          1000,
        );
      }
    }
  });
});

describe("the weak points are real, hittable parts", () => {
  it("a round flown at each weak point's centre from outside meets it first, on every class", () => {
    const pose = { ...blankPose(), x: 1000, y: 585, z: 1000, yaw: 0.4 };
    pose.hx = Math.cos(0.4);
    pose.hz = -Math.sin(0.4);
    for (const cls of CLASSES) {
      for (let k = 0; k < BOSS_WEAK_POINTS.length; k++) {
        const p = (SHIP_PARTS[cls] as readonly BossPart[])[
          BOSS_WEAK_POINTS[k] as number
        ] as BossPart;
        const wp = weakPointInto(pose, cls, k, { x: 0, y: 0, z: 0 });
        const out =
          p.kind === "engine"
            ? [0, -1, 0]
            : p.y > 15 * (SHIP_CLASSES[cls]?.sr as number)
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
        const hit = shipRayHit(
          pose,
          cls,
          o,
          { x: d.x / len, y: d.y / len, z: d.z / len },
          400,
        );
        expect(hit?.weak).toBe(k);
      }
    }
  });
});
