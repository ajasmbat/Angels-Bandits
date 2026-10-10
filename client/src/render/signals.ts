// L1 traffic signals: vehicle heads and crosswalk signals cycling on the S1
// furniture line. Client-only, non-collidable, altitude-gated. The aspect is a
// pure function of (block, server time, seed), so two tabs turn green on the
// same beat.
//
// Cars OBEY these signals (L6). The aspect below is the one pure source:
// traffic.ts reads the same go window through goWindowStart(), so the lens a
// player sees and the stop line a car honours can never disagree. Traffic
// stays a pure function of time because every lane's leader trajectory is
// built over whole signal cycles — see traffic.ts.
//
// NOBODY CROSSES THE ROAD — pedestrians stay on the sidewalk ring by
// decision. A painted crosswalk plus a permanent WALK signal and an empty
// crossing is a stronger "this is fake" cue than no crosswalk signal at all,
// so WALK is lit for only ~14 % of the cycle, as in a real city. That is what
// explains the empty crossing.

import {
  type SignalMast,
  allSignalMasts,
  signalMastsForBlock,
} from "@angels-bandits/common/city/street";
import { BLOCK_PITCH, EMISSIVE_LAMP } from "@angels-bandits/common/constants";
import { type Vec3, canonicalize } from "@angels-bandits/common/world";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { emissiveBoost } from "./emissive";
import { QUALITY_PROFILES, type QualityTier } from "./quality";
import { type CityReactions, alarmBlinkOn, alarmed } from "./reactions";
import {
  BLOCK_WINDOW_RADIUS,
  type BlockIndex,
  TAG_SIGNAL,
  blockStream,
  blockWindowInto,
  pruneBlockCache,
} from "./streetlife";
import { nearestImageInto, uploadPrefix } from "./wrapPlacement";

/** Green phase, seconds. */
export const GREEN = 18;
/** Amber phase, seconds. */
export const AMBER = 3;
/** All-red clearance between the two axes, seconds. */
const ALL_RED = 1;
/** One axis's half of the cycle, seconds. */
const HALF_CYCLE = GREEN + AMBER + ALL_RED;
/** The full two-axis cycle, seconds. */
export const SIGNAL_CYCLE = 2 * HALF_CYCLE;
/** An axis's go window (green then amber), seconds — red for the rest. */
export const GO_WINDOW = GREEN + AMBER;
/** Seconds of steady WALK at the head of the parallel green. */
const WALK_ON = 6;
/** Seconds of flashing DON'T-WALK after it. */
const WALK_FLASH = 8;
/** Flashes per second during the flashing phase. */
const FLASH_HZ = 2;

/** A vehicle signal aspect. */
export type Aspect = "red" | "amber" | "green";
/** A crosswalk aspect. */
export type Walk = "walk" | "flash" | "dont";

/** Everything one intersection is showing at an instant. */
export interface SignalAspects {
  /** Traffic travelling along z (the north–south street). */
  ns: Aspect;
  /** Traffic travelling along x (the east–west street). */
  ew: Aspect;
  /** Crossing the east–west street, i.e. walking along z. */
  walkNs: Walk;
  /** Crossing the north–south street, i.e. walking along x. */
  walkEw: Walk;
}

/** The per-intersection cycle offset, seconds — so a city is not one metronome. */
export function signalOffset(bx: number, bz: number, seed: number): number {
  return blockStream(seed, bx, bz, TAG_SIGNAL)() * SIGNAL_CYCLE;
}

const aspectAt = (q: number): Aspect => {
  if (q < 0 || q >= HALF_CYCLE) return "red";
  if (q < GREEN) return "green";
  if (q < GREEN + AMBER) return "amber";
  return "red";
};

const walkAt = (q: number): Walk => {
  if (q < 0 || q >= HALF_CYCLE) return "dont";
  if (q < WALK_ON) return "walk";
  if (q < WALK_ON + WALK_FLASH) {
    return Math.floor(q * FLASH_HZ) % 2 === 0 ? "flash" : "dont";
  }
  return "dont";
};

/**
 * What intersection (bx, bz) is showing at server time `timeSeconds`.
 *
 * The two axes are never simultaneously non-red: `ns` owns [0, HALF_CYCLE)
 * of the cycle and `ew` owns [HALF_CYCLE, CYCLE), and the ALL_RED tail of
 * each half is red on both. That invariant is asserted over a full cycle in
 * the tests — it is the one property a signal system cannot get wrong.
 */
export function signalPhase(
  bx: number,
  bz: number,
  timeSeconds: number,
  seed: number,
): SignalAspects {
  let p = (timeSeconds + signalOffset(bx, bz, seed)) % SIGNAL_CYCLE;
  if (p < 0) p += SIGNAL_CYCLE;
  const qNs = p;
  const qEw = p - HALF_CYCLE;
  return {
    ns: aspectAt(qNs),
    ew: aspectAt(qEw),
    // Crossing the EW street is safe while EW traffic is stopped, i.e. during
    // the NS green — so walkNs rides the NS half of the cycle.
    walkNs: walkAt(qNs),
    walkEw: walkAt(qEw),
  };
}

/**
 * When `axis` traffic's go window (green, then amber) opens at intersection
 * (bx, bz), as seconds in [0, SIGNAL_CYCLE) of server time mod the cycle.
 * It lasts GO_WINDOW; the rest of the cycle is red for that axis. The same
 * arithmetic as signalPhase — the traffic tests check the two agree by
 * reading signalPhase directly.
 */
export function goWindowStart(
  bx: number,
  bz: number,
  axis: "ns" | "ew",
  seed: number,
): number {
  const base = axis === "ns" ? 0 : HALF_CYCLE;
  let s = (base - signalOffset(bx, bz, seed)) % SIGNAL_CYCLE;
  if (s < 0) s += SIGNAL_CYCLE;
  return s;
}

// D9: the mast layout moved to the street contract (common/src/city/street.ts)
// — masts can be snapped, so the server places them exactly as every client.
export { type SignalMast, allSignalMasts, signalMastsForBlock };

// --- Renderer -------------------------------------------------------------

const MAST_HEIGHT = 5.4;
const XWALK_MAST_HEIGHT = 3.6;
/** Signals are street furniture, so they sit on the lamp rung of the ladder —
 * never above EMISSIVE_TRACER, and never at a new rung of their own. */
const ASPECT_HEX: Record<Aspect, number> = {
  red: 0xff2418,
  amber: 0xffa016,
  green: 0x30ff70,
};
const WALK_HEX: Record<Walk, number> = {
  walk: 0xdff2ff,
  flash: 0xff5a20,
  dont: 0x05060a,
};

/**
 * A lit lens, pre-boosted ONCE onto the lamp rung — the same class of street
 * furniture as a lamp head, never a rung of its own and never above
 * EMISSIVE_TRACER. Pre-boosted rather than boosted per frame because
 * emissiveBoost divides by luminance: applied to the near-black DON'T-WALK
 * lens it would multiply it into the brightest thing on the street.
 */
const litLens = (hex: number): THREE.Color => {
  const c = new THREE.Color(hex);
  return c.multiplyScalar(emissiveBoost(c, EMISSIVE_LAMP));
};

const ASPECT_COLORS: Record<Aspect, THREE.Color> = {
  red: litLens(ASPECT_HEX.red),
  amber: litLens(ASPECT_HEX.amber),
  green: litLens(ASPECT_HEX.green),
};
const WALK_COLORS: Record<Walk, THREE.Color> = {
  walk: litLens(WALK_HEX.walk),
  flash: litLens(WALK_HEX.flash),
  // The OFF lens is left dark on purpose: it is unlit, not a dim rung.
  dont: new THREE.Color(WALK_HEX.dont),
};

const VERTEX_PARS = /* glsl */ `
attribute float aLens;
varying float vLens;
`;

const VERTEX_MAIN = /* glsl */ `
vLens = aLens;
`;

const FRAGMENT_PARS = /* glsl */ `
varying float vLens;
`;

/**
 * The per-instance aspect colour lights the LENS only — the mast and housing
 * stay dark. USE_COLOR is emitted by WebGLProgram as soon as
 * `instancingColor` is set, so setColorAt alone is enough and
 * `material.vertexColors` is NOT required; the patch is #ifdef-guarded all the
 * same, because USE_COLOR only appears once instanceColor !== null and an
 * unguarded patch would be a compile error on the first compile.
 */
const FRAGMENT_MAIN = /* glsl */ `
#ifdef USE_COLOR
  diffuseColor.rgb = mix(diffuseColor.rgb, vColor, vLens * 0.8);
  totalEmissiveRadiance += vColor * vLens;
#endif
`;

/** Mast + housing + lens, merged into ONE geometry (useGroups defaults false:
 * true would yield groups → a material array → two draw calls). */
function mastGeometry(
  poleHeight: number,
  housing: { w: number; h: number; d: number },
  lens: { w: number; h: number },
): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const lensFlags: number[] = [];
  const pole = new THREE.BoxGeometry(0.2, poleHeight, 0.2);
  pole.translate(0, poleHeight / 2, 0);
  parts.push(pole);
  const headY = poleHeight + housing.h / 2 - 0.1;
  const box = new THREE.BoxGeometry(housing.w, housing.h, housing.d);
  box.translate(0, headY, 0);
  parts.push(box);
  const face = new THREE.BoxGeometry(lens.w, lens.h, 0.1);
  face.translate(0, headY, housing.d / 2 + 0.02);
  parts.push(face);
  for (let i = 0; i < parts.length; i++) {
    const n = (parts[i] as THREE.BufferGeometry).getAttribute("position").count;
    for (let v = 0; v < n; v++) lensFlags.push(i === 2 ? 1 : 0);
  }
  const merged = mergeGeometries(parts) ?? new THREE.BufferGeometry();
  for (const part of parts) part.dispose();
  merged.setAttribute(
    "aLens",
    new THREE.BufferAttribute(new Float32Array(lensFlags), 1),
  );
  return merged;
}

function createSignalMaterial(key: string): THREE.MeshLambertMaterial {
  const material = new THREE.MeshLambertMaterial({ color: 0x1c1e22 });
  // Textually distinct patches still collide without a distinct key (V3).
  material.customProgramCacheKey = () => key;
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${VERTEX_PARS}`)
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>\n${VERTEX_MAIN}`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${FRAGMENT_PARS}`)
      .replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>\n${FRAGMENT_MAIN}`,
      );
  };
  return material;
}

/** Both mast kinds share ONE InstancedMesh — one draw call for the class. */
export class Signals {
  readonly mesh: THREE.InstancedMesh;
  private readonly seed: number;
  private readonly byBlock = new Map<number, SignalMast[]>();
  private readonly matrix = new THREE.Matrix4();
  private readonly quat = new THREE.Quaternion();
  private readonly vec = new THREE.Vector3();
  /** Per-mast scratch: nearestImageInto writes here, never allocates (O3). */
  private readonly anchor: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly image: Vec3 = { x: 0, y: 0, z: 0 };
  private static readonly UP = new THREE.Vector3(0, 1, 0);
  /** Vehicle masts are taller; scale Y so one geometry serves both kinds. */
  private readonly scale = new THREE.Vector3(1, 1, 1);
  private drawn = 0;
  /** The radius the buffer is sized for, and (M3) the tier's radius within it. */
  private readonly maxRadius: number;
  private radius: number;

  constructor(seed: number, windowRadius = BLOCK_WINDOW_RADIUS) {
    this.seed = seed;
    this.maxRadius = windowRadius;
    this.radius = windowRadius;
    const perBlock = signalMastsForBlock(0, 0).length;
    const capacity = (2 * windowRadius + 1) ** 2 * perBlock;
    this.mesh = new THREE.InstancedMesh(
      mastGeometry(
        MAST_HEIGHT,
        { w: 0.52, h: 1.25, d: 0.4 },
        { w: 0.34, h: 0.34 },
      ),
      createSignalMaterial("ab-signal-head"),
      capacity,
    );
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.visible = false;
    // Force instanceColor allocation (three only defines instancingColor once
    // instanceColor !== null). Real aspect colours are written every frame —
    // an aspect is time-varying by definition.
    for (let i = 0; i < capacity; i++) {
      this.mesh.setColorAt(i, ASPECT_COLORS.red);
    }
    if (this.mesh.instanceColor) {
      this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
      this.mesh.instanceColor.needsUpdate = true;
    }
  }

  private mastsFor(bx: number, bz: number): SignalMast[] {
    const key = bx * 1000 + bz;
    let masts = this.byBlock.get(key);
    if (!masts) {
      masts = signalMastsForBlock(bx, bz);
      this.byBlock.set(key, masts);
    }
    return masts;
  }

  /** O5: the block window, reused every frame (blockWindowInto). */
  private readonly windowScratch: BlockIndex[] = [];

  /** Phase-only, so a missing clock falls back to local time. `reactions`
   * (L1): vehicle heads inside an alarm radius flash amber instead. */
  update(
    cameraPos: Vec3,
    timeMs: number,
    gate: number,
    reactions?: CityReactions,
  ): void {
    if (gate <= 0) {
      this.mesh.visible = false;
      this.mesh.count = 0;
      this.drawn = 0;
      return;
    }
    this.mesh.visible = true;
    const t = timeMs / 1000;
    const alarms =
      reactions !== undefined && reactions.wakeCount > 0 ? reactions : null;
    const blinkLens = alarmBlinkOn(timeMs)
      ? ASPECT_COLORS.amber
      : WALK_COLORS.dont;
    let n = 0;
    // P3: keep the cache to last frame's window (about to be refilled).
    pruneBlockCache(this.byBlock, this.windowScratch);
    for (const { bx, bz } of blockWindowInto(
      cameraPos,
      this.radius,
      this.windowScratch,
    )) {
      const aspects = signalPhase(bx, bz, t, this.seed);
      const masts = this.mastsFor(bx, bz);
      for (const mast of masts) {
        this.anchor.x = mast.x;
        this.anchor.z = mast.z;
        const p = nearestImageInto(this.image, cameraPos, this.anchor);
        this.quat.setFromAxisAngle(Signals.UP, mast.yaw);
        this.vec.set(p.x, 0, p.z);
        const shrink =
          mast.kind === "crosswalk" ? XWALK_MAST_HEIGHT / MAST_HEIGHT : 1;
        this.scale.set(1, shrink, 1);
        this.matrix.compose(this.vec, this.quat, this.scale);
        this.mesh.setMatrixAt(n, this.matrix);
        const lens =
          mast.kind === "vehicle"
            ? alarms && alarmed(alarms, mast.x, mast.z)
              ? blinkLens
              : ASPECT_COLORS[mast.ns ? aspects.ns : aspects.ew]
            : WALK_COLORS[mast.ns ? aspects.walkNs : aspects.walkEw];
        this.mesh.setColorAt(n, lens);
        n++;
      }
    }
    this.drawn = n;
    this.mesh.count = n;
    uploadPrefix([this.mesh.instanceMatrix, this.mesh.instanceColor], n);
  }

  /** Instances drawn last frame. */
  /** M3 quality tier: stream masts in a tighter block window (count only). */
  setQuality(tier: QualityTier): void {
    this.radius = Math.min(this.maxRadius, QUALITY_PROFILES[tier].microRadius);
  }

  get count(): number {
    return this.drawn;
  }

  /** QA: the aspects of ONE pinned intersection at a pinned server time. */
  sample(bx: number, bz: number, timeMs: number): SignalAspects {
    return signalPhase(bx, bz, timeMs / 1000, this.seed);
  }
}
