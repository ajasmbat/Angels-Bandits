// W2 against a dedicated server process: a hidden tab goes AWAY (out of
// snapshots and targeting, seat kept) and comes back with a fresh spawn, and
// a dropped socket resumes as the same player through its welcome's
// resumeToken — same id, same kills and deaths. Its own process, with the
// resume window and away silence shortened through their env overrides, so
// the expiry paths run in seconds.

import { type ChildProcess, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  AWAY_COMBAT_LOCK_MS,
  AWAY_MIN_MS,
  BULLET_DAMAGE,
  BULLET_RANGE,
  INTERP_FLOOR_MS,
  MAX_HP,
  SNAPSHOT_INTERVAL_MS,
  SPAWN_PROTECTION_MS,
} from "@angels-bandits/common/constants";
import type {
  DamageMsg,
  Pose,
  RespawnMsg,
  ScoreMsg,
  ServerMsg,
  WelcomeMsg,
  WireSnapshotMsg,
} from "@angels-bandits/common/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const RESUME_WINDOW = 3000;
const AWAY_SILENCE = 2500;

let child: ChildProcess;
let url: string;
/** Holds the standing room open for the whole file — if it emptied, the
 * next join would spawn a fresh room flying the default bots again. */
let admin: Peer | undefined;

beforeAll(async () => {
  child = spawn(process.execPath, ["--import", "tsx", entry], {
    env: {
      ...process.env,
      PORT: "0",
      RESUME_WINDOW_MS: String(RESUME_WINDOW),
      AWAY_SILENCE_MS: String(AWAY_SILENCE),
    },
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
  // No bots: their fire would add damage (delaying away) and kills nobody
  // asked for. Any member may set the room's count.
  admin = await connect("Admin");
  admin.ws.send(JSON.stringify({ type: "setBots", count: 0 }));
  await wait(SNAPSHOT_INTERVAL_MS * 4);
}, 30000);

afterAll(async () => {
  admin?.ws.close();
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((r) => child.once("exit", r));
  child.kill();
  await exited;
});

interface Peer {
  ws: WebSocket;
  welcome: WelcomeMsg;
  snapshots: WireSnapshotMsg[];
  seen: ServerMsg[];
  closed: Promise<void>;
  /** Stop the 1 Hz heartbeat (a frozen page). */
  silence: () => void;
}

/** Join (optionally resuming) and resolve on the welcome. Unless `silent`,
 * the peer heartbeats at 1 Hz like a hidden tab, so liveness never drops it
 * between steps. */
function connect(
  name: string,
  resume?: string,
  { silent = false } = {},
): Promise<Peer> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const snapshots: WireSnapshotMsg[] = [];
    const seen: ServerMsg[] = [];
    const beat = silent
      ? undefined
      : setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "ping" }));
          }
        }, 1000);
    const silence = () => clearInterval(beat);
    const closed = new Promise<void>((r) =>
      ws.once("close", () => {
        silence();
        r();
      }),
    );
    ws.on("error", reject);
    ws.on("open", () =>
      ws.send(JSON.stringify({ type: "join", name, resume })),
    );
    ws.on("message", (data: Buffer) => {
      const msg = JSON.parse(data.toString()) as ServerMsg;
      if (msg.type === "snapshot") snapshots.push(msg);
      else seen.push(msg);
      if (msg.type === "welcome") {
        resolve({ ws, welcome: msg, snapshots, seen, closed, silence });
      }
    });
  });
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };
const at = (x: number, z: number): Pose => ({
  pos: { x, y: 300, z },
  quat: { ...IDENTITY },
  speed: 65,
});
const send = (peer: Peer, msg: object) => peer.ws.send(JSON.stringify(msg));
const pose = (peer: Peer, p: Pose) => send(peer, { type: "pose", pose: p });
const fromSpawn = (s: WelcomeMsg["spawn"]): Pose => ({
  pos: { ...s.pos },
  quat: { ...IDENTITY },
  speed: s.speed,
});

/** Resolve with the first message matching `pred` (already seen or later). */
async function nextMsg<T extends ServerMsg>(
  peer: Peer,
  pred: (m: ServerMsg) => m is T,
  timeoutMs = 8000,
  from = 0,
): Promise<T> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const found = peer.seen.slice(from).find(pred);
    if (found) return found;
    await wait(20);
  }
  throw new Error("message never arrived");
}

const inSnapshot = (snap: WireSnapshotMsg, id: string) =>
  snap.p.some((e) => e[0] === id);

/** Park `shooter` and `target` BULLET_RANGE/2 apart, wait out spawn
 * protection while streaming at the uplink rate, then land one validated
 * hit. Repeating a claim past RESYNC_AFTER_REJECTS is the re-sync path a
 * crash respawn uses, so the parking jump is accepted. */
async function landHit(shooter: Peer, target: Peer, seq: number) {
  const stream = async (ms: number) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      pose(shooter, at(1000, 1000));
      pose(target, at(1000 + BULLET_RANGE / 2, 1000));
      await wait(1000 / 20);
    }
  };
  await stream(16 * 50);
  await stream(SPAWN_PROTECTION_MS + 300);
  const from = target.seen.length;
  send(shooter, { type: "fire", seq });
  await wait(30);
  send(shooter, {
    type: "hit",
    targetId: target.welcome.id,
    bulletOrigin: { x: 1000, y: 300, z: 1000 },
    seq,
    delay: INTERP_FLOOR_MS,
  });
  return nextMsg(
    target,
    (m): m is DamageMsg =>
      m.type === "damage" && m.targetId === target.welcome.id,
    4000,
    from,
  );
}

const scoreOf = (scores: ScoreMsg["scores"], id: string) =>
  scores.find((s) => s.id === id);

describe("away (W2)", () => {
  it("waits out recent damage, then leaves snapshots and targeting for 10 s, and returns with a fresh protected spawn", async () => {
    const shooter = await connect("Shooter");
    const target = await connect("Target");
    const damage = await landHit(shooter, target, 1);
    expect(damage.hp).toBe(MAX_HP - BULLET_DAMAGE);

    // Hidden right after taking a hit: the away is deferred, so the plane
    // can't dodge a burst — still in snapshots, still hittable.
    send(target, { type: "away", on: true });
    const hiddenAt = Date.now();
    const lockEnds = hiddenAt + AWAY_COMBAT_LOCK_MS - 300;
    while (Date.now() < lockEnds) {
      pose(shooter, at(1000, 1000));
      await wait(1000 / 20);
    }
    expect(target.seen.some((m) => m.type === "awayStarted")).toBe(false);
    const last = shooter.snapshots[shooter.snapshots.length - 1];
    expect(last && inSnapshot(last, target.welcome.id)).toBe(true);

    await nextMsg(
      target,
      (m): m is { type: "awayStarted" } => m.type === "awayStarted",
      2000,
    );
    expect(Date.now() - hiddenAt).toBeGreaterThanOrEqual(
      AWAY_COMBAT_LOCK_MS - 100,
    );

    // Away for 10 s: absent from every snapshot, and a hit claim on it is
    // simply refused (no damage), though the same claim landed before.
    await wait(SNAPSHOT_INTERVAL_MS * 2);
    const fromSnap = shooter.snapshots.length;
    const fromSeen = target.seen.length;
    const awayEnds = Date.now() + 10000;
    let claimed = false;
    while (Date.now() < awayEnds) {
      pose(shooter, at(1000, 1000));
      if (!claimed && Date.now() > awayEnds - 8000) {
        claimed = true;
        send(shooter, { type: "fire", seq: 2 });
        send(shooter, {
          type: "hit",
          targetId: target.welcome.id,
          bulletOrigin: { x: 1000, y: 300, z: 1000 },
          seq: 2,
          delay: INTERP_FLOOR_MS,
        });
      }
      await wait(1000 / 20);
    }
    const during = shooter.snapshots.slice(fromSnap);
    expect(during.length).toBeGreaterThan(150);
    for (const snap of during) {
      expect(inSnapshot(snap, target.welcome.id)).toBe(false);
    }
    expect(
      target.seen
        .slice(fromSeen)
        .filter(
          (m) =>
            (m.type === "damage" && m.targetId === target.welcome.id) ||
            (m.type === "death" && m.victimId === target.welcome.id),
        ),
    ).toEqual([]);
    // The seat was kept the whole time.
    expect(target.ws.readyState).toBe(WebSocket.OPEN);

    // Back: a respawn for the target, and a pose from that spawn is taken.
    send(target, { type: "away", on: false });
    const back = await nextMsg(
      target,
      (m): m is RespawnMsg =>
        m.type === "respawn" && m.id === target.welcome.id,
      2000,
      fromSeen,
    );
    expect(back.protectedUntil).toBeGreaterThan(Date.now());
    const fromBack = shooter.snapshots.length;
    for (let i = 0; i < 6; i++) {
      pose(target, fromSpawn(back.spawn));
      pose(shooter, at(1000, 1000));
      await wait(1000 / 20);
    }
    await wait(SNAPSHOT_INTERVAL_MS * 2);
    const row = shooter.snapshots
      .slice(fromBack)
      .flatMap((s) => s.p)
      .filter((e) => e[0] === target.welcome.id)
      .pop();
    expect(row).toBeDefined();
    expect(row?.[9]).toBe(MAX_HP); // a fresh plane
    expect(row?.[10]).toBe(1); // spawn-protected

    shooter.ws.close();
    target.ws.close();
  }, 40000);

  it("holds a return until AWAY_MIN_MS has passed", async () => {
    const peer = await connect("Blinker");
    pose(peer, fromSpawn(peer.welcome.spawn)); // live
    await wait(SNAPSHOT_INTERVAL_MS * 2);
    send(peer, { type: "away", on: true });
    await nextMsg(
      peer,
      (m): m is { type: "awayStarted" } => m.type === "awayStarted",
      2000,
    );
    const startedAt = Date.now();
    send(peer, { type: "away", on: false });
    await nextMsg(
      peer,
      (m): m is RespawnMsg => m.type === "respawn" && m.id === peer.welcome.id,
      3000,
    );
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(AWAY_MIN_MS - 60);
    peer.ws.close();
  }, 20000);

  it("closes an away socket that goes silent, and it can still resume", async () => {
    const peer = await connect("Frozen");
    pose(peer, fromSpawn(peer.welcome.spawn));
    await wait(SNAPSHOT_INTERVAL_MS * 2);
    send(peer, { type: "away", on: true });
    await nextMsg(
      peer,
      (m): m is { type: "awayStarted" } => m.type === "awayStarted",
      2000,
    );
    peer.silence(); // the phone froze the page
    const t0 = Date.now();
    await peer.closed;
    // Well past the 4 s live bound would have been fine too; it must not
    // be the 60 s away window.
    expect(Date.now() - t0).toBeLessThan(AWAY_SILENCE + 2500);
    const back = await connect("Frozen", peer.welcome.resumeToken);
    expect(back.welcome.id).toBe(peer.welcome.id);
    back.ws.close();
  }, 20000);
});

describe("resume tokens (W2)", () => {
  it("rejoining with the resumeToken restores the same id, kills and deaths, and tells the room", async () => {
    const shooter = await connect("Ace");
    const target = await connect("Wingman");
    await landHit(shooter, target, 1);
    // A crash inside DAMAGE_MEMORY_MS credits the damager: 1 kill / 1 death.
    send(target, { type: "crash" });
    const scored = await nextMsg(
      target,
      (m): m is ScoreMsg =>
        m.type === "score" &&
        scoreOf(m.scores, shooter.welcome.id)?.kills === 1,
    );
    expect(scoreOf(scored.scores, target.welcome.id)?.deaths).toBe(1);

    shooter.ws.close();
    await shooter.closed;
    await wait(100);
    const from = target.seen.length;
    const back = await connect("Someone Else", shooter.welcome.resumeToken);
    expect(back.welcome.id).toBe(shooter.welcome.id);
    expect(back.welcome.roomId).toBe(shooter.welcome.roomId);
    expect(back.welcome.resumeToken).not.toBe(shooter.welcome.resumeToken);
    expect(
      back.welcome.roster.find((r) => r.id === back.welcome.id)?.name,
    ).toBe("Ace");
    expect(scoreOf(back.welcome.scores, back.welcome.id)).toEqual({
      id: shooter.welcome.id,
      kills: 1,
      deaths: 0,
    });
    // Everyone else's board seeded the rejoined row at 0/0: the restored
    // tally has to reach them too.
    await nextMsg(
      target,
      (m): m is ScoreMsg =>
        m.type === "score" &&
        scoreOf(m.scores, shooter.welcome.id)?.kills === 1,
      3000,
      from,
    );

    target.ws.close();
    await target.closed;
    await wait(100);
    const victim = await connect("Wingman", target.welcome.resumeToken);
    expect(victim.welcome.id).toBe(target.welcome.id);
    expect(scoreOf(victim.welcome.scores, victim.welcome.id)?.deaths).toBe(1);
    back.ws.close();
    victim.ws.close();
  }, 30000);

  it("an expired or spent token gets a fresh id — no error, no crash", async () => {
    const expired = await connect("Late");
    expired.ws.close();
    await expired.closed;
    await wait(RESUME_WINDOW + 300);
    const late = await connect("Late", expired.welcome.resumeToken);
    expect(late.welcome.id).not.toBe(expired.welcome.id);
    expect(scoreOf(late.welcome.scores, late.welcome.id)).toEqual({
      id: late.welcome.id,
      kills: 0,
      deaths: 0,
    });

    const first = await connect("Twice");
    first.ws.close();
    await first.closed;
    await wait(100);
    const resumed = await connect("Twice", first.welcome.resumeToken);
    expect(resumed.welcome.id).toBe(first.welcome.id);
    send(resumed, { type: "ping" }); // the welcome landed: token spent
    await wait(100);
    resumed.ws.close();
    await resumed.closed;
    await wait(100);
    const reused = await connect("Twice", first.welcome.resumeToken);
    expect(reused.welcome.id).not.toBe(first.welcome.id);

    // Junk tokens are just a fresh join too.
    const junk = await connect("Junk", "not-a-token");
    expect(junk.welcome.type).toBe("welcome");
    expect(child.exitCode).toBeNull();
    for (const p of [late, reused, junk]) p.ws.close();
  }, 20000);

  it("a resume whose welcome was lost can be retried with the same token", async () => {
    const first = await connect("Flaky");
    first.ws.close();
    await first.closed;
    await wait(100);
    // Resumed, but the line dies before the session ever speaks.
    const lost = await connect("Flaky", first.welcome.resumeToken, {
      silent: true,
    });
    expect(lost.welcome.id).toBe(first.welcome.id);
    lost.ws.close();
    await lost.closed;
    await wait(100);
    const retry = await connect("Flaky", first.welcome.resumeToken);
    expect(retry.welcome.id).toBe(first.welcome.id);
    retry.ws.close();
  }, 20000);

  it("takes over a session the server still thinks is open, and its late close never evicts the resumed player", async () => {
    const observer = await connect("Observer");
    const stale = await connect("Stale");
    await nextMsg(
      observer,
      (m): m is ServerMsg =>
        m.type === "playerJoined" && m.player.id === stale.welcome.id,
    );
    const from = observer.seen.length;
    const fresh = await connect("Stale", stale.welcome.resumeToken);
    expect(fresh.welcome.id).toBe(stale.welcome.id);
    await stale.closed; // the server dropped the stale socket
    await wait(SNAPSHOT_INTERVAL_MS * 6);
    expect(fresh.ws.readyState).toBe(WebSocket.OPEN);
    const events = observer.seen
      .slice(from)
      .filter(
        (m) =>
          (m.type === "playerLeft" && m.id === stale.welcome.id) ||
          (m.type === "playerJoined" && m.player.id === stale.welcome.id),
      )
      .map((m) => m.type);
    expect(events).toEqual(["playerLeft", "playerJoined"]);
    observer.ws.close();
    fresh.ws.close();
  }, 20000);

  it("resuming into a full room keeps the id and score in another room", async () => {
    const pilot = await connect("Crowded");
    pose(pilot, fromSpawn(pilot.welcome.spawn)); // live
    await wait(SNAPSHOT_INTERVAL_MS * 2);
    send(pilot, { type: "crash" }); // 0 / 1
    await nextMsg(
      pilot,
      (m): m is ScoreMsg =>
        m.type === "score" &&
        scoreOf(m.scores, pilot.welcome.id)?.deaths === 1,
    );
    pilot.ws.close();
    await pilot.closed;

    // Fill the pilot's old room to ROOM_CAP humans: the first filler that
    // lands somewhere else proves it is full.
    const fillers: Peer[] = [];
    for (let i = 0; i < 13; i++) {
      const f = await connect(`Filler ${i}`);
      fillers.push(f);
      if (f.welcome.roomId !== pilot.welcome.roomId) break;
    }
    expect(fillers[fillers.length - 1]?.welcome.roomId).not.toBe(
      pilot.welcome.roomId,
    );

    const back = await connect("Crowded", pilot.welcome.resumeToken);
    expect(back.welcome.id).toBe(pilot.welcome.id);
    expect(back.welcome.roomId).not.toBe(pilot.welcome.roomId);
    expect(scoreOf(back.welcome.scores, back.welcome.id)).toEqual({
      id: pilot.welcome.id,
      kills: 0,
      deaths: 1,
    });
    back.ws.close();
    for (const f of fillers) f.ws.close();
  }, 30000);
});
