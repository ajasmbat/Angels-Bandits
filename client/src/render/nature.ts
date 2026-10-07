// N1 nature renderer: park and forecourt trees, street trees in tree pits,
// park lamps, forecourt planters and construction hoardings. A thin THREE
// adapter over the pure seam natureFor() in common/src/city/nature.ts — the
// same Streetlights / RoofClutter pattern: canonical layout built once,
// re-placed at the torus image nearest the camera.
//
// DRAW-CALL BUDGET: exactly three meshes, whatever the view.
//   1. solids   — one unit box: trunks, tree pits, lamp poles, planters,
//                 hoardings (per-instance colour).
//   2. canopies — one low-poly icosahedron: every crown and planter shrub.
//   3. heads    — the park-lamp heads, on the existing LAMP ladder rung.
// The parks' lawns, paths, pond and lamp pools are ground paint (sky.ts) and
// cost no draw call at all.
//
// DRAW == COLLIDE. Every tree instance is scaled from treeBoxes(), the call
// collision indexes. The trunk box is drawn as that box; the crown is an
// icosahedron whose vertices all sit on the unit sphere, scaled to the
// canopy box's half-extents — i.e. the ellipsoid inscribed in the box, which
// is exactly the volume collideNature() treats as solid.
//
// WIND (L9). The crowns sway in the shared wind (common/src/wind.ts) inside
// their vertex shader: drawn at CROWN_DRAW_SCALE and displaced at most the
// slack that leaves, so a swaying crown never leaves the solid ellipsoid.
// Park, forecourt and street crowns and planter shrubs all share the one
// crown mesh and sway alike — still three draw calls.

import {
  type Nature,
  type NatureBox,
  treeBoxes,
} from "@angels-bandits/common/city/nature";
import { EMISSIVE_LAMP } from "@angels-bandits/common/constants";
import {
  CROWN_BEGIN_VERTEX_GLSL,
  CROWN_SWAY_GLSL,
  SWAY_UNIFORM_PHASE,
  SWAY_UNIFORM_WIND,
  type SwayPhases,
  type Wind,
  swayPhases,
  windAt,
} from "@angels-bandits/common/wind";
import type { Vec3 } from "@angels-bandits/common/world";
import * as THREE from "three";
import { emissiveBoost } from "./emissive";
import { ImageCache, InstanceUploads } from "./wrapPlacement";

/** Re-image every instance once the camera has moved this far, m. An
 * instance can then sit on a stale image only while it is within this
 * distance of the antipode (≥ 950 m away) — far beyond FOG_DISTANCE (800). */
const REIMAGE_STEP = 50;

const TRUNK_COLOR = 0x2b2019;
const PIT_COLOR = 0x120f0c;
const POLE_COLOR = 0x1a1a26; // the street-lamp pole colour
const PLANTER_COLOR = 0x3a3b46;
const HOARDING_COLORS = [0x22314a, 0x2a3a2c, 0x3a2f45] as const;
/** Crown colours by kind: night foliage, a touch lifted so moonlight and the
 * city-glow fill read it as green rather than black. */
const PARK_GREENS = [0x2f5a37, 0x3b6a3c, 0x2a5040, 0x46703a] as const;
const FORECOURT_GREEN = 0x3a6a42;
const STREET_GREENS = [0x47763f, 0x3e6c3b] as const;
const SHRUB_GREEN = 0x355f37;
const LAMP_COLOR = 0xffb35c; // the street-lamp head colour family

/** Tree-pit side and depth (a flat soil square around each street trunk), m. */
const PIT_SIDE = 1.4;
const PIT_HEIGHT = 0.06;
/** Lamp pole half-side, head radius, m. */
const POLE_HALF = 0.09;
const HEAD_RADIUS = 0.32;
/** Shrub in a planter: crown radius and height above the soil, m. */
const SHRUB_RADIUS = 0.95;
const SHRUB_HEIGHT = 1.4;

/** Program-cache key for the swaying crown material: three keys programs on
 * onBeforeCompile.toString() by default (see traffic.ts for that bug). */
export const NATURE_CROWN_CACHE_KEY = "ab-nature-crown-sway";

/** One instance's canonical ground position plus its fixed scale/height. */
interface Slot {
  x: number;
  z: number;
  y: number;
  sx: number;
  sy: number;
  sz: number;
}

/** A centred unit-box slot from a NatureBox. */
const boxSlot = (b: NatureBox): Slot => ({
  x: b.x,
  z: b.z,
  y: (b.y0 + b.y1) / 2,
  sx: b.hx * 2,
  sy: b.y1 - b.y0,
  sz: b.hz * 2,
});

/** A unit-sphere slot scaled to a NatureBox's half-extents (the inscribed
 * ellipsoid). */
const ellipsoidSlot = (b: NatureBox): Slot => ({
  x: b.x,
  z: b.z,
  y: (b.y0 + b.y1) / 2,
  sx: b.hx,
  sy: (b.y1 - b.y0) / 2,
  sz: b.hz,
});

/** Stable per-instance pick from a palette (no PRNG needed for a colour). */
const pick = <T>(list: readonly T[], x: number, z: number): T =>
  list[Math.abs(Math.floor(x * 7.31 + z * 3.17)) % list.length] as T;

/** One instanced part: canonical slots + the mesh drawing them. */
class Part {
  readonly mesh: THREE.InstancedMesh;
  private readonly slots: Slot[];
  /** O2: re-image rewrites + uploads only the slots whose image flipped. */
  private readonly images: ImageCache;
  private readonly uploads: InstanceUploads;

  constructor(
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    slots: Slot[],
    colors: number[] | null,
  ) {
    this.slots = slots;
    this.mesh = new THREE.InstancedMesh(
      geometry,
      material,
      Math.max(1, slots.length),
    );
    this.mesh.count = slots.length;
    const m = new THREE.Matrix4();
    const c = new THREE.Color();
    slots.forEach((s, i) => {
      m.makeScale(s.sx, s.sy, s.sz);
      m.setPosition(s.x, s.y, s.z);
      this.mesh.setMatrixAt(i, m);
      if (colors) this.mesh.setColorAt(i, c.setHex(colors[i] ?? 0xffffff));
    });
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // Instances move relative to the camera when they re-image.
    this.mesh.frustumCulled = false;
    this.images = new ImageCache(
      slots.map((s) => s.x),
      slots.map((s) => s.z),
    );
    this.uploads = new InstanceUploads([this.mesh.instanceMatrix]);
  }

  /** Move every instance whose image flipped to its image nearest `cam`
   * (translation only). */
  reimage(cam: Vec3): void {
    this.images.update(cam, this.place);
    this.uploads.flush();
  }

  private readonly place = (i: number, x: number, z: number): void => {
    const a = this.mesh.instanceMatrix.array;
    a[i * 16 + 12] = x;
    a[i * 16 + 14] = z;
    this.uploads.mark(i);
  };
}

export class NatureRenderer {
  readonly group = new THREE.Group();
  private readonly parts: Part[];
  /** Camera position at the last re-image; NaN forces the first one. */
  private readonly lastCam = { x: Number.NaN, z: Number.NaN };
  /** The crown shader's wind uniforms, refreshed per frame in place. */
  private readonly windUniform = { value: new THREE.Vector3() };
  private readonly phaseUniform = { value: new THREE.Vector3() };
  private readonly wind: Wind = { x: 1, z: 0, strength: 0 };
  private readonly phases: SwayPhases = { gust: 0, flutterA: 0, flutterB: 0 };

  constructor(nature: Nature) {
    const solids: Slot[] = [];
    const solidColors: number[] = [];
    const crowns: Slot[] = [];
    const crownColors: number[] = [];
    const heads: Slot[] = [];

    for (const t of nature.trees) {
      const { trunk, canopy } = treeBoxes(t);
      solids.push(boxSlot(trunk));
      solidColors.push(TRUNK_COLOR);
      crowns.push(ellipsoidSlot(canopy));
      crownColors.push(
        t.kind === "park"
          ? pick(PARK_GREENS, t.x, t.z)
          : t.kind === "forecourt"
            ? FORECOURT_GREEN
            : pick(STREET_GREENS, t.x, t.z),
      );
      if (t.kind === "street") {
        // The tree pit: a flat soil square in the pavement.
        solids.push({
          x: t.x,
          z: t.z,
          y: PIT_HEIGHT / 2,
          sx: PIT_SIDE,
          sy: PIT_HEIGHT,
          sz: PIT_SIDE,
        });
        solidColors.push(PIT_COLOR);
      }
    }
    for (const l of nature.lamps) {
      solids.push({
        x: l.x,
        z: l.z,
        y: l.height / 2,
        sx: POLE_HALF * 2,
        sy: l.height,
        sz: POLE_HALF * 2,
      });
      solidColors.push(POLE_COLOR);
      heads.push({
        x: l.x,
        z: l.z,
        y: l.height,
        sx: HEAD_RADIUS,
        sy: HEAD_RADIUS,
        sz: HEAD_RADIUS,
      });
    }
    for (const p of nature.planters) {
      solids.push({
        x: p.x,
        z: p.z,
        y: p.height / 2,
        sx: p.half * 2,
        sy: p.height,
        sz: p.half * 2,
      });
      solidColors.push(PLANTER_COLOR);
      crowns.push({
        x: p.x,
        z: p.z,
        y: p.height + SHRUB_HEIGHT / 2,
        sx: SHRUB_RADIUS,
        sy: SHRUB_HEIGHT / 2,
        sz: SHRUB_RADIUS,
      });
      crownColors.push(SHRUB_GREEN);
    }
    for (const h of nature.hoardings) {
      solids.push({
        x: h.x,
        z: h.z,
        y: h.height / 2,
        sx: h.hx * 2,
        sy: h.height,
        sz: h.hz * 2,
      });
      solidColors.push(pick(HOARDING_COLORS, h.x, h.z));
    }

    const headMaterial = new THREE.MeshBasicMaterial({ color: LAMP_COLOR });
    headMaterial.color.multiplyScalar(
      emissiveBoost(headMaterial.color, EMISSIVE_LAMP),
    );

    const crownMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.9,
      flatShading: true,
    });
    crownMaterial.customProgramCacheKey = () => NATURE_CROWN_CACHE_KEY;
    crownMaterial.onBeforeCompile = (shader) => {
      shader.uniforms[SWAY_UNIFORM_WIND] = this.windUniform;
      shader.uniforms[SWAY_UNIFORM_PHASE] = this.phaseUniform;
      shader.vertexShader = shader.vertexShader
        .replace("void main() {", `${CROWN_SWAY_GLSL}\nvoid main() {`)
        .replace("#include <begin_vertex>", CROWN_BEGIN_VERTEX_GLSL);
    };

    this.parts = [
      new Part(
        new THREE.BoxGeometry(1, 1, 1),
        new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95 }),
        solids,
        solidColors,
      ),
      new Part(
        // Detail 1: 80 faces, every vertex on the unit sphere — so the
        // scaled, swaying crown never leaves its collision ellipsoid.
        new THREE.IcosahedronGeometry(1, 1),
        crownMaterial,
        crowns,
        crownColors,
      ),
      new Part(new THREE.SphereGeometry(1, 8, 6), headMaterial, heads, null),
    ];
    for (const p of this.parts) this.group.add(p.mesh);
  }

  /** Sway the crowns on the synced clock, and re-image when the camera has
   * moved REIMAGE_STEP. Call per frame. A null clock holds the crowns still
   * (zero strength) rather than swaying out of step with other clients. */
  update(cameraPos: Vec3, serverTimeMs: number | null): void {
    if (serverTimeMs === null) {
      this.windUniform.value.set(1, 0, 0);
    } else {
      const w = windAt(serverTimeMs, this.wind);
      const p = swayPhases(serverTimeMs, this.phases);
      this.windUniform.value.set(w.x, w.z, w.strength);
      this.phaseUniform.value.set(p.gust, p.flutterA, p.flutterB);
    }
    // The camera's own render-space travel since the last re-image — raw on
    // purpose: a seam crossing teleports the camera by WORLD_SIZE, and that
    // jump is exactly what must trigger a re-image.
    if (
      Math.abs(cameraPos.x - this.lastCam.x) < REIMAGE_STEP &&
      Math.abs(cameraPos.z - this.lastCam.z) < REIMAGE_STEP
    ) {
      return;
    }
    this.lastCam.x = cameraPos.x;
    this.lastCam.z = cameraPos.z;
    for (const p of this.parts) p.reimage(cameraPos);
  }
}
