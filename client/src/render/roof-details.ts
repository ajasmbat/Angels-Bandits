// R2 roof dressing — what a real rooftop looks like from the air, as pure
// deterministic layout. roofDetailsFor() returns every part the clutter
// renderer (roofclutter.ts) draws for one building:
//  - the BODIES of its solid structures, 1:1 from Building.roof (the shared
//    collision seam), so what is drawn is exactly what collides;
//  - their dressing: penthouse doors with a lit lamp and a canopy, billboard
//    faces with a lit frame, catwalks and leg braces;
//  - the HVAC units of roofClutterFor, and a steam stack on the first;
//  - free-standing clutter, ALL ≤ ROOF_CLUTTER_MAX_HEIGHT above the deck:
//    duct runs, vent stacks, solar arrays, satellite dishes, lightning rods,
//    window-cleaning davits (and the gondola hanging on the facade below),
//    maintenance walkways, hatches and drains.
// It reads roof-layout (structures, HVAC), rooftop-life (L8 parties, pools,
// fans, flags) and keeps every new part clear of all of them. Seeded from
// the building's own position and dimensions through a salted mulberry32
// stream — never Math.random, never a torus image — so every client dresses
// identical roofs.

import {
  type Building,
  type LocalBox,
  generatedRoof,
  mulberry32,
} from "@angels-bandits/common/city";
import {
  BILLBOARD_CATWALK,
  BILLBOARD_LIFT,
  BILLBOARD_THICKNESS,
  COOLING_SHROUD,
  ROOF_CLUTTER_MAX_HEIGHT,
  type RoofStructure,
} from "@angels-bandits/common/city/roof-structures";
import { LANDMARK_HEIGHT } from "@angels-bandits/common/constants";
import { wrapDeltaAxis } from "@angels-bandits/common/world";
import * as THREE from "three";
import { emissiveBoost } from "./emissive";
import { GLYPH_H, wordCells, wordRuns } from "./pixel-font";
import {
  type Rect,
  clutterRects,
  overlaps,
  roofClutterFor,
} from "./roof-layout";
import { RoofKind, roofStyleFor } from "./roofs";
import {
  LIFE_MAX_HEIGHT,
  ROOF_INSET,
  rooftopLifeAllowed,
  rooftopLifeFor,
} from "./rooftop-life";

/**
 * One drawn part: a unit box or cylinder (base at y = 0) scaled by
 * (sx, sy, sz), turned by `tilt` about its own x axis (leaning +y towards
 * +z), then by `yaw` about +y, standing on its pivot (x, y, z) — canonical
 * world coordinates; the renderer re-places it at the nearest torus image.
 */
export interface RoofPart {
  x: number;
  y: number;
  z: number;
  sx: number;
  sy: number;
  sz: number;
  yaw: number;
  tilt: number;
  /** sRGB tone. */
  tone: number;
  /** Lit parts: the multiplier that lifts the tone to its emissive rung
   * (0 = a lit-by-the-scene part). */
  boost: number;
  /** Fine detail — the first thing Low and Mobile drop. */
  fine: boolean;
  /** DT2 distance LOD: the part folds into its own base between 0.7× and
   * 1× this camera distance, m (roofclutter.ts aFade). 0 = never — every
   * solid body and every pre-DT2 part. */
  fade: number;
  /** Drawn from a solid roof structure (collides). */
  solid: boolean;
  /** D8: the structure this part is the body or dressing of (null for free
   * clutter) — drawn exactly while that structure stands (structureDrawn). */
  structure: RoofStructure | null;
}

export interface RoofDetails {
  /** Unit boxes, lit by the scene. */
  boxes: RoofPart[];
  /** Unit cylinders (radius 1 at sx = sz = 1), lit by the scene. */
  cylinders: RoofPart[];
  /** Unit boxes that emit: door lamps, billboard faces and frames. */
  lit: RoofPart[];
  /** Steam stack tops (steam.ts vents from the first). */
  vents: { x: number; y: number; z: number }[];
  /** Footprints of the free-standing parts — keep-outs for anything placed
   * later (citylife's terrace people). */
  rects: Rect[];
}

// --- Emissive rungs (bloom threshold 0.72) --------------------------------
/** Penthouse door lamp: a warm glint that blooms a little. */
export const DOOR_LAMP_LUMINANCE = 0.8;
/** Billboard frame lights: lamps, under the SIGN rung (0.93). */
export const BILLBOARD_FRAME_LUMINANCE = 0.85;
/** Billboard art: a lit SURFACE, under the lit-facade ceiling (0.4) — it
 * glows like a pane, never like a lamp. */
export const BILLBOARD_FACE_LUMINANCE = 0.36;

const DOOR_LAMP_TONE = 0xffc98a;
const FRAME_TONE = 0xfff1d6;
/** Ad art: two bands per board, picked from these. */
export const AD_TONES = [
  0xff5a3c, 0x3cc8ff, 0xffd23c, 0xff4fb0, 0x7dff6a, 0xf2f2f2,
] as const;

const boostOf = (hex: number, target: number): number =>
  emissiveBoost(new THREE.Color().setHex(hex), target);
const DOOR_LAMP_BOOST = boostOf(DOOR_LAMP_TONE, DOOR_LAMP_LUMINANCE);
const FRAME_BOOST = boostOf(FRAME_TONE, BILLBOARD_FRAME_LUMINANCE);
const AD_BOOSTS = AD_TONES.map((t) => boostOf(t, BILLBOARD_FACE_LUMINANCE));

// --- Palette (sRGB; the clutter material is white, tone is per instance) --
const PENTHOUSE_TONES = [0x8d8a84, 0x7d6f63, 0x9a9890, 0x6f747b] as const;
const COOLING_TONES = [0x7f8a86, 0x8c9496] as const;
const TANK_TONES = [0x7a6552, 0x6e7680, 0x86705a] as const; // timber / steel
const BOX_TONES = [0x9aa1aa, 0x9c9585, 0x8a929c, 0xa7a49b] as const; // plant
const BOARD_BACK_TONE = 0x3c4046;
const LEG_TONE = 0x5a5f66;
const CATWALK_TONE = 0x6b7077;
const DOOR_TONE = 0x2e3338;
const CANOPY_TONE = 0x50555c;
const DUCT_TONE = 0xa2a8ae;
const VENT_TONE = 0x8e949a;
const VENT_CAP_TONE = 0x6e737a;
const SOLAR_FRAME_TONE = 0xb4b9bf;
const SOLAR_GLASS_TONE = 0x1c2d52;
const DISH_TONE = 0xd6d8da;
const PEDESTAL_TONE = 0x7a8088;
const ROD_TONE = 0x9a7a5a;
const DAVIT_TONE = 0xc9cdd2;
const GONDOLA_TONE = 0xd9d4c8;
const CABLE_TONE = 0x3a3d42;
const WALKWAY_TONE = 0x9a9c9f;
const HATCH_TONE = 0x4a4f56;
const DRAIN_TONE = 0x24272b;

/** Stable per-item pick from a [0, 1) roll. */
const pick = <T>(list: readonly T[], r: number): T =>
  list[Math.min(list.length - 1, Math.floor(r * list.length))] as T;
/** Stable per-item pick from its canonical position (never a torus image). */
const toneAt = <T>(tones: readonly T[], x: number, z: number): T =>
  tones[
    ((Math.imul(Math.round(x * 8), 73856093) ^
      Math.imul(Math.round(z * 8), 19349663)) >>>
      0) %
      tones.length
  ] as T;

/** Layout rules. */
export const SOLAR_CHANCE = 0.35;
export const SOLAR_MAX_HEIGHT = 150;
/** Panels lean this far off flat, all facing one way (one sun). */
export const SOLAR_TILT = 0.42;
const SOLAR_PITCH = 2.1;
const SOLAR_DEPTH = 1.5;
/** Satellite dishes all look roughly the same way (one satellite belt). */
const DISH_YAW = 2.4;
const DISH_TILT = 0.9;
export const ROD_MIN_HEIGHT = 80;
export const DAVIT_MIN_HEIGHT = 100;
export const DAVIT_CHANCE = 0.55;
const DAVIT_POST = 2.0;
const DAVIT_SPAN = 3.4;
/** Keep-out margin between free-standing parts and anything placed. */
const GAP = 0.5;
const TRIES = 6;

/** A face index (0 +x, 1 −x, 2 +z, 3 −z) as a unit direction. */
const faceDir = (face: number): [number, number] =>
  face === 0 ? [1, 0] : face === 1 ? [-1, 0] : face === 2 ? [0, 1] : [0, -1];
/** Yaw that turns local +z towards a face's direction. */
const faceYaw = (face: number): number =>
  face === 0
    ? Math.PI / 2
    : face === 1
      ? -Math.PI / 2
      : face === 2
        ? 0
        : Math.PI;

/** Buildings are immutable once generated, so their details are too: the
 * renderer lays every roof out at boot, and the block-streamed readers
 * (steam vents, terrace people) then pay a lookup, not a layout, when the
 * plane enters a block. Callers must not mutate the result. */
const detailCache = new WeakMap<Building, RoofDetails>();

/**
 * Every part the roof renderer draws for one building's top roof (cached
 * per building — see detailCache).
 */
export function roofDetailsFor(b: Building): RoofDetails {
  let details = detailCache.get(b);
  if (!details) {
    details = layoutDetails(b);
    detailCache.set(b, details);
  }
  return details;
}

/**
 * The layout itself. Every roll is drawn for every building in a fixed
 * order, so one rule's gate never shifts another rule's outcome;
 * variable-length detail uses a sub-stream.
 */
function layoutDetails(b: Building): RoofDetails {
  const out: RoofDetails = {
    boxes: [],
    cylinders: [],
    lit: [],
    vents: [],
    rects: [],
  };
  const top = b.tiers[b.tiers.length - 1];
  if (!top || b.height >= LANDMARK_HEIGHT) return out;
  const clutter = roofClutterFor(b);
  const y = b.height;

  const part = (
    list: RoofPart[],
    p: Partial<RoofPart> &
      Pick<RoofPart, "x" | "y" | "z" | "sx" | "sy" | "sz" | "tone">,
  ) => {
    list.push({
      yaw: 0,
      tilt: 0,
      boost: 0,
      fine: false,
      fade: 0,
      solid: false,
      structure: null,
      ...p,
    });
  };

  // --- Solid structure bodies and their dressing (Building.roof, 1:1).
  for (const s of clutter.structures) {
    dressStructure(b, s, out, (list, p) => part(list, { ...p, structure: s }));
  }

  // --- HVAC units (roofClutterFor), a steam stack on the first.
  clutter.acBoxes.forEach((box, i) => {
    part(out.boxes, {
      x: box.x,
      y: box.y,
      z: box.z,
      sx: box.width,
      sy: box.height,
      sz: box.depth,
      tone: toneAt(BOX_TONES, box.x, box.z),
    });
    if (i !== 0) return;
    const stack = Math.min(0.9, ROOF_CLUTTER_MAX_HEIGHT - box.height);
    const r = Math.min(0.22, Math.min(box.width, box.depth) * 0.12);
    part(out.cylinders, {
      x: box.x,
      y: box.y + box.height,
      z: box.z,
      sx: r,
      sy: stack,
      sz: r,
      tone: VENT_TONE,
    });
    out.vents.push({ x: box.x, y: box.y + box.height + stack, z: box.z });
  });

  // Helipads, sky-hole roofs: structures and HVAC only (L8's rule).
  if (!rooftopLifeAllowed(b)) return out;

  const rand = mulberry32(
    (Math.imul(b.x, 0x7feb352d) ^
      Math.imul(b.z, 0x846ca68b) ^
      Math.imul(b.height, 0x2c1b3c6d) ^
      0x297a2d39) >>>
      0,
  );
  const rVents = rand();
  const rDuct = rand();
  const rSolar = rand();
  const rDish = rand();
  const rDavit = rand();
  const rHatch = rand();
  const rDrain = rand();
  const d = mulberry32((rand() * 4294967296) >>> 0);

  const kind = roofStyleFor(b).tierKinds[b.tiers.length - 1];
  const flat = kind === RoofKind.MEMBRANE || kind === RoofKind.GRAVEL;
  const life = rooftopLifeFor(b);
  const halfW = top.width / 2;
  const halfD = top.depth / 2;
  const innerW = halfW - ROOF_INSET;
  const innerD = halfD - ROOF_INSET;
  const taken: Rect[] = clutterRects(b, clutter);
  if (life.party) {
    const p = life.party;
    taken.push({ x: p.x, z: p.z, hw: p.halfW, hd: p.halfD });
  }
  if (life.pool) {
    const p = life.pool;
    taken.push({ x: p.x, z: p.z, hw: p.halfW + 0.4, hd: p.halfD + 0.4 });
  }
  for (const f of life.fans) {
    taken.push({ x: f.x, z: f.z, hw: f.radius + 0.3, hd: f.radius + 0.3 });
  }
  for (const f of life.flags) {
    taken.push({ x: f.x, z: f.z, hw: 0.4, hd: 0.4 });
  }
  const free = (r: Rect) => taken.every((t) => !overlaps(r, t, GAP));
  const claim = (r: Rect) => {
    taken.push(r);
    out.rects.push(r);
  };
  /** A free hw×hd spot on the inner roof, or null. */
  const spot = (hw: number, hd: number): Rect | null => {
    if (hw > innerW || hd > innerD) return null;
    for (let i = 0; i < TRIES; i++) {
      const r: Rect = {
        x: b.x + (d() * 2 - 1) * (innerW - hw),
        z: b.z + (d() * 2 - 1) * (innerD - hd),
        hw,
        hd,
      };
      if (free(r)) return r;
    }
    return null;
  };

  // --- Duct run: from the first HVAC unit towards the penthouse (the
  // building's core), straight along the longer axis between them.
  const penthouse = clutter.structures.find((s) => s.kind === "penthouse");
  const ac = clutter.acBoxes[0];
  if (rDuct < 0.6 && penthouse && ac) {
    const px = b.x + penthouse.dx;
    const pz = b.z + penthouse.dz;
    const alongX = Math.abs(px - ac.x) >= Math.abs(pz - ac.z);
    const from = alongX ? ac.x : ac.z;
    const to = alongX ? px : pz;
    const sign = Math.sign(to - from);
    const start = from + sign * (alongX ? ac.width / 2 : ac.depth / 2);
    const end =
      to - sign * (alongX ? penthouse.width / 2 : penthouse.depth / 2);
    const len = (end - start) * sign;
    if (len > 1.5) {
      const mid = (start + end) / 2;
      const w = 0.6 + d() * 0.3;
      const h = 0.55 + d() * 0.25;
      const r: Rect = alongX
        ? { x: mid, z: ac.z, hw: len / 2, hd: w / 2 }
        : { x: ac.x, z: mid, hw: w / 2, hd: len / 2 };
      // The run ends AT the two units it joins: test it against the rest.
      const others = taken.filter(
        (t) =>
          !overlaps(
            t,
            { x: ac.x, z: ac.z, hw: ac.width / 2, hd: ac.depth / 2 },
            -0.01,
          ) &&
          !overlaps(
            t,
            { x: px, z: pz, hw: penthouse.width / 2, hd: penthouse.depth / 2 },
            -0.01,
          ),
      );
      if (others.every((t) => !overlaps(r, t, 0.2))) {
        part(out.boxes, {
          x: r.x,
          y,
          z: r.z,
          sx: r.hw * 2,
          sy: h,
          sz: r.hd * 2,
          tone: DUCT_TONE,
        });
        claim(r);
      }
    }
  }

  // --- Free-standing vent stacks with rain caps.
  const stacks = rVents < 0.35 ? 0 : rVents < 0.8 ? 1 : 2;
  for (let i = 0; i < stacks; i++) {
    const r0 = 0.12 + d() * 0.1;
    const h = 1.2 + d() * 1.0;
    const r = spot(r0 + 0.2, r0 + 0.2);
    if (!r) continue;
    claim(r);
    part(out.cylinders, {
      x: r.x,
      y,
      z: r.z,
      sx: r0,
      sy: h,
      sz: r0,
      tone: VENT_TONE,
    });
    part(out.cylinders, {
      x: r.x,
      y: y + h,
      z: r.z,
      sx: r0 * 1.8,
      sy: 0.1,
      sz: r0 * 1.8,
      tone: VENT_CAP_TONE,
    });
  }

  // --- Solar array: rows of tilted dark-blue glass in aluminium frames.
  if (flat && rSolar < SOLAR_CHANCE && b.height < SOLAR_MAX_HEIGHT) {
    const rows = 3 + Math.floor(d() * 4);
    const rowLen = Math.min(innerW * 1.2, 6 + d() * 10);
    const r = spot(rowLen / 2, (rows * SOLAR_PITCH) / 2);
    if (r && rowLen >= 4) {
      claim(r);
      const lift = 0.42;
      for (let k = 0; k < rows; k++) {
        const z = r.z - r.hd + SOLAR_PITCH * (k + 0.5);
        part(out.boxes, {
          x: r.x,
          y: y + lift,
          z,
          sx: rowLen,
          sy: 0.05,
          sz: SOLAR_DEPTH,
          tilt: -SOLAR_TILT,
          tone: SOLAR_FRAME_TONE,
        });
        part(out.boxes, {
          x: r.x,
          y: y + lift + 0.04,
          z,
          sx: rowLen - 0.1,
          sy: 0.04,
          sz: SOLAR_DEPTH - 0.1,
          tilt: -SOLAR_TILT,
          tone: SOLAR_GLASS_TONE,
        });
      }
    }
  }

  // --- Satellite dishes on a pedestal.
  const dishes = b.height < 30 || rDish < 0.45 ? 0 : rDish < 0.85 ? 1 : 2;
  for (let i = 0; i < dishes; i++) {
    const radius = 0.45 + d() * 0.4;
    const ped = 0.8 + d() * 0.4;
    const yaw = DISH_YAW + (d() - 0.5) * 0.4;
    const r = spot(radius + 0.2, radius + 0.2);
    if (!r) continue;
    claim(r);
    part(out.boxes, {
      x: r.x,
      y,
      z: r.z,
      sx: 0.22,
      sy: ped,
      sz: 0.22,
      tone: PEDESTAL_TONE,
      fine: true,
    });
    part(out.cylinders, {
      x: r.x,
      y: y + ped,
      z: r.z,
      sx: radius,
      sy: 0.1,
      sz: radius,
      yaw,
      tilt: DISH_TILT,
      tone: DISH_TONE,
      fine: true,
    });
  }

  // --- Lightning rods at the four corners of tall roofs.
  if (b.height >= ROD_MIN_HEIGHT) {
    const ix = halfW - 1.2;
    const iz = halfD - 1.2;
    for (const [sx, sz] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ] as const) {
      const r: Rect = { x: b.x + sx * ix, z: b.z + sz * iz, hw: 0.1, hd: 0.1 };
      if (!taken.every((t) => !overlaps(r, t, 0.1))) continue;
      claim(r);
      part(out.boxes, {
        x: r.x,
        y,
        z: r.z,
        sx: 0.05,
        sy: 1.6,
        sz: 0.05,
        tone: ROD_TONE,
        fine: true,
      });
    }
  }

  // --- Window-cleaning davits on tall towers, often with the gondola down
  // the facade (facade garnish: ≤ 1.1 m out from the wall, under the roof).
  if (b.height >= DAVIT_MIN_HEIGHT && rDavit < DAVIT_CHANCE) {
    const face = Math.floor(d() * 4);
    const hang = d();
    const depthRoll = d();
    const [nx, nz] = faceDir(face);
    const edge = face < 2 ? halfW : halfD;
    const along = face < 2 ? innerD : innerW;
    const at = (d() * 2 - 1) * Math.max(0, along - DAVIT_SPAN);
    const postIn = edge - 1.0; // on the coping, inside the parapet
    const posts: [number, number][] = [-1, 1].map((k) => {
      const t = at + (k * DAVIT_SPAN) / 2;
      return face < 2
        ? [b.x + nx * postIn, b.z + t]
        : [b.x + t, b.z + nz * postIn];
    });
    const r: Rect =
      face < 2
        ? {
            x: b.x + nx * postIn,
            z: b.z + at,
            hw: 0.3,
            hd: DAVIT_SPAN / 2 + 0.3,
          }
        : {
            x: b.x + at,
            z: b.z + nz * postIn,
            hw: DAVIT_SPAN / 2 + 0.3,
            hd: 0.3,
          };
    if (Math.abs(at) + DAVIT_SPAN / 2 <= along && free(r)) {
      claim(r);
      const reach = 1.35; // post to arm tip, out past the parapet
      for (const [px, pz] of posts) {
        part(out.boxes, {
          x: px,
          y,
          z: pz,
          sx: 0.18,
          sy: DAVIT_POST,
          sz: 0.18,
          tone: DAVIT_TONE,
        });
        part(out.boxes, {
          x: px + (nx * reach) / 2,
          y: y + DAVIT_POST,
          z: pz + (nz * reach) / 2,
          sx: face < 2 ? reach : 0.15,
          sy: 0.15,
          sz: face < 2 ? 0.15 : reach,
          tone: DAVIT_TONE,
        });
      }
      const drop = 6 + depthRoll * Math.min(30, top.height - 10);
      if (hang < 0.6 && top.height >= 12) {
        const gy = y - drop;
        const out1 = edge + 0.35 + 0.35; // gondola centre off the wall
        const gx = face < 2 ? b.x + nx * out1 : b.x + at;
        const gz = face < 2 ? b.z + at : b.z + nz * out1;
        part(out.boxes, {
          x: gx,
          y: gy,
          z: gz,
          sx: face < 2 ? 0.7 : DAVIT_SPAN + 0.2,
          sy: 1.0,
          sz: face < 2 ? DAVIT_SPAN + 0.2 : 0.7,
          tone: GONDOLA_TONE,
        });
        for (const [px, pz] of posts) {
          const tip = edge + 0.3;
          part(out.boxes, {
            x: face < 2 ? b.x + nx * tip : px,
            y: gy + 1.0,
            z: face < 2 ? pz : b.z + nz * tip,
            sx: 0.03,
            sy: y + DAVIT_POST - (gy + 1.0),
            sz: 0.03,
            tone: CABLE_TONE,
            fine: true,
          });
        }
      }
    }
  }

  // --- Maintenance walkway: pads from the penthouse door out across the
  // membrane, stopping short of whatever stands in the way.
  if (penthouse) {
    const [nx, nz] = faceDir(penthouse.face);
    const half = penthouse.face < 2 ? penthouse.width / 2 : penthouse.depth / 2;
    const ox = b.x + penthouse.dx + nx * half;
    const oz = b.z + penthouse.dz + nz * half;
    let len = 0;
    for (let s = 1; s <= 10; s += 0.5) {
      const cx = ox + nx * s;
      const cz = oz + nz * s;
      const probe: Rect = { x: cx, z: cz, hw: 0.4, hd: 0.4 };
      if (Math.abs(cx - b.x) > innerW || Math.abs(cz - b.z) > innerD) break;
      if (!taken.every((t) => !overlaps(probe, t, 0))) break;
      len = s;
    }
    if (len >= 2) {
      const r: Rect = {
        x: ox + (nx * len) / 2,
        z: oz + (nz * len) / 2,
        hw: nx !== 0 ? len / 2 : 0.4,
        hd: nz !== 0 ? len / 2 : 0.4,
      };
      claim(r);
      part(out.boxes, {
        x: r.x,
        y,
        z: r.z,
        sx: nx !== 0 ? len : 0.7,
        sy: 0.05,
        sz: nz !== 0 ? len : 0.7,
        tone: WALKWAY_TONE,
        fine: true,
      });
    }
  }

  // --- Roof hatch (a curb and lid) and drains near the edges.
  if (rHatch < 0.6) {
    const r = spot(0.7, 0.7);
    if (r) {
      claim(r);
      part(out.boxes, {
        x: r.x,
        y,
        z: r.z,
        sx: 1.0,
        sy: 0.4,
        sz: 1.0,
        tone: HATCH_TONE,
        fine: true,
      });
    }
  }
  const drains = 2 + Math.floor(rDrain * 3);
  for (let i = 0; i < drains; i++) {
    const side = Math.floor(d() * 4);
    const t = d() * 2 - 1;
    const x = side < 2 ? (side === 0 ? innerW : -innerW) : t * innerW;
    const z = side < 2 ? t * innerD : side === 2 ? innerD : -innerD;
    const r: Rect = { x: b.x + x, z: b.z + z, hw: 0.25, hd: 0.25 };
    if (!free(r)) continue;
    claim(r);
    part(out.boxes, {
      x: r.x,
      y,
      z: r.z,
      sx: 0.45,
      sy: 0.03,
      sz: 0.45,
      tone: DRAIN_TONE,
      fine: true,
    });
  }

  // --- DT2: the last pass, on its own stream, so everything above is
  // byte-identical with or without it.
  dressDt2(b, top, kind, { innerW, innerD, free, claim, part, out });

  return out;
}

// --- DT2: laundry, pigeons, gardens and neon on the roofs -----------------

/** DT2 fold distances (RoofPart.fade), m — the small things go first, and
 * a neon letter stroke folds before it is thin enough to sparkle. */
export const DT2_FADE = {
  pigeon: 170,
  bench: 260,
  laundry: 300,
  letters: 340,
  garden: 440,
  sign: 560,
} as const;
/** Chances, rolled once per roof on the DT2 stream. */
export const LAUNDRY_CHANCE = 0.3;
export const PIGEON_CHANCE = 0.4;
export const NEON_CHANCE = 0.16;
/** Neon signs crown mid-rises: high enough to be seen over the street
 * wall, low enough to sit under the flight band's roofs. */
export const NEON_MIN_HEIGHT = 25;
/** Neon letters glow just under the bloom threshold (0.72): a colour that
 * reads, never a blooming stroke that sparkles as it thins with distance. */
export const NEON_LUMINANCE = 0.68;
/** Pixel-font cell, m: letters are 5 cells (1.6 m) tall, strokes 0.32 m. */
export const NEON_CELL = 0.32;
const NEON_LEGS = 0.4;
const NEON_MARGIN = 0.2;
const NEON_BOARD_DEPTH = 0.14;
const NEON_LETTER_DEPTH = 0.08;
/** Words a neon roof sign may spell (every glyph is in pixel-font.ts). */
export const NEON_WORDS = [
  "HOTEL",
  "BAR",
  "JAZZ",
  "LIVE",
  "OPEN",
  "CAFE",
  "DINER",
  "MOTEL",
  "RADIO",
  "CLUB",
  "EAT",
  "PIZZA",
  "ROXY",
  "TAXI",
  "GIN",
  "DANCE",
  "NEON",
  "SODA",
  "GRILL",
] as const;
const NEON_TONES = [
  0xff2d95, 0x2de2ff, 0xff3b30, 0xffb02d, 0x3dff7a, 0xb44dff,
] as const;
const NEON_BOOSTS = NEON_TONES.map((t) => boostOf(t, NEON_LUMINANCE));
const SIGN_BOARD_TONE = 0x1d2026;
const SIGN_STEEL_TONE = 0x4a4f57;
const LAUNDRY_POST_TONE = 0x8e949a;
const LINE_TONE = 0xc9cdd2;
const CLOTH_TONES = [
  0xf2f2ee, 0xd8dde6, 0x3a6fd8, 0xd23a4a, 0xf2c94c, 0x2bb673, 0xe58fb8,
  0x9b51e0, 0x1e2430, 0xff8a4c,
] as const;
const PIGEON_TONES = [
  0x6b7280, 0x58606c, 0x8a8f99, 0x3f4248, 0xb9b6ae,
] as const;
const BED_TONES = [0x6b4a32, 0x5a3d2a, 0x7a5a3c, 0x55585e] as const;
const LEAF_TONES = [0x2f5a2a, 0x3d6b2f, 0x24502a, 0x4a7a34, 0x365e3a] as const;
const BLOOM_TONES = [0xd9467a, 0xe8c13a, 0xf2f2f2, 0xb05ad9, 0xff8a4c] as const;
const TRUNK_TONE = 0x4a3526;

interface Dt2Context {
  innerW: number;
  innerD: number;
  free: (r: Rect) => boolean;
  claim: (r: Rect) => void;
  part: (
    list: RoofPart[],
    p: Partial<RoofPart> &
      Pick<RoofPart, "x" | "y" | "z" | "sx" | "sy" | "sz" | "tone">,
  ) => void;
  out: RoofDetails;
}

/**
 * DT2 roof dressing for one roof — run LAST in layoutDetails, on its own
 * salted stream, against every keep-out already taken (structures, HVAC,
 * L8 life, R2 dressing), claiming its own rects into `out.rects` so the
 * terrace people and anything placed later step around it. Everything is
 * fine detail under ROOF_CLUTTER_MAX_HEIGHT and folds away with distance.
 */
function dressDt2(
  b: Building,
  top: { width: number; depth: number },
  kind: number | undefined,
  c: Dt2Context,
): void {
  const { innerW, innerD, free, claim, out } = c;
  const y = b.height;
  const rand = mulberry32(
    (Math.imul(b.x, 0x5f356495) ^
      Math.imul(b.z, 0x2c9277b5) ^
      Math.imul(b.height, 0x4cf5ad43) ^
      0x0d72c0de) >>>
      0,
  );
  const rLaundry = rand();
  const rPigeons = rand();
  const rNeon = rand();
  const rNeonWord = rand();
  const rNeonFace = rand();
  const rNeonTone = rand();
  const g = mulberry32((rand() * 4294967296) >>> 0);
  const flat = kind === RoofKind.MEMBRANE || kind === RoofKind.GRAVEL;
  const part = (
    list: RoofPart[],
    fade: number,
    p: Partial<RoofPart> &
      Pick<RoofPart, "x" | "y" | "z" | "sx" | "sy" | "sz" | "tone">,
  ) => c.part(list, { fine: true, fade, ...p });
  /** A free hw×hd spot on the inner roof (own stream), or null. */
  const spot = (hw: number, hd: number): Rect | null => {
    if (hw > innerW || hd > innerD) return null;
    for (let i = 0; i < TRIES; i++) {
      const r: Rect = {
        x: b.x + (g() * 2 - 1) * (innerW - hw),
        z: b.z + (g() * 2 - 1) * (innerD - hd),
        hw,
        hd,
      };
      if (free(r)) return r;
    }
    return null;
  };

  // --- Neon roof sign: a dark board on short legs at one roof edge, its
  // word spelled in pixel-font runs facing the street.
  if (
    flat &&
    rNeon < NEON_CHANCE &&
    b.height >= NEON_MIN_HEIGHT &&
    b.height < LIFE_MAX_HEIGHT
  ) {
    const first = Math.floor(rNeonFace * 4);
    const w0 = Math.floor(rNeonWord * NEON_WORDS.length);
    const toneI = Math.floor(rNeonTone * NEON_TONES.length);
    for (let k = 0; k < 4; k++) {
      const face = (first + k) % 4;
      const [nx, nz] = faceDir(face);
      const innerN = face < 2 ? innerW : innerD;
      const innerAlong = face < 2 ? innerD : innerW;
      // The longest word (from the rolled one on) that fits this edge.
      let word = "";
      for (let i = 0; i < NEON_WORDS.length; i++) {
        const w = NEON_WORDS[(w0 + i) % NEON_WORDS.length] as string;
        if (wordCells(w) * NEON_CELL + 2 * NEON_MARGIN + 0.6 <= innerAlong) {
          word = w;
          break;
        }
      }
      if (!word || innerN < 1.5) continue;
      const boardW = wordCells(word) * NEON_CELL + 2 * NEON_MARGIN;
      const across = 0.6;
      const cx = b.x + nx * (innerN - across);
      const cz = b.z + nz * (innerN - across);
      const r: Rect =
        face < 2
          ? { x: cx, z: cz, hw: across, hd: boardW / 2 + 0.2 }
          : { x: cx, z: cz, hw: boardW / 2 + 0.2, hd: across };
      if (!free(r)) continue;
      claim(r);
      // Board plane 0.5 m in from the inner edge; letters on its outer face.
      const plane = innerN - 0.5;
      const boardH = GLYPH_H * NEON_CELL + 2 * NEON_MARGIN;
      const at = (n: number, s: number) =>
        // n outward, s along the reader's right: (nz, −nx).
        [b.x + nx * n + nz * s, b.z + nz * n - nx * s] as const;
      const [bx, bz] = at(plane, 0);
      part(out.boxes, DT2_FADE.sign, {
        x: bx,
        y: y + NEON_LEGS,
        z: bz,
        sx: face < 2 ? NEON_BOARD_DEPTH : boardW,
        sy: boardH,
        sz: face < 2 ? boardW : NEON_BOARD_DEPTH,
        tone: SIGN_BOARD_TONE,
      });
      // Legs under the board and raking back-stays behind it.
      for (const s of [-boardW / 2 + 0.15, 0, boardW / 2 - 0.15]) {
        const [lx, lz] = at(plane, s);
        part(out.boxes, DT2_FADE.sign, {
          x: lx,
          y,
          z: lz,
          sx: 0.1,
          sy: NEON_LEGS,
          sz: 0.1,
          tone: SIGN_STEEL_TONE,
        });
        const [sx, sz] = at(plane - 0.45, s);
        part(out.boxes, DT2_FADE.sign, {
          x: sx,
          y,
          z: sz,
          sx: 0.08,
          sy: Math.hypot(0.45, 1.5),
          sz: 0.08,
          yaw: faceYaw(face),
          tilt: Math.atan2(0.45, 1.5),
          tone: SIGN_STEEL_TONE,
        });
      }
      // The word: one lit box per run, a few cm proud of the board.
      const n = plane + NEON_BOARD_DEPTH / 2 + NEON_LETTER_DEPTH / 2 + 0.01;
      const wordW = wordCells(word) * NEON_CELL;
      const tone = NEON_TONES[toneI] as number;
      const boost = NEON_BOOSTS[toneI] as number;
      for (const run of wordRuns(word)) {
        const s = -wordW / 2 + (run.col + run.len / 2) * NEON_CELL;
        const [lx, lz] = at(n, s);
        const len = run.len * NEON_CELL;
        part(out.lit, DT2_FADE.letters, {
          x: lx,
          y: y + NEON_LEGS + NEON_MARGIN + (GLYPH_H - 1 - run.row) * NEON_CELL,
          z: lz,
          sx: face < 2 ? NEON_LETTER_DEPTH : len,
          sy: NEON_CELL,
          sz: face < 2 ? len : NEON_LETTER_DEPTH,
          tone,
          boost,
        });
      }
      break;
    }
  }

  // --- Laundry: two lines on T-posts, a row of garments on each (static —
  // the roof batches do not animate).
  if (flat && rLaundry < LAUNDRY_CHANCE && b.height < LIFE_MAX_HEIGHT) {
    const len = 4 + g() * 3;
    const alongX = g() < 0.5;
    const r = alongX ? spot(len / 2 + 0.2, 0.45) : spot(0.45, len / 2 + 0.2);
    if (r) {
      claim(r);
      const lineY = 1.85;
      const pos = (along: number, across: number) =>
        alongX
          ? ([r.x + along, r.z + across] as const)
          : ([r.x + across, r.z + along] as const);
      for (const end of [-len / 2, len / 2]) {
        const [px, pz] = pos(end, 0);
        part(out.boxes, DT2_FADE.laundry, {
          x: px,
          y,
          z: pz,
          sx: 0.08,
          sy: lineY + 0.05,
          sz: 0.08,
          tone: LAUNDRY_POST_TONE,
        });
        part(out.boxes, DT2_FADE.laundry, {
          x: px,
          y: y + lineY - 0.03,
          z: pz,
          sx: alongX ? 0.08 : 0.7,
          sy: 0.06,
          sz: alongX ? 0.7 : 0.08,
          tone: LAUNDRY_POST_TONE,
        });
      }
      for (const across of [-0.28, 0.28]) {
        const [lx, lz] = pos(0, across);
        part(out.boxes, DT2_FADE.laundry, {
          x: lx,
          y: y + lineY - 0.02,
          z: lz,
          sx: alongX ? len : 0.02,
          sy: 0.02,
          sz: alongX ? 0.02 : len,
          tone: LINE_TONE,
        });
        let a = -len / 2 + 0.25;
        for (;;) {
          const w = 0.35 + g() * 0.4;
          const drop = 0.35 + g() * 0.5;
          const gap = 0.08 + g() * 0.25;
          const skip = g() < 0.2;
          const toneRoll = g();
          if (a + w > len / 2 - 0.2) break;
          if (!skip) {
            const [gx, gz] = pos(a + w / 2, across);
            part(out.boxes, DT2_FADE.laundry, {
              x: gx,
              y: y + lineY - 0.02 - drop,
              z: gz,
              sx: alongX ? w : 0.03,
              sy: drop,
              sz: alongX ? 0.03 : w,
              tone: pick(CLOTH_TONES, toneRoll),
            });
          }
          a += w + gap;
        }
      }
    }
  }

  // --- Pigeons: a small flock pecking about the deck.
  if (rPigeons < PIGEON_CHANCE) {
    const r = spot(0.8, 0.8);
    if (r) {
      claim(r);
      const count = 4 + Math.floor(g() * 5);
      const placed: [number, number][] = [];
      for (let i = 0; i < count; i++) {
        const px = r.x + (g() * 2 - 1) * (r.hw - 0.18);
        const pz = r.z + (g() * 2 - 1) * (r.hd - 0.18);
        const yaw = g() * Math.PI * 2;
        const tone = pick(PIGEON_TONES, g());
        if (placed.some(([qx, qz]) => Math.hypot(qx - px, qz - pz) < 0.3))
          continue;
        placed.push([px, pz]);
        part(out.boxes, DT2_FADE.pigeon, {
          x: px,
          y,
          z: pz,
          sx: 0.13,
          sy: 0.16,
          sz: 0.28,
          yaw,
          tone,
        });
        part(out.boxes, DT2_FADE.pigeon, {
          x: px + Math.sin(yaw) * 0.15,
          y: y + 0.13,
          z: pz + Math.cos(yaw) * 0.15,
          sx: 0.08,
          sy: 0.09,
          sz: 0.09,
          yaw,
          tone,
        });
      }
    }
  }

  // --- Roof gardens: raised beds in bloom, potted trees and a bench on
  // every GARDEN roof (the painted green deck under them).
  if (kind === RoofKind.GARDEN) {
    const beds = 3 + Math.floor(g() * 5);
    for (let i = 0; i < beds; i++) {
      const long = 1.8 + g() * 1.4;
      const wide = 0.8 + g() * 0.2;
      const alongX = g() < 0.5;
      const leaf = pick(LEAF_TONES, g());
      const leafH = 0.25 + g() * 0.3;
      const bloom = g();
      const r = alongX ? spot(long / 2, wide / 2) : spot(wide / 2, long / 2);
      if (!r) continue;
      claim(r);
      part(out.boxes, DT2_FADE.garden, {
        x: r.x,
        y,
        z: r.z,
        sx: r.hw * 2,
        sy: 0.45,
        sz: r.hd * 2,
        tone: pick(BED_TONES, (bloom * 7.1) % 1),
      });
      part(out.boxes, DT2_FADE.garden, {
        x: r.x,
        y: y + 0.45,
        z: r.z,
        sx: r.hw * 2 - 0.16,
        sy: leafH,
        sz: r.hd * 2 - 0.16,
        tone: leaf,
      });
      if (bloom < 0.55) {
        part(out.boxes, DT2_FADE.garden, {
          x: r.x,
          y: y + 0.45 + leafH,
          z: r.z,
          sx: r.hw * 1.3,
          sy: 0.12,
          sz: r.hd * 1.3,
          tone: pick(BLOOM_TONES, bloom / 0.55),
        });
      }
    }
    const trees = 1 + Math.floor(g() * 3);
    for (let i = 0; i < trees; i++) {
      const yaw = g() * Math.PI;
      const leaf = pick(LEAF_TONES, g());
      const r = spot(0.75, 0.75);
      if (!r) continue;
      claim(r);
      part(out.boxes, DT2_FADE.garden, {
        x: r.x,
        y,
        z: r.z,
        sx: 0.7,
        sy: 0.5,
        sz: 0.7,
        tone: BED_TONES[3],
      });
      part(out.boxes, DT2_FADE.garden, {
        x: r.x,
        y: y + 0.5,
        z: r.z,
        sx: 0.12,
        sy: 0.9,
        sz: 0.12,
        tone: TRUNK_TONE,
      });
      part(out.boxes, DT2_FADE.garden, {
        x: r.x,
        y: y + 1.3,
        z: r.z,
        sx: 1.3,
        sy: 0.6,
        sz: 1.3,
        yaw,
        tone: leaf,
      });
      part(out.boxes, DT2_FADE.garden, {
        x: r.x,
        y: y + 1.9,
        z: r.z,
        sx: 0.85,
        sy: 0.45,
        sz: 0.85,
        yaw: yaw + 0.6,
        tone: leaf,
      });
    }
    const alongX = g() < 0.5;
    const r = alongX ? spot(0.85, 0.3) : spot(0.3, 0.85);
    if (r) {
      claim(r);
      const wood = pick(BED_TONES, 0.2);
      part(out.boxes, DT2_FADE.bench, {
        x: r.x,
        y: y + 0.4,
        z: r.z,
        sx: alongX ? 1.6 : 0.45,
        sy: 0.07,
        sz: alongX ? 0.45 : 1.6,
        tone: wood,
      });
      for (const s of [-0.7, 0.7]) {
        part(out.boxes, DT2_FADE.bench, {
          x: r.x + (alongX ? s : 0),
          y,
          z: r.z + (alongX ? 0 : s),
          sx: alongX ? 0.07 : 0.4,
          sy: 0.4,
          sz: alongX ? 0.4 : 0.07,
          tone: SIGN_STEEL_TONE,
        });
      }
    }
  }
}

/**
 * Everything already standing on `b`'s top roof, as plan-view keep-out
 * rects: solid structures and HVAC (roof-layout), L8's party, pool, fans
 * and flags, and every free-standing R2 and DT2 part. The ONE seam later
 * roof dressing (A1 terrace people, W3 nests, D9 debris) steps around.
 */
export function roofKeepOuts(b: Building): Rect[] {
  const life = rooftopLifeFor(b);
  const out: Rect[] = [
    ...clutterRects(b, roofClutterFor(b)),
    ...roofDetailsFor(b).rects,
    ...life.fans.map((f) => ({
      x: f.x,
      z: f.z,
      hw: f.radius + 0.3,
      hd: f.radius + 0.3,
    })),
    ...life.flags.map((f) => ({ x: f.x, z: f.z, hw: 0.4, hd: 0.4 })),
  ];
  if (life.party) {
    const p = life.party;
    out.push({ x: p.x, z: p.z, hw: p.halfW, hd: p.halfD });
  }
  if (life.pool) {
    const p = life.pool;
    out.push({ x: p.x, z: p.z, hw: p.halfW + 0.4, hd: p.halfD + 0.4 });
  }
  return out;
}

/** A structure's body, 1:1 with its collider, plus its ≤ 2.5 m dressing. */
function dressStructure(
  b: Building,
  s: RoofStructure,
  out: RoofDetails,
  part: (
    list: RoofPart[],
    p: Partial<RoofPart> &
      Pick<RoofPart, "x" | "y" | "z" | "sx" | "sy" | "sz" | "tone">,
  ) => void,
): void {
  const x = b.x + s.dx;
  const z = b.z + s.dz;
  const body = (list: RoofPart[], height: number, tone: number) =>
    part(list, {
      x,
      y: s.baseY,
      z,
      sx: s.round ? s.width / 2 : s.width,
      sy: height,
      sz: s.round ? s.depth / 2 : s.depth,
      tone,
      solid: true,
    });
  const [nx, nz] = faceDir(s.face);
  const half = s.face < 2 ? s.width / 2 : s.depth / 2;
  switch (s.kind) {
    case "penthouse": {
      body(out.boxes, s.height, pick(PENTHOUSE_TONES, s.seed));
      // Door, lamp and canopy on the door face — all under the clutter line.
      const onFace = (off: number) => [
        x + nx * (half + off),
        z + nz * (half + off),
      ];
      const [dx, dz] = onFace(0.0);
      const doorW = 1.0;
      part(out.boxes, {
        x: dx as number,
        y: s.baseY,
        z: dz as number,
        sx: s.face < 2 ? 0.08 : doorW,
        sy: 2.0,
        sz: s.face < 2 ? doorW : 0.08,
        tone: DOOR_TONE,
      });
      const [lx, lz] = onFace(0.08);
      part(out.lit, {
        x: lx as number,
        y: s.baseY + 2.08,
        z: lz as number,
        sx: s.face < 2 ? 0.16 : 0.3,
        sy: 0.14,
        sz: s.face < 2 ? 0.3 : 0.16,
        tone: DOOR_LAMP_TONE,
        boost: DOOR_LAMP_BOOST,
      });
      const [cx, cz] = onFace(0.28);
      part(out.boxes, {
        x: cx as number,
        y: s.baseY + 2.3,
        z: cz as number,
        sx: s.face < 2 ? 0.56 : 1.5,
        sy: 0.08,
        sz: s.face < 2 ? 1.5 : 0.56,
        tone: CANOPY_TONE,
      });
      return;
    }
    case "coolingTower":
      // The casing; its fan and shroud (the top COOLING_SHROUD) are
      // rooftop-life's GPU-spun fans.
      body(out.boxes, s.height - COOLING_SHROUD, pick(COOLING_TONES, s.seed));
      return;
    case "waterTank":
      body(out.cylinders, s.height, toneAt(TANK_TONES, x, z));
      return;
    case "billboardLeg":
      body(out.boxes, s.height, LEG_TONE);
      out.boxes.push(braceFor(b, s));
      return;
    case "billboard": {
      body(out.boxes, s.height, BOARD_BACK_TONE);
      const len = s.face < 2 ? s.depth : s.width;
      const front = BILLBOARD_THICKNESS / 2;
      // Face art: two bands, a hair proud of the panel's front face.
      const hueA = Math.floor(s.seed * AD_TONES.length) % AD_TONES.length;
      const hueB =
        (hueA + 1 + (Math.floor(s.seed * 97) % (AD_TONES.length - 1))) %
        AD_TONES.length;
      const margin = 0.18;
      const faceH = s.height - 2 * margin;
      const split = 0.62;
      const plate = (y0: number, h: number, hue: number) =>
        part(out.lit, {
          x: x + nx * (front + 0.01) - nx * 0.02,
          y: y0,
          z: z + nz * (front + 0.01) - nz * 0.02,
          sx: s.face < 2 ? 0.04 : len - 2 * margin,
          sy: h,
          sz: s.face < 2 ? len - 2 * margin : 0.04,
          tone: AD_TONES[hue] as number,
          boost: AD_BOOSTS[hue] as number,
        });
      plate(s.baseY + margin + faceH * (1 - split), faceH * split, hueA);
      plate(s.baseY + margin, faceH * (1 - split) - 0.05, hueB);
      // Lit frame: lamp strips along all four edges of the face.
      const strip = (y0: number, h: number, t: number, w: number) =>
        part(out.lit, {
          x: x + nx * (front + 0.03) + (s.face < 2 ? 0 : t),
          y: y0,
          z: z + nz * (front + 0.03) + (s.face < 2 ? t : 0),
          sx: s.face < 2 ? 0.06 : w,
          sy: h,
          sz: s.face < 2 ? w : 0.06,
          tone: FRAME_TONE,
          boost: FRAME_BOOST,
        });
      strip(s.baseY + s.height - 0.12, 0.1, 0, len - 0.1);
      strip(s.baseY + 0.02, 0.1, 0, len - 0.1);
      strip(s.baseY + 0.02, s.height - 0.04, -(len / 2 - 0.08), 0.1);
      strip(s.baseY + 0.02, s.height - 0.04, len / 2 - 0.08, 0.1);
      // Catwalk at the panel's foot, in front (clutter: 2.4 m up).
      const cw = front + BILLBOARD_CATWALK / 2;
      part(out.boxes, {
        x: x + nx * cw,
        y: s.baseY - 0.1,
        z: z + nz * cw,
        sx: s.face < 2 ? BILLBOARD_CATWALK : len,
        sy: 0.08,
        sz: s.face < 2 ? len : BILLBOARD_CATWALK,
        tone: CATWALK_TONE,
        fine: true,
      });
      return;
    }
    case "mast":
      // Drawn by roofclutter's mast + tip meshes from roofClutterFor().masts.
      return;
  }
}

/** A billboard leg's back brace: a strut from the deck behind the leg up to
 * under the panel, leaning towards it (clutter: 2.2 m up). It stands inside
 * the billboard's keep-out (structureRect). */
function braceFor(b: Building, leg: RoofStructure): RoofPart {
  const [nx, nz] = faceDir(leg.face);
  const back = 1.0;
  const rise = BILLBOARD_LIFT - 0.2;
  return {
    x: b.x + leg.dx - nx * back,
    y: b.height,
    z: b.z + leg.dz - nz * back,
    sx: 0.12,
    sy: Math.hypot(back, rise),
    sz: 0.12,
    yaw: faceYaw(leg.face),
    tilt: Math.atan2(back, rise),
    tone: LEG_TONE,
    boost: 0,
    fine: true,
    fade: 0,
    solid: false,
    structure: leg,
  };
}

// --- D8: what still stands ------------------------------------------------

/** Is structure `s` (one of generatedRoof(b)) drawn right now? Exactly while
 * it is in the live `b.roof` (common/src/city/standing.ts syncRoof) — the
 * list collision, sight lines and rays read, so drawing a tank and crashing
 * into it agree after any damage. */
export const structureDrawn = (b: Building, s: RoofStructure): boolean =>
  b.roof === generatedRoof(b) || (b.roof?.includes(s) ?? false);

/** The structures whose bodies the roof renderer draws for `b` right now
 * (equal to the live `b.roof`, in its order). */
export function drawnStructures(b: Building): readonly RoofStructure[] {
  return (generatedRoof(b) ?? []).filter((s) => structureDrawn(b, s));
}

const corner = new THREE.Vector3();
const partMatrix = new THREE.Matrix4();
const tiltMatrix = new THREE.Matrix4();

/**
 * A part's world-axis bounding box in its building's frame (x/z from the
 * building's centre, y from the ground): the unit box or cylinder scaled,
 * tilted and yawed as the renderer draws it. `cylinder`: radius sx/sz.
 */
export function partBox(
  b: Building,
  p: RoofPart,
  cylinder: boolean,
  out: LocalBox = { x0: 0, x1: 0, y0: 0, y1: 0, z0: 0, z1: 0 },
): LocalBox {
  const hx = cylinder ? p.sx : p.sx / 2;
  const hz = cylinder ? p.sz : p.sz / 2;
  partMatrix.makeRotationY(p.yaw).multiply(tiltMatrix.makeRotationX(p.tilt));
  const cx = wrapDeltaAxis(b.x, p.x);
  const cz = wrapDeltaAxis(b.z, p.z);
  out.x0 = out.y0 = out.z0 = Number.POSITIVE_INFINITY;
  out.x1 = out.y1 = out.z1 = Number.NEGATIVE_INFINITY;
  for (let k = 0; k < 8; k++) {
    corner
      .set(k & 1 ? hx : -hx, k & 2 ? p.sy : 0, k & 4 ? hz : -hz)
      .applyMatrix4(partMatrix);
    out.x0 = Math.min(out.x0, cx + corner.x);
    out.x1 = Math.max(out.x1, cx + corner.x);
    out.y0 = Math.min(out.y0, p.y + corner.y);
    out.y1 = Math.max(out.y1, p.y + corner.y);
    out.z0 = Math.min(out.z0, cz + corner.z);
    out.z1 = Math.max(out.z1, cz + corner.z);
  }
  return out;
}
