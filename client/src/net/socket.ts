// GameSocket: the client's one connection to the presence server. Joins with
// a name, streams the local plane's pose up at TICK_UP_HZ, surfaces
// snapshots/join/leave events, and estimates the server clock so the render
// loop can sample interpolation buffers the ADAPTIVE interpolation delay
// behind it (ANGE-4KO2W2). The frame loop never reads that raw estimate:
// it renders on the SMOOTHED clocks in ./clock.ts (O2), latched once per
// frame by tickRenderClock().
//
// Snapshots arrive QUANTISED — a tuple of integers per plane — and are decoded
// here, so nothing downstream of this file knows the wire got cheaper. This is
// also where snapshot-arrival jitter is measured: it is the one place that
// sees every snapshot land on the local clock.
//
// W2: a dropped socket is not the end of the session. The GameSocket swaps
// in a fresh ws behind the same object, rejoining with the welcome's
// resumeToken on the backoff in ./reconnect.ts, and only reports onClose
// once that has failed — the server answered as a different player, or the
// resume window ran out.
//
// D2: the room's destroyed-chunk set lives HERE, in `cityDamage`, not in the
// game loop's handlers: those attach only after the city build and shader
// pre-warm, and a `chunks` batch dropped while booting would leave this
// client colliding with walls everyone else has shot away for the rest of
// the session. main.ts binds it to the city once the city exists.
// D3: so do the room's collapses (`collapses`), for the same reason: a
// collapse dropped while booting would leave a building standing here that
// everyone else saw fall.

import { CityDamage, decodeChunkIds } from "@angels-bandits/common/city";
import {
  CollapseField,
  type CollapseWire,
  collapseChunks,
} from "@angels-bandits/common/city/collapse";
import type { CityEvent } from "@angels-bandits/common/cityevents";
import {
  CONNECT_TIMEOUT_MS,
  SERVER_SILENCE_MS,
  TICK_UP_HZ,
} from "@angels-bandits/common/constants";
import { decodeSnapshotEntry } from "@angels-bandits/common/net";
import type {
  BotsConfigMsg,
  CourseBoardMsg,
  CourseResultMsg,
  DamageMsg,
  DeathMsg,
  NewsHeliMsg,
  Pose,
  RespawnMsg,
  RosterEntry,
  ScoreEntry,
  ServerMsg,
  SnapshotMsg,
  WelcomeMsg,
} from "@angels-bandits/common/protocol";
import type { Vec3 } from "@angels-bandits/common/world";
import { PoseCadence, RenderClock } from "./clock";
import { InterpDelay } from "./delay";
import { reconnectDelayMs } from "./reconnect";

export interface GameSocketEvents {
  onSnapshot?: (snap: SnapshotMsg) => void;
  onPlayerJoined?: (player: RosterEntry) => void;
  onPlayerLeft?: (id: string) => void;
  onFired?: (id: string) => void;
  onDamage?: (msg: DamageMsg) => void;
  onDeath?: (msg: DeathMsg) => void;
  onRespawn?: (msg: RespawnMsg) => void;
  onScores?: (scores: ScoreEntry[]) => void;
  onBotsConfig?: (msg: BotsConfigMsg) => void;
  /** L1: a server-accepted event the city reacts to (reactions.ts). */
  onCityEvent?: (event: CityEvent) => void;
  onNewsHeli?: (msg: NewsHeliMsg) => void;
  /** W2: our `away` took effect — the return will come with a respawn. */
  onAwayStarted?: () => void;
  /** D3: a building section started to collapse (already applied to
   * `cityDamage` and `collapses`) — audio, shake, dust. */
  onCollapse?: (c: CollapseWire) => void;
  /** S3: the official result of our own finished course run. */
  onCourseResult?: (msg: CourseResultMsg) => void;
  /** S3: a course leaderboard changed (ghost attached when a record fell). */
  onCourseBoard?: (msg: CourseBoardMsg) => void;
  /** W2: the socket dropped; reconnecting in the background. */
  onReconnecting?: () => void;
  /** W2: back as the same player. `welcome` is the fresh one: roster,
   * scores and a new spawn, since the room moved on meanwhile. */
  onResumed?: (welcome: WelcomeMsg) => void;
  /** The session is over for good: the resume failed or ran out of time. */
  onClose?: () => void;
}

/** One frame's latched clocks (server-clock ms unless noted). All null until
 * the first snapshot has given the client a server-clock estimate. */
export interface FrameClock {
  /** The local rAF timestamp these were latched at. */
  frameMs: number;
  /** The smoothed render time — what the world is drawn at. */
  time: number | null;
  /** The RAW render target (estimated server now − controller delay). Each
   * remote slews its own clock toward this minus its pose lag. */
  target: number | null;
  /** The raw estimated server "now" at this frame. */
  serverNow: number | null;
}

const POSE_INTERVAL_MS = 1000 / TICK_UP_HZ;
/** W2 dead-socket watchdog cadence, ms. */
const WATCHDOG_MS = 1000;

/** ws endpoint: dev talks straight to the server port, prod is same-origin. */
const socketUrl = (): string => {
  if (import.meta.env.DEV) return `ws://${location.hostname}:8080`;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}`;
};

export class GameSocket {
  /** The latest welcome — replaced by each resume (same id, fresh token). */
  welcome: WelcomeMsg;
  readonly events: GameSocketEvents = {};
  /** D2: what the server has destroyed in this room — reset from every
   * welcome (a resume may land in a room with less damage), grown by every
   * `chunks` batch, whether or not anything is listening yet. */
  readonly cityDamage = new CityDamage();
  /** D3: the room's collapse records and their debris — replayed from every
   * welcome, grown by every `collapse` message. Its fallen chunks are marked
   * in `cityDamage` from the records alone (never the welcome's set). */
  readonly collapses = new CollapseField();
  private ws: WebSocket;
  /** W2: "open" → "reconnecting" on a drop → back, or "lost" for good. */
  private state: "open" | "reconnecting" | "lost" = "open";
  /** When the drop was noticed, and how many resumes have been tried. */
  private droppedAt = 0;
  private attempt = 0;
  /** Last time anything arrived from the server (local clock). */
  private lastHeardMs = performance.now();
  /** serverTime − performance.now(), estimated from stamped snapshots. */
  private clockOffset: number | null = null;
  /** Fixed 30 Hz pose upload deadline (O2). */
  private readonly cadence = new PoseCadence(POSE_INTERVAL_MS);
  /** The adaptive interpolation buffer, fed by snapshot arrival times. */
  private readonly delay = new InterpDelay();
  /** Smoothed estimate of server "now" — what outgoing poses are stamped
   * with, so their times are as even as the poses themselves. */
  private readonly nowClock = new RenderClock();
  /** Smoothed render time: slews toward now − delay, never backward. */
  private readonly renderClock = new RenderClock();
  private frame: FrameClock = {
    frameMs: 0,
    time: null,
    target: null,
    serverNow: null,
  };

  private constructor(
    ws: WebSocket,
    welcome: WelcomeMsg,
    private readonly name: string,
  ) {
    this.ws = ws;
    this.welcome = welcome;
    this.replayDestruction(welcome);
    this.attach(ws);
    // W2 watchdog: snapshots arrive at TICK_DOWN_HZ, so a visible tab that
    // hears nothing for SERVER_SILENCE_MS is on a dead (half-open) socket —
    // a network change can leave one that never fires `close`. A hidden tab
    // is skipped, and coming back restarts the clock — as does a check that
    // itself ran late: after a long main-thread stall (the synchronous city
    // build, a slow frame) this timer can run before the snapshots that
    // queued meanwhile, and that silence proves nothing about the socket.
    let lastCheckMs = performance.now();
    setInterval(() => {
      const now = performance.now();
      const stalled = now - lastCheckMs > WATCHDOG_MS * 2;
      lastCheckMs = now;
      if (stalled || document.hidden) this.lastHeardMs = now;
      if (this.state !== "open") return;
      if (now - this.lastHeardMs > SERVER_SILENCE_MS) this.dropped();
    }, WATCHDOG_MS);
  }

  /** Connect and join; resolves once the server's welcome arrives. Always
   * settles (W1): an error, a close before the welcome, or no welcome within
   * CONNECT_TIMEOUT_MS all reject — a join never hangs on a silent socket.
   * `resume` (W2) is a token handed over a reload, if any. */
  static async connect(name: string, resume?: string): Promise<GameSocket> {
    const { ws, welcome } = await GameSocket.open(name, resume);
    return new GameSocket(ws, welcome, name);
  }

  private static open(
    name: string,
    resume?: string,
  ): Promise<{ ws: WebSocket; welcome: WelcomeMsg }> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(socketUrl());
      let settled = false;
      const fail = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ws.close();
        reject(new Error("Can't reach the server"));
      };
      const timer = setTimeout(fail, CONNECT_TIMEOUT_MS);
      ws.addEventListener("open", () =>
        ws.send(JSON.stringify({ type: "join", name, resume })),
      );
      ws.addEventListener("error", fail);
      ws.addEventListener("close", fail);
      ws.addEventListener(
        "message",
        (ev) => {
          if (settled) return;
          const msg = JSON.parse(ev.data as string) as ServerMsg;
          if (msg.type !== "welcome") return fail();
          settled = true;
          clearTimeout(timer);
          resolve({ ws, welcome: msg });
        },
        { once: true },
      );
    });
  }

  /** Route a ws's traffic here — only while it is the CURRENT one, so a
   * replaced socket's stragglers (and its late close) are ignored. */
  private attach(ws: WebSocket): void {
    ws.addEventListener("message", (ev) => {
      if (ws !== this.ws) return;
      this.lastHeardMs = performance.now();
      this.handle(ev);
    });
    ws.addEventListener("close", () => {
      if (ws === this.ws) this.dropped();
    });
  }

  /** The current socket is gone (closed, or the watchdog gave up on it):
   * start resuming. */
  private dropped(): void {
    if (this.state !== "open") return;
    this.state = "reconnecting";
    this.ws.close();
    this.droppedAt = performance.now();
    this.attempt = 0;
    this.events.onReconnecting?.();
    this.scheduleResume();
  }

  private scheduleResume(): void {
    const delay = reconnectDelayMs(
      this.attempt,
      performance.now() - this.droppedAt,
    );
    if (delay === null) this.lost();
    else setTimeout(() => this.tryResume(), delay);
  }

  /** One resume attempt. A hidden tab waits to be shown first: a resumed
   * session starts loading again, and nothing would pose it from here. */
  private async tryResume(): Promise<void> {
    if (document.hidden) {
      document.addEventListener("visibilitychange", () => this.tryResume(), {
        once: true,
      });
      return;
    }
    let next: { ws: WebSocket; welcome: WelcomeMsg };
    try {
      next = await GameSocket.open(this.name, this.welcome.resumeToken);
    } catch {
      this.attempt++;
      this.scheduleResume();
      return;
    }
    if (next.welcome.id !== this.selfId) {
      // The token was refused (expired, spent, or the server restarted): the
      // server made us someone new, and that is SIGNAL LOST's job, not ours.
      next.ws.close();
      this.lost();
      return;
    }
    this.ws = next.ws;
    this.welcome = next.welcome;
    this.replayDestruction(next.welcome);
    this.attach(next.ws);
    this.delay.reset(); // the outage's arrival gaps are not jitter
    this.lastHeardMs = performance.now();
    this.state = "open";
    this.events.onResumed?.(next.welcome);
  }

  /** A welcome's whole destruction: the broken set, then every collapse. */
  private replayDestruction(welcome: WelcomeMsg): void {
    this.cityDamage.reset(decodeChunkIds(welcome.destroyed));
    const records = Array.isArray(welcome.collapses) ? welcome.collapses : [];
    this.collapses.reset(records);
    for (const c of records) this.cityDamage.collapse(collapseChunks(c));
  }

  /** One live collapse: its chunks fall, its debris starts. */
  private applyCollapse(c: CollapseWire): void {
    this.cityDamage.collapse(collapseChunks(c));
    this.collapses.add(c);
    this.events.onCollapse?.(c);
  }

  private lost(): void {
    this.state = "lost";
    this.events.onClose?.();
  }

  get selfId(): string {
    return this.welcome.id;
  }

  /** The token a reload can resume this session with (W2). */
  get resumeToken(): string {
    return this.welcome.resumeToken;
  }

  /** W2: the tab hid (`true`) or came back (`false`). */
  sendAway(on: boolean): void {
    this.send({ type: "away", on });
  }

  /** Call every frame with the frame's rAF timestamp — sends one pose per
   * TICK_UP_HZ interval on a fixed cadence, stamped with this frame's
   * smoothed server-time estimate (the server forwards it so remotes are
   * interpolated on when each pose was TAKEN, not when a tick sampled it). */
  sendPose(pose: Pose, frameMs: number): void {
    if (!this.cadence.due(frameMs)) return;
    if (this.ws.readyState !== WebSocket.OPEN) return;
    const t = this.frame.frameMs === frameMs ? this.nowClock.time : null;
    this.ws.send(
      JSON.stringify(
        t === null
          ? { type: "pose", pose }
          : { type: "pose", pose, t: Math.round(t) },
      ),
    );
  }

  /** Boot keepalive (W1): "still here" while nothing else is being sent. */
  sendPing(): void {
    this.send({ type: "ping" });
  }

  /** Announce one shot (seq = bullet id future hit claims will reference). */
  sendFire(seq: number): void {
    this.send({ type: "fire", seq });
  }

  /** Boost edge (F2): the instant a burn starts or ends. Never batched —
   * the server's energy mirror is stepped from exactly these edges. */
  sendBoost(on: boolean): void {
    this.send({ type: "boost", on });
  }

  /** Claim a shooter-side hit on `targetId` by bullet `seq`. The claim
   * declares the buffer this client was holding: the server's range slack is
   * derived from it, so a shooter on a clean link is judged against a tighter
   * window than one that genuinely needs a deep buffer.
   *
   * The declared delay is the one the frame was actually drawn at (the
   * smoothed clock lags or leads the controller while it slews), plus
   * `extraMs` — how much staler than the server's on-record pose that
   * target's image additionally is (RemotePlanes.extraDelayOf). */
  sendHit(
    targetId: string,
    bulletOrigin: Vec3,
    seq: number,
    extraMs = 0,
  ): void {
    this.send({
      type: "hit",
      targetId,
      bulletOrigin,
      seq,
      delay: Math.round(this.effectiveDelayMs + extraMs),
    });
  }

  /** Report flying into a building or the ground; `t` (D3) is the server
   * time the movers — and collapse debris — were posed at for the check. */
  sendCrash(t: number | null = null): void {
    this.send(t === null ? { type: "crash" } : { type: "crash", t });
  }

  /** Claim the room's shared bot count. The server may clamp or silently
   * drop it (rate limit) — only the botsConfig it answers with is real. */
  sendSetBots(count: number): void {
    this.send({ type: "setBots", count });
  }

  private send(msg: object): void {
    if (this.ws.readyState === WebSocket.OPEN)
      this.ws.send(JSON.stringify(msg));
  }

  /**
   * Advance the smoothed clocks to the frame at `frameMs` (the rAF
   * timestamp) and latch them. Call ONCE per frame, before anything reads
   * the render time: every system then poses against the same instant.
   */
  tickRenderClock(frameMs: number): FrameClock {
    if (this.clockOffset === null) {
      this.frame = { frameMs, time: null, target: null, serverNow: null };
      return this.frame;
    }
    const serverNow = frameMs + this.clockOffset;
    const target = serverNow - this.interpDelayMs;
    this.nowClock.advance(frameMs, serverNow);
    const time = this.renderClock.advance(frameMs, target);
    this.frame = { frameMs, time, target, serverNow };
    return this.frame;
  }

  /**
   * The server-clock time the world renders at, as latched by the last
   * tickRenderClock(): smoothed, never decreasing. Null until the first
   * snapshot.
   */
  renderTime(): number | null {
    return this.frame.time;
  }

  /** The interpolation buffer the controller wants right now, ms. */
  get interpDelayMs(): number {
    return this.delay.delayMs;
  }

  /** The buffer this frame was actually drawn with, ms: estimated server
   * now minus the smoothed render time. Equals interpDelayMs once the
   * clock has converged; differs only while it slews. */
  get effectiveDelayMs(): number {
    const { time, serverNow } = this.frame;
    if (time === null || serverNow === null) return this.interpDelayMs;
    return Math.max(0, serverNow - time);
  }

  /** Measured snapshot-arrival jitter, ms — QA/telemetry only. */
  get jitterMs(): number {
    return this.delay.jitter;
  }

  private handle(ev: MessageEvent): void {
    const msg = JSON.parse(ev.data as string) as ServerMsg;
    switch (msg.type) {
      case "snapshot": {
        const arrival = performance.now();
        this.delay.observe(arrival);
        // Each sample of serverTime − now is the true offset minus that
        // packet's latency, so the LARGEST sample is the best estimate; adapt
        // slowly downward to track drift or a route change.
        const sample = msg.time - arrival;
        if (this.clockOffset === null || sample > this.clockOffset) {
          this.clockOffset = sample;
        } else {
          this.clockOffset += (sample - this.clockOffset) * 0.02;
        }
        const decoded: SnapshotMsg = {
          type: "snapshot",
          time: msg.time,
          players: msg.p.map(decodeSnapshotEntry),
        };
        this.events.onSnapshot?.(decoded);
        break;
      }
      case "playerJoined":
        this.events.onPlayerJoined?.(msg.player);
        break;
      case "playerLeft":
        this.events.onPlayerLeft?.(msg.id);
        break;
      case "fired":
        this.events.onFired?.(msg.id);
        break;
      case "damage":
        this.events.onDamage?.(msg);
        break;
      case "death":
        this.events.onDeath?.(msg);
        break;
      case "cityEvent":
        this.events.onCityEvent?.(msg.event);
        break;
      case "respawn":
        this.events.onRespawn?.(msg);
        break;
      case "score":
        this.events.onScores?.(msg.scores);
        break;
      case "botsConfig":
        this.events.onBotsConfig?.(msg);
        break;
      case "newsHeli":
        this.events.onNewsHeli?.(msg);
        break;
      case "awayStarted":
        this.events.onAwayStarted?.();
        break;
      case "chunks":
        this.cityDamage.apply(decodeChunkIds(msg.d));
        break;
      case "collapse":
        this.applyCollapse(msg.c);
        break;
      case "courseResult":
        this.events.onCourseResult?.(msg);
        break;
      case "courseBoard":
        this.events.onCourseBoard?.(msg);
        break;
      case "welcome":
        break; // already consumed by open()
    }
  }
}
