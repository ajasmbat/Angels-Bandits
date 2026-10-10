// D9 persistent facade scars: a broken-window ring round every chunk shot or
// blasted out of a facade, and a soot streak rising up the facade above
// every chunk that burned (C2's spreading fire). Both are a PURE function of
// replicated state — the destroyed set (CityDamage) and the room's soot set
// (the socket's, from every `fires` batch and the welcome) — written into
// the D1 damage atlas (damage-map.ts), so every client and late joiner sees
// the same scars, and a D5 rebuild (clearBuilding + the soot cleared) takes
// them away.
//
// The atlas is a small LRU of face slots, so a scar can lose its slot to a
// fresh bullet hole elsewhere. FacadeScarKeeper re-writes a building's
// scars ONLY when that happened (the face's slot epoch changed) or its scar
// state changed — never in a steady view — for the nearest scarred
// buildings, within half the atlas, at most one building a frame.

import {
  type Building,
  cellBox,
  chunkBuilding,
  chunkCell,
  chunkTier,
  mulberry32,
  tierGrids,
} from "@angels-bandits/common/city";
import type { LocalBox } from "@angels-bandits/common/city";
import { CELL_FALLEN } from "@angels-bandits/common/city/destruction";
import { type Vec3, wrapDeltaAxis } from "@angels-bandits/common/world";
import { FacadeFace, tierBase, tierPitch } from "../game/bullet-impact";
import type { FacadeDamage } from "./damage-map";

/** One scar mark: a facade cell to shatter and/or scorch. */
export interface ScarMark {
  tier: number;
  face: number;
  cx: number;
  cy: number;
  shatter: boolean;
  scorch: number;
}

/** Kept within this of the camera (plan view), m, plus a hysteresis band
 * a kept building has to leave before it is dropped. */
export const SCAR_KEEP_M = 350;
export const SCAR_HYSTERESIS_M = 50;
/** Share of a broken chunk's surrounding panes that shatter. */
const RING_P = 0.55;
/** Rows a soot streak climbs above its chunk. */
const SOOT_ROWS = 4;

const box: LocalBox = { x0: 0, x1: 0, y0: 0, y1: 0, z0: 0, z1: 0 };

/** The outer faces (FacadeFace) cell (ix, iz) of a tier sits on. */
function outerFaces(
  ix: number,
  iz: number,
  nx: number,
  nz: number,
  out: number[],
): number[] {
  out.length = 0;
  if (ix === nx - 1) out.push(FacadeFace.PX);
  if (ix === 0) out.push(FacadeFace.NX);
  if (iz === nz - 1) out.push(FacadeFace.PZ);
  if (iz === 0) out.push(FacadeFace.NZ);
  return out;
}

/**
 * Every scar mark of building `bi`: the window ring round each gone chunk
 * on an outer face (seeded by the chunk), and the soot streak above each
 * sooted chunk (`soot`: the room's sooted chunk ids). Deterministic; marks
 * on the same cell simply add up when written.
 */
export function facadeScars(
  b: Building,
  bi: number,
  soot: Iterable<number>,
): ScarMark[] {
  const out: ScarMark[] = [];
  const grids = tierGrids(b);
  const faces: number[] = [];
  const mark = (
    tier: number,
    cell: number,
    shatterRing: boolean,
    scorch: boolean,
    seed: number,
  ) => {
    const g = grids[tier];
    if (!g) return;
    const ix = cell % g.nx;
    const iz = Math.floor(cell / g.nx) % g.nz;
    cellBox(g, cell, box);
    const base = tierBase(b, tier);
    const [px, py] = tierPitch(b, tier);
    const r0 = Math.floor((box.y0 - base) / py);
    const r1 = Math.floor((box.y1 - base - 1e-3) / py);
    const rand = mulberry32(seed);
    for (const face of outerFaces(ix, iz, g.nx, g.nz, faces)) {
      const alongX = face === FacadeFace.PX || face === FacadeFace.NX;
      // The run along the face is z for an x-facing face, x otherwise.
      const a0 = alongX ? box.z0 : box.x0;
      const a1 = alongX ? box.z1 : box.x1;
      const c0 = Math.floor(a0 / px);
      const c1 = Math.floor((a1 - 1e-3) / px);
      if (shatterRing) {
        for (let cy = r0 - 1; cy <= r1 + 1; cy++) {
          for (let cx = c0 - 1; cx <= c1 + 1; cx++) {
            const inside = cy >= r0 && cy <= r1 && cx >= c0 && cx <= c1;
            // One draw per cell, inside or not: the stream stays aligned.
            const hit = rand() < RING_P;
            if (inside || !hit || cy < 0) continue;
            out.push({ tier, face, cx, cy, shatter: true, scorch: 30 });
          }
        }
      }
      if (scorch) {
        for (let k = 0; k <= r1 - r0 + SOOT_ROWS; k++) {
          const cy = r0 + k;
          const above = Math.max(0, cy - r1);
          const fade = 1 - above / (SOOT_ROWS + 1);
          // The streak narrows as it climbs.
          const pinch = Math.floor(above / 2);
          for (let cx = c0 + pinch; cx <= c1 - pinch; cx++) {
            out.push({
              tier,
              face,
              cx,
              cy,
              shatter: false,
              scorch: Math.round(210 * fade),
            });
          }
        }
      }
    }
  };
  const dmg = b.damage;
  if (dmg) {
    dmg.cells.forEach((cells, tier) => {
      for (let c = 0; c < cells.length; c++) {
        // A shot-out chunk rings its panes; a fallen one took its facade
        // with it (the collapse's own rubble and soot tell that story).
        if (cells[c] && cells[c] !== CELL_FALLEN) {
          mark(
            tier,
            c,
            true,
            false,
            (Math.imul(bi + 1, 0x9e3779b1) ^ (tier << 20) ^ c) >>> 0,
          );
        }
      }
    });
  }
  for (const id of soot) {
    if (chunkBuilding(id) !== bi) continue;
    mark(chunkTier(id), chunkCell(id), false, true, id >>> 0);
  }
  return out;
}

interface Applied {
  sig: number;
  faces: Map<number, number>;
}

/**
 * Keeps the nearest scarred buildings' scars in the atlas (see the header).
 * `soot` is the socket's live set; call update() once a frame.
 */
export class FacadeScarKeeper {
  /** Buildings re-written so far (QA: a steady view adds none). */
  reapplies = 0;
  private readonly applied = new Map<number, Applied>();
  private order: number[] = [];
  private readonly sootBy = new Map<number, number[]>();
  /** Wall time of the last re-sort, ms (twice a second, whatever the frame
   * rate — a software renderer draws a frame every few seconds). */
  private lastSort = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly damage: FacadeDamage,
    private readonly buildings: readonly Building[],
    private readonly soot: ReadonlySet<number>,
  ) {}

  /** A rebuilt building's scars are gone with its marks. */
  forget(bi: number): void {
    this.applied.delete(bi);
  }

  update(viewer: Vec3, now: number): void {
    if (now - this.lastSort >= 500) {
      this.lastSort = now;
      this.reorder(viewer);
    }
    for (const bi of this.order) {
      if (this.refresh(bi)) break; // one building a frame
    }
  }

  /** The kept set: scarred buildings nearest first, within SCAR_KEEP_M (a
   * kept one until SCAR_KEEP_M + hysteresis), within half the atlas. */
  private reorder(viewer: Vec3): void {
    this.sootBy.clear();
    for (const id of this.soot) {
      const bi = chunkBuilding(id);
      const list = this.sootBy.get(bi);
      if (list) list.push(id);
      else this.sootBy.set(bi, [id]);
    }
    const near: { bi: number; d: number }[] = [];
    this.buildings.forEach((b, bi) => {
      if (!b.damage && !this.sootBy.has(bi)) return;
      const dx = wrapDeltaAxis(viewer.x, b.x);
      const dz = wrapDeltaAxis(viewer.z, b.z);
      const d = Math.hypot(dx, dz);
      const keep = SCAR_KEEP_M + (this.applied.has(bi) ? SCAR_HYSTERESIS_M : 0);
      if (d <= keep) near.push({ bi, d });
    });
    near.sort((a, b) => a.d - b.d || a.bi - b.bi);
    const budget = Math.floor(this.damage.slotCap / 2);
    let faces = 0;
    this.order = [];
    for (const { bi } of near) {
      const b = this.buildings[bi] as Building;
      const f = 4 * b.tiers.length;
      if (faces + f > budget && this.order.length > 0) break;
      faces += f;
      this.order.push(bi);
    }
    for (const bi of [...this.applied.keys()]) {
      if (!this.order.includes(bi)) this.applied.delete(bi);
    }
  }

  /** Re-write building `bi`'s scars if they changed or lost a slot. */
  private refresh(bi: number): boolean {
    const b = this.buildings[bi];
    if (!b) return false;
    const soot = this.sootBy.get(bi) ?? [];
    const sig = (b.damage?.version ?? 0) * 4096 + soot.length;
    const st = this.applied.get(bi);
    if (st && st.sig === sig) {
      let lost = false;
      for (const [key, epoch] of st.faces) {
        const tier = Math.floor(key / 4) % 8;
        if (this.damage.faceEpoch(bi, tier, key % 4) !== epoch) {
          lost = true;
          break;
        }
      }
      if (!lost) return false;
    }
    const marks = facadeScars(b, bi, soot);
    const faces = new Map<number, number>();
    for (const m of marks) {
      if (m.shatter) this.damage.shatter(bi, m.tier, m.face, m.cx, m.cy);
      if (m.scorch > 0) {
        this.damage.scorch(bi, m.tier, m.face, m.cx, m.cy, m.scorch);
      }
      faces.set(m.tier * 4 + m.face, 0);
    }
    for (const key of faces.keys()) {
      faces.set(key, this.damage.faceEpoch(bi, Math.floor(key / 4), key % 4));
    }
    this.applied.set(bi, { sig, faces });
    if (marks.length > 0) this.reapplies++;
    return true;
  }
}
