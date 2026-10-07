// Traffic model seam: pure deterministic lane graph + vehicle poses — no
// THREE, no netcode. Worked examples use the shipped constants (WORLD_SIZE =
// 2000, BLOCK_PITCH = 200 → 10 street lines per axis): every street line
// carries two lanes on the S1 contract's lane centers, ±5 m from the
// centerline, opposite directions, each a full torus loop.
//
// L6 made the cars obey the L1 signals. The red-light sweep below derives the
// intersection a car is in from its WORLD position and reads the aspect from
// signalPhase itself — it never reuses the model's own lane → block mapping,
// so a wrong mapping fails here instead of agreeing with itself.

import {
  INTERSECTION_HALF,
  isInRoadway,
} from "@angels-bandits/common/city/street";
import { wrapDeltaAxis } from "@angels-bandits/common/world";
import { describe, expect, it } from "vitest";
import {
  AMBER,
  GO_WINDOW,
  SIGNAL_CYCLE,
  goWindowStart,
  signalPhase,
} from "../src/render/signals";
import {
  CLEAR_MARGIN,
  EMERGENCY_CARS,
  EMERGENCY_SLOTS,
  MIN_PASS_WINDOW,
  QUEUE_GAP,
  SIREN_BEAT,
  type TrafficFleet,
  type TrafficVehicle,
  VEHICLES,
  cruiseClearance,
  emergencyCars,
  findQueue,
  laneBlock,
  laneLine,
  newVehicleState,
  planLane,
  restClearance,
  sirenState,
  trafficFleet,
  trafficLanes,
  vehiclePose,
  vehicleState,
} from "../src/render/traffic";

const SEED = 42;
/** A realistic synced server clock, seconds (~2027): big enough that float
 * precision in the lap arithmetic would show. */
const NOW = 1_800_000_000;

const fleet = trafficFleet(SEED);
const lengthOf = (v: TrafficVehicle) => VEHICLES[v.kind].length;

describe("trafficLanes", () => {
  const lanes = trafficLanes();

  it("carries 40 lanes: 10 streets per axis × 2 axes × 2 lanes", () => {
    expect(lanes).toHaveLength(40);
  });

  it("offsets every lane ±5 m from a street centerline, in canonical coords", () => {
    for (const lane of lanes) {
      // cross ± 5 must sit on a BLOCK_PITCH multiple; 1995 wraps line x = 0.
      const onLine = (v: number) => ((v % 200) + 200) % 200 === 0;
      expect(onLine(lane.cross - 5) || onLine(lane.cross + 5)).toBe(true);
      expect(lane.cross).toBeGreaterThanOrEqual(0);
      expect(lane.cross).toBeLessThan(2000);
    }
  });

  it("gives each street one lane per direction on opposite sides", () => {
    // Street line x = 400 (a 'z' axis street): its two lanes sit at 395 and
    // 405 and drive opposite ways.
    const pair = lanes.filter(
      (l) => l.axis === "z" && (l.cross === 395 || l.cross === 405),
    );
    expect(pair).toHaveLength(2);
    expect(pair[0].dir + pair[1].dir).toBe(0);
  });

  it("assigns every lane a unique stable id", () => {
    expect(new Set(lanes.map((l) => l.id)).size).toBe(lanes.length);
  });

  it("wraps line 0's 1995 lane to street line 0 and block 0's signal", () => {
    const lane = lanes.find((l) => l.axis === "z" && l.cross === 1995);
    if (!lane) throw new Error("lane not found");
    expect(laneLine(lane)).toBe(0);
    // Lane intersection 0 of a 'z' lane on street x = 0 is block (0, 0).
    expect(laneBlock(lane, 0)).toEqual({ bx: 0, bz: 0 });
  });

  it("maps reverse lanes' intersections in reverse block order", () => {
    // A −z lane meets z = 1800 (block 9) one block after z = 0.
    const lane = lanes.find((l) => l.axis === "z" && l.dir === -1);
    if (!lane) throw new Error("lane not found");
    expect(laneBlock(lane, 1).bz).toBe(9);
    expect(laneBlock(lane, 2).bz).toBe(8);
  });
});

describe("goWindowStart", () => {
  it("agrees with signalPhase: non-red exactly inside the go window", () => {
    for (const [bx, bz] of [
      [0, 0],
      [3, 7],
      [9, 9],
    ]) {
      for (const axis of ["ns", "ew"] as const) {
        const start = goWindowStart(bx, bz, axis, SEED);
        for (let t = NOW; t < NOW + SIGNAL_CYCLE; t += 0.37) {
          const q =
            (((t - start) % SIGNAL_CYCLE) + SIGNAL_CYCLE) % SIGNAL_CYCLE;
          // Skip a hair either side of the boundaries (float rounding).
          if (Math.abs(q - GO_WINDOW) < 1e-3 || q < 1e-3) continue;
          const lit = signalPhase(bx, bz, t, SEED)[axis] !== "red";
          expect(lit).toBe(q < GO_WINDOW);
        }
      }
    }
  });
});

describe("planLane", () => {
  it("is deterministic from (lane, seed)", () => {
    const lane = trafficLanes()[7];
    expect(planLane(lane, SEED)).toEqual(planLane(lane, SEED));
    expect(planLane(lane, SEED + 1)).not.toEqual(planLane(lane, SEED));
  });

  it("closes every lap on a whole number of signal cycles", () => {
    for (const plan of fleet.plans) {
      expect(plan.period % SIGNAL_CYCLE).toBe(0);
      expect(plan.period / SIGNAL_CYCLE).toBeGreaterThanOrEqual(4);
    }
  });

  it("keeps cruise speeds in the [10, 14] m/s band", () => {
    for (const plan of fleet.plans) {
      expect(plan.speed).toBeGreaterThanOrEqual(10);
      expect(plan.speed).toBeLessThanOrEqual(14);
    }
  });

  it("never needs the forced anchor stop (seeds 0–999)", () => {
    const lanes = trafficLanes();
    let forced = 0;
    for (let seed = 0; seed < 1000; seed++) {
      for (const lane of lanes) if (planLane(lane, seed).forced) forced++;
    }
    expect(forced).toBe(0);
  });

  it("admits only platoons that clear the box, cruising or from rest", () => {
    for (let seed = 0; seed < 50; seed++) {
      for (const plan of trafficFleet(seed).plans) {
        for (const p of plan.platoons) {
          expect(p.members.length).toBeGreaterThanOrEqual(1);
          expect(p.members.length).toBeLessThanOrEqual(4);
          expect(
            p.members.filter((m) => m.kind === "bus").length,
          ).toBeLessThanOrEqual(1);
          expect(cruiseClearance(p, plan.speed)).toBeLessThanOrEqual(
            GO_WINDOW - CLEAR_MARGIN - MIN_PASS_WINDOW + 1e-9,
          );
          expect(restClearance(p, plan.speed)).toBeLessThanOrEqual(
            GO_WINDOW - CLEAR_MARGIN,
          );
        }
      }
    }
  });

  it("rarely stops at a green: ≤ 10 % of stops city-wide begin with more than AMBER left", () => {
    let stops = 0;
    let early = 0;
    let lanesOver = 0;
    let lanes = 0;
    for (let seed = 0; seed < 50; seed++) {
      for (const plan of trafficFleet(seed).plans) {
        const n = plan.stops.filter((s) => s.greenLeft > AMBER).length;
        stops += plan.stops.length;
        early += n;
        lanes++;
        // Per lane: one lap is only ~7 stops, so bound the count too.
        expect(n).toBeLessThanOrEqual(3);
        if (n / plan.stops.length > 0.25) lanesOver++;
      }
    }
    expect(early / stops).toBeLessThanOrEqual(0.1);
    expect(lanesOver / lanes).toBeLessThanOrEqual(0.05);
  });
});

describe("trafficFleet", () => {
  it("is deterministic: same seed, same fleet, same poses", () => {
    const again = trafficFleet(SEED);
    expect(again.vehicles).toEqual(fleet.vehicles);
    for (const t of [NOW, NOW + 123.456, -77.7]) {
      fleet.vehicles.forEach((v, i) => {
        expect(vehiclePose(again, again.vehicles[i], t)).toEqual(
          vehiclePose(fleet, v, t),
        );
      });
    }
  });

  it("stays in a sane size band (≤ 600 instances) across seeds", () => {
    for (let seed = 0; seed < 50; seed++) {
      const n = trafficFleet(seed).vehicles.length;
      expect(n).toBeGreaterThan(160);
      expect(n).toBeLessThanOrEqual(600);
    }
  });

  it("mixes buses, taxis and cars, plus the emergency vehicles", () => {
    const kinds = new Set(fleet.vehicles.map((v) => v.kind));
    expect([...kinds].sort()).toEqual(["bus", "car", "emergency", "taxi"]);
    expect(fleet.vehicles.filter((v) => v.kind === "emergency")).toHaveLength(
      EMERGENCY_CARS,
    );
  });
});

/** Every sample time across one full period of a lane (plus a little). */
function* samples(period: number, step: number, base = NOW) {
  for (let t = base; t <= base + period + 1; t += step) yield t;
}

describe("vehicle poses", () => {
  const s = newVehicleState();

  it("a lap closes: pose(t + P) = pose(t) for every vehicle", () => {
    for (const v of fleet.vehicles) {
      const plan = fleet.plans[v.lane];
      const period = v.runner ? 2000 / v.runner.speed : plan.period;
      for (const t of [NOW, NOW + 17.3, -45.5]) {
        const a = vehiclePose(fleet, v, t);
        const b = vehiclePose(fleet, v, t + period);
        // Same point on the torus (the seam may sit between the two).
        expect(Math.abs(wrapDeltaAxis(a.pos.x, b.pos.x))).toBeLessThan(1e-3);
        expect(Math.abs(wrapDeltaAxis(a.pos.z, b.pos.z))).toBeLessThan(1e-3);
        expect(b.yaw).toBe(a.yaw);
      }
    }
  });

  it("moves continuously and never backwards, across the lap boundary too", () => {
    for (const plan of fleet.plans) {
      const v = fleet.vehicles.find(
        (x) => x.lane === plan.lane.id && !x.runner,
      );
      if (!v) continue;
      const step = 0.05;
      let prev = vehicleState(fleet, v, NOW, s).front;
      let minStep = Number.POSITIVE_INFINITY;
      let maxStep = Number.NEGATIVE_INFINITY;
      for (const t of samples(plan.period, step, NOW + step)) {
        const front = vehicleState(fleet, v, t, s).front;
        minStep = Math.min(minStep, front - prev);
        maxStep = Math.max(maxStep, front - prev);
        prev = front;
      }
      // Lane space is unbounded (~1e10 m at NOW): an ulp there is ~2e-6 m.
      expect(minStep).toBeGreaterThanOrEqual(-1e-4);
      expect(maxStep).toBeLessThanOrEqual(plan.speed * step + 1e-4);
    }
  });

  it("keeps every vehicle on the roadway and on its lane (or centerline)", () => {
    for (const t of [NOW, NOW + 61.2, NOW + 200.9]) {
      for (const v of fleet.vehicles) {
        const lane = fleet.lanes[v.lane];
        const { pos } = vehiclePose(fleet, v, t);
        expect(isInRoadway(pos)).toBe(true);
        const cross = lane.axis === "x" ? pos.z : pos.x;
        const want = v.runner ? laneLine(lane) * 200 : lane.cross;
        expect(cross).toBe(want);
        expect(pos.y).toBe(0);
      }
    }
  });

  it("faces the lane direction (yaw convention: forward = -Z at yaw 0)", () => {
    // Worked examples: +Z travel → yaw π; -Z → 0; +X → -π/2; -X → π/2.
    const yawOf = (axis: "x" | "z", dir: 1 | -1) => {
      const v = fleet.vehicles.find((x) => {
        const l = fleet.lanes[x.lane];
        return l.axis === axis && l.dir === dir;
      });
      if (!v) throw new Error("vehicle not found");
      return vehiclePose(fleet, v, NOW).yaw;
    };
    expect(yawOf("z", 1)).toBeCloseTo(Math.PI, 10);
    expect(yawOf("z", -1)).toBeCloseTo(0, 10);
    expect(yawOf("x", 1)).toBeCloseTo(-Math.PI / 2, 10);
    expect(yawOf("x", -1)).toBeCloseTo(Math.PI / 2, 10);
  });
});

/**
 * The intersection (block + axis aspect) a vehicle's BODY overlaps right now,
 * from its world position alone, or null when it is mid-block.
 */
function boxAspect(
  f: TrafficFleet,
  v: TrafficVehicle,
  t: number,
): { inBox: boolean; red: boolean } {
  const lane = f.lanes[v.lane];
  const { pos } = vehiclePose(f, v, t);
  const along = lane.axis === "x" ? pos.x : pos.z;
  const cross = lane.axis === "x" ? pos.z : pos.x;
  const line = Math.round(along / 200);
  const off = Math.abs(wrapDeltaAxis(line * 200, along));
  const inBox = off < INTERSECTION_HALF + lengthOf(v) / 2 - 1e-6;
  if (!inBox) return { inBox, red: false };
  const wrap = (i: number) => ((i % 10) + 10) % 10;
  const street = wrap(Math.round(cross / 200));
  const bx = lane.axis === "x" ? wrap(line) : street;
  const bz = lane.axis === "x" ? street : wrap(line);
  const aspects = signalPhase(bx, bz, t, SEED);
  return {
    inBox,
    red: (lane.axis === "x" ? aspects.ew : aspects.ns) === "red",
  };
}

describe("signals", () => {
  it("no car is inside an intersection while its signal is red (emergency vehicles excepted)", () => {
    let inBox = 0;
    for (const v of fleet.vehicles) {
      if (v.runner) continue;
      const period = fleet.plans[v.lane].period;
      for (const t of samples(period, 0.2)) {
        const at = boxAspect(fleet, v, t);
        if (at.inBox) inBox++;
        if (at.red) {
          throw new Error(
            `${v.kind} on lane ${v.lane} (platoon ${v.platoon}) in a box on red at t=${t}`,
          );
        }
      }
    }
    // The sweep really did watch cars cross intersections.
    expect(inBox).toBeGreaterThan(1000);
  });

  it("holds at negative server time too", () => {
    for (const v of fleet.vehicles) {
      if (v.runner) continue;
      for (let t = -300; t < 0; t += 1.1) {
        expect(boxAspect(fleet, v, t).red).toBe(false);
      }
    }
  });

  it("emergency vehicles do run reds", () => {
    let ranRed = false;
    for (const v of fleet.vehicles) {
      if (!v.runner) continue;
      for (let t = NOW; t < NOW + 600 && !ranRed; t += 0.2) {
        if (boxAspect(fleet, v, t).red) ranRed = true;
      }
    }
    expect(ranRed).toBe(true);
  });

  it("cars really queue: a red-light queue of 2+ forms, then drains on green", () => {
    let best = null as ReturnType<typeof findQueue>;
    let at = 0;
    for (let t = NOW; t < NOW + 300 && !(best && best.count >= 3); t += 1) {
      const q = findQueue(fleet, t);
      if (q && (!best || q.count > best.count)) {
        best = q;
        at = t;
      }
    }
    if (!best) throw new Error("no queue");
    expect(best.count).toBeGreaterThanOrEqual(2);
    // Every standing queue is waiting at a light that is not green-and-open
    // for long: it is red/amber, or the platoon could not clear it in time.
    const aspect = signalPhase(best.bx, best.bz, at, SEED)[best.axis];
    expect(aspect).not.toBe("green");
    // Within one signal cycle the queue has gone.
    let drained = false;
    for (let t = at; t < at + SIGNAL_CYCLE + 5; t += 0.5) {
      const q = findQueue(fleet, t);
      if (!q || q.laneId !== best.laneId || q.k !== best.k) {
        drained = true;
        break;
      }
    }
    expect(drained).toBe(true);
  });
});

describe("queues", () => {
  const s = newVehicleState();

  it("cars never overlap in a lane, standing in a queue or moving", () => {
    const byLane = new Map<number, TrafficVehicle[]>();
    for (const v of fleet.vehicles) {
      if (v.runner) continue;
      const list = byLane.get(v.lane) ?? [];
      list.push(v);
      byLane.set(v.lane, list);
    }
    let standingPairs = 0;
    let minGap = Number.POSITIVE_INFINITY;
    for (const [laneId, list] of byLane) {
      const period = fleet.plans[laneId].period;
      for (const t of samples(period, 0.5)) {
        const cars = list
          .map((v) => {
            const st = vehicleState(fleet, v, t, s);
            return {
              front: ((st.front % 2000) + 2000) % 2000,
              len: lengthOf(v),
              still: st.speed < 0.05,
            };
          })
          .sort((a, b) => a.front - b.front);
        for (let i = 0; i < cars.length; i++) {
          const behind = cars[i];
          const ahead = cars[(i + 1) % cars.length];
          // Gap from the follower's front bumper to the leader's rear one.
          const gap =
            (((ahead.front - ahead.len - behind.front) % 2000) + 2000) % 2000;
          minGap = Math.min(minGap, gap);
          if (behind.still && ahead.still && gap < QUEUE_GAP + 1) {
            standingPairs++;
          }
        }
      }
    }
    // 1e-4: lane space is ~1e10 m at NOW, an ulp there is ~2e-6 m.
    expect(minGap).toBeGreaterThanOrEqual(QUEUE_GAP - 1e-4);
    // Queues really form nose to tail at the queue gap.
    expect(standingPairs).toBeGreaterThan(100);
  });
});

// --- Emergency vehicles: which streets, and when they flash ------------------

describe("emergencyCars", () => {
  it("picks EMERGENCY_CARS on distinct streets, deterministically from the seed", () => {
    const a = emergencyCars(SEED);
    expect(a).toHaveLength(EMERGENCY_CARS);
    expect(emergencyCars(SEED)).toEqual(a);
    expect(new Set(a.map((c) => c.laneId >> 1)).size).toBe(a.length);
    expect(emergencyCars(SEED + 1)).not.toEqual(a);
  });

  it("only ever names lanes and slots that exist", () => {
    const lanes = trafficLanes().length;
    for (let seed = 0; seed < 100; seed++) {
      for (const c of emergencyCars(seed)) {
        expect(c.laneId).toBeGreaterThanOrEqual(0);
        expect(c.laneId).toBeLessThan(lanes);
        expect(c.carIndex).toBeGreaterThanOrEqual(0);
        expect(c.carIndex).toBeLessThan(EMERGENCY_SLOTS);
      }
    }
  });
});

describe("sirenState", () => {
  it("alternates red and blue on the beat, deterministically", () => {
    // A real light bar alternates rather than blinking dark, so the state is
    // always 1 or 2 — and it is a pure function of SERVER time, which is what
    // makes two tabs flash together.
    expect(sirenState(0)).toBe(1);
    expect(sirenState(SIREN_BEAT * 1.5)).toBe(1);
    expect(sirenState(SIREN_BEAT * 2.5)).toBe(2);
    expect(sirenState(SIREN_BEAT * 3.5)).toBe(2);
    expect(sirenState(SIREN_BEAT * 4.5)).toBe(1);
  });

  it("repeats every four beats and survives a negative clock", () => {
    for (const t of [0.01, 0.3, 0.77]) {
      expect(sirenState(t + SIREN_BEAT * 4)).toBe(sirenState(t));
    }
    expect([1, 2]).toContain(sirenState(-1));
  });

  it("spends equal time on each side", () => {
    let red = 0;
    let samples = 0;
    for (let t = 0; t < 100; t += 0.005) {
      samples++;
      if (sirenState(t) === 1) red++;
    }
    expect(red / samples).toBeCloseTo(0.5, 2);
  });
});
