// S7 streak and medal rules. What these tests defend: the server credits
// every kill through one MedalLedger, so whatever it says here is what every
// client shows — and a medal or a tier must never be awarded twice.

import { generateCity } from "@angels-bandits/common/city";
import type { Hole, HoleSpan } from "@angels-bandits/common/city/holes";
import {
  blankCar,
  carBox,
  generateTrains,
} from "@angels-bandits/common/city/train";
import { WORLD_SIZE } from "@angels-bandits/common/constants";
import {
  DOUBLE_KILL_MS,
  type KillFacts,
  MEDAL_KINDS,
  MedalLedger,
  TRAIN_SURFER_RANGE,
  inHoleSpan,
  isMedalKind,
  nearTrainCar,
  streakTier,
} from "@angels-bandits/common/medals";
import { describe, expect, it } from "vitest";

const facts = (over: Partial<KillFacts> = {}): KillFacts => ({
  killerId: "a",
  victimId: "b",
  cause: "shot",
  now: 0,
  killerAlive: true,
  needle: false,
  train: false,
  ...over,
});

/** `a` kills `victim` at `now` and the victim dies — the server's order. */
function kill(
  ledger: MedalLedger,
  over: Partial<KillFacts> = {},
): ReturnType<MedalLedger["kill"]> {
  const f = facts(over);
  const award = ledger.kill(f);
  ledger.death(f.victimId, f.killerId);
  return award;
}

describe("kill streaks", () => {
  it("crosses 3, 5 and 10 exactly once each, and nothing in between", () => {
    const ledger = new MedalLedger();
    const tiers: (number | null)[] = [];
    for (let i = 1; i <= 12; i++) {
      // Spaced out so no DOUBLE KILL muddies the award.
      tiers.push(kill(ledger, { victimId: `v${i}`, now: i * 10_000 }).tier);
    }
    expect(tiers).toEqual([
      null,
      null,
      3,
      null,
      5,
      null,
      null,
      null,
      null,
      10,
      null,
      null,
    ]);
    expect(ledger.streakOf("a")).toBe(12);
  });

  it("ends on death — any death, credited or not — and starts again from 1", () => {
    const ledger = new MedalLedger();
    for (let i = 1; i <= 4; i++)
      kill(ledger, { victimId: `v${i}`, now: i * 10_000 });
    ledger.death("a", null); // a crash nobody gets credit for
    expect(ledger.streakOf("a")).toBe(0);
    expect(ledger.bestOf("a")).toBe(4);
    const tiers = [5, 6, 7].map(
      (i) => kill(ledger, { victimId: `w${i}`, now: i * 10_000 }).tier,
    );
    expect(tiers).toEqual([null, null, 3]); // the 3 tier is earned again
    expect(ledger.bestOf("a")).toBe(4);
  });

  it("a posthumous kill earns medals but never extends the streak", () => {
    const ledger = new MedalLedger();
    kill(ledger, { victimId: "v1", now: 0 });
    kill(ledger, { victimId: "v2", now: 10_000 });
    ledger.death("a", "z");
    const award = kill(ledger, {
      victimId: "v3",
      now: 30_000,
      cause: "wreck",
      killerAlive: false,
    });
    expect(award.medals).toEqual(["demolition"]);
    expect(award.tier).toBeNull();
    expect(ledger.streakOf("a")).toBe(0);
  });

  it("streakTier names the highest tier reached", () => {
    expect([0, 2, 3, 4, 5, 9, 10, 40].map(streakTier)).toEqual([
      0, 0, 3, 3, 5, 5, 10, 10,
    ]);
  });
});

describe("medals", () => {
  it("DOUBLE KILL on the 2nd kill of a chain only — never again on the 3rd", () => {
    const ledger = new MedalLedger();
    const a1 = kill(ledger, { victimId: "v1", now: 0 });
    const a2 = kill(ledger, { victimId: "v2", now: DOUBLE_KILL_MS });
    const a3 = kill(ledger, { victimId: "v3", now: DOUBLE_KILL_MS + 1000 });
    expect(a1.medals).toEqual([]);
    expect(a2.medals).toEqual(["double"]);
    expect(a3.medals).toEqual([]);
    // A gap past the window starts a fresh chain.
    kill(ledger, { victimId: "v4", now: 20_000 });
    expect(kill(ledger, { victimId: "v5", now: 21_000 }).medals).toEqual([
      "double",
    ]);
  });

  it("two kills in one tick: one DOUBLE KILL and one exact tier crossing", () => {
    const ledger = new MedalLedger();
    kill(ledger, { victimId: "v1", now: 0 });
    // A shot kill, then the same plane's wreck takes a second pilot — the
    // same server `now`.
    const shot = kill(ledger, { victimId: "v2", now: 50_000 });
    const wreck = kill(ledger, {
      victimId: "v3",
      now: 50_000,
      cause: "wreck",
    });
    expect(shot.medals).toEqual([]);
    expect(shot.tier).toBeNull();
    expect(wreck.medals).toEqual(["double", "demolition"]);
    expect(wreck.tier).toBe(3);
  });

  it("THREAD THE NEEDLE and TRAIN SURFER come from the server's context", () => {
    const ledger = new MedalLedger();
    expect(kill(ledger, { needle: true }).medals).toEqual(["needle"]);
    expect(
      kill(ledger, { victimId: "c", now: 10_000, train: true }).medals,
    ).toEqual(["train"]);
  });

  it("DEMOLITION is a wreck or a collapse, never a shot or a credited crash", () => {
    const ledger = new MedalLedger();
    const medals = ["shot", "crash", "storm", "wreck", "collapse"].map(
      (cause, i) =>
        kill(ledger, { victimId: `v${i}`, now: i * 10_000, cause }).medals,
    );
    expect(medals).toEqual([[], [], [], ["demolition"], ["demolition"]]);
  });

  it("REVENGE pays back your last killer once, and a null killer leaves no grudge", () => {
    const ledger = new MedalLedger();
    kill(ledger, { killerId: "b", victimId: "a", now: 0 });
    const payback = kill(ledger, { killerId: "a", victimId: "b", now: 10_000 });
    expect(payback.medals).toEqual(["revenge"]);
    // b respawns and a kills b again: the grudge is spent.
    const again = kill(ledger, { killerId: "a", victimId: "b", now: 30_000 });
    expect(again.medals).toEqual([]);

    // An uncredited crash does not erase or replace who you owe.
    kill(ledger, { killerId: "c", victimId: "a", now: 40_000 });
    ledger.death("a", null);
    const late = kill(ledger, { killerId: "a", victimId: "c", now: 60_000 });
    expect(late.medals).toEqual(["revenge"]);
  });

  it("forgetting a pilot drops every grudge held against them", () => {
    const ledger = new MedalLedger();
    kill(ledger, { killerId: "b", victimId: "a", now: 0 });
    ledger.forget("b");
    const award = kill(ledger, { killerId: "a", victimId: "b", now: 10_000 });
    expect(award.medals).toEqual([]);
  });

  it("SKY-BOSS SLAYER is the S4 flag", () => {
    expect(kill(new MedalLedger(), { boss: true }).medals).toEqual(["boss"]);
  });

  it("never lists a medal twice, and lists them in MEDAL_KINDS order", () => {
    const ledger = new MedalLedger();
    kill(ledger, { killerId: "b", victimId: "a", now: 0 });
    kill(ledger, { killerId: "a", victimId: "x", now: 10_000 });
    const all = kill(ledger, {
      killerId: "a",
      victimId: "b",
      now: 10_500,
      cause: "wreck",
      needle: true,
      train: true,
      boss: true,
    });
    expect(all.medals).toEqual([...MEDAL_KINDS]);
    expect(new Set(all.medals).size).toBe(all.medals.length);
  });

  it("restore puts a resumed pilot's streak back", () => {
    const ledger = new MedalLedger();
    ledger.restore("a", 4, 6);
    expect(ledger.streakOf("a")).toBe(4);
    expect(kill(ledger, { now: 10_000 }).tier).toBe(5);
    expect(ledger.bestOf("a")).toBe(6);
  });

  it("isMedalKind rejects kinds this build does not know", () => {
    expect(isMedalKind("double")).toBe(true);
    expect(isMedalKind("airshow")).toBe(false);
    expect(isMedalKind(7)).toBe(false);
  });
});

describe("kill context geometry", () => {
  // A synthetic 40 m long, 20 m wide, 15 m tall tunnel along x, whose
  // centre sits 5 m from the seam — inHoleSpan must measure across it.
  const hole: Hole = {
    kind: "tunnel",
    axis: "x",
    tierIndex: 0,
    offset: 0,
    y0: 10,
    width: 20,
    height: 15,
  };
  const span = {
    hole,
    hosts: [],
    center: { x: WORLD_SIZE - 5, y: 17.5, z: 500 },
    entry: { x: WORLD_SIZE - 25, y: 17.5, z: 500 },
    exit: { x: 15, y: 17.5, z: 500 },
    length: 40,
  } as unknown as HoleSpan;

  it("inHoleSpan: inside the clear volume, across the seam", () => {
    expect(inHoleSpan(span, { x: WORLD_SIZE - 5, y: 15, z: 500 })).toBe(true);
    expect(inHoleSpan(span, { x: 10, y: 15, z: 505 })).toBe(true);
    expect(inHoleSpan(span, { x: 20, y: 15, z: 500 })).toBe(false); // past the mouth
    expect(inHoleSpan(span, { x: 0, y: 15, z: 515 })).toBe(false); // through the wall
    expect(inHoleSpan(span, { x: 0, y: 26, z: 500 })).toBe(false); // in the lintel
    expect(inHoleSpan(span, { x: 0, y: 9, z: 500 })).toBe(false); // under the floor
  });

  const lines = generateTrains(42, generateCity(42));

  it("nearTrainCar: just above a car is near; the same spot once it has gone is not", () => {
    const t = 60_000;
    const line = lines[0];
    if (!line) throw new Error("seed 42 has trains");
    const car = carBox(line, 0, 0, 0, t, blankCar());
    const above = { x: car.x, y: car.y + car.hy + 10, z: car.z };
    expect(nearTrainCar(lines, above, TRAIN_SURFER_RANGE, t)).toBe(true);
    // Somewhere in the following lap the set has moved on and the spot —
    // still right over the viaduct — is clear of every car.
    let cleared = false;
    for (let dt = 5_000; dt < 60_000 && !cleared; dt += 1_000) {
      cleared = !nearTrainCar(lines, above, TRAIN_SURFER_RANGE, t + dt);
    }
    expect(cleared).toBe(true);
  });

  it("nearTrainCar: high above the city is never near", () => {
    expect(
      nearTrainCar(lines, { x: 800, y: 500, z: 600 }, TRAIN_SURFER_RANGE, 0),
    ).toBe(false);
  });
});
