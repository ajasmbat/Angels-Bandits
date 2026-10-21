// SOLO: the page's side of the sim worker (./worker.ts). The game runs
// locally by default: GameSocket opens a WorkerLink where it opened a
// WebSocket, and the link behaves like one — `open`, `message`, `close`
// and `error` events, `readyState`, `send(text)`, `close()` — so the
// socket's join, resume and watchdog code is the same code over either.
// `?mp=1` (a hidden developer toggle) keeps the ws to the remote server.
//
// G9: a snapshot arrives PACKED (common/src/net.ts packSnapshot) and is
// handed on as its Float64Array — `message` with that as `data` and the
// link's id table as `ids` (GameSocket decodes it into objects it reuses):
// nothing per snapshot is allocated on this side, and the one event object
// is reused. Every other frame is still the JSON text a ws would give.
//
// The worker starts once per page, as early as the boot can start it, so
// the host has built its city while the player is still on the start
// screen. Host flags ride `?sim=KEY:VALUE,KEY:VALUE` — the AB_* switches and
// timing overrides the harnesses used to set on the server's environment.

import type { PhysTier } from "@angels-bandits/server/debris-physics";
import type { TickReport } from "@angels-bandits/server/host";
import { ingestPoses, sendPhysicsView } from "./poses";
import type { FromWorker, ToWorker } from "./protocol";

/** WebSocket's readyState values (a link reports the same ones). */
const OPEN = 1;
const CLOSED = 3;

/** The surface GameSocket uses — a WebSocket has it, and so does a
 * WorkerLink. */
export interface Link {
  readonly readyState: number;
  send(text: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: "open" | "message" | "close" | "error",
    listener: (ev: LinkEvent) => void,
    options?: { once?: boolean },
  ): void;
}

/** What a link's listeners read: a message's text, a close's code. */
export interface LinkEvent {
  data?: unknown;
  code?: number;
  reason?: string;
  /** G9: a packed snapshot's id table (the index → the id). */
  ids?: readonly string[];
}

/** Is this page on the multiplayer server (`?mp=1`) instead of the local
 * host? Read once. */
export const multiplayer = (): boolean =>
  typeof location !== "undefined" &&
  new URLSearchParams(location.search ?? "").get("mp") === "1";

/** `?sim=` → the host's environment-shaped flags (server/src/host-options). */
export function simEnv(search: string): Record<string, string> {
  const raw = new URLSearchParams(search).get("sim");
  const env: Record<string, string> = {};
  for (const pair of (raw ?? "").split(",")) {
    const at = pair.indexOf(":");
    if (at <= 0) continue;
    env[pair.slice(0, at).trim()] = pair.slice(at + 1).trim();
  }
  return env;
}

let worker: Worker | null = null;
let nextId = 1;
const live = new Map<number, WorkerLink>();
/** A host error: every link still opening fails with it. */
let fatal: string | null = null;

const postToWorker = (msg: ToWorker): void => worker?.postMessage(msg);

/** Start the sim worker (idempotent): its host builds while the page boots. */
export function startLocalHost(): void {
  if (worker) return;
  worker = new Worker(new URL("./worker.ts", import.meta.url), {
    type: "module",
    name: "sim",
  });
  worker.addEventListener("message", (ev: MessageEvent<FromWorker>) => {
    const msg = ev.data;
    if (msg.t === "poses") {
      ingestPoses(msg);
      return;
    }
    if (msg.t === "stats") {
      const out = msg.report && { ...msg.report, at: msg.at };
      for (const resolve of statsWaiters.splice(0)) resolve(out);
      return;
    }
    if (msg.t === "error") {
      fatal = msg.message || "The game failed to start";
      for (const link of live.values()) link.fail();
      return;
    }
    live.get(msg.id)?.receive(msg);
  });
  worker.addEventListener("error", (ev) => {
    fatal = ev.message || "The game failed to start";
    for (const link of live.values()) link.fail();
  });
  postToWorker({ t: "init", env: simEnv(location.search) });
}

/** QA (tools/perf/worker-tick.mjs): the host's tick profile, or null when
 * the page runs no local host or profiling is off (`sim` AB_TICK_STATS:1). */
export function localTickReport(
  reset: boolean,
): Promise<(TickReport & { at: number }) | null> {
  if (!worker) return Promise.resolve(null);
  return new Promise((resolve) => {
    statsWaiters.push(resolve);
    postToWorker({ t: "stats", reset });
  });
}
const statsWaiters: ((r: (TickReport & { at: number }) | null) => void)[] = [];

/** DS1: the camera (any torus image) and quality tier, for the local
 * host's debris physics (throttled; a no-op without a worker). */
export function localPhysicsView(
  x: number,
  z: number,
  tier: PhysTier,
  now: number,
): void {
  if (worker) sendPhysicsView(postToWorker, x, z, tier, now);
}

/** Freeze (or resume) the local simulation. */
export function pauseLocalHost(on: boolean): void {
  postToWorker({ t: "pause", on });
}

const decoder = new TextDecoder();

/** One connection into the local host, shaped like a WebSocket. */
export class WorkerLink implements Link {
  readyState = 0;
  private readonly id = nextId++;
  private readonly listeners = new Map<
    string,
    { fn: (ev: LinkEvent) => void; once: boolean }[]
  >();
  /** G9: this connection's id table, and the event a packed snapshot is
   * handed on in (reused: its listeners read it there and then). */
  private readonly ids: string[] = [];
  private readonly snapEvent: LinkEvent = { data: null, ids: this.ids };

  constructor() {
    startLocalHost();
    live.set(this.id, this);
    if (fatal) setTimeout(() => this.fail(), 0);
    else postToWorker({ t: "open", id: this.id });
  }

  addEventListener(
    type: "open" | "message" | "close" | "error",
    fn: (ev: LinkEvent) => void,
    options?: { once?: boolean },
  ): void {
    const list = this.listeners.get(type) ?? [];
    list.push({ fn, once: options?.once === true });
    this.listeners.set(type, list);
  }

  send(text: string): void {
    if (this.readyState !== OPEN) return;
    postToWorker({ t: "send", id: this.id, text });
  }

  close(): void {
    if (this.readyState === CLOSED) return;
    postToWorker({ t: "close", id: this.id });
    // A ws reports its own close on a later turn, never inside close().
    this.readyState = CLOSED;
    live.delete(this.id);
    setTimeout(() => this.emit("close", { code: 1000, reason: "" }), 0);
  }

  /** A frame or state change from the worker for this link. */
  receive(msg: FromWorker): void {
    if (this.readyState === CLOSED) return;
    if (msg.t === "open") {
      this.readyState = OPEN;
      this.emit("open", {});
    } else if (msg.t === "snap") {
      this.snapEvent.data = msg.data;
      this.emit("message", this.snapEvent);
      this.snapEvent.data = null;
    } else if (msg.t === "ids") {
      for (let k = 0; k < msg.ids.length; k++) {
        this.ids[msg.base + k] = msg.ids[k] as string;
      }
    } else if (msg.t === "frame") {
      this.emit("message", { data: decoder.decode(msg.data) });
    } else if (msg.t === "close") {
      this.closed(msg.code, msg.reason);
    }
  }

  /** The host is gone: an error, then the close (a ws's order). */
  fail(): void {
    if (this.readyState === CLOSED) return;
    this.emit("error", {});
    this.closed(1006, fatal ?? "");
  }

  private closed(code: number, reason: string): void {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    live.delete(this.id);
    this.emit("close", { code, reason });
  }

  private emit(type: string, ev: LinkEvent): void {
    const list = this.listeners.get(type);
    if (!list) return;
    // G9: the list is copied only when a once-listener leaves it (not on
    // every message).
    let once = false;
    for (let k = 0; k < list.length; k++) {
      if ((list[k] as (typeof list)[number]).once) once = true;
    }
    if (once) {
      this.listeners.set(
        type,
        list.filter((l) => !l.once),
      );
    }
    for (let k = 0; k < list.length; k++) {
      (list[k] as (typeof list)[number]).fn(ev);
    }
  }
}
