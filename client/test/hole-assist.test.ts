// H2 hole assist (client/src/game/hole-assist.ts): the silent centering nudge.
// Its caps are the feature — capped, gated on range / capture / alignment,
// rate limited, yielding to the pilot, and never steering into a solid — so
// each is pinned here, against a hand-built hole and the real seed-42 city.

import {
  type Building,
  type HoleSpan,
  cityHoles,
  generateCity,
} from "@angels-bandits/common/city";
import { buildCityIndex, collideCity } from "@angels-bandits/common/collision";
import { CITY_SEED, PLAYER_RADIUS } from "@angels-bandits/common/constants";
import type { Vec3 } from "@angels-bandits/common/world";
import { describe, expect, it } from "vitest";
import {
  ASSIST_ALIGN_MAX,
  ASSIST_CAPTURE,
  ASSIST_MAX_RAD,
  ASSIST_RANGE,
  ASSIST_RATE,
  ASSIST_STICK_MAX,
  type AssistWorld,
  assistStick,
  createHoleAssist,
  holeAssistTarget,
  stepHoleAssist,
} from "../src/game/hole-assist";

const DEG = Math.PI / 180;

/** A 26 × 20 hole along x, 60 m long, centred at (1000, 50, 1000), in a
 * tower with nothing else around it. */
const host: Building = {
  x: 1000,
  z: 1000,
  width: 60,
  depth: 60,
  height: 120,
  tiers: [{ width: 60, depth: 60, height: 120 }],
  holes: [
    {
      kind: "tunnel",
      axis: "x",
      tierIndex: 0,
      offset: 0,
      y0: 40,
      width: 26,
      height: 20,
    },
  ],
};
const lone: AssistWorld = {
  spans: cityHoles([host]),
  buildings: [host],
};
const span = lone.spans[0] as HoleSpan;
/** Mouth the plane enters by when flying +x. */
const MOUTH_X = 970;

/** Unit direction for a heading `h` off +x toward +z, elevation `e`, rad. */
const dir = (h: number, e = 0): Vec3 => ({
  x: Math.cos(e) * Math.cos(h),
  y: Math.sin(e),
  z: Math.cos(e) * Math.sin(h),
});

const target = (pos: Vec3, d: Vec3, world: AssistWorld = lone) => {
  const out = createHoleAssist();
  const on = holeAssistTarget(pos, d, world, out);
  return { on, ...out };
};

describe("holeAssistTarget — a hand-built hole", () => {
  it("eases a plane offset to one side back onto the centreline, capped", () => {
    expect(span.center).toEqual({ x: 1000, y: 50, z: 1000 });
    // Flying +x, 5 m to the +z side (the pilot's right): turn left, i.e.
    // a negative (left) yaw. 5 m low: nose up.
    const t = target({ x: MOUTH_X - 30, y: 45, z: 1005 }, dir(0));
    expect(t.on).toBe(true);
    expect(t.yaw).toBeLessThan(0);
    expect(t.pitch).toBeGreaterThan(0);
    expect(Math.abs(t.yaw)).toBeLessThanOrEqual(ASSIST_MAX_RAD + 1e-12);
    expect(Math.abs(t.pitch)).toBeLessThanOrEqual(ASSIST_MAX_RAD + 1e-12);
    // Mirror image the other way, and the same both directions of travel.
    const m = target({ x: MOUTH_X - 30, y: 55, z: 995 }, dir(0));
    expect(m.yaw).toBeCloseTo(-t.yaw, 12);
    expect(m.pitch).toBeCloseTo(-t.pitch, 12);
    // Flying −x from the far side, the same +z offset is now on the LEFT.
    const back = target({ x: 1060, y: 45, z: 1005 }, dir(Math.PI));
    expect(back.yaw).toBeGreaterThan(0);
  });

  it("never exceeds ASSIST_MAX_RAD, however far off the line", () => {
    let maxed = 0;
    for (let lat = -18; lat <= 18; lat += 1.5) {
      for (let up = -14; up <= 14; up += 2) {
        for (const h of [-15, -6, 0, 6, 15]) {
          for (const dx of [-75, -40, -5, 20, 50]) {
            const t = target(
              { x: MOUTH_X + dx, y: 50 + up, z: 1000 + lat },
              dir(h * DEG),
            );
            expect(Math.abs(t.yaw)).toBeLessThanOrEqual(ASSIST_MAX_RAD + 1e-12);
            expect(Math.abs(t.pitch)).toBeLessThanOrEqual(
              ASSIST_MAX_RAD + 1e-12,
            );
            if (Math.abs(t.yaw) > ASSIST_MAX_RAD - 1e-9) maxed++;
          }
        }
      }
    }
    expect(maxed).toBeGreaterThan(0); // the cap is reached, not just never hit
  });

  it("only engages within ASSIST_RANGE of the mouth, and never past the exit", () => {
    const at = (x: number) => target({ x, y: 50, z: 1006 }, dir(0)).on;
    expect(at(MOUTH_X - ASSIST_RANGE + 1)).toBe(true);
    expect(at(MOUTH_X - ASSIST_RANGE - 1)).toBe(false);
    expect(at(1000)).toBe(true); // inside the hole
    expect(at(1031)).toBe(false); // past the exit
  });

  it("only engages inside the mouth plus ASSIST_CAPTURE — flying past beside it is left alone", () => {
    const at = (z: number, y = 50) =>
      target({ x: MOUTH_X - 40, y, z }, dir(0)).on;
    expect(at(1000 + 13 + ASSIST_CAPTURE - 0.5)).toBe(true);
    expect(at(1000 + 13 + ASSIST_CAPTURE + 0.5)).toBe(false);
    expect(at(1000 - 13 - ASSIST_CAPTURE - 0.5)).toBe(false);
    expect(at(1000, 50 + 10 + ASSIST_CAPTURE + 0.5)).toBe(false);
  });

  it("only engages when the pilot MEANS to fly the axis (≤ ASSIST_ALIGN_MAX), fading out toward it", () => {
    const pos = { x: MOUTH_X - 40, y: 50, z: 1006 };
    const full = target(pos, dir(0));
    const half = target(pos, dir(14 * DEG));
    const off = target(pos, dir(ASSIST_ALIGN_MAX + 0.5 * DEG));
    const climbing = target(pos, dir(0, ASSIST_ALIGN_MAX + 0.5 * DEG));
    expect(full.on).toBe(true);
    expect(off.on).toBe(false);
    expect(climbing.on).toBe(false);
    // Aiming 14° toward +z (further off): the assist's weight is fading.
    expect(Math.abs(half.yaw)).toBeLessThan(Math.abs(full.yaw) + 1e-12);
  });

  it("never steers into a solid: a wall on the centreline beyond the exit vetoes it", () => {
    // A slab right across the centreline 30 m past the exit, the plane off
    // to the side where its own line passes beside the slab.
    const slab: Building = {
      x: 1060,
      z: 1000,
      width: 4,
      depth: 10,
      height: 200,
      tiers: [{ width: 4, depth: 10, height: 200 }],
    };
    const world: AssistWorld = { spans: lone.spans, buildings: [host, slab] };
    const pos = { x: 1020, y: 50, z: 1009 };
    // The pilot's own line is clear for the guard's whole sweep...
    for (let d = 4; d <= 60; d += 4) {
      expect(
        collideCity({ x: pos.x + d, y: 50, z: pos.z }, PLAYER_RADIUS + 0.5, [
          host,
          slab,
        ]),
      ).toBeNull();
    }
    // ...the nudge toward the centreline would put it into the slab: no.
    expect(target(pos, dir(0)).on).toBe(true);
    expect(target(pos, dir(0), world)).toEqual({ on: false, yaw: 0, pitch: 0 });
  });
});

describe("stepHoleAssist — rate limited both ways", () => {
  it("moves at most ASSIST_RATE per second, and lets go to zero within ASSIST_MAX_RAD / ASSIST_RATE", () => {
    const s = createHoleAssist();
    const want = { yaw: ASSIST_MAX_RAD, pitch: -ASSIST_MAX_RAD };
    const dt = 1 / 60;
    stepHoleAssist(s, want, dt);
    expect(s.yaw).toBeCloseTo(ASSIST_RATE * dt, 12);
    expect(s.pitch).toBeCloseTo(-ASSIST_RATE * dt, 12);
    for (let i = 0; i < 120; i++) stepHoleAssist(s, want, dt);
    expect(s).toEqual(want);
    // Disengage: back to exactly zero inside the decay budget (≈ 0.67 s).
    const zero = { yaw: 0, pitch: 0 };
    const frames = Math.ceil(ASSIST_MAX_RAD / ASSIST_RATE / dt) + 1;
    for (let i = 0; i < frames; i++) stepHoleAssist(s, zero, dt);
    expect(s).toEqual(zero);
    expect(frames * dt).toBeLessThan(0.75);
  });
});

describe("assistStick — classic mode", () => {
  const rates = { turnRate: 1.2, pitchRate: 1.2 };
  const out = { turn: 0, pitch: 0 };
  const bias = { yaw: ASSIST_MAX_RAD, pitch: -ASSIST_MAX_RAD };

  it("adds at most ASSIST_STICK_MAX of stick", () => {
    assistStick(bias, { turn: 0, pitch: 0 }, rates, out);
    expect(out.turn).toBeCloseTo(ASSIST_STICK_MAX, 12);
    expect(out.pitch).toBeCloseTo(-ASSIST_STICK_MAX, 12);
    assistStick(bias, { turn: 0.3, pitch: -0.2 }, rates, out);
    expect(out.turn).toBeCloseTo(0.3 + ASSIST_STICK_MAX, 12);
    expect(out.pitch).toBeCloseTo(-0.2 - ASSIST_STICK_MAX, 12);
  });

  it("yields outright to a pilot pushing the other way", () => {
    assistStick(bias, { turn: -0.2, pitch: 0.4 }, rates, out);
    expect(out).toEqual({ turn: -0.2, pitch: 0.4 });
  });
});

describe("holeAssistTarget — the seed-42 city", () => {
  const city = generateCity(CITY_SEED);
  const world: AssistWorld = {
    spans: cityHoles(city),
    buildings: city,
    index: buildCityIndex(city),
  };

  it("engages on the approach to every hole flown down its axis, and stays capped", () => {
    let engaged = 0;
    for (const s of world.spans) {
      const x = s.hole.axis === "x";
      for (const sg of [1, -1]) {
        const along = -sg * (s.length / 2 + 30);
        const pos = {
          x: s.center.x + (x ? along : 3),
          y: s.center.y - 2,
          z: s.center.z + (x ? 3 : along),
        };
        const d = { x: x ? sg : 0, y: 0, z: x ? 0 : sg };
        const t = target(pos, d, world);
        if (t.on) engaged++;
        expect(Math.abs(t.yaw)).toBeLessThanOrEqual(ASSIST_MAX_RAD + 1e-12);
        expect(Math.abs(t.pitch)).toBeLessThanOrEqual(ASSIST_MAX_RAD + 1e-12);
      }
    }
    // Arches' approaches are not clear air (hand-placed, H1), so the guard
    // may veto some — but the run-out rule makes every other hole engage.
    expect(engaged).toBeGreaterThanOrEqual(
      2 * world.spans.filter((s) => s.hole.kind !== "arch").length,
    );
  });
});
