// S6 glass reflections: one camera-centred cubemap probe that glass towers,
// puddles and the river all sample. The neon skyline, the signs, the
// jumbotrons, the street and the moon-lit sky dome are rendered into a small
// HalfFloat cube from the render camera, one face at a time, and the shaders
// read it with Fresnel and a mip blur (the roughness). No SSR, no second
// full-scene render per frame.
//
// THREE CUBES, ROTATED BY IDENTITY. The shader samples mix(prev, cur, blend);
// `back` is built one face per update and is never sampled while it is
// drawn, so there is no feedback loop and nothing to swap out. When all six
// faces of `back` are done, prev ← cur, cur ← back, and back ← the one cube
// that is neither (after a refill snap prev == cur, so a cube is always
// free). The blend follows back's face progress, so the reflection
// crossfades continuously: an animated sign or a lit window changing in the
// probe never STEPS on the glass, and faces drawn at different instants
// never meet at a seam. The cost is lag — the glass shows a cube one to two
// cycles old (6–12 frames on High). The sample is mip-blurred and weak, so a
// near tower drifting a few metres in it reads as glass, not as an error.
//
// WHAT IS IN THE PROBE: only objects tagged into REFLECTION_LAYER (the sky
// dome, the city, the signs, the jumbotrons and the ground) plus every light
// in the scene, so the probe pass resolves the SAME programs the main pass
// already compiled (three keys a program on light counts; a render target to
// render target switch keeps tone mapping and colour space). While the probe
// draws, uReflOn is forced to 0 — no reflection inside the reflection.
//
// QUALITY: the tier sets faces per frame (quality.ts `reflections`). Mobile
// is 0: no probe renders and uReflOn 0 — a uniform branch, so a tier switch
// compiles nothing (O3 rule 1).
//
// TORUS: the probe sits at the render camera, and every tagged object is
// already drawn at its nearest image to that camera, so the cube is
// seam-correct by construction. Camera jumps are measured with wrapDelta.

import type { Vec3 } from "@angels-bandits/common/world";
import { wrapDeltaInto } from "@angels-bandits/common/world";
import * as THREE from "three";
import { QUALITY_PROFILES, type QualityTier } from "./quality";

/** The layer the probe's face cameras see. Layer 0 is the main camera's. */
export const REFLECTION_LAYER = 7;
/** Cube face size, px. Low on purpose: the shaders read it at mip ≥ 1.5. */
export const PROBE_SIZE = 128;
/** A camera jump (respawn, teleport) past this refills the probe, m. */
export const REFILL_JUMP = 150;
/** Faces drawn per frame while an organic refill runs (2 frames for 6). */
export const REFILL_FACES_PER_FRAME = 3;
/** A QA camera eye that moved past this from the previous QA eye refills
 * the probe synchronously, m. The flicker harness re-sends the same eye
 * every frame (frozen, still) or slides it 1.5 m a frame (pan) — neither
 * refills, so the shipped crossfade is what its verdict measures. */
export const QA_REFILL_STEP = 10;

/** Luminance cap on the (blended) probe sample, linear. Applied ONCE, after
 * the prev/cur mix. A reflection is never a ladder rung: times the glass
 * F90 it sits far under the 0.72 bloom threshold (client/test/reflections). */
export const REFL_LUMA_CAP = 0.45;
/** Glass reflectance head-on (Schlick F0) — over real glass's 0.04
 * so a dark tower reads as glass at night; F90 is GRAZING_REFLECTANCE.glass. */
export const REFL_F0 = 0.1;
/** Mip level the glass samples at: the curtain wall's roughness blur. */
export const REFL_GLASS_LOD = 2.0;
/** Puddles are smoother than glass, but rippled. */
export const REFL_PUDDLE_LOD = 1.5;
/** The river: rippled water, sampled a little blurrier. */
export const REFL_RIVER_LOD = 1.5;
/** Reflected-ray elevation (world dir .y) over which a horizontal reflector
 * hands from its faked reflection to the probe. Below ~3° the camera-centred
 * probe sees a different street than the puddle would; by ~12° it is sky,
 * towers and moon, which are far enough away to agree. */
export const REFL_ELEV = { lo: 0.05, hi: 0.2 } as const;
/** Camera height over which puddles hand back to their faked sheen, m:
 * from altitude a puddle's reflection is all sky, which the sheen already is. */
export const REFL_PUDDLE_CAM_Y = { near: 40, far: 160 } as const;
/** Allowance for the moon's diffuse + specular on dark glass, linear
 * luminance — part of the summed-pixel bound the ladder test checks. */
export const REFL_MOON_ALLOWANCE = 0.1;

const glsl = (n: number) => (Number.isInteger(n) ? `${n}.0` : `${n}`);

/** An unuploaded cube (version 0): three binds its empty black cube for it,
 * so a sampler that has nothing yet reads zero — no reflection, no error. */
const EMPTY_CUBE = new THREE.CubeTexture();

/** Shared by reference into every material that reflects (buildings,
 * ground, river). Only this module writes them. */
export const REFLECTION_UNIFORMS = {
  uReflPrev: { value: EMPTY_CUBE as THREE.Texture },
  uReflCur: { value: EMPTY_CUBE as THREE.Texture },
  uReflBlend: { value: 1 },
  uReflOn: { value: 0 },
};

/** Spread into a material's onBeforeCompile uniforms. */
export function bindReflectionUniforms(uniforms: {
  [name: string]: THREE.IUniform;
}): void {
  uniforms.uReflPrev = REFLECTION_UNIFORMS.uReflPrev;
  uniforms.uReflCur = REFLECTION_UNIFORMS.uReflCur;
  uniforms.uReflBlend = REFLECTION_UNIFORMS.uReflBlend;
  uniforms.uReflOn = REFLECTION_UNIFORMS.uReflOn;
}

/** Fragment pars: the probe read. `abRefl(worldDir, lod)` mixes the two
 * displayed cubes and caps the result's luminance at REFL_LUMA_CAP. Explicit
 * LOD: no derivatives, so it is safe inside any branch. */
export const REFLECTION_PARS_GLSL = /* glsl */ `
uniform samplerCube uReflPrev;
uniform samplerCube uReflCur;
uniform float uReflBlend;
uniform float uReflOn;
vec3 abRefl(vec3 abReflDir, float abReflLod) {
  vec3 abReflC = mix(textureLod(uReflPrev, abReflDir, abReflLod).rgb,
                     textureLod(uReflCur, abReflDir, abReflLod).rgb, uReflBlend);
  float abReflL = dot(abReflC, vec3(0.2126, 0.7152, 0.0722));
  return abReflC * min(1.0, ${glsl(REFL_LUMA_CAP)} / max(abReflL, 1e-4));
}
// How much a horizontal reflector trusts the probe along world dir d.
float abReflElev(vec3 d) {
  return smoothstep(${glsl(REFL_ELEV.lo)}, ${glsl(REFL_ELEV.hi)}, d.y);
}
`;

/** TS mirror of the shader's cap, for the ladder test. */
export function capReflection(lum: number): number {
  return Math.min(lum, REFL_LUMA_CAP);
}

/** TS mirror of the glass Fresnel: F0 → F90 by Schlick on |cos θ|. */
export function glassFresnel(cosTheta: number, f90: number): number {
  const k = (1 - Math.min(1, Math.abs(cosTheta))) ** 5;
  return REFL_F0 + (f90 - REFL_F0) * k;
}

/** What one frame of the schedule draws: these faces into cube `target`. */
export interface ProbeFrame {
  target: number;
  faces: readonly number[];
}

/**
 * The probe's pure bookkeeping — which faces of which cube to draw this
 * frame, the rotation, the blend and the refills. No three.js in here, so
 * every rule is unit-tested (client/test/reflections.test.ts).
 */
export class ProbeSchedule {
  prev = 0;
  cur = 1;
  back = 2;
  /** Next face of `back` to draw. */
  face = 0;
  /** Displayed mix: 0 = prev, 1 = cur. */
  blend = 1;
  /** Faces per frame (the tier's knob): 0 off, at most 1. */
  share = 0;
  /** Completed rotations and refills, for QA. */
  rotations = 0;
  refills = 0;
  private acc = 0;
  private refill: "none" | "spread" | "sync" = "none";
  private readonly faces: number[] = [];
  private readonly frameOut: ProbeFrame = { target: 2, faces: this.faces };
  private lastPos: Vec3 | null = null;
  private lastQaEye: Vec3 | null = null;
  private readonly d: Vec3 = { x: 0, y: 0, z: 0 };

  /** The tier's faces per frame. Off → on refills (the cubes went stale). */
  setShare(share: number): void {
    const s = Math.max(0, Math.min(1, share));
    if (this.share <= 0 && s > 0) this.requestRefill(false);
    this.share = s;
    if (s <= 0) this.acc = 0;
  }

  /** Rebuild `back` from face 0, then snap to it. A sync refill draws all
   * six faces on the next frame; otherwise REFILL_FACES_PER_FRAME a frame.
   * A sync request upgrades a pending spread one, never the other way. */
  requestRefill(sync: boolean): void {
    if (this.refill === "sync") return;
    if (this.refill === "none") this.face = 0;
    this.refill = sync ? "sync" : "spread";
  }

  /** The render camera this frame: a jump past REFILL_JUMP refills (torus
   * distance — crossing the seam is not a jump). */
  observe(pos: Vec3): void {
    if (this.lastPos === null) {
      this.lastPos = { x: pos.x, y: pos.y, z: pos.z };
      return;
    }
    wrapDeltaInto(this.lastPos, pos, this.d);
    if (Math.hypot(this.d.x, this.d.y, this.d.z) > REFILL_JUMP) {
      this.requestRefill(false);
    }
    this.lastPos.x = pos.x;
    this.lastPos.y = pos.y;
    this.lastPos.z = pos.z;
  }

  /** A QA camera eye (null: released). Only a CHANGE of more than
   * QA_REFILL_STEP from the previous eye refills, and synchronously. */
  observeQaEye(eye: Vec3 | null): void {
    if (eye === null) {
      this.lastQaEye = null;
      return;
    }
    const last = this.lastQaEye;
    if (last !== null) {
      wrapDeltaInto(last, eye, this.d);
      if (Math.hypot(this.d.x, this.d.y, this.d.z) <= QA_REFILL_STEP) {
        last.x = eye.x;
        last.y = eye.y;
        last.z = eye.z;
        return;
      }
    }
    this.lastQaEye = { x: eye.x, y: eye.y, z: eye.z };
    this.requestRefill(true);
  }

  /** The cube that is neither prev nor cur — by identity. */
  private free(): number {
    for (let i = 0; i < 3; i++) {
      if (i !== this.prev && i !== this.cur) return i;
    }
    return 2; // unreachable: at most two of three are taken
  }

  /**
   * This frame's draw list, with the state ALREADY advanced past it: the
   * caller draws `faces` into cube `target` and then reads prev/cur/blend.
   * The returned object is reused frame to frame (no allocation).
   */
  frame(): ProbeFrame {
    this.faces.length = 0;
    this.frameOut.target = this.back;
    if (this.share <= 0) return this.frameOut;
    if (this.refill !== "none") {
      const n = this.refill === "sync" ? 6 : REFILL_FACES_PER_FRAME;
      for (let i = 0; i < n && this.face < 6; i++) this.faces.push(this.face++);
      if (this.face >= 6) {
        // Snap: both displayed cubes are the fresh one.
        this.prev = this.back;
        this.cur = this.back;
        this.back = this.free();
        this.blend = 1;
        this.face = 0;
        this.acc = 0;
        this.refill = "none";
        this.refills++;
      }
      return this.frameOut;
    }
    this.acc += this.share;
    if (this.acc < 1 - 1e-9) return this.frameOut;
    this.acc -= 1;
    this.faces.push(this.face++);
    if (this.face >= 6) {
      this.prev = this.cur;
      this.cur = this.back;
      this.back = this.free();
      this.face = 0;
      this.blend = 0;
      this.rotations++;
    } else {
      // Fully on cur by the 5th face, so the rotation that the 6th face
      // triggers (prev ← cur, blend 0) shows the very same image.
      this.blend = Math.min(1, this.face / 5);
    }
    return this.frameOut;
  }
}

/** QA read-out (`__ab.reflections()`). */
export interface ReflectionStats {
  on: boolean;
  supported: boolean | null;
  share: number;
  facesLastFrame: number;
  facesTotal: number;
  drawsLastFrame: number;
  rotations: number;
  refills: number;
  blend: number;
  programs: number;
  lightsTagged: boolean;
}

/** The probe: three cube targets, the face cameras, the schedule. */
export class ReflectionProbe {
  readonly schedule = new ProbeSchedule();
  private readonly targets: THREE.WebGLCubeRenderTarget[];
  private readonly cubeCam: THREE.CubeCamera;
  private readonly cams: THREE.Camera[];
  /** null until the first update checks the device. */
  private supported: boolean | null = null;
  private tierShare = 0;
  private facesTotal = 0;
  private facesLastFrame = 0;
  private drawsLastFrame = 0;
  private programs = 0;
  private scene: THREE.Scene | null = null;

  /** `enabled` false (`?refl=0`) keeps the whole feature off for a paired
   * A/B; `far` is the render camera's far plane (the dome sits inside it). */
  constructor(
    private readonly enabled: boolean,
    far: number,
  ) {
    this.targets = [0, 1, 2].map(
      () =>
        new THREE.WebGLCubeRenderTarget(PROBE_SIZE, {
          type: THREE.HalfFloatType,
          generateMipmaps: true,
          minFilter: THREE.LinearMipmapLinearFilter,
          magFilter: THREE.LinearFilter,
          depthBuffer: true,
        }),
    );
    this.cubeCam = new THREE.CubeCamera(
      1,
      far,
      this.targets[0] as THREE.WebGLCubeRenderTarget,
    );
    // The six face cameras share the CubeCamera's Layers object.
    this.cubeCam.layers.set(REFLECTION_LAYER);
    this.cams = this.cubeCam.children as THREE.Camera[];
  }

  /** Put `obj` (and, when `recursive`, its subtree) into the probe. */
  tag(obj: THREE.Object3D, recursive = false): void {
    if (recursive) obj.traverse((o) => o.layers.enable(REFLECTION_LAYER));
    else obj.layers.enable(REFLECTION_LAYER);
  }

  /** Tag every light in the scene, so the probe pass sees the same light
   * counts — and therefore resolves the same programs — as the main pass. */
  tagLights(scene: THREE.Scene): void {
    this.scene = scene;
    scene.traverse((o) => {
      if ((o as THREE.Light).isLight) o.layers.enable(REFLECTION_LAYER);
    });
  }

  /** The tier's faces per frame (0 on Mobile: no renders, uReflOn 0). */
  setQuality(tier: QualityTier): void {
    this.tierShare = QUALITY_PROFILES[tier].reflections;
    this.applyShare();
  }

  /** Refill on the next update (sync: all six faces in that frame). */
  requestRefill(sync: boolean): void {
    this.schedule.requestRefill(sync);
  }

  /** The QA camera's eye, or null once released (see QA_REFILL_STEP). */
  observeQaEye(eye: Vec3 | null): void {
    this.schedule.observeQaEye(eye);
  }

  private applyShare(): void {
    const share = this.enabled && this.supported !== false ? this.tierShare : 0;
    this.schedule.setShare(share);
    REFLECTION_UNIFORMS.uReflOn.value = share > 0 ? 1 : 0;
  }

  /**
   * Draw this frame's faces. Call AFTER the main render: the scene graph's
   * matrices are fresh, so the probe pass skips its own walk of it.
   */
  update(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
  ): void {
    this.facesLastFrame = 0;
    this.drawsLastFrame = 0;
    if (this.supported === null) {
      const ext = renderer.extensions;
      this.supported =
        ext.has("EXT_color_buffer_float") ||
        ext.has("EXT_color_buffer_half_float");
      this.applyShare();
    }
    if (this.schedule.share <= 0) return;
    this.schedule.observe(camera.position);
    const plan = this.schedule.frame();
    if (plan.faces.length > 0) {
      this.drawFaces(renderer, scene, camera, plan);
    }
    const s = this.schedule;
    REFLECTION_UNIFORMS.uReflPrev.value = (
      this.targets[s.prev] as THREE.WebGLCubeRenderTarget
    ).texture;
    REFLECTION_UNIFORMS.uReflCur.value = (
      this.targets[s.cur] as THREE.WebGLCubeRenderTarget
    ).texture;
    REFLECTION_UNIFORMS.uReflBlend.value = s.blend;
    this.programs = renderer.info.programs?.length ?? 0;
  }

  private drawFaces(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
    plan: ProbeFrame,
  ): void {
    const cube = this.cubeCam;
    if (cube.coordinateSystem !== renderer.coordinateSystem) {
      cube.coordinateSystem = renderer.coordinateSystem;
      cube.updateCoordinateSystem();
    }
    cube.position.copy(camera.position);
    cube.updateMatrixWorld(true);
    const target = this.targets[plan.target] as THREE.WebGLCubeRenderTarget;
    // Save everything the pass touches, so it restores exactly — uReflOn
    // included: Mobile or the guard's "off" must stay off.
    const prevTarget = renderer.getRenderTarget();
    const prevFace = renderer.getActiveCubeFace();
    const prevMip = renderer.getActiveMipmapLevel();
    const prevAuto = scene.matrixWorldAutoUpdate;
    const prevOn = REFLECTION_UNIFORMS.uReflOn.value;
    const before = renderer.info.render.calls;
    try {
      REFLECTION_UNIFORMS.uReflOn.value = 0;
      scene.matrixWorldAutoUpdate = false;
      for (const face of plan.faces) {
        renderer.setRenderTarget(target, face);
        if (this.facesTotal === 0 && !this.framebufferComplete(renderer)) {
          this.supported = false;
          break;
        }
        renderer.render(scene, this.cams[face] as THREE.Camera);
        this.facesLastFrame++;
        this.facesTotal++;
      }
    } finally {
      renderer.setRenderTarget(prevTarget, prevFace, prevMip);
      scene.matrixWorldAutoUpdate = prevAuto;
      REFLECTION_UNIFORMS.uReflOn.value = prevOn;
      this.drawsLastFrame = renderer.info.render.calls - before;
    }
    if (this.supported === false) this.applyShare();
  }

  /** A half-float cube attachment the extensions promised can still be
   * incomplete on some drivers — then the feature turns itself off. */
  private framebufferComplete(renderer: THREE.WebGLRenderer): boolean {
    const gl = renderer.getContext();
    return (
      gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE
    );
  }

  /** Draws the probe's faces cost this frame (S8: the frame meter's split —
   * a plain read, unlike `stats`, which walks the scene). */
  get lastFrameDraws(): number {
    return this.drawsLastFrame;
  }

  get stats(): ReflectionStats {
    let lightsTagged = true;
    this.scene?.traverse((o) => {
      if ((o as THREE.Light).isLight && !o.layers.isEnabled(REFLECTION_LAYER)) {
        lightsTagged = false;
      }
    });
    const s = this.schedule;
    return {
      on: REFLECTION_UNIFORMS.uReflOn.value > 0.5,
      supported: this.supported,
      share: s.share,
      facesLastFrame: this.facesLastFrame,
      facesTotal: this.facesTotal,
      drawsLastFrame: this.drawsLastFrame,
      rotations: s.rotations,
      refills: s.refills,
      blend: s.blend,
      programs: this.programs,
      lightsTagged,
    };
  }
}
