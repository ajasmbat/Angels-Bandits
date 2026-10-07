// Plaza fountains (L9): lit spray thrown up from the middle of every park
// pond (nature.ponds, the same seam the ground shader paints the ponds from).
// Spray is light and water — the accepted no-collision exception — so this is
// purely a renderer.
//
// Every particle is a pure ballistic function of (pond, particle index,
// synced server clock): a tall central jet plus a ring of jets arcing in
// toward it, each particle staggered through its jet's flight time. All
// clients see the same spray, late joiners included, with nothing streamed.
//
// DRAW-CALL BUDGET: one additive Points, drawing ONLY the pond nearest the
// camera within FOUNTAIN_RANGE. The plaza ponds sit ≥ ~848 m apart on the
// torus, so at most one is ever in range: +1 draw call over a park, 0
// anywhere else (the Points is hidden). Not MoverLights: its fixed point cap
// is shared with firework bursts, which would silently eat the spray.
//
// Brightness sits on the WINDOW rung: spray only catches the park lamps'
// light, so it must read dimmer than the lamp heads it is lit by — and it
// stays far under TRACER.

import type { Pond } from "@angels-bandits/common/city/nature";
import { EMISSIVE_WINDOW } from "@angels-bandits/common/constants";
import { type Vec3, wrapDeltaAxis } from "@angels-bandits/common/world";
import * as THREE from "three";
import { emissiveBoost } from "./emissive";

/** Draw a pond's spray only within this distance of the camera, m. */
const FOUNTAIN_RANGE = 350;
const GRAVITY = 9.8;

/** The central jet: particles, launch speed (apex ≈ v²/2g ≈ 8.6 m) and the
 * sideways scatter that gives the column its body, m/s. */
const CENTRAL_COUNT = 48;
const CENTRAL_VY = 13;
const CENTRAL_SPREAD = 0.55;
/** The ring: jets on a circle around the central one, arcing inward. */
const RING_JETS = 8;
const RING_PER_JET = 9;
const RING_RADIUS = 7;
const RING_VY = 7;
const RING_INWARD = 2.2;
/** Jets rise from just above the water, m. */
const NOZZLE_Y = 0.4;

export const FOUNTAIN_PARTICLES = CENTRAL_COUNT + RING_JETS * RING_PER_JET;

/** Pale, slightly cool spray — water lit by sodium lamps from the side. */
const SPRAY_COLOR = new THREE.Color(0xdcecff);
const SPRAY_BOOST = emissiveBoost(SPRAY_COLOR, EMISSIVE_WINDOW);

/** A deterministic 0..1 value per particle (no PRNG for a fixed table). */
const hash01 = (i: number, salt: number): number =>
  ((i * 7919 + salt * 104729) % 997) / 997;

/** One particle's launch: nozzle offset from the pond centre, velocity,
 * flight time and its stagger through that flight. */
interface Jet {
  ox: number;
  oz: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  stagger: number;
  size: number;
}

/** The fixed particle table every pond shares. */
function jetTable(): Jet[] {
  const out: Jet[] = [];
  // Flight time until the particle falls back to the water (y = 0).
  const flight = (vy: number) =>
    (vy + Math.sqrt(vy * vy + 2 * GRAVITY * NOZZLE_Y)) / GRAVITY;
  for (let i = 0; i < CENTRAL_COUNT; i++) {
    const a = hash01(i, 1) * Math.PI * 2;
    const s = CENTRAL_SPREAD * hash01(i, 2);
    const vy = CENTRAL_VY * (0.88 + 0.12 * hash01(i, 3));
    out.push({
      ox: 0,
      oz: 0,
      vx: Math.cos(a) * s,
      vy,
      vz: Math.sin(a) * s,
      life: flight(vy),
      stagger: (i + hash01(i, 4)) / CENTRAL_COUNT,
      size: 0.45 + 0.25 * hash01(i, 5),
    });
  }
  for (let j = 0; j < RING_JETS; j++) {
    const a = (j / RING_JETS) * Math.PI * 2;
    const cx = Math.cos(a);
    const cz = Math.sin(a);
    for (let k = 0; k < RING_PER_JET; k++) {
      const i = CENTRAL_COUNT + j * RING_PER_JET + k;
      const vy = RING_VY * (0.92 + 0.08 * hash01(i, 3));
      out.push({
        ox: cx * RING_RADIUS,
        oz: cz * RING_RADIUS,
        vx: -cx * RING_INWARD,
        vy,
        vz: -cz * RING_INWARD,
        life: flight(vy),
        stagger: (k + hash01(i, 4)) / RING_PER_JET,
        size: 0.35 + 0.2 * hash01(i, 5),
      });
    }
  }
  return out;
}

/**
 * A particle's offset from its pond centre at `serverMs`, plus its
 * brightness (0..1: it fades in off the nozzle and out as it falls back).
 * Pure: the same (jet, time) gives the same spray on every client.
 */
function sprayAt(
  jet: Jet,
  serverMs: number,
  out: { x: number; y: number; z: number; glow: number },
): void {
  const cycle = serverMs / 1000 / jet.life + jet.stagger;
  const u = cycle - Math.floor(cycle); // 0..1 through the flight
  const t = u * jet.life;
  out.x = jet.ox + jet.vx * t;
  out.y = NOZZLE_Y + jet.vy * t - 0.5 * GRAVITY * t * t;
  out.z = jet.oz + jet.vz * t;
  out.glow = Math.min(1, u * 8) * Math.min(1, (1 - u) * 4);
}

/** Soft round droplet, procedural like every other sprite in the repo. */
function sprayTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 32;
  const g = c.getContext("2d");
  if (!g) return new THREE.Texture();
  const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.35, "rgba(255,255,255,0.6)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 32, 32);
  return new THREE.CanvasTexture(c);
}

/** Program-cache key: the aSize splice below is textually shared. */
export const FOUNTAIN_CACHE_KEY = "ab-fountain-spray";

export class Fountains {
  readonly points: THREE.Points;
  private readonly ponds: readonly Pond[];
  private readonly jets = jetTable();
  private readonly positions = new Float32Array(FOUNTAIN_PARTICLES * 3);
  private readonly colors = new Float32Array(FOUNTAIN_PARTICLES * 3);
  private readonly sizes = new Float32Array(FOUNTAIN_PARTICLES);
  private readonly geometry = new THREE.BufferGeometry();
  private readonly p = { x: 0, y: 0, z: 0, glow: 0 };

  constructor(ponds: readonly Pond[]) {
    this.ponds = ponds;
    this.geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(this.positions, 3),
    );
    this.geometry.setAttribute(
      "color",
      new THREE.BufferAttribute(this.colors, 3),
    );
    this.jets.forEach((j, i) => {
      this.sizes[i] = j.size;
    });
    this.geometry.setAttribute(
      "aSize",
      new THREE.BufferAttribute(this.sizes, 1),
    );
    this.geometry.boundingSphere = new THREE.Sphere(
      new THREE.Vector3(),
      Number.POSITIVE_INFINITY,
    );
    const material = new THREE.PointsMaterial({
      size: 1, // per-point metres via aSize
      sizeAttenuation: true,
      map: sprayTexture(),
      vertexColors: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      // Additive + fog brightens the distant scene (the V1 lesson).
      fog: false,
    });
    material.customProgramCacheKey = () => FOUNTAIN_CACHE_KEY;
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
    this.points.visible = false;
  }

  /** Throw the spray of the pond in range, if any. A null clock hides it. */
  update(cameraPos: Vec3, serverTimeMs: number | null): void {
    let pond: Pond | null = null;
    let dx = 0;
    let dz = 0;
    if (serverTimeMs !== null) {
      for (const candidate of this.ponds) {
        const ex = wrapDeltaAxis(cameraPos.x, candidate.x);
        const ez = wrapDeltaAxis(cameraPos.z, candidate.z);
        if (Math.hypot(ex, cameraPos.y, ez) < FOUNTAIN_RANGE) {
          pond = candidate;
          dx = ex;
          dz = ez;
          break;
        }
      }
    }
    if (pond === null || serverTimeMs === null) {
      this.points.visible = false;
      return;
    }
    this.points.visible = true;
    // The pond's render-space centre: its torus image nearest the camera.
    const cx = cameraPos.x + dx;
    const cz = cameraPos.z + dz;
    const p = this.p;
    for (let i = 0; i < this.jets.length; i++) {
      sprayAt(this.jets[i] as Jet, serverTimeMs, p);
      this.positions[i * 3] = cx + p.x;
      this.positions[i * 3 + 1] = p.y;
      this.positions[i * 3 + 2] = cz + p.z;
      const b = SPRAY_BOOST * p.glow;
      this.colors[i * 3] = SPRAY_COLOR.r * b;
      this.colors[i * 3 + 1] = SPRAY_COLOR.g * b;
      this.colors[i * 3 + 2] = SPRAY_COLOR.b * b;
    }
    for (const name of ["position", "color"]) {
      const attr = this.geometry.getAttribute(name);
      if (attr) attr.needsUpdate = true;
    }
  }
}
