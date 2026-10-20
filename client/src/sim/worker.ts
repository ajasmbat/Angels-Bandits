// SOLO: the sim worker — the whole game server (server/src/host.ts) running
// in the player's browser, off the main thread. The page (./local.ts) opens
// connections into it the way it opened a ws: the host sees each as a
// Transport and speaks the unchanged wire protocol, and every frame comes
// back as UTF-8 bytes whose buffer is TRANSFERRED, never copied, when it is
// the frame's own (every snapshot is). The tick is the host's own
// drift-corrected loop, on this worker's timers; a pause stops it and
// freezes the host clock.
//
// DS1: and the debris is physical here. Rapier's WASM loads before the
// host is built (messages that arrive meanwhile wait their turn), each room
// gets a DebrisPhysics, and every tick's pose frame goes to the page as one
// transferred Float32Array (`poses`). `?sim=AB_PHYSICS:0` turns it off (the
// closed-form collapses, as multiplayer has them).

import {
  DebrisPhysics,
  PHYS_BUDGET,
  initDebrisPhysics,
} from "@angels-bandits/server/debris-physics";
import {
  type GameHost,
  type Transport,
  createGameHost,
} from "@angels-bandits/server/host";
import { hostOptionsFromEnv } from "@angels-bandits/server/host-options";
import type { FromWorker, ToWorker } from "./protocol";

/** The dedicated worker's scope, as far as this file uses it (the client
 * compiles against the DOM lib, which has no worker globals). */
const scope = self as unknown as {
  postMessage(msg: FromWorker, transfer?: Transferable[]): void;
  addEventListener(type: "message", fn: (ev: MessageEvent) => void): void;
};

const post = (msg: FromWorker, transfer?: Transferable[]): void =>
  scope.postMessage(msg, transfer);

let host: GameHost | null = null;
/** Each live connection's own close handler and message handler. */
const links = new Map<
  number,
  { message: (text: string) => void; closed: () => void }
>();

/** Connection `id` as the host's Transport. */
function transport(id: number): Transport {
  let open = true;
  let message: (text: string) => void = () => {};
  let closed: () => void = () => {};
  const end = (code: number, reason: string): void => {
    if (!open) return;
    open = false;
    links.delete(id);
    post({ t: "close", id, code, reason });
    // A ws reports its close on a later turn; so does this.
    setTimeout(closed, 0);
  };
  links.set(id, {
    message: (text) => message(text),
    closed: () => {
      if (!open) return;
      open = false;
      links.delete(id);
      closed();
    },
  });
  return {
    get open() {
      return open;
    },
    send(frame, own) {
      if (!open) return;
      // Hand the buffer over when it is exactly this frame's; a broadcast's
      // shared bytes are copied (the host reuses them for other members).
      const whole =
        own &&
        frame.byteOffset === 0 &&
        frame.byteLength === frame.buffer.byteLength;
      const data = (whole ? frame.buffer : frame.slice().buffer) as ArrayBuffer;
      post({ t: "frame", id, data }, [data]);
    },
    close: (code, reason) => end(code, reason),
    terminate: () => end(1006, ""),
    onMessage(handler) {
      message = handler;
    },
    onClose(handler) {
      closed = handler;
    },
  };
}

/**
 * The host's wall clock: Date.now, or (QA, `sim` AB_EPOCH_MS — what
 * tools/perf/fixed-epoch.mjs did to a Node server) one that starts at that
 * epoch and runs at real speed, so two builds show the same world at the
 * same server time.
 */
function clockFor(env: Record<string, string>): () => number {
  const epoch = Number(env.AB_EPOCH_MS);
  if (!Number.isFinite(epoch) || epoch <= 0) return Date.now;
  const start = Date.now();
  return () => epoch + (Date.now() - start);
}

/** Every message waits for the one before it (the host is built after
 * Rapier loads, asynchronously). */
let queue: Promise<void> = Promise.resolve();

scope.addEventListener("message", (ev: MessageEvent) => {
  const msg = ev.data as ToWorker;
  queue = queue.then(() => handle(msg));
});

/** Build the host from the page's `?sim=` pairs, with debris physics
 * unless they turn it off (or Rapier will not load). */
async function build(env: Record<string, string>): Promise<GameHost> {
  let physics = env.AB_PHYSICS !== "0";
  if (physics) {
    try {
      await initDebrisPhysics();
    } catch (err) {
      console.error("sim worker: no debris physics:", err);
      physics = false;
    }
  }
  return createGameHost({
    ...hostOptionsFromEnv(env),
    // Only ever one player here: the game is theirs to pause.
    pausable: true,
    clock: clockFor(env),
    debrisPhysics: physics
      ? (room) => new DebrisPhysics(room, undefined, { governed: true })
      : null,
    onPhysicsFrame: (f) => {
      const transfer: Transferable[] = [f.data.buffer as ArrayBuffer];
      if (f.heaps) transfer.push(f.heaps.buffer as ArrayBuffer);
      post(
        { t: "poses", at: f.t, epoch: f.epoch, data: f.data, heaps: f.heaps },
        transfer,
      );
    },
  });
}

async function handle(msg: ToWorker): Promise<void> {
  try {
    switch (msg.t) {
      case "init":
        if (host) return;
        host = await build(msg.env);
        host.start();
        return;
      case "view":
        host?.setPhysicsView({
          x: msg.x,
          z: msg.z,
          budget: PHYS_BUDGET[msg.tier] ?? PHYS_BUDGET.high,
        });
        return;
      case "open":
        if (!host) throw new Error("the sim worker has no host yet");
        host.connect(transport(msg.id));
        post({ t: "open", id: msg.id });
        return;
      case "send":
        links.get(msg.id)?.message(msg.text);
        return;
      case "close":
        links.get(msg.id)?.closed();
        return;
      case "pause":
        host?.setPaused(msg.on);
        return;
      case "stats":
        post({
          t: "stats",
          report: host?.tickReport(msg.reset) ?? null,
          at: performance.now(),
        });
        return;
    }
  } catch (err) {
    console.error("sim worker:", err);
    post({ t: "error", message: err instanceof Error ? err.message : "" });
  }
}
