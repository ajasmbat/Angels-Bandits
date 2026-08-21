// Placeholder scene proving the client boots: a lit cube in the night fog.
// T2 replaces this with the chunked city renderer and flight model.

import * as THREE from "three";
import { FOG_DISTANCE } from "@angels-bandits/common/constants";

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0a14);
scene.fog = new THREE.Fog(0x0a0a14, 1, FOG_DISTANCE);

const camera = new THREE.PerspectiveCamera(
  70,
  window.innerWidth / window.innerHeight,
  0.1,
  FOG_DISTANCE,
);
camera.position.set(0, 1.5, 4);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
document.body.appendChild(renderer.domElement);

const cube = new THREE.Mesh(
  new THREE.BoxGeometry(1.5, 1.5, 1.5),
  new THREE.MeshStandardMaterial({ color: 0x7f5af0, roughness: 0.4 }),
);
scene.add(cube);

scene.add(new THREE.AmbientLight(0x404060, 1.5));
const key = new THREE.DirectionalLight(0xffffff, 2);
key.position.set(3, 5, 2);
scene.add(key);

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

renderer.setAnimationLoop((time) => {
  cube.rotation.x = time / 2000;
  cube.rotation.y = time / 1300;
  renderer.render(scene, camera);
});
