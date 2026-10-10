// D1 impact particles and blasts: the pool caps the live particle count at
// the tier's budget (Mobile lowest), and the blast ledger turns server death
// events into facade damage + burning patches exactly once each, in event
// order — a reconnect's replayed welcome changes nothing, and the burn cap
// drops the oldest by event order on every client alike.

import { generateCity } from "@angels-bandits/common/city";
import type { CityEvent } from "@angels-bandits/common/cityevents";
import { SMOKE_LIFE_MS } from "@angels-bandits/common/cityevents";
import { buildCityIndex } from "@angels-bandits/common/collision";
import { wrapCoord } from "@angels-bandits/common/world";
import { describe, expect, it } from "vitest";
import { FacadeDamage, faceSlotsFor } from "../src/render/damage-map";
import {
  BlastLedger,
  IMPACT_PARTICLES_MAX,
  ImpactPool,
  Kind,
  burnCapFor,
  particleCapFor,
} from "../src/render/impacts";
import { QUALITY_PROFILES, type QualityTier } from "../src/render/quality";

const TIERS: readonly QualityTier[] = ["high", "medium", "low", "mobile"];
const O = { x: 100, y: 50, z: 100 };

describe("ImpactPool — capped", () => {
  it("never holds more live particles than its cap", () => {
    const pool = new ImpactPool();
    pool.setCap(particleCapFor(QUALITY_PROFILES.high.impacts));
    for (let n = 0; n < 5000; n++) {
      pool.spawn(Kind.DUST, O, 0, 1, 0, 10_000, 2, 1, 1, 1, n * 0.1);
    }
    expect(pool.live(600)).toBe(IMPACT_PARTICLES_MAX);
    pool.setCap(particleCapFor(QUALITY_PROFILES.mobile.impacts));
    expect(pool.live(600)).toBeLessThanOrEqual(300);
    for (let n = 0; n < 5000; n++) {
      pool.spawn(Kind.SPARK, O, 1, 0, 0, 10_000, 1, 1, 1, 1, 600);
    }
    expect(pool.live(601)).toBe(300);
  });

  it("overwrites the oldest first, and expired particles stop counting", () => {
    const pool = new ImpactPool(4);
    for (let n = 0; n < 6; n++) {
      pool.spawn(Kind.CHIP, O, 0, 0, 0, 100, 1, 1, 1, 1, n);
    }
    // Slots hold births 4, 5, 2, 3 — the two oldest (0, 1) were replaced.
    expect([...pool.born].sort((a, b) => a - b)).toEqual([2, 3, 4, 5]);
    expect(pool.live(50)).toBe(4);
    expect(pool.live(104)).toBe(1); // only the one born at 5 is still alive
    expect(pool.live(200)).toBe(0);
  });
});

describe("D1 tier budgets", () => {
  it("is 1200 / 900 / 600 / 300 particles, 48 / 40 / 32 / 24 slots, 6 / 5 / 4 / 3 burns", () => {
    const shares = TIERS.map((t) => QUALITY_PROFILES[t].impacts);
    expect(shares.map(particleCapFor)).toEqual([1200, 900, 600, 300]);
    expect(shares.map(faceSlotsFor)).toEqual([48, 40, 32, 24]);
    expect(shares.map(burnCapFor)).toEqual([6, 5, 4, 3]);
  });

  it("Mobile is strictly the cheapest", () => {
    const m = QUALITY_PROFILES.mobile.impacts;
    const h = QUALITY_PROFILES.high.impacts;
    expect(particleCapFor(m)).toBeLessThan(particleCapFor(h));
    expect(faceSlotsFor(m)).toBeLessThan(faceSlotsFor(h));
    expect(burnCapFor(m)).toBeLessThan(burnCapFor(h));
  });
});

describe("BlastLedger — server death events", () => {
  const city = generateCity(42);
  const index = buildCityIndex(city);
  // Death events 5 m in front of real facades, one per building.
  const events: CityEvent[] = city
    .filter((b) => b.height > 40)
    .slice(0, 8)
    .map((b, i) => ({
      kind: "death",
      x: wrapCoord(b.x + b.width / 2 + 5),
      y: 25,
      z: b.z,
      t: 100_000 + i * 1000,
    }));
  const gunfire: CityEvent = {
    ...(events[0] as CityEvent),
    kind: "gunfire",
    t: 1,
  };

  it("applies each death once: the same welcome ingested twice changes nothing", () => {
    const d = new FacadeDamage();
    const ledger = new BlastLedger(d, city, index);
    const first = ledger.ingest([gunfire, ...events]);
    expect(first.length).toBe(events.length);
    const snapshot = d.data.slice();
    const burns = ledger.burns.map((b) => b.t);
    expect(ledger.ingest(events)).toEqual([]);
    expect(d.data).toEqual(snapshot);
    expect(ledger.burns.map((b) => b.t)).toEqual(burns);
  });

  it("gives every client the same damage, whatever order the events arrived in", () => {
    const a = new FacadeDamage();
    const b = new FacadeDamage();
    new BlastLedger(a, city, index).ingest(events);
    const late = new BlastLedger(b, city, index);
    for (const ev of [...events].reverse()) late.ingest([ev]);
    // Applied one at a time in reverse, each blast is still seeded from its
    // own event, so every pane the ring takes is the same pane.
    let shatteredA = 0;
    let shatteredB = 0;
    for (let i = 0; i < a.data.length; i += 2) {
      if ((a.data[i] as number) & 0x80) shatteredA++;
      if ((b.data[i] as number) & 0x80) shatteredB++;
    }
    expect(shatteredA).toBeGreaterThan(0);
    expect(shatteredB).toBe(shatteredA);
  });

  it("over the burn cap, drops the oldest by event order", () => {
    const ledger = new BlastLedger(new FacadeDamage(), city, index);
    ledger.setBurnCap(burnCapFor(QUALITY_PROFILES.high.impacts));
    ledger.ingest([...events].reverse());
    expect(ledger.burns.map((b) => b.t)).toEqual(
      events.slice(-6).map((e) => e.t),
    );
    ledger.setBurnCap(3);
    expect(ledger.burns.map((b) => b.t)).toEqual(
      events.slice(-3).map((e) => e.t),
    );
  });

  it("burns out after SMOKE_LIFE_MS of server time", () => {
    const ledger = new BlastLedger(new FacadeDamage(), city, index);
    ledger.ingest(events.slice(0, 2));
    const t0 = (events[0] as CityEvent).t;
    ledger.prune(t0 + SMOKE_LIFE_MS - 1);
    expect(ledger.burns.length).toBe(2);
    ledger.prune(t0 + SMOKE_LIFE_MS + 500);
    expect(ledger.burns.length).toBe(1);
  });

  it("forgets a death only once no welcome can replay it — the ledger stays bounded (A2)", () => {
    const d = new FacadeDamage();
    const ledger = new BlastLedger(d, city, index);
    ledger.ingest(events);
    const snapshot = d.data.slice();
    const last = (events.at(-1) as CityEvent).t;
    // Burnt out, but a resume's welcome (SMOKE_LIFE_MS of replay on the
    // server's clock, ahead of the render clock) may still carry them.
    ledger.prune(last + SMOKE_LIFE_MS + 1000);
    expect(ledger.burns.length).toBe(0);
    expect(ledger.ingest(events)).toEqual([]);
    expect(d.data).toEqual(snapshot);
    expect(ledger.remembered).toBe(events.length);
    // Long past any replay: forgotten.
    ledger.prune(last + 2 * SMOKE_LIFE_MS);
    expect(ledger.remembered).toBe(0);
  });
});
