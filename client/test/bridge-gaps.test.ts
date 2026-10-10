// D9 guard: a fallen bridge span is a hole in its deck, and the ground,
// river and sight-line tests only know it when handed the room's `gaps`
// (common/src/city/river.ts). A new caller that forgets it would silently
// collide with a deck nobody can see — so every call to hitsGround /
// riverHit / losClear in the client, the shared wreck sweep, the course
// sweep, the bots and the boss is scanned here: it passes a gaps argument,
// or it is on the allowlist below with its reason and its exact count. The
// allowlist cannot go stale (an entry matching fewer calls fails), and the
// bots' ONE gaps-passing call — the physics death check — cannot lose it.
// The W1 follow-up (gaps in the bot probes) is done when the bots.ts entry
// is empty.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../..");
/** The 0-based argument index of `gaps` per function. */
const GAPS_ARG: Record<string, number> = {
  hitsGround: 2,
  riverHit: 2,
  losClear: 3,
};

/** Calls that deliberately keep a fallen span solid, per file and function. */
const ALLOW: Record<string, { calls: Record<string, number>; why: string }> = {
  "server/src/bots.ts": {
    calls: { hitsGround: 9, losClear: 2 },
    why: "bot probes, rollouts and sight lines keep the deck (conservative: a gap is only avoided, never entered); the physics death check passes it — W1 follow-up",
  },
  "server/src/boss.ts": {
    calls: { losClear: 1 },
    why: "turret sight lines from the zeppelin's altitude; a deck gap changes nothing up there",
  },
  "common/src/boss.ts": {
    calls: { hitsGround: 1 },
    why: "a falling boss section's contact sweep: one landing over a gap rests on air (rare, visual only)",
  },
  "client/src/render/atmosphere-fx.ts": {
    calls: { losClear: 1 },
    why: "light-shaft occlusion: a visual test, never a collision",
  },
};

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** Every call of a scanned function in `src`: its name and argument count. */
function calls(src: string): { fn: string; args: number }[] {
  const out: { fn: string; args: number }[] = [];
  const re = /\b(hitsGround|riverHit|losClear)\(/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const fn = m[1] as string;
    const lineStart = src.lastIndexOf("\n", m.index) + 1;
    const line = src.slice(lineStart, m.index).trim();
    // Comments and the definitions themselves are not calls.
    if (line.startsWith("//") || line.startsWith("*")) continue;
    if (/function\s*$/.test(line)) continue;
    let depth = 0;
    let args = 0;
    let sawArg = false;
    for (let i = m.index + m[0].length - 1; i < src.length; i++) {
      const c = src[i];
      if (c === "(" || c === "[" || c === "{") {
        depth++;
        if (depth > 1) sawArg = true;
      } else if (c === ")" || c === "]" || c === "}") {
        depth--;
        if (depth === 0) break;
      } else if (c === "," && depth === 1) {
        args++;
        sawArg = false;
      } else if (depth === 1 && !/\s/.test(c as string)) {
        sawArg = true;
      }
    }
    out.push({ fn, args: args + (sawArg ? 1 : 0) });
  }
  return out;
}

describe("D9 bridge gaps reach every collision that kills or scores", () => {
  const files = [
    ...tsFiles(join(ROOT, "client/src")),
    join(ROOT, "common/src/wreck.ts"),
    join(ROOT, "server/src/courses.ts"),
    join(ROOT, "server/src/bots.ts"),
    join(ROOT, "server/src/boss.ts"),
    join(ROOT, "common/src/boss.ts"),
  ];
  const found = new Map<string, Record<string, number>>();
  const withGaps = new Map<string, Record<string, number>>();
  for (const file of files) {
    const rel = relative(ROOT, file).replaceAll("\\", "/");
    for (const c of calls(readFileSync(file, "utf8"))) {
      const bucket = c.args > (GAPS_ARG[c.fn] as number) ? withGaps : found;
      const rec = bucket.get(rel) ?? {};
      rec[c.fn] = (rec[c.fn] ?? 0) + 1;
      bucket.set(rel, rec);
    }
  }

  it("passes gaps everywhere but the allowlisted calls", () => {
    const missing: string[] = [];
    for (const [file, fns] of found) {
      for (const [fn, n] of Object.entries(fns)) {
        const allowed = ALLOW[file]?.calls[fn] ?? 0;
        if (n > allowed) {
          missing.push(
            `${file}: ${n - allowed} ${fn}() call(s) without the room's gaps — pass gapsOf(movers) (or the socket's gapMask), or allowlist it here with a reason`,
          );
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("has no stale allowlist entry, and every entry says why", () => {
    for (const [file, { calls: want, why }] of Object.entries(ALLOW)) {
      expect(why.length, file).toBeGreaterThan(10);
      for (const [fn, n] of Object.entries(want)) {
        expect(found.get(file)?.[fn] ?? 0, `${file} ${fn}`).toBe(n);
      }
    }
  });

  it("keeps the bots' physics death check on the gaps", () => {
    expect(withGaps.get("server/src/bots.ts")?.hitsGround).toBe(1);
    expect(withGaps.get("client/src/game/collision.ts")?.hitsGround).toBe(1);
    expect(withGaps.get("common/src/wreck.ts")?.hitsGround).toBe(1);
    expect(withGaps.get("server/src/courses.ts")?.hitsGround).toBe(1);
  });
});
