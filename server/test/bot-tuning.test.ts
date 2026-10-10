// F10 guard: the players' roll feel (fast roll, held bank, bank-and-pull,
// knife-edge sink) is DEFAULT_TUNING, and stepFlight's tuning parameter
// defaults to it — so a bot step that forgot BOT_TUNING would quietly fly
// the players' model. Every stepFlight call in the server goes through
// bots.ts botStep (or names its tuning).

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "..", "src");

describe("F10 bots fly BOT_TUNING", () => {
  it("every stepFlight( call in server/src passes a tuning", () => {
    const offenders: string[] = [];
    for (const file of readdirSync(SRC).filter((f) => f.endsWith(".ts"))) {
      const text = readFileSync(join(SRC, file), "utf8");
      const re = /stepFlight\(([^;]*?)\)\s*;?\n/g;
      for (let m = re.exec(text); m !== null; m = re.exec(text)) {
        const args = m[1] as string;
        // The comments that name the function in prose are not calls.
        if (!args.includes(",")) continue;
        if (!/BOT_TUNING|tuning/i.test(args))
          offenders.push(`${file}: ${m[0].trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("bots.ts steps through botStep, on BOT_TUNING", () => {
    const text = readFileSync(join(SRC, "bots.ts"), "utf8");
    expect(text).toMatch(
      /function botStep\([^)]*\)[^{]*\{\s*return stepFlight\([^)]*BOT_TUNING\)/,
    );
    expect((text.match(/botStep\(/g) ?? []).length).toBeGreaterThan(5);
  });
});
