// Lead-indicator seam: the pure torus-aware intercept solver. Given the
// shooter, the bullet speed, and a target with velocity, find where a bullet
// fired NOW meets the target. Expected values are hand-worked quadratic
// solutions (t from |d + v·t| = s·t), not recomputed via the implementation.

import { BULLET_RANGE } from "@angels-bandits/common/constants";
import { createFlightState } from "@angels-bandits/common/flight";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  SolutionTone,
  gunLinePoint,
  hasSolution,
  leadPoint,
  projectToScreen,
  solutionMiss,
} from "../src/ui/lead";

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

// The firing solution. "Hot" means your bullets would actually connect, so the
// test is the PERPENDICULAR MISS of the intercept point from the gun line
// against HIT_RADIUS (6 m) — not a flat angle, which would be 7.3 m of slop at
// 350 m but 1.0 m at 50 m. A 4-degree ceiling stops point-blank pinning it on.
// Expected values are hand-worked right triangles.
describe("solutionMiss", () => {
  const level = createFlightState({ x: 1000, y: 300, z: 1000 }); // nose −Z

  it("reads zero miss straight down the gun line", () => {
    const e = solutionMiss(level, { x: 1000, y: 300, z: 800 });
    expect(e.miss).toBeCloseTo(0, 6);
    expect(e.angleRad).toBeCloseTo(0, 6);
    expect(hasSolution(e)).toBe(true);
  });

  it("measures 5 m of miss for a target 200 m out and 5 m off-axis", () => {
    const e = solutionMiss(level, { x: 1005, y: 300, z: 800 });
    expect(e.miss).toBeCloseTo(5, 6);
    expect(e.angleRad).toBeCloseTo(Math.atan2(5, 200), 6);
    expect(hasSolution(e)).toBe(true);
  });

  it("goes cold at 8 m of miss — wider than the 6 m hit radius", () => {
    expect(hasSolution(solutionMiss(level, { x: 1008, y: 300, z: 800 }))).toBe(
      false,
    );
  });

  it("counts vertical miss the same as lateral", () => {
    const e = solutionMiss(level, { x: 1000, y: 308, z: 800 });
    expect(e.miss).toBeCloseTo(8, 6);
    expect(hasSolution(e)).toBe(false);
  });

  it("refuses point-blank sloppiness: 3 m off at 20 m is 8.5 deg, not a solution", () => {
    // Inside the hit radius, but nowhere near lined up — without the angle
    // ceiling the reticle would sit permanently hot in a knife fight.
    const e = solutionMiss(level, { x: 1003, y: 300, z: 980 });
    expect(e.miss).toBeCloseTo(3, 6);
    expect(e.angleRad).toBeCloseTo(Math.atan2(3, 20), 6);
    expect(hasSolution(e)).toBe(false);
  });

  it("still trips at max range, where a flat 1.2 deg would be 7.3 m of slop", () => {
    const e = solutionMiss(level, { x: 1005, y: 300, z: 650 });
    expect(e.miss).toBeCloseTo(5, 6);
    expect(hasSolution(e)).toBe(true);
  });

  it("is cold for a target directly astern", () => {
    const e = solutionMiss(level, { x: 1000, y: 300, z: 1200 });
    expect(e.angleRad).toBeCloseTo(Math.PI, 6);
    expect(hasSolution(e)).toBe(false);
  });

  it("is seam-safe: 150 m ahead through the z edge, not 1850 m astern", () => {
    const near = createFlightState({ x: 1000, y: 300, z: 50 });
    const e = solutionMiss(near, { x: 1000, y: 300, z: 1900 });
    expect(e.miss).toBeCloseTo(0, 6);
    expect(hasSolution(e)).toBe(true);
  });

  it("takes only the shooter and the point — no camera, so zoom cannot move it", () => {
    // Structural: a pixel- or FOV-derived threshold would need one of those.
    expect(solutionMiss.length).toBe(2);
  });
});

describe("SolutionTone", () => {
  it("ticks once on acquiring, not every frame it stays hot", () => {
    const t = new SolutionTone();
    expect(t.shouldPlay(true, 0)).toBe(true);
    expect(t.shouldPlay(true, 16)).toBe(false);
    expect(t.shouldPlay(true, 32)).toBe(false);
  });

  it("stays silent while cold", () => {
    const t = new SolutionTone();
    expect(t.shouldPlay(false, 0)).toBe(false);
    expect(t.shouldPlay(false, 500)).toBe(false);
  });

  it("refuses to re-tick inside 400 ms — a jinking target cannot machine-gun it", () => {
    const t = new SolutionTone();
    expect(t.shouldPlay(true, 0)).toBe(true);
    t.shouldPlay(false, 100);
    expect(t.shouldPlay(true, 200)).toBe(false);
    t.shouldPlay(false, 300);
    expect(t.shouldPlay(true, 399)).toBe(false);
  });

  it("ticks again once the cooldown has expired", () => {
    const t = new SolutionTone();
    expect(t.shouldPlay(true, 1000)).toBe(true);
    t.shouldPlay(false, 1100);
    expect(t.shouldPlay(true, 1400)).toBe(true);
  });
});
