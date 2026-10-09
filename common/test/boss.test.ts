// S4 sky boss — the pure model (common/src/boss.ts): the schedule and the
// path are pure; the hull a renderer draws is the hull everything collides
// with; turret fire is held to the bots' fairness caps; a weak-point hit is
// judged on the round's line; credit splits by damage; and the break-up
// falls on the D4 wreck path.

import {
  BOSS_ALT,
  BOSS_FAST_TUNING,
  BOSS_FLAK_BURST_R,
  BOSS_FLAK_CONE,
  BOSS_FLAK_DAMAGE_R,
  BOSS_FLAK_JITTER,
  BOSS_FLAK_MIN_FUSE_MS,
  BOSS_FLAK_MIN_RANGE,
  BOSS_FLAK_RANGE,
  BOSS_FLAK_REACTION_MS,
  BOSS_ORBIT_R,
  BOSS_PARTS,
  BOSS_PIECES,
  BOSS_REACH_X,
  BOSS_REACH_Y,
  BOSS_REACH_Z,
  BOSS_SPEED,
  BOSS_TUNING,
  BOSS_TURRETS,
  BOSS_WEAK_POINTS,
  type BossRaid,
  type BossSlot,
  PIECE_PARTS,
  blankPose,
  bossCredit,
  bossHitValid,
  bossPartBoxInto,
  bossPiecePartBoxInto,
  bossPoseAt,
  bossPresent,
  bossRayHit,
  bossSpawnClear,
  breakUp,
  collideBoss,
  decodeFlak,
  decodeRaid,
  encodeFlak,
  encodeRaid,
  flakDamage,
  flakSolution,
  nextRaidAt,
  piecePoseAt,
  planRaid,
  raidEgressAt,
  raidEnd,
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
  HELI_ALT_MAX,
  HELI_HULL,
  MAX_HP,
  NEWS_HELI_ALT_MIN,
  RESPAWN_SPEED,
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
const raid = (over: Partial<BossRaid> = {}): BossRaid => ({
  id: 3,
  t0: T0,
  cx: 1000,
  cz: 1000,
  th0: 0.7,
  orbitMs: 300_000,
  hpScale: 1,
  ...over,
});
const midOrbit = (r: BossRaid) => r.t0 + 60_000;
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

describe("schedule and path are pure", () => {
  it("nextRaidAt: the first raid after a human arrives, then every period", () => {
    const first = nextRaidAt(null, T0, mulberry32(9));
    expect(first).toBe(nextRaidAt(null, T0, mulberry32(9)));
    expect(first - T0).toBeGreaterThanOrEqual(BOSS_TUNING.firstMinMs);
    expect(first - T0).toBeLessThanOrEqual(BOSS_TUNING.firstMaxMs);
    for (let i = 0; i < 50; i++) {
      const next = nextRaidAt(first, T0, mulberry32(i));
      expect(Math.abs(next - first - BOSS_TUNING.periodMs)).toBeLessThanOrEqual(
        BOSS_TUNING.periodJitterMs,
      );
      expect(Number.isInteger(next)).toBe(true);
    }
    // ~15 minutes, start to start.
    expect(BOSS_TUNING.periodMs).toBe(15 * 60_000);
    // The QA schedule is only ever faster.
    expect(BOSS_FAST_TUNING.firstMaxMs).toBeLessThan(BOSS_TUNING.firstMinMs);
  });

  it("planRaid is deterministic and survives the wire bit for bit", () => {
    const a = planRaid(mulberry32(5), 7, T0 + 0.4);
    expect(a).toEqual(planRaid(mulberry32(5), 7, T0 + 0.4));
    expect(decodeRaid(encodeRaid(a))).toEqual(a);
    expect(encodeRaid(a).every(Number.isInteger)).toBe(true);
    expect(decodeRaid([1, 2, 3])).toBeNull();
    expect(decodeRaid([1, 2, 3, 4, 5, Number.NaN, 7])).toBeNull();
  });

  it("bossPoseAt is a pure function of (raid, time)", () => {
    const r = raid();
    for (const t of [T0, T0 + 12_345, midOrbit(r), raidEgressAt(r) + 9000]) {
      expect(bossPoseAt(r, t, blankPose())).toEqual(
        bossPoseAt({ ...r }, t, blankPose()),
      );
    }
  });

  it("flies at BOSS_SPEED along a C1 path: run-in, orbit, run-out", () => {
    const r = raid();
    const a = blankPose();
    const b = blankPose();
    const end = raidEnd(r);
    for (let t = r.t0; t < end - 1000; t += 997) {
      bossPoseAt(r, t, a);
      bossPoseAt(r, t + 1000, b);
      const d = wrapDistance(a, b);
      // A chord of the orbit is a hair shorter than the arc.
      expect(d).toBeGreaterThan(BOSS_SPEED * 0.995);
      expect(d).toBeLessThanOrEqual(BOSS_SPEED + 1e-6);
      expect(a.y).toBe(BOSS_ALT);
      // The heading turns smoothly: no corner anywhere on the path.
      expect(a.hx * b.hx + a.hz * b.hz).toBeGreaterThan(Math.cos(0.05));
      // Box yaw and heading agree (local +X = world (cos yaw, −sin yaw)).
      expect(Math.cos(a.yaw)).toBeCloseTo(a.hx, 9);
      expect(-Math.sin(a.yaw)).toBeCloseTo(a.hz, 9);
    }
    // On station it circles the raid's centre at BOSS_ORBIT_R.
    const p = bossPoseAt(r, midOrbit(r), a);
    const off = wrapDelta({ x: r.cx, y: 0, z: r.cz }, { x: p.x, y: 0, z: p.z });
    expect(Math.hypot(off.x, off.z)).toBeCloseTo(BOSS_ORBIT_R, 6);
  });

  it("is in the air only between t0 and the end of its run-out", () => {
    const r = raid();
    const slot: BossSlot = { raid: r, down: null };
    expect(bossPresent(slot, r.t0 - 1)).toBe(false);
    expect(bossPresent(slot, r.t0)).toBe(true);
    expect(bossPresent(slot, raidEnd(r) - 1)).toBe(true);
    expect(bossPresent(slot, raidEnd(r))).toBe(false);
  });

  it("stacks: over every roof and heli, under the news heli, blimp and cloud deck", () => {
    let top = Number.NEGATIVE_INFINITY;
    let bottom = Number.POSITIVE_INFINITY;
    for (const p of BOSS_PARTS) {
      top = Math.max(top, BOSS_ALT + p.y + p.hy);
      bottom = Math.min(bottom, BOSS_ALT + p.y - p.hy);
      // The reject bounds really bound every part.
      expect(Math.abs(p.x) + p.hx).toBeLessThanOrEqual(BOSS_REACH_X);
      expect(Math.abs(p.y) + p.hy).toBeLessThanOrEqual(BOSS_REACH_Y);
      expect(Math.abs(p.z) + p.hz).toBeLessThanOrEqual(BOSS_REACH_Z);
    }
    const city = generateCity(CITY_SEED);
    let roofs = 0;
    for (const b of city) {
      roofs = Math.max(roofs, b.height);
      for (const s of roofStructuresFor(b)) {
        roofs = Math.max(roofs, s.baseY + s.height);
      }
    }
    expect(bottom).toBeGreaterThan(roofs + 15);
    expect(bottom).toBeGreaterThan(HELI_ALT_MAX + (HELI_HULL[1] as number));
    expect(top).toBeLessThan(NEWS_HELI_ALT_MIN - (HELI_HULL[1] as number));
    expect(top).toBeLessThan(BLIMP_ALT - (BLIMP_HULL[1] as number));
    expect(top).toBeLessThan(CLOUD_BASE);
    // "Several times the blimp's size."
    expect(BOSS_REACH_X).toBeGreaterThan(2.5 * (BLIMP_HULL[0] as number));
  });
});

describe("draw == collide for the hull", () => {
  const r = raid();
  const slot: BossSlot = { raid: r, down: null };
  const t = midOrbit(r);
  const pose = bossPoseAt(r, t, blankPose());
  const boxes = BOSS_PARTS.map((_, i) => bossPartBoxInto(pose, i, blank()));

  it("solid exactly inside the boxes the renderer instances", () => {
    const rand = mulberry32(17);
    let hits = 0;
    for (let n = 0; n < 4000; n++) {
      const p: Vec3 = {
        x: pose.x + (rand() * 2 - 1) * 150,
        y: pose.y + (rand() * 2 - 1) * 45,
        z: pose.z + (rand() * 2 - 1) * 150,
      };
      const drawn = boxes.some((b) => sphereHitsBox(b, p, 2));
      const solid = collideBoss(slot, p, 2, t) !== null;
      expect(solid).toBe(drawn);
      if (solid) hits++;
    }
    expect(hits).toBeGreaterThan(200);
  });

  it("every box centre is solid; just past every face is not", () => {
    for (const b of boxes) {
      expect(collideBoss(slot, b, 0.1, t)?.kind).toBe("boss");
    }
    // Straight above the dorsal fin's top face, clear of everything.
    const fin = boxes[5] as MoverBox;
    expect(
      collideBoss(slot, { ...fin, y: fin.y + fin.hy + 0.6 }, 0.5, t),
    ).toBeNull();
    expect(
      collideBoss(slot, { ...fin, y: fin.y + fin.hy - 0.4 }, 0.5, t),
    ).not.toBeNull();
  });

  it("weak points and turrets are boxes of the hull, not extra geometry", () => {
    for (const i of BOSS_WEAK_POINTS) {
      expect(["engine", "cell"]).toContain(BOSS_PARTS[i]?.kind);
    }
    for (const { part } of BOSS_TURRETS) {
      expect(BOSS_PARTS[part]?.kind).toBe("turret");
    }
    // Each section's parts partition the hull.
    expect(PIECE_PARTS.flat().sort((a, b) => a - b)).toEqual(
      BOSS_PARTS.map((_, i) => i),
    );
  });

  it("the falling sections start as the hull and stay yaw-only boxes", () => {
    const city = generateCity(CITY_SEED);
    const down = breakUp(r, t, {
      buildings: city,
      index: buildCityIndex(city),
    });
    for (const piece of down.pieces) {
      const at0 = piecePoseAt(piece, down.t, piece.end, down.t, blankPose());
      for (const i of PIECE_PARTS[piece.k] as number[]) {
        const fall = bossPiecePartBoxInto(piece, at0, i, blank());
        const whole = boxes[i] as MoverBox;
        expect(wrapDistance(fall, whole)).toBeLessThan(1e-6);
        expect(fall.yaw).toBeCloseTo(whole.yaw, 12);
        expect([fall.hx, fall.hy, fall.hz]).toEqual([
          whole.hx,
          whole.hy,
          whole.hz,
        ]);
      }
    }
    // Mid-fall: solid exactly where a section's boxes are drawn.
    const fallSlot: BossSlot = { raid: r, down };
    const piece = down.pieces[1];
    if (!piece) throw new Error("no mid section");
    const ms = down.t + piece.end / 2;
    const pose2 = piecePoseAt(piece, down.t, piece.end, ms, blankPose());
    for (const i of PIECE_PARTS[1] as number[]) {
      const b = bossPiecePartBoxInto(piece, pose2, i, blank());
      expect(collideBoss(fallSlot, b, 0.1, ms)?.kind).toBe("bossDebris");
    }
    // The intact hull is gone the instant it breaks; a landed section too.
    expect(
      collideBoss(fallSlot, boxes[0] as MoverBox, 0.1, down.t + 1)?.kind,
    ).not.toBe("boss");
    const gone = Math.max(...down.pieces.map((p) => p.end));
    for (const b of boxes) {
      expect(collideBoss(fallSlot, b, 0.1, down.t + gone + 1)).toBeNull();
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
    // Level with the turret: outside its cone (and so is anything above).
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
    // The same plane turning onto −Z the moment the shell leaves (a 90°
    // break at its speed) is long gone when it bursts.
    const broke = {
      x: target.pos.x,
      y: target.pos.y,
      z: target.pos.z - 60 * t,
    };
    expect(flakDamage(wrapDistance(broke, s.to))).toBe(0);
  });

  it("shells survive the wire exactly", () => {
    const f = {
      id: 9,
      turret: 3,
      to: { x: 1.2, y: 33.4, z: 1999.9 },
      t0: T0,
      fuse: 1400,
    };
    expect(decodeFlak(encodeFlak(f))).toEqual(f);
    expect(decodeFlak([9, 99, 1, 2, 3, T0, 1400])).toBeNull();
  });
});

describe("weak-point hit validation and the credit split", () => {
  const r = raid();
  const t = midOrbit(r);
  const pose = bossPoseAt(r, t, blankPose());
  const alive = BOSS_WEAK_POINTS.map(() => true);
  const toward = (from: Vec3, to: Vec3): Vec3 => {
    const d = wrapDelta(from, to);
    const len = Math.hypot(d.x, d.y, d.z);
    return { x: d.x / len, y: d.y / len, z: d.z / len };
  };

  it("a round straight at a live engine from below hits it", () => {
    for (let k = 0; k < 4; k++) {
      const wp = weakPointInto(pose, k, { x: 0, y: 0, z: 0 });
      const from = { x: wp.x + 15, y: wp.y - 150, z: wp.z + 10 };
      expect(bossHitValid(pose, k, from, toward(from, wp), alive)).toBe(true);
      // ...but not as a claim on another weak point, or once it is spent.
      expect(
        bossHitValid(pose, (k + 1) % 4, from, toward(from, wp), alive),
      ).toBe(false);
      const spent = alive.map((v, i) => i !== k && v);
      expect(bossHitValid(pose, k, from, toward(from, wp), spent)).toBe(false);
    }
  });

  it("armour stops a round: a cell can't be hit through the hull", () => {
    // The starboard cell (k 4) from far off to port, through the mid hull.
    const cell = weakPointInto(pose, 4, { x: 0, y: 0, z: 0 });
    const c = Math.cos(pose.yaw);
    const s = Math.sin(pose.yaw);
    // Hull-frame −Z (port) in world: (−sin yaw, −cos yaw)·… see placeLocal.
    const from = { x: cell.x - s * 200, y: cell.y, z: cell.z - c * 200 };
    const dir = toward(from, cell);
    expect(bossRayHit(pose, from, dir, 400, alive)?.weak).toBe(-1);
    expect(bossHitValid(pose, 4, from, dir, alive)).toBe(false);
    // From its own side it is open.
    const near = { x: cell.x + s * 120, y: cell.y, z: cell.z + c * 120 };
    expect(bossHitValid(pose, 4, near, toward(near, cell), alive)).toBe(true);
  });

  it("a miss is a miss", () => {
    const wp = weakPointInto(pose, 0, { x: 0, y: 0, z: 0 });
    const from = { x: wp.x + 15, y: wp.y - 150, z: wp.z + 10 };
    const off = toward(from, { x: wp.x + 60, y: wp.y, z: wp.z + 60 });
    expect(bossHitValid(pose, 0, from, off, alive)).toBe(false);
    expect(bossHitValid(pose, 99, from, toward(from, wp), alive)).toBe(false);
  });

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
    // 50 / 657 ≈ 7.6 % and 7 / 657 ≈ 1 %: under the 10 % bar.
    expect(credit.credited).toEqual(["a", "b"]);
    expect(bossCredit(new Map()).top).toBeNull();
  });
});

describe("the break-up falls on the D4 wreck path", () => {
  const city = generateCity(CITY_SEED);
  const world = { buildings: city, index: buildCityIndex(city) };
  const r = raid();
  const t = midOrbit(r);
  const down = breakUp(r, t, world);

  it("each section's anchor IS wreckPosAt of its params", () => {
    for (const piece of down.pieces) {
      const path = {
        p: piece.p,
        v: piece.v,
        t: down.t,
        spin: piece.spin,
        end: piece.end,
      };
      for (let ms = 0; ms <= piece.end; ms += 250) {
        const a = piecePoseAt(
          piece,
          down.t,
          piece.end,
          down.t + ms,
          blankPose(),
        );
        const w = wreckPosAt(path, down.t + ms, { x: 0, y: 0, z: 0 });
        expect(a.x).toBe(w.x);
        expect(a.y).toBe(w.y);
        expect(a.z).toBe(w.z);
      }
    }
  });

  it("comes down on the city, inside the D4 window, the same way every time", () => {
    expect(down).toEqual(breakUp({ ...r }, t, world));
    expect(down.pieces.map((p) => p.k)).toEqual([0, 1, 2]);
    for (const p of down.pieces) {
      expect(p.end).toBeGreaterThan(0);
      expect(p.end).toBeLessThan(WRECK_MAX_MS);
      expect(["city", "ground", "river"]).toContain(p.hit);
    }
  });

  it("starts each section from where it was on the hull", () => {
    const pose = bossPoseAt(r, t, blankPose());
    for (const piece of down.pieces) {
      const ax = (BOSS_PIECES[piece.k] as { ax: number }).ax;
      expect(piece.p.y).toBe(BOSS_ALT);
      const off = wrapDelta(pose, piece.p);
      expect(Math.hypot(off.x, off.z)).toBeCloseTo(Math.abs(ax), 6);
    }
  });
});

describe("respawns stay out of its way", () => {
  const r = raid();
  const slot: BossSlot = { raid: r, down: null };
  const t = midOrbit(r);
  const pose = bossPoseAt(r, t, blankPose());

  it("vetoes a spawn whose run-out flies into the hull", () => {
    // 200 m off the nose, at the hull's height, flying straight at it.
    const at = {
      x: pose.x + pose.hx * 330,
      y: BOSS_ALT,
      z: pose.z + pose.hz * 330,
    };
    const yawAt = Math.atan2(pose.hx, pose.hz); // fwd (−sin, −cos) = −heading
    expect(bossSpawnClear(slot, at, yawAt, RESPAWN_SPEED, t)).toBe(false);
    // The same spot flying away from it is clear.
    expect(bossSpawnClear(slot, at, yawAt + Math.PI, RESPAWN_SPEED, t)).toBe(
      true,
    );
    // No raid: everything is clear.
    expect(
      bossSpawnClear({ raid: null, down: null }, at, yawAt, RESPAWN_SPEED, t),
    ).toBe(true);
  });

  it("with no heading known, asks for the whole run-out disc", () => {
    const at = {
      x: pose.x + pose.hx * 400,
      y: BOSS_ALT,
      z: pose.z + pose.hz * 400,
    };
    expect(bossSpawnClear(slot, at, null, RESPAWN_SPEED, t)).toBe(false);
    const far = {
      x: pose.x + pose.hx * 950,
      y: BOSS_ALT,
      z: pose.z + pose.hz * 950,
    };
    expect(bossSpawnClear(slot, far, null, RESPAWN_SPEED, t)).toBe(true);
  });

  it("turret muzzles sit on the hull's outer faces", () => {
    for (let k = 0; k < BOSS_TURRETS.length; k++) {
      const m = turretMuzzleInto(pose, k, { x: 0, y: 0, z: 0 });
      const up = (BOSS_TURRETS[k] as { up: number }).up;
      expect(up * (m.y - BOSS_ALT)).toBeGreaterThan(25);
    }
  });
});
