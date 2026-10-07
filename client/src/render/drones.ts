// Drone light show (L10): 200 points of light morphing through shapes over a
// plaza, 60 s every ~8 min. The schedule and every drone's position are
// common/src/skytraffic.ts — pure in (seed, synced clock) — so every client
// sees the same heart over the same plaza at the same instant.
//
// Light, not geometry (the searchlight exception): no collision, and it is
// drawn into the SHARED MoverLights cloud, so the whole show costs zero draw
// calls. It must be the LAST writer of the frame — if the cloud ever filled,
// the drones are what gets dropped, never a nav light. Peak at the NAVLIGHT
// rung, under BEACON as the ticket asks. The cloud has fog off (additive +
// fog brightens), so the show fades with distance here instead.

import {
  EMISSIVE_NAVLIGHT,
  FOG_DISTANCE,
} from "@angels-bandits/common/constants";
import {
  DRONE_COUNT,
  DRONE_SHOW_MS,
  DRONE_SHOW_PERIOD_MS,
  type DroneShow,
  droneKeyframe,
  dronePointInto,
  droneShowAt,
  droneShowOf,
} from "@angels-bandits/common/skytraffic";
import type { Vec3 } from "@angels-bandits/common/world";
import * as THREE from "three";
import { emissiveBoost } from "./emissive";
import type { MoverLights } from "./movers";
import { nearestImage } from "./wrapPlacement";

/** Two colours per formation (alternate drones), in DRONE_SHAPES order. */
const PALETTE: readonly (readonly [number, number])[] = [
  [0xcfe4ff, 0xcfe4ff], // parked: cool white
  [0x3fd8ff, 0x8a7bff], // globe: cyan / violet
  [0xff4fc8, 0x3fd8ff], // rings: magenta / cyan
  [0xff2a4a, 0xff7a9a], // heart: red / pink
  [0xffc94a, 0xfff2b0], // star: gold
];
const boostedPalette = PALETTE.map((pair) =>
  pair.map((hex) => {
    const c = new THREE.Color(hex);
    return c.multiplyScalar(emissiveBoost(c, EMISSIVE_NAVLIGHT));
  }),
);
/** Drone light size, m (attenuated, like every MoverLights point). */
const DRONE_SIZE = 2.6;
/** Parked drones glow at this fraction before they lift off and after landing. */
const PARKED_GLOW = 0.35;

export class DroneShowRenderer {
  private forced: DroneShow | null = null;
  private readonly p = { x: 0, y: 0, z: 0 };
  private readonly at: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly color = new THREE.Color();
  /** The show drawn last frame (null between shows) — QA read-back. */
  current: DroneShow | null = null;

  constructor(private readonly seed: number) {}

  /** QA: play this period's show starting `ageMs` ago (null = schedule). */
  force(serverTimeMs: number | null, ageMs: number | null): void {
    if (serverTimeMs === null || ageMs === null) {
      this.forced = null;
      return;
    }
    const n = Math.floor(serverTimeMs / DRONE_SHOW_PERIOD_MS);
    this.forced = {
      ...droneShowOf(this.seed, n),
      startMs: serverTimeMs - ageMs,
    };
  }

  /** Write this frame's drones into the shared cloud. Call LAST. */
  update(cameraPos: Vec3, serverTimeMs: number | null, lights: MoverLights) {
    this.current = null;
    if (serverTimeMs === null) return;
    const forced = this.forced;
    if (forced && serverTimeMs - forced.startMs >= DRONE_SHOW_MS) {
      this.forced = null;
    }
    const show = this.forced ?? droneShowAt(this.seed, serverTimeMs);
    if (!show) return;
    this.current = show;
    // The formation is ~120 m across, far under WORLD_SIZE / 2, so one torus
    // image for its centre places every drone; offsets are local.
    const centre = nearestImage(cameraPos, show);
    const dist = Math.hypot(centre.x - cameraPos.x, centre.z - cameraPos.z);
    const far = 1 - smooth(FOG_DISTANCE * 0.65, FOG_DISTANCE, dist);
    if (far <= 0) return;
    const age = serverTimeMs - show.startMs;
    const key = droneKeyframe(age);
    // Lit while flying; dim while parked on the floor at either end.
    const lift = (key.from === 0 ? key.k : 1) * (key.to === 0 ? 1 - key.k : 1);
    const glow = (PARKED_GLOW + (1 - PARKED_GLOW) * lift) * far;
    const from = boostedPalette[key.from] ?? boostedPalette[0];
    const to = boostedPalette[key.to] ?? boostedPalette[0];
    if (!from || !to) return;
    for (let i = 0; i < DRONE_COUNT; i++) {
      dronePointInto(show, i, serverTimeMs, this.p);
      this.at.x = centre.x + (this.p.x - show.x);
      this.at.y = this.p.y;
      this.at.z = centre.z + (this.p.z - show.z);
      const a = from[i % 2];
      const b = to[i % 2];
      if (!a || !b) continue;
      this.color.copy(a).lerp(b, key.k).multiplyScalar(glow);
      lights.place(this.at, this.color, DRONE_SIZE);
    }
  }
}

const smooth = (lo: number, hi: number, v: number): number => {
  const k = Math.min(1, Math.max(0, (v - lo) / (hi - lo)));
  return k * k * (3 - 2 * k);
};
