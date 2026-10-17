// K1: the lowered sky is the ceiling of everything. The cloud deck came
// down to CLOUD_BASE (440 m) and the soft ceiling to SOFT_CEILING (480 m):
// the playable air is under the deck, and only the landmark spires reach
// into it. What this defends:
//   1. Every altitude the systems fly, spawn, launch, aim or draw at is
//      DERIVED under the deck: the bots, the fleet's lanes and launches and
//      flak, the cosmetic armada and its flak, the storm, the rooftop beams,
//      the spawns and the sky traffic — checked from the constants and the
//      pure schedules themselves, not restated.
//   2. No such system hard-codes an altitude above the deck: a scan of
//      their sources for an altitude-named constant, an altitude field or an
//      altitude comparison with a literal over CLOUD_BASE (the few that are
//      above it by design are named, with why).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  FLEET_ALT_MAX,
  FLEET_LANES,
  type FleetShip,
  SHIP_CLASSES,
  SHIP_REACH,
  installFleetPlan,
  laneAltHi,
  launchSpawnAt,
} from "@angels-bandits/common/boss";
import { generateCity } from "@angels-bandits/common/city";
import { generateMovers } from "@angels-bandits/common/city/movers";
import {
  BLIMP_ALT,
  BLIMP_HULL,
  BOT_CANYON_ALT_MAX,
  BOT_CEILING_ALT,
  BOT_DEFEND_MAX_ALT,
  BOT_ENGAGE_CEILING,
  BOT_SPAWN_ALT_MAX,
  CEILING_FADE,
  CITY_SEED,
  CLOUD_BASE,
  FIREWORK_ALT_MAX,
  HELI_ALT_MAX,
  HELI_HULL,
  MAX_ALTITUDE,
  NEWS_HELI_ALT_MAX,
  RESPAWN_ALTITUDE,
  SOFT_CEILING,
  STORM_KILL_ALT,
} from "@angels-bandits/common/constants";
import { burstsInWindow } from "@angels-bandits/common/fireworks";
import { fleetWorldOf, planFleet } from "@angels-bandits/common/fleetplan";
import {
  FLAK_SLOTS,
  GROUP_ALT,
  GROUP_BOB,
  GROUP_SIZE_MAX,
  GROUP_SLOTS,
  SHIP_LAYERS,
  SHIP_SCALE_MIN,
  SHIP_SCALE_SPAN,
  SHIP_SLOTS,
  flakPoseInto,
  newFlakPose,
  newPlanePose,
  newShipPose,
  planePoseInto,
  shipPoseInto,
  skySeed,
} from "@angels-bandits/common/skyarmada";
import { describe, expect, it } from "vitest";

const CITY = generateCity(CITY_SEED);
const MOVERS = generateMovers(CITY_SEED, CITY);
installFleetPlan(planFleet(fleetWorldOf(CITY, MOVERS)));
const T0 = 1_790_000_000_000;

describe("the lowered sky", () => {
  it("brings the deck and the ceiling down onto the skyline", () => {
    expect(CLOUD_BASE).toBeGreaterThanOrEqual(420);
    expect(CLOUD_BASE).toBeLessThanOrEqual(450);
    expect(SOFT_CEILING).toBeGreaterThan(CLOUD_BASE);
    expect(SOFT_CEILING).toBeLessThanOrEqual(490);
    expect(STORM_KILL_ALT).toBeGreaterThan(CLOUD_BASE);
    expect(STORM_KILL_ALT).toBeLessThanOrEqual(SOFT_CEILING);
    // The wire's clamp is still what legal flight can reach, no more.
    expect(MAX_ALTITUDE).toBe(SOFT_CEILING + CEILING_FADE + 50);
  });

  it("keeps the bots under it, fighting in the 60–350 m band", () => {
    expect(BOT_CEILING_ALT).toBeLessThan(CLOUD_BASE);
    expect(BOT_DEFEND_MAX_ALT).toBeLessThanOrEqual(350);
    expect(BOT_ENGAGE_CEILING).toBeLessThanOrEqual(350);
    expect(BOT_SPAWN_ALT_MAX).toBeLessThanOrEqual(350);
    expect(BOT_CANYON_ALT_MAX).toBeLessThanOrEqual(350);
  });

  it("flies, launches and fires the whole fleet under it", () => {
    FLEET_LANES.forEach((lane, i) => {
      const reach = SHIP_REACH[lane.cls] as { y: number };
      expect(laneAltHi(i) + reach.y).toBeLessThanOrEqual(FLEET_ALT_MAX);
      const ship: FleetShip = {
        id: i + 1,
        lane: i,
        t0: T0,
        s0: 0,
        hp0: 100,
        down: null,
      };
      // Every rig, all along the lane: the release is under the deck.
      for (const kind of SHIP_CLASSES[lane.cls]?.rigs ?? []) {
        for (let k = 0; k < 40; k++) {
          const l = { id: k, ship: ship.id, kind, t0: T0 + k * 9_000 };
          expect(launchSpawnAt(ship, l).pos.y).toBeLessThan(CLOUD_BASE);
        }
      }
    });
    expect(FLEET_ALT_MAX).toBeLessThan(CLOUD_BASE);
  });

  it("keeps the sky traffic, the spawns and the fireworks under it", () => {
    const rotor = (HELI_HULL[1] as number) * 1.3;
    expect(HELI_ALT_MAX + rotor).toBeLessThan(CLOUD_BASE);
    expect(NEWS_HELI_ALT_MAX + rotor).toBeLessThan(CLOUD_BASE);
    expect(BLIMP_ALT + (BLIMP_HULL[1] as number)).toBeLessThan(CLOUD_BASE);
    for (const r of MOVERS.aircraft) {
      expect(r.y + r.hy * 1.3).toBeLessThan(CLOUD_BASE);
    }
    expect(RESPAWN_ALTITUDE).toBeLessThan(CLOUD_BASE);
    expect(FIREWORK_ALT_MAX).toBeLessThan(CLOUD_BASE);
    for (const b of burstsInWindow(CITY_SEED, T0, T0 + 3_600_000)) {
      expect(b.y).toBeLessThan(CLOUD_BASE);
    }
  });

  it("paints the cosmetic armada, its dogfights and its flak under it", () => {
    const widest = 21 * (SHIP_SCALE_MIN + SHIP_SCALE_SPAN);
    for (const [, hi] of SHIP_LAYERS) {
      expect(hi + widest).toBeLessThan(CLOUD_BASE);
    }
    expect(GROUP_ALT[1] + GROUP_BOB[1]).toBeLessThan(CLOUD_BASE);
    const seed = skySeed(CITY_SEED);
    const ship = newShipPose();
    const plane = newPlanePose();
    const flak = newFlakPose();
    for (const t of [0, 911, 2400, 3599]) {
      for (let i = 0; i < SHIP_SLOTS; i++) {
        shipPoseInto(seed, i, t, 0, 0, ship);
        // A ship climbing out of the deck after a fall emerges from it.
        if (ship.fade < 1 || ship.burn > 0) continue;
        expect(ship.y + 21 * ship.scale).toBeLessThan(CLOUD_BASE);
      }
      for (let g = 0; g < GROUP_SLOTS; g++) {
        for (let m = 0; m < GROUP_SIZE_MAX; m++) {
          planePoseInto(seed, g, m, t, 0, 0, plane);
          if (!plane.present || plane.fade < 1 || plane.hitAge >= 0) continue;
          expect(plane.y).toBeLessThan(CLOUD_BASE);
        }
      }
      for (let f = 0; f < FLAK_SLOTS; f++) {
        flakPoseInto(seed, f, t, 0, 0, flak);
        expect(flak.y).toBeLessThan(CLOUD_BASE);
      }
    }
  });
  // The rooftop beams' end in the deck is pinned by the client's own
  // test (client/test/searchlights.test.ts: deckBeamLength) — the client
  // render code needs the DOM lib this package does not build with.
});

describe("no system hard-codes an altitude over the deck", () => {
  /** The systems' sources (bots, flak, the armada, the storm, the beams,
   * the spawns, the launches, the fleet, the sky traffic), from here. */
  const FILES = [
    "../src/constants.ts",
    "../src/boss.ts",
    "../src/fleetplan.ts",
    "../src/skyarmada.ts",
    "../src/storm.ts",
    "../src/aa.ts",
    "../src/bombs.ts",
    "../src/waves.ts",
    "../src/fireworks.ts",
    "../src/city/movers.ts",
    "../src/city/newsheli.ts",
    "../../server/src/bots.ts",
    "../../server/src/bottactics.ts",
    "../../server/src/bombs.ts",
    "../../server/src/boss.ts",
    "../../server/src/aa.ts",
    "../../server/src/waves.ts",
    "../../server/src/respawn.ts",
    "../../server/src/storm.ts",
    "../../client/src/render/storm.ts",
    "../../client/src/render/searchlights.ts",
    "../../client/src/render/sky-armada.ts",
    "../../client/src/render/boss.ts",
  ];
  /** Over the deck BY DESIGN, and why. */
  const ABOVE: Readonly<Record<string, string>> = {
    SOFT_CEILING: "the soft ceiling: the engine fades from it, in the deck",
    MAX_ALTITUDE: "the wire's clamp: legal flight's reach over the fade",
    CITY_TOP: "the tallest spire: it pierces the deck, the point of K1",
    METEOR_ALT: "meteors and comets fall into the city from over the deck",
    CEILING_FAR:
      "a distance from the viewer (the deck sheet's fade), not a height",
  };

  /** Each line's code, comments and doc lines dropped. */
  const codeOf = (src: string): string[] =>
    src
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("*"))
      .filter((l) => !l.trimStart().startsWith("//"))
      .filter((l) => !l.trimStart().startsWith("/*"))
      .map((l) => l.replace(/\/\/.*$/, ""));

  const PATTERNS: readonly RegExp[] = [
    // A constant set from a literal (its name is judged below).
    /\b(?:const|let)\s+([A-Z][A-Z0-9_]*)\s*(?::[^=]+)?=\s*(\d[\d_]*(?:\.\d+)?)/,
    // An altitude field given a literal.
    /\b(y|alt|altitude|topY|hubY|ipY)\s*:\s*(\d[\d_]*(?:\.\d+)?)\b/,
    // An altitude compared with a literal.
    /\.y\s*[<>]=?\s*(\d[\d_]*(?:\.\d+)?)\b/,
  ];

  /** A constant's name that says it is an altitude: one of its words is,
   * and it is no time (ms, s). */
  const ALT_WORDS = ["ALT", "ALTITUDE", "CEILING", "DECK", "TOP", "Y", "IP"];
  const altitudeNamed = (name: string): boolean => {
    const w = name.split("_");
    const last = w[w.length - 1] as string;
    if (last === "MS" || last === "S") return false;
    return (
      w.some((x) => ALT_WORDS.includes(x)) ||
      (w.includes("CLOUD") && w.includes("BASE"))
    );
  };

  /** An altitude over the deck a pattern finds in `line`, or null. */
  const overDeck = (line: string): string | null => {
    for (const [k, re] of PATTERNS.entries()) {
      const m = line.match(re);
      if (!m) continue;
      const name = m[1] as string;
      if (k === 0 && !altitudeNamed(name)) continue;
      const v = Number((m[m.length - 1] as string).replace(/_/g, ""));
      if (!(v > CLOUD_BASE) || name in ABOVE) continue;
      return line.trim();
    }
    return null;
  };

  it("would catch one: the old sky's literals are found", () => {
    for (const old of [
      "export const CLOUD_BASE = 650;",
      "export const STORM_KILL_ALT = 750;",
      "const DIVE_IP_MAX = 520;",
      "    y: 625,",
      "  if (f.pos.y > 600) return;",
    ]) {
      expect(overDeck(old)).not.toBeNull();
    }
    expect(overDeck("export const SOFT_CEILING = 480;")).toBeNull();
    expect(overDeck("export const SHIP_WINDOW = 12800;")).toBeNull();
    expect(overDeck("export const RECONNECT_BASE_MS = 500;")).toBeNull();
    expect(overDeck("const BOLT_TOP_Y = CLOUD_BASE + 40;")).toBeNull();
  });

  it("finds none in the bots, flak, armada, storm, beams, spawns or launches", () => {
    const over: string[] = [];
    for (const rel of FILES) {
      const src = readFileSync(
        fileURLToPath(new URL(rel, import.meta.url)),
        "utf8",
      );
      for (const line of codeOf(src)) {
        const hit = overDeck(line);
        if (hit) over.push(`${rel}: ${hit}`);
      }
    }
    expect(over).toEqual([]);
  });

  it("names only real constants as over the deck by design", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../src/constants.ts", import.meta.url)),
      "utf8",
    );
    for (const name of Object.keys(ABOVE)) {
      if (name === "METEOR_ALT") continue; // common/src/chaos.ts
      if (name === "CEILING_FAR") continue; // client/src/render/storm.ts
      expect(src).toMatch(new RegExp(`export const ${name}\\b`));
    }
  });
});
