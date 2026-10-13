// L7 Inferno — the city burns like reference 2. As the room's BURN LEVEL
// rises (common/src/burn.ts: server-authoritative, room-wide, on the wire as
// `burn`), every client turns the same wreckage into the same inferno:
//
//  - FIRE SITES, derived from the client's own damage state, so every
//    client derives the same ones: a FLOOR fire on the top of each standing
//    chunk under a gone one, a WINDOW fire out of the outer face of each
//    standing facade chunk beside a gone one, and every C2 burning chunk
//    (`socket.fires`). Each damaged building keeps its SITES_PER_BUILDING
//    lowest-ranked candidates; a site's rank is a hash of its (building,
//    chunk) ids, and it comes alive smoothly as burn × the building's wear
//    passes that rank — so the fire spreads site by site as the war goes on
//    and never pops. D8: sites stand only on what stands (they are rebuilt
//    from the live cells whenever the building's damage version moves), so
//    the module is STANDING_EXEMPT rather than a StandingLayer.
//  - FLAMES (1 draw): three layered vertical-billboard cards per drawn site,
//    a procedural flame on the world clock, blended (never added: a stack
//    never sums past EMISSIVE_FIRE, under every tracer).
//  - SMOKE COLUMNS (1 draw): a black column of puffs over each burning
//    building's lead site, hundreds of metres up into the cloud deck,
//    leaning with the shared wind, lit orange from below by its fire.
//  - THE AIR (1 draw): embers swirling up, ash drifting down and debris
//    chunks tumbling round the biggest fires — static buffers animated in
//    the vertex shader, no per-particle CPU.
//  - and, at no draw, the firelight on facades and the street, the gutted
//    frames (inferno-shading.ts), the heat shimmer (fed to atmosphere-fx's
//    J1 heat list) and the glow on the cloud deck (fed to storm.ts).
//
// Ownership: fires.ts still licks small flames and smoke off C2's burning
// chunks into the D1 pool, and ruins.ts still smoulders felled lots; this
// module owns the big volumes, the columns, the air and the light.
//
// Placement follows the renderer's one rule: sites are canonical, and every
// drawn thing is written at its torus image nearest the viewer each frame.
// Everything is cut inside FOG_DISTANCE (< S/2), so an image flip happens
// fully fogged. The draw caps (FLAME_SITES_MAX, COLUMNS_MAX) fade the
// farthest picks out before the cut, so a swap at the cap is invisible.
// Every animation reads phases computed on the CPU in double precision from
// the latched world clock (`__ab.pinWorld` freezes it) — nothing wraps.

import { chunkCentreInto } from "@angels-bandits/common/chaos";
import {
  type Building,
  type LocalBox,
  cellBox,
  chunkAt,
  chunkBuilding,
  chunkCell,
  chunkId,
  chunkMask,
  chunkTier,
  standingTopAt,
  tierGrids,
} from "@angels-bandits/common/city";
import { EMISSIVE_FIRE, FOG_DISTANCE } from "@angels-bandits/common/constants";
import { type Wind, windAt } from "@angels-bandits/common/wind";
import {
  type Vec3,
  wrapCoord,
  wrapDeltaAxis,
} from "@angels-bandits/common/world";
import * as THREE from "three";
import { luminance } from "./emissive";
import type { Heat } from "./fx";
import {
  FIRE_LIGHTS,
  FIRE_LIGHT_COLOR_UNIFORM,
  FIRE_LIGHT_COUNT_UNIFORM,
  FIRE_LIGHT_UNIFORM,
  FIRE_PHASE_UNIFORM,
  FIRE_ZONES,
  FIRE_ZONE_COUNT_UNIFORM,
  FIRE_ZONE_UNIFORM,
  GUT_WEAR_LO,
  INFERNO_BURN_UNIFORM,
  setFirePhase,
} from "./inferno-shading";
import { QUALITY_PROFILES, type QualityTier } from "./quality";
import { RENDER_ORDER } from "./render-order";
import { nearestImageInto, uploadPrefix } from "./wrapPlacement";

/** Flame sites drawn at once (full share), and cards per site. */
export const FLAME_SITES_MAX = 220;
const CARDS = 3;
/** Smoke columns drawn at once (full share), and puffs per column. */
export const COLUMNS_MAX = 20;
const PUFFS = 16;
/** L7b: columns nearer than this are picked as though farther (a plume
 * reads from a distance; up close it is only a dark wall), m. */
const COLUMN_NEAR = 220;
/** Embers, ash and debris (full share), round AIR_ANCHORS fires. */
export const AIR_MAX = 1600;
const AIR_ANCHORS = 16;
/** L7b: embers and ash in the air round the camera (the same draw, its
 * first AIR_CAM points), in a CAM_BOX m cube that wraps with the view —
 * CAM_BOX divides WORLD_SIZE, so the torus wrap of the camera's render
 * position never moves a point. */
export const AIR_CAM = 480;
const CAM_BOX = 80;
/** Candidates a damaged building keeps (its lowest ranks). */
const SITES_PER_BUILDING = 32;
/** Nothing is drawn past this, m (inside the fog's full dissolve). */
const CUT_M = FOG_DISTANCE * 0.95;
/** A building rebuilds its sites at most this often, ms. */
const REBUILD_MS = 250;
/** A building this worn (share of its chunks gone) burns round its foot. */
const RUBBLE_WEAR = 0.06;
/** Site kinds. */
const KIND_FLOOR = 0;
const KIND_WINDOW = 1;
const KIND_C2 = 2;
/** L7b: a burning rubble field at the foot of a wrecked building. */
const KIND_RUBBLE = 3;
/** Rubble-field candidates round a wrecked building's footprint. */
const RUBBLE_SITES = 8;
/** A site comes alive over this much of the burn × wear scale. */
const RANK_SOFT = 0.08;
/** Fading slots (lights, air anchors) ease in and out at this rate, 1/s. */
const SLOT_RATE = 1.5;
/** Shimmer columns the fires add to the J1 heat list (after the blasts). */
const FIRE_SHIMMER_MAX = 3;
/** A fire's shimmer column per metre of its flame height (fx.ts Heat.size
 * is in blast units: BLAST_SHIMMER_HEIGHT ≈ 36 m each). */
const FIRE_SHIMMER_SIZE_PER_M = 1 / 16;
/** Fires shimmer only within this, m (atmosphere-fx's own range is wider). */
const FIRE_SHIMMER_RANGE = 320;
/** Cloud-deck glow spots (storm.ts CloudDeck.setGlow). */
export const CLOUD_GLOW_MAX = 8;
/** D11: a smoke puff is fully drawn from SMOKE_NEAR_FULL of its own size
 * away and gone at SMOKE_NEAR_GONE — measured on its TRUE size (the
 * overdraw clamp below shrinks a near puff to 0.9 × its distance, which had
 * left every near puff at ~97 % and a column beside the camera a hard,
 * near-black disc over half the sky). */
export const SMOKE_NEAR_FULL = 2.0;
export const SMOKE_NEAR_GONE = 0.6;
/** D11: a puff's most opaque (its core), and the share of the frame the
 * drawn columns may cover (Σ area × strength); past it every puff's
 * strength is scaled down to fit — like the collapse dust's budget. */
export const SMOKE_ALPHA_MAX = 0.85;
export const SMOKE_COVERAGE_MAX = 0.5;

/** smoothstep(e0, e1, x). */
const smoothstepJs = (e0: number, e1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** D11: the near-camera fade of a smoke puff `size` m across, `dist` m
 * from the camera — the GLSL's own formula (SMOKE_VERTEX). */
export const smokeNearFade = (size: number, dist: number): number =>
  smoothstepJs(SMOKE_NEAR_GONE * size, SMOKE_NEAR_FULL * size, dist);

/** D11: the scale on every puff's strength that keeps the columns'
 * frame coverage `cov` under SMOKE_COVERAGE_MAX. */
export const smokeCoverageScale = (cov: number): number =>
  cov > SMOKE_COVERAGE_MAX ? SMOKE_COVERAGE_MAX / cov : 1;

/** D11: the puff's radial opacity at r² (r = 1 at the card's edge, before
 * the noise): a soft falloff to exactly 0 at the edge, never saturating to
 * a hard rim — the GLSL's own formula (SMOKE_FRAGMENT). */
export const smokeShape = (r2: number, n = 0.5): number =>
  Math.min(
    SMOKE_ALPHA_MAX,
    Math.exp(-r2 * 1.8) * (1 - smoothstepJs(0.15, 1.0, r2)) * (0.6 + 1.1 * n),
  );
/** The flames' colour gain: the hottest core (1, 0.82, 0.5) peaks exactly
 * at the EMISSIVE_FIRE rung. */
const FIRE_GAIN = EMISSIVE_FIRE / luminance(new THREE.Color(1, 0.82, 0.5));
/** The air's phases' periods, s: debris arc, ember rise, ash fall. */
const AIR_PERIODS = [3.1, 4.3, 9.7] as const;
/** The firelight colour (linear) at strength 1. */
const FIRELIGHT_RGB = [1.0, 0.3, 0.07] as const;

/** Small integer hash → [0, 1) (seeded by ids, never by a pose). */
function hash01(a: number, b: number): number {
  let h =
    Math.imul((a | 0) + 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 17, 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x27d4eb2f);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

const smooth01 = (t: number): number => {
  const u = t < 0 ? 0 : t > 1 ? 1 : t;
  return u * u * (3 - 2 * u);
};

/** One damaged building's fire sites (canonical), rebuilt on a version bump. */
class BuildingSites {
  version = -1;
  builtAt = Number.NEGATIVE_INFINITY;
  n = 0;
  wear = 0;
  /** How alive its sites are: burn × wear scale, written each frame. */
  amount = 0;
  readonly x = new Float64Array(SITES_PER_BUILDING);
  readonly y = new Float64Array(SITES_PER_BUILDING);
  readonly z = new Float64Array(SITES_PER_BUILDING);
  /** Outward normal (window fires; 0 for floor fires). */
  readonly nx = new Float32Array(SITES_PER_BUILDING);
  readonly nz = new Float32Array(SITES_PER_BUILDING);
  readonly kind = new Uint8Array(SITES_PER_BUILDING);
  readonly rank = new Float32Array(SITES_PER_BUILDING);
  /** Flame width, m. */
  readonly size = new Float32Array(SITES_PER_BUILDING);
  /** Stable key: chunkId × 4 + kind. */
  readonly key = new Float64Array(SITES_PER_BUILDING);
}

/** Scratch for a building's candidate list before it keeps the best. */
const SCRATCH_MAX = 1024;
const scratch = {
  n: 0,
  x: new Float64Array(SCRATCH_MAX),
  y: new Float64Array(SCRATCH_MAX),
  z: new Float64Array(SCRATCH_MAX),
  nx: new Float32Array(SCRATCH_MAX),
  nz: new Float32Array(SCRATCH_MAX),
  kind: new Uint8Array(SCRATCH_MAX),
  rank: new Float32Array(SCRATCH_MAX),
  size: new Float32Array(SCRATCH_MAX),
  key: new Float64Array(SCRATCH_MAX),
};
const box: LocalBox = { x0: 0, x1: 0, y0: 0, y1: 0, z0: 0, z1: 0 };
const probe: Vec3 = { x: 0, y: 0, z: 0 };

/** Is cell `c` of tier `k` a chunk that still stands? */
function stands(
  masks: readonly Uint8Array[],
  cells: readonly Uint8Array[],
  k: number,
  c: number,
): boolean {
  return (masks[k]?.[c] ?? 0) !== 0 && (cells[k]?.[c] ?? 1) === 0;
}

function pushCandidate(
  index: number,
  kind: number,
  chunk: number,
  x: number,
  y: number,
  z: number,
  nx: number,
  nz: number,
  size: number,
): void {
  const key = chunk * 4 + kind;
  for (let i = 0; i < scratch.n; i++) if (scratch.key[i] === key) return;
  if (scratch.n >= SCRATCH_MAX) return;
  const i = scratch.n++;
  scratch.x[i] = x;
  scratch.y[i] = y;
  scratch.z[i] = z;
  scratch.nx[i] = nx;
  scratch.nz[i] = nz;
  scratch.kind[i] = kind;
  scratch.rank[i] = hash01(index, chunk * 4 + kind);
  scratch.size[i] = size;
  scratch.key[i] = key;
}

/**
 * Building `index`'s fire sites from its live cells, into `out` (canonical
 * coordinates). Pure in the building's damage state: every client gets the
 * same sites from the same wreckage.
 */
export function buildSites(
  b: Building,
  index: number,
  chunkTotal: number,
  out: BuildingSites,
): void {
  out.n = 0;
  const dmg = b.damage;
  if (!dmg || dmg.count === 0) {
    out.wear = 0;
    return;
  }
  out.wear = Math.min(1, dmg.count / Math.max(1, chunkTotal));
  const grids = tierGrids(b);
  const masks = chunkMask(b);
  const cells = dmg.cells;
  scratch.n = 0;
  for (let k = 0; k < grids.length; k++) {
    const g = grids[k];
    const tier = cells[k];
    const mask = masks[k];
    if (!g || !tier || !mask) continue;
    const layer = g.nx * g.nz;
    for (let c = 0; c < tier.length; c++) {
      if (tier[c] === 0 || mask[c] === 0) continue;
      const ix = c % g.nx;
      const iz = Math.floor(c / g.nx) % g.nz;
      const iy = Math.floor(c / layer);
      cellBox(g, c, box);
      const cx = (box.x0 + box.x1) / 2;
      const cz = (box.z0 + box.z1) / 2;
      // FLOOR: the gone chunk's floor is the top of what stands under it
      // (the next tier's top row, or the ground itself).
      let floor = false;
      if (iy > 0) floor = stands(masks, cells, k, c - layer);
      else if (box.y0 <= 0.01) floor = true;
      else {
        probe.x = cx;
        probe.y = box.y0 - 0.5;
        probe.z = cz;
        const at = chunkAt(b, probe);
        floor = at !== null && stands(masks, cells, at.tier, at.cell);
      }
      if (floor) {
        pushCandidate(
          index,
          KIND_FLOOR,
          chunkId(index, k, c),
          cx,
          box.y0,
          cz,
          0,
          0,
          // L7b: the whole floor ablaze, wall to wall.
          Math.min(g.cw, g.cd) * 1.05,
        );
      }
      // WINDOW: a standing facade neighbour on the same floor burns out of
      // its outer face.
      for (let q = 0; q < 4; q++) {
        const jx = ix + (q === 0 ? -1 : q === 1 ? 1 : 0);
        const jz = iz + (q === 2 ? -1 : q === 3 ? 1 : 0);
        if (jx < 0 || jx >= g.nx || jz < 0 || jz >= g.nz) continue;
        const n = (iy * g.nz + jz) * g.nx + jx;
        if (!stands(masks, cells, k, n)) continue;
        let fx = 0;
        let fz = 0;
        if (jx === 0) fx = -1;
        else if (jx === g.nx - 1) fx = 1;
        else if (jz === 0) fz = -1;
        else if (jz === g.nz - 1) fz = 1;
        else continue; // an inner chunk has no window
        cellBox(g, n, box);
        const wx = fx !== 0 ? fx * (g.width / 2 + 0.4) : (box.x0 + box.x1) / 2;
        const wz = fz !== 0 ? fz * (g.depth / 2 + 0.4) : (box.z0 + box.z1) / 2;
        pushCandidate(
          index,
          KIND_WINDOW,
          chunkId(index, k, n),
          wx,
          box.y0 + g.ch * 0.3,
          wz,
          fx,
          fz,
          // L7b: a row of tongues pouring out of the window band.
          Math.min(9, (fx !== 0 ? g.cd : g.cw) * 0.6),
        );
      }
    }
  }
  // L7b RUBBLE: a wrecked building's fallen insides burn round its foot —
  // the corners and the middle of each side, just outside its walls (on
  // the ground: nothing to stand on but the street).
  const g0 = grids[0];
  if (g0 && out.wear >= RUBBLE_WEAR) {
    const hw = g0.width / 2 + 3;
    const hd = g0.depth / 2 + 3;
    const size = Math.min(16, Math.max(g0.width, g0.depth) * 0.4);
    const base = chunkId(index, 0, 0);
    for (let q = 0; q < RUBBLE_SITES; q++) {
      const a = (q / RUBBLE_SITES) * Math.PI * 2;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      // On the footprint's outline (a rounded rectangle), pushed out.
      const k = 1 / Math.max(Math.abs(ca) / hw, Math.abs(sa) / hd);
      pushCandidate(
        index,
        KIND_RUBBLE,
        base + q,
        ca * k,
        0,
        sa * k,
        0,
        0,
        size,
      );
    }
  }
  // Keep the SITES_PER_BUILDING lowest ranks (partial selection).
  const keep = Math.min(scratch.n, SITES_PER_BUILDING);
  for (let i = 0; i < keep; i++) {
    let best = i;
    for (let j = i + 1; j < scratch.n; j++) {
      if ((scratch.rank[j] as number) < (scratch.rank[best] as number))
        best = j;
    }
    if (best !== i) swapScratch(i, best);
    out.x[i] = wrapCoord(b.x + (scratch.x[i] as number));
    out.y[i] = scratch.y[i] as number;
    out.z[i] = wrapCoord(b.z + (scratch.z[i] as number));
    out.nx[i] = scratch.nx[i] as number;
    out.nz[i] = scratch.nz[i] as number;
    out.kind[i] = scratch.kind[i] as number;
    out.rank[i] = scratch.rank[i] as number;
    out.size[i] = scratch.size[i] as number;
    out.key[i] = scratch.key[i] as number;
  }
  out.n = keep;
}

function swapScratch(i: number, j: number): void {
  const sw = (a: Float64Array | Float32Array | Uint8Array) => {
    const t = a[i] as number;
    a[i] = a[j] as number;
    a[j] = t;
  };
  sw(scratch.x);
  sw(scratch.y);
  sw(scratch.z);
  sw(scratch.nx);
  sw(scratch.nz);
  sw(scratch.kind);
  sw(scratch.rank);
  sw(scratch.size);
  sw(scratch.key);
}

/** How alive a building's sites are at `burn`, from its wear (≥ 1: all). */
export const siteAmount = (burn: number, wear: number): number =>
  // L7b: by burn 0.7 every site of every damaged building is alight (a
  // building with a few chunks gone included); below it the fire spreads.
  Math.min(1.05, burn * 1.5) * Math.min(1, 0.7 + 6 * wear);

/** A site's weight: 0 below its rank, 1 a RANK_SOFT past it. */
export const siteWeight = (rank: number, amount: number): number =>
  smooth01((amount - rank + RANK_SOFT) / RANK_SOFT);

/**
 * K slots that ease in and out (1/SLOT_RATE s) so a reassignment never
 * jumps: a slot keeps its key while wanted, fades to 0 when not, and only a
 * faded slot takes a new key.
 */
class FadeSlots {
  readonly key: Float64Array;
  readonly w: Float32Array;
  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly z: Float64Array;
  /** Per-slot payload (size, strength). */
  readonly a: Float32Array;
  readonly b: Float32Array;
  private readonly wanted: Uint8Array;

  constructor(readonly k: number) {
    // NaN = empty: every real key (C2's negative ones too) is a number.
    this.key = new Float64Array(k).fill(Number.NaN);
    this.w = new Float32Array(k);
    this.x = new Float64Array(k);
    this.y = new Float64Array(k);
    this.z = new Float64Array(k);
    this.a = new Float32Array(k);
    this.b = new Float32Array(k);
    this.wanted = new Uint8Array(k);
  }

  begin(): void {
    this.wanted.fill(0);
  }

  /** `key` is wanted this frame at (x, y, z) with payload (a, b). */
  want(
    key: number,
    x: number,
    y: number,
    z: number,
    a: number,
    b: number,
  ): void {
    let slot = -1;
    for (let i = 0; i < this.k; i++) {
      if (this.key[i] === key) {
        slot = i;
        break;
      }
    }
    if (slot < 0) {
      for (let i = 0; i < this.k; i++) {
        if ((this.w[i] as number) <= 0) {
          slot = i;
          this.key[i] = key;
          break;
        }
      }
    }
    if (slot < 0) return; // every slot busy fading out: next frame
    this.wanted[slot] = 1;
    this.x[slot] = x;
    this.y[slot] = y;
    this.z[slot] = z;
    this.a[slot] = a;
    this.b[slot] = b;
  }

  /** Ease every slot toward wanted (1) or not (0). */
  end(dt: number): void {
    for (let i = 0; i < this.k; i++) {
      const w = this.w[i] as number;
      this.w[i] =
        this.wanted[i] === 1
          ? Math.min(1, w + dt * SLOT_RATE)
          : Math.max(0, w - dt * SLOT_RATE);
      if ((this.w[i] as number) <= 0 && this.wanted[i] === 0) {
        this.key[i] = Number.NaN;
      }
    }
  }
}

// --- Shaders ---------------------------------------------------------------

/** Value noise periodic in y with period `py` lattice cells (so a scroll by
 * phase × py never jumps when the phase wraps). */
const NOISE_GLSL = /* glsl */ `
float abInfHash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
float abInfNoise(vec2 p, float py) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float y0 = mod(i.y, py);
  float y1 = mod(i.y + 1.0, py);
  float a = abInfHash(vec2(i.x, y0));
  float b = abInfHash(vec2(i.x + 1.0, y0));
  float c = abInfHash(vec2(i.x, y1));
  float d = abInfHash(vec2(i.x + 1.0, y1));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
`;

const FLAME_VERTEX = /* glsl */ `
attribute vec4 aA; // render-space base (xyz), width (w)
attribute vec4 aB; // height, seed, alpha, layer + 4 × form
uniform vec2 uWind;
varying vec2 vUv;
flat varying float vSeed;
flat varying float vLayer;
flat varying float vForm;
varying float vAlpha;
#include <fog_pars_vertex>
void main() {
  vec3 base = aA.xyz;
  float w = aA.w;
  float h = aB.x;
  // L7b: the form — 0 a floor ablaze (a back card and a front pair), 1 a
  // row of tongues out of a window band, 2 a rubble field (both side by
  // side across the fire).
  float form = floor(aB.w / 4.0 + 0.01);
  float layer = aB.w - 4.0 * form;
  // Cylindrical billboard about +y: flames stand up, whatever the camera.
  vec3 toCam = cameraPosition - base;
  toCam.y = 0.0;
  float len = length(toCam);
  vec3 fwd = len > 1e-3 ? toCam / len : vec3(0.0, 0.0, 1.0);
  vec3 right = vec3(fwd.z, 0.0, -fwd.x);
  // Layer 0 is the tall back card; 1 and 2 the front pair, either side.
  float back = step(layer, 0.5);
  float side = layer < 1.5 ? -1.0 : 1.0;
  float row = step(0.5, form);
  vec3 off = -fwd * (back * 0.3 * w * (1.0 - row))
    + right * ((1.0 - back) * side * mix(0.2, 0.55, row) * w);
  float hs = mix(0.78, 1.15, back);
  float ws = mix(0.72, 1.0, back) * mix(1.0, 0.62, row);
  vec3 p = base + off + right * (position.x * w * ws) + vec3(0.0, position.y * h * hs, 0.0);
  // The tip leans downwind.
  p.xz += uWind * (position.y * position.y * h * 0.22);
  vec4 mvPosition = viewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  vUv = position.xy;
  vSeed = aB.y;
  vLayer = layer;
  vForm = form;
  vAlpha = aB.z;
  #include <fog_vertex>
}
`;

const FLAME_FRAGMENT = /* glsl */ `
uniform vec4 uFirePhase;
varying vec2 vUv;
flat varying float vSeed;
flat varying float vLayer;
flat varying float vForm;
varying float vAlpha;
#include <fog_pars_fragment>
${NOISE_GLSL}
void main() {
  float x = vUv.x;
  float y = vUv.y;
  float sx = vSeed * 37.0 + vLayer * 11.0;
  // Three octaves scrolling up the flame (periods 4, 8 and 16 lattice cells
  // along y: the phase scroll wraps seamlessly).
  vec2 q = vec2(x * 2.4 + sx, y * 2.2 - uFirePhase.x * 4.0);
  float n = 0.5 * abInfNoise(q, 4.0)
          + 0.3 * abInfNoise(vec2(q.x * 2.1 + 5.3, q.y * 2.0), 8.0)
          + 0.2 * abInfNoise(vec2(q.x * 4.3 + 1.7, q.y * 4.0), 16.0);
  // A soft teardrop (L7b: fuller), its outline licked sideways more
  // toward the tip...
  // A rubble field (form 2) is a low bank of fire: barely tapering, its
  // top all tongues.
  float rubble = step(1.5, vForm);
  float xd = x + (n - 0.5) * 0.55 * y;
  float width = 0.5 * pow(max(1.0 - y, 0.0), mix(0.55, 0.2, rubble));
  float body = 1.0 - smoothstep(width * 0.2, width, abs(xd));
  // ...torn into tongues by the noise, more the higher it climbs.
  float erode = smoothstep(0.1 + 0.55 * y, 0.4 + 0.55 * y, n + 0.3 - 0.1 * rubble);
  float m = body * erode * smoothstep(0.0, 0.06, y);
  // Hot only low in the flame and where the noise runs hot: the core is
  // a small yellow-white heart, the body orange-red.
  float heat = m * (1.0 - 0.9 * y) * (0.5 + 0.65 * n) * mix(1.0, 0.75, step(vLayer, 0.5));
  // L7b: reference 2's fire — deep red edges, an orange-red body (kept
  // under ~0.9 linear, where the filmic curve leaves it red-orange instead
  // of washing it to yellow), a small yellow-white core; only the core
  // reaches the EMISSIVE_FIRE rung.
  vec3 col = mix(vec3(0.42, 0.03, 0.0), vec3(1.0, 0.12, 0.01), smoothstep(0.1, 0.42, heat));
  col = mix(col, vec3(1.0, 0.42, 0.1), smoothstep(0.5, 0.8, heat));
  col = mix(col, vec3(1.0, 0.82, 0.5), smoothstep(0.8, 1.0, heat));
  col *= ${FIRE_GAIN.toFixed(4)} * mix(0.55, 1.0, smoothstep(0.08, 0.9, heat));
  // Cool edges are thin, the hot core opaque.
  float a = smoothstep(0.0, 0.45, m) * (0.45 + 0.55 * smoothstep(0.1, 0.5, heat)) * vAlpha;
  if (a < 0.004) discard;
  gl_FragColor = vec4(col, a);
  #ifdef USE_FOG
  // L7b: fire shines through the smoke and haze — its fog is the shaped
  // curve squared (still exactly 1 at fogFar; every flame is gone by
  // CUT_M anyway), so a block burning 600 m out still reads as fire.
  float flameFog = abFogFactor(fogNear, fogFar, vFogDepth);
  gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, flameFog * flameFog);
  #endif
}
`;

const SMOKE_VERTEX = /* glsl */ `
attribute vec4 aA; // render-space column base (xyz), height (w)
attribute vec4 aB; // puff slot 0..1, seed, strength, size scale
uniform vec4 uFirePhase;
uniform vec2 uWind;
varying vec2 vUv;
varying float vCornerY;
varying float vAlpha;
varying float vGlow;
varying float vRise;
flat varying float vSeed;
#include <fog_pars_vertex>
void main() {
  // Each puff rises the column once per 17 s (uFirePhase.z), its slot
  // spacing it from its neighbours; columns are offset by their seed.
  float ph = fract(uFirePhase.z + aB.x + aB.y * 0.137);
  float H = aA.w;
  float h = ph * H;
  vec3 c = aA.xyz;
  // Leaning downwind, more the higher it climbs; a slow wobble.
  float lean = h * 0.22 + h * h / max(H, 1.0) * 0.5;
  c.xz += uWind * lean;
  float wob = 3.0 + h * 0.05;
  c.x += sin(6.2832 * (ph * 2.0 + aB.y)) * wob;
  c.z += cos(6.2832 * (ph * 1.7 + aB.y * 1.3)) * wob;
  c.y += h;
  // L7b: a dense plume — an 18 m puff at the fire swelling to 75 m at
  // the deck, narrow enough to read as a column against the sky.
  float size = mix(18.0, 75.0, pow(ph, 0.8)) * aB.w;
  vec4 mvC = viewMatrix * vec4(c, 1.0);
  float dist = length(mvC.xyz);
  // D11: never in the camera's face — on its TRUE size (smokeNearFade),
  // before the overdraw clamp shrinks it.
  float camFade = smoothstep(size * ${SMOKE_NEAR_GONE.toFixed(2)}, size * ${SMOKE_NEAR_FULL.toFixed(2)}, dist);
  // Bounded overdraw: never wider than 0.9 × its view distance.
  size = min(size, 0.9 * dist);
  float rot = 6.2832 * (aB.y + ph * 0.35);
  float cs = cos(rot);
  float sn = sin(rot);
  vec2 corner = position.xy;
  vec4 mvPosition = mvC + vec4(corner * size, 0.0, 0.0);
  gl_Position = projectionMatrix * mvPosition;
  vUv = mat2(cs, -sn, sn, cs) * corner;
  vCornerY = corner.y;
  // In and out over its life; transparent over its lowest ~20 m so the
  // flames read through it; never in the camera's face (the stand-in for a
  // depth fade — the pipeline keeps no depth texture).
  float env = smoothstep(0.0, 0.08, ph) * (1.0 - smoothstep(0.7, 1.0, ph));
  float baseFade = smoothstep(4.0, 24.0, h);
  vAlpha = aB.z * env * baseFade * camFade;
  // L7b: the fire lights the column's lower ~30 % (the reference's orange
  // plume bases), fading up into the dark.
  vGlow = aB.z * (1.0 - smoothstep(0.0, 0.3 * H, h)) * (0.35 + 0.65 * exp(-h / 60.0));
  vRise = ph;
  vSeed = aB.y;
  #include <fog_vertex>
}
`;

const SMOKE_FRAGMENT = /* glsl */ `
uniform vec4 uFirePhase;
uniform float uSmokeDetail;
uniform float uSmokeBurn;
varying vec2 vUv;
varying float vCornerY;
varying float vAlpha;
varying float vGlow;
varying float vRise;
flat varying float vSeed;
#include <fog_pars_fragment>
${NOISE_GLSL}
void main() {
  float r2 = dot(vUv, vUv) * 4.0;
  // Billowing edge: a static noise turning with the puff (Mobile: plain).
  float n = uSmokeDetail > 0.5 ? abInfNoise(vUv * 3.2 + vSeed * 17.0, 64.0) : 0.5;
  // D11: a soft falloff all the way to the card's edge, the core capped
  // under opaque (smokeShape): never a saturated, hard-rimmed disc.
  float shape = min(${SMOKE_ALPHA_MAX.toFixed(2)}, exp(-r2 * 1.8) * (1.0 - smoothstep(0.15, 1.0, r2)) * (0.6 + 1.1 * n));
  float a = shape * vAlpha;
  if (a < 0.003) discard;
  // Near-black smoke, a touch greyer (moonlit) as it rises, its top edge
  // catching the moon; lit orange from below by its own fire, strongest
  // under each puff (L7b: hot enough to read as the reference's lit plume
  // bases against the haze), and the whole plume a dim ember from the
  // burning city under it.
  // D11: dark, never black — sooty grey-brown that takes the night light.
  vec3 albedo = vec3(0.03, 0.027, 0.025) + vec3(0.016, 0.016, 0.019) * vRise;
  albedo += vec3(0.035, 0.038, 0.047) * smoothstep(0.1, 0.5, vCornerY) * vRise;
  float under = smoothstep(0.3, -0.5, vCornerY);
  float flick = 0.85 + 0.15 * sin(6.2832 * (uFirePhase.x + vSeed));
  vec3 glow = vec3(1.0, 0.2, 0.03) * (1.3 * vGlow * (0.12 + 0.88 * under * under) * flick)
    + vec3(0.025, 0.006, 0.0015) * uSmokeBurn * (1.0 - vRise);
  gl_FragColor = vec4(albedo + glow, a);
  #include <fog_fragment>
}
`;

const AIR_VERTEX = /* glsl */ `
attribute vec4 aSeed;
attribute float aKind; // 0 ember, 1 ash, 2 debris
attribute float aSlot;
uniform vec4 uAnchor[${AIR_ANCHORS}];  // render-space (xyz), weight
uniform vec4 uAnchorB[${AIR_ANCHORS}]; // radius, flame height, -, -
uniform vec4 uAirPhase;                // debris, ember, ash phases
uniform vec2 uWind;
uniform float uPxPerM;                 // pixels per metre at 1 m
uniform vec4 uCamBox;                  // render-space camera (xyz), strength
uniform vec3 uEmberOff;                // camera embers' drift, mod CAM_BOX
uniform vec3 uAshOff;                  // camera ash's drift, mod CAM_BOX
varying vec4 vCol;
varying float vRot;
varying float vKind;
#include <fog_pars_vertex>
void main() {
  int slot = int(aSlot + 0.5);
  vec4 A = uAnchor[0];
  vec4 B = uAnchorB[0];
  for (int i = 0; i < ${AIR_ANCHORS}; i++) {
    if (i == slot) { A = uAnchor[i]; B = uAnchorB[i]; }
  }
  vec3 p = A.xyz;
  float size = 0.0;
  vec4 col = vec4(0.0);
  float rot = 0.0;
  float ang = aSeed.y * 6.2832;
  bool cam = aSlot > ${AIR_ANCHORS.toFixed(1)} - 0.5;
  if (cam) {
    // L7b: the air round the camera — embers rising and ash falling
    // through a cube that wraps with the view, faded over its outer 30 %
    // so nothing pops at the wrap.
    vec3 off = aKind < 0.5 ? uEmberOff : uAshOff;
    vec3 q = aSeed.xyz * ${CAM_BOX.toFixed(1)} + off - uCamBox.xyz;
    q = (fract(q / ${CAM_BOX.toFixed(1)}) - 0.5) * ${CAM_BOX.toFixed(1)};
    p = uCamBox.xyz + q;
    vec3 e = abs(q) / ${(CAM_BOX / 2).toFixed(1)};
    float edge = 1.0 - smoothstep(0.7, 1.0, max(max(e.x, e.y), e.z));
    if (aKind < 0.5) {
      size = 0.1 + 0.2 * aSeed.w;
      float blink = 0.6 + 0.4 * sin(6.2832 * (uAirPhase.y * 3.0 + aSeed.w * 7.0));
      col = vec4(vec3(1.0, 0.42, 0.09) * (1.5 * blink), edge);
    } else {
      size = 0.12 + 0.18 * aSeed.w;
      col = vec4(0.16, 0.15, 0.145, 0.8 * edge);
    }
    col.a *= uCamBox.w;
  } else if (aKind < 0.5) {
    // Embers: up out of the fire on a swirl, carried downwind, cooling.
    float ph = fract(uAirPhase.y + aSeed.x);
    float t = ph * ${AIR_PERIODS[1].toFixed(1)};
    float rad = B.x * 0.5 * sqrt(aSeed.z);
    p += vec3(cos(ang) * rad, B.y * 0.3, sin(ang) * rad);
    p.y += (5.0 + 9.0 * aSeed.w) * t;
    p.x += sin(t * 2.3 + ang * 3.0) * 2.2 * ph + uWind.x * t * 1.6;
    p.z += cos(t * 1.9 + ang * 2.0) * 2.2 * ph + uWind.y * t * 1.6;
    size = (0.35 + 0.45 * aSeed.z) * (1.0 - 0.6 * ph);
    float blink = 0.65 + 0.35 * sin(t * 14.0 + aSeed.y * 40.0);
    col = vec4(vec3(1.0, 0.5, 0.13) * (1.3 * blink * (1.0 - 0.5 * ph)), (1.0 - ph) * smoothstep(0.0, 0.05, ph));
  } else if (aKind < 1.5) {
    // Ash: drifting down from high over the fire, fluttering downwind.
    float ph = fract(uAirPhase.z + aSeed.x);
    float t = ph * ${AIR_PERIODS[2].toFixed(1)};
    float rad = 15.0 + 55.0 * sqrt(aSeed.z);
    p += vec3(cos(ang) * rad, 60.0 + 140.0 * aSeed.w - 2.2 * t, sin(ang) * rad);
    p.x += uWind.x * t * 3.0 + sin(t * 3.1 + ang) * 1.5;
    p.z += uWind.y * t * 3.0 + cos(t * 2.7 + ang) * 1.5;
    size = 0.25 + 0.25 * aSeed.z;
    col = vec4(0.2, 0.19, 0.185, 0.75 * smoothstep(0.0, 0.1, ph) * (1.0 - smoothstep(0.8, 1.0, ph)));
  } else {
    // Debris: chunks thrown up out of the fire, arcing back down, tumbling.
    float ph = fract(uAirPhase.x + aSeed.x);
    float t = ph * ${AIR_PERIODS[0].toFixed(1)};
    float sp = 4.0 + 6.0 * aSeed.z;
    vec3 v0 = vec3(cos(ang) * sp, 9.0 + 9.0 * aSeed.w, sin(ang) * sp);
    p += vec3(cos(ang), 0.0, sin(ang)) * (B.x * 0.3) + v0 * t;
    p.y += B.y * 0.2 - 4.9 * t * t;
    size = 0.6 + 0.8 * aSeed.w;
    rot = t * (4.0 + 6.0 * aSeed.z);
    float landed = step(A.y - 1.0, p.y);
    col = vec4(vec3(0.06, 0.05, 0.045), landed);
  }
  if (!cam) col.a *= A.w;
  vec4 mvPosition = viewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  float px = size * uPxPerM / max(-mvPosition.z, 1.0);
  // Never under 1.5 px (a sub-pixel point sparkles): fade it instead.
  col.a *= clamp(px * px / 2.25, 0.0, 1.0);
  gl_PointSize = clamp(px, 1.5, 48.0);
  // Never a point at (or behind) the eye: its clip w is ~0, and a
  // rasteriser fed that point can stall (the camera's own air sits there).
  if (col.a < 0.004 || mvPosition.z > -0.5) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  vCol = col;
  vRot = rot;
  vKind = aKind;
  #include <fog_vertex>
}
`;

const AIR_FRAGMENT = /* glsl */ `
varying vec4 vCol;
varying float vRot;
varying float vKind;
#include <fog_pars_fragment>
void main() {
  vec2 pc = gl_PointCoord - 0.5;
  float a = vCol.a;
  if (vKind > 1.5) {
    // A tumbling slab: a rotated, flattened square.
    float c = cos(vRot);
    float s = sin(vRot);
    vec2 q = mat2(c, -s, s, c) * pc;
    if (max(abs(q.x), abs(q.y) * 1.6) > 0.32) discard;
  } else {
    a *= 1.0 - smoothstep(0.2, 0.5, length(pc));
  }
  if (a < 0.01) discard;
  gl_FragColor = vec4(vCol.rgb, a);
  #include <fog_fragment>
}
`;

// --- The frame's inputs ------------------------------------------------------

export interface InfernoFrame {
  /** The room's burn level, 0..1 (already eased by the caller). */
  burn: number;
  /** C2 burning chunks (`socket.fires`). */
  fires: ReadonlySet<number>;
  /** Where things are picked and placed around (the camera). */
  viewer: Vec3;
  camera: THREE.PerspectiveCamera;
  /** Viewport height in pixels (the air's point sizes). */
  viewportH: number;
  /** The latched world clock (null before sync: the wall clock stands in). */
  worldMs: number | null;
  /** Wall clock, ms. */
  now: number;
}

/** QA (`__ab.inferno()`): what the inferno is drawing. */
export interface InfernoStats {
  burn: number;
  /** Live candidate sites in the city (weight > 0). */
  sites: number;
  /** Sites drawn as flames, and their cards. */
  flames: number;
  cards: number;
  columns: number;
  lights: number;
  anchors: number;
  air: number;
  /** Damaged buildings past the gut threshold (gut wear > 0). */
  gutted: number;
  /** D8: drawn sites over what stands under them (must be 0). */
  floating: number;
  /** Overdraw proxy: screen fractions of the flame cards and smoke puffs. */
  coverage: number;
  /** D11: the smoke columns' share of it (after their budget). */
  smokeCoverage: number;
  /** Glow spots handed to the cloud deck. */
  glow: number;
}

/** The inferno: sites, three draws and the zero-draw feeds. */
export class Inferno {
  readonly group = new THREE.Group();
  readonly flames: THREE.Mesh;
  readonly smoke: THREE.Mesh;
  readonly air: THREE.Points;
  /** Fire shimmer + blasts, for atmosphere-fx (mergeHeat). */
  readonly heat: Heat[] = [];
  /** Cloud-deck glow spots: render-space x, z, strength, radius. */
  readonly cloudGlow = new Float32Array(CLOUD_GLOW_MAX * 4);
  cloudGlowCount = 0;

  private readonly sites = new Map<number, BuildingSites>();
  private readonly active: number[] = [];
  private readonly chunkTotals: Int32Array;
  private readonly c2 = new Map<number, Float64Array>();
  private readonly c2Seen = new Set<number>();
  /** This frame's C2 fires, in a stable order: ids and emitters. */
  private readonly c2Ids: number[] = [];
  private readonly c2Em: Float64Array[] = [];
  private readonly flameA: THREE.InstancedBufferAttribute;
  private readonly flameB: THREE.InstancedBufferAttribute;
  private readonly smokeA: THREE.InstancedBufferAttribute;
  private readonly smokeB: THREE.InstancedBufferAttribute;
  private readonly flameUploads: THREE.BufferAttribute[];
  private readonly smokeUploads: THREE.BufferAttribute[];
  private readonly windU = { value: new THREE.Vector2() };
  private readonly smokeDetailU = { value: 1 };
  private readonly anchorU: { value: THREE.Vector4[] };
  private readonly anchorBU: { value: THREE.Vector4[] };
  private readonly airPhaseU = { value: new THREE.Vector4() };
  private readonly pxPerMU = { value: 600 };
  private readonly camBoxU = { value: new THREE.Vector4() };
  private readonly emberOffU = { value: new THREE.Vector3() };
  private readonly ashOffU = { value: new THREE.Vector3() };
  private flameShare = 1;
  private smokeShare = 1;
  private airShare = 1;
  private lastWorld = Number.NaN;
  private readonly wind: Wind = { x: 1, z: 0, strength: 0 };
  private readonly img: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly canon: Vec3 = { x: 0, y: 0, z: 0 };
  // Per-frame candidates (flat, preallocated; grown only if a city needs it).
  private cap = 2048;
  private cB = new Int32Array(this.cap);
  private cS = new Int16Array(this.cap);
  private cD = new Float64Array(this.cap);
  /** L7b: the pick order — distance² over the view weight² (viewRank). */
  private cR = new Float64Array(this.cap);
  private cW = new Float32Array(this.cap);
  /** The camera's forward (unit), for viewRank. */
  private readonly fwd = new THREE.Vector3(0, 0, -1);
  private cN = 0;
  private readonly lights = new FadeSlots(FIRE_LIGHTS);
  private readonly anchors = new FadeSlots(AIR_ANCHORS);
  private readonly stats: InfernoStats = {
    burn: 0,
    sites: 0,
    flames: 0,
    cards: 0,
    columns: 0,
    lights: 0,
    anchors: 0,
    air: 0,
    gutted: 0,
    floating: 0,
    coverage: 0,
    smokeCoverage: 0,
    glow: 0,
  };
  // Per-building column pick (scratch).
  private readonly colB = new Int32Array(512);
  private readonly colS = new Int16Array(512);
  private readonly colD = new Float64Array(512);
  private readonly colW = new Float32Array(512);
  private colN = 0;

  constructor(private readonly buildings: readonly Building[]) {
    this.chunkTotals = new Int32Array(buildings.length);
    // Flames: a unit card standing on its base (x in ±0.5, y in 0..1).
    const card = cardGeometry(0);
    const fg = new THREE.InstancedBufferGeometry();
    fg.index = card.index;
    fg.setAttribute("position", card.getAttribute("position"));
    const flameCap = FLAME_SITES_MAX * CARDS;
    this.flameA = dynAttr(flameCap, 4);
    this.flameB = dynAttr(flameCap, 4);
    fg.setAttribute("aA", this.flameA);
    fg.setAttribute("aB", this.flameB);
    fg.instanceCount = 0;
    this.flameUploads = [this.flameA, this.flameB];
    this.flames = new THREE.Mesh(
      fg,
      new THREE.ShaderMaterial({
        uniforms: fogUniforms({
          uWind: this.windU,
          uFirePhase: FIRE_PHASE_UNIFORM,
        }),
        vertexShader: FLAME_VERTEX,
        fragmentShader: FLAME_FRAGMENT,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        // One pass, not three's back-then-front pair for a transparent
        // double-sided material (O3): a camera-facing card has one side
        // to draw, and the pair would cost the flames a second draw.
        forceSinglePass: true,
        fog: true,
      }),
    );
    this.flames.frustumCulled = false;
    this.flames.renderOrder = RENDER_ORDER.fireVolumes;
    this.flames.visible = false;
    // Smoke: a centred unit quad per puff.
    const quad = cardGeometry(-0.5);
    const sg = new THREE.InstancedBufferGeometry();
    sg.index = quad.index;
    sg.setAttribute("position", quad.getAttribute("position"));
    const smokeCap = COLUMNS_MAX * PUFFS;
    this.smokeA = dynAttr(smokeCap, 4);
    this.smokeB = dynAttr(smokeCap, 4);
    sg.setAttribute("aA", this.smokeA);
    sg.setAttribute("aB", this.smokeB);
    sg.instanceCount = 0;
    this.smokeUploads = [this.smokeA, this.smokeB];
    this.smoke = new THREE.Mesh(
      sg,
      new THREE.ShaderMaterial({
        uniforms: fogUniforms({
          uWind: this.windU,
          uFirePhase: FIRE_PHASE_UNIFORM,
          uSmokeDetail: this.smokeDetailU,
          uSmokeBurn: INFERNO_BURN_UNIFORM,
        }),
        vertexShader: SMOKE_VERTEX,
        fragmentShader: SMOKE_FRAGMENT,
        transparent: true,
        depthWrite: false,
        fog: true,
      }),
    );
    this.smoke.frustumCulled = false;
    this.smoke.renderOrder = RENDER_ORDER.smokeColumns;
    this.smoke.visible = false;
    // The air: static seeds, every motion in the vertex shader.
    const ag = new THREE.BufferGeometry();
    const total = AIR_CAM + AIR_MAX;
    const seeds = new Float32Array(total * 4);
    const kinds = new Float32Array(total);
    const slots = new Float32Array(total);
    let s = 0x2545f491;
    const rnd = () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 4294967296;
    };
    for (let i = 0; i < AIR_MAX; i++) {
      const j = AIR_CAM + i;
      for (let k = 0; k < 4; k++) seeds[j * 4 + k] = rnd();
      // Interleaved, so any drawn prefix holds every kind in proportion.
      const m = i % 20;
      kinds[j] = m < 11 ? 0 : m < 17 ? 1 : 2;
      slots[j] = i % AIR_ANCHORS;
    }
    // L7b: the camera's own embers and ash lead the buffer (slot
    // AIR_ANCHORS), so the draw range is one run: [0 or AIR_CAM, …).
    for (let i = 0; i < AIR_CAM; i++) {
      for (let k = 0; k < 4; k++) seeds[i * 4 + k] = rnd();
      kinds[i] = i % 5 < 3 ? 0 : 1;
      slots[i] = AIR_ANCHORS;
    }
    ag.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(total * 3), 3),
    );
    ag.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 4));
    ag.setAttribute("aKind", new THREE.BufferAttribute(kinds, 1));
    ag.setAttribute("aSlot", new THREE.BufferAttribute(slots, 1));
    ag.setDrawRange(0, 0);
    this.anchorU = {
      value: Array.from({ length: AIR_ANCHORS }, () => new THREE.Vector4()),
    };
    this.anchorBU = {
      value: Array.from({ length: AIR_ANCHORS }, () => new THREE.Vector4()),
    };
    this.air = new THREE.Points(
      ag,
      new THREE.ShaderMaterial({
        uniforms: fogUniforms({
          uAnchor: this.anchorU,
          uAnchorB: this.anchorBU,
          uAirPhase: this.airPhaseU,
          uWind: this.windU,
          uPxPerM: this.pxPerMU,
          uCamBox: this.camBoxU,
          uEmberOff: this.emberOffU,
          uAshOff: this.ashOffU,
        }),
        vertexShader: AIR_VERTEX,
        fragmentShader: AIR_FRAGMENT,
        transparent: true,
        depthWrite: false,
        fog: true,
      }),
    );
    this.air.frustumCulled = false;
    this.air.renderOrder = RENDER_ORDER.fireVolumes;
    this.air.visible = false;
    this.group.add(this.smoke, this.flames, this.air);
    for (let i = 0; i < FIRE_SHIMMER_MAX + 16; i++) {
      this.heat.push({ x: 0, y: 0, z: 0, size: 0, level: 0 });
    }
  }

  /** Quality: flames and air × chaosFx, columns × smokeColumns (with each
   * puff grown so the columns' coverage holds — rule 2 for the fill), and
   * Mobile's plain smoke edge. A uniform and counts only: nothing compiles. */
  setQuality(tier: QualityTier): void {
    const p = QUALITY_PROFILES[tier];
    this.flameShare = Math.max(0.2, p.chaosFx);
    // Mobile drops the air (a draw of pure dressing): its peak-chaos scene
    // sits at the Mobile draw ceiling already.
    this.airShare = tier === "mobile" ? 0 : Math.max(0.15, p.chaosFx);
    this.smokeShare = Math.max(0.25, p.smokeColumns);
    this.smokeDetailU.value = p.heatShimmer ? 1 : 0;
  }

  /** Per frame, once the camera is placed. */
  update(f: InfernoFrame): void {
    const now = f.now;
    const world = f.worldMs ?? now;
    // The slots fade on the WORLD clock, like every animation here: a frame
    // pinned in place (QA, a frozen capture) changes nothing.
    const dt = Number.isFinite(this.lastWorld)
      ? Math.min(0.1, Math.max(0, (world - this.lastWorld) / 1000))
      : 0;
    this.lastWorld = world;
    const burn = Math.min(1, Math.max(0, f.burn));
    INFERNO_BURN_UNIFORM.value = burn;
    setFirePhase(world);
    const s = world / 1000;
    this.airPhaseU.value.set(
      s / AIR_PERIODS[0] - Math.floor(s / AIR_PERIODS[0]),
      s / AIR_PERIODS[1] - Math.floor(s / AIR_PERIODS[1]),
      s / AIR_PERIODS[2] - Math.floor(s / AIR_PERIODS[2]),
      0,
    );
    windAt(world, this.wind);
    this.windU.value.set(
      this.wind.x * (0.4 + this.wind.strength),
      this.wind.z * (0.4 + this.wind.strength),
    );
    const cam = f.camera;
    this.tanHalf = Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2);
    this.camAspect = cam.aspect;
    this.pxPerMU.value = f.viewportH / (2 * this.tanHalf);
    cam.getWorldDirection(this.fwd);
    this.syncSites(now);
    this.syncC2(f.fires);
    this.collect(f.viewer, burn);
    this.stats.burn = burn;
    const drawn = this.pickFlames(f.viewer, burn);
    this.pickColumns(f.viewer, burn);
    this.feedSlots(f.viewer, drawn, dt, world);
  }

  // --- Sites -------------------------------------------------------------

  private chunkTotal(b: number): number {
    let n = this.chunkTotals[b] as number;
    if (n === 0) {
      for (const mask of chunkMask(this.buildings[b] as Building)) {
        for (let c = 0; c < mask.length; c++) n += mask[c] as number;
      }
      n = Math.max(1, n);
      this.chunkTotals[b] = n;
    }
    return n;
  }

  /** Rebuild every building whose damage version moved (≤ every REBUILD_MS
   * per building); forget the ones that are whole again. */
  private syncSites(now: number): void {
    const bs = this.buildings;
    let gutted = 0;
    this.active.length = 0;
    for (let i = 0; i < bs.length; i++) {
      const b = bs[i] as Building;
      const v = b.damage?.version ?? 0;
      let entry = this.sites.get(i);
      if (v === 0 || !b.damage || b.damage.count === 0) {
        if (entry) entry.n = 0;
        continue;
      }
      if (!entry) {
        entry = new BuildingSites();
        this.sites.set(i, entry);
      }
      if (entry.version !== v && now - entry.builtAt >= REBUILD_MS) {
        buildSites(b, i, this.chunkTotal(i), entry);
        entry.version = v;
        entry.builtAt = now;
      }
      if (entry.n > 0) this.active.push(i);
      if (entry.wear > GUT_WEAR_LO) gutted++;
    }
    this.stats.gutted = gutted;
  }

  /** C2 burning chunks: their emitters (fires.ts's outer-face rule), once. */
  private syncC2(fires: ReadonlySet<number>): void {
    this.c2Seen.clear();
    this.c2Ids.length = 0;
    this.c2Em.length = 0;
    fires.forEach(this.seeFire);
    this.c2.forEach(this.forgetFire);
  }

  private readonly seeFire = (id: number): void => {
    this.c2Seen.add(id);
    const have = this.c2.get(id);
    if (have) {
      this.c2Ids.push(id);
      this.c2Em.push(have);
      return;
    }
    const at: Vec3 = { x: 0, y: 0, z: 0 };
    const out = new Float64Array(6);
    out[5] = 0;
    if (chunkCentreInto(this.buildings, id, at)) {
      const b = this.buildings[chunkBuilding(id)] as Building;
      const g = tierGrids(b)[chunkTier(id)];
      if (g) {
        const dx = wrapDeltaAxis(b.x, at.x);
        const dz = wrapDeltaAxis(b.z, at.z);
        const hw = g.width / 2;
        const hd = g.depth / 2;
        let nx = 0;
        let nz = 0;
        if (Math.abs(dx) / hw >= Math.abs(dz) / hd) {
          nx = Math.sign(dx || 1);
          at.x = wrapCoord(b.x + nx * (hw + 0.6));
        } else {
          nz = Math.sign(dz || 1);
          at.z = wrapCoord(b.z + nz * (hd + 0.6));
        }
        out[0] = at.x;
        out[1] = at.y - g.ch * 0.25;
        out[2] = at.z;
        out[3] = nx;
        out[4] = nz;
        out[5] = 1;
      }
    }
    this.c2.set(id, out);
    this.c2Ids.push(id);
    this.c2Em.push(out);
  };

  private readonly forgetFire = (_v: Float64Array, id: number): void => {
    if (!this.c2Seen.has(id)) this.c2.delete(id);
  };

  /** D8: is chunk `id` gone in this client's damage state? */
  private gone(id: number): boolean {
    const b = this.buildings[chunkBuilding(id)];
    return (b?.damage?.cells[chunkTier(id)]?.[chunkCell(id)] ?? 0) !== 0;
  }

  private grow(): void {
    const n = this.cap * 2;
    const g32 = (a: Int32Array) => {
      const b = new Int32Array(n);
      b.set(a);
      return b;
    };
    const g16 = (a: Int16Array) => {
      const b = new Int16Array(n);
      b.set(a);
      return b;
    };
    const gd = (a: Float64Array) => {
      const b = new Float64Array(n);
      b.set(a);
      return b;
    };
    const gf = (a: Float32Array) => {
      const b = new Float32Array(n);
      b.set(a);
      return b;
    };
    this.cB = g32(this.cB);
    this.cS = g16(this.cS);
    this.cD = gd(this.cD);
    this.cR = gd(this.cR);
    this.cW = gf(this.cW);
    this.cap = n;
  }

  /** Every live site within CUT_M: (building, site) or (−1, C2 index). */
  private collect(viewer: Vec3, burn: number): void {
    this.cN = 0;
    let live = 0;
    const cut2 = CUT_M * CUT_M;
    for (let a = 0; a < this.active.length; a++) {
      const bi = this.active[a] as number;
      const e = this.sites.get(bi) as BuildingSites;
      e.amount = siteAmount(burn, e.wear);
      for (let i = 0; i < e.n; i++) {
        const w = siteWeight(e.rank[i] as number, e.amount);
        if (w <= 0.01) continue;
        live++;
        const dx = wrapDeltaAxis(viewer.x, e.x[i] as number);
        const dy = (e.y[i] as number) - viewer.y;
        const dz = wrapDeltaAxis(viewer.z, e.z[i] as number);
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > cut2) continue;
        if (this.cN >= this.cap) this.grow();
        this.cB[this.cN] = bi;
        this.cS[this.cN] = i;
        this.cD[this.cN] = d2;
        // A building's k-th site (they are kept in rank order) picks as
        // though (1 + k/4)× as far, so the cap spreads over many burning
        // buildings instead of drawing every site of the nearest few.
        const spread = 1 + i / 4;
        this.cR[this.cN] = this.viewRank(dx, dy, dz, d2) * spread * spread;
        this.cW[this.cN] = w;
        this.cN++;
      }
    }
    // C2 fires burn at any level (they are C2's, already lit).
    for (let idx = 0; idx < this.c2Ids.length; idx++) {
      const v = this.c2Em[idx] as Float64Array;
      if (v[5] !== 1 || this.gone(this.c2Ids[idx] as number)) continue;
      live++;
      const dx = wrapDeltaAxis(viewer.x, v[0] as number);
      const dy = (v[1] as number) - viewer.y;
      const dz = wrapDeltaAxis(viewer.z, v[2] as number);
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > cut2) continue;
      if (this.cN >= this.cap) this.grow();
      this.cB[this.cN] = -1;
      this.cS[this.cN] = idx;
      this.cD[this.cN] = d2;
      this.cR[this.cN] = this.viewRank(dx, dy, dz, d2);
      this.cW[this.cN] = 1;
      this.cN++;
    }
    this.stats.sites = live;
  }

  /**
   * L7b: a candidate's pick key — its distance² over its view weight²: a
   * fire within ~32° of the view axis counts at its distance, one 63° or
   * more off it (out of frame) as though 4× as far, smoothly in between, so the capped draw is spent
   * on fire in view and a turning camera re-ranks sites smoothly (the cap
   * fade runs on this key).
   */
  private viewRank(dx: number, dy: number, dz: number, d2: number): number {
    const d = Math.sqrt(d2);
    if (d < 1) return d2;
    const f = this.fwd;
    const c = (dx * f.x + dy * f.y + dz * f.z) / d;
    const vw = 0.25 + 0.75 * smooth01((c - 0.45) / 0.4);
    return d2 / (vw * vw);
  }

  /** viewRank on the level: the camera's heading, not its pitch. */
  private levelRank(dx: number, dz: number, d2: number): number {
    const f = this.fwd;
    const h = Math.hypot(f.x, f.z);
    const d = Math.sqrt(d2);
    if (d < 1 || h < 1e-3) return d2;
    const c = (dx * f.x + dz * f.z) / (d * h);
    const vw = 0.3 + 0.7 * smooth01((c + 0.2) / 0.7);
    return d2 / (vw * vw);
  }

  /** Candidate `c`'s canonical position, size and kind. */
  private siteOf(
    c: number,
    out: Vec3,
  ): { size: number; kind: number; key: number; nx: number; nz: number } {
    const bi = this.cB[c] as number;
    const si = this.cS[c] as number;
    if (bi >= 0) {
      const e = this.sites.get(bi) as BuildingSites;
      out.x = e.x[si] as number;
      out.y = e.y[si] as number;
      out.z = e.z[si] as number;
      this.siteInfo.size = e.size[si] as number;
      this.siteInfo.kind = e.kind[si] as number;
      this.siteInfo.key = e.key[si] as number;
      this.siteInfo.nx = e.nx[si] as number;
      this.siteInfo.nz = e.nz[si] as number;
    } else {
      const v = this.c2Em[si] as Float64Array;
      out.x = v[0] as number;
      out.y = v[1] as number;
      out.z = v[2] as number;
      this.siteInfo.size = 4;
      this.siteInfo.kind = KIND_C2;
      // C2 keys: negative, from the chunk id (stable across frames).
      this.siteInfo.key = -1 - (this.c2Ids[si] as number);
      this.siteInfo.nx = v[3] as number;
      this.siteInfo.nz = v[4] as number;
    }
    return this.siteInfo;
  }

  private readonly siteInfo = { size: 0, kind: 0, key: 0, nx: 0, nz: 0 };

  /** Partial selection: the `n` nearest candidates to the front. */
  private selectNearest(n: number): void {
    const m = Math.min(n, this.cN);
    for (let i = 0; i < m; i++) {
      let best = i;
      for (let j = i + 1; j < this.cN; j++) {
        if ((this.cR[j] as number) < (this.cR[best] as number)) best = j;
      }
      if (best === i) continue;
      swap4(this.cB, this.cS, this.cD, this.cW, i, best);
      const t = this.cR[i] as number;
      this.cR[i] = this.cR[best] as number;
      this.cR[best] = t;
    }
  }

  /** Write the flame cards; returns how many sites were drawn. */
  private pickFlames(viewer: Vec3, burn: number): number {
    const want = Math.max(1, Math.round(FLAME_SITES_MAX * this.flameShare));
    // One past the cap: its distance is where the fade-out ends.
    this.selectNearest(want + 1);
    const n = Math.min(want, this.cN);
    // The cap fade runs on the pick key (viewRank), like the pick itself;
    // under the cap nothing fades but the last stretch before CUT_M.
    const edge =
      this.cN > want
        ? Math.sqrt(this.cR[want] as number)
        : Number.POSITIVE_INFINITY;
    const fadeFrom = edge * 0.75;
    const a = this.flameA.array as Float32Array;
    const bArr = this.flameB.array as Float32Array;
    const aspect = this.camAspect;
    const k = 1 / (4 * this.tanHalf * this.tanHalf * aspect);
    let cov = 0;
    let cards = 0;
    let floating = 0;
    const scale = 0.7 + 0.3 * burn;
    for (let c = 0; c < n; c++) {
      const info = this.siteOf(c, this.canon);
      const d = Math.sqrt(this.cD[c] as number);
      const r = Math.sqrt(this.cR[c] as number);
      // D11: under the cap there is no cap fade — `edge` is infinite, and
      // ∞ − ∞ made every flame's alpha NaN (O7's detector, a lone collapse).
      const capFade = Number.isFinite(edge)
        ? 1 - smooth01((r - fadeFrom) / Math.max(1, edge - fadeFrom))
        : 1;
      const fade =
        capFade * (1 - smooth01((d - 0.85 * CUT_M) / (0.15 * CUT_M)));
      const w = (this.cW[c] as number) * fade;
      if (w <= 0.01) continue;
      const img = nearestImageInto(this.img, viewer, this.canon);
      const grow = (0.55 + 0.45 * (this.cW[c] as number)) * scale;
      // Bigger with distance, so a burning block still reads as fire from
      // across the city (dressing: never solid, never collided).
      const far = 1 + 1.8 * smooth01((d - 100) / 500);
      const kind = info.kind;
      const width =
        info.size *
        grow *
        far *
        (kind === KIND_FLOOR ? 1.3 : kind === KIND_RUBBLE ? 1.6 : 1.15);
      const height =
        width * (kind === KIND_FLOOR ? 1.7 : kind === KIND_RUBBLE ? 0.55 : 1.9);
      // The card form (FLAME_VERTEX): floor / row of tongues / rubble.
      const form = kind === KIND_FLOOR ? 0 : kind === KIND_RUBBLE ? 2 : 1;
      const seed = hash01(info.key | 0, Math.floor(info.key / 4294967296));
      // L7b: no two fires alike — a roaring one beside a low one, so a
      // burning block reads as a ragged skyline of fire, not a curtain.
      const vary = 0.6 + 0.8 * hash01(info.key | 0, 77);
      for (let j = 0; j < CARDS; j++) {
        const o = cards * 4;
        a[o] = img.x;
        a[o + 1] = img.y;
        a[o + 2] = img.z;
        a[o + 3] = width * (0.8 + 0.2 * vary);
        bArr[o] = height * vary;
        bArr[o + 1] = seed;
        bArr[o + 2] = Math.min(1, w * 1.2);
        bArr[o + 3] = j + 4 * form;
        cards++;
      }
      cov += (width * height * CARDS * 0.5) / Math.max(1, d * d);
      if (this.isFloating(c, this.canon, info.nx, info.nz)) floating++;
    }
    const g = this.flames.geometry as THREE.InstancedBufferGeometry;
    g.instanceCount = cards;
    this.flames.visible = cards > 0;
    uploadPrefix(this.flameUploads, cards);
    this.stats.flames = cards / CARDS;
    this.stats.cards = cards;
    this.stats.floating = floating;
    this.stats.coverage = cov * k;
    return n;
  }

  /** D8 QA: does drawn candidate `c` sit over what stands under it? A probe
   * a metre inside the face it burns out of (window and C2 fires). */
  private isFloating(c: number, at: Vec3, nx: number, nz: number): boolean {
    const bi = this.cB[c] as number;
    const id = bi >= 0 ? bi : -1;
    const b =
      id >= 0
        ? (this.buildings[id] as Building)
        : this.buildingOfC2(this.cS[c] as number);
    if (!b) return false;
    if (at.y <= 0.5) return false; // on the ground
    const lx = wrapDeltaAxis(b.x, at.x) - nx * 1.0;
    const lz = wrapDeltaAxis(b.z, at.z) - nz * 1.0;
    return at.y > standingTopAt(b, lx, lz) + 0.5;
  }

  private buildingOfC2(idx: number): Building | null {
    const id = this.c2Ids[idx];
    return id === undefined
      ? null
      : (this.buildings[chunkBuilding(id)] ?? null);
  }

  private camAspect = 16 / 9;
  private tanHalf = Math.tan(THREE.MathUtils.degToRad(35));

  /** One smoke column per burning building: over its lead (lowest-rank
   * live) site, the nearest COLUMNS_MAX × share, faded at the cap. */
  private pickColumns(viewer: Vec3, burn: number): void {
    this.colN = 0;
    const cut2 = CUT_M * CUT_M;
    for (
      let a = 0;
      a < this.active.length && this.colN < this.colB.length;
      a++
    ) {
      const bi = this.active[a] as number;
      const e = this.sites.get(bi) as BuildingSites;
      let lead = -1;
      let sum = 0;
      for (let i = 0; i < e.n; i++) {
        const w = siteWeight(e.rank[i] as number, e.amount);
        if (w <= 0.01) continue;
        sum += w;
        if (lead < 0 || (e.rank[i] as number) < (e.rank[lead] as number)) {
          if (e.kind[i] === KIND_FLOOR || lead < 0) lead = i;
        }
      }
      if (lead < 0) continue;
      const dx = wrapDeltaAxis(viewer.x, e.x[lead] as number);
      const dz = wrapDeltaAxis(viewer.z, e.z[lead] as number);
      const d2 = dx * dx + dz * dz;
      if (d2 > cut2) continue;
      const k = this.colN++;
      this.colB[k] = bi;
      this.colS[k] = lead;
      // L7b: picked (and faded at the cap) by viewRank, level: a column
      // climbs through the whole frame wherever its foot is.
      // Closer than COLUMN_NEAR m a column is a wall of smoke round the
      // camera, not a plume: it picks as though that much farther out.
      const dc = Math.sqrt(d2);
      const dn = dc + 2 * Math.max(0, COLUMN_NEAR - dc);
      this.colD[k] = this.levelRank(dx, dz, dn * dn);
      this.colW[k] = Math.min(1, sum / 3);
    }
    const want = Math.max(1, Math.round(COLUMNS_MAX * this.smokeShare));
    const m = Math.min(want + 1, this.colN);
    for (let i = 0; i < m; i++) {
      let best = i;
      for (let j = i + 1; j < this.colN; j++) {
        if ((this.colD[j] as number) < (this.colD[best] as number)) best = j;
      }
      if (best === i) continue;
      swap4(this.colB, this.colS, this.colD, this.colW, i, best);
    }
    const n = Math.min(want, this.colN);
    const edge =
      this.colN > want ? Math.sqrt(this.colD[want] as number) : CUT_M;
    const fadeFrom = edge * 0.75;
    // Fewer columns on a cheaper tier, each puff grown so the coverage holds.
    const sizeMul = 1 / Math.sqrt(this.smokeShare);
    const a = this.smokeA.array as Float32Array;
    const b = this.smokeB.array as Float32Array;
    let puffs = 0;
    let glow = 0;
    let cov = 0;
    for (let c = 0; c < n; c++) {
      const e = this.sites.get(this.colB[c] as number) as BuildingSites;
      const si = this.colS[c] as number;
      const d = Math.sqrt(this.colD[c] as number);
      const fade = 1 - smooth01((d - fadeFrom) / Math.max(1, edge - fadeFrom));
      const strength = (this.colW[c] as number) * fade;
      if (strength <= 0.02) continue;
      this.canon.x = e.x[si] as number;
      this.canon.y = e.y[si] as number;
      this.canon.z = e.z[si] as number;
      const img = nearestImageInto(this.img, viewer, this.canon);
      // L7b: up into the cloud deck (CLOUD_BASE 500 m) at high burn.
      const height =
        (260 + 280 * Math.min(1, e.wear * 3)) * (0.55 + 0.45 * burn);
      const seed = hash01(this.colB[c] as number, 911);
      for (let p = 0; p < PUFFS; p++) {
        const o = puffs * 4;
        a[o] = img.x;
        a[o + 1] = img.y;
        a[o + 2] = img.z;
        a[o + 3] = height;
        b[o] = p / PUFFS;
        b[o + 1] = seed;
        b[o + 2] = strength;
        b[o + 3] = sizeMul * (0.75 + 0.5 * (this.colW[c] as number));
        puffs++;
      }
      // Coverage: PUFFS puffs ~85 m across, at about the column's distance.
      const sz = 85 * sizeMul;
      cov +=
        (PUFFS * sz * sz * strength) /
        Math.max(1, d * d + height * height * 0.25);
      if (glow < CLOUD_GLOW_MAX) {
        const o = glow * 4;
        this.cloudGlow[o] = img.x;
        this.cloudGlow[o + 1] = img.z;
        this.cloudGlow[o + 2] = strength * burn;
        this.cloudGlow[o + 3] = 300 + 160 * (this.colW[c] as number);
        // L7b: the same block's firelight from below (inferno-shading.ts
        // FIRE_ZONE_UNIFORM), a tighter reach than the glow on the deck.
        (FIRE_ZONE_UNIFORM.value[glow] as THREE.Vector4).set(
          img.x,
          img.z,
          strength * burn,
          170 + 110 * (this.colW[c] as number),
        );
        glow++;
      }
    }
    FIRE_ZONE_COUNT_UNIFORM.value = Math.min(glow, FIRE_ZONES);
    this.cloudGlowCount = glow;
    this.stats.glow = glow;
    const g = this.smoke.geometry as THREE.InstancedBufferGeometry;
    g.instanceCount = puffs;
    this.smoke.visible = puffs > 0;
    uploadPrefix(this.smokeUploads, puffs);
    this.stats.columns = puffs / PUFFS;
    const k = 1 / (4 * this.tanHalf * this.tanHalf * this.camAspect);
    // D11: the columns' frame budget — every puff's strength scaled to fit.
    const scale = smokeCoverageScale(cov * k);
    if (scale < 1) {
      for (let i = 0; i < puffs; i++) {
        b[i * 4 + 2] = (b[i * 4 + 2] as number) * scale;
      }
    }
    this.stats.smokeCoverage = cov * k * scale;
    this.stats.coverage += cov * k * scale;
  }

  /** Fire lights and air anchors from the drawn flames (nearest first,
   * strongest kept), through their fading slots; the heat shimmer list. */
  private feedSlots(
    viewer: Vec3,
    drawn: number,
    dt: number,
    world: number,
  ): void {
    this.lights.begin();
    this.anchors.begin();
    let lightsWanted = 0;
    let anchorsWanted = 0;
    let shimmer = 0;
    this.heatFires = 0;
    for (let c = 0; c < drawn; c++) {
      const w = this.cW[c] as number;
      if (w <= 0.05) continue;
      const info = this.siteOf(c, this.canon);
      const d = Math.sqrt(this.cD[c] as number);
      if (lightsWanted < FIRE_LIGHTS && d < 420) {
        // A little off the face, so it lights the wall it burns on too.
        this.lights.want(
          info.key,
          this.canon.x + info.nx * 2,
          this.canon.y + info.size * 0.8,
          this.canon.z + info.nz * 2,
          12 + info.size * 2.5 * w,
          0.45 + 0.45 * w,
        );
        lightsWanted++;
      }
      if (anchorsWanted < AIR_ANCHORS) {
        this.anchors.want(
          info.key,
          this.canon.x,
          this.canon.y,
          this.canon.z,
          info.size * 1.2,
          info.size * 1.7,
        );
        anchorsWanted++;
      }
      if (shimmer < FIRE_SHIMMER_MAX && d < FIRE_SHIMMER_RANGE && w > 0.4) {
        const h = this.heat[shimmer] as Heat;
        h.x = this.canon.x;
        h.y = this.canon.y + info.size;
        h.z = this.canon.z;
        h.size = info.size * 1.8 * FIRE_SHIMMER_SIZE_PER_M * 4;
        h.level = w;
        shimmer++;
      }
    }
    this.heatFires = shimmer;
    this.lights.end(dt);
    this.anchors.end(dt);
    // Lights → the shared uniforms (render space, flickering on the world clock).
    const L = FIRE_LIGHT_UNIFORM.value;
    const C = FIRE_LIGHT_COLOR_UNIFORM.value;
    let nl = 0;
    const s = world / 1000;
    for (let i = 0; i < FIRE_LIGHTS; i++) {
      const w = this.lights.w[i] as number;
      if (w <= 0) continue;
      this.canon.x = this.lights.x[i] as number;
      this.canon.y = this.lights.y[i] as number;
      this.canon.z = this.lights.z[i] as number;
      const img = nearestImageInto(this.img, viewer, this.canon);
      const ph = i * 1.7;
      const flick =
        0.78 +
        0.14 * Math.sin(s * 9.1 + ph) +
        0.08 * Math.sin(s * 23.3 + ph * 2.3);
      const k = w * (this.lights.b[i] as number) * flick;
      (L[nl] as THREE.Vector4).set(
        img.x,
        img.y,
        img.z,
        this.lights.a[i] as number,
      );
      (C[nl] as THREE.Vector4).set(
        FIRELIGHT_RGB[0] * k,
        FIRELIGHT_RGB[1] * k,
        FIRELIGHT_RGB[2] * k,
        0,
      );
      nl++;
    }
    FIRE_LIGHT_COUNT_UNIFORM.value = nl;
    this.stats.lights = nl;
    // Anchors → the air's uniforms.
    const AU = this.anchorU.value;
    const BU = this.anchorBU.value;
    let na = 0;
    for (let i = 0; i < AIR_ANCHORS; i++) {
      const w = this.anchors.w[i] as number;
      const v = AU[i] as THREE.Vector4;
      if (w <= 0) {
        v.w = 0;
        continue;
      }
      this.canon.x = this.anchors.x[i] as number;
      this.canon.y = this.anchors.y[i] as number;
      this.canon.z = this.anchors.z[i] as number;
      const img = nearestImageInto(this.img, viewer, this.canon);
      v.set(img.x, img.y, img.z, w);
      (BU[i] as THREE.Vector4).set(
        this.anchors.a[i] as number,
        this.anchors.b[i] as number,
        0,
        0,
      );
      na++;
    }
    this.stats.anchors = na;
    const count =
      na > 0 && this.airShare > 0
        ? Math.round(
            AIR_MAX *
              this.airShare *
              Math.min(1, 0.3 + this.stats.burn * 0.9) *
              Math.min(1, na / 6),
          )
        : 0;
    // L7b: the camera's embers and ash — as strong as the burn, within
    // reach of the nearest drawn fire (sorted first by pickFlames).
    const near = drawn > 0 ? Math.sqrt(this.cD[0] as number) : CUT_M;
    const camK =
      this.airShare > 0
        ? smooth01((this.stats.burn - 0.2) / 0.5) *
          (1 - smooth01((near - 150) / 400))
        : 0;
    const wx = this.windU.value.x;
    const wz = this.windU.value.y;
    driftInto(this.emberOffU.value, wx * 1.6 * dt, 2.6 * dt, wz * 1.6 * dt);
    driftInto(this.ashOffU.value, wx * 2.5 * dt, -1.4 * dt, wz * 2.5 * dt);
    this.camBoxU.value.set(viewer.x, viewer.y, viewer.z, camK);
    const camN = camK > 0.01 ? Math.round(AIR_CAM * this.airShare) : 0;
    this.air.geometry.setDrawRange(AIR_CAM - camN, camN + count);
    this.air.visible = camN + count > 0;
    this.stats.air = camN + count;
  }

  private heatFires = 0;

  /** The J1 heat list for atmosphere-fx: the live blasts first (never
   * crowded out), then up to FIRE_SHIMMER_MAX fires. Returns the count;
   * the list is `this.heat`. */
  mergeHeat(blasts: readonly Heat[], count: number): number {
    // The fires were written at the front by update(); move them behind.
    const fires = this.heatFires;
    const need = count + fires;
    while (this.heat.length < need) {
      this.heat.push({ x: 0, y: 0, z: 0, size: 0, level: 0 });
    }
    for (let i = fires - 1; i >= 0; i--) {
      const from = this.heat[i] as Heat;
      const to = this.heat[count + i] as Heat;
      if (from === to) continue;
      to.x = from.x;
      to.y = from.y;
      to.z = from.z;
      to.size = from.size;
      to.level = from.level;
    }
    for (let i = 0; i < count; i++) {
      const from = blasts[i] as Heat;
      const to = this.heat[i] as Heat;
      to.x = from.x;
      to.y = from.y;
      to.z = from.z;
      to.size = from.size;
      to.level = from.level;
    }
    return need;
  }

  /** QA: what is drawn (a copy). */
  info(): InfernoStats {
    return { ...this.stats };
  }
}

/** Move a camera-air drift by (dx, dy, dz), kept in [0, CAM_BOX). */
function driftInto(v: THREE.Vector3, dx: number, dy: number, dz: number): void {
  const m = (a: number) => a - Math.floor(a / CAM_BOX) * CAM_BOX;
  v.set(m(v.x + dx), m(v.y + dy), m(v.z + dz));
}

/** Swap entries i and j of four parallel arrays (no closure per swap). */
function swap4(
  b: Int32Array,
  s: Int16Array,
  d: Float64Array,
  w: Float32Array,
  i: number,
  j: number,
): void {
  let t = b[i] as number;
  b[i] = b[j] as number;
  b[j] = t;
  t = s[i] as number;
  s[i] = s[j] as number;
  s[j] = t;
  t = d[i] as number;
  d[i] = d[j] as number;
  d[j] = t;
  t = w[i] as number;
  w[i] = w[j] as number;
  w[j] = t;
}

/** A unit card: x in ±0.5, y in [y0, y0 + 1]. */
function cardGeometry(y0: number): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute(
    "position",
    new THREE.BufferAttribute(
      new Float32Array([
        -0.5,
        y0,
        0,
        0.5,
        y0,
        0,
        0.5,
        y0 + 1,
        0,
        -0.5,
        y0 + 1,
        0,
      ]),
      3,
    ),
  );
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
}

function dynAttr(n: number, size: number): THREE.InstancedBufferAttribute {
  const a = new THREE.InstancedBufferAttribute(
    new Float32Array(n * size),
    size,
  );
  a.setUsage(THREE.DynamicDrawUsage);
  return a;
}

/** Fog-capable uniforms (UniformsLib.fog carries the haze and weather by
 * reference once installHeightFog has run) plus `own`, kept live. */
function fogUniforms(
  own: Record<string, THREE.IUniform>,
): Record<string, THREE.IUniform> {
  const u = THREE.UniformsUtils.merge([THREE.UniformsLib.fog]);
  for (const k of Object.keys(own)) u[k] = own[k] as THREE.IUniform;
  return u;
}
