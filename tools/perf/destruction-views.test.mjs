// D11: every staged destruction view shows its subject. H1's taller city
// moved buildings out from under the D8–D10 views — they framed intact
// towers or the backs of neighbours — and nothing failed. Each gallery view
// that stages a fell, chews a facade or downs a prop, each collapse
// time-lapse case and each destruction perf segment is checked here against
// the seed city (view-check.mjs): its subject sits inside the frame, the
// eye has a clear sight line to it, and a fell is caught in the phase the
// view promises (still falling, or settled).

import { describe, expect, it } from "vitest";
import { wrapDeltaAxis } from "../../common/src/world/index.ts";
import { CASES } from "./collapse-cases.mjs";
import { VIEWS } from "./gallery-views.mjs";
import { SEGMENTS } from "./segments.mjs";
import {
  CITY,
  collapseSamples,
  felledCollapse,
  framed,
  inOpen,
  xyz,
} from "./view-check.mjs";

/** At least this share of the subject framed, and of that, seen. A perf
 * segment is a held flight pose, not a composed shot: a quarter framed. */
const MIN_FRAMED = 0.5;
const MIN_SEEN = 0.5;
const MIN_FRAMED_SEGMENT = 0.25;
const MIN_SEEN_SEGMENT = 0.35;

/** The guard qaDestruction applies: the city still has this tower. */
const guard = (f) =>
  expect(Math.round(CITY[f.b]?.height ?? -1), `building ${f.b}`).toBe(f.h);

/** A fell's subject at `ageMs` in `phase` ("falling" | "settled"). */
function fellSubject(f, ageMs, phase) {
  guard(f);
  const c = felledCollapse(f);
  const falling = phase === "falling";
  const s = collapseSamples(c, ageMs, falling, 96);
  if (falling) expect(s.moving, "pieces still moving").toBeGreaterThan(0);
  else expect(ageMs, "the fell has settled").toBeGreaterThanOrEqual(c.endMs);
  return { points: inOpen(s.points, [f.b]), skip: [f.b] };
}

/** The building whose footprint (+ 2 m) holds plan point `p`. */
const buildingAt = (p) =>
  CITY.findIndex(
    (b) =>
      Math.abs(wrapDeltaAxis(b.x, p.x)) <= b.width / 2 + 2 &&
      Math.abs(wrapDeltaAxis(b.z, p.z)) <= b.depth / 2 + 2,
  );

const fellViews = VIEWS.filter((v) => v.stage?.fell);
const chewViews = VIEWS.filter((v) => v.chew);
const propViews = VIEWS.filter((v) => v.stage?.props && v.subject);

describe("D11 staged destruction views frame their subject", () => {
  it("covers every destruction view", () => {
    expect(fellViews.length).toBeGreaterThanOrEqual(6);
    expect(chewViews.length).toBeGreaterThanOrEqual(2);
    // Every view that stages a fall says when it is shot (a fall is over
    // in seconds; a slow rasteriser's settle loop takes longer).
    for (const v of fellViews) {
      expect(v.timeMs, `${v.name} pins the world clock`).toBeTypeOf("number");
    }
  });

  for (const v of fellViews) {
    it(`${v.name}: the ${v.phase} fell is in frame and in sight`, () => {
      const f = v.stage.fell[0];
      const { points, skip } = fellSubject(f, -f.t, v.phase);
      const r = framed(xyz(v.eye), xyz(v.at), points, skip, v.fov);
      expect(r.inFrame, `${v.name} framed`).toBeGreaterThanOrEqual(MIN_FRAMED);
      expect(r.seen, `${v.name} seen`).toBeGreaterThanOrEqual(MIN_SEEN);
    });
  }

  for (const v of chewViews) {
    it(`${v.name}: the chewed facade is in frame and in sight`, () => {
      // The aim point, a metre and a half back toward the shooter (off
      // the wall it hits).
      const a = xyz(v.chew.at);
      const e = xyz(v.chew.eye);
      const l = Math.hypot(a.x - e.x, a.y - e.y, a.z - e.z);
      const p = {
        x: a.x + ((e.x - a.x) / l) * 1.5,
        y: a.y + ((e.y - a.y) / l) * 1.5,
        z: a.z + ((e.z - a.z) / l) * 1.5,
      };
      // The chewed building is the subject, not cover.
      const r = framed(xyz(v.eye), xyz(v.at), [p], [buildingAt(a)], v.fov);
      expect(r.inFrame, `${v.name} framed`).toBe(1);
      expect(r.seen, `${v.name} seen`).toBe(1);
    });
  }

  for (const v of propViews) {
    it(`${v.name}: the downed prop is in frame and in sight`, () => {
      const r = framed(xyz(v.eye), xyz(v.at), v.subject.map(xyz), [], v.fov);
      expect(r.inFrame).toBeGreaterThanOrEqual(MIN_FRAMED);
      expect(r.seen).toBeGreaterThanOrEqual(MIN_SEEN);
    });
  }

  for (const [name, c] of Object.entries(CASES)) {
    it(`time-lapse ${name}: the tower and its fall are in frame and in sight`, () => {
      const f = c.fell[0];
      const { points, skip } = fellSubject(f, 3000, "falling");
      const r = framed(xyz(c.eye), xyz(c.at), points, skip, c.fov);
      expect(r.inFrame).toBeGreaterThanOrEqual(MIN_FRAMED);
      expect(r.seen).toBeGreaterThanOrEqual(MIN_SEEN);
    });
  }

  for (const s of SEGMENTS.filter((s) => s.stage?.fell)) {
    it(`segment ${s.name}: its ${s.expect} fells are in frame and in sight`, () => {
      const eye = { x: s.x, y: s.y + 6, z: s.z };
      const at = {
        x: s.x - Math.sin(s.yaw) * 100,
        y: s.y + 6,
        z: s.z - Math.cos(s.yaw) * 100,
      };
      const points = [];
      const skip = [];
      for (const f of s.stage.fell) {
        const sub = fellSubject(f, -f.t, s.expect);
        points.push(...sub.points);
        skip.push(...sub.skip);
      }
      const r = framed(eye, at, points, skip);
      expect(r.inFrame).toBeGreaterThanOrEqual(MIN_FRAMED_SEGMENT);
      expect(r.seen).toBeGreaterThanOrEqual(MIN_SEEN_SEGMENT);
    });
  }

  for (const s of SEGMENTS.filter((s) => s.stageAtWindow?.fell)) {
    it(`segment ${s.name}: the fell ahead is in frame and in sight`, () => {
      const f = s.stageAtWindow.fell[0];
      // The chase camera sits just behind the held plane, level, nose on.
      const eye = { x: s.x, y: s.y + 6, z: s.z };
      const at = {
        x: s.x - Math.sin(s.yaw) * 100,
        y: s.y + 6,
        z: s.z - Math.cos(s.yaw) * 100,
      };
      // Its window opens 1.5 s into the fall and holds a few seconds.
      const { points, skip } = fellSubject(f, -f.t + 1500, "falling");
      const r = framed(eye, at, points, skip);
      expect(r.inFrame).toBeGreaterThanOrEqual(MIN_FRAMED_SEGMENT);
      expect(r.seen).toBeGreaterThanOrEqual(MIN_SEEN_SEGMENT);
    });
  }
});
