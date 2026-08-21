// T2: solo flight over the torus city. The plane simulates in canonical
// coords via the shared flight model; the camera and every rendered thing are
// placed per frame at their torus image nearest the viewer — that placement
// (plus fog < WORLD_SIZE/2) IS the seamless-torus illusion.

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
import { CityRenderer } from "./render/city";
import { GroundPlane, setupSky } from "./render/sky";
import { nearestImage } from "./render/wrapPlacement";

const CITY_SEED = 42;

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

// --- World ---
const city = new CityRenderer(CITY_SEED);
scene.add(city.mesh);
const ground = new GroundPlane();
scene.add(ground.mesh);

// --- Placeholder plane (proper model is T5 polish) ---
function buildPlaneMesh(): THREE.Group {
  const g = new THREE.Group();
  const body = new THREE.MeshStandardMaterial({
    color: 0x8a94a8,
    roughness: 0.5,
  });
  const accent = new THREE.MeshStandardMaterial({
    color: 0x27e0c0,
    emissive: 0x27e0c0,
    emissiveIntensity: 0.6,
  });
  const fuselage = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1, 6), body);
  const wings = new THREE.Mesh(new THREE.BoxGeometry(9, 0.18, 1.8), body);
  wings.position.z = 0.3;
  const tailplane = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.15, 1), body);
  tailplane.position.z = 2.6;
  const fin = new THREE.Mesh(new THREE.BoxGeometry(0.15, 1.2, 1), accent);
  fin.position.set(0, 0.8, 2.6);
  const nose = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.8), accent);
  nose.position.z = -3.2;
  g.add(fuselage, wings, tailplane, fin, nose);
  return g;
}
const plane = buildPlaneMesh();
scene.add(plane);

// --- Simulation state ---
const input = new FlightInputSource();
const chase = new ChaseCamera();
let flight: FlightState = createFlightState({ x: 900, y: 300, z: 1100 });

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
};

// --- Frame loop ---
let last = performance.now();
renderer.setAnimationLoop((now) => {
  const rawMs = now - last;
  const dt = Math.min(rawMs / 1000, 0.05); // clamp hitches, keep sim stable
  last = now;

  flight = stepFlight(flight, input.read(), dt);
  const respawned = checkDeath(flight, city.cityBuildings);
  if (respawned) die(respawned);

  chase.update(camera, flight, dt);

  // Plane drawn at its image nearest the camera (it always IS that image, but
  // the rule is uniform: everything rendered goes through nearestImage).
  const planePos = nearestImage(chase.position, flight.pos);
  plane.position.set(planePos.x, planePos.y, planePos.z);
  plane.rotation.set(flight.pitch, flight.yaw, flight.roll, "YXZ");

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
      `ALT ${flight.pos.y.toFixed(0)} m  FPS ${perf.fps.toFixed(0)}`;
  }
});
