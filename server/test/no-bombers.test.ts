// W1: the C2 bomber formations ("the jets") are gone — from the shared
// model, the wire, the server, the client and its staging — while the
// far-off airliner lights (L10, scenery) stay. DT1's name for the carrier's
// own enemy aircraft, the "fighter-bomber", is not one of them. A source scan, so a bomber
// that creeps back in anywhere fails here rather than in a playtest.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SOURCES = ["common/src", "server/src", "client/src", "client/index.html"];

/** Every source file under `rel` (a file or a directory). */
function files(rel: string): string[] {
  const abs = join(ROOT, rel);
  if (!statSync(abs).isDirectory()) return [rel];
  return readdirSync(abs).flatMap((name) => files(join(rel, name)));
}

describe("no bombers anywhere (W1)", () => {
  it("no source file names a bomber, its formation, its slot, its wire messages or its hit claim", () => {
    const hits: string[] = [];
    for (const f of SOURCES.flatMap(files)) {
      const lines = readFileSync(join(ROOT, f), "utf8").split("\n");
      lines.forEach((line, i) => {
        const text = line.replace(/fighter-bombers?/gi, "");
        if (/bomber|bombsOff|BombsOff/i.test(text)) {
          hits.push(`${f}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(hits).toEqual([]);
  });

  it("the airliners' nav lights on the sky dome stay, as scenery", () => {
    expect(
      statSync(join(ROOT, "client/src/render/airliners.ts")).isFile(),
    ).toBe(true);
  });
});
