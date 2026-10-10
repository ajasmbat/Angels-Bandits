// P4 plane fleet: every plane in the room — the own plane and every remote —
// drawn by ONE set of instanced draws, however many planes there are.
//
// Why: a plane was 15 draws up close (biplane.ts: eight material groups, four
// hinged surfaces, the prop, its blur disc and the scarf) plus a name-tag
// sprite, so a full 12-plane furball spent ~190 draws on planes alone — more
// than the whole city — and peak chaos could never fit its budget
// (tools/perf/README.md, P4).
//
// How: planes keep everything they had — their Group, the zoom-aware
// PlaneLOD, the rig `animatePlane` drives (hinges, prop, blur, scarf phase,
// battle damage) — but their meshes are taken off every camera layer. Each
// frame the fleet reads each plane's live state and writes one instance per
// plane into eight InstancedMeshes built from the SAME shared airframe:
//
//   near  LIVERY  body + trim + ailerons + elevator (livery colours per
//                 instance, the hinges turned in the vertex shader)
//         MISC    metal + prop blades + dark + engine + cream + leather
//                 (each part's colour baked, roughness / metalness per
//                 vertex, the exhaust ring's glow masked per vertex)
//         RUDDER  the checker rudder (its own map), hinged
//         GLASS   windscreen and goggles
//         BLUR    the prop disc, its speed fade per instance
//         SCARF   the pilot's scarf, its flutter in the vertex shader
//   far   LIVERY + MISC impostor groups (the 2-draw silhouette)
//
// DT1 adds the enemy fighter-bomber (fighter.ts) and a mid level, for +2
// draws however many planes there are:
//
//   ENEMY  the fighter's whole near airframe in ONE draw — hinges and prop
//          turned in the vertex shader, the five bombs collapsed by the
//          plane's rack mask, its paintwork (camo, decals, panel lines,
//          rivets, soot, oil, chips) procedural from the rest position
//   LOD    biplane-mid, fighter-mid and fighter-far as frames of one
//          geometry: a per-instance kind picks the frame, the others'
//          vertices collapse to a point (zero-area triangles; positions
//          only — normals stay valid)
//
// The fighter's canopy glass rides the GLASS draw (the same frame select)
// and its prop blur the BLUR draw (the disc scaled by its matrix).
//
// Per instance: the model matrix, the four deflections (aileron, elevator,
// rudder, prop angle — read straight off the rig's hinge objects), battle
// damage (the uAbDamage the per-plane uniform carried), the spawn-shimmer /
// storm-reveal glow (the emissive the per-plane materials were tinted with),
// the blur's opacity and the scarf's phase. The hero light and damage GLSL
// are the planes' own (planelights.ts, plane.ts), so a plane looks the same.
//
// Every mesh has frustumCulled = false: instances span the city, and an
// InstancedMesh's cached bound would cull planes it no longer covers. The
// glass and blur are one transparent object each; they do not write depth,
// so a cloud or smoke puff sorted after them is never depth-rejected.
//
// `?fleet=0` keeps the per-plane meshes drawing as before (main.ts) — the
// rollback for bisecting a visual or driver problem.

import { ROOM_CAP } from "@angels-bandits/common/constants";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import {
  type BiplaneMaterials,
  type Pivot,
  SCARF_ROOT,
  SCARF_SEGMENTS,
  biplaneSources,
} from "./biplane";
import {
  BOMB_ID_BASE,
  DETAIL_FRAGMENT_BODY,
  DETAIL_FRAGMENT_DECL,
  DETAIL_VERTEX_BODY,
  DETAIL_VERTEX_DECL,
  FIGHTER_PROP_Z,
  fighterDecals,
  fighterGeometry,
} from "./fighter";
import { SCARF_LENGTH, patchDamage, planeRig } from "./plane";
import { patchHeroFragment } from "./planelights";
import type { QualityTier } from "./quality";

/** Biplanes the fleet draws: the room's humans, plus a few remotes that
 * are leaving while others join. Planes past it are not drawn. */
const CAPACITY_BIPLANE = ROOM_CAP + 8;
/** DT1: enemy fighter-bombers (the carrier's waves, on top of the room). */
const CAPACITY_ENEMY = 24;
/** Draws both airframes share (LOD, glass, blur). */
const CAPACITY_ALL = CAPACITY_BIPLANE + CAPACITY_ENEMY;

/** LOD / glass frames (aPart.x there; the per-instance aKind picks one). */
const FRAME_BIPLANE_MID = 0;
const FRAME_FIGHTER_MID = 1;
const FRAME_FIGHTER_FAR = 2;
/** Glass frames: the biplane's windscreen / goggles, the fighter canopy. */
const FRAME_BIPLANE_GLASS = 0;
const FRAME_FIGHTER_GLASS = 1;
/** Livery slot that takes no livery tint (colours baked). */
const SLOT_BAKED = 2;

/** Per-vertex hinge ids (0: rigid). */
const HINGE_AILERON_L = 1;
const HINGE_AILERON_R = 2;
const HINGE_ELEVATOR = 3;
const HINGE_RUDDER = 4;
const HINGE_PROP = 5;
const HINGES = 6;

/** The scarf's flutter terms repeat every 20π of phase (sin w, sin(1.3 w + 1),
 * sin(w + 0.8): 2π and 2π / 1.3 both divide it), so the phase is wrapped to
 * that before it goes into a float attribute and loses precision. */
const SCARF_PHASE_WRAP = 20 * Math.PI;
const TWO_PI = 2 * Math.PI;

// --- Geometry ---------------------------------------------------------------

interface PartSpec {
  geometry: THREE.BufferGeometry;
  hinge: number;
  /** Livery slot: 0 primary, 1 secondary, 2 baked (LIVERY / LOD only). */
  slot?: number;
  roughness: number;
  metalness: number;
  /** Bake this colour (linear) into the vertex colours (MISC only). */
  tint?: THREE.Color;
  exhaust?: number;
}

const SHARED_ATTRS = ["position", "normal", "uv", "color", "aHole", "aRest"];

/** One part in the merged layout: the shared attributes plus the fleet's. */
function part(spec: PartSpec) {
  const g = new THREE.BufferGeometry();
  const src = spec.geometry;
  const n = (src.getAttribute("position") as THREE.BufferAttribute).count;
  for (const name of SHARED_ATTRS) {
    const a = src.getAttribute(name) as THREE.BufferAttribute | undefined;
    if (!a) throw new Error(`fleet: the airframe has no ${name}`);
    g.setAttribute(name, a);
  }
  if (spec.tint) {
    const c = (src.getAttribute("color") as THREE.BufferAttribute).clone();
    for (let i = 0; i < n; i++) {
      c.setXYZ(
        i,
        c.getX(i) * spec.tint.r,
        c.getY(i) * spec.tint.g,
        c.getZ(i) * spec.tint.b,
      );
    }
    g.setAttribute("color", c);
  }
  // Packed, so a draw stays inside the 16 vertex attributes a GPU must
  // offer (the instance matrix alone takes four): x hinge id, y livery
  // slot, z exhaust-glow mask, w the damage patch's hole mode (aHole).
  const hole = src.getAttribute("aHole") as THREE.BufferAttribute;
  const part = new Float32Array(n * 4);
  const rm = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    part[i * 4] = spec.hinge;
    part[i * 4 + 1] = spec.slot ?? 0;
    part[i * 4 + 2] = spec.exhaust ?? 0;
    part[i * 4 + 3] = hole.getX(i);
    rm[i * 2] = spec.roughness;
    rm[i * 2 + 1] = spec.metalness;
  }
  g.setAttribute("aPart", new THREE.BufferAttribute(part, 4));
  g.setAttribute("aRM", new THREE.BufferAttribute(rm, 2));
  return g;
}

function merged(
  parts: (PartSpec | THREE.BufferGeometry)[],
): THREE.BufferGeometry {
  const g = mergeGeometries(
    parts.map((p) => (p instanceof THREE.BufferGeometry ? p : part(p))),
    false,
  );
  if (!g) throw new Error("fleet: merge failed");
  return g;
}

/** A fighter geometry (already in the fleet layout, fighter.ts) with its
 * aPart.x (hinge or frame id) and, if given, aPart.y (livery slot) set. */
function withPart(
  src: THREE.BufferGeometry,
  x: number | null,
  y?: number,
): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  for (const name of [...SHARED_ATTRS, "aRM"]) {
    const a = src.getAttribute(name) as THREE.BufferAttribute | undefined;
    if (!a) throw new Error(`fleet: the fighter has no ${name}`);
    g.setAttribute(name, a);
  }
  const p = (src.getAttribute("aPart") as THREE.BufferAttribute).clone();
  for (let i = 0; i < p.count; i++) {
    if (x !== null) p.setX(i, x);
    if (y !== undefined) p.setY(i, y);
  }
  g.setAttribute("aPart", p);
  return g;
}

/** The scarf strip at rest, plus where along it (s) and which edge each
 * vertex is — the vertex shader rebuilds `flutterScarf`'s wave from them. */
function scarfGeometry(): THREE.BufferGeometry {
  const n = (SCARF_SEGMENTS + 1) * 2;
  const pos = new Float32Array(n * 3);
  const along = new Float32Array(n * 2);
  for (let i = 0; i <= SCARF_SEGMENTS; i++) {
    const s = i / SCARF_SEGMENTS;
    for (let e = 0; e < 2; e++) {
      const v = i * 2 + e;
      pos[v * 3] = SCARF_ROOT.x;
      pos[v * 3 + 1] = SCARF_ROOT.y - 0.07 * s;
      pos[v * 3 + 2] = SCARF_ROOT.z - s * SCARF_LENGTH;
      along[v * 2] = s;
      along[v * 2 + 1] = e === 0 ? -1 : 1;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute(
    "normal",
    new THREE.BufferAttribute(new Float32Array(n * 3).fill(0), 3),
  );
  g.setAttribute("aScarf", new THREE.BufferAttribute(along, 2));
  const idx: number[] = [];
  for (let i = 0; i < SCARF_SEGMENTS; i++) {
    const a = i * 2;
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  g.setIndex(idx);
  return g;
}

const pivotMatrix = (p: Pivot): THREE.Matrix4 =>
  new THREE.Matrix4().compose(
    p.position,
    new THREE.Quaternion().setFromEuler(p.rotation),
    new THREE.Vector3(1, 1, 1),
  );

// --- Shaders ----------------------------------------------------------------

interface Variant {
  key: string;
  /** The hero light (opaque parts), and its exhaust ring masked per vertex. */
  hero?: boolean;
  exhaust?: boolean;
  damage?: boolean;
  hinge?: boolean;
  livery?: boolean;
  rm?: boolean;
  alpha?: boolean;
  scarf?: boolean;
  /** DT1: the fighter's bomb ids (≥ BOMB_ID_BASE) collapse by aBombs. */
  bombs?: boolean;
  /** DT1: the per-instance frame select (aPart.x vs aKind). */
  select?: boolean;
  /** DT1: the fighter's procedural paintwork and its decal atlas. */
  detail?: THREE.Texture | null;
}

const HINGE_DECL = `
attribute vec4 aDeflect;
uniform mat4 uAbHinge[${HINGES}];
mat3 abHingeRot(int h) {
  float a = h == ${HINGE_AILERON_L} ? aDeflect.x
    : h == ${HINGE_AILERON_R} ? -aDeflect.x
    : h == ${HINGE_ELEVATOR} ? aDeflect.y
    : h == ${HINGE_RUDDER} ? aDeflect.z
    : aDeflect.w;
  float c = cos(a);
  float s = sin(a);
  if (h == ${HINGE_RUDDER}) return mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c);
  if (h == ${HINGE_PROP}) return mat3(c, s, 0.0, -s, c, 0.0, 0.0, 0.0, 1.0);
  return mat3(1.0, 0.0, 0.0, 0.0, c, s, 0.0, -s, c);
}`;
// Hinge ids index uAbHinge only inside [1, HINGES): the fighter's bomb ids
// (≥ BOMB_ID_BASE) ride the same attribute and must never read past it.
const HINGE_NORMAL = `
int abH = int(aPart.x + 0.5);
mat3 abR = mat3(1.0);
mat4 abP = mat4(1.0);
if (abH > 0 && abH < ${HINGES}) {
  abR = abHingeRot(abH);
  abP = uAbHinge[abH];
  objectNormal = mat3(abP) * (abR * objectNormal);
}`;
const HINGE_POSITION = `
if (abH > 0 && abH < ${HINGES}) transformed = (abP * vec4(abR * transformed, 1.0)).xyz;`;
/** A bomb off its rack: every vertex to one point (position only). */
const BOMBS_DECL = `
attribute float aBombs;`;
const BOMBS_POSITION = `
if (abH >= ${BOMB_ID_BASE} && ((int(aBombs + 0.5) >> (abH - ${BOMB_ID_BASE})) & 1) == 0) transformed = vec3(0.0);`;
/** The frame select: another frame's vertices collapse to one point. */
const SELECT_DECL = `
attribute float aKind;`;
const SELECT_POSITION = `
if (abs(aPart.x - aKind) > 0.5) transformed = vec3(0.0);`;

const SCARF_DECL = `
attribute vec2 aScarf;
vec3 abScarfAcross;
vec3 abScarfCentre() {
  float s = aScarf.x;
  float wave = aGlow.w - s * 7.0;
  float amp = pow(s, 1.3);
  float twist = 0.7 * amp * sin(wave + 0.8);
  float hw = 0.06 - 0.025 * s;
  abScarfAcross = vec3(cos(twist) * hw, sin(twist) * hw, 0.0);
  return vec3(
    ${SCARF_ROOT.x.toFixed(5)} + 0.12 * amp * sin(wave),
    ${SCARF_ROOT.y.toFixed(5)} - 0.07 * s + 0.045 * amp * sin(wave * 1.3 + 1.0),
    ${SCARF_ROOT.z.toFixed(5)} - s * ${SCARF_LENGTH.toFixed(5)});
}`;
const SCARF_NORMAL = `
vec3 abScarfC = abScarfCentre();
objectNormal = normalize(cross(abScarfAcross, vec3(0.0, 0.0, -1.0)));`;
const SCARF_POSITION = `
transformed = abScarfC + aScarf.y * abScarfAcross;`;

function patchVariant(
  shader: THREE.WebGLProgramParametersWithUniforms,
  v: Variant,
  hinges: THREE.Matrix4[],
): void {
  if (v.hero) {
    shader.fragmentShader = patchHeroFragment(
      shader.fragmentShader,
      v.exhaust === true,
    );
  }
  if (v.damage) {
    patchDamage(shader);
    // Per instance, not per plane: the uniform becomes a flat varying (an
    // interpolated constant is not bit-exact — concepts/traps), and the hole
    // mode rides in the packed aPart.w.
    shader.fragmentShader = shader.fragmentShader.replace(
      "uniform float uAbDamage;",
      "flat varying float vAbDamage;\n#define uAbDamage vAbDamage",
    );
    shader.vertexShader = shader.vertexShader.replace(
      "attribute float aHole;",
      "#define aHole aPart.w",
    );
  }
  // Per instance: aGlow = the glow (rgb) and one scalar (w) — the damage,
  // the blur's opacity or the scarf's phase, by draw. Per vertex: aPart
  // (see part()). Packed: a GPU need only offer 16 attributes.
  const packed = v.hinge || v.damage || v.livery || v.exhaust || v.select;
  let vDecl = `attribute vec4 aGlow;\nflat varying vec3 vAbGlow;${packed ? "\nattribute vec4 aPart;" : ""}`;
  let vNormal = "";
  let vPosition = "";
  let vBody = "vAbGlow = aGlow.rgb;";
  let fDecl = "flat varying vec3 vAbGlow;";
  if (v.damage) {
    vDecl += "\nflat varying float vAbDamage;";
    vBody += "\nvAbDamage = aGlow.w;";
  }
  if (v.hinge) {
    vDecl += HINGE_DECL;
    vNormal += HINGE_NORMAL;
    vPosition += HINGE_POSITION;
    shader.uniforms.uAbHinge = { value: hinges };
  }
  if (v.scarf) {
    vDecl += SCARF_DECL;
    vNormal += SCARF_NORMAL;
    vPosition += SCARF_POSITION;
  }
  if (v.bombs) {
    vDecl += BOMBS_DECL;
    vPosition += BOMBS_POSITION;
  }
  if (v.select) {
    vDecl += SELECT_DECL;
    vPosition += SELECT_POSITION;
  }
  if (v.detail !== undefined) {
    vDecl += DETAIL_VERTEX_DECL;
    vNormal += DETAIL_VERTEX_BODY;
    fDecl += DETAIL_FRAGMENT_DECL;
    shader.uniforms.uAbDecal = { value: v.detail };
  }
  if (v.livery) {
    vDecl += "\nattribute vec3 aLiveryA;\nattribute vec3 aLiveryB;";
  }
  if (v.rm) {
    vDecl += "\nattribute vec2 aRM;\nvarying vec2 vAbRM;";
    vBody += "\nvAbRM = aRM;";
    fDecl += "\nvarying vec2 vAbRM;";
  }
  if (v.exhaust) {
    vDecl += "\nvarying float vAbExhaust;";
    vBody += "\nvAbExhaust = aPart.z;";
    fDecl += "\nvarying float vAbExhaust;";
  }
  if (v.alpha) {
    vDecl += "\nflat varying float vAbAlpha;";
    vBody += "\nvAbAlpha = aGlow.w;";
    fDecl += "\nflat varying float vAbAlpha;";
  }
  let vs = shader.vertexShader
    .replace("#include <common>", `#include <common>\n${vDecl}`)
    .replace(
      "#include <beginnormal_vertex>",
      `#include <beginnormal_vertex>\n${vNormal}`,
    )
    .replace(
      "#include <begin_vertex>",
      `#include <begin_vertex>\n${vPosition}\n${vBody}`,
    );
  if (v.livery) {
    vs = vs.replace(
      "#include <color_vertex>",
      // Slot 2 (DT1): colours baked, no livery (the fighter in the LOD draw).
      "#include <color_vertex>\nvColor.xyz *= aPart.y > 1.5 ? vec3(1.0) : mix(aLiveryA, aLiveryB, aPart.y);",
    );
  }
  shader.vertexShader = vs;
  let fs = shader.fragmentShader
    .replace("#include <common>", `#include <common>\n${fDecl}`)
    .replace(
      "#include <emissivemap_fragment>",
      "#include <emissivemap_fragment>\ntotalEmissiveRadiance += vAbGlow;",
    );
  if (v.rm) {
    fs = fs
      .replace(
        "#include <roughnessmap_fragment>",
        "#include <roughnessmap_fragment>\nroughnessFactor = vAbRM.x;",
      )
      .replace(
        "#include <metalnessmap_fragment>",
        "#include <metalnessmap_fragment>\nmetalnessFactor = vAbRM.y;",
      );
  }
  if (v.exhaust) {
    fs = fs.replace(
      "abLit + totalEmissiveRadiance + abExhaust;",
      "abLit + totalEmissiveRadiance + abExhaust * vAbExhaust;",
    );
  }
  if (v.alpha) {
    fs = fs.replace(
      "#include <color_fragment>",
      "#include <color_fragment>\ndiffuseColor.a *= vAbAlpha;",
    );
  }
  if (v.detail !== undefined) {
    // After the albedo, before the damage terms (the first include is the
    // one the damage patch kept): scorch and holes paint over the paint.
    fs = fs.replace(
      "#include <color_fragment>",
      `#include <color_fragment>\n${DETAIL_FRAGMENT_BODY}`,
    );
  }
  shader.fragmentShader = fs;
}

/** A fleet material: `base`'s parameters, the variant's patches. */
function fleetMaterial(
  base: THREE.MeshStandardMaterial,
  v: Variant,
  hinges: THREE.Matrix4[],
  over: THREE.MeshStandardMaterialParameters = {},
): THREE.MeshStandardMaterial {
  const m = base.clone();
  m.setValues(over);
  m.customProgramCacheKey = () => `ab-fleet-${v.key}`;
  m.onBeforeCompile = (shader) => patchVariant(shader, v, hinges);
  return m;
}

// --- The fleet --------------------------------------------------------------

/** The instanced attributes one draw carries. */
interface Draw {
  mesh: THREE.InstancedMesh;
  /** rgb: the glow; w: the damage (or, by draw, the blur's opacity or the
   * scarf's phase — written after `put`). */
  glow: THREE.InstancedBufferAttribute;
  deflect?: THREE.InstancedBufferAttribute;
  liveryA?: THREE.InstancedBufferAttribute;
  liveryB?: THREE.InstancedBufferAttribute;
  /** DT1: the frame (LOD / glass) and the rack mask (enemy). */
  kind?: THREE.InstancedBufferAttribute;
  bombs?: THREE.InstancedBufferAttribute;
  /** Instances written this frame. */
  n: number;
}

interface Entry {
  group: THREE.Object3D;
  r: number;
  g: number;
  b: number;
}

/** A plane's glow this frame, linear RGB (shimmer / reveal × intensity). */
export interface Glow {
  r: number;
  g: number;
  b: number;
}
const NO_GLOW: Glow = { r: 0, g: 0, b: 0 };

const scratchColor = new THREE.Color();

export class PlaneFleet {
  readonly group = new THREE.Group();
  private readonly draws: Draw[] = [];
  private readonly livery: Draw;
  private readonly misc: Draw;
  private readonly rudder: Draw;
  private readonly glass: Draw;
  private readonly blur: Draw;
  private readonly scarf: Draw;
  private readonly farLivery: Draw;
  private readonly farMisc: Draw;
  /** DT1: the enemy's near airframe, and the shared mid / far LOD frames. */
  private readonly enemy: Draw;
  private readonly lod: Draw;
  private readonly entries: Entry[] = [];
  private count = 0;
  /** Mobile draws neither the glass nor the scarf (quality.ts, P4). */
  private fineParts = true;
  private warming = false;
  /** QA (__ab.fleet): planes drawn last frame, by LOD level and kind. */
  readonly stats = { planes: 0, near: 0, mid: 0, far: 0, enemies: 0 };

  constructor() {
    const { shared: s, materials: M, propZ } = biplaneSources();
    const F = fighterGeometry();
    const hinges: THREE.Matrix4[] = [];
    for (let i = 0; i < HINGES; i++) hinges.push(new THREE.Matrix4());
    hinges[HINGE_AILERON_L] = pivotMatrix(s.pivots.aileronL);
    hinges[HINGE_AILERON_R] = pivotMatrix(s.pivots.aileronR);
    hinges[HINGE_ELEVATOR] = pivotMatrix(s.pivots.elevator);
    hinges[HINGE_RUDDER] = pivotMatrix(s.pivots.rudder);
    hinges[HINGE_PROP] = new THREE.Matrix4().makeTranslation(0, 0, propZ);
    const st = (k: keyof BiplaneMaterials) => M[k];
    const stat = (k: string) => {
      const g = s.statics.get(k as never);
      if (!g) throw new Error(`fleet: the airframe has no ${k} group`);
      return g;
    };
    const rm = (k: keyof BiplaneMaterials) => ({
      roughness: st(k).roughness,
      metalness: st(k).metalness,
    });
    const lin = (k: keyof BiplaneMaterials) =>
      new THREE.Color().copy(st(k).color);

    const liveryGeo = merged([
      { geometry: stat("body"), hinge: 0, slot: 0, ...rm("body") },
      { geometry: stat("trim"), hinge: 0, slot: 1, ...rm("trim") },
      {
        geometry: s.aileronL,
        hinge: HINGE_AILERON_L,
        slot: 0,
        ...rm("body"),
      },
      {
        geometry: s.aileronR,
        hinge: HINGE_AILERON_R,
        slot: 0,
        ...rm("body"),
      },
      { geometry: s.elevator, hinge: HINGE_ELEVATOR, slot: 0, ...rm("body") },
    ]);
    const miscGeo = merged([
      {
        geometry: stat("metal"),
        hinge: 0,
        ...rm("metal"),
        tint: lin("metal"),
      },
      {
        geometry: s.blades,
        hinge: HINGE_PROP,
        ...rm("metal"),
        tint: lin("metal"),
      },
      { geometry: stat("dark"), hinge: 0, ...rm("dark"), tint: lin("dark") },
      {
        geometry: stat("engine"),
        hinge: 0,
        ...rm("engine"),
        tint: lin("engine"),
        exhaust: 1,
      },
      {
        geometry: stat("cream"),
        hinge: 0,
        ...rm("cream"),
        tint: lin("cream"),
      },
      {
        geometry: stat("leather"),
        hinge: 0,
        ...rm("leather"),
        tint: lin("leather"),
      },
    ]);
    const rudderGeo = merged([
      { geometry: s.rudder, hinge: HINGE_RUDDER, ...rm("rudder") },
    ]);
    const farLiveryGeo = merged([
      { geometry: s.impostorBody, hinge: 0, slot: 0, ...rm("body") },
    ]);
    const farMiscGeo = merged([
      {
        geometry: s.impostorDark,
        hinge: 0,
        ...rm("dark"),
        tint: lin("dark"),
      },
    ]);
    // DT1: the fighter's near airframe — hinge ids as the biplane's, the
    // bombs keep their own ids (≥ BOMB_ID_BASE).
    const enemyGeo = merged([
      withPart(F.statics, 0),
      withPart(F.aileronL, HINGE_AILERON_L),
      withPart(F.aileronR, HINGE_AILERON_R),
      withPart(F.elevator, HINGE_ELEVATOR),
      withPart(F.rudder, HINGE_RUDDER),
      withPart(F.blades, HINGE_PROP),
      withPart(F.bombs, null),
    ]);
    const fighterHinges: THREE.Matrix4[] = [];
    for (let i = 0; i < HINGES; i++) fighterHinges.push(new THREE.Matrix4());
    fighterHinges[HINGE_AILERON_L] = pivotMatrix(F.pivots.aileronL);
    fighterHinges[HINGE_AILERON_R] = pivotMatrix(F.pivots.aileronR);
    fighterHinges[HINGE_ELEVATOR] = pivotMatrix(F.pivots.elevator);
    fighterHinges[HINGE_RUDDER] = pivotMatrix(F.pivots.rudder);
    fighterHinges[HINGE_PROP] = new THREE.Matrix4().makeTranslation(
      0,
      0,
      FIGHTER_PROP_Z,
    );
    // The LOD frames: the biplane's mid level (livery slots like the near
    // draw, the misc groups baked), the fighter's mid and far.
    const mid = (k: string) => {
      const g = s.mid.get(k as never);
      if (!g) throw new Error(`fleet: the mid airframe has no ${k} group`);
      return g;
    };
    const midMisc = (k: "metal" | "dark" | "engine" | "cream" | "leather") =>
      s.mid.has(k)
        ? [
            {
              geometry: mid(k),
              hinge: FRAME_BIPLANE_MID,
              slot: SLOT_BAKED,
              ...rm(k),
              tint: lin(k),
              exhaust: k === "engine" ? 1 : 0,
            },
          ]
        : [];
    const lodGeo = merged([
      {
        geometry: mid("body"),
        hinge: FRAME_BIPLANE_MID,
        slot: 0,
        ...rm("body"),
      },
      {
        geometry: mid("trim"),
        hinge: FRAME_BIPLANE_MID,
        slot: 1,
        ...rm("trim"),
      },
      ...midMisc("metal"),
      ...midMisc("dark"),
      ...midMisc("engine"),
      ...midMisc("cream"),
      ...midMisc("leather"),
      withPart(F.mid, FRAME_FIGHTER_MID, SLOT_BAKED),
      withPart(F.far, FRAME_FIGHTER_FAR, SLOT_BAKED),
    ]);
    const glassGeo = merged([
      {
        geometry: stat("glass"),
        hinge: FRAME_BIPLANE_GLASS,
        ...rm("glass"),
      },
      withPart(F.glass, FRAME_FIGHTER_GLASS),
    ]);

    const white = { color: 0xffffff, vertexColors: true };
    const liveryMat = fleetMaterial(
      M.body,
      {
        key: "livery",
        hero: true,
        damage: true,
        hinge: true,
        livery: true,
        rm: true,
      },
      hinges,
      white,
    );
    const miscMat = fleetMaterial(
      M.metal,
      { key: "misc", hero: true, exhaust: true, hinge: true, rm: true },
      hinges,
      white,
    );
    const B = CAPACITY_BIPLANE;
    this.livery = this.draw(liveryGeo, liveryMat, B, {
      deflect: true,
      livery: true,
    });
    this.misc = this.draw(miscGeo, miscMat, B, { deflect: true });
    this.rudder = this.draw(
      rudderGeo,
      fleetMaterial(
        M.rudder,
        { key: "rudder", hero: true, damage: true, hinge: true, rm: true },
        hinges,
      ),
      B,
      { deflect: true },
    );
    this.glass = this.draw(
      glassGeo,
      fleetMaterial(M.glass, { key: "glass", select: true }, hinges, {
        depthWrite: false,
      }),
      CAPACITY_ALL,
      { kind: true },
    );
    this.blur = this.draw(
      s.blurDisc,
      fleetMaterial(M.blur, { key: "blur", alpha: true }, hinges, {
        opacity: 1,
      }),
      CAPACITY_ALL,
      {},
    );
    this.scarf = this.draw(
      scarfGeometry(),
      fleetMaterial(M.scarf, { key: "scarf", hero: true, scarf: true }, hinges),
      B,
      {},
    );
    // The impostor shares the near draws' programs (same variant keys).
    this.farLivery = this.draw(farLiveryGeo, liveryMat, B, {
      deflect: true,
      livery: true,
    });
    this.farMisc = this.draw(farMiscGeo, miscMat, B, { deflect: true });
    this.enemy = this.draw(
      enemyGeo,
      fleetMaterial(
        M.metal,
        {
          key: "enemy",
          hero: true,
          exhaust: true,
          damage: true,
          hinge: true,
          rm: true,
          bombs: true,
          detail: fighterDecals(),
        },
        fighterHinges,
        white,
      ),
      CAPACITY_ENEMY,
      { deflect: true, bombs: true },
    );
    this.lod = this.draw(
      lodGeo,
      fleetMaterial(
        M.body,
        {
          key: "lod",
          hero: true,
          exhaust: true,
          damage: true,
          livery: true,
          rm: true,
          select: true,
        },
        hinges,
        white,
      ),
      CAPACITY_ALL,
      { livery: true, kind: true },
    );
    for (const m of Object.values(M)) {
      if (m instanceof THREE.Material) m.dispose();
    }
  }

  /** One instanced draw over its own geometry (sharing the source's
   * attribute buffers) with the attributes it needs. */
  private draw(
    source: THREE.BufferGeometry,
    material: THREE.Material,
    capacity: number,
    want: {
      deflect?: boolean;
      livery?: boolean;
      kind?: boolean;
      bombs?: boolean;
    },
  ): Draw {
    const geometry = new THREE.BufferGeometry();
    for (const [name, a] of Object.entries(source.attributes)) {
      geometry.setAttribute(name, a);
    }
    if (source.index) geometry.setIndex(source.index);
    const mesh = new THREE.InstancedMesh(geometry, material, capacity);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    mesh.frustumCulled = false;
    const attr = (name: string, size: number) => {
      const a = new THREE.InstancedBufferAttribute(
        new Float32Array(capacity * size),
        size,
      );
      a.setUsage(THREE.DynamicDrawUsage);
      geometry.setAttribute(name, a);
      return a;
    };
    const d: Draw = { mesh, glow: attr("aGlow", 4), n: 0 };
    if (want.deflect) d.deflect = attr("aDeflect", 4);
    if (want.livery) {
      d.liveryA = attr("aLiveryA", 3);
      d.liveryB = attr("aLiveryB", 3);
    }
    if (want.kind) d.kind = attr("aKind", 1);
    if (want.bombs) d.bombs = attr("aBombs", 1);
    this.draws.push(d);
    this.group.add(mesh);
    return d;
  }

  /** Quality row (`planeFleet`): Mobile leaves out the glass and scarf. */
  setQuality(tier: QualityTier): void {
    this.fineParts = tier !== "mobile";
  }

  /**
   * Take a plane over: its meshes leave every camera layer (the fleet draws
   * it from now on). Its Group, LOD and rig keep working as before.
   */
  adopt(plane: THREE.Object3D): void {
    const rig = planeRig(plane);
    if (!rig) throw new Error("fleet: not a plane");
    rig.cpuScarf = false;
    plane.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) o.layers.disableAll();
    });
  }

  /** Start a frame's list of planes. */
  begin(): void {
    this.count = 0;
  }

  /** Draw `plane` this frame (if it and its parents are visible), glowing
   * by `glow` — the linear emissive its materials used to be tinted with.
   * An object, not three numbers: a double handed to a call V8 does not
   * inline is boxed (P4's allocation table). */
  add(plane: THREE.Object3D, glow: Glow = NO_GLOW): void {
    if (this.count >= this.entries.length) {
      this.entries.push({ group: plane, r: glow.r, g: glow.g, b: glow.b });
    } else {
      const e = this.entries[this.count] as Entry;
      e.group = plane;
      e.r = glow.r;
      e.g = glow.g;
      e.b = glow.b;
    }
    this.count++;
  }

  /** P4 pre-warm: one parked instance in every draw, so the boot compile
   * and the warm frame build every program and pipeline (a fleet with no
   * instance issues no draw). Off again before the first real frame. */
  warm(on: boolean): void {
    this.warming = on;
    for (const d of this.draws) {
      d.mesh.count = on ? 1 : 0;
      if (on) {
        scratchMatrix.makeTranslation(0, -9999, 0);
        d.mesh.setMatrixAt(0, scratchMatrix);
        d.mesh.instanceMatrix.needsUpdate = true;
        d.glow.setW(0, 1);
      }
    }
  }

  /**
   * Write every plane added this frame into the draws. Call once the camera
   * is final for the frame (the LOD level depends on it): each plane's
   * matrices are refreshed here, so nothing is drawn a frame late.
   */
  commit(camera: THREE.Camera): void {
    if (this.warming) return;
    camera.updateMatrixWorld();
    for (const d of this.draws) d.n = 0;
    let near = 0;
    let mid = 0;
    let far = 0;
    let biplanes = 0;
    let enemies = 0;
    for (let i = 0; i < this.count; i++) {
      const e = this.entries[i] as Entry;
      const rig = planeRig(e.group);
      if (!rig || !shown(e.group)) continue;
      const enemy = rig.kind === "fighter";
      if (enemy ? enemies >= CAPACITY_ENEMY : biplanes >= CAPACITY_BIPLANE) {
        continue;
      }
      if (enemy) enemies++;
      else biplanes++;
      e.group.updateMatrixWorld(true);
      rig.lod.update(camera);
      const prim = scratchColor.setHex(rig.livery.primary);
      const pr = prim.r;
      const pg = prim.g;
      const pb = prim.b;
      const sec = scratchColor.setHex(rig.livery.secondary);
      const damage = rig.damage.value;
      const ail = rig.parts.aileronL.rotation.x;
      const elev = rig.parts.elevator.rotation.x;
      const rud = rig.parts.rudder.rotation.y;
      const prop = rig.prop.rotation.z % TWO_PI;
      // Every LOD level hangs on the same transform.
      const m = rig.near.matrixWorld;
      const level = rig.lod.getCurrentLevel();
      if (level === 0) {
        near++;
        if (enemy) {
          const k = this.put(this.enemy, m, e, damage, ail, elev, rud, prop);
          this.enemy.bombs?.setX(k, rig.bombs);
        } else {
          this.put(this.livery, m, e, damage, ail, elev, rud, prop);
          setLivery(this.livery, pr, pg, pb, sec);
          this.put(this.misc, m, e, damage, ail, elev, rud, prop);
          this.put(this.rudder, m, e, damage, ail, elev, rud, prop);
        }
        if (this.fineParts) {
          const g = this.put(this.glass, m, e, damage, ail, elev, rud, prop);
          this.glass.kind?.setX(
            g,
            enemy ? FRAME_FIGHTER_GLASS : FRAME_BIPLANE_GLASS,
          );
          if (!enemy) {
            const sc = this.put(this.scarf, m, e, damage, ail, elev, rud, prop);
            this.scarf.glow.setW(sc, rig.phase % SCARF_PHASE_WRAP);
          }
        }
      } else if (level === 1 || enemy) {
        if (level === 1) mid++;
        else far++;
        const k = this.put(this.lod, m, e, damage, 0, 0, 0, 0);
        setLivery(this.lod, pr, pg, pb, sec);
        this.lod.kind?.setX(
          k,
          !enemy
            ? FRAME_BIPLANE_MID
            : level === 1
              ? FRAME_FIGHTER_MID
              : FRAME_FIGHTER_FAR,
        );
      } else {
        far++;
        this.put(this.farLivery, m, e, damage, 0, 0, 0, 0);
        setLivery(this.farLivery, pr, pg, pb, sec);
        this.put(this.farMisc, m, e, damage, 0, 0, 0, 0);
      }
      // The prop disc, near and mid (beyond, it is under a pixel or two).
      const blur = rig.parts.blur;
      if (level < 2 && blur.visible) {
        const k = this.put(
          this.blur,
          blur.matrixWorld,
          e,
          damage,
          ail,
          elev,
          rud,
          prop,
        );
        this.blur.glow.setW(k, rig.parts.blurMaterial.opacity);
      }
    }
    for (const d of this.draws) {
      d.mesh.count = d.n;
      if (d.n === 0) continue;
      d.mesh.instanceMatrix.needsUpdate = true;
      d.glow.needsUpdate = true;
      if (d.deflect) d.deflect.needsUpdate = true;
      if (d.liveryA) d.liveryA.needsUpdate = true;
      if (d.liveryB) d.liveryB.needsUpdate = true;
      if (d.kind) d.kind.needsUpdate = true;
      if (d.bombs) d.bombs.needsUpdate = true;
    }
    this.stats.planes = near + mid + far;
    this.stats.near = near;
    this.stats.mid = mid;
    this.stats.far = far;
    this.stats.enemies = enemies;
  }

  /**
   * QA (DT1): each fleet program's ACTIVE vertex attributes, as the GPU
   * linked them — every one must stay within the 16 a GPU must offer. A
   * draw not yet compiled reports nothing.
   */
  activeAttributes(renderer: THREE.WebGLRenderer): Record<string, number> {
    const gl = renderer.getContext();
    const out: Record<string, number> = {};
    for (const d of this.draws) {
      const material = d.mesh.material as THREE.Material;
      const props = renderer.properties.get(material) as {
        currentProgram?: { program: WebGLProgram };
      };
      const program = props.currentProgram?.program;
      if (!program) continue;
      const key = material.customProgramCacheKey();
      out[key] = gl.getProgramParameter(
        program,
        gl.ACTIVE_ATTRIBUTES,
      ) as number;
    }
    return out;
  }

  /** Draws issued last frame (QA): one per non-empty instanced mesh. */
  get drawCount(): number {
    let n = 0;
    for (const d of this.draws) if (d.mesh.count > 0) n++;
    return n;
  }

  /** One instance of `d`: matrix, glow, deflections, damage. */
  private put(
    d: Draw,
    m: THREE.Matrix4,
    e: Entry,
    damage: number,
    ail: number,
    elev: number,
    rud: number,
    prop: number,
  ): number {
    const k = d.n++;
    d.mesh.setMatrixAt(k, m);
    d.glow.setXYZW(k, e.r, e.g, e.b, damage);
    d.deflect?.setXYZW(k, ail, elev, rud, prop);
    return k;
  }
}

const scratchMatrix = new THREE.Matrix4();

/** The primary (already in r, g, b) and secondary livery of the last
 * instance written to `d`. */
function setLivery(
  d: Draw,
  r: number,
  g: number,
  b: number,
  sec: THREE.Color,
): void {
  const k = d.n - 1;
  d.liveryA?.setXYZ(k, r, g, b);
  d.liveryB?.setXYZ(k, sec.r, sec.g, sec.b);
}

/** Is `o` drawn: it and every parent visible. */
function shown(o: THREE.Object3D): boolean {
  for (let p: THREE.Object3D | null = o; p !== null; p = p.parent) {
    if (!p.visible) return false;
  }
  return true;
}
