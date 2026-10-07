// Animated signage shader (L7): the onBeforeCompile patches that make the
// street neon move — glyph tickers crawling up marquees, chasing bulb rings,
// "video" billboards, LED tickers on the storefront strips — plus the
// broken-tube stutter. All of it runs on the GPU from ONE shared clock
// uniform and the per-instance `aAnim` / `aSize` attributes, so a frame costs
// two uniform writes and no texture upload, and adds no draw call.
//
// Peak stays on the SIGN rung by construction: every effect only multiplies
// the HDR instanceColor (already sized to EMISSIVE_SIGN) by a gain ≤ 1, or
// mixes it with a palette colour normalised to the same luminance. The
// numbers are interpolated from signage-anim.ts, where the tests read them.

import { EMISSIVE_SIGN } from "@angels-bandits/common/constants";
import * as THREE from "three";
import {
  ANIM_CHASE,
  ANIM_GLYPH_TICKER,
  ANIM_LED_TICKER,
  ANIM_VIDEO,
  CHASE_GAP,
  CHASE_OFF,
  CHASE_ON,
  CHASE_RADIUS_M,
  CHASE_SPACING_M,
  LED_BACKING,
  LED_DOT_R,
  LED_LIT,
  LED_MEAN,
  LED_MESSAGE_COLS,
  LED_ROWS,
  LED_UNLIT,
  SIGN_LOOP_S,
  VIDEO_BACKDROP,
  VIDEO_FIELD_FLOOR,
  VIDEO_FIELD_S,
  VIDEO_PAN_S,
  VIDEO_SPIN_S,
} from "./signage-anim";

export type SignShaderKind = "marquee" | "billboard" | "strip";

/** GLSL float literal (always carries a decimal point). */
const f = (x: number): string => x.toFixed(6);

/** Marquee atlas geometry (signage.ts marqueeAtlas): the neon frame line is
 * centred 5 px in from the 64×512 tile edge; glyphs fill 22..490 px. */
const RING_U = 5 / 64;
const RING_V = 5 / 512;
const GLYPH_U0 = 0.14;
const GLYPH_U1 = 0.86;
const GLYPH_V0 = 22 / 512;
const GLYPH_V1 = 490 / 512;
/** Billboard brand-line footer (bottom 28% of the art) stays put through
 * every programme. */
const FOOTER_V = 0.28;

/** Uniforms every sign material shares (one write per frame). */
export interface SignUniforms {
  uSignTime: { value: number };
  /** Broken-tube stutter levels, packed four per vec4. */
  uStutter: { value: THREE.Vector4[] };
  /** Palette at SIGN-rung luminance (the colour fields' second hue). */
  uSignPalette: { value: THREE.Color[] };
}

export function createSignUniforms(
  brokenCount: number,
  palette: readonly { r: number; g: number; b: number }[],
): SignUniforms {
  return {
    uSignTime: { value: 0 },
    uStutter: {
      value: Array.from(
        { length: Math.max(1, Math.ceil(brokenCount / 4)) },
        () => new THREE.Vector4(1, 1, 1, 1),
      ),
    },
    uSignPalette: {
      value: palette.map((c) => new THREE.Color(c.r, c.g, c.b)),
    },
  };
}

/** Write per-tube stutter levels into the packed uniform. */
export function writeStutter(
  uniforms: SignUniforms,
  i: number,
  level: number,
): void {
  const v = uniforms.uStutter.value[i >> 2];
  if (v) v.setComponent(i & 3, level);
}

/** The vertex additions (all kinds): varyings + the stutter, applied to the
 * instance colour where the instance's broken slot is known. */
function vertexChunks(kind: SignShaderKind, brokenCount: number) {
  const vec4s = Math.max(1, Math.ceil(brokenCount / 4));
  const pars = `
attribute vec4 aAnim;
attribute vec3 aSize;
#define SIGN_STUTTER_VEC4S ${vec4s}
uniform vec4 uStutter[SIGN_STUTTER_VEC4S];
varying vec4 vAnim;
varying vec2 vSize;
varying vec2 vSignUv;
varying float vSignFront;
${kind === "strip" ? "" : "varying float vSignTile;"}`;
  const main = `
vAnim = aAnim;
vSize = aSize.xy;
vSignUv = uv;
// Only the outward face animates; the panel's edges and top stay plain.
vSignFront = step(0.5, normal.z);
${kind === "strip" ? "" : "vSignTile = aTile;"}
#ifdef USE_INSTANCING_COLOR
if (aSize.z >= 0.0) {
  int s = int(aSize.z + 0.5);
  vColor *= uStutter[s / 4][s - (s / 4) * 4];
}
#endif`;
  return { pars, main };
}

const FRAG_PARS = (kind: SignShaderKind) => `
uniform highp float uSignTime;
uniform vec3 uSignPalette[5];
varying vec4 vAnim;
varying vec2 vSize;
varying vec2 vSignUv;
varying float vSignFront;
${kind === "strip" ? "" : "varying float vSignTile;"}
#define SIGN_LOOP ${f(SIGN_LOOP_S)}
#define SIGN_RUNG ${f(EMISSIVE_SIGN)}
const vec3 SIGN_LUMA = vec3(0.2126, 0.7152, 0.0722);
bool signKind(float k) { return vSignFront > 0.5 && abs(vAnim.x - k) < 0.5; }
// PCG integer hash: identical on every GPU (a sin() hash is not).
uint signHash(uint v) {
  uint s = v * 747796405u + 2891336453u;
  uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}`;

/** Marquee texture lookup: the glyph ticker scrolls the stack inside the
 * fixed frame (textureGrad on the unwrapped coordinate, so the wrap line
 * draws no mip seam). */
const MARQUEE_MAP = (tiles: number) => `
#ifdef USE_MAP
  float signScroll = fract(uSignTime / SIGN_LOOP * vAnim.y + vAnim.z);
  float signSpan = ${f(GLYPH_V1 - GLYPH_V0)};
  float signV = (vSignUv.y - ${f(GLYPH_V0)}) / signSpan - signScroll;
  vec2 signGradUv = vec2((vSignTile + vSignUv.x) / ${f(tiles)}, ${f(GLYPH_V0)} + signV * signSpan);
  vec2 signDx = dFdx(signGradUv);
  vec2 signDy = dFdy(signGradUv);
  vec4 sampledDiffuseColor;
  if (signKind(${f(ANIM_GLYPH_TICKER)})
      && vSignUv.x > ${f(GLYPH_U0)} && vSignUv.x < ${f(GLYPH_U1)}
      && vSignUv.y > ${f(GLYPH_V0)} && vSignUv.y < ${f(GLYPH_V1)}) {
    vec2 wrapped = vec2(signGradUv.x, ${f(GLYPH_V0)} + fract(signV) * signSpan);
    sampledDiffuseColor = textureGrad(map, wrapped, signDx, signDy);
  } else {
    sampledDiffuseColor = texture2D(map, vMapUv);
  }
  diffuseColor *= sampledDiffuseColor;
#endif`;

/** Marquee chase ring: bulbs every CHASE_SPACING_M around the frame line,
 * lit in thirds; fades back to the plain frame once a bulb is sub-pixel. */
const MARQUEE_COLOR = `
#include <color_fragment>
{
  vec2 m = vSignUv * vSize;
  float aa = max(fwidth(m.x), fwidth(m.y));
  if (signKind(${f(ANIM_CHASE)})) {
    float ix = ${f(RING_U)} * vSize.x;
    float iy = ${f(RING_V)} * vSize.y;
    float rw = vSize.x - 2.0 * ix;
    float rh = vSize.y - 2.0 * iy;
    float dl = abs(m.x - ix);
    float dr = abs(m.x - (vSize.x - ix));
    float db = abs(m.y - iy);
    float dt = abs(m.y - (vSize.y - iy));
    float across;
    float p;
    if (min(dl, dr) < min(db, dt)) {
      across = min(dl, dr);
      p = dl < dr ? m.y - iy : rh + rw + (vSize.y - iy - m.y);
    } else {
      across = min(db, dt);
      p = dt < db ? rh + (m.x - ix) : 2.0 * rh + rw + (vSize.x - ix - m.x);
    }
    float sp = ${f(CHASE_SPACING_M)};
    float r = ${f(CHASE_RADIUS_M)};
    if (across < r * 1.6) {
      float bulb = floor(p / sp);
      float along = (fract(p / sp) - 0.5) * sp;
      float mask = 1.0 - smoothstep(r - aa, r + aa, length(vec2(along, across)));
      float step3 = floor(uSignTime / SIGN_LOOP * vAnim.y + vAnim.z * 3.0);
      float lit = mod(bulb + step3, 3.0) < 0.5 ? ${f(CHASE_ON)} : ${f(CHASE_OFF)};
      float ring = mix(${f(CHASE_GAP)}, lit, mask);
      float detail = 1.0 - smoothstep(r * 0.5, r * 1.5, aa);
      diffuseColor.rgb = mix(diffuseColor.rgb, vColor * ring, detail);
    }
  }
}`;

/** Billboard texture lookup: the slow-pan programme samples a 60%-wide
 * window that ping-pongs across its own atlas tile (never off it). */
const BILLBOARD_MAP = (tiles: number) => `
#ifdef USE_MAP
  float signT = uSignTime;
  float signMode = mod(floor(signT / max(vAnim.y, 1.0) + vAnim.z * 3.0), 3.0);
  float signTri = 1.0 - abs(2.0 * fract(signT / ${f(VIDEO_PAN_S)} + vAnim.z) - 1.0);
  float signU = clamp(0.4 * signTri + vSignUv.x * 0.6, 0.01, 0.99);
  vec2 signPanUv = vec2((vSignTile + signU) / ${f(tiles)}, vSignUv.y);
  vec4 signPan = texture2D(map, signPanUv);
  vec4 sampledDiffuseColor = texture2D(map, vMapUv);
  if (signKind(${f(ANIM_VIDEO)}) && signMode > 1.5 && vSignUv.y > ${f(FOOTER_V)}) {
    sampledDiffuseColor = signPan;
  }
  diffuseColor *= sampledDiffuseColor;
#endif`;

/** Billboard programmes 0 (drifting colour fields between the sign's hue and
 * a second rung-normalised hue) and 1 (a product silhouette spinning on a
 * dim backdrop). The footer brand line stays on the static art. */
const BILLBOARD_COLOR = `
#include <color_fragment>
if (signKind(${f(ANIM_VIDEO)}) && vSignUv.y > ${f(FOOTER_V)}) {
  float signT = uSignTime;
  float signMode = mod(floor(signT / max(vAnim.y, 1.0) + vAnim.z * 3.0), 3.0);
  float lumC = dot(vColor, SIGN_LUMA);
  vec3 other = uSignPalette[int(vAnim.w + 0.5)] * (lumC / SIGN_RUNG);
  if (signMode < 0.5) {
    float hue = 0.5 + 0.5 * sin(6.2831853 * (vSignUv.x * 1.3 - signT / ${f(VIDEO_FIELD_S)} + vAnim.z));
    float band = vSignUv.y * 0.9 + vSignUv.x * 0.45 + signT / ${f(VIDEO_FIELD_S)};
    float gain = ${f(VIDEO_FIELD_FLOOR)} + ${f(1 - VIDEO_FIELD_FLOOR)} * (0.5 + 0.5 * sin(6.2831853 * band));
    diffuseColor.rgb = mix(vColor, other, hue) * gain;
  } else if (signMode < 1.5) {
    float ang = 6.2831853 * signT / ${f(VIDEO_SPIN_S)};
    float c = abs(cos(ang));
    // Panel-space meters around the product's centre.
    float h = vSize.y * 0.3;
    vec2 q = vec2((vSignUv.x - 0.5) * vSize.x, (vSignUv.y - 0.64) * vSize.y);
    float halfW = h * 0.42 * (0.35 + 0.65 * c);
    float body = step(abs(q.x), halfW) * step(abs(q.y), h);
    float cap = step(abs(q.x), halfW * 0.45) * step(h, q.y) * step(q.y, h * 1.25);
    float shade = 0.45 + 0.55 * c;
    float label = step(abs(q.y), h * 0.2) * step(0.3, c);
    vec3 prod = mix(other * shade, vColor * shade, label);
    float on = max(body, cap);
    diffuseColor.rgb = mix(vColor * ${f(VIDEO_BACKDROP)}, prod, on);
  }
}`;

/** Strip LED ticker: a 5-row dot matrix of fake 3×5 glyphs (one PCG hash
 * per glyph — no font, no real word) crawling left; dots fade to the
 * panel's mean once they are sub-pixel, so a far ticker is a steady band. */
const STRIP_COLOR = `
#include <color_fragment>
{
  float pitch = vSize.y / ${f(LED_ROWS)};
  float scroll = fract(uSignTime / SIGN_LOOP * vAnim.y + vAnim.z) * ${f(LED_MESSAGE_COLS)};
  float colF = vSignUv.x * vSize.x / pitch + scroll;
  float rowF = vSignUv.y * ${f(LED_ROWS)};
  float px = max(fwidth(vSignUv.x * vSize.x / pitch), fwidth(rowF));
  if (signKind(${f(ANIM_LED_TICKER)})) {
    int col = int(mod(floor(colF), ${f(LED_MESSAGE_COLS)}));
    int row = clamp(int(floor(rowF)), 0, ${LED_ROWS - 1});
    int ch = col / 4;
    int cx = col - ch * 4;
    uint h = signHash(uint(ch) + uint(vAnim.w + 0.5) * 131u);
    bool space = (h % 7u) == 0u;
    bool lit = cx < 3 && !space && ((h >> uint(cx + 3 * row + 3)) & 1u) == 1u;
    vec2 cell = vec2(fract(colF), fract(rowF)) - 0.5;
    float dotAA = max(px, 0.02);
    float dotMask = 1.0 - smoothstep(${f(LED_DOT_R)} - dotAA, ${f(LED_DOT_R)} + dotAA, length(cell));
    float near = mix(${f(LED_BACKING)}, lit ? ${f(LED_LIT)} : ${f(LED_UNLIT)}, dotMask);
    float fade = smoothstep(0.3, 0.7, px);
    diffuseColor.rgb *= mix(near, ${f(LED_MEAN)}, fade);
  }
}`;

/**
 * Every GLSL fragment the patch injects for one sign kind — pure strings,
 * so the tests can confirm the constants the gain mirrors use are the ones
 * the GPU runs.
 */
export function signShaderChunks(
  kind: SignShaderKind,
  tiles: number,
  brokenCount: number,
): {
  vertexPars: string;
  vertexMain: string;
  fragmentPars: string;
  fragmentMap: string | null;
  fragmentColor: string;
} {
  const v = vertexChunks(kind, brokenCount);
  return {
    vertexPars: v.pars,
    vertexMain: v.main,
    fragmentPars: FRAG_PARS(kind),
    fragmentMap:
      kind === "marquee"
        ? MARQUEE_MAP(tiles)
        : kind === "billboard"
          ? BILLBOARD_MAP(tiles)
          : null,
    fragmentColor:
      kind === "marquee"
        ? MARQUEE_COLOR
        : kind === "billboard"
          ? BILLBOARD_COLOR
          : STRIP_COLOR,
  };
}

/**
 * Patch a sign material in place. Chains any existing onBeforeCompile (the
 * atlas `aTile` UV patch) and extends the cache key with the broken count,
 * which sizes the stutter array.
 */
export function patchSignMaterial(
  material: THREE.MeshBasicMaterial,
  kind: SignShaderKind,
  uniforms: SignUniforms,
  tiles: number,
  brokenCount: number,
): void {
  const chunks = signShaderChunks(kind, tiles, brokenCount);
  const prior = material.onBeforeCompile.bind(material);
  const baseKey = material.customProgramCacheKey();
  material.customProgramCacheKey = () =>
    `${baseKey}|ab-sign-anim-${kind}-${brokenCount}`;
  material.onBeforeCompile = (shader, renderer) => {
    prior(shader, renderer);
    shader.uniforms.uSignTime = uniforms.uSignTime;
    shader.uniforms.uStutter = uniforms.uStutter;
    shader.uniforms.uSignPalette = uniforms.uSignPalette;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${chunks.vertexPars}`)
      .replace(
        "#include <color_vertex>",
        `#include <color_vertex>\n${chunks.vertexMain}`,
      );
    let frag = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${chunks.fragmentPars}`)
      .replace("#include <color_fragment>", chunks.fragmentColor);
    if (chunks.fragmentMap) {
      frag = frag.replace("#include <map_fragment>", chunks.fragmentMap);
    }
    shader.fragmentShader = frag;
  };
}
