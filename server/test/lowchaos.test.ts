// C1 low-flying chaos on the server (server/src/director.ts): fly low among
// the towers and something comes apart near and ahead every 2–4 s — up high
// it is D5's cadence exactly; every event is warned ≥ 1.5 s (in fact
// DIRECTOR_WARN_MS) ahead and leaves every plane a way out (straight on, a
// normal turn or a gentle climb), lethal ones near a plane inside the
// danger budget; no tower is felled near a human with LOW_FALLING_MAX
// collapses already coming down round them; and the recycling rule keeps
// it going for half an hour without the city ever reaching the stop shares
// or the caps — every recycled rebuild out in the fog.

import {
  type Building,
  generateCity,
  mulberry32,
} from "@angels-bandits/common/city";
import {
  TOPPLE,
  buildCollapse,
  collapseWire,
  demolitionPlan,
} from "@angels-bandits/common/city/collapse";
import { generateMovers } from "@angels-bandits/common/city/movers";
import { fallSeconds } from "@angels-bandits/common/city/props";
import {
  BLOCK_PITCH,
  CITY_SEED,
  COLLAPSE_CAP,
  COLLAPSE_LEAD_MS,
  DESTROY_CAP,
  FOG_DISTANCE,
  GONE_HOLD_SHARE,
} from "@angels-bandits/common/constants";
import {
  DIRECTOR_WARN_MIN_MS,
  type DirectorEvent,
  EVENT_CARS,
  EVENT_COLLAPSE,
  EVENT_CRANE,
  EVENT_FACADE,
  EVENT_GAS,
  EVENT_ROOF,
  EVENT_SPAN,
  type RebuildWire,
} from "@angels-bandits/common/director";
import {
  LOW_FALLING_MAX,
  LOW_FALLING_R,
  escapeFrom,
} from "@angels-bandits/common/lowchaos";
import {
  type Vec3,
  canonicalize,
  wrapDeltaAxis,
} from "@angels-bandits/common/world";
import { describe, expect, it } from "vitest";
import { applyGoneHold } from "../src/chaos";
import { DANGER_TUNING, DangerBudget, type DangerLayer } from "../src/danger";
import {
  type RoomCity,
  createRoomCity,
  tickDestruction,
} from "../src/destruction";
import {
  DESTRUCTION_TUNING,
  DestructionDirector,
  type DestructionPlane,
  type DestructionTuning,
} from "../src/director";

const SEED_CITY = generateCity(CITY_SEED);
const CRANES = generateMovers(CITY_SEED, SEED_CITY).cranes;
const T0 = 1_790_000_000_000;
const LOW_KINDS = [EVENT_FACADE, EVENT_ROOF, EVENT_SPAN, EVENT_CARS];

/** A plane down the streets: `speed` m/s at altitude `y`, legs of one block
 * alternating +z and +x from intersection (i, j) — a staircase across the
 * torus, so it keeps reaching new blocks and leaves the old ones behind. */
function staircase(
  id: string,
  t: number,
  y: number,
  i: number,
  j: number,
  speed = 80,
  human = true,
): DestructionPlane {
  const s = ((t - T0) / 1000) * speed;
  const leg = Math.floor(s / BLOCK_PITCH);
  const f = s - leg * BLOCK_PITCH;
  const zLegs = Math.ceil(leg / 2);
  const xLegs = Math.floor(leg / 2);
  const alongZ = leg % 2 === 0;
  const pos = canonicalize({
    x: (i + xLegs) * BLOCK_PITCH + (alongZ ? 0 : f),
    y,
    z: (j + zLegs) * BLOCK_PITCH + (alongZ ? f : 0),
  });
  const vel = alongZ ? { x: 0, y: 0, z: speed } : { x: speed, y: 0, z: 0 };
  return { id, pos, vel, human, protected: false, ageMs: 0 };
}

interface Room {
  rc: RoomCity;
  director: DestructionDirector;
  budget: DangerBudget;
  charges: Map<string, { t: number; layer: DangerLayer }[]>;
}

function room(tuning: DestructionTuning, seed = 7): Room {
  const rc = createRoomCity(SEED_CITY, CRANES, CITY_SEED, []);
  const budget = new DangerBudget();
  const charges = new Map<string, { t: number; layer: DangerLayer }[]>();
  const log = (id: string, t: number, layer: DangerLayer) => {
    const list = charges.get(id) ?? [];
    list.push({ t, layer });
    charges.set(id, list);
  };
  const charge = budget.charge.bind(budget);
  budget.charge = (layer, points, leadMs, now, planes) => {
    const ids = charge(layer, points, leadMs, now, planes);
    for (const id of ids) log(id, now, layer);
    return ids;
  };
  const chargeIds = budget.chargeIds.bind(budget);
  budget.chargeIds = (layer, ids, now) => {
    chargeIds(layer, ids, now);
    for (const id of ids) log(id, now, layer);
  };
  return {
    rc,
    director: new DestructionDirector(seed, mulberry32(seed ^ 0xd5d5), tuning),
    budget,
    charges,
  };
}

/** One server tick as index.ts runs it (the hold, the director, the
 * destruction, the rebuilds). */
function tick(
  r: Room,
  planes: DestructionPlane[],
  now: number,
  onWarn?: (e: DirectorEvent) => void,
): {
  warned: DirectorEvent[];
  fired: DirectorEvent[];
  rebuilds: RebuildWire[];
} {
  applyGoneHold(r.rc);
  const d = r.director.tick(now, planes, {
    city: r.rc,
    cranes: CRANES,
    budget: r.budget,
  });
  for (const e of d.warned) onWarn?.(e);
  tickDestruction(r.rc, now, planes);
  const rebuilds = r.director.rebuild(now, planes, {
    city: r.rc,
    cranes: CRANES,
  });
  return { warned: d.warned, fired: d.fired.map((f) => f.event), rebuilds };
}

/** The seconds from the warning a low event's danger is live — what the
 * director judged it on (a topple's from its real debris). */
const endMsCache = new Map<string, number>();
function windowOf(r: Room, e: DirectorEvent): [number, number] | null {
  const lead = (e.at - e.w) / 1000;
  if (e.k === EVENT_COLLAPSE) {
    const key = `${e.b}:${e.d}`;
    let end = endMsCache.get(key);
    if (end === undefined) {
      const b = SEED_CITY[e.b] as Building;
      const plan = demolitionPlan(b, e.b, TOPPLE, e.d);
      const c = plan && buildCollapse(SEED_CITY, collapseWire(plan, e.b, 0, 0));
      end = c ? c.endMs : 0;
      endMsCache.set(key, end);
    }
    return [lead + COLLAPSE_LEAD_MS / 1000, lead + end / 1000 + 1];
  }
  if (e.k === EVENT_FACADE) return [lead, lead + 3];
  if (e.k === EVENT_GAS) return [lead - 0.1, lead + 0.1];
  if (e.k === EVENT_ROOF || e.k === EVENT_SPAN) {
    const p = r.rc.props.layout.props[e.b];
    return p ? [lead, lead + fallSeconds(p) + 1] : null;
  }
  return null; // cars: prop blasts never reach a plane
}

/** Collapses coming down within LOW_FALLING_R of `pos` (warned, or with
 * debris in the air), leaving out event `skip`. */
function fallingNear(r: Room, now: number, pos: Vec3, skip: number): number {
  const gap = (x: number, z: number) =>
    Math.hypot(wrapDeltaAxis(x, pos.x), wrapDeltaAxis(z, pos.z));
  let n = 0;
  for (const c of r.rc.collapses.list) {
    if (now <= c.t0 + c.endMs && gap(c.x, c.z) <= LOW_FALLING_R) n++;
  }
  for (const e of r.director.pending()) {
    if (e.id === skip || (e.k !== EVENT_COLLAPSE && e.k !== EVENT_CRANE)) {
      continue;
    }
    if (gap(e.x, e.z) <= LOW_FALLING_R) n++;
  }
  return n;
}

describe("low-flying chaos: cadence", () => {
  const MINUTES = 3;
  const run = (y: number, tuning: DestructionTuning) => {
    const r = room(tuning);
    const warned: DirectorEvent[] = [];
    let lowTicks = 0;
    let ticks = 0;
    for (let t = T0; t < T0 + MINUTES * 60_000; t += 100) {
      const planes = [staircase("h", t, y, 3, 1)];
      warned.push(...tick(r, planes, t).warned);
      if (r.director.lowLevel("h") > 0) lowTicks++;
      ticks++;
    }
    return { warned, lowShare: lowTicks / ticks };
  };
  const low = run(60, DESTRUCTION_TUNING);
  const high = run(300, DESTRUCTION_TUNING);
  const d5 = run(300, { ...DESTRUCTION_TUNING, low: null });

  it("low among the towers: something every 2–4 s, near and ahead", () => {
    console.log(
      `C1 ${MINUTES} min low: ${low.warned.length} events (low ${(100 * low.lowShare).toFixed(0)} % of the time); up high: ${high.warned.length}`,
    );
    expect(low.lowShare).toBeGreaterThan(0.7);
    // One a low slot (2–4 s), on top of D5's 10–20 s cadence.
    expect(low.warned.length).toBeGreaterThanOrEqual(
      ((MINUTES * 60) / 4) * low.lowShare,
    );
    const gaps = low.warned
      .slice(1)
      .map((e, k) => e.w - (low.warned[k] as DirectorEvent).w)
      .sort((a, b) => a - b);
    expect(gaps[Math.floor(gaps.length / 2)]).toBeLessThanOrEqual(4000);
    expect(
      low.warned.filter((e) => LOW_KINDS.includes(e.k)).length,
    ).toBeGreaterThan(0);
  });

  it("up high it calms back down to D5's cadence — exactly the same events as with no low chaos", () => {
    expect(high.warned.length).toBeLessThanOrEqual((MINUTES * 60) / 10 + 1);
    expect(high.warned.length).toBeGreaterThan(0);
    expect(high.warned.some((e) => LOW_KINDS.includes(e.k))).toBe(false);
    expect(high.warned).toEqual(d5.warned);
    expect(low.warned.length).toBeGreaterThan(4 * high.warned.length);
  });

  it("warns every event at least 1.5 s ahead (in fact D5's 3 s floor)", () => {
    for (const e of [...low.warned, ...high.warned]) {
      expect(e.at - e.w).toBeGreaterThanOrEqual(1500);
      expect(e.at - e.w).toBeGreaterThanOrEqual(DIRECTOR_WARN_MIN_MS);
    }
  });
});

describe("low-flying chaos: fair, budgeted and capped (10 min, two humans and a bot down low)", () => {
  const r = room(DESTRUCTION_TUNING, 11);
  const kinds = new Map<number, number>();
  const unfair: string[] = [];
  const overCap: string[] = [];
  let lethalChecked = 0;
  let collapses = 0;
  for (let t = T0; t < T0 + 10 * 60_000; t += 100) {
    const planes = [
      staircase("h1", t, 55, 2, 1),
      staircase("h2", t, 85, 7, 4, 70),
      staircase("bot:1", t, 70, 2, 2, 75, false),
    ];
    tick(r, planes, t, (e) => {
      kinds.set(e.k, (kinds.get(e.k) ?? 0) + 1);
      // Every plane keeps a way out of every lethal event, as warned.
      const w = windowOf(r, e);
      if (w) {
        for (const p of planes) {
          lethalChecked++;
          if (escapeFrom(e.zone, e.x, e.z, p.pos, p.vel, ...w) < 0) {
            unfair.push(`${e.id}:${e.k} ${p.id}`);
          }
        }
      }
      // No tower (or crane) felled near a human already under the cap.
      if (e.k === EVENT_COLLAPSE || e.k === EVENT_CRANE) {
        collapses++;
        for (const p of planes) {
          if (!p.human) continue;
          const gap = Math.hypot(
            wrapDeltaAxis(e.x, p.pos.x),
            wrapDeltaAxis(e.z, p.pos.z),
          );
          if (gap > LOW_FALLING_R) continue;
          const n = fallingNear(r, t, p.pos, e.id);
          if (n >= LOW_FALLING_MAX) overCap.push(`${e.id} ${p.id}: ${n}`);
        }
      }
    });
  }

  it("stages every kind the city has round the route", () => {
    console.log(`C1 10-min mix by kind: ${JSON.stringify([...kinds])}`);
    for (const k of [
      EVENT_COLLAPSE,
      EVENT_GAS,
      EVENT_FACADE,
      EVENT_ROOF,
      EVENT_CARS,
    ]) {
      expect(kinds.get(k) ?? 0).toBeGreaterThan(0);
    }
  });

  it("leaves every plane a way out — straight on, a normal turn or a gentle climb", () => {
    expect(lethalChecked).toBeGreaterThan(100);
    expect(unfair).toEqual([]);
  });

  it("charges a plane no more lethal events than its danger budget allows", () => {
    const t = DANGER_TUNING;
    let low = 0;
    for (const [, list] of r.charges) {
      for (const c of list) {
        const window = list.filter((o) => o.t > c.t - t.windowMs && o.t <= c.t);
        expect(window.length).toBeLessThanOrEqual(t.total);
        expect(
          window.filter((o) => o.layer === c.layer).length,
        ).toBeLessThanOrEqual(t.perLayer[c.layer]);
        if (c.layer === "lowchaos") low++;
      }
    }
    expect(low).toBeGreaterThan(10);
  });

  it(`never fells a tower near a human with ${LOW_FALLING_MAX} collapses already coming down round them`, () => {
    expect(collapses).toBeGreaterThan(5);
    expect(overCap).toEqual([]);
  });
});

describe("the recycling rule", () => {
  it("keeps the chaos going for 30 min of low flying — never near the stop shares or the caps, every recycled rebuild out in the fog", async () => {
    // Recycling alone: no ruin waits out a timer.
    const r = room(
      { ...DESTRUCTION_TUNING, rebuildMinMs: 1e12, rebuildMaxMs: 1e12 },
      23,
    );
    const stop = Math.min(
      DESTRUCTION_TUNING.stopShare,
      GONE_HOLD_SHARE,
      DESTROY_CAP,
      COLLAPSE_CAP,
    );
    const perWindow: number[] = [];
    const structural: number[] = [];
    const inSight: string[] = [];
    let rebuilt = 0;
    let maxGone = 0;
    const WINDOW = 2 * 60_000;
    for (let t = T0; t < T0 + 30 * 60_000; t += 100) {
      if ((t - T0) % 60_000 === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      const human = staircase("h", t, 60, 1, 6);
      const out = tick(r, [human], t);
      const w = Math.floor((t - T0) / WINDOW);
      perWindow[w] = (perWindow[w] ?? 0) + out.warned.length;
      for (const e of out.warned) {
        if (e.k === EVENT_COLLAPSE || e.k === EVENT_FACADE) {
          structural.push(t - T0);
        }
      }
      for (const rb of out.rebuilds) {
        if (!rb.go) continue;
        rebuilt++;
        let cx: number;
        let cz: number;
        let hx: number;
        let hz: number;
        if (rb.k === 0) {
          const b = SEED_CITY[rb.b] as Building;
          cx = b.x;
          cz = b.z;
          hx = b.width / 2;
          hz = b.depth / 2;
        } else {
          const site = CRANES.find((c) => c.id === rb.b);
          if (!site) continue;
          cx = site.x;
          cz = site.z;
          hx = hz = Math.max(site.jibLength, site.counterLength);
        }
        const gap = Math.hypot(
          Math.max(Math.abs(wrapDeltaAxis(cx, human.pos.x)) - hx, 0),
          Math.max(Math.abs(wrapDeltaAxis(cz, human.pos.z)) - hz, 0),
        );
        if (gap <= FOG_DISTANCE)
          inSight.push(`${rb.k}:${rb.b} at ${gap.toFixed(0)} m`);
      }
      maxGone = Math.max(maxGone, r.rc.damage.goneShare);
    }
    console.log(
      `C1 30-min low run: ${perWindow.reduce((a, b) => a + b, 0)} events (per 2 min: ${perWindow.join(" ")}), ${structural.length} topples/facades, ${rebuilt} recycled rebuilds, peak gone share ${(100 * maxGone).toFixed(2)} %`,
    );
    expect(inSight).toEqual([]);
    expect(rebuilt).toBeGreaterThan(50);
    expect(maxGone).toBeLessThan(stop);
    // Never stalls: every 2 minutes as busy as ever, structural to the end.
    expect(perWindow).toHaveLength(15);
    for (const n of perWindow) expect(n).toBeGreaterThanOrEqual(25);
    expect(structural.filter((t) => t >= 20 * 60_000).length).toBeGreaterThan(
      20,
    );
  }, 600_000);
});
