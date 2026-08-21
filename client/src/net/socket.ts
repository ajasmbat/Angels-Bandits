// GameSocket: the client's one connection to the presence server. Joins with
// a name, streams the local plane's pose up at TICK_UP_HZ, surfaces
// snapshots/join/leave events, and estimates the server clock so the render
// loop can sample interpolation buffers INTERP_DELAY_MS behind it.

import { INTERP_DELAY_MS, TICK_UP_HZ } from "@angels-bandits/common/constants";
import type {
  Pose,
  RosterEntry,
  ServerMsg,
  SnapshotMsg,
  WelcomeMsg,
} from "@angels-bandits/common/protocol";

export interface GameSocketEvents {
  onSnapshot?: (snap: SnapshotMsg) => void;
  onPlayerJoined?: (player: RosterEntry) => void;
  onPlayerLeft?: (id: string) => void;
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

  /**
   * The server-clock time remote planes should render at: estimated server
   * "now" minus the interpolation delay. Null until the first snapshot.
   */
  renderTime(): number | null {
    if (this.clockOffset === null) return null;
    return performance.now() + this.clockOffset - INTERP_DELAY_MS;
  }

  private handle(ev: MessageEvent): void {
    const msg = JSON.parse(ev.data as string) as ServerMsg;
    switch (msg.type) {
      case "snapshot": {
        // Each sample of serverTime − now is the true offset minus that
        // packet's latency, so the LARGEST sample is the best estimate; adapt
        // slowly downward to track drift or a route change.
        const sample = msg.time - performance.now();
        if (this.clockOffset === null || sample > this.clockOffset) {
          this.clockOffset = sample;
        } else {
          this.clockOffset += (sample - this.clockOffset) * 0.02;
        }
        this.events.onSnapshot?.(msg);
        break;
      }
      case "playerJoined":
        this.events.onPlayerJoined?.(msg.player);
        break;
      case "playerLeft":
        this.events.onPlayerLeft?.(msg.id);
        break;
      case "welcome":
        break; // already consumed by connect()
    }
  }
}
