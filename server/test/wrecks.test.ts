// D4 server wrecks: a wreck's impact is settled — and its D2 blast applied —
// exactly once, and a plane that flies into a wreck credits the wreck's
// shooter (never itself, never the wreck's own victim, never a near miss
// the crash report does not name).

import { type Building, generateCity } from "@angels-bandits/common/city";
import {
  CITY_SEED,
  DAMAGE_MEMORY_MS,
  WRECKS_MAX,
} from "@angels-bandits/common/constants";
import type { Vec3 } from "@angels-bandits/common/world";
import { wreckPosAt } from "@angels-bandits/common/wreck";
import { describe, expect, it } from "vitest";
import { Combat } from "../src/combat";
import { createRoomCity } from "../src/destruction";
import { RoomWrecks, applyWreckImpact, impactPos } from "../src/wrecks";

const seedCity = generateCity(CITY_SEED);
const towerIndex = seedCity.findIndex(
  (b) => !b.holes && !b.roof && b.height >= 60 && b.tiers.length === 1,
);
const tower = seedCity[towerIndex] as Building;
const still: Vec3 = { x: 0, y: 0, z: 0 };

describe("wreck impact", () => {
  it("lands once: settle returns it once and the blast breaks the roof once", () => {
    const rc = createRoomCity(seedCity);
    const wrecks = new RoomWrecks();
    const t = 10_000;
    const w = wrecks.spawn(
      "victim",
      "shooter",
      { x: tower.x, y: tower.height + 40, z: tower.z },
      still,
      t,
      { buildings: rc.buildings, index: rc.index },
    );
    if (!w) throw new Error("no wreck");
    expect(w.hit).toBe("city");
    expect(wrecks.settle(t + w.end - 1)).toEqual([]);
    expect(wrecks.active()).toEqual([w]);

    let applied = 0;
    const landAll = (now: number) => {
      for (const { params } of wrecks.settle(now)) {
        applied++;
        applyWreckImpact(rc, impactPos(params));
      }
    };
    landAll(t + w.end);
    const broken = rc.damage.destroyedIds();
    expect(applied).toBe(1);
    expect(broken.length).toBeGreaterThan(0);
    // Every tick after: nothing more lands, nothing more breaks.
    for (let k = 1; k <= 40; k++) landAll(t + w.end + k * 50);
    expect(applied).toBe(1);
    expect(rc.damage.destroyedIds()).toEqual(broken);
    expect(wrecks.active()).toEqual([]);
  });

  it("caps a room at WRECKS_MAX falling wrecks", () => {
    const wrecks = new RoomWrecks();
    const p = { x: 300, y: 700, z: 300 };
    for (let i = 0; i < WRECKS_MAX; i++) {
      expect(
        wrecks.spawn(`v${i}`, null, p, still, 0, { buildings: [] }),
      ).not.toBeNull();
    }
    expect(
      wrecks.spawn("over", null, p, still, 0, { buildings: [] }),
    ).toBeNull();
    const ids = wrecks.active().map((w) => w.id);
    expect(new Set(ids).size).toBe(WRECKS_MAX);
  });
});

describe("wreck kill credit", () => {
  const setup = () => {
    const combat = new Combat();
    for (const id of ["shooter", "victim", "flyer", "other"]) {
      combat.addPlayer(id, 0);
    }
    const wrecks = new RoomWrecks();
    const t = 20_000;
    const w = wrecks.spawn(
      "victim",
      "shooter",
      { x: 900, y: 500, z: 900 },
      { x: 50, y: 0, z: 0 },
      t,
      { buildings: [] },
    );
    if (!w) throw new Error("no wreck");
    const at = (ms: number) => wreckPosAt(w, ms, { x: 0, y: 0, z: 0 });
    return { combat, wrecks, w, t, at };
  };

  it("credits the shooter when a plane flies into the wreck", () => {
    const { combat, wrecks, w, t, at } = setup();
    const now = t + 3000;
    const r = wrecks.creditFor("flyer", w.id, at(now - 300), now);
    expect(r?.shooterId).toBe("shooter");
    const death = combat.wreckKill("flyer", r?.shooterId ?? null, now);
    expect(death).toEqual({
      victimId: "flyer",
      killerId: "shooter",
      cause: "wreck",
    });
    expect(combat.scoreOf("shooter").kills).toBe(1);
    expect(combat.scoreOf("flyer").deaths).toBe(1);
  });

  it("the wreck's shooter wins over the flyer's last damager", () => {
    const { combat, t } = setup();
    const now = t + 1000;
    combat.fire("other", 1, now - 500);
    expect(
      combat.hit(
        "other",
        "flyer",
        1,
        { x: 0, y: 0, z: 0 },
        { x: 0, y: 0, z: 0 },
        { x: 10, y: 0, z: 0 },
        now - 400,
      ).ok,
    ).toBe(true);
    expect(combat.wreckKill("flyer", "shooter", now)?.killerId).toBe("shooter");
  });

  it("no kill for your own death: the shooter into its own kill's wreck is a crash", () => {
    const { combat, t } = setup();
    const death = combat.wreckKill("shooter", "shooter", t + 1000);
    expect(death?.cause).toBe("crash");
    expect(death?.killerId).toBeNull();
    expect(combat.scoreOf("shooter").kills).toBe(0);
  });

  it("a shooter who left falls back to the environment rule", () => {
    const { combat, t } = setup();
    combat.removePlayer("shooter");
    const death = combat.wreckKill("flyer", "shooter", t + 1000);
    expect(death).toMatchObject({ killerId: null, cause: "crash" });
    // ...which still pays a recent damager.
    combat.fire("other", 1, t);
    combat.hit(
      "other",
      "victim",
      1,
      still,
      still,
      { x: 5, y: 0, z: 0 },
      t + 50,
    );
    const credited = combat.wreckKill(
      "victim",
      "gone",
      t + DAMAGE_MEMORY_MS / 2,
    );
    expect(credited).toMatchObject({ killerId: "other", cause: "crash" });
  });

  it("the server checks the claim: a far crash, a stale one, a wrong id or the victim's own wreck earn nothing", () => {
    const { wrecks, w, t, at } = setup();
    const now = t + 3000;
    const far = { ...at(now), y: at(now).y + 200 };
    expect(wrecks.creditFor("flyer", w.id, far, now)).toBeNull();
    // Where the wreck was 2 s ago: outside the 1.2 s lookback.
    expect(wrecks.creditFor("flyer", w.id, at(now - 2000), now)).toBeNull();
    expect(wrecks.creditFor("flyer", w.id + 1, at(now), now)).toBeNull();
    expect(wrecks.creditFor("flyer", undefined, at(now), now)).toBeNull();
    expect(wrecks.creditFor("flyer", "1", at(now), now)).toBeNull();
    expect(wrecks.creditFor("victim", w.id, at(now), now)).toBeNull();
  });

  it("a crash reported just after the wreck landed still counts", () => {
    const { wrecks, w, t, at } = setup();
    const end = t + w.end;
    wrecks.settle(end);
    expect(
      wrecks.creditFor("flyer", w.id, at(end - 200), end + 300)?.shooterId,
    ).toBe("shooter");
    wrecks.settle(end + 5000);
    expect(
      wrecks.creditFor("flyer", w.id, at(end - 200), end + 5000),
    ).toBeNull();
  });

  it("bots touch a falling wreck — never their own", () => {
    const { wrecks, t, at } = setup();
    const now = t + 2500;
    expect(wrecks.touching("flyer", at(now), 2, now)?.shooterId).toBe(
      "shooter",
    );
    expect(wrecks.touching("victim", at(now), 2, now)).toBeNull();
    expect(
      wrecks.touching("flyer", { ...at(now), y: at(now).y + 50 }, 2, now),
    ).toBeNull();
  });
});
