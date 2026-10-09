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
//
// O4: two holes that let first sight hitch anyway.
//  1. three keys a program on the BOUND render target: with none bound it
//     compiles the "tone-mapped, sRGB, to the screen" variant
//     (WebGLPrograms: toneMapping / outputColorSpace), while the game draws
//     every object through the composer's linear HalfFloat target with no
//     tone mapping — a different program. So the old pre-warm compiled the
//     wrong variant of everything hidden, and each one compiled AGAIN the
//     first time it appeared. The compile now runs with the composer's
//     target bound.
//  2. A compiled program is not a drawn one. The driver builds the rest
//     lazily on the first real draw (ANGLE/Metal pipeline states per blend
//     state and attachment format, buffer and texture residency), so after
//     the compile ONE real frame goes through the whole composer chain with
//     everything shown and frustum culling off, behind the boot fade. Every
//     object's `visible` and `frustumCulled`, and every LOD's `autoUpdate`,
//     is restored exactly afterwards.
//
// U5b: three's own compileAsync() polls `currentProgram.isReady()` on every
// compiled material and THROWS (inside a setTimeout, so its promise never
// settles) once one is disposed mid-wait — its program is gone with it.
// window.__ab and every socket handler are live during this await: the
// bot that yields to a joining human (or a QA `setBots(0)`) arrives as
// `playerLeft` and disposes that plane's materials, and boot sat out the
// whole timeout. The wait below drops a disposed material instead.

import * as THREE from "three";
import type { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { createNameTag, disposeNameTag } from "./nametags";

/** A driver whose parallel-compile query never resolves must not hold boot
 * hostage: past this the game starts anyway (programs then finish lazily). */
const PREWARM_TIMEOUT_MS = 3000;

export async function prewarmScene(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  composer: EffectComposer,
): Promise<void> {
  const tag = createNameTag("prewarm");
  scene.add(tag);

  const hidden: THREE.Object3D[] = [];
  const culled: THREE.Object3D[] = [];
  const lods: THREE.LOD[] = [];
  scene.traverse((o) => {
    if (!o.visible) {
      hidden.push(o);
      o.visible = true;
    }
    if (o.frustumCulled) {
      culled.push(o);
      o.frustumCulled = false;
    }
    // A LOD re-picks its level inside render() and would hide the level the
    // camera is not at — draw every level once.
    if (o instanceof THREE.LOD && o.autoUpdate) {
      lods.push(o);
      o.autoUpdate = false;
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

  const previousTarget = renderer.getRenderTarget();
  try {
    // The target RenderPass draws into: the program variant the game uses.
    renderer.setRenderTarget(composer.readBuffer);
    await Promise.race([
      programsReady(renderer, renderer.compile(scene, camera)),
      new Promise<void>((resolve) => setTimeout(resolve, PREWARM_TIMEOUT_MS)),
    ]);
    renderer.setRenderTarget(previousTarget);
    // One real frame through the real chain (bloom, the final pass) — the
    // boot fade covers it. Never the reason boot fails.
    try {
      composer.render(0);
    } catch {
      /* the next real frame draws it instead */
    }
  } finally {
    renderer.setRenderTarget(previousTarget);
    for (const o of hidden) o.visible = false;
    for (const o of culled) o.frustumCulled = true;
    for (const o of lods) o.autoUpdate = true;
    scene.remove(tag);
    disposeNameTag(tag);
  }
}

/** Resolves once every material's program has linked (compileAsync's
 * wait, minus its crash): a material disposed meanwhile has no program
 * left to wait for and is dropped. Without KHR_parallel_shader_compile
 * there is no non-blocking status to wait on — the real frame links. */
function programsReady(
  renderer: THREE.WebGLRenderer,
  materials: Set<THREE.Material>,
): Promise<void> {
  if (!renderer.extensions.has("KHR_parallel_shader_compile")) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const check = (): void => {
      for (const m of materials) {
        const { currentProgram: program } = renderer.properties.get(m) as {
          currentProgram?: { isReady(): boolean };
        };
        if (!program || program.isReady()) materials.delete(m);
      }
      if (materials.size === 0) resolve();
      else setTimeout(check, 10);
    };
    check();
  });
}
