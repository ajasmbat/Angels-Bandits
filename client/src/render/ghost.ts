// S3 course record ghost: the record holder's run, replayed as a translucent
// plane beside you while you fly the same course. ONE draw — a merged
// silhouette (fuselage, wings, tailplane, fin) under one additive material
// at EMISSIVE_TRAIL, well under the tracers. MOBILE draws no ghost at all
// (quality.ts courseGhost): the rings stay, the replay goes.
//
// The path is the server's recording (positions only, common/src/courses.ts
// GhostRecorder), so attitude is read off the path itself: heading and climb
// from the tangent, bank from how fast the heading turns (a coordinated
// turn's tan(bank) = v·ω / g). Placed at the torus image nearest the camera
// every frame; scratch objects only.

import { EMISSIVE_TRAIL } from "@angels-bandits/common/constants";
import {
  type GhostTrack,
  ghostPositionAt,
} from "@angels-bandits/common/courses";
import { type Vec3, wrapDeltaAxis } from "@angels-bandits/common/world";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { emissiveBoost } from "./emissive";
import { QUALITY_PROFILES, type QualityTier } from "./quality";
import { nearestImageInto } from "./wrapPlacement";

const GHOST_COLOR = new THREE.Color(0x9fe8ff);
const GHOST_OPACITY = 0.4;
/** Heading/climb tangent, and the bank's turn-rate window, ms either side. */
const TANGENT_MS = 60;
const BANK_MS = 300;
const MAX_BANK = 1.1;
const G = 9.81;
/** The ghost lingers this long past its finish before it fades out, ms. */
const LINGER_MS = 1500;

/** A low-poly plane silhouette, nose along −Z like the player's plane. */
function ghostGeometry(): THREE.BufferGeometry {
  const box = (
    w: number,
    h: number,
    d: number,
    x: number,
    y: number,
    z: number,
  ) => new THREE.BoxGeometry(w, h, d).translate(x, y, z);
  const merged = mergeGeometries([
    box(1.1, 1.1, 8.5, 0, 0, 0), // fuselage
    box(11, 0.22, 2.2, 0, 0, -0.6), // wings
    box(4, 0.2, 1.2, 0, 0.1, 3.6), // tailplane
    box(0.2, 1.8, 1.3, 0, 0.9, 3.6), // fin
  ]);
  return merged ?? new THREE.BoxGeometry(1, 1, 8);
}

export class CourseGhost {
  readonly mesh: THREE.Mesh;
  private track: GhostTrack | null = null;
  private startMs = 0;
  private enabled = true;
  private readonly a: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly b: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly at: Vec3 = { x: 0, y: 0, z: 0 };

  constructor() {
    const color = GHOST_COLOR.clone().multiplyScalar(
      emissiveBoost(GHOST_COLOR, EMISSIVE_TRAIL),
    );
    this.mesh = new THREE.Mesh(
      ghostGeometry(),
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: GHOST_OPACITY,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    this.mesh.name = "course-ghost";
    this.mesh.visible = false;
  }

  /** MOBILE drops the replay; every other tier keeps it. */
  setQuality(tier: QualityTier): void {
    this.enabled = QUALITY_PROFILES[tier].courseGhost;
    if (!this.enabled) this.mesh.visible = false;
  }

  /** Start replaying `track`, its start ring passed at `nowMs`. */
  play(track: GhostTrack, nowMs: number): void {
    this.track = track;
    this.startMs = nowMs;
  }

  stop(): void {
    this.track = null;
    this.mesh.visible = false;
  }

  get playing(): boolean {
    return this.track !== null;
  }

  update(view: Vec3, nowMs: number): void {
    const track = this.track;
    if (!track) return;
    const t = nowMs - this.startMs;
    if (t > track.durMs + LINGER_MS) {
      this.stop();
      return;
    }
    if (!this.enabled) return;
    const pos = ghostPositionAt(track, t, this.at);
    // Heading and climb from the local tangent.
    ghostPositionAt(track, t - TANGENT_MS, this.a);
    ghostPositionAt(track, t + TANGENT_MS, this.b);
    const dx = wrapDeltaAxis(this.a.x, this.b.x);
    const dy = this.b.y - this.a.y;
    const dz = wrapDeltaAxis(this.a.z, this.b.z);
    const flat = Math.hypot(dx, dz);
    if (flat + Math.abs(dy) < 1e-3) return; // parked at an end: keep attitude
    const yaw = Math.atan2(-dx, -dz);
    const pitch = Math.atan2(dy, flat);
    // Bank from the heading's turn rate across a wider window.
    const yaw0 = this.headingAt(track, t - BANK_MS);
    const yaw1 = this.headingAt(track, t + BANK_MS);
    let dYaw = yaw1 - yaw0;
    if (dYaw > Math.PI) dYaw -= 2 * Math.PI;
    if (dYaw < -Math.PI) dYaw += 2 * Math.PI;
    const omega = dYaw / ((2 * BANK_MS) / 1000);
    const speed = Math.hypot(flat, dy) / ((2 * TANGENT_MS) / 1000);
    const roll = Math.max(
      -MAX_BANK,
      Math.min(MAX_BANK, Math.atan((speed * omega) / G)),
    );
    const at = nearestImageInto(this.at, view, pos);
    this.mesh.position.set(at.x, at.y, at.z);
    this.mesh.rotation.set(pitch, yaw, roll, "YXZ");
    this.mesh.visible = true;
  }

  /** Path heading at `t`, rad (flightForward's yaw convention). */
  private headingAt(track: GhostTrack, t: number): number {
    ghostPositionAt(track, t - TANGENT_MS, this.a);
    ghostPositionAt(track, t + TANGENT_MS, this.b);
    return Math.atan2(
      -wrapDeltaAxis(this.a.x, this.b.x),
      -wrapDeltaAxis(this.a.z, this.b.z),
    );
  }
}
