// Airliners (L10): nav-light clusters crossing far overhead, drawn ON the sky
// dome — the stars idiom. The Points object is a child of SkyDome's mesh, so
// it follows the camera, hides with the dome inside the cloud deck, and is
// never in world space: no torus, no collision, nothing to fly into.
//
// The schedule is common/src/skytraffic.ts, a pure function of (seed, synced
// clock), so every client sees the same airliner in the same direction at the
// same moment. Each flight is a straight track 1,000-1,600 m above the viewer;
// its lights are laid out in metres there and then pulled in onto the dome,
// so near the zenith the wing lights separate and at the horizon they merge,
// the way a real one does.
//
// One draw call: every airliner's lights and its faint contrail share one
// additive Points buffer, rewritten each frame (a few dozen points).

import {
  EMISSIVE_NAVLIGHT,
  EMISSIVE_STROBE,
  FOG_DISTANCE,
} from "@angels-bandits/common/constants";
import {
  AIRLINER_HALF_TRACK,
  type Airliner,
  airlinerOffsetInto,
  airlinersAt,
} from "@angels-bandits/common/skytraffic";
import * as THREE from "three";
import { emissiveBoost } from "./emissive";

/** Inside the dome (FOG_DISTANCE + 60) and in front of the stars (+40). */
const DOME_RADIUS = FOG_DISTANCE + 20;
/** Most airliners ever up at once (slot 40 s, flights <= 86 s), plus slack. */
const MAX_AIRLINERS = 5;
/** Contrail samples behind each airliner and their spacing along track, m. */
const CONTRAIL_POINTS = 22;
const CONTRAIL_SPACING = 140;
/** Lights per airliner: two wingtips, tail, two wingtip strobes, beacon. */
const LIGHTS = 6;
const CAPACITY = MAX_AIRLINERS * (LIGHTS + CONTRAIL_POINTS);
/** Half wingspan and tail length, m. */
const HALF_SPAN = 32;
const TAIL = 30;
/** Strobe: a white double flash; beacon: a slow red blink. */
const STROBE_PERIOD_MS = 1300;
const STROBE_FLASH_MS = 70;
const BEACON_PERIOD_MS = 1000;

const boosted = (r: number, g: number, b: number, rung: number) => {
  const c = new THREE.Color(r, g, b);
  return c.multiplyScalar(emissiveBoost(c, rung));
};
const NAV_RED = boosted(1.0, 0.12, 0.1, EMISSIVE_NAVLIGHT);
const NAV_GREEN = boosted(0.15, 1.0, 0.3, EMISSIVE_NAVLIGHT);
const NAV_WHITE = boosted(1.0, 1.0, 1.0, EMISSIVE_NAVLIGHT);
const STROBE = boosted(1.0, 1.0, 1.0, EMISSIVE_STROBE);
/** Moonlit vapour: faint and cool, far under the bloom threshold. */
const CONTRAIL = new THREE.Color(0.11, 0.12, 0.16);

/** Pixel sizes (no attenuation — these are as far away as the stars). */
const NAV_PX = 3.2;
const STROBE_PX = 5;
const CONTRAIL_PX = 7;

function glowTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 32;
  const g = c.getContext("2d");
  if (!g) return new THREE.Texture();
  const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.35, "rgba(255,255,255,0.6)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 32, 32);
  return new THREE.CanvasTexture(c);
}

export class Airliners {
  readonly points: THREE.Points;
  private readonly positions = new Float32Array(CAPACITY * 3);
  private readonly colors = new Float32Array(CAPACITY * 3);
  private readonly sizes = new Float32Array(CAPACITY);
  private readonly geometry = new THREE.BufferGeometry();
  private readonly off = { x: 0, y: 0, z: 0, hx: 0, hz: 0 };
  private count = 0;
  /** Airliners drawn last frame — QA read-back. */
  drawn: Airliner[] = [];

  constructor(private readonly seed: number) {
    this.geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(this.positions, 3),
    );
    this.geometry.setAttribute(
      "color",
      new THREE.BufferAttribute(this.colors, 3),
    );
    this.geometry.setAttribute(
      "aSize",
      new THREE.BufferAttribute(this.sizes, 1),
    );
    const material = new THREE.PointsMaterial({
      size: 1,
      sizeAttenuation: false,
      map: glowTexture(),
      vertexColors: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    });
    material.customProgramCacheKey = () => "ab-airliners";
    material.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace(
          "uniform float size;",
          "uniform float size;\nattribute float aSize;",
        )
        .replace("gl_PointSize = size;", "gl_PointSize = size * aSize;");
    };
    this.points = new THREE.Points(this.geometry, material);
    this.points.frustumCulled = false;
    // Drawn with the dome's backdrop pass, before the city.
    this.points.renderOrder = -1;
  }

  private put(
    x: number,
    y: number,
    z: number,
    scale: number,
    color: THREE.Color,
    k: number,
    px: number,
  ): void {
    if (this.count >= CAPACITY) return;
    const i = this.count++;
    this.positions[i * 3] = x * scale;
    this.positions[i * 3 + 1] = y * scale;
    this.positions[i * 3 + 2] = z * scale;
    this.colors[i * 3] = color.r * k;
    this.colors[i * 3 + 1] = color.g * k;
    this.colors[i * 3 + 2] = color.b * k;
    this.sizes[i] = px;
  }

  /** Lay out every airliner up at `serverTimeMs`. Null clock: none. */
  update(serverTimeMs: number | null): void {
    this.count = 0;
    this.drawn =
      serverTimeMs === null
        ? []
        : airlinersAt(this.seed, serverTimeMs).slice(0, MAX_AIRLINERS);
    for (const a of this.drawn) {
      const t = serverTimeMs ?? 0;
      const o = airlinerOffsetInto(a, t, this.off);
      const dist = Math.hypot(o.x, o.y, o.z);
      // One scale for the whole cluster keeps its shape; the dome pulls it in.
      const scale = DOME_RADIUS / dist;
      // Haze near the horizon, like the stars.
      const k = Math.min(1, Math.max(0, (o.y / dist - 0.04) / 0.12));
      if (k <= 0) continue;
      // Right-hand side of the heading (hx, hz) in XZ is (-hz, hx).
      const rx = -o.hz;
      const rz = o.hx;
      this.put(
        o.x - rx * HALF_SPAN,
        o.y,
        o.z - rz * HALF_SPAN,
        scale,
        NAV_RED,
        k,
        NAV_PX,
      );
      this.put(
        o.x + rx * HALF_SPAN,
        o.y,
        o.z + rz * HALF_SPAN,
        scale,
        NAV_GREEN,
        k,
        NAV_PX,
      );
      this.put(
        o.x - o.hx * TAIL,
        o.y,
        o.z - o.hz * TAIL,
        scale,
        NAV_WHITE,
        k,
        NAV_PX * 0.8,
      );
      const st = (t + a.strobe * STROBE_PERIOD_MS) % STROBE_PERIOD_MS;
      if (
        st < STROBE_FLASH_MS ||
        (st > 2 * STROBE_FLASH_MS && st < 3 * STROBE_FLASH_MS)
      ) {
        for (const side of [-1, 1]) {
          this.put(
            o.x + side * rx * HALF_SPAN,
            o.y,
            o.z + side * rz * HALF_SPAN,
            scale,
            STROBE,
            k,
            STROBE_PX,
          );
        }
      }
      if ((t + a.strobe * 7919) % BEACON_PERIOD_MS < 160) {
        this.put(o.x, o.y + 3, o.z, scale, NAV_RED, k, NAV_PX * 1.2);
      }
      // Contrail: vapour along the track already flown, thinning with age.
      const flown = (a.speed * (t - a.startMs)) / 1000;
      for (let c = 1; c <= CONTRAIL_POINTS; c++) {
        const back = c * CONTRAIL_SPACING + TAIL;
        if (back > flown || back > 2 * AIRLINER_HALF_TRACK) break;
        const fade = (1 - c / (CONTRAIL_POINTS + 1)) * k;
        const cx = o.x - o.hx * back;
        const cz = o.z - o.hz * back;
        // Each sample onto the dome along its OWN direction (it is a
        // different distance away than the aircraft).
        this.put(
          cx,
          o.y,
          cz,
          DOME_RADIUS / Math.hypot(cx, o.y, cz),
          CONTRAIL,
          fade,
          CONTRAIL_PX * (0.7 + (0.6 * c) / CONTRAIL_POINTS),
        );
      }
    }
    this.geometry.setDrawRange(0, this.count);
    for (const name of ["position", "color", "aSize"]) {
      const attr = this.geometry.getAttribute(name);
      if (attr) attr.needsUpdate = true;
    }
  }

  /** Points written last frame — the perf report's handle. */
  get pointCount(): number {
    return this.count;
  }
}
