// D2 breakable buildings — the chunk model and the damage state, shared
// verbatim by client and server.
//
// Every tier of every building is cut into a deterministic grid of CHUNKS:
// floor bands (~CHUNK_FLOOR) × facade bays (~CHUNK_BAY) × depth slices
// (~CHUNK_BAY). A chunk's id is (building index, tier, cell) — never its
// translation — so client and server name the same chunk the same way.
// Cells that are wholly hole air (an H1 tunnel, arch or sky hole) are not
// chunks.
//
// The SERVER is the only authority on what breaks: it applies bullet rays
// and death blasts to a CityDamage, broadcasts what broke, and replays the
// whole destroyed set to late joiners. Every client applies the same set to
// its own CityDamage, which writes through to each Building's `damage`
// record — and `solids(b)` (city/holes.ts) subtracts exactly those chunks,
// so collision, sight lines, bot probes and the renderer all agree.

import {
  CHUNK_BAY,
  CHUNK_FLOOR,
  CHUNK_HP,
  DESTROY_CAP,
  HOLE_CORRIDOR_MARGIN,
  RUBBLE_FALL_RANGE,
  RUBBLE_MAX_HEIGHT,
  RUBBLE_REACH,
  RUBBLE_STEP,
} from "../constants";
import { type Vec3, wrapDelta } from "../world/index";
// holes.ts ↔ destruction.ts is a module cycle: solids() dispatches here for
// damaged buildings and this module reads solids() back. Every use is at
// call time, never at module evaluation, so the cycle is harmless.
import { type SolidBox, baseSolids, solids } from "./holes";
import type { Building } from "./index";
import { ROOF_STRUCTURE_MAX_HEIGHT } from "./roof-structures";
// standing.ts reads this module back at call time only (the holes.ts idiom).
import { generatedRoof, syncRoof } from "./standing";

/** SolidBox.cut bits: the box faces exposed by destruction (−x, +x, −y, +y,
 * −z, +z), and RUBBLE for a debris pile on the street. */
export const CUT_NEG_X = 1;
export const CUT_POS_X = 2;
export const CUT_NEG_Y = 4;
export const CUT_POS_Y = 8;
export const CUT_NEG_Z = 16;
export const CUT_POS_Z = 32;
export const CUT_RUBBLE = 64;

/** Chunk id layout: building index · tier (2 bits) · cell (12 bits). */
const CELL_BITS = 12;
const TIER_BITS = 2;
export const MAX_CELLS = 1 << CELL_BITS;
export const MAX_TIERS = 1 << TIER_BITS;

export const chunkId = (building: number, tier: number, cell: number): number =>
  building * (1 << (CELL_BITS + TIER_BITS)) + tier * MAX_CELLS + cell;
export const chunkBuilding = (id: number): number =>
  Math.floor(id / (1 << (CELL_BITS + TIER_BITS)));
export const chunkTier = (id: number): number =>
  Math.floor(id / MAX_CELLS) % MAX_TIERS;
export const chunkCell = (id: number): number => id % MAX_CELLS;

/** BuildingDamage.cells values: a chunk shot or blasted out (it drops D2
 * street rubble) and one that fell in a D3 collapse (its debris lands as
 * the collapse's own rubble, city/collapse.ts). Any non-zero cell is gone. */
export const CELL_BROKEN = 1;
export const CELL_FALLEN = 2;

/** One building's destruction, written by CityDamage and read by solids(). */
export interface BuildingDamage {
  /** The building's index in its city array (the chunk id prefix). */
  readonly index: number;
  /** Per tier: CELL_BROKEN or CELL_FALLEN where the cell is gone, else 0. */
  readonly cells: Uint8Array[];
  /** Destroyed chunks in this building. */
  count: number;
  /** Bumped on every change, from one global counter — solids() keys its
   * cache on it, and a renderer compares it to what it last drew. */
  version: number;
  /** Tier-0 faces rubble may pile in front of (open ground for
   * RUBBLE_REACH): bit 0 −x, 1 +x, 2 −z, 3 +z. */
  readonly openFaces: number;
}

let damageVersion = 0;

/** A tier's chunk grid, in its building's frame (x/z from the centre). */
export interface TierGrid {
  nx: number;
  ny: number;
  nz: number;
  /** Cell size along x, y, z, meters. */
  cw: number;
  ch: number;
  cd: number;
  width: number;
  depth: number;
  height: number;
  /** Ground height of the tier's base. */
  baseY: number;
}

/** A box in a building's frame: x/z from its centre, y from the ground. */
export interface LocalBox {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  z0: number;
  z1: number;
}

const gridCache = new WeakMap<Building, readonly TierGrid[]>();

/** The chunk grid of every tier, bottom-up. Pure in the tier sizes. */
export function tierGrids(b: Building): readonly TierGrid[] {
  let grids = gridCache.get(b);
  if (!grids) {
    const out: TierGrid[] = [];
    let baseY = 0;
    for (const t of b.tiers) {
      const nx = Math.max(1, Math.round(t.width / CHUNK_BAY));
      const nz = Math.max(1, Math.round(t.depth / CHUNK_BAY));
      const ny = Math.max(1, Math.round(t.height / CHUNK_FLOOR));
      out.push({
        nx,
        ny,
        nz,
        cw: t.width / nx,
        ch: t.height / ny,
        cd: t.depth / nz,
        width: t.width,
        depth: t.depth,
        height: t.height,
        baseY,
      });
      baseY += t.height;
    }
    grids = out;
    gridCache.set(b, grids);
  }
  return grids;
}

/** Cell edges, exact at the tier's own faces (no float drift at the ends). */
const edgeX = (g: TierGrid, i: number) =>
  i >= g.nx ? g.width / 2 : -g.width / 2 + i * g.cw;
const edgeZ = (g: TierGrid, i: number) =>
  i >= g.nz ? g.depth / 2 : -g.depth / 2 + i * g.cd;
const edgeY = (g: TierGrid, i: number) =>
  i >= g.ny ? g.baseY + g.height : g.baseY + i * g.ch;

export const cellIndex = (g: TierGrid, ix: number, iy: number, iz: number) =>
  (iy * g.nz + iz) * g.nx + ix;

/** A cell's box in its building's frame. */
export function cellBox(g: TierGrid, cell: number, out?: LocalBox): LocalBox {
  const ix = cell % g.nx;
  const iz = Math.floor(cell / g.nx) % g.nz;
  const iy = Math.floor(cell / (g.nx * g.nz));
  const box = out ?? { x0: 0, x1: 0, y0: 0, y1: 0, z0: 0, z1: 0 };
  box.x0 = edgeX(g, ix);
  box.x1 = edgeX(g, ix + 1);
  box.y0 = edgeY(g, iy);
  box.y1 = edgeY(g, iy + 1);
  box.z0 = edgeZ(g, iz);
  box.z1 = edgeZ(g, iz + 1);
  return box;
}

/** A SolidBox's extent as a LocalBox. */
const solidExtent = (s: SolidBox): LocalBox => ({
  x0: s.dx - s.width / 2,
  x1: s.dx + s.width / 2,
  y0: s.baseY,
  y1: s.baseY + s.height,
  z0: s.dz - s.depth / 2,
  z1: s.dz + s.depth / 2,
});

/** Positive-volume overlap of two boxes, or null. */
function intersect(a: LocalBox, b: LocalBox): LocalBox | null {
  const x0 = Math.max(a.x0, b.x0);
  const x1 = Math.min(a.x1, b.x1);
  const y0 = Math.max(a.y0, b.y0);
  const y1 = Math.min(a.y1, b.y1);
  const z0 = Math.max(a.z0, b.z0);
  const z1 = Math.min(a.z1, b.z1);
  if (x1 - x0 <= 1e-6 || y1 - y0 <= 1e-6 || z1 - z0 <= 1e-6) return null;
  return { x0, x1, y0, y1, z0, z1 };
}

const existsCache = new WeakMap<Building, readonly Uint8Array[]>();

/** Per tier: 1 where the cell holds solid volume (is a chunk). */
export function chunkMask(b: Building): readonly Uint8Array[] {
  let masks = existsCache.get(b);
  if (!masks) {
    const grids = tierGrids(b);
    const base = baseSolids(b);
    const scratch: LocalBox = { x0: 0, x1: 0, y0: 0, y1: 0, z0: 0, z1: 0 };
    masks = grids.map((g, k) => {
      const tierBoxes = base.filter((s) => s.tierIndex === k).map(solidExtent);
      const mask = new Uint8Array(g.nx * g.ny * g.nz);
      for (let c = 0; c < mask.length; c++) {
        const box = cellBox(g, c, scratch);
        mask[c] = tierBoxes.some((s) => intersect(box, s)) ? 1 : 0;
      }
      return mask;
    });
    existsCache.set(b, masks);
  }
  return masks;
}

/** Every chunk id of building `index` (= `b`), ascending. */
export function chunksOf(b: Building, index: number): number[] {
  const out: number[] = [];
  chunkMask(b).forEach((mask, tier) => {
    for (let c = 0; c < mask.length; c++) {
      if (mask[c]) out.push(chunkId(index, tier, c));
    }
  });
  return out;
}

/** True when `id` names a real chunk of `buildings`. */
export function isChunk(buildings: readonly Building[], id: number): boolean {
  if (!Number.isInteger(id) || id < 0) return false;
  const b = buildings[chunkBuilding(id)];
  if (!b) return false;
  const mask = chunkMask(b)[chunkTier(id)];
  return !!mask && mask[chunkCell(id)] === 1;
}

/** A chunk's box in its building's frame (null for an unknown id). */
export function chunkBox(
  buildings: readonly Building[],
  id: number,
): LocalBox | null {
  const b = buildings[chunkBuilding(id)];
  const g = b && tierGrids(b)[chunkTier(id)];
  if (!g || chunkCell(id) >= g.nx * g.ny * g.nz) return null;
  return cellBox(g, chunkCell(id));
}

/**
 * The tier and cell holding a point in `b`'s frame, or null outside every
 * tier. A point exactly on a tier's top belongs to the tier below it.
 */
export function chunkAt(
  b: Building,
  p: Vec3,
): { tier: number; cell: number } | null {
  const grids = tierGrids(b);
  for (let k = 0; k < grids.length; k++) {
    const g = grids[k] as TierGrid;
    if (p.y < g.baseY - 1e-6 || p.y > g.baseY + g.height + 1e-6) continue;
    if (
      Math.abs(p.x) > g.width / 2 + 1e-6 ||
      Math.abs(p.z) > g.depth / 2 + 1e-6
    ) {
      continue;
    }
    const clampI = (v: number, n: number) =>
      Math.min(n - 1, Math.max(0, Math.floor(v)));
    const ix = clampI((p.x + g.width / 2) / g.cw, g.nx);
    const iy = clampI((p.y - g.baseY) / g.ch, g.ny);
    const iz = clampI((p.z + g.depth / 2) / g.cd, g.nz);
    return { tier: k, cell: cellIndex(g, ix, iy, iz) };
  }
  return null;
}

/** What one chunk rests on (D3's collapse input). */
export interface ChunkSupport {
  id: number;
  /** Chunk ids directly carrying this one. */
  on: number[];
  /** True for the street tier's bottom band: it stands on the ground. */
  ground: boolean;
}

/**
 * The support graph of building `index` (= `b`): every chunk and what it
 * rests on. A cell rests on the cell under it in its tier; where that is
 * hole air (a lintel over a tunnel) on its same-band neighbours either side
 * across the hole — a lintel is carried by its walls. A tier's bottom band
 * rests on the top-band chunks of the tier below that overlap it in plan;
 * the street tier's bottom band on the ground. Destroyed chunks are not
 * excluded: D3 intersects this with the live destroyed set.
 */
export function supportGraph(b: Building, index: number): ChunkSupport[] {
  const grids = tierGrids(b);
  const masks = chunkMask(b);
  const out: ChunkSupport[] = [];
  const box: LocalBox = { x0: 0, x1: 0, y0: 0, y1: 0, z0: 0, z1: 0 };
  const lower: LocalBox = { x0: 0, x1: 0, y0: 0, y1: 0, z0: 0, z1: 0 };
  for (let k = 0; k < grids.length; k++) {
    const g = grids[k] as TierGrid;
    const mask = masks[k] as Uint8Array;
    const hole = b.holes?.find((h) => h.tierIndex === k);
    for (let c = 0; c < mask.length; c++) {
      if (!mask[c]) continue;
      const ix = c % g.nx;
      const iz = Math.floor(c / g.nx) % g.nz;
      const iy = Math.floor(c / (g.nx * g.nz));
      const on: number[] = [];
      let ground = false;
      if (iy > 0) {
        const below = cellIndex(g, ix, iy - 1, iz);
        if (mask[below]) {
          on.push(chunkId(index, k, below));
        } else {
          // Hole air underneath: carried sideways, across the hole's axis.
          const alongX = hole?.axis !== "x";
          for (const step of [-1, 1]) {
            const jx = alongX ? ix + step : ix;
            const jz = alongX ? iz : iz + step;
            if (jx < 0 || jx >= g.nx || jz < 0 || jz >= g.nz) continue;
            const n = cellIndex(g, jx, iy, jz);
            if (mask[n]) on.push(chunkId(index, k, n));
          }
        }
      } else if (k === 0) {
        ground = true;
      } else {
        const lg = grids[k - 1] as TierGrid;
        const lmask = masks[k - 1] as Uint8Array;
        cellBox(g, c, box);
        for (let jz = 0; jz < lg.nz; jz++) {
          for (let jx = 0; jx < lg.nx; jx++) {
            const n = cellIndex(lg, jx, lg.ny - 1, jz);
            if (!lmask[n]) continue;
            cellBox(lg, n, lower);
            if (
              Math.min(box.x1, lower.x1) - Math.max(box.x0, lower.x0) > 1e-6 &&
              Math.min(box.z1, lower.z1) - Math.max(box.z0, lower.z0) > 1e-6
            ) {
              on.push(chunkId(index, k - 1, n));
            }
          }
        }
      }
      out.push({ id: chunkId(index, k, c), on, ground });
    }
  }
  return out;
}

// --- solids() of a damaged building ---------------------------------------

/** Push `piece` (= region ∩ s) as a SolidBox, tagging the faces that lie
 * strictly inside `s` — the surfaces destruction exposed. */
function pushPiece(
  out: SolidBox[],
  region: LocalBox,
  s: LocalBox,
  tierIndex: number,
): void {
  const p = intersect(region, s);
  if (!p) return;
  const eps = 1e-6;
  let cut = 0;
  if (p.x0 > s.x0 + eps) cut |= CUT_NEG_X;
  if (p.x1 < s.x1 - eps) cut |= CUT_POS_X;
  if (p.y0 > s.y0 + eps) cut |= CUT_NEG_Y;
  if (p.y1 < s.y1 - eps) cut |= CUT_POS_Y;
  if (p.z0 > s.z0 + eps) cut |= CUT_NEG_Z;
  if (p.z1 < s.z1 - eps) cut |= CUT_POS_Z;
  out.push({
    dx: (p.x0 + p.x1) / 2,
    dz: (p.z0 + p.z1) / 2,
    baseY: p.y0,
    width: p.x1 - p.x0,
    height: p.y1 - p.y0,
    depth: p.z1 - p.z0,
    tierIndex,
    cut,
  });
}

/**
 * The solid volume of one chunk as the building was generated: its cell
 * clipped to the tier's hole-split base boxes (one box for an unholed tier,
 * up to three around a hole), each tagged with the faces that lay inside
 * the tier — what D3 drops when the chunk falls. Pure in the geometry.
 */
export function cellSolids(
  b: Building,
  tier: number,
  cell: number,
): SolidBox[] {
  const g = tierGrids(b)[tier];
  if (!g || cell < 0 || cell >= g.nx * g.ny * g.nz) return [];
  const region = cellBox(g, cell);
  const out: SolidBox[] = [];
  for (const s of baseSolids(b)) {
    if (s.tierIndex === tier) pushPiece(out, region, solidExtent(s), tier);
  }
  return out;
}

/**
 * The solids of a damaged building: each damaged tier's intact cells merged
 * into few boxes (runs of whole intact floor bands become one box; a band
 * with damage becomes x-runs per depth slice) and clipped to the tier's
 * hole-split base boxes, then the rubble piles. Undamaged tiers keep their
 * base boxes untouched.
 */
export function damagedSolids(b: Building, dmg: BuildingDamage): SolidBox[] {
  const base = baseSolids(b);
  const grids = tierGrids(b);
  const out: SolidBox[] = [];
  for (let k = 0; k < grids.length; k++) {
    const g = grids[k] as TierGrid;
    const cells = dmg.cells[k];
    const tierBoxes = base.filter((s) => s.tierIndex === k);
    if (!cells || cells.every((v) => v === 0)) {
      out.push(...tierBoxes);
      continue;
    }
    const extents = tierBoxes.map(solidExtent);
    const bandIntact = (iy: number) => {
      const from = iy * g.nx * g.nz;
      for (let c = from; c < from + g.nx * g.nz; c++)
        if (cells[c]) return false;
      return true;
    };
    const region = (
      x0: number,
      x1: number,
      y0: number,
      y1: number,
      z0: number,
      z1: number,
    ) => {
      const r = { x0, x1, y0, y1, z0, z1 };
      for (const s of extents) pushPiece(out, r, s, k);
    };
    let iy = 0;
    while (iy < g.ny) {
      if (bandIntact(iy)) {
        let top = iy;
        while (top < g.ny && bandIntact(top)) top++;
        region(
          -g.width / 2,
          g.width / 2,
          edgeY(g, iy),
          edgeY(g, top),
          -g.depth / 2,
          g.depth / 2,
        );
        iy = top;
        continue;
      }
      for (let iz = 0; iz < g.nz; iz++) {
        let ix = 0;
        while (ix < g.nx) {
          if (cells[cellIndex(g, ix, iy, iz)]) {
            ix++;
            continue;
          }
          let end = ix;
          while (end < g.nx && !cells[cellIndex(g, end, iy, iz)]) end++;
          region(
            edgeX(g, ix),
            edgeX(g, end),
            edgeY(g, iy),
            edgeY(g, iy + 1),
            edgeZ(g, iz),
            edgeZ(g, iz + 1),
          );
          ix = end;
        }
      }
      iy++;
    }
  }
  pushRubble(out, b, dmg);
  return out;
}

/**
 * Rubble: every broken (not fallen) chunk drops onto the nearest OPEN tier-0 face
 * (open ground for RUBBLE_REACH — a street-facing sidewalk or a yard, never
 * a party wall) within RUBBLE_FALL_RANGE of its centre, in the tier-0 bay
 * its centre projects onto. Each slot is one low box against the facade,
 * growing with the chunks that fell into it. Slots in front of a street-tier
 * hole mouth (its half-width + HOLE_CORRIDOR_MARGIN) stay clear.
 */
function pushRubble(out: SolidBox[], b: Building, dmg: BuildingDamage): void {
  if (!dmg.openFaces) return;
  const grids = tierGrids(b);
  const g0 = grids[0];
  if (!g0) return;
  const hw = g0.width / 2;
  const hd = g0.depth / 2;
  // Slots per face: x faces have nz bays along z, z faces nx along x.
  const counts = [
    new Uint16Array(g0.nz),
    new Uint16Array(g0.nz),
    new Uint16Array(g0.nx),
    new Uint16Array(g0.nx),
  ];
  const box: LocalBox = { x0: 0, x1: 0, y0: 0, y1: 0, z0: 0, z1: 0 };
  for (let k = 0; k < grids.length; k++) {
    const g = grids[k] as TierGrid;
    const cells = dmg.cells[k];
    if (!cells) continue;
    for (let c = 0; c < cells.length; c++) {
      // Fallen chunks land as their collapse's rubble, not here.
      if (cells[c] !== CELL_BROKEN) continue;
      cellBox(g, c, box);
      const cx = (box.x0 + box.x1) / 2;
      const cz = (box.z0 + box.z1) / 2;
      const dist = [cx + hw, hw - cx, cz + hd, hd - cz];
      let face = -1;
      for (let f = 0; f < 4; f++) {
        if (!(dmg.openFaces & (1 << f))) continue;
        const d = dist[f] as number;
        if (d > RUBBLE_FALL_RANGE) continue;
        if (face < 0 || d < (dist[face] as number)) face = f;
      }
      if (face < 0) continue;
      const slots = counts[face] as Uint16Array;
      const along = face < 2 ? cz + hd : cx + hw;
      const size = face < 2 ? g0.cd : g0.cw;
      const bay = Math.min(
        slots.length - 1,
        Math.max(0, Math.floor(along / size)),
      );
      slots[bay] = (slots[bay] as number) + 1;
    }
  }
  const mouth = b.holes?.find((h) => h.tierIndex === 0);
  for (let f = 0; f < 4; f++) {
    const slots = counts[f] as Uint16Array;
    const xFace = f < 2;
    const sign = f % 2 === 0 ? -1 : 1;
    for (let bay = 0; bay < slots.length; bay++) {
      const n = slots[bay] as number;
      if (n === 0) continue;
      const a0 = xFace ? edgeZ(g0, bay) : edgeX(g0, bay);
      const a1 = xFace ? edgeZ(g0, bay + 1) : edgeX(g0, bay + 1);
      // A hole travelling along x opens on the x faces (and z on z).
      if (mouth && (mouth.axis === "x") === xFace) {
        const keep = mouth.width / 2 + HOLE_CORRIDOR_MARGIN;
        if (a1 > mouth.offset - keep && a0 < mouth.offset + keep) continue;
      }
      const height = Math.min(RUBBLE_STEP * n, RUBBLE_MAX_HEIGHT);
      const reach = Math.min(1 + 0.5 * n, RUBBLE_REACH);
      const span = a1 - a0 - 0.4;
      if (span <= 0) continue;
      const out0 = (xFace ? hw : hd) + reach / 2;
      out.push({
        dx: xFace ? sign * out0 : (a0 + a1) / 2,
        dz: xFace ? (a0 + a1) / 2 : sign * out0,
        baseY: 0,
        width: xFace ? reach : span,
        height,
        depth: xFace ? span : reach,
        tierIndex: 0,
        cut: CUT_RUBBLE,
      });
    }
  }
}

// --- The damage state -----------------------------------------------------

/**
 * Tier-0 faces of `buildings[i]` with open ground in front of them: no other
 * building's street-tier footprint within RUBBLE_REACH (torus-correct).
 */
function openFacesOf(buildings: readonly Building[], i: number): number {
  const b = buildings[i] as Building;
  const t0 = b.tiers[0];
  if (!t0) return 0;
  const hw = t0.width / 2;
  const hd = t0.depth / 2;
  // Each face's strip, centred on the building: [x0, x1] × [z0, z1].
  const strips = [
    [-hw - RUBBLE_REACH, -hw, -hd, hd],
    [hw, hw + RUBBLE_REACH, -hd, hd],
    [-hw, hw, -hd - RUBBLE_REACH, -hd],
    [-hw, hw, hd, hd + RUBBLE_REACH],
  ] as const;
  let open = 0;
  strips.forEach(([x0, x1, z0, z1], f) => {
    const blocked = buildings.some((o, j) => {
      if (j === i) return false;
      const ot = o.tiers[0];
      if (!ot) return false;
      const d = wrapDelta({ x: b.x, y: 0, z: b.z }, { x: o.x, y: 0, z: o.z });
      return (
        Math.min(x1, d.x + ot.width / 2) - Math.max(x0, d.x - ot.width / 2) >
          1e-6 &&
        Math.min(z1, d.z + ot.depth / 2) - Math.max(z0, d.z - ot.depth / 2) >
          1e-6
      );
    });
    if (!blocked) open |= 1 << f;
  });
  return open;
}

/** Point-to-box distance, the point in the box's frame. */
function boxDistance(p: Vec3, box: LocalBox): number {
  const dx = Math.max(box.x0 - p.x, 0, p.x - box.x1);
  const dy = Math.max(box.y0 - p.y, 0, p.y - box.y1);
  const dz = Math.max(box.z0 - p.z, 0, p.z - box.z1);
  return Math.hypot(dx, dy, dz);
}

/**
 * One city's destruction: what is destroyed (server and client) and the
 * partial HP of chunks still standing (server). Holds bare ids until
 * bind(buildings) — a client's socket sees chunks before its city is built —
 * then writes every change through to the buildings' `damage` records.
 */
export class CityDamage {
  private buildings: readonly Building[] | null = null;
  private readonly destroyed = new Set<number>();
  /** D3: chunks that fell in a collapse. Kept apart from `destroyed`: they
   * never count toward DESTROY_CAP, never go out in `chunks` batches or the
   * welcome's `destroyed` — a client rebuilds them from the collapse records
   * (CollapseField), so a late joiner holds exactly what a live one does. */
  private readonly fallen = new Set<number>();
  private readonly hp = new Map<number, number>();
  private pending: number[] = [];
  private openFaces: Int8Array | null = null;
  /** Real chunks in the bound city, and how many may be destroyed. */
  private total = 0;
  private limit = Number.POSITIVE_INFINITY;
  private capShare = DESTROY_CAP;
  /** C2 backstop (server): while true nothing breaks — a chunk bottoms out
   * at 1 HP, as at the cap. The room sets it from its gone share. */
  hold = false;
  /** Bumped on every change to the destroyed set. */
  version = 0;
  /** D8: buildings whose cells changed since the last roof sync. */
  private readonly roofDirty = new Set<number>();

  /** Attach to the city these ids name; replays everything held so far. */
  bind(buildings: readonly Building[]): void {
    this.buildings = buildings;
    this.openFaces = new Int8Array(buildings.length).fill(-1);
    let total = 0;
    for (const b of buildings) {
      for (const mask of chunkMask(b)) for (const v of mask) total += v;
    }
    this.total = total;
    this.limit = Math.floor(total * this.capShare);
    const held = [...this.destroyed];
    const fell = [...this.fallen];
    this.destroyed.clear();
    this.fallen.clear();
    for (const b of buildings) b.damage = undefined;
    for (const id of held) this.mark(id, CELL_BROKEN);
    for (const id of fell) this.mark(id, CELL_FALLEN);
    this.syncAllRoofs();
    this.version++;
  }

  /** The share of chunks that may be broken (DESTROY_CAP by default). */
  setCap(share: number): void {
    this.capShare = share;
    if (this.buildings) this.limit = Math.floor(this.total * share);
  }

  /** (broken + fallen) / chunks of the bound city (0 before bind). */
  get goneShare(): number {
    return this.total > 0
      ? (this.destroyed.size + this.fallen.size) / this.total
      : 0;
  }

  /** Chunks in the bound city (0 before bind). */
  get chunkCount(): number {
    return this.total;
  }

  get destroyedCount(): number {
    return this.destroyed.size;
  }

  isDestroyed(id: number): boolean {
    return this.destroyed.has(id);
  }

  /** D3: chunks that fell in collapses. */
  get fallenCount(): number {
    return this.fallen.size;
  }

  /** Broken or fallen: no longer part of the building. */
  isGone(id: number): boolean {
    return this.destroyed.has(id) || this.fallen.has(id);
  }

  /** The destroyed set, ascending — the welcome's replay. */
  destroyedIds(): number[] {
    return [...this.destroyed].sort((a, b) => a - b);
  }

  /** What broke since the last call, ascending — one batch per tick. */
  takeDestroyed(): number[] {
    const out = this.pending.sort((a, b) => a - b);
    this.pending = [];
    return out;
  }

  /** Apply ids the server says are destroyed (a client's `chunks`). No cap:
   * the server already applied it. Unknown ids are dropped once bound. */
  apply(ids: readonly number[]): void {
    let changed = false;
    for (const id of ids) {
      if (this.isGone(id)) continue;
      if (this.buildings && !isChunk(this.buildings, id)) continue;
      this.mark(id, CELL_BROKEN);
      changed = true;
    }
    this.flushRoofs();
    if (changed) this.version++;
  }

  /** Make the destroyed set exactly `ids` (a welcome; may shrink it) and
   * forget every fallen chunk — the caller replays the collapse records. */
  reset(ids: readonly number[]): void {
    this.destroyed.clear();
    this.fallen.clear();
    this.hp.clear();
    this.pending = [];
    if (this.buildings) for (const b of this.buildings) b.damage = undefined;
    for (const id of ids) {
      if (this.buildings && !isChunk(this.buildings, id)) continue;
      if (!this.destroyed.has(id)) this.mark(id, CELL_BROKEN);
    }
    this.syncAllRoofs();
    this.version++;
  }

  /**
   * D3: these chunks fell in a collapse. Exempt from DESTROY_CAP (a collapse
   * must never leave anything floating) and never queued for `chunks`: the
   * collapse record itself carries them. A chunk already broken stays
   * broken (its D2 rubble is already on the street).
   */
  collapse(ids: readonly number[]): void {
    let changed = false;
    for (const id of ids) {
      if (this.isGone(id)) continue;
      if (this.buildings && !isChunk(this.buildings, id)) continue;
      this.fallen.add(id);
      this.hp.delete(id);
      if (this.buildings) this.writeCell(id, CELL_FALLEN);
      changed = true;
    }
    this.flushRoofs();
    if (changed) this.version++;
  }

  /** Destroy one chunk outright. False if it was already gone, is not a
   * chunk, the city is at DESTROY_CAP, or the room holds (C2). */
  destroyChunk(id: number): boolean {
    if (!this.buildings || this.isGone(id)) return false;
    if (!isChunk(this.buildings, id)) return false;
    if (this.destroyed.size >= this.limit || this.hold) return false;
    this.mark(id, CELL_BROKEN);
    this.hp.delete(id);
    this.pending.push(id);
    this.flushRoofs();
    this.version++;
    return true;
  }

  /** Take `amount` off a chunk; true when that destroyed it. At the cap a
   * chunk bottoms out at 1 HP and stands. */
  damageChunk(id: number, amount: number): boolean {
    if (!this.buildings || this.isGone(id) || !(amount > 0)) {
      return false;
    }
    if (!isChunk(this.buildings, id)) return false;
    const left = (this.hp.get(id) ?? CHUNK_HP) - amount;
    if (left > 0) {
      this.hp.set(id, left);
      return false;
    }
    if (this.destroyChunk(id)) return true;
    this.hp.set(id, 1);
    return false;
  }

  /** Remaining HP of a standing chunk (0 once destroyed). */
  hpOf(id: number): number {
    if (this.isGone(id)) return 0;
    return this.hp.get(id) ?? CHUNK_HP;
  }

  /**
   * A blast: every standing chunk within `radius` of `pos` (point-to-box,
   * torus-correct) takes `amount`, falling off linearly to 0 at the radius.
   * Returns the ids it destroyed, in deterministic order.
   */
  damageAt(pos: Vec3, radius: number, amount: number): number[] {
    const buildings = this.buildings;
    if (!buildings || !(radius > 0)) return [];
    const out: number[] = [];
    const box: LocalBox = { x0: 0, x1: 0, y0: 0, y1: 0, z0: 0, z1: 0 };
    for (let i = 0; i < buildings.length; i++) {
      const b = buildings[i] as Building;
      const d = wrapDelta({ x: b.x, y: 0, z: b.z }, pos);
      if (
        Math.abs(d.x) > b.width / 2 + radius ||
        Math.abs(d.z) > b.depth / 2 + radius ||
        pos.y - radius > b.height
      ) {
        continue;
      }
      const local = { x: d.x, y: pos.y, z: d.z };
      const grids = tierGrids(b);
      const masks = chunkMask(b);
      for (let k = 0; k < grids.length; k++) {
        const g = grids[k] as TierGrid;
        const mask = masks[k] as Uint8Array;
        for (let c = 0; c < mask.length; c++) {
          if (!mask[c]) continue;
          const dist = boxDistance(local, cellBox(g, c, box));
          if (dist > radius) continue;
          const id = chunkId(i, k, c);
          if (this.damageChunk(id, amount * (1 - dist / radius))) out.push(id);
        }
      }
    }
    return out;
  }

  /**
   * D5 rebuild: building `index` is whole again. Every broken or fallen
   * chunk of it is restored, its partial HP forgotten and its not-yet-sent
   * breaks dropped (so no later `chunks` batch names a chunk that is back),
   * and its Building's `damage` record cleared — solids(b) is the generated
   * base boxes again. Works before bind (bare ids filtered by building).
   * Returns the restored ids, ascending. The caller drops the building's
   * collapse records (CollapseField.removeBuilding) in the same step.
   */
  restoreBuilding(index: number): number[] {
    const out: number[] = [];
    for (const set of [this.destroyed, this.fallen]) {
      for (const id of [...set]) {
        if (chunkBuilding(id) !== index) continue;
        set.delete(id);
        out.push(id);
      }
    }
    let changed = out.length > 0;
    for (const id of [...this.hp.keys()]) {
      if (chunkBuilding(id) !== index) continue;
      this.hp.delete(id);
      changed = true;
    }
    this.pending = this.pending.filter((id) => chunkBuilding(id) !== index);
    const b = this.buildings?.[index];
    if (b?.damage) {
      b.damage = undefined;
      changed = true;
    }
    if (b) syncRoof(b);
    if (changed) this.version++;
    return out.sort((a, c) => a - c);
  }

  /**
   * D5: how worn each damaged building is, in chunks — its gone chunks
   * plus the HP its standing chunks have lost, in chunks' worth — and that
   * as a share of its chunk count. Buildings with no damage at all are
   * absent. One pass over the state.
   */
  wear(): Map<number, { lost: number; share: number }> {
    const lost = new Map<number, number>();
    const add = (id: number, v: number) => {
      const b = chunkBuilding(id);
      lost.set(b, (lost.get(b) ?? 0) + v);
    };
    for (const id of this.destroyed) add(id, 1);
    for (const id of this.fallen) add(id, 1);
    for (const [id, hp] of this.hp) add(id, 1 - hp / CHUNK_HP);
    const out = new Map<number, { lost: number; share: number }>();
    const buildings = this.buildings;
    if (!buildings) return out;
    for (const [i, v] of lost) {
      const b = buildings[i];
      if (!b) continue;
      let n = 0;
      for (const mask of chunkMask(b)) for (const m of mask) n += m;
      if (n > 0) out.set(i, { lost: v, share: Math.min(1, v / n) });
    }
    return out;
  }

  /** D8: bring the touched buildings' roof structures up to their cells. */
  private flushRoofs(): void {
    const buildings = this.buildings;
    if (!buildings) return;
    for (const i of this.roofDirty) syncRoof(buildings[i] as Building);
    this.roofDirty.clear();
  }

  /** D8: every building's roof from scratch (bind / reset cleared all). */
  private syncAllRoofs(): void {
    this.roofDirty.clear();
    for (const b of this.buildings ?? []) syncRoof(b);
  }

  /** Record `id` as gone (`kind`) and write it through to its building. */
  private mark(id: number, kind: number): void {
    (kind === CELL_FALLEN ? this.fallen : this.destroyed).add(id);
    if (this.buildings) this.writeCell(id, kind);
  }

  /** Write one gone cell through to its building's damage record. */
  private writeCell(id: number, kind: number): void {
    const buildings = this.buildings as readonly Building[];
    const index = chunkBuilding(id);
    const b = buildings[index] as Building;
    let dmg = b.damage;
    if (!dmg) {
      const faces = this.openFaces as Int8Array;
      if ((faces[index] as number) < 0) {
        faces[index] = openFacesOf(buildings, index);
      }
      dmg = {
        index,
        cells: tierGrids(b).map((g) => new Uint8Array(g.nx * g.ny * g.nz)),
        count: 0,
        version: 0,
        openFaces: faces[index] as number,
      };
      b.damage = dmg;
    }
    const cells = dmg.cells[chunkTier(id)] as Uint8Array;
    if (!cells[chunkCell(id)]) dmg.count++;
    cells[chunkCell(id)] = kind;
    dmg.version = ++damageVersion;
    this.roofDirty.add(index);
  }
}

// --- Rays -----------------------------------------------------------------

/** The first thing a ray meets in the city. */
export interface RayHit {
  /** Index of the building hit. */
  building: number;
  /** Distance along the ray, meters. */
  t: number;
  /** The chunk hit, or -1 when the ray stopped on rubble or a roof structure. */
  chunk: number;
  /** D9: the R2 roof structure hit, as an index into generatedRoof(b) (so
   * it names the same structure on every machine), or -1. */
  roof: number;
}

/** Slab-clip entry distance of the ray (origin 0, unit `dir`) into a box in
 * the ray's frame, or -1 for a miss within [0, range] (or a box the ray only
 * touches as it leaves). */
function rayEntry(
  dir: Vec3,
  range: number,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  z0: number,
  z1: number,
): number {
  let t0 = 0;
  let t1 = range;
  for (let axis = 0; axis < 3; axis++) {
    const dv = axis === 0 ? dir.x : axis === 1 ? dir.y : dir.z;
    const lo = axis === 0 ? x0 : axis === 1 ? y0 : z0;
    const hi = axis === 0 ? x1 : axis === 1 ? y1 : z1;
    if (dv === 0) {
      if (lo > 0 || hi < 0) return -1;
      continue;
    }
    const a = lo / dv;
    const b = hi / dv;
    t0 = Math.max(t0, Math.min(a, b));
    t1 = Math.min(t1, Math.max(a, b));
    if (t0 > t1) return -1;
  }
  // A ray starting on a face and leaving the box at once (a plane hugging a
  // wall, firing away from it) does not hit that box.
  return t1 <= 1e-6 ? -1 : t0;
}

/**
 * Cast a bullet ray from `from` along unit `dir` for `range` meters through
 * the city as it stands (destroyed chunks are gone). It stops on chunk
 * solids, rubble and roof structures (round ones as their bounding box);
 * trees and the river are ignored. Torus-correct: each building enters the
 * ray's frame through wrapDelta, exact for range < WORLD_SIZE / 2.
 */
export function raycastChunk(
  buildings: readonly Building[],
  from: Vec3,
  dir: Vec3,
  range: number,
): RayHit | null {
  let best: RayHit | null = null;
  let bestT = range;
  let bestLocal: Vec3 | null = null;
  for (let i = 0; i < buildings.length; i++) {
    const b = buildings[i] as Building;
    const c = wrapDelta(from, { x: b.x, y: 0, z: b.z });
    const reach = b.damage ? RUBBLE_REACH : 0;
    const top = b.height + (b.roof ? ROOF_STRUCTURE_MAX_HEIGHT : 0);
    if (
      rayEntry(
        dir,
        bestT,
        c.x - b.width / 2 - reach,
        c.x + b.width / 2 + reach,
        -from.y,
        top - from.y,
        c.z - b.depth / 2 - reach,
        c.z + b.depth / 2 + reach,
      ) < 0
    ) {
      continue;
    }
    const consider = (
      dx: number,
      dz: number,
      baseY: number,
      w: number,
      h: number,
      d: number,
      isChunkBox: boolean,
      roofIndex: number,
    ) => {
      const t = rayEntry(
        dir,
        bestT,
        c.x + dx - w / 2,
        c.x + dx + w / 2,
        baseY - from.y,
        baseY + h - from.y,
        c.z + dz - d / 2,
        c.z + dz + d / 2,
      );
      if (t < 0 || t >= bestT) return;
      bestT = t;
      best = { building: i, t, chunk: -1, roof: roofIndex };
      // 1 cm past the face, in the building's frame, to find the cell.
      bestLocal = isChunkBox
        ? {
            x: dir.x * (t + 0.01) - c.x,
            y: from.y + dir.y * (t + 0.01),
            z: dir.z * (t + 0.01) - c.z,
          }
        : null;
    };
    for (const s of solids(b)) {
      consider(
        s.dx,
        s.dz,
        s.baseY,
        s.width,
        s.height,
        s.depth,
        (s.cut & CUT_RUBBLE) === 0,
        -1,
      );
    }
    if (b.roof) {
      const gen = generatedRoof(b) ?? b.roof;
      for (const r of b.roof) {
        consider(
          r.dx,
          r.dz,
          r.baseY,
          r.width,
          r.height,
          r.depth,
          false,
          gen.indexOf(r),
        );
      }
    }
  }
  const hit = best as RayHit | null;
  const local = bestLocal as Vec3 | null;
  if (hit && local) {
    const b = buildings[hit.building] as Building;
    const at = chunkAt(b, local);
    if (at && chunkMask(b)[at.tier]?.[at.cell] === 1) {
      const gone = (b.damage?.cells[at.tier]?.[at.cell] ?? 0) !== 0;
      if (!gone) hit.chunk = chunkId(hit.building, at.tier, at.cell);
    }
  }
  return hit;
}

// --- Wire -----------------------------------------------------------------

/** Ascending ids as first-then-gaps: small numbers, short JSON. */
export function encodeChunkIds(ids: readonly number[]): number[] {
  const sorted = [...ids].sort((a, b) => a - b);
  return sorted.map((id, i) => (i === 0 ? id : id - (sorted[i - 1] as number)));
}

/** Inverse of encodeChunkIds; a malformed list decodes to []. */
export function decodeChunkIds(wire: unknown): number[] {
  if (!Array.isArray(wire)) return [];
  const out: number[] = [];
  let acc = 0;
  for (const v of wire) {
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) return [];
    acc += v;
    out.push(acc);
  }
  return out;
}
