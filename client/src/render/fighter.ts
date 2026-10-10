// DT1: the enemy fighter-bomber — the Eisenwolke Air Syndicate's carrier
// plane (the S9 war-zeppelin launches them), a dieselpunk inverted-gull
// monoplane that reads as the opposite of the player's red biplane at a
// glance: one long low wing kinked down then up, a long inline-V12 nose with
// a chin radiator and six flame-tongued stacks a side, a framed greenhouse
// with a gas-masked pilot and a rear gunner, spatted "trouser" gear with a
// siren, wing cannons, and bombs on a centreline trapeze and four wing racks.
//
// Built entirely from Three.js geometry like the biplane (no assets), ONCE
// per page into shared geometry: the near airframe (statics + the hinged
// ailerons / elevator / rudder, the prop and the five bombs, each baked into
// its pivot space), the glass, a simplified mid level and a low-poly far
// impostor. Every vertex carries the fleet layout (fleet.ts): its colour
// (the camouflage is baked per vertex — grey-green above, pale teal-grey
// below), the model-space rest position the damage and detail shaders key
// on, and the packed part data (hinge / bomb id, skin class, exhaust-glow
// mask, hole mode) plus roughness / metalness. So an enemy is ONE instanced
// draw up close however many there are, and its paintwork — splinter camo,
// panel lines, rivets, soot, oil, chipped paint and the decals (a FICTIONAL
// faction roundel, the carrier's tail code, a shark mouth) — is procedural
// in its fragment shader, projected from the rest position (no uv, no new
// attribute). The decal atlas is the only canvas; the geometry is DOM-free.
//
// Axes: +Z = nose, +Y = up, model +X = the pilot's left (as the biplane).
// ~10.3 m span, ~9.4 m long. The W2 seam: FIGHTER_BOMB_RACKS (game-local
// mounts) and the rig's `bombs` mask (plane.ts) — a cleared bit hides that
// bomb on the rack.

import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import {
  type LoftSpec,
  type Pivot,
  type Section,
  camber,
  loft,
  normalize,
  strut,
} from "./biplane";

// --- Palette: the Eisenwolke Air Syndicate (boss.ts's crest colours) -------

/** Upper camouflage base (the shader adds the darker splinter tone). */
const CAMO_UPPER = 0x4c564d;
/** Undersides: pale grey-teal. */
const CAMO_LOWER = 0x7e9294;
const TEAL = 0x1f5d5a;
const BRASS = 0xc79a45;
const CREAM = 0xe9dfc4;
const GUNMETAL = 0x2b2e33;
const STEEL = 0x8b9197;
const DARK = 0x17181a;
const RUBBER = 0x121212;
const LEATHER = 0x3a2a1e;
const JACKET = 0x2d3128;
const MASK = 0x1d1f1c;
/** Goggle lenses: smoked red glass — glossy, never emissive. */
const LENS = 0x5a1210;
const BOMB = 0x3a4430;
const BOMB_BAND = 0xd2a82c;
/** Flame tongues: their glow is the exhaust ring's rung (planelights.ts). */
const FLAME = 0xff9a3a;
const STACK = 0x3a2c26;

// --- Layout -----------------------------------------------------------------

/** Wing: NACA-ish thick section, the gull knee and the panels' planform. */
const WING_SECTION: Section = { m: 0.025, p: 0.4, t: 0.14 };
const TAIL_SECTION: Section = { m: 0, p: 0.4, t: 0.09 };
/** Inner (anhedral) and outer (dihedral) panels: tan of the angles. */
const INNER_TAN = -0.231; // −13°
const OUTER_TAN = 0.149; // +8.5°
const ROOT_Y = -0.32;
const KNEE_X = 2.0;
const KNEE_Y = ROOT_Y + KNEE_X * INNER_TAN;
const OUTER_Y0 = KNEE_Y - KNEE_X * OUTER_TAN;
export const FIGHTER_TIP_X = 5.15;
const TIP_ROUND = 4.72;
const chordAt = (ax: number): number =>
  ax <= KNEE_X
    ? 2.1 - 0.25 * (ax / KNEE_X)
    : 1.85 - 0.9 * ((ax - KNEE_X) / (FIGHTER_TIP_X - KNEE_X));
const zcAt = (ax: number): number =>
  ax <= KNEE_X
    ? 0.35 - 0.05 * (ax / KNEE_X)
    : 0.3 - 0.25 * ((ax - KNEE_X) / (FIGHTER_TIP_X - KNEE_X));
/** Wing camber-line height at span |x|. */
const wingY = (ax: number): number =>
  ax <= KNEE_X ? ROOT_Y + ax * INNER_TAN : OUTER_Y0 + ax * OUTER_TAN;
/** Aileron span (outer panel) and chord split. */
const AILERON_IN = 3.05;
const AILERON_OUT = 4.7;
const AILERON_HINGE_C = 0.74;
const AILERON_FRONT_C = 0.765;
/** Tailplane, elevator split and the rudder's gap / hinge post. */
const STAB = { y: 0.22, z: -3.8, chord: 1.1, half: 1.95, tip: 1.5 };
const ELEVATOR_HINGE_C = 0.62;
const ELEVATOR_FRONT_C = 0.645;
const ELEVATOR_GAP = 0.12;
const RUDDER_HINGE = new THREE.Vector3(0, 0.12, -4.3);
/** Prop hub plane and blade radius (the blur disc is scaled to it). */
export const FIGHTER_PROP_Z = 4.2;
export const FIGHTER_PROP_RADIUS = 1.5;

/** Fuselage side profile (radius, z), nose to tail. */
const FUSELAGE: [number, number][] = [
  [0.3, 4.05],
  [0.47, 3.95],
  [0.57, 3.6],
  [0.63, 3.0],
  [0.66, 2.2],
  [0.68, 1.2],
  [0.67, 0.3],
  [0.62, -0.8],
  [0.52, -2.0],
  [0.38, -3.2],
  [0.24, -4.1],
  [0.1, -4.55],
  [0.001, -4.62],
];
const FUSELAGE_SQUASH = 0.84;

function fuselageRadius(z: number): number {
  for (let i = 0; i < FUSELAGE.length - 1; i++) {
    const [ra, za] = FUSELAGE[i] as [number, number];
    const [rb, zb] = FUSELAGE[i + 1] as [number, number];
    if (z <= za && z >= zb) return ra + ((rb - ra) * (za - z)) / (za - zb);
  }
  return 0;
}

// --- Bombs: the W2 seam -----------------------------------------------------

/** Per-vertex ids of the bombs in the near airframe (fleet.ts collapses a
 * bomb whose bit in the plane's mask is clear). Above every hinge id. */
export const BOMB_ID_BASE = 8;
/** All five bombs loaded. */
export const BOMBS_FULL = 0b11111;

/** Where each bomb hangs, model space (+Z nose): the heavy one on the
 * centreline trapeze, then two light ones under each outer wing. */
const BOMB_MOUNTS: readonly {
  x: number;
  y: number;
  z: number;
  heavy: boolean;
}[] = [
  { x: 0, y: -1.05, z: 0.3, heavy: true },
  { x: 2.75, y: wingY(2.75) - 0.27, z: zcAt(2.75), heavy: false },
  { x: -2.75, y: wingY(2.75) - 0.27, z: zcAt(2.75), heavy: false },
  { x: 3.5, y: wingY(3.5) - 0.26, z: zcAt(3.5), heavy: false },
  { x: -3.5, y: wingY(3.5) - 0.26, z: zcAt(3.5), heavy: false },
];

/**
 * The bomb racks in GAME-local coordinates (forward −Z, right +X, up +Y —
 * as planelights.ts LIGHT_MOUNTS): bit `i` of a plane's `bombs` mask is
 * rack `i`. W2 releases a bomb by clearing its bit and spawning the falling
 * bomb at the rack.
 */
export const FIGHTER_BOMB_RACKS: readonly {
  x: number;
  y: number;
  z: number;
  heavy: boolean;
}[] = BOMB_MOUNTS.map((m) => ({ x: -m.x, y: m.y, z: -m.z, heavy: m.heavy }));

// --- Tags: what a part is made of -------------------------------------------

/** Skin classes for the detail shader (aPart.y): 0 none, 1 fuselage, 2 a
 * flying surface, 3 the cowling. */
export const SKIN_FUSELAGE = 1;
export const SKIN_SURFACE = 2;
export const SKIN_COWL = 3;

interface FTag {
  tint: number;
  rough: number;
  metal: number;
  /** 1: glows with the exhaust ring (stacks, flame tongues). */
  exhaust: number;
  skin: number;
  /** Damage hole mode (plane.ts): 0.5 holes read dark, 0 never holed. */
  hole: number;
  /** Camouflage by normal (grey-green above, pale below) instead of tint. */
  painted: boolean;
  glass: boolean;
}

const tag = (t: Partial<FTag>): THREE.MeshBasicMaterial => {
  const m = new THREE.MeshBasicMaterial();
  m.userData.ft = {
    tint: 0xffffff,
    rough: 0.6,
    metal: 0.2,
    exhaust: 0,
    skin: 0,
    hole: 0,
    painted: false,
    glass: false,
    ...t,
  } satisfies FTag;
  return m;
};

const T = {
  fuselage: tag({
    painted: true,
    skin: SKIN_FUSELAGE,
    hole: 0.5,
    rough: 0.55,
    metal: 0.3,
  }),
  surface: tag({
    painted: true,
    skin: SKIN_SURFACE,
    hole: 0.5,
    rough: 0.55,
    metal: 0.3,
  }),
  cowl: tag({
    painted: true,
    skin: SKIN_COWL,
    hole: 0.5,
    rough: 0.48,
    metal: 0.35,
  }),
  frame: tag({ tint: CAMO_UPPER, rough: 0.5, metal: 0.35 }),
  teal: tag({ tint: TEAL, rough: 0.38, metal: 0.35 }),
  brass: tag({ tint: BRASS, rough: 0.28, metal: 0.85 }),
  cream: tag({ tint: CREAM, rough: 0.5, metal: 0.05 }),
  gunmetal: tag({ tint: GUNMETAL, rough: 0.42, metal: 0.75 }),
  steel: tag({ tint: STEEL, rough: 0.32, metal: 0.85 }),
  dark: tag({ tint: DARK, rough: 0.85, metal: 0.15 }),
  rubber: tag({ tint: RUBBER, rough: 0.9, metal: 0 }),
  stack: tag({ tint: STACK, rough: 0.6, metal: 0.5, exhaust: 1 }),
  flame: tag({ tint: FLAME, rough: 0.9, metal: 0, exhaust: 1 }),
  leather: tag({ tint: LEATHER, rough: 0.85, metal: 0 }),
  jacket: tag({ tint: JACKET, rough: 0.9, metal: 0 }),
  mask: tag({ tint: MASK, rough: 0.7, metal: 0.1 }),
  lens: tag({ tint: LENS, rough: 0.08, metal: 0.4 }),
  bomb: tag({ tint: BOMB, rough: 0.6, metal: 0.3 }),
  band: tag({ tint: BOMB_BAND, rough: 0.6, metal: 0.2 }),
  glass: tag({ glass: true }),
};

// --- Baking -----------------------------------------------------------------

const scratchColor = new THREE.Color();
const upperColor = new THREE.Color(CAMO_UPPER);
const lowerColor = new THREE.Color(CAMO_LOWER);
const scratchN = new THREE.Vector3();
const scratchNM = new THREE.Matrix3();

interface Baked {
  opaque: THREE.BufferGeometry | null;
  glass: THREE.BufferGeometry | null;
}

/**
 * Flatten every tagged Mesh under `root` into one opaque and one glass
 * geometry in `root`'s space, in the fleet layout: position / normal / uv /
 * color / aHole / aRest (biplane.ts normalize) plus aPart (x hinge or bomb
 * id, y skin class, z exhaust mask, w hole mode) and aRM (roughness,
 * metalness). `restOf` maps root space to model space (hinged parts);
 * `hinge` is the default id, a mesh's `userData.hinge` overrides it.
 */
function bake(root: THREE.Object3D, restOf?: THREE.Matrix4, hinge = 0): Baked {
  root.updateMatrixWorld(true);
  const toRoot = root.matrixWorld.clone().invert();
  const opaque: THREE.BufferGeometry[] = [];
  const glass: THREE.BufferGeometry[] = [];
  const local = new THREE.Matrix4();
  const rest = new THREE.Matrix4();
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const t = (o.material as THREE.Material).userData.ft as FTag;
    local.multiplyMatrices(toRoot, o.matrixWorld);
    if (restOf) rest.multiplyMatrices(restOf, local);
    else rest.copy(local);
    const g = normalize(
      o.geometry,
      local,
      t.painted ? 0xffffff : t.tint,
      t.hole,
      restOf ? rest : undefined,
    );
    o.geometry.dispose();
    const n = (g.getAttribute("position") as THREE.BufferAttribute).count;
    if (t.painted) {
      // Camouflage by the rest-space normal: a soft demarcation along the
      // flanks, the vertex density keeps it from reading as a hard line.
      const nrm = g.getAttribute("normal") as THREE.BufferAttribute;
      const col = g.getAttribute("color") as THREE.BufferAttribute;
      // The baked normal is in root space; restOf takes it to model space.
      if (restOf) scratchNM.getNormalMatrix(restOf);
      else scratchNM.identity();
      for (let i = 0; i < n; i++) {
        scratchN
          .fromBufferAttribute(nrm, i)
          .applyMatrix3(scratchNM)
          .normalize();
        const k = THREE.MathUtils.smoothstep(scratchN.y, -0.32, 0.12);
        scratchColor.copy(lowerColor).lerp(upperColor, k);
        col.setXYZ(
          i,
          col.getX(i) * scratchColor.r,
          col.getY(i) * scratchColor.g,
          col.getZ(i) * scratchColor.b,
        );
      }
    }
    const id = (o.userData.hinge as number | undefined) ?? hinge;
    const part = new Float32Array(n * 4);
    const rm = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      part[i * 4] = id;
      part[i * 4 + 1] = t.skin;
      part[i * 4 + 2] = t.exhaust;
      part[i * 4 + 3] = t.hole;
      rm[i * 2] = t.rough;
      rm[i * 2 + 1] = t.metal;
    }
    g.setAttribute("aPart", new THREE.BufferAttribute(part, 4));
    g.setAttribute("aRM", new THREE.BufferAttribute(rm, 2));
    (t.glass ? glass : opaque).push(g);
  });
  const merge = (list: THREE.BufferGeometry[]) => {
    if (list.length === 0) return null;
    const m = mergeGeometries(list, false);
    if (!m) throw new Error("fighter: merge failed");
    for (const g of list) g.dispose();
    m.computeBoundingSphere();
    m.userData.shared = true;
    return m;
  };
  return { opaque: merge(opaque), glass: merge(glass) };
}

function pivotMatrix(p: Pivot): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    p.position,
    new THREE.Quaternion().setFromEuler(p.rotation),
    new THREE.Vector3(1, 1, 1),
  );
}

/** Bake model-space parts into a hinged part's pivot space (aRest = model). */
function bakeHinged(parts: THREE.Mesh[], pivot: Pivot): THREE.BufferGeometry {
  const root = new THREE.Group();
  root.position.copy(pivot.position);
  root.rotation.copy(pivot.rotation);
  root.updateMatrixWorld(true);
  const holder = new THREE.Group();
  holder.applyMatrix4(root.matrixWorld.clone().invert());
  for (const p of parts) holder.add(p);
  root.add(holder);
  const { opaque } = bake(root, pivotMatrix(pivot));
  if (!opaque) throw new Error("fighter: empty hinged part");
  return opaque;
}

// --- Part helpers -----------------------------------------------------------

/** A wing / tail piece: the biplane's loft on this plane's planform. */
function wingPiece(
  x0: number,
  x1: number,
  inner: boolean,
  c0: number,
  c1: number,
  stations: number,
): THREE.Mesh {
  const spec: LoftSpec = {
    section: WING_SECTION,
    x0,
    x1,
    c0,
    c1,
    chord: 1,
    zc: 0,
    y0: inner ? ROOT_Y : OUTER_Y0,
    dihedral: Math.atan(inner ? INNER_TAN : OUTER_TAN),
    fabric: false,
    chordAt,
    zcAt,
    stations,
  };
  if (!inner && Math.max(Math.abs(x0), Math.abs(x1)) > TIP_ROUND + 0.01) {
    spec.tipStart = TIP_ROUND;
    spec.tipEnd = FIGHTER_TIP_X;
  }
  return new THREE.Mesh(loft(spec), T.surface);
}

/** A point on the wing's camber line at span x, chord fraction c. */
function wingPoint(x: number, c: number): THREE.Vector3 {
  const ax = Math.abs(x);
  const chord = chordAt(ax);
  return new THREE.Vector3(
    x,
    wingY(ax) + chord * (camber(WING_SECTION, c) - WING_SECTION.m * 0.8),
    zcAt(ax) + chord / 2 - c * chord,
  );
}

function mesh(
  geo: THREE.BufferGeometry,
  material: THREE.Material,
  x = 0,
  y = 0,
  z = 0,
): THREE.Mesh {
  const m = new THREE.Mesh(geo, material);
  m.position.set(x, y, z);
  return m;
}

/** A body of revolution along +Z from a (radius, z) profile. */
function lathe(
  profile: [number, number][],
  segments: number,
  material: THREE.Material,
  phiStart = 0,
  phiLength = Math.PI * 2,
): THREE.Mesh {
  const pts = profile.map(([r, z]) => new THREE.Vector2(Math.max(r, 0.001), z));
  const geo = new THREE.LatheGeometry(pts, segments, phiStart, phiLength);
  geo.rotateX(Math.PI / 2); // lathe axis −> +Z (as biplane.ts)
  return new THREE.Mesh(geo, material);
}

/** A bomb on its rack (model space, nose +Z), fins and a yellow band. */
function bombParts(
  m: { x: number; y: number; z: number; heavy: boolean },
  id: number,
  near: boolean,
): THREE.Mesh[] {
  const s = m.heavy ? 1 : 0.55;
  const r = 0.22 * s;
  const len = 1.7 * s;
  const seg = near ? 14 : 8;
  const body = lathe(
    [
      [0.02, len * 0.5],
      [r * 0.7, len * 0.42],
      [r, len * 0.25],
      [r, -len * 0.15],
      [r * 0.55, -len * 0.42],
      [r * 0.3, -len * 0.5],
    ],
    seg,
    T.bomb,
  );
  body.position.set(m.x, m.y, m.z);
  const out = [body];
  if (near) {
    const band = new THREE.Mesh(
      new THREE.CylinderGeometry(r * 1.01, r * 1.01, len * 0.07, seg),
      T.band,
    );
    band.rotation.x = Math.PI / 2;
    band.position.set(m.x, m.y, m.z + len * 0.12);
    out.push(band);
    const fuze = new THREE.Mesh(
      new THREE.CylinderGeometry(0.012, 0.03 * s, 0.1 * s, 6),
      T.brass,
    );
    fuze.rotation.x = Math.PI / 2;
    fuze.position.set(m.x, m.y, m.z + len * 0.53);
    out.push(fuze);
  }
  // Four tail fins with a box ring (the heavy one's is the classic drum).
  for (let k = 0; k < 4; k++) {
    const fin = new THREE.Mesh(
      new THREE.BoxGeometry(0.012, r * 1.5, len * 0.22),
      T.bomb,
    );
    const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
    fin.rotation.z = a;
    fin.position.set(
      m.x + Math.sin(-a) * r * 0.55,
      m.y + Math.cos(a) * r * 0.55,
      m.z - len * 0.42,
    );
    out.push(fin);
  }
  if (near) {
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(r * 1.05, 0.012, 4, seg),
      T.bomb,
    );
    ring.position.set(m.x, m.y, m.z - len * 0.45);
    out.push(ring);
  }
  for (const o of out) o.userData.hinge = id;
  return out;
}

// --- The airframe -----------------------------------------------------------

interface Built {
  statics: THREE.Group;
  ailerons: [THREE.Mesh[], THREE.Mesh[]];
  elevator: THREE.Mesh[];
  rudder: THREE.Mesh[];
  blades: THREE.Group;
  bombs: THREE.Mesh[];
  pivots: {
    aileronL: Pivot;
    aileronR: Pivot;
    elevator: Pivot;
    rudder: Pivot;
  };
}

/** The tagged airframe in model space. `near` adds every small part and the
 * fine tessellation; the mid level keeps the silhouette and the big shapes
 * (its hinged parts, prop and racks are folded into the statics by the
 * caller; it carries no bombs — a dropped bomb must not linger at range). */
function buildAirframe(near: boolean): Built {
  const g = new THREE.Group();
  const seg = near ? 32 : 12;
  const small = near ? 10 : 6;

  // ---------- fuselage: a squashed lathe; the nose ahead of the firewall is
  // its own (cowl) skin so the panel shader can tell them apart.
  const cowlProfile = FUSELAGE.filter(([, z]) => z >= 2.2);
  const bodyProfile = FUSELAGE.filter(([, z]) => z <= 2.2);
  for (const [profile, material] of [
    [cowlProfile, T.cowl],
    [bodyProfile, T.fuselage],
  ] as const) {
    const m = lathe(profile as [number, number][], seg, material);
    m.scale.x = FUSELAGE_SQUASH;
    g.add(m);
  }

  // Spinner (teal, brass tip) with the hub cannon's muzzle.
  const spinner = new THREE.Mesh(
    new THREE.SphereGeometry(0.31, near ? 20 : 10, near ? 12 : 6),
    T.teal,
  );
  spinner.scale.z = 1.9;
  spinner.position.z = 4.12;
  g.add(spinner);
  const tip = new THREE.Mesh(new THREE.SphereGeometry(0.12, small, 6), T.brass);
  tip.scale.z = 1.6;
  tip.position.z = 4.62;
  g.add(tip);
  if (near) {
    const muzzle = new THREE.Mesh(
      new THREE.CylinderGeometry(0.035, 0.035, 0.08, 8),
      T.dark,
    );
    muzzle.rotation.x = Math.PI / 2;
    muzzle.position.z = 4.8;
    g.add(muzzle);
  }

  // Chin radiator: a rounded scoop under the nose, a dark slatted mouth.
  const scoop = new THREE.Mesh(
    new THREE.CylinderGeometry(0.34, 0.3, 1.5, near ? 18 : 8, 1),
    T.cowl,
  );
  scoop.rotation.x = Math.PI / 2;
  scoop.scale.set(1.05, 1, 0.62); // x wide, (pre-rotation z) → y squashed
  scoop.position.set(0, -0.62, 2.95);
  g.add(scoop);
  const mouth = new THREE.Mesh(
    new THREE.CircleGeometry(0.3, near ? 18 : 8),
    T.dark,
  );
  mouth.scale.set(1.05, 0.62, 1);
  mouth.position.set(0, -0.62, 3.705);
  g.add(mouth);
  if (near) {
    for (let k = -3; k <= 3; k++) {
      const slat = new THREE.Mesh(
        new THREE.BoxGeometry(0.018, 0.34, 0.05),
        T.steel,
      );
      slat.position.set(k * 0.075, -0.62, 3.72);
      g.add(slat);
    }
    // Radiator flap at the scoop's tail.
    const flap = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.02, 0.22), T.cowl);
    flap.position.set(0, -0.8, 2.12);
    flap.rotation.x = 0.25;
    g.add(flap);
  }

  // Exhaust stacks: six a side along the V12's banks, swept aft, each with
  // a flame tongue (the exhaust ring's glow — planelights.ts).
  for (const sx of [1, -1]) {
    if (near) {
      const plate = new THREE.Mesh(
        new THREE.BoxGeometry(0.04, 0.16, 1.55),
        T.gunmetal,
      );
      plate.position.set(sx * 0.535, 0.12, 2.78);
      plate.rotation.y = sx * 0.04;
      g.add(plate);
    }
    for (let k = 0; k < 6; k++) {
      const z = 3.4 - k * 0.24;
      const a = new THREE.Vector3(sx * 0.5, 0.12, z);
      const b = new THREE.Vector3(sx * 0.68, 0.1, z - 0.15);
      const stack = strut(a, b, 0.045, T.stack, false, near ? 8 : 5);
      stack.scale.x = 0.75;
      g.add(stack);
      if (near) {
        const flame = new THREE.Mesh(
          new THREE.ConeGeometry(0.035, 0.24, 6),
          T.flame,
        );
        const dir = new THREE.Vector3(sx * 0.4, -0.05, -1).normalize();
        // Apex aft: the cone's +Y onto the exhaust direction.
        flame.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
        flame.position.copy(b).addScaledVector(dir, 0.13);
        g.add(flame);
      }
    }
  }

  // Supercharger intake on the left cowl, gun troughs and synchronised MGs.
  const intake = new THREE.Mesh(
    new THREE.CylinderGeometry(0.1, 0.12, 0.7, small),
    T.cowl,
  );
  intake.rotation.x = Math.PI / 2;
  intake.position.set(0.56, -0.12, 2.65);
  g.add(intake);
  if (near) {
    const lip = new THREE.Mesh(new THREE.CircleGeometry(0.085, 10), T.dark);
    lip.position.set(0.56, -0.12, 3.006);
    g.add(lip);
    for (const sx of [1, -1]) {
      const mg = strut(
        new THREE.Vector3(sx * 0.15, 0.6, 2.1),
        new THREE.Vector3(sx * 0.15, 0.58, 3.5),
        0.022,
        T.gunmetal,
        false,
        8,
      );
      g.add(mg);
    }
  }

  // ---------- the gull wing (inner anhedral, outer dihedral, tapered).
  const st = near ? 4 : 1;
  for (const sx of [1, -1] as const) {
    const span = (a: number, b: number): [number, number] =>
      sx > 0 ? [a, b] : [-b, -a];
    const [i0, i1] = span(0, KNEE_X);
    g.add(wingPiece(i0, i1, true, 0, 1, st));
    const [o0, o1] = span(KNEE_X, AILERON_IN);
    g.add(wingPiece(o0, o1, false, 0, 1, st));
    const [a0, a1] = span(AILERON_IN, AILERON_OUT);
    g.add(wingPiece(a0, a1, false, 0, AILERON_HINGE_C, st));
    const [t0, t1] = span(AILERON_OUT, FIGHTER_TIP_X);
    g.add(wingPiece(t0, t1, false, 0, 1, 0));
    // Wing-root fillet: a fairing blending the inner wing into the belly.
    const fillet = new THREE.Mesh(
      new THREE.SphereGeometry(0.5, small, near ? 8 : 4),
      T.fuselage,
    );
    fillet.scale.set(0.9, 0.42, 3.0);
    fillet.position.set(sx * 0.42, -0.42, 0.1);
    g.add(fillet);

    // Cannon gondola under the knee and its barrel with a muzzle brake.
    const ck = 2.35;
    const le = wingPoint(sx * ck, 0);
    const pod = new THREE.Mesh(
      new THREE.CylinderGeometry(0.1, 0.085, 1.1, small),
      T.surface,
    );
    pod.rotation.x = Math.PI / 2;
    pod.position.set(sx * ck, le.y - 0.13, le.z - 0.3);
    g.add(pod);
    const barrel = strut(
      new THREE.Vector3(sx * ck, le.y - 0.13, le.z + 0.2),
      new THREE.Vector3(sx * ck, le.y - 0.13, le.z + 0.95),
      0.038,
      T.gunmetal,
      false,
      small,
    );
    g.add(barrel);
    if (near) {
      const brake = new THREE.Mesh(
        new THREE.CylinderGeometry(0.06, 0.06, 0.16, 10),
        T.gunmetal,
      );
      brake.rotation.x = Math.PI / 2;
      brake.position.set(sx * ck, le.y - 0.13, le.z + 0.98);
      g.add(brake);
    }

    // Spatted "trouser" gear at the knee: leg fairing, spat, wheel, siren.
    const kz = 0.48;
    const ky = wingY(KNEE_X) - 0.08;
    const leg = new THREE.Mesh(
      new THREE.CylinderGeometry(0.13, 0.18, 0.46, small),
      T.surface,
    );
    leg.scale.z = 2.1;
    leg.position.set(sx * KNEE_X, ky - 0.22, kz);
    g.add(leg);
    const spat = new THREE.Mesh(
      new THREE.SphereGeometry(0.5, near ? 18 : 8, near ? 12 : 6),
      T.surface,
    );
    spat.scale.set(0.36, 0.78, 1.25);
    spat.position.set(sx * KNEE_X, ky - 0.62, kz + 0.02);
    g.add(spat);
    const wheel = new THREE.Mesh(
      new THREE.TorusGeometry(0.24, 0.1, near ? 10 : 6, near ? 20 : 10),
      T.rubber,
    );
    wheel.rotation.y = Math.PI / 2;
    wheel.position.set(sx * KNEE_X, ky - 0.88, kz);
    g.add(wheel);
    if (near) {
      // The dive siren: a drum on the leg's front and its little prop.
      const drum = new THREE.Mesh(
        new THREE.CylinderGeometry(0.07, 0.07, 0.18, 10),
        T.steel,
      );
      drum.rotation.x = Math.PI / 2;
      drum.position.set(sx * KNEE_X, ky - 0.28, kz + 0.42);
      g.add(drum);
      for (const r of [0, Math.PI / 2]) {
        const vane = new THREE.Mesh(
          new THREE.BoxGeometry(0.2, 0.025, 0.01),
          T.brass,
        );
        vane.rotation.z = r;
        vane.position.set(sx * KNEE_X, ky - 0.28, kz + 0.52);
        g.add(vane);
      }
      // Dive brakes: a slatted bar under the outer wing on three hangers.
      for (const x of [2.55, 3.4, 4.25]) {
        const p = wingPoint(sx * x, 0.32);
        g.add(
          strut(
            new THREE.Vector3(p.x, p.y - 0.08, p.z),
            new THREE.Vector3(p.x, p.y - 0.24, p.z - 0.04),
            0.014,
            T.gunmetal,
            false,
            6,
          ),
        );
      }
      for (const dy of [0, 0.07]) {
        const a = wingPoint(sx * 2.45, 0.32);
        const b = wingPoint(sx * 4.35, 0.32);
        g.add(
          strut(
            new THREE.Vector3(a.x, a.y - 0.24 - dy, a.z - 0.04),
            new THREE.Vector3(b.x, b.y - 0.24 - dy, b.z - 0.04),
            0.018,
            T.steel,
            false,
            6,
          ),
        );
      }
      // Wingtip nav-light lens and pitot (left).
      const navLens = new THREE.Mesh(
        new THREE.SphereGeometry(0.07, 8, 6),
        T.lens,
      );
      navLens.position.copy(wingPoint(sx * (FIGHTER_TIP_X - 0.06), 0.45));
      g.add(navLens);
    }

    // Bomb racks under the outer wing (always there; the bombs come and go).
    for (const x of [2.75, 3.5]) {
      const top = wingPoint(sx * x, 0.45);
      const rack = new THREE.Mesh(
        new THREE.BoxGeometry(0.06, 0.12, 0.55),
        T.gunmetal,
      );
      rack.position.set(sx * x, top.y - 0.12, zcAt(x));
      g.add(rack);
    }
  }
  // Pitot tube on the left outer wing.
  if (near) {
    const p = wingPoint(4.2, 0);
    g.add(
      strut(
        new THREE.Vector3(4.2, p.y - 0.02, p.z - 0.1),
        new THREE.Vector3(4.2, p.y - 0.02, p.z + 0.45),
        0.01,
        T.steel,
        false,
        6,
      ),
    );
  }

  // Centreline bomb trapeze: the swing fork that throws the heavy bomb
  // clear of the prop in a dive.
  const heavy = BOMB_MOUNTS[0] as (typeof BOMB_MOUNTS)[number];
  for (const sx of [1, -1]) {
    g.add(
      strut(
        new THREE.Vector3(sx * 0.32, -0.6, heavy.z + 0.5),
        new THREE.Vector3(sx * 0.12, heavy.y + 0.2, heavy.z + 0.15),
        0.022,
        T.gunmetal,
        false,
        small,
      ),
    );
  }
  const crutch = new THREE.Mesh(
    new THREE.BoxGeometry(0.16, 0.06, 0.7),
    T.gunmetal,
  );
  crutch.position.set(0, heavy.y + 0.24, heavy.z);
  g.add(crutch);

  // ---------- cockpit: tub, greenhouse frames, armour, pilot, gunner.
  const tub = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.04, 2.5), T.dark);
  tub.position.set(0, 0.71, -0.25);
  g.add(tub);
  const CANOPY: [number, number][] = [
    [0.03, 1.15],
    [0.26, 1.02],
    [0.4, 0.65],
    [0.43, -0.2],
    [0.41, -1.0],
    [0.3, -1.5],
    [0.04, -1.72],
  ];
  const canopyY = 0.42;
  const canopyStretch = 1.45;
  const glass = lathe(CANOPY, near ? 24 : 10, T.glass, Math.PI / 2, Math.PI);
  glass.scale.y = canopyStretch;
  glass.position.y = canopyY;
  g.add(glass);
  // Frames: hoops at stations, a spine rail and the sills.
  const hoopRadius = (z: number) => {
    for (let i = 0; i < CANOPY.length - 1; i++) {
      const [ra, za] = CANOPY[i] as [number, number];
      const [rb, zb] = CANOPY[i + 1] as [number, number];
      if (z <= za && z >= zb) return ra + ((rb - ra) * (za - z)) / (za - zb);
    }
    return 0;
  };
  const hoops = near ? [0.95, 0.55, 0.05, -0.45, -0.95, -1.4] : [0.55, -0.95];
  for (const z of hoops) {
    const r = hoopRadius(z) + 0.012;
    const hoop = new THREE.Mesh(
      new THREE.TorusGeometry(r, 0.022, 4, near ? 16 : 8, Math.PI),
      T.frame,
    );
    hoop.scale.y = canopyStretch;
    hoop.position.set(0, canopyY, z);
    g.add(hoop);
  }
  const spine = new THREE.Mesh(
    new THREE.BoxGeometry(0.04, 0.03, 2.75),
    T.frame,
  );
  spine.position.set(0, canopyY + 0.43 * canopyStretch + 0.005, -0.25);
  g.add(spine);
  if (near) {
    for (const sx of [1, -1]) {
      const sill = new THREE.Mesh(
        new THREE.BoxGeometry(0.04, 0.04, 2.7),
        T.frame,
      );
      sill.position.set(sx * 0.43, canopyY + 0.18, -0.25);
      g.add(sill);
    }
    // Armour plate behind the pilot's head.
    const armour = new THREE.Mesh(
      new THREE.BoxGeometry(0.42, 0.3, 0.04),
      T.gunmetal,
    );
    armour.position.set(0, 0.86, 0.12);
    g.add(armour);
    // Instrument panel and its gauges, facing the pilot (−Z).
    const panel = new THREE.Mesh(
      new THREE.BoxGeometry(0.5, 0.18, 0.03),
      T.dark,
    );
    panel.position.set(0, 0.8, 0.78);
    g.add(panel);
    for (const [x, y] of [
      [-0.15, 0.83],
      [0, 0.84],
      [0.15, 0.83],
      [-0.075, 0.77],
      [0.075, 0.77],
    ] as const) {
      const bezel = new THREE.Mesh(
        new THREE.TorusGeometry(0.032, 0.007, 4, 12),
        T.brass,
      );
      bezel.position.set(x, y, 0.762);
      g.add(bezel);
      const face = new THREE.Mesh(new THREE.CircleGeometry(0.03, 12), T.cream);
      face.rotation.y = Math.PI;
      face.position.set(x, y, 0.761);
      g.add(face);
    }
  }
  // Pilot (facing forward) and rear gunner (facing aft): gas masks, red
  // goggles, leather helmets. The mid level keeps the heads.
  for (const [z, aft] of [
    [0.45, false],
    [-0.95, true],
  ] as const) {
    const fwd = aft ? -1 : 1;
    const head = new THREE.Mesh(
      new THREE.SphereGeometry(0.11, near ? 14 : 8, near ? 10 : 6),
      T.leather,
    );
    head.position.set(0, 0.9, z);
    g.add(head);
    if (!near) continue;
    const torso = new THREE.Mesh(
      new THREE.CylinderGeometry(0.15, 0.19, 0.34, 12),
      T.jacket,
    );
    torso.scale.z = 0.8;
    torso.position.set(0, 0.67, z - fwd * 0.03);
    g.add(torso);
    const shoulders = new THREE.Mesh(
      new THREE.SphereGeometry(0.16, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2),
      T.jacket,
    );
    shoulders.scale.set(1.15, 0.45, 0.8);
    shoulders.position.set(0, 0.81, z - fwd * 0.03);
    g.add(shoulders);
    // Respirator snout and its filter drum.
    const snout = new THREE.Mesh(
      new THREE.CylinderGeometry(0.035, 0.05, 0.1, 10),
      T.mask,
    );
    snout.rotation.x = (fwd * Math.PI) / 2 + fwd * 0.5;
    snout.position.set(0, 0.85, z + fwd * 0.12);
    g.add(snout);
    const filter = new THREE.Mesh(
      new THREE.CylinderGeometry(0.045, 0.045, 0.05, 10),
      T.steel,
    );
    filter.rotation.x = (fwd * Math.PI) / 2 + fwd * 0.5;
    filter.position.set(0, 0.815, z + fwd * 0.17);
    g.add(filter);
    // The hose down to the chest.
    const hose = new THREE.Mesh(
      new THREE.TorusGeometry(0.08, 0.014, 5, 10, Math.PI * 0.9),
      T.mask,
    );
    hose.rotation.y = Math.PI / 2;
    hose.position.set(0.03, 0.75, z + fwd * 0.12);
    g.add(hose);
    for (const sx of [1, -1]) {
      const lensPos = new THREE.Vector3(sx * 0.042, 0.93, z + fwd * 0.095);
      const rim = new THREE.Mesh(
        new THREE.TorusGeometry(0.03, 0.009, 6, 12),
        T.gunmetal,
      );
      rim.position.copy(lensPos);
      g.add(rim);
      const lens = new THREE.Mesh(new THREE.CircleGeometry(0.027, 12), T.lens);
      lens.position.copy(lensPos).add(new THREE.Vector3(0, 0, fwd * 0.004));
      if (aft) lens.rotation.y = Math.PI;
      g.add(lens);
    }
    const cap = new THREE.Mesh(
      new THREE.SphereGeometry(0.12, 12, 6, 0, Math.PI * 2, 0, Math.PI * 0.45),
      T.leather,
    );
    cap.position.set(0, 0.9, z);
    g.add(cap);
  }
  // The gunner's twin MG on its ring, pointing aft and up.
  {
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.26, 0.02, 4, near ? 18 : 8),
      T.gunmetal,
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.set(0, 0.86, -1.2);
    g.add(ring);
    for (const sx of [1, -1]) {
      g.add(
        strut(
          new THREE.Vector3(sx * 0.05, 0.95, -1.3),
          new THREE.Vector3(sx * 0.05, 1.12, -2.15),
          0.02,
          T.gunmetal,
          false,
          near ? 8 : 4,
        ),
      );
    }
    if (near) {
      const drum = new THREE.Mesh(
        new THREE.CylinderGeometry(0.08, 0.08, 0.06, 12),
        T.gunmetal,
      );
      drum.rotation.z = Math.PI / 2;
      drum.position.set(0, 1.04, -1.42);
      g.add(drum);
    }
  }
  // Radio mast and its aerial wire to the fin.
  g.add(
    strut(
      new THREE.Vector3(0, 0.62, -2.15),
      new THREE.Vector3(0, 1.2, -2.35),
      0.025,
      T.frame,
      true,
      small,
    ),
  );
  if (near) {
    g.add(
      strut(
        new THREE.Vector3(0, 1.2, -2.35),
        new THREE.Vector3(0, 1.62, -4.1),
        0.006,
        T.steel,
        false,
        4,
      ),
    );
  }

  // ---------- tail: swept fin, tailplane with struts, tail wheel.
  const finShape = new THREE.Shape();
  finShape.moveTo(0, -0.05);
  finShape.lineTo(1.3, 0.05);
  finShape.quadraticCurveTo(0.7, 0.6, 0.28, 1.5);
  finShape.quadraticCurveTo(0.12, 1.66, 0, 1.62);
  finShape.lineTo(0, -0.05);
  const fin = new THREE.Mesh(
    new THREE.ExtrudeGeometry(finShape, {
      depth: 0.07,
      bevelEnabled: false,
      curveSegments: near ? 10 : 4,
    }),
    T.surface,
  );
  fin.rotation.y = -Math.PI / 2; // shape x -> +Z
  fin.position.set(0.035, RUDDER_HINGE.y, RUDDER_HINGE.z);
  g.add(fin);
  const stabPiece = (x0: number, x1: number, c1: number) =>
    new THREE.Mesh(
      loft({
        section: TAIL_SECTION,
        x0,
        x1,
        c0: 0,
        c1,
        chord: STAB.chord,
        zc: STAB.z,
        y0: STAB.y,
        dihedral: 0,
        tipStart: STAB.tip,
        tipEnd: STAB.half,
        fabric: false,
        stations: near ? 4 : 0,
      }),
      T.surface,
    );
  g.add(stabPiece(-STAB.half, -STAB.tip, 1));
  g.add(stabPiece(-STAB.tip, STAB.tip, ELEVATOR_HINGE_C));
  g.add(stabPiece(STAB.tip, STAB.half, 1));
  for (const sx of [1, -1]) {
    g.add(
      strut(
        new THREE.Vector3(sx * 0.12, -0.12, -3.65),
        new THREE.Vector3(sx * 0.95, STAB.y - 0.05, -3.7),
        0.025,
        T.frame,
        true,
        small,
      ),
    );
  }
  const tw = new THREE.Mesh(
    new THREE.TorusGeometry(0.09, 0.045, 6, near ? 14 : 8),
    T.rubber,
  );
  tw.rotation.y = Math.PI / 2;
  tw.position.set(0, -0.5, -4.05);
  g.add(tw);
  g.add(
    strut(
      new THREE.Vector3(0, -0.15, -3.9),
      new THREE.Vector3(0, -0.47, -4.05),
      0.035,
      T.gunmetal,
      true,
      small,
    ),
  );

  // ---------- hinged surfaces (model space; the caller bakes or folds them)
  const aileron = (sx: 1 | -1): THREE.Mesh => {
    const [x0, x1] =
      sx > 0
        ? [AILERON_IN + 0.02, AILERON_OUT - 0.02]
        : [-(AILERON_OUT - 0.02), -(AILERON_IN + 0.02)];
    const m = wingPiece(x0, x1, false, AILERON_FRONT_C, 1, near ? 3 : 0);
    return m;
  };
  const hingeAxis = (sx: 1 | -1): Pivot => {
    // Along the tapered hinge line, pointing +X on both sides (fleet.ts's
    // sign convention: the right aileron turns by −deflection).
    const a = wingPoint(sx * AILERON_IN, AILERON_HINGE_C);
    const b = wingPoint(sx * AILERON_OUT, AILERON_HINGE_C);
    const dir = (sx > 0 ? b.clone().sub(a) : a.clone().sub(b)).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(1, 0, 0),
      dir,
    );
    return { position: a, rotation: new THREE.Euler().setFromQuaternion(q) };
  };
  const elevatorParts = [
    [-STAB.tip + 0.02, -ELEVATOR_GAP],
    [ELEVATOR_GAP, STAB.tip - 0.02],
  ].map(
    ([x0, x1]) =>
      new THREE.Mesh(
        loft({
          section: TAIL_SECTION,
          x0: x0 as number,
          x1: x1 as number,
          c0: ELEVATOR_FRONT_C,
          c1: 1,
          chord: STAB.chord,
          zc: STAB.z,
          y0: STAB.y,
          dihedral: 0,
          fabric: false,
          stations: near ? 2 : 0,
        }),
        T.surface,
      ),
  );
  const elevatorPivot: Pivot = {
    position: new THREE.Vector3(
      0,
      STAB.y - STAB.chord * TAIL_SECTION.m * 0.8,
      STAB.z + STAB.chord / 2 - ELEVATOR_HINGE_C * STAB.chord,
    ),
    rotation: new THREE.Euler(),
  };
  // Rudder: hinged on the post, a horn balance at the top.
  const rudShape = new THREE.Shape();
  rudShape.moveTo(0, -0.2);
  rudShape.lineTo(0, 1.6);
  rudShape.quadraticCurveTo(-0.3, 1.66, -0.5, 1.2);
  rudShape.lineTo(-0.6, 0.3);
  rudShape.quadraticCurveTo(-0.55, -0.15, -0.3, -0.28);
  rudShape.lineTo(0, -0.2);
  const rudMesh = new THREE.Mesh(
    new THREE.ExtrudeGeometry(rudShape, {
      depth: 0.06,
      bevelEnabled: false,
      curveSegments: near ? 8 : 3,
    }),
    T.surface,
  );
  rudMesh.rotation.y = -Math.PI / 2;
  rudMesh.position.set(0.03, RUDDER_HINGE.y, RUDDER_HINGE.z);
  const rudderPivot: Pivot = {
    position: RUDDER_HINGE.clone(),
    rotation: new THREE.Euler(),
  };

  // ---------- prop: three paddle blades, brass tips (prop space, hub at 0).
  const blades = new THREE.Group();
  for (let k = 0; k < 3; k++) {
    const geo = new THREE.CylinderGeometry(
      0.06,
      0.12,
      1.4,
      near ? 10 : 6,
      near ? 6 : 1,
    );
    const p = geo.attributes.position as THREE.BufferAttribute;
    const col = new Float32Array(p.count * 3);
    const tipC = new THREE.Color(BRASS);
    const base = new THREE.Color(0x1c1d1f);
    for (let i = 0; i < p.count; i++) {
      const c = p.getY(i) > 0.55 ? tipC : base;
      col[i * 3] = c.r;
      col[i * 3 + 1] = c.g;
      col[i * 3 + 2] = c.b;
    }
    geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
    const blade = new THREE.Mesh(geo, tag({ rough: 0.45, metal: 0.6 }));
    blade.scale.z = 0.3;
    blade.position.y = 0.78;
    blade.rotation.y = 0.5;
    const holder = new THREE.Group();
    holder.add(blade);
    holder.rotation.z = (k / 3) * Math.PI * 2;
    blades.add(holder);
  }

  const bombs: THREE.Mesh[] = [];
  if (near) {
    BOMB_MOUNTS.forEach((m, i) => {
      bombs.push(...bombParts(m, BOMB_ID_BASE + i, true));
    });
  }

  return {
    statics: g,
    ailerons: [[aileron(1)], [aileron(-1)]],
    elevator: elevatorParts,
    rudder: [rudMesh],
    blades,
    bombs,
    pivots: {
      aileronL: hingeAxis(1),
      aileronR: hingeAxis(-1),
      elevator: elevatorPivot,
      rudder: rudderPivot,
    },
  };
}

/** The far impostor: a low-poly silhouette (gull wing, long nose, spats). */
function buildFar(): THREE.Group {
  const g = new THREE.Group();
  const fus = lathe(
    [
      [0.45, 4.1],
      [0.66, 2.6],
      [0.66, 0.4],
      [0.38, -3.0],
      [0.001, -4.6],
    ],
    6,
    T.fuselage,
  );
  fus.scale.x = FUSELAGE_SQUASH;
  g.add(fus);
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.32, 0.6, 6), T.teal);
  nose.rotation.x = Math.PI / 2;
  nose.position.z = 4.35;
  g.add(nose);
  for (const sx of [1, -1]) {
    // Inner and outer panels as tilted slabs on the gull line.
    for (const [x0, x1] of [
      [0.3, KNEE_X],
      [KNEE_X, FIGHTER_TIP_X],
    ] as const) {
      const xm = (x0 + x1) / 2;
      const w = new THREE.Mesh(
        new THREE.BoxGeometry(x1 - x0, 0.14, chordAt(xm)),
        T.surface,
      );
      w.position.set(sx * xm, wingY(xm), zcAt(xm));
      w.rotation.z = sx * Math.atan(xm <= KNEE_X ? INNER_TAN : OUTER_TAN);
      g.add(w);
    }
    const spat = new THREE.Mesh(
      new THREE.BoxGeometry(0.3, 0.9, 0.9),
      T.surface,
    );
    spat.position.set(sx * KNEE_X, wingY(KNEE_X) - 0.75, 0.48);
    g.add(spat);
  }
  const stab = new THREE.Mesh(
    new THREE.BoxGeometry(STAB.half * 2, 0.1, STAB.chord),
    T.surface,
  );
  stab.position.set(0, STAB.y, STAB.z);
  g.add(stab);
  const fin = new THREE.Mesh(new THREE.BoxGeometry(0.07, 1.6, 1.1), T.surface);
  fin.position.set(0, 0.95, -4.2);
  g.add(fin);
  const canopy = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.45, 2.6), T.frame);
  canopy.position.set(0, 0.75, -0.25);
  g.add(canopy);
  return g;
}

// --- Shared geometry --------------------------------------------------------

export interface FighterGeometry {
  /** Near statics (opaque, hinge 0). */
  statics: THREE.BufferGeometry;
  glass: THREE.BufferGeometry;
  aileronL: THREE.BufferGeometry;
  aileronR: THREE.BufferGeometry;
  elevator: THREE.BufferGeometry;
  rudder: THREE.BufferGeometry;
  /** Prop blades, prop space (hub at the origin, spin about Z). */
  blades: THREE.BufferGeometry;
  /** The five bombs (model space), their per-vertex ids BOMB_ID_BASE + i. */
  bombs: THREE.BufferGeometry;
  /** Simplified mid level (everything static, at rest; no bombs). */
  mid: THREE.BufferGeometry;
  midGlass: THREE.BufferGeometry;
  far: THREE.BufferGeometry;
  pivots: {
    aileronL: Pivot;
    aileronR: Pivot;
    elevator: Pivot;
    rudder: Pivot;
  };
}

let shared: FighterGeometry | null = null;

/** The fighter's shared geometry, built on first use (DOM-free). */
export function fighterGeometry(): FighterGeometry {
  if (!shared) shared = buildShared();
  return shared;
}

function required(g: THREE.BufferGeometry | null, what: string) {
  if (!g) throw new Error(`fighter: no ${what} geometry`);
  return g;
}

function buildShared(): FighterGeometry {
  const near = buildAirframe(true);
  const { opaque: statics, glass } = bake(near.statics);
  const p = near.pivots;
  const aileronL = bakeHinged(near.ailerons[0], p.aileronL);
  const aileronR = bakeHinged(near.ailerons[1], p.aileronR);
  const elevator = bakeHinged(near.elevator, p.elevator);
  const rudder = bakeHinged(near.rudder, p.rudder);
  const propRest = new THREE.Matrix4().makeTranslation(0, 0, FIGHTER_PROP_Z);
  const blades = required(bake(near.blades, propRest).opaque, "blade");
  const bombRoot = new THREE.Group();
  for (const b of near.bombs) bombRoot.add(b);
  const bombs = required(bake(bombRoot).opaque, "bomb");

  // Mid: the hinged parts, the prop (at the hub) and nothing else folded in.
  const mid = buildAirframe(false);
  for (const list of [...mid.ailerons, mid.elevator, mid.rudder]) {
    for (const m of list) mid.statics.add(m);
  }
  mid.blades.position.z = FIGHTER_PROP_Z;
  mid.statics.add(mid.blades);
  const midBaked = bake(mid.statics);

  return {
    statics: required(statics, "static"),
    glass: required(glass, "glass"),
    aileronL,
    aileronR,
    elevator,
    rudder,
    blades,
    bombs,
    mid: required(midBaked.opaque, "mid"),
    midGlass: required(midBaked.glass, "mid glass"),
    far: required(bake(buildFar()).opaque, "far"),
    pivots: p,
  };
}

/** Triangles per level (QA / the PR's budget table). */
export function fighterTriangles(): { near: number; mid: number; far: number } {
  const s = fighterGeometry();
  const tris = (...gs: THREE.BufferGeometry[]) =>
    gs.reduce(
      (n, g) =>
        n + (g.getAttribute("position") as THREE.BufferAttribute).count / 3,
      0,
    );
  return {
    near: tris(
      s.statics,
      s.glass,
      s.aileronL,
      s.aileronR,
      s.elevator,
      s.rudder,
      s.blades,
      s.bombs,
    ),
    mid: tris(s.mid, s.midGlass),
    far: tris(s.far),
  };
}

// --- The decal atlas ----------------------------------------------------------

/** Atlas rects in uv space (x0, y0, w, h; v up — the canvas is flipped). */
export const DECAL_ROUNDEL = [0, 0, 0.5, 1] as const;
export const DECAL_TAIL_CODE = [0.5, 0.5, 0.5, 0.5] as const;
export const DECAL_SHARK = [0.5, 0, 0.5, 0.5] as const;

let atlas: THREE.Texture | null | undefined;

/**
 * The fighter's decals, drawn once into a 1024 × 512 canvas: the left half
 * the Eisenwolke roundel (a brass winged cog on teal, ringed in cream — the
 * carrier's crest, boss.ts; FICTIONAL, never a historical insignia), top
 * right the carrier's tail code, bottom right a shark mouth (nose at the
 * left). Null without a DOM.
 */
export function fighterDecals(): THREE.Texture | null {
  if (atlas !== undefined) return atlas;
  atlas = null;
  if (typeof document === "undefined") return null;
  const cv = document.createElement("canvas");
  cv.width = 1024;
  cv.height = 512;
  const g = cv.getContext("2d");
  if (!g) return null;
  g.clearRect(0, 0, 1024, 512);
  // Roundel.
  const cx = 256;
  const cy = 256;
  g.fillStyle = "#e9dfc4";
  g.beginPath();
  g.arc(cx, cy, 240, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = "#1f5d5a";
  g.beginPath();
  g.arc(cx, cy, 206, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = "#c79a45";
  for (const s of [1, -1]) {
    for (let f = 0; f < 3; f++) {
      g.beginPath();
      const y0 = cy - 40 + f * 34;
      g.moveTo(cx + s * 60, y0);
      g.lineTo(cx + s * (196 - f * 26), y0 - 70 + f * 22);
      g.lineTo(cx + s * (186 - f * 26), y0 - 38 + f * 22);
      g.lineTo(cx + s * 60, y0 + 26);
      g.closePath();
      g.fill();
    }
  }
  g.beginPath();
  for (let t = 0; t < 24; t++) {
    const a = (t / 24) * Math.PI * 2;
    const a2 = ((t + 1) / 24) * Math.PI * 2;
    const r = t % 2 === 0 ? 96 : 76;
    g.lineTo(cx + r * Math.cos(a), cy + r * Math.sin(a));
    g.lineTo(cx + r * Math.cos(a2), cy + r * Math.sin(a2));
  }
  g.closePath();
  g.fill();
  g.fillStyle = "#1f5d5a";
  g.beginPath();
  g.arc(cx, cy, 46, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = "#e9dfc4";
  for (let b = 0; b < 3; b++) {
    g.save();
    g.translate(cx, cy);
    g.rotate((b / 3) * Math.PI * 2 + 0.3);
    g.beginPath();
    g.ellipse(0, -22, 8, 22, 0, 0, Math.PI * 2);
    g.fill();
    g.restore();
  }
  // Tail code: the carrier's, stencilled in cream on a teal flash.
  g.fillStyle = "#1f5d5a";
  g.fillRect(540, 40, 450, 176);
  g.fillStyle = "#e9dfc4";
  g.font = "bold 118px 'Courier New', monospace";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText("DZ·129", 765, 112);
  g.font = "bold 40px 'Courier New', monospace";
  g.fillText("EISENWOLKE", 765, 186);
  // Shark mouth: nose at the left, the jaw sweeping back to the right.
  const mx = 512;
  const my = 256;
  g.fillStyle = "#7a0f12";
  g.beginPath();
  g.moveTo(mx + 30, my + 70);
  g.quadraticCurveTo(mx + 220, my + 20, mx + 470, my + 110);
  g.quadraticCurveTo(mx + 250, my + 250, mx + 40, my + 150);
  g.closePath();
  g.fill();
  g.fillStyle = "#f2efe6";
  const teeth = (y0: (u: number) => number, dir: number) => {
    for (let k = 0; k < 11; k++) {
      const u = k / 11;
      const u2 = (k + 1) / 11;
      const x0 = mx + 40 + u * 420;
      const x1 = mx + 40 + u2 * 420;
      g.beginPath();
      g.moveTo(x0, y0(u));
      g.lineTo(x1, y0(u2));
      g.lineTo((x0 + x1) / 2, y0((u + u2) / 2) + dir * (30 - 14 * u));
      g.closePath();
      g.fill();
    }
  };
  teeth((u) => my + 68 - 30 * Math.sin(u * Math.PI * 0.8) + 40 * u, 1);
  teeth((u) => my + 150 + 40 * Math.sin(u * Math.PI * 0.9) - 40 * u, -1);
  g.fillStyle = "#e9dfc4";
  g.beginPath();
  g.arc(mx + 120, my + 40, 22, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = "#111";
  g.beginPath();
  g.arc(mx + 124, my + 40, 11, 0, Math.PI * 2);
  g.fill();
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.userData.shared = true;
  atlas = tex;
  return tex;
}

// --- The detail shader (fleet.ts's enemy draw) -------------------------------

const f = (n: number): string => n.toFixed(4);
const rect = (r: readonly number[]): string =>
  `vec4(${r.map((n) => f(n)).join(", ")})`;

/** Vertex: the rest normal and skin class for the detail pass. Injected
 * after the fleet's hinge normal step (so a hinged part's normal is in model
 * space), which leaves `objectNormal` defined. */
export const DETAIL_VERTEX_DECL = `
varying vec3 vAbRestN;
flat varying float vAbSkin;`;
export const DETAIL_VERTEX_BODY = `
vAbRestN = objectNormal;
vAbSkin = aPart.y;`;

/** Fragment declarations (needs the damage patch's vAbRest and abNoise). */
export const DETAIL_FRAGMENT_DECL = `
uniform sampler2D uAbDecal;
varying vec3 vAbRestN;
flat varying float vAbSkin;
// A panel line every \`period\` along x, antialiased against its own
// derivative: never thinner than ~1.5 px (its ink kept constant), and faded
// out before its period nears a pixel (no moire, no shimmer).
float abLine(float x, float period, float halfW) {
  float w = max(fwidth(x), 1e-5);
  float d = abs(fract(x / period + 0.5) - 0.5) * period;
  float hw = max(halfW, w * 0.75);
  float l = (1.0 - smoothstep(hw - w * 0.5, hw + w * 0.5, d)) * (halfW / hw);
  return l * (1.0 - smoothstep(period * 0.1, period * 0.25, w));
}
// Rivet dots on a grid (cells of continuous rest coords), same AA policy.
float abDots(vec2 p, vec2 period, float r) {
  vec2 w = max(fwidth(p), vec2(1e-5));
  vec2 d = abs(fract(p / period + 0.5) - 0.5) * period;
  float rr = max(r, max(w.x, w.y) * 0.75);
  float l = (1.0 - smoothstep(rr - w.x * 0.5, rr + w.x * 0.5, length(d))) * (r * r) / (rr * rr);
  return l * (1.0 - smoothstep(min(period.x, period.y) * 0.1, min(period.x, period.y) * 0.25, max(w.x, w.y)));
}
vec4 abDecalAt(vec2 uv, vec4 r) {
  float inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
  vec4 c = texture2D(uAbDecal, r.xy + clamp(uv, 0.0, 1.0) * r.zw);
  c.a *= inside;
  return c;
}`;

/**
 * Fragment, after <color_fragment> and BEFORE the damage terms (scorch and
 * holes paint over the paintwork): splinter camouflage on the upper skins,
 * the faction nose ring and rudder, the decals, panel lines and rivets, then
 * the weathering — exhaust soot aft of the stacks, oil under the belly and
 * chipped paint. Every line and dot is antialiased (abLine / abDots); the
 * only hashed inputs are floored cells of the continuous rest position.
 */
export const DETAIL_FRAGMENT_BODY = `
{
  vec3 p = vAbRest;
  vec3 nr = normalize(vAbRestN);
  float skin = vAbSkin;
  float painted = step(0.5, skin);
  float fus = step(0.5, skin) * step(skin, 1.5);
  float surf = step(1.5, skin) * step(skin, 2.5);
  float cowl = step(2.5, skin);
  float side = step(0.08, abs(p.x));
  float sx = p.x >= 0.0 ? 1.0 : -1.0;
  // Splinter camouflage: two crossed bands of hard-edged splinters,
  // antialiased, on the upper skins only.
  float a1 = dot(p.xz, vec2(0.82, 0.57)) * 0.42 + 0.31 * sin(p.z * 0.9 + p.x * 0.4);
  float a2 = dot(p.xz, vec2(-0.45, 0.89)) * 0.36 + 0.4;
  float w1 = fwidth(a1) + 1e-4;
  float w2 = fwidth(a2) + 1e-4;
  float s1 = smoothstep(-w1, w1, abs(fract(a1) - 0.5) - 0.25);
  float s2 = smoothstep(-w2, w2, abs(fract(a2) - 0.5) - 0.22);
  float splinter = s1 + s2 - 2.0 * s1 * s2;
  float upper = smoothstep(-0.12, 0.3, nr.y);
  diffuseColor.rgb *= mix(vec3(1.0), vec3(0.6, 0.66, 0.6), splinter * upper * painted);
  // Faction teal: the nose ring and the rudder.
  vec3 abTeal = vec3(0.0144, 0.1095, 0.1022);
  float ring = cowl * step(3.72, p.z);
  float rudder = surf * step(p.z, -4.31) * step(0.0, p.y) * step(abs(p.x), 0.1);
  diffuseColor.rgb = mix(diffuseColor.rgb, abTeal, max(ring, rudder));
  // Decals.
  vec4 dec = vec4(0.0);
  vec2 uvR = vec2(-(p.z + 2.05) * sx, p.y - 0.02) / 0.8 + 0.5;
  vec4 c = abDecalAt(uvR, ${rect(DECAL_ROUNDEL)});
  dec = mix(dec, c, c.a * fus * side);
  vec2 uvW = vec2(abs(p.x) - 3.95, p.z - 0.12) / 0.86 + 0.5;
  c = abDecalAt(uvW, ${rect(DECAL_ROUNDEL)});
  dec = mix(dec, c, c.a * surf * step(2.2, abs(p.x)));
  // Text reads forward-to-aft... left to right from either side.
  float codeU = sx > 0.0 ? (-3.48 - p.z) / 0.8 : (p.z + 4.28) / 0.8;
  c = abDecalAt(vec2(codeU, (p.y - 0.4) / 0.4), ${rect(DECAL_TAIL_CODE)});
  dec = mix(dec, c, c.a * surf * step(abs(p.x), 0.12) * step(p.z, -3.3));
  c = abDecalAt(vec2((4.02 - p.z) / 1.3, (p.y + 0.8) / 0.65), ${rect(DECAL_SHARK)});
  dec = mix(dec, c, c.a * cowl * step(0.12, abs(p.x)));
  diffuseColor.rgb = mix(diffuseColor.rgb, dec.rgb, dec.a);
  // Panel lines and rivets.
  float lines = 0.0;
  float rivets = 0.0;
  float ang = atan(p.y, p.x / ${f(FUSELAGE_SQUASH)}) * 0.62;
  lines += fus * max(abLine(p.z, 0.82, 0.006), abLine(ang + 0.31, 0.62, 0.005));
  rivets += fus * abDots(vec2(p.z - 0.035, ang), vec2(0.82, 0.07), 0.009);
  lines += cowl * max(abLine(p.z - 0.18, 0.9, 0.007), abLine(p.y - 0.28, 4.0, 0.007));
  rivets += cowl * abDots(vec2(p.z - 0.23, ang), vec2(0.9, 0.16), 0.016);
  lines += surf * max(abLine(abs(p.x), 0.78, 0.006), max(abLine(p.z - 0.72, 8.0, 0.006), abLine(p.z + 0.3, 8.0, 0.006)));
  rivets += surf * abDots(vec2(abs(p.x) - 0.03, p.z), vec2(0.78, 0.075), 0.008);
  diffuseColor.rgb *= 1.0 - 0.55 * clamp(lines, 0.0, 1.0);
  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 1.35 + 0.02, clamp(rivets, 0.0, 1.0) * 0.6);
  // Exhaust soot streaking aft of the stacks along both flanks.
  float aft = 3.45 - p.z;
  float sootY = (p.y - 0.12 + max(aft, 0.0) * 0.045) / (0.07 + max(aft, 0.0) * 0.06);
  float soot = smoothstep(0.0, 0.35, aft) * exp(-max(aft - 1.4, 0.0) * 0.7)
    * exp(-sootY * sootY) * side * (fus + cowl);
  soot *= 0.65 + 0.35 * abNoise(vec3(p.z * 1.2, p.y * 16.0, p.x * 3.0));
  diffuseColor.rgb *= 1.0 - 0.7 * clamp(soot, 0.0, 1.0);
  // Oil weeping back from the radiator along the belly.
  float belly = smoothstep(-0.3, -0.55, p.y) * step(abs(p.x), 0.5) * step(p.z, 2.3) * (fus + cowl);
  float streak = smoothstep(0.55, 0.8, abNoise(vec3(p.x * 22.0, p.z * 0.7, 3.1)));
  float oil = belly * streak * exp(-max(2.3 - p.z, 0.0) * 0.45);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.03, 0.022, 0.015), 0.75 * oil);
  // Chipped paint: bare metal where a fine noise peaks (faded with range).
  vec3 cp = p * 9.0;
  float cw = length(fwidth(cp));
  float chip = smoothstep(0.74, 0.8, abNoise(cp)) * (1.0 - smoothstep(0.3, 0.9, cw)) * painted;
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.42, 0.43, 0.44), chip * 0.55);
}`;
