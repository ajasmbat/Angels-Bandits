// Dev perf HUD (P1). A small overlay reading the SAME FrameMeter the
// headless harness reads, so the numbers on screen and the numbers in
// tools/perf's report are the same numbers.
//
// It exists because the harness cannot catch *felt* hitching: a 2 % frame at
// 200 ms averages away in a benchmark and is obvious in the hand. Percentiles
// plus a live overlay covers both halves.
//
// Off by default and never player-visible: the markup lives in index.html
// hidden behind `body.perf`, exactly the toggle idiom free-look and
// fullscreen already use. `P` flips it — but ONLY in a dev build, or in a
// build visited with ?perf=1 (see render/renderopts.ts and
// perfHudKeyEnabled below). In a plain production visit the key is never
// bound at all, so a player who happens to press P gets nothing.

import type { FrameStats } from "../render/perfmeter";

/** Just enough of Document to drive the overlay — injectable for tests. */
export interface PerfHudDoc {
  getElementById(id: string): { textContent: string | null } | null;
  body: { classList: { toggle(token: string, force?: boolean): void } } | null;
}

export interface ResolutionReadout {
  ratio: number;
  auto: boolean;
}

/** The HUD's whole body text. Pure — this is what the unit test asserts. */
export function perfHudText(
  stats: FrameStats,
  res: ResolutionReadout,
  aa: string,
  gpu: FrameStats | null = null,
  gpuStarved = 0,
): string {
  const ms = (v: number) => v.toFixed(1);
  const lines = [
    `PERF  ${stats.fps.toFixed(0)} FPS  (p50 ${ms(stats.p50)} ms)`,
    `p95 ${ms(stats.p95)}  p99 ${ms(stats.p99)}  WORST ${ms(stats.worst)} ms`,
    `DRAW ${stats.drawCalls} (max ${stats.drawCallsMax})  N ${stats.count}`,
    `RES ${res.ratio.toFixed(2)}x ${res.auto ? "auto" : "pinned"}  AA ${aa}`,
  ];
  // Only when ?gputime=1 asked for it AND the driver has the extension.
  if (gpu !== null) {
    // A skip count is never decoration: the query pool empties on the
    // EXPENSIVE frames, so any number here means the GPU tail below is
    // missing its worst samples (see render/gputimer.ts).
    const skipped = gpuStarved > 0 ? `  !${gpuStarved} SKIPPED` : "";
    lines.push(`GPU p50 ${ms(gpu.p50)}  p95 ${ms(gpu.p95)} ms${skipped}`);
  }
  return lines.join("\n");
}

/** How often the overlay rewrites its text — 4 Hz, not every frame. */
export const PERF_HUD_REFRESH_MS = 250;

export class PerfHud {
  private readonly el: { textContent: string | null } | null;
  private open = false;
  private nextWriteAt = 0;

  constructor(private readonly doc: PerfHudDoc = document) {
    this.el = doc.getElementById("perfhud");
  }

  get isOpen(): boolean {
    return this.open;
  }

  setOpen(on: boolean): void {
    this.open = on;
    this.doc.body?.classList.toggle("perf", on);
    this.nextWriteAt = 0; // repaint immediately on open
  }

  toggle(): void {
    this.setOpen(!this.open);
  }

  /**
   * Call every frame; writes at PERF_HUD_REFRESH_MS and only while open.
   * `statsOf` is a supplier, not a value: summarising the window sorts it,
   * so the overlay must not pay for that on the frames it throws away.
   */
  update(
    now: number,
    statsOf: () => FrameStats,
    res: ResolutionReadout,
    aa: string,
    gpuOf: () => FrameStats | null = () => null,
    gpuStarvedOf: () => number = () => 0,
  ): void {
    if (!this.open || this.el === null || now < this.nextWriteAt) return;
    this.nextWriteAt = now + PERF_HUD_REFRESH_MS;
    this.el.textContent = perfHudText(
      statsOf(),
      res,
      aa,
      gpuOf(),
      gpuStarvedOf(),
    );
  }
}

/**
 * Whether `P` should be bound at all — the production/dev split, kept pure so
 * the test can assert both sides of it without a bundler.
 *
 * The overlay is a debug tool: teal monospace percentiles over the canvas,
 * meaningless to a player and confusing if it appears by accident. It is
 * hidden behind `body.perf`, so the only way in is the key, and the key used
 * to be registered unconditionally — every shipped build answered P. Two
 * doors stay open, and no others:
 *
 *  - a **dev build** (`import.meta.env.DEV`), where the whole point is to
 *    press it while flying;
 *  - **`?perf=1`**, which a human (or the harness) types deliberately. That
 *    one already opens the overlay, so binding the key there only lets them
 *    close it again.
 *
 * A production player has neither, so nothing listens for their keystroke.
 */
export function perfHudKeyEnabled(
  devBuild: boolean,
  perfHudRequested: boolean,
): boolean {
  return devBuild || perfHudRequested;
}

/**
 * Bind `P` to the HUD, when `enabled` (see perfHudKeyEnabled). Guarded the
 * way fullscreen's `F` is: never while typing a callsign, never on
 * auto-repeat.
 *
 * `enabled` gates the REGISTRATION, not the handler body: a disabled build
 * adds no keydown listener at all, so the HUD costs a production player
 * nothing — not even a predicate per keystroke.
 */
export function bindPerfHudKey(
  hud: PerfHud,
  enabled: boolean,
  target: Pick<Window, "addEventListener"> = window,
): void {
  if (!enabled) return;
  target.addEventListener("keydown", (ev: KeyboardEvent) => {
    if (ev.code !== "KeyP" || ev.repeat) return;
    const tag = (ev.target as { tagName?: string } | null)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    hud.toggle();
  });
}
