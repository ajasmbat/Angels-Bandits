// Placeholder HTTP server — T3 adds the ws rooms on top of this process.
// One Node process will serve the static client and host WebSocket rooms.

import { createServer } from "node:http";
import { ROOM_CAP } from "@angels-bandits/common/constants";

const PORT = Number(process.env.PORT ?? 8080);

const server = createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});

server.listen(PORT, () => {
  console.log(
    `angels-bandits server listening on :${PORT} (room cap ${ROOM_CAP})`,
  );
});
