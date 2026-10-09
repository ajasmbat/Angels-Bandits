// S1: the pure headline + leader model behind the jumbotrons and tickers.
// Pins determinism (two clients fed the same broadcast print the same
// words) and the name guard (free-text names never reach a world screen).

import { LANDMARK_BLOCKS, PLAZA_BLOCKS } from "@angels-bandits/common/city";
import { RIVER_CENTER_Z } from "@angels-bandits/common/city/river";
import { BLOCK_PITCH } from "@angels-bandits/common/constants";
import type { ScoreEntry } from "@angels-bandits/common/protocol";
import { CLEAR_WEATHER, type Weather } from "@angels-bandits/common/weather";
import { describe, expect, it } from "vitest";
import {
  ALIAS_WORDS,
  type HeadlineDeath,
  LANDMARK_NAMES,
  PLAZA_NAMES,
  type PilotInfo,
  feedLine,
  killHeadline,
  pilotAlias,
  pilotLabel,
  placePhrase,
  replaySubject,
  stormWarning,
  topPilot,
} from "../src/game/headlines";

const roster = new Map<string, PilotInfo>([
  ["b3", { name: "BANDIT-3", isBot: true }],
  ["b7", { name: "BANDIT-7", isBot: true }],
  ["h1", { name: "xXFragLord69Xx", isBot: false }],
  ["h2", { name: "BANDIT-9", isBot: false }], // a human squatting a callsign
  ["spoof", { name: "BANDIT-4 lol", isBot: true }],
]);
const label = (id: string) => pilotLabel(id, roster.get(id));

const blockCenter = (bx: number, bz: number) => ({
  x: bx * BLOCK_PITCH + BLOCK_PITCH / 2,
  z: bz * BLOCK_PITCH + BLOCK_PITCH / 2,
});
const [lx, lz] = LANDMARK_BLOCKS[0] as readonly [number, number];
const [px, pz] = PLAZA_BLOCKS[0] as readonly [number, number];

describe("pilot labels (the name guard)", () => {
  it("shows a bot's callsign only when the guard passes it", () => {
    expect(label("b3")).toBe("BANDIT-3");
    expect(label("spoof")).toBe(pilotAlias("spoof"));
  });

  it("never shows a human's free-text name, even one shaped like a callsign", () => {
    expect(label("h1")).toBe(pilotAlias("h1"));
    expect(label("h1")).not.toContain("Frag");
    expect(label("h2")).toBe(pilotAlias("h2"));
  });

  it("gives unknown ids the same alias every time", () => {
    expect(pilotLabel("gone", undefined)).toBe(pilotAlias("gone"));
    expect(pilotAlias("gone")).toBe(pilotAlias("gone"));
  });

  it("aliases are a fixed word and two digits, never a bot callsign", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const a = pilotAlias(`player-${i}-${(i * 7919).toString(36)}`);
      const [word, digits] = a.split("-");
      expect(ALIAS_WORDS).toContain(word);
      expect(digits).toMatch(/^\d{2}$/);
      expect(a).not.toMatch(/^BANDIT-\d+$/);
      seen.add(a);
    }
    expect(seen.size).toBeGreaterThan(200); // spread, not a handful
  });
});

describe("topPilot (the leader model)", () => {
  const s = (id: string, kills: number, deaths: number): ScoreEntry => ({
    id,
    kills,
    deaths,
  });

  it("is nobody until somebody has a kill", () => {
    expect(topPilot([])).toBeNull();
    expect(topPilot([s("a", 0, 3), s("b", 0, 0)])).toBeNull();
  });

  it("ranks kills, then fewest deaths, then the lower id", () => {
    expect(topPilot([s("a", 2, 0), s("b", 3, 9)])?.id).toBe("b");
    expect(topPilot([s("a", 3, 2), s("b", 3, 1)])?.id).toBe("b");
    expect(topPilot([s("b", 3, 1), s("a", 3, 1)])?.id).toBe("a");
  });

  it("does not depend on the order the scores arrived in", () => {
    const scores = [s("c", 4, 2), s("a", 4, 2), s("b", 4, 1), s("d", 1, 0)];
    const leader = topPilot(scores)?.id;
    for (let r = 0; r < scores.length; r++) {
      const rotated = [...scores.slice(r), ...scores.slice(0, r)];
      expect(topPilot(rotated)?.id).toBe(leader);
      expect(topPilot([...rotated].reverse())?.id).toBe(leader);
    }
    expect(leader).toBe("b");
  });
});

describe("placePhrase", () => {
  it("names the landmark, the plaza and the river from the kill site", () => {
    const l = blockCenter(lx, lz);
    expect(placePhrase(l.x, l.z)).toBe(`OVER ${LANDMARK_NAMES[0]}`);
    const p = blockCenter(px, pz);
    expect(placePhrase(p.x, p.z)).toBe(`OVER ${PLAZA_NAMES[0]}`);
    expect(placePhrase(30, RIVER_CENTER_Z)).toBe("OVER THE RIVER");
  });

  it("is empty when the death carried no site", () => {
    expect(placePhrase(undefined, undefined)).toBe("");
  });

  it("names a place for every site on the map", () => {
    for (let x = 0; x < 2000; x += 97) {
      for (let z = 0; z < 2000; z += 89) {
        expect(placePhrase(x, z)).toMatch(/^(OVER|NEAR) [A-Z ]+$/);
      }
    }
  });
});

describe("killHeadline", () => {
  const river = { x: 30, z: RIVER_CENTER_Z };
  const shot: HeadlineDeath = {
    victimId: "h1",
    killerId: "b3",
    cause: "shot",
    ...river,
  };

  it("reads like the ticket's example", () => {
    expect(killHeadline(shot, label, 0)).toMatch(
      new RegExp(`^BANDIT-3 [A-Z ]+ ${pilotAlias("h1")} OVER THE RIVER$`),
    );
  });

  it("is identical for identical inputs (two clients, one kill)", () => {
    for (let n = 0; n < 20; n++) {
      expect(killHeadline({ ...shot }, label, n)).toBe(
        killHeadline(shot, (id) => pilotLabel(id, roster.get(id)), n),
      );
    }
  });

  it("rotates its verb from kill to kill without a client counter", () => {
    const lines = new Set(
      Array.from({ length: 12 }, (_, n) => killHeadline(shot, label, n)),
    );
    expect(lines.size).toBeGreaterThan(1);
  });

  it("covers storm, un-credited and credited crashes", () => {
    const storm = killHeadline(
      { victimId: "b7", killerId: null, cause: "storm" },
      label,
      0,
    );
    expect(storm).toMatch(/^[A-Z ]+ BANDIT-7$/);
    const wipeout = killHeadline(
      { victimId: "b7", killerId: null, cause: "crash" },
      label,
      0,
    );
    expect(wipeout).toMatch(/^BANDIT-7 [A-Z ]+$/);
    const forced = killHeadline(
      { victimId: "b7", killerId: "b3", cause: "crash" },
      label,
      0,
    );
    expect(forced).toMatch(/^BANDIT-3 [A-Z ]+ BANDIT-7$/);
    const wreck = killHeadline(
      { victimId: "b7", killerId: "b3", cause: "wreck" },
      label,
      0,
    );
    expect(wreck).toMatch(/^BANDIT-3 WRECK[A-Z ]* BANDIT-7$/);
  });

  it("is built only from guarded labels and fixed words", () => {
    const ids = [...roster.keys(), "gone"];
    for (const killer of [...ids, null]) {
      for (const victim of ids) {
        for (const cause of ["shot", "crash", "storm", "wreck"] as const) {
          const line = killHeadline(
            { victimId: victim, killerId: killer, cause, x: 500, z: 900 },
            label,
            3,
          );
          // Upper-case words, digits and hyphens only — no free text.
          expect(line).toMatch(/^[A-Z0-9 -]+$/);
          expect(line).not.toMatch(/Frag|lol/);
        }
      }
    }
  });
});

describe("feed lines and the LAST KILL subject", () => {
  it("feed lines use the guarded labels", () => {
    expect(
      feedLine({ victimId: "h1", killerId: "b3", cause: "shot" }, label),
    ).toBe(`BANDIT-3 ▸ ${pilotAlias("h1")}`);
    expect(
      feedLine({ victimId: "b7", killerId: null, cause: "storm" }, label),
    ).toBe("⚡ BANDIT-7");
  });

  it("shows the killer, or the downed plane when nobody gets credit", () => {
    expect(
      replaySubject({ victimId: "v", killerId: "k", cause: "shot" }),
    ).toEqual({ id: "k", caption: "LAST KILL" });
    expect(
      replaySubject({ victimId: "v", killerId: "k", cause: "crash" }).id,
    ).toBe("k");
    expect(
      replaySubject({ victimId: "v", killerId: null, cause: "crash" }),
    ).toEqual({ id: "v", caption: "WIPEOUT" });
    expect(
      replaySubject({ victimId: "v", killerId: "k", cause: "wreck" }),
    ).toEqual({ id: "k", caption: "LAST KILL" });
    expect(
      replaySubject({ victimId: "v", killerId: "k", cause: "storm" }),
    ).toEqual({ id: "v", caption: "STORM KILL" });
  });
});

describe("stormWarning", () => {
  const w = (phase: Weather["phase"], phaseT: number): Weather => ({
    ...CLEAR_WEATHER,
    phase,
    phaseT,
  });

  it("follows the shared weather, quiet in clear skies", () => {
    expect(stormWarning(w("clear", 0.5))).toBeNull();
    expect(stormWarning(w("drizzle", 0.2))).toBeNull();
    expect(stormWarning(w("drizzle", 0.8))?.kind).toBe("storm");
    expect(stormWarning(w("downpour", 0.1))?.text).toMatch(/LIGHTNING/);
    expect(stormWarning(w("clearing", 0.1))?.text).toBe("STORM CLEARING");
    expect(stormWarning(w("clearing", 0.9))).toBeNull();
  });

  it("never announces the hidden death ceiling", () => {
    for (const phase of ["drizzle", "downpour", "clearing"] as const) {
      const text = stormWarning(w(phase, 0.95))?.text ?? "";
      expect(text).not.toMatch(/LOW|ALTITUDE|CEILING|HIGH/);
    }
  });
});
