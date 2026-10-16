// P1 penetrating impacts, server side (server/src/destruction.ts): a crash
// with a velocity sweeps a tunnel instead of one radial blast; each chunk of
// it breaks at its own entry time (not before), credited to the killer; the
// impact record goes out once, exactly as swept; DESTROY_CAP and the C2
// hold still rule every chunk it lands; a rebuild stops a tunnel still
// being driven into it; and D5's collapse debris sweeps too.

import {
  type Building,
  chunkBuilding,
  generateCity,
} from "@angels-bandits/common/city";
import {
  IMPACT_DEBRIS,
  IMPACT_PLANE,
  SWEEP_MODEL_VERSION,
  decodeImpact,
  encodeImpact,
  sweepRecord,
} from "@angels-bandits/common/city/penetrate";
import { CITY_SEED } from "@angels-bandits/common/constants";
import { describe, expect, it } from "vitest";
import {
  type RoomCity,
  applyDeathBlast,
  createRoomCity,
  rebuildBuilding,
  takeSweeps,
  tickDestruction,
} from "../src/destruction";

const seedCity = generateCity(CITY_SEED);
const towerIndex = seedCity.findIndex(
  (b) => !b.holes && b.height > 140 && b.height < 300 && b.width > 40,
);
const tower = seedCity[towerIndex] as Building;
/** 3 m off the tower's −x facade, flying in level at 85 m/s. */
const crashPos = { x: tower.x - tower.width / 2 - 3, y: 60, z: tower.z };
const crashVel = { x: 85, y: -4, z: 0 };
const NOW = 50_000;

/** A crash into the tower; returns the swept record and its sweep. */
function crash(rc: RoomCity) {
  const before = rc.damage.destroyedCount;
  expect(applyDeathBlast(rc, crashPos, "killer", crashVel, NOW)).toEqual([]);
  // Nothing breaks at the instant of the crash: the tunnel lands as the
  // plane ploughs on.
  expect(rc.damage.destroyedCount).toBe(before);
  const recs = takeSweeps(rc);
  expect(recs).toHaveLength(1);
  const rec = recs[0] as NonNullable<(typeof recs)[number]>;
  return { rec, res: sweepRecord(rec, rc.buildings) };
}

describe("P1 sweepBlast", () => {
  it("drives a crash through the tower chunk by chunk, each at its entry time", () => {
    const rc = createRoomCity(seedCity);
    const { rec, res } = crash(rc);
    expect(rec.kind).toBe(IMPACT_PLANE);
    expect(res.chunks.length).toBeGreaterThanOrEqual(2);
    // Each tick lands exactly the chunks whose entry time has come.
    let landed = 0;
    for (let t = NOW; t <= NOW + 4000; t += 50) {
      tickDestruction(rc, t);
      const due = res.times.filter((s) => rec.t + s * 1000 <= t).length;
      const gone = res.chunks.filter((id) => rc.damage.isGone(id)).length;
      expect(gone).toBe(due);
      landed = gone;
    }
    expect(landed).toBe(res.chunks.length);
    // Credited to the killer, and the record goes out once.
    expect(rc.breakers.get(chunkBuilding(res.chunks[0] as number))).toBe(
      "killer",
    );
    expect(takeSweeps(rc)).toEqual([]);
  });

  it("puts the record on the wire exactly as it swept it", () => {
    const rc = createRoomCity(seedCity);
    const { rec, res } = crash(rc);
    const wire = JSON.parse(
      JSON.stringify({ v: SWEEP_MODEL_VERSION, i: [encodeImpact(rec)] }),
    );
    expect(wire.v).toBe(SWEEP_MODEL_VERSION);
    const back = decodeImpact(wire.i[0]);
    expect(back).toEqual(rec);
    // A client's city (the seed, nothing broken yet) replays the same tunnel.
    const client = createRoomCity(seedCity);
    expect(sweepRecord(back as typeof rec, client.buildings)).toEqual(res);
  });

  it("keeps DESTROY_CAP and the C2 hold", () => {
    const capped = createRoomCity(seedCity);
    capped.damage.setCap(0);
    crash(capped);
    tickDestruction(capped, NOW + 5000);
    expect(capped.damage.destroyedCount).toBe(0);

    const held = createRoomCity(seedCity);
    held.damage.hold = true;
    crash(held);
    tickDestruction(held, NOW + 5000);
    expect(held.damage.destroyedCount).toBe(0);
  });

  it("stops at a rebuild: the rebuilt walls are not broken by an old tunnel", () => {
    const rc = createRoomCity(seedCity);
    const { res } = crash(rc);
    rebuildBuilding(rc, towerIndex);
    tickDestruction(rc, NOW + 5000);
    for (const id of res.chunks) {
      if (chunkBuilding(id) === towerIndex) {
        expect(rc.damage.isGone(id)).toBe(false);
      }
    }
  });

  it("without a velocity, a death still bursts in place (a shot-down plane over the wreck cap)", () => {
    const rc = createRoomCity(seedCity);
    const at = { x: tower.x - tower.width / 2 + 1, y: 60, z: tower.z };
    expect(applyDeathBlast(rc, at, null).length).toBeGreaterThan(0);
    expect(takeSweeps(rc)).toEqual([]);
  });

  it("sweeps D5 collapse debris on into the building it strikes", () => {
    const rc = createRoomCity(seedCity);
    rc.impacts.push({
      t: NOW,
      building: towerIndex,
      x: crashPos.x + 2,
      y: 40,
      z: crashPos.z,
      e: 1,
      vx: 20,
      vy: -25,
      vz: 0,
      vol: 2400,
      source: 1,
      depth: 0,
      by: "culprit",
    });
    tickDestruction(rc, NOW);
    const recs = takeSweeps(rc);
    expect(recs).toHaveLength(1);
    expect(recs[0]?.kind).toBe(IMPACT_DEBRIS);
    tickDestruction(rc, NOW + 5000);
    expect(rc.damage.destroyedCount).toBeGreaterThan(0);
    expect(rc.breakers.get(towerIndex)).toBe("culprit");
  });
});
