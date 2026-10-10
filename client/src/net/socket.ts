// GameSocket: the client's one connection to the presence server. Joins with
// a name, streams the local plane's pose up at TICK_UP_HZ, surfaces
// snapshots/join/leave events, and estimates the server clock so the render
// loop can sample interpolation buffers the ADAPTIVE interpolation delay
// behind it (ANGE-4KO2W2). The frame loop never reads that raw estimate:
// it renders on the SMOOTHED clocks in ./clock.ts (O2), latched once per
// frame by tickRenderClock().
//
// Snapshots arrive QUANTISED — a tuple of integers per plane — and are decoded
// here, so nothing downstream of this file knows the wire got cheaper. This is
// also where snapshot-arrival jitter is measured: it is the one place that
// sees every snapshot land on the local clock.
//
// W2: a dropped socket is not the end of the session. The GameSocket swaps
// in a fresh ws behind the same object, rejoining with the welcome's
// resumeToken on the backoff in ./reconnect.ts, and only reports onClose
// once that has failed — the server answered as a different player, or the
// resume window ran out.
//
// D2: the room's destroyed-chunk set lives HERE, in `cityDamage`, not in the
// game loop's handlers: those attach only after the city build and shader
// pre-warm, and a `chunks` batch dropped while booting would leave this
// client colliding with walls everyone else has shot away for the rest of
// the session. main.ts binds it to the city once the city exists.
// D3: so do the room's collapses (`collapses`), for the same reason: a
// collapse dropped while booting would leave a building standing here that
// everyone else saw fall.
//
// X1: the room's missiles in the air live here too (`missiles`), for the
// same reason — a strike announced while this client boots must still
// whistle and land on time. main.ts consumes them on the synced clock.
// D5: and so do the director's warned events (`director`) and its rebuilds,
// which are applied to `cityDamage` and `collapses` on arrival — in message
// order, so a `chunks` batch after a rebuild lands after it here too.
// C2: and the chaos — quakes (`quakes`) and the burning chunks (`fires`).
// U6: and the cave-ins (`caveIns`, the mover field's slot).

import {
  type BossFlak,
  type BossLaunch,
  type BossRaid,
  applyBossState,
  decodeFlak,
  decodeLaunch,
  decodeRaid,
  emptyBossSlot,
  isBossDown,
  launchDoneAt,
  raidMaxHp,
} from "@angels-bandits/common/boss";
import {
  type QuakeEvent,
  type WireChaosState,
  decodeQuake,
  quakeLive,
} from "@angels-bandits/common/chaos";
import { CityDamage, decodeChunkIds } from "@angels-bandits/common/city";
import {
  type CaveIn,
  addCaveIn,
  decodeCaveIn,
  emptyCaveInSlot,
  pruneCaveIns,
} from "@angels-bandits/common/city/caveins";
import {
  CollapseField,
  type CollapseWire,
  collapseChunks,
} from "@angels-bandits/common/city/collapse";
import type { CityEvent } from "@angels-bandits/common/cityevents";
import {
  CONNECT_TIMEOUT_MS,
  LAB_FULL_CODE,
  SERVER_SILENCE_MS,
  TICK_UP_HZ,
} from "@angels-bandits/common/constants";
import {
  type DirectorEvent,
  type RebuildWire,
  decodeDirectorEvent,
} from "@angels-bandits/common/director";
import { STREAK_TIERS, isMedalKind } from "@angels-bandits/common/medals";
import { decodeSnapshotEntry } from "@angels-bandits/common/net";
import type {
  AwardMsg,
  BossDownMsg,
  CourseBoardMsg,
  CourseResultMsg,
  DamageMsg,
  DeathMsg,
  IntensityConfigMsg,
  NewsHeliMsg,
  Pose,
  RespawnMsg,
  RosterEntry,
  ScoreEntry,
  ServerMsg,
  SnapshotMsg,
  WelcomeMsg,
} from "@angels-bandits/common/protocol";
import {
  type MissileStrike,
  decodeMissile,
} from "@angels-bandits/common/strike";
import {
  type WaveState,
  decodeWaves,
  idleWaves,
} from "@angels-bandits/common/waves";
import type { Vec3 } from "@angels-bandits/common/world";
import { PoseCadence, RenderClock } from "./clock";
import { InterpDelay } from "./delay";
import { reconnectDelayMs } from "./reconnect";

export interface GameSocketEvents {
  onSnapshot?: (snap: SnapshotMsg) => void;
  onPlayerJoined?: (player: RosterEntry) => void;
  onPlayerLeft?: (id: string) => void;
  onFired?: (id: string) => void;
  onDamage?: (msg: DamageMsg) => void;
  onDeath?: (msg: DeathMsg) => void;
  onRespawn?: (msg: RespawnMsg) => void;
  onScores?: (scores: ScoreEntry[]) => void;
  /** S7: the server's credit for one kill — medals, and a tier crossing. */
  onAward?: (msg: AwardMsg) => void;
  /** W1: the room's enemy intensity changed (who set it, to what). */
  onIntensityConfig?: (msg: IntensityConfigMsg) => void;
  /** W1: the carrier war moved on (already in `waves`). */
  onWaves?: (state: WaveState) => void;
  /** L1: a server-accepted event the city reacts to (reactions.ts). */
  onCityEvent?: (event: CityEvent) => void;
  onNewsHeli?: (msg: NewsHeliMsg) => void;
  /** W2: our `away` took effect — the return will come with a respawn. */
  onAwayStarted?: () => void;
  /** D3: a building section started to collapse (already applied to
   * `cityDamage` and `collapses`) — audio, shake, dust. */
  onCollapse?: (c: CollapseWire) => void;
  /** D5: the director warned of an event (already in `director`). */
  onDirectorWarn?: (e: DirectorEvent) => void;
  /** D5: a rebuild announce (`go: false`) or one just applied to
   * `cityDamage` and `collapses` (`go: true`, with the chunks it restored). */
  onRebuild?: (r: RebuildWire, restored: readonly number[]) => void;
  /** S3: the official result of our own finished course run. */
  onCourseResult?: (msg: CourseResultMsg) => void;
  /** S3: a course leaderboard changed (ghost attached when a record fell). */
  onCourseBoard?: (msg: CourseBoardMsg) => void;
  /** S4: a sky-boss raid began (already in `boss`). */
  onBoss?: (raid: BossRaid) => void;
  /** S4: the boss went down (already in `boss`): credit and the break-up. */
  onBossDown?: (msg: BossDownMsg) => void;
  /** S9: the carrier is launching `bot` (already in `boss.launches`). */
  onBossLaunch?: (l: BossLaunch, bot: string) => void;
  /** C2: a quake was announced (already in `quakes`). */
  onQuake?: (q: QuakeEvent) => void;
  /** U6: a cave-in was announced (already in `caveIns`). */
  onCaveIn?: (c: CaveIn) => void;
  /** W2: the socket dropped; reconnecting in the background. */
  onReconnecting?: () => void;
  /** W2: back as the same player. `welcome` is the fresh one: roster,
   * scores and a new spawn, since the room moved on meanwhile. */
  onResumed?: (welcome: WelcomeMsg) => void;
  /** The session is over for good: the resume failed or ran out of time. */
  onClose?: () => void;
}

/** One frame's latched clocks (server-clock ms unless noted). All null until
 * the first snapshot has given the client a server-clock estimate. */
export interface FrameClock {
  /** The local rAF timestamp these were latched at. */
  frameMs: number;
  /** The smoothed render time — what the world is drawn at. */
  time: number | null;
  /** The RAW render target (estimated server now − controller delay). Each
   * remote slews its own clock toward this minus its pose lag. */
  target: number | null;
  /** The raw estimated server "now" at this frame. */
  serverNow: number | null;
}

const POSE_INTERVAL_MS = 1000 / TICK_UP_HZ;

/** pruneChaos's quake walk (P4: Map.forEach with a module-level callback —
 * `for…of` built an iterator and an entry array per quake, per frame). */
const prune = { quakes: null as Map<number, QuakeEvent> | null, t: 0 };
const pruneQuake = (q: QuakeEvent, id: number): void => {
  if (!quakeLive(q, prune.t)) prune.quakes?.delete(id);
};
/** W2 dead-socket watchdog cadence, ms. */
const WATCHDOG_MS = 1000;

/**
 * The watchdog's silence bound, ms: SERVER_SILENCE_MS, or a QA `?silence=`
 * (S8, the perf harness only). On a software renderer at 1–2 s a frame the
 * check can run between two long frames before the snapshots queued behind
 * them, read ~4 s of "silence" off a healthy socket without tripping its
 * own late-check guard, and drop it — the page then rejoins a fresh room
 * mid-measurement. A plain visit has no such parameter.
 */
const serverSilenceMs = (() => {
  const raw =
    typeof location === "undefined"
      ? null
      : new URLSearchParams(location.search).get("silence");
  const ms = raw === null ? Number.NaN : Number(raw);
  return Number.isFinite(ms) && ms > SERVER_SILENCE_MS ? ms : SERVER_SILENCE_MS;
})();

/** ws endpoint: dev talks straight to the server port, prod is same-origin. */
const socketUrl = (): string => {
  if (import.meta.env.DEV) return `ws://${location.hostname}:8080`;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}`;
};

export class GameSocket {
  /** The latest welcome — replaced by each resume (same id, fresh token). */
  welcome: WelcomeMsg;
  readonly events: GameSocketEvents = {};
  /** D2: what the server has destroyed in this room — reset from every
   * welcome (a resume may land in a room with less damage), grown by every
   * `chunks` batch, whether or not anything is listening yet. */
  readonly cityDamage = new CityDamage();
  /** D3: the room's collapse records and their debris — replayed from every
   * welcome, grown by every `collapse` message. Its fallen chunks are marked
   * in `cityDamage` from the records alone (never the welcome's set). */
  readonly collapses = new CollapseField();
  /** X1: missiles announced in this room and not yet consumed, by id — from
   * every welcome and every `missile` event, listening or not. The frame
   * loop removes each once it has landed (or gone stale). */
  readonly missiles = new Map<number, MissileStrike>();
  /** D5: the director's warned events, by id — from every welcome and every
   * `directorWarn`, listening or not. The frame loop drops each once it has
   * happened. */
  readonly director = new Map<number, DirectorEvent>();
  /** D6 (perf harness): destruction the SERVER sent — `chunks`, `collapse`,
   * `directorWarn`, `rebuild`, `missile` and `boss` messages, plus a welcome
   * that carried any. A quiet city (AB_QUIET_CITY) sends none, so a segment
   * that saw this move measured something the harness did not stage. */
  serverDestruction = 0;
  /** P4: C2 chaos messages received (quakes, fires; meteors arrive as `missile`, counted above) — a quiet
   * city sends none, so a chaos segment's window must see none. */
  serverChaos = 0;
  /** D6 (perf harness): sessions resumed after a drop (W2) — a resume
   * respawns the plane and replays the room, so a measured window that saw
   * one is not the scene it set up. */
  resumes = 0;
  /** S4: the room's sky boss — its raid and break-up (the mover field holds
   * this very slot, so the crash check sees it), every weak point's HP, and
   * the shells in the air by id (the renderer drops each once it bursts).
   * Kept from every welcome and message, listening or not. */
  readonly boss = emptyBossSlot();
  bossHp: number[] = [];
  /** W1: the room's carrier war — the wave on or coming, enemies left —
   * from every welcome and `waves` message. */
  waves: WaveState = idleWaves();
  readonly flak = new Map<number, BossFlak>();
  /** C2: the quakes announced and not yet over, and the burning chunks —
   * kept from every welcome and message, listening or not. */
  readonly quakes = new Map<number, QuakeEvent>();
  readonly fires = new Set<number>();
  /** U6: the room's live cave-ins (the mover field holds this very slot) —
   * replaced by every welcome, grown by every `caveIn`, listening or not. */
  readonly caveIns = emptyCaveInSlot();
  private ws: WebSocket;
  /** W2: "open" → "reconnecting" on a drop → back, or "lost" for good. */
  private state: "open" | "reconnecting" | "lost" = "open";
  /** When the drop was noticed, and how many resumes have been tried. */
  private droppedAt = 0;
  private attempt = 0;
  /** Last time anything arrived from the server (local clock). */
  private lastHeardMs = performance.now();
  /** serverTime − performance.now(), estimated from stamped snapshots. */
  private clockOffset: number | null = null;
  /** Fixed 30 Hz pose upload deadline (O2). */
  private readonly cadence = new PoseCadence(POSE_INTERVAL_MS);
  /** The adaptive interpolation buffer, fed by snapshot arrival times. */
  private readonly delay = new InterpDelay();
  /** Smoothed estimate of server "now" — what outgoing poses are stamped
   * with, so their times are as even as the poses themselves. */
  private readonly nowClock = new RenderClock();
  /** Smoothed render time: slews toward now − delay, never backward. */
  private readonly renderClock = new RenderClock();
  private frame: FrameClock = {
    frameMs: 0,
    time: null,
    target: null,
    serverNow: null,
  };

  private constructor(
    ws: WebSocket,
    welcome: WelcomeMsg,
    private readonly name: string,
  ) {
    this.ws = ws;
    this.welcome = welcome;
    this.replayDestruction(welcome);
    this.addMissiles(welcome.missiles);
    this.bossHp = applyBossState(this.boss, welcome.boss);
    this.waves = decodeWaves(welcome.waves) ?? idleWaves();
    this.replayChaos(welcome.chaos);
    this.replayCaveIns(welcome.caveIns);
    this.attach(ws);
    // W2 watchdog: snapshots arrive at TICK_DOWN_HZ, so a visible tab that
    // hears nothing for SERVER_SILENCE_MS is on a dead (half-open) socket —
    // a network change can leave one that never fires `close`. A hidden tab
    // is skipped, and coming back restarts the clock — as does a check that
    // itself ran late: after a long main-thread stall (the synchronous city
    // build, a slow frame) this timer can run before the snapshots that
    // queued meanwhile, and that silence proves nothing about the socket.
    let lastCheckMs = performance.now();
    setInterval(() => {
      const now = performance.now();
      const stalled = now - lastCheckMs > WATCHDOG_MS * 2;
      lastCheckMs = now;
      if (stalled || document.hidden) this.lastHeardMs = now;
      if (this.state !== "open") return;
      if (now - this.lastHeardMs > serverSilenceMs) this.dropped();
    }, WATCHDOG_MS);
  }

  /** Connect and join; resolves once the server's welcome arrives. Always
   * settles (W1): an error, a close before the welcome, or no welcome within
   * CONNECT_TIMEOUT_MS all reject — a join never hangs on a silent socket.
   * `resume` (W2) is a token handed over a reload, if any. `lab` (FL1) joins
   * the Flight Lab: a solo room of this player's own; the server ignores
   * `resume` for it, and a full lab rejects with "Flight Lab is full". */
  static async connect(
    name: string,
    resume?: string,
    lab = false,
  ): Promise<GameSocket> {
    const { ws, welcome } = await GameSocket.open(name, resume, lab);
    return new GameSocket(ws, welcome, name);
  }

  private static open(
    name: string,
    resume?: string,
    lab = false,
  ): Promise<{ ws: WebSocket; welcome: WelcomeMsg }> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(socketUrl());
      let settled = false;
      const fail = (message = "Can't reach the server"): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ws.close();
        reject(new Error(message));
      };
      const timer = setTimeout(() => fail(), CONNECT_TIMEOUT_MS);
      ws.addEventListener("open", () =>
        ws.send(
          JSON.stringify(
            lab
              ? { type: "join", name, lab: true }
              : { type: "join", name, resume },
          ),
        ),
      );
      ws.addEventListener("error", () => fail());
      // FL1: a refused lab join (4001) says why; any other close is generic.
      ws.addEventListener("close", (ev: CloseEvent) =>
        fail(ev.code === LAB_FULL_CODE && ev.reason ? ev.reason : undefined),
      );
      ws.addEventListener(
        "message",
        (ev) => {
          if (settled) return;
          const msg = JSON.parse(ev.data as string) as ServerMsg;
          if (msg.type !== "welcome") return fail();
          settled = true;
          clearTimeout(timer);
          resolve({ ws, welcome: msg });
        },
        { once: true },
      );
    });
  }

  /** Route a ws's traffic here — only while it is the CURRENT one, so a
   * replaced socket's stragglers (and its late close) are ignored. */
  private attach(ws: WebSocket): void {
    ws.addEventListener("message", (ev) => {
      if (ws !== this.ws) return;
      this.lastHeardMs = performance.now();
      this.handle(ev);
    });
    ws.addEventListener("close", () => {
      if (ws === this.ws) this.dropped();
    });
  }

  /** The current socket is gone (closed, or the watchdog gave up on it):
   * start resuming. */
  private dropped(): void {
    if (this.state !== "open") return;
    // FL1: a lab session can't be resumed (the server never resumes one), so
    // a drop is SIGNAL LOST at once; its reload keeps `?lab` and comes back
    // to a fresh lab room — whose welcome the lab answers with its tuning.
    // (A reconnect may never land lab tuning in a normal room.)
    if (this.lab) {
      this.ws.close();
      this.lost();
      return;
    }
    this.state = "reconnecting";
    this.ws.close();
    this.droppedAt = performance.now();
    this.attempt = 0;
    this.events.onReconnecting?.();
    this.scheduleResume();
  }

  private scheduleResume(): void {
    const delay = reconnectDelayMs(
      this.attempt,
      performance.now() - this.droppedAt,
    );
    if (delay === null) this.lost();
    else setTimeout(() => this.tryResume(), delay);
  }

  /** One resume attempt. A hidden tab waits to be shown first: a resumed
   * session starts loading again, and nothing would pose it from here. */
  private async tryResume(): Promise<void> {
    if (document.hidden) {
      document.addEventListener("visibilitychange", () => this.tryResume(), {
        once: true,
      });
      return;
    }
    let next: { ws: WebSocket; welcome: WelcomeMsg };
    try {
      next = await GameSocket.open(this.name, this.welcome.resumeToken);
    } catch {
      this.attempt++;
      this.scheduleResume();
      return;
    }
    if (next.welcome.id !== this.selfId) {
      // The token was refused (expired, spent, or the server restarted): the
      // server made us someone new, and that is SIGNAL LOST's job, not ours.
      next.ws.close();
      this.lost();
      return;
    }
    this.ws = next.ws;
    // A welcome's strikes REPLACE what was held, same room or not (A2): a
    // bomb called off during the drop (`bombsOff`) must not fall on here,
    // and missile and shell ids are per room besides.
    this.missiles.clear();
    this.flak.clear();
    this.welcome = next.welcome;
    this.replayDestruction(next.welcome);
    this.addMissiles(next.welcome.missiles);
    this.bossHp = applyBossState(this.boss, next.welcome.boss);
    this.waves = decodeWaves(next.welcome.waves) ?? idleWaves();
    this.replayChaos(next.welcome.chaos);
    this.replayCaveIns(next.welcome.caveIns);
    this.attach(next.ws);
    this.delay.reset(); // the outage's arrival gaps are not jitter
    this.lastHeardMs = performance.now();
    this.state = "open";
    this.resumes++;
    this.events.onResumed?.(next.welcome);
  }

  /** A welcome's whole destruction: the broken set, then every collapse —
   * and (D5) the director's warnings still to happen. */
  private replayDestruction(welcome: WelcomeMsg): void {
    if (
      (welcome.destroyed?.length ?? 0) > 0 ||
      (welcome.collapses?.length ?? 0) > 0 ||
      (welcome.director?.length ?? 0) > 0
    ) {
      this.serverDestruction++;
    }
    this.cityDamage.reset(decodeChunkIds(welcome.destroyed));
    const records = Array.isArray(welcome.collapses) ? welcome.collapses : [];
    this.collapses.reset(records);
    for (const c of records) this.cityDamage.collapse(collapseChunks(c));
    this.director.clear();
    for (const w of welcome.director ?? []) {
      const e = decodeDirectorEvent(w);
      if (e) this.director.set(e.id, e);
    }
  }

  /** D5: a rebuild — applied now if it is the real one (`go`). */
  applyRebuild(r: RebuildWire): void {
    let restored: number[] = [];
    if (r.go) {
      if (r.k === 0) {
        restored = this.cityDamage.restoreBuilding(r.b);
        this.collapses.removeBuilding(r.b);
      } else {
        this.collapses.removeCrane(r.b);
      }
    }
    this.events.onRebuild?.(r, restored);
  }

  /** One live collapse: its chunks fall, its debris starts. */
  private applyCollapse(c: CollapseWire): void {
    this.cityDamage.collapse(collapseChunks(c));
    this.collapses.add(c);
    this.events.onCollapse?.(c);
  }

  /** C2: a welcome's chaos — the quakes and fires REPLACE
   * what was held (a resume may land in another room, or a calmer one). */
  private replayChaos(state: WireChaosState | undefined): void {
    this.quakes.clear();
    this.fires.clear();
    if (!state) return;
    for (const w of Array.isArray(state.quakes) ? state.quakes : []) {
      const q = decodeQuake(w);
      if (q) this.quakes.set(q.id, q);
    }
    for (const id of decodeChunkIds(state.fires)) this.fires.add(id);
  }

  /** U6: a welcome's cave-ins REPLACE what was held (a resume may land in
   * another room). */
  private replayCaveIns(list: readonly unknown[] | undefined): void {
    this.caveIns.list.length = 0;
    for (const w of Array.isArray(list) ? list : []) {
      const e = decodeCaveIn(w);
      if (e) addCaveIn(this.caveIns, e);
    }
  }

  /** C2: forget quakes that are long over at server time `t` (the
   * frame loop calls this; nothing is allocated when there is none). U6:
   * and cave-ins that have settled away. */
  pruneChaos(t: number): void {
    if (this.caveIns.list.length > 0) pruneCaveIns(this.caveIns, t);
    // S9: carrier launches whose rig has reset.
    const ls = this.boss.launches;
    if (ls && ls.length > 0 && launchDoneAt(ls[0] as BossLaunch) < t) {
      this.boss.launches = ls.filter((l) => launchDoneAt(l) >= t);
    }
    if (this.quakes.size === 0) return;
    prune.quakes = this.quakes;
    prune.t = t;
    this.quakes.forEach(pruneQuake);
    prune.quakes = null;
  }

  /** Hold every decodable missile of a welcome/event list (dupes are
   * harmless: same id, same strike). */
  private addMissiles(list: readonly unknown[] | undefined): void {
    for (const w of list ?? []) {
      const m = decodeMissile(w);
      if (m) this.missiles.set(m.id, m);
    }
  }

  private lost(): void {
    this.state = "lost";
    this.events.onClose?.();
  }

  get selfId(): string {
    return this.welcome.id;
  }

  /** The token a reload can resume this session with (W2). */
  get resumeToken(): string {
    return this.welcome.resumeToken;
  }

  /** FL1: is this a Flight Lab room? True only when the server's welcome
   * says so — the one gate for applying lab tuning on this client. */
  get lab(): boolean {
    return this.welcome.lab === true;
  }

  /** W2: the tab hid (`true`) or came back (`false`). */
  sendAway(on: boolean): void {
    this.send({ type: "away", on });
  }

  /** Call every frame with the frame's rAF timestamp — sends one pose per
   * TICK_UP_HZ interval on a fixed cadence, stamped with this frame's
   * smoothed server-time estimate (the server forwards it so remotes are
   * interpolated on when each pose was TAKEN, not when a tick sampled it). */
  sendPose(pose: Pose, frameMs: number): void {
    if (!this.cadence.due(frameMs)) return;
    if (this.ws.readyState !== WebSocket.OPEN) return;
    const t = this.frame.frameMs === frameMs ? this.nowClock.time : null;
    this.ws.send(
      JSON.stringify(
        t === null
          ? { type: "pose", pose }
          : { type: "pose", pose, t: Math.round(t) },
      ),
    );
  }

  /** Boot keepalive (W1): "still here" while nothing else is being sent. */
  sendPing(): void {
    this.send({ type: "ping" });
  }

  /** Announce one shot (seq = bullet id future hit claims will reference). */
  sendFire(seq: number): void {
    this.send({ type: "fire", seq });
  }

  /** Boost edge (F2): the instant a burn starts or ends. Never batched —
   * the server's energy mirror is stepped from exactly these edges. */
  sendBoost(on: boolean): void {
    this.send({ type: "boost", on });
  }

  /** Claim a shooter-side hit on `targetId` by bullet `seq`. The claim
   * declares the buffer this client was holding: the server's range slack is
   * derived from it, so a shooter on a clean link is judged against a tighter
   * window than one that genuinely needs a deep buffer.
   *
   * The declared delay is the one the frame was actually drawn at (the
   * smoothed clock lags or leads the controller while it slews), plus
   * `extraMs` — how much staler than the server's on-record pose that
   * target's image additionally is (RemotePlanes.extraDelayOf). */
  sendHit(
    targetId: string,
    bulletOrigin: Vec3,
    seq: number,
    extraMs = 0,
  ): void {
    this.send({
      type: "hit",
      targetId,
      bulletOrigin,
      seq,
      delay: Math.round(this.effectiveDelayMs + extraMs),
    });
  }

  /**
   * S4: one of our rounds met the sky boss's live weak point `wp`. The claim
   * carries the round's whole line — the muzzle, its unit direction, and the
   * render-clock time it met the zeppelin there — because the server re-runs
   * that line against the armour itself.
   */
  sendBossHit(
    wp: number,
    bulletOrigin: Vec3,
    dir: Vec3,
    seq: number,
    t: number,
  ): void {
    this.send({ type: "bossHit", wp, seq, bulletOrigin, dir, t });
  }

  /** Report flying into a building or the ground — or (D4) into the
   * falling wreck `wreck` (its id), which the server may credit. `t` (D3) is
   * the server time the movers — and collapse debris — were posed at for
   * the check. */
  sendCrash(wreck: number | null = null, t: number | null = null): void {
    this.send({
      type: "crash",
      ...(wreck !== null && { wreck }),
      ...(t !== null && { t }),
    });
  }

  /** W1: claim the room's shared enemy intensity (0–3). The server may
   * clamp or silently drop it (rate limit) — only the intensityConfig it
   * answers with is real. */
  sendSetIntensity(level: number): void {
    this.send({ type: "setIntensity", level });
  }

  /** FL1: the lab's tuning (a decoded export: JSON.parse(exportTuning(t)))
   * and/or its chaos and (W1) enemy-waves toggles. Ignored by the server
   * outside a lab room; the newest wins, so send the whole tuning each time. */
  sendLab(msg: { tuning?: unknown; chaos?: boolean; waves?: boolean }): void {
    this.send({ type: "lab", ...msg });
  }

  private send(msg: object): void {
    if (this.ws.readyState === WebSocket.OPEN)
      this.ws.send(JSON.stringify(msg));
  }

  /**
   * Advance the smoothed clocks to the frame at `frameMs` (the rAF
   * timestamp) and latch them. Call ONCE per frame, before anything reads
   * the render time: every system then poses against the same instant.
   */
  tickRenderClock(frameMs: number): FrameClock {
    if (this.clockOffset === null) {
      this.frame = { frameMs, time: null, target: null, serverNow: null };
      return this.frame;
    }
    const serverNow = frameMs + this.clockOffset;
    const target = serverNow - this.interpDelayMs;
    this.nowClock.advance(frameMs, serverNow);
    const time = this.renderClock.advance(frameMs, target);
    this.frame = { frameMs, time, target, serverNow };
    return this.frame;
  }

  /**
   * The server-clock time the world renders at, as latched by the last
   * tickRenderClock(): smoothed, never decreasing. Null until the first
   * snapshot.
   */
  renderTime(): number | null {
    return this.frame.time;
  }

  /** The interpolation buffer the controller wants right now, ms. */
  get interpDelayMs(): number {
    return this.delay.delayMs;
  }

  /** The buffer this frame was actually drawn with, ms: estimated server
   * now minus the smoothed render time. Equals interpDelayMs once the
   * clock has converged; differs only while it slews. */
  get effectiveDelayMs(): number {
    const { time, serverNow } = this.frame;
    if (time === null || serverNow === null) return this.interpDelayMs;
    return Math.max(0, serverNow - time);
  }

  /** Measured snapshot-arrival jitter, ms — QA/telemetry only. */
  get jitterMs(): number {
    return this.delay.jitter;
  }

  private handle(ev: MessageEvent): void {
    const msg = JSON.parse(ev.data as string) as ServerMsg;
    switch (msg.type) {
      case "snapshot": {
        const arrival = performance.now();
        this.delay.observe(arrival);
        // Each sample of serverTime − now is the true offset minus that
        // packet's latency, so the LARGEST sample is the best estimate; adapt
        // slowly downward to track drift or a route change.
        const sample = msg.time - arrival;
        if (this.clockOffset === null || sample > this.clockOffset) {
          this.clockOffset = sample;
        } else {
          this.clockOffset += (sample - this.clockOffset) * 0.02;
        }
        const decoded: SnapshotMsg = {
          type: "snapshot",
          time: msg.time,
          players: msg.p.map(decodeSnapshotEntry),
        };
        this.events.onSnapshot?.(decoded);
        break;
      }
      case "playerJoined":
        this.events.onPlayerJoined?.(msg.player);
        break;
      case "playerLeft":
        this.events.onPlayerLeft?.(msg.id);
        break;
      case "fired":
        this.events.onFired?.(msg.id);
        break;
      case "damage":
        this.events.onDamage?.(msg);
        break;
      case "death":
        this.events.onDeath?.(msg);
        break;
      case "cityEvent":
        this.events.onCityEvent?.(msg.event);
        break;
      case "respawn":
        this.events.onRespawn?.(msg);
        break;
      case "score":
        this.events.onScores?.(msg.scores);
        break;
      case "intensityConfig":
        this.events.onIntensityConfig?.(msg);
        break;
      case "waves": {
        const w = decodeWaves(msg.w);
        if (w) {
          this.waves = w;
          this.events.onWaves?.(w);
        }
        break;
      }
      case "newsHeli":
        this.events.onNewsHeli?.(msg);
        break;
      case "awayStarted":
        this.events.onAwayStarted?.();
        break;
      case "boss": {
        this.serverDestruction++;
        const raid = decodeRaid(msg.r);
        if (!raid) break;
        this.boss.raid = raid;
        this.boss.down = null;
        this.boss.launches = [];
        this.bossHp = raidMaxHp(raid);
        this.events.onBoss?.(raid);
        break;
      }
      case "bossLaunch": {
        const l = decodeLaunch(msg.l);
        if (!l || this.boss.raid?.id !== l.raid) break;
        const ls = this.boss.launches ?? [];
        if (ls.some((o) => o.id === l.id)) break;
        this.boss.launches = [...ls, l];
        this.events.onBossLaunch?.(l, String(msg.bot));
        break;
      }
      case "bossHp":
        if (
          this.boss.raid?.id === msg.id &&
          Array.isArray(msg.hp) &&
          msg.hp.length === this.bossHp.length &&
          msg.hp.every((v) => typeof v === "number" && Number.isFinite(v))
        ) {
          this.bossHp = msg.hp;
        }
        break;
      case "flak":
        for (const w of Array.isArray(msg.f) ? msg.f : []) {
          const f = decodeFlak(w);
          if (f) this.flak.set(f.id, f);
        }
        break;
      case "bossDown":
        if (isBossDown(msg.d) && this.boss.raid?.id === msg.d.id) {
          this.boss.down = msg.d;
          this.bossHp = this.bossHp.map(() => 0);
          this.events.onBossDown?.(msg);
        }
        break;
      case "missile":
        this.serverDestruction++;
        this.addMissiles([msg.m]);
        break;
      case "quake": {
        this.serverChaos++;
        const q = decodeQuake(msg.q);
        if (q) {
          this.quakes.set(q.id, q);
          this.events.onQuake?.(q);
        }
        break;
      }
      case "caveIn": {
        this.serverChaos++;
        const e = decodeCaveIn(msg.c);
        const c = e ? addCaveIn(this.caveIns, e) : null;
        if (c) this.events.onCaveIn?.(c);
        break;
      }
      case "fires":
        this.serverChaos++;
        for (const id of decodeChunkIds(msg.on)) this.fires.add(id);
        for (const id of decodeChunkIds(msg.off)) this.fires.delete(id);
        break;
      case "chunks":
        this.serverDestruction++;
        this.cityDamage.apply(decodeChunkIds(msg.d));
        break;
      case "collapse":
        this.serverDestruction++;
        this.applyCollapse(msg.c);
        break;
      case "directorWarn": {
        this.serverDestruction++;
        const e = decodeDirectorEvent(msg.e);
        if (e) {
          this.director.set(e.id, e);
          this.events.onDirectorWarn?.(e);
        }
        break;
      }
      case "rebuild":
        this.serverDestruction++;
        this.applyRebuild(msg.r);
        break;
      case "courseResult":
        this.events.onCourseResult?.(msg);
        break;
      case "courseBoard":
        this.events.onCourseBoard?.(msg);
        break;
      case "award": {
        const award = sanitizeAward(msg);
        if (award) this.events.onAward?.(award);
        break;
      }
      case "welcome":
        break; // already consumed by open()
    }
  }
}

/**
 * S7: an `award` as this build understands it, or null when its shape is
 * junk. Medal kinds this build does not know (a later D3/S4 addition seen
 * by an old tab) are dropped rather than rendered as nonsense, and an
 * unknown tier is dropped the same way.
 */
export function sanitizeAward(msg: AwardMsg): AwardMsg | null {
  if (typeof msg.id !== "string" || typeof msg.victimId !== "string") {
    return null;
  }
  const medals = Array.isArray(msg.medals)
    ? msg.medals.filter(isMedalKind)
    : [];
  const tier = (STREAK_TIERS as readonly unknown[]).includes(msg.tier)
    ? msg.tier
    : undefined;
  return {
    type: "award",
    id: msg.id,
    victimId: msg.victimId,
    medals: [...new Set(medals)],
    ...(tier !== undefined && { tier }),
  };
}
