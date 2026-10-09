// B3 tactics, the pure half (server/src/bottactics.ts): tactic selection is
// a function of the situation and nothing else, a pincer puts its two
// attackers on distinct sides and keeps them there, and the skill scaler is
// bounded with hysteresis.

import { BOT_STYLES, botStyle } from "@angels-bandits/common/botstyle";
import {
  BOT_BREAK_MAX_MS,
  BOT_SKILL_JITTER_NOVICE,
  BOT_SKILL_JITTER_VETERAN,
  BOT_SKILL_REACTION_NOVICE,
  BOT_SKILL_REACTION_VETERAN,
} from "@angels-bandits/common/constants";
import { describe, expect, it } from "vitest";
import {
  SkillScaler,
  type TacticSituation,
  breakThresholds,
  chooseTactic,
  pincerOffset,
  pincerSides,
} from "../src/bottactics";

/** A healthy wingman level with its target, nobody behind it. */
const BASE: TacticSituation = {
  style: "wingman",
  hp: 1,
  breaking: false,
  breakingFor: 0,
  above: 0,
  onSix: false,
  pincerSide: 0,
  boss: false,
  boomReady: true,
  skill: 0,
};

const at = (s: Partial<TacticSituation>) => chooseTactic({ ...BASE, ...s });

describe("chooseTactic: a pure function of the situation", () => {
  it("returns the same tactic for the same situation, and never mutates it", () => {
    const cases: TacticSituation[] = [];
    for (const style of BOT_STYLES) {
      for (const hp of [0.1, 0.4, 0.75, 1]) {
        for (const breaking of [false, true]) {
          for (const above of [-50, 0, 40]) {
            for (const onSix of [false, true]) {
              for (const pincerSide of [-1, 0, 1] as const) {
                cases.push({
                  ...BASE,
                  style,
                  hp,
                  breaking,
                  breakingFor: breaking ? 5000 : 0,
                  above,
                  onSix,
                  pincerSide,
                });
              }
            }
          }
        }
      }
    }
    for (const c of cases) {
      const frozen = Object.freeze({ ...c });
      const first = chooseTactic(frozen);
      // Interleave other calls: no hidden state carries between them.
      chooseTactic({ ...BASE, hp: 0.05 });
      chooseTactic({ ...BASE, onSix: true });
      expect(chooseTactic(frozen)).toBe(first);
      expect(frozen).toEqual(c);
    }
  });

  it("follows its precedence table", () => {
    // Defend a contact on the six — even hurt.
    expect(at({ onSix: true })).toBe("defend");
    expect(at({ onSix: true, hp: 0.05 })).toBe("defend");
    // Hurt: break off.
    expect(at({ hp: 0.2 })).toBe("breakOff");
    // The boss is always a straight attack.
    expect(at({ boss: true, above: 80, pincerSide: 1 })).toBe("turnFight");
    // Height over the target: boom-and-zoom (once ready).
    expect(at({ above: 40 })).toBe("boomZoom");
    expect(at({ above: 40, boomReady: false })).toBe("turnFight");
    expect(at({ above: 20 })).toBe("turnFight");
    // A partner on the same target: pincer; boom outranks it.
    expect(at({ pincerSide: -1 })).toBe("pincer");
    expect(at({ pincerSide: 1, above: 40 })).toBe("boomZoom");
    // Otherwise the turn fight.
    expect(at({})).toBe("turnFight");
  });

  it("breaks off with hysteresis: out below breakHp, back only above returnHp", () => {
    for (const style of BOT_STYLES) {
      const { breakHp, returnHp } = breakThresholds(style, 0);
      expect(returnHp).toBeGreaterThan(breakHp);
      const mid = (breakHp + returnHp) / 2;
      const s = { ...BASE, style };
      // Fighting at `mid`: keep fighting. Broken off at `mid`: stay out.
      expect(chooseTactic({ ...s, hp: mid })).not.toBe("breakOff");
      expect(chooseTactic({ ...s, hp: mid, breaking: true })).toBe("breakOff");
      expect(chooseTactic({ ...s, hp: breakHp - 0.01 })).toBe("breakOff");
      expect(
        chooseTactic({ ...s, hp: returnHp + 0.01, breaking: true }),
      ).not.toBe("breakOff");
      // …and never longer than BOT_BREAK_MAX_MS, whatever the HP.
      expect(
        chooseTactic({
          ...s,
          hp: 0.05,
          breaking: true,
          breakingFor: BOT_BREAK_MAX_MS,
        }),
      ).not.toBe("breakOff");
    }
  });

  it("leaves a novice's fight sooner and presses a veteran harder", () => {
    const novice = breakThresholds("wingman", -1);
    const neutral = breakThresholds("wingman", 0);
    const veteran = breakThresholds("wingman", 1);
    expect(novice.breakHp).toBeGreaterThan(neutral.breakHp);
    expect(veteran.breakHp).toBeLessThan(neutral.breakHp);
  });
});

describe("botStyle: seeded per callsign", () => {
  it("is a pure function of the callsign number, and deals all three styles per block", () => {
    for (let block = 0; block < 4; block++) {
      const styles = [1, 2, 3].map((k) => botStyle(block * 3 + k));
      expect(new Set(styles).size).toBe(3);
      expect([1, 2, 3].map((k) => botStyle(block * 3 + k))).toEqual(styles);
    }
  });
});

describe("pincerSides: two attackers on one target", () => {
  const target = {
    pos: { x: 1000, y: 60, z: 1000 },
    vel: { x: 70, y: 0, z: 0 },
  };

  it("assigns distinct sides — each the side it is already on", () => {
    // Target flying +x; one attacker to each side of its track.
    const sides = pincerSides(target, [
      { id: "a", pos: { x: 800, y: 60, z: 900 } },
      { id: "b", pos: { x: 800, y: 60, z: 1100 } },
    ]);
    expect(new Set(sides.values())).toEqual(new Set([-1, 1]));
    // The +1 side is the one pincerOffset swings toward: the side `b` is on.
    const off = pincerOffset(target.vel, sides.get("b") ?? 0, 600, 120, 200);
    expect(off.z).toBeGreaterThan(0);
    expect(
      pincerOffset(target.vel, sides.get("a") ?? 0, 600, 120, 200).z,
    ).toBeLessThan(0);
  });

  it("splits two attackers that start on the SAME side, across the torus seam too", () => {
    const seam = {
      pos: { x: 10, y: 60, z: 1990 },
      vel: { x: 0, y: 0, z: -60 },
    };
    const sides = pincerSides(seam, [
      { id: "a", pos: { x: 1950, y: 60, z: 30 } },
      { id: "b", pos: { x: 1900, y: 60, z: 80 } },
    ]);
    expect(sides.get("a")).not.toBe(sides.get("b"));
  });

  it("keeps its assignment when the attackers cross over (stable)", () => {
    const first = pincerSides(target, [
      { id: "a", pos: { x: 800, y: 60, z: 900 } },
      { id: "b", pos: { x: 800, y: 60, z: 1100 } },
    ]);
    // Swapped positions next tick: the previous sides stand.
    const next = pincerSides(
      target,
      [
        { id: "a", pos: { x: 800, y: 60, z: 1100 } },
        { id: "b", pos: { x: 800, y: 60, z: 900 } },
      ],
      first,
    );
    expect(next).toEqual(first);
  });

  it("has no pincer for a lone attacker, and uses both sides for three", () => {
    expect(
      pincerSides(target, [{ id: "a", pos: { x: 800, y: 60, z: 900 } }]).size,
    ).toBe(0);
    const three = pincerSides(target, [
      { id: "a", pos: { x: 800, y: 60, z: 900 } },
      { id: "b", pos: { x: 800, y: 60, z: 950 } },
      { id: "c", pos: { x: 800, y: 60, z: 1100 } },
    ]);
    expect(new Set(three.values())).toEqual(new Set([-1, 1]));
  });

  it("converges: no offset inside the near range", () => {
    const off = pincerOffset(target.vel, 1, 150, 120, 200);
    expect(Math.hypot(off.x, off.z)).toBe(0);
  });
});

describe("SkillScaler: bounded, with hysteresis", () => {
  it("saturates at the ends and never leaves its bounds", () => {
    const s = new SkillScaler();
    for (let i = 0; i < 200; i++) s.noteOutcome("novice", false);
    for (let i = 0; i < 200; i++) s.noteOutcome("veteran", true);
    expect(s.levelOf("novice")).toBe(-1);
    expect(s.levelOf("veteran")).toBe(1);
    expect(s.jitterScale("novice")).toBeCloseTo(BOT_SKILL_JITTER_NOVICE);
    expect(s.jitterScale("veteran")).toBeCloseTo(BOT_SKILL_JITTER_VETERAN);
    expect(s.reactionScale("novice")).toBeCloseTo(BOT_SKILL_REACTION_NOVICE);
    expect(s.reactionScale("veteran")).toBeCloseTo(BOT_SKILL_REACTION_VETERAN);
    // A long seeded random walk stays inside the bounds every step.
    let x = 12345;
    const rand = () => {
      x = (x * 1103515245 + 12345) % 2147483648;
      return x / 2147483648;
    };
    const lo = Math.min(BOT_SKILL_JITTER_NOVICE, BOT_SKILL_JITTER_VETERAN);
    const hi = Math.max(BOT_SKILL_JITTER_NOVICE, BOT_SKILL_JITTER_VETERAN);
    for (let i = 0; i < 5000; i++) {
      s.noteOutcome("walker", rand() < 0.5);
      expect(Math.abs(s.levelOf("walker"))).toBeLessThanOrEqual(1);
      expect(s.jitterScale("walker")).toBeGreaterThanOrEqual(lo);
      expect(s.jitterScale("walker")).toBeLessThanOrEqual(hi);
    }
    // Unknown pilots (and bots) are neutral.
    expect(s.levelOf("nobody")).toBe(0);
    expect(s.jitterScale("nobody")).toBe(1);
  });

  it("does not move on a single outcome from neutral (the deadband)", () => {
    const s = new SkillScaler();
    s.noteOutcome("p", true);
    expect(s.levelOf("p")).toBe(0);
    s.noteOutcome("q", false);
    expect(s.levelOf("q")).toBe(0);
  });

  it("does not flip-flop: one opposite outcome at a limit leaves the level there", () => {
    const s = new SkillScaler();
    for (let i = 0; i < 30; i++) s.noteOutcome("p", false);
    expect(s.levelOf("p")).toBe(-1);
    s.noteOutcome("p", true);
    expect(s.levelOf("p")).toBe(-1);
    for (let i = 0; i < 30; i++) s.noteOutcome("v", true);
    expect(s.levelOf("v")).toBe(1);
    s.noteOutcome("v", false);
    expect(s.levelOf("v")).toBe(1);
  });

  it("forgets a pilot who leaves", () => {
    const s = new SkillScaler();
    for (let i = 0; i < 30; i++) s.noteOutcome("p", false);
    s.forget("p");
    expect(s.levelOf("p")).toBe(0);
    s.noteOutcome("p", true);
    expect(s.levelOf("p")).toBe(0);
  });
});
