// D1 facade damage — a shader-side damage map, not geometry. Bullet holes,
// shattered panes and scorch accumulate per WINDOW CELL of a tier's facade
// face, and the building shader reads them back from one small atlas texture
// (buildings-material.ts / window-pattern.ts damageGlsl).
//
// Seam rule: every record is keyed by the building's INDEX in generateCity's
// array (identical on every client), its tier, its face and the facade-local
// window cell — never a translation, so a facade damaged on one side of the
// torus seam reads the same from the other.
//
// Bounded: the atlas is a fixed grid of FACE slots (DAMAGE.slotsX ×
// DAMAGE.slotsY), each DAMAGE.cols × DAMAGE.rows cells of RG8 (R = shattered
// pane bit + bullet-hole count, G = scorch). A face takes a slot the first
// time it is marked; when the slots in use reach the quality tier's cap the
// least recently hit face is evicted (its cells zeroed — it visibly heals,
// which is why the cap is generous on every tier). Memory never grows.
//
// The pure model (FacadeDamage, blastFacades) is the tested seam; the THREE
// half (DamageTexture) uploads only the DIRTY slots each frame, as
// sub-rectangles (renderer.copyTextureToTexture → texSubImage2D).

import type { Building } from "@angels-bandits/common/city";
import {
  type CityIndex,
  forEachBuildingNear,
} from "@angels-bandits/common/collision";
import { type Vec3, wrapCoord } from "@angels-bandits/common/world";
import * as THREE from "three";
import { FacadeFace, tierBase, tierPitch } from "../game/bullet-impact";

/** Atlas layout. 64 cells cover a 160 m facade at the tightest jittered
 * pitch (≈ 2.7 m), 96 rows a 238 m tier at ≈ 2.6 m floors. */
export const DAMAGE = {
  cols: 64,
  rows: 96,
  /** A cell's signed run index (from the tier centre) + this = its column. */
  colOffset: 32,
  slotsX: 8,
  slotsY: 6,
} as const;
/** Face slots the atlas holds (also the packed word's 6-bit ceiling, 63). */
export const MAX_FACE_SLOTS = DAMAGE.slotsX * DAMAGE.slotsY;
export const ATLAS_WIDTH = DAMAGE.slotsX * DAMAGE.cols;
export const ATLAS_HEIGHT = DAMAGE.slotsY * DAMAGE.rows;
/** Bytes per texel (RG8). */
const TEXEL = 2;

/** R channel: the shattered-pane bit, and the bullet-hole count below it. */
export const SHATTERED = 0x80;
export const HOLE_MASK = 0x03;
/** Most bullet holes one cell shows. */
export const MAX_HOLES = 3;

/** One face's key: building index, tier, face — ids only (seam rule). */
export const faceKey = (building: number, tier: number, face: number): number =>
  (building * 8 + tier) * 4 + face;
/** One tier's key (the packed slot word is per tier). */
export const tierKey = (building: number, tier: number): number =>
  building * 8 + tier;

/** Face slots the tier uses at quality share `share` (1 = High … 0.25 =
 * Mobile): 48 / 40 / 32 / 24. */
export const faceSlotsFor = (share: number): number =>
  Math.min(MAX_FACE_SLOTS, Math.round(16 + 32 * share));

export class FacadeDamage {
  /** The CPU atlas, RG8, row-major ATLAS_WIDTH × ATLAS_HEIGHT. */
  readonly data: Uint8Array<ArrayBuffer> = new Uint8Array(
    ATLAS_WIDTH * ATLAS_HEIGHT * TEXEL,
  );
  /** Face key per slot (-1 = free). */
  private readonly slotFace = new Int32Array(MAX_FACE_SLOTS).fill(-1);
  /** Last-hit stamp per slot (LRU). */
  private readonly slotStamp = new Float64Array(MAX_FACE_SLOTS);
  private readonly faceSlot = new Map<number, number>();
  /** D9: a face's slot generation (bumped each time it is given a slot;
   * gone when it is evicted) — how D9's scar keeper sees an eviction. */
  private readonly epochs = new Map<number, number>();
  private epochGen = 0;
  private stamp = 0;
  private cap = MAX_FACE_SLOTS;
  private readonly dirtySlots = new Set<number>();
  private readonly dirtyTiers = new Set<number>();

  /** Face slots in use. */
  get slotsUsed(): number {
    return this.faceSlot.size;
  }

  get slotCap(): number {
    return this.cap;
  }

  /** Quality: how many face slots may be in use. Shrinking evicts. */
  setSlotCap(cap: number): void {
    this.cap = Math.max(1, Math.min(MAX_FACE_SLOTS, Math.floor(cap)));
    for (let s = this.cap; s < MAX_FACE_SLOTS; s++) this.evict(s);
  }

  /** D9: the face's slot generation, 0 while it holds no slot. */
  faceEpoch(building: number, tier: number, face: number): number {
    return this.epochs.get(faceKey(building, tier, face)) ?? 0;
  }

  /** The slot a face's records live in, or -1 (never marked / evicted). */
  slotOf(building: number, tier: number, face: number): number {
    return this.faceSlot.get(faceKey(building, tier, face)) ?? -1;
  }

  /**
   * The packed per-tier slot word the shader decodes: face f's (slot + 1) in
   * bits [6f, 6f + 6), 0 = undamaged. 24 bits — exact in a float32.
   */
  packedWord(building: number, tier: number): number {
    let word = 0;
    for (let f = 0; f < 4; f++) {
      const s = this.slotOf(building, tier, f);
      if (s >= 0) word += (s + 1) * 2 ** (6 * f);
    }
    return word;
  }

  /** Cell (x signed from the tier centre, y from the tier base) → byte
   * offset of its R texel in `data`, creating the face's slot; -1 when the
   * cell falls outside the slot's grid. */
  private cell(
    building: number,
    tier: number,
    face: number,
    cx: number,
    cy: number,
  ): number {
    const col = cx + DAMAGE.colOffset;
    if (col < 0 || col >= DAMAGE.cols || cy < 0 || cy >= DAMAGE.rows) {
      return -1;
    }
    const slot = this.acquire(building, tier, face);
    this.dirtySlots.add(slot);
    const x = (slot % DAMAGE.slotsX) * DAMAGE.cols + col;
    const y = Math.floor(slot / DAMAGE.slotsX) * DAMAGE.rows + cy;
    return (y * ATLAS_WIDTH + x) * TEXEL;
  }

  private acquire(building: number, tier: number, face: number): number {
    const key = faceKey(building, tier, face);
    const stamp = ++this.stamp;
    const have = this.faceSlot.get(key);
    if (have !== undefined) {
      this.slotStamp[have] = stamp;
      return have;
    }
    let slot = -1;
    let oldest = Number.POSITIVE_INFINITY;
    for (let s = 0; s < this.cap; s++) {
      if (this.slotFace[s] === -1) {
        slot = s;
        break;
      }
      const at = this.slotStamp[s] as number;
      if (at < oldest) {
        oldest = at;
        slot = s;
      }
    }
    this.evict(slot);
    this.slotFace[slot] = key;
    this.slotStamp[slot] = stamp;
    this.faceSlot.set(key, slot);
    this.epochs.set(key, ++this.epochGen);
    this.dirtyTiers.add(tierKey(building, tier));
    return slot;
  }

  /** Free a slot: zero its cells, forget its face, re-pack its tier. */
  private evict(slot: number): void {
    const key = this.slotFace[slot] as number;
    if (key === -1) return;
    this.faceSlot.delete(key);
    this.epochs.delete(key);
    this.slotFace[slot] = -1;
    this.dirtyTiers.add(Math.floor(key / 4));
    const x0 = (slot % DAMAGE.slotsX) * DAMAGE.cols;
    const y0 = Math.floor(slot / DAMAGE.slotsX) * DAMAGE.rows;
    for (let y = 0; y < DAMAGE.rows; y++) {
      const o = ((y0 + y) * ATLAS_WIDTH + x0) * TEXEL;
      this.data.fill(0, o, o + DAMAGE.cols * TEXEL);
    }
    this.dirtySlots.add(slot);
  }

  /** D5 rebuild: `building` is whole again — every mark on it (shattered
   * panes, bullet holes, scorch) goes with the damage. (faceKey's building
   * prefix: 8 tiers × 4 faces.) */
  clearBuilding(building: number): void {
    for (let s = 0; s < MAX_FACE_SLOTS; s++) {
      const key = this.slotFace[s] as number;
      if (key !== -1 && Math.floor(key / 32) === building) {
        this.evict(s);
      }
    }
  }

  /** A pane shatters (it goes dark for good). False when off-grid. */
  shatter(
    building: number,
    tier: number,
    face: number,
    cx: number,
    cy: number,
  ): boolean {
    const o = this.cell(building, tier, face, cx, cy);
    if (o < 0) return false;
    this.data[o] = (this.data[o] as number) | SHATTERED;
    return true;
  }

  /** A bullet hole in the wall (up to MAX_HOLES per cell). */
  bulletHole(
    building: number,
    tier: number,
    face: number,
    cx: number,
    cy: number,
  ): boolean {
    const o = this.cell(building, tier, face, cx, cy);
    if (o < 0) return false;
    const r = this.data[o] as number;
    const holes = Math.min(MAX_HOLES, (r & HOLE_MASK) + 1);
    this.data[o] = (r & ~HOLE_MASK) | holes;
    return true;
  }

  /** Add scorch (0..255, saturating). */
  scorch(
    building: number,
    tier: number,
    face: number,
    cx: number,
    cy: number,
    amount: number,
  ): boolean {
    const o = this.cell(building, tier, face, cx, cy);
    if (o < 0) return false;
    const g = (this.data[o + 1] as number) + Math.round(amount);
    this.data[o + 1] = Math.max(0, Math.min(255, g));
    return true;
  }

  /** Read one cell back (tests, QA): {shattered, holes, scorch}. */
  read(
    building: number,
    tier: number,
    face: number,
    cx: number,
    cy: number,
  ): { shattered: boolean; holes: number; scorch: number } {
    const slot = this.slotOf(building, tier, face);
    const col = cx + DAMAGE.colOffset;
    if (
      slot < 0 ||
      col < 0 ||
      col >= DAMAGE.cols ||
      cy < 0 ||
      cy >= DAMAGE.rows
    ) {
      return { shattered: false, holes: 0, scorch: 0 };
    }
    const x = (slot % DAMAGE.slotsX) * DAMAGE.cols + col;
    const y = Math.floor(slot / DAMAGE.slotsX) * DAMAGE.rows + cy;
    const o = (y * ATLAS_WIDTH + x) * TEXEL;
    const r = this.data[o] as number;
    return {
      shattered: (r & SHATTERED) !== 0,
      holes: r & HOLE_MASK,
      scorch: this.data[o + 1] as number,
    };
  }

  /** Slots whose cells changed since the last call (then forgotten). */
  /** D6: slots marked since the last takeDirtySlots (0 = nothing to do). */
  get dirtySlotCount(): number {
    return this.dirtySlots.size;
  }

  takeDirtySlots(visit: (slot: number) => void): void {
    for (const s of this.dirtySlots) visit(s);
    this.dirtySlots.clear();
  }

  /** Tiers whose packed word changed since the last call (tierKey). */
  takeDirtyTiers(visit: (key: number) => void): void {
    for (const k of this.dirtyTiers) visit(k);
    this.dirtyTiers.clear();
  }
}

/** Blast reach: windows blow out within this, meters. */
export const BLAST_RADIUS = 35;
/** Scorch reaches this far from the blast, meters. */
export const SCORCH_RADIUS = 14;

/** Where a blast's burning patch sits: the nearest facade point. */
export interface BlastSite {
  building: number;
  tier: number;
  face: number;
  /** Canonical point on the facade, and the face's outward normal. */
  point: Vec3;
  normal: Vec3;
  /** Distance from the blast centre, meters. */
  distance: number;
}

const FACE_NORMALS: readonly Vec3[] = [
  { x: 1, y: 0, z: 0 },
  { x: -1, y: 0, z: 0 },
  { x: 0, y: 0, z: 1 },
  { x: 0, y: 0, z: -1 },
];

/**
 * A big impact (a plane death) at canonical `centre`: every outer facade
 * face within BLAST_RADIUS blows out a ring of windows — each pane with
 * probability 1 − d / BLAST_RADIUS, drawn from `rand` in a fixed order (so a
 * seeded stream gives every client the same ring) — and takes radial scorch
 * inside SCORCH_RADIUS. Returns the nearest facade point (the burning
 * patch), or null when no facade is in reach.
 */
export function blastFacades(
  damage: FacadeDamage,
  buildings: readonly Building[],
  index: CityIndex,
  centre: Vec3,
  rand: () => number,
): BlastSite | null {
  let best: BlastSite | null = null;
  const R = BLAST_RADIUS;
  forEachBuildingNear(index, centre, R, (bi, off) => {
    const b = buildings[bi];
    if (!b) return;
    // off = building centre − blast centre; the blast in building frame:
    const bx = -off.x;
    const bz = -off.z;
    for (let tier = 0; tier < b.tiers.length; tier++) {
      const t = b.tiers[tier];
      if (!t) continue;
      const base = tierBase(b, tier);
      const hy = centre.y - base;
      if (hy < -R || hy > t.height + R) continue;
      const [px, py] = tierPitch(b, tier);
      for (let face = 0; face < 4; face++) {
        const alongX = face === FacadeFace.PX || face === FacadeFace.NX;
        const sign = face === FacadeFace.PX || face === FacadeFace.PZ ? 1 : -1;
        const half = alongX ? t.width / 2 : t.depth / 2;
        const runHalf = alongX ? t.depth / 2 : t.width / 2;
        // Signed distance of the blast in front of this face (< 0 = behind).
        const plane = (alongX ? bx : bz) * sign - half;
        if (plane < -2 || plane > R) continue;
        const run = alongX ? bz : bx;
        const near = Math.min(Math.max(run, -runHalf), runHalf);
        const nearH = Math.min(Math.max(hy, 0), t.height);
        const dn = Math.hypot(Math.max(plane, 0), run - near, hy - nearH);
        if (dn > R) continue;
        if (!best || dn < best.distance) {
          const n = FACE_NORMALS[face] as Vec3;
          best = {
            building: bi,
            tier,
            face,
            point: {
              x: wrapCoord(centre.x + (alongX ? sign * half - bx : near - bx)),
              y: base + nearH,
              z: wrapCoord(centre.z + (alongX ? near - bz : sign * half - bz)),
            },
            normal: n,
            distance: dn,
          };
        }
        const c0 = Math.floor(Math.max(run - R, -runHalf) / px);
        const c1 = Math.floor(Math.min(run + R, runHalf) / px);
        const r0 = Math.max(0, Math.floor((hy - R) / py));
        const r1 = Math.floor(Math.min(hy + R, t.height) / py);
        for (let cy = r0; cy <= r1; cy++) {
          for (let cx = c0; cx <= c1; cx++) {
            const du = (cx + 0.5) * px - run;
            const dv = (cy + 0.5) * py - hy;
            const d = Math.hypot(Math.max(plane, 0), du, dv);
            if (d > R) continue;
            if (rand() < 1 - d / R) damage.shatter(bi, tier, face, cx, cy);
            if (d < SCORCH_RADIUS) {
              const k = 1 - d / SCORCH_RADIUS;
              damage.scorch(bi, tier, face, cx, cy, 255 * k * (0.6 + 0.4 * k));
            }
          }
        }
      }
    }
  });
  return best;
}

/**
 * THREE half: the GPU atlas, fed dirty slots as sub-rectangles.
 *
 * D6: straight `texSubImage2D` from the CPU atlas, NOT
 * `renderer.copyTextureToTexture`. three's copy saves and restores five
 * pixel-store parameters with `gl.getParameter` on every call, and each one
 * is a synchronous round trip to the GPU process that waits for every
 * queued command — per dirty slot, i.e. on every frame a bullet marks a
 * facade. The perf harness's `ruins` (a furball in a damaged block) stalled
 * 5–22 s a frame on it on a software rasteriser. Here the pixel store is SET
 * (three sets flip-Y, premultiply and alignment itself before each of its
 * own uploads, and never sets row length or skips, which go back to 0).
 */
export class DamageTexture {
  /** The texture the building shader samples (uDamage). */
  readonly texture: THREE.DataTexture;

  constructor(readonly model: FacadeDamage) {
    this.texture = makeAtlas(new Uint8Array(model.data.length));
    this.texture.needsUpdate = true; // the zeroed atlas, once, at first bind
  }

  /** Upload the slots marked since last frame, each as one sub-rect. */
  flush(renderer: THREE.WebGLRenderer): void {
    if (this.model.dirtySlotCount === 0) return;
    const gl = renderer.getContext() as WebGL2RenderingContext;
    let props = renderer.properties.get(this.texture) as {
      __webglTexture?: WebGLTexture;
    };
    if (!props.__webglTexture) {
      renderer.initTexture(this.texture); // allocates and uploads zeros
      props = renderer.properties.get(this.texture) as typeof props;
    }
    const tex = props.__webglTexture;
    if (!tex) return; // no context: the slots stay dirty for next frame
    renderer.state.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, ATLAS_WIDTH);
    this.gl = gl;
    this.model.takeDirtySlots(this.upload);
    this.gl = null;
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
    renderer.state.unbindTexture();
  }

  private gl: WebGL2RenderingContext | null = null;
  /** One slot's sub-rect, from the CPU atlas (bound once, not per frame). */
  private readonly upload = (slot: number): void => {
    const gl = this.gl;
    if (!gl) return;
    const x = (slot % DAMAGE.slotsX) * DAMAGE.cols;
    const y = Math.floor(slot / DAMAGE.slotsX) * DAMAGE.rows;
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, x);
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, y);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      x,
      y,
      DAMAGE.cols,
      DAMAGE.rows,
      gl.RG,
      gl.UNSIGNED_BYTE,
      this.model.data,
    );
  };
}

function makeAtlas(data: Uint8Array<ArrayBuffer>): THREE.DataTexture {
  const tex = new THREE.DataTexture(
    data,
    ATLAS_WIDTH,
    ATLAS_HEIGHT,
    THREE.RGFormat,
    THREE.UnsignedByteType,
  );
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.unpackAlignment = 1;
  return tex;
}

/** The shader's on/off switch for facade damage, shared by reference. On
 * for every tier (cheaper tiers only get fewer slots); a uniform so QA can
 * A/B it without a recompile. */
export const DAMAGE_ON_UNIFORM = { value: 1 };

/** Fragment declarations: the atlas, the switch, the per-tier slot word. */
export const DAMAGE_PARS_GLSL = /* glsl */ `
uniform highp sampler2D uDamage;
uniform float uDamageOn;
flat varying highp float vDmgWord;
// Smooth value noise (bilinear over abHash lattice values, smoothstep-eased).
float abVNoise(vec2 p) {
  vec2 vnI = floor(p);
  vec2 vnF = p - vnI;
  vnF = vnF * vnF * (3.0 - 2.0 * vnF);
  return mix(
    mix(abHash(vnI, 5.0), abHash(vnI + vec2(1.0, 0.0), 5.0), vnF.x),
    mix(abHash(vnI + vec2(0.0, 1.0), 5.0), abHash(vnI + vec2(1.0, 1.0), 5.0), vnF.x),
    vnF.y);
}
`;

/**
 * Facade damage, spliced right after the window grid (it reads `facade`,
 * `winGrid`, `winPitch`, `winCell`, `winF`, `winPane`, `pane`, `lit`,
 * `winDetail`, `wAA`) and before weathering. A fragment of an OUTER facade
 * face (on its tier's outer extent: a hole's inner walls share the outer
 * face's cells and must not show its marks) decodes its face's slot from
 * the tier word and reads its cell:
 *  - shattered: the pane's light dies and the glass goes dark, a jagged rim
 *    of leftover glass at its edges (pane is zeroed for everything after —
 *    the glow, the sheen and the L1 wake can never relight it);
 *  - bullet holes: up to 3 dark pits with a pale chipped ring at hashed
 *    spots in the cell;
 *  - scorch: a 4-tap bilinear soot blend over cell centres, noisy edge;
 *    heavy scorch also kills the window's light.
 * Per-cell detail fades with winDetail (O1: no distant sparkle). An
 * undamaged tier pays one compare; an undamaged face one integer decode.
 */
export const DAMAGE_GLSL = /* glsl */ `
// --- D1 facade damage ---
float dmgGlass = 0.0;
float dmgHoles = 0.0;
float dmgScorch = 0.0;
if (uDamageOn > 0.5 && facade > 0.0 && vDmgWord > 0.5) {
  uint dmgW = uint(vDmgWord + 0.5);
  bool dmgOnX = abs(vObjNormal.x) > 0.5;
  int dmgFace = dmgOnX ? (vObjNormal.x > 0.0 ? 0 : 1) : (vObjNormal.z > 0.0 ? 2 : 3);
  float dmgEdge = dmgOnX ? abs(vMeters.x) - vHalfXZ.x : abs(vMeters.z) - vHalfXZ.y;
  uint dmgSlot = (dmgW >> uint(6 * dmgFace)) & 63u;
  if (dmgSlot > 0u && dmgEdge > -0.05) {
    int dmgS = int(dmgSlot) - 1;
    ivec2 dmgO = ivec2((dmgS % ${DAMAGE.slotsX}) * ${DAMAGE.cols}, (dmgS / ${DAMAGE.slotsX}) * ${DAMAGE.rows});
    ivec2 dmgC = ivec2(winCell) + ivec2(${DAMAGE.colOffset}, 0);
    if (dmgC.x >= 0 && dmgC.x < ${DAMAGE.cols} && dmgC.y >= 0 && dmgC.y < ${DAMAGE.rows}) {
      float dmgR = floor(texelFetch(uDamage, dmgO + dmgC, 0).r * 255.0 + 0.5);
      dmgGlass = step(127.5, dmgR);
      dmgHoles = mod(dmgR, 4.0);
    }
    vec2 dmgG = winGrid / winPitch - 0.5;
    vec2 dmgG0 = floor(dmgG);
    vec2 dmgGf = dmgG - dmgG0;
    ivec2 dmgB = ivec2(dmgG0) + ivec2(${DAMAGE.colOffset}, 0);
    ivec2 dmgHi = ivec2(${DAMAGE.cols - 1}, ${DAMAGE.rows - 1});
    float dmgS00 = texelFetch(uDamage, dmgO + clamp(dmgB, ivec2(0), dmgHi), 0).g;
    float dmgS10 = texelFetch(uDamage, dmgO + clamp(dmgB + ivec2(1, 0), ivec2(0), dmgHi), 0).g;
    float dmgS01 = texelFetch(uDamage, dmgO + clamp(dmgB + ivec2(0, 1), ivec2(0), dmgHi), 0).g;
    float dmgS11 = texelFetch(uDamage, dmgO + clamp(dmgB + ivec2(1, 1), ivec2(0), dmgHi), 0).g;
    dmgScorch = mix(mix(dmgS00, dmgS10, dmgGf.x), mix(dmgS01, dmgS11, dmgGf.x), dmgGf.y);
    // Charred, not airbrushed: two octaves of smooth value noise (1.6 m and
    // 0.5 m) break the soft edge into licks and blotches.
    float dmgN = 0.65 * abVNoise(winGrid / 1.6) + 0.35 * abVNoise(winGrid / 0.5 + 17.0);
    dmgScorch = smoothstep(0.1, 0.8, dmgScorch * (0.45 + 1.1 * dmgN));
  }
}
if (dmgGlass + dmgHoles + dmgScorch > 0.0) {
  // Shattered pane: a black room behind, a jagged rim of glass left in the
  // frame (meters in from the pane edge vs a per-sliver hash).
  float dmgPane = pane * dmgGlass * winDetail;
  vec2 dmgPd = (winPane * 0.5 - abs(winF - 0.5)) * winPitch;
  float dmgRim = min(dmgPd.x, dmgPd.y);
  float dmgShard = 1.0 - step(0.06 + 0.22 * abHash(floor(winGrid * vec2(7.0, 5.0)), 3.0), dmgRim);
  diffuseColor.rgb *= mix(1.0, mix(0.12, 1.15, dmgShard), dmgPane);
  lit *= 1.0 - dmgGlass * winDetail;
  pane *= 1.0 - dmgGlass * winDetail;
  // Bullet holes: dark pit + pale chipped ring, at hashed spots in the cell.
  vec2 dmgM = winF * winPitch;
  float dmgPit = 0.0;
  float dmgChip = 0.0;
  for (int k = 0; k < 3; k++) {
    if (float(k) >= dmgHoles) break;
    vec2 dmgH = vec2(abHash(winCell, 11.0 + float(k)), abHash(winCell + 5.0, 13.0 + float(k)));
    float dmgD = length(dmgM - (0.15 + 0.7 * dmgH) * winPitch);
    dmgPit = max(dmgPit, 1.0 - smoothstep(0.06, 0.1, dmgD));
    dmgChip = max(dmgChip, (1.0 - smoothstep(0.12, 0.24, dmgD)) * (0.6 + 0.4 * abHash(floor(dmgM * 12.0), 9.0)));
  }
  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 1.6 + 0.04, dmgChip * (1.0 - dmgPit) * winDetail * 0.6);
  diffuseColor.rgb *= 1.0 - 0.85 * dmgPit * winDetail;
  // Scorch: soot over everything, and a burnt-out window is dark.
  diffuseColor.rgb *= 1.0 - 0.88 * dmgScorch;
  lit *= 1.0 - smoothstep(0.55, 0.9, dmgScorch);
}
`;
