// T1 the supertall canyon: the berths' rigging. Each mega-tower's berth
// (common/src/boss.ts layer 5) holds its ship alongside a face, MOOR_GAP
// off it, and this draws what ties ship to tower across that gap: a lit
// gangway at the hull's waist, a mooring arm at each quarter on its
// bracket, and four cargo cables — every piece a horizontal box from the
// face to an anchor on the hull's flank, re-posed each frame so it follows
// the ship's sway (the hull end of each piece rides the pose; the face end
// stays on the face).
//
// Never solid, never needed to be: everything here hangs inside the gap
// between the hull and the face, at heights the hull's own envelope
// closes off, and the gap is narrower than a plane (MOOR_GAP). Draw ==
// collide is untouched: nothing a plane can reach is drawn here.
//
// One unlit instanced draw for every berth together (none while no berth is
// near: each one's instances are written only within the fog), the lamps and
// the arms' lights bright on the LAMP rung, the steel dark: it reads as a
// silhouette and a string of lights at night, like everything else up
// there. Shown only while the berth's ship is moored (present and not
// falling).

import {
  FLEET_LANES,
  type FleetLane,
  type FleetShip,
  type FleetSlot,
  PATH_MOOR,
  SHIP_PROFILES,
  SHIP_REACH,
  type ShipPose,
  blankPose,
  fleetPoseAt,
  lanePath,
  profileR,
  shipPointInto,
} from "@angels-bandits/common/boss";
import { LANDMARK_BLOCKS, landmarkProfile } from "@angels-bandits/common/city";
import {
  BLOCK_PITCH,
  EMISSIVE_LAMP,
  FOG_DISTANCE,
} from "@angels-bandits/common/constants";
import { type Vec3, wrapDeltaAxis } from "@angels-bandits/common/world";
import * as THREE from "three";
import { emissiveBoost } from "./emissive";

/** One piece: an anchor on the hull's flank (along the hull, as a share of
 * its half length; round it, rad from the beam toward the face, + up),
 * offsets along the hull and up from it, its cross-section and its look. */
interface RigPiece {
  along: number;
  around: number;
  du: number;
  dy: number;
  /** Size along the hull and up, m (the length is the span, each frame). */
  w: number;
  h: number;
  /** 0 steel, 1 lamp, 2 cable. */
  look: 0 | 1 | 2;
  /** A lamp sits at this share of the span from the face (else spans it). */
  at?: number;
}

/** The rig, per berth. */
export const RIG_PIECES: readonly RigPiece[] = [
  // The gangway at the waist: its deck, two rails, three lamps.
  { along: -0.03, around: -0.25, du: 0, dy: 0, w: 3, h: 0.35, look: 0 },
  { along: -0.03, around: -0.25, du: 1.4, dy: 0.6, w: 0.08, h: 1, look: 0 },
  { along: -0.03, around: -0.25, du: -1.4, dy: 0.6, w: 0.08, h: 1, look: 0 },
  {
    along: -0.03,
    around: -0.25,
    du: 1.4,
    dy: 1.2,
    w: 0.45,
    h: 0.45,
    look: 1,
    at: 0.15,
  },
  {
    along: -0.03,
    around: -0.25,
    du: -1.4,
    dy: 1.2,
    w: 0.45,
    h: 0.45,
    look: 1,
    at: 0.5,
  },
  {
    along: -0.03,
    around: -0.25,
    du: 1.4,
    dy: 1.2,
    w: 0.45,
    h: 0.45,
    look: 1,
    at: 0.85,
  },
  // The mooring arms at the quarters, and a light on each.
  { along: 0.62, around: 0.15, du: 0, dy: 0, w: 1.4, h: 1.4, look: 0 },
  { along: -0.62, around: 0.15, du: 0, dy: 0, w: 1.4, h: 1.4, look: 0 },
  {
    along: 0.62,
    around: 0.15,
    du: 0,
    dy: 1.1,
    w: 0.5,
    h: 0.5,
    look: 1,
    at: 0.9,
  },
  {
    along: -0.62,
    around: 0.15,
    du: 0,
    dy: 1.1,
    w: 0.5,
    h: 0.5,
    look: 1,
    at: 0.9,
  },
  // The cargo cables, two pairs.
  { along: 0.3, around: 0.45, du: 0, dy: 0, w: 0.14, h: 0.14, look: 2 },
  { along: 0.3, around: -0.5, du: 0, dy: 0, w: 0.14, h: 0.14, look: 2 },
  { along: -0.3, around: 0.45, du: 0, dy: 0, w: 0.14, h: 0.14, look: 2 },
  { along: -0.3, around: -0.5, du: 0, dy: 0, w: 0.14, h: 0.14, look: 2 },
];
/** The arms' brackets: a slab on the face behind each arm, m (up, out). */
const BRACKET = { h: 9, out: 1.2, w: 2.2 };

/** Colours (linear): dark steel, the gangway's warm lamps at the LAMP
 * rung, the cables a shade lighter than the steel. */
const STEEL = new THREE.Color(0.035, 0.038, 0.045);
const LAMP = new THREE.Color(1.0, 0.72, 0.42);
const LAMP_RGB = LAMP.clone().multiplyScalar(
  emissiveBoost(LAMP, EMISSIVE_LAMP),
);
const CABLE = new THREE.Color(0.07, 0.07, 0.075);
const looks: readonly THREE.Color[] = [STEEL, LAMP_RGB, CABLE];

/** One berth as the rig needs it. */
interface Berth {
  lane: number;
  /** The tower's axis and the face's outward normal and plane, m. */
  tx: number;
  tz: number;
  nx: number;
  nz: number;
  face: number;
}

/** Instances per berth: the pieces and the two brackets. */
const PER_BERTH = RIG_PIECES.length + 2;

const pose: ShipPose = blankPose();
const at: Vec3 = { x: 0, y: 0, z: 0 };
const m4 = new THREE.Matrix4();
const q = new THREE.Quaternion();
const up = new THREE.Vector3(0, 1, 0);
const pos = new THREE.Vector3();
const scl = new THREE.Vector3();

/** The berths' rigging (see the file's head). */
export class MooringRigs {
  readonly group = new THREE.Group();
  private readonly berths: Berth[] = [];
  private readonly geometry = new THREE.BoxGeometry(1, 1, 1);
  private readonly material = new THREE.MeshBasicMaterial({
    color: 0xffffff,
  });
  private readonly mesh: THREE.InstancedMesh;

  constructor() {
    FLEET_LANES.forEach((ln: FleetLane, lane) => {
      if (lanePath(lane) !== PATH_MOOR) return;
      const block = LANDMARK_BLOCKS[ln.tower];
      if (!block) return;
      const tx = block[0] * BLOCK_PITCH + BLOCK_PITCH / 2;
      const tz = block[1] * BLOCK_PITCH + BLOCK_PITCH / 2;
      const dx = wrapDeltaAxis(tx, ln.cx);
      const dz = wrapDeltaAxis(tz, ln.cz);
      const n = Math.hypot(dx, dz) || 1;
      const half =
        ((landmarkProfile(ln.tower).tiers[1] as { width: number }).width ?? 0) /
        2;
      this.berths.push({ lane, tx, tz, nx: dx / n, nz: dz / n, face: half });
    });
    const total = Math.max(1, this.berths.length) * PER_BERTH;
    this.mesh = new THREE.InstancedMesh(this.geometry, this.material, total);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < total; i++) {
      const piece = RIG_PIECES[i % PER_BERTH];
      this.mesh.setColorAt(
        i,
        piece ? (looks[piece.look] as THREE.Color) : STEEL,
      );
    }
    // The berths are posed at the viewer's images, all within the fog:
    // one draw for whichever are shown, never culled per berth.
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.visible = false;
    this.group.add(this.mesh);
  }

  /** Pose every moored ship's rig at `renderMs`, at its torus image
   * nearest `viewer`; hide the rest. Allocation-free. */
  update(slot: FleetSlot, viewer: Vec3, renderMs: number | null): void {
    let k = 0;
    for (const berth of this.berths) {
      const ship =
        renderMs === null ? null : mooredShip(slot, berth.lane, renderMs);
      const ln = FLEET_LANES[berth.lane] as FleetLane;
      const ox = viewer.x + wrapDeltaAxis(viewer.x, ln.cx) - ln.cx;
      const oz = viewer.z + wrapDeltaAxis(viewer.z, ln.cz) - ln.cz;
      const near =
        Math.hypot(ln.cx + ox - viewer.x, ln.cz + oz - viewer.z) <
        FOG_DISTANCE + 100;
      if (!ship || !near || renderMs === null) continue;
      fleetPoseAt(ship, renderMs, pose);
      const cls = ln.cls;
      const reach = (SHIP_REACH[cls] as { x: number }).x;
      const prof = SHIP_PROFILES[cls] as Parameters<typeof profileR>[0];
      // Toward the face, in the hull's frame: its +Z (starboard) points
      // to world (sin yaw, cos yaw); the face is −n from the hull.
      const side =
        Math.sin(pose.yaw) * -berth.nx + Math.cos(pose.yaw) * -berth.nz > 0
          ? 1
          : -1;
      const fx = berth.tx + berth.nx * berth.face;
      const fz = berth.tz + berth.nz * berth.face;
      for (const piece of RIG_PIECES) {
        const lx = piece.along * reach;
        const r = profileR(prof, lx);
        shipPointInto(
          pose,
          lx,
          r * Math.sin(piece.around) + piece.dy,
          side * r * Math.cos(piece.around),
          at,
        );
        // The anchor and its projection on the face, on the viewer's image.
        const hx = at.x + ox;
        const hz = at.z + oz;
        const out =
          wrapDeltaAxis(fx, at.x) * berth.nx +
          wrapDeltaAxis(fz, at.z) * berth.nz;
        const span = Math.max(0.2, out + 0.3);
        // Along the hull (the face's tangent): offset `du`.
        const ux = -berth.nz;
        const uz = berth.nx;
        const t = piece.at ?? 0.5;
        const cx = hx - berth.nx * (out - span * t) + ux * piece.du;
        const cz = hz - berth.nz * (out - span * t) + uz * piece.du;
        pos.set(cx, at.y, cz);
        q.setFromAxisAngle(up, Math.atan2(-berth.nz, berth.nx));
        scl.set(piece.at === undefined ? span : piece.w, piece.h, piece.w);
        this.mesh.setMatrixAt(k++, m4.compose(pos, q, scl));
      }
      // The arms' brackets on the face.
      for (const along of [0.62, -0.62]) {
        shipPointInto(pose, along * reach, 0, 0, at);
        const out =
          wrapDeltaAxis(fx, at.x) * berth.nx +
          wrapDeltaAxis(fz, at.z) * berth.nz;
        pos.set(
          at.x + ox - berth.nx * (out - BRACKET.out / 2),
          at.y,
          at.z + oz - berth.nz * (out - BRACKET.out / 2),
        );
        q.setFromAxisAngle(up, Math.atan2(-berth.nz, berth.nx));
        scl.set(BRACKET.out, BRACKET.h, BRACKET.w);
        this.mesh.setMatrixAt(k++, m4.compose(pos, q, scl));
      }
    }
    this.mesh.count = k;
    this.mesh.visible = k > 0;
    if (k > 0) this.mesh.instanceMatrix.needsUpdate = true;
  }
}

/** The ship moored at `lane`'s berth at `t` — present, not falling — or
 * null. */
function mooredShip(
  slot: FleetSlot,
  lane: number,
  t: number,
): FleetShip | null {
  for (const s of slot.ships) {
    if (s.lane !== lane || t < s.t0) continue;
    if (s.down !== null && t >= s.down.t) continue;
    return s;
  }
  return null;
}
