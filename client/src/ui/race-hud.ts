// S3 race HUD: the top-centre readout for stunt courses. DOM-only, like the
// kill feed. Three states:
//   - hint:   idle near a start ring — which course, and its record;
//   - run:    course, rings passed, misses, the running clock and the medal
//             cut-offs. The clock is the CLIENT's, provisional;
//   - result: the finish — first the local time, then the server's OFFICIAL
//             time (courseResult) replaces it, with medal and rank.
// Text is only written when it changes (the clock at 0.1 s), never per frame.

import {
  COURSE_MISS_PENALTY_MS,
  type Course,
} from "@angels-bandits/common/courses";
import type { CourseBoardEntry, Medal } from "@angels-bandits/common/protocol";

/** How long a finish result stays up, ms. */
const RESULT_MS = 6000;

/** "14.3 s", or "1:02.4" past a minute. Tenths: arrival-time timing carries
 * network jitter, so hundredths would claim precision it doesn't have. */
export function formatCourseTime(ms: number): string {
  const tenths = Math.max(0, Math.round(ms / 100));
  const s = tenths / 10;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, "0")}`;
}

export const MEDAL_LABEL: Readonly<Record<Medal, string>> = {
  gold: "GOLD",
  silver: "SILVER",
  bronze: "BRONZE",
};

export class RaceHud {
  private readonly root = document.getElementById("race") as HTMLDivElement;
  private readonly title = document.createElement("div");
  private readonly clock = document.createElement("div");
  private readonly detail = document.createElement("div");
  private mode: "off" | "hint" | "run" | "result" = "off";
  private resultUntil = 0;
  private hintCourse = -1;
  private texts = ["", "", ""];

  constructor() {
    this.title.className = "title";
    this.clock.className = "clock";
    this.detail.className = "detail";
    this.root.append(this.title, this.clock, this.detail);
  }

  private show(
    title: string,
    clock: string,
    detail: string,
    cls: string,
  ): void {
    const next = [title, clock, detail];
    const els = [this.title, this.clock, this.detail];
    for (let i = 0; i < 3; i++) {
      if (this.texts[i] !== next[i]) {
        (els[i] as HTMLDivElement).textContent = next[i] as string;
        this.texts[i] = next[i] as string;
      }
    }
    if (this.root.className !== cls) this.root.className = cls;
  }

  private hide(): void {
    this.mode = "off";
    this.hintCourse = -1;
    if (this.root.className !== "") this.root.className = "";
  }

  /** Idle near a start ring (or `course` null: nothing near). */
  hint(course: Course | null, record: CourseBoardEntry | null): void {
    if (this.mode === "run" || this.mode === "result") return;
    if (!course) {
      if (this.mode === "hint") this.hide();
      return;
    }
    if (this.mode === "hint" && this.hintCourse === course.id) return;
    this.mode = "hint";
    this.hintCourse = course.id;
    this.show(
      course.name.toUpperCase(),
      "◯ FLY THE GREEN RING",
      record
        ? `RECORD ${formatCourseTime(record.timeMs)} · ${record.name}`
        : `GOLD ${formatCourseTime(course.medals.gold)}`,
      "open hint",
    );
  }

  /** A run in progress: call every frame (writes only on change). */
  run(course: Course, next: number, missed: number, elapsedMs: number): void {
    this.mode = "run";
    const rings = course.rings.length;
    const penalty = missed * COURSE_MISS_PENALTY_MS;
    const m = course.medals;
    this.show(
      `${course.name.toUpperCase()} · RING ${Math.min(next, rings)}/${rings}`,
      formatCourseTime(elapsedMs + penalty),
      missed > 0
        ? `MISSED ${missed} (+${penalty / 1000} s) · GOLD ${formatCourseTime(m.gold)}`
        : `GOLD ${formatCourseTime(m.gold)} · SILVER ${formatCourseTime(m.silver)} · BRONZE ${formatCourseTime(m.bronze)}`,
      "open run",
    );
  }

  /** The local finish: provisional until the server's result lands. */
  finished(
    course: Course,
    timeMs: number,
    missed: number,
    nowMs: number,
  ): void {
    this.mode = "result";
    this.resultUntil = nowMs + RESULT_MS;
    this.show(
      `${course.name.toUpperCase()} · FINISH`,
      formatCourseTime(timeMs),
      missed > 0 ? `MISSED ${missed} · CONFIRMING…` : "CONFIRMING…",
      "open result",
    );
  }

  /** The server's official result for our run. */
  official(
    course: Course,
    timeMs: number,
    missed: number,
    medal: Medal | null,
    rank: number | null,
    record: boolean,
    nowMs: number,
  ): void {
    this.mode = "result";
    this.resultUntil = nowMs + RESULT_MS;
    const parts: string[] = [];
    if (record) parts.push("NEW RECORD");
    else if (rank !== null) parts.push(`#${rank} ON THE BOARD`);
    if (missed > 0) parts.push(`MISSED ${missed}`);
    if (parts.length === 0) parts.push("OFFICIAL");
    this.show(
      `${course.name.toUpperCase()} · ${medal ? MEDAL_LABEL[medal] : "FINISHED"}`,
      formatCourseTime(timeMs),
      parts.join(" · "),
      `open result${medal ? ` ${medal}` : ""}${record ? " record" : ""}`,
    );
  }

  /** The run was dropped (death, respawn, idle): clear the readout. */
  aborted(): void {
    if (this.mode === "run") this.hide();
  }

  /** Expire a finished result. */
  update(nowMs: number): void {
    if (this.mode === "result" && nowMs > this.resultUntil) this.hide();
  }
}
