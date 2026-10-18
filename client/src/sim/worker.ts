// SOLO: the sim worker — the whole game server (server/src/host.ts) running
// in the player's browser, off the main thread. The page (./local.ts) opens
// connections into it the way it opened a ws: the host sees each as a
// Transport and speaks the unchanged wire protocol, and every frame comes
// back as UTF-8 bytes whose buffer is TRANSFERRED, never copied, when it is
// the frame's own (every snapshot is). The tick is the host's own
// drift-corrected loop, on this worker's timers; a pause stops it and
// freezes the host clock.

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

scope.addEventListener("message", (ev: MessageEvent) => {
  const msg = ev.data as ToWorker;
  try {
    switch (msg.t) {
      case "init":
        if (host) return;
        host = createGameHost({
          ...hostOptionsFromEnv(msg.env),
          // Only ever one player here: the game is theirs to pause.
          pausable: true,
        });
        host.start();
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
    }
  } catch (err) {
    console.error("sim worker:", err);
    post({ t: "error", message: err instanceof Error ? err.message : "" });
  }
});
