// Z1 airship fleet, client half: the renderer draws the WHOLE fleet in at
// most four draws (two instanced hull LODs, the lights, the shells), every
// instance where the crash check collides with it; its glow sits on the
// emissive ladder's rungs; and a round the client sees meet a ship is one
// the server's own line test accepts.

import {
  FLEET_LANES,
  FLEET_LAYERS,
  type FleetShip,
  type FleetSlot,
  SHIP_CLASSES,
  blankPose,
  collideBoss,
  fleetPoseAt,
  shipClass,
  shipHitValid,
  weakPointInto,
} from "@angels-bandits/common/boss";
import { mulberry32 } from "@angels-bandits/common/city";
import { EMISSIVE_TRACER, WORLD_SIZE } from "@angels-bandits/common/constants";
import { type Vec3, wrapDistance } from "@angels-bandits/common/world";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { bossBulletHit } from "../src/game/boss-hits";
import {
  FLEET_DRAWS,
  FleetRenderer,
  SHELL_COLOR,
  WEAK_COLOR,
} from "../src/render/boss";
import { luminance } from "../src/render/emissive";
import type { Impacts } from "../src/render/impacts";

const T0 = 1_787_000_000_000;
const t = T0 + 70_000;
const fleet = (seed: number): FleetShip[] => {
  const rand = mulberry32(seed);
  return FLEET_LANES.map((l, lane) => ({
    id: lane + 1,
    lane,
    t0: T0,
    s0:
      Math.round(
        rand() * (FLEET_LAYERS[l.layer] as { length: number }).length * 10,
      ) / 10,
    hp0: SHIP_CLASSES[l.cls]?.hp as number,
    down: null,
  }));
};
const slot: FleetSlot = { ships: fleet(3), launches: [] };
const hp = new Map(slot.ships.map((s) => [s.id, s.hp0]));

describe("the whole fleet in four draws", () => {
  // The particle pool needs a DOM; its dressing is not what is tested.
  const r = new FleetRenderer(
    { wreckFire: () => {} } as unknown as Impacts,
    () => {},
    () => {},
  );
  const viewer = { x: 30, y: 400, z: WORLD_SIZE - 20 };
  r.update(slot, hp, new Map(), viewer, t, 1000);

  it("draws every ship, and no more than four draw objects in all", () => {
    expect(r.stats.ships).toBe(slot.ships.length);
    expect(r.stats.draws).toBeLessThanOrEqual(FLEET_DRAWS);
    expect(FLEET_DRAWS).toBe(4);
    // The group holds exactly the four draws — however many ships fly.
    const drawn: THREE.Object3D[] = [];
    r.group.traverse((o) => {
      if (
        o instanceof THREE.Mesh ||
        o instanceof THREE.Points ||
        o instanceof THREE.InstancedMesh
      ) {
        drawn.push(o);
      }
    });
    expect(drawn.length).toBe(FLEET_DRAWS);
  });

  it("each instance is its ship, on the viewer's torus image", () => {
    const meshes: THREE.InstancedMesh[] = [];
    r.group.traverse((o) => {
      if (o instanceof THREE.InstancedMesh && o.visible) meshes.push(o);
    });
    const placed: THREE.Vector3[] = [];
    const m = new THREE.Matrix4();
    for (const mesh of meshes) {
      for (let i = 0; i < mesh.count; i++) {
        mesh.getMatrixAt(i, m);
        placed.push(new THREE.Vector3().setFromMatrixPosition(m));
      }
    }
    expect(placed.length).toBe(slot.ships.length);
    for (const s of slot.ships) {
      const pose = fleetPoseAt(s, t, blankPose());
      // Exactly one instance sits on this ship's centre (mod the torus),
      // within half a world of the viewer…
      const on = placed.filter(
        (p) => wrapDistance({ x: p.x, y: p.y, z: p.z }, pose) < 1e-3,
      );
      expect(on).toHaveLength(1);
      const p = on[0] as THREE.Vector3;
      expect(Math.abs(p.x - viewer.x)).toBeLessThanOrEqual(WORLD_SIZE / 2);
      expect(Math.abs(p.z - viewer.z)).toBeLessThanOrEqual(WORLD_SIZE / 2);
      // …and the crash check finds the hull there.
      expect(collideBoss(slot, pose, 1, t)?.id).toBe(s.id);
    }
  });

  it("draws nothing with no clock, and only the fleet it is handed", () => {
    r.update(slot, hp, new Map(), viewer, null, 1100);
    expect(r.group.visible).toBe(false);
    r.update({ ships: [], launches: [] }, hp, new Map(), viewer, t, 1200);
    expect(r.stats.ships).toBe(0);
    expect(r.stats.draws).toBe(0);
  });

  it("glows under the tracers on the ladder", () => {
    expect(luminance(WEAK_COLOR)).toBeLessThan(EMISSIVE_TRACER);
    expect(luminance(SHELL_COLOR)).toBeLessThan(EMISSIVE_TRACER);
  });
});

describe("what the client claims, the server accepts", () => {
  it("a round flown straight at an engine claims it, and the server agrees", () => {
    for (const s of slot.ships.slice(0, 6)) {
      const cls = shipClass(s);
      const pose = fleetPoseAt(s, t, blankPose());
      for (let k = 0; k < 4; k++) {
        const wp = weakPointInto(pose, cls, k, { x: 0, y: 0, z: 0 });
        const origin = { x: wp.x + 30, y: wp.y - 200, z: wp.z - 20 };
        const d = {
          x: wp.x - origin.x,
          y: wp.y - origin.y,
          z: wp.z - origin.z,
        };
        const len = Math.hypot(d.x, d.y, d.z);
        const dir = { x: d.x / len, y: d.y / len, z: d.z / len };
        const at = (u: number): Vec3 => ({
          x: origin.x + dir.x * u,
          y: origin.y + dir.y * u,
          z: origin.z + dir.z * u,
        });
        const hit = bossBulletHit(slot, at(len - 10), at(len + 1), t);
        expect(hit?.ship).toBe(s.id);
        expect(hit?.weak).toBe(k);
        if (!hit) continue;
        expect(shipHitValid(pose, cls, k, origin, hit.dir)).toBe(true);
      }
    }
  });

  it("the hull stops a round; no clock, no fleet: nothing", () => {
    const s = slot.ships[9] as FleetShip;
    const pose = fleetPoseAt(s, t, blankPose());
    const prev = { x: pose.x, y: pose.y - 40, z: pose.z };
    const cur = { x: pose.x, y: pose.y - 5, z: pose.z };
    const hit = bossBulletHit(slot, prev, cur, t);
    expect(hit?.ship).toBe(s.id);
    expect(hit?.weak).toBe(-1);
    expect(bossBulletHit(slot, prev, cur, null)).toBeNull();
    expect(bossBulletHit({ ships: [], launches: [] }, prev, cur, t)).toBeNull();
    // A round far below the fleet never even poses a ship.
    expect(
      bossBulletHit(slot, { ...prev, y: 80 }, { ...cur, y: 90 }, t),
    ).toBeNull();
  });
});
