// O7 NaN/Inf probe (`?nanprobe`, QA only). A black box that flashes on
// screen is what one non-finite pixel in the HDR scene becomes: the bloom's
// bright pass passes it on, every blur tap that touches it turns NaN, each
// mip spreads it further, and FinalPass's tone map writes NaN (and Inf: ACES
// is Inf/Inf) as black — a blocky square that grows with the mip level.
// This pass sits right after the scene render, BEFORE bloom, and classifies
// every texel of the HDR target by its float BITS, so a driver's fast-math
// cannot fold the test away the way it may fold `isnan(x)` or `x != x`:
//
//   NaN   exponent all ones, mantissa non-zero
//   ±Inf  exponent all ones, mantissa zero (a float16 overflow lands here:
//         anything over 65504 written to the RGBA16F target is +Inf)
//   neg   finite and below zero (reported, never failed: it cannot bloom)
//
// `count` (the default) only writes a full-resolution RGBA8 mask — the
// image is untouched, so the black-box detector still sees the real thing —
// and `__ab.nanProbe()` reads it back for exact counts and a bounding box.
// `paint` also paints every non-finite texel magenta before bloom, for a
// human looking for one. Without the flag the pass is never built: no draw,
// no program, nothing.
//
// `inject()` is the detector's positive control: a 48×48 patch of HDR
// INJECT_LEVEL held for INJECT_FRAMES frames, with a 16×16 NaN core written
// on the middle one. The probe must count exactly INJECT_CORE² NaN pixels on that frame,
// and the detector (tools/perf/blackbox.mjs) must flag a box there.

import * as THREE from "three";
import {
  FullScreenQuad,
  Pass,
} from "three/examples/jsm/postprocessing/Pass.js";

export type NanProbeMode = "off" | "count" | "paint";

/** The positive control: patch and core edge lengths (drawing-buffer px). */
export const INJECT_PATCH = 48;
export const INJECT_CORE = 16;
/** The patch's linear HDR level: bright on screen, but under the bloom
 * threshold (0.72), so no glow of its own fills a sanitised (black) core. */
export const INJECT_LEVEL = 0.5;
/** Frames the patch is held; the core lands on the middle one. */
export const INJECT_FRAMES = 7;
/** What `paint` writes over a non-finite texel (linear HDR magenta). */
const PAINT = "vec4(8.0, 0.0, 8.0, 1.0)";

/** GLSL ES 3.00: which channels are NaN / ±Inf, from the bits alone. */
const CLASSIFY_GLSL = /* glsl */ `
bvec3 abNan(vec3 c) {
  return greaterThan(floatBitsToUint(c) & uvec3(0x7fffffffu), uvec3(0x7f800000u));
}
bvec3 abInf(vec3 c) {
  return equal(floatBitsToUint(c) & uvec3(0x7fffffffu), uvec3(0x7f800000u));
}
`;

const VERTEX = /* glsl */ `
void main() {
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

/** One probe readback: the last frame the pass ran on. */
export interface NanProbeReading {
  /** Frames the probe has classified since boot. */
  frame: number;
  width: number;
  height: number;
  /** Pixels with any NaN channel. */
  nan: number;
  /** Pixels with an infinite channel (and none NaN). */
  inf: number;
  /** Finite pixels with a negative channel. */
  neg: number;
  /** Bounding box of the non-finite pixels (GL pixel coords, y up), or null. */
  box: { x0: number; y0: number; x1: number; y1: number } | null;
}

export class NanProbePass extends Pass {
  private readonly mask = new THREE.WebGLRenderTarget(1, 1, {
    depthBuffer: false,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
  });
  private readonly maskUniforms = {
    tDiffuse: { value: null as THREE.Texture | null },
  };
  private readonly paintUniforms = {
    tDiffuse: { value: null as THREE.Texture | null },
  };
  private readonly injectUniforms = {
    uBits: { value: 0 },
    uValue: { value: 1 },
  };
  private readonly maskQuad = new FullScreenQuad(
    new THREE.ShaderMaterial({
      name: "AbNanProbeMask",
      uniforms: this.maskUniforms,
      vertexShader: VERTEX,
      fragmentShader: /* glsl */ `
uniform sampler2D tDiffuse;
${CLASSIFY_GLSL}
void main() {
  vec3 c = texelFetch(tDiffuse, ivec2(gl_FragCoord.xy), 0).rgb;
  bool nan = any(abNan(c));
  bool inf = !nan && any(abInf(c));
  bool neg = !nan && !inf && any(lessThan(c, vec3(0.0)));
  gl_FragColor = vec4(nan ? 1.0 : 0.0, inf ? 1.0 : 0.0, neg ? 1.0 : 0.0, 1.0);
}`,
      depthTest: false,
      depthWrite: false,
    }),
  );
  private readonly paintQuad = new FullScreenQuad(
    new THREE.ShaderMaterial({
      name: "AbNanProbePaint",
      uniforms: this.paintUniforms,
      vertexShader: VERTEX,
      fragmentShader: /* glsl */ `
uniform sampler2D tDiffuse;
${CLASSIFY_GLSL}
void main() {
  vec4 c = texelFetch(tDiffuse, ivec2(gl_FragCoord.xy), 0);
  gl_FragColor = any(abNan(c.rgb)) || any(abInf(c.rgb)) ? ${PAINT} : c;
}`,
      depthTest: false,
      depthWrite: false,
    }),
  );
  /** Writes `uintBitsToFloat(uBits)` (a uniform, so nothing folds it). */
  private readonly injectQuad = new FullScreenQuad(
    new THREE.ShaderMaterial({
      name: "AbNanProbeInject",
      uniforms: this.injectUniforms,
      vertexShader: VERTEX,
      fragmentShader: /* glsl */ `
uniform float uBits;
uniform float uValue;
void main() {
  float v = uBits > 0.0 ? uintBitsToFloat(uint(uBits)) : uValue;
  gl_FragColor = vec4(v, v, v, 1.0);
}`,
      depthTest: false,
      depthWrite: false,
    }),
  );
  private frames = 0;
  /** Frames of the positive control still to draw (0: none queued). */
  private injectLeft = 0;
  private pixels = new Uint8Array(4);

  constructor(private readonly paint: boolean) {
    super();
    this.needsSwap = paint;
  }

  /** Queue the positive control (see the header). */
  inject(): void {
    this.injectLeft = INJECT_FRAMES;
  }

  /** `width`/`height` are DRAWING-BUFFER pixels (EffectComposer's). */
  override setSize(width: number, height: number): void {
    this.mask.setSize(Math.max(1, width), Math.max(1, height));
  }

  override render(
    renderer: THREE.WebGLRenderer,
    writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
  ): void {
    if (this.injectLeft > 0) this.drawInject(renderer, readBuffer);
    this.maskUniforms.tDiffuse.value = readBuffer.texture;
    renderer.setRenderTarget(this.mask);
    this.maskQuad.render(renderer);
    if (this.paint) {
      this.paintUniforms.tDiffuse.value = readBuffer.texture;
      renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
      this.paintQuad.render(renderer);
    }
    this.frames++;
  }

  private drawInject(
    renderer: THREE.WebGLRenderer,
    target: THREE.WebGLRenderTarget,
  ): void {
    const k = INJECT_FRAMES - this.injectLeft;
    this.injectLeft--;
    const u = this.injectUniforms;
    const cx = Math.floor(target.width / 2);
    const cy = Math.floor(target.height / 2);
    const square = (edge: number, bits: number, value: number): void => {
      u.uBits.value = bits;
      u.uValue.value = value;
      target.scissor.set(cx - edge / 2, cy - edge / 2, edge, edge);
      target.scissorTest = true;
      renderer.setRenderTarget(target);
      this.injectQuad.render(renderer);
      target.scissorTest = false;
    };
    square(INJECT_PATCH, 0, INJECT_LEVEL);
    // 0x7fc00000: a quiet NaN (exactly representable as a float uniform).
    if (k === Math.floor(INJECT_FRAMES / 2)) square(INJECT_CORE, 0x7fc00000, 0);
  }

  /** Read the last frame's mask back (synchronous; QA only). */
  read(renderer: THREE.WebGLRenderer): NanProbeReading {
    const { width, height } = this.mask;
    const n = width * height * 4;
    if (this.pixels.length !== n) this.pixels = new Uint8Array(n);
    const px = this.pixels;
    renderer.readRenderTargetPixels(this.mask, 0, 0, width, height, px);
    let nan = 0;
    let inf = 0;
    let neg = 0;
    let x0 = width;
    let y0 = height;
    let x1 = -1;
    let y1 = -1;
    for (let i = 0, p = 0; i < n; i += 4, p++) {
      const bad = (px[i] as number) > 127 || (px[i + 1] as number) > 127;
      if ((px[i] as number) > 127) nan++;
      else if ((px[i + 1] as number) > 127) inf++;
      else if ((px[i + 2] as number) > 127) neg++;
      if (bad) {
        const x = p % width;
        const y = (p - x) / width;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
    return {
      frame: this.frames,
      width,
      height,
      nan,
      inf,
      neg,
      box: x1 < 0 ? null : { x0, y0, x1, y1 },
    };
  }

  override dispose(): void {
    this.mask.dispose();
    this.maskQuad.dispose();
    this.paintQuad.dispose();
    this.injectQuad.dispose();
  }
}
