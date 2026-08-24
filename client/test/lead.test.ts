// Lead-indicator seam: the pure torus-aware intercept solver. Given the
// shooter, the bullet speed, and a target with velocity, find where a bullet
// fired NOW meets the target. Expected values are hand-worked quadratic
// solutions (t from |d + v·t| = s·t), not recomputed via the implementation.

import { BULLET_RANGE } from "@angels-bandits/common/constants";
import { createFlightState } from "@angels-bandits/common/flight";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { gunLinePoint, leadPoint, projectToScreen } from "../src/ui/lead";

describe("leadPoint", () => {
  it("aims straight at a stationary target: 400 m ahead at bullet speed 400 → the target itself", () => {
    const p = leadPoint({ x: 1000, y: 300, z: 1000 }, 400, {
      pos: { x: 1000, y: 300, z: 600 },
      vel: { x: 0, y: 0, z: 0 },
    });
    expect(p?.x).toBeCloseTo(1000);
    expect(p?.y).toBeCloseTo(300);
    expect(p?.z).toBeCloseTo(600);
  });

  it("leads a crossing target: 300 m ahead, crossing at 300 m/s, bullet 500 m/s → t = 0.75 s", () => {
    // d = (0,0,−300), v = (300,0,0), s = 500. d·v = 0, so t = 300/√(s²−v²)
    // = 300/400 = 0.75 s; intercept = target + v·t = 225 m east of it.
    const p = leadPoint({ x: 1000, y: 300, z: 1000 }, 500, {
      pos: { x: 1000, y: 300, z: 700 },
      vel: { x: 300, y: 0, z: 0 },
    });
    expect(p?.x).toBeCloseTo(1225);
    expect(p?.y).toBeCloseTo(300);
    expect(p?.z).toBeCloseTo(700);
  });

  it("works across the seam and canonicalizes: fleeing target 200 m past the x edge", () => {
    // Shooter x=1950, target x=150 (d.x = +200 through the seam), fleeing
    // east at 100 m/s, bullet 400 m/s: 15t² − 4t − 4 = 0 → t = 2/3 s.
    // Intercept x = 150 + 100·(2/3) = 216.67 — canonical, no 2000s anywhere.
    const p = leadPoint({ x: 1950, y: 300, z: 100 }, 400, {
      pos: { x: 150, y: 300, z: 100 },
      vel: { x: 100, y: 0, z: 0 },
    });
    expect(p?.x).toBeCloseTo(216.666, 2);
    expect(p?.y).toBeCloseTo(300);
    expect(p?.z).toBeCloseTo(100);
  });

  it("returns null when the target outruns the bullet away from the shooter", () => {
    const p = leadPoint({ x: 1000, y: 300, z: 1000 }, 400, {
      pos: { x: 1000, y: 300, z: 900 },
      vel: { x: 0, y: 0, z: -500 },
    });
    expect(p).toBeNull();
  });
});

// ANGE-G9CPCV — the gun line itself. guns.ts fires from alternating wingtips
// with velocity exactly along flightForward, so the honest single line is the
// plane's centreline. Expected points are hand-worked from the attitude.
describe("gunLinePoint", () => {
  const at = { x: 1000, y: 300, z: 1000 };

  it("runs 350 m due north from a level plane at yaw 0 (nose is −Z)", () => {
    const p = gunLinePoint(createFlightState(at), BULLET_RANGE);
    expect(p.x).toBeCloseTo(1000);
    expect(p.y).toBeCloseTo(300);
    expect(p.z).toBeCloseTo(650);
  });

  it("swings west at yaw 90°", () => {
    const p = gunLinePoint(createFlightState(at, Math.PI / 2), BULLET_RANGE);
    expect(p.x).toBeCloseTo(650);
    expect(p.y).toBeCloseTo(300);
    expect(p.z).toBeCloseTo(1000);
  });

  it("climbs with the nose: 30° up gains 175 m over 350 m of line", () => {
    const climbing = { ...createFlightState(at), pitch: Math.PI / 6 };
    const p = gunLinePoint(climbing, BULLET_RANGE);
    expect(p.y).toBeCloseTo(475); // 300 + 350·sin30
    expect(p.z).toBeCloseTo(1000 - 350 * Math.cos(Math.PI / 6), 3);
  });

  it("canonicalizes across the seam — no negative coordinates", () => {
    // 100 m from the z edge, firing north: 100 − 350 = −250 ⇒ 1750.
    const p = gunLinePoint(
      createFlightState({ x: 1000, y: 300, z: 100 }),
      BULLET_RANGE,
    );
    expect(p.z).toBeCloseTo(1750);
  });
});

// The project-and-place step the pipper and the lead reticle share.
describe("projectToScreen", () => {
  const W = 1280;
  const H = 800;
  const eye = { x: 1000, y: 300, z: 1010 };

  /** A real perspective camera at `eye` looking due north (−Z). */
  function camera() {
    const c = new THREE.PerspectiveCamera(70, W / H, 0.1, 900);
    c.position.set(eye.x, eye.y, eye.z);
    c.lookAt(eye.x, eye.y, eye.z - 10);
    c.updateMatrixWorld(true);
    c.updateProjectionMatrix();
    return c;
  }

  it("puts a point on the view axis at screen centre", () => {
    const p = projectToScreen(
      camera(),
      eye,
      { x: 1000, y: 300, z: 900 },
      new THREE.Vector3(),
      W,
      H,
    );
    expect(p?.x).toBeCloseTo(W / 2, 3);
    expect(p?.y).toBeCloseTo(H / 2, 3);
  });

  it("puts a point off the right wing to the right, and a high one high", () => {
    const right = projectToScreen(
      camera(),
      eye,
      { x: 1030, y: 300, z: 900 },
      new THREE.Vector3(),
      W,
      H,
    );
    const high = projectToScreen(
      camera(),
      eye,
      { x: 1000, y: 330, z: 900 },
      new THREE.Vector3(),
      W,
      H,
    );
    expect(right?.x).toBeGreaterThan(W / 2);
    expect(right?.y).toBeCloseTo(H / 2, 3);
    expect(high?.y).toBeLessThan(H / 2); // screen y grows downward
    expect(high?.x).toBeCloseTo(W / 2, 3);
  });

  it("returns null for a point behind the camera", () => {
    const p = projectToScreen(
      camera(),
      eye,
      { x: 1000, y: 300, z: 1100 },
      new THREE.Vector3(),
      W,
      H,
    );
    expect(p).toBeNull();
  });

  it("is seam-safe: a point past the z edge still lands on the axis", () => {
    // Eye at z=10, point at z=1900 — 110 m ahead through the seam, not
    // 1890 m behind. Raw subtraction would put it off-screen.
    const seamEye = { x: 1000, y: 300, z: 10 };
    const c = new THREE.PerspectiveCamera(70, W / H, 0.1, 900);
    c.position.set(seamEye.x, seamEye.y, seamEye.z);
    c.lookAt(seamEye.x, seamEye.y, seamEye.z - 10);
    c.updateMatrixWorld(true);
    c.updateProjectionMatrix();
    const p = projectToScreen(
      c,
      seamEye,
      { x: 1000, y: 300, z: 1900 },
      new THREE.Vector3(),
      W,
      H,
    );
    expect(p?.x).toBeCloseTo(W / 2, 3);
    expect(p?.y).toBeCloseTo(H / 2, 3);
  });
});
