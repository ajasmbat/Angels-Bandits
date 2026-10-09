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
// D8: both are sized to what STANDS (standingProfile), never to the tower
// as generated — the felled tower's cage and mast were the "skeleton" left
// in the air. When a dressed tower's `rebuild` lands, a full-height wrap
// (`wrapBoxes`) stands around it and strips top-down over STRIP_MS.
// `scaffoldBoxes` is the one placement (pure; the bounds test reads it).
//
// One InstancedMesh with a per-instance colour; the tier's
// QualityProfile.scaffold says how many buildings are dressed at once (the
// nearest damaged ones), MOBILE included. Rewritten only when the city's
// damage version moves or the camera crosses a block — no per-frame work
// and no per-frame allocation in between.

import {
  type Building,
  standingProfile,
  tierGrids,
} from "@angels-bandits/common/city";
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
/** D8 restore wrap: a deck every this many m up a restored tower. */
const WRAP_LIFT = 12;
/** D8: a restored tower's scaffold strips top-down over this long, ms. */
export const STRIP_MS = 3000;
/** D8: restored towers stripping at once, and the boxes each may use (a
 * 215 m four-tier tower wraps in ~230). */
const STRIP_MAX = 3;
const BOXES_PER_STRIP = 400;

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

/** Faces (−x, +x, −z, +z) a hole mouth opens on below `top`, of tier `k`
 * (−1: any tier): a hole along x opens on the x faces, along z on z. */
function holedFaces(b: Building, top: number, k = -1): number {
  let mask = 0;
  for (const h of b.holes ?? []) {
    if (h.y0 >= top || (k >= 0 && h.tierIndex !== k)) continue;
    mask |= h.axis === "x" ? 0b0011 : 0b1100;
  }
  return mask;
}

/**
 * One face of scaffolding along a run of bays: `heights[j]` is how high bay
 * j stands (0 = nothing to wrap), the bays split [−half, half] evenly. Poles
 * on the outer line every ≤ POLE_STEP (a bay boundary pole as tall as the
 * taller bay), a deck every `lift` up each bay. `y0` is the ground the
 * face stands on, `off` the facade's distance from the centre.
 */
function pushFace(
  out: DressBox[],
  f: number,
  half: number,
  off: number,
  heights: readonly number[],
  y0: number,
  lift: number,
): void {
  const xFace = f < 2;
  const sign = f % 2 === 0 ? -1 : 1;
  const mid = off + (SCAFFOLD_IN + SCAFFOLD_OUT) / 2;
  const depth = SCAFFOLD_OUT - SCAFFOLD_IN;
  const outer = off + SCAFFOLD_OUT - POLE / 2;
  const nb = heights.length;
  const len = (2 * half) / nb;
  const pole = (a: number, h: number) => {
    if (h <= 0) return;
    out.push({
      x: xFace ? sign * outer : a,
      y: y0 + h / 2,
      z: xFace ? a : sign * outer,
      w: POLE,
      h,
      d: POLE,
      part: 0,
    });
  };
  for (let j = 0; j < nb; j++) {
    const h = heights[j] as number;
    const prev = j > 0 ? (heights[j - 1] as number) : 0;
    const a0 = -half + j * len;
    const m = Math.max(1, Math.round(len / POLE_STEP));
    pole(a0, Math.max(prev, h));
    if (h <= 0) continue;
    for (let i = 1; i < m; i++) pole(a0 + (len * i) / m, h);
    for (let y = lift; y <= h + 1e-6; y += lift) {
      out.push({
        x: xFace ? sign * mid : a0 + len / 2,
        y: y0 + y - DECK / 2,
        z: xFace ? a0 + len / 2 : sign * mid,
        w: xFace ? depth : len,
        h: DECK,
        d: xFace ? len : depth,
        part: 1,
      });
    }
  }
  pole(half, heights[nb - 1] as number);
}

/**
 * The scaffolding and rebuild crane for building `b` as it STANDS (D8),
 * pushed onto `out` (cleared first). Pure in (shape, damage).
 *
 * Scaffolding wraps tier 0's stump bay by bay, each bay up to what stands
 * contiguously from the ground there (standingProfile's stump), at most
 * SCAFFOLD_MAX_H — never a cage around air where the tower was. The crane
 * stands in the footprint corner whose stump is tallest (on the ground or
 * the rubble where nothing stands), its top CRANE_ABOVE_ROOF over that
 * stump and never over the generated roof's allowance.
 */
export function scaffoldBoxes(b: Building, out: DressBox[]): DressBox[] {
  out.length = 0;
  const g = tierGrids(b)[0];
  if (!g) return out;
  const stump = standingProfile(b).stump;
  const col = (ix: number, iz: number) =>
    Math.min(stump[iz * g.nx + ix] as number, SCAFFOLD_MAX_H);
  const hw = g.width / 2;
  const hd = g.depth / 2;
  const faces: number[][] = [
    Array.from({ length: g.nz }, (_, iz) => col(0, iz)),
    Array.from({ length: g.nz }, (_, iz) => col(g.nx - 1, iz)),
    Array.from({ length: g.nx }, (_, ix) => col(ix, 0)),
    Array.from({ length: g.nx }, (_, ix) => col(ix, g.nz - 1)),
  ];
  // A bay too low for a single lift carries nothing.
  for (const f of faces)
    for (let j = 0; j < f.length; j++)
      if ((f[j] as number) < LIFT_STEP) f[j] = 0;
  for (let f = 0; f < 4; f++) {
    const heights = faces[f] as number[];
    const top = Math.max(0, ...heights);
    if (top <= 0 || holedFaces(b, top) & (1 << f)) continue;
    pushFace(out, f, f < 2 ? hd : hw, f < 2 ? hw : hd, heights, 0, LIFT_STEP);
  }
  // The crane: a mast in the tallest-standing footprint corner, jib laid
  // along the longer side, all inside the footprint.
  const corners = [
    [0, 0],
    [g.nx - 1, 0],
    [0, g.nz - 1],
    [g.nx - 1, g.nz - 1],
  ] as const;
  let best = 0;
  for (let k = 1; k < 4; k++) {
    const [ix, iz] = corners[k] as readonly [number, number];
    const [bx, bz] = corners[best] as readonly [number, number];
    if ((stump[iz * g.nx + ix] as number) > (stump[bz * g.nx + bx] as number))
      best = k;
  }
  const [cx, cz] = corners[best] as readonly [number, number];
  const standing = stump[cz * g.nx + cx] as number;
  const sx = cx === 0 ? -1 : 1;
  const sz = cz === 0 ? -1 : 1;
  pushCrane(out, b, g.width, g.depth, sx, sz, standing);
  return out;
}

/** The rebuild crane over a stump `standing` m tall, in the (sx, sz)
 * footprint corner of a `width` × `depth` footprint. */
function pushCrane(
  out: DressBox[],
  b: Building,
  width: number,
  depth: number,
  sx: number,
  sz: number,
  standing: number,
): void {
  const craneTop = Math.min(
    standing + CRANE_ABOVE_ROOF,
    b.height + CRANE_ABOVE_ROOF,
    b.height * 0.6 + 24,
  );
  const mx = sx * (width / 2 - MAST);
  const mz = sz * (depth / 2 - MAST);
  out.push({
    x: mx,
    y: craneTop / 2,
    z: mz,
    w: MAST,
    h: craneTop,
    d: MAST,
    part: 2,
  });
  const alongX = width >= depth;
  const len = (alongX ? width : depth) - 2 * MAST;
  if (len > 4) {
    // Laid from the mast back across the footprint.
    out.push({
      x: alongX ? mx - sx * (len / 2 - MAST / 2) : mx,
      y: craneTop - JIB / 2,
      z: alongX ? mz : mz - sz * (len / 2 - MAST / 2),
      w: alongX ? len : JIB,
      h: JIB,
      d: alongX ? JIB : len,
      part: 2,
    });
  }
}

/**
 * D8: the whole restored tower in scaffolding — every tier's facades, from
 * the tier's base to its top, a deck every WRAP_LIFT — and its crane at full
 * height, pushed onto `out` (cleared first). Drawn the moment a dressed
 * building's `rebuild` lands, then stripped top-down (ScaffoldRenderer), so
 * the tower appears inside its scaffold instead of popping out of air.
 */
export function wrapBoxes(b: Building, out: DressBox[]): DressBox[] {
  out.length = 0;
  const grids = tierGrids(b);
  grids.forEach((g, k) => {
    const hw = g.width / 2;
    const hd = g.depth / 2;
    const skip = holedFaces(b, g.baseY + g.height, k);
    for (let f = 0; f < 4; f++) {
      if (skip & (1 << f)) continue;
      const bays = f < 2 ? g.nz : g.nx;
      pushFace(
        out,
        f,
        f < 2 ? hd : hw,
        f < 2 ? hw : hd,
        new Array<number>(bays).fill(g.height),
        g.baseY,
        WRAP_LIFT,
      );
    }
  });
  const g0 = grids[0];
  if (g0) pushCrane(out, b, g0.width, g0.depth, -1, -1, b.height);
  return out;
}

/** Does building `b` wear scaffolding? (Enough of it is gone.) */
export const needsScaffold = (b: Building): boolean =>
  (b.damage?.count ?? 0) >= SCAFFOLD_MIN_GONE;

/** A restored tower's scaffold, stripping top-down. */
interface Strip {
  b: number;
  t0: number;
  top: number;
  boxes: DressBox[];
}

export class ScaffoldRenderer {
  readonly mesh: THREE.InstancedMesh;
  private maxBuildings: number;
  /** Each dressed building's boxes and the damage version they were placed
   * at (D8: they follow the stump, so a version change re-places them). */
  private readonly boxes = new Map<
    number,
    { version: number; boxes: readonly DressBox[] }
  >();
  private readonly matrix = new THREE.Matrix4();
  private readonly picks: number[] = [];
  private lastVersion = -1;
  private lastBx = Number.NaN;
  private lastBz = Number.NaN;
  private readonly pickDist: number[] = [];
  /** Slots [0, dressed) hold the damaged buildings' dressing; strips after. */
  private dressed = 0;
  private readonly strips: Strip[] = [];
  private readonly capacity: number;

  constructor(
    private readonly buildings: readonly Building[],
    tier: QualityTier,
  ) {
    this.maxBuildings = QUALITY_PROFILES[tier].scaffold;
    this.capacity = 8 * BOXES_PER_BUILDING + STRIP_MAX * BOXES_PER_STRIP;
    const capacity = this.capacity;
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
   * D8: building `b`'s `rebuild` landed. If it was dressed, its scaffold
   * wraps the restored tower at full height and strips top-down over
   * STRIP_MS from `now` (performance.now() ms) — the tower lands inside its
   * scaffold. Nothing is grown before the restore: a rebuild the director
   * defers never leaves scaffolding around air.
   */
  rebuilt(b: number, now: number): void {
    if (!this.picks.includes(b)) return;
    const building = this.buildings[b];
    if (!building) return;
    if (this.strips.length >= STRIP_MAX) this.strips.shift();
    this.strips.push({
      b,
      t0: now,
      top: building.height + CRANE_ABOVE_ROOF,
      boxes: wrapBoxes(building, []),
    });
  }

  /**
   * Re-dress when the city's damage `version` moved or the camera crossed a
   * block: the `maxBuildings` damaged buildings nearest the camera, each at
   * its torus image nearest it — and, while a restored tower strips, its
   * wrap every frame.
   */
  update(cameraPos: Vec3, version: number, now = performance.now()): void {
    const bx = Math.floor(cameraPos.x / BLOCK_PITCH);
    const bz = Math.floor(cameraPos.z / BLOCK_PITCH);
    const redress =
      version !== this.lastVersion || bx !== this.lastBx || bz !== this.lastBz;
    if (!redress && this.strips.length === 0) return;
    if (redress) {
      this.lastVersion = version;
      this.lastBx = bx;
      this.lastBz = bz;
      this.dressed = this.dress(cameraPos);
    }
    let n = this.dressed;
    for (let k = this.strips.length - 1; k >= 0; k--) {
      const strip = this.strips[k] as Strip;
      const u = (now - strip.t0) / STRIP_MS;
      if (u >= 1) {
        this.strips.splice(k, 1);
        continue;
      }
      // Top-down: everything over the line is gone, poles are cut at it.
      const line = strip.top * (1 - u * u);
      const b = this.buildings[strip.b] as Building;
      const x = cameraPos.x + wrapDeltaAxis(cameraPos.x, b.x);
      const z = cameraPos.z + wrapDeltaAxis(cameraPos.z, b.z);
      const end = Math.min(this.capacity, n + BOXES_PER_STRIP);
      for (const box of strip.boxes) {
        if (n >= end) break;
        const y0 = box.y - box.h / 2;
        if (y0 >= line) continue;
        const h = Math.min(box.h, line - y0);
        this.write(
          n++,
          x + box.x,
          y0 + h / 2,
          z + box.z,
          box.w,
          h,
          box.d,
          box.part,
        );
      }
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  /** Dress the nearest damaged buildings into slots [0, n); returns n. */
  private dress(cameraPos: Vec3): number {
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
    // P3: only the dressed buildings' boxes stay cached. Under C2's constant
    // chaos nearly every building is damaged sooner or later, and caching
    // each one ever dressed grew the heap for the whole session (the soak).
    // Re-dressing one is pure and cheap. Runs only on a re-dress.
    if (this.boxes.size > this.picks.length * 2) {
      for (const i of this.boxes.keys()) {
        if (!this.picks.includes(i)) this.boxes.delete(i);
      }
    }
    let n = 0;
    const budget = 8 * BOXES_PER_BUILDING;
    for (const i of this.picks) {
      const b = this.buildings[i] as Building;
      const x = cameraPos.x + wrapDeltaAxis(cameraPos.x, b.x);
      const z = cameraPos.z + wrapDeltaAxis(cameraPos.z, b.z);
      const version = b.damage?.version ?? 0;
      let entry = this.boxes.get(i);
      if (!entry || entry.version !== version) {
        entry = { version, boxes: scaffoldBoxes(b, []) };
        this.boxes.set(i, entry);
      }
      for (const box of entry.boxes) {
        if (n >= budget) break;
        this.write(
          n++,
          x + box.x,
          box.y,
          z + box.z,
          box.w,
          box.h,
          box.d,
          box.part,
        );
      }
    }
    return n;
  }

  private write(
    n: number,
    x: number,
    y: number,
    z: number,
    w: number,
    h: number,
    d: number,
    part: number,
  ): void {
    this.matrix.makeScale(w, h, d);
    this.matrix.setPosition(x, y, z);
    this.mesh.setMatrixAt(n, this.matrix);
    this.mesh.setColorAt(
      n,
      part === 0 ? POLE_COLOR : part === 1 ? DECK_COLOR : CRANE_COLOR,
    );
  }
}
