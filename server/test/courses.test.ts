// S3 stunt courses, server side (server/src/courses.ts): the anti-cheat
// timing. A CourseTracker fed a synthetic accepted-pose stream accepts a
// legal run with the right time, and refuses — each case the legal stream
// with exactly ONE defect — a run flown faster than any plane can, a
// teleport past most of the course, a path through a tower, a hole in the
// stream, a reject streak and a reset. A small skip is NOT cheating: it is
// accepted with its miss penalty. The solid sweep is wrap-safe. CourseBook
// keeps each pilot's best time. One legal run is also flown on a real
// seed-42 course, so the synthetic courses can't hide a real-world gap.

import { type Building, generateCity } from "@angels-bandits/common/city";
import { generateMovers } from "@angels-bandits/common/city/movers";
import { natureFor } from "@angels-bandits/common/city/nature";
import {
  buildCityIndex,
  buildNatureIndex,
} from "@angels-bandits/common/collision";
import { CITY_SEED, WORLD_SIZE } from "@angels-bandits/common/constants";
import {
  COURSE_BOARD_SIZE,
  COURSE_MAX_GROUND_SPEED,
  COURSE_MISS_PENALTY_MS,
  type Course,
  type Ring,
  decodeGhost,
  generateCourses,
} from "@angels-bandits/common/courses";
import type { GhostPath } from "@angels-bandits/common/protocol";
import { type Vec3, wrapCoord, wrapDelta } from "@angels-bandits/common/world";
import { describe, expect, it } from "vitest";
import {
  CourseBook,
  CourseTracker,
  type FinishedRun,
  type SweepWorld,
  sweptThroughSolid,
} from "../src/courses";

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
/** Accepted poses arrive at 20 Hz. */
const DT_MS = 50;

/** A straight course along +x at y 100, z 500: `count` rings every 100 m
 * from x0 (unwrapped; ring centres are canonicalised). */
const lineCourse = (x0: number, count = 12): Course => ({
  id: 0,
  theme: "canyon",
  name: "Line",
  rings: Array.from({ length: count }, (_, i) => ({
    pos: v(wrapCoord(x0 + i * 100), 100, 500),
    n: v(1, 0, 0),
    r: 10,
  })),
  length: (count - 1) * 100,
  span: (count - 1) * 100,
  medals: { gold: 10_000, silver: 15_000, bronze: 20_000 },
});

/** One solid box tower, centred at (x, z). */
const tower = (x: number, z: number, size = 30, height = 200): Building => ({
  x,
  z,
  width: size,
  depth: size,
  height,
  tiers: [{ width: size, depth: size, height }],
});

const OPEN: SweepWorld = { buildings: [] };

/** A pose stream: canonical positions at server arrival times. */
type Stream = { pos: Vec3; t: number; rejects?: number }[];

/** Fly the polyline `pts` (unwrapped) at `speed` m/s from `t0`, one pose
 * every DT_MS. The first sample is offset so no pose lands on a ring
 * plane. */
function along(pts: readonly Vec3[], speed: number, t0 = 1000): Stream {
  const out: Stream = [];
  const lens: number[] = [];
  let total = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i] as Vec3;
    const b = pts[i + 1] as Vec3;
    const l = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    lens.push(l);
    total += l;
  }
  const at = (dist: number): Vec3 => {
    let s = dist;
    let i = 0;
    while (i < lens.length - 1 && s > (lens[i] as number)) {
      s -= lens[i] as number;
      i++;
    }
    const a = pts[i] as Vec3;
    const b = pts[i + 1] as Vec3;
    const f = s / (lens[i] as number);
    return v(
      wrapCoord(a.x + (b.x - a.x) * f),
      a.y + (b.y - a.y) * f,
      wrapCoord(a.z + (b.z - a.z) * f),
    );
  };
  const step = (speed * DT_MS) / 1000;
  for (let k = 0, s = 0.37; s <= total; k++, s = 0.37 + k * step) {
    out.push({ pos: at(s), t: t0 + k * DT_MS });
  }
  return out;
}

/** Feed `stream` to `tracker`; the finished runs it produced. */
function feed(tracker: CourseTracker, stream: Stream): FinishedRun[] {
  const runs: FinishedRun[] = [];
  for (const p of stream) {
    const run = tracker.observe(p.pos, p.t, p.rejects ?? 0);
    if (run) runs.push(run);
  }
  return runs;
}

/** The straight line along a line course, 20 m before its start ring to
 * 20 m past its finish. */
const lineOf = (x0: number, count = 12): Vec3[] => [
  v(x0 - 20, 100, 500),
  v(x0 + (count - 1) * 100 + 20, 100, 500),
];

describe("CourseTracker — a legal run", () => {
  it("is accepted at 60 m/s with the flown time, no misses and a decodable ghost", () => {
    const course = lineCourse(200);
    const runs = feed(
      new CourseTracker([course], OPEN),
      along(lineOf(200), 60),
    );
    expect(runs).toHaveLength(1);
    const run = runs[0] as FinishedRun;
    expect(run.course).toBe(0);
    expect(run.missed).toBe(0);
    // 1100 m at 60 m/s.
    expect(Math.abs(run.timeMs - 1100 / 0.06)).toBeLessThanOrEqual(1);
    const ghost = decodeGhost(run.ghost);
    expect(ghost).not.toBeNull();
    expect(ghost?.durMs).toBe(run.timeMs);
  });

  it("is accepted just under the physical floor's speed (150 m/s < COURSE_MAX_GROUND_SPEED)", () => {
    expect(COURSE_MAX_GROUND_SPEED).toBeGreaterThan(150);
    const runs = feed(
      new CourseTracker([lineCourse(200)], OPEN),
      along(lineOf(200), 150),
    );
    expect(runs).toHaveLength(1);
  });

  it("is accepted across the x seam, timed the short way", () => {
    const x0 = WORLD_SIZE - 500; // rings 5–11 lie past the seam
    const runs = feed(
      new CourseTracker([lineCourse(x0)], OPEN),
      along(lineOf(x0), 60),
    );
    expect(runs).toHaveLength(1);
    expect(
      Math.abs((runs[0] as FinishedRun).timeMs - 1100 / 0.06),
    ).toBeLessThanOrEqual(1);
  });
});

describe("CourseTracker — refuses a run with one defect", () => {
  it("flown at 200 m/s, beyond any plane (the physical floor)", () => {
    expect(200).toBeGreaterThan(COURSE_MAX_GROUND_SPEED);
    const tracker = new CourseTracker([lineCourse(200)], OPEN);
    expect(feed(tracker, along(lineOf(200), 200))).toEqual([]);
    // The finish WAS crossed (the run ended): only the floor refused it.
    expect(tracker.running).toBe(false);
  });

  /** The legal 60 m/s stream with the poses between x `from` and `to`
   * removed: one teleport, the time of a single pose. */
  const teleport = (from: number, to: number): Stream => {
    const legal = along(lineOf(200), 60);
    const before = legal.filter((p) => p.pos.x < from);
    const after = legal
      .filter((p) => p.pos.x >= to)
      .map((p, i) => ({ ...p, t: (before.at(-1)?.t ?? 0) + (i + 1) * DT_MS }));
    return [...before, ...after];
  };

  it("teleporting past ≥ 75 % of the span (the >250 m jump passes no ring, the time falls under the floor)", () => {
    const tracker = new CourseTracker([lineCourse(200)], OPEN);
    // Rings at x 200…1300: jump from x 310 to x 1280 — 970 m of 1100.
    expect(feed(tracker, teleport(310, 1280))).toEqual([]);
    expect(tracker.running).toBe(false);
  });

  it("…while a SMALL skip is accepted on purpose, with its miss penalty", () => {
    // Jump x 310 → 580: rings at 400 and 500 skipped (270 m > 250 m).
    const runs = feed(
      new CourseTracker([lineCourse(200)], OPEN),
      teleport(310, 580),
    );
    expect(runs).toHaveLength(1);
    const run = runs[0] as FinishedRun;
    expect(run.missed).toBe(2);
    // Flown: 200 → ~310 and ~580 → 1300 at 60 m/s, plus one 50 ms jump.
    const flownMs = run.timeMs - 2 * COURSE_MISS_PENALTY_MS;
    expect(flownMs).toBeGreaterThan((830 / 60) * 1000 - 100);
    expect(flownMs).toBeLessThan((830 / 60) * 1000 + 100);
  });

  it("flying through a tower between two rings (the solid sweep)", () => {
    const blocked: SweepWorld = { buildings: [tower(650, 500)] };
    const tracker = new CourseTracker([lineCourse(200)], blocked);
    expect(feed(tracker, along(lineOf(200), 60))).toEqual([]);
    expect(tracker.running).toBe(false);
    // Control: the same tower beside the line costs nothing.
    const beside: SweepWorld = { buildings: [tower(650, 560)] };
    expect(
      feed(
        new CourseTracker([lineCourse(200)], beside),
        along(lineOf(200), 60),
      ),
    ).toHaveLength(1);
  });
});

describe("CourseTracker — holes in the accepted stream", () => {
  /** The legal stream with the pose times after index `at` shifted by
   * `extra` ms (a gap), and `rejects` reported on that pose. */
  const withGap = (extra: number, rejects = 0): Stream => {
    const legal = along(lineOf(200), 60);
    const at = 100; // mid-run, between rings
    return legal.map((p, i) => ({
      ...p,
      t: i > at ? p.t + extra : p.t,
      rejects: i === at + 1 ? rejects : 0,
    }));
  };
  const runsOf = (stream: Stream) =>
    feed(new CourseTracker([lineCourse(200)], OPEN), stream);

  it("a gap of exactly 1000 ms survives; 1001 ms drops the run", () => {
    expect(runsOf(withGap(1000 - DT_MS))).toHaveLength(1);
    expect(runsOf(withGap(1001 - DT_MS))).toEqual([]);
  });

  it("2 rejected poses in a row survive; 3 drop the run", () => {
    expect(runsOf(withGap(0, 2))).toHaveLength(1);
    expect(runsOf(withGap(0, 3))).toEqual([]);
  });

  it("a rejected pose is tolerated over at most 500 ms", () => {
    expect(runsOf(withGap(500 - DT_MS, 1))).toHaveLength(1);
    expect(runsOf(withGap(501 - DT_MS, 1))).toEqual([]);
  });

  it("reset() mid-run (death, respawn, resync) drops it", () => {
    const tracker = new CourseTracker([lineCourse(200)], OPEN);
    const stream = along(lineOf(200), 60);
    feed(tracker, stream.slice(0, 100));
    expect(tracker.running).toBe(true);
    tracker.reset();
    expect(tracker.running).toBe(false);
    expect(feed(tracker, stream.slice(100))).toEqual([]);
  });
});

describe("sweptThroughSolid", () => {
  const flat = (pts: Vec3[]) => pts.flatMap((p) => [p.x, p.y, p.z]);
  const city: SweepWorld = { buildings: [tower(500, 500)] };

  it("clear air passes; a move through a tower fails", () => {
    expect(
      sweptThroughSolid(flat([v(400, 100, 600), v(600, 100, 600)]), city),
    ).toBe(false);
    expect(
      sweptThroughSolid(flat([v(400, 100, 500), v(600, 100, 500)]), city),
    ).toBe(true);
    // Over its roof is clear.
    expect(
      sweptThroughSolid(flat([v(400, 210, 500), v(600, 210, 500)]), city),
    ).toBe(false);
  });

  it("a move into the ground fails", () => {
    expect(
      sweptThroughSolid(flat([v(100, 50, 100), v(100, -20, 140)]), OPEN),
    ).toBe(true);
  });

  it("is wrap-safe: a short clear move across the seam is not a 2 km leg through the city", () => {
    const near: SweepWorld = { buildings: [tower(1000, 300)] };
    const across = flat([v(WORLD_SIZE - 10, 100, 300), v(10, 100, 300)]);
    expect(sweptThroughSolid(across, near)).toBe(false);
    // …and a tower straddling the seam is still found.
    const seam: SweepWorld = { buildings: [tower(0, 300)] };
    expect(sweptThroughSolid(across, seam)).toBe(true);
  });
});

describe("a legal run on a real seed-42 course", () => {
  it("the ring-centre path at 60 m/s is accepted and timed as span / 60", () => {
    const buildings = generateCity(CITY_SEED);
    const index = buildCityIndex(buildings);
    const courses = generateCourses(CITY_SEED, {
      buildings,
      index,
      nature: buildNatureIndex(natureFor(CITY_SEED, buildings)),
      movers: generateMovers(CITY_SEED, buildings),
    });
    const world: SweepWorld = { buildings, index };
    /** The unwrapped chord path: 5 m before the start along its normal,
     * every ring centre, 5 m past the finish. */
    const chord = (c: Course): Vec3[] => {
      const rings = c.rings as Ring[];
      const first = rings[0] as Ring;
      const pts = [
        v(
          first.pos.x - first.n.x * 5,
          first.pos.y - first.n.y * 5,
          first.pos.z - first.n.z * 5,
        ),
        { ...first.pos },
      ];
      for (let i = 1; i < rings.length; i++) {
        const prev = pts.at(-1) as Vec3;
        const d = wrapDelta(prev, (rings[i] as Ring).pos);
        pts.push(v(prev.x + d.x, prev.y + d.y, prev.z + d.z));
      }
      const last = rings.at(-1) as Ring;
      const end = pts.at(-1) as Vec3;
      pts.push(
        v(end.x + last.n.x * 5, end.y + last.n.y * 5, end.z + last.n.z * 5),
      );
      return pts;
    };
    // Precondition: some course's straight ring-to-ring path is itself
    // clear of solids (generation only guarantees the filleted path).
    const clear = courses.filter(
      (c) =>
        !sweptThroughSolid(
          chord(c).flatMap((p) => [p.x, p.y, p.z]),
          world,
        ),
    );
    expect(clear.length).toBeGreaterThan(0);
    const course = clear[0] as Course;
    const runs = feed(
      new CourseTracker(courses, world),
      along(chord(course), 60),
    );
    expect(runs).toHaveLength(1);
    const run = runs[0] as FinishedRun;
    expect(run.course).toBe(course.id);
    expect(run.missed).toBe(0);
    expect(
      Math.abs(run.timeMs - (course.span / 60) * 1000),
    ).toBeLessThanOrEqual(1);
  });
});

describe("CourseBook — the leaderboards", () => {
  const course = lineCourse(200);
  const ghost = (tag: number): GhostPath => ({ hz: 10, durMs: tag, d: [] });
  const run = (timeMs: number, tag = timeMs): FinishedRun => ({
    course: 0,
    timeMs,
    missed: 0,
    ghost: ghost(tag),
  });

  it("keeps each pilot's best time (by name, case-insensitive); a slower run changes nothing", () => {
    const book = new CourseBook([course]);
    expect(book.submit("Ace", run(14_000))).toEqual({
      medal: "silver",
      rank: 1,
      record: true,
      changed: true,
    });
    expect(book.submit("ACE", run(16_000))).toEqual({
      medal: "bronze",
      rank: null,
      record: false,
      changed: false,
    });
    expect(book.submit("ace", run(9_000)).record).toBe(true);
    const board = book.standing(0).board;
    expect(board).toHaveLength(1);
    expect(board[0]).toMatchObject({
      name: "ace",
      timeMs: 9_000,
      medal: "gold",
    });
  });

  it("ties keep whoever set the time first; the board holds COURSE_BOARD_SIZE rows", () => {
    const book = new CourseBook([course]);
    book.submit("First", run(12_000));
    const tie = book.submit("Second", run(12_000));
    expect(tie.rank).toBe(2);
    expect(tie.record).toBe(false);
    for (let i = 0; i < COURSE_BOARD_SIZE + 2; i++) {
      book.submit(`P${i}`, run(13_000 + i));
    }
    const board = book.standing(0).board;
    expect(board).toHaveLength(COURSE_BOARD_SIZE);
    expect(board.map((e) => e.name).slice(0, 2)).toEqual(["First", "Second"]);
    expect(book.submit("Slow", run(99_000))).toMatchObject({
      rank: null,
      changed: false,
      medal: null,
    });
  });

  it("the record ghost follows rank 1 only", () => {
    const book = new CourseBook([course]);
    book.submit("A", run(12_000, 1));
    expect(book.ghostOf(0)?.durMs).toBe(1);
    book.submit("B", run(13_000, 2));
    expect(book.ghostOf(0)?.durMs).toBe(1);
    book.submit("B", run(11_000, 3));
    expect(book.ghostOf(0)?.durMs).toBe(3);
    expect(book.standing(0).ghost?.durMs).toBe(3);
  });

  it("an unknown course id is ignored", () => {
    const book = new CourseBook([course]);
    expect(book.submit("A", { ...run(1), course: 7 })).toEqual({
      medal: null,
      rank: null,
      record: false,
      changed: false,
    });
    expect(book.standings()).toHaveLength(1);
  });
});
