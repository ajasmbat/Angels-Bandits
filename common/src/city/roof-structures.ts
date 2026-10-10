// R2 roof structures — the one seam for everything on a roof that is taller
// than clutter. Penthouses, cooling towers, water tanks, rooftop billboards
// and antenna masts stand well above the 2.5 m clutter line, so by the
// flight-band rule they are SOLID: collision (collideCity), sight lines
// (losClear), the bot probes and the client's renderer all read exactly
// these boxes, so drawing, crashing and seeing agree by construction.
//
// Pure and shared: deterministic per building from its own position and
// dimensions through a salted mulberry32 stream (never Math.random, never a
// torus image), so client and server agree and nothing moves when a building
// wraps. generateCity() stores the result on `Building.roof`; hand-built
// buildings (tests) carry none unless they ask for roofStructuresFor().
//
// Everything stays ROOF_STRUCTURE_INSET inside the top tier's footprint
// (clear of the parapet lip), off helipad roofs, off the strip above a sky
// hole, and off the centre of the tallest towers (searchlight stations).
// Landmarks carry nothing: their beacon and crown are the read.

import { LANDMARK_HEIGHT, WORLD_SIZE } from "../constants";
import type { Building } from "./index";
import { mulberry32 } from "./rng";

export type RoofStructureKind =
  | "penthouse"
  | "coolingTower"
  | "waterTank"
  | "billboard"
  | "billboardLeg"
  | "mast"
  // W3: a rooftop anti-aircraft nest (sandbag ring, gun, crew) — light, or
  // a heavy flak gun on the tallest towers (common/src/aa.ts).
  | "aaNest";

/** One solid roof structure, offset from its building's (x, z) center. */
export interface RoofStructure {
  kind: RoofStructureKind;
  dx: number;
  dz: number;
  /** World height of the box's base (the deck; a billboard panel floats). */
  baseY: number;
  /** Extent along x / z. A round structure is a vertical cylinder of
   * diameter `width` (== depth). */
  width: number;
  depth: number;
  height: number;
  round: boolean;
  /** Facing: 0 +x, 1 −x, 2 +z, 3 −z (penthouse door, billboard face). */
  face: number;
  /** Per-item roll in [0, 1) for dressing (tone, ad art, lamp). */
  seed: number;
}

/** Parapet lip (facade-garnish.ts, 1.1 m thick, centred on the roof edge)
 * covers the outer ~0.55 m of every roof. */
export const PARAPET_INSET = 0.6;
/** Structures stand this far inside the top-tier edge: the parapet lip plus
 * a margin (rooftop-life's ROOF_INSET, the same number). */
export const ROOF_STRUCTURE_INSET = 1.6;
/** Anything on a roof taller than this is a structure (solid); at or under
 * it is clutter (dressing only). */
export const ROOF_CLUTTER_MAX_HEIGHT = 2.5;
/** The tallest any structure stands above its deck (the longest mast). */
export const ROOF_STRUCTURE_MAX_HEIGHT = 16;

/** Helipads: big flat mid-rise roofs only. Under 120 m keeps them off every
 * mast roof and every searchlight station (the ten tallest, ~190 m+). */
export const HELIPAD_MIN_HEIGHT = 50;
export const HELIPAD_MAX_HEIGHT = 120;
export const HELIPAD_MIN_ROOF = 34;
export const HELIPAD_CHANCE = 0.18;
/** Touchdown-circle radius on a helipad roof, m. */
export const helipadRadius = (roofWidth: number, roofDepth: number): number =>
  0.62 * (Math.min(roofWidth, roofDepth) / 2 - PARAPET_INSET);

/** Antenna masts on buildings at least this tall. */
export const MAST_MIN_HEIGHT = 120;
/** Mast base radius — the drawn cylinder's base and the collider. */
export const MAST_RADIUS = 0.14;
/** Searchlight stations sit on the roof centre of the ten tallest
 * non-landmarks; every tower this tall keeps a square this big clear. */
export const SEARCHLIGHT_CLEAR_MIN_HEIGHT = 150;
export const SEARCHLIGHT_CLEAR_HALF = 5;
/** Cooling-tower fan shroud above the casing (drawn by rooftop-life). */
export const COOLING_SHROUD = 0.7;
/** Billboard panel: open air under it (legs only), panel depth. */
export const BILLBOARD_LIFT = 2.4;
export const BILLBOARD_THICKNESS = 0.45;
/** Catwalk in front of the panel (clutter, at the panel's foot). */
export const BILLBOARD_CATWALK = 0.8;
/** Billboard leg section, m. */
export const BILLBOARD_LEG = 0.3;

/** W3 AA nests: a sandbag ring round a gun mount, collided as one vertical
 * cylinder whose top is the gun's top — above the clutter line, so solid.
 * Light machine-gun nests sit on mid-rise roofs, chance weighted toward the
 * map's middle; every non-landmark at least AA_FLAK_MIN_HEIGHT tall carries
 * a heavy flak gun instead. */
export const AA_NEST_RADIUS = 2.5;
export const AA_NEST_HEIGHT = 2.8;
export const AA_FLAK_RADIUS = 3.2;
export const AA_FLAK_HEIGHT = 3.6;
export const AA_NEST_MIN_HEIGHT = 30;
export const AA_NEST_MIN_ROOF = 16;
export const AA_FLAK_MIN_HEIGHT = 200;
/** A light nest's chance at the anchor, falling linearly by AA_NEST_FALLOFF
 * of itself at the torus' farthest point from it (wrap distance). */
export const AA_NEST_CHANCE = 0.15;
export const AA_NEST_FALLOFF = 0.75;
/** The density anchor: the middle of the canonical map. On a torus every
 * point is a middle — this one is fixed so the layout is. */
export const AA_NEST_ANCHOR = { x: WORLD_SIZE / 2, z: WORLD_SIZE / 2 };
/** A heavy (flak) nest's `face` marks it (light nests use 0..3). */
export const AA_FLAK_FACE = 4;
/** Is roof structure `s` a heavy flak nest? */
export const isFlakNest = (s: RoofStructure): boolean =>
  s.kind === "aaNest" && s.face === AA_FLAK_FACE;

/** Keep-out margin between structures, m. */
const GAP = 1.2;
const TRIES = 8;

/**
 * Does this building's top tier carry a helipad? The roll is roofs.ts's
 * VO3 roofStyleFor stream — same seed, same salt, same draw order (rBase,
 * then rTop) — so moving it here moved no pad.
 */
export function hasHelipad(b: Building): boolean {
  if (b.height >= LANDMARK_HEIGHT) return false;
  if (b.height < HELIPAD_MIN_HEIGHT || b.height >= HELIPAD_MAX_HEIGHT) {
    return false;
  }
  const top = b.tiers[b.tiers.length - 1];
  if (!top || Math.min(top.width, top.depth) < HELIPAD_MIN_ROOF) return false;
  const rand = roofStyleStream(b);
  rand(); // rBase
  return rand() < HELIPAD_CHANCE;
}

/** roofs.ts roofStyleFor's stream — exported so the client draws its rolls
 * from the one definition. */
export const roofStyleStream = (b: Building): (() => number) =>
  mulberry32(
    (Math.imul(b.x, 2654435761) ^
      Math.imul(b.z, 40503) ^
      Math.imul(b.height, 2246822519) ^
      0x7f4a7c15) >>>
      0,
  );

/** An axis-aligned rectangle in building-relative offsets. */
interface Rect {
  x: number;
  z: number;
  hw: number;
  hd: number;
}
const overlaps = (a: Rect, b: Rect, margin: number): boolean =>
  Math.abs(a.x - b.x) < a.hw + b.hw + margin &&
  Math.abs(a.z - b.z) < a.hd + b.hd + margin;

/**
 * Deterministic solid roof structures for one building's top-tier roof.
 * Every roll is drawn for every building in a fixed order (the roofStyleFor
 * idiom), so one rule's gate never shifts another rule's outcome; sizes and
 * positions come from a sub-stream.
 */
export function roofStructuresFor(b: Building): RoofStructure[] {
  const out: RoofStructure[] = [];
  const top = b.tiers[b.tiers.length - 1];
  if (!top || b.height >= LANDMARK_HEIGHT || hasHelipad(b)) return out;

  // Own salt: roofClutterFor, roofStyleFor and rooftopLifeFor hash the
  // same (x, z, height).
  const rand = mulberry32(
    (Math.imul(b.x, 0x27d4eb2d) ^
      Math.imul(b.z, 0x165667b1) ^
      Math.imul(b.height, 0x85ebca77) ^
      0x3c6ef372) >>>
      0,
  );
  const rPent = rand();
  const rCool = rand();
  const rTank = rand();
  const rBill = rand();
  const rMast = rand();
  const d = mulberry32((rand() * 4294967296) >>> 0);

  const iw = top.width / 2 - ROOF_STRUCTURE_INSET;
  const id = top.depth / 2 - ROOF_STRUCTURE_INSET;
  const y = b.height;
  const taken: Rect[] = [];
  // Never over a sky hole (or an H2 gate in the top tier): it runs the top
  // tier's full length under a lintel; the strip above it stays bare deck.
  for (const h of b.holes ?? []) {
    if (h.kind !== "sky" && h.kind !== "gate") continue;
    if (h.tierIndex !== b.tiers.length - 1) continue;
    taken.push(
      h.axis === "x"
        ? { x: 0, z: h.offset, hw: top.width, hd: h.width / 2 }
        : { x: h.offset, z: 0, hw: h.width / 2, hd: top.depth },
    );
  }
  if (b.height >= SEARCHLIGHT_CLEAR_MIN_HEIGHT) {
    taken.push({
      x: 0,
      z: 0,
      hw: SEARCHLIGHT_CLEAR_HALF,
      hd: SEARCHLIGHT_CLEAR_HALF,
    });
  }

  /** A free spot for a hw×hd footprint within `span` of the inner roof. */
  const place = (hw: number, hd: number, span = 1): Rect | null => {
    if (hw > iw || hd > id) return null;
    for (let i = 0; i < TRIES; i++) {
      const rx = d();
      const rz = d();
      const r: Rect = {
        x: (rx * 2 - 1) * Math.max(0, (iw - hw) * span),
        z: (rz * 2 - 1) * Math.max(0, (id - hd) * span),
        hw,
        hd,
      };
      if (taken.every((t) => !overlaps(r, t, GAP))) return r;
    }
    return null;
  };
  const push = (
    kind: RoofStructureKind,
    r: Rect,
    baseY: number,
    height: number,
    face: number,
    round = false,
  ) => {
    out.push({
      kind,
      dx: r.x,
      dz: r.z,
      baseY,
      width: r.hw * 2,
      depth: r.hd * 2,
      height,
      round,
      face,
      seed: d(),
    });
  };

  const tall = b.height >= SEARCHLIGHT_CLEAR_MIN_HEIGHT;

  // --- Elevator / stair penthouse: nearly every roof has one, towards the
  // middle (the core) so a party or pool still finds an end of the roof.
  if (rPent < 0.8 && b.height >= 18) {
    const scale = tall ? 1.5 : 1;
    const hw = ((3.6 + d() * 2.4) * scale) / 2;
    const hd = ((3.4 + d() * 2.2) * scale) / 2;
    const h = 3.2 + d() * 1.3 + (tall ? 1 : 0);
    const face = Math.floor(d() * 4);
    const r = place(hw, hd, 0.45);
    if (r) {
      taken.push(r);
      push("penthouse", r, y, h, face);
    }
  }

  // --- Cooling tower: a boxy induced-draft casing, the fan on top.
  if (rCool < 0.3 && b.height >= 35 && Math.min(iw, id) >= 7) {
    const hw = (4 + d() * 3) / 2;
    const hd = (3.4 + d() * 2) / 2;
    const body = 3 + d() * 1.2;
    const r = place(hw, hd);
    if (r) {
      taken.push(r);
      push("coolingTower", r, y, body + COOLING_SHROUD, 0);
    }
  }

  // --- Water tank (the old V2 water tower, now solid): a round timber or
  // steel tank, 5–7 m tall.
  if (rTank < 0.45 && Math.min(top.width, top.depth) >= 24) {
    const radius = 2.2 + d() * 1.1;
    const h = 5 + d() * 2;
    const r = place(radius, radius);
    if (r) {
      taken.push(r);
      push("waterTank", r, y, h, 0, true);
    }
  }

  // --- Rooftop billboard on some mid-rises: a panel on legs along one roof
  // edge, facing the street. Open air under the panel, exactly as drawn.
  if (rBill < 0.14 && b.height >= 24 && b.height < 95) {
    const face = Math.floor(d() * 4);
    const alongX = face >= 2; // a ±z face runs along x
    const alongHalf = alongX ? iw : id;
    const crossHalf = alongX ? id : iw;
    const len = Math.min(alongHalf * 1.6, 8 + d() * 8);
    const panelH = 3.4 + d() * 1.4;
    const sign = face % 2 === 0 ? 1 : -1;
    if (len >= 6 && crossHalf >= 4) {
      // The panel's back sits a catwalk's depth in from the inner edge.
      const cross =
        sign * (crossHalf - BILLBOARD_CATWALK - BILLBOARD_THICKNESS / 2);
      const panel: Rect = alongX
        ? { x: 0, z: cross, hw: len / 2, hd: BILLBOARD_THICKNESS / 2 }
        : { x: cross, z: 0, hw: BILLBOARD_THICKNESS / 2, hd: len / 2 };
      // Footprint incl. catwalk (front) and leg braces (back).
      const reserve: Rect = alongX
        ? { x: 0, z: cross, hw: len / 2, hd: 1.4 }
        : { x: cross, z: 0, hw: 1.4, hd: len / 2 };
      if (taken.every((t) => !overlaps(reserve, t, GAP))) {
        taken.push(reserve);
        push("billboard", panel, y + BILLBOARD_LIFT, panelH, face);
        const legs = len > 12 ? 3 : 2;
        for (let i = 0; i < legs; i++) {
          const along = (i / (legs - 1) - 0.5) * (len - 1.2);
          const leg: Rect = alongX
            ? {
                x: along,
                z: cross,
                hw: BILLBOARD_LEG / 2,
                hd: BILLBOARD_LEG / 2,
              }
            : {
                x: cross,
                z: along,
                hw: BILLBOARD_LEG / 2,
                hd: BILLBOARD_LEG / 2,
              };
          push("billboardLeg", leg, y, BILLBOARD_LIFT, face);
        }
      }
    }
  }

  // --- Antenna cluster on tall towers: one to three masts within a few
  // meters of each other (aviation lights: rooftop-life).
  if (b.height >= MAST_MIN_HEIGHT) {
    const count = rMast < 0.3 ? 3 : rMast < 0.65 ? 2 : 1;
    const hub = place(2.5, 2.5);
    if (hub) {
      taken.push(hub);
      for (let i = 0; i < count; i++) {
        const a = (i / count) * Math.PI * 2 + d();
        const reach = count === 1 ? 0 : 1.2 + d() * 1.1;
        const r: Rect = {
          x: hub.x + Math.cos(a) * reach,
          z: hub.z + Math.sin(a) * reach,
          hw: MAST_RADIUS,
          hd: MAST_RADIUS,
        };
        push("mast", r, y, 8 + d() * 8, 0, true);
      }
    }
  }

  // --- W3 AA nest: last, from its own stream, so adding it moved no other
  // structure (they only keep out of its way from here on).
  const nest = aaNestFor(b, taken, iw, id);
  if (nest) out.push(nest);

  return out;
}

/** The torus' farthest point from any anchor, m (half the diagonal). */
const FAR = (Math.SQRT2 * WORLD_SIZE) / 2;

/**
 * W3: the AA nest on `b`'s roof, or null — a heavy flak gun on every
 * non-landmark at least AA_FLAK_MIN_HEIGHT tall (a light nest when the
 * heavy one finds no room), else a light nest by a seeded roll weighted
 * toward AA_NEST_ANCHOR. Clear of everything in `taken` by GAP.
 */
function aaNestFor(
  b: Building,
  taken: readonly Rect[],
  iw: number,
  id: number,
): RoofStructure | null {
  if (b.height < AA_NEST_MIN_HEIGHT) return null;
  const top = b.tiers[b.tiers.length - 1];
  if (!top || Math.min(top.width, top.depth) < AA_NEST_MIN_ROOF) return null;
  const rand = mulberry32(
    (Math.imul(b.x, 0x2545f491) ^
      Math.imul(b.z, 0x9e3779b9) ^
      Math.imul(b.height, 0x7feb352d) ^
      0x5aa7e5) >>>
      0,
  );
  const rRoll = rand();
  const heavy = b.height >= AA_FLAK_MIN_HEIGHT;
  if (!heavy) {
    const dx = Math.abs(b.x - AA_NEST_ANCHOR.x);
    const dz = Math.abs(b.z - AA_NEST_ANCHOR.z);
    // Canonical coordinates are in [0, S): the wrap distance to the anchor
    // at the middle is the plain one.
    const far = Math.min(1, Math.hypot(dx, dz) / FAR);
    if (rRoll >= AA_NEST_CHANCE * (1 - AA_NEST_FALLOFF * far)) return null;
  }
  const seed = rand();
  const face = Math.floor(rand() * 4);
  const tries = [heavy ? AA_FLAK_RADIUS : AA_NEST_RADIUS, AA_NEST_RADIUS];
  for (let k = 0; k < (heavy ? 2 : 1); k++) {
    const r = tries[k] as number;
    if (r > iw || r > id) continue;
    for (let i = 0; i < TRIES; i++) {
      const spot: Rect = {
        x: (rand() * 2 - 1) * (iw - r),
        z: (rand() * 2 - 1) * (id - r),
        hw: r,
        hd: r,
      };
      if (!taken.every((t) => !overlaps(spot, t, GAP))) continue;
      const flak = heavy && k === 0;
      return {
        kind: "aaNest",
        dx: spot.x,
        dz: spot.z,
        baseY: b.height,
        width: 2 * r,
        depth: 2 * r,
        height: flak ? AA_FLAK_HEIGHT : AA_NEST_HEIGHT,
        round: true,
        face: flak ? AA_FLAK_FACE : face,
        seed,
      };
    }
  }
  return null;
}

/** Highest point of the building, roof structures included. */
export function roofTop(b: Building): number {
  let top = b.height;
  for (const s of b.roof ?? []) {
    if (s.baseY + s.height > top) top = s.baseY + s.height;
  }
  return top;
}

/** Highest solid surface under the building-relative offset (dx, dz) —
 * a structure's top, else the roof (callers check the footprint). */
export function roofTopAt(b: Building, dx: number, dz: number): number {
  let top = b.height;
  for (const s of b.roof ?? []) {
    if (!structureCovers(s, dx, dz, 0)) continue;
    if (s.baseY + s.height > top) top = s.baseY + s.height;
  }
  return top;
}

/** Is the building-relative (dx, dz) within `pad` of the structure's
 * footprint (a disc for round structures)? */
/**
 * structureCovers for an offset held in an object (only x and z are read)
 * — the per-probe collision path's form (O5): a double handed to a call V8
 * does not inline is boxed, an object is not. Same test, same answer.
 */
export function structureCoversAt(
  s: RoofStructure,
  d: { readonly x: number; readonly z: number },
  pad: number,
): boolean {
  return structureCovers(s, d.x, d.z, pad);
}

export function structureCovers(
  s: RoofStructure,
  dx: number,
  dz: number,
  pad: number,
): boolean {
  const ox = dx - s.dx;
  const oz = dz - s.dz;
  if (s.round) {
    const r = s.width / 2 + pad;
    return ox * ox + oz * oz <= r * r;
  }
  return Math.abs(ox) <= s.width / 2 + pad && Math.abs(oz) <= s.depth / 2 + pad;
}
