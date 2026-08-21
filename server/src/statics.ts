// Production statics: the one Node process serves the built client alongside
// the ws rooms (PLAN.md → Hosting). In dev there is no client/dist — vite
// serves the client — so the handler is simply absent.

import { createReadStream, existsSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DIST_DIR = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../client/dist",
);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

export type StaticHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => boolean;

/**
 * A request handler over `distDir`, or null when no build exists there
 * (dev mode). Returns false for requests it doesn't serve.
 */
export function createStaticHandler(distDir = DIST_DIR): StaticHandler | null {
  if (!existsSync(join(distDir, "index.html"))) return null;

  return (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") return false;
    const url = (req.url ?? "/").split("?")[0] ?? "/";
    // Pathless routes fall back to the app shell; files are served verbatim.
    const rel = extname(url) === "" ? "index.html" : normalize(url).slice(1);
    const file = resolve(distDir, rel);
    if (!file.startsWith(distDir) || !existsSync(file)) return false;

    res.writeHead(200, {
      "content-type": MIME[extname(file)] ?? "application/octet-stream",
    });
    createReadStream(file).pipe(res);
    return true;
  };
}
