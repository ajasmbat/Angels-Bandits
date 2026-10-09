// D5 rebuild dressing: scaffolding and a rebuild crane on every damaged
// building near the camera, so a broken tower visibly is being put back
// together until the server's `rebuild` pops its chunks back in.
//
// Cosmetic, never collidable — so it is kept where no plane can be without
// already hitting something solid (the shared-world rule's limit on
// cosmetic geometry):
//  - scaffolding hugs the street tier's facades, at most SCAFFOLD_OUT out
//    (closer than a plane's own radius can get to a wall), and never on a
//    face with a hole mouth below its top (H1 holes are flown through);
//  - the rebuild crane stands INSIDE the building's footprint, its jib laid
//    over the footprint and its top at most CRANE_ABOVE_ROOF over the
//    generated roof — no jib swinging over the street.
// `scaffoldBoxes` is the one placement (pure; the bounds test reads it).
//
// One InstancedMesh with a per-instance colour; the tier's
// QualityProfile.scaffold says how many buildings are dressed at once (the
// nearest damaged ones), MOBILE included. Rewritten only when the city's
// damage version moves or the camera crosses a block — no per-frame work
// and no per-frame allocation in between.

import { type Building, tierGrids } from "@angels-bandits/common/city";
import { BLOCK_PITCH } from "@angels-bandits/common/constants";
import { type Vec3, wrapDeltaAxis } from "@angels-bandits/common/world";
import * as THREE from "three";
import { QUALITY_PROFILES, type QualityTier } from "./quality";

/** Scaffolding stands this far out from the facade, m (inner and outer
 * faces of the deck). */
export const SCAFFOLD_IN = 0.25;
export const SCAFFOLD_OUT = 1.3;
/** Its height: the street tier, at most this, m. */
const SCAFFOLD_MAX_H = 36;
/** Pole spacing along a face and lift (deck) spacing up it, m. */
const POLE_STEP = 6;
const LIFT_STEP = 6;
const POLE = 0.22;
const DECK = 0.3;
/** The rebuild crane: top at most this over the generated roof, m. */
export const CRANE_ABOVE_ROOF = 20;
const MAST = 2.2;
const JIB = 1.4;
/** A building wears scaffolding with at least this many chunks gone. */
export const SCAFFOLD_MIN_GONE = 3;
/** Instance budget per dressed building (a 60 m street tier: ~60 boxes). */
const BOXES_PER_BUILDING = 160;

const POLE_COLOR = new THREE.Color(0x6d7177);
const DECK_COLOR = new THREE.Color(0x5a4632);
const CRANE_COLOR = new THREE.Color(0xc89a2c);

/** One box of dressing, world-axis aligned: centre relative to the
 * building's (x, z), y absolute; full sizes. */
export interface DressBox {
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  d: number;
  /** 0 pole, 1 deck, 2 crane. */
  part: 0 | 1 | 2;
}

/** Faces (−x, +x, −z, +z) a hole mouth opens on below `top`: a hole along
 * x opens on the x faces, along z on the z faces. */
function holedFaces(b: Building, top: number): number {
  let mask = 0;
  for (const h of b.holes ?? []) {
    if (h.y0 >= top) continue;
    mask |= h.axis === "x" ? 0b0011 : 0b1100;
  }
  return mask;
}

/**
 * The scaffolding and rebuild crane for building `b`, pushed onto `out`
 * (cleared first). Pure in the building's generated shape.
 */
export function scaffoldBoxes(b: Building, out: DressBox[]): DressBox[] {
  out.length = 0;
  const g = tierGrids(b)[0];
  if (!g) return out;
  const top = Math.min(g.height, SCAFFOLD_MAX_H);
  const hw = g.width / 2;
  const hd = g.depth / 2;
  const skip = holedFaces(b, top);
  const mid = (SCAFFOLD_IN + SCAFFOLD_OUT) / 2;
  const depth = SCAFFOLD_OUT - SCAFFOLD_IN;
  for (let f = 0; f < 4; f++) {
    if (skip & (1 << f)) continue;
    const xFace = f < 2;
    const sign = f % 2 === 0 ? -1 : 1;
    const half = xFace ? hd : hw;
    const off = (xFace ? hw : hd) + mid;
    // Poles: the outer line, every POLE_STEP along the face.
    const poles = Math.max(2, Math.round((2 * half) / POLE_STEP) + 1);
    for (let i = 0; i < poles; i++) {
      const a = -half + (2 * half * i) / (poles - 1);
      const o = (xFace ? hw : hd) + SCAFFOLD_OUT - POLE / 2;
      out.push({
        x: xFace ? sign * o : a,
        y: top / 2,
        z: xFace ? a : sign * o,
        w: POLE,
        h: top,
        d: POLE,
        part: 0,
      });
    }
    // Decks: one lift every LIFT_STEP, the whole face long.
    for (let y = LIFT_STEP; y <= top + 1e-6; y += LIFT_STEP) {
      out.push({
        x: xFace ? sign * off : 0,
        y: y - DECK / 2,
        z: xFace ? 0 : sign * off,
        w: xFace ? depth : 2 * half,
        h: DECK,
        d: xFace ? 2 * half : depth,
        part: 1,
      });
    }
  }
  // The crane: a mast in the footprint's (−x, −z) corner, jib laid along
  // the longer side, all inside the footprint.
  const craneTop = Math.min(b.height + CRANE_ABOVE_ROOF, b.height * 0.6 + 24);
  const mx = -hw + MAST;
  const mz = -hd + MAST;
  out.push({
    x: mx,
    y: craneTop / 2,
    z: mz,
    w: MAST,
    h: craneTop,
    d: MAST,
    part: 2,
  });
  const alongX = g.width >= g.depth;
  const len = (alongX ? g.width : g.depth) - 2 * MAST;
  if (len > 4) {
    out.push({
      x: alongX ? mx - MAST / 2 + len / 2 : mx,
      y: craneTop - JIB / 2,
      z: alongX ? mz : mz - MAST / 2 + len / 2,
      w: alongX ? len : JIB,
      h: JIB,
      d: alongX ? JIB : len,
      part: 2,
    });
  }
  return out;
}

/** Does building `b` wear scaffolding? (Enough of it is gone.) */
export const needsScaffold = (b: Building): boolean =>
  (b.damage?.count ?? 0) >= SCAFFOLD_MIN_GONE;

export class ScaffoldRenderer {
  readonly mesh: THREE.InstancedMesh;
  private maxBuildings: number;
  /** Each building's boxes, placed once (pure in its shape — D6: a
   * re-dress used to build them all again). */
  private readonly boxes = new Map<number, readonly DressBox[]>();
  private readonly matrix = new THREE.Matrix4();
  private readonly picks: number[] = [];
  private lastVersion = -1;
  private lastBx = Number.NaN;
  private lastBz = Number.NaN;
  private readonly pickDist: number[] = [];

  constructor(
    private readonly buildings: readonly Building[],
    tier: QualityTier,
  ) {
    this.maxBuildings = QUALITY_PROFILES[tier].scaffold;
    const capacity = 8 * BOXES_PER_BUILDING;
    const material = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.85,
      metalness: 0.25,
    });
    this.mesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      material,
      capacity,
    );
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // Seed the per-instance colour buffer so the program compiles with it.
    for (let i = 0; i < capacity; i++) this.mesh.setColorAt(i, POLE_COLOR);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
  }

  /** Quality: how many buildings are dressed at once. */
  setQuality(tier: QualityTier): void {
    this.maxBuildings = QUALITY_PROFILES[tier].scaffold;
    this.lastVersion = -1;
  }

  /**
   * Re-dress when the city's damage `version` moved or the camera crossed a
   * block: the `maxBuildings` damaged buildings nearest the camera, each at
   * its torus image nearest it.
   */
  update(cameraPos: Vec3, version: number): void {
    const bx = Math.floor(cameraPos.x / BLOCK_PITCH);
    const bz = Math.floor(cameraPos.z / BLOCK_PITCH);
    if (
      version === this.lastVersion &&
      bx === this.lastBx &&
      bz === this.lastBz
    ) {
      return;
    }
    this.lastVersion = version;
    this.lastBx = bx;
    this.lastBz = bz;
    // The nearest damaged buildings (insertion into a short sorted list).
    this.picks.length = 0;
    this.pickDist.length = 0;
    for (let i = 0; i < this.buildings.length; i++) {
      const b = this.buildings[i] as Building;
      if (!needsScaffold(b)) continue;
      const d = Math.hypot(
        wrapDeltaAxis(cameraPos.x, b.x),
        wrapDeltaAxis(cameraPos.z, b.z),
      );
      let k = this.picks.length;
      while (k > 0 && (this.pickDist[k - 1] as number) > d) k--;
      if (k >= this.maxBuildings) continue;
      // Insert at k, dropping the farthest past maxBuildings (D6: in place;
      // splice returns a fresh array every call).
      const len = Math.min(this.picks.length + 1, this.maxBuildings);
      for (let j = len - 1; j > k; j--) {
        this.picks[j] = this.picks[j - 1] as number;
        this.pickDist[j] = this.pickDist[j - 1] as number;
      }
      this.picks[k] = i;
      this.pickDist[k] = d;
      this.picks.length = len;
      this.pickDist.length = len;
    }
    let n = 0;
    for (const i of this.picks) {
      const b = this.buildings[i] as Building;
      const x = cameraPos.x + wrapDeltaAxis(cameraPos.x, b.x);
      const z = cameraPos.z + wrapDeltaAxis(cameraPos.z, b.z);
      let boxes = this.boxes.get(i);
      if (!boxes) {
        boxes = scaffoldBoxes(b, []);
        this.boxes.set(i, boxes);
      }
      for (const box of boxes) {
        if (n >= this.mesh.instanceMatrix.count) break;
        this.matrix.makeScale(box.w, box.h, box.d);
        this.matrix.setPosition(x + box.x, box.y, z + box.z);
        this.mesh.setMatrixAt(n, this.matrix);
        this.mesh.setColorAt(
          n,
          box.part === 0
            ? POLE_COLOR
            : box.part === 1
              ? DECK_COLOR
              : CRANE_COLOR,
        );
        n++;
      }
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}
