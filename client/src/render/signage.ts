// Street-level neon signage (S2, client-only dressing) — the "Full Times
// Square" concept the design gate picked: vertical glyph marquees, billboards,
// storefront strips, and sidewalk neon spill, dense near landmarks/plazas and
// quiet on side streets. Layout is the pure seam signageFor(): deterministic
// per building from (world seed, building) via the shared mulberry32 — no
// Math.random, so every client dresses identical streets (same idiom as
// roofClutterFor). Signs mount flush on TIER-1 facades — the plan's sanctioned
// visual-without-collision exception — and every offset that could reach the
// roadway comes from the S1 street contract, never a literal.

import {
  type Building,
  LANDMARK_BLOCKS,
  PLAZA_BLOCKS,
  mulberry32,
} from "@angels-bandits/common/city";
import { ROADWAY_HALF } from "@angels-bandits/common/city/street";
import {
  BLOCK_PITCH,
  EMISSIVE_SIGN,
  WORLD_SIZE,
} from "@angels-bandits/common/constants";
import {
  type Vec3,
  canonicalize,
  wrapDelta,
} from "@angels-bandits/common/world";
import * as THREE from "three";
import { emissiveBoost } from "./emissive";
import { nearestImage } from "./wrapPlacement";

// --- Tunables (Concept 4: steep density gradient, everything on) ---
/** Marquee panel: along-facade width, meters. */
const MARQUEE_WIDTH_MIN = 2;
const MARQUEE_WIDTH_MAX = 3;
/** Marquee vertical extent, meters. */
const MARQUEE_HEIGHT_MIN = 8;
const MARQUEE_HEIGHT_MAX = 25;
/** Marquee bottom edge above the sidewalk, meters. */
const MARQUEE_BOTTOM_MIN = 4;
const MARQUEE_BOTTOM_MAX = 8;
/** How proud of the facade a marquee box sits, meters. */
const MARQUEE_DEPTH = 0.6;
/** Mean marquees per facade before the density gradient. */
const MARQUEE_FACE_MEAN = 1.6;
/** Hard cap per facade. */
const MARQUEE_FACE_MAX = 4;

/** Facades need this much sidewalk between face and curb to carry signs —
 * covers the proudest sign plus clearance so no corner touches the roadway. */
const MIN_FACE_CLEARANCE = 1.2;
/** Candidate sign stations per facade (signs get distinct slots, no overlap). */
const FACE_SLOTS = 6;
/** Fraction of the facade length usable for slots (insets keep corners clear). */
const FACE_USABLE = 0.84;

/** Density gradient (Concept 4): quiet side streets → riot at landmarks. */
const DENSITY_BASE = 0.7;
const DENSITY_HOT = 1.1;
/** Blocks of Chebyshev distance over which landmark/plaza heat fades to 0. */
const HEAT_RADIUS = 3;

/** Marquee glyph-texture pool size (atlas tiles; grown from the plan's ~8 —
 * the dense concept repeats textures too visibly with fewer). */
export const MARQUEE_TEXTURE_POOL = 16;

/** Billboard quad: along-facade width, meters (plan: 8×5 to 16×9). */
const BILLBOARD_WIDTH_MIN = 8;
const BILLBOARD_WIDTH_MAX = 16;
const BILLBOARD_HEIGHT_MIN = 5;
const BILLBOARD_HEIGHT_MAX = 9;
/** Billboard bottom edge above the storefront band, meters. */
const BILLBOARD_BOTTOM_MIN = 6;
const BILLBOARD_BOTTOM_MAX = 14;
/** How proud of the facade a billboard sits, meters (flatter than marquees). */
const BILLBOARD_DEPTH = 0.3;
/** Mean billboards per facade before the density gradient (plan caps at 2). */
const BILLBOARD_FACE_MEAN = 1.1;
const BILLBOARD_FACE_MAX = 2;

/** Billboard art-texture pool size (atlas tiles). */
export const BILLBOARD_TEXTURE_POOL = 8;

/** Storefront strip: a thin sign band just above the shop-glass line the
 * buildings shader paints (its shop band tops out at 4 m of world height). */
const STRIP_BOTTOM = 4.1;
const STRIP_HEIGHT = 0.7;
/** How proud of the facade the strip sits, meters. */
const STRIP_DEPTH = 0.4;

/** A facade spills onto the sidewalk once it carries this many signs. */
const SPILL_MIN_CLUSTER = 3;
/** Pool radius bounds, meters (lamp glow pools are 9 m). */
const SPILL_RADIUS_MAX = 8;

// --- Seeded neon palette (linear RGB, weighted like the reference photo) ---
export interface PaletteColor {
  r: number;
  g: number;
  b: number;
}
/** pink, cyan, amber, blue, red — Concept 4's balanced warm+cool mix. */
export const SIGN_PALETTE: readonly PaletteColor[] = [
  { r: 1.0, g: 0.15, b: 0.75 },
  { r: 0.1, g: 0.85, b: 1.0 },
  { r: 1.0, g: 0.55, b: 0.1 },
  { r: 0.2, g: 0.35, b: 1.0 },
  { r: 1.0, g: 0.12, b: 0.1 },
];
const PALETTE_WEIGHTS = [2.5, 2, 2.5, 1.5, 2.5] as const;
const PALETTE_TOTAL = PALETTE_WEIGHTS.reduce((a, w) => a + w, 0);

/** Weighted palette pick from one PRNG draw. */
function paletteIndex(roll: number): number {
  let r = roll * PALETTE_TOTAL;
  for (let i = 0; i < PALETTE_WEIGHTS.length; i++) {
    r -= PALETTE_WEIGHTS[i] as number;
    if (r <= 0) return i;
  }
  return 0;
}

// --- Layout types (the pure seam's output) ---
/** One flush facade-mounted sign panel, canonical coords. */
export interface SignPlacement {
  /** Canonical panel-center ground position (center of the proud box). */
  x: number;
  z: number;
  /** Bottom edge height, meters. */
  y: number;
  /** Along-facade extent, meters. */
  width: number;
  /** Vertical extent, meters. */
  height: number;
  /** Proud-of-facade extent, meters. */
  depth: number;
  /** Facade outward-normal axis and direction. */
  axis: "x" | "z";
  dir: -1 | 1;
  paletteIndex: number;
  /** Atlas tile this sign samples. */
  textureIndex: number;
  /** Pulse phase offset, 0..1 of a period. */
  phase: number;
}

/** One additive ground-glow pool on the sidewalk (lamp-glow idiom). */
export interface SpillPool {
  x: number;
  z: number;
  radius: number;
  paletteIndex: number;
  phase: number;
}

export interface BuildingSignage {
  marquees: SignPlacement[];
  billboards: SignPlacement[];
  strips: SignPlacement[];
  spills: SpillPool[];
}

/** Torus-wrapped block-index distance on the GRID×GRID block grid. */
const GRID = WORLD_SIZE / BLOCK_PITCH;
function blockDist(a: number, b: number): number {
  const d = Math.abs(a - b) % GRID;
  return Math.min(d, GRID - d);
}

/**
 * Landmark/plaza heat for a building: 1 on a hotspot-adjacent block fading
 * linearly to 0 at HEAT_RADIUS blocks (Chebyshev, wrap-aware). This is the
 * "Times Square concentration" — pure function of the block position.
 */
export function landmarkHeat(b: Building): number {
  const bx = Math.floor(b.x / BLOCK_PITCH);
  const bz = Math.floor(b.z / BLOCK_PITCH);
  let nearest = Number.POSITIVE_INFINITY;
  for (const [hx, hz] of [...LANDMARK_BLOCKS, ...PLAZA_BLOCKS]) {
    const d = Math.max(blockDist(bx, hx), blockDist(bz, hz));
    if (d < nearest) nearest = d;
  }
  return Math.max(0, 1 - nearest / HEAT_RADIUS);
}

/** The four tier-1 facades of a building, with the S1-derived clearance
 * between the facade plane and the curb of the street it faces. */
interface Face {
  axis: "x" | "z";
  dir: -1 | 1;
  /** Along-facade length, meters (the other footprint dimension). */
  length: number;
  /** Facade plane's coordinate on `axis`. */
  plane: number;
  /** Sidewalk depth from facade plane to the curb, meters. */
  clearance: number;
}

function tierOneFaces(b: Building): Face[] {
  const t1 = b.tiers[0];
  if (!t1) return [];
  const faces: Face[] = [];
  for (const axis of ["x", "z"] as const) {
    const perp = axis === "x" ? t1.width : t1.depth;
    const length = axis === "x" ? t1.depth : t1.width;
    const clearance = (BLOCK_PITCH - perp) / 2 - ROADWAY_HALF;
    for (const dir of [-1, 1] as const) {
      faces.push({
        axis,
        dir,
        length,
        plane: (axis === "x" ? b.x : b.z) + (dir * perp) / 2,
        clearance,
      });
    }
  }
  return faces;
}

/** Fisher–Yates shuffle of 0..n-1 driven by the face's PRNG. */
function shuffledSlots(rand: () => number, n: number): number[] {
  const slots = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = slots[i] as number;
    slots[i] = slots[j] as number;
    slots[j] = tmp;
  }
  return slots;
}

/**
 * Deterministic signage for one building's tier-1 facades. Faces whose
 * sidewalk clearance can't hold a proud sign (max-footprint buildings sit ON
 * the curb) stay bare. Everything derives from (seed, building) — same city
 * seed, same neon, on every client.
 */
export function signageFor(b: Building, seed: number): BuildingSignage {
  const none: BuildingSignage = {
    marquees: [],
    billboards: [],
    strips: [],
    spills: [],
  };
  const t1 = b.tiers[0];
  if (!t1) return none;

  const bSeed =
    (seed ^
      Math.imul(b.x, 73856093) ^
      Math.imul(b.z, 19349663) ^
      Math.imul(b.height, 83492791)) >>>
    0;
  const density = DENSITY_BASE + DENSITY_HOT * landmarkHeat(b);
  const out: BuildingSignage = {
    marquees: [],
    billboards: [],
    strips: [],
    spills: [],
  };

  tierOneFaces(b).forEach((face, faceIndex) => {
    if (face.clearance < MIN_FACE_CLEARANCE) return;
    const rand = mulberry32(
      (bSeed ^ Math.imul(faceIndex + 1, 0x9e3779b9)) >>> 0,
    );
    const slots = shuffledSlots(rand, FACE_SLOTS);
    const span = face.length * FACE_USABLE;
    const slotWidth = span / FACE_SLOTS;
    const along = (slot: number) =>
      (face.axis === "x" ? b.z : b.x) - span / 2 + (slot + 0.5) * slotWidth;

    // Panel center sits depth/2 outside the facade plane.
    const place = (
      centerAlong: number,
      depth: number,
    ): { x: number; z: number } => {
      const centerPerp = face.plane + (face.dir * depth) / 2;
      const p =
        face.axis === "x"
          ? { x: centerPerp, y: 0, z: centerAlong }
          : { x: centerAlong, y: 0, z: centerPerp };
      const c = canonicalize(p);
      return { x: c.x, z: c.z };
    };

    /** Marquees + billboards mounted on THIS facade (drives the spill). */
    const faceSigns: SignPlacement[] = [];

    // --- Vertical marquees ---
    const marqueeCount = Math.min(
      MARQUEE_FACE_MAX,
      Math.round(MARQUEE_FACE_MEAN * density * (0.6 + 0.8 * rand())),
    );
    const tier1Top = t1.height - 1;
    for (let i = 0; i < marqueeCount; i++) {
      const slot = slots[i % FACE_SLOTS] as number;
      const width =
        MARQUEE_WIDTH_MIN + rand() * (MARQUEE_WIDTH_MAX - MARQUEE_WIDTH_MIN);
      const bottom =
        MARQUEE_BOTTOM_MIN + rand() * (MARQUEE_BOTTOM_MAX - MARQUEE_BOTTOM_MIN);
      const height = Math.min(
        MARQUEE_HEIGHT_MIN + rand() * (MARQUEE_HEIGHT_MAX - MARQUEE_HEIGHT_MIN),
        tier1Top - bottom,
      );
      const jitter =
        (rand() * 2 - 1) * Math.max(0, slotWidth / 2 - width / 2 - 0.5);
      if (height < MARQUEE_HEIGHT_MIN) continue;
      const marquee: SignPlacement = {
        ...place(along(slot) + jitter, MARQUEE_DEPTH),
        y: bottom,
        width,
        height,
        depth: MARQUEE_DEPTH,
        axis: face.axis,
        dir: face.dir,
        paletteIndex: paletteIndex(rand()),
        textureIndex: Math.floor(rand() * MARQUEE_TEXTURE_POOL),
        phase: rand(),
      };
      out.marquees.push(marquee);
      faceSigns.push(marquee);
    }

    // --- Billboards (lower facade, slots after the marquees') ---
    const billboardCount = Math.min(
      BILLBOARD_FACE_MAX,
      Math.floor(BILLBOARD_FACE_MEAN * density * rand() * 2),
    );
    for (let i = 0; i < billboardCount; i++) {
      const slot = slots[(marqueeCount + i) % FACE_SLOTS] as number;
      const width =
        BILLBOARD_WIDTH_MIN +
        rand() * (BILLBOARD_WIDTH_MAX - BILLBOARD_WIDTH_MIN);
      const height =
        BILLBOARD_HEIGHT_MIN +
        rand() * (BILLBOARD_HEIGHT_MAX - BILLBOARD_HEIGHT_MIN);
      const bottom = Math.min(
        BILLBOARD_BOTTOM_MIN +
          rand() * (BILLBOARD_BOTTOM_MAX - BILLBOARD_BOTTOM_MIN),
        t1.height - height,
      );
      const jitter =
        (rand() * 2 - 1) * Math.max(0, slotWidth / 2 - width / 2 - 0.5);
      if (bottom < BILLBOARD_BOTTOM_MIN) continue;
      const billboard: SignPlacement = {
        ...place(along(slot) + jitter, BILLBOARD_DEPTH),
        y: bottom,
        width,
        height,
        depth: BILLBOARD_DEPTH,
        axis: face.axis,
        dir: face.dir,
        paletteIndex: paletteIndex(rand()),
        textureIndex: Math.floor(rand() * BILLBOARD_TEXTURE_POOL),
        phase: rand(),
      };
      out.billboards.push(billboard);
      faceSigns.push(billboard);
    }

    // --- Storefront strip (one continuous band per facade, Concept 4) ---
    out.strips.push({
      ...place(face.axis === "x" ? b.z : b.x, STRIP_DEPTH),
      y: STRIP_BOTTOM,
      width: span,
      height: STRIP_HEIGHT,
      depth: STRIP_DEPTH,
      axis: face.axis,
      dir: face.dir,
      paletteIndex: paletteIndex(rand()),
      textureIndex: 0,
      phase: rand(),
    });

    // --- Neon spill: a dense facade tints its sidewalk (lamp-glow idiom) ---
    if (faceSigns.length >= SPILL_MIN_CLUSTER) {
      const mid = face.plane + (face.dir * face.clearance) / 2;
      const alongMid = face.axis === "x" ? b.z : b.x;
      const c = canonicalize(
        face.axis === "x"
          ? { x: mid, y: 0, z: alongMid }
          : { x: alongMid, y: 0, z: mid },
      );
      out.spills.push({
        x: c.x,
        z: c.z,
        radius: Math.min(SPILL_RADIUS_MAX, Math.max(2, face.clearance * 0.75)),
        paletteIndex: (faceSigns[0] as SignPlacement).paletteIndex,
        phase: rand(),
      });
    }
  });

  return out;
}

// --- Renderer (consumes the pure layout above; untested, like Streetlights) ---

/** Synced hue-pulse: period of the shimmer, ms of server time. */
const PULSE_PERIOD_MS = 7000;
/** Pulse SCALES DOWN from the rung (peak = exactly EMISSIVE_SIGN) so the
 * shimmer can never climb over the lamp rung above it. */
const PULSE_DEPTH = 0.12;

/** Ground-glow opacity for the sidewalk spill (Concept 4: visible tint). */
const SPILL_OPACITY = 0.14;
/** Spill quad lift, meters — between the ground plane (0) and the lamp glow
 * pools (0.2) so none of the three coplanar-fight. */
const SPILL_LIFT = 0.16;

/** Marquee glyph atlas: TILES tall narrow tiles side by side. */
const MARQUEE_TILE_W = 64;
const MARQUEE_TILE_H = 512;
/** Billboard art atlas tile size. */
const BILLBOARD_TILE_W = 256;
const BILLBOARD_TILE_H = 128;

/** Blocky fake glyph: a 3×5 cell grid with ~half the cells lit — reads as a
 * letter from flight distance, is not one (no fonts, no real names). */
function drawGlyph(
  ctx: CanvasRenderingContext2D,
  rand: () => number,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  for (let gy = 0; gy < 5; gy++) {
    for (let gx = 0; gx < 3; gx++) {
      if (rand() < 0.55) {
        ctx.fillRect(x + (gx * w) / 3, y + (gy * h) / 5, w / 3.6, h / 6);
      }
    }
  }
}

/** Seeded atlas of white-on-dark glyph-stack marquee faces. Deterministic
 * from the world seed, so every client bakes identical signs. */
function marqueeAtlas(seed: number): THREE.CanvasTexture {
  const rand = mulberry32((seed ^ 0x51637a) >>> 0);
  const canvas = document.createElement("canvas");
  canvas.width = MARQUEE_TILE_W * MARQUEE_TEXTURE_POOL;
  canvas.height = MARQUEE_TILE_H;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.fillStyle = "#0b0b12";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    for (let tile = 0; tile < MARQUEE_TEXTURE_POOL; tile++) {
      const x0 = tile * MARQUEE_TILE_W;
      // Neon tube frame at full white — tinted to the rung per instance.
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 4;
      ctx.strokeRect(x0 + 5, 5, MARQUEE_TILE_W - 10, MARQUEE_TILE_H - 10);
      const cells = 5 + Math.floor(rand() * 5);
      const cellH = (MARQUEE_TILE_H - 44) / cells;
      for (let c = 0; c < cells; c++) {
        ctx.fillStyle = rand() < 0.85 ? "#ffffff" : "#c8c8c8";
        drawGlyph(
          ctx,
          rand,
          x0 + MARQUEE_TILE_W * 0.22,
          22 + c * cellH + cellH * 0.14,
          MARQUEE_TILE_W * 0.56,
          cellH * 0.72,
        );
      }
    }
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Seeded atlas of grayscale color-block billboard art (tinted per instance,
 * so one atlas serves the whole palette). */
function billboardAtlas(seed: number): THREE.CanvasTexture {
  const rand = mulberry32((seed ^ 0xb111b0) >>> 0);
  const canvas = document.createElement("canvas");
  canvas.width = BILLBOARD_TILE_W * BILLBOARD_TEXTURE_POOL;
  canvas.height = BILLBOARD_TILE_H;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    for (let tile = 0; tile < BILLBOARD_TEXTURE_POOL; tile++) {
      const x0 = tile * BILLBOARD_TILE_W;
      // Diagonal gray gradient — hue arrives via the per-instance tint.
      const grad = ctx.createLinearGradient(
        x0,
        0,
        x0 + BILLBOARD_TILE_W,
        BILLBOARD_TILE_H,
      );
      grad.addColorStop(0, "#8c8c8c");
      grad.addColorStop(1, "#e6e6e6");
      ctx.fillStyle = grad;
      ctx.fillRect(x0, 0, BILLBOARD_TILE_W, BILLBOARD_TILE_H);
      // A few hard color blocks, light and dark.
      const blocks = 2 + Math.floor(rand() * 3);
      for (let i = 0; i < blocks; i++) {
        ctx.fillStyle = rand() < 0.6 ? "#ffffff" : "#1c1c24";
        ctx.fillRect(
          x0 + rand() * BILLBOARD_TILE_W * 0.7,
          rand() * BILLBOARD_TILE_H * 0.5,
          BILLBOARD_TILE_W * (0.1 + rand() * 0.25),
          BILLBOARD_TILE_H * (0.15 + rand() * 0.3),
        );
      }
      // Dark footer bar with a white glyph row — the "brand line".
      ctx.fillStyle = "#14141c";
      ctx.fillRect(
        x0,
        BILLBOARD_TILE_H * 0.72,
        BILLBOARD_TILE_W,
        BILLBOARD_TILE_H * 0.28,
      );
      ctx.fillStyle = "#ffffff";
      const glyphs = 4 + Math.floor(rand() * 4);
      for (let g = 0; g < glyphs; g++) {
        drawGlyph(
          ctx,
          rand,
          x0 + BILLBOARD_TILE_W * 0.08 + g * BILLBOARD_TILE_W * 0.11,
          BILLBOARD_TILE_H * 0.76,
          BILLBOARD_TILE_W * 0.08,
          BILLBOARD_TILE_H * 0.2,
        );
      }
    }
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Soft white radial falloff for the spill pools (lamp-glow idiom, but white
 * so the per-instance tint carries the sign's hue). */
function spillTexture(): THREE.Texture {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, "rgba(255, 255, 255, 1)");
    grad.addColorStop(0.4, "rgba(255, 255, 255, 0.35)");
    grad.addColorStop(1, "rgba(255, 255, 255, 0)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Atlas-tiled emissive sign material: per-instance `aTile` picks the atlas
 * column. Needs its OWN program cache key — three keys programs on
 * onBeforeCompile.toString(), and this repo has been bitten by textually
 * identical patches silently sharing programs (see traffic.ts). */
function signMaterial(
  map: THREE.Texture,
  tiles: number,
  cacheKey: string,
): THREE.MeshBasicMaterial {
  const material = new THREE.MeshBasicMaterial({ map });
  material.customProgramCacheKey = () => cacheKey;
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nattribute float aTile;")
      .replace(
        "#include <uv_vertex>",
        `#include <uv_vertex>\nvMapUv = vMapUv * vec2(${(1 / tiles).toFixed(8)}, 1.0) + vec2(aTile * ${(1 / tiles).toFixed(8)}, 0.0);`,
      );
  };
  return material;
}

/** One unit box with its base at y = 0 (the city/clutter idiom): a compose()
 * with scale (width, height, depth) stands a sign on its bottom edge. */
function unitPanelGeometry(): THREE.BoxGeometry {
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  geometry.translate(0, 0.5, 0);
  return geometry;
}

/** Facade-normal yaw: rotates the panel's local +Z (its face) to point
 * outward, which also lays its local X (width) along the facade. */
const panelYaw = (s: SignPlacement): number => {
  if (s.axis === "z") return s.dir === 1 ? 0 : Math.PI;
  return s.dir === 1 ? Math.PI / 2 : -Math.PI / 2;
};

/**
 * The instanced street-neon renderer: 4 draw calls (marquees, billboards,
 * strips, spill), placed per frame at the torus image nearest the camera.
 * Per-instance palette tints ride instanceColor at HDR: base color × the
 * emissive boost that lifts it to the SIGN rung, × the synced-clock pulse.
 */
export class Signage {
  readonly group = new THREE.Group();
  private readonly marquees: SignPlacement[];
  private readonly billboards: SignPlacement[];
  private readonly strips: SignPlacement[];
  private readonly spills: SpillPool[];
  private readonly marqueeMesh: THREE.InstancedMesh;
  private readonly billboardMesh: THREE.InstancedMesh;
  private readonly stripMesh: THREE.InstancedMesh;
  private readonly spillMesh: THREE.InstancedMesh;
  private readonly scratch = new THREE.Matrix4();
  private readonly quat = new THREE.Quaternion();
  private readonly pos = new THREE.Vector3();
  private readonly scale = new THREE.Vector3();
  private static readonly UP = new THREE.Vector3(0, 1, 0);

  constructor(buildings: readonly Building[], seed: number) {
    const layouts = buildings.map((b) => signageFor(b, seed));
    this.marquees = layouts.flatMap((s) => s.marquees);
    this.billboards = layouts.flatMap((s) => s.billboards);
    this.strips = layouts.flatMap((s) => s.strips);
    this.spills = layouts.flatMap((s) => s.spills);

    const panel = unitPanelGeometry();
    this.marqueeMesh = new THREE.InstancedMesh(
      panel.clone(),
      signMaterial(marqueeAtlas(seed), MARQUEE_TEXTURE_POOL, "ab-sign-marquee"),
      this.marquees.length,
    );
    this.billboardMesh = new THREE.InstancedMesh(
      panel.clone(),
      signMaterial(
        billboardAtlas(seed),
        BILLBOARD_TEXTURE_POOL,
        "ab-sign-billboard",
      ),
      this.billboards.length,
    );
    this.stripMesh = new THREE.InstancedMesh(
      panel,
      new THREE.MeshBasicMaterial(),
      this.strips.length,
    );

    const spillGeometry = new THREE.CircleGeometry(1, 16);
    spillGeometry.rotateX(-Math.PI / 2); // flat on the sidewalk
    this.spillMesh = new THREE.InstancedMesh(
      spillGeometry,
      new THREE.MeshBasicMaterial({
        map: spillTexture(),
        transparent: true,
        opacity: SPILL_OPACITY,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false, // additive + fog would brighten the distant ground
      }),
      this.spills.length,
    );

    this.setTiles(this.marqueeMesh, this.marquees);
    this.setTiles(this.billboardMesh, this.billboards);

    for (const mesh of [
      this.marqueeMesh,
      this.billboardMesh,
      this.stripMesh,
      this.spillMesh,
    ]) {
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false; // instances move relative to the camera every frame
      this.group.add(mesh);
    }
  }

  /** Per-instance atlas-tile attribute for a sign mesh. */
  private setTiles(mesh: THREE.InstancedMesh, signs: SignPlacement[]): void {
    const tiles = new Float32Array(signs.length);
    signs.forEach((s, i) => {
      tiles[i] = s.textureIndex;
    });
    mesh.geometry.setAttribute(
      "aTile",
      new THREE.InstancedBufferAttribute(tiles, 1),
    );
  }

  /** Signage instances drawn per kind — perf reporting/QA. */
  get counts(): {
    marquees: number;
    billboards: number;
    strips: number;
    spills: number;
  } {
    return {
      marquees: this.marquees.length,
      billboards: this.billboards.length,
      strips: this.strips.length,
      spills: this.spills.length,
    };
  }

  /** The synced pulse: scales DOWN from 1 so the peak sits exactly on the
   * SIGN rung — the shimmer can never cross the lamp rung above it. */
  private static pulse(timeMs: number, phase: number): number {
    const s = Math.sin((timeMs / PULSE_PERIOD_MS + phase) * 2 * Math.PI);
    return 1 - PULSE_DEPTH + PULSE_DEPTH * s;
  }

  /** Write one sign kind's matrices + pulsed HDR tints for this frame. */
  private place(
    mesh: THREE.InstancedMesh,
    signs: SignPlacement[],
    cameraPos: Vec3,
    timeMs: number,
    color: THREE.Color,
  ): void {
    signs.forEach((s, i) => {
      const p = nearestImage(cameraPos, { x: s.x, y: 0, z: s.z });
      this.quat.setFromAxisAngle(Signage.UP, panelYaw(s));
      this.pos.set(p.x, s.y, p.z);
      this.scale.set(s.width, s.height, s.depth);
      this.scratch.compose(this.pos, this.quat, this.scale);
      mesh.setMatrixAt(i, this.scratch);

      const base = SIGN_PALETTE[s.paletteIndex] as PaletteColor;
      color.setRGB(base.r, base.g, base.b);
      color.multiplyScalar(
        emissiveBoost(color, EMISSIVE_SIGN) * Signage.pulse(timeMs, s.phase),
      );
      mesh.setColorAt(i, color);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  private readonly tint = new THREE.Color();

  /**
   * Place everything at its torus image nearest the camera; `timeMs` is
   * server-synced time so every client's neon pulses in phase (same source
   * as the landmark beacons).
   */
  update(cameraPos: Vec3, timeMs: number): void {
    this.place(this.marqueeMesh, this.marquees, cameraPos, timeMs, this.tint);
    this.place(
      this.billboardMesh,
      this.billboards,
      cameraPos,
      timeMs,
      this.tint,
    );
    this.place(this.stripMesh, this.strips, cameraPos, timeMs, this.tint);

    this.spills.forEach((sp, i) => {
      const p = nearestImage(cameraPos, { x: sp.x, y: 0, z: sp.z });
      this.scratch.makeScale(sp.radius, 1, sp.radius);
      this.scratch.setPosition(p.x, SPILL_LIFT, p.z);
      this.spillMesh.setMatrixAt(i, this.scratch);
      const base = SIGN_PALETTE[sp.paletteIndex] as PaletteColor;
      this.tint.setRGB(base.r, base.g, base.b);
      this.tint.multiplyScalar(Signage.pulse(timeMs, sp.phase));
      this.spillMesh.setColorAt(i, this.tint);
    });
    this.spillMesh.instanceMatrix.needsUpdate = true;
    if (this.spillMesh.instanceColor) {
      this.spillMesh.instanceColor.needsUpdate = true;
    }
  }

  /**
   * QA hook (seam checks): where the marquee nearest canonical (x, z) is
   * currently DRAWN, read back from its instance matrix — the rendered
   * truth, not a re-derivation (same idiom as Streetlights.imageOf).
   */
  imageOf(x: number, z: number): { x: number; z: number } | null {
    let best = -1;
    let bestDist = Number.POSITIVE_INFINITY;
    this.marquees.forEach((m, i) => {
      const d = wrapDelta({ x, y: 0, z }, { x: m.x, y: 0, z: m.z });
      const dist = d.x * d.x + d.z * d.z;
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    });
    if (best < 0) return null;
    this.marqueeMesh.getMatrixAt(best, this.scratch);
    const e = this.scratch.elements;
    return { x: e[12] as number, z: e[14] as number };
  }
}
