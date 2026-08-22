// The shared bot slider's WIRE contract (ANGE-6STDNN), driven over a real
// socket against a real server process: the welcome's botTarget, the setBots
// claim, and the botsConfig broadcast that answers it. The governance rules
// themselves are unit-tested at the Room seam (room.test.ts) — what is only
// observable here is that a JOINING client is told the current value and that
// a change reaches every member of the room, attributed.
//
// The server binds PORT=0 and this reads the real port off its startup line,
// so a stale dev server on 8080 can neither collide with these runs nor
// silently answer them.

import { type ChildProcess, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ServerMsg, WelcomeMsg } from "@angels-bandits/common/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));

let child: ChildProcess;
let url: string;

/** One joined player: its welcome plus every server message since. */
interface Peer {
  ws: WebSocket;
  welcome: WelcomeMsg;
  seen: ServerMsg[];
  /** Resolve once a message matching `match` arrives (or has already). */
  waitFor(
    match: (msg: ServerMsg) => boolean,
    label: string,
  ): Promise<ServerMsg>;
  /** Nothing matching `match` arrives within `ms` — the "dropped" assertion. */
  expectSilence(match: (msg: ServerMsg) => boolean, ms: number): Promise<void>;
}

function connect(name: string): Promise<Peer> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const seen: ServerMsg[] = [];
    const listeners = new Set<(msg: ServerMsg) => void>();
    ws.on("error", reject);
    ws.on("open", () => ws.send(JSON.stringify({ type: "join", name })));
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString()) as ServerMsg;
      seen.push(msg);
      for (const fn of listeners) fn(msg);
      if (msg.type === "welcome") {
        resolve({
          ws,
          welcome: msg,
          seen,
          waitFor: (match, label) =>
            new Promise((res, rej) => {
              const hit = seen.find(match);
              if (hit) return res(hit);
              const timer = setTimeout(() => {
                listeners.delete(fn);
                rej(new Error(`timed out waiting for ${label}`));
              }, 4000);
              const fn = (m: ServerMsg) => {
                if (!match(m)) return;
                clearTimeout(timer);
                listeners.delete(fn);
                res(m);
              };
              listeners.add(fn);
            }),
          expectSilence: (match, ms) =>
            new Promise((res, rej) => {
              const before = seen.filter(match).length;
              setTimeout(() => {
                const after = seen.filter(match).length;
                if (after > before) {
                  rej(new Error(`expected silence, got ${after - before}`));
                } else res();
              }, ms);
            }),
        });
      }
    });
  });
}

const isBotsConfig = (count: number, byName: string) => (msg: ServerMsg) =>
  msg.type === "botsConfig" && msg.count === count && msg.byName === byName;

const setBots = (peer: Peer, count: number): void => {
  peer.ws.send(JSON.stringify({ type: "setBots", count }));
};

beforeAll(async () => {
  child = spawn("npx", ["tsx", entry], {
    env: { ...process.env, PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("server never announced a port")),
      25000,
    );
    child.stdout?.on("data", (buf: Buffer) => {
      const port = /listening on :(\d+)/.exec(buf.toString())?.[1];
      if (!port) return;
      clearTimeout(timer);
      resolve(`ws://127.0.0.1:${port}`);
    });
  });
}, 30000);

afterAll(() => {
  child?.kill();
});

describe("shared bot slider over the wire", () => {
  it("tells a joining client the room's current bot count", async () => {
    const alice = await connect("Alice");
    // The standing room starts at the spec default of 5.
    expect(alice.welcome.botTarget).toBe(5);

    setBots(alice, 3);
    await alice.waitFor(isBotsConfig(3, "Alice"), "Alice's own botsConfig");

    // A LATE joiner is told 3, not the default — the whole point of the
    // welcome field: their slider opens where the room actually is.
    const bob = await connect("Bob");
    expect(bob.welcome.botTarget).toBe(3);
    alice.ws.close();
    bob.ws.close();
  });

  it("broadcasts a change to every member, attributed to the setter", async () => {
    const alice = await connect("Alice");
    const bob = await connect("Bob");

    setBots(bob, 7);
    // Both tabs move, and both learn it was Bob — the ticker's attribution.
    await alice.waitFor(isBotsConfig(7, "Bob"), "Bob's change seen by Alice");
    await bob.waitFor(isBotsConfig(7, "Bob"), "Bob's change echoed to Bob");
    alice.ws.close();
    bob.ws.close();
  });

  it("last write wins a slider war, and a rate-limited retry is dropped", async () => {
    const alice = await connect("Alice");
    const bob = await connect("Bob");

    setBots(alice, 2);
    await bob.waitFor(isBotsConfig(2, "Alice"), "Alice's 2");
    // Bob is a different player, so his write is not rate-limited: it lands
    // immediately after Alice's and wins.
    setBots(bob, 9);
    await alice.waitFor(isBotsConfig(9, "Bob"), "Bob's 9");

    // Alice tries again inside her 3 s window: silently dropped, no echo —
    // which is what makes her slider snap back to 9.
    setBots(alice, 0);
    await alice.expectSilence((m) => m.type === "botsConfig", 1200);

    // The room really is at 9: a fresh joiner is told so.
    const carol = await connect("Carol");
    expect(carol.welcome.botTarget).toBe(9);
    alice.ws.close();
    bob.ws.close();
    carol.ws.close();
  });
});
