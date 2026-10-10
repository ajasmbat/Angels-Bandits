// W1 never a silent dead session — the client's connection states. Joining
// (GameSocket.connect) always settles: the welcome resolves it; an error, a
// close before the welcome, a wrong first message or no welcome within
// CONNECT_TIMEOUT_MS reject it and close the socket. Once connected, a drop
// goes "reconnecting" and either resumes as the same player or ends (W2's
// half of the same state machine; its backoff maths is reconnect.test.ts).
// The join card is the loading screen: CONNECTING… with the form locked,
// the error state with RETRY, and the one-tap rejoin — which still reloads
// with storage blocked. A fake WebSocket and a fake DOM, fake timers
// (performance included) restored after every test.

import {
  CONNECT_TIMEOUT_MS,
  RESUME_WINDOW_MS,
} from "@angels-bandits/common/constants";
import type { WelcomeMsg } from "@angels-bandits/common/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GameSocket } from "../src/net/socket";
import { requestName, setJoinStatus, showJoinError } from "../src/ui/join";

type Listener = (ev: { data?: string }) => void;

class FakeSocket {
  static all: FakeSocket[] = [];
  static readonly OPEN = 1;
  readonly OPEN = 1;
  readyState = 1;
  readonly sent: Record<string, unknown>[] = [];
  closed = 0;
  private readonly listeners = new Map<string, Listener[]>();
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  static get last(): FakeSocket {
    const ws = FakeSocket.all.at(-1);
    if (!ws) throw new Error("no socket opened");
    return ws;
  }
  addEventListener(type: string, fn: Listener, opts?: { once?: boolean }) {
    const wrapped: Listener = opts?.once
      ? (ev) => {
          this.listeners.set(
            type,
            (this.listeners.get(type) ?? []).filter((f) => f !== wrapped),
          );
          fn(ev);
        }
      : fn;
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), wrapped]);
  }
  emit(type: string, data?: unknown) {
    const ev = data === undefined ? {} : { data: JSON.stringify(data) };
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(ev);
  }
  send(text: string) {
    this.sent.push(JSON.parse(text) as Record<string, unknown>);
  }
  close() {
    this.closed++;
  }
}

const welcome = (id = "me", token = "tok-1"): WelcomeMsg =>
  ({
    type: "welcome",
    id,
    roomId: "room-1",
    seed: 42,
    spawn: { pos: { x: 0, y: 300, z: 0 }, yaw: 0, speed: 60 },
    roster: [],
    scores: [],
    intensity: 1,
    waves: [0, 0, 0, 0, 0, 0],
    cityEvents: [],
    resumeToken: token,
    destroyed: [],
    collapses: [],
    courses: [],
  }) as unknown as WelcomeMsg;

/** Track a promise's outcome without awaiting it. */
function track<T>(p: Promise<T>) {
  const s: { done: boolean; value?: T; error?: Error } = { done: false };
  p.then(
    (value) => {
      s.done = true;
      s.value = value;
    },
    (error: Error) => {
      s.done = true;
      s.error = error;
    },
  );
  return s;
}

describe("GameSocket.connect — a join always settles", () => {
  beforeEach(() => {
    FakeSocket.all = [];
    vi.useFakeTimers({
      toFake: [
        "setTimeout",
        "clearTimeout",
        "setInterval",
        "clearInterval",
        "performance",
      ],
    });
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.stubGlobal("location", {
      hostname: "localhost",
      host: "localhost",
      protocol: "http:",
    });
    vi.stubGlobal("document", { hidden: false, addEventListener() {} });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("joins on open and resolves on the welcome", async () => {
    const joining = GameSocket.connect("Ace");
    const ws = FakeSocket.last;
    ws.emit("open");
    expect(ws.sent).toEqual([{ type: "join", name: "Ace" }]);
    ws.emit("message", welcome());
    const socket = await joining;
    expect(socket.selfId).toBe("me");
    expect(ws.closed).toBe(0);
  });

  it("no welcome within CONNECT_TIMEOUT_MS rejects and closes the socket; a late welcome is ignored", async () => {
    const joining = track(GameSocket.connect("Ace"));
    const ws = FakeSocket.last;
    ws.emit("open");
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS - 1);
    expect(joining.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(joining.error?.message).toBe("Can't reach the server");
    expect(ws.closed).toBe(1);
    ws.emit("message", welcome());
    ws.emit("close");
    await vi.advanceTimersByTimeAsync(0);
    expect(joining.value).toBeUndefined();
    expect(ws.closed).toBe(1);
  });

  for (const [what, act] of [
    ["an error", (ws: FakeSocket) => ws.emit("error")],
    ["a close before the welcome", (ws: FakeSocket) => ws.emit("close")],
    [
      "a first message that isn't the welcome",
      (ws: FakeSocket) => ws.emit("message", { type: "scores", scores: [] }),
    ],
  ] as const) {
    it(`${what} rejects at once and closes the socket`, async () => {
      const joining = track(GameSocket.connect("Ace"));
      const ws = FakeSocket.last;
      ws.emit("open");
      act(ws);
      await vi.advanceTimersByTimeAsync(0);
      expect(joining.error?.message).toBe("Can't reach the server");
      expect(ws.closed).toBe(1);
      // The timeout was cleared: nothing fires later.
      await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS);
      expect(ws.closed).toBe(1);
    });
  }

  it("sendPing is the boot keepalive", async () => {
    const joining = GameSocket.connect("Ace");
    const ws = FakeSocket.last;
    ws.emit("open");
    ws.emit("message", welcome());
    (await joining).sendPing();
    expect(ws.sent.at(-1)).toEqual({ type: "ping" });
  });

  describe("connected → reconnecting → resumed, or → lost", () => {
    async function connected() {
      const joining = GameSocket.connect("Ace");
      const ws = FakeSocket.last;
      ws.emit("open");
      ws.emit("message", welcome());
      const socket = await joining;
      const seen: string[] = [];
      socket.events.onReconnecting = () => seen.push("reconnecting");
      socket.events.onResumed = () => seen.push("resumed");
      socket.events.onClose = () => seen.push("lost");
      return { socket, ws, seen };
    }

    it("a drop reconnects with the resume token and comes back as the same player", async () => {
      const { ws, seen } = await connected();
      ws.emit("close");
      expect(seen).toEqual(["reconnecting"]);
      await vi.advanceTimersByTimeAsync(500); // the first backoff step
      const retry = FakeSocket.last;
      expect(retry).not.toBe(ws);
      retry.emit("open");
      expect(retry.sent).toEqual([
        { type: "join", name: "Ace", resume: "tok-1" },
      ]);
      retry.emit("message", welcome("me", "tok-2"));
      await vi.advanceTimersByTimeAsync(0);
      expect(seen).toEqual(["reconnecting", "resumed"]);
    });

    it("a same-room resume REPLACES the held strikes: one called off during the drop is gone (A2)", async () => {
      const { socket, ws } = await connected();
      // Missile 7 in the air; then the drop. Meanwhile the server called it
      // off (`bombsOff`) and launched 8 — the resume's welcome says so.
      const missile = (id: number) => [id, 0, 0, 3000, 0, 1000, 0, 1000, 5];
      ws.emit("message", { type: "missile", m: missile(7) });
      expect([...socket.missiles.keys()]).toEqual([7]);
      ws.emit("close");
      await vi.advanceTimersByTimeAsync(500);
      const retry = FakeSocket.last;
      retry.emit("open");
      retry.emit("message", {
        ...welcome("me", "tok-2"),
        missiles: [missile(8)],
      });
      await vi.advanceTimersByTimeAsync(0);
      expect([...socket.missiles.keys()]).toEqual([8]);
    });

    it("a refused token (the server made us someone new) ends the session", async () => {
      const { ws, seen } = await connected();
      ws.emit("close");
      await vi.advanceTimersByTimeAsync(500);
      const retry = FakeSocket.last;
      retry.emit("open");
      retry.emit("message", welcome("someone-else"));
      await vi.advanceTimersByTimeAsync(0);
      expect(seen).toEqual(["reconnecting", "lost"]);
      expect(retry.closed).toBeGreaterThan(0);
    });

    it("a server that never answers: retries back off, then the session ends inside the resume window", async () => {
      const { ws, seen } = await connected();
      ws.emit("close");
      const before = FakeSocket.all.length;
      // Every resume attempt hits a dead server.
      for (
        let t = 0;
        t < RESUME_WINDOW_MS + 20_000 && !seen.includes("lost");
        t += 250
      ) {
        await vi.advanceTimersByTimeAsync(250);
        const last = FakeSocket.last;
        if (last !== ws && last.closed === 0) last.emit("error");
      }
      expect(seen).toEqual(["reconnecting", "lost"]);
      // 0.5, 1, 2, 4, 8 s, then 8 s steps: several attempts, not a spin.
      const attempts = FakeSocket.all.length - before;
      expect(attempts).toBeGreaterThanOrEqual(5);
      expect(attempts).toBeLessThan(20);
      expect(performance.now()).toBeLessThanOrEqual(RESUME_WINDOW_MS + 1000);
    });
  });
});

// --- The join card (the loading screen) ---------------------------------------

class FakeEl {
  readonly classes = new Set<string>();
  readonly classList = {
    add: (c: string) => this.classes.add(c),
    remove: (c: string) => this.classes.delete(c),
    contains: (c: string) => this.classes.has(c),
  };
  textContent = "";
  value = "";
  hidden = true;
  disabled = false;
  maxLength = 0;
  readonly listeners: Record<
    string,
    ((e: { preventDefault(): void }) => void)[]
  > = {};
  addEventListener(type: string, fn: (e: { preventDefault(): void }) => void) {
    this.listeners[type] = [...(this.listeners[type] ?? []), fn];
  }
  fire(type: string) {
    for (const fn of this.listeners[type] ?? []) fn({ preventDefault() {} });
  }
  focus() {}
  select() {}
  blur() {}
}

describe("the join card — CONNECTING…, the error state, RETRY", () => {
  let els: Record<string, FakeEl>;
  let reloads: number;
  let session: Map<string, string> | "blocked";
  let local: Map<string, string>;

  beforeEach(() => {
    els = Object.fromEntries(
      ["join", "join-form", "join-name", "join-status", "join-retry"].map(
        (id) => [id, new FakeEl()],
      ),
    );
    reloads = 0;
    session = new Map();
    local = new Map();
    const storage = (get: () => Map<string, string> | "blocked") => ({
      getItem: (k: string) => {
        const s = get();
        if (s === "blocked") throw new DOMException("SecurityError");
        return s.get(k) ?? null;
      },
      setItem: (k: string, val: string) => {
        const s = get();
        if (s === "blocked") throw new DOMException("SecurityError");
        s.set(k, val);
      },
      removeItem: (k: string) => {
        const s = get();
        if (s === "blocked") throw new DOMException("SecurityError");
        s.delete(k);
      },
    });
    vi.stubGlobal("document", {
      getElementById: (id: string) => els[id] ?? null,
    });
    vi.stubGlobal(
      "sessionStorage",
      storage(() => session),
    );
    vi.stubGlobal("window", { localStorage: storage(() => local) });
    vi.stubGlobal("location", {
      reload: () => {
        reloads++;
      },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  const el = (id: string) => els[id] as FakeEl;

  it("setJoinStatus locks the form and shows the boot step", () => {
    el("join-status").classes.add("error");
    setJoinStatus("LOADING CITY…");
    expect(el("join-form").classes.has("busy")).toBe(true);
    expect(el("join-name").disabled).toBe(true);
    expect(el("join-status").textContent).toBe("LOADING CITY…");
    expect(el("join-status").classes.has("error")).toBe(false);
  });

  it("FLY resolves with the trimmed name, remembers it, and the card stays up on CONNECTING…", async () => {
    const naming = requestName();
    expect(el("join").classes.has("open")).toBe(true);
    el("join-name").value = "  Maverick  ";
    el("join-form").fire("submit");
    expect(await naming).toBe("Maverick");
    expect(local.get("ab:name")).toBe("Maverick");
    expect(el("join-status").textContent).toBe("CONNECTING…");
    expect(el("join").classes.has("open")).toBe(true);
  });

  it("an empty name flies as Pilot", async () => {
    const naming = requestName();
    el("join-name").value = "   ";
    el("join-form").fire("submit");
    expect(await naming).toBe("Pilot");
  });

  it("a server it can't reach ends on the error state with RETRY, which rejoins in one tap", async () => {
    showJoinError("CAN'T REACH THE SERVER");
    expect(el("join-status").classes.has("error")).toBe(true);
    expect(el("join-status").textContent).toBe("CAN'T REACH THE SERVER");
    expect(el("join-retry").hidden).toBe(false);
    expect(el("join").classes.has("open")).toBe(true);
    el("join-retry").fire("click");
    expect(reloads).toBe(1);
    expect((session as Map<string, string>).get("ab:rejoin")).toBe("1");
    // After the reload: the remembered name flies straight back in.
    local.set("ab:name", "Maverick");
    expect(await requestName()).toBe("Maverick");
    expect(el("join-status").textContent).toBe("CONNECTING…");
    expect((session as Map<string, string>).has("ab:rejoin")).toBe(false);
  });

  it("RETRY with storage blocked still reloads (the name is just typed again)", async () => {
    session = "blocked";
    showJoinError("CAN'T REACH THE SERVER");
    el("join-retry").fire("click");
    expect(reloads).toBe(1);
    // No rejoin flag could persist: the card waits for FLY.
    const naming = track(requestName());
    await Promise.resolve();
    expect(naming.done).toBe(false);
  });
});
