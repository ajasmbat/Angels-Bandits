// I1 Individual pilots, the pure brain (common/src/pilots.ts):
//
//  - personalities: deterministic from a seed, and spread — no two pilots
//    alike;
//  - intents: burning flees, hit breaks off, nobody to fight means no hunt;
//  - 500 pilots fly five minutes over the real city on its roofline grid,
//    round six humans and three moving airships: not one plane touches a
//    building (the full collision test the pilots are never flown
//    against), they fly low among the towers under the bands derived from
//    the ceilings, every intent is flown — and NOTHING FLIES IN FORMATION:
//    of the pairs that ever meet within 60 m, hardly any hold headings
//    within 15° of each other for more than 3 s;
//  - the same seeds fly the same sky (the brain is pure);
//  - promote / demote hysteresis: a plane changes tier once on the way in
//    and once on the way out, however its distance wobbles, the cap holds,
//    and a visible ace is never handed back;
//  - the guns' forward cone.

import { generateCity, mulberry32 } from "@angels-bandits/common/city";
import { generateMovers } from "@angels-bandits/common/city/movers";
import { buildCityIndex, collideCity } from "@angels-bandits/common/collision";
import {
  BLIMP_ALT,
  BLIMP_HULL,
  BOT_CEILING_ALT,
  CITY_SEED,
  PLAYER_RADIUS,
  SOFT_CEILING,
  WORLD_SIZE,
} from "@angels-bandits/common/constants";
import {
  ACE_MAX,
  ACE_MIN,
  type AceCandidate,
  DEMOTE_M,
  INTENT_BREAK,
  INTENT_COUNT,
  INTENT_DIVE,
  INTENT_ESCORT,
  INTENT_FLEE,
  INTENT_HUNT,
  INTENT_PATROL,
  INTENT_STRAFE,
  INTENT_TAIL,
  PILOT_ALT_MAX,
  PILOT_BURNING_HP,
  PILOT_CRUISE_CAP,
  PILOT_FIRE_RANGE,
  PILOT_FLOOR_ALT,
  PROMOTE_M,
  type Pilot,
  type PilotHuman,
  type PilotShip,
  RooflineGrid,
  aceCap,
  chooseAces,
  chooseIntent,
  craneColumns,
  flyPilots,
  newPilot,
  personalityOf,
  pilotInCone,
  stagedSpawn,
} from "@angels-bandits/common/pilots";
import { wrapCoord, wrapDeltaAxis } from "@angels-bandits/common/world";
import { beforeAll, describe, expect, it } from "vitest";

const city = generateCity(CITY_SEED);
const grid = RooflineGrid.build(
  city,
  craneColumns(generateMovers(CITY_SEED, city).cranes),
);

describe("I1 pilots: personalities", () => {
  it("are deterministic from the seed", () => {
    for (const seed of [0, 1, 7, 123456, 0xffffffff]) {
      expect(personalityOf(seed)).toEqual(personalityOf(seed));
    }
    expect(personalityOf(1)).not.toEqual(personalityOf(2));
  });

  it("spread every trait across the air force — no two pilots alike", () => {
    const ps = Array.from({ length: 500 }, (_, i) => personalityOf(i));
    const keys = [
      "aggression",
      "skill",
      "prefAlt",
      "turn",
      "bank",
      "risk",
      "speed",
      "weaveHz",
    ] as const;
    for (const k of keys) {
      const v = ps.map((p) => p[k]).sort((a, b) => a - b);
      const lo = v[25] as number;
      const hi = v[475] as number;
      // A real spread: the 5th and 95th percentiles well apart…
      expect(hi - lo).toBeGreaterThan(
        ((v[499] as number) - (v[0] as number)) * 0.7,
      );
      // …and (all but a rare draw) every value its own.
      expect(new Set(v.map((x) => x.toFixed(6))).size).toBeGreaterThan(495);
    }
    // Both ways to break.
    expect(ps.filter((p) => p.side === 1).length).toBeGreaterThan(200);
    expect(ps.filter((p) => p.side === -1).length).toBeGreaterThan(200);
  });
});

describe("I1 pilots: intents", () => {
  const bold = { ...personalityOf(3), aggression: 0.95, risk: 0.9, skill: 0.9 };
  const meek = { ...personalityOf(4), aggression: 0.05, risk: 0.1, skill: 0.2 };
  const near = { hp: 100, hit: false, humanDist: 300, ship: true };

  it("flees when burning, breaks off when hit", () => {
    for (const r of [0, 0.3, 0.99]) {
      expect(chooseIntent(bold, { ...near, hp: PILOT_BURNING_HP - 1 }, r)).toBe(
        INTENT_FLEE,
      );
      expect(chooseIntent(meek, { ...near, hit: true }, r)).toBe(INTENT_BREAK);
    }
  });

  it("hunts nobody with no human up, and no escort with no airship", () => {
    const alone = {
      hp: 100,
      hit: false,
      humanDist: Number.POSITIVE_INFINITY,
      ship: false,
    };
    for (let i = 0; i < 200; i++) {
      const it = chooseIntent(bold, alone, i / 200);
      expect([INTENT_PATROL, INTENT_STRAFE]).toContain(it);
    }
  });

  it("lets the aggressive attack far more often than the meek", () => {
    const attacks = (p: typeof bold) => {
      let n = 0;
      for (let i = 0; i < 1000; i++) {
        const it = chooseIntent(p, near, i / 1000);
        if (it === INTENT_HUNT || it === INTENT_TAIL || it === INTENT_DIVE) n++;
      }
      return n;
    };
    expect(attacks(bold)).toBeGreaterThan(attacks(meek) * 3);
    expect(attacks(meek)).toBeGreaterThan(0);
  });
});

const T0 = 1_790_000_000_000;

/** `n` pilots flown `ticks` ticks round six weaving humans and three
 * airships; `each(t, pilots)` after every tick. */
function fly(
  n: number,
  ticks: number,
  each: (t: number, pilots: readonly Pilot[]) => void,
  stats: { clamps: number },
): void {
  const rand = mulberry32(2026);
  const pilots: Pilot[] = [];
  const at = { pos: { x: 0, y: 0, z: 0 }, yaw: 0 };
  for (let i = 0; i < n; i++) {
    stagedSpawn(grid, rand, at);
    pilots.push(
      newPilot(`bot:room-1:${i}`, i, 1000 + i * 7919, at.pos, at.yaw, 70),
    );
  }
  const humans: PilotHuman[] = Array.from({ length: 6 }, (_, i) => ({
    id: `pilot-${i}`,
    pos: { x: 0, y: 220, z: 0 },
    vel: { x: 0, y: 0, z: 0 },
  }));
  const ships: PilotShip[] = Array.from({ length: 3 }, (_, i) => ({
    id: i + 1,
    pos: { x: 0, y: 150 + i * 60, z: 0 },
    r: 70,
    h: 30,
  }));
  // A human's HP falls now and then (its pilots' fights): some planes are
  // hit and break off, a few burn and flee, and regen mends them.
  const hp = new Map<string, number>();
  for (let t = 0; t < ticks; t++) {
    const now = T0 + t * 50;
    const s = t / 20;
    humans.forEach((h, i) => {
      const a = s * 0.25 + i;
      const cx = 200 + (i % 3) * 600;
      const cz = 500 + Math.floor(i / 3) * 1000;
      const x = wrapCoord(cx + Math.cos(a) * 300);
      const z = wrapCoord(cz + Math.sin(a) * 300);
      h.vel.x = wrapDeltaAxis(h.pos.x, x) * 20;
      h.vel.z = wrapDeltaAxis(h.pos.z, z) * 20;
      h.pos = { x, y: 220 + 40 * Math.sin(a * 3), z };
    });
    ships.forEach((sh, i) => {
      sh.pos = {
        x: wrapCoord(300 + i * 650 + s * 9 * (i % 2 ? 1 : -1)),
        y: sh.pos.y,
        z: wrapCoord(400 + i * 500 + s * 6),
      };
    });
    if (t % 40 === 0) {
      const p = pilots[Math.floor(rand() * n)] as Pilot;
      hp.set(p.id, Math.max(1, (hp.get(p.id) ?? 100) - 25 - rand() * 40));
    }
    if (t % 100 === 0) {
      for (const [id, v] of hp) hp.set(id, Math.min(100, v + 15));
    }
    flyPilots(
      pilots,
      { now, humans, ships, grid },
      0.05,
      t,
      (p) => hp.get(p.id) ?? 100,
      ships,
      stats,
    );
    each(t, pilots);
  }
}

describe("I1 pilots: 500 individuals over the real city", () => {
  const N = 500;
  // Five minutes at 20 Hz; every plane checked against the city every
  // fourth tick, and the pairs within 60 m every fourth tick (0.2 s).
  const TICKS = 20 * 300;
  const stats = { clamps: 0 };
  let hits = 0;
  let checks = 0;
  const ys: number[] = [];
  const intents = new Array(INTENT_COUNT).fill(0);
  /** Pairs that ever met within 60 m, and the ones that then held a
   * heading within 15° of each other for more than 3 s. */
  const met = new Set<number>();
  const formed = new Set<number>();
  beforeAll(() => {
    const index = buildCityIndex(city);
    const CELL = 60;
    const NC = Math.ceil(WORLD_SIZE / CELL);
    const run = new Map<number, number>();
    const head = new Int32Array(NC * NC);
    const next = new Int32Array(N);
    fly(
      N,
      TICKS,
      (t, pilots) => {
        if (t % 4 !== 0) return;
        for (const p of pilots) {
          checks++;
          if (collideCity(p.pos, PLAYER_RADIUS, city, index)) hits++;
          intents[p.intent]++;
          ys.push(p.pos.y);
        }
        head.fill(-1);
        pilots.forEach((p, i) => {
          const c =
            Math.floor(p.pos.z / CELL) * NC + Math.floor(p.pos.x / CELL);
          next[i] = head[c] as number;
          head[c] = i;
        });
        const aligned = new Set<number>();
        pilots.forEach((p, i) => {
          const cx = Math.floor(p.pos.x / CELL);
          const cz = Math.floor(p.pos.z / CELL);
          for (let oz = -1; oz <= 1; oz++) {
            for (let ox = -1; ox <= 1; ox++) {
              const c = ((cz + oz + NC) % NC) * NC + ((cx + ox + NC) % NC);
              for (let j = head[c] as number; j >= 0; j = next[j] as number) {
                if (j <= i) continue;
                const q = pilots[j] as Pilot;
                const dx = wrapDeltaAxis(p.pos.x, q.pos.x);
                const dy = q.pos.y - p.pos.y;
                const dz = wrapDeltaAxis(p.pos.z, q.pos.z);
                if (dx * dx + dy * dy + dz * dz > 60 * 60) continue;
                const key = i * N + j;
                met.add(key);
                const dh = Math.abs(
                  ((q.yaw - p.yaw + 3 * Math.PI) % (2 * Math.PI)) - Math.PI,
                );
                if (dh >= (15 * Math.PI) / 180) continue;
                aligned.add(key);
                const held = (run.get(key) ?? 0) + 0.2;
                run.set(key, held);
                if (held > 3) formed.add(key);
              }
            }
          }
        });
        for (const k of run.keys()) if (!aligned.has(k)) run.delete(k);
      },
      stats,
    );
    ys.sort((a, b) => a - b);
  }, 300_000);

  it("never puts a plane into a building", () => {
    expect(checks).toBeGreaterThan(700_000);
    expect(hits).toBe(0);
  });

  it("never needs the hard floor more than a handful of times (≤ 1 per 50 000 pilot steps)", () => {
    expect(stats.clamps).toBeLessThanOrEqual((N * TICKS) / 50_000);
  });

  it("flies low and close: mostly between PILOT_FLOOR_ALT and the skyline's cruise cap", () => {
    const at = (q: number) => ys[Math.floor(ys.length * q)] as number;
    expect(at(0.05)).toBeGreaterThanOrEqual(PILOT_FLOOR_ALT - 1);
    expect(at(0.5)).toBeLessThan(300);
    expect(at(0.9)).toBeLessThanOrEqual(PILOT_CRUISE_CAP + 10);
    expect(ys[ys.length - 1]).toBeLessThanOrEqual(PILOT_ALT_MAX);
  });

  it("flies every intent: hunts, tails, dives, patrols, strafes, escorts, breaks off and flees", () => {
    for (const i of [
      INTENT_PATROL,
      INTENT_STRAFE,
      INTENT_ESCORT,
      INTENT_HUNT,
      INTENT_TAIL,
      INTENT_DIVE,
      INTENT_BREAK,
      INTENT_FLEE,
    ]) {
      expect(intents[i], `intent ${i}`).toBeGreaterThan(0);
    }
  });

  it("holds no formation: under 2 % of the pairs that meet fly together for more than 3 s", () => {
    // Planes do meet — round the humans they hunt — and tangle…
    expect(met.size).toBeGreaterThan(1000);
    // …but almost never fly one another's line.
    expect(formed.size / met.size).toBeLessThan(0.02);
  });
});

describe("I1 pilots: the brain is pure", () => {
  it("flies the same sky from the same seeds", () => {
    const run = () => {
      const out: number[] = [];
      fly(
        40,
        400,
        (t, pilots) => {
          if (t === 399) {
            for (const p of pilots)
              out.push(p.pos.x, p.pos.y, p.pos.z, p.yaw, p.intent);
          }
        },
        { clamps: 0 },
      );
      return out;
    };
    expect(run()).toEqual(run());
  });
});

describe("I1 pilots: the altitude bands", () => {
  it("derive from the ceilings: under BOT_CEILING_ALT and SOFT_CEILING, the cruise cap under both", () => {
    expect(PILOT_ALT_MAX).toBeLessThan(BOT_CEILING_ALT);
    expect(PILOT_ALT_MAX).toBeLessThan(SOFT_CEILING);
    // …and the blimp's belly: K1 put its lane over the rooftops.
    expect(PILOT_ALT_MAX + PLAYER_RADIUS).toBeLessThan(
      BLIMP_ALT - (BLIMP_HULL[1] as number),
    );
    expect(PILOT_CRUISE_CAP).toBeLessThanOrEqual(PILOT_ALT_MAX);
    expect(PILOT_FLOOR_ALT).toBeLessThan(PILOT_CRUISE_CAP);
  });
});

describe("I1 pilots: promote / demote hysteresis", () => {
  const cand = (
    id: string,
    dist: number,
    ace: boolean,
    extra: Partial<AceCandidate> = {},
  ): AceCandidate => ({ id, dist, ace, locked: false, ...extra });

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

  it("demotes only past DEMOTE_M, never a locked one", () => {
    expect(chooseAces([cand("a", DEMOTE_M + 5, true)], 12).demote).toEqual([
      "a",
    ]);
    expect(chooseAces([cand("a", DEMOTE_M - 5, true)], 12).demote).toEqual([]);
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

describe("I1 pilots: the guns' forward cone", () => {
  it("fires only at a human dead ahead within PILOT_FIRE_RANGE, across the seam too", () => {
    const fwd = { x: 0, y: 0, z: -1 };
    const at = { x: 1000, y: 200, z: 5 };
    expect(pilotInCone(at, fwd, { x: 1000, y: 200, z: 1900 })).toBe(true); // 105 m ahead over the seam
    expect(
      pilotInCone(at, fwd, {
        x: 1000,
        y: 200,
        z: 5 - PILOT_FIRE_RANGE - 5 + 2000,
      }),
    ).toBe(false);
    expect(pilotInCone(at, fwd, { x: 1040, y: 200, z: 1900 })).toBe(false); // 21° off the nose
    expect(pilotInCone(at, fwd, { x: 1000, y: 200, z: 60 })).toBe(false); // behind
  });
});
