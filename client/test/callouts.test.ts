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
