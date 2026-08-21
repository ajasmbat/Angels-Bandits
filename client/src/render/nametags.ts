// Billboarded name tags above remote planes. A THREE.Sprite always faces the
// camera, so billboarding is free; placement is torus-aware because the
// remote-plane manager positions tags via the same nearestImage placement as
// everything else rendered.

import * as THREE from "three";

/** Meters above a plane's position its tag floats. */
export const TAG_ALTITUDE = 6;

export function createNameTag(name: string): THREE.Sprite {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.font = "bold 30px ui-monospace, Menlo, monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.shadowColor = "#000";
    ctx.shadowBlur = 6;
    ctx.fillStyle = "#9fd8e8";
    ctx.fillText(name, canvas.width / 2, canvas.height / 2);
  }
  const texture = new THREE.CanvasTexture(canvas);
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
  });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(20, 5, 1); // meters — readable at combat range, fog fades it
  return sprite;
}

export function disposeNameTag(sprite: THREE.Sprite): void {
  sprite.material.map?.dispose();
  sprite.material.dispose();
}
