// W1 Carrier War, the pure half (common/src/waves.ts): wave sizes start at
// three and grow by one or two up to a cap inside the perf budget, the
// first waves are the softest, the carrier's tiers climb, enemies spread
// over the humans they hunt, and the HUD's state survives the wire.

import { mulberry32 } from "@angels-bandits/common/city";
import {
  ENEMY_CAP,
  INTENSITY_DEFAULT,
  type Intensity,
  NEXT_CARRIER_MS,
  QUARRY_SPREAD_M,
  WAVE_BREATHER_MS,
  WAVE_LEVELS,
  WAVE_LIVE,
  WAVE_RAMP,
  asIntensity,
  assignQuarries,
  carrierFlakScale,
  carrierHpScale,
  decodeWaves,
  encodeWaves,
  nextWaveSize,
  waveGrade,
} from "@angels-bandits/common/waves";
import { describe, expect, it } from "vitest";

const LEVELS: Intensity[] = [0, 1, 2, 3];

/** The first `n` wave sizes at `level` from one seeded stream. */
function sizes(level: Intensity, n: number, seed = 1): number[] {
  const rand = mulberry32(seed);
  const out: number[] = [];
  let prev: number | null = null;
  for (let i = 0; i < n; i++) {
    prev = nextWaveSize(prev, level, rand);
    out.push(prev);
  }
  return out;
}

describe("wave cadence and caps", () => {
  it("wave 1 is 3 planes on NORMAL, then +1 to +2 a wave up to its cap", () => {
    expect(INTENSITY_DEFAULT).toBe(1);
    for (let seed = 1; seed <= 40; seed++) {
      const s = sizes(1, 12, seed);
      expect(s[0]).toBe(3);
      for (let i = 1; i < s.length; i++) {
        const grow = (s[i] as number) - (s[i - 1] as number);
        const capped = s[i] === WAVE_LEVELS[1]?.cap;
        expect(capped || (grow >= 1 && grow <= 2)).toBe(true);
        expect(grow).toBeGreaterThanOrEqual(0);
      }
      expect(s[s.length - 1]).toBe(WAVE_LEVELS[1]?.cap);
    }
  });

  it("every level stays inside the perf budget (≤ 12 alive) and grows harder with intensity", () => {
    expect(ENEMY_CAP).toBeLessThanOrEqual(12);
    let prevCap = 0;
    let prevFirst = 0;
    for (const level of LEVELS) {
      const l = WAVE_LEVELS[level];
      if (!l) throw new Error("no level");
      expect(l.cap).toBeLessThanOrEqual(ENEMY_CAP);
      expect(l.cap).toBeGreaterThan(prevCap);
      expect(l.first).toBeGreaterThanOrEqual(prevFirst);
      prevCap = l.cap;
      prevFirst = l.first;
      for (const s of sizes(level, 30)) {
        expect(s).toBeGreaterThanOrEqual(1);
        expect(s).toBeLessThanOrEqual(l.cap);
      }
    }
  });

  it("is deterministic: one draw per wave from the stream, the same sizes for the same seed", () => {
    expect(sizes(2, 20, 7)).toEqual(sizes(2, 20, 7));
    const rand = mulberry32(3);
    nextWaveSize(null, 1, rand);
    nextWaveSize(4, 1, rand);
    const twin = mulberry32(3);
    twin();
    twin();
    expect(rand()).toBe(twin());
  });

  it("breathes ~8 s between waves; the next carrier comes 20 s after the last", () => {
    expect(WAVE_BREATHER_MS).toBeGreaterThanOrEqual(6000);
    expect(WAVE_BREATHER_MS).toBeLessThanOrEqual(10_000);
    expect(NEXT_CARRIER_MS).toBe(20_000);
  });

  it("takes a client's intensity only as a whole level, clamped to EASY–INSANE", () => {
    expect(asIntensity(2)).toBe(2);
    expect(asIntensity(9)).toBe(3);
    expect(asIntensity(-1)).toBe(0);
    expect(asIntensity(1.5)).toBeNull();
    expect(asIntensity("2")).toBeNull();
  });
});

describe("difficulty ramps gently", () => {
  it("the first waves are the softest: aim jitter and reaction ease, fire discipline loosens, then hold", () => {
    for (const level of LEVELS) {
      let prev = waveGrade(1, level);
      for (let w = 2; w <= WAVE_RAMP + 4; w++) {
        const g = waveGrade(w, level);
        expect(g.jitter).toBeLessThanOrEqual(prev.jitter + 1e-12);
        expect(g.reaction).toBeLessThanOrEqual(prev.reaction + 1e-12);
        expect(g.fire).toBeGreaterThanOrEqual(prev.fire - 1e-12);
        expect(g.fire).toBeLessThanOrEqual(1);
        prev = g;
      }
      expect(waveGrade(WAVE_RAMP + 1, level)).toEqual(waveGrade(50, level));
    }
    // A new player's first wave on the default level: sloppier aim, slower
    // to shoot, and lets about half its shots go.
    const first = waveGrade(1, INTENSITY_DEFAULT);
    expect(first.jitter).toBeGreaterThan(1.5);
    expect(first.reaction).toBeGreaterThan(1.2);
    expect(first.fire).toBeLessThanOrEqual(0.5);
  });

  it("each carrier is tougher and hits harder than the last, to a ceiling", () => {
    for (let t = 2; t <= 12; t++) {
      expect(carrierHpScale(t)).toBeGreaterThanOrEqual(carrierHpScale(t - 1));
      expect(carrierFlakScale(t)).toBeGreaterThanOrEqual(
        carrierFlakScale(t - 1),
      );
    }
    expect(carrierHpScale(2)).toBeGreaterThan(carrierHpScale(1));
    expect(carrierHpScale(50)).toBeLessThanOrEqual(1.5);
    expect(carrierFlakScale(1)).toBeLessThan(1);
    expect(carrierFlakScale(50)).toBe(1);
  });
});

describe("who hunts whom", () => {
  const at = (x: number, z: number) => ({ x, y: 100, z });

  it("every enemy hunts the nearest human when there is one", () => {
    const q = assignQuarries(
      [
        { id: "e1", pos: at(100, 100) },
        { id: "e2", pos: at(1900, 100) }, // 200 m from h through the seam
      ],
      [{ id: "h", pos: at(100, 100) }],
    );
    expect([...q]).toEqual([
      ["e1", "h"],
      ["e2", "h"],
    ]);
  });

  it("spreads a wave across several humans instead of piling onto the nearest", () => {
    const enemies = Array.from({ length: 6 }, (_, k) => ({
      id: `e${k}`,
      pos: at(1000 + k, 1000),
    }));
    // h1 is nearer to all of them, but only by 100 m.
    const humans = [
      { id: "h1", pos: at(1000, 1150) },
      { id: "h2", pos: at(1000, 1250) },
    ];
    expect(100).toBeLessThan(QUARRY_SPREAD_M);
    const q = assignQuarries(enemies, humans);
    const on = (h: string) => [...q.values()].filter((v) => v === h).length;
    expect(on("h1")).toBe(3);
    expect(on("h2")).toBe(3);
    // Pure: the same answer every time.
    expect(assignQuarries(enemies, humans)).toEqual(q);
  });

  it("assigns nobody when there are no humans", () => {
    expect(assignQuarries([{ id: "e", pos: at(0, 0) }], []).size).toBe(0);
  });
});

describe("the waves state on the wire", () => {
  it("survives the wire bit for bit and refuses junk", () => {
    const s = {
      wave: 4,
      phase: WAVE_LIVE,
      at: 1_790_000_000_123,
      left: 5,
      size: 6,
      tier: 2,
    } as const;
    expect(decodeWaves(encodeWaves(s))).toEqual(s);
    expect(decodeWaves([1, 9, 0, 0, 0, 0])).toBeNull();
    expect(decodeWaves([1, 1, 0, 0, 0])).toBeNull();
    expect(decodeWaves([1, 1, 0.5, 0, 0, 0])).toBeNull();
    expect(decodeWaves("waves")).toBeNull();
  });
});
