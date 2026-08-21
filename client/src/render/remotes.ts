// Remote planes: one mesh + name tag + interpolation buffer per other player.
// Snapshots feed the buffers; each frame the manager samples them at the
// delayed render time and places everything at its torus image nearest the
// viewer (nearestImage) — the same placement rule as the rest of the scene,
// which is what keeps a seam-crossing remote gliding instead of teleporting.

import type { RosterEntry, SnapshotMsg } from "@angels-bandits/common/protocol";
import type { Vec3 } from "@angels-bandits/common/world";
import type * as THREE from "three";
import { InterpolationBuffer } from "../net/interp";
import { TAG_ALTITUDE, createNameTag, disposeNameTag } from "./nametags";
import { buildPlaneMesh, disposePlaneMesh } from "./plane";
import { nearestImage } from "./wrapPlacement";

/** Remote planes get a warm accent so friend-or-foe reads at a glance (T4 owns teams). */
const REMOTE_ACCENT = 0xff8a3d;

interface Remote {
  mesh: THREE.Group;
  tag: THREE.Sprite;
  buffer: InterpolationBuffer;
  /** Canonical pose last applied — exposed for QA/debug. */
  lastPos: Vec3 | null;
}

export class RemotePlanes {
  private readonly remotes = new Map<string, Remote>();
  private readonly names = new Map<string, string>();

  constructor(
    private readonly scene: THREE.Scene,
    private readonly selfId: string,
  ) {}

  get count(): number {
    return this.remotes.size;
  }

  setRoster(roster: RosterEntry[]): void {
    for (const entry of roster) {
      if (entry.id !== this.selfId) this.names.set(entry.id, entry.name);
    }
  }

  playerJoined(player: RosterEntry): void {
    if (player.id !== this.selfId) this.names.set(player.id, player.name);
  }

  playerLeft(id: string): void {
    this.names.delete(id);
    const remote = this.remotes.get(id);
    if (!remote) return;
    this.remotes.delete(id);
    this.scene.remove(remote.mesh, remote.tag);
    disposePlaneMesh(remote.mesh);
    disposeNameTag(remote.tag);
  }

  /** Feed one server snapshot into the per-player buffers. */
  ingest(snap: SnapshotMsg): void {
    for (const { id, pose } of snap.players) {
      if (id === this.selfId) continue;
      let remote = this.remotes.get(id);
      if (!remote) {
        remote = {
          mesh: buildPlaneMesh(REMOTE_ACCENT),
          tag: createNameTag(this.names.get(id) ?? "???"),
          buffer: new InterpolationBuffer(),
          lastPos: null,
        };
        remote.mesh.visible = false; // until the first sampled pose
        remote.tag.visible = false;
        this.scene.add(remote.mesh, remote.tag);
        this.remotes.set(id, remote);
      }
      remote.buffer.push(snap.time, pose);
    }
  }

  /** Sample every buffer at `renderTime` and place meshes around `viewer`. */
  update(renderTime: number | null, viewer: Vec3): void {
    if (renderTime === null) return;
    for (const remote of this.remotes.values()) {
      const pose = remote.buffer.sample(renderTime);
      if (!pose) continue;
      remote.lastPos = pose.pos;
      const p = nearestImage(viewer, pose.pos);
      remote.mesh.position.set(p.x, p.y, p.z);
      remote.mesh.quaternion.set(
        pose.quat.x,
        pose.quat.y,
        pose.quat.z,
        pose.quat.w,
      );
      remote.tag.position.set(p.x, p.y + TAG_ALTITUDE, p.z);
      remote.mesh.visible = true;
      remote.tag.visible = true;
    }
  }

  /** QA hook: each remote's canonical position and render-space placement. */
  debug(): { id: string; canonical: Vec3 | null; rendered: Vec3 }[] {
    return [...this.remotes.entries()].map(([id, r]) => ({
      id,
      canonical: r.lastPos,
      rendered: {
        x: r.mesh.position.x,
        y: r.mesh.position.y,
        z: r.mesh.position.z,
      },
    }));
  }
}
