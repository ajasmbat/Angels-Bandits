// Rooftop searchlights (L2). Beams are LIGHT, not geometry — so by the
// ticket's design rule they carry no collision, and they are the one piece of
// L2 spectacle that lives entirely in the flight band without being solid.
// A beam you can fly through reads as a beam; a beam you cannot would be an
// invisible wall, which is exactly what the rule exists to prevent.
//
// One additive InstancedMesh of open cones = one draw call. Deliberately
// SUB-BLOOM: the beam sits under the 0.72 bloom threshold rather than on an
// emissive rung, the same call storm.ts makes for its rim flash. A bloomed
// cone would smear over half the screen and bury tracers.
//
// Stations and sweeps are pure functions of (city, server time) — no seed
// stream of its own, no state — so every client sweeps in lockstep.

import type { Building } from "@angels-bandits/common/city";
import { LANDMARK_HEIGHT } from "@angels-bandits/common/constants";
import type { Vec3 } from "@angels-bandits/common/world";
import * as THREE from "three";
import { nearestImage } from "./wrapPlacement";

/** How many rooftops carry a light. */
export const SEARCHLIGHT_COUNT = 8;
/** Beam length and half-angle at the far end, m. */
const BEAM_LENGTH = 340;
const BEAM_RADIUS = 26;
/** Seconds for one full sweep cycle; each station is offset around it. */
const SWEEP_PERIOD_S = 23;
/** How far the beam leans off vertical at the extremes, rad. */
const SWEEP_TILT = 0.72;

/** One rooftop light: where it stands and where in the cycle it starts. */
export interface SearchlightStation {
  x: number;
  y: number;
  z: number;
  /** Phase offset into the sweep cycle, 0..1. */
  phase: number;
}

/**
 * Pick the rooftops. Deterministic from the city alone: the tallest
 * non-landmark buildings, tie-broken by position so the order can never
 * depend on sort stability. Landmarks are excluded because they already
 * carry the roof beacons — doubling up would blow out one silhouette.
 */
export function searchlightStations(
  buildings: readonly Building[],
): SearchlightStation[] {
  const candidates = buildings
    .filter((b) => b.height < LANDMARK_HEIGHT)
    .slice()
    .sort((a, b) => b.height - a.height || a.x - b.x || a.z - b.z)
    .slice(0, SEARCHLIGHT_COUNT);
  return candidates.map((b, i) => ({
    x: b.x,
    y: b.height,
    z: b.z,
    phase: i / SEARCHLIGHT_COUNT,
  }));
}

/**
 * A station's beam direction at a server time — a unit vector pointing up and
 * away. The sweep is a slow cone: the beam leans SWEEP_TILT off vertical and
 * rotates, so from the ground it scythes across the sky.
 */
export function beamDirection(
  station: SearchlightStation,
  serverTimeMs: number,
): Vec3 {
  const cycle = (serverTimeMs / 1000 / SWEEP_PERIOD_S + station.phase) % 1;
  const spin = cycle * Math.PI * 2;
  // Tilt breathes over the cycle so the beams do not all trace one cone.
  const tilt = SWEEP_TILT * (0.55 + 0.45 * Math.sin(spin * 2));
  return {
    x: Math.sin(tilt) * Math.cos(spin),
    y: Math.cos(tilt),
    z: Math.sin(tilt) * Math.sin(spin),
  };
}

// --- Renderer (consumes the pure model above; untested, like Streetlights) ---

/**
 * Cool arc-lamp white, and the opacity it is drawn at.
 *
 * Deliberately SUB-BLOOM: the effective luminance stays under the 0.72
 * threshold rather than sitting on an emissive rung, the same call storm.ts
 * makes for its rim flash. Exported so a test can pin that — a bloomed beam
 * cone would smear across the screen and bury tracers, which is the one
 * readability contract the emissive ladder exists to protect.
 */
export const BEAM_COLOR = new THREE.Color(0.62, 0.72, 0.9);
export const BEAM_OPACITY = 0.075;

const UP = new THREE.Vector3(0, 1, 0);

/**
 * Every beam in one additive InstancedMesh. The cone is built apex-at-origin
 * pointing along +Y, so a single quaternion from +Y to the beam direction
 * places it — no per-frame geometry work.
 */
export class Searchlights {
  readonly mesh: THREE.InstancedMesh;
  private readonly stations: SearchlightStation[];
  private readonly matrix = new THREE.Matrix4();
  private readonly quat = new THREE.Quaternion();
  private readonly pos = new THREE.Vector3();
  private readonly dir = new THREE.Vector3();
  private readonly scale = new THREE.Vector3();

  constructor(buildings: readonly Building[]) {
    this.stations = searchlightStations(buildings);
    // Open-ended cone, apex pulled down to the origin.
    const cone = new THREE.ConeGeometry(1, 1, 14, 1, true);
    cone.translate(0, 0.5, 0);
    this.mesh = new THREE.InstancedMesh(
      cone,
      new THREE.MeshBasicMaterial({
        color: BEAM_COLOR,
        transparent: true,
        opacity: BEAM_OPACITY,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        // Additive + fog brightens the distant scene (the V1 lesson).
        fog: false,
      }),
      Math.max(1, this.stations.length),
    );
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }

  /** Beams drawn — for the perf report. */
  get beamCount(): number {
    return this.stations.length;
  }

  /** Sweep every beam. A null clock hides them, like the rest of L2. */
  update(cameraPos: Vec3, serverTimeMs: number | null): void {
    if (serverTimeMs === null) {
      this.mesh.visible = false;
      return;
    }
    this.mesh.visible = true;
    for (let i = 0; i < this.stations.length; i++) {
      const station = this.stations[i];
      if (!station) continue;
      const p = nearestImage(cameraPos, {
        x: station.x,
        y: station.y,
        z: station.z,
      });
      const d = beamDirection(station, serverTimeMs);
      this.pos.set(p.x, p.y, p.z);
      this.dir.set(d.x, d.y, d.z).normalize();
      this.quat.setFromUnitVectors(UP, this.dir);
      this.scale.set(BEAM_RADIUS, BEAM_LENGTH, BEAM_RADIUS);
      this.matrix.compose(this.pos, this.quat, this.scale);
      this.mesh.setMatrixAt(i, this.matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
