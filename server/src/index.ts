// The Angels & Bandits Node shell: one process serving /healthz, the built
// client statics (production), and — behind the client's hidden `?mp=1` —
// the ws presence rooms. SOLO: the room simulation itself is the GameHost
// (./host.ts), which the browser also runs in its sim worker; this file is
// only the Node plumbing around it — the environment, HTTP and ws.

import { createServer } from "node:http";
import { type WebSocket, WebSocketServer } from "ws";
import { type Transport, createGameHost } from "./host";
import { hostOptionsFromEnv } from "./host-options";
import { createStaticHandler } from "./statics";

const PORT = Number(process.env.PORT ?? 8080);

/** Test-only introspection of the per-room maps (`GET /debug/rooms`). */
const DEBUG_ROOMS = process.env.AB_DEBUG_ROOMS === "1";

/** A2: `process.memoryUsage()` after a full GC when node exposes one. */
const memoryAfterGc = (): NodeJS.MemoryUsage => {
  (globalThis as { gc?: () => void }).gc?.();
  return process.memoryUsage();
};

// Every timing override and AB_* switch the host knows (./host-options.ts):
// the env names the tests and harnesses have always set.
const options = hostOptionsFromEnv(process.env);
if (options.quietCity && process.env.NODE_ENV === "production") {
  console.error(
    "AB_QUIET_CITY=1 is a perf-harness switch: refusing to run in production",
  );
  process.exit(1);
}
if (options.quietCity) {
  console.warn(
    "!! AB_QUIET_CITY=1: destruction and boss raids are OFF in every room (perf harness only)",
  );
}

const host = createGameHost(options);

// --- HTTP: health + production statics ---
const statics = createStaticHandler();
const server = createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (DEBUG_ROOMS && req.url === "/debug/rooms") {
    res.writeHead(200, { "content-type": "application/json" });
    // A2: the soak's server samples — memory after a forced GC (when run
    // with --expose-gc) beside the host's per-room maps and damage.
    res.end(JSON.stringify({ ...host.debugRooms(), memory: memoryAfterGc() }));
    return;
  }
  if (req.url?.startsWith("/debug/tick")) {
    const report = host.tickReport(req.url.endsWith("?reset=1"));
    if (report) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(report));
      return;
    }
  }
  if (statics?.(req, res)) return;
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});

/** A ws socket as the host's Transport. Frames go out as TEXT frames: the
 * host hands over UTF-8 bytes, encoded once per broadcast (A1). */
function wsTransport(ws: WebSocket): Transport {
  return {
    get open() {
      return ws.readyState === ws.OPEN;
    },
    send: (frame) => ws.send(frame, { binary: false }),
    close: (code, reason) => ws.close(code, reason),
    terminate: () => ws.terminate(),
    onMessage: (handler) => ws.on("message", (data) => handler(String(data))),
    onClose: (handler) => ws.on("close", handler),
  };
}

// --- WebSocket rooms ---
const wss = new WebSocketServer({ server, maxPayload: 16 * 1024 });
wss.on("connection", (ws) => {
  host.connect(wsTransport(ws));
  ws.on("error", () => ws.terminate());
});

host.start();

server.listen(PORT, () => {
  // The bound address, not PORT: with PORT=0 the OS picks one, and tests read
  // the real number back off this line.
  const addr = server.address();
  const bound = typeof addr === "object" && addr ? addr.port : PORT;
  console.log(
    `angels-bandits server listening on :${bound} (statics: ${statics ? "client/dist" : "dev — use vite"})`,
  );
});
