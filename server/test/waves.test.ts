// W1 Carrier War, server side (server/src/waves.ts) on the room's real
// carrier (BossDirector), pilots (RoomBots, the seeded city, its movers and
// trees) and Combat — the same objects index.ts wires, ticked the way its
// loop ticks them, with a host that records what the room would broadcast:
//
//  - waves come in their cadence (3, then +1..+2 up to the cap, a breather
//    between) and never put more than the cap in the air;
//  - every enemy is born at the carrier: its first pose is its launch's
//    release pose, it is launched once, and once down it leaves the room;
//  - enemies hunt humans only — their contacts, quarries, targets and
//    trigger pulls name humans and nothing else;
//  - shooting the carrier down takes its planes with it, and the next
//    carrier comes NEXT_CARRIER_MS later, one tier up, with the next wave;
//  - one seed replays the same war exactly.

import {
  BOSS_FAST_TUNING,
  BOSS_WEAK_POINTS,
  type BossLaunch,
  type BossRaid,
  type BossTuning,
  decodeLaunch,
  launchSpawnAt,
  raidTier,
} from "@angels-bandits/common/boss";
import { generateCity, mulberry32 } from "@angels-bandits/common/city";
import {
  type MoverField,
  generateMovers,
} from "@angels-bandits/common/city/movers";
import { natureFor } from "@angels-bandits/common/city/nature";
import { buildNatureIndex } from "@angels-bandits/common/collision";
import { CITY_SEED, TICK_DOWN_HZ } from "@angels-bandits/common/constants";
import type { SpawnState } from "@angels-bandits/common/protocol";
import {
  ENEMY_CAP,
  NEXT_CARRIER_MS,
  WAVE_BREATHER_MS,
  WAVE_LEVELS,
  WAVE_LIVE,
  type WaveState,
  decodeWaves,
} from "@angels-bandits/common/waves";
import type { Vec3 } from "@angels-bandits/common/world";
import { beforeAll, describe, expect, it } from "vitest";
import { BossDirector } from "../src/boss";
import { RoomBots } from "../src/bots";
import { Combat, type Death } from "../src/combat";
import { createRoomCity } from "../src/destruction";
import { RoomWaves, type WaveHuman, humanContacts } from "../src/waves";

const CITY = generateCity(CITY_SEED);
const MOVERS = generateMovers(CITY_SEED, CITY);
const NATURE = buildNatureIndex(natureFor(CITY_SEED, CITY));
const T0 = 1_790_000_000_000;
const DT = 1000 / TICK_DOWN_HZ;

/** A carrier 1 s after the humans arrive, on station for the whole test,
 * full HP (tier-scaled). */
const TUNING: BossTuning = {
  ...BOSS_FAST_TUNING,
  firstMinMs: 1000,
  firstMaxMs: 1000,
  orbitMs: 900_000,
  hpScale: 1,
};

interface Launched {
  id: string;
  launch: BossLaunch;
  raid: BossRaid;
  at: number;
}

/** One simulated room and everything it broadcast. */
interface Sim {
  now: number;
  boss: BossDirector;
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
  raids: BossRaid[];
}

function makeSim(seed: number, humans: { id: string; pos: Vec3 }[]): Sim {
  const rc = createRoomCity(CITY);
  const boss = new BossDirector(mulberry32(seed ^ 0xb055), TUNING);
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
    raids: [],
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
        const raid = boss.slot.raid;
        if (l && raid) {
          sim.launched.push({ id: msg.bot, launch: l, raid, at: sim.now });
        }
      } else if (msg.type === "waves") {
        const s = decodeWaves(msg.w);
        if (s) sim.states.push({ at: sim.now, s });
      }
    },
    // The room's death path (index.ts sendDeath) reports every death.
    death: (death, now) => down(sim, death, now),
  });
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

/** One server tick, in index.ts's order: the carrier then its waves, the
 * respawn pass, then the pilots. */
function step(sim: Sim): void {
  const now = (sim.now += DT);
  const out = sim.boss.tick(now, true, sim.humans, sim.world);
  if (out.started) sim.raids.push(out.started);
  sim.waves.tick(now, true, sim.humans);
  for (const id of sim.combat.tick(now).respawnsDue) {
    const r = sim.waves.release(id, now);
    if (r && r !== "wait") {
      const list = sim.released.get(id) ?? [];
      list.push(r);
      sim.released.set(id, list);
    }
  }
  const { shots, crashes } = sim.bots.tick(now, humanContacts(sim.humans));
  for (const s of shots) sim.shotTargets.push(s.targetId);
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
    // leaves the carrier.
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

  it("every enemy is born at the carrier: launched once, its first pose its launch's release pose", () => {
    expect(sim.launched.length).toBeGreaterThan(10);
    // Both rigs launched (belly trapeze and dorsal catapult).
    expect(new Set(sim.launched.map((l) => l.launch.kind)).size).toBe(2);
    for (const l of sim.launched) {
      const spawns = sim.released.get(l.id);
      if (!spawns) continue; // still on its rig at the end
      // Launched once: a downed enemy never comes back.
      expect(spawns).toHaveLength(1);
      const want = launchSpawnAt(l.raid, l.launch);
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

describe("W1 waves: the carrier loop", () => {
  it("downing the carrier takes its planes with it; the next carrier comes 20 s later, a tier up, with the next wave", () => {
    const sim = makeSim(3, [H1]);
    // Wave 1 up, nobody shot down.
    while (
      sim.launched.length < 3 ||
      sim.waves.enemies().every((e) => !sim.bots.contactOf(e.id))
    ) {
      step(sim);
      if (sim.now > T0 + 60_000) throw new Error("wave 1 never flew");
    }
    const raid = sim.boss.slot.raid as BossRaid;
    expect(raidTier(raid)).toBe(1);
    const before = sim.waves.state().wave;
    // Every weak point shot out, then the room's down path (index.ts
    // bossDowned → RoomWaves.carrierDown).
    let downAt: number | null = null;
    for (let k = 0; k < BOSS_WEAK_POINTS.length; k++) {
      for (let n = 0; n < 2000 && downAt === null; n++) {
        const hit = sim.boss.damage(H1.id, k, sim.now, sim.world);
        if (!hit) break;
        if (hit.down) downAt = hit.down.t;
      }
    }
    if (downAt === null) throw new Error("the carrier never went down");
    const enemiesBefore = sim.waves.enemies().map((e) => e.id);
    sim.waves.carrierDown(raid, sim.now);
    // Every plane it launched is down with it — scuttled, nobody's kill —
    // or, still on a rig, gone at once.
    for (const id of enemiesBefore) {
      const d = sim.downs.find((x) => x.id === id);
      if (d) {
        expect(d.death.cause).toBe("carrier");
        expect(d.death.killerId).toBeNull();
      } else {
        expect(sim.roster.has(id)).toBe(false);
      }
    }
    expect(sim.waves.state().left).toBe(0);
    // The next carrier: NEXT_CARRIER_MS after the down, one tier up.
    while (sim.raids.length < 2) {
      step(sim);
      if (sim.now > downAt + 60_000) throw new Error("no next carrier");
    }
    const next = sim.raids[1] as BossRaid;
    expect(next.t0 - downAt).toBeGreaterThanOrEqual(NEXT_CARRIER_MS);
    expect(next.t0 - downAt).toBeLessThanOrEqual(NEXT_CARRIER_MS + DT);
    expect(raidTier(next)).toBe(2);
    expect(next.hpScale).toBeGreaterThan(raid.hpScale);
    // …and its first wave is the war's next one, launched off IT.
    fly(sim, 12_000, null);
    expect(sim.waves.state().wave).toBe(before + 1);
    const fresh = sim.launched.filter((l) => l.at > next.t0);
    expect(fresh.length).toBeGreaterThan(0);
    for (const l of fresh) expect(l.launch.raid).toBe(next.id);
    // The scuttled planes are gone after their kill-cam.
    for (const id of enemiesBefore) expect(sim.roster.has(id)).toBe(false);
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
