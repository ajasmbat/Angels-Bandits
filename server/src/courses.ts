// S3 stunt courses, server side: the OFFICIAL timing of every human's runs
// and the process-wide leaderboards.
//
// The server never trusts a client's time. Each human has a CourseTracker
// fed ONLY from the poses validatePose accepted (handlePose), on the server's
// own ARRIVAL clock, so a client stamp can never shave time off a run; the
// shared CourseRunner (common/src/courses.ts) finds the ring passes on that
// stream with a little extra radius (the client's provisional HUD uses the
// exact one). A run survives a couple of isolated rejected poses — the next
// accepted move is still swept for rings — but a longer reject streak, a
// resync teleport, a gap in the stream, death, respawn, going away or
// leaving drops it outright (never a penalty: it just isn't a run).
//
// At the finish two checks stand between a run and the board:
//   - the physical floor: no plane covers the ring-to-ring distance faster
//     than the validator's own speed bound allows;
//   - the solid sweep: every accepted move of the run, every few metres,
//     through the ground and the buildings — a noclip shortcut through a
//     tower leaves a trail inside it. Two consecutive hits refuse the run;
//     one is a close pass, interpolated.
// The ghost is recorded from the same accepted stream.
//
// Boards and ghosts live in this process's memory only — a redeploy resets
// them (by design for now; no database).

import type { Building } from "@angels-bandits/common/city";
import {
  type CityIndex,
  collideCity,
  hitsGround,
} from "@angels-bandits/common/collision";
import { PLAYER_RADIUS } from "@angels-bandits/common/constants";
import {
  COURSE_BOARD_SIZE,
  COURSE_MAX_GROUND_SPEED,
  type Course,
  CourseRunner,
  GhostRecorder,
  medalFor,
} from "@angels-bandits/common/courses";
import type {
  CourseBoardEntry,
  CourseStanding,
  GhostPath,
  Medal,
} from "@angels-bandits/common/protocol";
import {
  type Vec3,
  wrapCoord,
  wrapDeltaAxis,
} from "@angels-bandits/common/world";

/** The server's extra pass radius, m: generous, so a pass the client saw
 * (exact radius) is never one the server misses. */
export const SERVER_RING_SLACK = 2;
/** A run keeps going over at most this many rejected poses in a row… */
const MAX_REJECTS_IN_RUN = 2;
/** …and over no gap between accepted poses longer than this, ms. */
const MAX_GAP_MS = 1000;
/** Rejected poses inside a run are only tolerated within this window, ms. */
const REJECT_GAP_MS = 500;
/** The solid sweep: step along each move, m, and the probe radius, m. */
const SWEEP_STEP = 3;
const SWEEP_RADIUS = PLAYER_RADIUS - 1;

/** A finished run, as the server timed it. */
export interface FinishedRun {
  course: number;
  timeMs: number;
  missed: number;
  ghost: GhostPath;
}

/** What the solid sweep collides with. */
export interface SweepWorld {
  buildings: readonly Building[];
  index?: CityIndex;
  /** D9: the room's fallen bridge spans (river.ts gaps), read at the sweep. */
  gaps?: () => number;
}

const scratch: Vec3 = { x: 0, y: 0, z: 0 };

/**
 * Did the run fly through something solid? `path` is the run's accepted
 * positions, xyz-interleaved. Each move is stepped every SWEEP_STEP; two
 * consecutive probes inside the ground or a building fail it.
 */
export function sweptThroughSolid(
  path: readonly number[],
  world: SweepWorld,
): boolean {
  let streak = 0;
  const gaps = world.gaps?.() ?? 0;
  const probeAt = (x: number, y: number, z: number): boolean => {
    scratch.x = wrapCoord(x);
    scratch.y = y;
    scratch.z = wrapCoord(z);
    const hit =
      hitsGround(scratch, SWEEP_RADIUS, gaps) ||
      collideCity(scratch, SWEEP_RADIUS, world.buildings, world.index) !== null;
    streak = hit ? streak + 1 : 0;
    return streak >= 2;
  };
  for (let i = 0; i + 5 < path.length; i += 3) {
    const ax = path[i] as number;
    const ay = path[i + 1] as number;
    const az = path[i + 2] as number;
    const dx = wrapDeltaAxis(ax, path[i + 3] as number);
    const dy = (path[i + 4] as number) - ay;
    const dz = wrapDeltaAxis(az, path[i + 5] as number);
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy, dz) / SWEEP_STEP));
    for (let k = i === 0 ? 0 : 1; k <= steps; k++) {
      const f = k / steps;
      if (probeAt(ax + dx * f, ay + dy * f, az + dz * f)) return true;
    }
  }
  return false;
}

/**
 * One human's official run timing, fed from accepted poses. `observe` takes
 * every accepted pose with its server arrival time and the number of poses
 * rejected since the previous accepted one; `reset` drops any run and the
 * stream position (death, respawn, away, resync).
 */
export class CourseTracker {
  private readonly runner: CourseRunner;
  private readonly recorder = new GhostRecorder();
  /** The run's accepted positions, xyz-interleaved, for the solid sweep. */
  private path: number[] = [];
  private prev: Vec3 | null = null;
  private prevT = 0;

  constructor(
    private readonly courses: readonly Course[],
    private readonly world: SweepWorld,
  ) {
    this.runner = new CourseRunner(courses, SERVER_RING_SLACK);
  }

  /** Is a run in progress? */
  get running(): boolean {
    return this.runner.active;
  }

  reset(): void {
    this.runner.abort();
    this.prev = null;
  }

  observe(pos: Vec3, t: number, rejectsBefore = 0): FinishedRun | null {
    const prev = this.prev;
    const prevT = this.prevT;
    this.prev = { x: pos.x, y: pos.y, z: pos.z };
    this.prevT = t;
    if (!prev) return null;
    const gap = t - prevT;
    if (
      gap > MAX_GAP_MS ||
      rejectsBefore > MAX_REJECTS_IN_RUN ||
      (rejectsBefore > 0 && gap > REJECT_GAP_MS)
    ) {
      // A hole in the accepted stream: whatever happened in it is unknown.
      this.runner.abort();
      return null;
    }
    const step = this.runner.step(prev, pos, prevT, t);
    const runner = this.runner;
    if (step === "start") {
      const cross = lerp(prev, pos, runner.frac);
      this.recorder.start(cross, runner.atMs);
      this.recorder.add(pos, t);
      this.path = [cross.x, cross.y, cross.z, pos.x, pos.y, pos.z];
      return null;
    }
    if (step === "abort" || (step === "none" && !runner.active)) return null;
    if (step !== "finish") {
      this.recorder.add(pos, t);
      this.path.push(pos.x, pos.y, pos.z);
      return null;
    }
    const cross = lerp(prev, pos, runner.frac);
    this.path.push(cross.x, cross.y, cross.z);
    const ghost = this.recorder.finish(cross, runner.atMs);
    const course = this.courses[runner.subject] as Course;
    const floorMs = (course.span / COURSE_MAX_GROUND_SPEED) * 1000;
    if (runner.elapsedMs < floorMs) return null;
    if (sweptThroughSolid(this.path, this.world)) return null;
    return {
      course: course.id,
      timeMs: Math.round(runner.timeMs),
      missed: runner.missed,
      ghost,
    };
  }
}

/** Wrap-safe point `f` of the way from a to b. */
const lerp = (a: Vec3, b: Vec3, f: number): Vec3 => ({
  x: wrapCoord(a.x + wrapDeltaAxis(a.x, b.x) * f),
  y: a.y + (b.y - a.y) * f,
  z: wrapCoord(a.z + wrapDeltaAxis(a.z, b.z) * f),
});

/** What a submitted run did to its course's board. */
export interface BoardOutcome {
  medal: Medal | null;
  /** 1-based board position, or null when the time did not make it. */
  rank: number | null;
  /** The course record fell (rank 1 with a new time). */
  record: boolean;
  /** The board's rows changed (broadcast it). */
  changed: boolean;
}

/**
 * Every course's top COURSE_BOARD_SIZE and record ghost, for one city seed.
 * One row per pilot NAME (case-insensitive): a rejoin is a new player id but
 * the same pilot. A tie never displaces whoever set the time first.
 */
export class CourseBook {
  private readonly boards: CourseBoardEntry[][];
  private readonly ghosts: (GhostPath | null)[];

  constructor(readonly courses: readonly Course[]) {
    this.boards = courses.map(() => []);
    this.ghosts = courses.map(() => null);
  }

  standings(): CourseStanding[] {
    return this.courses.map((c) => this.standing(c.id));
  }

  standing(course: number): CourseStanding {
    return {
      course,
      board: [...(this.boards[course] ?? [])],
      ghost: this.ghosts[course] ?? null,
    };
  }

  ghostOf(course: number): GhostPath | null {
    return this.ghosts[course] ?? null;
  }

  submit(name: string, run: FinishedRun): BoardOutcome {
    const course = this.courses[run.course];
    const board = this.boards[run.course];
    if (!course || !board) {
      return { medal: null, rank: null, record: false, changed: false };
    }
    const medal = medalFor(course, run.timeMs);
    const key = name.toLowerCase();
    const mine = board.findIndex((e) => e.name.toLowerCase() === key);
    const own = mine >= 0 ? (board[mine] as CourseBoardEntry) : null;
    if (own && own.timeMs <= run.timeMs) {
      return { medal, rank: null, record: false, changed: false };
    }
    if (mine >= 0) board.splice(mine, 1);
    const entry: CourseBoardEntry = {
      name,
      timeMs: run.timeMs,
      missed: run.missed,
      medal,
    };
    // After every row at least as fast: ties keep their earlier setter.
    let at = board.findIndex((e) => e.timeMs > run.timeMs);
    if (at < 0) at = board.length;
    board.splice(at, 0, entry);
    if (board.length > COURSE_BOARD_SIZE) board.length = COURSE_BOARD_SIZE;
    const ranked = at < COURSE_BOARD_SIZE;
    const record = at === 0;
    if (record) this.ghosts[run.course] = run.ghost;
    return {
      medal,
      rank: ranked ? at + 1 : null,
      record,
      changed: ranked || own !== null,
    };
  }
}
