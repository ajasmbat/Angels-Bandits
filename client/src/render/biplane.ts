// Procedural vintage aerobatic biplane (Stearman-style) built entirely from
// Three.js geometry — no external assets, per the project constraint that
// everything ships bundled. Reference: red fuselage/wings, maroon cowl ring,
// checkered rudder, N-struts with crossed flying wires, open cockpit with a
// goggled pilot, radial engine with exhaust stubs, spatted gear. The livery
// (primary/secondary colours) is a parameter so remote pilots can wear their
// own; the shapes never change.
//
// F3 redesign: lofted airfoil wings (camber, fabric sag between ribs, rib
// tapes, dihedral), hinged ailerons / elevator / rudder, a pilot, a prop blur
// disc. The airframe is built ONCE per page into shared geometry merged per
// material (every plane reuses it — only materials are per-plane, because
// remotes.ts tints `material.emissive` for the shimmer/reveal), so a plane is
// 15 draws up close and 2 as the far impostor instead of 66.
//
// Axes: +Z = nose, +Y = up. Model is ~9 units wingspan (≈ meters).

import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

/** The two livery colours: `primary` paints fuselage, wings, tail and gear;
 * `secondary` the cowl ring and trim. Cream struts, gold cheat line, metal
 * and the pilot stay common to every livery. */
export interface Livery {
  primary: number;
  secondary: number;
}

/** The classic red-and-maroon scheme — the own plane always wears it. */
export const CLASSIC_LIVERY: Livery = {
  primary: 0xe0182f,
  secondary: 0x8c1424,
};

const CREAM = 0xf2ead8;
const GOLD = 0xd9a441;
const CHROME = 0xe8eaec;
const SILVER = 0xd6d8da;
const WIRE = 0xb9bbbd;
const DARK = 0x1d1d20;
const TIRE = 0x141414;
const LEATHER = 0x4a3220;
const HELMET = 0x5c3a1e;
const JACKET = 0x33241a;
const SKIN = 0xc98f6b;
const PROP_TIP = 0xe8c020;
const SCARF = 0xf4f1ea;

/** Upper / lower wing dihedral, radians (≈1.2° / 2.5°). */
const UPPER_DIHEDRAL = 0.021;
const LOWER_DIHEDRAL = 0.044;
/** Upper wing: centre height, chord-centre z, chord, half-span. */
const UPPER = { y: 1.38, z: 0.62, chord: 1.5, half: 4.5, tip: 3.9 };
const LOWER = { y: -0.32, z: 0.18, chord: 1.35, half: 3.65, tip: 3.2 };
const STAB = { y: 0.16, z: -2.95, chord: 0.95, half: 1.65, tip: 1.3 };
/** Upper-wing aileron span (both sides) and chord split. */
const AILERON_IN = 1.95;
const AILERON_HINGE_C = 0.72;
const AILERON_FRONT_C = 0.745;
/** Elevator chord split and the centre gap the rudder swings through. */
const ELEVATOR_HINGE_C = 0.6;
const ELEVATOR_FRONT_C = 0.625;
const ELEVATOR_GAP = 0.12;
/** Rudder hinge post (model space). */
const RUDDER_HINGE = new THREE.Vector3(0, 0.25, -3.32);
/** Prop hub plane and blade radius. */
const PROP_Z = 3.5;
const PROP_RADIUS = 1.6;
/** Rib pitch along the span, and half-width of a rib tape, meters. */
const RIB_PITCH = 0.42;
const RIB_TAPE = 0.025;
/** Fabric sag between ribs, meters (shading comes from the bent normals). */
const FABRIC_SAG = 0.007;

// ---------------------------------------------------------------------------
// Materials (per plane)

/** The material groups static geometry is merged into. */
type GroupKey =
  | "body"
  | "trim"
  | "metal"
  | "dark"
  | "engine"
  | "cream"
  | "leather"
  | "glass";
const GROUP_KEYS: readonly GroupKey[] = [
  "body",
  "trim",
  "metal",
  "dark",
  "engine",
  "cream",
  "leather",
  "glass",
];

export type BiplaneMaterials = Record<GroupKey, THREE.MeshStandardMaterial> & {
  rudder: THREE.MeshStandardMaterial;
  scarf: THREE.MeshStandardMaterial;
  blur: THREE.MeshStandardMaterial;
};

function materials(livery: Livery, shared: SharedGeometry): BiplaneMaterials {
  const std = (p: THREE.MeshStandardMaterialParameters) =>
    new THREE.MeshStandardMaterial(p);
  // Livery fabric: vertex colours carry the rib tapes and panel seams, and
  // `userData.damage` opts it into the scorch/holes patch (plane.ts).
  const body = std({
    color: livery.primary,
    roughness: 0.32,
    metalness: 0.12,
    vertexColors: true,
  });
  body.userData.damage = true;
  const trim = std({
    color: livery.secondary,
    roughness: 0.35,
    metalness: 0.2,
    vertexColors: true,
  });
  trim.userData.damage = true;
  // The radial's cylinders + crank case + exhaust stubs: dark metal that the
  // hero-light patch (planelights.ts) heats into the glowing exhaust ring.
  const engine = std({ color: DARK, roughness: 0.6, metalness: 0.4 });
  engine.userData.exhaustGlow = true;
  const rudder = std({
    map: shared.checker,
    roughness: 0.5,
    metalness: 0.05,
  });
  rudder.userData.damage = true;
  return {
    body,
    trim,
    // Gold, chrome, silver, wire and rivets: one metal, tinted per vertex.
    metal: std({
      color: 0xffffff,
      roughness: 0.22,
      metalness: 0.9,
      vertexColors: true,
    }),
    // Firewall, cockpit tub, tyres.
    dark: std({
      color: 0xffffff,
      roughness: 0.8,
      metalness: 0.2,
      vertexColors: true,
    }),
    engine,
    cream: std({
      color: CREAM,
      roughness: 0.5,
      metalness: 0.05,
      vertexColors: true,
    }),
    // Coaming, helmet, jacket and face, tinted per vertex.
    leather: std({
      color: 0xffffff,
      roughness: 0.88,
      metalness: 0.0,
      vertexColors: true,
    }),
    glass: std({
      color: 0xbfd9e8,
      roughness: 0.05,
      metalness: 0.1,
      transparent: true,
      opacity: 0.35,
      side: THREE.DoubleSide,
      // Flat panes (windshield, goggle lenses): one pass draws what three's
      // back-then-front pair would, minus two program re-checks and a draw
      // per plane per frame (O3).
      forceSinglePass: true,
    }),
    rudder,
    scarf: std({
      color: SCARF,
      roughness: 0.7,
      metalness: 0.0,
      side: THREE.DoubleSide,
    }),
    // Prop blur: transparent (so the hero patch skips it) and dim — it must
    // read as a haze, never bloom. Opacity is driven by speed (plane.ts).
    blur: std({
      color: 0x9a9da0,
      map: shared.blurTexture,
      roughness: 0.6,
      metalness: 0.3,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      side: THREE.DoubleSide,
      // A flat disc: single pass, as for the glass (O3).
      forceSinglePass: true,
    }),
  };
}

// ---------------------------------------------------------------------------
// Textures (shared by every plane — never disposed with one)

function checkerTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d");
  if (!g) return new THREE.Texture(); // 2d canvas is universal; typing only
  const n = 6;
  const s = c.width / n;
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      g.fillStyle = (i + j) % 2 ? "#111111" : "#f5f2ea";
      g.fillRect(i * s, j * s, s, s);
    }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  t.userData.shared = true;
  return t;
}

/** Radial haze for the spinning prop: clear hub, soft disc, a yellow tip
 * ring (the painted blade tips smeared into a circle) and a feathered rim. */
function blurTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d");
  if (!g) return new THREE.Texture();
  const grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  grad.addColorStop(0, "rgba(200,200,200,0)");
  grad.addColorStop(0.14, "rgba(200,200,200,0)");
  grad.addColorStop(0.3, "rgba(190,190,190,0.55)");
  grad.addColorStop(0.75, "rgba(205,205,205,0.4)");
  grad.addColorStop(0.86, "rgba(232,200,60,0.75)");
  grad.addColorStop(0.95, "rgba(232,200,60,0.5)");
  grad.addColorStop(1, "rgba(200,200,200,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.userData.shared = true;
  return t;
}

// ---------------------------------------------------------------------------
// Geometry baking: every part is built as a Mesh carrying a tag material that
// names its group and vertex tint; `bake` flattens a tree of them into one
// geometry per group with a uniform attribute set.

interface Tag {
  key: GroupKey;
  tint: number;
}
const tag = (key: GroupKey, tint = 0xffffff): THREE.MeshBasicMaterial => {
  const m = new THREE.MeshBasicMaterial();
  m.userData.tag = { key, tint } satisfies Tag;
  return m;
};
/** Tag materials, named like the old per-part materials. */
const T = {
  red: tag("body"),
  maroon: tag("trim"),
  gold: tag("metal", GOLD),
  chrome: tag("metal", CHROME),
  silver: tag("metal", SILVER),
  wire: tag("metal", WIRE),
  dark: tag("dark", DARK),
  tire: tag("dark", TIRE),
  engine: tag("engine"),
  cream: tag("cream"),
  leather: tag("leather", LEATHER),
  helmet: tag("leather", HELMET),
  jacket: tag("leather", JACKET),
  skin: tag("leather", SKIN),
  glass: tag("glass"),
};

/** Hole modes (aHole): 1 = thin fabric (see-through), 0.5 = fuselage fabric
 * (reads as a dark hole), 0 = never holed. */
const HOLE_FABRIC = 1;
const HOLE_FUSELAGE = 0.5;

const KEEP = new Set(["position", "normal", "uv", "color", "aHole", "aRest"]);
const scratchColor = new THREE.Color();

/**
 * Bring a part geometry into the shared attribute layout, transformed by
 * `matrix`: non-indexed, position/normal/uv/color/aHole/aRest. `aRest` is
 * the model-space rest position (scorch/holes stay put when a hinged part
 * moves), so callers pass `rest` when `matrix` is not model space.
 */
function normalize(
  source: THREE.BufferGeometry,
  matrix: THREE.Matrix4,
  tint: number,
  hole: number,
  rest?: THREE.Matrix4,
): THREE.BufferGeometry {
  const g = source.index ? source.toNonIndexed() : source.clone();
  if (!g.attributes.normal) g.computeVertexNormals();
  const n = (g.attributes.position as THREE.BufferAttribute).count;
  const restPos = (g.attributes.position as THREE.BufferAttribute).clone();
  restPos.applyMatrix4(rest ?? matrix);
  g.applyMatrix4(matrix);
  if (!g.attributes.uv) {
    g.setAttribute(
      "uv",
      new THREE.Float32BufferAttribute(new Float32Array(n * 2), 2),
    );
  }
  scratchColor.setHex(tint);
  const colors = new Float32Array(n * 3);
  const prior = g.attributes.color as THREE.BufferAttribute | undefined;
  for (let i = 0; i < n; i++) {
    colors[i * 3] = scratchColor.r * (prior ? prior.getX(i) : 1);
    colors[i * 3 + 1] = scratchColor.g * (prior ? prior.getY(i) : 1);
    colors[i * 3 + 2] = scratchColor.b * (prior ? prior.getZ(i) : 1);
  }
  g.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  g.setAttribute(
    "aHole",
    new THREE.Float32BufferAttribute(new Float32Array(n).fill(hole), 1),
  );
  g.setAttribute("aRest", restPos);
  for (const name of Object.keys(g.attributes)) {
    if (!KEEP.has(name)) g.deleteAttribute(name);
  }
  g.morphAttributes = {};
  g.clearGroups();
  return g;
}

/**
 * Flatten every tagged Mesh under `root` into one geometry per group key, in
 * `root`'s space. `restOf` maps root space to model space for aRest.
 */
function bake(
  root: THREE.Object3D,
  restOf?: THREE.Matrix4,
): Map<GroupKey, THREE.BufferGeometry> {
  root.updateMatrixWorld(true);
  const toRoot = root.matrixWorld.clone().invert();
  const buckets = new Map<GroupKey, THREE.BufferGeometry[]>();
  const local = new THREE.Matrix4();
  const rest = new THREE.Matrix4();
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const t = (o.material as THREE.Material).userData.tag as Tag;
    local.multiplyMatrices(toRoot, o.matrixWorld);
    if (restOf) rest.multiplyMatrices(restOf, local);
    const hole = (o.userData.hole as number | undefined) ?? 0;
    const g = normalize(
      o.geometry,
      local,
      t.tint,
      hole,
      restOf ? rest : undefined,
    );
    o.geometry.dispose();
    const list = buckets.get(t.key) ?? [];
    list.push(g);
    buckets.set(t.key, list);
  });
  const out = new Map<GroupKey, THREE.BufferGeometry>();
  for (const [key, list] of buckets) {
    const merged = mergeGeometries(list, false);
    if (!merged) throw new Error(`biplane: merge failed for ${key}`);
    for (const g of list) g.dispose();
    merged.computeBoundingSphere();
    merged.userData.shared = true;
    out.set(key, merged);
  }
  return out;
}

/** Bake a single-group subtree (a hinged part) into one geometry. */
function bakeOne(
  root: THREE.Object3D,
  restOf: THREE.Matrix4,
): THREE.BufferGeometry {
  const map = bake(root, restOf);
  const parts = [...map.values()];
  if (parts.length !== 1) throw new Error("biplane: hinged part spans groups");
  return parts[0] as THREE.BufferGeometry;
}

// ---------------------------------------------------------------------------
// Airfoil loft

/** NACA-4-style section: camber m at p, thickness t (fractions of chord). */
interface Section {
  m: number;
  p: number;
  t: number;
}
const WING_SECTION: Section = { m: 0.035, p: 0.4, t: 0.11 };
const TAIL_SECTION: Section = { m: 0, p: 0.4, t: 0.085 };

function camber(s: Section, c: number): number {
  if (s.m === 0) return 0;
  return c < s.p
    ? (s.m / (s.p * s.p)) * (2 * s.p * c - c * c)
    : (s.m / ((1 - s.p) * (1 - s.p))) * (1 - 2 * s.p + 2 * s.p * c - c * c);
}
function halfThickness(s: Section, c: number): number {
  return (
    5 *
    s.t *
    (0.2969 * Math.sqrt(c) -
      0.126 * c -
      0.3516 * c * c +
      0.2843 * c * c * c -
      0.1036 * c * c * c * c)
  );
}

/** Cosine-spaced chord stations (dense at the nose and tail). */
const CHORD_SAMPLES = Array.from(
  { length: 15 },
  (_, i) => (1 - Math.cos((Math.PI * i) / 14)) / 2,
);

interface LoftSpec {
  section: Section;
  /** Span range; x0 < x1. */
  x0: number;
  x1: number;
  /** Chord fraction range of this piece (an aileron bay stops at the hinge). */
  c0: number;
  c1: number;
  chord: number;
  /** Chord-centre z and centre-line y at the root. */
  zc: number;
  y0: number;
  dihedral: number;
  /** Rounded tip: chord shrinks toward |x| = tipEnd from |x| = tipStart. */
  tipStart?: number;
  tipEnd?: number;
  /** Fabric: sag between ribs + rib-tape vertex shading. */
  fabric: boolean;
}

function ribDistance(x: number): { d: number; bay: number } {
  const u = Math.abs(x) / RIB_PITCH;
  const nearest = Math.round(u);
  return { d: Math.abs(u - nearest) * RIB_PITCH, bay: u - Math.floor(u) };
}

/** Span stations: both ends, rib tapes, bay midpoints, tip rounding steps. */
function spanStations(spec: LoftSpec): number[] {
  const xs = new Set<number>([spec.x0, spec.x1]);
  const inRange = (x: number) => x > spec.x0 + 1e-4 && x < spec.x1 - 1e-4;
  if (spec.fabric) {
    const first = Math.floor(spec.x0 / RIB_PITCH) - 1;
    const last = Math.ceil(spec.x1 / RIB_PITCH) + 1;
    for (let k = first; k <= last; k++) {
      const r = k * RIB_PITCH;
      for (const x of [
        r - 2 * RIB_TAPE,
        r - RIB_TAPE,
        r + RIB_TAPE,
        r + 2 * RIB_TAPE,
        r + RIB_PITCH / 2,
      ]) {
        if (inRange(x)) xs.add(x);
      }
    }
  }
  if (spec.tipStart !== undefined && spec.tipEnd !== undefined) {
    for (const u of [0.3, 0.55, 0.72, 0.85, 0.94]) {
      const a = spec.tipStart + (spec.tipEnd - spec.tipStart) * u;
      if (inRange(a)) xs.add(a);
      if (inRange(-a)) xs.add(-a);
    }
  }
  return [...xs].sort((a, b) => a - b);
}

/**
 * A closed lofted airfoil piece in model space, with vertex colours for the
 * rib tapes. Ring order per station: upper surface nose→tail, then lower
 * tail→nose; cut edges (an aileron bay's spar face, an aileron's nose) get
 * duplicate vertices so they shade flat.
 */
function loft(spec: LoftSpec): THREE.BufferGeometry {
  const { section, c0, c1 } = spec;
  const cs = [
    c0,
    ...CHORD_SAMPLES.filter((c) => c > c0 + 1e-3 && c < c1 - 1e-3),
    c1,
  ];
  // Ring entries: [c, upper?]. Every entry is its own vertex, so a cut
  // face's corners are pushed twice (surface copy + face copy) to shade flat.
  const ring: [number, boolean][] = [];
  if (c0 > 0) ring.push([c0, false], [c0, true]); // nose face (aileron)
  for (const c of cs) ring.push([c, true]);
  if (c1 < 1) ring.push([c1, true], [c1, false]); // spar face (aileron bay)
  for (let i = cs.length - 1; i >= 0; i--) {
    const c = cs[i] as number;
    // Closed trailing edge / leading edge: shared by both surfaces.
    if ((c === 1 && c1 === 1) || (c === 0 && c0 === 0)) continue;
    ring.push([c, false]);
  }

  const xs = spanStations(spec);
  const pos: number[] = [];
  const col: number[] = [];
  for (const x of xs) {
    const ax = Math.abs(x);
    let chord = spec.chord;
    if (
      spec.tipStart !== undefined &&
      spec.tipEnd !== undefined &&
      ax > spec.tipStart
    ) {
      const u = Math.min(
        1,
        (ax - spec.tipStart) / (spec.tipEnd - spec.tipStart),
      );
      chord *= Math.sqrt(Math.max(0, 1 - 0.93 * u * u));
    }
    const yBase = spec.y0 + ax * Math.tan(spec.dihedral);
    const { d, bay } = ribDistance(x);
    const sag = spec.fabric
      ? FABRIC_SAG * Math.sin(Math.PI * bay) * Math.min(1, d / (2 * RIB_TAPE))
      : 0;
    const shade = !spec.fabric
      ? 1
      : d <= RIB_TAPE + 1e-4
        ? 1.0
        : 0.92 - 0.06 * Math.sin(Math.PI * bay);
    for (const [c, upper] of ring) {
      const yc = camber(section, c);
      const yt = halfThickness(section, c);
      // Fabric is taut over the nose ribbing and the trailing-edge strip.
      const bow = Math.sin(
        Math.PI * Math.min(1, Math.max(0, (c - 0.08) / 0.84)),
      );
      const y =
        yBase +
        chord * (yc + (upper ? yt : -yt) - section.m * 0.8) +
        (upper ? -1 : 1) * sag * bow;
      const z = spec.zc + chord / 2 - c * chord;
      pos.push(x, y, z);
      col.push(shade, shade, shade);
    }
  }
  const n = ring.length;
  const idx: number[] = [];
  for (let j = 0; j < xs.length - 1; j++) {
    for (let i = 0; i < n; i++) {
      const a = j * n + i;
      const b = j * n + ((i + 1) % n);
      const c = (j + 1) * n + ((i + 1) % n);
      const dd = (j + 1) * n + i;
      idx.push(a, c, b, a, dd, c);
    }
  }
  // End caps: a fan around each end ring's centroid.
  for (const [j, flip] of [
    [0, false],
    [xs.length - 1, true],
  ] as const) {
    let cy = 0;
    let cz = 0;
    for (let i = 0; i < n; i++) {
      cy += pos[(j * n + i) * 3 + 1] as number;
      cz += pos[(j * n + i) * 3 + 2] as number;
    }
    const center = pos.length / 3;
    pos.push(xs[j] as number, cy / n, cz / n);
    col.push(1, 1, 1);
    for (let i = 0; i < n; i++) {
      const a = j * n + i;
      const b = j * n + ((i + 1) % n);
      if (flip) idx.push(center, b, a);
      else idx.push(center, a, b);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Hinge line point at span x of a wing piece (camber line, chord frac c). */
function hingePoint(
  w: { y: number; z: number; chord: number },
  section: Section,
  dihedral: number,
  x: number,
  c: number,
): THREE.Vector3 {
  return new THREE.Vector3(
    x,
    w.y +
      Math.abs(x) * Math.tan(dihedral) +
      w.chord * (camber(section, c) - section.m * 0.8),
    w.z + w.chord / 2 - c * w.chord,
  );
}

// ---------------------------------------------------------------------------
// Part helpers

function strut(
  a: THREE.Vector3,
  b: THREE.Vector3,
  radius: number,
  material: THREE.Material,
  streamline = true,
): THREE.Mesh {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  const geo = new THREE.CylinderGeometry(radius, radius, len, 10);
  const m = new THREE.Mesh(geo, material);
  if (streamline) m.scale.x = 0.55; // airfoil-ish cross-section
  m.position.copy(a).addScaledVector(dir, 0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  return m;
}

function fabric(m: THREE.Mesh, hole = HOLE_FABRIC): THREE.Mesh {
  m.userData.hole = hole;
  return m;
}

/** Upper-wing surface height at span x (strut and wire attachments). */
const upperY = (x: number, base: number) =>
  base + Math.abs(x) * Math.tan(UPPER_DIHEDRAL);
const lowerY = (x: number, base: number) =>
  base + Math.abs(x) * Math.tan(LOWER_DIHEDRAL);

/** Fuselage side profile (radius, z): nose to tail. */
const FUSELAGE_PROFILE: [number, number][] = [
  [0.34, 3.26], // open cowl mouth — engine visible inside
  [0.5, 3.22],
  [0.62, 2.75],
  [0.63, 2.1],
  [0.58, 1.1],
  [0.52, 0.0],
  [0.4, -1.5],
  [0.24, -2.6],
  [0.1, -3.25],
  [0.001, -3.3],
];
/** Panel seams (z) on the fuselage: metal forward panels, then fabric. */
const PANEL_SEAMS = [2.62, 1.95, 1.3, 0.62];
const SEAM_HALF = 0.012;

function fuselageRadius(z: number): number {
  for (let i = 0; i < FUSELAGE_PROFILE.length - 1; i++) {
    const [ra, za] = FUSELAGE_PROFILE[i] as [number, number];
    const [rb, zb] = FUSELAGE_PROFILE[i + 1] as [number, number];
    if (z <= za && z >= zb) return ra + ((rb - ra) * (za - z)) / (za - zb);
  }
  return 0;
}

function fuselageGeometry(): THREE.BufferGeometry {
  const zs = new Set(FUSELAGE_PROFILE.map(([, z]) => z));
  for (const s of PANEL_SEAMS) {
    zs.add(s - SEAM_HALF);
    zs.add(s + SEAM_HALF);
  }
  const pts = [...zs]
    .sort((a, b) => b - a)
    .map((z) => new THREE.Vector2(fuselageRadius(z) || 0.001, z));
  const geo = new THREE.LatheGeometry(pts, 28);
  geo.rotateX(Math.PI / 2); // lathe axis -> Z
  // Panel seams: thin dark bands.
  const p = geo.attributes.position as THREE.BufferAttribute;
  const col = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const z = p.getZ(i);
    const seam = PANEL_SEAMS.some((s) => Math.abs(z - s) < SEAM_HALF + 1e-4);
    const v = seam ? 0.55 : 1;
    col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = v;
  }
  geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  return geo;
}

// ---------------------------------------------------------------------------
// The shared airframe

interface Pivot {
  position: THREE.Vector3;
  /** Rest rotation (the aileron hinge follows the dihedral). */
  rotation: THREE.Euler;
}

export interface SharedGeometry {
  statics: Map<GroupKey, THREE.BufferGeometry>;
  aileronL: THREE.BufferGeometry;
  aileronR: THREE.BufferGeometry;
  elevator: THREE.BufferGeometry;
  rudder: THREE.BufferGeometry;
  blades: THREE.BufferGeometry;
  blurDisc: THREE.BufferGeometry;
  impostorBody: THREE.BufferGeometry;
  impostorDark: THREE.BufferGeometry;
  pivots: {
    aileronL: Pivot;
    aileronR: Pivot;
    elevator: Pivot;
    rudder: Pivot;
  };
  checker: THREE.Texture;
  blurTexture: THREE.Texture;
}

let shared: SharedGeometry | null = null;

/** Built on the first plane (not at import: vitest has no `document`). */
function sharedGeometry(): SharedGeometry {
  if (!shared) shared = buildShared();
  return shared;
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
  const toPivot = root.matrixWorld.clone().invert();
  const holder = new THREE.Group();
  holder.applyMatrix4(toPivot);
  for (const p of parts) holder.add(p);
  root.add(holder);
  return bakeOne(root, pivotMatrix(pivot));
}

function buildShared(): SharedGeometry {
  const g = new THREE.Group();

  // ---------- fuselage (lathe of a side profile, squashed slightly oval)
  const fus = fabric(new THREE.Mesh(fuselageGeometry(), T.red), HOLE_FUSELAGE);
  fus.scale.x = 0.88;
  g.add(fus);

  // rivet rows along the forward panel seams (upper half + flanks)
  const rivet = new THREE.SphereGeometry(0.016, 6, 4);
  for (const z of PANEL_SEAMS.slice(0, 3)) {
    const r = fuselageRadius(z) + 0.004;
    for (let k = 0; k <= 12; k++) {
      const a = -1.9 + (3.8 * k) / 12; // angle from the top, radians
      const m = new THREE.Mesh(rivet, T.silver);
      m.position.set(Math.sin(a) * r * 0.88, Math.cos(a) * r, z + 0.035);
      m.scale.set(1, 1, 0.5);
      g.add(m);
    }
  }

  // gold cheat-line stripe along each flank
  for (const sx of [1, -1]) {
    const stripe = new THREE.Mesh(
      new THREE.BoxGeometry(0.02, 0.09, 5.6),
      T.gold,
    );
    stripe.position.set(sx * 0.51, 0.13, -0.35);
    stripe.rotation.y = sx * -0.035;
    g.add(stripe);
  }

  // ---------- cowl ring + radial engine + exhaust stubs
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.4, 0.085, 14, 36),
    T.maroon,
  );
  ring.scale.z = 1.6;
  ring.position.z = 3.24;
  g.add(ring);
  const firewall = new THREE.Mesh(
    new THREE.CylinderGeometry(0.5, 0.5, 0.06, 24),
    T.dark,
  );
  firewall.rotation.x = Math.PI / 2;
  firewall.position.z = 2.95;
  g.add(firewall);
  const crank = new THREE.Mesh(
    new THREE.CylinderGeometry(0.17, 0.2, 0.3, 20),
    T.engine,
  );
  crank.rotation.x = Math.PI / 2;
  crank.position.z = 3.28;
  g.add(crank);
  for (let i = 0; i < 7; i++) {
    // 7-cylinder radial peeking through the cowl, with finned heads
    const a = (i / 7) * Math.PI * 2;
    const dir = new THREE.Vector3(Math.cos(a), Math.sin(a), 0);
    const cyl = new THREE.Mesh(
      new THREE.CylinderGeometry(0.075, 0.075, 0.26, 10),
      T.engine,
    );
    cyl.position.set(dir.x * 0.28, dir.y * 0.28, 3.18);
    cyl.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    g.add(cyl);
    for (const f of [0.04, 0.08]) {
      const fin = new THREE.Mesh(
        new THREE.CylinderGeometry(0.095, 0.095, 0.012, 10),
        T.engine,
      );
      fin.position.set(dir.x * (0.28 + f), dir.y * (0.28 + f), 3.18);
      fin.quaternion.copy(cyl.quaternion);
      g.add(fin);
    }
  }
  // Exhaust stubs: two per side below the cowl, angled down and aft — on the
  // engine material, so they glow with the exhaust ring.
  for (const sx of [1, -1]) {
    for (const [y, z] of [
      [-0.2, 2.86],
      [-0.33, 2.8],
    ] as const) {
      const stub = strut(
        new THREE.Vector3(sx * 0.42, y, z),
        new THREE.Vector3(sx * 0.53, y - 0.08, z - 0.38),
        0.032,
        T.engine,
        false,
      );
      g.add(stub);
    }
  }
  const spinner = new THREE.Mesh(
    new THREE.SphereGeometry(0.16, 20, 14),
    T.chrome,
  );
  spinner.scale.z = 1.7;
  spinner.position.z = 3.52;
  g.add(spinner);

  // ---------- wings: lofted airfoils, upper larger + forward, lower staggered
  const wingPiece = (
    w: typeof UPPER,
    dihedral: number,
    x0: number,
    x1: number,
    c1 = 1,
  ) =>
    fabric(
      new THREE.Mesh(
        loft({
          section: WING_SECTION,
          x0,
          x1,
          c0: 0,
          c1,
          chord: w.chord,
          zc: w.z,
          y0: w.y,
          dihedral,
          tipStart: w.tip,
          tipEnd: w.half,
          fabric: true,
        }),
        T.red,
      ),
    );
  // upper: tip | aileron bay | centre | aileron bay | tip
  g.add(wingPiece(UPPER, UPPER_DIHEDRAL, -UPPER.half, -UPPER.tip));
  g.add(
    wingPiece(UPPER, UPPER_DIHEDRAL, -UPPER.tip, -AILERON_IN, AILERON_HINGE_C),
  );
  g.add(wingPiece(UPPER, UPPER_DIHEDRAL, -AILERON_IN, AILERON_IN));
  g.add(
    wingPiece(UPPER, UPPER_DIHEDRAL, AILERON_IN, UPPER.tip, AILERON_HINGE_C),
  );
  g.add(wingPiece(UPPER, UPPER_DIHEDRAL, UPPER.tip, UPPER.half));
  g.add(wingPiece(LOWER, LOWER_DIHEDRAL, -LOWER.half, LOWER.half));
  // aileron hinge fairings (secondary colour) on the upper wing's bays
  for (const sx of [1, -1]) {
    const a = hingePoint(
      UPPER,
      WING_SECTION,
      UPPER_DIHEDRAL,
      sx * AILERON_IN,
      AILERON_HINGE_C,
    );
    const b = hingePoint(
      UPPER,
      WING_SECTION,
      UPPER_DIHEDRAL,
      sx * UPPER.tip,
      AILERON_HINGE_C,
    );
    g.add(strut(a, b, 0.018, T.maroon, false));
  }

  // ---------- cabane + interplane struts (attachments follow the dihedral)
  const cab: [THREE.Vector3, THREE.Vector3][] = [
    [new THREE.Vector3(0.3, 0.52, 1.05), new THREE.Vector3(0.55, 1.3, 0.95)],
    [new THREE.Vector3(0.3, 0.5, 0.15), new THREE.Vector3(0.55, 1.3, 0.3)],
  ];
  for (const sx of [1, -1])
    for (const [a, b] of cab)
      g.add(
        strut(
          new THREE.Vector3(a.x * sx, a.y, a.z),
          new THREE.Vector3(b.x * sx, upperY(b.x, b.y), b.z),
          0.035,
          T.cream,
        ),
      );
  for (const sx of [1, -1]) {
    const xo = 3.05;
    const lowF = new THREE.Vector3(xo * sx, lowerY(xo, -0.25), 0.55);
    const lowR = new THREE.Vector3(xo * sx, lowerY(xo, -0.25), -0.25);
    const upF = new THREE.Vector3(xo * sx, upperY(xo, 1.32), 1.0);
    const upR = new THREE.Vector3(xo * sx, upperY(xo, 1.32), 0.25);
    g.add(strut(lowF, upF, 0.04, T.cream));
    g.add(strut(lowR, upR, 0.04, T.cream));
    g.add(strut(lowR, upF, 0.028, T.cream)); // N diagonal
    // crossed flying wires, front and rear bays
    const rootLowF = new THREE.Vector3(0.62 * sx, lowerY(0.62, -0.28), 0.55);
    const rootLowR = new THREE.Vector3(0.62 * sx, lowerY(0.62, -0.28), -0.2);
    const rootUpF = new THREE.Vector3(0.6 * sx, upperY(0.6, 1.3), 1.0);
    const rootUpR = new THREE.Vector3(0.6 * sx, upperY(0.6, 1.3), 0.3);
    g.add(strut(rootLowF, upF, 0.011, T.wire, false));
    g.add(strut(rootLowR, upR, 0.011, T.wire, false));
    g.add(strut(rootUpF, lowF, 0.011, T.wire, false));
    g.add(strut(rootUpR, lowR, 0.011, T.wire, false));
  }

  // ---------- cockpit (open, leather coaming) + windshield + headrest fairing
  const rim = new THREE.Mesh(
    new THREE.TorusGeometry(0.3, 0.055, 12, 26),
    T.leather,
  );
  rim.rotation.x = Math.PI / 2;
  rim.scale.set(1, 1.35, 1);
  rim.position.set(0, 0.44, -0.75);
  g.add(rim);
  const pit = new THREE.Mesh(
    new THREE.CylinderGeometry(0.29, 0.24, 0.3, 20),
    T.dark,
  );
  pit.scale.z = 1.35;
  pit.position.set(0, 0.3, -0.75);
  g.add(pit);
  const shield = new THREE.Mesh(new THREE.PlaneGeometry(0.52, 0.3), T.glass);
  shield.position.set(0, 0.62, -0.28);
  shield.rotation.x = -0.5;
  g.add(shield);
  const shieldFrame = new THREE.Mesh(
    new THREE.TorusGeometry(0.27, 0.008, 4, 24, Math.PI),
    T.silver,
  );
  shieldFrame.position.set(0, 0.5, -0.22);
  shieldFrame.rotation.x = -0.5;
  shieldFrame.scale.set(1, 0.85, 1);
  g.add(shieldFrame);
  const fair = new THREE.Mesh(new THREE.SphereGeometry(0.24, 16, 12), T.red);
  fair.scale.set(0.8, 1.0, 3.2);
  fair.position.set(0, 0.42, -1.72);
  g.add(fair);

  // ---------- pilot: leather jacket, skin, helmet with ear flaps, goggles
  const torso = new THREE.Mesh(
    new THREE.CylinderGeometry(0.15, 0.2, 0.34, 14),
    T.jacket,
  );
  torso.scale.z = 0.75;
  torso.position.set(0, 0.55, -0.82);
  g.add(torso);
  const shoulders = new THREE.Mesh(
    new THREE.SphereGeometry(0.16, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2),
    T.jacket,
  );
  shoulders.scale.set(1.15, 0.45, 0.8);
  shoulders.position.set(0, 0.7, -0.82);
  g.add(shoulders);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.105, 16, 12), T.skin);
  head.position.set(0, 0.85, -0.8);
  g.add(head);
  // Helmet: a cap over the crown, and a back/sides shell that leaves the
  // face open (phi measured from −X toward +Z; the face is at phi = π/2).
  const cap = new THREE.Mesh(
    new THREE.SphereGeometry(0.116, 16, 8, 0, Math.PI * 2, 0, Math.PI * 0.42),
    T.helmet,
  );
  cap.position.copy(head.position);
  g.add(cap);
  const shell = new THREE.Mesh(
    new THREE.SphereGeometry(
      0.114,
      16,
      8,
      Math.PI / 2 + 0.75,
      Math.PI * 2 - 1.5,
      Math.PI * 0.4,
      Math.PI * 0.38,
    ),
    T.helmet,
  );
  shell.position.copy(head.position);
  g.add(shell);
  for (const sx of [1, -1]) {
    // ear flaps
    const flap = new THREE.Mesh(new THREE.SphereGeometry(0.04, 8, 6), T.helmet);
    flap.scale.set(0.45, 1.1, 0.9);
    flap.position.set(sx * 0.105, 0.82, -0.81);
    g.add(flap);
    // goggles: chrome rims + glass lenses over the eyes
    const lensPos = new THREE.Vector3(sx * 0.043, 0.875, -0.705);
    const rimG = new THREE.Mesh(
      new THREE.TorusGeometry(0.028, 0.008, 6, 14),
      T.chrome,
    );
    rimG.position.copy(lensPos);
    g.add(rimG);
    const lens = new THREE.Mesh(new THREE.CircleGeometry(0.026, 14), T.glass);
    lens.position.copy(lensPos).add(new THREE.Vector3(0, 0, 0.004));
    g.add(lens);
  }
  const strap = new THREE.Mesh(
    new THREE.TorusGeometry(0.112, 0.01, 4, 24),
    T.leather,
  );
  strap.rotation.x = Math.PI / 2;
  strap.position.set(0, 0.875, -0.8);
  g.add(strap);
  // scarf collar (the trailing tail is a per-plane animated strip)
  const collar = new THREE.Mesh(
    new THREE.TorusGeometry(0.075, 0.025, 6, 16),
    T.cream,
  );
  collar.rotation.x = Math.PI / 2;
  collar.position.set(0, 0.74, -0.81);
  g.add(collar);

  // ---------- tail: fin (fabric), stabilizer (airfoil), bracing wires
  const finShape = new THREE.Shape();
  finShape.moveTo(-0.0, 0);
  finShape.lineTo(0.75, 0);
  finShape.quadraticCurveTo(0.85, 0.55, 0.45, 0.95);
  finShape.quadraticCurveTo(0.2, 1.05, 0.0, 0.9);
  finShape.lineTo(0, 0);
  const fin = fabric(
    new THREE.Mesh(
      new THREE.ExtrudeGeometry(finShape, {
        depth: 0.045,
        bevelEnabled: false,
        curveSegments: 16,
      }),
      T.red,
    ),
    HOLE_FUSELAGE, // vertical: holes read dark, never see-through
  );
  fin.rotation.y = -Math.PI / 2; // shape x -> +Z(forward), lies on center plane
  fin.position.set(0.022, 0.25, -2.55 - 0.75); // shape x=0 at hinge z=-3.3
  g.add(fin);

  const stabPiece = (x0: number, x1: number, c1: number) =>
    fabric(
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
          fabric: true,
        }),
        T.red,
      ),
    );
  g.add(stabPiece(-STAB.half, -STAB.tip, 1));
  g.add(stabPiece(-STAB.tip, STAB.tip, ELEVATOR_HINGE_C));
  g.add(stabPiece(STAB.tip, STAB.half, 1));
  for (const sx of [1, -1]) {
    // tail bracing wires
    g.add(
      strut(
        new THREE.Vector3(0, 1.05, -3.1),
        new THREE.Vector3(1.35 * sx, 0.18, -2.95),
        0.009,
        T.wire,
        false,
      ),
    );
    g.add(
      strut(
        new THREE.Vector3(0, -0.2, -3.05),
        new THREE.Vector3(1.35 * sx, 0.14, -2.95),
        0.009,
        T.wire,
        false,
      ),
    );
  }

  // ---------- landing gear: red streamlined legs, spreader, wheels, tailwheel
  for (const sx of [1, -1]) {
    const hub = new THREE.Vector3(0.98 * sx, -1.22, 0.85);
    g.add(strut(new THREE.Vector3(0.34 * sx, -0.42, 1.35), hub, 0.055, T.red));
    g.add(strut(new THREE.Vector3(0.36 * sx, -0.4, 0.45), hub, 0.055, T.red));
    g.add(
      strut(
        new THREE.Vector3(0.6 * sx, -0.3, 0.55),
        new THREE.Vector3(-0.98 * sx, -1.22, 0.85),
        0.012,
        T.wire,
        false,
      ),
    );
    const tire = new THREE.Mesh(
      new THREE.TorusGeometry(0.245, 0.115, 14, 26),
      T.tire,
    );
    tire.rotation.y = Math.PI / 2;
    tire.position.copy(hub);
    g.add(tire);
    for (const hx of [0.075, -0.075]) {
      const cap = new THREE.Mesh(
        new THREE.CylinderGeometry(0.17, 0.19, 0.15, 20),
        T.red,
      );
      cap.rotation.z = Math.PI / 2;
      cap.position.copy(hub).add(new THREE.Vector3(hx * sx, 0, 0));
      g.add(cap);
    }
  }
  const spreader = new THREE.Mesh(
    new THREE.CylinderGeometry(0.05, 0.05, 1.96, 10),
    T.red,
  );
  spreader.rotation.z = Math.PI / 2;
  spreader.scale.z = 0.6;
  spreader.position.set(0, -1.22, 0.85);
  g.add(spreader);
  const tw = new THREE.Mesh(
    new THREE.TorusGeometry(0.08, 0.045, 10, 18),
    T.tire,
  );
  tw.rotation.y = Math.PI / 2;
  tw.position.set(0, -0.52, -3.0);
  g.add(tw);
  g.add(
    strut(
      new THREE.Vector3(0, -0.18, -2.85),
      new THREE.Vector3(0, -0.5, -3.0),
      0.035,
      T.silver,
    ),
  );

  const statics = bake(g);

  // ---------- hinged surfaces (built in model space, baked into pivot space)
  const aileron = (sx: 1 | -1) => {
    const inner = sx * AILERON_IN;
    const outer = sx * (UPPER.tip - 0.02);
    const pivot: Pivot = {
      position: hingePoint(
        UPPER,
        WING_SECTION,
        UPPER_DIHEDRAL,
        inner,
        AILERON_HINGE_C,
      ),
      rotation: new THREE.Euler(0, 0, sx * UPPER_DIHEDRAL),
    };
    const part = fabric(
      new THREE.Mesh(
        loft({
          section: WING_SECTION,
          x0: Math.min(inner, outer),
          x1: Math.max(inner, outer),
          c0: AILERON_FRONT_C,
          c1: 1,
          chord: UPPER.chord,
          zc: UPPER.z,
          y0: UPPER.y,
          dihedral: UPPER_DIHEDRAL,
          fabric: true,
        }),
        T.red,
      ),
    );
    return { pivot, geometry: bakeHinged([part], pivot) };
  };
  const ailL = aileron(1); // model +X = the pilot's left
  const ailR = aileron(-1);

  const elevatorPivot: Pivot = {
    position: hingePoint(STAB, TAIL_SECTION, 0, 0, ELEVATOR_HINGE_C),
    rotation: new THREE.Euler(),
  };
  const elevatorParts = [
    [-STAB.tip + 0.02, -ELEVATOR_GAP],
    [ELEVATOR_GAP, STAB.tip - 0.02],
  ].map(([x0, x1]) =>
    fabric(
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
          fabric: true,
        }),
        T.red,
      ),
    ),
  );
  const elevator = bakeHinged(elevatorParts, elevatorPivot);

  // Rudder: checkered, hinged on the post. Planar UVs over the shape so the
  // checker maps cleanly on both faces.
  const rudShape = new THREE.Shape();
  rudShape.moveTo(0, -0.15);
  rudShape.lineTo(0, 0.95);
  rudShape.quadraticCurveTo(-0.55, 1.0, -0.62, 0.45);
  rudShape.quadraticCurveTo(-0.66, -0.05, -0.35, -0.22);
  rudShape.lineTo(0, -0.15);
  const rudGeo = new THREE.ExtrudeGeometry(rudShape, {
    depth: 0.04,
    bevelEnabled: false,
    curveSegments: 16,
  });
  rudGeo.computeBoundingBox();
  const bb = rudGeo.boundingBox ?? new THREE.Box3();
  const uv = rudGeo.attributes.uv as THREE.BufferAttribute;
  const pos = rudGeo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(
      i,
      (pos.getX(i) - bb.min.x) / (bb.max.x - bb.min.x),
      (pos.getY(i) - bb.min.y) / (bb.max.y - bb.min.y),
    );
  }
  const rudderPivot: Pivot = {
    position: RUDDER_HINGE.clone(),
    rotation: new THREE.Euler(),
  };
  const rudderMesh = fabric(new THREE.Mesh(rudGeo, T.red), HOLE_FUSELAGE);
  rudderMesh.rotation.y = -Math.PI / 2;
  rudderMesh.position.set(0.02, 0.25, -3.32);
  const rudder = bakeHinged([rudderMesh], rudderPivot);

  // ---------- propeller blades (prop space: hub at origin, spin about Z)
  const prop = new THREE.Group();
  for (const rot of [0, Math.PI]) {
    const bladeGeo = new THREE.CylinderGeometry(0.055, 0.1, 1.55, 10, 6);
    // Painted tips: the outer ~10 cm of each blade is yellow.
    const bp = bladeGeo.attributes.position as THREE.BufferAttribute;
    const bc = new Float32Array(bp.count * 3);
    const tip = new THREE.Color(PROP_TIP);
    const base = new THREE.Color(SILVER);
    for (let i = 0; i < bp.count; i++) {
      const c = bp.getY(i) > 0.62 ? tip : base;
      bc[i * 3] = c.r;
      bc[i * 3 + 1] = c.g;
      bc[i * 3 + 2] = c.b;
    }
    bladeGeo.setAttribute("color", new THREE.Float32BufferAttribute(bc, 3));
    const blade = new THREE.Mesh(bladeGeo, tag("metal"));
    blade.scale.z = 0.28;
    blade.position.y = 0.82;
    blade.rotation.y = 0.42; // blade pitch
    const holder = new THREE.Group();
    holder.add(blade);
    holder.rotation.z = rot;
    prop.add(holder);
  }
  const propRest = new THREE.Matrix4().makeTranslation(0, 0, PROP_Z);
  const blades = bakeOne(prop, propRest);

  const disc = new THREE.Mesh(
    new THREE.CircleGeometry(PROP_RADIUS, 48),
    tag("metal"),
  );
  const blurDisc = bakeOne(disc, propRest);

  // ---------- far impostor: a low-poly silhouette in two groups
  const far = new THREE.Group();
  const farFus = new THREE.Mesh(
    new THREE.LatheGeometry(
      [
        new THREE.Vector2(0.5, 3.2),
        new THREE.Vector2(0.62, 2.4),
        new THREE.Vector2(0.52, 0),
        new THREE.Vector2(0.22, -2.6),
        new THREE.Vector2(0.001, -3.3),
      ],
      6,
    ),
    T.red,
  );
  farFus.geometry.rotateX(Math.PI / 2);
  farFus.scale.x = 0.88;
  far.add(farFus);
  for (const [w, sy] of [
    [UPPER, UPPER.y + 0.05],
    [LOWER, LOWER.y + 0.05],
    [STAB, STAB.y],
  ] as const) {
    const wing = new THREE.Mesh(
      new THREE.BoxGeometry(w.half * 2, 0.12, w.chord),
      T.red,
    );
    wing.position.set(0, sy, w.z);
    far.add(wing);
  }
  const farFin = new THREE.Mesh(new THREE.BoxGeometry(0.05, 1.0, 0.9), T.red);
  farFin.position.set(0, 0.7, -3.25);
  far.add(farFin);
  const farNose = new THREE.Mesh(
    new THREE.CylinderGeometry(0.48, 0.48, 0.4, 8),
    T.dark,
  );
  farNose.rotation.x = Math.PI / 2;
  farNose.position.z = 3.2;
  far.add(farNose);
  for (const sx of [1, -1]) {
    const wheel = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.6, 0.6), T.tire);
    wheel.position.set(sx * 0.98, -1.22, 0.85);
    far.add(wheel);
  }
  const farGroups = bake(far);

  const required = (m: Map<GroupKey, THREE.BufferGeometry>, k: GroupKey) => {
    const geo = m.get(k);
    if (!geo) throw new Error(`biplane: missing ${k} geometry`);
    return geo;
  };
  return {
    statics,
    aileronL: ailL.geometry,
    aileronR: ailR.geometry,
    elevator,
    rudder,
    blades,
    blurDisc,
    impostorBody: required(farGroups, "body"),
    impostorDark: required(farGroups, "dark"),
    pivots: {
      aileronL: ailL.pivot,
      aileronR: ailR.pivot,
      elevator: elevatorPivot,
      rudder: rudderPivot,
    },
    checker: checkerTexture(),
    blurTexture: blurTexture(),
  };
}

// ---------------------------------------------------------------------------
// Per-plane assembly

/** Scarf strip resolution (segments along its length). */
export const SCARF_SEGMENTS = 10;
/** Where the scarf leaves the collar (model space). */
export const SCARF_ROOT = new THREE.Vector3(0, 0.73, -0.86);

/** The moving bits of one plane, for the per-frame animation (plane.ts). */
export interface BiplaneParts {
  /** Deflection children (rotation.x) of the dihedral-tilted hinge pivots. */
  aileronL: THREE.Object3D;
  aileronR: THREE.Object3D;
  elevator: THREE.Object3D;
  /** Rudder deflection (rotation.y). */
  rudder: THREE.Object3D;
  blur: THREE.Mesh;
  blurMaterial: THREE.MeshStandardMaterial;
  scarf: THREE.Mesh;
}

export interface Biplane {
  near: THREE.Group;
  far: THREE.Group;
  parts: BiplaneParts;
  materials: BiplaneMaterials;
}

function hinged(
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  pivot: Pivot,
): { holder: THREE.Group; deflect: THREE.Group } {
  const holder = new THREE.Group();
  holder.position.copy(pivot.position);
  holder.rotation.copy(pivot.rotation);
  const deflect = new THREE.Group();
  deflect.add(new THREE.Mesh(geometry, material));
  holder.add(deflect);
  return { holder, deflect };
}

/** A fresh scarf strip (per plane: plane.ts rewrites it every frame). */
function scarfGeometry(): THREE.BufferGeometry {
  const n = (SCARF_SEGMENTS + 1) * 2;
  const g = new THREE.BufferGeometry();
  const position = new THREE.Float32BufferAttribute(new Float32Array(n * 3), 3);
  position.setUsage(THREE.DynamicDrawUsage);
  g.setAttribute("position", position);
  const normal = new THREE.Float32BufferAttribute(new Float32Array(n * 3), 3);
  normal.setUsage(THREE.DynamicDrawUsage);
  g.setAttribute("normal", normal);
  const idx: number[] = [];
  for (let i = 0; i < SCARF_SEGMENTS; i++) {
    const a = i * 2;
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  g.setIndex(idx);
  // Fixed, generous bounds: the strip is rewritten every frame.
  g.boundingSphere = new THREE.Sphere(SCARF_ROOT.clone().setZ(-1.3), 1.2);
  return g;
}

export function createBiplane(livery: Livery = CLASSIC_LIVERY): Biplane {
  const s = sharedGeometry();
  const M = materials(livery, s);
  const near = new THREE.Group();
  for (const key of GROUP_KEYS) {
    const geo = s.statics.get(key);
    if (geo) near.add(new THREE.Mesh(geo, M[key]));
  }
  const ailL = hinged(s.aileronL, M.body, s.pivots.aileronL);
  const ailR = hinged(s.aileronR, M.body, s.pivots.aileronR);
  const elev = hinged(s.elevator, M.body, s.pivots.elevator);
  const rud = hinged(s.rudder, M.rudder, s.pivots.rudder);
  near.add(ailL.holder, ailR.holder, elev.holder, rud.holder);

  const prop = new THREE.Group();
  prop.name = "propeller"; // spin this at runtime
  prop.add(new THREE.Mesh(s.blades, M.metal));
  prop.position.z = PROP_Z;
  near.add(prop);
  const blur = new THREE.Mesh(s.blurDisc, M.blur);
  blur.position.z = PROP_Z + 0.02;
  blur.visible = false; // until speed fades it in
  near.add(blur);
  const scarfGeo = scarfGeometry();
  const scarf = new THREE.Mesh(scarfGeo, M.scarf);
  near.add(scarf);

  const far = new THREE.Group();
  far.add(
    new THREE.Mesh(s.impostorBody, M.body),
    new THREE.Mesh(s.impostorDark, M.dark),
  );

  return {
    near,
    far,
    materials: M,
    parts: {
      aileronL: ailL.deflect,
      aileronR: ailR.deflect,
      elevator: elev.deflect,
      rudder: rud.deflect,
      blur,
      blurMaterial: M.blur,
      scarf,
    },
  };
}
