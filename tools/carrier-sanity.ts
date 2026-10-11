// A3 release gate: the Carrier War, played. One scripted NOVICE pilot
// against the real server, production tunings (no AB_*_FAST: the carrier
// already comes 4–6 s after the pilot starts flying), on Easy — the pilot's
// own Easy mode (W4's join flag) and the room's EASY intensity (W1).
//
//   node --import tsx tools/carrier-sanity.ts [--runs 3] [--seed 1]
//        [--out <file.json>] [--timeout 900]
//
// The novice is a plain ws client — no flight sim, no aim help:
//  - it flies a level orbit (250 m) over the AA nests' anchor, the map's
//    middle, at a constant 62 m/s, 140 m up;
//  - it turns its nose toward the nearest enemy within 700 m at a novice's
//    rate (≤ 45°/s), flying where the nose points;
//  - it fires real `fire` rounds (the server's own cadence and heat model)
//    only with an enemy inside a 12° nose cone within 300 m, and claims a
//    hit on about one round in four (a seeded roll — novice accuracy);
//    every claim still has to pass the server's range check;
//  - once wave 1 is cleared it goes for the carrier the same way, a weak
//    point at a time — strafing passes at MIN_SPEED, breaking off inside
//    BREAK_M — claiming (`bossHit`, a line the server re-runs against the
//    hull) only rounds whose line the pure hull model says meets a live weak
//    point first: full accuracy there, since what is checked is the carrier
//    loop, not the novice.
//
// Clearing wave 1 is the pilot's guns AND the rooftop AA together — the
// game's design; the report says who downed what.
//
// PASS (exit 0) needs every run to pass every check:
//  1. wave 1 goes LIVE and is cleared within WAVE1_CLEAR_S of going live;
//  2. the pilot is never shot down between wave 1 going live and its clear;
//  3. at least one enemy goes down to a rooftop AA nest (cause "aa");
//  4. at least one enemy bomb falls, and every bomb lands on the city's
//     surface — never above what the intact city has there (a roof, the
//     street, a bridge deck, or the river's water off the decks) by more
//     than SURFACE_M (a burst in mid-air), never below the floor (a broken
//     roof's stump is lower than the intact roof, and fine) — and at least
//     SPAWN_CLEAR_M in plan from EVERY spawn point the pilot was given in
//     the run, at any time;
//  5. the carrier goes down within CARRIER_DOWN_S of the start, and the
//     next carrier's raid arrives within NEXT_CARRIER_MS + 10 s of it.
// After the next carrier the novice flies the war on (orbit and engage)
// until it has seen MIN_BOMBS bombs or --timeout runs out.
// A JSON report (per run: the timeline, every bomb, every kill by cause)
// goes to --out.

import { type ChildProcess, spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  BOSS_WEAK_POINTS,
  type BossRaid,
  blankPose,
  bossPoseAt,
  bossRayHit,
  decodeRaid,
  raidMaxHp,
  weakPointInto,
} from "@angels-bandits/common/boss";
import {
  type Building,
  generateCity,
  standingTopAt,
} from "@angels-bandits/common/city";
import {
  BRIDGE_HALF_WIDTH,
  RIVER_WATER_Y,
  minAltitude,
  overChannel,
} from "@angels-bandits/common/city/river";
import {
  canFire,
  cooledGunHeat,
  createGunHeat,
  firedGunHeat,
} from "@angels-bandits/common/combat";
import {
  BLOCK_PITCH,
  BULLET_RANGE,
  CITY_SEED,
  MIN_SPEED,
  WORLD_SIZE,
} from "@angels-bandits/common/constants";
import { decodeSnapshotEntry } from "@angels-bandits/common/net";
import type { ServerMsg } from "@angels-bandits/common/protocol";
import {
  type MissileStrike,
  decodeMissile,
} from "@angels-bandits/common/strike";
import {
  NEXT_CARRIER_MS,
  WAVE_BREATHER,
  WAVE_IDLE,
  WAVE_LIVE,
  type WaveState,
  decodeWaves,
} from "@angels-bandits/common/waves";
import {
  type Vec3,
  canonicalize,
  wrapDelta,
  wrapDeltaAxis,
  wrapDistance,
} from "@angels-bandits/common/world";
import WebSocket from "ws";

const args = process.argv.slice(2);
const opt = (name: string, dflt: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? (args[i + 1] as string) : dflt;
};
const RUNS = Number(opt("runs", "1"));
const SEED = Number(opt("seed", "1"));
const OUT = opt("out", "");
const TIMEOUT_S = Number(opt("timeout", "900"));

// --- The checks' numbers ---------------------------------------------------------

/** Wave 1 cleared within this of going live, s. */
const WAVE1_CLEAR_S = 240;
/** The carrier down within this of the pilot's first pose, s. */
const CARRIER_DOWN_S = 600;
/** The next raid within NEXT_CARRIER_MS + this of the last one going down. */
const NEXT_SLACK_MS = 10_000;
/** A bomb's impact this close to the surface under it counts as on it, m. */
const SURFACE_M = 3;
/** No bomb within this of any spawn point, plan view, m — the server's own
 * respawn quiet radius (server/src/strikes.ts respawnClearM), held at all
 * times here rather than only inside its 5 s window. */
const SPAWN_CLEAR_M = 150;
/** A run flies on past the next carrier until it has seen this many enemy
 * bombs (Easy's first waves bomb rarely), up to --timeout. */
const MIN_BOMBS = 3;

// --- The novice --------------------------------------------------------------------

const POSE_HZ = 30;
const SPEED = 62;
const TURN_RATE = (45 * Math.PI) / 180;
const ORBIT = { x: WORLD_SIZE / 2, z: WORLD_SIZE / 2, r: 250, y: 140 };
const ENGAGE_M = 700;
const FIRE_CONE = (12 * Math.PI) / 180;
const FIRE_M = 300;
const NOVICE_HIT = 0.25;
/** The carrier run: extend to this far off the weak point, and break off a
 * pass inside BREAK_M, m. */
const STANDOFF_M = 250;
const BREAK_M = 90;
const BOSS_FIRE_CONE = (2.5 * Math.PI) / 180;
const PITCH_MAX = (60 * Math.PI) / 180;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Nose for (yaw, pitch): yaw 0 faces −Z, positive pitch climbs. */
const noseOf = (yaw: number, pitch: number): Vec3 => ({
  x: -Math.sin(yaw) * Math.cos(pitch),
  y: Math.sin(pitch),
  z: -Math.cos(yaw) * Math.cos(pitch),
});
/** q = yaw about +Y, then pitch about the local +X: its nose is noseOf. */
function quatOf(yaw: number, pitch: number) {
  const cy = Math.cos(yaw / 2);
  const sy = Math.sin(yaw / 2);
  const cp = Math.cos(pitch / 2);
  const sp = Math.sin(pitch / 2);
  return { x: cy * sp, y: sy * cp, z: -sy * sp, w: cy * cp };
}
const angleBetween = (a: Vec3, b: Vec3): number =>
  Math.acos(Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y + a.z * b.z)));
const unit = (v: Vec3): Vec3 => {
  const l = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / l, y: v.y / l, z: v.z / l };
};
const wrapAngle = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));

// --- The city's surface, for the bomb check ------------------------------------------

const city: Building[] = generateCity(CITY_SEED);
/** The intact city's surface under (x, z): the tallest building top there,
 * else a bridge deck (the street plane) or the river's water over the open
 * channel, else the street. */
function surfaceAt(x: number, z: number): { y: number; on: string } {
  let best = -1;
  for (const b of city) {
    const lx = wrapDeltaAxis(b.x, x);
    const lz = wrapDeltaAxis(b.z, z);
    if (Math.abs(lx) > b.width / 2 || Math.abs(lz) > b.depth / 2) continue;
    best = Math.max(best, standingTopAt(b, lx, lz));
  }
  if (best > 0) return { y: best, on: "roof" };
  if (!overChannel(z)) return { y: 0, on: "street" };
  const off = wrapDeltaAxis(Math.round(x / BLOCK_PITCH) * BLOCK_PITCH, x);
  return Math.abs(off) <= BRIDGE_HALF_WIDTH
    ? { y: 0, on: "bridge" }
    : { y: RIVER_WATER_Y, on: "river" };
}

// --- One run -----------------------------------------------------------------------------

interface Bomb {
  id: number;
  by: string;
  to: Vec3;
  t0: number;
  surface: number;
  on: string;
  /** Plan distance to the nearest spawn point of the run, m. */
  spawnM: number;
}

interface RunReport {
  run: number;
  seed: number;
  pass: boolean;
  checks: Record<string, { pass: boolean; detail: string }>;
  timeline: { s: number; what: string }[];
  kills: Record<string, number>;
  pilot: {
    shots: number;
    claims: number;
    bossClaims: number;
    deaths: string[];
  };
  bombs: Bomb[];
}

function startServer(): Promise<{ child: ChildProcess; url: string }> {
  const entry = fileURLToPath(
    new URL("../server/src/index.ts", import.meta.url),
  );
  const child = spawn(process.execPath, ["--import", "tsx", entry], {
    env: { ...process.env, PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let errors = "";
  child.stderr?.on("data", (b: Buffer) => {
    errors += b.toString();
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`server never announced a port\n${errors}`)),
      30_000,
    );
    child.stdout?.on("data", (buf: Buffer) => {
      const port = /listening on :(\d+)/.exec(buf.toString())?.[1];
      if (!port) return;
      clearTimeout(timer);
      resolve({ child, url: `ws://127.0.0.1:${port}` });
    });
    child.on("exit", (code) =>
      reject(new Error(`server exited ${code}\n${errors}`)),
    );
  });
}

function fly(url: string, run: number, seed: number): Promise<RunReport> {
  const rand = mulberry32(seed);
  const ws = new WebSocket(url);
  const startWall = performance.now();
  const sinceS = () => (performance.now() - startWall) / 1000;
  const timeline: { s: number; what: string }[] = [];
  const note = (what: string) => {
    timeline.push({ s: Math.round(sinceS() * 10) / 10, what });
    console.log(`  [run ${run}] ${sinceS().toFixed(1).padStart(6)} s  ${what}`);
  };

  let selfId = "";
  let pos: Vec3 = { x: 0, y: 0, z: 0 };
  let yaw = 0;
  let pitch = 0;
  let alive = false;
  let seq = 0;
  let heat = createGunHeat(0);
  const bots = new Set<string>();
  const enemies = new Map<string, Vec3>();
  const spawns: Vec3[] = [];
  const kills: Record<string, number> = {};
  const deaths: string[] = [];
  const bombs: MissileStrike[] = [];
  const bombBy = new Map<number, string>();
  let shots = 0;
  let claims = 0;
  let bossClaims = 0;
  let aaKills = 0;
  // The server clock, from the newest snapshot.
  let snapTime = 0;
  let snapAt = 0;
  const serverNow = () => snapTime + (performance.now() - snapAt);
  // The war.
  let waves: WaveState | null = null;
  let wave1LiveS: number | null = null;
  let wave1ClearS: number | null = null;
  let deathsInWave1 = 0;
  let raid: BossRaid | null = null;
  let raidHp: number[] = [];
  let firstRaidId: number | null = null;
  let carrierDownS: number | null = null;
  let carrierDownId: number | null = null;
  let nextRaidS: number | null = null;
  const bossPose = blankPose();
  let carrierRun = false;
  let extending = false;
  let hpLoggedAt = 0;
  const wp: Vec3 = { x: 0, y: 0, z: 0 };

  const send = (m: unknown) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
  };

  const spawnAt = (s: { pos: Vec3; yaw: number }) => {
    pos = { ...s.pos };
    yaw = s.yaw;
    pitch = 0;
    alive = true;
    spawns.push({ ...s.pos });
  };

  /** Turn the nose toward `want` at the novice's rate. */
  const steer = (want: Vec3, dt: number) => {
    const d = unit(want);
    const wantYaw = Math.atan2(-d.x, -d.z);
    const wantPitch = Math.max(-PITCH_MAX, Math.min(PITCH_MAX, Math.asin(d.y)));
    const step = TURN_RATE * dt;
    const dy = wrapAngle(wantYaw - yaw);
    const dp = wantPitch - pitch;
    const mag = Math.hypot(dy, dp);
    const k = mag > step ? step / mag : 1;
    yaw = wrapAngle(yaw + dy * k);
    pitch += dp * k;
  };
  /** A climb/dive toward altitude `y` blended into `dir`. */
  const holdAlt = (dir: Vec3, y: number): Vec3 => {
    const flat = Math.hypot(dir.x, dir.z) || 1;
    const climb = Math.max(-0.6, Math.min(0.6, (y - pos.y) / 120));
    return { x: dir.x / flat, y: climb, z: dir.z / flat };
  };

  const tryFire = (): number | null => {
    const now = performance.now();
    heat = cooledGunHeat(heat, now);
    // A margin under the lock, so the server's own model never refuses.
    if (!canFire(heat, now + 15) || heat.heat > 0.8) return null;
    heat = firedGunHeat(heat, now);
    seq++;
    shots++;
    send({ type: "fire", seq });
    return seq;
  };

  const tick = (dt: number) => {
    if (!alive) return;
    carrierRun = wave1ClearS !== null && raid !== null && carrierDownS === null;
    if (!carrierRun) {
      // Engage the nearest enemy, else orbit the AA anchor.
      let best: [string, Vec3, number] | null = null;
      for (const [id, p] of enemies) {
        const d = wrapDistance(pos, p);
        if (d < ENGAGE_M && (!best || d < best[2])) best = [id, p, d];
      }
      if (best) {
        const to = wrapDelta(pos, best[1]);
        steer(to, dt);
        const ang = angleBetween(noseOf(yaw, pitch), unit(to));
        if (ang < FIRE_CONE && best[2] < FIRE_M) {
          const s = tryFire();
          if (s !== null && rand() < NOVICE_HIT) {
            claims++;
            send({
              type: "hit",
              targetId: best[0],
              bulletOrigin: pos,
              seq: s,
              delay: 100,
            });
          }
        }
      } else {
        const rel = wrapDelta({ x: ORBIT.x, y: pos.y, z: ORBIT.z }, pos);
        const r = Math.hypot(rel.x, rel.z) || 1;
        const tangent = { x: -rel.z / r, y: 0, z: rel.x / r };
        const pull = Math.max(-1, Math.min(1, (r - ORBIT.r) / 150));
        steer(
          holdAlt(
            {
              x: tangent.x - (rel.x / r) * pull,
              y: 0,
              z: tangent.z - (rel.z / r) * pull,
            },
            ORBIT.y,
          ),
          dt,
        );
      }
    } else {
      // The carrier run: the live weak point whose line is clearest.
      const t = serverNow();
      bossPoseAt(raid, t, bossPose);
      const live = raidHp.map((h) => h > 0);
      let target = -1;
      let targetD = Number.POSITIVE_INFINITY;
      for (let k = 0; k < BOSS_WEAK_POINTS.length; k++) {
        if (!live[k]) continue;
        weakPointInto(bossPose, k, wp);
        const d = wrapDistance(pos, wp);
        if (d < targetD) {
          target = k;
          targetD = d;
        }
      }
      if (target >= 0) {
        weakPointInto(bossPose, target, wp);
        const to = wrapDelta(pos, wp);
        if (extending) {
          // Extend out to a stand-off point on the weak point's side, then
          // turn in for the next pass.
          const side = wrapDelta({ x: bossPose.x, y: wp.y, z: bossPose.z }, wp);
          const sl = Math.hypot(side.x, side.z) || 1;
          const aim = {
            x: wp.x + (side.x / sl) * STANDOFF_M,
            y: wp.y + 20,
            z: wp.z + (side.z / sl) * STANDOFF_M,
          };
          const toAim = wrapDelta(pos, aim);
          steer(toAim, dt);
          if (Math.hypot(toAim.x, toAim.y, toAim.z) < 60) extending = false;
        } else {
          steer(to, dt);
          if (targetD < BREAK_M) extending = true;
          const n = noseOf(yaw, pitch);
          if (angleBetween(n, unit(to)) < BOSS_FIRE_CONE) {
            // Claim only what the round's own line meets first.
            const hit = bossRayHit(bossPose, pos, n, BULLET_RANGE, live);
            if (hit && hit.weak >= 0) {
              const s = tryFire();
              if (s !== null) {
                bossClaims++;
                send({
                  type: "bossHit",
                  wp: hit.weak,
                  seq: s,
                  bulletOrigin: pos,
                  dir: n,
                  t: Math.round(t - 30),
                });
              }
            }
          }
        }
      }
    }
    // Fly where the nose points; never into the ground or the ceiling.
    // The carrier run flies slow (MIN_SPEED) for longer passes.
    const v = carrierRun ? MIN_SPEED : SPEED;
    const n = noseOf(yaw, pitch);
    pos = canonicalize({
      x: pos.x + n.x * v * dt,
      y: Math.max(40, Math.min(420, pos.y + n.y * v * dt)),
      z: pos.z + n.z * v * dt,
    });
    send({ type: "pose", pose: { pos, quat: quatOf(yaw, pitch), speed: v } });
  };

  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setInterval> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let last = performance.now();
    const finish = () => {
      clearInterval(timer);
      clearTimeout(deadline);
      ws.close();
      resolve(report());
    };
    const report = (): RunReport => {
      const bombRows: Bomb[] = bombs.map((m) => {
        const s = surfaceAt(m.to.x, m.to.z);
        let near = Number.POSITIVE_INFINITY;
        for (const p of spawns) {
          near = Math.min(
            near,
            Math.hypot(wrapDeltaAxis(p.x, m.to.x), wrapDeltaAxis(p.z, m.to.z)),
          );
        }
        return {
          id: m.id,
          by: bombBy.get(m.id) ?? "?",
          to: m.to,
          t0: m.t0,
          surface: Math.round(s.y * 10) / 10,
          on: s.on,
          spawnM: Math.round(near),
        };
      });
      const offSurface = bombRows.filter(
        (b) =>
          b.to.y > b.surface + SURFACE_M || b.to.y < minAltitude(b.to.z) - 1,
      );
      const nearSpawn = bombRows.filter((b) => b.spawnM < SPAWN_CLEAR_M);
      const nextBy = (NEXT_CARRIER_MS + NEXT_SLACK_MS) / 1000;
      const checks = {
        wave1Cleared: {
          pass:
            wave1LiveS !== null &&
            wave1ClearS !== null &&
            wave1ClearS - wave1LiveS <= WAVE1_CLEAR_S,
          detail:
            wave1LiveS === null
              ? "wave 1 never went live"
              : wave1ClearS === null
                ? `live at ${wave1LiveS.toFixed(1)} s, never cleared`
                : `live ${wave1LiveS.toFixed(1)} s → cleared ${wave1ClearS.toFixed(1)} s (${(wave1ClearS - wave1LiveS).toFixed(1)} s ≤ ${WAVE1_CLEAR_S})`,
        },
        survivedWave1: {
          pass: wave1ClearS !== null && deathsInWave1 === 0,
          detail: `${deathsInWave1} pilot death(s) during wave 1`,
        },
        aaDownedEnemies: {
          pass: aaKills >= 1,
          detail: `${aaKills} enemy plane(s) downed by rooftop AA`,
        },
        bombsHitCityNotSpawn: {
          pass:
            bombRows.length >= 1 &&
            offSurface.length === 0 &&
            nearSpawn.length === 0,
          detail: `${bombRows.length} bomb(s): ${bombRows.filter((b) => b.on === "roof").length} roof / ${bombRows.filter((b) => b.on === "street").length} street / ${bombRows.filter((b) => b.on === "bridge").length} bridge / ${bombRows.filter((b) => b.on === "river").length} river; off the surface ${offSurface.length}; within ${SPAWN_CLEAR_M} m of a spawn point ${nearSpawn.length} (nearest ${bombRows.length ? Math.min(...bombRows.map((b) => b.spawnM)) : "—"} m over ${spawns.length} spawn point(s))`,
        },
        carrierDownAndNext: {
          pass:
            carrierDownS !== null &&
            carrierDownS <= CARRIER_DOWN_S &&
            nextRaidS !== null &&
            nextRaidS - carrierDownS <= nextBy,
          detail:
            carrierDownS === null
              ? "the carrier never went down"
              : nextRaidS === null
                ? `down at ${carrierDownS.toFixed(1)} s; no next raid`
                : `down at ${carrierDownS.toFixed(1)} s; the next raid ${(nextRaidS - carrierDownS).toFixed(1)} s later (≤ ${nextBy})`,
        },
      };
      return {
        run,
        seed,
        pass: Object.values(checks).every((c) => c.pass),
        checks,
        timeline,
        kills,
        pilot: { shots, claims, bossClaims, deaths },
        bombs: bombRows,
      };
    };

    ws.on("error", reject);
    ws.on("open", () => send({ type: "join", name: "Novice", easy: true }));
    ws.on("message", (data: Buffer) => {
      const msg = JSON.parse(data.toString()) as ServerMsg;
      switch (msg.type) {
        case "welcome": {
          selfId = msg.id;
          for (const r of msg.roster) if (r.isBot) bots.add(r.id);
          spawnAt(msg.spawn);
          send({ type: "setIntensity", level: 0 });
          note(`joined ${msg.roomId}; Easy pilot, room intensity → EASY`);
          timer = setInterval(() => {
            const now = performance.now();
            const dt = Math.min(0.1, (now - last) / 1000);
            last = now;
            tick(dt);
          }, 1000 / POSE_HZ);
          deadline = setTimeout(() => {
            note(`timeout (${TIMEOUT_S} s)`);
            finish();
          }, TIMEOUT_S * 1000);
          break;
        }
        case "intensityConfig":
          note(`intensity ${msg.level} (by ${msg.byName})`);
          break;
        case "playerJoined":
          if (msg.player.isBot) bots.add(msg.player.id);
          break;
        case "playerLeft":
          bots.delete(msg.id);
          enemies.delete(msg.id);
          break;
        case "snapshot": {
          snapTime = msg.time;
          snapAt = performance.now();
          const seen = new Set<string>();
          for (const w of msg.p) {
            const e = decodeSnapshotEntry(w);
            if (!bots.has(e.id)) continue;
            enemies.set(e.id, e.pose.pos);
            seen.add(e.id);
          }
          for (const id of enemies.keys())
            if (!seen.has(id)) enemies.delete(id);
          break;
        }
        case "waves": {
          const w = decodeWaves(msg.w);
          if (!w) break;
          const prev = waves;
          waves = w;
          if (prev?.wave !== w.wave || prev?.phase !== w.phase) {
            const ph =
              w.phase === WAVE_LIVE
                ? "LIVE"
                : w.phase === WAVE_BREATHER
                  ? "breather"
                  : "idle";
            note(
              `wave ${w.wave} ${ph} (size ${w.size}, left ${w.left}, tier ${w.tier})`,
            );
          }
          if (w.wave === 1 && w.phase === WAVE_LIVE && wave1LiveS === null) {
            wave1LiveS = sinceS();
          }
          if (
            wave1LiveS !== null &&
            wave1ClearS === null &&
            (w.wave > 1 || w.phase === WAVE_IDLE)
          ) {
            wave1ClearS = sinceS();
            note(
              `WAVE 1 CLEARED (${(wave1ClearS - wave1LiveS).toFixed(1)} s live)`,
            );
          }
          break;
        }
        case "boss": {
          const r = decodeRaid(msg.r);
          if (!r) break;
          if (firstRaidId === null) firstRaidId = r.id;
          if (raid?.id !== r.id) {
            raid = r;
            raidHp = raidMaxHp(r);
            note(
              `carrier raid ${r.id} (weak HP ${raidHp.reduce((a, b) => a + b, 0)})`,
            );
            if (
              carrierDownS !== null &&
              nextRaidS === null &&
              r.id !== carrierDownId
            ) {
              nextRaidS = sinceS();
              note("the NEXT carrier arrives");
              if (bombs.length >= MIN_BOMBS) setTimeout(finish, 1000);
            }
          }
          break;
        }
        case "bossHp":
          if (raid && msg.id === raid.id) {
            raidHp = msg.hp;
            if (sinceS() - hpLoggedAt >= 30) {
              hpLoggedAt = sinceS();
              note(
                `carrier weak HP ${raidHp.reduce((a, b) => a + Math.max(0, b), 0)} (${bossClaims} claims so far)`,
              );
            }
          }
          break;
        case "bossDown":
          if (carrierDownS === null) {
            carrierDownS = sinceS();
            carrierDownId = msg.d.id;
            note(
              `CARRIER DOWN (top ${msg.top === selfId ? "the pilot" : msg.top})`,
            );
          }
          break;
        case "missile": {
          if (msg.by === undefined) break;
          const m = decodeMissile(msg.m);
          if (m && m.kind === "bomb") {
            bombs.push(m);
            bombBy.set(m.id, msg.by);
            const on = surfaceAt(m.to.x, m.to.z).on;
            note(`enemy bomb ${bombs.length} (${msg.by}) → ${on}`);
            if (nextRaidS !== null && bombs.length >= MIN_BOMBS) {
              setTimeout(finish, 1000);
            }
          }
          break;
        }
        case "death": {
          if (msg.victimId === selfId) {
            alive = false;
            deaths.push(msg.cause);
            if (wave1LiveS !== null && wave1ClearS === null) deathsInWave1++;
            note(`pilot DOWN (${msg.cause})`);
          } else if (bots.has(msg.victimId)) {
            const by =
              msg.killerId === selfId
                ? "pilot"
                : msg.cause === "aa"
                  ? "aa"
                  : msg.cause;
            kills[by] = (kills[by] ?? 0) + 1;
            if (msg.cause === "aa") aaKills++;
            note(
              `enemy down: ${by}${msg.assist === selfId ? " (pilot assist)" : ""}`,
            );
            enemies.delete(msg.victimId);
          }
          break;
        }
        case "respawn":
          if (msg.id === selfId) {
            spawnAt(msg.spawn);
            note("pilot respawned");
          }
          break;
      }
    });
  });
}

// --- Main ---------------------------------------------------------------------------------

const reports: RunReport[] = [];
for (let run = 1; run <= RUNS; run++) {
  const seed = SEED + run - 1;
  console.log(`run ${run}/${RUNS} (seed ${seed})`);
  const { child, url } = await startServer();
  try {
    reports.push(await fly(url, run, seed));
  } finally {
    child.kill();
  }
  const r = reports.at(-1) as RunReport;
  for (const [name, c] of Object.entries(r.checks)) {
    console.log(`  ${c.pass ? "ok  " : "FAIL"} ${name}: ${c.detail}`);
  }
  console.log(
    `  kills ${JSON.stringify(r.kills)}; pilot ${JSON.stringify(r.pilot)}`,
  );
}
const passed = reports.filter((r) => r.pass).length;
console.log(
  `${passed}/${RUNS} runs passed: ${passed === RUNS ? "PASS" : "FAIL"}`,
);
if (OUT) writeFileSync(OUT, JSON.stringify(reports, null, 2));
process.exit(passed === RUNS ? 0 : 1);
