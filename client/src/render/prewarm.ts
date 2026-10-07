// Boot-time shader pre-warm (O2). Everything that starts hidden — tracers,
// muzzle flashes, explosions and sparks, storm bolts, searchlights, birds,
// movers, traffic, the micro tier, the propeller blur, the HP sprite — would
// otherwise compile its program (and upload its texture) on the frame it
// first appears: a guaranteed hitch exactly when the player fires, kills or
// sees lightning for the first time.
//
// compile() only walks the VISIBLE scene, so for one call every hidden object
// is shown, a throwaway name tag joins it (tags are only built when a remote
// first appears), and visibility is put back exactly as it was. Each
// subsystem's own update() owns visibility from the next frame on.

import type * as THREE from "three";
import { createNameTag, disposeNameTag } from "./nametags";

/** A driver whose parallel-compile query never resolves must not hold boot
 * hostage: past this the game starts anyway (programs then finish lazily). */
const PREWARM_TIMEOUT_MS = 3000;

export async function prewarmScene(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
): Promise<void> {
  const tag = createNameTag("prewarm");
  scene.add(tag);

  const hidden: THREE.Object3D[] = [];
  scene.traverse((o) => {
    if (!o.visible) {
      hidden.push(o);
      o.visible = true;
    }
  });
  // Texture uploads hitch separately from program links.
  scene.traverseVisible((o) => {
    const material = (o as THREE.Mesh).material;
    for (const m of Array.isArray(material) ? material : [material]) {
      const map = (m as THREE.MeshBasicMaterial | undefined)?.map;
      if (map) renderer.initTexture(map);
    }
  });

  try {
    await Promise.race([
      renderer.compileAsync(scene, camera).catch(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, PREWARM_TIMEOUT_MS)),
    ]);
  } finally {
    for (const o of hidden) o.visible = false;
    scene.remove(tag);
    disposeNameTag(tag);
  }
}
