// DS1 the structural model — every building as a FRAME, shared verbatim by
// the host (planner, sweep, debris physics) and the page (tests, the lab).
//
// D2 cut a tier into chunks (~20 m bays × 12 m floor bands); DS1 keeps that
// grid as the frame's bays — a chunk id still names one bay, so the damage
// wire, holes and solids() are untouched — and fills each bay with what a
// real building has there:
//
//   - FLOOR SLABS: one per storey (~COLLAPSE_SLAB_STOREY), the floor plate
//     and the storey it carries, inset behind the facade;
//   - FACADE PANELS: one per storey on each face of the bay that lies on the
//     tier's outline, COLLAPSE_SHEET_THICK deep, of the building's facade
//     material (glass curtain wall, punched masonry, strip-window office);
//   - COLUMNS: one per floor band at every bay-grid intersection, embedded in
//     the slabs (perimeter ones just inside the panels).
//
// Slabs and panels PARTITION the building's generated solids (every hole-
// split box of every bay): the standing frame is exactly the box the
// renderer draws and collision tests, so nothing changes until it breaks.
//
// Load: a column stands while at least half the bays it is embedded in still
// stand (a bay shot out takes its slab and panels; the steel at its corners
// survives until most of what braces it is gone). A floor band whose
// standing columns fall under `strength` of its columns fails, and what is
// above loses its support. WHERE they failed decides how it comes down: the
// surviving columns' centroid off to one side → the section leans over the
// line of the last standing columns (a hinge), centred → it pancakes.
//
// Pure in the building's generated shape (and the standing mask passed in),
// cached per Building. Not re-exported from city/index.ts; import
// "@angels-bandits/common/city/structure".

import {
  COLLAPSE_COLUMN_SIDE,
  COLLAPSE_SHEET_THICK,
  COLLAPSE_SLAB_STOREY,
  LANDMARK_HEIGHT,
} from "../constants";
import { FacadeArchetype, archetypeFor } from "./archetype";
import {
  type LocalBox,
  type TierGrid,
  cellIndex,
  cellSolids,
  chunkMask,
  tierGrids,
} from "./destruction";
import type { Building } from "./index";

/** Element kinds. */
export const EL_SLAB = 0;
export const EL_PANEL = 1;
export const EL_COLUMN = 2;

/** Materials: the three facade archetypes' panels (their ids), then the
 * slabs' concrete and the columns' steel. DS2 reads these per piece. */
export const MAT_GLASS = FacadeArchetype.GLASS;
export const MAT_MASONRY = FacadeArchetype.MASONRY;
export const MAT_OFFICE = FacadeArchetype.OFFICE;
export const MAT_CONCRETE = 3;
export const MAT_STEEL = 4;

/** Effective density of each material's element, kg/m³ of the element's
 * box (a storey slab is mostly the air of its storey; a panel is glass and
 * mullions, or brick, over its whole depth). Physics mass, never visuals. */
export const MATERIAL_DENSITY: readonly number[] = [260, 900, 600, 240, 1500];

/** What breaking 1 m³ of each material costs a penetrating body, relative to
 * the D2 chunk average (P1's sweep): glass gives, masonry and steel resist. */
export const MATERIAL_RESIST: readonly number[] = [0.35, 1.7, 1.1, 0.9, 3.2];

/** Faces, D2's / collapse.ts's DIR_* order: −x, +x, −z, +z. */
export const FACE_NEG_X = 0;
export const FACE_POS_X = 1;
export const FACE_NEG_Z = 2;
export const FACE_POS_Z = 3;

/** Panel depth and storey height, m (the D10 sheet and slab). */
export const PANEL_THICK = COLLAPSE_SHEET_THICK;
export const STOREY = COLLAPSE_SLAB_STOREY;
/** A box narrower than this along an axis carries no panels across it (it
 * would be all facade). */
const PANEL_MIN_SPAN = 2 * PANEL_THICK + 2;

/** One structural element, in its building's frame (x/z from the centre,
 * y from the ground). */
export interface FrameElement {
  kind: number;
  tier: number;
  /** The bay (chunk cell) it belongs to; a column: the first of `cells`. */
  cell: number;
  /** Storey within its bay's band (slabs and panels); −1 for a column. */
  storey: number;
  /** Which of its bay's solids (cellSolids order) it was cut from; a hole
   * splits a bay into up to three. 0 for a column. */
  part: number;
  /** FACE_* of a panel; −1 otherwise. */
  face: number;
  material: number;
  box: LocalBox;
}

/** A column: an element plus the bays it is embedded in. */
export interface FrameColumn extends FrameElement {
  /** Floor band (the chunk grid's iy). */
  band: number;
  /** Bay-grid intersection. */
  ix: number;
  iz: number;
  /** The existing bays around it, in its band (1–4 cells). */
  cells: number[];
}

export interface TierFrame {
  grid: TierGrid;
  /** Storeys per floor band. */
  storeys: number;
  /** Per cell: the indices into `elements` of its slabs and panels. */
  byCell: number[][];
  /** Per band: its columns. */
  columns: FrameColumn[][];
}

export interface BuildingFrame {
  /** The facade material (MAT_GLASS / MAT_MASONRY / MAT_OFFICE). */
  material: number;
  /** Every slab and panel. */
  elements: FrameElement[];
  tiers: TierFrame[];
}

const frameCache = new WeakMap<Building, BuildingFrame>();

/** Building `b` as a frame (cached; pure in its generated shape). */
export function buildingFrame(b: Building): BuildingFrame {
  let frame = frameCache.get(b);
  if (!frame) {
    frame = makeFrame(b);
    frameCache.set(b, frame);
  }
  return frame;
}

const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;

function makeFrame(b: Building): BuildingFrame {
  const material = archetypeFor(b);
  const elements: FrameElement[] = [];
  const grids = tierGrids(b);
  const masks = chunkMask(b);
  const tiers: TierFrame[] = grids.map((g, k) => {
    const mask = masks[k] as Uint8Array;
    const storeys = Math.max(1, Math.round(g.ch / STOREY));
    const byCell: number[][] = [];
    for (let c = 0; c < mask.length; c++) {
      const list: number[] = [];
      byCell.push(list);
      if (!mask[c]) continue;
      const solids = cellSolids(b, k, c);
      for (let part = 0; part < solids.length; part++) {
        const s = solids[part] as (typeof solids)[number];
        bayElements(
          g,
          k,
          c,
          part,
          {
            x0: s.dx - s.width / 2,
            x1: s.dx + s.width / 2,
            y0: s.baseY,
            y1: s.baseY + s.height,
            z0: s.dz - s.depth / 2,
            z1: s.dz + s.depth / 2,
          },
          storeys,
          material,
          elements,
          list,
        );
      }
    }
    return { grid: g, storeys, byCell, columns: columnsOf(b, g, k, mask) };
  });
  return { material, elements, tiers };
}

/** One solid box of bay `cell`: its outline faces as panels per storey,
 * the rest as storey slabs — together exactly the box. */
function bayElements(
  g: TierGrid,
  tier: number,
  cell: number,
  part: number,
  s: LocalBox,
  storeys: number,
  material: number,
  out: FrameElement[],
  list: number[],
): void {
  const wide = s.x1 - s.x0 >= PANEL_MIN_SPAN;
  const deep = s.z1 - s.z0 >= PANEL_MIN_SPAN;
  const onNegX = deep && near(s.x0, -g.width / 2);
  const onPosX = deep && near(s.x1, g.width / 2);
  const onNegZ = wide && near(s.z0, -g.depth / 2);
  const onPosZ = wide && near(s.z1, g.depth / 2);
  // A thin box split into storeys would be slivers: it gets its own count.
  const h = s.y1 - s.y0;
  const n = Math.max(1, Math.min(storeys, Math.round(h / STOREY)));
  // The x-faces' panels run the box's full depth; the z-faces' panels fit
  // between them; the slab is what is left inside.
  const ix0 = onNegX ? s.x0 + PANEL_THICK : s.x0;
  const ix1 = onPosX ? s.x1 - PANEL_THICK : s.x1;
  const iz0 = onNegZ ? s.z0 + PANEL_THICK : s.z0;
  const iz1 = onPosZ ? s.z1 - PANEL_THICK : s.z1;
  const push = (el: FrameElement) => {
    list.push(out.length);
    out.push(el);
  };
  for (let j = 0; j < n; j++) {
    const y0 = s.y0 + (h * j) / n;
    const y1 = j === n - 1 ? s.y1 : s.y0 + (h * (j + 1)) / n;
    const panel = (face: number, box: LocalBox) =>
      push({
        kind: EL_PANEL,
        tier,
        cell,
        storey: j,
        part,
        face,
        material,
        box,
      });
    if (onNegX)
      panel(FACE_NEG_X, { x0: s.x0, x1: ix0, y0, y1, z0: s.z0, z1: s.z1 });
    if (onPosX)
      panel(FACE_POS_X, { x0: ix1, x1: s.x1, y0, y1, z0: s.z0, z1: s.z1 });
    if (onNegZ)
      panel(FACE_NEG_Z, { x0: ix0, x1: ix1, y0, y1, z0: s.z0, z1: iz0 });
    if (onPosZ)
      panel(FACE_POS_Z, { x0: ix0, x1: ix1, y0, y1, z0: iz1, z1: s.z1 });
    push({
      kind: EL_SLAB,
      tier,
      cell,
      storey: j,
      part,
      face: -1,
      material: MAT_CONCRETE,
      box: { x0: ix0, x1: ix1, y0, y1, z0: iz0, z1: iz1 },
    });
  }
}

/** Every column of tier `k`, per floor band: one at each bay-grid
 * intersection that some existing bay of the band touches, clamped inside
 * the tier's panels. */
function columnsOf(
  b: Building,
  g: TierGrid,
  k: number,
  mask: Uint8Array,
): FrameColumn[][] {
  const out: FrameColumn[][] = [];
  const side = COLLAPSE_COLUMN_SIDE;
  const inset = PANEL_THICK + side / 2;
  const holed = (b.holes?.length ?? 0) > 0;
  for (let iy = 0; iy < g.ny; iy++) {
    const band: FrameColumn[] = [];
    const y0 = g.baseY + iy * g.ch;
    const y1 = iy === g.ny - 1 ? g.baseY + g.height : y0 + g.ch;
    for (let iz = 0; iz <= g.nz; iz++) {
      for (let ix = 0; ix <= g.nx; ix++) {
        const cells: number[] = [];
        for (let dz = -1; dz <= 0; dz++) {
          for (let dx = -1; dx <= 0; dx++) {
            const cx = ix + dx;
            const cz = iz + dz;
            if (cx < 0 || cx >= g.nx || cz < 0 || cz >= g.nz) continue;
            const c = cellIndex(g, cx, iy, cz);
            if (mask[c]) cells.push(c);
          }
        }
        if (cells.length === 0) continue;
        const x = Math.min(
          g.width / 2 - inset,
          Math.max(-g.width / 2 + inset, -g.width / 2 + ix * g.cw),
        );
        const z = Math.min(
          g.depth / 2 - inset,
          Math.max(-g.depth / 2 + inset, -g.depth / 2 + iz * g.cd),
        );
        // A column never stands in hole air (a tunnel through the bay).
        if (holed && !insideSolids(b, k, cells, x, (y0 + y1) / 2, z)) {
          continue;
        }
        band.push({
          kind: EL_COLUMN,
          tier: k,
          cell: cells[0] as number,
          storey: -1,
          part: 0,
          face: -1,
          material: MAT_STEEL,
          box: {
            x0: x - side / 2,
            x1: x + side / 2,
            y0,
            y1,
            z0: z - side / 2,
            z1: z + side / 2,
          },
          band: iy,
          ix,
          iz,
          cells,
        });
      }
    }
    out.push(band);
  }
  return out;
}

function insideSolids(
  b: Building,
  tier: number,
  cells: readonly number[],
  x: number,
  y: number,
  z: number,
): boolean {
  for (const c of cells) {
    for (const s of cellSolids(b, tier, c)) {
      if (
        Math.abs(x - s.dx) <= s.width / 2 + 1e-6 &&
        Math.abs(z - s.dz) <= s.depth / 2 + 1e-6 &&
        y >= s.baseY - 1e-6 &&
        y <= s.baseY + s.height + 1e-6
      ) {
        return true;
      }
    }
  }
  return false;
}

// --- Load ---------------------------------------------------------------------

/** Does `col` still stand, given per-tier standing bays? At least half the
 * bays it is embedded in must stand. */
export function columnStands(
  col: FrameColumn,
  standing: readonly Uint8Array[],
): boolean {
  const st = standing[col.tier] as Uint8Array;
  let up = 0;
  for (const c of col.cells) up += st[c] ? 1 : 0;
  return up > 0 && 2 * up >= col.cells.length;
}

/** One floor band's columns under a standing mask: how many there are and
 * stand, both centroids (plan, building frame), and the standing columns'
 * plan extent. */
export interface FloorLoad {
  tier: number;
  band: number;
  total: number;
  up: number;
  /** Centroid of every column, and of the standing ones (NaN when none). */
  ax: number;
  az: number;
  sx: number;
  sz: number;
  /** The standing columns' extent (NaN when none). */
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/** The load picture of floor band `band` of tier `tier`. */
export function floorLoad(
  frame: BuildingFrame,
  standing: readonly Uint8Array[],
  tier: number,
  band: number,
): FloorLoad {
  const cols = frame.tiers[tier]?.columns[band] ?? [];
  let ax = 0;
  let az = 0;
  let sx = 0;
  let sz = 0;
  let up = 0;
  let minX = Number.NaN;
  let maxX = Number.NaN;
  let minZ = Number.NaN;
  let maxZ = Number.NaN;
  for (const col of cols) {
    const x = (col.box.x0 + col.box.x1) / 2;
    const z = (col.box.z0 + col.box.z1) / 2;
    ax += x;
    az += z;
    if (!columnStands(col, standing)) continue;
    sx += x;
    sz += z;
    up++;
    if (!(x >= minX)) minX = x;
    if (!(x <= maxX)) maxX = x;
    if (!(z >= minZ)) minZ = z;
    if (!(z <= maxZ)) maxZ = z;
  }
  const n = cols.length;
  return {
    tier,
    band,
    total: n,
    up,
    ax: n > 0 ? ax / n : 0,
    az: n > 0 ? az / n : 0,
    sx: up > 0 ? sx / up : Number.NaN,
    sz: up > 0 ? sz / up : Number.NaN,
    minX,
    maxX,
    minZ,
    maxZ,
  };
}

/** Is anything standing above band `band` of tier `tier`? */
function standingAbove(
  standing: readonly Uint8Array[],
  grids: readonly TierGrid[],
  tier: number,
  band: number,
): boolean {
  const g = grids[tier] as TierGrid;
  const st = standing[tier] as Uint8Array;
  for (let c = (band + 1) * g.nx * g.nz; c < st.length; c++) {
    if (st[c]) return true;
  }
  for (let k = tier + 1; k < standing.length; k++) {
    if ((standing[k] as Uint8Array).includes(1)) return true;
  }
  return false;
}

/**
 * The lowest floor band whose standing columns are under `strength` of its
 * columns, with something still standing above it — the floor that gives —
 * or null when every loaded floor holds.
 */
export function failingFloor(
  b: Building,
  standing: readonly Uint8Array[],
  strength: number,
): { tier: number; band: number } | null {
  const frame = buildingFrame(b);
  const grids = tierGrids(b);
  for (let k = 0; k < frame.tiers.length; k++) {
    const tf = frame.tiers[k] as TierFrame;
    for (let iy = 0; iy < tf.columns.length; iy++) {
      const load = floorLoad(frame, standing, k, iy);
      if (load.total === 0 || load.up >= strength * load.total) continue;
      if (standingAbove(standing, grids, k, iy)) return { tier: k, band: iy };
    }
  }
  return null;
}

/**
 * How the section over a failed floor comes down: off-centre surviving
 * columns (offset over `threshold` of the tier's side) → it leans toward the
 * failed side, FACE_* returned; centred, or none left → −1 (a pancake).
 */
export function leanDir(
  load: FloorLoad,
  g: TierGrid,
  threshold: number,
): number {
  if (load.up === 0) return -1;
  const ox = (load.ax - load.sx) / g.width;
  const oz = (load.az - load.sz) / g.depth;
  if (Math.max(Math.abs(ox), Math.abs(oz)) < threshold) return -1;
  if (Math.abs(ox) >= Math.abs(oz)) return ox > 0 ? FACE_POS_X : FACE_NEG_X;
  return oz > 0 ? FACE_POS_Z : FACE_NEG_Z;
}

/**
 * The hinge a section leaning toward `dir` turns about: the line of the
 * last standing columns on that side, in the floor band just under height
 * `y` (the failure height). Returns the hinge's coordinate along the lean
 * axis (x for ±x, z for ±z) in the building's frame, or NaN when nothing
 * stands under `y` (the section has nothing to lean on).
 */
export function hingeLine(
  b: Building,
  standing: readonly Uint8Array[],
  y: number,
  dir: number,
): number {
  const frame = buildingFrame(b);
  const grids = tierGrids(b);
  for (let k = grids.length - 1; k >= 0; k--) {
    const g = grids[k] as TierGrid;
    if (y <= g.baseY + 1e-6 || y > g.baseY + g.height + 1e-6) continue;
    const band = Math.min(
      g.ny - 1,
      Math.max(0, Math.ceil((y - g.baseY) / g.ch) - 1),
    );
    const load = floorLoad(frame, standing, k, band);
    if (load.up === 0) return Number.NaN;
    if (dir === FACE_POS_X) return load.maxX;
    if (dir === FACE_NEG_X) return load.minX;
    if (dir === FACE_POS_Z) return load.maxZ;
    return load.minZ;
  }
  return Number.NaN;
}

// --- Resistance (P1) ------------------------------------------------------------

/** A landmark's steel frame costs this much more to break through (P1's
 * SWEEP_LANDMARK_HARDNESS). */
export const LANDMARK_HARDNESS = 1.6;

const resistCache = new WeakMap<Building, Float32Array[]>();

/**
 * How hard bay `cell` of tier `tier` is to break through, relative to D2's
 * flat chunk (≈ 1 on an average bay): its slabs, panels and columns, each
 * weighed by its material's MATERIAL_RESIST, over the bay's volume — a
 * glass curtain wall gives, a brick one and a column line resist. A
 * landmark's steel frame is harder still (P1's hardness, kept).
 */
export function bayResistance(b: Building, tier: number, cell: number): number {
  let per = resistCache.get(b);
  if (!per) {
    per = resistOf(b);
    resistCache.set(b, per);
  }
  return (per[tier]?.[cell] as number | undefined) ?? 1;
}

/** Normaliser: a bay's weighted volume over its own is ≈ this on the seed
 * city's average bay, so the sweep's mean cost is D2's. */
const RESIST_NORM = 0.961;

function resistOf(b: Building): Float32Array[] {
  const frame = buildingFrame(b);
  const hard = b.height >= LANDMARK_HEIGHT ? LANDMARK_HARDNESS : 1;
  return frame.tiers.map((tf) => {
    const g = tf.grid;
    const out = new Float32Array(g.nx * g.ny * g.nz).fill(1);
    const colVol = new Float64Array(out.length);
    for (const band of tf.columns) {
      for (const col of band) {
        const v = volume(col.box) / col.cells.length;
        for (const c of col.cells) colVol[c] = (colVol[c] as number) + v;
      }
    }
    for (let c = 0; c < out.length; c++) {
      const list = tf.byCell[c] as number[];
      if (list.length === 0) continue;
      let vol = 0;
      let w = 0;
      for (const e of list) {
        const el = frame.elements[e] as FrameElement;
        const v = volume(el.box);
        vol += v;
        w += v * (MATERIAL_RESIST[el.material] as number);
      }
      const cv = colVol[c] as number;
      w += cv * ((MATERIAL_RESIST[MAT_STEEL] as number) - 1);
      out[c] = vol > 0 ? (hard * w) / vol / RESIST_NORM : 1;
    }
    return out;
  });
}

export const volume = (b: LocalBox): number =>
  (b.x1 - b.x0) * (b.y1 - b.y0) * (b.z1 - b.z0);
