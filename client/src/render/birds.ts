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

import { mulberry32 } from "@angels-bandits/common/city";
import { WORLD_SIZE } from "@angels-bandits/common/constants";
import { type Vec3, canonicalize } from "@angels-bandits/common/world";
import * as THREE from "three";
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

  constructor(seed: number) {
    this.flocks = flocks(seed);
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
    this.points.visible = false;
  }

  /** Birds drawn — for the perf report. */
  get birdCount(): number {
    return this.flocks.length * BIRDS_PER_FLOCK;
  }

  /** Fly the flocks. A null clock hides them, like the rest of L2. */
  update(cameraPos: Vec3, serverTimeMs: number | null): void {
    if (serverTimeMs === null) {
      this.points.visible = false;
      return;
    }
    this.points.visible = true;
    let i = 0;
    for (const flock of this.flocks) {
      for (let b = 0; b < BIRDS_PER_FLOCK; b++) {
        const p = nearestImage(cameraPos, birdPosition(flock, b, serverTimeMs));
        this.positions[i * 3] = p.x;
        this.positions[i * 3 + 1] = p.y;
        this.positions[i * 3 + 2] = p.z;
        i++;
      }
    }
    const attr = this.geometry.getAttribute("position");
    if (attr) attr.needsUpdate = true;
  }
}
