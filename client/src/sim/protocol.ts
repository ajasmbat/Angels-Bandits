// SOLO: the messages between the page and its sim worker (./worker.ts). The
// GAME protocol is untouched — its JSON frames ride inside `send`/`frame`
// exactly as they ride a ws — and these few envelopes only add what a
// socket gives for free: opening, closing, and (solo only) the pause.

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
  | { t: "pause"; on: boolean };

/** Worker → page. */
export type FromWorker =
  /** Connection `id` is live (the host exists and took it). */
  | { t: "open"; id: number }
  /** One server frame: UTF-8 JSON text, its buffer transferred. */
  | { t: "frame"; id: number; data: ArrayBuffer }
  /** The host closed connection `id`. */
  | { t: "close"; id: number; code: number; reason: string }
  /** The host could not be built, or a frame could not be handled. */
  | { t: "error"; message: string };
