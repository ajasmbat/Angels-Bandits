// GameSocket: the client's one connection to the presence server. Joins with
// a name, streams the local plane's pose up at TICK_UP_HZ, surfaces
// snapshots/join/leave events, and estimates the server clock so the render
// loop can sample interpolation buffers the ADAPTIVE interpolation delay
// behind it (ANGE-4KO2W2).
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
  private lastPoseSentAt = 0;
  /** The adaptive interpolation buffer, fed by snapshot arrival times. */
  private readonly delay = new InterpDelay();

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

  /** Call every frame — sends at most one pose per TICK_UP_HZ interval. */
  sendPose(pose: Pose): void {
    const now = performance.now();
    if (now - this.lastPoseSentAt < POSE_INTERVAL_MS) return;
    if (this.ws.readyState !== WebSocket.OPEN) return;
    this.lastPoseSentAt = now;
    this.ws.send(JSON.stringify({ type: "pose", pose }));
  }

  /** Announce one shot (seq = bullet id future hit claims will reference). */
  sendFire(seq: number): void {
    this.send({ type: "fire", seq });
  }

  /** Claim a shooter-side hit on `targetId` by bullet `seq`. The claim
   * declares the buffer this client was holding: the server's range slack is
   * derived from it, so a shooter on a clean link is judged against a tighter
   * window than one that genuinely needs a deep buffer. */
  sendHit(targetId: string, bulletOrigin: Vec3, seq: number): void {
    this.send({
      type: "hit",
      targetId,
      bulletOrigin,
      seq,
      delay: this.interpDelayMs,
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
   * The server-clock time remote planes should render at: estimated server
   * "now" minus the interpolation delay. Null until the first snapshot.
   */
  renderTime(): number | null {
    if (this.clockOffset === null) return null;
    return performance.now() + this.clockOffset - this.interpDelayMs;
  }

  /** The interpolation buffer this client is currently holding, ms. */
  get interpDelayMs(): number {
    return this.delay.delayMs;
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
