// H2 hole decor (client/src/render/hole-decor.ts) on the real seed-42 city:
// every interior piece is flush with the lining it decorates (≤ DECOR_DEPTH
// proud of it, inside the clear volume, never across an open-sky slot), the
// approach chevrons lie under the floor, every emissive sits on its ladder
// rung, and the whole city stays inside the vertex budget.

import { cityHoles, generateCity } from "@angels-bandits/common/city";
import {
  CITY_SEED,
  EMISSIVE_HOLE_LED,
  EMISSIVE_SIGN,
  EMISSIVE_WINDOW,
  PLAYER_RADIUS,
} from "@angels-bandits/common/constants";
import { wrapDeltaAxis } from "@angels-bandits/common/world";
import { describe, expect, it } from "vitest";
import {
  DECOR_DEPTH,
  DECOR_PAINT_GLOW,
  DECOR_VERTEX_BUDGET,
  DecorKind,
  bakeDecor,
  bucketByBlock,
  holeDecorFor,
  linedSegments,
} from "../src/render/hole-decor";

const city = generateCity(CITY_SEED);
const spans = cityHoles(city);
const byBlock = bucketByBlock(city);
const decor = spans.map((span) => ({
  span,
  quads: holeDecorFor(span, byBlock),
}));
const lum = (c: readonly number[]) =>
  0.2126 * (c[0] ?? 0) + 0.7152 * (c[1] ?? 0) + 0.0722 * (c[2] ?? 0);

/** Every corner of a span's quads in its hole frame (along, across, up). */
function corners(i: number) {
  const { span, quads } = decor[i] as (typeof decor)[number];
  const x = span.hole.axis === "x";
  return quads.flatMap((q) =>
    q.corners.map(([dx, dy, dz]) => {
      const wx = q.pivot.x + dx;
      const wz = q.pivot.z + dz;
      return {
        q,
        a: x
          ? wrapDeltaAxis(span.center.x, wx)
          : wrapDeltaAxis(span.center.z, wz),
        c: x
          ? wrapDeltaAxis(span.center.z, wz)
          : wrapDeltaAxis(span.center.x, wx),
        y: q.pivot.y + dy,
      };
    }),
  );
}

describe("hole decor — seed 42", () => {
  it("decorates every hole, inside the vertex budget, deterministically", () => {
    expect(spans.length).toBeGreaterThanOrEqual(30);
    for (const { span, quads } of decor) {
      const inside = quads.filter((q) => q.kind !== DecorKind.CHEVRON);
      expect(
        inside.length,
        `${span.hole.kind} @ ${span.center.x},${span.center.z}`,
      ).toBeGreaterThan(10);
    }
    const all = decor.flatMap((d) => d.quads);
    expect(bakeDecor(all).vertexCount).toBeLessThanOrEqual(DECOR_VERTEX_BUDGET);
    const again = cityHoles(generateCity(CITY_SEED)).flatMap((s) =>
      holeDecorFor(s, bucketByBlock(city)),
    );
    expect(again).toEqual(all);
  });

  it("keeps every interior piece flush: inside the clear volume, within DECOR_DEPTH of the lining, on a lined host", () => {
    expect(DECOR_DEPTH).toBeLessThan(PLAYER_RADIUS);
    const bad: string[] = [];
    decor.forEach(({ span }, i) => {
      const { width: W, height: H, y0 } = span.hole;
      const segs = linedSegments(span);
      const eps = 1e-6;
      for (const p of corners(i)) {
        if (p.q.kind === DecorKind.CHEVRON) continue;
        const where = `${span.hole.kind} @ ${Math.round(span.center.x)},${Math.round(span.center.z)} kind ${p.q.kind}`;
        if (
          Math.abs(p.c) > W / 2 + eps ||
          p.y < y0 - eps ||
          p.y > y0 + H + eps
        ) {
          bad.push(`${where}: outside the clear volume`);
          continue;
        }
        const depth = Math.min(W / 2 - Math.abs(p.c), p.y - y0, y0 + H - p.y);
        if (depth > DECOR_DEPTH + eps)
          bad.push(`${where}: ${depth.toFixed(2)} m proud`);
        if (!segs.some(([lo, hi]) => p.a >= lo - eps && p.a <= hi + eps)) {
          bad.push(`${where}: over an open-sky slot`);
        }
      }
    });
    expect(bad).toEqual([]);
  });

  it("lays the approach chevrons under the floor, outside the hole", () => {
    let n = 0;
    decor.forEach(({ span }, i) => {
      const segs = linedSegments(span);
      const lo = segs[0]?.[0] ?? 0;
      const hi = segs[segs.length - 1]?.[1] ?? 0;
      for (const p of corners(i)) {
        if (p.q.kind !== DecorKind.CHEVRON) continue;
        n++;
        expect(p.y).toBeLessThan(span.hole.y0);
        expect(p.a <= lo + 0.1 || p.a >= hi - 0.1).toBe(true);
      }
    });
    expect(n).toBeGreaterThan(spans.length * 8);
  });

  it("puts every emissive on its ladder rung (paint under the bloom threshold)", () => {
    const peak = new Map<DecorKind, number>();
    for (const { quads } of decor) {
      for (const q of quads) {
        peak.set(q.kind, Math.max(peak.get(q.kind) ?? 0, lum(q.glow)));
      }
    }
    expect(peak.get(DecorKind.LIGHT)).toBeCloseTo(EMISSIVE_HOLE_LED, 6);
    expect(peak.get(DecorKind.CHEVRON)).toBeCloseTo(EMISSIVE_HOLE_LED, 6);
    expect(peak.get(DecorKind.EXIT)).toBeLessThanOrEqual(EMISSIVE_SIGN + 1e-9);
    expect(peak.get(DecorKind.ARROW)).toBeLessThanOrEqual(EMISSIVE_SIGN + 1e-9);
    expect(peak.get(DecorKind.MURAL)).toBeLessThanOrEqual(EMISSIVE_SIGN + 1e-9);
    expect(peak.get(DecorKind.LOBBY)).toBeLessThanOrEqual(
      EMISSIVE_WINDOW + 1e-9,
    );
    // Paint (lane lines, tags) is not a light.
    expect(DECOR_PAINT_GLOW).toBeLessThan(0.72);
    expect(peak.get(DecorKind.PLAIN)).toBeLessThanOrEqual(
      DECOR_PAINT_GLOW + 1e-9,
    );
    expect(peak.get(DecorKind.GRAFFITI)).toBeLessThanOrEqual(
      DECOR_PAINT_GLOW + 1e-9,
    );
    expect(peak.get(DecorKind.FAN) ?? 0).toBe(0);
  });

  it("dresses the arches as lobbies and everything else with murals", () => {
    for (const { span, quads } of decor) {
      const kinds = new Set(quads.map((q) => q.kind));
      if (span.hole.kind === "arch") {
        expect(kinds.has(DecorKind.LOBBY)).toBe(true);
        expect(kinds.has(DecorKind.MURAL)).toBe(false);
      } else {
        expect(kinds.has(DecorKind.LOBBY)).toBe(false);
      }
      expect(kinds.has(DecorKind.LIGHT)).toBe(true);
    }
  });
});
