// The post chain's two custom passes (O4 "Retina 60 fps"). At pixel ratio 2
// the drawing buffer is 2560×1440 — 3.7 M pixels of RGBA16F — and every
// full-resolution pass that reads and writes it is pure bandwidth on a tile
// GPU. The chain used to be: scene → bloom (its blur chain, then an ADDITIVE
// full-res blend back into the scene target) → OutputPass (tone map + sRGB,
// a full-res read and write) → grade (another full-res read and write). Two
// of those three full-res passes did nothing a single pass can't:
//
//   AbBloomPass — UnrealBloomPass's blur chain, unchanged in look, minus the
//     final blend: it leaves its result in `bloomTexture` for FinalPass. Its
//     targets carry no depth buffer (three allocates one per target by
//     default, and every blur clear cleared and stored it), and its chain is
//     anchored to CSS pixels instead of device pixels: at ratio 2 the bright
//     pass and mip 0 run at a quarter of the buffer per axis (1/16 of its
//     pixels) instead of a half. The blur taps keep their old offsets in
//     buffer UV, so every halo keeps its old screen-space size, and the
//     bright pass box-filters four bilinear taps — exactly the 2×2 average of
//     the old bright target — so a small emissive cannot fall between taps
//     and shimmer. At ratio ≤ 1 nothing changes at all.
//
//   FinalPass — scene + bloom, ACES with the live exposure, the sRGB encode
//     and the VO5 grade, in ONE full-res pass. The maths is the old chain's
//     to the letter: the additive blend added bloom.rgb × bloom.a (three's
//     AdditiveBlending is SRC_ALPHA, ONE, unclamped on a float target), the
//     tone map and encode are three's own chunks, and the grade is
//     grade.ts's GLSL. What changes is two RGBA16F round trips of the
//     intermediate image (< 1/2048 relative, below an 8-bit step).
//
// The emissive ladder is untouched: the bright pass still thresholds the
// linear HDR scene at the same 0.72 with the same smooth width.

import * as THREE from "three";
import {
  FullScreenQuad,
  Pass,
} from "three/examples/jsm/postprocessing/Pass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputShader } from "three/examples/jsm/shaders/OutputShader.js";
import {
  FINAL_ATMO_PARS_GLSL,
  SHAFT_FRAGMENT,
  SHIMMER_PERIOD_S,
  SHIMMER_SLOTS,
} from "./atmo-post";
import { GRADE_GLSL, GRADE_PARS_GLSL, gradeUniforms } from "./grade";
import { FINITE_GLSL } from "./hdr-safe";

/** UnrealBloomPass's blur directions (static there, untyped in @types). */
const BLUR_X = new THREE.Vector2(1, 0);
const BLUR_Y = new THREE.Vector2(0, 1);
/** UnrealBloomPass's own soft-knee width above the threshold. */
const BLOOM_SMOOTH_WIDTH = 0.01;

/**
 * The bright pass, box-filtered: four bilinear taps, each thresholded as the
 * old single tap was, then averaged. With `uTap` at ±1 buffer pixel (ratio 2)
 * each tap is the old bright target's texel, so the result is exactly the
 * 2×2 box of the old bright target. `uTap` 0 (ratio ≤ 1) is the old pass.
 */
const BrightShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    luminosityThreshold: { value: 1 },
    smoothWidth: { value: BLOOM_SMOOTH_WIDTH },
    uTap: { value: new THREE.Vector2() },
  },
  vertexShader: /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`,
  fragmentShader: /* glsl */ `
#include <common>
uniform sampler2D tDiffuse;
uniform float luminosityThreshold;
uniform float smoothWidth;
uniform vec2 uTap;
varying vec2 vUv;
${FINITE_GLSL}
vec4 abBright(vec2 uv) {
  // O7 (hdr-safe.ts): one NaN/Inf texel here is a black box five mips wide.
  vec4 texel = vec4(abFinite(texture2D(tDiffuse, uv).rgb), 1.0);
  float v = luminance(texel.xyz);
  float alpha = smoothstep(luminosityThreshold, luminosityThreshold + smoothWidth, v);
  return mix(vec4(0.0), texel, alpha);
}
void main() {
  gl_FragColor = 0.25 * (
    abBright(vUv + vec2(-uTap.x, -uTap.y)) + abBright(vUv + vec2(uTap.x, -uTap.y)) +
    abBright(vUv + vec2(-uTap.x, uTap.y)) + abBright(vUv + vec2(uTap.x, uTap.y)));
}`,
};

export class AbBloomPass extends UnrealBloomPass {
  /** Device pixels per CSS pixel the chain is anchored to (≥ 1). */
  private density = 1;
  private bufferSize = new THREE.Vector2(1, 1);
  private readonly brightMaterial = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.clone(BrightShader.uniforms),
    vertexShader: BrightShader.vertexShader,
    fragmentShader: BrightShader.fragmentShader,
  });
  private readonly quad = new FullScreenQuad();
  /** A1: render()'s saved clear colour — one Color, not one a frame. */
  private readonly scratchClear = new THREE.Color();

  constructor(strength: number, radius: number, threshold: number) {
    super(new THREE.Vector2(256, 256), strength, radius, threshold);
    // Nothing in the bloom chain depth-tests. Read by three when a target is
    // first set up, i.e. on the first render — before that, so in time.
    for (const rt of [
      this.renderTargetBright,
      ...this.renderTargetsHorizontal,
      ...this.renderTargetsVertical,
    ]) {
      rt.depthBuffer = false;
    }
    // FinalPass adds the bloom; nothing is written back to the scene.
    this.needsSwap = false;
  }

  /** The composited bloom (all mips), for FinalPass. */
  get bloomTexture(): THREE.Texture {
    return this.renderTargetsHorizontal[0]?.texture as THREE.Texture;
  }

  /** Device pixels per CSS pixel the chain runs at (1 at ratio <= 1). */
  get cssDensity(): number {
    return this.density;
  }

  /** The renderer's pixel ratio; the chain runs at CSS density above 1. */
  setPixelRatio(ratio: number): void {
    this.density = Math.max(1, ratio);
    this.setSize(this.bufferSize.x, this.bufferSize.y);
  }

  /** `width`/`height` are DRAWING-BUFFER pixels (EffectComposer's). */
  override setSize(width: number, height: number): void {
    this.bufferSize.set(width, height);
    const f = this.density;
    const bright = this.renderTargetBright;
    bright.setSize(
      Math.max(1, Math.round(width / (2 * f))),
      Math.max(1, Math.round(height / (2 * f))),
    );
    // Old bright texel (2 buffer px) centres sit (f − 1) buffer px either
    // side of the new texel's centre: ±1 px at ratio 2, none at ratio 1.
    (this.brightMaterial.uniforms.uTap?.value as THREE.Vector2).set(
      (f - 1) / Math.max(1, width),
      (f - 1) / Math.max(1, height),
    );
    let oldX = Math.round(width / 2);
    let oldY = Math.round(height / 2);
    for (let i = 0; i < this.nMips; i++) {
      const w = Math.max(1, Math.round(oldX / f));
      const h = Math.max(1, Math.round(oldY / f));
      this.renderTargetsHorizontal[i]?.setSize(w, h);
      this.renderTargetsVertical[i]?.setSize(w, h);
      // The taps keep their OLD offsets in UV: the same screen-space blur,
      // sampled bilinearly from a sparser target.
      const blur = this.separableBlurMaterials[i];
      (blur?.uniforms.invSize?.value as THREE.Vector2 | undefined)?.set(
        1 / oldX,
        1 / oldY,
      );
      oldX = Math.round(oldX / 2);
      oldY = Math.round(oldY / 2);
    }
  }

  override render(
    renderer: THREE.WebGLRenderer,
    _writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
  ): void {
    const oldClear = renderer.getClearColor(this.scratchClear);
    const oldAlpha = renderer.getClearAlpha();
    const oldAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setClearColor(this.clearColor, 0);

    // 1. Bright areas, box-filtered.
    const u = this.brightMaterial.uniforms;
    (u.tDiffuse as THREE.IUniform).value = readBuffer.texture;
    (u.luminosityThreshold as THREE.IUniform).value = this.threshold;
    this.quad.material = this.brightMaterial;
    renderer.setRenderTarget(this.renderTargetBright);
    renderer.clear();
    this.quad.render(renderer);

    // 2. The mip chain — UnrealBloomPass's, unchanged.
    let input = this.renderTargetBright;
    for (let i = 0; i < this.nMips; i++) {
      const blur = this.separableBlurMaterials[i] as THREE.ShaderMaterial;
      const h = this.renderTargetsHorizontal[i] as THREE.WebGLRenderTarget;
      const v = this.renderTargetsVertical[i] as THREE.WebGLRenderTarget;
      this.quad.material = blur;
      (blur.uniforms.colorTexture as THREE.IUniform).value = input.texture;
      (blur.uniforms.direction as THREE.IUniform).value = BLUR_X;
      renderer.setRenderTarget(h);
      renderer.clear();
      this.quad.render(renderer);
      (blur.uniforms.colorTexture as THREE.IUniform).value = h.texture;
      (blur.uniforms.direction as THREE.IUniform).value = BLUR_Y;
      renderer.setRenderTarget(v);
      renderer.clear();
      this.quad.render(renderer);
      input = v;
    }

    // 3. Composite every mip into mip 0's horizontal target (bloomTexture).
    const c = this.compositeMaterial.uniforms;
    (c.bloomStrength as THREE.IUniform).value = this.strength;
    (c.bloomRadius as THREE.IUniform).value = this.radius;
    (c.bloomTintColors as THREE.IUniform).value = this.bloomTintColors;
    this.quad.material = this.compositeMaterial;
    renderer.setRenderTarget(this.renderTargetsHorizontal[0] ?? null);
    renderer.clear();
    this.quad.render(renderer);

    renderer.setClearColor(oldClear, oldAlpha);
    renderer.autoClear = oldAutoClear;
  }

  override dispose(): void {
    super.dispose();
    this.brightMaterial.dispose();
    this.quad.dispose();
  }
}

/**
 * After the scene pass: nothing later reads the scene's depth, so hint the
 * driver to discard it rather than store it (on a tile GPU, a full-res
 * depth write-back per frame). Skipped on a multisampled target, whose
 * resolve three manages itself. A no-op where the hint is ignored.
 */
export class DiscardDepthPass extends Pass {
  constructor() {
    super();
    this.needsSwap = false;
  }

  override render(
    renderer: THREE.WebGLRenderer,
    _writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
  ): void {
    if (readBuffer.samples > 0 || !readBuffer.depthBuffer) return;
    renderer.setRenderTarget(readBuffer);
    const gl = renderer.getContext() as WebGL2RenderingContext;
    gl.invalidateFramebuffer(gl.FRAMEBUFFER, [gl.DEPTH_ATTACHMENT]);
  }
}

/**
 * S5 light shafts: a quarter-CSS-res radial march of the scene toward the
 * moon (atmo-post.ts), left in `texture` for FinalPass to add. ONE draw, and
 * none at all while inactive (no moon in view, the tier has no shafts, or
 * the camera is in the deck) — FinalPass then adds nothing, the way it
 * treats a disabled bloom. It never writes back into the scene.
 */
export class ShaftsPass extends Pass {
  /** The tier's switch (Mobile drops shafts). */
  tierOn = true;
  /** Prewarm: render once even while inactive, so the program is linked
   * at boot (a tier pick or the moon rising must never compile). */
  forceOnce = false;
  private density = 1;
  private readonly bufferSize = new THREE.Vector2(1, 1);
  private readonly target = new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.HalfFloatType,
    depthBuffer: false,
  });
  readonly uniforms = {
    tDiffuse: { value: null as THREE.Texture | null },
    uSun: { value: new THREE.Vector2(0.5, 0.5) },
    uAspect: { value: 1 },
    uStrength: { value: 0 },
  };
  private readonly quad = new FullScreenQuad(
    new THREE.ShaderMaterial({
      name: "AbShaftsShader",
      uniforms: this.uniforms,
      vertexShader: /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`,
      fragmentShader: SHAFT_FRAGMENT,
      depthTest: false,
      depthWrite: false,
    }),
  );
  /** Whether last frame's texture holds shafts FinalPass should add. */
  private drew = false;

  constructor() {
    super();
    this.needsSwap = false;
  }

  /** The moon this frame: screen UV, aspect, and strength (0 = none). */
  setSource(u: number, v: number, aspect: number, strength: number): void {
    this.uniforms.uSun.value.set(u, v);
    this.uniforms.uAspect.value = aspect;
    this.uniforms.uStrength.value = strength;
  }

  /** True when FinalPass should add `texture` this frame. */
  get active(): boolean {
    return this.tierOn && this.uniforms.uStrength.value > 0.001;
  }

  /** What FinalPass adds, or null while nothing was drawn this frame. */
  get texture(): THREE.Texture | null {
    return this.drew ? this.target.texture : null;
  }

  /** The renderer's pixel ratio (the pass runs at CSS density above 1). */
  setPixelRatio(ratio: number): void {
    this.density = Math.max(1, ratio);
    this.setSize(this.bufferSize.x, this.bufferSize.y);
  }

  /** `width`/`height` are DRAWING-BUFFER pixels (EffectComposer's). */
  override setSize(width: number, height: number): void {
    this.bufferSize.set(width, height);
    const k = 4 * this.density;
    this.target.setSize(
      Math.max(1, Math.round(width / k)),
      Math.max(1, Math.round(height / k)),
    );
  }

  override render(
    renderer: THREE.WebGLRenderer,
    _writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
  ): void {
    const force = this.forceOnce;
    this.forceOnce = false;
    this.drew = this.active;
    if (!this.drew && !force) return;
    this.uniforms.tDiffuse.value = readBuffer.texture;
    renderer.setRenderTarget(this.target);
    this.quad.render(renderer);
  }

  override dispose(): void {
    this.target.dispose();
    this.quad.dispose();
  }
}

/** The final pass's fragment shader: OutputShader's, plus bloom and grade
 * (and S5's shimmer, glare and shafts — uniforms, never defines). */
function finalFragmentShader(grade: boolean): string {
  const read = "gl_FragColor = texture2D( tDiffuse, vUv );";
  const src = OutputShader.fragmentShader;
  if (
    !src.includes(read) ||
    !src.includes("#include <colorspace_pars_fragment>")
  ) {
    throw new Error("post: OutputShader changed shape — re-check FinalPass");
  }
  const tail = src.lastIndexOf("}");
  const body = src
    .slice(0, tail)
    .replace(
      "#include <colorspace_pars_fragment>",
      `#include <colorspace_pars_fragment>\nuniform sampler2D tBloom;\n${FINITE_GLSL}${FINAL_ATMO_PARS_GLSL}${grade ? `uniform float uGradeOn;\n${GRADE_PARS_GLSL}` : ""}`,
    )
    .replace(
      read,
      // S5 heat shimmer bends the scene read (never the bloom, never the HUD).
      // Then the old additive blend, exactly: SRC_ALPHA, ONE on a float
      // target; then S5's glare (off the bloom) and light shafts.
      [
        "vec2 abUv = vUv + abShimmer( vUv );",
        // O7 (hdr-safe.ts): the scene read, and the sum of everything the
        // post adds to it, are finite and in range before the tone map —
        // ACES writes Inf and NaN as black.
        "gl_FragColor = texture2D( tDiffuse, abUv );",
        "gl_FragColor.rgb = abFinite( gl_FragColor.rgb );",
        "vec4 abBloom = texture2D( tBloom, vUv );",
        "gl_FragColor.rgb += abBloom.rgb * abBloom.a;",
        "if ( uGlare > 0.0 ) gl_FragColor.rgb += uGlare * abGlare( vUv );",
        "gl_FragColor.rgb += texture2D( tShafts, vUv ).rgb * uShaftTint;",
        "gl_FragColor.rgb = abFinite( gl_FragColor.rgb );",
      ].join("\n"),
    );
  // M3's tiers switch the grade off (Mobile): a uniform, so the switch never
  // compiles a program.
  return `${GLSL3_FRAGMENT}${body}${grade ? `if (uGradeOn > 0.5) ${GRADE_GLSL}` : ""}\n}`;
}

/**
 * O7: FinalPass is built as GLSL ES 3.00 (`abFinite` tests float bits) from
 * OutputShader's ES 1.00 source — the same maths, spelled for 3.00 exactly
 * as three spells it for every ShaderMaterial (WebGLProgram's prefix).
 */
const GLSL3_VERTEX = "#define attribute in\n#define varying out\n";
const GLSL3_FRAGMENT = [
  "#define varying in",
  "layout(location = 0) out highp vec4 pc_fragColor;",
  "#define gl_FragColor pc_fragColor",
  "#define texture2D texture",
  "",
].join("\n");

/**
 * Bloom add + tone map + sRGB + grade, one full-res pass. Behaves like
 * OutputPass toward the composer (reads `readBuffer`, renders to the screen
 * when last, else to `writeBuffer`), and re-reads the renderer's tone mapping,
 * output colour space and exposure every frame like OutputPass does (the sky
 * cycle moves the exposure).
 */
export class FinalPass extends Pass {
  readonly uniforms: Record<string, THREE.IUniform>;
  private readonly material: THREE.RawShaderMaterial;
  private readonly quad: FullScreenQuad;
  private colorSpace: string | null = null;
  private toneMapping: THREE.ToneMapping | null = null;

  constructor(
    private readonly bloom: AbBloomPass,
    grade: boolean,
    private readonly shafts: ShaftsPass | null = null,
  ) {
    super();
    this.uniforms = {
      tDiffuse: { value: null },
      tBloom: { value: null },
      toneMappingExposure: { value: 1 },
      // S5 (atmo-post.ts): written by AtmosphereFx each frame.
      tShafts: { value: null },
      uShaftTint: { value: new THREE.Vector3() },
      uShimA: {
        value: Array.from({ length: SHIMMER_SLOTS }, () => new THREE.Vector4()),
      },
      uShimB: {
        value: Array.from({ length: SHIMMER_SLOTS }, () => new THREE.Vector4()),
      },
      uShimCount: { value: 0 },
      uShimTime: { value: 0 },
      uTexel: { value: new THREE.Vector2(1, 1) },
      uAspect: { value: 1 },
      uGlare: { value: 0 },
      ...(grade ? { uGradeOn: { value: 1 }, ...gradeUniforms() } : {}),
    };
    this.material = new THREE.RawShaderMaterial({
      name: grade ? "AbFinalGradeShader" : "AbFinalShader",
      uniforms: this.uniforms,
      glslVersion: THREE.GLSL3,
      vertexShader: `${GLSL3_VERTEX}${OutputShader.vertexShader}`,
      fragmentShader: finalFragmentShader(grade),
    });
    this.quad = new FullScreenQuad(this.material);
  }

  /**
   * The grade's own switch (M3 turns it off on the Mobile tier). A uniform,
   * not a pass toggle: this pass also does the tone map and the encode, so
   * it can never be the thing that is disabled. False when built without it.
   */
  get gradeEnabled(): boolean {
    return (this.uniforms.uGradeOn?.value ?? 0) > 0.5;
  }

  set gradeEnabled(on: boolean) {
    const u = this.uniforms.uGradeOn;
    if (u) u.value = on ? 1 : 0;
  }

  override render(
    renderer: THREE.WebGLRenderer,
    writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
  ): void {
    (this.uniforms.tDiffuse as THREE.IUniform).value = readBuffer.texture;
    // A disabled bloom (M3: Mobile, a thermal level) is skipped by the
    // composer, so its texture is stale — add nothing instead (a null
    // sampler binds three's empty texture: zero, alpha zero).
    (this.uniforms.tBloom as THREE.IUniform).value = this.bloom.enabled
      ? this.bloom.bloomTexture
      : null;
    (this.uniforms.toneMappingExposure as THREE.IUniform).value =
      renderer.toneMappingExposure;
    // S5: shafts only when their pass drew this frame (else three's empty
    // texture: zero), and the shimmer's pixel size from the read target.
    (this.uniforms.tShafts as THREE.IUniform).value =
      this.shafts?.texture ?? null;
    (this.uniforms.uTexel?.value as THREE.Vector2).set(
      1 / Math.max(1, readBuffer.width),
      1 / Math.max(1, readBuffer.height),
    );
    // OutputPass's define rebuild, verbatim in effect.
    if (
      this.colorSpace !== renderer.outputColorSpace ||
      this.toneMapping !== renderer.toneMapping
    ) {
      this.colorSpace = renderer.outputColorSpace;
      this.toneMapping = renderer.toneMapping;
      const defines: Record<string, string> = {};
      if (
        THREE.ColorManagement.getTransfer(renderer.outputColorSpace) ===
        THREE.SRGBTransfer
      ) {
        defines.SRGB_TRANSFER = "";
      }
      const tm = TONE_MAPPING_DEFINES[renderer.toneMapping];
      if (tm) defines[tm] = "";
      this.material.defines = defines;
      this.material.needsUpdate = true;
    }
    if (this.renderToScreen) {
      renderer.setRenderTarget(null);
    } else {
      renderer.setRenderTarget(writeBuffer);
      if (this.clear) {
        renderer.clear(
          renderer.autoClearColor,
          renderer.autoClearDepth,
          renderer.autoClearStencil,
        );
      }
    }
    this.quad.render(renderer);
  }

  override dispose(): void {
    this.material.dispose();
    this.quad.dispose();
  }
}

/** S5: wrap a world clock (s) onto the shimmer's period, in doubles — a
 * raw epoch would reach the shader as a float32 with no fraction left. */
export const shimmerClock = (worldS: number): number =>
  ((worldS % SHIMMER_PERIOD_S) + SHIMMER_PERIOD_S) % SHIMMER_PERIOD_S;

const TONE_MAPPING_DEFINES: Partial<Record<THREE.ToneMapping, string>> = {
  [THREE.LinearToneMapping]: "LINEAR_TONE_MAPPING",
  [THREE.ReinhardToneMapping]: "REINHARD_TONE_MAPPING",
  [THREE.CineonToneMapping]: "CINEON_TONE_MAPPING",
  [THREE.ACESFilmicToneMapping]: "ACES_FILMIC_TONE_MAPPING",
  [THREE.AgXToneMapping]: "AGX_TONE_MAPPING",
  [THREE.NeutralToneMapping]: "NEUTRAL_TONE_MAPPING",
};
