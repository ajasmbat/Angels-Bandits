// E1 Air force, the pure half of the squadrons (common/src/squadron.ts):
//
//  - slot keeping: every wingman sits on its slot off the anchor's level
//    frame, never under the anchor, and a wire row expands into exactly the
//    poses the server flies (ids counted up from slot 0's);
//  - 500 planes in 63 squadrons fly ten minutes over the real city on its
//    roofline grid without one plane touching a building (the full
//    collision test the planes are never flown against), low among the
//    towers and under the bands derived from the ceilings;
//  - promote / demote hysteresis: a plane changes tier once on the way in
//    and once on the way out, however its distance wobbles, the cap holds,
//    and a visible ace is never handed back;
//  - the guns' forward cone.

import { generateCity, mulberry32 } from "@angels-bandits/common/city";
import { generateMovers } from "@angels-bandits/common/city/movers";
import { buildCityIndex, collideCity } from "@angels-bandits/common/collision";
import {
  BOT_CEILING_ALT,
  CITY_SEED,
  PLAYER_RADIUS,
  SOFT_CEILING,
  WORLD_SIZE,
} from "@angels-bandits/common/constants";
import type { Pose } from "@angels-bandits/common/protocol";
import {
  ACE_MAX,
  ACE_MIN,
  type AceCandidate,
  DEMOTE_M,
  FORMATIONS,
  FORM_REACH,
  PLAN_ESCORT,
  PLAN_LANE,
  PLAN_STREAM,
  PROMOTE_M,
  RooflineGrid,
  SQUAD_ALT_MAX,
  SQUAD_CRUISE_CAP,
  SQUAD_FIRE_RANGE,
  SQUAD_FLOOR_ALT,
  SQUAD_SIZE,
  type SquadAnchor,
  type SquadPlan,
  aceCap,
  attitudeQuatInto,
  chooseAces,
  craneColumns,
  decodeSquadRow,
  encodeSquadRow,
  expandSquadRow,
  floorAhead,
  isSquadRow,
  planYaw,
  quatYaw,
  slotPoseInto,
  squadInCone,
  squadMemberId,
  stepAnchor,
} from "@angels-bandits/common/squadron";
import { wrapDelta } from "@angels-bandits/common/world";
import { beforeAll, describe, expect, it } from "vitest";

const pose = (): Pose => ({
  pos: { x: 0, y: 0, z: 0 },
  quat: { x: 0, y: 0, z: 0, w: 1 },
  speed: 0,
});

function anchorPose(x: number, y: number, z: number, yaw: number): Pose {
  const p = pose();
  p.pos = { x, y, z };
  attitudeQuatInto(yaw, 0.1, -0.3, p.quat);
  p.speed = 72;
  return p;
}

describe("E1 squadrons: slot keeping", () => {
  it("holds every slot at its offset in the anchor's level frame, whatever the heading, never under the anchor", () => {
    for (let form = 0; form < FORMATIONS.length; form++) {
      const slots = FORMATIONS[form] as (typeof FORMATIONS)[number];
      expect(slots).toHaveLength(SQUAD_SIZE);
      for (const yaw of [0, 0.7, -2.1, Math.PI]) {
        const a = anchorPose(1000, 300, 1000, yaw);
        // The heading the slots turn with is the pose's own.
        expect(Math.cos(quatYaw(a.quat) - yaw)).toBeCloseTo(1, 9);
        for (let k = 0; k < SQUAD_SIZE; k++) {
          const sl = slots[k] as { r: number; u: number; b: number };
          const p = slotPoseInto(a, form, k, 1, pose());
          const d = wrapDelta(a.pos, p.pos);
          expect(Math.hypot(d.x, d.z)).toBeCloseTo(Math.hypot(sl.r, sl.b), 6);
          expect(Math.hypot(d.x, d.z)).toBeLessThanOrEqual(FORM_REACH + 1e-9);
          expect(d.y).toBeCloseTo(sl.u, 9);
          expect(d.y).toBeGreaterThanOrEqual(0);
          // Behind is behind: the slot's back offset is against the nose.
          const fx = -Math.sin(yaw);
          const fz = -Math.cos(yaw);
          expect(-(d.x * fx + d.z * fz)).toBeCloseTo(sl.b, 6);
          // A wingman flies the anchor's attitude and speed.
          expect(p.quat).toEqual(a.quat);
          expect(p.speed).toBe(a.speed);
        }
      }
    }
  });

  it("folds into the anchor at spread 0 and opens linearly", () => {
    const a = anchorPose(10, 200, 1995, 1.2); // across the seam
    for (let k = 0; k < SQUAD_SIZE; k++) {
      const closed = slotPoseInto(a, 0, k, 0, pose());
      expect(wrapDelta(a.pos, closed.pos)).toEqual({ x: 0, y: 0, z: 0 });
      const half = wrapDelta(a.pos, slotPoseInto(a, 0, k, 0.5, pose()).pos);
      const full = wrapDelta(a.pos, slotPoseInto(a, 0, k, 1, pose()).pos);
      expect(half.x * 2).toBeCloseTo(full.x, 6);
      expect(half.z * 2).toBeCloseTo(full.z, 6);
    }
  });

  it("expands a wire row into exactly the poses the server flies, ids counted up from slot 0's", () => {
    const a = anchorPose(1999.96, 251.23, 3.71, -0.83);
    const mask = 0b10110111;
    const hp = [100, 93, 71, 44, 100, 12];
    const wire = encodeSquadRow({
      id0: "bot:room-3:41",
      anchor: a,
      form: 3,
      spread: 0.737,
      prot: true,
      mask,
      hp,
    });
    expect(isSquadRow(wire)).toBe(true);
    expect(isSquadRow([...wire, 5])).toBe(false);
    expect(isSquadRow(["x", 1, 2])).toBe(false);
    // The server flies its planes off the decoded (quantised) anchor.
    const q = decodeSquadRow(wire);
    const out: { id: string; pose: Pose; hp: number; prot: boolean }[] = [];
    expandSquadRow(wire, out);
    expect(out.map((e) => e.id)).toEqual(
      [0, 1, 2, 4, 5, 7].map((k) => `bot:room-3:${41 + k}`),
    );
    expect(out.map((e) => e.hp)).toEqual(hp);
    let i = 0;
    for (let k = 0; k < SQUAD_SIZE; k++) {
      if (!(mask & (1 << k))) continue;
      const want = slotPoseInto(q.anchor, q.form, k, q.spread, pose());
      expect(out[i]?.pose).toEqual(want);
      expect(out[i]?.prot).toBe(true);
      expect(squadMemberId("bot:room-3:41", k)).toBe(out[i]?.id);
      i++;
    }
    // Quantisation stays the snapshot entry's: ≤ 0.05 m per axis.
    expect(Math.abs(wrapDelta(a.pos, q.anchor.pos).x)).toBeLessThanOrEqual(
      0.05,
    );
    expect(Math.abs(q.anchor.pos.y - a.pos.y)).toBeLessThanOrEqual(0.05);
  });
});

describe("E1 squadrons: the altitude bands", () => {
  it("derive from the ceilings: under BOT_CEILING_ALT and SOFT_CEILING, the cruise cap under both", () => {
    expect(SQUAD_ALT_MAX).toBeLessThan(BOT_CEILING_ALT);
    expect(SQUAD_ALT_MAX).toBeLessThan(SOFT_CEILING);
    expect(SQUAD_CRUISE_CAP).toBeLessThanOrEqual(SQUAD_ALT_MAX);
    expect(SQUAD_FLOOR_ALT).toBeLessThan(SQUAD_CRUISE_CAP);
  });
});

describe("E1 squadrons: 500 planes over the real city", () => {
  // 63 squadrons (504 planes) on seeded plans for ten minutes at 20 Hz,
  // every plane checked against the city every fourth tick.
  const SQUADS = 63;
  const TICKS = 20 * 600;
  const stats = { clamps: 0 };
  let hits = 0;
  let checks = 0;
  const ys: number[] = [];
  beforeAll(() => {
    const city = generateCity(CITY_SEED);
    const index = buildCityIndex(city);
    const grid = RooflineGrid.build(
      city,
      craneColumns(generateMovers(CITY_SEED, city).cranes),
    );
    const rand = mulberry32(2026);
    const squads: {
      a: SquadAnchor;
      plan: SquadPlan;
      pref: number;
      form: number;
    }[] = [];
    for (let i = 0; i < SQUADS; i++) {
      const x = rand() * WORLD_SIZE;
      const z = rand() * WORLD_SIZE;
      const yaw = rand() * Math.PI * 2;
      const pos = { x, y: 0, z };
      pos.y = Math.max(SQUAD_FLOOR_ALT, floorAhead(grid, pos, yaw));
      squads.push({
        a: {
          pos,
          yaw,
          pitch: 0,
          roll: 0,
          speed: 66 + rand() * 14,
          steer: yaw,
          steerNeed: 0,
        },
        plan: {
          kind: ([PLAN_LANE, PLAN_STREAM, PLAN_ESCORT] as const)[i % 3] as
            | 0
            | 1
            | 2,
          axis: rand() < 0.5 ? "x" : "z",
          cross: rand() * WORLD_SIZE,
          dir: rand() < 0.5 ? 1 : -1,
          center: { x: rand() * WORLD_SIZE, y: 0, z: rand() * WORLD_SIZE },
          radius: 260,
        },
        pref: rand() * 40,
        form: i % FORMATIONS.length,
      });
    }
    const p = pose();
    const ap = pose();
    for (let t = 0; t < TICKS; t++) {
      squads.forEach((q, i) => {
        if (
          q.plan.kind === PLAN_STREAM &&
          Math.hypot(
            wrapDelta(q.a.pos, q.plan.center).x,
            wrapDelta(q.a.pos, q.plan.center).z,
          ) < 260
        ) {
          q.plan.center = {
            x: rand() * WORLD_SIZE,
            y: 0,
            z: rand() * WORLD_SIZE,
          };
        }
        stepAnchor(
          q.a,
          planYaw(q.plan, q.a.pos),
          q.pref,
          grid,
          [],
          0.05,
          (t + i) % 4 === 0,
          stats,
        );
        if (t % 4 !== 0) return;
        ap.pos = q.a.pos;
        attitudeQuatInto(q.a.yaw, q.a.pitch, q.a.roll, ap.quat);
        for (let k = 0; k < SQUAD_SIZE; k++) {
          slotPoseInto(ap, q.form, k, 1, p);
          checks++;
          if (collideCity(p.pos, PLAYER_RADIUS, city, index)) hits++;
        }
        ys.push(q.a.pos.y);
      });
    }
    ys.sort((a, b) => a - b);
  }, 300_000);

  it("never puts a plane into a building", () => {
    expect(checks).toBeGreaterThan(1_500_000);
    expect(hits).toBe(0);
  });

  it("never needs the hard floor more than a handful of times (≤ 1 per 50 000 anchor steps)", () => {
    expect(stats.clamps).toBeLessThanOrEqual((SQUADS * TICKS) / 50_000);
  });

  it("flies low and close: mostly between SQUAD_FLOOR_ALT and the skyline's cruise cap", () => {
    const at = (q: number) => ys[Math.floor(ys.length * q)] as number;
    expect(at(0.05)).toBeGreaterThanOrEqual(SQUAD_FLOOR_ALT - 1);
    expect(at(0.5)).toBeLessThan(300);
    expect(at(0.9)).toBeLessThanOrEqual(SQUAD_CRUISE_CAP + 10);
    expect(ys[ys.length - 1]).toBeLessThanOrEqual(SQUAD_ALT_MAX);
  });
});

describe("E1 squadrons: promote / demote hysteresis", () => {
  const cand = (
    id: string,
    dist: number,
    ace: boolean,
    extra: Partial<AceCandidate> = {},
  ): AceCandidate => ({
    id,
    dist,
    slotDist: dist,
    ace,
    locked: false,
    ...extra,
  });

  it("promotes within PROMOTE_M, nearest first, up to the cap", () => {
    const r = chooseAces(
      [
        cand("a", 500, false),
        cand("b", 100, false),
        cand("c", 300, false),
        cand("d", PROMOTE_M + 1, false),
      ],
      2,
    );
    expect(r.promote).toEqual(["b", "c"]);
    expect(r.demote).toEqual([]);
  });

  it("demotes only with the plane AND its slot past DEMOTE_M, never a locked one", () => {
    expect(chooseAces([cand("a", DEMOTE_M + 5, true)], 12).demote).toEqual([
      "a",
    ]);
    expect(
      chooseAces([cand("a", DEMOTE_M + 5, true, { slotDist: 400 })], 12).demote,
    ).toEqual([]);
    expect(
      chooseAces([cand("a", DEMOTE_M + 5, true, { locked: true })], 12).demote,
    ).toEqual([]);
    // Over the cap a visible ace stays; demotable ones free their seats.
    const r = chooseAces(
      [
        cand("a", 200, true),
        cand("b", 300, true),
        cand("c", 2 * DEMOTE_M, true),
        cand("d", 50, false),
      ],
      2,
    );
    expect(r.demote).toEqual(["c"]);
    expect(r.promote).toEqual([]);
  });

  it("changes a plane's tier once in and once out, however its distance wobbles", () => {
    let ace = false;
    let flips = 0;
    const r = mulberry32(7);
    // In from 1400 m to 50 m and back out, ±40 m of jitter every tick.
    const path: number[] = [];
    for (let d = 1400; d > 50; d -= 5) path.push(d);
    for (let d = 50; d < 1400; d += 5) path.push(d);
    for (const d of path) {
      const dist = Math.max(0, d + (r() - 0.5) * 80);
      const out = chooseAces([cand("x", dist, ace)], ACE_MIN);
      const next: boolean = out.promote.includes("x")
        ? true
        : out.demote.includes("x")
          ? false
          : ace;
      if (next !== ace) flips++;
      ace = next;
    }
    expect(flips).toBe(2);
    expect(ace).toBe(false);
  });

  it("scales the cap with the humans, 12 to 24", () => {
    expect(aceCap(0)).toBe(ACE_MIN);
    expect(aceCap(1)).toBe(ACE_MIN);
    expect(aceCap(2)).toBe(ACE_MIN + 4);
    expect(aceCap(12)).toBe(ACE_MAX);
  });
});

describe("E1 squadrons: the guns' forward cone", () => {
  it("fires only at a human dead ahead within SQUAD_FIRE_RANGE, across the seam too", () => {
    const fwd = { x: 0, y: 0, z: -1 };
    const at = { x: 1000, y: 200, z: 5 };
    expect(squadInCone(at, fwd, { x: 1000, y: 200, z: 1900 })).toBe(true); // 105 m ahead over the seam
    expect(
      squadInCone(at, fwd, {
        x: 1000,
        y: 200,
        z: 5 - SQUAD_FIRE_RANGE - 5 + 2000,
      }),
    ).toBe(false);
    expect(squadInCone(at, fwd, { x: 1040, y: 200, z: 1900 })).toBe(false); // 21° off the nose
    expect(squadInCone(at, fwd, { x: 1000, y: 200, z: 60 })).toBe(false); // behind
  });
});
