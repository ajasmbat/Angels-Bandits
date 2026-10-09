// D8 what still stands — the one seam every per-building layer asks before
// it draws something on, in front of or above a building. Shared verbatim by
// client and server, pure in (shape, damage).
//
// A building is generated once and its decoration (signs, balconies, roof
// clutter, tanks, searchlights, scaffolding…) is laid out against that
// shape. D2/D3 then take chunks away. Anything laid out against a chunk that
// is gone would hang in the air where the tower was — the "skeleton" D8
// fixes. So every layer filters its items through `decorStands`, keyed on
// the building's damage version, and the R2 roof structures (which are
// SOLID) follow the stump through `syncRoof`.
//
// The test is on D2's chunk grid, not on solids(): a few lookups per sample
// instead of a pass over a chewed building's boxes. A chunk cell is the same
// volume solids() keeps (cells are clipped to the tier's hole-split boxes),
// so the two agree to within the hole cut-outs — which only ever make the
// grid MORE permissive inside a hole, never above a gone floor.

import {
  type LocalBox,
  type TierGrid,
  chunkMask,
  tierGrids,
} from "./destruction";
import type { Building } from "./index";
import type { RoofStructure } from "./roof-structures";

/** How far an item may stand proud of its facade (a sign, a balcony, an
 * awning's anchor), m: a sample outside a tier's footprint by at most this
 * is clamped onto the footprint and asks the cell it lands in. */
export const STAND_OUT = 3;
/** Slack around a standing cell, m (a sill sits on a floor line, a lip
 * sinks into the deck). */
export const STAND_EPS = 0.5;
/** How high above an ORIGINAL deck (a roof or setback terrace that still
 * stands) an item may rise, m: roof clutter, masts, rooftop life, beacons. */
export const STAND_ROOF_RISE = 20;
/** Sample spacing along a decoration box, m — finer than a chunk (≥ 12 m),
 * so a box that spans a gone cell has a sample inside it. */
const SAMPLE_STEP = 6;

/** Does cell (ix, iy, iz) of tier `k` still hold something to stand on? A
 * chunk that is not gone does; a pure hole-air cell does while the lintel
 * above it or a same-band neighbour stands (hole lining hangs off those). */
function cellStands(
  b: Building,
  masks: readonly Uint8Array[],
  g: TierGrid,
  k: number,
  ix: number,
  iy: number,
  iz: number,
): boolean {
  const mask = masks[k] as Uint8Array;
  const gone = b.damage?.cells[k];
  const at = (jx: number, jy: number, jz: number): boolean => {
    if (jx < 0 || jx >= g.nx || jy < 0 || jy >= g.ny || jz < 0 || jz >= g.nz)
      return false;
    const c = (jy * g.nz + jz) * g.nx + jx;
    return mask[c] === 1 && !gone?.[c];
  };
  const c = (iy * g.nz + iz) * g.nx + ix;
  if (mask[c] === 1) return !gone?.[c];
  return (
    at(ix, iy + 1, iz) ||
    at(ix - 1, iy, iz) ||
    at(ix + 1, iy, iz) ||
    at(ix, iy, iz - 1) ||
    at(ix, iy, iz + 1)
  );
}

const clampI = (v: number, n: number): number =>
  Math.min(n - 1, Math.max(0, Math.floor(v)));

/**
 * Does the point (x, y, z) — in `b`'s frame: x/z from its centre, y from the
 * ground — still have building under it? True when it lies in a standing
 * cell (± STAND_EPS), proud of a standing facade by ≤ STAND_OUT, or up to
 * STAND_ROOF_RISE over a standing cell of an original deck (a tier's top
 * band where no higher tier covers it). Intact buildings: always true.
 */
export function pointStands(
  b: Building,
  x: number,
  y: number,
  z: number,
): boolean {
  if (!b.damage) return true;
  const grids = tierGrids(b);
  const masks = chunkMask(b);
  for (let k = 0; k < grids.length; k++) {
    const g = grids[k] as TierGrid;
    const hw = g.width / 2;
    const hd = g.depth / 2;
    if (Math.abs(x) - hw > STAND_OUT || Math.abs(z) - hd > STAND_OUT) continue;
    const top = g.baseY + g.height;
    if (y < g.baseY - STAND_EPS) continue;
    // Clamped onto the footprint (a protruding sample asks its facade cell).
    const cx = Math.max(-hw, Math.min(hw, x)) + hw;
    const cz = Math.max(-hd, Math.min(hd, z)) + hd;
    const x0 = clampI((cx - STAND_EPS) / g.cw, g.nx);
    const x1 = clampI((cx + STAND_EPS) / g.cw, g.nx);
    const z0 = clampI((cz - STAND_EPS) / g.cd, g.nz);
    const z1 = clampI((cz + STAND_EPS) / g.cd, g.nz);
    if (y <= top + STAND_EPS) {
      const y0 = clampI((y - g.baseY - STAND_EPS) / g.ch, g.ny);
      const y1 = clampI((y - g.baseY + STAND_EPS) / g.ch, g.ny);
      for (let iy = y0; iy <= y1; iy++)
        for (let iz = z0; iz <= z1; iz++)
          for (let ix = x0; ix <= x1; ix++)
            if (cellStands(b, masks, g, k, ix, iy, iz)) return true;
      continue;
    }
    if (y > top + STAND_ROOF_RISE) continue;
    // Over the deck: only where it is an ORIGINAL deck — the top tier's
    // roof, or a setback terrace outside the next tier's footprint.
    const up = grids[k + 1];
    if (
      up &&
      Math.abs(x) < up.width / 2 + STAND_EPS &&
      Math.abs(z) < up.depth / 2 + STAND_EPS
    )
      continue;
    for (let iz = z0; iz <= z1; iz++)
      for (let ix = x0; ix <= x1; ix++)
        if (cellStands(b, masks, g, k, ix, g.ny - 1, iz)) return true;
  }
  return false;
}

/** Sample coordinates along [a0, a1]: both ends and every ≤ SAMPLE_STEP. */
function samples(a0: number, a1: number, out: number[]): number[] {
  out.length = 0;
  const n = Math.max(1, Math.ceil((a1 - a0) / SAMPLE_STEP));
  for (let i = 0; i <= n; i++) out.push(a0 + ((a1 - a0) * i) / n);
  return out;
}
const sx: number[] = [];
const sy: number[] = [];
const sz: number[] = [];

/**
 * Does a decoration occupying `box` (in `b`'s frame) still stand? Every
 * sample of the box — its corners, and every ≤ 6 m along each edge and
 * through it — must pass pointStands. An intact building keeps everything.
 */
export function decorStands(b: Building, box: LocalBox): boolean {
  if (!b.damage) return true;
  samples(box.x0, box.x1, sx);
  samples(box.y0, box.y1, sy);
  samples(box.z0, box.z1, sz);
  for (const y of sy)
    for (const z of sz)
      for (const x of sx) if (!pointStands(b, x, y, z)) return false;
  return true;
}

// --- The standing profile -------------------------------------------------

/** What of a building still stands, for layers that size themselves to it. */
export interface StandingProfile {
  /** The damage version this was taken at (0 = intact). */
  readonly version: number;
  readonly intact: boolean;
  /** The highest standing top, m (b.height intact, 0 when nothing stands). */
  readonly top: number;
  /** Tier 0, per column (ix + iz·nx): the height standing CONTIGUOUSLY from
   * the ground, m — what a scaffold or a crane can stand against. */
  readonly stump: Float64Array;
}

const profileCache = new WeakMap<Building, StandingProfile>();

/** `b`'s standing profile, cached on its damage version. */
export function standingProfile(b: Building): StandingProfile {
  const version = b.damage?.version ?? 0;
  const hit = profileCache.get(b);
  if (hit && hit.version === version) return hit;
  const grids = tierGrids(b);
  const masks = chunkMask(b);
  const g0 = grids[0];
  const stump = new Float64Array(g0 ? g0.nx * g0.nz : 0);
  let top = 0;
  if (!b.damage) {
    top = b.height;
    if (g0) stump.fill(g0.height);
  } else {
    const gone = b.damage.cells;
    grids.forEach((g, k) => {
      const mask = masks[k] as Uint8Array;
      const cells = gone[k];
      for (let c = 0; c < mask.length; c++) {
        if (!mask[c] || cells?.[c]) continue;
        const iy = Math.floor(c / (g.nx * g.nz));
        top = Math.max(
          top,
          iy + 1 >= g.ny ? g.baseY + g.height : g.baseY + (iy + 1) * g.ch,
        );
      }
    });
    if (g0) {
      for (let iz = 0; iz < g0.nz; iz++) {
        for (let ix = 0; ix < g0.nx; ix++) {
          let iy = 0;
          while (iy < g0.ny && cellStands(b, masks, g0, 0, ix, iy, iz)) iy++;
          stump[iz * g0.nx + ix] = iy >= g0.ny ? g0.height : iy * g0.ch;
        }
      }
    }
  }
  const p: StandingProfile = { version, intact: !b.damage, top, stump };
  profileCache.set(b, p);
  return p;
}

/**
 * The highest standing top over (x, z) in `b`'s frame, m — 0 when nothing
 * stands there (or (x, z) is off the building). Where a strike, a meteor or
 * a smoke base sits on a damaged building.
 */
export function standingTopAt(b: Building, x: number, z: number): number {
  const grids = tierGrids(b);
  const masks = chunkMask(b);
  let top = 0;
  grids.forEach((g, k) => {
    if (Math.abs(x) > g.width / 2 || Math.abs(z) > g.depth / 2) return;
    const ix = clampI((x + g.width / 2) / g.cw, g.nx);
    const iz = clampI((z + g.depth / 2) / g.cd, g.nz);
    for (let iy = g.ny - 1; iy >= 0; iy--) {
      if (!cellStands(b, masks, g, k, ix, iy, iz)) continue;
      top = Math.max(
        top,
        iy + 1 >= g.ny ? g.baseY + g.height : g.baseY + (iy + 1) * g.ch,
      );
      break;
    }
  });
  return top;
}

// --- R2 roof structures follow the stump ---------------------------------

/** Each damaged building's roof structures as generated (absent = never
 * touched: `b.roof` is still the generated list). */
const generated = new WeakMap<Building, RoofStructure[] | undefined>();

/** The roof structures `b` was generated with — what layouts (clutter
 * keep-outs, roof details, rooftop life) are laid out against, so nothing
 * shifts when damage takes structures away and a rebuild brings them back. */
export function generatedRoof(
  b: Building,
): readonly RoofStructure[] | undefined {
  return generated.has(b) ? generated.get(b) : b.roof;
}

/** Does the deck under roof structure `r` still stand: every top-band cell
 * of the top tier its footprint overlaps? */
function roofCarried(b: Building, r: RoofStructure): boolean {
  const grids = tierGrids(b);
  const k = grids.length - 1;
  const g = grids[k];
  if (!g) return false;
  const masks = chunkMask(b);
  const mask = masks[k] as Uint8Array;
  const gone = b.damage?.cells[k];
  const hw = g.width / 2;
  const hd = g.depth / 2;
  const x0 = clampI((r.dx - r.width / 2 + hw + 1e-6) / g.cw, g.nx);
  const x1 = clampI((r.dx + r.width / 2 + hw - 1e-6) / g.cw, g.nx);
  const z0 = clampI((r.dz - r.depth / 2 + hd + 1e-6) / g.cd, g.nz);
  const z1 = clampI((r.dz + r.depth / 2 + hd - 1e-6) / g.cd, g.nz);
  const iy = g.ny - 1;
  for (let iz = z0; iz <= z1; iz++) {
    for (let ix = x0; ix <= x1; ix++) {
      const c = (iy * g.nz + iz) * g.nx + ix;
      if (mask[c] && gone?.[c]) return false;
    }
  }
  return true;
}

/**
 * Make `b.roof` the generated structures whose deck still stands. Pure in
 * the current damage (no memory of what fell before), so a server and a
 * client holding the same destroyed set hold the same roof — collision,
 * sight lines, rays and the roof renderer read `b.roof` as before. Run by
 * CityDamage after every change to a building.
 */
export function syncRoof(b: Building): void {
  if (!generated.has(b)) {
    if (!b.damage || !b.roof) return;
    generated.set(b, b.roof);
  }
  const all = generated.get(b);
  if (!all || !b.damage) {
    b.roof = all;
    return;
  }
  let kept: RoofStructure[] | null = null;
  for (let i = 0; i < all.length; i++) {
    const r = all[i] as RoofStructure;
    const ok = roofCarried(b, r);
    if (!ok && !kept) kept = all.slice(0, i);
    else if (ok && kept) kept.push(r);
  }
  b.roof = kept ? (kept.length > 0 ? kept : undefined) : all;
}
