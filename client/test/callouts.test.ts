// Callout seam, part 1: the fixed event→callout builders and the VOICE
// NAME-GUARD (plan's named security constraint). Voiced text is built only
// from the fixed phrase bank plus bot callsigns that strictly match
// BANDIT-<n>; a free-text human name must never reach the voice string —
// only the ticker (which renders it inert via textContent, like the kill
// feed). Expected strings are the literal brevity calls from the plan.

import { describe, expect, it } from "vitest";
import {
  checkInCallout,
  hitCallout,
  maydayCallout,
  nearMissCallout,
  offStationCallout,
  ownKillCallout,
  splashCallout,
  threatCallout,
  threatOnSix,
} from "../src/game/callouts";

const HOSTILE = "BadWord123";

describe("callout builders", () => {
  it("voices a bot's kill as the fixed 'Splash one.' brevity call", () => {
    const c = splashCallout("BANDIT-3", true);
    expect(c.kind).toBe("kill");
    expect(c.voice).toBe("Splash one.");
    expect(c.speaker).toBe("BANDIT-3");
    expect(c.ticker).toBe("splash one");
  });

  it("voices own kill / death / hit / near-miss with the plan's fixed lines", () => {
    expect(ownKillCallout("ace").voice).toBe("Good kill, good kill.");
    expect(ownKillCallout("ace").kind).toBe("own");
    expect(maydayCallout("ace").voice).toBe("Mayday, mayday, going down.");
    expect(hitCallout("ace").voice).toBe("I'm hit, I'm hit.");
    expect(nearMissCallout("ace").voice).toBe("That was close.");
  });

  it("voices the threat warning at threat priority", () => {
    const c = threatCallout("ace");
    expect(c.kind).toBe("threat");
    expect(c.voice).toBe("Bandit on your six, break!");
  });

  it("speaks a valid bot callsign on check-in, but never a human name", () => {
    expect(checkInCallout("BANDIT-7", true).voice).toBe(
      "BANDIT-7, checking in.",
    );
    const human = checkInCallout(HOSTILE, false);
    expect(human.voice).toBe("New contact, checking in.");
    expect(human.speaker).toBe(HOSTILE); // ticker may show the real name
  });

  it("refuses to voice a bot-flagged name that is not a BANDIT-<n> callsign", () => {
    // A spoofed/nonstandard name must fail the strict pattern even with isBot.
    expect(checkInCallout(HOSTILE, true).voice).toBe(
      "New contact, checking in.",
    );
    expect(offStationCallout("BANDIT-12", true).voice).toBe(
      "BANDIT-12 off station.",
    );
    expect(offStationCallout(HOSTILE, true).voice).toBe("Contact off station.");
  });

  it("NAME-GUARD: no builder ever leaks a hostile name into voiced text", () => {
    const callouts = [
      splashCallout(HOSTILE, false),
      splashCallout(HOSTILE, true),
      ownKillCallout(HOSTILE),
      maydayCallout(HOSTILE),
      hitCallout(HOSTILE),
      nearMissCallout(HOSTILE),
      threatCallout(HOSTILE),
      checkInCallout(HOSTILE, false),
      checkInCallout(HOSTILE, true),
      offStationCallout(HOSTILE, false),
      offStationCallout(HOSTILE, true),
    ];
    for (const c of callouts) {
      expect(c.voice).not.toContain(HOSTILE);
    }
  });
});

// Threat geometry: attacker within 400 m, forward vector within 20° of the
// line attacker→you, AND aft of your 3-9 line. World yaw convention (see
// audio-spatial.test.ts): yaw 0 faces −Z, so "behind" a yaw-0 self is +Z.
describe("threatOnSix", () => {
  const SELF = { x: 1000, y: 300, z: 1000 };

  it("flags an attacker 200 m dead astern pointing at you", () => {
    const attacker = {
      pos: { x: 1000, y: 300, z: 1200 },
      fwd: { x: 0, y: 0, z: -1 },
    };
    expect(threatOnSix(SELF, 0, [attacker])).toBe(true);
  });

  it("ignores the same geometry ahead of the 3-9 line", () => {
    const attacker = {
      pos: { x: 1000, y: 300, z: 800 },
      fwd: { x: 0, y: 0, z: 1 }, // head-on, pointing straight at you
    };
    expect(threatOnSix(SELF, 0, [attacker])).toBe(false);
  });

  it("ignores an attacker astern who is pointing away", () => {
    const attacker = {
      pos: { x: 1000, y: 300, z: 1200 },
      fwd: { x: 0, y: 0, z: 1 },
    };
    expect(threatOnSix(SELF, 0, [attacker])).toBe(false);
  });

  it("ignores an aimed pursuer beyond 400 m", () => {
    const attacker = {
      pos: { x: 1000, y: 300, z: 1500 },
      fwd: { x: 0, y: 0, z: -1 },
    };
    expect(threatOnSix(SELF, 0, [attacker])).toBe(false);
  });

  it("ignores a pursuer aimed 30° off your tailpipe", () => {
    const off = (30 * Math.PI) / 180;
    const attacker = {
      pos: { x: 1000, y: 300, z: 1200 },
      fwd: { x: Math.sin(off), y: 0, z: -Math.cos(off) },
    };
    expect(threatOnSix(SELF, 0, [attacker])).toBe(false);
  });

  it("follows self yaw: facing east, a pursuer to the west is on your six", () => {
    // Yaw −π/2 faces +… east is +X (right turn decreases yaw from 0/north).
    const attacker = {
      pos: { x: 800, y: 300, z: 1000 }, // 200 m west = dead astern
      fwd: { x: 1, y: 0, z: 0 }, // flying east, at you
    };
    expect(threatOnSix(SELF, -Math.PI / 2, [attacker])).toBe(true);
  });

  it("sees across the torus seam: a pursuer 100 m astern through the wrap", () => {
    const self = { x: 1000, y: 300, z: 1950 }; // facing north (−Z)
    const attacker = {
      pos: { x: 1000, y: 300, z: 50 }, // behind you, across the z seam
      fwd: { x: 0, y: 0, z: -1 },
    };
    expect(threatOnSix(self, 0, [attacker])).toBe(true);
  });
});
