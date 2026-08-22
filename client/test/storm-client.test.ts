// ST2 pure storm-clock seam: reveal sets, thunder timing, turbulence shake,
// bolt polylines, and strike polling — pure functions of (strikes, poses,
// synced clock). Worked examples use the shipped constants: WORLD_SIZE 2000,
// STORM_REVEAL_RADIUS 300, STORM_REVEAL_MS 2000, CLOUD_BASE 500.

import { CLOUD_BASE } from "@angels-bandits/common/constants";
import { createFlightState } from "@angels-bandits/common/flight";
import { type Strike, strikesInWindow } from "@angels-bandits/common/storm";
import { describe, expect, it } from "vitest";
import { ChaseCamera } from "../src/game/camera";
import {
  StormReveals,
  StrikeFeed,
  boltBranches,
  boltPolyline,
  revealLevel,
  revealedPlanes,
  thunderDelayMs,
  thunderGain,
  turbulenceOffset,
} from "../src/render/storm";

describe("revealedPlanes", () => {
  const strike = { timeMs: 100_000, x: 1000, z: 1000 };

  it("reveals a plane 250 m out, not one 350 m out (radius 300)", () => {
    const near = { id: "a", pos: { x: 1250, y: 300, z: 1000 } };
    const far = { id: "b", pos: { x: 1350, y: 300, z: 1000 } };
    const revealed = revealedPlanes(strike, [near, far]);
    expect(revealed.map((p) => p.id)).toEqual(["a"]);
  });

  it("reveals across the seam: strike x=1990, plane x=10 is 20 m away", () => {
    const seam = { timeMs: 0, x: 1990, z: 500 };
    const plane = { id: "s", pos: { x: 10, y: 200, z: 500 } };
    expect(revealedPlanes(seam, [plane]).map((p) => p.id)).toEqual(["s"]);
  });

  it("ignores altitude — the bolt is a full-height column", () => {
    // 250 m horizontal but 400 m up: still inside the reveal column.
    const high = { id: "h", pos: { x: 1250, y: 700, z: 1000 } };
    expect(revealedPlanes(strike, [high]).map((p) => p.id)).toEqual(["h"]);
  });
});

describe("revealLevel", () => {
  it("runs 1 → 0 over STORM_REVEAL_MS (2000 ms), 0 outside", () => {
    expect(revealLevel(10_000, 10_000)).toBe(1);
    expect(revealLevel(10_000, 11_000)).toBeCloseTo(0.5, 10);
    expect(revealLevel(10_000, 12_000)).toBe(0);
    expect(revealLevel(10_000, 9_999)).toBe(0); // not yet struck
  });
});

describe("thunderDelayMs", () => {
  it("delays by wrapDistance / 340 m/s from the strike's ground point", () => {
    // Listener 340 m up, directly above the strike: exactly 1 s.
    const strike = { timeMs: 0, x: 600, z: 800 };
    expect(thunderDelayMs(strike, { x: 600, y: 340, z: 800 })).toBeCloseTo(
      1000,
      6,
    );
  });

  it("is seam-aware: strike x=1990 vs listener x=10 is 20 m, not 1980 m", () => {
    const strike = { timeMs: 0, x: 1990, z: 500 };
    // 20 m / 340 m/s = 58.82 ms — the raw-subtraction bug would give ~5.8 s.
    expect(thunderDelayMs(strike, { x: 10, y: 0, z: 500 })).toBeCloseTo(
      58.8235,
      2,
    );
  });
});

describe("turbulenceOffset", () => {
  it("is exactly zero at and below CLOUD_BASE (500 m)", () => {
    expect(turbulenceOffset(12_345, 500)).toEqual({ x: 0, y: 0, z: 0 });
    expect(turbulenceOffset(12_345, 120)).toEqual({ x: 0, y: 0, z: 0 });
  });

  it("shakes above the base, bounded, and ramps with altitude", () => {
    const low = turbulenceOffset(777, 520);
    const high = turbulenceOffset(777, 640);
    const mag = (v: { x: number; y: number; z: number }) =>
      Math.hypot(v.x, v.y, v.z);
    expect(mag(low)).toBeGreaterThan(0);
    expect(mag(high)).toBeGreaterThan(mag(low));
    // Hard bound: never more than 3 m of displacement (readability).
    for (let t = 0; t < 5000; t += 137) {
      expect(mag(turbulenceOffset(t, 800))).toBeLessThanOrEqual(3);
    }
  });

  it("is deterministic — same time and altitude, same offset", () => {
    expect(turbulenceOffset(4321, 610)).toEqual(turbulenceOffset(4321, 610));
  });
});

describe("camera shake is display-only", () => {
  const stubCamera = () => {
    const calls: { pos: number[]; look: number[] } = { pos: [], look: [] };
    return {
      calls,
      cam: {
        position: {
          set: (x: number, y: number, z: number) => {
            calls.pos = [x, y, z];
          },
        },
        lookAt: (x: number, y: number, z: number) => {
          calls.look = [x, y, z];
        },
      } as unknown as import("three").PerspectiveCamera,
    };
  };

  it("moves the rendered camera but never the chase state or the pose", () => {
    const flight = createFlightState({ x: 1000, y: 620, z: 1000 }, 0.3);
    Object.freeze(flight.pos); // the outgoing pose path reads this object
    const shake = turbulenceOffset(999, flight.pos.y);

    const plain = new ChaseCamera();
    plain.snapTo(flight);
    const a = stubCamera();
    plain.update(a.cam, flight, 0.016);

    const shaken = new ChaseCamera();
    shaken.snapTo(flight);
    const b = stubCamera();
    shaken.update(b.cam, flight, 0.016, undefined, shake);

    // The displayed camera moved by exactly the shake offset...
    expect(b.calls.pos[0]).toBeCloseTo((a.calls.pos[0] ?? 0) + shake.x, 10);
    expect(b.calls.pos[1]).toBeCloseTo((a.calls.pos[1] ?? 0) + shake.y, 10);
    expect(b.calls.pos[2]).toBeCloseTo((a.calls.pos[2] ?? 0) + shake.z, 10);
    // ...while the smoothed chase state and the streamed pose source did not.
    expect(shaken.position).toEqual(plain.position);
    expect(flight.pos).toEqual({ x: 1000, y: 620, z: 1000 });
  });
});

describe("thunderGain", () => {
  it("falls with distance and dies out by the far half-world", () => {
    const near = thunderGain(50);
    const mid = thunderGain(600);
    expect(near).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(0);
    expect(thunderGain(1500)).toBe(0);
  });
});

describe("boltPolyline", () => {
  const strike = { timeMs: 230_000, x: 700, z: 300 };

  it("runs from the cloud deck down to the given top, anchored at the strike", () => {
    const pts = boltPolyline(strike, 120);
    const first = pts[0];
    const last = pts[pts.length - 1];
    expect(first?.y).toBeGreaterThanOrEqual(CLOUD_BASE);
    expect(last).toEqual({ x: 0, y: 120, z: 0 }); // offsets from the strike
    // Jaggedness stays bounded so the bolt reads as a channel, not a scribble.
    for (const p of pts) {
      expect(Math.abs(p.x)).toBeLessThan(120);
      expect(Math.abs(p.z)).toBeLessThan(120);
    }
    expect(pts.length).toBeGreaterThan(16);
  });

  it("is deterministic per strike and differs between strikes", () => {
    expect(boltPolyline(strike, 120)).toEqual(boltPolyline(strike, 120));
    const other = boltPolyline({ timeMs: 241_500, x: 700, z: 300 }, 120);
    expect(boltPolyline(strike, 120)).not.toEqual(other);
  });
});

describe("StormReveals", () => {
  const strike = { timeMs: 50_000, x: 1000, z: 1000 };
  const planes = [
    { id: "near", pos: { x: 1250, y: 300, z: 1000 } },
    { id: "far", pos: { x: 1350, y: 300, z: 1000 } },
  ];

  it("tracks revealed planes for STORM_REVEAL_MS, by id and as pings", () => {
    const reveals = new StormReveals();
    reveals.onStrike(strike, planes, 7_000);
    expect(reveals.levelOf("near", 7_000)).toBe(1);
    expect(reveals.levelOf("near", 8_000)).toBeCloseTo(0.5, 10);
    expect(reveals.levelOf("near", 9_000)).toBe(0);
    expect(reveals.levelOf("far", 7_000)).toBe(0); // 350 m out — never revealed
    const pings = reveals.pings(7_500);
    expect(pings).toHaveLength(1);
    expect(pings[0]?.pos).toEqual({ x: 1250, y: 300, z: 1000 }); // echo where lit
    expect(reveals.pings(9_100)).toEqual([]); // expired echoes pruned
  });

  it("a fresh strike re-reveals a fading plane at full strength", () => {
    const reveals = new StormReveals();
    reveals.onStrike(strike, planes, 7_000);
    reveals.onStrike({ ...strike, timeMs: 58_000 }, planes, 8_500);
    expect(reveals.levelOf("near", 8_500)).toBe(1);
  });
});

describe("StrikeFeed", () => {
  it("returns nothing until the clock exists, primes on first tick", () => {
    const feed = new StrikeFeed(42);
    expect(feed.poll(null)).toEqual([]);
    expect(feed.poll(100_000)).toEqual([]); // priming tick — no back-replay
  });

  it("chunked polls partition the timeline: every strike once, none twice", () => {
    const feed = new StrikeFeed(42);
    feed.poll(100_000); // prime
    const seen: Strike[] = [];
    // Uneven frame-ish chunks across 5 minutes.
    let t = 100_000;
    let step = 16;
    while (t < 400_000) {
      t += step;
      step = (step * 31) % 700 + 16;
      seen.push(...feed.poll(t));
    }
    seen.push(...feed.poll(400_000));
    // Independent truth: ST1's window function over the whole span at once.
    expect(seen).toEqual(strikesInWindow(42, 100_000, 400_000));
  });
});

describe("boltBranches", () => {
  it("hangs every branch off a point of the main channel", () => {
    const strike = { timeMs: 230_000, x: 700, z: 300 };
    const main = boltPolyline(strike, 120);
    const branches = boltBranches(strike, main);
    expect(branches.length).toBeGreaterThan(0);
    for (const branch of branches) {
      const root = branch[0];
      expect(main).toContainEqual(root);
    }
  });
});
