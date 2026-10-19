// SOLO: the messages between the page and its sim worker (./worker.ts). The
// GAME protocol is untouched — its JSON frames ride inside `send`/`frame`
// exactly as they ride a ws — and these few envelopes only add what a
// socket gives for free: opening, closing, and (solo only) the pause — plus
// the QA tick profile (tools/perf/worker-tick.mjs).

import type { TickReport } from "@angels-bandits/server/host";

/** Page → worker. */
export type ToWorker =
  /** Build the host: the `?sim=` pairs (server/src/host-options.ts names). */
  | { t: "init"; env: Record<string, string> }
  /** A new connection `id` (what `new WebSocket` was). */
  | { t: "open"; id: number }
  /** One client frame (JSON text) on connection `id`. */
  | { t: "send"; id: number; text: string }
  /** The page closed connection `id`. */
  | { t: "close"; id: number }
  /** Freeze or resume the whole simulation (GameHost.setPaused). */
  | { t: "pause"; on: boolean }
  /** QA: the host's tick profile (`sim` AB_TICK_STATS:1), reset after. */
  | { t: "stats"; reset: boolean };

/** Worker → page. */
export type FromWorker =
  /** Connection `id` is live (the host exists and took it). */
  | { t: "open"; id: number }
  /** One server frame: UTF-8 JSON text, its buffer transferred. */
  | { t: "frame"; id: number; data: ArrayBuffer }
  /** The host closed connection `id`. */
  | { t: "close"; id: number; code: number; reason: string }
  /** The host could not be built, or a frame could not be handled. */
  | { t: "error"; message: string }
  /** QA: the tick profile asked for (null while profiling is off), and
   * the worker's clock when it was taken (its own timeline, ms). */
  | { t: "stats"; report: TickReport | null; at: number };
