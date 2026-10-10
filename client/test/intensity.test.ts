// IntensityBar seam (W1; ANGE-6STDNN's BotBar before it): the shared enemy-
// intensity control's pure state, with no DOM in sight (ui/scoreboard.ts
// renders it, main.ts wires it to the socket).
//
// The load-bearing rule is that the SERVER owns the value: a drag may preview
// locally while the pointer is down, but the moment it is released the bar
// shows the last value the server confirmed until an intensityConfig says
// otherwise. A rate-limited claim is never echoed, so that snap-back IS the
// feedback. The 0–3 range is EASY–INSANE; one-claim-per-drag is what two-tab
// QA forced — see the note on the release path in ui/intensity.ts.

import { describe, expect, it } from "vitest";
import { IntensityBar } from "../src/ui/intensity";

describe("IntensityBar", () => {
  it("shows the server's value, and nothing of its own, before any drag", () => {
    const bar = new IntensityBar(1);
    expect(bar.displayed).toBe(1);
    bar.applyServer(3, "Viper");
    expect(bar.displayed).toBe(3);
    expect(bar.attribution).toBe("Viper set enemies to INSANE");
  });

  it("previews a whole drag locally and claims ONCE, on release", () => {
    // The server accepts one change per player per 3 s, so a claim sent
    // mid-drag would spend that budget on a notch the player was only
    // passing over — and the value they actually let go on would be the one
    // dropped. Exactly one claim per drag, and it is the released value.
    const bar = new IntensityBar(0);
    const sent: number[] = [];
    bar.onClaim = (level) => sent.push(level);

    bar.dragTo(1);
    // The pointer is down: the bar follows the finger even though the server
    // has not agreed yet — that is what makes dragging feel attached.
    expect(bar.displayed).toBe(1);
    bar.dragTo(2);
    bar.dragTo(3);
    expect(bar.displayed).toBe(3);
    expect(sent).toEqual([]);

    bar.release();
    expect(sent).toEqual([3]);
  });

  it("does not claim a release that already matches the server's value", () => {
    // Dragging back to where the room already is asks for no change — and
    // spending the rate limit on it would block the next real one.
    const bar = new IntensityBar(1);
    const sent: number[] = [];
    bar.onClaim = (level) => sent.push(level);

    bar.dragTo(3);
    bar.dragTo(1);
    bar.release();
    expect(sent).toEqual([]);
  });

  it("re-claims a value it claimed before if the room has moved since", () => {
    // The dedupe is against the SERVER's value, not this bar's history: a
    // player must be able to put it back to INSANE after someone else took
    // it away, or their bar would silently stay wrong.
    const bar = new IntensityBar(1);
    const sent: number[] = [];
    bar.onClaim = (level) => sent.push(level);

    bar.dragTo(3);
    bar.release();
    bar.applyServer(3, "Maverick");
    bar.applyServer(0, "Viper");

    bar.dragTo(3);
    bar.release();
    expect(sent).toEqual([3, 3]);
  });

  it("snaps back to the server's value on release until intensityConfig lands", () => {
    const bar = new IntensityBar(1);
    bar.onClaim = () => {};

    bar.dragTo(0);
    expect(bar.displayed).toBe(0);
    bar.release();
    // Released and unconfirmed: the bar is the server's again, not the
    // player's — a dropped (rate-limited) claim visibly rebounds to 1.
    expect(bar.displayed).toBe(1);

    // …and when the server does agree, the bar moves for real.
    bar.applyServer(0, "Maverick");
    expect(bar.displayed).toBe(0);
  });

  it("keeps another player's change visible mid-drag without stealing the grab", () => {
    const bar = new IntensityBar(1);
    bar.onClaim = () => {};

    bar.dragTo(3);
    bar.applyServer(2, "Viper");
    // Someone else moved it while this player is dragging: the attribution
    // updates, but the finger stays in charge of what is drawn.
    expect(bar.attribution).toBe("Viper set enemies to HARD");
    expect(bar.displayed).toBe(3);
    // On release the bar rejoins the room at the server's value.
    bar.release();
    expect(bar.displayed).toBe(2);
  });

  it("clamps a notch outside the 0–3 range rather than sending it", () => {
    const bar = new IntensityBar(1);
    const sent: number[] = [];
    bar.onClaim = (level) => sent.push(level);

    bar.dragTo(99);
    expect(bar.displayed).toBe(3);
    bar.release();
    bar.dragTo(-4);
    expect(bar.displayed).toBe(0);
    bar.release();
    expect(sent).toEqual([3, 0]);
  });

  it("has no attribution line until someone actually sets it", () => {
    const bar = new IntensityBar(1);
    expect(bar.attribution).toBeNull();
  });
});
