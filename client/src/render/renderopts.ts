// Renderer knobs the perf harness (and a human doing QA) can flip from the
// URL without a rebuild. Pure string→options parsing so the harness can
// measure antialiasing modes and pixel ratios against each other in one
// build; every default here is what actually ships, so a plain visit gets
// the shipped configuration and nothing else.
//
//   ?aa=legacy|off|msaa|smaa   antialiasing mode (default DEFAULT_AA)
//   ?res=auto|<number>    pin the pixel ratio, clamped to THIS panel's own
//                         limits (default "auto" — the scaler)
//   ?perf=1               open the dev perf HUD (default closed)
//   ?gputime=1            measure GPU frame cost   (default off)
//   ?micro=0              disable the L1 micro tier (default on)

import { defaultLimits } from "./resolution";

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
 * GPU p50 at pixelRatio 2, measured by tools/perf on an M3. Read these as a
 * RANKING, not as absolutes: this GPU charges materially different prices for
 * the identical scene on different days (tools/perf/README.md documents a
 * 7 ms / 19 ms spread on the same build), so what is durable here is the
 * order and the ratios, which came from interleaved `--ab` runs.
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
  /**
   * Whether the L1 micro tier (pedestrians, steam, signals, sparks) is drawn.
   * On in the shipped game; `?micro=0` is the perf harness's A/B control, and
   * it takes the SAME early-return path as the altitude gate, so it skips the
   * CPU work and not merely the draw — otherwise the A/B measures nothing.
   */
  micro: boolean;
}

export const DEFAULT_RENDER_OPTIONS: RenderOptions = {
  aa: DEFAULT_AA,
  pixelRatio: "auto",
  perfHud: false,
  gpuTimer: false,
  micro: true,
};

const AA_MODES: readonly AaMode[] = ["legacy", "off", "msaa", "smaa"];

/**
 * Parse a `location.search` string. Unknown or malformed values fall back to
 * the shipped default rather than throwing — a typo in a QA URL must never
 * be the reason the game fails to boot.
 *
 * `devicePixelRatio` is REQUIRED, and it is the panel's, not a guess: a
 * pinned `?res=` is clamped to `defaultLimits(devicePixelRatio)` — the very
 * limits the adaptive controller would have used — rather than to the raw
 * module constants. The difference only shows on a panel below the ceiling,
 * and there it is the whole ballgame: on a 1x display the constants let
 * `?res=2` through and the client draws FOUR times the pixels the same URL
 * draws on a Retina panel, under a five-level bloom chain. Someone repeating
 * P1's before/after on a non-Retina monitor would have compared two
 * different workloads and called the difference a render win.
 *
 * A zero, negative or non-finite ratio is read as 1. `defaultLimits(0)`
 * returns a ceiling of 0, which would pin the renderer at zero pixels — a
 * black canvas from a value no real panel reports, but jsdom and a few
 * headless contexts do.
 */
export function readRenderOptions(
  search: string,
  devicePixelRatio: number,
): RenderOptions {
  const params = new URLSearchParams(search);
  const opts: RenderOptions = { ...DEFAULT_RENDER_OPTIONS };
  const dpr =
    Number.isFinite(devicePixelRatio) && devicePixelRatio > 0
      ? devicePixelRatio
      : 1;

  const aa = params.get("aa");
  if (aa !== null && (AA_MODES as readonly string[]).includes(aa)) {
    opts.aa = aa as AaMode;
  }

  const res = params.get("res");
  if (res === "auto") opts.pixelRatio = "auto";
  else if (res !== null) {
    const n = Number(res);
    if (Number.isFinite(n) && n > 0) {
      const limits = defaultLimits(dpr);
      opts.pixelRatio = Math.min(limits.ceiling, Math.max(limits.floor, n));
    }
  }

  const perf = params.get("perf");
  if (perf !== null) opts.perfHud = perf !== "0" && perf !== "false";

  const gpu = params.get("gputime");
  if (gpu !== null) opts.gpuTimer = gpu !== "0" && gpu !== "false";

  const micro = params.get("micro");
  if (micro !== null) opts.micro = micro !== "0" && micro !== "false";

  return opts;
}
