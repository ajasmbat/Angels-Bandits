// S3 stunt ring courses (common/src/courses.ts), the shared half: generation
// on the real seed-42 world is deterministic and every ring is flyable (a
// probe sphere on its disc, and the real stepFlight straight through it);
// the swept, wrap-safe ring-pass test; the run state machine's rules
// (order, skips, restart, idle/max aborts); the ghost codec round-trip; and
// the medal cut-offs. The server's anti-cheat half is server/test/courses.

import { generateCity } from "@angels-bandits/common/city";
import { generateMovers } from "@angels-bandits/common/city/movers";
import { natureFor } from "@angels-bandits/common/city/nature";
import {
  buildCityIndex,
  buildNatureIndex,
  collideCity,
  collideNature,
  hitsGround,
} from "@angels-bandits/common/collision";
import {
  CITY_SEED,
  PLAYER_RADIUS,
  WORLD_SIZE,
} from "@angels-bandits/common/constants";
import {
  COURSES_MAX,
  COURSES_MIN,
  COURSE_IDLE_MS,
  COURSE_MAX_MS,
  COURSE_MISS_PENALTY_MS,
  COURSE_PROBE_RADIUS,
  type Course,
  CourseRunner,
  type CourseWorld,
  GHOST_HZ,
  GHOST_MAX_SAMPLES,
  GhostRecorder,
  type Ring,
  decodeGhost,
  generateCourses,
  ghostPositionAt,
  medalFor,
  ringCrossing,
} from "@angels-bandits/common/courses";
import { createFlightState, stepFlight } from "@angels-bandits/common/flight";
import { POS_SCALE } from "@angels-bandits/common/net";
import {
  type Vec3,
  wrapDelta,
  wrapDistance,
} from "@angels-bandits/common/world";
import { describe, expect, it } from "vitest";

// The real world, built once — the same inputs server/src/index.ts uses.
const buildings = generateCity(CITY_SEED);
const index = buildCityIndex(buildings);
const nature = buildNatureIndex(natureFor(CITY_SEED, buildings));
const movers = generateMovers(CITY_SEED, buildings);
const world: CourseWorld = { buildings, index, nature, movers };
const courses = generateCourses(CITY_SEED, world);

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

/** A hand-built ring facing +x (unless `n` says otherwise). */
const ring = (pos: Vec3, r = 10, n: Vec3 = v(1, 0, 0)): Ring => ({
  pos,
  n,
  r,
});

/** A hand-built course: rings along +x at y 100, z `z`, from x `x0` every
 * `gap` m. Medals and lengths are only read by medalFor here. */
const lineCourse = (id: number, x0: number, z: number, count = 4, gap = 100) =>
  ({
    id,
    theme: "canyon",
    name: `Line ${id}`,
    rings: Array.from({ length: count }, (_, i) =>
      ring(v(x0 + i * gap, 100, z)),
    ),
    length: (count - 1) * gap,
    span: (count - 1) * gap,
    medals: { gold: 10_000, silver: 20_000, bronze: 30_000 },
  }) satisfies Course;

describe("generateCourses on the seed-42 world", () => {
  it("is deterministic: the same seed and world give the same courses", () => {
    expect(generateCourses(CITY_SEED, world)).toEqual(courses);
  });

  it("offers COURSES_MIN–COURSES_MAX courses, ids in order, canonical rings with unit normals", () => {
    expect(courses.length).toBeGreaterThanOrEqual(COURSES_MIN);
    expect(courses.length).toBeLessThanOrEqual(COURSES_MAX);
    courses.forEach((c, i) => {
      expect(c.id).toBe(i);
      expect(c.rings.length).toBeGreaterThanOrEqual(3);
      for (const r of c.rings) {
        expect(r.pos.x).toBeGreaterThanOrEqual(0);
        expect(r.pos.x).toBeLessThan(WORLD_SIZE);
        expect(r.pos.z).toBeGreaterThanOrEqual(0);
        expect(r.pos.z).toBeLessThan(WORLD_SIZE);
        expect(Math.hypot(r.n.x, r.n.y, r.n.z)).toBeCloseTo(1, 9);
        expect(r.r).toBeGreaterThan(PLAYER_RADIUS);
      }
      // span is the wrap-safe ring-to-ring distance, so never a 2 km leg.
      let span = 0;
      for (let k = 0; k + 1 < c.rings.length; k++) {
        const d = wrapDistance(
          (c.rings[k] as Ring).pos,
          (c.rings[k + 1] as Ring).pos,
        );
        expect(d).toBeLessThan(WORLD_SIZE / 2);
        span += d;
      }
      expect(c.span).toBeCloseTo(span, 6);
      expect(c.medals.gold).toBeLessThan(c.medals.silver);
      expect(c.medals.silver).toBeLessThan(c.medals.bronze);
    });
  });

  it("every ring's disc clears a probe sphere against ground, buildings and trees", () => {
    for (const c of courses) {
      for (const [k, r] of c.rings.entries()) {
        const where = `${c.name} ring ${k}`;
        expect(hitsGround(r.pos, COURSE_PROBE_RADIUS), where).toBe(false);
        expect(
          collideCity(r.pos, COURSE_PROBE_RADIUS, buildings, index),
          where,
        ).toBeNull();
        expect(
          collideNature(r.pos, COURSE_PROBE_RADIUS, nature),
          where,
        ).toBeNull();
      }
    }
  });

  it("the real stepFlight flies straight through every ring along its normal at 60 m/s, never inside a solid, and the pass registers", () => {
    const DT = 1 / 60;
    for (const c of courses) {
      for (const [k, r] of c.rings.entries()) {
        const where = `${c.name} ring ${k}`;
        // Inside the ring's own cleared sphere (radius r) the plane's sphere
        // fits anywhere within r − PLAYER_RADIUS of the centre.
        const back = r.r - PLAYER_RADIUS - 0.5;
        const start = v(
          r.pos.x - r.n.x * back,
          r.pos.y - r.n.y * back,
          r.pos.z - r.n.z * back,
        );
        // forward(yaw, pitch) = (−sin yaw·cos p, sin p, −cos yaw·cos p).
        let f = {
          ...createFlightState(start, Math.atan2(-r.n.x, -r.n.z)),
          pitch: Math.asin(r.n.y),
          speed: 60,
          targetSpeed: 60,
        };
        let passed = false;
        const steps = Math.ceil(((2 * back) / 60) * 60);
        for (let i = 0; i < steps; i++) {
          const prev = f.pos;
          f = stepFlight(f, { turn: 0, pitch: 0, roll: 0, throttle: 0 }, DT);
          expect(hitsGround(f.pos, PLAYER_RADIUS), where).toBe(false);
          expect(
            collideCity(f.pos, PLAYER_RADIUS, buildings, index),
            where,
          ).toBeNull();
          expect(collideNature(f.pos, PLAYER_RADIUS, nature), where).toBeNull();
          if (ringCrossing(r, prev, f.pos) >= 0) passed = true;
        }
        expect(passed, where).toBe(true);
      }
    }
  });
});

describe("ringCrossing — swept, forward-only, wrap-safe", () => {
  const r = ring(v(500, 100, 500), 10);

  it("a forward move through the disc passes at the right fraction; backward never counts", () => {
    expect(ringCrossing(r, v(490, 100, 500), v(510, 100, 500))).toBeCloseTo(
      0.5,
      9,
    );
    expect(ringCrossing(r, v(495, 100, 500), v(515, 100, 500))).toBeCloseTo(
      0.25,
      9,
    );
    expect(ringCrossing(r, v(510, 100, 500), v(490, 100, 500))).toBe(-1);
    // Never reaching, or already past, the plane.
    expect(ringCrossing(r, v(480, 100, 500), v(499, 100, 500))).toBe(-1);
    expect(ringCrossing(r, v(501, 100, 500), v(520, 100, 500))).toBe(-1);
  });

  it("outside the radius misses; slack widens it", () => {
    const from = v(490, 100, 511);
    const to = v(510, 100, 511);
    expect(ringCrossing(r, from, to)).toBe(-1);
    expect(ringCrossing(r, from, to, 2)).toBeCloseTo(0.5, 9);
    expect(ringCrossing(r, v(490, 109.9, 500), v(510, 109.9, 500))).toBe(0.5);
  });

  it("works across the x and z seams, for any torus image of the ring", () => {
    const seamX = ring(v(0.5, 100, 700), 10);
    expect(
      ringCrossing(seamX, v(WORLD_SIZE - 5, 100, 700), v(5, 100, 700)),
    ).toBeCloseTo(0.55, 9);
    const seamZ = ring(v(300, 100, WORLD_SIZE - 1), 10, v(0, 0, 1));
    expect(
      ringCrossing(seamZ, v(300, 100, WORLD_SIZE - 6), v(300, 100, 4)),
    ).toBeCloseTo(0.5, 9);
    // The same move expressed with an unwrapped endpoint is the same move.
    expect(
      ringCrossing(
        seamX,
        v(WORLD_SIZE - 5, 100, 700),
        v(WORLD_SIZE + 5, 100, 700),
      ),
    ).toBeCloseTo(0.55, 9);
  });

  it("a segment longer than 250 m (a teleport) never passes a ring", () => {
    expect(ringCrossing(r, v(370, 100, 500), v(630, 100, 500))).toBe(-1);
    expect(ringCrossing(r, v(380, 100, 500), v(620, 100, 500))).toBeCloseTo(
      0.5,
      9,
    );
  });
});

describe("CourseRunner — the run state machine", () => {
  const a = lineCourse(0, 100, 500);
  // Course 1's start ring sits ON course 0's line, between its rings 1 and 2.
  const b = lineCourse(1, 250, 500);

  /** Fly along +x at y 100, z 500 from x0 to x1, one step per `stepM` m at
   * 50 m/s, starting at `t0` ms; returns every non-"none" step. */
  const fly = (
    runner: CourseRunner,
    x0: number,
    x1: number,
    t0: number,
    stepM = 5,
  ): { step: string; t: number }[] => {
    const out: { step: string; t: number }[] = [];
    const dtMs = (stepM / 50) * 1000;
    let t = t0;
    for (let x = x0; x < x1; x += stepM) {
      const s = runner.step(
        v(x, 100, 500),
        v(x + stepM, 100, 500),
        t,
        t + dtMs,
      );
      if (s !== "none") out.push({ step: s, t: t + dtMs });
      t += dtMs;
    }
    return out;
  };

  it("start, every ring in order, finish: time is flown time, no penalty", () => {
    const runner = new CourseRunner([a, b]);
    // Rings at x 100/200/300/400; samples every 5 m from x 52 (off-plane).
    const steps = fly(runner, 52, 452, 0);
    expect(steps.map((s) => s.step)).toEqual([
      "start",
      "ring",
      "ring",
      "finish",
    ]);
    expect(runner.active).toBe(false);
    expect(runner.subject).toBe(0);
    expect(runner.missed).toBe(0);
    // 300 m at 50 m/s.
    expect(runner.elapsedMs).toBeCloseTo(6000, 6);
    expect(runner.timeMs).toBeCloseTo(6000, 6);
  });

  it("another course's start ring is ignored mid-run", () => {
    const runner = new CourseRunner([a, b]);
    fly(runner, 52, 452, 0);
    // Course 1's start (x 250) was crossed mid-run: still course 0's finish.
    expect(runner.subject).toBe(0);
  });

  it("skipping rings costs COURSE_MISS_PENALTY_MS each", () => {
    const runner = new CourseRunner([a]);
    fly(runner, 52, 152, 0); // start
    // Jump round rings 1 and 2 (a sideways detour), then through the finish.
    expect(runner.step(v(152, 100, 500), v(152, 100, 560), 1000, 1500)).toBe(
      "none",
    );
    expect(runner.step(v(152, 100, 560), v(390, 100, 560), 1500, 2000)).toBe(
      "none",
    );
    expect(runner.step(v(390, 100, 560), v(390, 100, 500), 2000, 2500)).toBe(
      "none",
    );
    expect(runner.step(v(390, 100, 500), v(410, 100, 500), 2500, 2900)).toBe(
      "finish",
    );
    expect(runner.missed).toBe(2);
    expect(runner.timeMs).toBeCloseTo(
      runner.elapsedMs + 2 * COURSE_MISS_PENALTY_MS,
      6,
    );
  });

  it("flying back through the active course's start ring restarts the clock", () => {
    const runner = new CourseRunner([a]);
    fly(runner, 52, 252, 0); // start and ring 1
    expect(runner.next).toBe(2);
    // Loop round and re-enter the start ring at t = 20 s.
    expect(runner.step(v(95, 100, 500), v(105, 100, 500), 20_000, 20_200)).toBe(
      "start",
    );
    expect(runner.next).toBe(1);
    expect(runner.startMs).toBeCloseTo(20_100, 6);
  });

  it("idle: exactly COURSE_IDLE_MS since the last ring survives, a millisecond more aborts", () => {
    const runner = new CourseRunner([a]);
    runner.step(v(95, 100, 500), v(105, 100, 500), 0, 200); // start at 100
    const last = runner.lastMs;
    expect(
      runner.step(
        v(110, 100, 520),
        v(112, 100, 520),
        1000,
        last + COURSE_IDLE_MS,
      ),
    ).toBe("none");
    expect(runner.active).toBe(true);
    expect(
      runner.step(
        v(112, 100, 520),
        v(114, 100, 520),
        last + COURSE_IDLE_MS,
        last + COURSE_IDLE_MS + 1,
      ),
    ).toBe("abort");
    expect(runner.active).toBe(false);
    expect(runner.subject).toBe(0);
  });

  it("a run older than COURSE_MAX_MS aborts even while rings keep coming", () => {
    // Rings every 100 m, a ring every 20 s: never idle, but too long.
    const long = lineCourse(0, 100, 500, 12);
    const runner = new CourseRunner([long]);
    let aborted = false;
    for (let k = 0; k < 11 && !aborted; k++) {
      const x = 100 + k * 100;
      const t = k * 20_000;
      aborted =
        runner.step(v(x - 5, 100, 500), v(x + 5, 100, 500), t, t + 200) ===
        "abort";
    }
    expect(aborted).toBe(true);
    expect(runner.lastMs).toBeLessThanOrEqual(COURSE_MAX_MS);
  });

  it("abort() drops a run and reports whether there was one", () => {
    const runner = new CourseRunner([a]);
    expect(runner.abort()).toBe(false);
    runner.step(v(95, 100, 500), v(105, 100, 500), 0, 200);
    expect(runner.abort()).toBe(true);
    expect(runner.active).toBe(false);
  });
});

describe("ghosts — record, encode, decode, replay", () => {
  /** Record a straight 60 m/s run along +x from `x0`, poses every 50 ms. */
  const record = (x0: number, ms: number) => {
    const rec = new GhostRecorder();
    const at = (t: number) => v(x0 + 0.06 * t, 120 + 0.01 * t, 800);
    rec.start(at(0), 0);
    for (let t = 50; t < ms; t += 50) rec.add(at(t), t);
    return { path: rec.finish(at(ms), ms), at };
  };

  it("round-trips a run to within the POS_SCALE quantisation, sampled at GHOST_HZ", () => {
    const { path, at } = record(300, 3030);
    expect(path.hz).toBe(GHOST_HZ);
    expect(path.durMs).toBe(3030);
    const track = decodeGhost(path);
    expect(track).not.toBeNull();
    if (!track) return;
    // 0, 100, …, 3000 on the grid, plus the off-grid finish.
    expect(track.count).toBe(32);
    const out = v(0, 0, 0);
    for (const ms of [0, 50, 100, 1234, 2999, 3030]) {
      ghostPositionAt(track, ms, out);
      const want = at(ms);
      expect(Math.abs(out.x - want.x)).toBeLessThanOrEqual(1 / POS_SCALE);
      expect(Math.abs(out.y - want.y)).toBeLessThanOrEqual(1 / POS_SCALE);
      expect(Math.abs(out.z - want.z)).toBeLessThanOrEqual(1 / POS_SCALE);
    }
  });

  it("a run across the seam replays the short way, canonical throughout", () => {
    const { path, at } = record(WORLD_SIZE - 60, 2000); // ends 60 m past it
    const track = decodeGhost(path);
    if (!track) throw new Error("ghost did not decode");
    const out = v(0, 0, 0);
    for (let ms = 0; ms <= 2000; ms += 25) {
      ghostPositionAt(track, ms, out);
      expect(out.x).toBeGreaterThanOrEqual(0);
      expect(out.x).toBeLessThan(WORLD_SIZE);
      const d = wrapDelta(at(ms), out);
      expect(Math.hypot(d.x, d.y, d.z)).toBeLessThanOrEqual(0.2);
    }
  });

  it("clamps before the start and after the end", () => {
    const { path, at } = record(300, 1000);
    const track = decodeGhost(path);
    if (!track) throw new Error("ghost did not decode");
    const out = v(0, 0, 0);
    ghostPositionAt(track, -500, out);
    expect(out.x).toBeCloseTo(at(0).x, 1);
    ghostPositionAt(track, 99_999, out);
    expect(out.x).toBeCloseTo(at(1000).x, 1);
  });

  it("decodeGhost rejects malformed paths", () => {
    const { path } = record(300, 1000);
    expect(decodeGhost({ ...path, hz: GHOST_HZ + 1 })).toBeNull();
    expect(decodeGhost({ ...path, durMs: 0 })).toBeNull();
    expect(decodeGhost({ ...path, d: path.d.slice(0, 3) })).toBeNull();
    expect(decodeGhost({ ...path, d: path.d.slice(0, 7) })).toBeNull();
    expect(
      decodeGhost({ ...path, d: [...path.d.slice(0, 5), 0.5] }),
    ).toBeNull();
    const tooLong = new Array((GHOST_MAX_SAMPLES + 1) * 3).fill(0);
    expect(decodeGhost({ ...path, d: tooLong })).toBeNull();
    expect(
      decodeGhost({ ...path, d: new Array(GHOST_MAX_SAMPLES * 3).fill(0) }),
    ).not.toBeNull();
  });

  it("never records more than GHOST_MAX_SAMPLES, however long the run", () => {
    const { path } = record(300, COURSE_MAX_MS + 10_000);
    expect(path.d.length / 3).toBeLessThanOrEqual(GHOST_MAX_SAMPLES);
    expect(decodeGhost(path)).not.toBeNull();
  });
});

describe("medalFor", () => {
  it("each cut-off is inclusive; slower than bronze earns nothing", () => {
    const c = lineCourse(0, 100, 500);
    expect(medalFor(c, 9_000)).toBe("gold");
    expect(medalFor(c, 10_000)).toBe("gold");
    expect(medalFor(c, 10_001)).toBe("silver");
    expect(medalFor(c, 20_000)).toBe("silver");
    expect(medalFor(c, 30_000)).toBe("bronze");
    expect(medalFor(c, 30_001)).toBeNull();
  });
});
