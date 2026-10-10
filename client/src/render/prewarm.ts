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
// enemy plane that leaves (W1: shot down, or gone with its carrier) arrives
// as `playerLeft` and disposes that plane's materials, and boot sat out the
// whole timeout. The wait below drops a disposed material instead.
//
// A1: a shown object that draws NOTHING is still not drawn. Every pool that
// boots empty — an InstancedMesh at count 0 (missiles, cave-ins,
// scaffold, street furniture…), a geometry with an empty draw range (storm
// bolts, steam, dust, impacts, litter…), an instanced geometry with no
// instances (fog banks, rain) — was compiled and then skipped by the real
// frame, so the first explosion, missile, bolt or downpour still paid the
// driver's lazy first draw. For that one frame each is forced to draw a
// minimal prefix (1 instance, ≤ 3 vertices) behind the boot fade, and put
// back the moment it returns: synchronously, so no game frame or socket
// handler can see the forced counts.

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
    const restore = forceEmptyDraws(scene);
    try {
      composer.render(0);
    } catch {
      /* the next real frame draws it instead */
    } finally {
      restore();
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

/**
 * Make every empty pool in `scene` draw a minimal prefix (see A1 above);
 * returns the function that puts each count back exactly. Only pools with
 * capacity for what is forced (an instance, the vertices) are touched.
 */
function forceEmptyDraws(scene: THREE.Scene): () => void {
  const meshes: THREE.InstancedMesh[] = [];
  const ranges = new Set<THREE.BufferGeometry>();
  const instanced = new Set<THREE.InstancedBufferGeometry>();
  scene.traverse((o) => {
    if (o instanceof THREE.InstancedMesh) {
      if (o.count === 0 && o.instanceMatrix.count >= 1) {
        meshes.push(o);
        o.count = 1;
      }
    }
    const geometry = (o as THREE.Mesh).geometry as
      | THREE.BufferGeometry
      | undefined;
    if (!geometry?.isBufferGeometry) return;
    if (geometry.drawRange.count === 0 && !ranges.has(geometry)) {
      const n =
        geometry.index?.count ?? geometry.getAttribute("position")?.count;
      if (n !== undefined && n >= 1) {
        ranges.add(geometry);
        geometry.drawRange.count = Math.min(3, n);
      }
    }
    if (
      geometry instanceof THREE.InstancedBufferGeometry &&
      geometry.instanceCount === 0 &&
      !instanced.has(geometry) &&
      Object.values(geometry.attributes).every(
        (a) =>
          !(a as THREE.InstancedBufferAttribute).isInstancedBufferAttribute ||
          a.count >= 1,
      )
    ) {
      instanced.add(geometry);
      geometry.instanceCount = 1;
    }
  });
  return () => {
    for (const m of meshes) m.count = 0;
    for (const g of ranges) g.drawRange.count = 0;
    for (const g of instanced) g.instanceCount = 0;
  };
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
