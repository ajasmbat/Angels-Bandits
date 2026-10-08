// A1 "Full of life" — the pure seams under the new street life: riders and
// pickup taxis on signal-obeying routes, crossers on WALK, ring groups, street
// stations and the people up the buildings. Worked against the shipped
// constants (STREET_WIDTH 30 → curb 15 m, lanes ±5 m, the bike lane 12.8 m,
// the taxi lane 8.7 m) and the seed-42 city every client generates.
//
// The red-light sweeps derive the intersection from the WORLD position and
// read the aspect from signalPhase itself (traffic.test.ts's idiom), so a
// wrong lane → block mapping fails here instead of agreeing with itself.

import { generateCity } from "@angels-bandits/common/city";
import {
  CURB_LINE,
  INTERSECTION_HALF,
  LOT_LINE,
  isInRoadway,
} from "@angels-bandits/common/city/street";
import { BLOCK_PITCH } from "@angels-bandits/common/constants";
import { wrapDeltaAxis } from "@angels-bandits/common/world";
import { describe, expect, it } from "vitest";
import {
  BIKE_LANE,
  BIKE_LANE_HALF,
  type FigurePose,
  LifeKind,
  PICKUP_TAXIS,
  type RoutePlan,
  TAXI_LANE,
  TAXI_LENGTH,
  TAXI_PULLOVER,
  TAXI_WIDTH,
  blockCrossers,
  blockRingLife,
  blockStations,
  crosserPoseInto,
  hailerPoseInto,
  highFigures,
  newFigurePose,
  newTaxiPose,
  offCentre,
  onCrosswalk,
  pickupTaxis,
  riderFleet,
  riderPoseInto,
  ringCounts,
  ringFigurePoseInto,
  taxiPoseInto,
} from "../src/render/citylife";
import { facadeDetailFor } from "../src/render/facade-detail";
import {
  LOOK_HOLD_S,
  LOOK_LIFE_S,
  LOOK_RADIUS,
  type Look,
  lookAt,
  lookEnvelope,
  watchHold,
} from "../src/render/lookup";
import { QUALITY_PROFILES } from "../src/render/quality";
import { SIGNAL_CYCLE, signalOffset, signalPhase } from "../src/render/signals";
import { PED_BAND_MAX, PED_BAND_MIN } from "../src/render/streetlife";

const SEED = 42;
/** A realistic synced server clock, seconds (~2027). */
const NOW = 1_800_000_000;
const P = BLOCK_PITCH;
const wrap10 = (i: number) => ((i % 10) + 10) % 10;

const riders = riderFleet(SEED);
const taxis = pickupTaxis(SEED);

/** Is a vehicle-like thing at (x, z) on `plan` inside an intersection box
 * while ITS axis is red? Derived from the world position, not the plan. */
function redBox(
  plan: RoutePlan,
  x: number,
  z: number,
  halfLength: number,
  t: number,
): { inBox: boolean; red: boolean } {
  const along = plan.lane.axis === "x" ? x : z;
  const cross = plan.lane.axis === "x" ? z : x;
  const line = Math.round(along / P);
  const off = Math.abs(wrapDeltaAxis(line * P, along));
  const inBox = off < INTERSECTION_HALF + halfLength - 1e-6;
  if (!inBox) return { inBox, red: false };
  const street = wrap10(Math.round(cross / P));
  const bx = plan.lane.axis === "x" ? wrap10(line) : street;
  const bz = plan.lane.axis === "x" ? street : wrap10(line);
  const a = signalPhase(bx, bz, t, SEED);
  return { inBox, red: (plan.lane.axis === "x" ? a.ew : a.ns) === "red" };
}

/** Lateral distance of a ground point from its own lane's street centreline. */
const lateralOf = (plan: RoutePlan, x: number, z: number) =>
  offCentre(plan.lane.axis === "x" ? z : x);

describe("riders (cyclists, scooters, delivery)", () => {
  it("is deterministic in (seed, time) and depends on the seed", () => {
    const again = riderFleet(SEED);
    const a = newFigurePose();
    const b = newFigurePose();
    for (const [i, r] of riders.riders.entries()) {
      riderPoseInto(riders, r, NOW + i, a);
      riderPoseInto(again, again.riders[i] as typeof r, NOW + i, b);
      expect(b).toEqual(a);
    }
    expect(JSON.stringify(riderFleet(SEED + 1).riders)).not.toBe(
      JSON.stringify(riders.riders),
    );
  });

  it("every route closes naturally on a whole number of signal cycles", () => {
    for (const plan of riders.plans) {
      expect(plan.forced).toBe(false);
      const cycles = plan.period / SIGNAL_CYCLE;
      expect(Math.abs(cycles - Math.round(cycles))).toBeLessThan(1e-9);
    }
    // The schedule repeats exactly: one lap later, the same place.
    const p = newFigurePose();
    const q = newFigurePose();
    for (const r of riders.riders.slice(0, 20)) {
      const plan = riders.plans[r.plan] as RoutePlan;
      riderPoseInto(riders, r, NOW, p);
      riderPoseInto(riders, r, NOW + plan.period, q);
      expect(Math.abs(wrapDeltaAxis(p.x, q.x))).toBeLessThan(1e-3);
      expect(Math.abs(wrapDeltaAxis(p.z, q.z))).toBeLessThan(1e-3);
    }
  });

  it("mixes bikes, scooters and delivery riders, a few per bike lane", () => {
    const kinds = new Set(riders.riders.map((r) => r.kind));
    expect(kinds).toEqual(
      new Set([LifeKind.BIKE, LifeKind.SCOOTER, LifeKind.DELIVERY]),
    );
    expect(riders.riders.length).toBeGreaterThan(100);
    // Riders sharing a lane run at distinct whole-cycle shifts.
    const byPlan = new Map<number, Set<number>>();
    for (const r of riders.riders) {
      const set = byPlan.get(r.plan) ?? new Set<number>();
      expect(set.has(r.delay)).toBe(false);
      set.add(r.delay);
      byPlan.set(r.plan, set);
    }
  });

  it("stay in their bike lane", () => {
    const p = newFigurePose();
    let samples = 0;
    for (const r of riders.riders) {
      const plan = riders.plans[r.plan] as RoutePlan;
      for (let t = NOW; t < NOW + plan.period; t += 1.7) {
        riderPoseInto(riders, r, t, p);
        const lat = lateralOf(plan, p.x, p.z);
        expect(Math.abs(lat - BIKE_LANE)).toBeLessThanOrEqual(BIKE_LANE_HALF);
        samples++;
      }
    }
    expect(samples).toBeGreaterThan(20_000);
  });

  it("never enter an intersection while their signal is red", () => {
    const p = newFigurePose();
    let inBox = 0;
    for (const r of riders.riders) {
      const plan = riders.plans[r.plan] as RoutePlan;
      for (let t = NOW; t < NOW + plan.period; t += 0.25) {
        riderPoseInto(riders, r, t, p);
        const at = redBox(plan, p.x, p.z, 0.9, t);
        if (at.inBox) inBox++;
        if (at.red) {
          throw new Error(`rider on plan ${r.plan} in a box on red at t=${t}`);
        }
      }
    }
    expect(inBox).toBeGreaterThan(1000);
  });

  it("really stop at red lights (and go again)", () => {
    const stops = riders.plans.reduce((n, p) => n + p.signalStops.length, 0);
    expect(stops).toBeGreaterThan(riders.plans.length);
    for (const plan of riders.plans) {
      for (const s of plan.signalStops)
        expect(s.tGo).toBeGreaterThanOrEqual(s.tStop);
    }
  });
});

describe("pickup taxis", () => {
  it("are PICKUP_TAXIS taxis on distinct directed streets, every route natural", () => {
    expect(taxis).toHaveLength(PICKUP_TAXIS);
    expect(new Set(taxis.map((t) => t.plan.lane.id)).size).toBe(PICKUP_TAXIS);
    for (const t of taxis) {
      expect(t.plan.forced).toBe(false);
      expect(t.plan.pickups.length).toBeGreaterThan(0);
    }
    expect(JSON.stringify(pickupTaxis(SEED))).toBe(JSON.stringify(taxis));
  });

  it("stay between their lane and the pull-over line, and obey the signals", () => {
    const p = newTaxiPose();
    let hazard = 0;
    let inBox = 0;
    for (const taxi of taxis) {
      for (let t = NOW; t < NOW + taxi.plan.period; t += 0.25) {
        taxiPoseInto(taxi, t, p);
        const lat = lateralOf(taxi.plan, p.x, p.z);
        expect(lat).toBeGreaterThanOrEqual(TAXI_LANE - 1e-6);
        expect(lat).toBeLessThanOrEqual(TAXI_PULLOVER + 1e-6);
        const at = redBox(taxi.plan, p.x, p.z, TAXI_LENGTH / 2, t);
        if (at.inBox) inBox++;
        if (at.red) throw new Error(`taxi in a box on red at t=${t}`);
        if (p.hazard) {
          hazard++;
          // Double-parked, clear of the bike lane.
          expect(lat + TAXI_WIDTH / 2).toBeLessThan(BIKE_LANE - BIKE_LANE_HALF);
          // Hazards only mid-block, never in a crossing.
          expect(at.inBox).toBe(false);
        }
      }
    }
    expect(hazard).toBeGreaterThan(100);
    expect(inBox).toBeGreaterThan(100);
  });

  it("each pickup has a hailer who is only ever in the roadway beside a standing taxi", () => {
    const taxi = newTaxiPose();
    const h: FigurePose = newFigurePose();
    let seen = 0;
    let inRoad = 0;
    for (const tx of taxis) {
      for (let i = 0; i < tx.plan.pickups.length; i++) {
        for (let t = NOW; t < NOW + tx.plan.period; t += 0.3) {
          if (!hailerPoseInto(tx, i, t, h)) continue;
          seen++;
          const lat = lateralOf(tx.plan, h.x, h.z);
          expect(lat).toBeLessThanOrEqual(LOT_LINE);
          if (lat < CURB_LINE) {
            inRoad++;
            taxiPoseInto(tx, t, taxi);
            expect(taxi.hazard).toBe(true);
            const d = Math.hypot(
              wrapDeltaAxis(taxi.x, h.x),
              wrapDeltaAxis(taxi.z, h.z),
            );
            // Between the curb and the taxi's door: never further out than
            // the curb-to-taxi gap (plus the door's offset along it).
            expect(d).toBeLessThan(CURB_LINE - TAXI_PULLOVER + 1);
          }
        }
      }
    }
    expect(seen).toBeGreaterThan(500);
    expect(inRoad).toBeGreaterThan(10);
  });
});

describe("crossers", () => {
  it("are deterministic per (seed, block) and scale with the district", () => {
    expect(JSON.stringify(blockCrossers(3, 4, SEED))).toBe(
      JSON.stringify(blockCrossers(3, 4, SEED)),
    );
    expect(blockCrossers(4, 4, SEED).length).toBeGreaterThan(
      blockCrossers(0, 9, SEED).length,
    );
  });

  it("stand on the sidewalk or walk a crosswalk — and only while the crossed street is red", () => {
    const p = newFigurePose();
    let crossing = 0;
    let waiting = 0;
    for (let bx = 0; bx < 10; bx++) {
      for (let bz = 0; bz < 10; bz += 3) {
        const offset = signalOffset(bx, bz, SEED);
        for (const c of blockCrossers(bx, bz, SEED)) {
          for (let t = NOW; t < NOW + 4 * SIGNAL_CYCLE; t += 0.5) {
            crosserPoseInto(c, t, offset, p);
            const road = isInRoadway({ x: p.x, y: 0, z: p.z });
            if (!road) {
              waiting++;
              continue;
            }
            crossing++;
            expect(onCrosswalk(p.x, p.z)).toBe(true);
            const a = signalPhase(bx, bz, t, SEED);
            // In the EW street's roadway → EW traffic must be stopped, etc.
            if (offCentre(p.z) < CURB_LINE) expect(a.ew).toBe("red");
            if (offCentre(p.x) < CURB_LINE) expect(a.ns).toBe("red");
          }
        }
      }
    }
    expect(crossing).toBeGreaterThan(1000);
    expect(waiting).toBeGreaterThan(crossing);
  });
});

describe("ring life: couples, groups, joggers, dog walkers", () => {
  it("is deterministic and denser in the hot districts", () => {
    expect(JSON.stringify(blockRingLife(2, 2, SEED))).toBe(
      JSON.stringify(blockRingLife(2, 2, SEED)),
    );
    const hot = ringCounts(4, 4);
    const cold = ringCounts(0, 9);
    expect(hot.groups).toBeGreaterThan(cold.groups);
    const all = blockRingLife(4, 4, SEED);
    expect(all.some((f) => f.kind === LifeKind.DOG)).toBe(true);
    expect(all.some((f) => f.speed > 2.5)).toBe(true); // joggers
  });

  it("everyone stays on the sidewalk band, corners included", () => {
    const p = newFigurePose();
    for (const [bx, bz] of [
      [0, 0],
      [4, 4],
      [9, 9],
      [6, 2],
    ] as const) {
      for (const f of blockRingLife(bx, bz, SEED)) {
        for (let t = NOW; t < NOW + 600; t += 2.3) {
          ringFigurePoseInto(f, t, p);
          expect(isInRoadway({ x: p.x, y: 0, z: p.z })).toBe(false);
          const d = Math.min(offCentre(p.x), offCentre(p.z));
          expect(d).toBeGreaterThanOrEqual(PED_BAND_MIN - 1e-6);
          expect(d).toBeLessThanOrEqual(PED_BAND_MAX + 1e-6);
        }
      }
    }
  });

  it("a group walks together, corners included (no drift apart)", () => {
    const a = newFigurePose();
    const b = newFigurePose();
    const specs = blockRingLife(5, 5, SEED);
    let pairs = 0;
    for (let i = 1; i < specs.length; i++) {
      const s = specs[i];
      const prev = specs[i - 1];
      if (!s || !prev || s.base !== prev.base || s.speed !== prev.speed)
        continue;
      pairs++;
      for (let t = NOW; t < NOW + 900; t += 3.1) {
        ringFigurePoseInto(prev, t, a);
        ringFigurePoseInto(s, t, b);
        const d = Math.hypot(wrapDeltaAxis(a.x, b.x), wrapDeltaAxis(a.z, b.z));
        expect(d).toBeLessThan(2.5);
      }
    }
    expect(pairs).toBeGreaterThan(5);
  });
});

describe("street stations: carts, bus stops, performers", () => {
  it("every station figure stands off the roadway, inside the lot line", () => {
    let carts = 0;
    let performers = 0;
    for (let bx = 0; bx < 10; bx++) {
      for (let bz = 0; bz < 10; bz++) {
        const s = blockStations(bx, bz, SEED);
        expect(s.busStops.length).toBeLessThanOrEqual(1);
        performers += s.performers.length;
        for (const f of s.figures) {
          if (f.kind === LifeKind.CART) carts++;
          expect(isInRoadway({ x: f.x, y: 0, z: f.z })).toBe(false);
          expect(f.y).toBe(0);
          const d = Math.min(offCentre(f.x), offCentre(f.z));
          // Sidewalks (curb → lot line), or a park's open ground.
          const plaza = [
            [4, 4],
            [1, 7],
            [8, 2],
          ].some(([px, pz]) => px === bx && pz === bz);
          if (!plaza) expect(d).toBeLessThanOrEqual(LOT_LINE);
        }
      }
    }
    expect(carts).toBeGreaterThan(30);
    expect(performers).toBeGreaterThan(8);
  });
});

describe("people up the buildings", () => {
  const city = generateCity(SEED);

  it("balcony people stand ON an L13 balcony slab; terrace people on their own roof", () => {
    let balcony = 0;
    let roof = 0;
    for (const b of city) {
      const figs = highFigures(b, SEED);
      if (figs.length === 0) continue;
      const slabs = facadeDetailFor(b, SEED).boxes.filter(
        (x) => x.kind === "balcony" && x.sy < 0.3,
      );
      const top = b.tiers[b.tiers.length - 1];
      for (const f of figs) {
        expect(f.high).toBe(1);
        if (Math.abs(f.y - b.height) < 1e-9 && top) {
          roof++;
          expect(Math.abs(wrapDeltaAxis(b.x, f.x))).toBeLessThan(top.width / 2);
          expect(Math.abs(wrapDeltaAxis(b.z, f.z))).toBeLessThan(top.depth / 2);
          continue;
        }
        balcony++;
        const on = slabs.some(
          (s) =>
            Math.abs(s.y + s.sy / 2 - f.y) < 1e-6 &&
            Math.abs(wrapDeltaAxis(s.x, f.x)) <= s.sx / 2 + 1e-6 &&
            Math.abs(wrapDeltaAxis(s.z, f.z)) <= s.sz / 2 + 1e-6,
        );
        expect(on).toBe(true);
      }
    }
    expect(balcony).toBeGreaterThan(200);
    expect(roof).toBeGreaterThan(50);
  });
});

describe("plane reactions (lookup.ts)", () => {
  it("the look envelope rises, holds, and fades by LOOK_HOLD_S + fade", () => {
    expect(lookEnvelope(-1)).toBe(0);
    expect(lookEnvelope(0)).toBe(0);
    expect(lookEnvelope(1)).toBe(1);
    expect(lookEnvelope(LOOK_HOLD_S)).toBe(1);
    expect(lookEnvelope(LOOK_HOLD_S + 10)).toBe(0);
  });

  it("a watcher stops, then catches back up — continuously", () => {
    const v = 1.3;
    expect(watchHold(0, v)).toBe(0);
    expect(watchHold(LOOK_HOLD_S, v)).toBeCloseTo(LOOK_HOLD_S * v);
    expect(watchHold(LOOK_LIFE_S + 1, v)).toBe(0);
    let prev = 0;
    for (let a = 0; a < LOOK_LIFE_S + 1; a += 0.01) {
      const h = watchHold(a, v);
      expect(Math.abs(h - prev)).toBeLessThan(0.05);
      prev = h;
    }
  });

  it("only passes within LOOK_RADIUS (3D, torus-wrapped) are looked at", () => {
    const out: Look = { weight: 0, age: -1 };
    const t = 1000_000;
    const near = [{ x: 1990, y: 30, z: 5, t: t - 2000 }];
    lookAt(near, 10, 0, 5, t, out); // 20 m away across the seam
    expect(out.weight).toBeGreaterThan(0.9);
    const far = [{ x: 10 + LOOK_RADIUS + 1, y: 0, z: 5, t: t - 2000 }];
    lookAt(far, 10, 0, 5, t, out);
    expect(out.weight).toBe(0);
    expect(out.age).toBe(-1);
  });
});

describe("quality tiers", () => {
  it("every tier thins the new life, Mobile the most", () => {
    const q = QUALITY_PROFILES;
    expect(q.high.cityLife).toBe(1);
    expect(q.medium.cityLife).toBeLessThan(q.high.cityLife);
    expect(q.low.cityLife).toBeLessThan(q.medium.cityLife);
    expect(q.mobile.cityLife).toBeLessThan(q.low.cityLife);
    expect(q.mobile.facadeLife).toBe(false);
    expect(q.high.facadeLife).toBe(true);
  });
});
