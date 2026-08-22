// Remote planes: one mesh + name tag + interpolation buffer per other player.
// Snapshots feed the buffers; each frame the manager samples them at the
// delayed render time and places everything at its torus image nearest the
// viewer (nearestImage) — the same placement rule as the rest of the scene,
// which is what keeps a seam-crossing remote gliding instead of teleporting.

import type {
  Pose,
  RosterEntry,
  SnapshotMsg,
} from "@angels-bandits/common/protocol";
import type { Vec3 } from "@angels-bandits/common/world";
import * as THREE from "three";
import { InterpolationBuffer } from "../net/interp";
import { TAG_ALTITUDE, createNameTag, disposeNameTag } from "./nametags";
import { buildPlaneMesh, disposePlaneMesh, spinPropeller } from "./plane";
import type { PlaneLights } from "./planelights";
import { strobePhaseMs } from "./planelights";
import { turbulenceOffset } from "./storm";
import type { PlaneTrails } from "./trails";
import { nearestImage } from "./wrapPlacement";

/** Spawn-protection shimmer pulse rate, Hz. */
const SHIMMER_HZ = 5;
/** Spawn-protection shimmer emissive tint. */
const SHIMMER_COLOR = 0x9fd8e8;
/** Propeller spin per meter flown, rad — same feel as the local plane's. */
const PROP_SPIN_PER_M = 0.7;

const scratchQuat = new THREE.Quaternion();
const scratchFwd = new THREE.Vector3();

interface Remote {
  mesh: THREE.Group;
  tag: THREE.Sprite;
  buffer: InterpolationBuffer;
  /** Canonical pose last applied — exposed for QA/debug. */
  lastPos: Vec3 | null;
  /** Full pose last sampled (remote tracer spawning). */
  lastPose: Pose | null;
  /** False between a death event and the next respawn — hidden, no samples. */
  alive: boolean;
  /** Spawn protection as of the last snapshot (drives the shimmer). */
  prot: boolean;
}

export class RemotePlanes {
  private readonly remotes = new Map<string, Remote>();
  private readonly names = new Map<string, { name: string; isBot: boolean }>();

  constructor(
    private readonly scene: THREE.Scene,
    private readonly selfId: string,
    private readonly lights: PlaneLights,
    private readonly trails: PlaneTrails,
  ) {}

  get count(): number {
    return this.remotes.size;
  }

  setRoster(roster: RosterEntry[]): void {
    for (const entry of roster) {
      if (entry.id !== this.selfId) {
        this.names.set(entry.id, {
          name: entry.name,
          isBot: entry.isBot ?? false,
        });
      }
    }
  }

  playerJoined(player: RosterEntry): void {
    if (player.id !== this.selfId) {
      this.names.set(player.id, {
        name: player.name,
        isBot: player.isBot ?? false,
      });
    }
  }

  playerLeft(id: string): void {
    this.names.delete(id);
    this.trails.drop(id);
    const remote = this.remotes.get(id);
    if (!remote) return;
    this.remotes.delete(id);
    this.scene.remove(remote.mesh, remote.tag);
    disposePlaneMesh(remote.mesh);
    disposeNameTag(remote.tag);
  }

  /** Feed one server snapshot into the per-player buffers. */
  ingest(snap: SnapshotMsg): void {
    for (const { id, pose, prot } of snap.players) {
      if (id === this.selfId) continue;
      let remote = this.remotes.get(id);
      if (!remote) {
        const known = this.names.get(id);
        remote = {
          mesh: buildPlaneMesh(),
          tag: createNameTag(known?.name ?? "???", known?.isBot ?? false),
          buffer: new InterpolationBuffer(),
          lastPos: null,
          lastPose: null,
          alive: true,
          prot: false,
        };
        remote.mesh.visible = false; // until the first sampled pose
        remote.tag.visible = false;
        this.scene.add(remote.mesh, remote.tag);
        this.remotes.set(id, remote);
      }
      // Presence in a snapshot IS being alive — dead planes are omitted.
      remote.alive = true;
      remote.prot = prot;
      remote.buffer.push(snap.time, pose);
    }
  }

  /** Death event: hide the plane and drop stale samples until it respawns. */
  setDead(id: string): void {
    const remote = this.remotes.get(id);
    if (!remote) return;
    remote.alive = false;
    remote.buffer = new InterpolationBuffer();
    remote.lastPos = null;
    remote.lastPose = null;
    remote.mesh.visible = false;
    remote.tag.visible = false;
    this.trails.clear(id);
  }

  /** Respawn event: fresh buffer so the teleport snaps instead of gliding. */
  respawn(id: string): void {
    const remote = this.remotes.get(id);
    if (!remote) return;
    remote.alive = true;
    remote.buffer = new InterpolationBuffer();
    remote.lastPos = null;
    remote.lastPose = null;
    this.trails.clear(id); // the respawn teleport must not streak
  }

  /** Living remotes as hit-test / lead targets: interpolated canonical
   * positions plus a seam-safe velocity estimate (zero until two samples). */
  targets(): { id: string; pos: Vec3; vel: Vec3 }[] {
    const out: { id: string; pos: Vec3; vel: Vec3 }[] = [];
    for (const [id, r] of this.remotes) {
      if (r.alive && r.lastPos) {
        out.push({
          id,
          pos: r.lastPos,
          vel: r.buffer.latestVelocity() ?? { x: 0, y: 0, z: 0 },
        });
      }
    }
    return out;
  }

  /** Living remotes for the passive UI/audio: canonical position, map-space
   * heading, and claimed airspeed (minimap blips + engine loops). */
  contacts(): { id: string; pos: Vec3; angle: number; speed: number }[] {
    const out: { id: string; pos: Vec3; angle: number; speed: number }[] = [];
    for (const [id, r] of this.remotes) {
      if (!r.alive || !r.lastPose) continue;
      scratchQuat.set(
        r.lastPose.quat.x,
        r.lastPose.quat.y,
        r.lastPose.quat.z,
        r.lastPose.quat.w,
      );
      scratchFwd.set(0, 0, -1).applyQuaternion(scratchQuat);
      // Map is north (−Z) up: heading angle 0 = up, clockwise positive.
      out.push({
        id,
        pos: r.lastPose.pos,
        angle: Math.atan2(scratchFwd.x, -scratchFwd.z),
        speed: r.lastPose.speed,
      });
    }
    return out;
  }

  /** Living remotes as threat-warning inputs: canonical position plus the
   * full 3D nose vector from the sampled quat (radio "on your six" check). */
  headings(): { pos: Vec3; fwd: Vec3 }[] {
    const out: { pos: Vec3; fwd: Vec3 }[] = [];
    for (const r of this.remotes.values()) {
      if (!r.alive || !r.lastPose) continue;
      scratchQuat.set(
        r.lastPose.quat.x,
        r.lastPose.quat.y,
        r.lastPose.quat.z,
        r.lastPose.quat.w,
      );
      scratchFwd.set(0, 0, -1).applyQuaternion(scratchQuat);
      out.push({
        pos: r.lastPose.pos,
        fwd: { x: scratchFwd.x, y: scratchFwd.y, z: scratchFwd.z },
      });
    }
    return out;
  }

  /** The last sampled pose of one remote (remote tracer spawning). */
  poseOf(id: string): Pose | null {
    const remote = this.remotes.get(id);
    return remote?.alive ? remote.lastPose : null;
  }

  nameOf(id: string): string {
    return this.names.get(id)?.name ?? "???";
  }

  /** Sample every buffer at `renderTime` and place meshes around `viewer`.
   * `nowMs` is the local performance.now clock (trail aging); `renderTime`
   * stays the synced server clock (strobe phase — all clients agree). */
  update(
    renderTime: number | null,
    viewer: Vec3,
    dt: number,
    nowMs: number,
  ): void {
    if (renderTime === null) return;
    for (const [id, remote] of this.remotes) {
      if (!remote.alive) continue;
      const pose = remote.buffer.sample(renderTime);
      if (!pose) continue;
      spinPropeller(remote.mesh, dt * pose.speed * PROP_SPIN_PER_M);
      remote.lastPos = pose.pos;
      remote.lastPose = pose;
      const p = nearestImage(viewer, pose.pos);
      this.lights.place(id, p, pose.quat, pose.speed, renderTime);
      this.trails.emit(id, pose.pos, pose.quat, nowMs, dt);
      // In-cloud turbulence wobble (ST2): display-only, zero at/below the
      // deck; phase-shifted per plane so a formation doesn't shake as one.
      const wobble = turbulenceOffset(
        nowMs + strobePhaseMs(id) * 7,
        pose.pos.y,
      );
      remote.mesh.position.set(
        p.x + wobble.x * 0.5,
        p.y + wobble.y * 0.5,
        p.z + wobble.z * 0.5,
      );
      remote.mesh.quaternion.set(
        pose.quat.x,
        pose.quat.y,
        pose.quat.z,
        pose.quat.w,
      );
      remote.tag.position.set(p.x, p.y + TAG_ALTITUDE, p.z);
      remote.mesh.visible = true;
      remote.tag.visible = true;
      // Spawn-protection shimmer: pulse the whole plane's material emissive.
      // The biplane nests groups (prop holders, struts) — traverse, not
      // children. Each remote owns its materials, so tinting is per-plane.
      const shimmer = remote.prot
        ? 0.75 + 0.25 * Math.sin((renderTime / 1000) * SHIMMER_HZ * 2 * Math.PI)
        : 0;
      remote.mesh.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          const mat = child.material as THREE.MeshStandardMaterial;
          if (remote.prot) {
            mat.emissive.setHex(SHIMMER_COLOR);
            mat.emissiveIntensity = shimmer;
          } else if (mat.emissive.getHex() === SHIMMER_COLOR) {
            // Restore the un-shimmered look (standard default: black, 1).
            mat.emissive.setHex(0x000000);
            mat.emissiveIntensity = 1;
          }
        }
      });
    }
  }

  /** QA hook: each remote's canonical position, placement, and combat flags. */
  debug(): {
    id: string;
    canonical: Vec3 | null;
    rendered: Vec3;
    alive: boolean;
    prot: boolean;
  }[] {
    return [...this.remotes.entries()].map(([id, r]) => ({
      id,
      canonical: r.lastPos,
      rendered: {
        x: r.mesh.position.x,
        y: r.mesh.position.y,
        z: r.mesh.position.z,
      },
      alive: r.alive,
      prot: r.prot,
    }));
  }
}
