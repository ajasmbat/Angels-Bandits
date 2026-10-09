// B3 hazard awareness in the bot brain: a bot chasing a decoy straight
// across a hazard steers clear of it inside the hazard's warning window —
// an X1 missile's impact disc (known from its launch broadcast, 5 s ahead)
// and a D3 collapse's falling debris (known from its record). Each case has
// a control run without the hazard in which the same chase flies straight
// through it, so "it missed" is never just "it was flying somewhere else".

import {
  type Building,
  generateCity,
  tierGrids,
} from "@angels-bandits/common/city";
import {
  CollapseField,
  PANCAKE,
  collapseWire,
  collapseZoneHit,
  demolitionPlan,
} from "@angels-bandits/common/city/collapse";
import {
  EMPTY_MOVERS,
  type MoverField,
} from "@angels-bandits/common/city/movers";
import {
  CITY_SEED,
  PLAYER_RADIUS,
  TICK_DOWN_HZ,
} from "@angels-bandits/common/constants";
import { type HazardDisc, missileHazard } from "@angels-bandits/common/hazards";
import { MISSILE_FLIGHT_MS } from "@angels-bandits/common/strike";
import {
  type Vec3,
  canonicalize,
  wrapDistance,
} from "@angels-bandits/common/world";
import { describe, expect, it } from "vitest";
import { type BotContact, RoomBots } from "../src/bots";

const DT = 1000 / TICK_DOWN_HZ;

/** One bot, open sky (no city), chasing a still decoy `ahead` m along +x
 * from `start`; `onTick` sees every position, `discs` are fed each tick. */
function chase(
  start: Vec3,
  ahead: number,
  ms: number,
  movers: MoverField,
  discs: readonly HazardDisc[],
  onTick: (pos: Vec3, now: number) => void,
): { crashes: number } {
  const bots = new RoomBots("room-0", 77, [], movers);
  const [entry] = bots.syncTo(1, () => ({
    pos: start,
    yaw: -Math.PI / 2, // nose along +x
    speed: 70,
  })).spawned;
  if (!entry) throw new Error("no bot");
  const decoy: BotContact = {
    id: "decoy",
    pos: canonicalize({ x: start.x + ahead, y: start.y, z: start.z }),
    vel: { x: 0, y: 0, z: 0 },
    prot: false,
  };
  bots.setHazardDiscs("test", discs);
  let crashes = 0;
  for (let now = DT; now <= ms; now += DT) {
    crashes += bots.tick(now, [decoy]).crashes.length;
    const pos = bots.lastPosOf(entry.id);
    if (pos) onTick(pos, now);
  }
  return { crashes };
}

describe("bots dodge X1 impact discs inside the warning window", () => {
  it("flies around a missile landing on its path; without the missile it flies through", () => {
    const start = { x: 600, y: 150, z: 1000 };
    // Control: where the chase puts the bot at T.
    const T = 3000;
    let at: Vec3 | null = null;
    chase(start, 450, T, EMPTY_MOVERS, [], (pos, now) => {
      if (now === T) at = { ...pos };
    });
    if (!at) throw new Error("no control position");
    const to: Vec3 = at;
    // A missile launched 5 s before T lands exactly there.
    const disc = missileHazard({
      id: 1,
      kind: "cruise",
      from: { x: to.x - 800, y: 60, z: to.z },
      to,
      t0: T - MISSILE_FLIGHT_MS,
    });
    expect(disc.t0).toBeLessThanOrEqual(T);
    expect(disc.t1).toBeGreaterThanOrEqual(T);
    // With the disc fed from launch: never inside it while it is live.
    let closest = Number.POSITIVE_INFINITY;
    let controlClosest = Number.POSITIVE_INFINITY;
    const near = (pos: Vec3, now: number, track: (d: number) => void) => {
      if (now >= disc.t0 - DT && now <= disc.t1 + DT) {
        track(wrapDistance(pos, disc));
      }
    };
    const run = chase(start, 450, T + 1000, EMPTY_MOVERS, [disc], (pos, now) =>
      near(pos, now, (d) => {
        closest = Math.min(closest, d);
      }),
    );
    chase(start, 450, T + 1000, EMPTY_MOVERS, [], (pos, now) =>
      near(pos, now, (d) => {
        controlClosest = Math.min(controlClosest, d);
      }),
    );
    expect(run.crashes).toBe(0);
    expect(controlClosest).toBeLessThan(disc.r);
    expect(closest).toBeGreaterThan(disc.r + PLAYER_RADIUS);
  });
});

describe("bots dodge D3 collapse debris", () => {
  const seedCity = generateCity(CITY_SEED);
  /** The tallest plain tower. */
  const target = seedCity.reduce((best, b, i) => {
    if (b.holes || tierGrids(b).length === 0) return best;
    return best < 0 || b.height > (seedCity[best]?.height ?? 0) ? i : best;
  }, -1);

  /** A D5-style demolition at t = 0: the whole tower pancaking down —
   * a column of falling debris standing across the bot's chase line. */
  function demolished(): CollapseField {
    const b = seedCity[target] as Building;
    const plan = demolitionPlan(b, target, PANCAKE, 0);
    if (!plan) throw new Error("no plan");
    const field = new CollapseField();
    field.bind(seedCity);
    field.add(collapseWire(plan, target, 1, 0));
    return field;
  }

  it("never enters a falling tower's zone on a chase straight across it; without the record it does", () => {
    const field = demolished();
    const c = field.list[0];
    if (!c) throw new Error("no collapse");
    // Above the canyon probe split (an open-sky chase stays a straight
    // pursuit up there), inside the zone's height.
    const y = 140;
    expect(c.bounds.y1).toBeGreaterThan(y + PLAYER_RADIUS);
    const zMid = (c.bounds.z0 + c.bounds.z1) / 2;
    const start = { x: c.x + c.bounds.x0 - 200, y, z: c.z + zMid };
    const ahead = 450;
    // Long enough for the chase to have passed the tower either way.
    const ms = Math.min(7000, c.endMs);
    const movers: MoverField = { ...EMPTY_MOVERS, collapses: field };
    let entered = 0;
    const run = chase(start, ahead, ms, movers, [], (pos, now) => {
      if (collapseZoneHit(pos, 0, field.list, now)) entered++;
    });
    let controlEntered = 0;
    chase(start, ahead, ms, EMPTY_MOVERS, [], (pos, now) => {
      if (collapseZoneHit(pos, 0, field.list, now)) controlEntered++;
    });
    expect(controlEntered).toBeGreaterThan(0);
    expect(entered).toBe(0);
    expect(run.crashes).toBe(0);
  });
});
