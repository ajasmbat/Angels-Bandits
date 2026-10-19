// W1 Carrier War, server side (server/src/waves.ts) on the room's real
// airship fleet (FleetDirector), pilots (RoomBots, the seeded city, its
// movers and trees) and Combat — the same objects index.ts wires, ticked the
// way its loop ticks them, with a host that records what the room would
// broadcast:
//
//  - waves come in their cadence (3, then +1..+2 up to the cap, a breather
//    between) and never put more than the cap in the air;
//  - every enemy is born on an airship near a human — several ships take
//    turns — its first pose is its launch's release pose, it is launched
//    once, and once down it leaves the room;
//  - enemies hunt humans only — their contacts, quarries, targets and
//    trigger pulls name humans and nothing else;
//  - shooting a ship down takes the planes still on its rigs, the ones it
//    launched fight on, the counter counts it and its lane refills;
//  - one seed replays the same war exactly.
//
// The W1 suites run with the E1 air force off (their counts are the wave's
// alone); "E1: the air force" runs it on top of the waves, flown the way
// index.ts flies it (RoomWaves.flyForce before the brain's tick).

import {
  type BossLaunch,
  FLEET_TUNING,
  type FleetShip,
  type FleetTuning,
  decodeLaunch,
  launchReleaseAt,
  launchSpawnAt,
  shipById,
} from "@angels-bandits/common/boss";
import { generateCity, mulberry32 } from "@angels-bandits/common/city";
import {
  type MoverField,
  generateMovers,
} from "@angels-bandits/common/city/movers";
import { natureFor } from "@angels-bandits/common/city/nature";
import {
  buildCityIndex,
  buildNatureIndex,
  collideCity,
} from "@angels-bandits/common/collision";
import {
  CITY_SEED,
  PLAYER_RADIUS,
  TICK_DOWN_HZ,
} from "@angels-bandits/common/constants";
import { aceCap } from "@angels-bandits/common/pilots";
import type { SpawnState } from "@angels-bandits/common/protocol";
import {
  AIR_FORCE,
  ENEMY_CAP,
  WAVE_BREATHER_MS,
  WAVE_LEVELS,
  WAVE_LIVE,
  type WaveState,
  decodeWaves,
} from "@angels-bandits/common/waves";
import type { Vec3 } from "@angels-bandits/common/world";
import { beforeAll, describe, expect, it } from "vitest";
import { FleetDirector } from "../src/boss";
import { RoomBots } from "../src/bots";
import { Combat, type Death } from "../src/combat";
import { createRoomCity } from "../src/destruction";
import { RoomWaves, type WaveHuman, humanContacts } from "../src/waves";

const CITY = generateCity(CITY_SEED);
const MOVERS = generateMovers(CITY_SEED, CITY);
const NATURE = buildNatureIndex(natureFor(CITY_SEED, CITY));
const T0 = 1_790_000_000_000;
const DT = 1000 / TICK_DOWN_HZ;

/** The live fleet: full HP, the live refill pace. */
const TUNING: FleetTuning = { ...FLEET_TUNING };

interface Launched {
  id: string;
  launch: BossLaunch;
  ship: FleetShip;
  at: number;
}

/** One simulated room and everything it broadcast. */
interface Sim {
  now: number;
  boss: FleetDirector;
  bots: RoomBots;
  combat: Combat;
  waves: RoomWaves;
  world: {
    buildings: typeof CITY;
    index: ReturnType<typeof createRoomCity>["index"];
  };
  humans: WaveHuman[];
  roster: Set<string>;
  launched: Launched[];
  /** Each enemy's release spawns, in order (one, unless relaunched). */
  released: Map<string, SpawnState[]>;
  left: Map<string, number>;
  downs: { id: string; at: number; death: Death }[];
  states: { at: number; s: WaveState }[];
  /** Every trigger pull's target, and every non-null target or quarry. */
  shotTargets: string[];
  aims: string[];
  maxAlive: number;
  ships: FleetShip[];
}

function makeSim(
  seed: number,
  humans: { id: string; pos: Vec3 }[],
  airForce = false,
): Sim {
  const rc = createRoomCity(CITY);
  const boss = new FleetDirector(mulberry32(seed ^ 0xb055), TUNING);
  const movers: MoverField = {
    ...MOVERS,
    collapses: rc.collapses,
    boss: boss.slot,
  };
  const bots = new RoomBots("room-1", seed, rc.buildings, movers, true, NATURE);
  const combat = new Combat();
  for (const h of humans) combat.addPlayer(h.id, T0);
  const sim = {
    now: T0,
    boss,
    bots,
    combat,
    world: { buildings: rc.buildings, index: rc.index },
    humans: humans.map((h) => ({
      ...h,
      vel: { x: 0, y: 0, z: 0 },
      prot: false,
      hp: 100,
    })),
    roster: new Set<string>(),
    launched: [],
    released: new Map(),
    left: new Map(),
    downs: [],
    states: [],
    shotTargets: [],
    aims: [],
    maxAlive: 0,
    ships: [],
  } as unknown as Sim;
  sim.waves = new RoomWaves(seed, bots, boss, combat, {
    addEnemy: (entry) => sim.roster.add(entry.id),
    removeEnemy: (id) => {
      sim.roster.delete(id);
      sim.left.set(id, sim.now);
    },
    send: (msg) => {
      if (msg.type === "bossLaunch") {
        const l = decodeLaunch(msg.l);
        const ship = l && shipById(boss.slot, l.ship);
        if (l && ship) {
          sim.launched.push({ id: msg.bot, launch: l, ship, at: sim.now });
        }
      } else if (msg.type === "waves") {
        const s = decodeWaves(msg.w);
        if (s) sim.states.push({ at: sim.now, s });
      }
    },
    // The room's death path (index.ts sendDeath) reports every death.
    death: (death, now) => down(sim, death, now),
  });
  sim.waves.airForce = airForce;
  return sim;
}

function down(sim: Sim, death: Death, now: number): void {
  sim.downs.push({ id: death.victimId, at: now, death });
  sim.waves.downed(death, now);
}

/** Bring enemy `id` down the way a human's guns would (Combat's crash
 * credit path), through the room's death path. */
function shootDown(sim: Sim, id: string): void {
  const death = sim.combat.crash(id, sim.now);
  if (!death) return;
  sim.bots.setDead(id);
  down(sim, death, sim.now);
}

/** One server tick, in index.ts's order: the fleet then its waves, the
 * respawn pass, then the pilots. */
function step(sim: Sim): void {
  sim.now += DT;
  const now = sim.now;
  const out = sim.boss.tick(now, true, sim.humans, sim.world);
  sim.ships.push(...out.started);
  sim.waves.tick(now, true, sim.humans);
  for (const id of sim.combat.tick(now).respawnsDue) {
    const r = sim.waves.release(id, now);
    if (r && r !== "wait") {
      const list = sim.released.get(id) ?? [];
      list.push(r);
      sim.released.set(id, list);
    }
  }
  const pilotShots = sim.waves.flyForce(now, DT / 1000, sim.humans);
  const { shots, crashes } = sim.bots.tick(now, humanContacts(sim.humans));
  for (const s of [...shots, ...pilotShots]) sim.shotTargets.push(s.targetId);
  for (const id of crashes) {
    const death = sim.combat.crash(id, now);
    if (death) down(sim, death, now);
  }
  let alive = 0;
  for (const e of sim.waves.enemies()) {
    if (sim.bots.contactOf(e.id)) alive++;
    const t = sim.bots.targetOf(e.id);
    if (t !== null) sim.aims.push(t);
    const q = sim.bots.quarryOf(e.id);
    if (q !== null) sim.aims.push(q);
  }
  sim.maxAlive = Math.max(sim.maxAlive, alive);
}

const H1 = {
  id: "11111111-aaaa-bbbb-cccc-000000000001",
  pos: { x: 1000, y: 300, z: 1000 },
};
const H2 = {
  id: "11111111-aaaa-bbbb-cccc-000000000002",
  pos: { x: 400, y: 300, z: 1500 },
};

/** Fly `ms`, shooting each enemy down `killAfter` ms after its release. */
function fly(sim: Sim, ms: number, killAfter: number | null): void {
  const end = sim.now + ms;
  const releasedAt = new Map<string, number>();
  while (sim.now < end) {
    step(sim);
    for (const e of sim.waves.enemies()) {
      if (!sim.bots.contactOf(e.id)) continue;
      if (!releasedAt.has(e.id)) releasedAt.set(e.id, sim.now);
      if (
        killAfter !== null &&
        sim.now - (releasedAt.get(e.id) as number) >= killAfter
      ) {
        shootDown(sim, e.id);
      }
    }
  }
}

describe("W1 waves: cadence, caps and where enemies come from", () => {
  let sim: Sim;
  beforeAll(() => {
    // Ninety seconds of a pilot downing every enemy four seconds after it
    // leaves its ship.
    sim = makeSim(5, [H1]);
    fly(sim, 90_000, 4000);
  }, 300_000);

  it("wave 1 is 3 planes, then +1 to +2 a wave up to NORMAL's cap, never more than ENEMY_CAP in the air", () => {
    const sizes: number[] = [];
    for (const { s } of sim.states) {
      if (s.phase === WAVE_LIVE && sizes.length < s.wave) sizes.push(s.size);
    }
    expect(sizes.length).toBeGreaterThanOrEqual(4);
    expect(sizes[0]).toBe(3);
    const cap = WAVE_LEVELS[1]?.cap as number;
    for (let i = 1; i < sizes.length; i++) {
      const grow = (sizes[i] as number) - (sizes[i - 1] as number);
      expect(sizes[i] === cap || (grow >= 1 && grow <= 2)).toBe(true);
    }
    expect(Math.max(...sizes)).toBeLessThanOrEqual(cap);
    expect(sim.maxAlive).toBeLessThanOrEqual(ENEMY_CAP);
    // Every wave launched exactly its size.
    sizes.forEach((size, i) => {
      if (i === sizes.length - 1) return; // the last may still be launching
      expect(
        sim.launched.filter((l) => waveOf(sim, l.id) === i + 1).length,
      ).toBe(size);
    });
  });

  it("breathes ~8 s between waves, with the next WAVE n announced first", () => {
    for (let w = 2; w <= 4; w++) {
      const lastDown = Math.max(
        ...sim.downs
          .filter((d) => waveOf(sim, d.id) === w - 1)
          .map((d) => d.at),
      );
      const firstLaunch = Math.min(
        ...sim.launched.filter((l) => waveOf(sim, l.id) === w).map((l) => l.at),
      );
      expect(firstLaunch - lastDown).toBeGreaterThanOrEqual(WAVE_BREATHER_MS);
      expect(firstLaunch - lastDown).toBeLessThanOrEqual(
        WAVE_BREATHER_MS + 3000,
      );
      // The breather's banner state went out before the launches.
      const banner = sim.states.find((x) => x.s.wave === w && x.s.phase === 1);
      expect(banner && banner.at < firstLaunch).toBe(true);
    }
  });

  it("every enemy is born on an airship: several take turns, launched once, its first pose its launch's release pose", () => {
    expect(sim.launched.length).toBeGreaterThan(10);
    // Z1: the launches spread across the fleet.
    expect(new Set(sim.launched.map((l) => l.ship.id)).size).toBeGreaterThan(2);
    for (const l of sim.launched) {
      const spawns = sim.released.get(l.id);
      if (!spawns) continue; // still on its rig at the end
      // Launched once: a downed enemy never comes back.
      expect(spawns).toHaveLength(1);
      const want = launchSpawnAt(l.ship, l.launch);
      expect(spawns[0]?.pos).toEqual(want.pos);
      expect(spawns[0]?.yaw).toBe(want.yaw);
      expect(sim.launched.filter((o) => o.id === l.id)).toHaveLength(1);
    }
    // Nothing but launches ever joined the roster.
    for (const id of sim.roster) {
      expect(sim.launched.some((l) => l.id === id)).toBe(true);
    }
  });

  it("a downed enemy leaves the room after its kill-cam instead of respawning", () => {
    expect(sim.downs.length).toBeGreaterThan(8);
    for (const d of sim.downs) {
      const gone = sim.left.get(d.id);
      if (gone === undefined) {
        // Downed in the last kill-cam of the run.
        expect(sim.now - d.at).toBeLessThan(3000);
        continue;
      }
      expect(gone - d.at).toBeGreaterThanOrEqual(2500);
      expect(gone - d.at).toBeLessThan(2500 + 2 * DT);
    }
  });
});

/** The wave an enemy flew in (from its launch-time state). */
function waveOf(sim: Sim, id: string): number {
  const l = sim.launched.find((x) => x.id === id);
  if (!l) return 0;
  let wave = 0;
  for (const { at, s } of sim.states) {
    if (at > l.at) break;
    if (s.phase === WAVE_LIVE) wave = s.wave;
  }
  return wave;
}

describe("W1 waves: enemies target only humans", () => {
  it("contacts, quarries, targets and trigger pulls name humans and nothing else — spread across both", () => {
    const sim = makeSim(9, [H1, H2]);
    fly(sim, 60_000, 12_000);
    const humans = new Set([H1.id, H2.id]);
    // The contact list itself: humans only.
    expect(
      humanContacts(sim.humans)
        .map((c) => c.id)
        .sort(),
    ).toEqual([...humans].sort());
    expect(sim.aims.length).toBeGreaterThan(1000);
    for (const id of sim.aims) expect(humans.has(id)).toBe(true);
    for (const id of sim.shotTargets) expect(humans.has(id)).toBe(true);
    // Several humans: the wave spreads over them.
    const hunted = new Set(sim.aims);
    expect(hunted.has(H1.id) && hunted.has(H2.id)).toBe(true);
  }, 120_000);
});

describe("W1 waves: the fleet loop", () => {
  it("downing a ship takes its rigs' planes, its flying ones fight on, the counter counts it and the lane refills", () => {
    const sim = makeSim(3, [H1]);
    // Wave 1 up and flying, nobody shot down.
    let flying: string | null = null;
    while (flying === null) {
      step(sim);
      if (sim.now > T0 + 60_000) throw new Error("wave 1 never flew");
      flying =
        sim.waves.enemies().find((e) => sim.bots.contactOf(e.id))?.id ?? null;
    }
    const launched = sim.launched.find((l) => l.id === flying) as Launched;
    const ship = launched.ship;
    const wave = sim.waves.state().wave;
    expect(sim.waves.state().downs).toBe(0);
    // Its hull shot out, then the room's down path (index.ts shipDowned →
    // RoomWaves.shipDown).
    let downAt: number | null = null;
    for (let n = 0; n < 200 && downAt === null; n++) {
      const hit = sim.boss.damage(H1.id, ship.id, -1, sim.now, sim.world);
      if (hit?.down) downAt = hit.down.t;
    }
    if (downAt === null) throw new Error("the ship never went down");
    const onRig = sim.waves
      .enemies()
      .filter((e) => e.carrier === ship.id && !sim.combat.isAlive(e.id))
      .map((e) => e.id);
    sim.waves.shipDown(ship);
    // The plane it launched fights on; the ones still on its rigs are gone.
    expect(sim.combat.isAlive(flying)).toBe(true);
    expect(sim.downs.some((d) => d.id === flying)).toBe(false);
    for (const id of onRig) expect(sim.roster.has(id)).toBe(false);
    expect(sim.waves.state().downs).toBe(1);
    expect(sim.waves.state().wave).toBe(wave);
    expect(sim.states.at(-1)?.s.downs).toBe(1);
    // The lane flies again.
    const before = sim.ships.length;
    while (sim.ships.length === before) {
      step(sim);
      if (sim.now > downAt + 60_000) throw new Error("no refill");
    }
    const refill = sim.ships.at(-1) as FleetShip;
    expect(refill.lane).toBe(ship.lane);
    expect(refill.t0 - downAt).toBeGreaterThanOrEqual(TUNING.refillMs);
  }, 120_000);
});

describe("W1 waves: deterministic replay", () => {
  it("one seed replays the same war: the same launches, releases and flight", () => {
    const run = () => {
      const sim = makeSim(11, [H1, H2]);
      fly(sim, 40_000, 6000);
      return {
        launched: sim.launched.map((l) => [
          l.at,
          l.id,
          l.launch.kind,
          l.launch.t0,
        ]),
        released: [...sim.released],
        downs: sim.downs.map((d) => [d.at, d.id, d.death.cause]),
        states: sim.states,
        flying: sim.waves.enemies().map((e) => [e.id, sim.bots.poseOf(e.id)]),
      };
    };
    const a = run();
    expect(a.launched.length).toBeGreaterThan(5);
    expect(run()).toEqual(a);
  }, 120_000);
});

describe("E1: the air force", () => {
  // NORMAL, one human hanging over the middle of the city, nobody shooting:
  // the pilots launch off the fleet one by one and fill the sky to the
  // level.
  let sim: Sim;
  const planesUp: number[] = [];
  let maxPilotAces = 0;
  let overCapPromotions = 0;
  let maxWave = 0;
  let collisions = 0;
  let pilotSeen = 0;
  const promotedOnce = new Set<string>();
  const demoted = new Set<string>();
  beforeAll(() => {
    sim = makeSim(21, [H1], true);
    const index = buildCityIndex(sim.world.buildings);
    const wasAce = new Map<string, boolean>();
    let promoted = 0;
    for (let t = 0; t < 120_000; t += DT) {
      step(sim);
      const promotedNow = sim.waves.pilots.stats.promotions > promoted;
      promoted = sim.waves.pilots.stats.promotions;
      let up = 0;
      let aces = 0;
      let wave = 0;
      for (const e of sim.waves.enemies()) {
        if (e.down) continue;
        if (!e.pilot) wave++;
        if (e.pilot) up++;
        const pose = sim.bots.poseOf(e.id);
        if (!pose) continue;
        const ace = !sim.bots.isPilot(e.id);
        if (e.pilot && ace) aces++;
        if (e.pilot && !ace) {
          pilotSeen++;
          if (
            collideCity(pose.pos, PLAYER_RADIUS, sim.world.buildings, index)
          ) {
            collisions++;
          }
        }
        if (e.pilot) {
          if (wasAce.get(e.id) === true && !ace) demoted.add(e.id);
          if (ace) promotedOnce.add(e.id);
          wasAce.set(e.id, ace);
        }
      }
      planesUp.push(up);
      maxPilotAces = Math.max(maxPilotAces, aces);
      // A promotion never takes the room past its cap (a wave plane
      // launched later may; a visible ace is never forced back).
      if (promotedNow && aces + wave > aceCap(1)) overCapPromotions++;
      maxWave = Math.max(maxWave, wave);
    }
  }, 300_000);

  it("fills the sky to the level's count (less the wave's planes), never past it", () => {
    const level = AIR_FORCE[1] as number;
    expect(Math.max(...planesUp)).toBeLessThanOrEqual(level);
    expect(Math.max(...planesUp)).toBeGreaterThanOrEqual(level - ENEMY_CAP);
    expect(sim.waves.state().force).toBe(planesUp.at(-1));
    // I1: every pilot is its own launch off a rig, spread over the fleet…
    const pilotLaunches = sim.launched.filter(
      (l) => sim.waves.enemy(l.id)?.pilot,
    );
    expect(pilotLaunches.length).toBeGreaterThanOrEqual(level - ENEMY_CAP);
    expect(new Set(pilotLaunches.map((l) => l.ship.id)).size).toBeGreaterThan(
      2,
    );
    // …and they leave one at a time: hardly two at the same moment.
    const releases = pilotLaunches.map((l) => launchReleaseAt(l.launch));
    expect(new Set(releases).size).toBeGreaterThan(releases.length * 0.9);
  });

  it("flies its pilots clear of every building", () => {
    expect(pilotSeen).toBeGreaterThan(100_000);
    expect(collisions).toBe(0);
    expect(sim.waves.pilots.stats.clamps).toBe(0);
  });

  it("hands the planes near the human to the brain, within the ace cap, and back out of sight", () => {
    expect(promotedOnce.size).toBeGreaterThan(0);
    expect(maxPilotAces).toBeLessThanOrEqual(aceCap(1));
    expect(overCapPromotions).toBe(0);
    expect(sim.waves.pilots.stats.promotions).toBeGreaterThan(0);
    // The aces it handed back went back to their own pilots.
    expect(demoted.size).toBe(sim.waves.pilots.stats.demotions);
  });

  it("is not the wave: the banner's count is the wave's planes alone", () => {
    for (const { s } of sim.states) {
      if (s.phase === WAVE_LIVE) expect(s.size).toBeLessThanOrEqual(ENEMY_CAP);
    }
    expect(maxWave).toBeLessThanOrEqual(ENEMY_CAP);
  });

  it("shoots at humans only", () => {
    for (const id of sim.shotTargets) expect(id).toBe(H1.id);
  });

  it("refills what goes down, and a downed air-force plane leaves the room", () => {
    const up = sim.waves
      .enemies()
      .filter((e) => e.pilot && sim.bots.contactOf(e.id));
    const victims = up.slice(0, 16).map((e) => e.id);
    for (const id of victims) shootDown(sim, id);
    const before = sim.waves.state().force;
    for (let t = 0; t < 30_000; t += DT) step(sim);
    for (const id of victims) expect(sim.roster.has(id)).toBe(false);
    expect(sim.waves.state().force).toBeGreaterThanOrEqual(before);
  }, 120_000);
});
