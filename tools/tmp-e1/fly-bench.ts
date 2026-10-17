import { generateCity, mulberry32 } from "@angels-bandits/common/city";
import { generateMovers } from "@angels-bandits/common/city/movers";
import { natureFor } from "@angels-bandits/common/city/nature";
import { buildNatureIndex } from "@angels-bandits/common/collision";
import { CITY_SEED } from "@angels-bandits/common/constants";
import { FLEET_TUNING } from "@angels-bandits/common/boss";
import { FleetDirector } from "../../server/src/boss";
import { RoomBots, humanContacts as _h } from "../../server/src/bots";
import { Combat } from "../../server/src/combat";
import { createRoomCity } from "../../server/src/destruction";
import { RoomWaves, humanContacts } from "../../server/src/waves";
const CITY = generateCity(CITY_SEED);
const rc = createRoomCity(CITY);
const boss = new FleetDirector(mulberry32(5), { ...FLEET_TUNING });
const movers = { ...generateMovers(CITY_SEED, CITY), collapses: rc.collapses, boss: boss.slot };
const bots = new RoomBots("room-1", 5, rc.buildings, movers, true, buildNatureIndex(natureFor(CITY_SEED, CITY)));
const combat = new Combat();
const T0 = 1_790_000_000_000;
const humans = [0, 1, 2, 3, 4, 5].map((i) => ({ id: `h${i}`, pos: { x: 200 + (i % 4) * 400, y: 240, z: 600 + Math.floor(i / 4) * 800 }, vel: { x: 0, y: 0, z: -60 }, prot: false, hp: 100 }));
for (const h of humans) combat.addPlayer(h.id, T0);
const waves = new RoomWaves(5, bots, boss, combat, { addEnemy: () => {}, removeEnemy: () => {}, send: () => {}, death: () => {} });
waves.staged = Number(process.argv[2] ?? 500);
let now = T0;
const promAt = new Map<string, number>();
let crashes = 0; let aceTicks = 0;
const times: number[] = []; const btimes: number[] = [];
for (let t = 0; t < 1600; t++) {
  now += 50;
  for (const h of humans) { h.pos.z = (h.pos.z - 3 + 2000) % 2000; }
  boss.tick(now, true, humans, { buildings: rc.buildings, index: rc.index });
  waves.tick(now, true, humans);
  for (const id of combat.tick(now).respawnsDue) waves.release(id, now);
  const a = performance.now();
  waves.flyForce(now, 0.05, humans);
  const b = performance.now();
  const r = bots.tick(now, humanContacts(humans));
  for (const id of waves.squadrons.aces()) if (!promAt.has(id)) promAt.set(id, now);
  for (const id of r.crashes) { crashes++; console.log('crash', id, 'after', now - (promAt.get(id) ?? now), 'ms', JSON.stringify(bots.flightOf(id)?.pos), bots.stateOf(id)); const d = combat.crash(id, now); if (d) waves.downed(d, now); }
  aceTicks += waves.squadrons.aces().length;
  const c = performance.now();
  if (t > 400) { times.push(b - a); btimes.push(c - b); }
}
const q = (arr: number[], p: number) => [...arr].sort((x, y) => x - y)[Math.floor(arr.length * p)]!.toFixed(3);
console.log("staged", waves.staged, "force", waves.state().force, "aces", waves.squadrons.aces().length, "flyForce p50", q(times, 0.5), "p99", q(times, 0.99), "| bots.tick p50", q(btimes, 0.5), "p99", q(btimes, 0.99), waves.squadrons.stats);
const ids = waves.squadrons.aces();
console.log("aces alive", ids.length, "isSquad false", ids.filter((i) => !bots.isSquad(i)).length, "contact", ids.filter((i) => bots.contactOf(i)).length);
console.log("crashes", crashes, "ace-minutes", (aceTicks / 20 / 60).toFixed(1), "per ace-min", (crashes / (aceTicks / 1200)).toFixed(3));
