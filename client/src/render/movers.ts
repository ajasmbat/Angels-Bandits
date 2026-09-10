// The L2 movers, rendered: slewing tower cranes, helicopters, a blimp.
//
// Every pose comes from common/src/city/movers.ts — the SAME pure function of
// (seed, server time) the collision path uses, so what you see is what you can
// hit. This file never derives a pose of its own; it only turns MoverBoxes
// into matrices. That is the whole reason there are no invisible walls here.
//
// Three draw calls, and the merges that hold them there:
//   1. `rig`      — one InstancedMesh of boxes for every crane's lattice AND
//                   the aircraft's hard parts: tail booms, fins, skids, the
//                   blimp's gondola and tail fins. Same steel, same mesh.
//   2. `hulls`    — one InstancedMesh of ellipsoids for helicopter cabins
//                   AND the blimp envelope (same shape at different scales).
//                   The blimp's lit ad banner and the cabins' window glow are
//                   emissive patches inside that material, flagged per
//                   instance, not a fourth mesh.
//   3. `rotors`   — one InstancedMesh of blurred discs: main AND tail rotors.
// The nav/warning lights are NOT here: they go into the shared additive point
// cloud below, which fireworks also write into. Merging those two is what
// keeps the whole L2 spectacle inside its six-draw-call budget. The
// helicopters' belly spots are not here either — they are handed to the
// Searchlights mesh each frame (`spots`), which already draws cones.
//
// Every detail part stays INSIDE its aircraft's collision box: a fin or a
// skid you can see is something you would hit anyway. Only the rotor blurs
// sit outside, and a blur is not something that looks solid.
//
// Hidden — and, at main.ts's crash check, non-solid — until the server clock
// estimate exists. A mover you cannot see must never be able to kill you.

import {
  type MoverBox,
  type MoverField,
  aircraftBox,
  craneBoxes,
} from "@angels-bandits/common/city/movers";
import {
  EMISSIVE_BEACON,
  EMISSIVE_NAVLIGHT,
  EMISSIVE_SIGN,
  EMISSIVE_STROBE,
  EMISSIVE_WINDOW,
} from "@angels-bandits/common/constants";
import type { Vec3 } from "@angels-bandits/common/world";
import * as THREE from "three";
import { emissiveBoost } from "./emissive";
import type { SpotBeam } from "./searchlights";
import { nearestImage } from "./wrapPlacement";

// --- Shared additive point cloud (nav lights, warning beacons, sparks) ---

/** Lights the movers themselves need, plus headroom for a firework show:
 * 3 cranes x 3 + 4 helis x 5 + blimp x 8 = 37, the searchlight heads (10
 * rooftops + 4 spots), and FIREWORK_BURSTS x FIREWORK_SPARKS = 240. Fixed
 * cap, never grown. */
const LIGHT_CAPACITY = 400;

/**
 * Program cache keys for the two patched materials here.
 *
 * Three keys its program cache on onBeforeCompile.toString() by default, and
 * both of these patches are TEXTUALLY identical to ones elsewhere in the repo
 * (the aSize splice matches planelights', the emissive splice matches
 * traffic's), so without explicit keys they would silently share a compiled
 * program and draw the wrong thing. Exported so a test can pin that they are
 * distinct from every other key in the repo — see traffic.ts for the bug.
 */
export const MOVER_LIGHTS_CACHE_KEY = "ab-mover-lights";
export const MOVER_HULL_CACHE_KEY = "ab-mover-hull";

/** Soft round glow, procedural like every other sprite in the repo. */
function glowTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d");
  if (!g) return new THREE.Texture();
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.2, "rgba(255,255,255,0.85)");
  grad.addColorStop(0.5, "rgba(255,255,255,0.22)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

/**
 * One additive Points object shared by every L2 light source — crane warning
 * beacons, aircraft nav lights and firework sparks. Same begin/place/commit
 * frame protocol as PlaneLights, for the same reason: one draw call for a
 * variable number of points.
 */
export class MoverLights {
  readonly points: THREE.Points;
  private readonly positions = new Float32Array(LIGHT_CAPACITY * 3);
  private readonly colors = new Float32Array(LIGHT_CAPACITY * 3);
  private readonly sizes = new Float32Array(LIGHT_CAPACITY);
  private readonly geometry = new THREE.BufferGeometry();
  private count = 0;

  constructor() {
    this.geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(this.positions, 3),
    );
    this.geometry.setAttribute(
      "color",
      new THREE.BufferAttribute(this.colors, 3),
    );
    this.geometry.setAttribute(
      "aSize",
      new THREE.BufferAttribute(this.sizes, 1),
    );
    this.geometry.boundingSphere = new THREE.Sphere(
      new THREE.Vector3(),
      Number.POSITIVE_INFINITY,
    );

    const material = new THREE.PointsMaterial({
      size: 1, // per-point meters via aSize, patched below
      sizeAttenuation: true,
      map: glowTexture(),
      vertexColors: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      // Additive + fog brightens the distant scene (the V1 lesson).
      fog: false,
    });
    // Its own cache key: three keys programs on onBeforeCompile.toString(),
    // and this patch is textually identical to planelights' (see traffic.ts).
    material.customProgramCacheKey = () => MOVER_LIGHTS_CACHE_KEY;
    material.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace(
          "uniform float size;",
          "uniform float size;\nattribute float aSize;",
        )
        .replace("gl_PointSize = size;", "gl_PointSize = size * aSize;");
    };
    this.points = new THREE.Points(this.geometry, material);
    this.points.frustumCulled = false;
  }

  /** Start a frame: forget last frame's points. */
  begin(): void {
    this.count = 0;
  }

  /** Append one light. `rendered` must already be nearest-image placed. */
  place(rendered: Vec3, color: THREE.Color, size: number): void {
    if (this.count >= LIGHT_CAPACITY) return;
    const i = this.count++;
    this.positions[i * 3] = rendered.x;
    this.positions[i * 3 + 1] = rendered.y;
    this.positions[i * 3 + 2] = rendered.z;
    this.colors[i * 3] = color.r;
    this.colors[i * 3 + 1] = color.g;
    this.colors[i * 3 + 2] = color.b;
    this.sizes[i] = size;
  }

  /** Upload the frame. */
  commit(): void {
    this.geometry.setDrawRange(0, this.count);
    for (const name of ["position", "color", "aSize"]) {
      const attr = this.geometry.getAttribute(name);
      if (attr) attr.needsUpdate = true;
    }
  }

  /** Points written this frame — the perf report's handle on the budget. */
  get lightCount(): number {
    return this.count;
  }
}

// --- Renderer (consumes the pure model in common/; untested, like Traffic) ---

/** Crane steelwork: dark, warm, industrial. Bloom only touches the lights. */
const STEEL_COLOR = 0x33302c;
/** Aircraft hulls: cool gunmetal with enough sheen that the low dusk key
 * catches the flank, so a hull reads as a shape and not only as its lights. */
const HULL_COLOR = 0x3b414e;

/** Aviation warning red, at the beacon rung's pulse peak. */
const WARNING_RED = new THREE.Color(1.0, 0.11, 0.09);
const WARNING_BOOST = emissiveBoost(WARNING_RED, EMISSIVE_BEACON);
/** Warning beacon period, ms — slower than a plane strobe so the two read
 * as different classes of object at distance. */
const WARNING_PERIOD_MS = 2600;
/** Helicopter anti-collision strobe: a red double-flash, ms. */
const HELI_STROBE_PERIOD_MS = 1500;
const HELI_STROBE_FLASH_MS = 80;
const HELI_STROBE_OFFSETS = [0, 220] as const;

/** Aircraft navigation lights: the steady red/green/white every aircraft in
 * the game already wears, at the same rung. */
const NAV_RED = new THREE.Color(1.0, 0.12, 0.1);
const NAV_GREEN = new THREE.Color(0.15, 1.0, 0.3);
const NAV_WHITE = new THREE.Color(1.0, 1.0, 1.0);
const navRedBoost = NAV_RED.clone().multiplyScalar(
  emissiveBoost(NAV_RED, EMISSIVE_NAVLIGHT),
);
const navGreenBoost = NAV_GREEN.clone().multiplyScalar(
  emissiveBoost(NAV_GREEN, EMISSIVE_NAVLIGHT),
);
const navWhiteBoost = NAV_WHITE.clone().multiplyScalar(
  emissiveBoost(NAV_WHITE, EMISSIVE_NAVLIGHT),
);

/** The blimp banner's colour at its pulse peak — the SIGN rung, so a flying
 * billboard is exactly as bright as the ones on the buildings and no brighter. */
const BANNER_COLOR = new THREE.Color(1.0, 0.42, 0.72);
const BANNER_BOOST = emissiveBoost(BANNER_COLOR, EMISSIVE_SIGN);
/** A second band under the banner in the complementary neon — same rung. */
const BANNER_COLOR_2 = new THREE.Color(0.35, 0.85, 1.0);
const BANNER_BOOST_2 = emissiveBoost(BANNER_COLOR_2, EMISSIVE_SIGN);
/** Helicopter cabin glass: warm cockpit light at the WINDOW rung. */
const CABIN_COLOR = new THREE.Color(1.0, 0.78, 0.5);
const CABIN_BOOST = emissiveBoost(CABIN_COLOR, EMISSIVE_WINDOW);
/** Gondola window strip lights, warm, in the point cloud. */
const GONDOLA_WARM = new THREE.Color(1.0, 0.8, 0.55);
const gondolaBoost = GONDOLA_WARM.clone().multiplyScalar(
  emissiveBoost(GONDOLA_WARM, EMISSIVE_NAVLIGHT),
);
const strobeRedBoost = NAV_RED.clone().multiplyScalar(
  emissiveBoost(NAV_RED, EMISSIVE_STROBE),
);

/** Lattice legs per mast, and how many horizontal ties up its height. */
const MAST_LEGS = 4;
const MAST_TIES = 7;
/** Ties along a jib, plus the cab and the counterweight. */
const JIB_TIES = 5;
/** Boxes one crane contributes to the rig mesh: the mast lattice, the jib
 * chord and its ties, then the counter-jib, counterweight, cab, cable and
 * hook. Must match exactly what update() writes — a short count would silently
 * drop the LAST parts written, which are the hook and cable. */
const BOXES_PER_CRANE = MAST_LEGS + MAST_TIES + 1 + JIB_TIES + 5;
/** Boxes one helicopter adds to the rig: tail boom, fin, two skids, rotor
 * mast. One blimp: gondola and four tail fins. Same "must match what
 * update() writes" rule as the crane count. */
const BOXES_PER_HELI = 5;
const BOXES_PER_BLIMP = 5;
/** Rotor discs per helicopter: the main blur and the tail rotor. */
const ROTORS_PER_HELI = 2;

const BANNER_PARS = /* glsl */ `
varying vec3 vHullPos;
varying float vBanner;
`;

const BANNER_VERTEX = /* glsl */ `
// The hull is a unit sphere scaled per instance, so object space is [-0.5, 0.5]
// along every axis regardless of how big the aircraft is.
vHullPos = position;
vBanner = aBanner;
`;

const BANNER_FRAGMENT = /* glsl */ `
// aBanner flags the hull's role: 1 = blimp envelope, 2 = helicopter cabin.
if (vBanner > 1.5) {
  // Cockpit glass: a warm band across the front third of the cabin, on the
  // flanks and the nose, cut off below the belt line.
  float front = smoothstep(0.02, 0.18, vHullPos.x);
  float belt = 1.0 - smoothstep(0.02, 0.16, abs(vHullPos.y - 0.06));
  float glass = front * belt;
  totalEmissiveRadiance += glass * ${CABIN_BOOST.toFixed(4)} *
    vec3(${CABIN_COLOR.r.toFixed(4)}, ${CABIN_COLOR.g.toFixed(4)}, ${CABIN_COLOR.b.toFixed(4)});
} else if (vBanner > 0.5) {
  // The blimp's lit ad banner: two bright horizontal bands down the flank,
  // faded at the nose and tail so they read as panels rather than paint.
  float ends = 1.0 - smoothstep(0.24, 0.46, abs(vHullPos.x));
  float upper = 1.0 - smoothstep(0.05, 0.13, abs(vHullPos.y - 0.09));
  float lower = 1.0 - smoothstep(0.03, 0.09, abs(vHullPos.y + 0.09));
  totalEmissiveRadiance += upper * ends * ${BANNER_BOOST.toFixed(4)} *
    vec3(${BANNER_COLOR.r.toFixed(4)}, ${BANNER_COLOR.g.toFixed(4)}, ${BANNER_COLOR.b.toFixed(4)});
  totalEmissiveRadiance += lower * ends * ${BANNER_BOOST_2.toFixed(4)} *
    vec3(${BANNER_COLOR_2.r.toFixed(4)}, ${BANNER_COLOR_2.g.toFixed(4)}, ${BANNER_COLOR_2.b.toFixed(4)});
}
`;

/** Hull material with the per-instance emissive patches (banner, cabin
 * glass) patched in. Flagged by an `aBanner` instanced attribute, the same
 * idiom signage uses for `aTile` — an attribute rather than instanceColor,
 * because instanceColor would also multiply the diffuse hull and turn the
 * whole envelope pink. */
function createHullMaterial(): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    color: HULL_COLOR,
    roughness: 0.5,
    metalness: 0.45,
  });
  material.customProgramCacheKey = () => MOVER_HULL_CACHE_KEY;
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>\nattribute float aBanner;\n${BANNER_PARS}`,
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>\n${BANNER_VERTEX}`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${BANNER_PARS}`)
      .replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>\n${BANNER_FRAGMENT}`,
      );
  };
  return material;
}

/**
 * The mover renderer. Three meshes, all instanced, all posed from the shared
 * seam every frame at the torus image nearest the camera.
 */
export class Movers {
  readonly rig: THREE.InstancedMesh;
  readonly hulls: THREE.InstancedMesh;
  readonly rotors: THREE.InstancedMesh;

  private readonly field: MoverField;
  private readonly matrix = new THREE.Matrix4();
  private readonly quat = new THREE.Quaternion();
  private readonly tilt = new THREE.Quaternion();
  private readonly pos = new THREE.Vector3();
  private readonly scale = new THREE.Vector3();
  private static readonly UP = new THREE.Vector3(0, 1, 0);
  private static readonly FORWARD = new THREE.Vector3(1, 0, 0);

  constructor(field: MoverField) {
    this.field = field;

    const helis = field.aircraft.filter((a) => a.kind === "helicopter").length;
    const box = new THREE.BoxGeometry(1, 1, 1);
    this.rig = new THREE.InstancedMesh(
      box,
      new THREE.MeshStandardMaterial({
        color: STEEL_COLOR,
        roughness: 0.85,
        metalness: 0.5,
      }),
      Math.max(1, this.rigInstances),
    );

    // One ellipsoid serves both aircraft: a 20 m helicopter cabin and a 92 m
    // blimp envelope are the same shape at different scales, which is what
    // lets them share an InstancedMesh (and so one draw call).
    const hull = new THREE.SphereGeometry(0.5, 14, 10);
    const aircraft = Math.max(1, field.aircraft.length);
    this.hulls = new THREE.InstancedMesh(hull, createHullMaterial(), aircraft);
    const banner = new Float32Array(aircraft);
    for (let i = 0; i < field.aircraft.length; i++) {
      banner[i] = field.aircraft[i]?.kind === "blimp" ? 1 : 2;
    }
    hull.setAttribute("aBanner", new THREE.InstancedBufferAttribute(banner, 1));

    const disc = new THREE.CircleGeometry(0.5, 20).rotateX(-Math.PI / 2);
    this.rotors = new THREE.InstancedMesh(
      disc,
      new THREE.MeshBasicMaterial({
        color: 0x9aa0ac,
        transparent: true,
        opacity: 0.14,
        depthWrite: false,
        side: THREE.DoubleSide,
        fog: false,
      }),
      Math.max(1, helis * ROTORS_PER_HELI),
    );

    for (const mesh of [this.rig, this.hulls, this.rotors]) {
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      // Instances move relative to the camera every frame.
      mesh.frustumCulled = false;
      // Until the first server clock estimate: see the header note.
      mesh.visible = false;
    }
  }

  /** Instances the rig actually draws — for the perf report. */
  get rigInstances(): number {
    let n = this.field.cranes.length * BOXES_PER_CRANE;
    for (const a of this.field.aircraft) {
      n += a.kind === "helicopter" ? BOXES_PER_HELI : BOXES_PER_BLIMP;
    }
    return n;
  }

  /**
   * The helicopters' belly spots for the frame just posed by update(),
   * nearest-image placed. Read AFTER update(); the Searchlights mesh draws
   * them so the beam cone stays a single draw call for the whole city.
   */
  readonly spots: SpotBeam[] = [];

  /**
   * Pose every mover for this frame.
   *
   * `serverTimeMs` is the LATCHED render clock from main.ts — the same value
   * the crash check uses, so the jib you fly into is the jib you can see. A
   * null clock hides everything (and main.ts skips the mover crash test), so
   * a mover can never be an invisible killer during the first few frames.
   */
  update(
    cameraPos: Vec3,
    serverTimeMs: number | null,
    lights: MoverLights,
  ): void {
    if (serverTimeMs === null) {
      for (const mesh of [this.rig, this.hulls, this.rotors]) {
        mesh.visible = false;
      }
      return;
    }
    for (const mesh of [this.rig, this.hulls, this.rotors]) {
      mesh.visible = true;
    }

    let rigIndex = 0;
    const put = (
      box: { x: number; y: number; z: number; yaw: number },
      sx: number,
      sy: number,
      sz: number,
      cameraAt: Vec3,
    ): void => {
      if (rigIndex >= this.rig.count) return;
      const p = nearestImage(cameraAt, { x: box.x, y: box.y, z: box.z });
      this.pos.set(p.x, p.y, p.z);
      this.quat.setFromAxisAngle(Movers.UP, box.yaw);
      this.scale.set(sx, sy, sz);
      this.matrix.compose(this.pos, this.quat, this.scale);
      this.rig.setMatrixAt(rigIndex++, this.matrix);
    };

    for (const site of this.field.cranes) {
      const parts = craneBoxes(site, serverTimeMs);
      const byKind = new Map(parts.map((p) => [p.kind, p]));
      const mast = byKind.get("mast");
      const jib = byKind.get("jib");
      const counter = byKind.get("counterJib");
      const cable = byKind.get("cable");
      const hook = byKind.get("hook");
      if (!mast || !jib || !counter || !cable || !hook) continue;

      // Mast as four corner legs plus horizontal ties: a lattice at close
      // range, a solid column through fog — and its convex hull is exactly the
      // collision box, so it never reads thinner than it hits.
      const legOff = mast.hx * 0.8;
      const legSide = mast.hx * 0.55;
      for (let i = 0; i < MAST_LEGS; i++) {
        const sx = i < 2 ? -legOff : legOff;
        const sz = i % 2 === 0 ? -legOff : legOff;
        put(
          { x: mast.x + sx, y: mast.y, z: mast.z + sz, yaw: 0 },
          legSide,
          mast.hy * 2,
          legSide,
          cameraPos,
        );
      }
      for (let i = 0; i < MAST_TIES; i++) {
        const y = ((i + 0.5) / MAST_TIES) * mast.hy * 2;
        put(
          { x: mast.x, y, z: mast.z, yaw: 0 },
          mast.hx * 2,
          legSide * 0.5,
          mast.hx * 2,
          cameraPos,
        );
      }

      // Jib: the collision box itself, plus ties riding inside its footprint.
      put(jib, jib.hx * 2, jib.hy * 2, jib.hz * 2, cameraPos);
      const ax = Math.cos(jib.yaw);
      const az = -Math.sin(jib.yaw);
      for (let i = 0; i < JIB_TIES; i++) {
        const s = ((i + 0.5) / JIB_TIES) * site.jibLength;
        put(
          {
            x: site.x + ax * s,
            y: site.hubY + jib.hy * 1.6,
            z: site.z + az * s,
            yaw: jib.yaw,
          },
          jib.hz * 0.6,
          jib.hy * 1.6,
          jib.hz * 0.6,
          cameraPos,
        );
      }

      put(counter, counter.hx * 2, counter.hy * 2, counter.hz * 2, cameraPos);
      // Counterweight slab at the short end, and the operator's cab at the hub.
      put(
        {
          x: site.x - ax * site.counterLength,
          y: site.hubY,
          z: site.z - az * site.counterLength,
          yaw: jib.yaw,
        },
        counter.hz * 2.2,
        counter.hy * 3,
        counter.hz * 3,
        cameraPos,
      );
      put(
        { x: site.x, y: site.hubY - jib.hy * 2, z: site.z, yaw: jib.yaw },
        jib.hz * 2.4,
        jib.hy * 3,
        jib.hz * 2.4,
        cameraPos,
      );
      // Always written, even when a tight site left no room for a hook drop:
      // a skipped put would leave last frame's matrix in that slot.
      put(cable, cable.hx * 2, cable.hy * 2, cable.hz * 2, cameraPos);
      put(hook, hook.hx * 2, hook.hy * 2, hook.hz * 2, cameraPos);

      // Aviation warning lights: the jib tip, the counter-jib end and the hub.
      // Pulsed exactly like the landmark roof beacons — peak AT the rung, the
      // trough under the bloom threshold, on the shared server clock so every
      // client sees the same blink.
      const pulse =
        0.22 +
        0.78 *
          (0.5 +
            0.5 * Math.sin((serverTimeMs / WARNING_PERIOD_MS) * Math.PI * 2));
      const warn = WARNING_RED.clone().multiplyScalar(WARNING_BOOST * pulse);
      const tip = nearestImage(cameraPos, {
        x: site.x + ax * site.jibLength,
        y: site.hubY,
        z: site.z + az * site.jibLength,
      });
      lights.place(tip, warn, 3.2);
      const tail = nearestImage(cameraPos, {
        x: site.x - ax * site.counterLength,
        y: site.hubY,
        z: site.z - az * site.counterLength,
      });
      lights.place(tail, warn, 2.6);
      lights.place(
        nearestImage(cameraPos, { x: site.x, y: site.hubY, z: site.z }),
        warn,
        2.6,
      );
    }
    let rotorIndex = 0;
    this.spots.length = 0;
    const strobeT = serverTimeMs % HELI_STROBE_PERIOD_MS;
    for (let i = 0; i < this.field.aircraft.length; i++) {
      const route = this.field.aircraft[i];
      if (!route) continue;
      const box: MoverBox = aircraftBox(route, serverTimeMs);
      const p = nearestImage(cameraPos, { x: box.x, y: box.y, z: box.z });
      const ax = Math.cos(box.yaw);
      const az = -Math.sin(box.yaw);
      // Helper: a point at (along, up, across) in the aircraft's own frame.
      const at = (along: number, up: number, across: number): Vec3 => ({
        x: p.x + ax * along - az * across,
        y: p.y + up,
        z: p.z + az * along + ax * across,
      });

      if (route.kind === "helicopter") {
        // Cabin: the front 58 % of the box, full height and width — so the
        // tail boom has somewhere to go and the whole thing reads as an
        // aircraft rather than an egg.
        const cabinHalf = box.hx * 0.575;
        const cabin = at(box.hx - cabinHalf, 0, 0);
        this.pos.set(cabin.x, cabin.y, cabin.z);
        this.quat.setFromAxisAngle(Movers.UP, box.yaw);
        this.scale.set(cabinHalf * 2, box.hy * 2, box.hz * 2);
        this.matrix.compose(this.pos, this.quat, this.scale);
        this.hulls.setMatrixAt(i, this.matrix);

        // Tail boom from the cabin back to the end of the box, tapering by
        // being thinner than the cabin; a fin at its end; two skids under
        // the cabin; a rotor mast on top. All inside the collision box.
        const boomLen = box.hx * 0.95;
        const boom = at(-box.hx + boomLen / 2, box.hy * 0.15, 0);
        put(
          { ...boom, yaw: box.yaw },
          boomLen,
          box.hy * 0.55,
          box.hz * 0.5,
          cameraPos,
        );
        const fin = at(-box.hx * 0.9, box.hy * 0.3, 0);
        put(
          { ...fin, yaw: box.yaw },
          box.hx * 0.16,
          box.hy * 1.4,
          box.hz * 0.16,
          cameraPos,
        );
        for (const side of [-1, 1]) {
          const skid = at(box.hx * 0.35, -box.hy * 0.85, side * box.hz * 0.7);
          put(
            { ...skid, yaw: box.yaw },
            box.hx * 1.1,
            box.hy * 0.14,
            box.hz * 0.16,
            cameraPos,
          );
        }
        const mast = at(box.hx * 0.35, box.hy * 0.95, 0);
        put(
          { ...mast, yaw: box.yaw },
          box.hx * 0.14,
          box.hy * 0.5,
          box.hz * 0.3,
          cameraPos,
        );

        // Main rotor blur over the cabin, spun fast enough to be a disc.
        const hub = at(box.hx * 0.35, box.hy * 1.2, 0);
        this.pos.set(hub.x, hub.y, hub.z);
        this.quat.setFromAxisAngle(Movers.UP, serverTimeMs * 0.02);
        const span = box.hx * 2.4;
        this.scale.set(span, 1, span);
        this.matrix.compose(this.pos, this.quat, this.scale);
        this.rotors.setMatrixAt(rotorIndex++, this.matrix);
        // Tail rotor: a small vertical disc on the fin's flank.
        const tailHub = at(-box.hx * 0.9, box.hy * 0.55, box.hz * 0.3);
        this.pos.set(tailHub.x, tailHub.y, tailHub.z);
        this.quat.setFromAxisAngle(Movers.UP, box.yaw);
        this.tilt.setFromAxisAngle(Movers.FORWARD, Math.PI / 2);
        this.quat.multiply(this.tilt);
        const tailSpan = box.hy * 1.1;
        this.scale.set(tailSpan, 1, tailSpan);
        this.matrix.compose(this.pos, this.quat, this.scale);
        this.rotors.setMatrixAt(rotorIndex++, this.matrix);

        // Port red, starboard green, tail white — the aircraft convention —
        // plus a red anti-collision strobe on the spine and the belly lamp
        // whose beam the Searchlights mesh draws.
        lights.place(
          at(box.hx * 0.3, -box.hy * 0.2, -box.hz),
          navRedBoost,
          2.2,
        );
        lights.place(
          at(box.hx * 0.3, -box.hy * 0.2, box.hz),
          navGreenBoost,
          2.2,
        );
        lights.place(at(-box.hx * 0.92, box.hy * 0.95, 0), navWhiteBoost, 1.8);
        for (const off of HELI_STROBE_OFFSETS) {
          const phase = (strobeT + route.id * 370) % HELI_STROBE_PERIOD_MS;
          if (phase >= off && phase < off + HELI_STROBE_FLASH_MS) {
            lights.place(
              at(box.hx * 0.35, box.hy * 1.25, 0),
              strobeRedBoost,
              4.5,
            );
            break;
          }
        }
        const lamp = at(box.hx * 0.7, -box.hy * 0.9, 0);
        this.spots.push({
          x: lamp.x,
          y: lamp.y,
          z: lamp.z,
          ax,
          az,
          phase: route.id * 1.7,
        });
      } else {
        // Envelope: the full box length, a little shy of the box vertically
        // so the gondola hangs UNDER it and still inside the box.
        this.pos.set(p.x, p.y + box.hy * 0.1, p.z);
        this.quat.setFromAxisAngle(Movers.UP, box.yaw);
        this.scale.set(box.hx * 2, box.hy * 1.6, box.hz * 1.8);
        this.matrix.compose(this.pos, this.quat, this.scale);
        this.hulls.setMatrixAt(i, this.matrix);

        // Gondola slung under the belly, forward of centre.
        const gondola = at(box.hx * 0.12, -box.hy * 0.8, 0);
        put(
          { ...gondola, yaw: box.yaw },
          box.hx * 0.42,
          box.hy * 0.3,
          box.hz * 0.4,
          cameraPos,
        );
        // Four tail fins in a cross where the envelope tapers, reaching out
        // to — never past — the box's own half-extents.
        const finAlong = -box.hx * 0.72;
        for (const [up, across] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const) {
          const fin = at(finAlong, up * box.hy * 0.76, across * box.hz * 0.78);
          put(
            { ...fin, yaw: box.yaw },
            box.hx * 0.36,
            up === 0 ? box.hy * 0.08 : box.hy * 0.48,
            up === 0 ? box.hz * 0.44 : box.hz * 0.08,
            cameraPos,
          );
        }

        // Nose white, tail red, a beacon on the spine, and a warm strip of
        // gondola windows — a lit ship, not a dark balloon.
        lights.place(at(box.hx, 0, 0), navWhiteBoost, 3.2);
        lights.place(at(-box.hx, 0, 0), navRedBoost, 3.2);
        lights.place(at(-box.hx * 0.88, box.hy * 0.5, 0), navWhiteBoost, 2.2);
        lights.place(at(0, box.hy * 0.9, 0), navRedBoost, 2.6);
        for (const k of [-1, 0, 1]) {
          lights.place(
            at(box.hx * 0.12 + k * box.hx * 0.14, -box.hy * 0.8, box.hz * 0.42),
            gondolaBoost,
            1.6,
          );
        }
        lights.place(at(box.hx * 0.12, -box.hy * 0.97, 0), navWhiteBoost, 2.4);
      }
    }
    this.rig.instanceMatrix.needsUpdate = true;
    this.hulls.instanceMatrix.needsUpdate = true;
    this.rotors.instanceMatrix.needsUpdate = true;
  }

  /**
   * QA read-back: the pure pose AND the position actually written into the
   * instance matrix, so a two-tab comparison reads the rendered truth rather
   * than a re-derivation of it. Pass an explicit server time so both tabs
   * sample the same instant (their render clocks differ by the interp delay).
   */
  debug(serverTimeMs: number | null): {
    time: number;
    cranes: { id: number; yaw: number; tip: Vec3 }[];
    aircraft: { id: number; kind: string; x: number; y: number; z: number }[];
    drawnAt: Vec3;
    visible: boolean;
  } | null {
    if (serverTimeMs === null) return null;
    const cranes = this.field.cranes.map((site) => {
      const parts = craneBoxes(site, serverTimeMs);
      const jib = parts.find((p) => p.kind === "jib");
      const yaw = jib?.yaw ?? 0;
      return {
        id: site.id,
        yaw,
        tip: {
          x: site.x + Math.cos(yaw) * site.jibLength,
          y: site.hubY,
          z: site.z - Math.sin(yaw) * site.jibLength,
        },
      };
    });
    const aircraft = this.field.aircraft.map((route) => {
      const b = aircraftBox(route, serverTimeMs);
      return { id: route.id, kind: route.kind, x: b.x, y: b.y, z: b.z };
    });
    this.rig.getMatrixAt(0, this.matrix);
    const e = this.matrix.elements;
    return {
      time: serverTimeMs,
      cranes,
      aircraft,
      drawnAt: { x: e[12] ?? 0, y: e[13] ?? 0, z: e[14] ?? 0 },
      visible: this.rig.visible,
    };
  }
}
