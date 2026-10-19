// SOLO: the sim worker (client/src/sim/worker.ts) carries the whole game
// server — server/src/host.ts and everything it reaches — into the
// browser. That only works while nothing on that path needs Node: one
// `node:` import (crypto, http, fs), `ws`, or a Buffer would build fine
// for the Node shell and break every player's game. This bundles the
// worker entry exactly as a browser gets it (esbuild, platform "browser",
// nothing external) and walks what went in.

import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

const entry = fileURLToPath(new URL("../src/sim/worker.ts", import.meta.url));

describe("the sim worker bundle", () => {
  it("bundles for the browser with the host inside and no Node import", async () => {
    const result = await build({
      entryPoints: [entry],
      bundle: true,
      write: false,
      metafile: true,
      platform: "browser",
      format: "esm",
      target: "es2022",
      logLevel: "silent",
    });
    expect(result.errors).toEqual([]);
    const inputs = Object.keys(result.metafile.inputs);
    // The game server really is in there — not a stub.
    expect(inputs.some((p) => p.endsWith("server/src/host.ts"))).toBe(true);
    expect(inputs.some((p) => p.endsWith("server/src/bots.ts"))).toBe(true);
    // Nothing from Node, nothing left for a runtime to resolve.
    const imported = Object.values(result.metafile.inputs).flatMap((i) =>
      i.imports.map((im) => im.path),
    );
    expect(imported.filter((p) => p.startsWith("node:"))).toEqual([]);
    expect(inputs.filter((p) => p.includes("node_modules/ws/"))).toEqual([]);
    for (const out of Object.values(result.metafile.outputs)) {
      expect(out.imports.filter((im) => im.external)).toEqual([]);
    }
    const code = result.outputFiles?.[0]?.text ?? "";
    expect(code).not.toMatch(/\bprocess\.env\b/);
    expect(code).not.toMatch(/\bBuffer\.from\(/);
  });
});
