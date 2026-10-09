// S1 live jumbotrons — the city talks about the fight. Big video screens on
// the landmark shafts and the facades facing the plazas show the TOP PILOT,
// the live kill feed, a LAST KILL replay card and the storm banner; an LED
// ticker under each screen crawls the match headlines. What they SAY comes
// from the pure model in game/headlines.ts (name-guarded, identical on every
// client); this file only lays the screens out and draws them.
//
// Cost model (the ticket's budget):
//   - ONE draw for every screen AND every ticker: a single InstancedMesh, two
//     instances per site, a per-instance kind picking screen or ticker art.
//   - Canvas repaints + texture uploads only when the content changes (a
//     kill, a new leader, a weather banner), never per frame.
//   - The LAST KILL shot is ONE small render-to-texture pass (256×144, the
//     plane's 2-draw impostor in a private mini scene), run on the frame
//     after a kill and never otherwise. Mobile skips it: the screens show the
//     static livery card painted on the canvas (a uniform flip — the same
//     program on every tier, so a tier switch compiles nothing).
// Placement rides the shared ImageCache/InstanceUploads nearest-image path,
// like the street signage, so a screen across the seam is drawn where the
// camera sees it.

import {
  type Building,
  LANDMARK_BLOCKS,
  type LocalBox,
  PLAZA_BLOCKS,
} from "@angels-bandits/common/city";
import {
  BLOCK_PITCH,
  EMISSIVE_SIGN,
  WORLD_SIZE,
} from "@angels-bandits/common/constants";
import {
  type Vec3,
  canonicalize,
  wrapDelta,
  wrapDeltaAxis,
} from "@angels-bandits/common/world";
import * as THREE from "three";
import type { MatchWarning } from "../game/headlines";
import { CLASSIC_LIVERY, type Livery, createBiplane } from "./biplane";
import { emissiveBoost } from "./emissive";
import { applyHeroLight } from "./planelights";
import { QUALITY_PROFILES, type QualityTier } from "./quality";
import { type StandingLayer, StandingMask } from "./standing-watch";
import { ImageCache, InstanceUploads } from "./wrapPlacement";

// --- Layout (pure) ---

/** Hard cap on screens (the ticket asks for 3–6). */
export const JUMBOTRON_MAX = 6;
/** Landmark screens: on the shaft (tier 2), well above the podium. */
const LANDMARK_SCREEN_WIDTH = 48;
const LANDMARK_SCREEN_BOTTOM = 92;
/** Plaza screens: on a tier-1 facade facing the plaza, above every L7 sign
 * (marquees top out at 33 m) — the ticker under it starts at 34 m. */
const PLAZA_SCREEN_WIDTH = 32;
const PLAZA_SCREEN_BOTTOM = 38;
/** A facade must be this much longer than the screen to carry it. */
const FACE_MARGIN = 4;
/** How proud of the facade a screen sits, meters (visual only, like signs). */
const SCREEN_DEPTH = 0.4;
/** LED ticker band under each screen: height and gap, meters. */
export const TICKER_HEIGHT = 2.6;
const TICKER_GAP = 1;
/** How far beyond a plaza facade we look for the plaza, meters. */
const PLAZA_PROBE = 30;

/** One screen: canonical panel-center ground position, bottom edge, size,
 * and the facade's outward normal. Its ticker hangs just below it. */
export interface JumbotronSite {
  x: number;
  z: number;
  y: number;
  width: number;
  height: number;
  axis: "x" | "z";
  dir: -1 | 1;
  /** D8: the index of the building it hangs on. */
  building: number;
}

const GRID = WORLD_SIZE / BLOCK_PITCH;
const wrapBlock = (b: number): number => ((b % GRID) + GRID) % GRID;
const blockOf = (v: number): number => wrapBlock(Math.floor(v / BLOCK_PITCH));
const blockCenter = ([bx, bz]: readonly [number, number]): Vec3 => ({
  x: bx * BLOCK_PITCH + BLOCK_PITCH / 2,
  y: 0,
  z: bz * BLOCK_PITCH + BLOCK_PITCH / 2,
});

/** A screen mounted proud of the facade plane at `plane` on `axis`. */
function mount(
  axis: "x" | "z",
  dir: -1 | 1,
  plane: number,
  along: number,
  y: number,
  width: number,
  building: number,
): JumbotronSite {
  const perp = plane + (dir * SCREEN_DEPTH) / 2;
  const c = canonicalize(
    axis === "x" ? { x: perp, y: 0, z: along } : { x: along, y: 0, z: perp },
  );
  return {
    x: c.x,
    z: c.z,
    y,
    width,
    height: (width * 9) / 16,
    axis,
    dir,
    building,
  };
}

/** The landmark's shaft face that looks toward its nearest plaza. */
function landmarkSite(b: Building, index: number): JumbotronSite | null {
  const shaft = b.tiers[1];
  const podium = b.tiers[0];
  if (!shaft || !podium) return null;
  const at = { x: b.x, y: 0, z: b.z };
  let best: Vec3 | null = null;
  let bestD = Number.POSITIVE_INFINITY;
  for (const p of PLAZA_BLOCKS) {
    const d = wrapDelta(at, blockCenter(p));
    const dist = Math.hypot(d.x, d.z);
    if (dist < bestD) {
      bestD = dist;
      best = d;
    }
  }
  if (!best) return null;
  const axis = Math.abs(best.x) >= Math.abs(best.z) ? "x" : "z";
  const dir = (axis === "x" ? best.x : best.z) >= 0 ? 1 : -1;
  const half = (axis === "x" ? shaft.width : shaft.depth) / 2;
  const length = axis === "x" ? shaft.depth : shaft.width;
  const width = Math.min(LANDMARK_SCREEN_WIDTH, length - FACE_MARGIN);
  const bottom = Math.max(LANDMARK_SCREEN_BOTTOM, podium.height + 20);
  if (bottom + (width * 9) / 16 > podium.height + shaft.height - 4) return null;
  return mount(
    axis,
    dir,
    (axis === "x" ? b.x : b.z) + dir * half,
    axis === "x" ? b.z : b.x,
    bottom,
    width,
    index,
  );
}

/** The tallest tier-1 facade that faces plaza block (px, pz) across the
 * street, skipping hole mouths (a screen would hang across the opening). */
function plazaSite(
  buildings: readonly Building[],
  landmarks: ReadonlySet<Building>,
  px: number,
  pz: number,
): JumbotronSite | null {
  let best: { b: Building; site: JumbotronSite } | null = null;
  for (let i = 0; i < buildings.length; i++) {
    const b = buildings[i] as Building;
    if (landmarks.has(b)) continue;
    const t1 = b.tiers[0];
    if (!t1) continue;
    const mouths = new Set(
      (b.holes ?? []).filter((h) => h.tierIndex === 0).map((h) => h.axis),
    );
    for (const axis of ["x", "z"] as const) {
      if (mouths.has(axis)) continue;
      const half = (axis === "x" ? t1.width : t1.depth) / 2;
      const length = axis === "x" ? t1.depth : t1.width;
      const width = Math.min(PLAZA_SCREEN_WIDTH, length - FACE_MARGIN);
      if (width < PLAZA_SCREEN_WIDTH * 0.6) continue;
      if (t1.height < PLAZA_SCREEN_BOTTOM + (width * 9) / 16 + 2) continue;
      for (const dir of [-1, 1] as const) {
        const plane = (axis === "x" ? b.x : b.z) + dir * half;
        const probe = plane + dir * PLAZA_PROBE;
        const along = axis === "x" ? b.z : b.x;
        const bx = blockOf(axis === "x" ? probe : along);
        const bz = blockOf(axis === "x" ? along : probe);
        if (bx !== px || bz !== pz) continue;
        if (
          best === null ||
          b.height > best.b.height ||
          (b.height === best.b.height &&
            (b.x < best.b.x || (b.x === best.b.x && b.z < best.b.z)))
        ) {
          best = {
            b,
            site: mount(axis, dir, plane, along, PLAZA_SCREEN_BOTTOM, width, i),
          };
        }
      }
    }
  }
  return best?.site ?? null;
}

/**
 * Where the jumbotrons hang: each landmark's shaft, facing its nearest
 * plaza, then one plaza-facing facade per plaza — capped at JUMBOTRON_MAX.
 * Deterministic from the city alone, so every client hangs the same screens.
 */
export function jumbotronSites(
  buildings: readonly Building[],
): JumbotronSite[] {
  const sites: JumbotronSite[] = [];
  const landmarks = new Set<Building>();
  for (const block of LANDMARK_BLOCKS) {
    const c = blockCenter(block);
    const index = buildings.findIndex((o) => o.x === c.x && o.z === c.z);
    const b = buildings[index];
    if (!b) continue;
    landmarks.add(b);
    const site = landmarkSite(b, index);
    if (site) sites.push(site);
  }
  for (const [px, pz] of PLAZA_BLOCKS) {
    const site = plazaSite(buildings, landmarks, px, pz);
    if (site) sites.push(site);
  }
  return sites.slice(0, JUMBOTRON_MAX);
}

/** D8: site `s`'s screen (or its ticker) box in its building's frame. */
function siteBox(b: Building, s: JumbotronSite, ticker: boolean): LocalBox {
  const x = wrapDeltaAxis(b.x, s.x);
  const z = wrapDeltaAxis(b.z, s.z);
  const hx = (s.axis === "x" ? SCREEN_DEPTH : s.width) / 2;
  const hz = (s.axis === "x" ? s.width : SCREEN_DEPTH) / 2;
  const y0 = ticker ? s.y - TICKER_GAP - TICKER_HEIGHT : s.y;
  const y1 = ticker ? s.y - TICKER_GAP : s.y + s.height;
  return { x0: x - hx, x1: x + hx, y0, y1, z0: z - hz, z1: z + hz };
}

/** D8: each building's screens and tickers (site order, screen then
 * ticker) — the instances' own order, so item k of a building is instance
 * `slots[k]`. */
function jumbotronLayer(
  buildings: readonly Building[],
  sites: readonly JumbotronSite[],
): StandingLayer & { instances(index: number): readonly number[] } {
  const per = new Map<number, number[]>();
  sites.forEach((s, i) => {
    const list = per.get(s.building) ?? [];
    list.push(i * 2, i * 2 + 1);
    per.set(s.building, list);
  });
  return {
    boxes(index) {
      const b = buildings[index] as Building;
      return (per.get(index) ?? []).map((n) =>
        siteBox(b, sites[n >> 1] as JumbotronSite, (n & 1) === 1),
      );
    },
    instances: (index) => per.get(index) ?? [],
  };
}

/** D8: the jumbotrons' items per building — what the renderer masks with. */
export function jumbotronStandingLayer(
  buildings: readonly Building[],
): StandingLayer {
  return jumbotronLayer(buildings, jumbotronSites(buildings));
}

// --- Content (what the screens are told) ---

/** The TOP PILOT panel: guarded label, livery, tallies. */
export interface LeaderCard {
  id: string;
  label: string;
  livery: Livery;
  kills: number;
  deaths: number;
}

/** One kill as the screens show it. */
export interface KillCard {
  headline: string;
  feed: string;
  caption: string;
  subjectLabel: string;
  livery: Livery;
}

// --- Renderer ---

/** Screen canvas (16:9) and the LAST KILL card's rectangle on it, px. */
const SCREEN_W = 1024;
const SCREEN_H = 576;
const CARD = { x: 432, y: 92, w: 560, h: 315 } as const;
/** Ticker canvas: one row of headline text. Capped at 2048 px wide (the
 * smallest phone texture limit has room to spare). */
const TICKER_W = 2048;
const TICKER_H = 64;
/** Ticker text pixels per meter of ticker (its height fills the band). */
const TICKER_PX_PER_M = TICKER_H / TICKER_HEIGHT;
/** Crawl speed, ticker pixels per second (~5 m/s on the band). */
const TICKER_SPEED_PX = 120;
/** Headlines the ticker carries, newest first. */
const TICKER_HEADLINES = 4;
/** Kill-feed lines the screen shows. */
const FEED_LINES = 4;
const TICKER_SEPARATOR = "   ◆   ";
/** LAST KILL render target size, px. */
const REPLAY_W = 256;
const REPLAY_H = 144;
const FONT = "ui-monospace, SFMono-Regular, Menlo, monospace";

const css = (hex: number): string => `#${hex.toString(16).padStart(6, "0")}`;

/** Fixed jumbotron camera on the LAST KILL subject: a low three-quarter
 * hero angle off the nose, the plane banked into it. */
const REPLAY_EYE = new THREE.Vector3(7.5, 2.4, 9.5);
const REPLAY_AT = new THREE.Vector3(0, 0.4, 0.2);
const REPLAY_BANK = -0.32;
const REPLAY_BACKDROP = new THREE.Color(0x0a1022);

const VERTEX_PARS = /* glsl */ `
attribute vec2 aJumbo;
varying vec2 vJumbo;
varying float vFront;
`;
const FRAGMENT_PARS = /* glsl */ `
uniform sampler2D uTicker;
uniform sampler2D uReplay;
uniform vec4 uReplayRect;
uniform float uReplayOn;
uniform float uTickerScroll;
uniform float uTickerLoop;
varying vec2 vJumbo;
varying float vFront;
`;
/** Front face only (the box's sides and top are a dark housing). Screen:
 * the canvas, with the LAST KILL shot laid into its card (scan
 * lines + a cool grade make it read as a broadcast, not a viewport).
 * Ticker: the headline row, crawled by the synced clock and wrapped on
 * the loop length. */
const FRAGMENT_MAP = /* glsl */ `
vec4 jumboTexel;
if (vFront < 0.5) {
  jumboTexel = vec4(vec3(0.015), 1.0); // the housing: only the face is lit
} else if (vJumbo.x > 0.5) {
  float px = vMapUv.x * vJumbo.y * ${(TICKER_PX_PER_M).toFixed(4)} + uTickerScroll;
  jumboTexel = texture2D(uTicker,
    vec2(mod(px, uTickerLoop) / ${TICKER_W.toFixed(1)}, vMapUv.y));
} else {
  jumboTexel = texture2D(map, vMapUv);
  vec2 r = (vMapUv - uReplayRect.xy) / (uReplayRect.zw - uReplayRect.xy);
  if (uReplayOn > 0.5 && r.x >= 0.0 && r.x <= 1.0 && r.y >= 0.0 && r.y <= 1.0) {
    vec3 shot = texture2D(uReplay, r).rgb;
    float scan = 0.82 + 0.18 * sin(r.y * ${(REPLAY_H * Math.PI).toFixed(3)});
    jumboTexel = vec4(shot * scan * vec3(0.9, 1.0, 1.08), 1.0);
  }
}
diffuseColor *= jumboTexel;
`;

/** Unit box standing on its bottom edge (the signage idiom). */
function unitPanel(): THREE.BoxGeometry {
  const g = new THREE.BoxGeometry(1, 1, 1);
  g.translate(0, 0.5, 0);
  return g;
}

/** Facade-normal yaw: local +Z (the face) outward, local X along it. */
const yawOf = (s: JumbotronSite): number =>
  s.axis === "z"
    ? s.dir === 1
      ? 0
      : Math.PI
    : (s.dir === 1 ? 1 : -1) * (Math.PI / 2);

/** The LAST KILL mini studio: one impostor plane, a key and a fill. */
class ReplayStudio {
  readonly target = new THREE.WebGLRenderTarget(REPLAY_W, REPLAY_H);
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(
    28,
    REPLAY_W / REPLAY_H,
    0.5,
    60,
  );
  private readonly body: THREE.MeshStandardMaterial;
  private readonly clear = new THREE.Color();
  /** Draw calls of the last pass, for QA. */
  lastDraws = 0;

  constructor() {
    // sRGB storage: 8 bits written linear-in, decoded on sample, so the
    // screen reads it in the composer's linear space without banding.
    this.target.texture.colorSpace = THREE.SRGBColorSpace;
    // The impostor level: two draws (body, dark metal). Only GEOMETRY is
    // shared between biplanes; these materials are this studio's own.
    const { far, materials } = createBiplane(CLASSIC_LIVERY);
    applyHeroLight(far);
    this.body = materials.body;
    far.rotation.z = REPLAY_BANK;
    this.scene.add(far);
    this.scene.add(new THREE.HemisphereLight(0xb8c8ff, 0x20242c, 1.6));
    const key = new THREE.DirectionalLight(0xfff1dc, 2.2);
    key.position.set(4, 6, 8);
    this.scene.add(key);
    this.scene.background = REPLAY_BACKDROP;
    this.camera.position.copy(REPLAY_EYE);
    this.camera.lookAt(REPLAY_AT);
  }

  /** Paint the subject's livery and render the shot: one small pass. */
  capture(renderer: THREE.WebGLRenderer, livery: Livery): void {
    this.body.color.setHex(livery.primary);
    const previous = renderer.getRenderTarget();
    renderer.getClearColor(this.clear);
    const alpha = renderer.getClearAlpha();
    const before = renderer.info.render.calls;
    renderer.setRenderTarget(this.target);
    renderer.render(this.scene, this.camera);
    this.lastDraws = renderer.info.render.calls - before;
    renderer.setRenderTarget(previous);
    renderer.setClearColor(this.clear, alpha);
  }
}

export class Jumbotrons {
  readonly mesh: THREE.InstancedMesh;
  readonly sites: readonly JumbotronSite[];
  private readonly screenCanvas = document.createElement("canvas");
  private readonly tickerCanvas = document.createElement("canvas");
  private readonly screenTex: THREE.CanvasTexture;
  private readonly tickerTex: THREE.CanvasTexture;
  private readonly studio = new ReplayStudio();
  private readonly images: ImageCache;
  private readonly uploads: InstanceUploads;
  /** D8: a screen on a facade that is gone goes with it. */
  private readonly standing: StandingMask;
  private readonly layer: ReturnType<typeof jumbotronLayer>;
  /** D8: each instance's item index on its building. */
  private readonly slot: Int32Array;
  private readonly uniforms = {
    uTicker: { value: null as THREE.Texture | null },
    uReplay: { value: null as THREE.Texture | null },
    uReplayRect: { value: new THREE.Vector4() },
    uReplayOn: { value: 0 },
    uTickerScroll: { value: 0 },
    uTickerLoop: { value: TICKER_W },
  };
  private readonly matrix = new THREE.Matrix4();
  private readonly quat = new THREE.Quaternion();
  private readonly pos = new THREE.Vector3();
  private readonly scale = new THREE.Vector3();
  private static readonly UP = new THREE.Vector3(0, 1, 0);

  // Content.
  private leader: LeaderCard | null = null;
  private warning: MatchWarning | null = null;
  private readonly headlines: string[] = [];
  private readonly feed: string[] = [];
  private lastKill: KillCard | null = null;
  private dirty = true;
  private pendingReplay: Livery | null = null;
  /** Kills the replay pass has rendered, for QA (check: one per kill). */
  private replayPasses = 0;
  private replayEnabled = true;
  private tickerAnimated = true;

  constructor(
    buildings: readonly Building[],
    private readonly renderer: THREE.WebGLRenderer,
  ) {
    this.sites = jumbotronSites(buildings);
    this.layer = jumbotronLayer(buildings, this.sites);
    this.slot = new Int32Array(this.sites.length * 2);
    for (const s of this.sites) {
      this.layer.instances(s.building).forEach((n, k) => {
        this.slot[n] = k;
      });
    }
    this.standing = new StandingMask(buildings, this.layer, (b) => {
      for (const n of this.layer.instances(b)) this.images.dirty(n);
    });
    this.screenCanvas.width = SCREEN_W;
    this.screenCanvas.height = SCREEN_H;
    this.tickerCanvas.width = TICKER_W;
    this.tickerCanvas.height = TICKER_H;
    this.screenTex = new THREE.CanvasTexture(this.screenCanvas);
    this.screenTex.colorSpace = THREE.SRGBColorSpace;
    this.screenTex.anisotropy = 4;
    this.tickerTex = new THREE.CanvasTexture(this.tickerCanvas);
    this.tickerTex.colorSpace = THREE.SRGBColorSpace;
    // The crawl wraps with mod() in the shader — mip selection would see
    // the wrap's derivative jump as a seam, so the ticker stays unmipped.
    this.tickerTex.generateMipmaps = false;
    this.tickerTex.minFilter = THREE.LinearFilter;
    this.uniforms.uTicker.value = this.tickerTex;
    this.uniforms.uReplay.value = this.studio.target.texture;
    this.uniforms.uReplayRect.value.set(
      CARD.x / SCREEN_W,
      1 - (CARD.y + CARD.h) / SCREEN_H,
      (CARD.x + CARD.w) / SCREEN_W,
      1 - CARD.y / SCREEN_H,
    );

    // White lifted to the SIGN rung: the screens sit with the street neon,
    // under the lamps and far under the tracers.
    const white = new THREE.Color(1, 1, 1);
    const material = new THREE.MeshBasicMaterial({
      map: this.screenTex,
      color: white.multiplyScalar(emissiveBoost(white, EMISSIVE_SIGN)),
    });
    material.customProgramCacheKey = () => "ab-jumbotron";
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", `#include <common>\n${VERTEX_PARS}`)
        .replace(
          "#include <uv_vertex>",
          "#include <uv_vertex>\nvJumbo = aJumbo;\nvFront = step(0.5, normal.z);",
        );
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", `#include <common>\n${FRAGMENT_PARS}`)
        .replace("#include <map_fragment>", FRAGMENT_MAP);
    };

    const count = this.sites.length * 2;
    const geometry = unitPanel();
    const jumbo = new Float32Array(Math.max(1, count) * 2);
    this.sites.forEach((s, i) => {
      jumbo.set([0, s.width, 1, s.width], i * 4);
    });
    geometry.setAttribute(
      "aJumbo",
      new THREE.InstancedBufferAttribute(jumbo, 2),
    );
    this.mesh = new THREE.InstancedMesh(geometry, material, Math.max(1, count));
    this.mesh.count = count;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false; // re-imaged per frame, like the signs
    // Instance i*2 is site i's screen, i*2+1 its ticker: same anchor.
    const xs = this.sites.flatMap((s) => [s.x, s.x]);
    const zs = this.sites.flatMap((s) => [s.z, s.z]);
    this.images = new ImageCache(xs, zs);
    this.uploads = new InstanceUploads([this.mesh.instanceMatrix]);

    this.paint();
    // Boot capture on EVERY tier: compiles the studio's programs behind the
    // boot fade, so the first kill never hitches (O2's rule).
    this.studio.capture(renderer, CLASSIC_LIVERY);
    // Canvas text drawn before the page font is ready falls back silently.
    document.fonts?.ready.then(() => {
      this.dirty = true;
    });
  }

  /** The current TOP PILOT (null = nobody has a kill yet). */
  setLeader(card: LeaderCard | null): void {
    const a = this.leader;
    if (
      a === card ||
      (a &&
        card &&
        a.id === card.id &&
        a.label === card.label &&
        a.kills === card.kills &&
        a.deaths === card.deaths)
    ) {
      return;
    }
    this.leader = card;
    this.dirty = true;
  }

  /** The banner (storm today; D5 adds destruction). */
  setWarning(warning: MatchWarning | null): void {
    if (warning?.text === this.warning?.text) return;
    this.warning = warning;
    this.dirty = true;
  }

  /** A kill: headline onto the ticker, a feed line, a fresh LAST KILL. */
  addKill(kill: KillCard): void {
    this.headlines.unshift(kill.headline);
    this.headlines.length = Math.min(this.headlines.length, TICKER_HEADLINES);
    this.feed.unshift(kill.feed);
    this.feed.length = Math.min(this.feed.length, FEED_LINES);
    this.lastKill = kill;
    this.pendingReplay = kill.livery;
    this.dirty = true;
  }

  /** S4: a headline and a feed line with no LAST KILL shot (the sky boss
   * going down is not a plane's kill). */
  addHeadline(headline: string, feed: string): void {
    this.headlines.unshift(headline);
    this.headlines.length = Math.min(this.headlines.length, TICKER_HEADLINES);
    this.feed.unshift(feed);
    this.feed.length = Math.min(this.feed.length, FEED_LINES);
    this.dirty = true;
  }

  /** Mobile: the static livery card instead of the rendered shot. The
   * ticker crawls with the rest of the L7 sign animation. */
  setQuality(tier: QualityTier): void {
    this.replayEnabled = QUALITY_PROFILES[tier].jumbotronReplay;
    this.tickerAnimated = QUALITY_PROFILES[tier].signAnimation;
    // The shot on screen may be stale after a Mobile stint: show it again
    // only once a kill has been captured on this tier.
    if (!this.replayEnabled) this.uniforms.uReplayOn.value = 0;
  }

  /**
   * Per frame, before the main render: place at the camera's torus images,
   * crawl the ticker on the synced clock, repaint if the content changed,
   * and run the LAST KILL pass if a kill landed since the last frame.
   */
  update(cameraPos: Vec3, timeMs: number | null): void {
    this.standing.update(); // D8
    this.images.update(cameraPos, this.place);
    this.uploads.flush();
    const loop = this.uniforms.uTickerLoop.value;
    this.uniforms.uTickerScroll.value =
      this.tickerAnimated && timeMs !== null
        ? ((timeMs / 1000) * TICKER_SPEED_PX) % loop
        : 0;
    if (this.dirty) this.paint();
    if (this.pendingReplay !== null) {
      if (this.replayEnabled) {
        this.studio.capture(this.renderer, this.pendingReplay);
        this.replayPasses++;
        this.uniforms.uReplayOn.value = 1;
      }
      this.pendingReplay = null;
    }
  }

  private readonly place = (i: number, x: number, z: number): void => {
    const site = this.sites[i >> 1] as JumbotronSite;
    const ticker = (i & 1) === 1;
    this.quat.setFromAxisAngle(Jumbotrons.UP, yawOf(site));
    this.pos.set(x, ticker ? site.y - TICKER_GAP - TICKER_HEIGHT : site.y, z);
    this.scale.set(
      site.width,
      ticker ? TICKER_HEIGHT : site.height,
      SCREEN_DEPTH,
    );
    // D8: hanging on a facade that is gone — zero scale.
    if (this.standing.isHidden(site.building, this.slot[i] as number)) {
      this.scale.set(0, 0, 0);
    }
    this.matrix.compose(this.pos, this.quat, this.scale);
    this.mesh.setMatrixAt(i, this.matrix);
    this.uploads.mark(i);
  };

  /** Repaint both canvases and flag their uploads (content changes only). */
  private paint(): void {
    this.dirty = false;
    this.paintScreen();
    this.paintTicker();
    this.screenTex.needsUpdate = true;
    this.tickerTex.needsUpdate = true;
  }

  private paintScreen(): void {
    const ctx = this.screenCanvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#070912";
    ctx.fillRect(0, 0, SCREEN_W, SCREEN_H);
    ctx.textBaseline = "middle";

    // Header: the city feed — or the storm banner, which outranks it.
    const banner = this.warning;
    ctx.fillStyle = banner ? "#e8a020" : "#141a33";
    ctx.fillRect(0, 0, SCREEN_W, 68);
    ctx.font = `bold 34px ${FONT}`;
    ctx.fillStyle = banner ? "#120c00" : "#ffffff";
    ctx.fillText(banner ? `⚠ ${banner.text}` : "CITY FEED", 28, 35);
    if (!banner) {
      ctx.fillStyle = "#ff3048";
      ctx.beginPath();
      ctx.arc(SCREEN_W - 120, 35, 10, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.fillText("LIVE", SCREEN_W - 100, 35);
    }

    // TOP PILOT.
    ctx.font = `bold 26px ${FONT}`;
    ctx.fillStyle = "#9fb4ff";
    ctx.fillText("TOP PILOT", 28, 112);
    const leader = this.leader;
    ctx.font = `bold 46px ${FONT}`;
    ctx.fillStyle = "#ffffff";
    ctx.fillText(leader ? leader.label : "—", 28, 166, 380);
    if (leader) {
      this.livery(ctx, leader.livery, 28, 204, 380, 26);
      ctx.font = `bold 30px ${FONT}`;
      ctx.fillStyle = "#d8e0ff";
      ctx.fillText(`${leader.kills} KILLS · ${leader.deaths} DOWN`, 28, 262);
    } else {
      ctx.font = `26px ${FONT}`;
      ctx.fillStyle = "#8c96b8";
      ctx.fillText("NO KILLS YET", 28, 214);
    }

    // Kill feed, newest first.
    ctx.fillStyle = "#1b2242";
    ctx.fillRect(28, 300, 380, 3);
    ctx.font = `bold 26px ${FONT}`;
    this.feed.forEach((line, i) => {
      ctx.fillStyle = i === 0 ? "#ffffff" : "#a8b2d8";
      ctx.fillText(line, 28, 336 + i * 44, 380);
    });

    // LAST KILL card: a static livery card underneath (all Mobile shows);
    // the shader lays the rendered shot over the same rectangle.
    ctx.fillStyle = "#0a1022";
    ctx.fillRect(CARD.x, CARD.y, CARD.w, CARD.h);
    const kill = this.lastKill;
    if (kill) {
      this.planeGlyph(ctx, kill.livery);
    } else {
      ctx.font = `bold 30px ${FONT}`;
      ctx.fillStyle = "#56608a";
      ctx.fillText("AWAITING FIRST KILL", CARD.x + 120, CARD.y + CARD.h / 2);
    }
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 4;
    ctx.strokeRect(CARD.x - 2, CARD.y - 2, CARD.w + 4, CARD.h + 4);
    ctx.fillStyle = "#ff3048";
    ctx.fillRect(CARD.x, CARD.y + CARD.h + 14, CARD.w, 46);
    ctx.font = `bold 28px ${FONT}`;
    ctx.fillStyle = "#ffffff";
    ctx.fillText(
      kill ? `${kill.caption} — ${kill.subjectLabel}` : "LAST KILL",
      CARD.x + 16,
      CARD.y + CARD.h + 38,
      CARD.w - 32,
    );
  }

  /** A livery swatch: primary bar with a secondary trim stripe. */
  private livery(
    ctx: CanvasRenderingContext2D,
    l: Livery,
    x: number,
    y: number,
    w: number,
    h: number,
  ): void {
    ctx.fillStyle = css(l.primary);
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = css(l.secondary);
    ctx.fillRect(x, y + h * 0.62, w, h * 0.38);
  }

  /** The static card: a top-down biplane in the subject's livery. */
  private planeGlyph(ctx: CanvasRenderingContext2D, l: Livery): void {
    const cx = CARD.x + CARD.w / 2;
    const cy = CARD.y + CARD.h / 2;
    ctx.fillStyle = css(l.primary);
    ctx.fillRect(cx - 190, cy - 34, 380, 48); // upper wing
    ctx.fillRect(cx - 22, cy - 110, 44, 230); // fuselage
    ctx.fillRect(cx - 80, cy + 92, 160, 26); // tailplane
    ctx.fillStyle = css(l.secondary);
    ctx.fillRect(cx - 30, cy - 126, 60, 22); // cowl
    ctx.fillRect(cx - 190, cy - 2, 380, 8); // trim
  }

  private paintTicker(): void {
    const ctx = this.tickerCanvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#050608";
    ctx.fillRect(0, 0, TICKER_W, TICKER_H);
    ctx.font = `bold 44px ${FONT}`;
    ctx.textBaseline = "middle";
    // Newest first; drop the oldest until one loop fits the canvas.
    let lines = this.headlines.length
      ? [...this.headlines]
      : ["CITY FEED — LIVE OVER DOWNTOWN"];
    let text = "";
    let width = 0;
    while (lines.length > 0) {
      text = lines.join(TICKER_SEPARATOR) + TICKER_SEPARATOR;
      width = ctx.measureText(text).width;
      if (width <= TICKER_W || lines.length === 1) break;
      lines = lines.slice(0, -1);
    }
    ctx.fillStyle = "#ffb020";
    ctx.fillText(text, 0, TICKER_H / 2 + 2, TICKER_W);
    this.uniforms.uTickerLoop.value = Math.min(TICKER_W, Math.ceil(width));
  }

  /** QA: what the screens say and what the replay pass has cost. */
  get stats(): {
    sites: number;
    headline: string | null;
    headlines: string[];
    feed: string[];
    leader: string | null;
    warning: string | null;
    replayPasses: number;
    replayDraws: number;
    replayOn: boolean;
  } {
    return {
      sites: this.sites.length,
      headline: this.headlines[0] ?? null,
      headlines: [...this.headlines],
      feed: [...this.feed],
      leader: this.leader?.label ?? null,
      warning: this.warning?.text ?? null,
      replayPasses: this.replayPasses,
      replayDraws: this.studio.lastDraws,
      replayOn: this.uniforms.uReplayOn.value > 0.5,
    };
  }

  /** QA: a canonical eye + look-at square on screen `i`. */
  view(i: number, distance = 110): { eye: Vec3; at: Vec3 } | null {
    const s = this.sites[i];
    if (!s) return null;
    const cy = s.y + s.height / 2 - 4;
    const n = s.dir * distance;
    const eye = canonicalize({
      x: s.axis === "x" ? s.x + n : s.x,
      y: cy,
      z: s.axis === "z" ? s.z + n : s.z,
    });
    return { eye, at: { x: s.x, y: cy, z: s.z } };
  }
}
