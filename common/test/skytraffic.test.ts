// L10 sky-traffic schedules. What these defend: every client draws the same
// airliners and the same drone show from (seed, synced clock) alone — so the
// schedules must be pure — and the airliners stay out of the flight band.

import { PLAZA_BLOCKS } from "@angels-bandits/common/city";
import {
  BLOCK_PITCH,
  MAX_ALTITUDE,
  STORM_KILL_ALT,
} from "@angels-bandits/common/constants";
import {
  AIRLINER_ALT_MIN,
  DRONE_ALT_MAX,
  DRONE_ALT_MIN,
  DRONE_COUNT,
  DRONE_SHOW_MS,
  DRONE_SHOW_PERIOD_MS,
  airlinerOffsetInto,
  airlinersAt,
  droneKeyframe,
  dronePointInto,
  droneShowAt,
} from "@angels-bandits/common/skytraffic";
import { describe, expect, it } from "vitest";

const SEED = 42;
/** An epoch-ms clock like the server's, so float behaviour is realistic. */
const T0 = 1_791_000_000_000;

describe("airliners", () => {
  it("are a pure function of (seed, time)", () => {
    for (let k = 0; k < 50; k++) {
      const t = T0 + k * 7_919;
      expect(airlinersAt(SEED, t)).toEqual(airlinersAt(SEED, t));
    }
    // A different seed is a different sky.
    const a = JSON.stringify(airlinersAt(SEED, T0 + 123_456));
    const b = JSON.stringify(airlinersAt(SEED + 1, T0 + 123_456));
    expect(a).not.toEqual(b);
  });

  it("keep the sky busy but never crowded", () => {
    let busy = 0;
    let most = 0;
    for (let k = 0; k < 600; k++) {
      const n = airlinersAt(SEED, T0 + k * 10_000).length;
      if (n > 0) busy++;
      most = Math.max(most, n);
    }
    expect(busy / 600).toBeGreaterThan(0.6);
    expect(most).toBeLessThanOrEqual(5);
  });

  it("fly 1,000 m+ up — far above the flight band and the storm ceiling", () => {
    const off = { x: 0, y: 0, z: 0, hx: 0, hz: 0 };
    for (let k = 0; k < 300; k++) {
      const t = T0 + k * 13_000;
      for (const a of airlinersAt(SEED, t)) {
        expect(airlinerOffsetInto(a, t, off).y).toBeGreaterThanOrEqual(
          AIRLINER_ALT_MIN,
        );
        expect(AIRLINER_ALT_MIN).toBeGreaterThan(
          Math.max(MAX_ALTITUDE, STORM_KILL_ALT),
        );
      }
    }
  });

  it("move along a straight track at cruise speed", () => {
    const a = airlinersAt(SEED, T0).at(0) ?? airlinersAt(SEED, T0 + 40_000)[0];
    expect(a).toBeDefined();
    if (!a) return;
    const p = airlinerOffsetInto(a, a.startMs + 10_000, {
      x: 0,
      y: 0,
      z: 0,
      hx: 0,
      hz: 0,
    });
    const q = airlinerOffsetInto(a, a.startMs + 11_000, {
      x: 0,
      y: 0,
      z: 0,
      hx: 0,
      hz: 0,
    });
    expect(Math.hypot(q.x - p.x, q.z - p.z)).toBeCloseTo(a.speed, 6);
  });
});

describe("drone show", () => {
  it("is a pure function of (seed, time)", () => {
    for (let k = 0; k < 200; k++) {
      const t = T0 + k * 61_000;
      expect(droneShowAt(SEED, t)).toEqual(droneShowAt(SEED, t));
    }
  });

  it("plays 60 s once per ~8 min, over a plaza, at 180-260 m", () => {
    const step = 1000;
    const starts: number[] = [];
    let on = 0;
    let prev = false;
    const span = 10 * DRONE_SHOW_PERIOD_MS;
    for (let t = T0; t < T0 + span; t += step) {
      const show = droneShowAt(SEED, t);
      if (show) {
        on++;
        if (!prev) starts.push(show.startMs);
        expect(show.y).toBeGreaterThanOrEqual(DRONE_ALT_MIN);
        expect(show.y).toBeLessThanOrEqual(DRONE_ALT_MAX);
        const plaza = PLAZA_BLOCKS[show.plaza];
        expect(plaza).toBeDefined();
        expect(show.x).toBe(((plaza?.[0] ?? 0) + 0.5) * BLOCK_PITCH);
        expect(show.z).toBe(((plaza?.[1] ?? 0) + 0.5) * BLOCK_PITCH);
      }
      prev = !!show;
    }
    // ~10 shows of 60 s each in 80 min.
    expect(starts.length).toBeGreaterThanOrEqual(9);
    expect(starts.length).toBeLessThanOrEqual(11);
    expect(on * step).toBeGreaterThanOrEqual(9 * DRONE_SHOW_MS);
    for (let i = 1; i < starts.length; i++) {
      const gap = (starts[i] ?? 0) - (starts[i - 1] ?? 0);
      expect(gap).toBeGreaterThanOrEqual(6 * 60_000 - step);
      expect(gap).toBeLessThanOrEqual(10 * 60_000 + step);
    }
  });

  it("flies every drone from the plaza floor, through shapes, back down", () => {
    const show = droneShowAt(SEED, T0) ?? {
      startMs: T0,
      x: 900,
      y: 220,
      z: 900,
      plaza: 0,
      spin: 0,
    };
    const p = { x: 0, y: 0, z: 0 };
    for (let i = 0; i < DRONE_COUNT; i++) {
      // Parked on the floor at the start and the end.
      expect(dronePointInto(show, i, show.startMs, p).y).toBeCloseTo(2, 6);
      expect(
        dronePointInto(show, i, show.startMs + DRONE_SHOW_MS, p).y,
      ).toBeCloseTo(2, 6);
      // Airborne mid-show, and the whole formation stays over its plaza.
      for (const s of [12, 22, 34, 46]) {
        const q = dronePointInto(show, i, show.startMs + s * 1000, p);
        expect(q.y).toBeGreaterThan(show.y - 70);
        expect(Math.hypot(q.x - show.x, q.z - show.z)).toBeLessThan(
          BLOCK_PITCH / 2,
        );
      }
    }
    // Motion is continuous: no drone jumps between frames.
    for (let i = 0; i < DRONE_COUNT; i += 7) {
      for (let ms = 0; ms < DRONE_SHOW_MS; ms += 250) {
        const a = { ...dronePointInto(show, i, show.startMs + ms, p) };
        const b = dronePointInto(show, i, show.startMs + ms + 16, p);
        expect(Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)).toBeLessThan(2);
      }
    }
    expect(droneKeyframe(0)).toEqual({ from: 0, to: 1, k: 0 });
  });
});
