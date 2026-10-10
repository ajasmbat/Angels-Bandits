// U7 gentle volumetric shafts: soft cones of light falling from the crown
// lamps (every SHAFT_STEP along each deep run, alternating sides) and the
// works' daylight grates. ONE additive draw for the whole network.
//
// Each shaft is two crossed fans, each fan three vertices wide — alpha 0
// at both edges, brightest down the middle under the lamp and thinning to
// the floor — so there is no hard card edge anywhere. The shader fades a
// fan as it turns edge-on to the eye, right in front of the camera (no
// sheet across the screen when flying through one) and well inside the
// fog distance (additive light must not fog to a colour — fog.ts). Each
// shaft adds at most SHAFT_PEAK luminance; shafts are light, and the
// surfaces under them are clamped (tunnel-look.ts's abUnderClamp) so two
// overlapping still sit under the 0.72 bloom threshold.
//
// Not solid, never collided (like the motes). Tiled 2×2 and snapped by
// whole periods like the shell. Hidden on MOBILE with the fixtures.

import {
  BORE_FLOOR_Y,
  TUNNELS,
  type Tunnel,
} from "@angels-bandits/common/city/tunnels";
import { WORLD_SIZE } from "@angels-bandits/common/constants";
import type { Vec3 } from "@angels-bandits/common/world";
import * as THREE from "three";
import { luminance } from "./emissive";
import { QUALITY_PROFILES, type QualityTier } from "./quality";
import { SHAFT_PEAK } from "./tunnel-look";
import { snapToPeriod } from "./tunnels";
import {
  DEEP_CEIL,
  type UndergroundLayout,
  boreXZ,
  deepRange,
  undergroundLayout,
} from "./underground-layout";

/** Program cache key. */
export const SHAFTS_CACHE_KEY = "ab-u7-shafts";
/** One shaft under the crown lamps every this many m, alternating sides. */
const SHAFT_STEP = 24;
/** The crown lamps' lateral offset (underground-layout's panels), m. */
const LAMP_LAT = 2.2;

const WARM = new THREE.Color(0xffd8a8);
const DAY = new THREE.Color(0xd8ecff);
/** Per fan: two fans overlap down a shaft's axis. */
const fanColor = (c: THREE.Color): THREE.Color =>
  c.clone().multiplyScalar(SHAFT_PEAK / 2 / luminance(c));

type P3 = [number, number, number];

/** The shafts' geometry: position, colour + alpha (RGBA). Exported for
 * QA. */
export function buildShaftGeometry(
  layout: UndergroundLayout = undergroundLayout(),
): THREE.BufferGeometry {
  const pos: number[] = [];
  const col: number[] = [];
  const pt = { x: 0, z: 0, th: 0 };
  const at = (t: Tunnel, s: number, lat: number, y: number): P3 => {
    boreXZ(t, s, lat, pt);
    return [pt.x, y, pt.z];
  };
  const push = (p: P3, c: THREE.Color, a: number) => {
    pos.push(p[0], p[1], p[2]);
    col.push(c.r, c.g, c.b, a);
  };
  /** A fan: top (half width w0) to bottom (w1), across `ax` (0 along s,
   * 1 across the bore), its middle column lit. */
  const shaft = (
    t: Tunnel,
    s: number,
    lat: number,
    w0: number,
    w1: number,
    c: THREE.Color,
  ) => {
    const yTop = DEEP_CEIL - 0.25;
    const yBot = BORE_FLOOR_Y + 0.4;
    for (const ax of [0, 1]) {
      const p = (u: number, y: number, w: number): P3 =>
        ax === 0 ? at(t, s + u * w, lat, y) : at(t, s, lat + u * w, y);
      const top = [p(-1, yTop, w0), p(0, yTop, w0), p(1, yTop, w0)];
      const bot = [p(-1, yBot, w1), p(0, yBot, w1), p(1, yBot, w1)];
      const aTop = [0, 1, 0];
      const aBot = [0, 0.18, 0];
      for (let i = 0; i < 2; i++) {
        const q = [top[i], top[i + 1], bot[i + 1], bot[i]] as P3[];
        const qa = [aTop[i], aTop[i + 1], aBot[i + 1], aBot[i]] as number[];
        for (const k of [0, 1, 2, 0, 2, 3]) {
          push(q[k] as P3, c, qa[k] as number);
        }
      }
    }
  };
  const warm = fanColor(WARM);
  const day = fanColor(DAY);
  for (const t of TUNNELS) {
    const [d0, d1] = deepRange(t);
    for (let k = Math.ceil(d0 / SHAFT_STEP); k * SHAFT_STEP <= d1; k++) {
      const s = k * SHAFT_STEP;
      shaft(t, s, k % 2 === 0 ? LAMP_LAT : -LAMP_LAT, 1.1, 3.4, warm);
    }
  }
  for (const g of layout.grates) shaft(g.t, g.s, g.lat, 1.6, 3.8, day);
  // One period by triangle centroid, tiled 2×2 (tunnels.ts's scheme).
  const n = pos.length / 3;
  const out = new Float32Array(n * 3 * 4);
  const outC = new Float32Array(n * 4 * 4);
  let o = 0;
  for (const ox of [0, WORLD_SIZE]) {
    for (const oz of [0, WORLD_SIZE]) {
      for (let tri = 0; tri < n; tri += 3) {
        const cx =
          ((pos[tri * 3] as number) +
            (pos[tri * 3 + 3] as number) +
            (pos[tri * 3 + 6] as number)) /
          3;
        const cz =
          ((pos[tri * 3 + 2] as number) +
            (pos[tri * 3 + 5] as number) +
            (pos[tri * 3 + 8] as number)) /
          3;
        const sx = Math.floor(cx / WORLD_SIZE) * WORLD_SIZE;
        const sz = Math.floor(cz / WORLD_SIZE) * WORLD_SIZE;
        for (let v = tri; v < tri + 3; v++) {
          out[o * 3] = (pos[v * 3] as number) - sx + ox;
          out[o * 3 + 1] = pos[v * 3 + 1] as number;
          out[o * 3 + 2] = (pos[v * 3 + 2] as number) - sz + oz;
          for (let j = 0; j < 4; j++) {
            outC[o * 4 + j] = col[v * 4 + j] as number;
          }
          o++;
        }
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(out, 3));
  g.setAttribute("color", new THREE.BufferAttribute(outC, 4));
  return g;
}

const SHAFT_VERTEX = /* glsl */ `
vShaftWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
`;
const SHAFT_FRAGMENT = /* glsl */ `
vec3 shaftN = normalize(cross(dFdx(vShaftWorld), dFdy(vShaftWorld)));
vec3 shaftV = cameraPosition - vShaftWorld;
float shaftD = length(shaftV);
float shaftFacing = abs(dot(shaftN, shaftV / max(shaftD, 1e-3)));
diffuseColor.a *= smoothstep(0.2, 0.55, shaftFacing) *
  smoothstep(4.0, 12.0, shaftD) * (1.0 - smoothstep(45.0, 80.0, shaftD));
`;

/** The shafts' one draw. */
export class TunnelShafts {
  readonly mesh: THREE.Mesh;

  constructor(layout?: UndergroundLayout) {
    const material = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      // Additive + fog brightens the distance: faded in the shader instead.
      fog: false,
    });
    material.customProgramCacheKey = () => SHAFTS_CACHE_KEY;
    material.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace(
          "#include <common>",
          "#include <common>\nvarying vec3 vShaftWorld;",
        )
        .replace(
          "#include <begin_vertex>",
          `#include <begin_vertex>\n${SHAFT_VERTEX}`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <common>",
          "#include <common>\nvarying vec3 vShaftWorld;",
        )
        .replace(
          "#include <color_fragment>",
          `#include <color_fragment>\n${SHAFT_FRAGMENT}`,
        );
    };
    this.mesh = new THREE.Mesh(buildShaftGeometry(layout), material);
    // Spans 2×2 periods: never culled as a whole; after the decor and the
    // veil (render order 2), never writing depth.
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
  }

  /** Snap by whole periods so the camera sits in the middle. */
  update(cameraPos: Vec3): void {
    snapToPeriod(this.mesh, cameraPos);
  }

  /** MOBILE drops the shafts with the fixtures. */
  setQuality(tier: QualityTier): void {
    this.mesh.visible = QUALITY_PROFILES[tier].tunnelFixtures;
  }
}
