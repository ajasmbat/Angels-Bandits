// S3 course leaderboards, shown under the roster in the Tab scoreboard panel
// (its own section and module, so ui/scoreboard.ts stays as it is). One
// block per course: name, medal cut-offs, then the board's top rows. State is
// whatever the server last said (welcome.courses + courseBoard). Names render
// as textContent — they are free text.

import { COURSE_BOARD_SIZE, type Course } from "@angels-bandits/common/courses";
import type { CourseBoardEntry } from "@angels-bandits/common/protocol";
import { MEDAL_LABEL, formatCourseTime } from "./race-hud";

/** Rows shown per course (the server keeps COURSE_BOARD_SIZE). */
const ROWS_SHOWN = Math.min(3, COURSE_BOARD_SIZE);

export class CourseBoard {
  private readonly root = document.getElementById(
    "course-board",
  ) as HTMLDivElement;
  private readonly boards: CourseBoardEntry[][];
  private dirty = true;

  constructor(
    private readonly courses: readonly Course[],
    private readonly selfName: string,
  ) {
    this.boards = courses.map(() => []);
  }

  set(course: number, board: readonly CourseBoardEntry[]): void {
    if (course < 0 || course >= this.boards.length) return;
    this.boards[course] = [...board];
    this.dirty = true;
  }

  /** The record row of `course`, or null. */
  recordOf(course: number): CourseBoardEntry | null {
    return this.boards[course]?.[0] ?? null;
  }

  /** Rebuild if anything changed — call when the panel opens. */
  render(): void {
    if (!this.dirty) return;
    this.dirty = false;
    const blocks: HTMLElement[] = [];
    for (const course of this.courses) {
      const block = document.createElement("div");
      block.className = "course";
      const head = document.createElement("div");
      head.className = "head";
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = course.name.toUpperCase();
      const cuts = document.createElement("span");
      cuts.className = "cuts";
      cuts.textContent = `${formatCourseTime(course.medals.gold)} / ${formatCourseTime(course.medals.silver)} / ${formatCourseTime(course.medals.bronze)}`;
      head.append(name, cuts);
      block.append(head);
      const board = this.boards[course.id] ?? [];
      if (board.length === 0) {
        const empty = document.createElement("div");
        empty.className = "row empty";
        empty.textContent = "no time yet — fly the green ring";
        block.append(empty);
      }
      board.slice(0, ROWS_SHOWN).forEach((entry, i) => {
        const row = document.createElement("div");
        row.className = `row${entry.medal ? ` ${entry.medal}` : ""}${
          entry.name === this.selfName ? " self" : ""
        }`;
        const who = document.createElement("span");
        who.textContent = `${i + 1}. ${entry.name}`;
        const time = document.createElement("span");
        time.textContent = `${formatCourseTime(entry.timeMs)}${
          entry.medal ? ` ${MEDAL_LABEL[entry.medal][0]}` : ""
        }`;
        row.append(who, time);
        block.append(row);
      });
      blocks.push(block);
    }
    const note = document.createElement("div");
    note.className = "note";
    note.textContent = "records reset when the server restarts";
    this.root.replaceChildren(...blocks, note);
  }
}
