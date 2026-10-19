import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { type Plugin, defineConfig } from "vite";

/**
 * SOLO: emit the offline service worker (client/sw.template.js) as /sw.js,
 * stamped with this build's whole file list and a version derived from it —
 * every asset name is content-hashed, and index.html's own content is
 * hashed in, so any change to the build is a new version (a new cache).
 * The public/ files (manifest, icons) are listed too: vite copies them
 * outside the bundle, so they are read off disk here.
 */
function offlineServiceWorker(): Plugin {
  const template = readFileSync(
    new URL("./sw.template.js", import.meta.url),
    "utf8",
  );
  const publicFiles = [
    "manifest.webmanifest",
    "icons/icon.svg",
    "icons/icon-192.png",
    "icons/icon-512.png",
    "icons/apple-touch-icon.png",
  ];
  return {
    name: "ab-offline-sw",
    apply: "build",
    // After vite's own html plugin, so index.html is in the bundle.
    enforce: "post",
    generateBundle(_options, bundle) {
      const files = [...Object.keys(bundle), ...publicFiles].sort();
      const hash = createHash("sha256");
      for (const name of files) {
        hash.update(name);
        const out = bundle[name];
        if (name === "index.html" && out?.type === "asset") {
          hash.update(out.source);
        }
      }
      const config = {
        version: hash.digest("hex").slice(0, 16),
        files: files.map((f) => `./${f}`),
      };
      this.emitFile({
        type: "asset",
        fileName: "sw.js",
        source: `self.__AB_SW__ = ${JSON.stringify(config)};\n${template}`,
      });
    },
  };
}

// ES2022 (matches tsconfig.base) — the join flow uses top-level await, which
// vite's default lowest-common-denominator target refuses to build.
export default defineConfig({
  build: { target: "es2022" },
  // SOLO: the sim worker (client/src/sim/worker.ts) is an ES module worker.
  worker: { format: "es" },
  plugins: [offlineServiceWorker()],
});
