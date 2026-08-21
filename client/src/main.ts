// T2: solo flight over the torus city. T3: the same city, shared — join with
// a name, stream your pose up at TICK_UP_HZ, and render everyone else from
// interpolation buffers ~100 ms behind server time. The plane simulates in
// canonical coords via the shared flight model; the camera and every rendered
// thing are placed per frame at their torus image nearest the viewer — that
// placement (plus fog < WORLD_SIZE/2) IS the seamless-torus illusion.

import { FOG_DISTANCE } from "@angels-bandits/common/constants";
import {
  type FlightState,
  createFlightState,
  stepFlight,
} from "@angels-bandits/common/flight";
import * as THREE from "three";
import { ChaseCamera } from "./game/camera";
import { checkDeath } from "./game/collision";
import { FlightInputSource } from "./game/flight-input";
import { GameSocket } from "./net/socket";
import { CityRenderer } from "./render/city";
import { buildPlaneMesh } from "./render/plane";
import { RemotePlanes } from "./render/remotes";
import { GroundPlane, setupSky } from "./render/sky";
import { nearestImage } from "./render/wrapPlacement";
import { requestName, showJoinError } from "./ui/join";

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

const plane = buildPlaneMesh();
scene.add(plane);

// --- Remote planes ---
const remotes = new RemotePlanes(scene, socket.selfId);
remotes.setRoster(welcome.roster);
socket.events.onSnapshot = (snap) => remotes.ingest(snap);
socket.events.onPlayerJoined = (player) => remotes.playerJoined(player);
socket.events.onPlayerLeft = (id) => remotes.playerLeft(id);

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

const fadeEl = document.getElementById("fade") as HTMLDivElement;
const hudEl = document.getElementById("hud") as HTMLDivElement;

function die(respawned: FlightState): void {
  flight = respawned;
  chase.snapTo(flight);
  // Instant black, then ease back in — the "brief fade" of the plan.
  fadeEl.classList.add("dead");
  requestAnimationFrame(() =>
    requestAnimationFrame(() => fadeEl.classList.remove("dead")),
  );
}

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
};

// --- Frame loop ---
const poseEuler = new THREE.Euler();
const poseQuat = new THREE.Quaternion();
let last = performance.now();
renderer.setAnimationLoop((now) => {
  const rawMs = now - last;
  const dt = Math.min(rawMs / 1000, 0.05); // clamp hitches, keep sim stable
  last = now;

  flight = stepFlight(flight, input.read(), dt);
  const respawned = checkDeath(flight, city.cityBuildings);
  if (respawned) die(respawned);

  // Stream our pose up (rate-limited to TICK_UP_HZ inside the socket).
  poseEuler.set(flight.pitch, flight.yaw, flight.roll, "YXZ");
  poseQuat.setFromEuler(poseEuler);
  socket.sendPose({
    pos: flight.pos,
    quat: { x: poseQuat.x, y: poseQuat.y, z: poseQuat.z, w: poseQuat.w },
    speed: flight.speed,
  });

  chase.update(camera, flight, dt);

  // Plane drawn at its image nearest the camera (it always IS that image, but
  // the rule is uniform: everything rendered goes through nearestImage).
  const planePos = nearestImage(chase.position, flight.pos);
  plane.position.set(planePos.x, planePos.y, planePos.z);
  plane.rotation.set(flight.pitch, flight.yaw, flight.roll, "YXZ");

  remotes.update(socket.renderTime(), chase.position);
  city.update(chase.position);
  ground.update(chase.position);

  renderer.render(scene, camera);

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
