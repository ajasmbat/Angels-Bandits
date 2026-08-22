// BotBar seam: the shared bot-count control's pure state, with no DOM in
// sight (ui/scoreboard.ts renders it, main.ts wires it to the socket).
//
// The load-bearing rule is that the SERVER owns the value: a drag may preview
// locally while the pointer is down, but the moment it is released the bar
// shows the last value the server confirmed until a botsConfig says otherwise.
// A rate-limited claim is never echoed, so that snap-back IS the feedback.
// Spec literals here (0–11 range, 300 ms drag throttle) come from the ticket.

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

  it("previews a drag locally but sends at most one claim per 300 ms", () => {
    const bar = new BotBar(5);
    const sent: number[] = [];
    bar.onClaim = (count) => sent.push(count);

    bar.dragTo(7, 0);
    // The pointer is down: the bar follows the finger even though the server
    // has not agreed yet — that is what makes dragging feel attached.
    expect(bar.displayed).toBe(7);
    expect(sent).toEqual([7]);

    // Two more notches inside the same 300 ms window: previewed, not sent.
    bar.dragTo(8, 100);
    bar.dragTo(9, 250);
    expect(bar.displayed).toBe(9);
    expect(sent).toEqual([7]);

    // Past the window, the next notch goes out.
    bar.dragTo(10, 400);
    expect(sent).toEqual([7, 10]);
  });

  it("always sends the released value, even inside the throttle window", () => {
    // The one claim that must land: throttled drag samples are disposable,
    // the value the player let go on is not.
    const bar = new BotBar(5);
    const sent: number[] = [];
    bar.onClaim = (count) => sent.push(count);

    bar.dragTo(7, 0);
    bar.dragTo(8, 50);
    bar.release(60);
    expect(sent).toEqual([7, 8]);
  });

  it("does not re-send a release that matches the last claim", () => {
    const bar = new BotBar(5);
    const sent: number[] = [];
    bar.onClaim = (count) => sent.push(count);

    bar.dragTo(7, 0);
    bar.release(10);
    expect(sent).toEqual([7]);
  });

  it("snaps back to the server's value on release until botsConfig lands", () => {
    const bar = new BotBar(5);
    bar.onClaim = () => {};

    bar.dragTo(2, 0);
    expect(bar.displayed).toBe(2);
    bar.release(10);
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

    bar.dragTo(9, 0);
    bar.applyServer(1, "Viper");
    // Someone else moved it while this player is dragging: the attribution
    // updates, but the finger stays in charge of what is drawn.
    expect(bar.attribution).toBe("Viper set bots to 1");
    expect(bar.displayed).toBe(9);
    // On release the bar rejoins the room at the server's value.
    bar.release(10);
    expect(bar.displayed).toBe(1);
  });

  it("clamps a notch outside the 0–11 range rather than sending it", () => {
    const bar = new BotBar(5);
    const sent: number[] = [];
    bar.onClaim = (count) => sent.push(count);

    bar.dragTo(99, 0);
    expect(bar.displayed).toBe(11);
    bar.dragTo(-4, 1000);
    expect(bar.displayed).toBe(0);
    expect(sent).toEqual([11, 0]);
  });

  it("has no attribution line until someone actually sets it", () => {
    const bar = new BotBar(5);
    expect(bar.attribution).toBeNull();
  });
});
