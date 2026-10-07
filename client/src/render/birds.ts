// Bird flocks (L2). Non-collidable by the ticket's design rule — a bird is
// small enough that passing through one is unremarkable, so it never has to
// be solid and never becomes an invisible wall.
//
// One Points object, NOT additive: birds are dark specks against the sky, the
// opposite of every other point cloud in the game. That is also why they get
// their own draw call rather than riding MoverLights — the material genuinely
// differs, and faking it with a black additive point would draw nothing.
//
// Every position is a pure function of (seed, server time): flocks wheel
// around seeded centers that drift on the shared clock, so all clients see
// the same birds without a byte on the wire and without per-frame state.
//
// L9: a flock scatters from a plane that passes within ~60 m, then resettles
// (bird-scatter.ts). That reaction is a per-client cosmetic layered on top of
// the shared wheel — see that file's header.

import { mulberry32 } from "@angels-bandits/common/city";
import { WORLD_SIZE } from "@angels-bandits/common/constants";
import { type Vec3, canonicalize } from "@angels-bandits/common/world";
import * as THREE from "three";
import { type Scatter, nextScatter, scatterOffset } from "./bird-scatter";
import { QUALITY_PROFILES, type QualityTier } from "./quality";
import { RENDER_ORDER } from "./render-order";
import { nearestImage } from "./wrapPlacement";

/** Flocks in the world, and birds per flock: 6 x 24 = 144 points. */
export const FLOCK_COUNT = 6;
export const BIRDS_PER_FLOCK = 24;

/** Flocks wheel low — above the streetwall, well under the canyon fight. */
const FLOCK_ALT_MIN = 95;
const FLOCK_ALT_MAX = 210;
/** Radius a flock wheels through, m, and how long one lap takes, s. */
const WHEEL_RADIUS = 34;
const WHEEL_PERIOD_S = 26;
/** How fast a flock's center drifts across the map, m/s. */
const DRIFT_SPEED = 7;

/** One flock's fixed parameters, drawn once from the world seed. */
export interface Flock {
  id: number;
  /** Center at t = 0, canonical. */
  x: number;
  z: number;
  y: number;
  /** Drift heading, unit. */
  dx: number;
  dz: number;
  /** Phase into the wheel, rad, and its direction. */
  phase: number;
  spin: 1 | -1;
}

/** Deterministic flock layout. Salted so it shares no stream with the movers. */
export function flocks(seed: number): Flock[] {
  const rand = mulberry32((seed ^ 0x3ac0ffee) >>> 0);
  const out: Flock[] = [];
  for (let i = 0; i < FLOCK_COUNT; i++) {
    const heading = rand() * Math.PI * 2;
    out.push({
      id: i,
      x: rand() * WORLD_SIZE,
      z: rand() * WORLD_SIZE,
      y: FLOCK_ALT_MIN + rand() * (FLOCK_ALT_MAX - FLOCK_ALT_MIN),
      dx: Math.cos(heading),
      dz: Math.sin(heading),
      phase: rand() * Math.PI * 2,
      spin: rand() < 0.5 ? 1 : -1,
    });
  }
  return out;
}

/** A flock's wheel centre at a server time, canonical. */
export function flockCenter(flock: Flock, serverTimeMs: number): Vec3 {
  const t = serverTimeMs / 1000;
  const p = canonicalize({
    x: flock.x + flock.dx * DRIFT_SPEED * t,
    y: 0,
    z: flock.z + flock.dz * DRIFT_SPEED * t,
  });
  return { x: p.x, y: flock.y, z: p.z };
}

/**
 * One bird's canonical position at a server time. The flock's center drifts
 * in a straight torus line while every bird wheels around it on its own
 * radius and phase — enough parallax to read as a flock, no state to keep.
 */
export function birdPosition(
  flock: Flock,
  index: number,
  serverTimeMs: number,
): Vec3 {
  const t = serverTimeMs / 1000;
  const spread = 0.35 + (0.65 * ((index * 7919) % 97)) / 97;
  const lift = (((index * 6151) % 53) / 53 - 0.5) * 14;
  const a =
    flock.phase +
    flock.spin * ((t / WHEEL_PERIOD_S) * Math.PI * 2 + index * 0.42);
  const r = WHEEL_RADIUS * spread;
  const p = canonicalize({
    x: flock.x + flock.dx * DRIFT_SPEED * t + Math.cos(a) * r,
    y: 0,
    z: flock.z + flock.dz * DRIFT_SPEED * t + Math.sin(a) * r,
  });
  // A gentle bob, so a flock is a cloud rather than a disc.
  return { x: p.x, y: flock.y + lift + Math.sin(a * 2) * 3, z: p.z };
}

// --- Renderer (consumes the pure model above; untested, like Streetlights) ---

/** Dark silhouette: birds read by occluding sky, not by glowing. */
const BIRD_COLOR = 0x14161c;

/** Soft dark speck. Not additive — see the header. */
function birdTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 32;
  const g = c.getContext("2d");
  if (!g) return new THREE.Texture();
  const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.55, "rgba(255,255,255,0.7)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 32, 32);
  return new THREE.CanvasTexture(c);
}

export class Birds {
  readonly points: THREE.Points;
  private readonly flocks: Flock[];
  private readonly positions: Float32Array;
  private readonly geometry = new THREE.BufferGeometry();
  /** Each flock's current scatter (L9), null while it wheels undisturbed. */
  private readonly scatters: (Scatter | null)[];
  private readonly offset: Vec3 = { x: 0, y: 0, z: 0 };
  /** O3 quality tier: birds drawn per flock. */
  private perFlock = BIRDS_PER_FLOCK;

  constructor(seed: number) {
    this.flocks = flocks(seed);
    this.scatters = this.flocks.map(() => null);
    this.positions = new Float32Array(FLOCK_COUNT * BIRDS_PER_FLOCK * 3);
    this.geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(this.positions, 3),
    );
    this.geometry.boundingSphere = new THREE.Sphere(
      new THREE.Vector3(),
      Number.POSITIVE_INFINITY,
    );
    this.points = new THREE.Points(
      this.geometry,
      new THREE.PointsMaterial({
        size: 1.4,
        sizeAttenuation: true,
        map: birdTexture(),
        color: BIRD_COLOR,
        transparent: true,
        opacity: 0.85,
        depthWrite: false,
      }),
    );
    this.points.frustumCulled = false;
    this.points.renderOrder = RENDER_ORDER.birds;
    this.points.visible = false;
  }

  /** QA hook (__ab.birds): every flock's centre and whether it is
   * scattered at `serverTimeMs`. */
  debug(serverTimeMs: number | null): { center: Vec3; scattered: boolean }[] {
    if (serverTimeMs === null) return [];
    return this.flocks.map((f, i) => ({
      center: flockCenter(f, serverTimeMs),
      scattered: this.scatters[i] != null,
    }));
  }

  /** Birds drawn — for the perf report. */
  get birdCount(): number {
    return this.flocks.length * BIRDS_PER_FLOCK;
  }

  /** Fly the flocks, scattering any a plane in `planes` (canonical
   * positions: own plane while alive + living remotes) passes close to. A
   * null clock hides them, like the rest of L2. */
  update(
    cameraPos: Vec3,
    serverTimeMs: number | null,
    planes: readonly Vec3[],
  ): void {
    if (serverTimeMs === null) {
      this.points.visible = false;
      return;
    }
    this.points.visible = true;
    let i = 0;
    for (let f = 0; f < this.flocks.length; f++) {
      const flock = this.flocks[f] as Flock;
      const scatter = nextScatter(
        flockCenter(flock, serverTimeMs),
        serverTimeMs,
        planes,
        this.scatters[f] ?? null,
      );
      this.scatters[f] = scatter;
      for (let b = 0; b < this.perFlock; b++) {
        const p = nearestImage(cameraPos, birdPosition(flock, b, serverTimeMs));
        const o = scatterOffset(
          flock.id,
          b,
          serverTimeMs,
          scatter,
          this.offset,
        );
        this.positions[i * 3] = p.x + o.x;
        this.positions[i * 3 + 1] = p.y + o.y;
        this.positions[i * 3 + 2] = p.z + o.z;
        i++;
      }
    }
    this.geometry.setDrawRange(0, i);
    const attr = this.geometry.getAttribute("position");
    if (attr) attr.needsUpdate = true;
  }

  /** O3: Low draws half of each flock (scatter logic is per flock, unchanged). */
  setQuality(tier: QualityTier): void {
    this.perFlock = Math.max(
      1,
      Math.round(BIRDS_PER_FLOCK * QUALITY_PROFILES[tier].birds),
    );
  }
}
