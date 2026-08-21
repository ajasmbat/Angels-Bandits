// Dusk sky, fog, lights, and the ground plane. The fog color matches the
// clear color exactly, so geometry dissolves into "city haze" well before the
// torus's half-world limit (FOG_DISTANCE = 800 < WORLD_SIZE/2 = 1000).
//
// The ground is a camera-following plane — equivalent to chunk-shifting for an
// infinite-looking floor. Its street-grid texture is anchored to WORLD
// coordinates via a per-frame UV offset, and because BLOCK_PITCH divides
// WORLD_SIZE evenly the grid tiles across the seam automatically.

import { BLOCK_PITCH, FOG_DISTANCE } from "@angels-bandits/common/constants";
import type { Vec3 } from "@angels-bandits/common/world";
import * as THREE from "three";

export const DUSK = {
  sky: 0x141225, // deep dusk indigo — clear color AND fog color, always identical
  ambient: 0x3a3a5c,
  sun: 0xff9a66, // low orange sun for long dusk shadows on tower faces
} as const;

const GROUND_SIZE = 2 * FOG_DISTANCE + 200; // fully covers the fog radius
const GRID_REPEATS = GROUND_SIZE / BLOCK_PITCH;

export function setupSky(scene: THREE.Scene): void {
  scene.background = new THREE.Color(DUSK.sky);
  scene.fog = new THREE.Fog(DUSK.sky, 60, FOG_DISTANCE);

  scene.add(new THREE.AmbientLight(DUSK.ambient, 1.6));
  const sun = new THREE.DirectionalLight(DUSK.sun, 1.4);
  sun.position.set(-0.6, 0.25, 0.75); // direction only — a low dusk sun
  scene.add(sun);
  const fill = new THREE.HemisphereLight(0x2c2c4a, 0x0c0c14, 0.9);
  scene.add(fill);
}

/** One BLOCK_PITCH×BLOCK_PITCH cell: asphalt with lit street edges. */
function streetTexture(): THREE.Texture {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.fillStyle = "#101018";
    ctx.fillRect(0, 0, size, size);
    // Street band along both edges of the cell (streets sit between blocks).
    ctx.strokeStyle = "#2a2a3e";
    ctx.lineWidth = 10;
    ctx.strokeRect(0, 0, size, size);
    ctx.strokeStyle = "#3d3d55";
    ctx.lineWidth = 2;
    ctx.strokeRect(0, 0, size, size);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(GRID_REPEATS, GRID_REPEATS);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class GroundPlane {
  readonly mesh: THREE.Mesh;
  private readonly tex: THREE.Texture;

  constructor() {
    this.tex = streetTexture();
    const material = new THREE.MeshStandardMaterial({
      map: this.tex,
      roughness: 1,
    });
    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(GROUND_SIZE, GROUND_SIZE),
      material,
    );
    this.mesh.rotation.x = -Math.PI / 2;
  }

  /** Follow the camera; shift UVs so the grid stays glued to world coords. */
  update(cameraPos: Vec3): void {
    this.mesh.position.set(cameraPos.x, 0, cameraPos.z);
    // The plane's u=0 edge sits at world x = cameraPos.x - GROUND_SIZE/2.
    const originX = (cameraPos.x - GROUND_SIZE / 2) / BLOCK_PITCH;
    // PlaneGeometry's v runs opposite to world +z after the -90° x-rotation.
    const originZ = -(cameraPos.z + GROUND_SIZE / 2) / BLOCK_PITCH;
    this.tex.offset.set(
      originX - Math.floor(originX),
      originZ - Math.floor(originZ),
    );
  }
}
