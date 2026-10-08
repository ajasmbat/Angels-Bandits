// H2 more holes (common/src/city/holes.ts) on the real seed-42 city: how many
// there are and how big their mouths are; that every centreline flies clear
// (a probe sphere, and the real stepFlight at 50–90 m/s) and every tunnel,
// gate and sky hole exits into clear air at both OUTER mouths; that the
// walls, lintels and sills around them still collide; that losClear sees
// exactly what collision flies; and that a row tunnel is one span over its
// whole run.

import {
  type Building,
  type HoleSpan,
  cityHoles,
  generateCity,
  opensOnStreets,
  segmentThroughHole,
  solids,
} from "@angels-bandits/common/city";
import { natureFor } from "@angels-bandits/common/city/nature";
import {
  buildCityIndex,
  buildNatureIndex,
  collideCity,
  collideNature,
  losClear,
} from "@angels-bandits/common/collision";
import {
  ARCH_HEIGHT,
  ARCH_WIDTH,
  CITY_SEED,
  GATE_HEIGHT,
  GATE_WIDTH,
  HOLE_LINTEL_MIN,
  HOLE_RUN_OUT,
  HOLE_WALL_MIN,
  PLAYER_RADIUS,
  SKY_HOLE_HEIGHT,
  SKY_HOLE_WIDTH,
  TUNNEL_HEIGHT,
  TUNNEL_WIDTH,
  WORLD_SIZE,
} from "@angels-bandits/common/constants";
import { createFlightState, stepFlight } from "@angels-bandits/common/flight";
import {
  type Vec3,
  canonicalize,
  wrapDeltaAxis,
} from "@angels-bandits/common/world";
import { describe, expect, it } from "vitest";

const city = generateCity(CITY_SEED);
const index = buildCityIndex(city);
const nature = buildNatureIndex(natureFor(CITY_SEED, city));
const spans = cityHoles(city);
const byKind = (k: string) => spans.filter((s) => s.hole.kind === k);
/** Holes placed by the clear-air rule (arches are hand-placed, H1). */
const ruled = spans.filter((s) => s.hole.kind !== "arch");

/** A point `along` past the span centre on its axis, `across` off it. */
function at(s: HoleSpan, along: number, across = 0, up = 0): Vec3 {
  const x = s.hole.axis === "x";
  return canonicalize({
    x: s.center.x + (x ? along : across),
    y: s.center.y + up,
    z: s.center.z + (x ? across : along),
  });
}
const where = (s: HoleSpan) =>
  `${s.hole.kind} @ ${Math.round(s.center.x)},${Math.round(s.center.z)} y0 ${s.hole.y0}`;

describe("H2 hole count and mouths (seed 42)", () => {
  it("has about 3× H1's 12 holes, of every kind", () => {
    expect(spans.length).toBeGreaterThanOrEqual(30);
    expect(byKind("arch").length).toBe(4);
    expect(byKind("tunnel").length).toBeGreaterThanOrEqual(15);
    expect(byKind("gate").length).toBeGreaterThanOrEqual(5);
    expect(byKind("sky").length).toBeGreaterThanOrEqual(3);
    // Block-through: at least one tunnel runs street to street, and one cuts
    // more than one lot.
    expect(byKind("tunnel").some(opensOnStreets)).toBe(true);
    expect(byKind("tunnel").some((s) => s.hosts.length > 1)).toBe(true);
  });

  it("opens every mouth at least as big as its kind's minimum", () => {
    const min: Record<string, [number, number]> = {
      arch: [ARCH_WIDTH, ARCH_HEIGHT],
      tunnel: [TUNNEL_WIDTH, TUNNEL_HEIGHT],
      gate: [GATE_WIDTH, GATE_HEIGHT],
      sky: [SKY_HOLE_WIDTH, SKY_HOLE_HEIGHT],
    };
    expect(TUNNEL_WIDTH).toBeGreaterThanOrEqual(26);
    expect(TUNNEL_HEIGHT).toBeGreaterThanOrEqual(20);
    expect(SKY_HOLE_WIDTH).toBeGreaterThanOrEqual(22);
    expect(SKY_HOLE_HEIGHT).toBeGreaterThanOrEqual(18);
    for (const s of spans) {
      const [w, h] = min[s.hole.kind] as [number, number];
      expect(s.hole.width, where(s)).toBeGreaterThanOrEqual(w);
      expect(s.hole.height, where(s)).toBeGreaterThanOrEqual(h);
    }
  });
});

describe("H2 holes fly clear (seed 42)", () => {
  it("every centreline, mouth to mouth, clears a probe sphere — corners of the opening too", () => {
    const r = PLAYER_RADIUS + 0.5;
    for (const s of spans) {
      const lat = s.hole.width / 2 - r - 0.05;
      const ver = s.hole.height / 2 - r - 0.05;
      for (let a = -s.length / 2; a <= s.length / 2; a += 2) {
        for (const [c, u] of [
          [0, 0],
          [lat, ver],
          [-lat, -ver],
          [lat, -ver],
          [-lat, ver],
        ] as const) {
          expect(
            collideCity(at(s, a, c, u), r, city, index),
            where(s),
          ).toBeNull();
        }
      }
    }
  });

  it("every tunnel, gate and sky hole exits into clear air: HOLE_RUN_OUT past both outer mouths (buildings and trees)", () => {
    const r = PLAYER_RADIUS;
    let seam = 0;
    for (const s of ruled) {
      // Closed boxes: a facade exactly at the run-out's end is legal, so the
      // probe stops just inside it.
      const end = s.length / 2 + HOLE_RUN_OUT - r - 0.5;
      const x = s.hole.axis === "x";
      const c = x ? s.center.x : s.center.z;
      if (c - end < 0 || c + end > WORLD_SIZE) seam++;
      for (let a = -end; a <= end; a += 2) {
        for (const u of [-(s.hole.height / 2 - r - 0.5), 0]) {
          const p = at(s, a, 0, u);
          expect(collideCity(p, r, city, index), where(s)).toBeNull();
          expect(collideNature(p, r, nature), where(s)).toBeNull();
        }
      }
    }
    // The torus is exercised: some run-out crosses the seam.
    expect(seam).toBeGreaterThan(0);
  });

  it("the real stepFlight flies every hole level down its centreline at 50–90 m/s and registers the transit", () => {
    for (const s of spans) {
      const x = s.hole.axis === "x";
      for (const dir of [1, -1] as const) {
        for (const speed of [50, 70, 90]) {
          // Arches have a 55 m run-in (H1); everything else its run-out.
          const back = s.hole.kind === "arch" ? 30 : 100;
          const start = at(s, -dir * (s.length / 2 + back));
          // yaw 0 faces −z; +x is −π/2, −x +π/2, +z π.
          const yaw = x
            ? dir === 1
              ? -Math.PI / 2
              : Math.PI / 2
            : dir === 1
              ? Math.PI
              : 0;
          let f = {
            ...createFlightState(start, yaw),
            speed,
            targetSpeed: speed,
          };
          let transit = 0;
          const steps = Math.ceil(((s.length + 2 * back) / speed) * 60);
          for (let i = 0; i < steps; i++) {
            const prev = f.pos;
            f = stepFlight(
              f,
              { turn: 0, pitch: 0, roll: 0, throttle: 0 },
              1 / 60,
            );
            expect(
              collideCity(f.pos, PLAYER_RADIUS, city, index),
              where(s),
            ).toBeNull();
            const d = segmentThroughHole(s, prev, f.pos);
            if (d !== 0) transit = d;
          }
          expect(transit, where(s)).toBe(dir);
        }
      }
    }
  });
});

describe("H2 holes keep their walls (seed 42)", () => {
  /** The hole's frame centre in a host's own solids. */
  const hostHits = (b: Building, p: Vec3, r: number) =>
    collideCity(p, r, [b]) === b;

  it("walls either side, the lintel over it and any sill under it still collide", () => {
    let sills = 0;
    for (const s of spans) {
      for (const b of s.hosts) {
        const hole = b.holes?.[0];
        if (!hole) continue;
        const x = hole.axis === "x";
        const mid = x ? b.x : b.z;
        const a = x
          ? wrapDeltaAxis(s.center.x, mid)
          : wrapDeltaAxis(s.center.z, mid);
        const r = 0.5;
        // Walls: HOLE_WALL_MIN / 2 into each side wall.
        for (const side of [-1, 1]) {
          const c = side * (hole.width / 2 + HOLE_WALL_MIN / 2);
          expect(hostHits(b, at(s, a, c), r), where(s)).toBe(true);
        }
        // Lintel: half its minimum above the ceiling.
        const lintel = at(s, a, 0, hole.height / 2 + HOLE_LINTEL_MIN / 2);
        expect(hostHits(b, lintel, r), where(s)).toBe(true);
        // Sill: wherever the floor is above the cut tier's base.
        let base = 0;
        for (let i = 0; i < hole.tierIndex; i++)
          base += b.tiers[i]?.height ?? 0;
        if (hole.y0 - base > 2) {
          sills++;
          const sill = at(s, a, 0, -hole.height / 2 - 1);
          expect(hostHits(b, sill, r), where(s)).toBe(true);
        }
        // Every solid stays inside the tier-1 footprint (index invariant).
        for (const box of solids(b)) {
          expect(Math.abs(box.dx) + box.width / 2).toBeLessThanOrEqual(
            b.width / 2 + 1e-9,
          );
          expect(Math.abs(box.dz) + box.depth / 2).toBeLessThanOrEqual(
            b.depth / 2 + 1e-9,
          );
        }
      }
    }
    expect(sills).toBeGreaterThan(0);
  });

  it("losClear agrees with collision: clear down the centreline, blocked through a wall", () => {
    for (const s of spans) {
      const end = s.length / 2 + (s.hole.kind === "arch" ? 0 : 20);
      expect(losClear(at(s, -end), at(s, end), city), where(s)).toBe(true);
      // Diagonal across the run, wall to wall: blocked by a host's solids.
      const c = s.hole.width / 2 + HOLE_WALL_MIN / 2;
      expect(losClear(at(s, 0, -c), at(s, 0, c), city), where(s)).toBe(false);
      expect(
        losClear(
          at(s, 0, 0, s.hole.height / 2 + 2),
          at(s, 0, 0, s.hole.height / 2 + 4),
          city,
        ),
        where(s),
      ).toBe(false);
    }
  });
});

describe("H2 row tunnels are one span (seed 42)", () => {
  it("a run's span reaches exactly the outer edges of its first and last host", () => {
    const runs = byKind("tunnel");
    for (const s of runs) {
      const x = s.hole.axis === "x";
      let lo = Number.POSITIVE_INFINITY;
      let hi = Number.NEGATIVE_INFINITY;
      for (const b of s.hosts) {
        const hole = b.holes?.[0];
        expect(hole?.run, where(s)).toBe(s.hole.run);
        const t = b.tiers[hole?.tierIndex ?? 0];
        if (!t) throw new Error("no tier");
        const half = (x ? t.width : t.depth) / 2;
        const mid = x ? b.x : b.z;
        lo = Math.min(lo, mid - half);
        hi = Math.max(hi, mid + half);
        // Every host is cut on the same line, floor and size.
        expect(hole?.y0).toBe(s.hole.y0);
        expect((x ? b.z : b.x) + (hole?.offset ?? 0)).toBeCloseTo(
          x ? s.center.z : s.center.x,
          9,
        );
      }
      expect(hi - lo, where(s)).toBeCloseTo(s.length, 9);
      expect(x ? s.entry.x : s.entry.z, where(s)).toBeCloseTo(lo, 9);
      expect(x ? s.exit.x : s.exit.z, where(s)).toBeCloseTo(hi, 9);
    }
    // Every holed building belongs to exactly one span.
    const holed = city.filter((b) => b.holes);
    expect(spans.reduce((n, s) => n + s.hosts.length, 0)).toBe(holed.length);
  });
});
