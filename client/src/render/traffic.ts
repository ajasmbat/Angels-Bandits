// Street traffic (V3): deterministic cosmetic cars on the street grid.
// Purely visual — zero netcode, zero collision, zero server involvement.
// Every car's pose is a PURE FUNCTION of (lane, car index, server time, seed),
// so all clients — late joiners included — see identical traffic with no
// per-frame integration state to drift. Same pure-layout/renderer split as
// streetlights.ts: the exported functions are the tested seam.
//
// L1 added the emergency vehicle: two of the cars carry a flashing light bar,
// riding the SAME InstancedMesh through a per-instance aSiren attribute — zero
// new draw calls, per the ticket's "reuse the traffic car-light slots" rule.

import { mulberry32 } from "@angels-bandits/common/city";
import { LANE_CENTERS } from "@angels-bandits/common/city/street";
import {
  BLOCK_PITCH,
  EMISSIVE_BEACON,
  WORLD_SIZE,
} from "@angels-bandits/common/constants";
import { type Vec3, canonicalize } from "@angels-bandits/common/world";
import * as THREE from "three";
import { emissiveBoost } from "./emissive";
import { nearestImage } from "./wrapPlacement";

/** Lane centerlines from the S1 street contract (±5 m, right-hand traffic). */
const [LANE_MINUS, LANE_PLUS] = LANE_CENTERS;
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
  /** Canonical coordinate on the OTHER axis (a contract lane center). */
  cross: number;
  /** Direction of travel along `axis`. */
  dir: 1 | -1;
}

/**
 * The full lane graph, deterministic from the block grid: every street line
 * (each BLOCK_PITCH multiple, both axes) carries two lanes on the contract's
 * lane centers, driving opposite directions — right-hand traffic. Lanes are
 * complete torus loops of length WORLD_SIZE.
 */
export function trafficLanes(): TrafficLane[] {
  const grid = WORLD_SIZE / BLOCK_PITCH;
  const lanes: TrafficLane[] = [];
  for (let line = 0; line < grid; line++) {
    const center = line * BLOCK_PITCH;
    // canonicalize wraps line 0's negative-side lane to WORLD_SIZE − offset.
    const minus = canonicalize({ x: center + LANE_MINUS, y: 0, z: 0 }).x;
    const plus = center + LANE_PLUS;
    lanes.push(
      { id: lanes.length, axis: "z", cross: minus, dir: -1 },
      { id: lanes.length + 1, axis: "z", cross: plus, dir: 1 },
    );
  }
  for (let line = 0; line < grid; line++) {
    const center = line * BLOCK_PITCH;
    const minus = canonicalize({ x: center + LANE_MINUS, y: 0, z: 0 }).x;
    const plus = center + LANE_PLUS;
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

// --- The emergency vehicle (L1) -------------------------------------------

/** Ambulances on the road. Two, so one is usually somewhere you can see. */
export const EMERGENCY_CARS = 2;
/** Light-bar alternation beat, seconds — red side, then blue side. */
export const SIREN_BEAT = 0.22;

/** One car's slot in the traffic fleet. */
export interface EmergencyCar {
  laneId: number;
  carIndex: number;
}

/**
 * Which cars are ambulances, drawn from the world seed — so every tab has the
 * same ambulance in the same lane, and the flash beat below is server time, so
 * they flash in sync too. Picked from the whole fleet (40 lanes ×
 * CARS_PER_LANE), with a retry on collision rather than a modulo, so the two
 * are always distinct cars.
 */
export function emergencyCars(seed: number): EmergencyCar[] {
  const laneCount = trafficLanes().length;
  const fleet = laneCount * CARS_PER_LANE;
  const rand = mulberry32((seed ^ 0x4d454447) >>> 0);
  const taken = new Set<number>();
  const out: EmergencyCar[] = [];
  // Bounded: 2 picks out of 160 slots collide vanishingly rarely, and the cap
  // makes the loop terminate whatever the PRNG does.
  for (let guard = 0; guard < 64 && out.length < EMERGENCY_CARS; guard++) {
    const slot = Math.floor(rand() * fleet);
    if (taken.has(slot)) continue;
    taken.add(slot);
    out.push({
      laneId: Math.floor(slot / CARS_PER_LANE),
      carIndex: slot % CARS_PER_LANE,
    });
  }
  return out;
}

/**
 * The light-bar state of an ambulance at server time `timeSeconds`:
 * 1 = red side lit, 2 = blue side lit — a real bar alternates rather than
 * blinking dark. A pure function of the synced clock, so two tabs strobe on
 * the same beat; that is the acceptance check.
 */
export function sirenState(timeSeconds: number): 1 | 2 {
  let beat = Math.floor(timeSeconds / SIREN_BEAT) % 4;
  if (beat < 0) beat += 4;
  return beat < 2 ? 1 : 2;
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
/** Ambulances are pale so the light bar has something to wash across. */
const AMBULANCE_BODY = 0xf2f4f7;

/**
 * A ladder-derived GLSL literal. The existing HEADLIGHT/TAILLIGHT literals
 * above were hand-tuned and have since drifted off-ladder (the headlight
 * computes to luminance 1.003, above EMISSIVE_LAMP); this ticket will not add
 * a third drifting literal, so the siren colours are DERIVED from the rung.
 * Sirens sit on the BEACON rung — a light bar is literally a beacon, and it is
 * still two rungs under EMISSIVE_TRACER.
 */
const ladderVec3 = (hex: number, rung: number): string => {
  const c = new THREE.Color(hex);
  c.multiplyScalar(emissiveBoost(c, rung));
  return `vec3(${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)})`;
};
const SIREN_RED = ladderVec3(0xff1a1f, EMISSIVE_BEACON);
const SIREN_BLUE = ladderVec3(0x2a55ff, EMISSIVE_BEACON);

const VERTEX_PARS = /* glsl */ `
// Three aliases the attribute KEYWORD via "#define attribute in", but it
// injects no declaration for a custom attribute — this line is required.
attribute float aSiren;
varying vec3 vCarPos;
varying vec3 vCarNormal;
varying float vSiren;
`;

const VERTEX_MAIN = /* glsl */ `
// All cars share one fixed-size geometry, so object space IS meters.
vCarPos = position;
vCarNormal = normal;
vSiren = aSiren;
`;

const FRAGMENT_PARS = /* glsl */ `
varying vec3 vCarPos;
varying vec3 vCarNormal;
varying float vSiren;
`;

const FRAGMENT_MAIN = /* glsl */ `
// Paired light dots on the front (−Z) and rear (+Z) faces, in object space.
// Oversized vs real car lights on purpose: they must read from flight
// altitude, where bloom merges each pair into one glow.
if (vCarNormal.z < -0.5) {
  float headDist = min(
    distance(vCarPos.xy, vec2(0.5, 0.6)),
    distance(vCarPos.xy, vec2(-0.5, 0.6))
  );
  totalEmissiveRadiance += (1.0 - smoothstep(0.28, 0.5, headDist)) * ${HEADLIGHT};
} else if (vCarNormal.z > 0.5) {
  float tailDist = min(
    distance(vCarPos.xy, vec2(0.55, 0.55)),
    distance(vCarPos.xy, vec2(-0.55, 0.55))
  );
  totalEmissiveRadiance += (1.0 - smoothstep(0.22, 0.4, tailDist)) * ${TAILLIGHT};
}
// Ambulance light bar, on the roof face. Compared by BAND, never by equality:
// an interpolated varying is not bit-exact across the perspective divide.
if (vSiren > 0.5 && vCarNormal.y > 0.5) {
  float redSide = step(vSiren, 1.5);
  float dRed = distance(vCarPos.xz, vec2(-0.55, 0.0));
  float dBlue = distance(vCarPos.xz, vec2(0.55, 0.0));
  totalEmissiveRadiance +=
    (1.0 - smoothstep(0.18, 0.42, dRed)) * redSide * ${SIREN_RED};
  totalEmissiveRadiance +=
    (1.0 - smoothstep(0.18, 0.42, dBlue)) * (1.0 - redSide) * ${SIREN_BLUE};
}
`;

/** Dark car body + procedural head/taillight dots (same onBeforeCompile
 * idiom as buildings-material.ts — emissives only, bloom does the glow). */
function createCarMaterial(): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    roughness: 0.6,
    metalness: 0.4,
  });
  // Three keys its program cache on onBeforeCompile.toString() by default.
  // This patch body is TEXTUALLY identical to buildings-material's (same
  // idiom, same local names), so without an explicit key the cars silently
  // reuse the buildings' compiled program and the light dots never appear.
  material.customProgramCacheKey = () => "ab-car-lights-siren";
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
  /** Per-instance light-bar state, rewritten every frame (0 = ordinary car). */
  private readonly siren: THREE.InstancedBufferAttribute;
  /** Instance index → true when that slot is an ambulance. */
  private readonly isAmbulance: boolean[];
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

    const capacity = this.lanes.length * CARS_PER_LANE;
    // An instanced attribute on the per-Traffic BoxGeometry is safe:
    // WebGLBindingStates takes the divisor from meshPerAttribute and skips the
    // _maxInstanceCount override for an isInstancedMesh draw.
    this.siren = new THREE.InstancedBufferAttribute(
      new Float32Array(capacity),
      1,
    );
    this.siren.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("aSiren", this.siren);
    this.isAmbulance = new Array(capacity).fill(false);
    for (const { laneId, carIndex } of emergencyCars(seed)) {
      const slot = laneId * CARS_PER_LANE + carIndex;
      if (slot >= 0 && slot < capacity) this.isAmbulance[slot] = true;
    }

    this.mesh = new THREE.InstancedMesh(
      geometry,
      createCarMaterial(),
      capacity,
    );
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false; // instances move relative to the camera every frame
    this.mesh.visible = false; // until the first server clock estimate

    const color = new THREE.Color();
    for (let i = 0; i < this.mesh.count; i++) {
      color.setHex(
        this.isAmbulance[i]
          ? AMBULANCE_BODY
          : (BODY_COLORS[i % BODY_COLORS.length] ?? 0x2a2d38),
      );
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
    // One siren state for the whole fleet: the flash is a function of server
    // time alone, so both ambulances beat together and so do both tabs.
    const flash = sirenState(t);
    let index = 0;
    for (const lane of this.lanes) {
      for (let i = 0; i < CARS_PER_LANE; i++) {
        const { pos, yaw } = carPose(lane, i, t, this.seed);
        const p = nearestImage(cameraPos, pos);
        this.quat.setFromAxisAngle(Traffic.UP, yaw);
        this.pos.set(p.x, p.y, p.z);
        this.scratch.compose(this.pos, this.quat, Traffic.UNIT);
        this.siren.setX(index, this.isAmbulance[index] ? flash : 0);
        this.mesh.setMatrixAt(index++, this.scratch);
      }
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.siren.needsUpdate = true;
  }

  /**
   * QA hook (cross-tab determinism checks): the canonical poses of the first
   * few cars at `serverTimeMs`, straight from the pure model — two tabs with
   * synced clocks must report identical cars.
   */
  debug(
    serverTimeMs: number | null,
    count = 5,
  ): {
    time: number;
    cars: CarPose[];
    visible: boolean;
    drawnAt: Vec3;
    /** L1: the light-bar state of every ambulance slot, in slot order. */
    siren: number[];
  } | null {
    if (serverTimeMs === null) return null;
    const t = serverTimeMs / 1000;
    const cars: CarPose[] = [];
    for (const lane of this.lanes.slice(0, count)) {
      cars.push(carPose(lane, 0, t, this.seed));
    }
    // The rendered truth for car 0, read back from its instance matrix
    // (same idiom as Streetlights.imageOf) — not a re-derivation.
    this.mesh.getMatrixAt(0, this.scratch);
    const e = this.scratch.elements;
    return {
      time: serverTimeMs,
      cars,
      visible: this.mesh.visible,
      drawnAt: { x: e[12] as number, y: e[13] as number, z: e[14] as number },
      siren: this.isAmbulance.flatMap((amb, i) =>
        amb ? [this.siren.getX(i)] : [],
      ),
    };
  }
}
