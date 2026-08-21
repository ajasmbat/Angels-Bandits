// Street traffic (V3): deterministic cosmetic cars on the street grid.
// Purely visual — zero netcode, zero collision, zero server involvement.
// Every car's pose is a PURE FUNCTION of (lane, car index, server time, seed),
// so all clients — late joiners included — see identical traffic with no
// per-frame integration state to drift. Same pure-layout/renderer split as
// streetlights.ts: the exported functions are the tested seam.

import { mulberry32 } from "@angels-bandits/common/city";
import { BLOCK_PITCH, WORLD_SIZE } from "@angels-bandits/common/constants";
import { type Vec3, canonicalize } from "@angels-bandits/common/world";
import * as THREE from "three";
import { nearestImage } from "./wrapPlacement";

/** Sideways offset of each lane from its street centerline, meters. */
const LANE_OFFSET = 3;
/** Cars on every lane. 40 lanes × 4 = 160 cars total (~the plan's ~150). */
export const CARS_PER_LANE = 4;
/** Speed band from the plan, m/s — one shared speed per lane, so the fixed
 * phase offsets keep cars in a lane from ever overlapping. */
const SPEED_MIN = 8;
const SPEED_SPAN = 6;
/** Even car spacing along a lane, meters. */
const SPACING = WORLD_SIZE / CARS_PER_LANE;
/** Per-car phase jitter, ± meters. Must stay < SPACING/2 minus a car length
 * so the in-lane no-overlap guarantee holds (worst-case gap 200 m). */
const PHASE_JITTER = 150;

/** One directed traffic lane: a full torus loop parallel to a street line. */
export interface TrafficLane {
  /** Stable id, used to seed this lane's PRNG stream. */
  id: number;
  /** World axis the lane runs along ('z' lanes belong to north–south streets). */
  axis: "x" | "z";
  /** Canonical coordinate on the OTHER axis (centerline ± LANE_OFFSET). */
  cross: number;
  /** Direction of travel along `axis`. */
  dir: 1 | -1;
}

/**
 * The full lane graph, deterministic from the block grid: every street line
 * (each BLOCK_PITCH multiple, both axes) carries two lanes offset
 * ±LANE_OFFSET from the centerline, driving opposite directions — right-hand
 * traffic. Lanes are complete torus loops of length WORLD_SIZE.
 */
export function trafficLanes(): TrafficLane[] {
  const grid = WORLD_SIZE / BLOCK_PITCH;
  const lanes: TrafficLane[] = [];
  for (let line = 0; line < grid; line++) {
    const center = line * BLOCK_PITCH;
    // canonicalize wraps line 0's negative-side lane to WORLD_SIZE − offset.
    const minus = canonicalize({ x: center - LANE_OFFSET, y: 0, z: 0 }).x;
    const plus = center + LANE_OFFSET;
    lanes.push(
      { id: lanes.length, axis: "z", cross: minus, dir: -1 },
      { id: lanes.length + 1, axis: "z", cross: plus, dir: 1 },
    );
  }
  for (let line = 0; line < grid; line++) {
    const center = line * BLOCK_PITCH;
    const minus = canonicalize({ x: center - LANE_OFFSET, y: 0, z: 0 }).x;
    const plus = center + LANE_OFFSET;
    lanes.push(
      { id: lanes.length, axis: "x", cross: minus, dir: 1 },
      { id: lanes.length + 1, axis: "x", cross: plus, dir: -1 },
    );
  }
  return lanes;
}

/** A car's rendered state: canonical ground position + heading. Forward is
 * −Z at yaw 0 — the same convention the planes use. */
export interface CarPose {
  pos: Vec3;
  yaw: number;
}

/** The lane's PRNG stream: draw 0 is the lane speed, draws 1..CARS_PER_LANE
 * are the per-car phase jitters. Seeded from world seed + lane id. */
const laneRand = (lane: TrafficLane, seed: number): (() => number) =>
  mulberry32((seed + lane.id) >>> 0);

/** Shared speed of every car on `lane`, m/s, in [SPEED_MIN, SPEED_MIN + SPEED_SPAN]. */
export function laneSpeed(lane: TrafficLane, seed: number): number {
  return SPEED_MIN + laneRand(lane, seed)() * SPEED_SPAN;
}

/** Heading for a lane: forward is −Z at yaw 0 (the plane convention), so
 * +Z travel → π, −Z → 0, +X → −π/2, −X → π/2. */
const laneYaw = (lane: TrafficLane): number => {
  if (lane.axis === "z") return lane.dir === 1 ? Math.PI : 0;
  return lane.dir === 1 ? -Math.PI / 2 : Math.PI / 2;
};

/**
 * The pose of car `carIndex` on `lane` at server time `timeSeconds` — a pure
 * function, so every client (late joiners included) computes identical
 * traffic from its synced clock. No integration state, nothing to drift.
 */
export function carPose(
  lane: TrafficLane,
  carIndex: number,
  timeSeconds: number,
  seed: number,
): CarPose {
  const rand = laneRand(lane, seed);
  const speed = SPEED_MIN + rand() * SPEED_SPAN;
  let jitter = 0;
  for (let i = 0; i <= carIndex; i++) jitter = (rand() * 2 - 1) * PHASE_JITTER;
  const along = carIndex * SPACING + jitter + lane.dir * speed * timeSeconds;
  const pos = canonicalize(
    lane.axis === "x"
      ? { x: along, y: 0, z: lane.cross }
      : { x: lane.cross, y: 0, z: along },
  );
  return { pos, yaw: laneYaw(lane) };
}

// --- Renderer (consumes the pure model above; untested, like Streetlights) ---

/** Car body, meters: length along Z (forward = −Z, the plane convention). */
const CAR_SIZE = { width: 1.9, height: 1.4, length: 4 } as const;

/** Headlight emissive, linear HDR. Luminance ≈ 1.0 — above the window peak
 * (~0.94), well below tracers (~1.5): V1's emissive-ladder rule. */
const HEADLIGHT = "vec3(1.05, 1.0, 0.9)";
/** Taillight emissive. Red carries little luminance, so the red channel is
 * pushed hard to clear the 0.72 bloom threshold: luminance ≈ 0.85, just
 * under the lamp heads (~0.87). */
const TAILLIGHT = "vec3(3.4, 0.16, 0.14)";

/** Muted night palette; per-car pick is deterministic so every client agrees. */
const BODY_COLORS = [0x2a2d38, 0x3a2f2c, 0x24333a, 0x38323f, 0x2e3830];

const VERTEX_PARS = /* glsl */ `
varying vec3 vCarPos;
varying vec3 vCarNormal;
`;

const VERTEX_MAIN = /* glsl */ `
// All cars share one fixed-size geometry, so object space IS meters.
vCarPos = position;
vCarNormal = normal;
`;

const FRAGMENT_PARS = /* glsl */ `
varying vec3 vCarPos;
varying vec3 vCarNormal;
`;

const FRAGMENT_MAIN = /* glsl */ `
// Paired light dots on the front (−Z) and rear (+Z) faces, in object space.
if (vCarNormal.z < -0.5) {
  float headDist = min(
    distance(vCarPos.xy, vec2(0.55, 0.55)),
    distance(vCarPos.xy, vec2(-0.55, 0.55))
  );
  totalEmissiveRadiance += (1.0 - smoothstep(0.10, 0.22, headDist)) * ${HEADLIGHT};
} else if (vCarNormal.z > 0.5) {
  float tailDist = min(
    distance(vCarPos.xy, vec2(0.62, 0.5)),
    distance(vCarPos.xy, vec2(-0.62, 0.5))
  );
  totalEmissiveRadiance += (1.0 - smoothstep(0.08, 0.16, tailDist)) * ${TAILLIGHT};
}
`;

/** Dark car body + procedural head/taillight dots (same onBeforeCompile
 * idiom as buildings-material.ts — emissives only, bloom does the glow). */
function createCarMaterial(): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    roughness: 0.6,
    metalness: 0.4,
  });
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${VERTEX_PARS}`)
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>\n${VERTEX_MAIN}`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${FRAGMENT_PARS}`)
      .replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>\n${FRAGMENT_MAIN}`,
      );
  };
  return material;
}

/**
 * The instanced traffic renderer: every car in ONE InstancedMesh, poses from
 * the pure model above, drawn — like everything else — at the torus image
 * nearest the camera. Hidden until the server clock estimate exists, so all
 * clients only ever show clock-agreed traffic.
 */
export class Traffic {
  readonly mesh: THREE.InstancedMesh;
  private readonly lanes: TrafficLane[];
  private readonly seed: number;
  private readonly scratch = new THREE.Matrix4();
  private readonly quat = new THREE.Quaternion();
  private readonly pos = new THREE.Vector3();
  private static readonly UP = new THREE.Vector3(0, 1, 0);
  private static readonly UNIT = new THREE.Vector3(1, 1, 1);

  constructor(seed: number) {
    this.seed = seed;
    this.lanes = trafficLanes();
    const geometry = new THREE.BoxGeometry(
      CAR_SIZE.width,
      CAR_SIZE.height,
      CAR_SIZE.length,
    );
    geometry.translate(0, CAR_SIZE.height / 2, 0); // wheels on the street

    this.mesh = new THREE.InstancedMesh(
      geometry,
      createCarMaterial(),
      this.lanes.length * CARS_PER_LANE,
    );
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false; // instances move relative to the camera every frame
    this.mesh.visible = false; // until the first server clock estimate

    const color = new THREE.Color();
    for (let i = 0; i < this.mesh.count; i++) {
      color.setHex(BODY_COLORS[i % BODY_COLORS.length] ?? 0x2a2d38);
      this.mesh.setColorAt(i, color);
    }
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  /** Place every car for server time `serverTimeMs` (null = clock unknown → hide). */
  update(cameraPos: Vec3, serverTimeMs: number | null): void {
    if (serverTimeMs === null) {
      this.mesh.visible = false;
      return;
    }
    this.mesh.visible = true;
    const t = serverTimeMs / 1000;
    let index = 0;
    for (const lane of this.lanes) {
      for (let i = 0; i < CARS_PER_LANE; i++) {
        const { pos, yaw } = carPose(lane, i, t, this.seed);
        const p = nearestImage(cameraPos, pos);
        this.quat.setFromAxisAngle(Traffic.UP, yaw);
        this.pos.set(p.x, p.y, p.z);
        this.scratch.compose(this.pos, this.quat, Traffic.UNIT);
        this.mesh.setMatrixAt(index++, this.scratch);
      }
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /**
   * QA hook (cross-tab determinism checks): the canonical poses of the first
   * few cars at `serverTimeMs`, straight from the pure model — two tabs with
   * synced clocks must report identical cars.
   */
  debug(
    serverTimeMs: number | null,
    count = 5,
  ): { time: number; cars: CarPose[] } | null {
    if (serverTimeMs === null) return null;
    const t = serverTimeMs / 1000;
    const cars: CarPose[] = [];
    for (const lane of this.lanes.slice(0, count)) {
      cars.push(carPose(lane, 0, t, this.seed));
    }
    return { time: serverTimeMs, cars };
  }
}
