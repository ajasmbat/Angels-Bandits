// The canyon-fight sim (B1, ANGE-I5XRNW): 18 rooms of 5 bots for 200 s each,
// in the real seeded city with its movers and nature, plus one scripted HIGH
// human orbiting at 300 m — the player the canyon bots must neither ignore
// nor be dragged up after. It is the harness the ticket's numbers come from,
// so it runs the full Combat loop: bot fire, kills, crashes, respawns.
//
// ~30 s of CPU, so it is opt-in: `BOT_SIM=1 npx vitest run
// server/test/bot-sim.test.ts`. Plain `npm test` skips it.
//
// D2 breakable buildings: BOT_SIM_DESTROY=<share> gives every room its own
// copy of the city with that share of its chunks destroyed before the fight
// (the rubble included), and BOT_SIM_LIVE=1 lets the fight break it as the
// server does — the same applyShotDamage / applyDeathBlast index.ts calls.
// (The harness has no humans, so it skips the server's "only while a human
// is in the room" gate.) Without either, every room flies the one intact
// seed city exactly as before.
//
// D3 collapses: in either damage mode each room's destruction ticks like the
// server's (tickDestruction), so broken buildings collapse, the debris is in
// the room's mover field (solid for bots, probed at arrival time) and a bot
// crushed by it is a collapse kill. BOT_SIM_COLLAPSE=1 also brings a tower
// down next to the fight every COLLAPSE_EVERY_S (a floor band shot out, as a
// D5 director would): the report counts kills-by-collapse apart from
// crashes, and how often bots entered an active collapse zone vs refused to.
//
// MAIN_* are the same harness's numbers on main before B1 (bots mostly high,
// spawned at RESPAWN_ALTITUDE), same seeds and run length — the bar the
// review set is crashes per bot-minute within 1.15x of them.

import {
  type Building,
  chunkId,
  chunksOf,
  generateCity,
  mulberry32,
  tierGrids,
} from "@angels-bandits/common/city";
import { collapseZoneHit } from "@angels-bandits/common/city/collapse";
import {
  type MoverField,
  generateMovers,
} from "@angels-bandits/common/city/movers";
import { natureFor } from "@angels-bandits/common/city/nature";
import { isInRoadway } from "@angels-bandits/common/city/street";
import {
  buildNatureIndex,
  collideCity,
} from "@angels-bandits/common/collision";
import {
  BLOCK_PITCH,
  BOT_SPAWN_GRACE_MS,
  CITY_SEED,
  CLOUD_BASE,
  PLAYER_RADIUS,
  RESPAWN_ALTITUDE,
  TICK_DOWN_HZ,
  WORLD_SIZE,
} from "@angels-bandits/common/constants";
import type { SpawnState } from "@angels-bandits/common/protocol";
import { type Vec3, wrapDeltaAxis } from "@angels-bandits/common/world";
import { describe, expect, it } from "vitest";
import {
  type BotContact,
  RoomBots,
  applyBotFire,
  landBotRound,
} from "../src/bots";
import { Combat } from "../src/combat";
import {
  type RoomCity,
  applyDeathBlast,
  applyShotDamage,
  collapseCulprit,
  createRoomCity,
  tickDestruction,
} from "../src/destruction";
import { type RespawnEnemy, pickBotRespawn } from "../src/respawn";

const ROOMS = 18;
/** Two disjoint seed sets. Tuning happens on `tune` (BOT_SIM_SET=tune); the
 * assertions run on the HOLDOUT set, so a knob fitted to one set's ±7-crash
 * Poisson noise cannot pass by luck. */
const TUNE = process.env.BOT_SIM_SET === "tune";
const roomSeed = (room: number) => (TUNE ? 2024 + room * 31 : 9001 + room * 97);
const spawnSeed = (room: number) => (TUNE ? 99 + room : 5003 + room * 7);
const BOTS = 5;
/** D2 modes (see the header). */
const DESTROY = Number(process.env.BOT_SIM_DESTROY ?? 0);
const LIVE = process.env.BOT_SIM_LIVE === "1";
/** D3: bring a tower down next to the fight every COLLAPSE_EVERY_S. */
const COLLAPSE = process.env.BOT_SIM_COLLAPSE === "1";
const COLLAPSE_EVERY_S = 20;
const SECONDS = 200;
const DT_MS = 1000 / TICK_DOWN_HZ;
/** The low layer: under the probe split, among the towers. */
const LOW = 110;
/** A spawn "crashed on arrival" if it dies to terrain within this, ms. */
const SPAWN_WINDOW_MS = 20_000;

/** Main before B1 (origin/main ad5480b, bots mostly high and spawned at
 * RESPAWN_ALTITUDE), on this harness and the HOLDOUT seeds, with the N1 trees
 * and H1 holes in the city: 56 crashes in 300 bot-minutes against 271 kills,
 * 17.0% of bot time below 110 m, and 11 of 412 spawns crashing inside
 * SPAWN_WINDOW_MS. (The tuning seeds give 51 crashes.) */
const MAIN_CRASHES_PER_BOT_MIN = 56 / 300;
const MAIN_BELOW_LOW = 0.17;

/** "p10/p50/p90" of a sample, rounded — the crash log's roof-height summary. */
function quantiles(xs: number[]): string {
  if (xs.length === 0) return "-";
  const sorted = [...xs].sort((a, b) => a - b);
  const at = (q: number) =>
    Math.round(
      sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0,
    );
  return `${at(0.1)}/${at(0.5)}/${at(0.9)}`;
}

/** How long a crashed bot had been off the roadway: a corner cut is a
 * fraction of a second, a bot wandering over the blocks is seconds. */
function offRoad(ms: number): string {
  return ms < 1000 ? "<1 s" : ms < 3000 ? "<3 s" : ">=3 s";
}

/** Plan-view distance to the nearest intersection centre, m. */
function cornerDistance(p: Vec3): number {
  const off = (v: number) =>
    Math.abs(v - Math.round(v / BLOCK_PITCH) * BLOCK_PITCH);
  return Math.hypot(off(p.x), off(p.z));
}

/** mulberry32 — a seeded stream for spawn placement, like the room's. */
function seeded(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The scripted human: a 450 m orbit at 300 m, 70 m/s. */
function human(now: number): BotContact {
  const a = (now / 1000) * (70 / 450);
  const wrap = (v: number) => (v + WORLD_SIZE) % WORLD_SIZE;
  return {
    id: "human-1",
    pos: {
      x: wrap(1000 + 450 * Math.cos(a)),
      y: 300,
      z: wrap(1000 + 450 * Math.sin(a)),
    },
    vel: { x: -70 * Math.sin(a), y: 0, z: 70 * Math.cos(a) },
    prot: false,
  };
}

describe.skipIf(!process.env.BOT_SIM)("canyon-fight sim (BOT_SIM=1)", () => {
  it("bots fight low without crashing more than main's high furball", async () => {
    const city = generateCity(CITY_SEED);
    const movers = generateMovers(CITY_SEED, city);
    const nature = buildNatureIndex(natureFor(CITY_SEED, city));
    let samples = 0;
    let below = 0;
    let ceilingBreaches = 0;
    let crashes = 0;
    let kills = 0;
    let humanHits = 0;
    let spawns = 0;
    let streetSpawns = 0;
    let spawnCrashes = 0;
    /** Crashes by state, altitude layer and ground under the bot. */
    const crashKinds = new Map<string, number>();
    /** Roof heights of the buildings bots flew into, m. */
    const roofsHit: number[] = [];
    /** Live ticks a bot spent fighting inside its post-spawn grace. */
    let graceFights = 0;
    /** D2: wall time of every bots.tick, ms, and the share destroyed. */
    const tickMs: number[] = [];
    let destroyedShare = 0;
    let destroyedChunks = 0;
    /** D3: collapse events, bots crushed by them, and the zone telemetry. */
    let collapses = 0;
    let collapseKills = 0;
    let zoneEntries = 0;
    let zoneRefusals = 0;

    for (let room = 0; room < ROOMS; room++) {
      // One room at a time, then let the event loop turn: the whole sim as a
      // single synchronous block (>60 s on a loaded box) starved the vitest
      // worker's RPC, whose fixed 60 s timeout failed the run with
      // "Timeout calling onTaskUpdate" even though the assertions passed.
      if (room > 0) await new Promise<void>((r) => setImmediate(r));
      // D2: a breakable copy per room when a damage mode is on.
      let rc: RoomCity | null = null;
      if (DESTROY > 0 || LIVE || COLLAPSE) {
        rc = createRoomCity(city);
        const rand = mulberry32(roomSeed(room) ^ 0x5eed);
        rc.buildings.forEach((b, i) => {
          for (const id of chunksOf(b, i)) {
            if (rand() < DESTROY) rc?.damage.destroyChunk(id);
          }
        });
      }
      const roomBuildings = rc ? rc.buildings : city;
      // D3: the room's collapses are movers, as on the server.
      const roomMovers: MoverField = rc
        ? { ...movers, collapses: rc.collapses }
        : movers;
      const bots = new RoomBots(
        `room-${room}`,
        roomSeed(room),
        roomBuildings,
        roomMovers,
        true,
        nature,
      );
      const combat = new Combat();
      const rand = seeded(spawnSeed(room));
      const spawnedAt = new Map<string, number>();
      /** Each bot's state, roadway flag and altitude on its last live tick. */
      const last = new Map<
        string,
        {
          state: string;
          road: boolean;
          y: number;
          since: number;
          turn: number;
          roadAt: number;
          from: string;
          exitCorner: number;
        }
      >();
      const pick = (enemies: RespawnEnemy[], now: number): SpawnState => {
        const spawn = pickBotRespawn(
          enemies,
          (pos, yaw) => bots.spawnClear(pos, yaw, now),
          rand,
        );
        spawns++;
        if (spawn.pos.y < RESPAWN_ALTITUDE) streetSpawns++;
        return spawn;
      };
      const roster = bots.syncTo(BOTS, () => pick([], 0)).spawned;
      const inZone = new Set<string>();
      /** D3 director stand-in: shoot out floor band 1 of the standing tower
       * nearest the first living bot (nobody to credit). */
      const knockDown = () => {
        if (!rc) return;
        const anchor = roster
          .map((e) => bots.flightOf(e.id)?.pos)
          .find((p) => p !== undefined);
        if (!anchor) return;
        let best = -1;
        let bestD = Number.POSITIVE_INFINITY;
        rc.buildings.forEach((b: Building, i) => {
          const g = tierGrids(b)[0];
          if (!g || g.ny < 3 || b.height < 40 || b.damage) return;
          const d = Math.hypot(
            wrapDeltaAxis(anchor.x, b.x),
            wrapDeltaAxis(anchor.z, b.z),
          );
          if (d < bestD) {
            bestD = d;
            best = i;
          }
        });
        const b = rc.buildings[best];
        const g = b && tierGrids(b)[0];
        if (!g) return;
        for (let c = g.nx * g.nz; c < 2 * g.nx * g.nz; c++) {
          rc.damage.destroyChunk(chunkId(best, 0, c));
        }
        rc.breakers.set(best, null);
      };
      for (const e of roster) {
        combat.addPlayer(e.id, 0);
        spawnedAt.set(e.id, 0);
      }

      for (let i = 1; i <= SECONDS * TICK_DOWN_HZ; i++) {
        const now = i * DT_MS;
        for (const id of combat.tick(now).respawnsDue) {
          const enemies = roster.flatMap((e) => {
            const c = e.id === id ? null : bots.contactOf(e.id);
            if (!c) return [];
            const speed = Math.hypot(c.vel.x, c.vel.y, c.vel.z);
            const fwd =
              speed > 0
                ? { x: c.vel.x / speed, y: c.vel.y / speed, z: c.vel.z / speed }
                : null;
            return [{ pos: c.pos, fwd }];
          });
          bots.respawn(id, pick(enemies, now));
          combat.respawned(id, now);
          spawnedAt.set(id, now);
        }
        const hi = human(now);
        const contacts: BotContact[] = [hi];
        for (const e of roster) {
          const c = bots.contactOf(e.id);
          if (c)
            contacts.push({
              id: e.id,
              ...c,
              prot: combat.isProtected(e.id, now),
            });
        }

        const t0 = performance.now();
        const result = bots.tick(now, contacts);
        tickMs.push(performance.now() - t0);
        for (const id of result.crashes) {
          const site = bots.lastPosOf(id);
          // D3: crushed by falling debris is a collapse kill, not a crash.
          const culprit =
            rc && site
              ? collapseCulprit(rc, site, PLAYER_RADIUS + 2, now)
              : null;
          if (culprit) {
            const by =
              culprit.by !== null && roster.some((e) => e.id === culprit.by)
                ? culprit.by
                : null;
            const death = combat.collapseKill(id, by, now);
            if (!death) continue;
            collapseKills++;
            if ((LIVE || COLLAPSE) && rc && site) {
              applyDeathBlast(rc, site, death.killerId);
            }
            continue;
          }
          if (!combat.crash(id, now)) continue;
          crashes++;
          if (LIVE && rc && site) applyDeathBlast(rc, site);
          const fresh = now - (spawnedAt.get(id) ?? 0) < SPAWN_WINDOW_MS;
          if (fresh) spawnCrashes++;
          const l = last.get(id);
          // Time in state tells a late RECOVER from a crash mid-chase; the
          // turn input tells whether the bot died turning (a straight probe's
          // blind side) or flying straight into something.
          const inState = l ? (now - l.since) / 1000 : 0;
          const kind = l
            ? `${l.state} ${l.y < LOW ? "low" : "high"} over ${l.road ? "road" : "block"}, ${inState < 0.5 ? "<0.5 s" : inState < 2 ? "<2 s" : ">=2 s"} in state, ${l.turn > 0.3 ? "turning" : "straight"}, off road ${offRoad(now - l.roadAt)} ${l.exitCorner < 40 ? "at a corner" : "mid-street"}, after ${l.from}${fresh ? ", <20 s from spawn" : ""}`
            : "unknown";
          crashKinds.set(kind, (crashKinds.get(kind) ?? 0) + 1);
          const wreck = bots.flightOf(id)?.pos;
          const hit = wreck
            ? collideCity(wreck, PLAYER_RADIUS, roomBuildings)
            : null;
          if (hit) roofsHit.push(hit.height);
        }
        for (const round of result.hits) {
          if (round.shot.targetId === hi.id) {
            humanHits++;
            continue;
          }
          const hit = landBotRound(combat, round, now);
          if (hit.ok && hit.death) {
            const site = bots.lastPosOf(round.shot.targetId);
            if (LIVE && rc && site) {
              applyDeathBlast(rc, site, round.shot.botId);
            }
            bots.setDead(round.shot.targetId);
            kills++;
          }
        }
        for (const s of result.shots) {
          // The human is scripted: its rounds fly (and are counted when they
          // land) without going through Combat.
          if (s.targetId === hi.id) {
            bots.launch(s, now);
            continue;
          }
          if (!combat.isAlive(s.botId)) continue;
          if (applyBotFire(combat, s, now)) {
            bots.launch(s, now);
            if (LIVE && rc) applyShotDamage(rc, s.origin, s.dir, s.botId);
          }
        }

        // D3: the server's destruction tick (plus the director's knock-down).
        if (rc && (LIVE || COLLAPSE)) {
          if (COLLAPSE && i % (COLLAPSE_EVERY_S * TICK_DOWN_HZ) === 0) {
            knockDown();
          }
          collapses += tickDestruction(rc, now).collapses.length;
        }

        for (const e of roster) {
          const f = bots.flightOf(e.id);
          if (!f || !bots.poseOf(e.id)) continue;
          samples++;
          if (rc && rc.collapses.list.length > 0) {
            const inside = collapseZoneHit(f.pos, 0, rc.collapses.list, now);
            if (inside && !inZone.has(e.id)) zoneEntries++;
            if (inside) inZone.add(e.id);
            else inZone.delete(e.id);
          }
          const state = bots.stateOf(e.id);
          if (
            now - (spawnedAt.get(e.id) ?? 0) < BOT_SPAWN_GRACE_MS &&
            (state === "ENGAGE" || state === "EVADE")
          ) {
            graceFights++;
          }
          const prev = last.get(e.id);
          const nowState = state ?? "?";
          last.set(e.id, {
            state: nowState,
            road: isInRoadway(f.pos),
            y: f.pos.y,
            since: prev?.state === nowState ? prev.since : now,
            turn: Math.abs(bots.inputOf(e.id)?.turn ?? 0),
            roadAt: isInRoadway(f.pos) ? now : (prev?.roadAt ?? now),
            from:
              prev && prev.state !== nowState
                ? prev.state
                : (prev?.from ?? "-"),
            exitCorner:
              isInRoadway(f.pos) || !prev
                ? cornerDistance(f.pos)
                : prev.exitCorner,
          });
          if (f.pos.y < LOW) below++;
          if (f.pos.y > CLOUD_BASE) ceilingBreaches++;
        }
      }
      zoneRefusals += bots.zoneRefusals;
      if (rc) {
        destroyedShare +=
          rc.damage.destroyedCount / rc.damage.chunkCount / ROOMS;
        destroyedChunks += rc.damage.destroyedCount;
      }
    }
    const sortedTicks = [...tickMs].sort((a, b) => a - b);
    const tickAt = (q: number) =>
      sortedTicks[
        Math.min(sortedTicks.length - 1, Math.floor(q * sortedTicks.length))
      ] ?? 0;

    const botMinutes = (ROOMS * BOTS * SECONDS) / 60;
    const stats = {
      belowLow: below / samples,
      crashesPerBotMin: crashes / botMinutes,
      crashShare: crashes / Math.max(1, crashes + kills),
      crashes,
      kills,
      humanHits,
      ceilingBreaches,
      streetSpawnShare: streetSpawns / spawns,
      spawnCrashShare: spawnCrashes / spawns,
      spawns,
    };
    // The before/after table the PR body quotes.
    console.log(
      [
        "metric                 main(before)  branch(after)",
        `below ${LOW} m            ${MAIN_BELOW_LOW.toFixed(3)}         ${stats.belowLow.toFixed(3)}`,
        `crashes / bot-min      ${MAIN_CRASHES_PER_BOT_MIN.toFixed(3)}         ${stats.crashesPerBotMin.toFixed(3)}`,
        `crashes, kills         56, 271       ${crashes}, ${kills}`,
        `crash share            0.171         ${stats.crashShare.toFixed(3)}`,
        `spawn crashes <20 s    11/412        ${spawnCrashes}/${spawns}`,
        `street spawns          0/412         ${streetSpawns}/${spawns}`,
        `hits on high human     22892         ${humanHits}`,
        `D2 mode                destroy=${DESTROY} live=${LIVE ? 1 : 0}, ${(100 * destroyedShare).toFixed(1)}% of chunks destroyed at the end (mean over rooms; ${destroyedChunks} chunks in all)`,
        `bots.tick ms           p50 ${tickAt(0.5).toFixed(2)}  p99 ${tickAt(0.99).toFixed(2)}  max ${tickAt(1).toFixed(2)}`,
        `D3 collapses           ${collapses} events (director=${COLLAPSE ? 1 : 0}), kills-by-collapse ${collapseKills} (not in the crash count above)`,
        `D3 collapse zones      ${zoneEntries} bot entries into an active zone, ${zoneRefusals} probe refusals`,
        "",
        `crash breakdown (${TUNE ? "tune" : "holdout"} seeds; roofs hit p10/p50/p90 m: ${quantiles(roofsHit)}):`,
        ...[...crashKinds]
          .sort((a, b) => b[1] - a[1])
          .map(([k, n]) => `  ${String(n).padStart(3)}  ${k}`),
      ].join("\n"),
    );

    expect(stats.belowLow).toBeGreaterThanOrEqual(0.75);
    expect(ceilingBreaches).toBe(0);
    expect(graceFights).toBe(0);
    expect(humanHits).toBeGreaterThan(0);
    expect(stats.crashesPerBotMin).toBeLessThanOrEqual(
      1.15 * MAIN_CRASHES_PER_BOT_MIN,
    );
    expect(stats.streetSpawnShare).toBeGreaterThanOrEqual(0.9);
    expect(stats.spawnCrashShare).toBeLessThanOrEqual(0.03);
  }, 600_000);
});
