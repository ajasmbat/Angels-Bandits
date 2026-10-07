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

import { TICK_UP_HZ } from "@angels-bandits/common/constants";
import { decodeSnapshotEntry } from "@angels-bandits/common/net";
import type {
  BotsConfigMsg,
  DamageMsg,
  DeathMsg,
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

/** ws endpoint: dev talks straight to the server port, prod is same-origin. */
const socketUrl = (): string => {
  if (import.meta.env.DEV) return `ws://${location.hostname}:8080`;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}`;
};

export class GameSocket {
  readonly welcome: WelcomeMsg;
  readonly events: GameSocketEvents = {};
  private readonly ws: WebSocket;
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

  private constructor(ws: WebSocket, welcome: WelcomeMsg) {
    this.ws = ws;
    this.welcome = welcome;
    ws.addEventListener("message", (ev) => this.handle(ev));
    ws.addEventListener("close", () => this.events.onClose?.());
  }

  /** Connect and join; resolves once the server's welcome arrives. */
  static connect(name: string): Promise<GameSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(socketUrl());
      ws.addEventListener("open", () =>
        ws.send(JSON.stringify({ type: "join", name })),
      );
      ws.addEventListener("error", () =>
        reject(new Error("could not reach the game server")),
      );
      ws.addEventListener(
        "message",
        (ev) => {
          const msg = JSON.parse(ev.data as string) as ServerMsg;
          if (msg.type === "welcome") resolve(new GameSocket(ws, msg));
          else reject(new Error(`expected welcome, got ${msg.type}`));
        },
        { once: true },
      );
    });
  }

  get selfId(): string {
    return this.welcome.id;
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

  /** Report flying into a building or the ground. */
  sendCrash(): void {
    this.send({ type: "crash" });
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
      case "respawn":
        this.events.onRespawn?.(msg);
        break;
      case "score":
        this.events.onScores?.(msg.scores);
        break;
      case "botsConfig":
        this.events.onBotsConfig?.(msg);
        break;
      case "welcome":
        break; // already consumed by connect()
    }
  }
}
