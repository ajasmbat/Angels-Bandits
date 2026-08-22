// BotBar seam: the shared bot-count control's pure state, with no DOM in
// sight (ui/scoreboard.ts renders it, main.ts wires it to the socket).
//
// The load-bearing rule is that the SERVER owns the value: a drag may preview
// locally while the pointer is down, but the moment it is released the bar
// shows the last value the server confirmed until a botsConfig says otherwise.
// A rate-limited claim is never echoed, so that snap-back IS the feedback.
// The 0–11 range is the ticket's; one-claim-per-drag is what two-tab QA
// forced — see the note on the release path in ui/botbar.ts.

import { describe, expect, it } from "vitest";
import { BotBar } from "../src/ui/botbar";

describe("BotBar", () => {
  it("shows the server's value, and nothing of its own, before any drag", () => {
    const bar = new BotBar(5);
    expect(bar.displayed).toBe(5);
    bar.applyServer(8, "Viper");
    expect(bar.displayed).toBe(8);
    expect(bar.attribution).toBe("Viper set bots to 8");
  });

  it("previews a whole drag locally and claims ONCE, on release", () => {
    // The server accepts one change per player per 3 s, so a claim sent
    // mid-drag would spend that budget on a notch the player was only
    // passing over — and the value they actually let go on would be the one
    // dropped. Exactly one claim per drag, and it is the released value.
    const bar = new BotBar(5);
    const sent: number[] = [];
    bar.onClaim = (count) => sent.push(count);

    bar.dragTo(7);
    // The pointer is down: the bar follows the finger even though the server
    // has not agreed yet — that is what makes dragging feel attached.
    expect(bar.displayed).toBe(7);
    bar.dragTo(8);
    bar.dragTo(9);
    expect(bar.displayed).toBe(9);
    expect(sent).toEqual([]);

    bar.release();
    expect(sent).toEqual([9]);
  });

  it("does not claim a release that already matches the server's value", () => {
    // Dragging back to where the room already is asks for no change — and
    // spending the rate limit on it would block the next real one.
    const bar = new BotBar(5);
    const sent: number[] = [];
    bar.onClaim = (count) => sent.push(count);

    bar.dragTo(9);
    bar.dragTo(5);
    bar.release();
    expect(sent).toEqual([]);
  });

  it("re-claims a value it claimed before if the room has moved since", () => {
    // The dedupe is against the SERVER's value, not this bar's history: a
    // player must be able to put it back to 9 after someone else took it
    // away, or their bar would silently stay wrong.
    const bar = new BotBar(5);
    const sent: number[] = [];
    bar.onClaim = (count) => sent.push(count);

    bar.dragTo(9);
    bar.release();
    bar.applyServer(9, "Maverick");
    bar.applyServer(2, "Viper");

    bar.dragTo(9);
    bar.release();
    expect(sent).toEqual([9, 9]);
  });

  it("snaps back to the server's value on release until botsConfig lands", () => {
    const bar = new BotBar(5);
    bar.onClaim = () => {};

    bar.dragTo(2);
    expect(bar.displayed).toBe(2);
    bar.release();
    // Released and unconfirmed: the bar is the server's again, not the
    // player's — a dropped (rate-limited) claim visibly rebounds to 5.
    expect(bar.displayed).toBe(5);

    // …and when the server does agree, the bar moves for real.
    bar.applyServer(2, "Maverick");
    expect(bar.displayed).toBe(2);
  });

  it("keeps another player's change visible mid-drag without stealing the grab", () => {
    const bar = new BotBar(5);
    bar.onClaim = () => {};

    bar.dragTo(9);
    bar.applyServer(1, "Viper");
    // Someone else moved it while this player is dragging: the attribution
    // updates, but the finger stays in charge of what is drawn.
    expect(bar.attribution).toBe("Viper set bots to 1");
    expect(bar.displayed).toBe(9);
    // On release the bar rejoins the room at the server's value.
    bar.release();
    expect(bar.displayed).toBe(1);
  });

  it("clamps a notch outside the 0–11 range rather than sending it", () => {
    const bar = new BotBar(5);
    const sent: number[] = [];
    bar.onClaim = (count) => sent.push(count);

    bar.dragTo(99);
    expect(bar.displayed).toBe(11);
    bar.release();
    bar.dragTo(-4);
    expect(bar.displayed).toBe(0);
    bar.release();
    expect(sent).toEqual([11, 0]);
  });

  it("has no attribution line until someone actually sets it", () => {
    const bar = new BotBar(5);
    expect(bar.attribution).toBeNull();
  });
});
