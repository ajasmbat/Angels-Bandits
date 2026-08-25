// Renderer knobs the perf harness (and a human doing QA) can flip from the
// URL without a rebuild. Pure string→options parsing so the harness can
// measure antialiasing modes and pixel ratios against each other in one
// build; every default here is what actually ships, so a plain visit gets
// the shipped configuration and nothing else.
//
//   ?aa=legacy|off|msaa|smaa   antialiasing mode (default DEFAULT_AA)
//   ?res=auto|<number>    pin the pixel ratio   (default "auto" — the scaler)
//   ?perf=1               open the dev perf HUD (default closed)
//   ?gputime=1            measure GPU frame cost   (default off)

import { RESOLUTION_CEILING, RESOLUTION_FLOOR } from "./resolution";

/**
 * - `legacy` — exactly what shipped before P1: `WebGLRenderer({antialias:
 *   true})` and a plain composer target. Kept so the harness can re-measure
 *   the "before" number out of the SAME build as the "after".
 * - `off` — `legacy` minus the multisampled default framebuffer nothing ever
 *   drew into. Visually identical to `legacy`; the delta between the two IS
 *   the cost of the mismatch this ticket found.
 * - `msaa` — multisampled composer target, renderer antialias off.
 * - `smaa` — plain target, renderer antialias off, an SMAA pass after output.
 */
export type AaMode = "legacy" | "off" | "msaa" | "smaa";

/**
 * What ships — decided by measurement, not by intuition (P1).
 *
 * The scene never reaches the default framebuffer: only OutputPass's
 * fullscreen blit does. So `WebGLRenderer({ antialias: true })` was
 * allocating and resolving a multisampled backbuffer for ONE textured quad
 * while the city itself stayed jagged. Dropping it is visually identical and
 * costs nothing to give up.
 *
 * GPU p50 at pixelRatio 2, measured by tools/perf on an M3:
 *
 *   legacy (antialias:true, no scene AA)   16.2 ms   <- what shipped
 *   off    (no scene AA)                    8.5 ms   <- ships now, -47 %
 *   smaa   (real scene AA)                 21.1 ms
 *   msaa   (4x on a HalfFloat target)      49.5 ms
 *
 * Real scene antialiasing was measured and rejected: at a device ratio of 2
 * the image is already supersampled against CSS pixels, and 12.6 ms of SMAA
 * would buy edge quality by forcing the adaptive resolution controller to
 * draw FEWER pixels — a worse image, more slowly. If the scaler is ever
 * pinned near its floor, revisit: that is where SMAA starts paying.
 */
export const DEFAULT_AA: AaMode = "off";
/** Samples for the composer's multisampled target when `aa === "msaa"`. */
export const MSAA_SAMPLES = 4;

export interface RenderOptions {
  aa: AaMode;
  /** "auto" hands the ratio to the adaptive controller; a number pins it. */
  pixelRatio: number | "auto";
  /** Whether the dev perf HUD starts open. */
  perfHud: boolean;
  /**
   * Whether to time the GPU with EXT_disjoint_timer_query_webgl2. Off in the
   * shipped game: it is driver state the player gains nothing from.
   */
  gpuTimer: boolean;
}

export const DEFAULT_RENDER_OPTIONS: RenderOptions = {
  aa: DEFAULT_AA,
  pixelRatio: "auto",
  perfHud: false,
  gpuTimer: false,
};

const AA_MODES: readonly AaMode[] = ["legacy", "off", "msaa", "smaa"];

/**
 * Parse a `location.search` string. Unknown or malformed values fall back to
 * the shipped default rather than throwing — a typo in a QA URL must never
 * be the reason the game fails to boot.
 */
export function readRenderOptions(search: string): RenderOptions {
  const params = new URLSearchParams(search);
  const opts: RenderOptions = { ...DEFAULT_RENDER_OPTIONS };

  const aa = params.get("aa");
  if (aa !== null && (AA_MODES as readonly string[]).includes(aa)) {
    opts.aa = aa as AaMode;
  }

  const res = params.get("res");
  if (res === "auto") opts.pixelRatio = "auto";
  else if (res !== null) {
    const n = Number(res);
    if (Number.isFinite(n) && n > 0) {
      opts.pixelRatio = Math.min(
        RESOLUTION_CEILING,
        Math.max(RESOLUTION_FLOOR, n),
      );
    }
  }

  const perf = params.get("perf");
  if (perf !== null) opts.perfHud = perf !== "0" && perf !== "false";

  const gpu = params.get("gputime");
  if (gpu !== null) opts.gpuTimer = gpu !== "0" && gpu !== "false";

  return opts;
}
