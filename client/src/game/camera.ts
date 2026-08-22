// Chase camera with lag. The camera lives in render space: before smoothing,
// its remembered position is re-aligned to the torus image nearest the plane
// (via wrapDelta, through nearestImage) — so when the plane's canonical
// coordinate jumps 2000→0 at the seam, the camera jumps WITH it and nothing
// moves on screen. That re-alignment is the whole seam trick for the viewer.

import {
  CAMERA_RESPONSE,
  CHASE_DISTANCE,
  CHASE_HEIGHT,
} from "@angels-bandits/common/constants";
import { type FlightState, flightForward } from "@angels-bandits/common/flight";
import type { Vec3 } from "@angels-bandits/common/world";
import type * as THREE from "three";
import { nearestImage } from "../render/wrapPlacement";
import { orbitOffset } from "./freelook";

export class ChaseCamera {
  private pos: Vec3 | null = null;

  /** Smoothed camera position, for placing the world around the viewer. */
  get position(): Vec3 {
    return this.pos ?? { x: 0, y: 0, z: 0 };
  }

  /** Snap directly behind the plane (spawn / respawn — no swoop across town). */
  snapTo(state: FlightState): void {
    this.pos = this.desired(state);
  }

  private desired(state: FlightState): Vec3 {
    const fwd = flightForward(state);
    return {
      x: state.pos.x - fwd.x * CHASE_DISTANCE,
      y: state.pos.y - fwd.y * CHASE_DISTANCE + CHASE_HEIGHT,
      z: state.pos.z - fwd.z * CHASE_DISTANCE,
    };
  }

  update(
    camera: THREE.PerspectiveCamera,
    state: FlightState,
    dt: number,
    look?: { yaw: number; pitch: number },
  ): void {
    if (!this.pos) this.snapTo(state);
    else this.pos = nearestImage(state.pos, this.pos); // seam re-alignment

    // From here on this is viewer-local math on already-aligned images, not
    // entity-to-entity world math — plain arithmetic is correct.
    const target = this.desired(state);
    const blend = 1 - Math.exp(-CAMERA_RESPONSE * dt);
    const p = this.pos as Vec3;
    this.pos = {
      x: p.x + (target.x - p.x) * blend,
      y: p.y + (target.y - p.y) * blend,
      z: p.z + (target.z - p.z) * blend,
    };

    // Free-look orbits the DISPLAYED camera around the plane; the chase state
    // itself stays un-orbited, so releasing E always eases back to the exact
    // chase framing and the orbit never feeds back into the smoothing.
    const aim = nearestImage(this.pos, state.pos);
    let view = this.pos as Vec3;
    if (look && (look.yaw !== 0 || look.pitch !== 0)) {
      const off = orbitOffset(
        { x: view.x - aim.x, y: view.y - aim.y, z: view.z - aim.z },
        look.yaw,
        look.pitch,
      );
      view = { x: aim.x + off.x, y: aim.y + off.y, z: aim.z + off.z };
    }
    camera.position.set(view.x, view.y, view.z);
    camera.lookAt(aim.x, aim.y + 2, aim.z);
  }
}
