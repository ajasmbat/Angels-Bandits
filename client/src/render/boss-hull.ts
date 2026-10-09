// S9 war-zeppelin carrier, the geometry: everything the boss renderer draws
// solid, built ONCE from the shared hull table (common/src/boss.ts) into a
// single skinned geometry — the whole carrier, intact or in three falling
// sections, its props, rudders, turrets, bay doors, trapeze, catapult, deck
// crew and the two planes on their rigs is ONE draw (boss.ts) — plus the
// additive glow geometry (searchlight beams, exhaust heat, muzzle flashes,
// catapult steam and sparks) on the same skeleton.
//
// Draw == collide: the envelope sections, the engine cars, the gas-cell
// blisters and the mooring cone are lathed from the SAME profiles collideBoss
// tests (BOSS_PROFILE / ENGINE_PROFILE / CELL_PROFILE), the box parts are
// drawn as their boxes. Everything else is tagged:
//  - TAG_SOLID  — the parts themselves (and flush trim on them, ≤ 0.2 m);
//  - TAG_DRESS  — non-solid dressing, never further than DRESS_REACH_M from
//    the solid hull (aerials, crew, ladders, walkways, lamp housings) or, for
//    the pennants only, PENNANT_REACH_M;
//  - TAG_RIG    — the launch rig and the planes on it (not hull: no plane is
//    solid to another).
// client/test/boss-hull.test.ts holds the solid and dressing vertices to the
// collision shape. Pure THREE (no DOM): the tests build it in node.

import {
  BAY_X,
  BOSS_DECK_Y,
  BOSS_PARTS,
  type BossPart,
  type BossProfile,
  CATAPULT_FROM_X,
  CATAPULT_TO_X,
  profileR,
} from "@angels-bandits/common/boss";
import * as THREE from "three";

// --- Vertex materials, tags, bones -----------------------------------------------

/** Per-vertex material codes the hull shader branches on. */
export const MAT_SKIN = 0;
export const MAT_METAL = 1;
export const MAT_GUN = 2;
export const MAT_BRASS = 3;
export const MAT_WINDOW = 4;
export const MAT_WEAK = 5;
export const MAT_DECAL = 6;
export const MAT_CLOTH = 7;
export const MAT_CREW = 8;
export const MAT_BAY = 9;
export const MAT_PLANE = 10;

export const TAG_SOLID = 0;
export const TAG_DRESS = 1;
export const TAG_RIG = 2;
/** How far non-solid dressing may stand off the solid hull, m. */
export const DRESS_REACH_M = 1.5;
/** ...and the pennants, which stream off the dorsal fin's tip. */
export const PENNANT_REACH_M = 5.5;

/** The skeleton: one bone per rigid body. The three sections are BOSS_PIECES
 * 0–2 (a part's bone is its `piece`); every other bone rides a section. */
export const BONE_FORE = 0;
export const BONE_MID = 1;
export const BONE_AFT = 2;
export const BONE_PROP = 3; // + engine 0..3
export const BONE_RUDDER_D = 7;
export const BONE_RUDDER_V = 8;
export const BONE_ELEV_S = 9;
export const BONE_ELEV_P = 10;
export const BONE_TURRET = 11; // + turret 0..5 (the head's traverse)
export const BONE_GUN = 17; // + turret 0..5 (traverse and elevation)
export const BONE_DOOR_P = 23;
export const BONE_DOOR_S = 24;
export const BONE_TRAPEZE = 25;
export const BONE_CARRIAGE = 26;
export const BONE_PLANE_BELLY = 27;
export const BONE_PLANE_DECK = 28;
export const BONE_CREW = 29; // + crew 0..CREW-1
export const CREW = 8;
export const BONE_LAMP = 37; // + lamp 0..2
export const LAMPS = 3;
export const BONE_COUNT = 40;

/** A bone's pivot in the hull frame and the section it rides. */
export interface BoneRest {
  x: number;
  y: number;
  z: number;
  section: 0 | 1 | 2;
}

// --- Layout -------------------------------------------------------------------------

const part = (i: number): BossPart => BOSS_PARTS[i] as BossPart;
/** The hangar keel's underside, the bay opening in it and its doors. */
const KEEL = part(9);
export const KEEL_BOTTOM = KEEL.y - KEEL.hy;
const BAY_X0 = BAY_X - 6;
const BAY_X1 = BAY_X + 6;
const BAY_HALF_W = 2.5;
/** The fins' rudders and elevators: the trailing 8 m, hinged here. */
export const HINGE_X = -111;
const FIN_TAIL_X = -119;
/** Crew patrol: deck x range, and their lanes either side of the rail. */
export const CREW_X0 = -8;
export const CREW_X1 = 48;
export const CREW_Z = 2.15;
/** The searchlights: two under the control car, one under the keel. */
export const LAMP_AT: readonly { x: number; y: number; z: number }[] = [
  { x: part(4).x + 3, y: part(4).y - part(4).hy, z: 1.6 },
  { x: part(4).x + 3, y: part(4).y - part(4).hy, z: -1.6 },
  { x: KEEL.x + 14, y: KEEL_BOTTOM, z: 0 },
];
/** The dorsal and ventral turrets' mounts (head pivot), from the parts. */
export const TURRET_PARTS: readonly number[] = [17, 18, 19, 20, 21, 22];

/** Every bone's pivot. Planes and crew pivot where they rest. */
export function boneRests(): BoneRest[] {
  const plane = { belly: PLANE_REST_BELLY, deck: PLANE_REST_DECK };
  const out: BoneRest[] = [];
  const set = (b: number, x: number, y: number, z: number, s: 0 | 1 | 2) => {
    out[b] = { x, y, z, section: s };
  };
  set(BONE_FORE, 0, 0, 0, 0);
  set(BONE_MID, 0, 0, 0, 1);
  set(BONE_AFT, 0, 0, 0, 2);
  for (let e = 0; e < 4; e++) {
    const p = part(10 + e);
    set(BONE_PROP + e, p.x - 6.8, p.y, p.z, 1);
  }
  set(BONE_RUDDER_D, HINGE_X, part(5).y, 0, 2);
  set(BONE_RUDDER_V, HINGE_X, part(6).y, 0, 2);
  set(BONE_ELEV_S, HINGE_X, 0, part(7).z, 2);
  set(BONE_ELEV_P, HINGE_X, 0, part(8).z, 2);
  TURRET_PARTS.forEach((pi, k) => {
    const p = part(pi);
    const up = p.y > 0 ? 1 : -1;
    set(BONE_TURRET + k, p.x, p.y, p.z, p.piece);
    set(BONE_GUN + k, p.x, p.y + up * 0.3, p.z, p.piece);
  });
  set(BONE_DOOR_P, BAY_X, KEEL_BOTTOM, 0, 1);
  set(BONE_DOOR_S, BAY_X, KEEL_BOTTOM, 0, 1);
  set(BONE_TRAPEZE, BAY_X, KEEL_BOTTOM, 0, 1);
  set(BONE_CARRIAGE, CATAPULT_FROM_X, BOSS_DECK_Y, 0, 1);
  set(BONE_PLANE_BELLY, plane.belly.x, plane.belly.y, plane.belly.z, 1);
  set(BONE_PLANE_DECK, plane.deck.x, plane.deck.y, plane.deck.z, 1);
  for (let c = 0; c < CREW; c++) {
    set(BONE_CREW + c, crewRestX(c), BOSS_DECK_Y, c % 2 ? -CREW_Z : CREW_Z, 1);
  }
  LAMP_AT.forEach((l, k) => set(BONE_LAMP + k, l.x, l.y, l.z, k < 2 ? 0 : 1));
  return out;
}

/** Crew member c's rest x (its walk's start). */
export const crewRestX = (c: number): number =>
  CREW_X0 + ((c * 7.3) % (CREW_X1 - CREW_X0));

// --- The builder --------------------------------------------------------------------

interface Opts {
  color: number;
  mat: number;
  bone: number;
  tag: number;
  weak?: number;
  /** Pennants: their own stand-off cap in the test. */
  pennant?: boolean;
}

/** A geometry as it is accumulated: flat arrays, non-indexed. */
class Acc {
  readonly pos: number[] = [];
  readonly nrm: number[] = [];
  readonly col: number[] = [];
  readonly uv: number[] = [];
  readonly mat: number[] = [];
  readonly weak: number[] = [];
  readonly bone: number[] = [];
  readonly tag: number[] = [];
  readonly pennant: number[] = [];
  private readonly c = new THREE.Color();

  add(src: THREE.BufferGeometry, o: Opts, m?: THREE.Matrix4): void {
    const g = src.index ? src.toNonIndexed() : src.clone();
    if (m) g.applyMatrix4(m);
    if (!g.getAttribute("normal")) g.computeVertexNormals();
    const p = g.getAttribute("position");
    const n = g.getAttribute("normal");
    const uv = g.getAttribute("uv");
    this.c.setHex(o.color);
    // Linear working colour (three's vertex colours are linear).
    const cr = this.c.r;
    const cg = this.c.g;
    const cb = this.c.b;
    for (let i = 0; i < p.count; i++) {
      this.pos.push(p.getX(i), p.getY(i), p.getZ(i));
      this.nrm.push(n.getX(i), n.getY(i), n.getZ(i));
      this.col.push(cr, cg, cb);
      this.uv.push(uv ? uv.getX(i) : 0, uv ? uv.getY(i) : 0);
      this.mat.push(o.mat);
      this.weak.push(o.weak ?? -1);
      this.bone.push(o.bone);
      this.tag.push(o.tag);
      this.pennant.push(o.pennant ? 1 : 0);
    }
    g.dispose();
  }

  /** Raw triangles (positions and normals already in the hull frame). */
  tris(
    pos: readonly number[],
    nrm: readonly number[],
    uv: readonly number[] | null,
    o: Opts,
  ): void {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3));
    if (uv) g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    this.add(g, o);
    g.dispose();
  }

  build(): BossHullGeometry {
    const g = new THREE.BufferGeometry();
    const n = this.pos.length / 3;
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute("aMat", new THREE.Float32BufferAttribute(this.mat, 1));
    g.setAttribute("aWeak", new THREE.Float32BufferAttribute(this.weak, 1));
    const idx = new Uint16Array(n * 4);
    const wts = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      idx[i * 4] = this.bone[i] as number;
      wts[i * 4] = 1;
    }
    g.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(idx, 4));
    g.setAttribute("skinWeight", new THREE.Float32BufferAttribute(wts, 4));
    // Posed on the torus image nearest the camera and split into falling
    // sections: no bound computed from the rest pose means anything.
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
    return {
      geometry: g,
      tag: Uint8Array.from(this.tag),
      bone: Uint8Array.from(this.bone),
      pennant: Uint8Array.from(this.pennant),
    };
  }
}

export interface BossHullGeometry {
  geometry: THREE.BufferGeometry;
  /** Per vertex: TAG_SOLID / TAG_DRESS / TAG_RIG, and its bone. */
  tag: Uint8Array;
  bone: Uint8Array;
  pennant: Uint8Array;
}

// --- Primitives (hull frame) ----------------------------------------------------

/**
 * A solid of revolution about the hull-frame X axis through (cx, cy, cz):
 * the profile's stations as rings of `seg` vertices (a polygon INSCRIBED in
 * the profile's circle — the faceting error is r(1 − cos π/seg)), flat
 * around, smooth along. `caps`: discs at ends whose radius is > 0.
 */
function lathe(
  acc: Acc,
  profile: BossProfile,
  cx: number,
  cy: number,
  cz: number,
  seg: number,
  o: Opts,
  caps = true,
  phase = 0,
): void {
  const pos: number[] = [];
  const nrm: number[] = [];
  const uv: number[] = [];
  const n = profile.length;
  // Smooth meridian normals at the stations: the average of the adjoining
  // segments' slopes.
  const slope = (i: number): number => {
    const a = profile[Math.max(0, i - 1)] as readonly [number, number];
    const b = profile[Math.min(n - 1, i + 1)] as readonly [number, number];
    const dx = b[0] - a[0];
    return dx > 1e-9 ? (b[1] - a[1]) / dx : 0;
  };
  const ang = (j: number) => phase + (j / seg) * Math.PI * 2;
  for (let i = 0; i + 1 < n; i++) {
    const a = profile[i] as readonly [number, number];
    const b = profile[i + 1] as readonly [number, number];
    if (b[0] - a[0] <= 1e-9) continue;
    if (a[1] <= 0 && b[1] <= 0) continue;
    const ka = slope(i);
    const kb = slope(i + 1);
    for (let j = 0; j < seg; j++) {
      const t0 = ang(j);
      const t1 = ang(j + 1);
      const tc = (t0 + t1) / 2;
      const cyc = Math.cos(tc);
      const czc = Math.sin(tc);
      const v = (x: number, r: number, t: number, k: number) => {
        pos.push(cx + x, cy + r * Math.cos(t), cz + r * Math.sin(t));
        const l = Math.hypot(k, 1);
        nrm.push(-k / l, cyc / l, czc / l);
        uv.push(x, t);
      };
      // Counter-clockwise seen from outside (three's front face).
      v(a[0], a[1], t0, ka);
      v(b[0], b[1], t1, kb);
      v(b[0], b[1], t0, kb);
      v(a[0], a[1], t0, ka);
      v(a[0], a[1], t1, ka);
      v(b[0], b[1], t1, kb);
    }
  }
  if (caps) {
    for (const [end, sx] of [
      [profile[0], -1],
      [profile[n - 1], 1],
    ] as const) {
      const [x, r] = end as readonly [number, number];
      if (r <= 0) continue;
      for (let j = 0; j < seg; j++) {
        const t0 = ang(j);
        const t1 = ang(j + 1);
        const pts =
          sx > 0
            ? [
                [0, 0],
                [r * Math.cos(t0), r * Math.sin(t0)],
                [r * Math.cos(t1), r * Math.sin(t1)],
              ]
            : [
                [0, 0],
                [r * Math.cos(t1), r * Math.sin(t1)],
                [r * Math.cos(t0), r * Math.sin(t0)],
              ];
        for (const [yy, zz] of pts) {
          pos.push(cx + x, cy + (yy as number), cz + (zz as number));
          nrm.push(sx, 0, 0);
          uv.push(x, 0);
        }
      }
    }
  }
  acc.tris(pos, nrm, uv, o);
}

/** A profile's stations from x0 to x1 (both inside it), interpolated ends. */
function slice(profile: BossProfile, x0: number, x1: number): BossProfile {
  const out: [number, number][] = [[x0, profileR(profile, x0)]];
  for (const [x, r] of profile) if (x > x0 && x < x1) out.push([x, r]);
  out.push([x1, profileR(profile, x1)]);
  return out;
}

const m4 = () => new THREE.Matrix4();
const at = (x: number, y: number, z: number) => m4().makeTranslation(x, y, z);

function boxAt(
  acc: Acc,
  x: number,
  y: number,
  z: number,
  hx: number,
  hy: number,
  hz: number,
  o: Opts,
): void {
  const g = new THREE.BoxGeometry(2 * hx, 2 * hy, 2 * hz);
  acc.add(g, o, at(x, y, z));
  g.dispose();
}

/** A cylinder of radius r from a to b. */
function rod(
  acc: Acc,
  a: THREE.Vector3,
  b: THREE.Vector3,
  r: number,
  o: Opts,
  seg = 6,
): void {
  const len = a.distanceTo(b);
  const g = new THREE.CylinderGeometry(r, r, len, seg, 1, false);
  const q = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    b.clone().sub(a).normalize(),
  );
  const mid = a.clone().add(b).multiplyScalar(0.5);
  acc.add(g, o, m4().compose(mid, q, new THREE.Vector3(1, 1, 1)));
  g.dispose();
}

/** A flat quad (decal, window, cloth) on the plane through `c` with unit
 * axes u (width) and v (height), facing u × v, uv 0–1. */
function quad(
  acc: Acc,
  c: THREE.Vector3,
  u: THREE.Vector3,
  v: THREE.Vector3,
  w: number,
  h: number,
  o: Opts,
  uv: readonly [number, number, number, number] = [0, 0, 1, 1],
): void {
  const n = u.clone().cross(v).normalize();
  const p = (su: number, sv: number) =>
    c
      .clone()
      .addScaledVector(u, (su * w) / 2)
      .addScaledVector(v, (sv * h) / 2);
  const corners = [p(-1, -1), p(1, -1), p(1, 1), p(-1, -1), p(1, 1), p(-1, 1)];
  const uvs = [
    [uv[0], uv[1]],
    [uv[2], uv[1]],
    [uv[2], uv[3]],
    [uv[0], uv[1]],
    [uv[2], uv[3]],
    [uv[0], uv[3]],
  ];
  const pos: number[] = [];
  const nrm: number[] = [];
  const tuv: number[] = [];
  corners.forEach((q, i) => {
    pos.push(q.x, q.y, q.z);
    nrm.push(n.x, n.y, n.z);
    const t = uvs[i] as number[];
    tuv.push(t[0] as number, t[1] as number);
  });
  acc.tris(pos, nrm, tuv, o);
}

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

// --- Colours ------------------------------------------------------------------

/** Silver-grey doped skin, gunmetal armour, near-black guns, brass. */
export const SKIN = 0x9ea4aa;
const ARMOUR = 0x3b4048;
const PLATE = 0x4a4f57;
const GUN = 0x1d1f23;
const BRASS = 0xa8823e;
const BAY = 0x1a1612;
const CLOTH = 0x2f6f6a;
const CREW_CLOTH = 0x3a3428;

// --- The carrier ------------------------------------------------------------------

/** Detail level: the full carrier within ~400 m, a light one beyond. */
export type HullDetail = "full" | "lite";

/** The launch planes' geometry (merged airframe, nose +X, origin at the
 * plane's centre), from the renderer — null in node tests. */
export interface PlaneGeo {
  parts: { geometry: THREE.BufferGeometry; color: number }[];
}

/** Where the rig planes rest (their bones' pivots), hull frame: stowed in
 * the bay, and on the catapult carriage. */
export const PLANE_REST_BELLY = new THREE.Vector3(BAY_X, -21.5, 0);
export const PLANE_REST_DECK = new THREE.Vector3(
  CATAPULT_FROM_X,
  BOSS_DECK_Y + 1.6,
  0,
);

export function buildBossHull(
  detail: HullDetail,
  plane: PlaneGeo | null = null,
): BossHullGeometry {
  const acc = new Acc();
  const full = detail === "full";
  const SOLID = TAG_SOLID;
  const seg = full ? 36 : 18;

  // The envelope: three lathed sections (their cut faces capped — a falling
  // section is a broken bulkhead, not a hollow tube). 36 sides like the
  // LZ 129's ring frames (girders where the polygon's corners are).
  for (const k of [1, 0, 3]) {
    const p = part(k);
    const prof = p.rev as BossProfile;
    lathe(acc, prof, p.x, p.y, p.z, k === 2 ? 12 : seg, {
      color: k === 2 ? BRASS : SKIN,
      mat: k === 2 ? MAT_BRASS : MAT_SKIN,
      bone: p.piece,
      tag: SOLID,
    });
  }
  // The mooring cone.
  {
    const p = part(2);
    lathe(acc, p.rev as BossProfile, p.x, p.y, p.z, 12, {
      color: BRASS,
      mat: MAT_BRASS,
      bone: 0,
      tag: SOLID,
    });
  }

  // Fins: the fixed vane, the moving surface aft of the hinge (its own bone).
  const finBones = [BONE_RUDDER_D, BONE_RUDDER_V, BONE_ELEV_S, BONE_ELEV_P];
  for (let f = 0; f < 4; f++) {
    const p = part(5 + f);
    const fixedX0 = HINGE_X;
    const fixedX1 = p.x + p.hx;
    boxAt(
      acc,
      (fixedX0 + fixedX1) / 2,
      p.y,
      p.z,
      (fixedX1 - fixedX0) / 2,
      p.hy,
      p.hz,
      { color: PLATE, mat: MAT_METAL, bone: 2, tag: SOLID },
    );
    boxAt(
      acc,
      (FIN_TAIL_X + HINGE_X) / 2,
      p.y,
      p.z,
      (HINGE_X - FIN_TAIL_X) / 2,
      p.hy * 0.995,
      p.hz * 0.995,
      {
        color: ARMOUR,
        mat: MAT_METAL,
        bone: finBones[f] as number,
        tag: SOLID,
      },
    );
    // The faction crest on both faces of the vane, outboard of the skin.
    const vertical = p.hz < p.hy;
    const out = vertical ? Math.sign(p.y) : Math.sign(p.z);
    for (const side of [1, -1]) {
      // u × v faces out of the face; u runs nose-ward on the starboard /
      // top face, so the crest reads the right way round from either side.
      const c = vertical
        ? V(-99, out * 21, side * (p.hz + 0.03))
        : V(-99, side * (p.hy + 0.03), out * 21);
      const v = vertical ? V(0, 1, 0) : V(0, 0, -1);
      quad(
        acc,
        c,
        V(side, 0, 0),
        v,
        10,
        10,
        {
          color: 0xffffff,
          mat: MAT_DECAL,
          bone: 2,
          tag: SOLID,
        },
        [0, 0, 0.5, 1],
      );
    }
  }

  // The control car: an armoured gondola with a lit window band all round,
  // a ladder up to the keel, and two searchlights under it.
  {
    const p = part(4);
    boxAt(acc, p.x, p.y, p.z, p.hx, p.hy, p.hz, {
      color: ARMOUR,
      mat: MAT_METAL,
      bone: 0,
      tag: SOLID,
    });
    const wy = p.y + 0.6;
    for (const s of [1, -1]) {
      quad(
        acc,
        V(p.x + 1.5, wy, s * (p.hz + 0.02)),
        V(s, 0, 0),
        V(0, 1, 0),
        11,
        1.3,
        {
          color: 0xffffff,
          mat: MAT_WINDOW,
          bone: 0,
          tag: SOLID,
        },
      );
    }
    quad(acc, V(p.x + p.hx + 0.02, wy, 0), V(0, 0, -1), V(0, 1, 0), 5.2, 1.5, {
      color: 0xffffff,
      mat: MAT_WINDOW,
      bone: 0,
      tag: SOLID,
    });
    if (full) {
      // Ladder on the aft face, car roof to the keel line.
      const lx = p.x - p.hx - 0.15;
      const y0 = p.y - p.hy + 0.3;
      const y1 = p.y + p.hy + 0.4;
      for (const z of [-0.35, 0.35]) {
        rod(acc, V(lx, y0, z), V(lx, y1, z), 0.04, {
          color: GUN,
          mat: MAT_GUN,
          bone: 0,
          tag: TAG_DRESS,
        });
      }
      for (let y = y0 + 0.3; y < y1; y += 0.45) {
        rod(acc, V(lx, y, -0.35), V(lx, y, 0.35), 0.03, {
          color: GUN,
          mat: MAT_GUN,
          bone: 0,
          tag: TAG_DRESS,
        });
      }
    }
  }

  // The hangar keel: its underside open over the bay, the bay's dark
  // interior with its amber work lights, and the two sliding doors.
  {
    const p = part(9);
    const x0 = p.x - p.hx;
    const x1 = p.x + p.hx;
    const yb = KEEL_BOTTOM;
    const yt = p.y + p.hy;
    const o = { color: ARMOUR, mat: MAT_METAL, bone: 1, tag: SOLID };
    // Sides, ends and roof as a box minus its bottom face.
    const g = new THREE.BoxGeometry(2 * p.hx, 2 * p.hy, 2 * p.hz);
    g.clearGroups();
    const idx = g.index as THREE.BufferAttribute;
    // BoxGeometry faces: +x, -x, +y, -y, +z, -z (6 indices × 2 tris each).
    const keep: number[] = [];
    for (let f = 0; f < 6; f++) {
      if (f === 3) continue;
      for (let i = 0; i < 6; i++) keep.push(idx.getX(f * 6 + i));
    }
    g.setIndex(keep);
    acc.add(g, o, at(p.x, p.y, p.z));
    g.dispose();
    // The underside around the bay opening.
    const bottom = (ax: number, bx: number, az: number, bz: number) =>
      quad(
        acc,
        V((ax + bx) / 2, yb, (az + bz) / 2),
        V(1, 0, 0),
        V(0, 0, 1),
        bx - ax,
        bz - az,
        o,
      );
    // quad's u × v = +x × +z = −y: facing down.
    bottom(x0, BAY_X0, -p.hz, p.hz);
    bottom(BAY_X1, x1, -p.hz, p.hz);
    bottom(BAY_X0, BAY_X1, BAY_HALF_W, p.hz);
    bottom(BAY_X0, BAY_X1, -p.hz, -BAY_HALF_W);
    // The bay: walls and ceiling facing in.
    const bay = { color: BAY, mat: MAT_BAY, bone: 1, tag: SOLID };
    const by = yb + 2.6;
    quad(
      acc,
      V((BAY_X0 + BAY_X1) / 2, by, 0),
      V(1, 0, 0),
      V(0, 0, -1),
      BAY_X1 - BAY_X0,
      2 * BAY_HALF_W,
      bay,
    );
    for (const s of [1, -1]) {
      quad(
        acc,
        V((BAY_X0 + BAY_X1) / 2, (yb + by) / 2, s * BAY_HALF_W),
        V(-s, 0, 0),
        V(0, 1, 0),
        BAY_X1 - BAY_X0,
        by - yb,
        bay,
      );
      quad(
        acc,
        V(s > 0 ? BAY_X1 : BAY_X0, (yb + by) / 2, 0),
        V(0, 0, s),
        V(0, 1, 0),
        2 * BAY_HALF_W,
        by - yb,
        bay,
      );
    }
    // Sliding doors, flush under the opening (they slide outboard).
    for (const [bone, s] of [
      [BONE_DOOR_S, 1],
      [BONE_DOOR_P, -1],
    ] as const) {
      boxAt(
        acc,
        BAY_X,
        yb - 0.06,
        (s * BAY_HALF_W) / 2,
        (BAY_X1 - BAY_X0) / 2,
        0.06,
        BAY_HALF_W / 2,
        {
          color: PLATE,
          mat: MAT_METAL,
          bone,
          tag: SOLID,
        },
      );
    }
    // The trapeze: two struts and a crossbar, 1 m long at rest (the bone
    // scales it to the drop), hanging from the bay roof line.
    const tr = { color: GUN, mat: MAT_GUN, bone: BONE_TRAPEZE, tag: TAG_RIG };
    for (const z of [-0.7, 0.7])
      rod(acc, V(BAY_X, yb, z), V(BAY_X, yb - 1, z), 0.12, tr);
    rod(acc, V(BAY_X, yb - 1, -0.8), V(BAY_X, yb - 1, 0.8), 0.14, tr);
  }

  // Engine cars: armoured nacelle fore and aft, the glowing radiator band
  // between (the weak point a pilot aims at), exhaust stacks, and the
  // six-blade ducted pusher (its own bone) — duct and blades fill the disc
  // collideBoss tests.
  for (let e = 0; e < 4; e++) {
    const p = part(10 + e);
    const prof = p.rev as BossProfile;
    const k = e; // weak point index
    lathe(
      acc,
      slice(prof, -6.5, -4),
      p.x,
      p.y,
      p.z,
      full ? 16 : 10,
      {
        color: ARMOUR,
        mat: MAT_METAL,
        bone: 1,
        tag: SOLID,
      },
      false,
    );
    lathe(
      acc,
      slice(prof, -4, 3),
      p.x,
      p.y,
      p.z,
      full ? 16 : 10,
      {
        color: 0xffffff,
        mat: MAT_WEAK,
        bone: 1,
        tag: SOLID,
        weak: k,
      },
      false,
    );
    lathe(
      acc,
      slice(prof, 3, 6.5),
      p.x,
      p.y,
      p.z,
      full ? 16 : 10,
      {
        color: PLATE,
        mat: MAT_METAL,
        bone: 1,
        tag: SOLID,
      },
      false,
    );
    // The tail of the nacelle closes on the hub.
    lathe(
      acc,
      [
        [-7.1, 0],
        [-6.5, 1.2],
      ],
      p.x,
      p.y,
      p.z,
      10,
      {
        color: BRASS,
        mat: MAT_BRASS,
        bone: BONE_PROP + e,
        tag: SOLID,
      },
      false,
    );
    const prop = { color: GUN, mat: MAT_GUN, bone: BONE_PROP + e, tag: SOLID };
    // The duct: a ring of the disc's radius and depth.
    lathe(
      acc,
      [
        [-7, 3.55],
        [-7, 4],
        [-6.6, 4],
        [-6.6, 3.55],
        [-7, 3.55],
      ],
      p.x,
      p.y,
      p.z,
      full ? 20 : 12,
      prop,
      false,
    );
    for (let b = 0; b < 6; b++) {
      const t = (b / 6) * Math.PI * 2;
      const tip = V(
        p.x - 6.8,
        p.y + 3.6 * Math.cos(t),
        p.z + 3.6 * Math.sin(t),
      );
      rod(acc, V(p.x - 6.8, p.y, p.z), tip, 0.32, prop, 4);
    }
    if (full) {
      // Exhaust stacks on the nacelle's back.
      for (const dx of [-1.5, 0, 1.5]) {
        rod(
          acc,
          V(p.x + dx, p.y + 2.6, p.z),
          V(p.x + dx - 0.6, p.y + 3.7, p.z),
          0.22,
          {
            color: GUN,
            mat: MAT_GUN,
            bone: 1,
            tag: TAG_DRESS,
          },
        );
      }
    }
  }
  // Their struts.
  for (let s = 0; s < 4; s++) {
    const p = part(23 + s);
    boxAt(acc, p.x, p.y, p.z, p.hx, p.hy, p.hz, {
      color: ARMOUR,
      mat: MAT_METAL,
      bone: 1,
      tag: SOLID,
    });
  }

  // Gas-cell blisters: armoured spindles, their lattice glowing (weak points).
  for (let c = 0; c < 3; c++) {
    const p = part(14 + c);
    lathe(acc, p.rev as BossProfile, p.x, p.y, p.z, full ? 16 : 10, {
      color: 0xffffff,
      mat: MAT_WEAK,
      bone: 1,
      tag: SOLID,
      weak: 4 + c,
    });
  }

  // Turrets: an armoured ring on the skin, the traversing head (its bone)
  // and twin barrels (traverse and elevation: their bone).
  TURRET_PARTS.forEach((pi, k) => {
    const p = part(pi);
    const up = p.y > 0 ? 1 : -1;
    const base0 = V(p.x, p.y - up * p.hy, p.z);
    // A full-footprint base plate, then the traversing cupola: a sloped
    // four-sided armour frustum (half-width 2.6 m at its foot, 2.1 at its
    // roof) — boxy enough to fill its collision box at any traverse.
    const base = new THREE.BoxGeometry(2 * p.hx, 0.7, 2 * p.hz);
    acc.add(
      base,
      { color: ARMOUR, mat: MAT_METAL, bone: p.piece, tag: SOLID },
      at(base0.x, base0.y + up * 0.35, base0.z),
    );
    base.dispose();
    const head = new THREE.CylinderGeometry(
      2.1 * Math.SQRT2,
      2.6 * Math.SQRT2,
      2.9,
      4,
    );
    const hm = at(p.x, base0.y + up * (0.7 + 1.45), p.z).multiply(
      m4().makeRotationY(Math.PI / 4),
    );
    if (up < 0) hm.multiply(m4().makeRotationX(Math.PI));
    acc.add(
      head,
      { color: PLATE, mat: MAT_METAL, bone: BONE_TURRET + k, tag: SOLID },
      hm,
    );
    head.dispose();
    const gun = { color: GUN, mat: MAT_GUN, bone: BONE_GUN + k, tag: SOLID };
    const gy = p.y + up * 0.3;
    for (const dz of [-0.55, 0.55]) {
      rod(
        acc,
        V(p.x + 0.8, gy, p.z + dz),
        V(p.x + 3.4, gy, p.z + dz),
        0.17,
        gun,
      );
    }
  });

  // The catapult deck: the plate, its rails, the steam main along it, the
  // carriage (its bone), and the deck crew.
  {
    const d = part(27);
    const top = BOSS_DECK_Y;
    const bot = d.y - d.hy;
    boxAt(acc, d.x, (top + bot) / 2, d.z, d.hx, (top - bot) / 2, d.hz, {
      color: PLATE,
      mat: MAT_METAL,
      bone: 1,
      tag: SOLID,
    });
    const rail = { color: GUN, mat: MAT_GUN, bone: 1, tag: SOLID };
    for (const z of [-0.8, 0.8]) {
      boxAt(
        acc,
        (CATAPULT_FROM_X - 4 + CATAPULT_TO_X + 4) / 2,
        top + 0.12,
        z,
        (CATAPULT_TO_X - CATAPULT_FROM_X + 8) / 2,
        0.12,
        0.12,
        rail,
      );
    }
    rod(
      acc,
      V(d.x - d.hx + 1, top + 0.25, -1.7),
      V(d.x + d.hx - 1, top + 0.25, -1.7),
      0.22,
      {
        color: BRASS,
        mat: MAT_BRASS,
        bone: 1,
        tag: SOLID,
      },
    );
    boxAt(acc, CATAPULT_FROM_X, top + 0.35, 0, 1.4, 0.22, 1.1, {
      color: BRASS,
      mat: MAT_BRASS,
      bone: BONE_CARRIAGE,
      tag: TAG_RIG,
    });
    if (full) {
      for (let c = 0; c < CREW; c++) {
        const x = crewRestX(c);
        const z = c % 2 ? -CREW_Z : CREW_Z;
        const crew = {
          color: CREW_CLOTH,
          mat: MAT_CREW,
          bone: BONE_CREW + c,
          tag: TAG_DRESS,
        };
        boxAt(acc, x, top + 0.42, z, 0.17, 0.42, 0.11, crew);
        boxAt(acc, x, top + 1.13, z, 0.22, 0.3, 0.13, crew);
        boxAt(acc, x, top + 1.56, z, 0.12, 0.12, 0.12, {
          ...crew,
          color: 0xc89878,
        });
      }
    }
  }

  if (full) {
    // Crew walkways along the spine fore and aft of the deck, a hand's
    // breadth off the skin, and the aerial masts.
    const walk = { color: ARMOUR, mat: MAT_METAL, bone: 1, tag: TAG_DRESS };
    const strip = (x0: number, x1: number, bone: number) => {
      const pos: number[] = [];
      const nrm: number[] = [];
      for (let x = x0; x < x1 - 1e-6; x += 4) {
        const xb = Math.min(x1, x + 4);
        const ya = profileR(PROFILE, x) + 0.12;
        const yb2 = profileR(PROFILE, xb) + 0.12;
        const q = [
          [x, ya, -0.45],
          [xb, yb2, 0.45],
          [xb, yb2, -0.45],
          [x, ya, -0.45],
          [x, ya, 0.45],
          [xb, yb2, 0.45],
        ];
        for (const v of q) {
          pos.push(...(v as [number, number, number]));
          nrm.push(0, 1, 0);
        }
      }
      acc.tris(pos, nrm, null, { ...walk, bone });
    };
    strip(-84, -50, 2);
    strip(-50, -12, 1);
    strip(56, 92, 0);
    const mast = { color: GUN, mat: MAT_GUN, bone: 0, tag: TAG_DRESS };
    for (const [x, b] of [
      [64, 0],
      [-20, 1],
      [-64, 2],
    ] as const) {
      const y = profileR(PROFILE, x);
      rod(
        acc,
        V(x, y, 0.9),
        V(x, y + 1.35, 0.9),
        0.05,
        { ...mast, bone: b },
        4,
      );
      rod(
        acc,
        V(x, -y, 0.9),
        V(x, -y - 1.35, 0.9),
        0.05,
        { ...mast, bone: b },
        4,
      );
    }
    // Pennants streaming off the dorsal fin's tip.
    const fin = part(5);
    for (const [dy, len] of [
      [-0.6, 5],
      [-1.6, 3.6],
    ] as const) {
      const pos: number[] = [];
      const nrm: number[] = [];
      const uv: number[] = [];
      const x0 = FIN_TAIL_X;
      const y0 = fin.y + fin.hy + dy;
      const n = 8;
      for (let i = 0; i < n; i++) {
        const a = i / n;
        const b = (i + 1) / n;
        const ha = 0.45 * (1 - a * 0.8);
        const hb = 0.45 * (1 - b * 0.8);
        const xa = x0 - a * len;
        const xb = x0 - b * len;
        const q = [
          [xa, y0 - ha, a],
          [xb, y0 - hb, b],
          [xb, y0 + hb, b],
          [xa, y0 - ha, a],
          [xb, y0 + hb, b],
          [xa, y0 + ha, a],
        ];
        for (const [x, y, t] of q) {
          pos.push(x as number, y as number, 0);
          nrm.push(0, 0, 1);
          uv.push(t as number, 0);
        }
      }
      acc.tris(pos, nrm, uv, {
        color: CLOTH,
        mat: MAT_CLOTH,
        bone: 2,
        tag: TAG_DRESS,
        pennant: true,
      });
    }
  }

  // (The crest and the name on the flanks are painted by the skin shader
  // straight onto the curved envelope — boss.ts — not a flat decal.)

  // Searchlight housings (their bone sweeps them; the beam is glow).
  LAMP_AT.forEach((l, k) => {
    rod(
      acc,
      V(l.x, l.y - 0.1, l.z),
      V(l.x, l.y - 1.3, l.z),
      0.55,
      {
        color: BRASS,
        mat: MAT_BRASS,
        bone: BONE_LAMP + k,
        tag: TAG_DRESS,
      },
      10,
    );
  });

  // The planes on their rigs.
  if (plane) {
    const rest = [
      [BONE_PLANE_BELLY, PLANE_REST_BELLY],
      [BONE_PLANE_DECK, PLANE_REST_DECK],
    ] as const;
    for (const [bone, r] of rest) {
      for (const pp of plane.parts) {
        acc.add(
          pp.geometry,
          { color: pp.color, mat: MAT_PLANE, bone, tag: TAG_RIG },
          at(r.x, r.y, r.z),
        );
      }
    }
  }
  return acc.build();
}
const PROFILE = (BOSS_PARTS[0] as BossPart).rev
  ? // The whole envelope's table, through the shared export.
    ((): BossProfile => {
      const out: [number, number][] = [];
      for (const k of [3, 0, 1]) {
        const p = part(k);
        for (const [x, r] of p.rev as BossProfile) {
          const hx = x + p.x;
          if (out.length && hx <= (out[out.length - 1] as [number, number])[0])
            continue;
          out.push([hx, r]);
        }
      }
      return out;
    })()
  : [];

// --- The glow (additive) ------------------------------------------------------------

/** Glow vertex kinds the glow shader scales: beams by their lamp, flashes by
 * their turret, steam and sparks by the catapult, exhaust heat by time. */
export const GLOW_BEAM = 0;
export const GLOW_HEAT = 1;
export const GLOW_FLASH = 2;
export const GLOW_STEAM = 3;
export const GLOW_SPARK = 4;
export const GLOW_LENS = 5;
/** Searchlight beam length and spread, m. */
export const BEAM_LEN = 330;
const BEAM_R = 16;

export function buildBossGlow(): THREE.BufferGeometry {
  const pos: number[] = [];
  const col: number[] = [];
  const kind: number[] = [];
  const idx: number[] = [];
  const along: number[] = [];
  const bone: number[] = [];
  const push = (
    g: THREE.BufferGeometry,
    m: THREE.Matrix4,
    rgb: [number, number, number],
    k: number,
    i: number,
    b: number,
    alongOf: (p: THREE.Vector3) => number,
  ) => {
    const ng = g.index ? g.toNonIndexed() : g;
    ng.applyMatrix4(m);
    const p = ng.getAttribute("position");
    const v = new THREE.Vector3();
    for (let n = 0; n < p.count; n++) {
      v.fromBufferAttribute(p, n);
      pos.push(v.x, v.y, v.z);
      col.push(...rgb);
      kind.push(k);
      idx.push(i);
      along.push(alongOf(v));
      bone.push(b);
    }
  };
  // Beams: open cones down from each lamp (the bone aims them).
  LAMP_AT.forEach((l, k) => {
    const g = new THREE.CylinderGeometry(0.5, BEAM_R, BEAM_LEN, 20, 1, true);
    const m = at(l.x, l.y - 1.3 - BEAM_LEN / 2, l.z);
    const top = l.y - 1.3;
    push(
      g,
      m,
      [1, 0.92, 0.75],
      GLOW_BEAM,
      k,
      BONE_LAMP + k,
      (v) => (top - v.y) / BEAM_LEN,
    );
    g.dispose();
    const lens = new THREE.CircleGeometry(0.5, 12);
    const lm = at(l.x, l.y - 1.32, l.z).multiply(
      m4().makeRotationX(Math.PI / 2),
    );
    push(lens, lm, [1, 0.95, 0.85], GLOW_LENS, k, BONE_LAMP + k, () => 0);
    lens.dispose();
  });
  // Exhaust heat: two crossed quads over each nacelle's stacks.
  for (let e = 0; e < 4; e++) {
    const p = part(10 + e);
    for (const rot of [0, Math.PI / 2]) {
      const g = new THREE.PlaneGeometry(7, 2.2, 6, 1);
      const m = at(p.x - 3.6, p.y + 4.4, p.z).multiply(m4().makeRotationX(rot));
      push(
        g,
        m,
        [1, 0.45, 0.15],
        GLOW_HEAT,
        e,
        BONE_MID,
        (v) => (p.x - v.x + 0.5) / 7,
      );
      g.dispose();
    }
  }
  // Muzzle flashes at each turret's barrels.
  TURRET_PARTS.forEach((pi, k) => {
    const p = part(pi);
    const up = p.y > 0 ? 1 : -1;
    for (const rot of [0, Math.PI / 2]) {
      const g = new THREE.PlaneGeometry(2.6, 1.6);
      const m = at(p.x + 4.4, p.y + up * 0.3, p.z)
        .multiply(m4().makeRotationX(rot))
        .multiply(m4().makeRotationY(Math.PI / 2));
      push(g, m, [1, 0.7, 0.35], GLOW_FLASH, k, BONE_GUN + k, () => 0);
      g.dispose();
    }
  });
  // Catapult steam at the breech, sparks at the carriage.
  for (const rot of [0, Math.PI / 2]) {
    const g = new THREE.PlaneGeometry(9, 4, 4, 2);
    const m = at(CATAPULT_FROM_X - 4, BOSS_DECK_Y + 1.6, 0).multiply(
      m4().makeRotationX(rot),
    );
    push(
      g,
      m,
      [0.75, 0.78, 0.8],
      GLOW_STEAM,
      0,
      BONE_MID,
      (v) => (CATAPULT_FROM_X + 0.5 - v.x) / 9,
    );
    g.dispose();
    const s = new THREE.PlaneGeometry(4, 0.7);
    const sm = at(CATAPULT_FROM_X - 2, BOSS_DECK_Y + 0.3, 0).multiply(
      m4().makeRotationX(rot),
    );
    push(
      s,
      sm,
      [1, 0.7, 0.3],
      GLOW_SPARK,
      0,
      BONE_CARRIAGE,
      (v) => (CATAPULT_FROM_X - v.x) / 4,
    );
    s.dispose();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute("aKind", new THREE.Float32BufferAttribute(kind, 1));
  g.setAttribute("aIdx", new THREE.Float32BufferAttribute(idx, 1));
  g.setAttribute("aAlong", new THREE.Float32BufferAttribute(along, 1));
  const n = pos.length / 3;
  const si = new Uint16Array(n * 4);
  const sw = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    si[i * 4] = bone[i] as number;
    sw[i * 4] = 1;
  }
  g.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(si, 4));
  g.setAttribute("skinWeight", new THREE.Float32BufferAttribute(sw, 4));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
  return g;
}

/** The catapult's run, for the renderer's sparks (hull x). */
export const CATAPULT_RUN = [CATAPULT_FROM_X, CATAPULT_TO_X] as const;
