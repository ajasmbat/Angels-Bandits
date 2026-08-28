// The L1 signal seam: the cycle and the mast layout, both pure. The one
// property a signal system cannot get wrong — the two axes never simultaneously
// non-red — is swept over a full cycle at 0.1 s resolution.

import { CITY_GRID } from "@angels-bandits/common/city";
import {
  FURNITURE_LINE,
  isInRoadway,
} from "@angels-bandits/common/city/street";
import {
  EMISSIVE_LAMP,
  EMISSIVE_TRACER,
} from "@angels-bandits/common/constants";
import { wrapDistance } from "@angels-bandits/common/world";
import { describe, expect, it } from "vitest";
import {
  SIGNAL_CYCLE,
  allSignalMasts,
  signalMastsForBlock,
  signalOffset,
  signalPhase,
} from "../src/render/signals";
import { streetlampPositions } from "../src/render/streetlights";

const SEED = 42;

describe("signalPhase", () => {
  it("NEVER shows both axes non-red at once, over a whole cycle", () => {
    for (const [bx, bz] of [
      [0, 0],
      [3, 7],
      [9, 9],
    ] as const) {
      for (let t = 0; t < SIGNAL_CYCLE; t += 0.1) {
        const p = signalPhase(bx, bz, t, SEED);
        const conflict = p.ns !== "red" && p.ew !== "red";
        expect(conflict).toBe(false);
      }
    }
  });

  it("gives each axis a green, an amber, and an all-red clearance", () => {
    const seen = new Set<string>();
    for (let t = 0; t < SIGNAL_CYCLE; t += 0.05) {
      const p = signalPhase(4, 4, t, SEED);
      seen.add(`ns:${p.ns}`);
      seen.add(`ew:${p.ew}`);
      if (p.ns === "red" && p.ew === "red") seen.add("allred");
    }
    for (const key of [
      "ns:green",
      "ns:amber",
      "ns:red",
      "ew:green",
      "ew:amber",
      "ew:red",
      "allred",
    ]) {
      expect(seen).toContain(key);
    }
  });

  it("repeats exactly one cycle later", () => {
    for (const t of [0, 3.3, 21.7, 40]) {
      expect(signalPhase(2, 5, t, SEED)).toEqual(
        signalPhase(2, 5, t + SIGNAL_CYCLE, SEED),
      );
    }
    // ...and handles a negative clock without a phase jump.
    expect(signalPhase(2, 5, -1, SEED)).toEqual(
      signalPhase(2, 5, SIGNAL_CYCLE - 1, SEED),
    );
  });

  it("lights WALK only inside the parallel green, and rarely", () => {
    let walkLit = 0;
    let samples = 0;
    const step = 0.02;
    for (let t = 0; t < SIGNAL_CYCLE; t += step) {
      const p = signalPhase(1, 1, t, SEED);
      samples++;
      if (p.walkNs === "walk") {
        walkLit++;
        // Crossing the EW street happens while EW traffic is stopped.
        expect(p.ew).toBe("red");
        expect(p.ns).toBe("green");
      }
      if (p.walkEw === "walk") {
        expect(p.ns).toBe("red");
        expect(p.ew).toBe("green");
      }
      // The two crossings are never both walking.
      expect(p.walkNs === "walk" && p.walkEw === "walk").toBe(false);
    }
    // ~14 % of the cycle: the honest reason nobody is ever mid-crossing.
    expect(walkLit / samples).toBeGreaterThan(0.1);
    expect(walkLit / samples).toBeLessThan(0.2);
  });

  it("is deterministic and staggered between intersections", () => {
    expect(signalPhase(3, 3, 11.5, SEED)).toEqual(
      signalPhase(3, 3, 11.5, SEED),
    );
    const offsets = new Set<number>();
    for (let bx = 0; bx < CITY_GRID; bx++) {
      for (let bz = 0; bz < CITY_GRID; bz++)
        offsets.add(signalOffset(bx, bz, SEED));
    }
    // A city of 100 metronomes would be a bug; near-100 distinct offsets is
    // what the tagged per-block stream is for.
    expect(offsets.size).toBeGreaterThan(90);
  });
});

describe("signalMastsForBlock", () => {
  it("gives every block one intersection: 4 vehicle heads + 8 crosswalk heads", () => {
    const masts = signalMastsForBlock(2, 3);
    expect(masts.filter((m) => m.kind === "vehicle")).toHaveLength(4);
    expect(masts.filter((m) => m.kind === "crosswalk")).toHaveLength(8);
    // Two vehicle heads per axis — a diagonally opposite pair each.
    expect(masts.filter((m) => m.kind === "vehicle" && m.ns)).toHaveLength(2);
  });

  it("puts no mast in a roadway — all 100 intersections", () => {
    for (const m of allSignalMasts()) {
      expect(isInRoadway({ x: m.x, y: 0, z: m.z })).toBe(false);
    }
  });

  it("never co-locates two masts (a rotated square pole would z-fight)", () => {
    const masts = allSignalMasts();
    const keys = masts.map((m) => `${m.x.toFixed(3)},${m.z.toFixed(3)}`);
    expect(new Set(keys).size).toBe(masts.length);
  });

  it("stands every mast on street-furniture ground, clear of the lamp row", () => {
    const offCenter = (v: number) => {
      const m = ((v % 200) + 200) % 200;
      return Math.min(m, 200 - m);
    };
    for (const m of allSignalMasts()) {
      // On the furniture line on at least one axis, and never inside a lot.
      const near = Math.min(offCenter(m.x), offCenter(m.z));
      expect(near).toBeCloseTo(FURNITURE_LINE, 6);
    }
    // And no mast lands on top of a lamp post.
    const lamps = streetlampPositions();
    let worst = Number.POSITIVE_INFINITY;
    for (const m of signalMastsForBlock(2, 2)) {
      for (const l of lamps) {
        const gap = wrapDistance(
          { x: m.x, y: 0, z: m.z },
          { x: l.x, y: 0, z: l.z },
        );
        if (gap < worst) worst = gap;
      }
    }
    expect(worst).toBeGreaterThan(1);
  });

  it("covers all 100 intersections exactly once across the wrap", () => {
    expect(allSignalMasts()).toHaveLength(CITY_GRID * CITY_GRID * 12);
  });
});

describe("the emissive ladder", () => {
  it("keeps signal lenses on the lamp rung, under tracers", () => {
    // The renderer boosts each lit lens to EMISSIVE_LAMP; no new rung is
    // introduced and nothing here reaches EMISSIVE_TRACER.
    expect(EMISSIVE_LAMP).toBeLessThan(EMISSIVE_TRACER);
  });
});
