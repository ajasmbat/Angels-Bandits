// T2: solo flight over the torus city. T3: the same city, shared. T4: the
// dogfight — hold the mouse to fire heat-limited bursts, bullets simulate
// locally and hits are claimed to the server (favor the shooter), while HP,
// kills, deaths, and respawns only ever arrive FROM the server (authority
// split). Death freezes the plane for a kill-cam beat until the server's
// respawn message reseeds the flight state far from every enemy.

import {
  BULLET_SPEED,
  FOG_DISTANCE,
  MAX_HP,
} from "@angels-bandits/common/constants";
import {
  type FlightState,
  createFlightState,
  stepFlight,
} from "@angels-bandits/common/flight";
import type { ScoreEntry, SpawnState } from "@angels-bandits/common/protocol";
import { wrapDelta } from "@angels-bandits/common/world";
import * as THREE from "three";
import { GameAudio } from "./audio/sound";
import { NEAR_MISS_RADIUS, closestApproach, spatialize } from "./audio/spatial";
import { Bullets } from "./game/bullets";
import { ChaseCamera } from "./game/camera";
import { detectCrash } from "./game/collision";
import { FlightInputSource } from "./game/flight-input";
import { Guns } from "./game/guns";
import { bulletHitsSphere } from "./game/hitdetect";
import { GameSocket } from "./net/socket";
import { CityRenderer } from "./render/city";
import { Explosions } from "./render/fx";
import { buildPlaneMesh, spinPropeller } from "./render/plane";
import { RemotePlanes } from "./render/remotes";
import { GroundPlane, SkyDome, setupSky } from "./render/sky";
import { Tracers } from "./render/tracers";
import { nearestImage } from "./render/wrapPlacement";
import { Hud } from "./ui/hud";
import { requestName, showJoinError } from "./ui/join";
import { KillFeed } from "./ui/killfeed";
import { LeadIndicator } from "./ui/lead";
import { EdgeMarkers } from "./ui/markers";
import { Minimap } from "./ui/minimap";
import { Scoreboard } from "./ui/scoreboard";

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
document.body.appendChild(renderer.domElement);

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// --- World (city seed comes from the server so every roommate agrees) ---
const city = new CityRenderer(welcome.seed);
scene.add(city.mesh);
const ground = new GroundPlane();
scene.add(ground.mesh);
const skyDome = new SkyDome();
scene.add(skyDome.mesh);
const explosions = new Explosions();
scene.add(explosions.group);

const plane = buildPlaneMesh();
scene.add(plane);

// --- Remote planes ---
const remotes = new RemotePlanes(scene, socket.selfId);
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
const killFeed = new KillFeed();
const scoreboard = new Scoreboard(socket.selfId);
scoreboard.setRoster(welcome.roster);
scoreboard.setScores(welcome.scores);

/** id → name for feed lines (self included; remotes tracks the others too). */
const playerNames = new Map<string, string>(
  welcome.roster.map((r) => [r.id, r.name]),
);
const nameOf = (id: string): string => playerNames.get(id) ?? "???";

// --- Simulation state ---
const input = new FlightInputSource();
const chase = new ChaseCamera();
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
function enterDeath(killerId: string | null): void {
  killCamTargetId = killerId;
  hud.showKillCam(killerId === null ? null : nameOf(killerId));
  if (!alive) return;
  alive = false;
  plane.visible = false;
  bullets.clearOwn();
  flashFade();
}

function respawnSelf(spawn: SpawnState): void {
  flight = createFlightState(spawn.pos, spawn.yaw);
  flight = { ...flight, speed: spawn.speed, targetSpeed: spawn.speed };
  chase.snapTo(flight);
  alive = true;
  killCamTargetId = null;
  plane.visible = true;
  hud.hideKillCam();
  guns.reset(performance.now());
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
  }
};
socket.events.onPlayerJoined = (player) => {
  playerNames.set(player.id, player.name);
  remotes.playerJoined(player);
  scoreboard.playerJoined(player);
};
socket.events.onPlayerLeft = (id) => {
  remotes.playerLeft(id);
  scoreboard.playerLeft(id);
  playerNames.delete(id);
};
socket.events.onFired = (id) => remoteFired(id);
socket.events.onDamage = (msg) => {
  if (msg.shooterId === socket.selfId) hud.hitConfirm(performance.now());
  if (msg.targetId === socket.selfId) {
    selfHp = msg.hp;
    hud.setHp(msg.hp);
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
  }
  killFeed.add(
    msg.killerId === null ? null : nameOf(msg.killerId),
    nameOf(msg.victimId),
  );
  if (msg.victimId === socket.selfId) enterDeath(msg.killerId);
  else remotes.setDead(msg.victimId);
};
socket.events.onRespawn = (msg) => {
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
      perf: () => { fps: number; frameMs: number; drawCalls: number };
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
      };
      aimAt: (x: number, z: number, y?: number) => void;
      setFiring: (held: boolean) => void;
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
};

// --- Frame loop ---
const poseEuler = new THREE.Euler();
const poseQuat = new THREE.Quaternion();
let last = performance.now();
renderer.setAnimationLoop((now) => {
  const rawMs = now - last;
  const dt = Math.min(rawMs / 1000, 0.05); // clamp hitches, keep sim stable
  last = now;

  if (alive) {
    flight = stepFlight(flight, input.read(), dt);
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
    const shot = guns.update(now, flight);
    if (shot) {
      bullets.spawn(shot.seq, shot.origin, shot.vel);
      socket.sendFire(shot.seq);
      tracers.flash(shot.origin, now);
      audio.gunshot();
    }

    chase.update(camera, flight, dt);
    const planePos = nearestImage(chase.position, flight.pos);
    plane.position.set(planePos.x, planePos.y, planePos.z);
    plane.rotation.set(flight.pitch, flight.yaw, flight.roll, "YXZ");
    // Prop speed tracks the commanded throttle (same factor as remotes').
    spinPropeller(plane, dt * flight.targetSpeed * 0.7);
  } else if (killCamTargetId !== null) {
    // Kill-cam beat: hold position, watch the killer if we can see them.
    const killerPose = remotes.poseOf(killCamTargetId);
    if (killerPose) {
      const aim = nearestImage(chase.position, killerPose.pos);
      camera.lookAt(aim.x, aim.y, aim.z);
    }
  }

  // Bullets fly and sweep the frame's segment over every living remote.
  bullets.step(dt);
  const targets = remotes.targets();
  for (const bullet of [...bullets.all]) {
    if (bullet.cosmetic) {
      // An enemy bullet shaving past this frame → panned near-miss whoosh.
      if (
        alive &&
        closestApproach(bullet.prev, bullet.pos, flight.pos) < NEAR_MISS_RADIUS
      ) {
        audio.whoosh(spatialize(flight.pos, flight.yaw, bullet.pos).pan, now);
      }
      continue;
    }
    for (const target of targets) {
      if (bulletHitsSphere(bullet.prev, bullet.pos, target.pos)) {
        socket.sendHit(target.id, bullet.origin, bullet.seq);
        bullets.remove(bullet);
        break;
      }
    }
  }

  remotes.update(socket.renderTime(), chase.position, dt);
  city.update(chase.position);
  ground.update(chase.position);
  skyDome.update(chase.position);
  explosions.update(chase.position, now, dt);
  tracers.update(bullets.all, chase.position, now);

  const heat = guns.state;
  hud.setHeat(heat.heat, heat.locked);
  hud.update(now);
  const contacts = remotes.contacts();
  minimap.update(flight.pos, flight.yaw, contacts);
  audio.setEngine(flight.targetSpeed, alive);
  audio.syncRemotes(contacts, flight.pos, flight.yaw);

  renderer.render(scene, camera);

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
