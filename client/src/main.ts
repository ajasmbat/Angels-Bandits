// T2: solo flight over the torus city. T3: the same city, shared. T4: the
// dogfight — hold the mouse to fire heat-limited bursts, bullets simulate
// locally and hits are claimed to the server (favor the shooter), while HP,
// kills, deaths, and respawns only ever arrive FROM the server (authority
// split). Death freezes the plane for a kill-cam beat until the server's
// respawn message reseeds the flight state far from every enemy.

import {
  BULLET_SPEED,
  CLOUD_BASE,
  FOG_DISTANCE,
  MAX_HP,
} from "@angels-bandits/common/constants";
import {
  type FlightState,
  createFlightState,
  stepFlight,
} from "@angels-bandits/common/flight";
import type { ScoreEntry, SpawnState } from "@angels-bandits/common/protocol";
import { strikesInWindow } from "@angels-bandits/common/storm";
import { wrapDelta, wrapDistance } from "@angels-bandits/common/world";
import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { RadioQueue, RadioVoice } from "./audio/radio";
import { GameAudio } from "./audio/sound";
import { NEAR_MISS_RADIUS, closestApproach, spatialize } from "./audio/spatial";
import { ThunderSchedule } from "./audio/thunder";
import { Bullets } from "./game/bullets";
import {
  AmbientChatter,
  type Callout,
  LOW_HP_CALLOUT,
  checkInCallout,
  hitCallout,
  maydayCallout,
  nearMissCallout,
  offStationCallout,
  ownKillCallout,
  splashCallout,
  threatCallout,
  threatOnSix,
} from "./game/callouts";
import { ChaseCamera } from "./game/camera";
import { detectCrash } from "./game/collision";
import { FlightInputSource } from "./game/flight-input";
import { createFreeLook, shapeInput, stepFreeLook } from "./game/freelook";
import { Guns } from "./game/guns";
import { bulletHitsSphere } from "./game/hitdetect";
import { magnetizeVelocity } from "./game/magnetism";
import { GameSocket } from "./net/socket";
import { CityRenderer } from "./render/city";
import { FacadeGarnishRenderer } from "./render/facade-garnish";
import { Explosions, Sparks } from "./render/fx";
import { buildPlaneMesh, spinPropeller } from "./render/plane";
import { PlaneLights } from "./render/planelights";
import { RemotePlanes } from "./render/remotes";
import { RoofClutterRenderer } from "./render/roofclutter";
import { Signage } from "./render/signage";
import { GroundPlane, SkyDome, setupSky } from "./render/sky";
import { SmokeTrails, smokeActive } from "./render/smoke";
import {
  CloudDeck,
  REVEAL_COLOR,
  REVEAL_INTENSITY,
  StormRenderer,
  StormReveals,
  StrikeFeed,
  thunderGain,
  turbulenceOffset,
} from "./render/storm";
import { Streetlights } from "./render/streetlights";
import { Tracers } from "./render/tracers";
import { Traffic } from "./render/traffic";
import { PlaneTrails } from "./render/trails";
import { nearestImage } from "./render/wrapPlacement";
import { CommsTicker } from "./ui/comms";
import { initFullscreenUi } from "./ui/fullscreen";
import { HPBAR_ALTITUDE, HpBarSprite, HpBarTracker } from "./ui/hpbar";
import { Hud } from "./ui/hud";
import { requestName, showJoinError } from "./ui/join";
import { KillFeed } from "./ui/killfeed";
import { LeadIndicator } from "./ui/lead";
import { EdgeMarkers } from "./ui/markers";
import { Minimap } from "./ui/minimap";
import { Scoreboard } from "./ui/scoreboard";

// Fullscreen chrome first — the join overlay carries its own toggle button,
// so it must be live before the name prompt (hidden where unsupported).
initFullscreenUi();

// --- Join flow: name → server welcome (identity, seed, spawn) ---
const name = await requestName();
let socket: GameSocket;
try {
  socket = await GameSocket.connect(name);
} catch (err) {
  showJoinError(
    err instanceof Error ? err.message : "could not reach the game server",
  );
  throw err;
}
const { welcome } = socket;

// --- Scene & renderer ---
const scene = new THREE.Scene();
setupSky(scene);

const camera = new THREE.PerspectiveCamera(
  70,
  window.innerWidth / window.innerHeight,
  0.1,
  FOG_DISTANCE + 100,
);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
// Filmic curve keeps the HDR emissives from clipping; the OutputPass applies
// this + sRGB at the end of the composer chain.
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.body.appendChild(renderer.domElement);

// --- Post pipeline: render → bloom → tonemap+sRGB (V1 night look) ---
// The bloom threshold sits above everything lit-but-not-emissive (facades peak
// ~0.05 luminance in linear HDR, the sky dome ~0.05) and below the emissives
// (windows ~0.8+, lamp heads ~0.9, tracers ~1.5) — so ONLY emissives glow.
// UnrealBloomPass runs its blur chain from HALF the drawing-buffer resolution.
const BLOOM_STRENGTH = 0.42;
const BLOOM_RADIUS = 0.3;
const BLOOM_THRESHOLD = 0.72;
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  BLOOM_STRENGTH,
  BLOOM_RADIUS,
  BLOOM_THRESHOLD,
);
composer.addPass(bloomPass);
composer.addPass(new OutputPass());
// The composer renders many passes per frame — reset the info counters
// ourselves so __ab.perf() reports the whole frame, not just the last pass.
renderer.info.autoReset = false;

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
});

// --- World (city seed comes from the server so every roommate agrees) ---
const city = new CityRenderer(welcome.seed);
scene.add(city.mesh);
// Roof clutter + landmark beacons dress the same shared Building[] (V2).
const roofClutter = new RoofClutterRenderer(city.cityBuildings);
scene.add(roofClutter.group);
// Parapet caps + entrance canopies dress the same shared Building[] (ANGE-XY8LH8).
const facadeGarnish = new FacadeGarnishRenderer(city.cityBuildings);
scene.add(facadeGarnish.group);
const ground = new GroundPlane();
scene.add(ground.mesh);
const skyDome = new SkyDome();
scene.add(skyDome.mesh);
const streetlights = new Streetlights();
scene.add(streetlights.group);
// Street-level neon (S2): marquees, billboards, strips, spill — one shared
// Building[] again, so signage dresses exactly the rendered facades.
const signage = new Signage(city.cityBuildings, welcome.seed);
scene.add(signage.group);
// Cosmetic street traffic — pure function of the synced server clock, so
// every client (late joiners included) sees identical cars. Zero netcode.
const traffic = new Traffic(welcome.seed);
scene.add(traffic.mesh);
const explosions = new Explosions();
scene.add(explosions.group);
const sparks = new Sparks();
scene.add(sparks.points);
const smoke = new SmokeTrails();
scene.add(smoke.points);
// ST2 storm: bolts + flash from the shared schedule — zero strike netcode;
// every client computes the identical storm from (seed, synced clock).
const storm = new StormRenderer(city.cityBuildings);
scene.add(storm.group, storm.flashLight);
const strikeFeed = new StrikeFeed(welcome.seed);
// The deck everyone shares: seeded layout, drifting on the synced clock.
const clouds = new CloudDeck(welcome.seed);
scene.add(clouds.group);
// The storm's neutral radar: strikes reveal nearby planes to EVERYONE.
const reveals = new StormReveals();
// Distance-delayed rumbles: flash now, thunder wrapDistance/340 later.
const thunder = new ThunderSchedule();
/** Recent strikes as consumed from the schedule (QA hook — two tabs must
 * report identical entries, since the schedule is shared, not streamed). */
const strikeLog: { timeMs: number; x: number; z: number }[] = [];

const plane = buildPlaneMesh();
scene.add(plane);

// Night visibility (ANGE-L7F2OS): every plane's aviation lights share one
// Points draw call, every plane's wingtip ribbons one mesh — planes light
// themselves, the world stays dark.
const planeLights = new PlaneLights();
scene.add(planeLights.points);
const planeTrails = new PlaneTrails();
scene.add(planeTrails.mesh);

// --- Remote planes ---
const remotes = new RemotePlanes(
  scene,
  socket.selfId,
  planeLights,
  planeTrails,
);
remotes.setRoster(welcome.roster);

// --- Combat: guns, bullets, tracers, HUD chrome ---
const guns = new Guns();
const bullets = new Bullets();
const tracers = new Tracers();
scene.add(tracers.group);
const audio = new GameAudio();
const hud = new Hud();
const minimap = new Minimap(city.cityBuildings);
const edgeMarkers = new EdgeMarkers();
const leadIndicator = new LeadIndicator();
const markerScratch = new THREE.Vector3();
const hpBar = new HpBarTracker();
const hpBarSprite = new HpBarSprite();
scene.add(hpBarSprite.sprite);
const killFeed = new KillFeed();
const scoreboard = new Scoreboard(socket.selfId);
scoreboard.setRoster(welcome.roster);
scoreboard.setScores(welcome.scores);

/** id → name/isBot for feed + radio lines (self included; remotes tracks the
 * others too). isBot gates whether the VOICE may speak the callsign. */
const players = new Map<string, { name: string; isBot: boolean }>(
  welcome.roster.map((r) => [r.id, { name: r.name, isBot: r.isBot ?? false }]),
);
const nameOf = (id: string): string => players.get(id)?.name ?? "???";
const isBotOf = (id: string): boolean => players.get(id)?.isBot ?? false;

// --- Radio comms: one channel, priority queue, voice + ticker (client-only) ---
// The pre-rendered voice bundle (tools/gen-radio-voices.sh): asset id → url,
// fetched eagerly by RadioVoice and decoded once the AudioContext runs.
const radioAssetUrls = Object.fromEntries(
  Object.entries(
    import.meta.glob("../assets/radio/*.ogg", {
      eager: true,
      query: "?url",
      import: "default",
    }) as Record<string, string>,
  ).map(([path, url]) => [
    path.replace(/^.*\//, "").replace(/\.ogg$/, ""),
    url,
  ]),
);
const radio = new RadioQueue();
const radioVoice = new RadioVoice(audio, radioAssetUrls);
const comms = new CommsTicker();
const ambient = new AmbientChatter(welcome.seed, performance.now());
const RADIO_VOICE_KEY = "ab-radio-voice";
let radioVoiceOn = localStorage.getItem(RADIO_VOICE_KEY) !== "off";
hud.bindRadioToggle(radioVoiceOn, (on) => {
  radioVoiceOn = on;
  localStorage.setItem(RADIO_VOICE_KEY, on ? "on" : "off");
});
/** Armed while HP is healthy; fires once per drop below LOW_HP_CALLOUT. */
let lowHpArmed = true;
/** Recent on-air lines (QA hook — headless runs can't hear the TTS). */
const radioLog: {
  at: number;
  speaker: string;
  ticker: string;
  voice: string;
}[] = [];
const say = (c: Callout): boolean => radio.enqueue(c, performance.now());
const botCallsigns = (): string[] => {
  const out: string[] = [];
  for (const p of players.values()) if (p.isBot) out.push(p.name);
  return out;
};

// --- Simulation state ---
const input = new FlightInputSource();
const chase = new ChaseCamera();
// Hold-E free-look: pure client camera state, never streamed (B2).
let freelook = createFreeLook();
let flight: FlightState = createFlightState(
  welcome.spawn.pos,
  welcome.spawn.yaw,
);
flight = {
  ...flight,
  speed: welcome.spawn.speed,
  targetSpeed: welcome.spawn.speed,
};
chase.snapTo(flight);

let alive = true;
let killCamTargetId: string | null = null;
// Server-said combat state about self (snapshots), kept for HUD + QA.
let selfHp = MAX_HP;
let selfProt = true;
let lastScores: ScoreEntry[] = welcome.scores;
let lastDeath: { victimId: string; killerId: string | null } | null = null;
let remoteFireSide = 1;

const fadeEl = document.getElementById("fade") as HTMLDivElement;
const hudEl = document.getElementById("hud") as HTMLDivElement;

/** Instant black, then ease back in — death and respawn both get the beat. */
function flashFade(): void {
  fadeEl.classList.add("dead");
  requestAnimationFrame(() =>
    requestAnimationFrame(() => fadeEl.classList.remove("dead")),
  );
}

/** Freeze into the kill-cam; the server's respawn message ends it. */
function enterDeath(killerId: string | null, cause?: "storm"): void {
  // Kill-cam owns the camera — force-exit free-look instantly.
  freelook = createFreeLook();
  hud.setFreeLook(false);
  killCamTargetId = killerId;
  hud.showKillCam(killerId === null ? null : nameOf(killerId), cause);
  if (!alive) return;
  alive = false;
  plane.visible = false;
  planeTrails.clear(socket.selfId);
  bullets.clearOwn();
  flashFade();
}

function respawnSelf(spawn: SpawnState): void {
  planeTrails.clear(socket.selfId); // respawn teleports — no streak
  flight = createFlightState(spawn.pos, spawn.yaw);
  flight = { ...flight, speed: spawn.speed, targetSpeed: spawn.speed };
  chase.snapTo(flight);
  alive = true;
  killCamTargetId = null;
  plane.visible = true;
  hud.hideKillCam();
  guns.reset(performance.now());
  lowHpArmed = true; // fresh plane, fresh "I'm hit" edge
  flashFade();
}

/** Cosmetic tracer burst for a remote's validated shot. */
function remoteFired(id: string): void {
  const pose = remotes.poseOf(id);
  if (!pose) return;
  remoteFireSide = -remoteFireSide;
  const quat = new THREE.Quaternion(
    pose.quat.x,
    pose.quat.y,
    pose.quat.z,
    pose.quat.w,
  );
  const muzzle = new THREE.Vector3(
    remoteFireSide * 3.5,
    0,
    -0.8,
  ).applyQuaternion(quat);
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(quat);
  const speed = BULLET_SPEED + pose.speed;
  const origin = {
    x: pose.pos.x + muzzle.x,
    y: pose.pos.y + muzzle.y,
    z: pose.pos.z + muzzle.z,
  };
  bullets.spawn(
    -1,
    origin,
    { x: fwd.x * speed, y: fwd.y * speed, z: fwd.z * speed },
    true,
  );
  tracers.flash(origin, performance.now());
  audio.remoteGunshot(origin, flight.pos, flight.yaw);
}

// --- Server events ---
socket.events.onSnapshot = (snap) => {
  remotes.ingest(snap);
  const self = snap.players.find((p) => p.id === socket.selfId);
  if (self) {
    selfHp = self.hp;
    selfProt = self.prot;
    hud.setHp(self.hp);
    hud.setProtected(self.prot);
    // Regen back above the threshold re-arms the "I'm hit" callout.
    if (self.hp >= LOW_HP_CALLOUT) lowHpArmed = true;
  }
};
socket.events.onPlayerJoined = (player) => {
  players.set(player.id, {
    name: player.name,
    isBot: player.isBot ?? false,
  });
  remotes.playerJoined(player);
  scoreboard.playerJoined(player);
  say(checkInCallout(player.name, player.isBot ?? false));
};
socket.events.onPlayerLeft = (id) => {
  say(offStationCallout(nameOf(id), isBotOf(id)));
  remotes.playerLeft(id);
  scoreboard.playerLeft(id);
  players.delete(id);
};
socket.events.onFired = (id) => remoteFired(id);
socket.events.onDamage = (msg) => {
  if (msg.shooterId === socket.selfId) {
    hud.hitConfirm(performance.now());
    // OUR damage only — another player's hits never raise our target bar.
    if (msg.targetId !== socket.selfId) {
      hpBar.recordDamage(msg.targetId, msg.hp, performance.now());
    }
  }
  if (msg.targetId === socket.selfId) {
    selfHp = msg.hp;
    hud.setHp(msg.hp);
    radio.noteCombat(performance.now());
    if (lowHpArmed && msg.hp < LOW_HP_CALLOUT) {
      lowHpArmed = false;
      say(hitCallout(name));
    }
  }
};
socket.events.onDeath = (msg) => {
  lastDeath = { victimId: msg.victimId, killerId: msg.killerId };
  // Grab the victim's position before setDead clears it (self = own plane).
  const victimPos =
    msg.victimId === socket.selfId
      ? flight.pos
      : remotes.poseOf(msg.victimId)?.pos;
  if (victimPos) {
    audio.explosion(victimPos, flight.pos, flight.yaw);
    explosions.explode(victimPos, performance.now());
    // Storm kill: the bolt comes down ON the victim (kill-cam length) with
    // an immediate hard crack — the one strike that isn't on the schedule.
    if (msg.cause === "storm") {
      storm.boltAt(victimPos, performance.now());
      audio.thunder(
        Math.max(0.5, thunderGain(wrapDistance(victimPos, flight.pos))),
        true,
      );
    }
  }
  killFeed.add(
    msg.killerId === null ? null : nameOf(msg.killerId),
    nameOf(msg.victimId),
    msg.cause,
  );
  if (msg.killerId === socket.selfId && msg.victimId !== socket.selfId) {
    hud.killConfirm(performance.now());
    audio.killConfirm();
  }
  hpBar.clear(msg.victimId); // never float a stale bar over a respawn
  if (msg.victimId === socket.selfId) {
    enterDeath(msg.killerId, msg.cause === "storm" ? "storm" : undefined);
  } else remotes.setDead(msg.victimId);
  // Radio: the victim's mayday from us, or the killer's "splash one".
  if (msg.victimId === socket.selfId) {
    radio.noteCombat(performance.now());
    say(maydayCallout(name));
  } else if (msg.killerId === socket.selfId) {
    say(ownKillCallout(name));
  } else if (msg.killerId !== null) {
    say(splashCallout(nameOf(msg.killerId), isBotOf(msg.killerId)));
  }
};
socket.events.onRespawn = (msg) => {
  // Fresh spawn, fresh trail — a rebased teleport would smear smoke 1 km.
  smoke.clear(msg.id);
  if (msg.id === socket.selfId) respawnSelf(msg.spawn);
  else remotes.respawn(msg.id);
};
socket.events.onScores = (scores) => {
  lastScores = scores;
  scoreboard.setScores(scores);
};

// --- Dev/QA hooks (used by the headless verification harness) ---
const perf = { frames: 0, ms: 0, fps: 0, frameMs: 0 };
declare global {
  interface Window {
    __ab?: {
      state: () => FlightState;
      teleport: (x: number, z: number, y?: number, yaw?: number) => void;
      perf: () => {
        fps: number;
        frameMs: number;
        drawCalls: number;
        smokePuffs: number;
      };
      net: () => {
        selfId: string;
        roomId: string;
        remotes: ReturnType<RemotePlanes["debug"]>;
        renderTime: number | null;
      };
      combat: () => {
        alive: boolean;
        hp: number;
        prot: boolean;
        heat: { heat: number; locked: boolean };
        scores: ScoreEntry[];
        lastDeath: { victimId: string; killerId: string | null } | null;
        targets: { id: string; pos: { x: number; y: number; z: number } }[];
        hpBarTarget: string | null;
      };
      aimAt: (x: number, z: number, y?: number) => void;
      setFiring: (held: boolean) => void;
      freelook: () => ReturnType<typeof createFreeLook>;
      lampImage: (x: number, z: number) => { x: number; z: number } | null;
      traffic: () => ReturnType<Traffic["debug"]>;
      cityStats: () => {
        buildings: number;
        tierInstances: number;
        clutterInstances: number;
        garnishInstances: number;
      };
      signage: () => Signage["counts"];
      signImage: (x: number, z: number) => { x: number; z: number } | null;
      garnishImage: (x: number, z: number) => { x: number; z: number } | null;
      radio: () => {
        voiceOn: boolean;
        voiceReady: boolean;
        inCombat: boolean;
        log: { at: number; speaker: string; ticker: string; voice: string }[];
      };
      storm: () => {
        seed: number;
        strikes: { timeMs: number; x: number; z: number }[];
        nextStrike: { timeMs: number; x: number; z: number } | null;
        pings: { id: string; pos: { x: number; y: number; z: number } }[];
        selfReveal: number;
        fogFar: number;
        shake: { x: number; y: number; z: number };
      };
    };
  }
}
window.__ab = {
  state: () => flight,
  teleport: (x, z, y = 300, yaw = 0) => {
    flight = { ...createFlightState({ x, y, z }, yaw), speed: flight.speed };
    chase.snapTo(flight);
  },
  perf: () => ({
    fps: perf.fps,
    frameMs: perf.frameMs,
    drawCalls: renderer.info.render.calls,
    smokePuffs: smoke.puffCount,
  }),
  net: () => ({
    selfId: socket.selfId,
    roomId: welcome.roomId,
    remotes: remotes.debug(),
    renderTime: socket.renderTime(),
  }),
  combat: () => ({
    alive,
    hp: selfHp,
    prot: selfProt,
    heat: guns.state,
    scores: lastScores,
    lastDeath,
    targets: remotes.targets(),
    // Gun-feel QA: whose HP bar is showing right now (null = faded/none).
    hpBarTarget: hpBar.current(performance.now())?.targetId ?? null,
  }),
  // Point the nose at a canonical world position (torus-aware, QA only).
  aimAt: (x, z, y = flight.pos.y) => {
    const d = wrapDelta(flight.pos, { x, y, z });
    const flat = Math.hypot(d.x, d.z);
    flight = {
      ...flight,
      yaw: Math.atan2(-d.x, -d.z),
      pitch: Math.atan2(d.y, flat),
      roll: 0,
    };
    chase.snapTo(flight);
  },
  setFiring: (held) => guns.setTrigger(held),
  // B2 QA: current free-look state (drive it with real key/mouse events).
  freelook: () => freelook,
  // Seam QA: where the lamp nearest canonical (x, z) is drawn right now.
  lampImage: (x, z) => streetlights.imageOf(x, z),
  // Traffic QA: canonical poses of the first cars at the current synced time —
  // two tabs must report the same cars at the same server time.
  traffic: () => traffic.debug(socket.renderTime()),
  // V2 QA: instance counts for the perf report.
  cityStats: () => ({
    buildings: city.cityBuildings.length,
    tierInstances: city.tierInstanceCount,
    clutterInstances: roofClutter.instanceCount,
    garnishInstances: facadeGarnish.instanceCount,
  }),
  // S2 QA: signage instance counts + drawn-position read-back (seam checks).
  signage: () => signage.counts,
  signImage: (x, z) => signage.imageOf(x, z),
  // ANGE-XY8LH8 seam QA: drawn position of the parapet nearest (x, z).
  garnishImage: (x, z) => facadeGarnish.imageOf(x, z),
  // Radio QA: recent on-air lines (headless runs can't hear the voice).
  radio: () => ({
    voiceOn: radioVoiceOn,
    voiceReady: radioVoice.ready,
    inCombat: radio.inCombat(performance.now()),
    log: radioLog.map((l) => ({ ...l })),
  }),
  // ST2 QA: consumed strikes (two tabs must agree), the next scheduled
  // strike (for staging reveals), live reveal pings, and atmosphere state.
  storm: () => {
    const rt = socket.renderTime();
    return {
      seed: welcome.seed,
      strikes: strikeLog.map((s) => ({ ...s })),
      nextStrike:
        rt === null
          ? null
          : (strikesInWindow(welcome.seed, rt, rt + 40_000)[0] ?? null),
      pings: reveals.pings(performance.now()),
      selfReveal: reveals.levelOf(socket.selfId, performance.now()),
      fogFar: scene.fog instanceof THREE.Fog ? scene.fog.far : -1,
      shake: turbulenceOffset(performance.now(), flight.pos.y),
    };
  },
};

// --- Frame loop ---
const poseEuler = new THREE.Euler();
const poseQuat = new THREE.Quaternion();
let last = performance.now();
renderer.setAnimationLoop((now) => {
  const rawMs = now - last;
  const dt = Math.min(rawMs / 1000, 0.05); // clamp hitches, keep sim stable
  last = now;

  // Drain look deltas every frame (dead too) so stale mouse motion never
  // dumps into the orbit as one jump. Signs: mouse-right pans the view
  // right, mouse-up looks up (both hand-tuned with LOOK_SENSITIVITY).
  const lookDelta = input.takeLookDelta();
  planeLights.begin(); // own + remote lights re-append every frame
  if (alive) {
    freelook = stepFreeLook(
      freelook,
      input.freeLookHeld(),
      -lookDelta.dx,
      lookDelta.dy,
      dt,
    );
    hud.setFreeLook(freelook.held);
    flight = stepFlight(flight, shapeInput(input.read(), freelook), dt);
    if (detectCrash(flight, city.cityBuildings)) {
      // Report and freeze; the server decides credit and the respawn.
      socket.sendCrash();
      enterDeath(null);
    }
  }

  if (alive) {
    // Stream our pose up (rate-limited to TICK_UP_HZ inside the socket).
    poseEuler.set(flight.pitch, flight.yaw, flight.roll, "YXZ");
    poseQuat.setFromEuler(poseEuler);
    socket.sendPose({
      pos: flight.pos,
      quat: { x: poseQuat.x, y: poseQuat.y, z: poseQuat.z, w: poseQuat.w },
      speed: flight.speed,
    });

    // Guns: at most one shot a frame; the same seq goes to server and sim.
    // Free-look suppresses shots (heat keeps cooling, none builds).
    const shot = guns.update(now, flight, !freelook.held);
    if (shot) {
      bullets.spawn(shot.seq, shot.origin, shot.vel);
      socket.sendFire(shot.seq);
      tracers.flash(shot.origin, now);
      audio.gunshot();
      radio.noteCombat(now); // firing = combat radio discipline
    }

    // In-cloud turbulence (ST2): pure offsets applied to the DISPLAYED
    // camera and plane only — sendPose above already read flight.pos, and
    // the flight model never sees any of this. Different time phases keep
    // the camera and the airframe from moving in lockstep.
    const camShake = turbulenceOffset(now, flight.pos.y);
    const planeShake = turbulenceOffset(now + 537, flight.pos.y);
    chase.update(camera, flight, dt, freelook, camShake);
    const planePos = nearestImage(chase.position, flight.pos);
    plane.position.set(
      planePos.x + planeShake.x * 0.5,
      planePos.y + planeShake.y * 0.5,
      planePos.z + planeShake.z * 0.5,
    );
    plane.rotation.set(flight.pitch, flight.yaw, flight.roll, "YXZ");
    // Prop speed tracks the commanded throttle (same factor as remotes').
    spinPropeller(plane, dt * flight.targetSpeed * 0.7);
    // Own aviation lights + wingtip trails (strobe on the synced clock so
    // every client sees this plane blink at the same instant).
    planeLights.place(
      socket.selfId,
      planePos,
      poseQuat,
      flight.speed,
      socket.renderTime() ?? now,
    );
    planeTrails.emit(socket.selfId, flight.pos, poseQuat, now, dt);
  } else if (killCamTargetId !== null) {
    // Kill-cam beat: hold position, watch the killer if we can see them.
    const killerPose = remotes.poseOf(killCamTargetId);
    if (killerPose) {
      const aim = nearestImage(chase.position, killerPose.pos);
      camera.lookAt(aim.x, aim.y, aim.z);
    }
  }

  // Bullets: bend own rounds a hair toward in-cone targets (magnetism seam),
  // then fly and sweep the frame's segment over every living remote.
  const targets = remotes.targets();
  for (const bullet of bullets.all) {
    if (!bullet.cosmetic) {
      bullet.vel = magnetizeVelocity(bullet.pos, bullet.vel, targets, dt);
    }
  }
  bullets.step(dt);
  for (const bullet of [...bullets.all]) {
    if (bullet.cosmetic) {
      // An enemy bullet shaving past this frame → panned near-miss whoosh.
      if (
        alive &&
        closestApproach(bullet.prev, bullet.pos, flight.pos) < NEAR_MISS_RADIUS
      ) {
        audio.whoosh(spatialize(flight.pos, flight.yaw, bullet.pos).pan, now);
        radio.noteCombat(now);
        say(nearMissCallout(name));
      }
      continue;
    }
    for (const target of targets) {
      if (bulletHitsSphere(bullet.prev, bullet.pos, target.pos)) {
        socket.sendHit(target.id, bullet.origin, bullet.seq);
        bullets.remove(bullet);
        // Instant shooter-side feedback (marker + thunk + sparks at the
        // impact point); the server's damage broadcast stays the
        // authoritative confirm (crosshair blip).
        hud.hitMarker(now);
        audio.hitThunk();
        sparks.burst(bullet.pos, now);
        break;
      }
    }
  }

  remotes.update(socket.renderTime(), chase.position, dt, now, (id) =>
    reveals.levelOf(id, now),
  );
  // Own rim-flash: the storm lit us up — same tint the remotes wear.
  const selfReveal = alive ? reveals.levelOf(socket.selfId, now) : 0;
  plane.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      const mat = child.material as THREE.MeshStandardMaterial;
      if (selfReveal > 0) {
        mat.emissive.setHex(REVEAL_COLOR);
        mat.emissiveIntensity = selfReveal * REVEAL_INTENSITY;
      } else if (mat.emissive.getHex() === REVEAL_COLOR) {
        mat.emissive.setHex(0x000000);
        mat.emissiveIntensity = 1;
      }
    }
  });
  planeLights.commit();
  planeTrails.update(chase.position, now);

  // --- Radio: threat scan, ambient chatter, then the one-line channel ---
  if (alive && threatOnSix(flight.pos, flight.yaw, remotes.headings())) {
    say(threatCallout(name));
    radio.noteCombat(now); // an active tail counts as combat
  }
  const ambientLine = ambient.poll(now, botCallsigns());
  if (ambientLine) say(ambientLine);
  const onAir = radio.poll(now);
  if (onAir) {
    comms.add(onAir.speaker, onAir.ticker);
    radioLog.push({
      at: now,
      speaker: onAir.speaker,
      ticker: onAir.ticker,
      voice: onAir.voice,
    });
    if (radioLog.length > 20) radioLog.shift();
    // Muted voice: nothing plays — the ticker alone carries the line and
    // the queue's estimated duration paces the channel.
    if (radioVoiceOn) {
      radioVoice.speak(onAir.voice, onAir.speaker, () =>
        radio.release(performance.now()),
      );
    }
  }

  city.update(chase.position);
  // Beacons pulse on server-synced time so every client is in phase.
  roofClutter.update(chase.position, socket.renderTime() ?? now);
  facadeGarnish.update(chase.position);
  streetlights.update(chase.position);
  // Neon pulses on the same synced clock as the beacons.
  signage.update(chase.position, socket.renderTime() ?? now);
  traffic.update(chase.position, socket.renderTime());
  ground.update(chase.position);
  skyDome.update(chase.position);
  // Wounded smoke: own plane from server-said self HP, every remote (human
  // or bot) from snapshot HP — all clients see the same wounds. Death clouds
  // simply stop being synced and age out inside SmokeTrails.
  if (alive) {
    smoke.sync(socket.selfId, flight.pos, now, smokeActive(selfHp));
  }
  for (const target of targets) {
    smoke.sync(target.id, target.pos, now, smokeActive(target.hp));
  }
  smoke.update(chase.position, now);
  // Storm: consume this frame's scheduled strikes, then age/place the bolts
  // and drive the sky-flash pulse (fog stain + dome tint + violet ambient).
  for (const s of strikeFeed.poll(socket.renderTime())) {
    storm.strike(s, now);
    strikeLog.push({ timeMs: s.timeMs, x: s.x, z: s.z });
    if (strikeLog.length > 12) strikeLog.shift();
    // Everyone in the strike's column is revealed — self included; remote
    // positions come from the same interpolated poses everything else uses.
    const planesNow = [
      ...(alive ? [{ id: socket.selfId, pos: flight.pos }] : []),
      ...remotes.targets(),
    ];
    reveals.onStrike(s, planesNow, now);
    thunder.add(s, flight.pos, now);
  }
  for (const ev of thunder.due(now)) audio.thunder(ev.gain, ev.hard);
  storm.update(chase.position, now);
  clouds.update(chase.position, camera.quaternion, socket.renderTime());
  const sky = storm.atmosphere(scene, chase.position.y, now);
  skyDome.tint(sky.tint);
  skyDome.mesh.visible = sky.domeVisible;
  explosions.update(chase.position, now, dt);
  sparks.update(chase.position, now);
  tracers.update(bullets.all, chase.position, now);

  // Target HP bar: over the plane WE damaged in the last 3 s (fading).
  const shownBar = hpBar.current(now);
  const barTarget = shownBar
    ? targets.find((t) => t.id === shownBar.targetId)
    : undefined;
  if (shownBar && barTarget) {
    const p = nearestImage(chase.position, barTarget.pos);
    hpBarSprite.sprite.position.set(p.x, p.y + HPBAR_ALTITUDE, p.z);
    // Snapshot HP is fresher than the damage event (covers regen ticks).
    hpBarSprite.show(barTarget.hp, shownBar.alpha);
  } else {
    hpBarSprite.hide();
  }

  const heat = guns.state;
  hud.setHeat(heat.heat, heat.locked);
  hud.update(now);
  const contacts = remotes.contacts();
  minimap.update(flight.pos, flight.yaw, contacts, reveals.pings(now));
  audio.setEngine(flight.targetSpeed, alive);
  audio.syncRemotes(contacts, flight.pos, flight.yaw);
  // In-cloud static bed: quiet crackle ramping in over the deck's first
  // 60 m. The only audio cue for the hidden ceiling — no HUD, by design.
  audio.setStatic(
    alive ? Math.min(1, Math.max(0, (flight.pos.y - CLOUD_BASE) / 60)) : 0,
  );

  renderer.info.reset();
  composer.render();

  // Matrices are fresh after the render — project the screen-space UI now.
  edgeMarkers.update(
    camera,
    chase.position,
    targets.map((t) => t.pos),
    markerScratch,
  );
  leadIndicator.update(
    camera,
    chase.position,
    flight,
    alive ? targets : [], // no reticle from the kill-cam
    markerScratch,
  );

  // HUD + rolling perf counters (~2 Hz refresh).
  perf.frames++;
  perf.ms += rawMs;
  if (perf.frames >= 30) {
    perf.frameMs = perf.ms / perf.frames;
    perf.fps = 1000 / perf.frameMs;
    perf.frames = 0;
    perf.ms = 0;
    hudEl.textContent =
      `SPD ${flight.speed.toFixed(0)} m/s  THR ${flight.targetSpeed.toFixed(0)}  ` +
      `ALT ${flight.pos.y.toFixed(0)} m  PLR ${remotes.count + 1}  FPS ${perf.fps.toFixed(0)}`;
  }
});
