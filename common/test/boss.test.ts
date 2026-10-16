// Z1 airship fleet — the pure model (common/src/boss.ts): a ship's pose is
// a pure function of its record and the clock; every lane wraps the torus
// seamlessly and stays in its altitude layer; no two hulls ever meet; the
// hull a renderer draws is the hull everything collides with, per class;
// turret fire is held to the bots' fairness caps; a hit is judged on the
// round's line; credit splits by damage; and a crash falls on the D4 wreck
// path.

import {
  BOSS_FLAK_BURST_R,
  BOSS_FLAK_CONE,
  BOSS_FLAK_DAMAGE_R,
  BOSS_FLAK_JITTER,
  BOSS_FLAK_MIN_FUSE_MS,
  BOSS_FLAK_MIN_RANGE,
  BOSS_FLAK_RANGE,
  BOSS_FLAK_REACTION_MS,
  BOSS_PARTS,
  BOSS_REACH_X,
  BOSS_REACH_Y,
  BOSS_REACH_Z,
  BOSS_TURRETS,
  BOSS_WEAK_POINTS,
  type BossFlak,
  type BossPart,
  FLEET_ALT_MAX,
  FLEET_ALT_MIN,
  FLEET_HIDE_M,
  FLEET_LANES,
  FLEET_LAYERS,
  FLEET_SIZE,
  type FleetShip,
  type FleetSlot,
  LAUNCH_BELLY,
  LAUNCH_CATAPULT,
  SHIP_CLASSES,
  SHIP_PARTS,
  SHIP_REACH,
  type ShipClassId,
  applyFleetState,
  blankPose,
  bossCredit,
  bossPartSdfAt,
  bossSpawnClear,
  collideBoss,
  decodeFlak,
  decodeShip,
  encodeFlak,
  encodeLaunch,
  encodeShip,
  fallPoseInto,
  flakDamage,
  flakPosAt,
  flakSolution,
  fleetPoseAt,
  hiddenLaneSpot,
  launchReleaseAt,
  launchSpawnAt,
  shipCrash,
  shipHitValid,
  shipLocalInto,
  shipPresent,
  shipRayHit,
  shipSdf,
  shipVelAt,
  turretMuzzleInto,
  weakPointInto,
} from "@angels-bandits/common/boss";
import { generateCity, mulberry32 } from "@angels-bandits/common/city";
import {
  type MoverBox,
  sphereHitsBox,
} from "@angels-bandits/common/city/movers";
import { roofStructuresFor } from "@angels-bandits/common/city/roof-structures";
import { buildCityIndex } from "@angels-bandits/common/collision";
import {
  BLIMP_ALT,
  BLIMP_HULL,
  BOT_AIM_JITTER,
  BOT_REACTION_MS,
  CITY_SEED,
  CLOUD_BASE,
  HELI_HULL,
  MAX_HP,
  NEWS_HELI_ALT_MAX,
  RESPAWN_SPEED,
  WORLD_SIZE,
  WRECK_MAX_MS,
} from "@angels-bandits/common/constants";
import {
  type Vec3,
  wrapDelta,
  wrapDistance,
} from "@angels-bandits/common/world";
import { wreckPosAt } from "@angels-bandits/common/wreck";
import { describe, expect, it } from "vitest";

/** A server-clock-sized time, never a cosy t = 0. */
const T0 = 1_787_000_000_000;
/** The first lane of each class. */
const laneOf = (cls: ShipClassId): number =>
  FLEET_LANES.findIndex((l) => l.cls === cls);
const ship = (over: Partial<FleetShip> = {}): FleetShip => ({
  id: 3,
  lane: 9,
  t0: T0,
  s0: 812.3,
  hp0: 210,
  down: null,
  ...over,
});
/** A whole fleet, one ship per lane, seeded spots along them. */
const fleet = (seed: number): FleetShip[] => {
  const rand = mulberry32(seed);
  return FLEET_LANES.map((l, lane) => ({
    id: lane + 1,
    lane,
    t0: T0 - Math.floor(rand() * 60_000),
    s0:
      Math.round(
        rand() * (FLEET_LAYERS[l.layer] as { length: number }).length * 10,
      ) / 10,
    hp0: SHIP_CLASSES[l.cls]?.hp as number,
    down: null,
  }));
};
const slotOf = (...ships: FleetShip[]): FleetSlot => ({ ships, launches: [] });
const toward = (from: Vec3, to: Vec3): Vec3 => {
  const d = wrapDelta(from, to);
  const len = Math.hypot(d.x, d.y, d.z);
  return { x: d.x / len, y: d.y / len, z: d.z / len };
};
const CLASSES: readonly ShipClassId[] = [0, 1, 2];

describe("fleetPoseAt is a pure function of the ship's record and the clock", () => {
  it("the same record and time give the same pose, every time", () => {
    const s = ship();
    for (const t of [T0, T0 + 12_345, T0 + 3_600_000, T0 + 86_400_000]) {
      expect(fleetPoseAt(s, t, blankPose())).toEqual(
        fleetPoseAt({ ...s }, t, blankPose()),
      );
    }
    // Before it came on, it holds its first spot.
    expect(fleetPoseAt(s, T0 - 5000, blankPose())).toEqual(
      fleetPoseAt(s, T0, blankPose()),
    );
  });

  it("survives the wire bit for bit", () => {
    for (const s of fleet(4)) {
      const w = encodeShip(s);
      expect(w.every(Number.isInteger)).toBe(true);
      const back = decodeShip(w);
      expect(back).toEqual(s);
      for (const t of [T0, T0 + 99_999]) {
        expect(fleetPoseAt(back as FleetShip, t, blankPose())).toEqual(
          fleetPoseAt(s, t, blankPose()),
        );
      }
    }
    expect(decodeShip([1, 2, 3])).toBeNull();
    expect(decodeShip([1, FLEET_SIZE, T0, 0, 100])).toBeNull();
    expect(decodeShip([1, 0, T0, Number.NaN, 100])).toBeNull();
    expect(decodeShip([1, 0, T0, 0, 0])).toBeNull();
  });

  it("flies its lane at its speed, nose first, wrapping the torus seamlessly", () => {
    for (const s of fleet(7)) {
      const lane = FLEET_LANES[s.lane];
      if (!lane) throw new Error("no lane");
      const a = blankPose();
      const b = blankPose();
      // 40 minutes in 0.25 s steps crosses every seam many times.
      for (let t = T0; t < T0 + 2_400_000; t += 250) {
        fleetPoseAt(s, t, a);
        fleetPoseAt(s, t + 250, b);
        for (const v of [a.x, a.z]) {
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThan(WORLD_SIZE);
        }
        // Never a jump at the seam: the step is the speed, on the torus.
        expect(wrapDistance(a, b)).toBeCloseTo(Math.abs(lane.v) * 0.25, 6);
        const d = wrapDelta(a, b);
        expect(d.x * a.hx + d.z * a.hz).toBeGreaterThan(0);
        expect(a.y).toBe(lane.alt);
        expect(a.pitch).toBe(0);
        expect(Math.cos(a.yaw)).toBeCloseTo(a.hx, 9);
        expect(-Math.sin(a.yaw)).toBeCloseTo(a.hz, 9);
      }
      // The lane closes on itself: a lane's length on, it is where it was.
      const len = (FLEET_LAYERS[lane.layer] as { length: number }).length;
      const back = fleetPoseAt(
        { ...s, s0: s.s0 + len },
        T0 + 5000,
        blankPose(),
      );
      expect(wrapDistance(back, fleetPoseAt(s, T0 + 5000, a))).toBeLessThan(
        1e-6,
      );
      const v = shipVelAt(s, T0 + 5000, { x: 0, y: 0, z: 0 });
      expect(Math.hypot(v.x, v.z)).toBeCloseTo(Math.abs(lane.v), 9);
    }
  });

  it("is in the air from t0 until it is shot down", () => {
    const s = ship();
    expect(shipPresent(s, T0 - 1)).toBe(false);
    expect(shipPresent(s, T0)).toBe(true);
    expect(shipPresent(s, T0 + 1e9)).toBe(true);
  });
});

describe("the fleet keeps to its altitude layers", () => {
  it("every hull sits between the news heli and the blimp, over every roof", () => {
    const city = generateCity(CITY_SEED);
    let roofs = 0;
    for (const b of city) {
      roofs = Math.max(roofs, b.height);
      for (const s of roofStructuresFor(b)) {
        roofs = Math.max(roofs, s.baseY + s.height);
      }
    }
    expect(FLEET_ALT_MIN).toBeGreaterThan(roofs + 15);
    expect(FLEET_ALT_MIN).toBeGreaterThanOrEqual(
      NEWS_HELI_ALT_MAX + (HELI_HULL[1] as number) * 1.3 + 15,
    );
    expect(FLEET_ALT_MAX).toBeLessThan(BLIMP_ALT - (BLIMP_HULL[1] as number));
    expect(FLEET_ALT_MAX).toBeLessThan(CLOUD_BASE);
    for (const lane of FLEET_LANES) {
      const reach = SHIP_REACH[lane.cls];
      if (!reach) throw new Error("no class");
      expect(lane.alt - reach.y).toBeGreaterThanOrEqual(FLEET_ALT_MIN);
      expect(lane.alt + reach.y).toBeLessThanOrEqual(FLEET_ALT_MAX);
    }
  });

  it("the reject bounds really bound every part of every class", () => {
    for (const cls of CLASSES) {
      const reach = SHIP_REACH[cls];
      if (!reach) throw new Error("no class");
      for (const p of SHIP_PARTS[cls] as readonly BossPart[]) {
        expect(Math.abs(p.x) + p.hx).toBeLessThanOrEqual(reach.x + 1e-9);
        expect(Math.abs(p.y) + p.hy).toBeLessThanOrEqual(reach.y + 1e-9);
        expect(Math.abs(p.z) + p.hz).toBeLessThanOrEqual(reach.z + 1e-9);
      }
    }
    for (const p of BOSS_PARTS) {
      expect(Math.abs(p.y) + p.hy).toBeLessThanOrEqual(BOSS_REACH_Y);
      expect(Math.abs(p.x) + p.hx).toBeLessThanOrEqual(BOSS_REACH_X);
      expect(Math.abs(p.z) + p.hz).toBeLessThanOrEqual(BOSS_REACH_Z);
    }
  });

  it("three classes of 90–200 m, and about twenty ships", () => {
    const lengths = CLASSES.map((c) => 2 * (SHIP_REACH[c]?.x as number));
    expect(lengths[0]).toBeGreaterThan(85);
    expect(lengths[2]).toBeLessThan(210);
    expect(lengths[0]).toBeLessThan(lengths[1] as number);
    expect(lengths[1]).toBeLessThan(lengths[2] as number);
    expect(FLEET_SIZE).toBe(20);
    for (const cls of CLASSES) {
      expect(FLEET_LANES.some((l) => l.cls === cls)).toBe(true);
    }
    // Only some ships are armed.
    const armed = FLEET_LANES.filter(
      (l) => (SHIP_CLASSES[l.cls]?.turrets.length ?? 0) > 0,
    ).length;
    expect(armed).toBeGreaterThan(0);
    expect(armed).toBeLessThan(FLEET_SIZE);
  });

  it("a ship flies its lane's altitude whenever it is up", () => {
    const a = blankPose();
    for (const s of fleet(11)) {
      for (let t = T0; t < T0 + 600_000; t += 7919) {
        expect(fleetPoseAt(s, t, a).y).toBe(FLEET_LANES[s.lane]?.alt);
      }
    }
  });
});

describe("no two hulls ever meet", () => {
  /** Margin between any two hulls' bounds, m. */
  const MARGIN = 3;

  it("the layers' altitude bands do not overlap", () => {
    const band = (layer: number) => {
      let lo = Number.POSITIVE_INFINITY;
      let hi = Number.NEGATIVE_INFINITY;
      for (const l of FLEET_LANES) {
        if (l.layer !== layer) continue;
        const r = SHIP_REACH[l.cls]?.y as number;
        lo = Math.min(lo, l.alt - r);
        hi = Math.max(hi, l.alt + r);
      }
      return { lo, hi };
    };
    expect(band(0).hi + MARGIN).toBeLessThanOrEqual(band(1).lo);
  });

  it("a layer's lanes are never closer across the heading than two beams", () => {
    for (const a of FLEET_LANES) {
      for (const b of FLEET_LANES) {
        if (a === b || a.layer !== b.layer) continue;
        const across = (FLEET_LAYERS[a.layer] as { across: number }).across;
        const raw = (((b.u - a.u) % across) + across) % across;
        const gap = Math.min(raw, across - raw);
        expect(gap).toBeGreaterThanOrEqual(
          (SHIP_REACH[a.cls]?.z as number) +
            (SHIP_REACH[b.cls]?.z as number) +
            MARGIN,
        );
      }
    }
  });

  it("over two hours of flight, no two hulls' bounds ever overlap", () => {
    const ships = fleet(23);
    const poses = ships.map(() => blankPose());
    for (let t = T0; t < T0 + 7_200_000; t += 1500) {
      ships.forEach((s, i) => fleetPoseAt(s, t, poses[i] as never));
      for (let i = 0; i < ships.length; i++) {
        const la = FLEET_LANES[ships[i]?.lane as number];
        const pa = poses[i];
        if (!la || !pa) throw new Error("no ship");
        const ra = SHIP_REACH[la.cls];
        if (!ra) throw new Error("no class");
        for (let j = i + 1; j < ships.length; j++) {
          const lb = FLEET_LANES[ships[j]?.lane as number];
          const pb = poses[j];
          if (!lb || !pb) throw new Error("no ship");
          const rb = SHIP_REACH[lb.cls];
          if (!rb) throw new Error("no class");
          const dy = Math.abs(pa.y - pb.y);
          if (dy >= ra.y + rb.y + MARGIN) continue;
          // Same layer, so the same heading line: their plan rectangles are
          // parallel. They overlap only if they do along AND across.
          const d = wrapDelta(pa, pb);
          const along = Math.abs(d.x * pa.hx + d.z * pa.hz);
          const across = Math.abs(-d.x * pa.hz + d.z * pa.hx);
          const overlap =
            along < ra.x + rb.x + MARGIN && across < ra.z + rb.z + MARGIN;
          expect(overlap).toBe(false);
        }
      }
    }
  });
});

describe("draw == collide, for every class", () => {
  const blank = (): MoverBox => ({
    x: 0,
    y: 0,
    z: 0,
    hx: 0,
    hy: 0,
    hz: 0,
    yaw: 0,
    kind: "boss",
    id: 0,
  });

  it("a flying hull is solid exactly inside its class's scaled parts", () => {
    for (const cls of CLASSES) {
      const s = ship({ lane: laneOf(cls) });
      const t = T0 + 40_000;
      const pose = fleetPoseAt(s, t, blankPose());
      // The class's parts as yaw-only boxes in the world (pitch 0 in
      // flight): an independent placement of the same shapes.
      const parts = SHIP_PARTS[cls] as readonly BossPart[];
      const boxes = parts.map((p) => {
        const b = blank();
        const c = Math.cos(pose.yaw);
        const sn = Math.sin(pose.yaw);
        b.x = (pose.x + p.x * c + p.z * sn + WORLD_SIZE) % WORLD_SIZE;
        b.y = pose.y + p.y;
        b.z = (pose.z - p.x * sn + p.z * c + WORLD_SIZE) % WORLD_SIZE;
        b.hx = p.hx;
        b.hy = p.hy;
        b.hz = p.hz;
        b.yaw = pose.yaw;
        return b;
      });
      const reach = SHIP_REACH[cls];
      if (!reach) throw new Error("no class");
      const rand = mulberry32(17 + cls);
      let hits = 0;
      for (let n = 0; n < 3000; n++) {
        const p: Vec3 = {
          x: pose.x + (rand() * 2 - 1) * reach.x,
          y: pose.y + (rand() * 2 - 1) * reach.y,
          z: pose.z + (rand() * 2 - 1) * reach.x,
        };
        const drawn = boxes.some(
          (b, i) =>
            sphereHitsBox(b, p, 2) &&
            bossPartSdfAt(parts[i] as BossPart, b, p) <= 2,
        );
        const solid = collideBoss(slotOf(s), p, 2, t);
        expect(solid !== null).toBe(drawn);
        if (solid) {
          hits++;
          expect(solid).toEqual({ kind: "boss", id: s.id });
        }
      }
      expect(hits).toBeGreaterThan(150);
    }
  });

  it("a falling hull is solid exactly where its pitched shape is", () => {
    const city = generateCity(CITY_SEED);
    const world = { buildings: city, index: buildCityIndex(city) };
    for (const cls of CLASSES) {
      const s = ship({ lane: laneOf(cls) });
      const down = shipCrash(s, T0 + 30_000, world);
      const fell: FleetShip = { ...s, down };
      const t = down.t + down.end * 0.6;
      const pose = fleetPoseAt(fell, t, blankPose());
      expect(pose.pitch).toBeLessThan(-0.2);
      // An independent inverse: the transpose of Ry(yaw)·Rz(pitch).
      const cy = Math.cos(pose.yaw);
      const sy = Math.sin(pose.yaw);
      const cp = Math.cos(pose.pitch);
      const sp = Math.sin(pose.pitch);
      const R = [
        [cy * cp, -cy * sp, sy],
        [sp, cp, 0],
        [-sy * cp, sy * sp, cy],
      ];
      const reach = SHIP_REACH[cls];
      if (!reach) throw new Error("no class");
      const rand = mulberry32(5 + cls);
      let hits = 0;
      for (let n = 0; n < 3000; n++) {
        const d = {
          x: (rand() * 2 - 1) * reach.x,
          y: (rand() * 2 - 1) * reach.x * 0.6,
          z: (rand() * 2 - 1) * reach.z * 1.5,
        };
        const l = {
          x:
            (R[0]?.[0] as number) * d.x +
            (R[1]?.[0] as number) * d.y +
            (R[2]?.[0] as number) * d.z,
          y:
            (R[0]?.[1] as number) * d.x +
            (R[1]?.[1] as number) * d.y +
            (R[2]?.[1] as number) * d.z,
          z:
            (R[0]?.[2] as number) * d.x +
            (R[1]?.[2] as number) * d.y +
            (R[2]?.[2] as number) * d.z,
        };
        const p = {
          x: (pose.x + d.x + WORLD_SIZE) % WORLD_SIZE,
          y: pose.y + d.y,
          z: (pose.z + d.z + WORLD_SIZE) % WORLD_SIZE,
        };
        const drawn = shipSdf(cls, l) <= 0.5;
        const solid = collideBoss(slotOf(fell), p, 0.5, t);
        // The SDF of the union is exact at its zero set; a hair's slack
        // for the boxes' corners (their distance is exact too).
        if (Math.abs(shipSdf(cls, l) - 0.5) < 1e-6) continue;
        expect(solid !== null).toBe(drawn);
        if (solid) {
          hits++;
          expect(solid.kind).toBe("bossDebris");
        }
      }
      expect(hits).toBeGreaterThan(100);
      // Gone once it landed.
      expect(
        collideBoss(slotOf(fell), down.at, 30, down.t + down.end + 1),
      ).toBeNull();
    }
  });

  it("the ship frame's inverse is its inverse", () => {
    const pose = {
      ...blankPose(),
      x: 1999,
      y: 580,
      z: 3,
      yaw: 2.3,
      pitch: -0.4,
    };
    const l = shipLocalInto(pose, 12, -7, 30, { x: 0, y: 0, z: 0 });
    expect(Math.hypot(l.x, l.y, l.z)).toBeCloseTo(Math.hypot(12, -7, 30), 9);
  });
});

describe("hits are judged on the round's line", () => {
  for (const cls of CLASSES) {
    const s = ship({ lane: laneOf(cls) });
    const t = T0 + 20_000;
    const pose = fleetPoseAt(s, t, blankPose());

    it(`class ${cls}: a round straight at an engine car from below hits it`, () => {
      for (let k = 0; k < 4; k++) {
        const wp = weakPointInto(pose, cls, k, { x: 0, y: 0, z: 0 });
        const from = { x: wp.x + 15, y: wp.y - 150, z: wp.z + 10 };
        const dir = toward(from, wp);
        expect(shipHitValid(pose, cls, k, from, dir)).toBe(true);
        expect(shipHitValid(pose, cls, -1, from, dir)).toBe(true);
        expect(shipHitValid(pose, cls, (k + 1) % 4, from, dir)).toBe(false);
      }
    });

    it(`class ${cls}: the envelope stops a round meant for the far cell`, () => {
      // The starboard cell (k 4) from far off to port, through the hull.
      const cell = weakPointInto(pose, cls, 4, { x: 0, y: 0, z: 0 });
      const c = Math.cos(pose.yaw);
      const sn = Math.sin(pose.yaw);
      const from = { x: cell.x - sn * 200, y: cell.y, z: cell.z - c * 200 };
      const dir = toward(from, cell);
      expect(shipRayHit(pose, cls, from, dir, 400)?.weak).toBe(-1);
      expect(shipHitValid(pose, cls, 4, from, dir)).toBe(false);
      // ...but it is a hull hit.
      expect(shipHitValid(pose, cls, -1, from, dir)).toBe(true);
      const near = { x: cell.x + sn * 120, y: cell.y, z: cell.z + c * 120 };
      expect(shipHitValid(pose, cls, 4, near, toward(near, cell))).toBe(true);
    });

    it(`class ${cls}: a miss is a miss`, () => {
      const wp = weakPointInto(pose, cls, 0, { x: 0, y: 0, z: 0 });
      const from = { x: wp.x + 15, y: wp.y - 150, z: wp.z + 10 };
      const off = toward(from, { x: wp.x + 200, y: wp.y, z: wp.z + 200 });
      expect(shipHitValid(pose, cls, 0, from, off)).toBe(false);
      expect(shipHitValid(pose, cls, -1, from, off)).toBe(false);
      expect(shipHitValid(pose, cls, 99, from, toward(from, wp))).toBe(false);
    });
  }

  it("credit splits by damage; the top dealer leads; a scratch earns nothing", () => {
    const credit = bossCredit(
      new Map([
        ["b", 300],
        ["a", 300],
        ["c", 50],
        ["d", 7],
        ["z", 0],
      ]),
    );
    expect(credit.dealers.map((d) => d.id)).toEqual(["a", "b", "c", "d"]);
    expect(credit.top).toBe("a");
    expect(credit.dealers.reduce((s, d) => s + d.share, 0)).toBeCloseTo(1, 12);
    expect(credit.credited).toEqual(["a", "b"]);
    expect(bossCredit(new Map()).top).toBeNull();
  });
});

describe("a downed ship crashes on the D4 wreck path", () => {
  const city = generateCity(CITY_SEED);
  const world = { buildings: city, index: buildCityIndex(city) };

  it("leaves from where it flew, nose dropping, its centre on wreckPosAt", () => {
    for (const s of fleet(31)) {
      const t = T0 + 45_000;
      const flying = fleetPoseAt(s, t, blankPose());
      const down = shipCrash(s, t, world);
      expect(down).toEqual(shipCrash({ ...s }, t, world));
      const fell = { ...s, down };
      const at0 = fleetPoseAt(fell, t, blankPose());
      expect(wrapDistance(at0, flying)).toBeLessThan(1e-9);
      expect(at0.yaw).toBeCloseTo(flying.yaw, 12);
      expect(at0.pitch).toBe(-0);
      let pitch = 0;
      for (let ms = 0; ms <= down.end; ms += 250) {
        const p = fleetPoseAt(fell, t + ms, blankPose());
        const w = wreckPosAt(down, t + ms, { x: 0, y: 0, z: 0 });
        expect([p.x, p.y, p.z]).toEqual([w.x, w.y, w.z]);
        expect(p.pitch).toBeLessThanOrEqual(pitch);
        pitch = p.pitch;
      }
      expect(down.end).toBeGreaterThan(0);
      expect(down.end).toBeLessThan(WRECK_MAX_MS);
      expect(["city", "ground", "river"]).toContain(down.hit);
      expect(shipPresent(fell, t)).toBe(false);
      expect(shipPresent(fell, t - 1)).toBe(true);
      const last = fallPoseInto(down, t + down.end, blankPose());
      expect(
        wrapDistance({ ...last, y: 0 }, { ...down.at, y: 0 }),
      ).toBeLessThan(
        (SHIP_REACH[FLEET_LANES[s.lane]?.cls as ShipClassId]?.x as number) + 1,
      );
    }
  });
});

describe("turret fire is fair", () => {
  const muzzle: Vec3 = { x: 500, y: 270, z: 500 };
  const still = (dx: number, dy: number, dz: number) => ({
    pos: { x: 500 + dx, y: 270 + dy, z: 500 + dz },
    vel: { x: 0, y: 0, z: 0 },
  });

  it("holds the bots' caps: reaction, jitter, never one-shot", () => {
    expect(BOSS_FLAK_REACTION_MS).toBeGreaterThanOrEqual(BOT_REACTION_MS);
    expect(BOSS_FLAK_JITTER).toBeGreaterThanOrEqual(BOT_AIM_JITTER);
    expect(BOSS_FLAK_MIN_FUSE_MS).toBeGreaterThanOrEqual(1200);
    expect(BOSS_FLAK_DAMAGE_R).toBeLessThan(BOSS_FLAK_BURST_R);
    for (let d = 0; d < 20; d += 0.25) {
      expect(flakDamage(d)).toBeLessThanOrEqual(MAX_HP / 4);
    }
    expect(flakDamage(BOSS_FLAK_DAMAGE_R)).toBe(0);
  });

  it("only inside its range and traverse — a level flank is a blind band", () => {
    const ventral = -1 as const;
    expect(
      flakSolution(muzzle, ventral, still(0, -200, 50), () => 0.5),
    ).not.toBeNull();
    expect(
      flakSolution(
        muzzle,
        ventral,
        still(0, -BOSS_FLAK_RANGE - 5, 0),
        () => 0.5,
      ),
    ).toBeNull();
    expect(
      flakSolution(
        muzzle,
        ventral,
        still(0, -BOSS_FLAK_MIN_RANGE + 5, 0),
        () => 0.5,
      ),
    ).toBeNull();
    const level = Math.tan(Math.PI / 2 - BOSS_FLAK_CONE) * 300 * 0.5;
    expect(
      flakSolution(muzzle, ventral, still(300, -level, 0), () => 0.5),
    ).toBeNull();
    expect(
      flakSolution(muzzle, ventral, still(0, 200, 0), () => 0.5),
    ).toBeNull();
    expect(flakSolution(muzzle, 1, still(0, 200, 0), () => 0.5)).not.toBeNull();
  });

  it("wanders no further than BOSS_FLAK_JITTER and never fuses short", () => {
    const target = {
      pos: { x: 700, y: 120, z: 560 },
      vel: { x: -40, y: 0, z: 55 },
    };
    const exact = flakSolution(muzzle, -1, target, () => 0);
    if (!exact) throw new Error("no solution");
    const aim = wrapDelta(muzzle, exact.to);
    const rand = mulberry32(4);
    for (let n = 0; n < 500; n++) {
      const s = flakSolution(muzzle, -1, target, rand);
      if (!s) throw new Error("no solution");
      expect(s.fuse).toBe(exact.fuse);
      expect(s.fuse).toBeGreaterThanOrEqual(BOSS_FLAK_MIN_FUSE_MS);
      const d = wrapDelta(muzzle, s.to);
      const cos =
        (d.x * aim.x + d.y * aim.y + d.z * aim.z) /
        (Math.hypot(d.x, d.y, d.z) * Math.hypot(aim.x, aim.y, aim.z));
      expect(Math.acos(Math.min(1, cos))).toBeLessThanOrEqual(
        BOSS_FLAK_JITTER + 1e-3,
      );
    }
  });

  it("is beatable: a plane that flies on is hit, one that jinks is not", () => {
    const vel = { x: 60, y: 0, z: 0 };
    const target = { pos: { x: 600, y: 80, z: 650 }, vel };
    const s = flakSolution(muzzle, -1, target, () => 0);
    if (!s) throw new Error("no solution");
    const t = s.fuse / 1000;
    const straight = {
      x: target.pos.x + vel.x * t,
      y: target.pos.y,
      z: target.pos.z,
    };
    expect(flakDamage(wrapDistance(straight, s.to))).toBeGreaterThan(0);
    const broke = {
      x: target.pos.x,
      y: target.pos.y,
      z: target.pos.z - 60 * t,
    };
    expect(flakDamage(wrapDistance(broke, s.to))).toBe(0);
  });

  it("shells survive the wire exactly and fly muzzle to burst", () => {
    const f: BossFlak = {
      id: 9,
      from: { x: 1998.4, y: 571.2, z: 3.3 },
      to: { x: 1.2, y: 333.4, z: 1999.9 },
      t0: T0,
      fuse: 1400,
    };
    expect(decodeFlak(encodeFlak(f))).toEqual(f);
    expect(decodeFlak([9, 1, 2, 3, T0, 1400])).toBeNull();
    expect(
      wrapDistance(flakPosAt(f, T0 - 10, { x: 0, y: 0, z: 0 }), f.from),
    ).toBeLessThan(1e-9);
    expect(
      wrapDistance(flakPosAt(f, T0 + 1400, { x: 0, y: 0, z: 0 }), f.to),
    ).toBeLessThan(1e-9);
    // Across the seam the straight way, never the long way round.
    const mid = flakPosAt(f, T0 + 700, { x: 0, y: 0, z: 0 });
    expect(wrapDistance(mid, f.from)).toBeLessThan(wrapDistance(f.from, f.to));
  });

  it("muzzles of every armed class sit outside the envelope, on its faces", () => {
    for (const cls of CLASSES) {
      const pose = fleetPoseAt(ship({ lane: laneOf(cls) }), T0, blankPose());
      for (const k of SHIP_CLASSES[cls]?.turrets ?? []) {
        const m = turretMuzzleInto(pose, cls, k, { x: 0, y: 0, z: 0 });
        const up = (BOSS_TURRETS[k] as { up: number }).up;
        expect(up * (m.y - pose.y)).toBeGreaterThan(
          18 * (SHIP_CLASSES[cls]?.sr as number),
        );
        const d = wrapDelta(pose, m);
        const l = shipLocalInto(pose, d.x, d.y, d.z, { x: 0, y: 0, z: 0 });
        expect(shipSdf(cls, l)).toBeGreaterThanOrEqual(-1e-9);
      }
    }
  });
});

describe("launches and spawns", () => {
  it("a launch releases under the belly or off the deck, clear of the hull", () => {
    for (const cls of CLASSES) {
      const s = ship({ lane: laneOf(cls) });
      for (const kind of SHIP_CLASSES[cls]?.rigs ?? []) {
        const l = { id: 1, ship: s.id, kind, t0: T0 + 1000 };
        const sp = launchSpawnAt(s, l);
        const pose = fleetPoseAt(s, launchReleaseAt(l), blankPose());
        if (kind === LAUNCH_BELLY) expect(sp.pos.y).toBeLessThan(pose.y);
        if (kind === LAUNCH_CATAPULT) expect(sp.pos.y).toBeGreaterThan(pose.y);
        const d = wrapDelta(pose, sp.pos);
        const loc = shipLocalInto(pose, d.x, d.y, d.z, { x: 0, y: 0, z: 0 });
        expect(shipSdf(cls, loc)).toBeGreaterThan(0.5);
        // Flying the ship's way (flight yaw 0 faces −Z).
        expect(
          -Math.sin(sp.yaw) * pose.hx - Math.cos(sp.yaw) * pose.hz,
        ).toBeCloseTo(1, 9);
      }
    }
    expect(SHIP_CLASSES[0]?.rigs).not.toContain(LAUNCH_CATAPULT);
  });

  it("vetoes a spawn whose run-out flies into a hull", () => {
    const s = ship();
    const t = T0 + 9000;
    const pose = fleetPoseAt(s, t, blankPose());
    const at = {
      x: pose.x + pose.hx * 250,
      y: pose.y,
      z: pose.z + pose.hz * 250,
    };
    const yawAt = Math.atan2(pose.hx, pose.hz);
    expect(bossSpawnClear(slotOf(s), at, yawAt, RESPAWN_SPEED, t)).toBe(false);
    expect(
      bossSpawnClear(slotOf(s), at, yawAt + Math.PI, RESPAWN_SPEED, t),
    ).toBe(true);
    expect(bossSpawnClear(slotOf(), at, yawAt, RESPAWN_SPEED, t)).toBe(true);
    expect(bossSpawnClear(slotOf(s), at, null, RESPAWN_SPEED, t)).toBe(false);
  });

  it("a new ship comes on out of sight of the humans", () => {
    const humans = [
      { x: 300, y: 200, z: 300 },
      { x: 1500, y: 300, z: 900 },
    ];
    for (let lane = 0; lane < FLEET_SIZE; lane++) {
      const spot = hiddenLaneSpot(lane, humans, 0.37);
      const pose = fleetPoseAt(ship({ lane, s0: spot.s0 }), T0, blankPose());
      for (const h of humans) {
        expect(
          wrapDistance({ ...h, y: 0 }, { ...pose, y: 0 }),
        ).toBeGreaterThanOrEqual(Math.min(spot.clear, FLEET_HIDE_M) - 0.2);
      }
    }
    expect(hiddenLaneSpot(0, [], 0).clear).toBe(Number.POSITIVE_INFINITY);
  });

  it("a welcome's fleet installs exactly", () => {
    const city = generateCity(CITY_SEED);
    const ships = fleet(2);
    const first = ships[0] as FleetShip;
    first.down = shipCrash(first, T0 + 1000, { buildings: city });
    const slot = slotOf();
    const hp = applyFleetState(slot, {
      s: ships.map(encodeShip),
      hp: ships.map((s, i) => (i === 0 ? 0 : s.hp0 - i)),
      d: ships.map((s) => s.down),
      l: [encodeLaunch({ id: 4, ship: 2, kind: LAUNCH_BELLY, t0: T0 })],
    });
    expect(slot.ships).toEqual(ships);
    expect(hp.get(first.id)).toBe(0);
    expect(hp.get(3)).toBe((ships[2] as FleetShip).hp0 - 2);
    expect(slot.launches).toHaveLength(1);
    expect(applyFleetState(slot, null).size).toBe(0);
    expect(slot.ships).toHaveLength(0);
  });

  it("weak points are parts of the hull, turrets too", () => {
    for (const i of BOSS_WEAK_POINTS) {
      expect(["engine", "cell"]).toContain(BOSS_PARTS[i]?.kind);
    }
    for (const { part } of BOSS_TURRETS) {
      expect(BOSS_PARTS[part]?.kind).toBe("turret");
    }
  });
});
