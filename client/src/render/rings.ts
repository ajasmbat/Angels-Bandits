// S3 stunt course rings: every ring of every course as ONE InstancedMesh —
// one draw call for the whole feature, on every quality tier (the rings are
// guidance, like the hole chevrons).
//
// Rings are LIGHT, not geometry: nothing here is solid, the crash check and
// the camera arm never see them, and a pass is decided by the shared swept
// test (common/src/courses.ts ringCrossing), never by these triangles.
//
// Each frame every ring is placed at its torus image nearest the camera
// (nearestImageInto, scratch objects only — no allocation), which is also why
// the mesh is never frustum-culled: three computes an InstancedMesh's bounds
// once, and per-frame images make that sphere meaningless.
//
// Colour says what a ring means, on the emissive ladder — tracers stay the
// brightest thing in the sky:
//   - idle: every start ring green at EMISSIVE_SIGN, the rest a dim cyan wash;
//   - racing: the next ring gold at EMISSIVE_HAZARD (and breathing), the ones
//     after it cyan at EMISSIVE_HOLE_LED, the finish magenta at EMISSIVE_SIGN,
//     passed rings gone, and every other course dimmed right down.
// Colours change only when the run state does; the per-frame work is the
// matrices.

import {
  EMISSIVE_HAZARD,
  EMISSIVE_HOLE_LED,
  EMISSIVE_SIGN,
} from "@angels-bandits/common/constants";
import type { Course } from "@angels-bandits/common/courses";
import type { Vec3 } from "@angels-bandits/common/world";
import * as THREE from "three";
import { emissiveBoost } from "./emissive";
import { nearestImageInto } from "./wrapPlacement";

/** Linear colour of `hex` lifted to ladder rung `rung`, times `dim`. */
function rungColor(hex: number, rung: number, dim = 1): THREE.Color {
  const c = new THREE.Color(hex);
  return c.multiplyScalar(emissiveBoost(c, rung) * dim);
}

const COLORS = {
  start: rungColor(0x3dff8a, EMISSIVE_SIGN),
  idle: rungColor(0x27e0c0, EMISSIVE_HOLE_LED, 0.35),
  next: rungColor(0xffc43d, EMISSIVE_HAZARD),
  ahead: rungColor(0x27e0c0, EMISSIVE_HOLE_LED),
  finish: rungColor(0xff4fd8, EMISSIVE_SIGN),
  otherStart: rungColor(0x3dff8a, EMISSIVE_SIGN, 0.3),
  other: rungColor(0x27e0c0, EMISSIVE_HOLE_LED, 0.15),
} as const;

/** Tube radius as a share of the ring radius. */
const TUBE = 0.07;
/** The next ring breathes this much, at this rate (rad/ms). */
const PULSE = 0.06;
const PULSE_RATE = 0.008;

interface RingInstance {
  course: number;
  index: number;
  last: boolean;
  pos: Vec3;
  quat: THREE.Quaternion;
  r: number;
}

export class CourseRings {
  readonly mesh: THREE.InstancedMesh;
  private readonly rings: RingInstance[] = [];
  /** Per instance: shown this frame (false = passed this run). */
  private readonly shown: Uint8Array;
  private runCourse = -2;
  private runNext = -1;
  private readonly at: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly m = new THREE.Matrix4();
  private readonly p = new THREE.Vector3();
  private readonly s = new THREE.Vector3();

  constructor(courses: readonly Course[]) {
    const axis = new THREE.Vector3(0, 0, 1); // TorusGeometry's own axis
    for (const course of courses) {
      course.rings.forEach((ring, index) => {
        this.rings.push({
          course: course.id,
          index,
          last: index === course.rings.length - 1,
          pos: ring.pos,
          quat: new THREE.Quaternion().setFromUnitVectors(
            axis,
            new THREE.Vector3(ring.n.x, ring.n.y, ring.n.z),
          ),
          r: ring.r,
        });
      });
    }
    const count = Math.max(1, this.rings.length);
    this.shown = new Uint8Array(count).fill(1);
    this.mesh = new THREE.InstancedMesh(
      new THREE.TorusGeometry(1, TUBE, 6, 40),
      new THREE.MeshBasicMaterial({ color: 0xffffff }),
      count,
    );
    this.mesh.name = "course-rings";
    this.mesh.frustumCulled = false;
    this.mesh.count = this.rings.length;
    for (let i = 0; i < count; i++) {
      this.mesh.setColorAt(i, COLORS.idle);
    }
    this.setRun(-1, 0);
  }

  /**
   * The local run state (course −1 = idle; `next` = the next ring due).
   * Cheap to call every frame: colours are rewritten only on a change.
   */
  setRun(course: number, next: number): void {
    if (course === this.runCourse && next === this.runNext) return;
    this.runCourse = course;
    this.runNext = next;
    for (let i = 0; i < this.rings.length; i++) {
      const ring = this.rings[i] as RingInstance;
      let shown = 1;
      let color: THREE.Color;
      if (course < 0) {
        color = ring.index === 0 ? COLORS.start : COLORS.idle;
      } else if (ring.course !== course) {
        color = ring.index === 0 ? COLORS.otherStart : COLORS.other;
      } else if (ring.index < next) {
        color = COLORS.idle;
        shown = 0;
      } else if (ring.index === next) {
        color = COLORS.next;
      } else {
        color = ring.last ? COLORS.finish : COLORS.ahead;
      }
      this.shown[i] = shown;
      this.mesh.setColorAt(i, color);
    }
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  /** Place every ring at its image nearest `view` (the camera). */
  update(view: Vec3, nowMs: number): void {
    const pulse = 1 + PULSE * Math.sin(nowMs * PULSE_RATE);
    for (let i = 0; i < this.rings.length; i++) {
      const ring = this.rings[i] as RingInstance;
      let scale = this.shown[i] ? ring.r : 0;
      if (
        ring.course === this.runCourse &&
        ring.index === this.runNext &&
        scale > 0
      ) {
        scale *= pulse;
      }
      const at = nearestImageInto(this.at, view, ring.pos);
      this.p.set(at.x, at.y, at.z);
      this.s.set(scale, scale, scale);
      this.m.compose(this.p, ring.quat, this.s);
      this.mesh.setMatrixAt(i, this.m);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
