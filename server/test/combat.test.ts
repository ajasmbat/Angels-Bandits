// Combat engine seam: the server's authority over guns, damage, death,
// respawn timing, and scores. Expected values are worked examples from the
// spec constants (constants.ts / PLAN.md), never recomputed the code's way.
//
// Heat worked example (HEAT_PER_SHOT 0.055, HEAT_COOL_RATE 0.3/s, server
// lock at OVERHEAT_AT + HEAT_VALIDATION_SLACK = 1.1):
//   firing at exact FIRE_INTERVAL_MS (100 ms) cadence, each interval nets
//   0.055 − 0.03 = 0.025 heat, so heat after shot k is 0.055 + 0.025k.
//   Shot 42 reaches 1.105 ≥ 1.1 → guns lock; shot 43 is the first reject.
//   Unlock below HEAT_LOCK_BELOW (0.35): (1.105 − 0.35) / 0.3 ≈ 2.52 s
//   after the locking shot at t = 4200 → still locked at 6600, free at 6800.

import { describe, expect, it } from "vitest";
import { Combat } from "../src/combat";

/** Engine with `n` players "p0".."pn-1" added at t=0. */
const arena = (n: number): Combat => {
  const combat = new Combat();
  for (let i = 0; i < n; i++) combat.addPlayer(`p${i}`, 0);
  return combat;
};

describe("fire validation (cadence + heat)", () => {
  it("accepts steady max-cadence fire until the heat model locks, then rejects with overheat", () => {
    const combat = arena(1);
    let firstReject = -1;
    for (let k = 0; k <= 43; k++) {
      const res = combat.fire("p0", k, k * 100);
      if (!res.ok) {
        firstReject = k;
        expect(res.reason).toBe("overheat");
        break;
      }
    }
    expect(firstReject).toBe(43);
  });

  it("keeps guns locked until heat cools below HEAT_LOCK_BELOW, then accepts again", () => {
    const combat = arena(1);
    for (let k = 0; k <= 42; k++) combat.fire("p0", k, k * 100);
    expect(combat.fire("p0", 90, 6600).ok).toBe(false);
    expect(combat.fire("p0", 91, 6800).ok).toBe(true);
  });

  it("allows a small burst (network batching) but rejects sustained faster-than-cadence fire", () => {
    const combat = arena(1);
    // FIRE_BURST_SLACK = 5 shots may land in the same instant…
    for (let k = 0; k < 5; k++) {
      expect(combat.fire("p0", k, 1000).ok).toBe(true);
    }
    // …but the 6th same-instant shot exceeds any legal cadence.
    const sixth = combat.fire("p0", 5, 1000);
    expect(sixth.ok).toBe(false);
    expect(sixth.reason).toBe("cadence");
  });

  it("firing cancels spawn protection the instant it happens", () => {
    const combat = arena(1);
    // Added at t=0 → protected until 4000 (SPAWN_PROTECTION_MS).
    expect(combat.isProtected("p0", 1000)).toBe(true);
    const res = combat.fire("p0", 0, 1000);
    expect(res.ok && res.protectionCanceled).toBe(true);
    expect(combat.isProtected("p0", 1001)).toBe(false);
  });

  it("rejects fire from a dead player", () => {
    const combat = arena(2);
    // p1 shoots p0 dead: 15 hits × 7 = 105 ≥ 100 HP.
    const t = 10_000; // everyone's spawn protection (4 s) long expired
    const at = { x: 100, y: 300, z: 100 };
    for (let i = 0; i < 15; i++) {
      combat.fire("p1", i, t + i * 100);
      combat.hit("p1", "p0", i, at, at, at, t + i * 100);
    }
    expect(combat.isAlive("p0")).toBe(false);
    const res = combat.fire("p0", 0, t + 2000);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("dead");
  });
});

const T = 10_000; // past everyone's initial spawn protection
const P = { x: 100, y: 300, z: 100 };

/** Fire seq then claim the hit in one worked step. */
const shoot = (
  combat: Combat,
  shooter: string,
  target: string,
  seq: number,
  now: number,
  shooterPos = P,
  targetPos = P,
) => {
  combat.fire(shooter, seq, now);
  return combat.hit(shooter, target, seq, shooterPos, shooterPos, targetPos, now);
};

describe("hit claim validation", () => {
  it("accepts a claim at range-plus-slack and rejects one beyond it (torus-aware)", () => {
    // BULLET_RANGE 350 + HIT_RANGE_SLACK 200 = 550 m budget. Across the seam:
    // shooter x=1900, target x=449 → shortest distance 100 + 449 = 549. A
    // target at x=452 is 552 away — over budget even though the raw
    // difference (1448) is meaningless on the torus.
    const combat = arena(2);
    const shooterPos = { x: 1900, y: 300, z: 100 };
    const okRes = shoot(combat, "p0", "p1", 0, T, shooterPos, {
      x: 449,
      y: 300,
      z: 100,
    });
    expect(okRes.ok).toBe(true);

    const farRes = shoot(combat, "p0", "p1", 1, T + 200, shooterPos, {
      x: 452,
      y: 300,
      z: 100,
    });
    expect(farRes.ok).toBe(false);
    expect(!farRes.ok && farRes.reason).toBe("range");
  });

  it("rejects a claim whose bullet was never fired, and a second claim on the same bullet", () => {
    const combat = arena(2);
    const phantom = combat.hit("p0", "p1", 77, P, P, P, T);
    expect(!phantom.ok && phantom.reason).toBe("bullet");

    combat.fire("p0", 0, T);
    expect(combat.hit("p0", "p1", 0, P, P, P, T).ok).toBe(true);
    const double = combat.hit("p0", "p1", 0, P, P, P, T + 50);
    expect(!double.ok && double.reason).toBe("bullet");
  });

  it("rejects a claim whose bulletOrigin is far from the shooter's on-record pose", () => {
    const combat = arena(2);
    combat.fire("p0", 0, T);
    // HIT_ORIGIN_SLACK is 50 m; an origin 60 m out is not this plane's gun.
    const res = combat.hit(
      "p0",
      "p1",
      0,
      { x: 160, y: 300, z: 100 },
      P,
      P,
      T,
    );
    expect(!res.ok && res.reason).toBe("origin");
  });

  it("rejects hits on a spawn-protected target until protection expires", () => {
    const combat = arena(2);
    // p1 added at t=0 → protected until 4000.
    combat.fire("p0", 0, 3000);
    const early = combat.hit("p0", "p1", 0, P, P, P, 3000);
    expect(!early.ok && early.reason).toBe("protected");

    combat.fire("p0", 1, 4200);
    expect(combat.hit("p0", "p1", 1, P, P, P, 4200).ok).toBe(true);
  });
});

describe("damage, death, and kill credit", () => {
  it("applies BULLET_DAMAGE per hit and reports server-owned hp (100 − 7 = 93)", () => {
    const combat = arena(2);
    const res = shoot(combat, "p0", "p1", 0, T);
    expect(res.ok && res.hp).toBe(93);
    expect(combat.hpOf("p1")).toBe(93);
  });

  it("kills on the 15th hit (15 × 7 = 105 ≥ 100), crediting the shooter", () => {
    const combat = arena(2);
    let death = null;
    for (let i = 0; i < 15; i++) {
      const res = shoot(combat, "p0", "p1", i, T + i * 100);
      if (res.ok) death = res.death;
      expect(res.ok).toBe(true);
    }
    expect(death).toEqual({ victimId: "p1", killerId: "p0", cause: "shot" });
    expect(combat.isAlive("p1")).toBe(false);
    expect(combat.scoreOf("p0")).toEqual({ id: "p0", kills: 1, deaths: 0 });
    expect(combat.scoreOf("p1")).toEqual({ id: "p1", kills: 0, deaths: 1 });
  });

  it("crash while recently damaged credits the damager; crash while clean credits nobody", () => {
    const combat = arena(3);
    // p0 wings p1, who crashes 7.9 s later — inside DAMAGE_MEMORY_MS (8 s).
    shoot(combat, "p0", "p1", 0, T);
    expect(combat.crash("p1", T + 7900)).toEqual({
      victimId: "p1",
      killerId: "p0",
      cause: "crash",
    });
    // p2 crashes untouched: a death, but no kill for anyone.
    expect(combat.crash("p2", T)).toEqual({
      victimId: "p2",
      killerId: null,
      cause: "crash",
    });
    expect(combat.scoreOf("p0").kills).toBe(1);
  });

  it("a crash outside the 8 s damage memory credits nobody", () => {
    const combat = arena(2);
    shoot(combat, "p0", "p1", 0, T);
    const death = combat.crash("p1", T + 8100);
    expect(death?.killerId).toBeNull();
  });
});

describe("regen, respawn scheduling, and score persistence", () => {
  it("regens +10 HP/s starting 8 s after the last damage, capped at MAX_HP", () => {
    const combat = arena(2);
    // Two hits: 100 − 14 = 86 HP, last damage at T+100.
    shoot(combat, "p0", "p1", 0, T);
    shoot(combat, "p0", "p1", 1, T + 100);
    combat.tick(T + 5000);
    expect(combat.hpOf("p1")).toBe(86); // still inside the 8 s delay

    // Regen window opens at T+8100; one second of it → 86 + 10 = 96.
    combat.tick(T + 9100);
    expect(combat.hpOf("p1")).toBe(96);
    // Two more seconds would be 116 — capped at 100.
    combat.tick(T + 11_100);
    expect(combat.hpOf("p1")).toBe(100);
  });

  it("schedules the respawn KILL_CAM_MS (2.5 s) after death, and respawned() restores a protected, full-HP player", () => {
    const combat = arena(2);
    for (let i = 0; i < 15; i++) shoot(combat, "p0", "p1", i, T + i * 100);
    const deathAt = T + 1400;
    expect(combat.isAlive("p1")).toBe(false);
    expect(combat.tick(deathAt + 2400).respawnsDue).toEqual([]);
    expect(combat.tick(deathAt + 2500).respawnsDue).toEqual(["p1"]);

    combat.respawned("p1", deathAt + 2500);
    expect(combat.isAlive("p1")).toBe(true);
    expect(combat.hpOf("p1")).toBe(100);
    expect(combat.isProtected("p1", deathAt + 2500 + 3999)).toBe(true);
    expect(combat.tick(deathAt + 6000).respawnsDue).toEqual([]);
  });

  it("scores persist across a respawn but reset when the player re-registers (rejoin)", () => {
    const combat = arena(2);
    for (let i = 0; i < 15; i++) shoot(combat, "p0", "p1", i, T + i * 100);
    combat.respawned("p1", T + 4000);
    expect(combat.scoreOf("p1")).toEqual({ id: "p1", kills: 0, deaths: 1 });
    expect(combat.scoreOf("p0").kills).toBe(1);

    combat.removePlayer("p1");
    combat.addPlayer("p1", T + 10_000);
    expect(combat.scoreOf("p1")).toEqual({ id: "p1", kills: 0, deaths: 0 });
  });

  it("a fresh respawn takes no residual damage memory into a crash", () => {
    const combat = arena(2);
    for (let i = 0; i < 15; i++) shoot(combat, "p0", "p1", i, T + i * 100);
    combat.respawned("p1", T + 4000);
    // Crash right after respawning (protection does not shield crashes).
    const death = combat.crash("p1", T + 4500);
    expect(death?.killerId).toBeNull();
    expect(combat.scoreOf("p0").kills).toBe(1); // unchanged
  });
});
