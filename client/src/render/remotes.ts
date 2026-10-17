// Remote planes: one mesh + name tag + interpolation buffer per other player.
// Snapshots feed the buffers; each frame the manager samples them at the
// delayed render time and places everything at its torus image nearest the
// viewer (nearestImage) — the same placement rule as the rest of the scene,
// which is what keeps a seam-crossing remote gliding instead of teleporting.
//
// O2: each sample is buffered at the time its pose was TAKEN (snapshot time
// minus the entry's age), not the tick that happened to sample it — the old
// tick stamp mislabelled a pose 0–50 ms old as "now", which was the judder.
// A human's newest pose is therefore older than the tick by its hold plus its
// latency, so a shared render clock would outrun its buffer: each remote
// slews its OWN RenderClock toward the frame's target minus a peak-hold of
// that lag. Trade-off, accepted: a bot (age 0) and a human are drawn on
// clocks a few tens of ms apart. Strobes and the spawn shimmer stay on the
// shared clock so every client blinks in phase.
//
// E1 Air force: a room may hold hundreds of enemy planes, and snapshots are
// interest managed (common/src/interest.ts). So an ENEMY missing from a
// snapshot is not dead — it goes stale after IM_STALE_MS (deaths still
// arrive as `death`); a human's absence still hides it at once. And only
// the enemies that can be seen pay for a plane: each frame every remote is
// sampled (the radar and the lead need the pose), but an enemy past the
// far plane — or past the tier's nearest `airforce` — is not drawn, and the
// per-plane extras (lights, trails, a name tag) go to the nearest ones.

import {
  FOG_DISTANCE,
  INTERP_JITTER_DECAY,
  MAX_HP,
} from "@angels-bandits/common/constants";
import { IM_STALE_MS } from "@angels-bandits/common/interest";
import type {
  Pose,
  RosterEntry,
  SnapshotMsg,
} from "@angels-bandits/common/protocol";
import type { Vec3 } from "@angels-bandits/common/world";
import * as THREE from "three";
import { RenderClock } from "../net/clock";
import { InterpolationBuffer } from "../net/interp";
import type { FrameClock } from "../net/socket";
import { BOMBS_FULL } from "./fighter";
import type { PlaneFleet } from "./fleet";
import {
  type NameTagBatch,
  TAG_ALTITUDE,
  createNameTag,
  disposeNameTag,
} from "./nametags";
import {
  type ControlDeflection,
  NEUTRAL_CONTROLS,
  animatePlane,
  buildEnemyMesh,
  buildPlaneMesh,
  disposePlaneMesh,
  liveryFor,
  poseControls,
  setPlaneBombs,
  spinPropeller,
} from "./plane";
import type { PlaneLights } from "./planelights";
import { isEnemyId, strobePhaseMs } from "./planelights";
import { THIN_SECTORS } from "./sky-armada";
import { REVEAL_COLOR, REVEAL_INTENSITY, turbulenceOffsetInto } from "./storm";
import type { PlaneTrails, QuatLike } from "./trails";
import { nearestImageInto } from "./wrapPlacement";

/** Spawn-protection shimmer pulse rate, Hz. */
const SHIMMER_HZ = 5;
/** Spawn-protection shimmer emissive tint. */
const SHIMMER_COLOR = 0x9fd8e8;
/** Propeller spin per meter flown, rad — same feel as the local plane's. */
const PROP_SPIN_PER_M = 0.7;

/** E1: an enemy is drawn only this near (the camera's far plane), m. */
const ENEMY_DRAW_M = FOG_DISTANCE + 100;
/** E1: an enemy wears lights within this, m; its trail within this. */
const ENEMY_LIGHTS_M = 450;
const ENEMY_TRAIL_M = 300;
/** E1: an enemy takes a name-tag cell within this and gives it back past
 * the second (the atlas has 16 cells), m. */
const ENEMY_TAG_IN_M = 300;
const ENEMY_TAG_OUT_M = 400;
/** E1: hit tests, the lead, magnetism and threat calls look this far, m. */
const ENEMY_TARGET_M = FOG_DISTANCE - 100;
/** E1: the draw-cap histogram: bins of this many m, out to the far plane. */
const DIST_BIN_M = 25;
const DIST_BINS = Math.ceil(ENEMY_DRAW_M / DIST_BIN_M);

/** P4: the shimmer and reveal tints in linear space, for the fleet's glow. */
const SHIMMER_LIN = new THREE.Color(SHIMMER_COLOR);
const REVEAL_LIN = new THREE.Color(REVEAL_COLOR);

const scratchQuat = new THREE.Quaternion();
const scratchFwd = new THREE.Vector3();
const scratchImage = { x: 0, y: 0, z: 0 };
const scratchWobble = { x: 0, y: 0, z: 0 };
/** P4: the glow handed to the fleet (copied there). */
const scratchGlow = { r: 0, g: 0, b: 0 };

interface Remote {
  mesh: THREE.Group;
  /** The per-plane sprite (`?fleet=0`); null when the batch draws tags. */
  tag: THREE.Sprite | null;
  /** P4: this remote's cell in the tag batch (-1: none). */
  tagCell: number;
  buffer: InterpolationBuffer;
  /** Canonical pose last applied — exposed for QA/debug. */
  lastPos: Vec3 | null;
  /** Full pose last sampled (remote tracer spawning). */
  lastPose: Pose | null;
  /** False between a death event and the next respawn — hidden, no samples. */
  alive: boolean;
  /** Spawn protection as of the last snapshot (drives the shimmer). */
  prot: boolean;
  /** Server-said HP as of the last snapshot (drives wounded smoke). */
  hp: number;
  /** Last frame's sampled orientation + render time (control surfaces). */
  prevQuat: QuatLike | null;
  prevTime: number;
  /** This remote's own smoothed render clock (O2). */
  clock: RenderClock;
  /** Peak-hold of the entries' pose age, ms: attacks instantly, decays
   * like the jitter estimate — how far behind the tick this remote's newest
   * pose can be, i.e. how much later than the shared clock to draw it. */
  lagPeak: number;
  /** The age on the newest snapshot entry, ms. */
  lastAge: number;
  /** How much staler this remote's image is than the server's on-record
   * pose of it, beyond the shared delay, ms (hit-claim budget). */
  extraDelay: number;
  /** `time` of the last snapshot this remote was in (W2: absence hides it). */
  seenAt: number;
  /** P4: this remote's surface commands, rewritten in place each frame. */
  controls: ControlDeflection;
  /** P4: the pose sampled each frame, rewritten in place (`lastPose` and
   * `lastPos` point into it while the remote is alive; readers copy what
   * they keep). */
  sampled: Pose;
  /** W2: the bomb mask last applied to an enemy's racks. */
  bombs: number;
  /** E1: an enemy plane (the carrier's), and its distance from the viewer
   * last frame, m. */
  enemy: boolean;
  dist: number;
}

export class RemotePlanes {
  private readonly remotes = new Map<string, Remote>();
  private readonly names = new Map<string, { name: string; isBot: boolean }>();
  /** W2: the room's enemy racks (GameSocket.racks; absent: fully loaded). */
  private racks: ReadonlyMap<string, number> | null = null;
  /** E1: enemies drawn at most (the tier's `airforce`), the distance that
   * kept them under it last frame, and this frame's histogram. */
  private enemyDraw = Number.POSITIVE_INFINITY;
  private drawCut = ENEMY_DRAW_M;
  private readonly bins = new Uint16Array(DIST_BINS);
  /** E1: enemies by bearing sector round the viewer last frame (the
   * cosmetic sky thins over the dense ones: SkyArmada.setThin). */
  readonly enemySectors = new Float32Array(THIN_SECTORS);
  /** E1 QA: enemies sampled / drawn last frame. */
  readonly airStats = { enemies: 0, drawn: 0, cut: ENEMY_DRAW_M };

  constructor(
    private readonly scene: THREE.Scene,
    private readonly selfId: string,
    private readonly lights: PlaneLights,
    private readonly trails: PlaneTrails,
    /** P4: the plane fleet and tag batch that draw every remote (null:
     * `?fleet=0`, each remote draws its own meshes and sprite). */
    private readonly fleet: PlaneFleet | null = null,
    private readonly tags: NameTagBatch | null = null,
  ) {}

  get count(): number {
    return this.remotes.size;
  }

  /** W2: read each enemy's bombs from `racks` every frame (a dropped bomb
   * leaves its rack empty on the airframe). */
  setRacks(racks: ReadonlyMap<string, number>): void {
    this.racks = racks;
  }

  /** E1: draw at most `n` enemies (the nearest; QualityProfile.airforce). */
  setEnemyDraw(n: number): void {
    this.enemyDraw = n;
  }

  setRoster(roster: RosterEntry[]): void {
    for (const entry of roster) this.playerJoined(entry);
  }

  playerJoined(player: RosterEntry): void {
    if (player.id !== this.selfId) {
      const isBot = player.isBot ?? false;
      this.names.set(player.id, { name: player.name, isBot });
      // P4: a remote first seen before its name arrived wears "???" —
      // redraw its batch cell now.
      const remote = this.remotes.get(player.id);
      if (remote) this.tags?.rename(remote.tagCell, player.name, isBot);
    }
  }

  playerLeft(id: string): void {
    this.names.delete(id);
    this.trails.drop(id);
    const remote = this.remotes.get(id);
    if (!remote) return;
    this.remotes.delete(id);
    this.scene.remove(remote.mesh);
    disposePlaneMesh(remote.mesh);
    if (remote.tag) {
      this.scene.remove(remote.tag);
      disposeNameTag(remote.tag);
    }
    this.tags?.free(remote.tagCell);
  }

  /** Feed one server snapshot into the per-player buffers. */
  ingest(snap: SnapshotMsg): void {
    for (const { id, pose, prot, hp, age = 0 } of snap.players) {
      if (id === this.selfId) continue;
      let remote = this.remotes.get(id);
      if (!remote) {
        const known = this.names.get(id);
        const tagName = known?.name ?? "???";
        const tagBot = known?.isBot ?? false;
        const enemy = isEnemyId(id);
        remote = {
          // DT1: enemies fly the carrier's fighter-bomber; every human
          // pilot a biplane in their own livery.
          mesh: enemy ? buildEnemyMesh() : buildPlaneMesh(liveryFor(id)),
          tag: this.tags ? null : createNameTag(tagName, tagBot),
          // E1: an enemy takes a tag cell only when near (updateOne).
          tagCell: this.tags && !enemy ? this.tags.alloc(tagName, tagBot) : -1,
          buffer: new InterpolationBuffer(),
          lastPos: null,
          lastPose: null,
          alive: true,
          prot: false,
          hp: MAX_HP,
          prevQuat: null,
          prevTime: 0,
          clock: new RenderClock(),
          lagPeak: 0,
          lastAge: 0,
          extraDelay: 0,
          seenAt: snap.time,
          controls: { ...NEUTRAL_CONTROLS },
          sampled: {
            pos: { x: 0, y: 0, z: 0 },
            quat: { x: 0, y: 0, z: 0, w: 1 },
            speed: 0,
          },
          bombs: BOMBS_FULL,
          enemy,
          dist: Number.POSITIVE_INFINITY,
        };
        remote.mesh.visible = false; // until the first sampled pose
        this.scene.add(remote.mesh);
        this.fleet?.adopt(remote.mesh);
        if (remote.tag) {
          remote.tag.visible = false;
          this.scene.add(remote.tag);
        }
        this.remotes.set(id, remote);
      }
      // Presence in a snapshot IS being alive — dead planes are omitted.
      remote.alive = true;
      remote.seenAt = snap.time;
      remote.prot = prot;
      remote.hp = hp;
      remote.lagPeak =
        age > remote.lagPeak
          ? age
          : remote.lagPeak + (age - remote.lagPeak) * INTERP_JITTER_DECAY;
      remote.lastAge = age;
      remote.buffer.push(snap.time - age, pose);
    }
    // ...and absence is not: dead, still loading, or away (W2, tab hidden).
    // Hide it with its samples dropped, so it never hangs frozen in the sky
    // or glides in from where it vanished. E1: an enemy's absence only
    // means it was not sent this tick (interest management) — it goes once
    // it has been missing for IM_STALE_MS.
    for (const [id, remote] of this.remotes) {
      if (!remote.alive || remote.seenAt === snap.time) continue;
      if (!remote.enemy || snap.time - remote.seenAt > IM_STALE_MS) {
        this.setDead(id);
      }
    }
  }

  /** Death event: hide the plane and drop stale samples until it respawns. */
  setDead(id: string): void {
    const remote = this.remotes.get(id);
    if (!remote?.alive) return; // already hidden (death event, or absence)
    remote.alive = false;
    remote.buffer = new InterpolationBuffer();
    remote.lastPos = null;
    remote.lastPose = null;
    remote.mesh.visible = false;
    if (remote.tag) remote.tag.visible = false;
    remote.prevQuat = null;
    remote.clock.reset();
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
    remote.prevQuat = null; // nor slam the control surfaces
    remote.clock.reset(); // the new buffer starts its own timeline
    this.trails.clear(id); // the respawn teleport must not streak
  }

  /** Living remotes as hit-test / lead targets: interpolated canonical
   * positions plus a seam-safe velocity estimate (zero until two samples),
   * the last snapshot's HP (wounded-smoke emission) and spawn protection
   * (U1: hit detection, the lead and magnetism skip a shielded plane). */
  targets(): { id: string; pos: Vec3; vel: Vec3; hp: number; prot: boolean }[] {
    const out: {
      id: string;
      pos: Vec3;
      vel: Vec3;
      hp: number;
      prot: boolean;
    }[] = [];
    for (const [id, r] of this.remotes) {
      // E1: enemies past ENEMY_TARGET_M are no target of anything local.
      if (r.enemy && r.dist > ENEMY_TARGET_M) continue;
      if (r.alive && r.lastPos) {
        out.push({
          id,
          pos: r.lastPos,
          vel: r.buffer.latestVelocity() ?? { x: 0, y: 0, z: 0 },
          hp: r.hp,
          prot: r.prot,
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
      if (r.enemy && r.dist > ENEMY_TARGET_M) continue;
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

  /** Extra staleness of `id`'s drawn image over the server's on-record pose
   * of it, ms — added to the declared delay of a hit claim on it. */
  extraDelayOf(id: string): number {
    return this.remotes.get(id)?.extraDelay ?? 0;
  }

  nameOf(id: string): string {
    return this.names.get(id)?.name ?? "???";
  }

  /** Sample every buffer at its remote's own clock and place meshes around
   * `viewer`. `nowMs` is the local performance.now clock (trail aging);
   * `clock.time` stays the shared synced clock (strobe phase — all clients
   * agree). */
  update(
    clock: FrameClock,
    viewer: Vec3,
    dt: number,
    nowMs: number,
    revealLevelOf?: (id: string) => number,
  ): void {
    const renderTime = clock.time;
    const target = clock.target;
    if (renderTime === null || target === null) return;
    // P4: a pre-bound walk — `for (const [id, remote] of this.remotes)`
    // built an iterator and an entry array per remote, per frame.
    const w = this.walk;
    w.clock = clock;
    w.viewer = viewer;
    w.dt = dt;
    w.nowMs = nowMs;
    w.renderTime = renderTime;
    w.target = target;
    w.revealLevelOf = revealLevelOf;
    this.bins.fill(0);
    this.enemySectors.fill(0);
    this.airStats.enemies = 0;
    this.airStats.drawn = 0;
    this.remotes.forEach(this.updateOne);
    w.revealLevelOf = undefined;
    // E1: next frame's draw distance — the bin where the nearest
    // `enemyDraw` enemies run out (one frame late, which nobody can see).
    let n = 0;
    let cut = ENEMY_DRAW_M;
    for (let b = 0; b < DIST_BINS; b++) {
      n += this.bins[b] as number;
      if (n > this.enemyDraw) {
        cut = b * DIST_BIN_M;
        break;
      }
    }
    this.drawCut = cut;
    this.airStats.cut = cut;
  }

  /** E1: the `n` nearest living remotes' contacts (engine audio), from a
   * contacts() list. */
  nearest<T extends { id: string }>(list: readonly T[], n: number): T[] {
    if (list.length <= n) return list as T[];
    const d = (c: T) =>
      this.remotes.get(c.id)?.dist ?? Number.POSITIVE_INFINITY;
    return [...list].sort((a, b) => d(a) - d(b)).slice(0, n);
  }

  /** update()'s state for `updateOne`. */
  private readonly walk: {
    clock: FrameClock | null;
    viewer: Vec3;
    dt: number;
    nowMs: number;
    renderTime: number;
    target: number;
    revealLevelOf: ((id: string) => number) | undefined;
  } = {
    clock: null,
    viewer: scratchImage,
    dt: 0,
    nowMs: 0,
    renderTime: 0,
    target: 0,
    revealLevelOf: undefined,
  };

  /** One remote's frame (update(), pre-bound). */
  private readonly updateOne = (remote: Remote, id: string): void => {
    const { clock, viewer, dt, nowMs, renderTime, target, revealLevelOf } =
      this.walk;
    if (!clock) return;
    if (!remote.alive) return;
    const ownTime = remote.clock.advance(
      clock.frameMs,
      target - remote.lagPeak,
    );
    // The server judges a hit on this remote against its NEWEST pose,
    // which is lastAge older than the tick; the image is drawn
    // (renderTime − ownTime) further back than the shared delay.
    remote.extraDelay = Math.max(0, renderTime - ownTime - remote.lastAge);
    const pose = remote.buffer.sampleInto(ownTime, remote.sampled);
    if (!pose) return;
    remote.lastPos = pose.pos;
    remote.lastPose = pose;
    const p = nearestImageInto(scratchImage, viewer, pose.pos);
    // E1: how far, and whether this enemy is drawn at all.
    const dx = p.x - viewer.x;
    const dy = p.y - viewer.y;
    const dz = p.z - viewer.z;
    remote.dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (remote.enemy) {
      this.airStats.enemies++;
      const sec =
        Math.floor(
          ((Math.atan2(dx, dz) + Math.PI) * THIN_SECTORS) / (2 * Math.PI),
        ) % THIN_SECTORS;
      this.enemySectors[sec] = (this.enemySectors[sec] as number) + 1;
      const bin = Math.floor(remote.dist / DIST_BIN_M);
      if (bin < DIST_BINS) this.bins[bin] = (this.bins[bin] as number) + 1;
      if (remote.dist > this.drawCut) {
        remote.mesh.visible = false;
        // Its surfaces start from rest when it comes back into view.
        remote.prevQuat = null;
        if (remote.tagCell >= 0 && remote.dist > ENEMY_TAG_OUT_M) {
          this.tags?.free(remote.tagCell);
          remote.tagCell = -1;
        }
        return;
      }
      this.airStats.drawn++;
      if (this.tags) {
        if (remote.tagCell < 0 && remote.dist < ENEMY_TAG_IN_M) {
          const known = this.names.get(id);
          remote.tagCell = this.tags.alloc(known?.name ?? "???", true);
        } else if (remote.tagCell >= 0 && remote.dist > ENEMY_TAG_OUT_M) {
          this.tags.free(remote.tagCell);
          remote.tagCell = -1;
        }
      }
    }
    spinPropeller(remote.mesh, dt * pose.speed * PROP_SPIN_PER_M);
    // Control surfaces from the frame-to-frame orientation delta over the
    // render clock the pose was sampled on (no protocol change).
    const controls = remote.prevQuat
      ? poseControls(
          remote.prevQuat,
          pose.quat,
          (ownTime - remote.prevTime) / 1000,
          remote.controls,
        )
      : NEUTRAL_CONTROLS;
    // Reused, not rebuilt per frame (P4 allocation table).
    if (remote.prevQuat) {
      remote.prevQuat.x = pose.quat.x;
      remote.prevQuat.y = pose.quat.y;
      remote.prevQuat.z = pose.quat.z;
      remote.prevQuat.w = pose.quat.w;
    } else {
      remote.prevQuat = { ...pose.quat };
    }
    remote.prevTime = ownTime;
    animatePlane(remote.mesh, controls, pose.speed, remote.hp, dt);
    // W2: the enemy's bombs still on its racks.
    const bombs = this.racks?.get(id) ?? BOMBS_FULL;
    if (bombs !== remote.bombs) {
      remote.bombs = bombs;
      setPlaneBombs(remote.mesh, bombs);
    }
    if (!remote.enemy || remote.dist < ENEMY_LIGHTS_M) {
      this.lights.place(id, p, pose.quat, pose.speed, renderTime);
    }
    if (!remote.enemy || remote.dist < ENEMY_TRAIL_M) {
      this.trails.emit(id, pose.pos, pose.quat, nowMs, dt);
    }
    // In-cloud turbulence wobble (ST2): display-only, zero at/below the
    // deck; phase-shifted per plane so a formation doesn't shake as one.
    const wobble = turbulenceOffsetInto(
      scratchWobble,
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
    remote.mesh.visible = true;
    // Spawn-protection shimmer: pulse the whole plane's material emissive.
    // The biplane nests groups (LOD levels, hinges) — traverse, not
    // children. Each remote owns its materials, so tinting is per-plane.
    const shimmer = remote.prot
      ? 0.75 + 0.25 * Math.sin((renderTime / 1000) * SHIMMER_HZ * 2 * Math.PI)
      : 0;
    // Storm reveal rim-flash (ST2): the shimmer's idiom with the reveal
    // tint; spawn protection outranks it when both are active.
    const reveal = revealLevelOf?.(id) ?? 0;
    if (this.fleet) {
      // P4: the fleet draws it — the tint is this instance's glow (the
      // emissive × intensity the materials used to be set to).
      const tint = remote.prot ? SHIMMER_LIN : REVEAL_LIN;
      const k = remote.prot ? shimmer : reveal * REVEAL_INTENSITY;
      scratchGlow.r = tint.r * k;
      scratchGlow.g = tint.g * k;
      scratchGlow.b = tint.b * k;
      this.fleet.add(remote.mesh, scratchGlow);
      this.tags?.place(remote.tagCell, p);
      return;
    }
    if (remote.tag) {
      remote.tag.position.set(p.x, p.y + TAG_ALTITUDE, p.z);
      remote.tag.visible = true;
    }
    remote.mesh.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        const mat = child.material as THREE.MeshStandardMaterial;
        if (remote.prot) {
          mat.emissive.setHex(SHIMMER_COLOR);
          mat.emissiveIntensity = shimmer;
        } else if (reveal > 0) {
          mat.emissive.setHex(REVEAL_COLOR);
          mat.emissiveIntensity = reveal * REVEAL_INTENSITY;
        } else if (
          mat.emissive.getHex() === SHIMMER_COLOR ||
          mat.emissive.getHex() === REVEAL_COLOR
        ) {
          // Restore the plain look (standard default: black, 1).
          mat.emissive.setHex(0x000000);
          mat.emissiveIntensity = 1;
        }
      }
    });
  };

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
