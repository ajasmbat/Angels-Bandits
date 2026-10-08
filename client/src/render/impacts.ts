// D1 bullet impacts — the particle half. Every bullet that strikes the city
// throws sparks, a puff of dust and falling chips tinted by the facade
// archetype (glass / masonry / office); a round through a pane adds a burst
// of glinting glass shards; a plane death near a facade (a SERVER `death`
// city event — common/src/cityevents.ts) showers glass and leaves a burning,
// smoking patch for SMOKE_LIFE_MS on the synced server clock.
//
// All of it is ONE THREE.Points (1 draw call): per-point colour + alpha and
// size, analytic ballistic motion from a canonical origin, placed every frame
// at the torus image nearest the viewer (the renderer's one placement rule).
// The pool is a fixed ring capped by the quality tier (QUALITY_PROFILES
// .impacts): when full, the oldest particle is overwritten — the live count
// can never pass the cap, and nothing is allocated per frame.
//
// Purely cosmetic: nothing here collides (D2 owns structural damage).

import { mulberry32 } from "@angels-bandits/common/city";
import type { Building } from "@angels-bandits/common/city";
import type { CityEvent } from "@angels-bandits/common/cityevents";
import { SMOKE_LIFE_MS } from "@angels-bandits/common/cityevents";
import type { CityIndex } from "@angels-bandits/common/collision";
import { type Vec3, wrapDeltaAxis } from "@angels-bandits/common/world";
import * as THREE from "three";
import type { BulletImpact } from "../game/bullet-impact";
import { FacadeArchetype } from "./archetypes";
import { type BlastSite, type FacadeDamage, blastFacades } from "./damage-map";
import { RENDER_ORDER } from "./render-order";
import { uploadPrefix } from "./wrapPlacement";

/** The full particle budget (High); a tier keeps `share` of it. */
export const IMPACT_PARTICLES_MAX = 1200;
/** Burning patches alive at once, at full share. */
export const BURNS_MAX = 6;

export const particleCapFor = (share: number): number =>
  Math.max(
    1,
    Math.min(IMPACT_PARTICLES_MAX, Math.round(IMPACT_PARTICLES_MAX * share)),
  );
export const burnCapFor = (share: number): number =>
  Math.max(1, Math.min(BURNS_MAX, Math.round(2 + 4 * share)));

/** Particle kinds — each its own gravity, drag-free arc and look. */
export const Kind = {
  SPARK: 0,
  DUST: 1,
  CHIP: 2,
  GLASS: 3,
  FIRE: 4,
  SMOKE: 5,
} as const;
export type Kind = (typeof Kind)[keyof typeof Kind];

/** m/s² down (negative = buoyant rise). */
const GRAVITY: Record<Kind, number> = {
  [Kind.SPARK]: 30,
  [Kind.DUST]: -0.6,
  [Kind.CHIP]: 16,
  [Kind.GLASS]: 12,
  [Kind.FIRE]: -5,
  [Kind.SMOKE]: -2.6,
};

/** Per bullet impact, at full share (each × share, at least 1). */
export const PER_HIT = { sparks: 8, dust: 3, chips: 4, glass: 10 } as const;
/** A blast's glass shower, at full share. */
export const BLAST_GLASS = 48;
/** A burning patch's emission, particles/s at full share. */
const BURN_FIRE_RATE = 16;
const BURN_SMOKE_RATE = 5;
/** The last stretch of a burn tapers its flames to nothing, ms. */
const BURN_TAPER_MS = 15_000;

/** Colours (linear). Everything sits under the tracer rung of the emissive
 * ladder (EMISSIVE_TRACER 1.5): sparks ≈ 0.8, fire ≈ 0.7, a glass glint
 * peaks ≈ 0.85 — hot enough to bloom softly, never over a tracer. */
const SPARK_RGB = [1.0, 0.76, 0.42] as const;
const FIRE_RGB = [1.0, 0.52, 0.16] as const;
const GLASS_RGB = [0.72, 0.88, 1.0] as const;
const SMOKE_RGB = [0.2, 0.18, 0.21] as const;
/** Dust / chip tint per facade archetype: glass curtain-wall (pale grey
 * concrete core), masonry (brick), office (warm concrete). */
const DUST_RGB: Record<FacadeArchetype, readonly [number, number, number]> = {
  [FacadeArchetype.GLASS]: [0.42, 0.45, 0.48],
  [FacadeArchetype.MASONRY]: [0.5, 0.28, 0.2],
  [FacadeArchetype.OFFICE]: [0.46, 0.43, 0.38],
};

/**
 * The pure particle pool: a ring of `capacity` slots, `cap` of them in use
 * (the tier's budget). spawn() writes the next slot round the ring — the
 * oldest — so live ≤ cap always. Origins are canonical.
 */
export class ImpactPool {
  readonly capacity: number;
  private cap: number;
  private head = 0;
  readonly ox: Float32Array;
  readonly oy: Float32Array;
  readonly oz: Float32Array;
  readonly vx: Float32Array;
  readonly vy: Float32Array;
  readonly vz: Float32Array;
  readonly born: Float64Array;
  readonly life: Float32Array;
  readonly kind: Uint8Array;
  readonly size: Float32Array;
  /** Per-particle base colour and a phase for glints / flicker. */
  readonly rgb: Float32Array;
  readonly phase: Float32Array;

  constructor(capacity = IMPACT_PARTICLES_MAX) {
    this.capacity = capacity;
    this.cap = capacity;
    this.ox = new Float32Array(capacity);
    this.oy = new Float32Array(capacity);
    this.oz = new Float32Array(capacity);
    this.vx = new Float32Array(capacity);
    this.vy = new Float32Array(capacity);
    this.vz = new Float32Array(capacity);
    this.born = new Float64Array(capacity).fill(Number.NEGATIVE_INFINITY);
    this.life = new Float32Array(capacity);
    this.kind = new Uint8Array(capacity);
    this.size = new Float32Array(capacity);
    this.rgb = new Float32Array(capacity * 3);
    this.phase = new Float32Array(capacity);
  }

  get limit(): number {
    return this.cap;
  }

  /** The tier's budget. Shrinking kills the particles past it. */
  setCap(cap: number): void {
    this.cap = Math.max(1, Math.min(this.capacity, Math.floor(cap)));
    for (let i = this.cap; i < this.capacity; i++) {
      this.born[i] = Number.NEGATIVE_INFINITY;
    }
    if (this.head >= this.cap) this.head = 0;
  }

  spawn(
    kind: Kind,
    origin: Vec3,
    vx: number,
    vy: number,
    vz: number,
    lifeMs: number,
    size: number,
    r: number,
    g: number,
    b: number,
    now: number,
    phase = 0,
  ): void {
    const i = this.head;
    this.head = (this.head + 1) % this.cap;
    this.ox[i] = origin.x;
    this.oy[i] = origin.y;
    this.oz[i] = origin.z;
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.vz[i] = vz;
    this.born[i] = now;
    this.life[i] = lifeMs;
    this.kind[i] = kind;
    this.size[i] = size;
    this.rgb[i * 3] = r;
    this.rgb[i * 3 + 1] = g;
    this.rgb[i * 3 + 2] = b;
    this.phase[i] = phase;
  }

  isLive(i: number, now: number): boolean {
    const age = now - (this.born[i] as number);
    return age >= 0 && age < (this.life[i] as number);
  }

  /** Live particles at `now`. */
  live(now: number): number {
    let n = 0;
    for (let i = 0; i < this.cap; i++) if (this.isLive(i, now)) n++;
    return n;
  }
}

/** One burning patch: a blast's nearest facade point, aged on the server
 * clock from its city event's `t`. */
export interface Burn {
  site: BlastSite;
  /** Server time of the death event, ms — and its sort key. */
  t: number;
  /** The event's position (the tie-break of the cap's drop order). */
  x: number;
  z: number;
  /** Fractional emission carried between frames. */
  fireAcc: number;
  smokeAcc: number;
}

/** Event order, the same on every client: time, then x, then z. */
const burnOrder = (a: Burn, b: Burn): number =>
  a.t - b.t || a.x - b.x || a.z - b.z;

/**
 * Death events → blasts, exactly once each. A reconnect's welcome replays
 * the same events, and the ledger ignores any it has already applied, so
 * ingesting a list twice changes nothing. Each blast is seeded from its
 * event (salted mulberry32 of position and server time), so every client —
 * late joiners included — blows out the same ring. Burns over the cap drop
 * the OLDEST by event order.
 */
export class BlastLedger {
  readonly burns: Burn[] = [];
  private readonly seen = new Set<string>();
  private burnCap = BURNS_MAX;

  constructor(
    private readonly damage: FacadeDamage,
    private readonly buildings: readonly Building[],
    private readonly index: CityIndex,
  ) {}

  get cap(): number {
    return this.burnCap;
  }

  setBurnCap(cap: number): void {
    this.burnCap = Math.max(1, Math.floor(cap));
    this.trim();
  }

  /** Apply every not-yet-seen `death` event. Returns the blasts applied. */
  ingest(events: readonly CityEvent[]): BlastSite[] {
    const fresh = events
      .filter((e) => e.kind === "death")
      .slice()
      .sort((a, b) => a.t - b.t || a.x - b.x || a.z - b.z);
    const out: BlastSite[] = [];
    for (const ev of fresh) {
      const key = `${ev.t}:${ev.x}:${ev.y}:${ev.z}`;
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      const site = blastFacades(
        this.damage,
        this.buildings,
        this.index,
        { x: ev.x, y: ev.y, z: ev.z },
        mulberry32(blastSeed(ev)),
      );
      if (!site) continue;
      out.push(site);
      this.burns.push({
        site,
        t: ev.t,
        x: ev.x,
        z: ev.z,
        fireAcc: 0,
        smokeAcc: 0,
      });
    }
    this.burns.sort(burnOrder);
    this.trim();
    return out;
  }

  /** Forget burns that have burnt out by server time `now`. */
  prune(now: number): void {
    let kept = 0;
    for (const b of this.burns) {
      if (now - b.t < SMOKE_LIFE_MS) this.burns[kept++] = b;
    }
    this.burns.length = kept;
  }

  private trim(): void {
    if (this.burns.length > this.burnCap) {
      this.burns.splice(0, this.burns.length - this.burnCap);
    }
  }
}

/** Salted seed for one blast: position (dm) and server time. */
export function blastSeed(ev: CityEvent): number {
  const xq = Math.round(ev.x * 10) | 0;
  const zq = Math.round(ev.z * 10) | 0;
  const tq = (ev.t % 2147483647) | 0;
  return (
    (Math.imul(xq, 73856093) ^
      Math.imul(zq, 19349663) ^
      Math.imul(tq, 83492791) ^
      0xd1b1a57) >>>
    0
  );
}

/** A unit-ish random direction in the hemisphere around `n`, × speed. */
function sprayInto(
  out: Vec3,
  n: Vec3,
  speed: number,
  spread: number,
  rand: () => number,
): Vec3 {
  const x = rand() * 2 - 1;
  const y = rand() * 2 - 1;
  const z = rand() * 2 - 1;
  out.x = (n.x + x * spread) * speed;
  out.y = (n.y + y * spread) * speed;
  out.z = (n.z + z * spread) * speed;
  return out;
}

/** THREE half: the one Points draw for every impact particle. */
export class Impacts {
  readonly points: THREE.Points;
  readonly pool = new ImpactPool();
  private readonly positions: THREE.BufferAttribute;
  private readonly colors: THREE.BufferAttribute;
  private readonly sizes: THREE.BufferAttribute;
  private share = 1;
  private lastLive = 0;
  private readonly v: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly at: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly rand = Math.random;

  constructor() {
    const n = this.pool.capacity;
    const geometry = new THREE.BufferGeometry();
    this.positions = new THREE.BufferAttribute(new Float32Array(n * 3), 3);
    this.colors = new THREE.BufferAttribute(new Float32Array(n * 4), 4);
    this.sizes = new THREE.BufferAttribute(new Float32Array(n), 1);
    for (const a of [this.positions, this.colors, this.sizes]) {
      a.setUsage(THREE.DynamicDrawUsage);
    }
    geometry.setAttribute("position", this.positions);
    geometry.setAttribute("color", this.colors);
    geometry.setAttribute("aSize", this.sizes);
    geometry.setDrawRange(0, 0);
    // Soft round sprite (a bare PointsMaterial renders hard squares).
    const canvas = document.createElement("canvas");
    canvas.width = 32;
    canvas.height = 32;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      const g = ctx.createRadialGradient(16, 16, 1, 16, 16, 16);
      g.addColorStop(0, "rgba(255,255,255,1)");
      g.addColorStop(0.45, "rgba(255,255,255,0.7)");
      g.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 32, 32);
    }
    const material = new THREE.PointsMaterial({
      size: 1, // per-point aSize carries the real size
      map: new THREE.CanvasTexture(canvas),
      vertexColors: true, // rgba: per-point colour AND alpha
      transparent: true,
      depthWrite: false,
    });
    material.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace(
          "#include <common>",
          "attribute float aSize;\n#include <common>",
        )
        .replace("gl_PointSize = size;", "gl_PointSize = size * aSize;");
    };
    // Distinct program key — onBeforeCompile patches collide without one (V3).
    material.customProgramCacheKey = () => "d1-impacts-asize";
    this.points = new THREE.Points(geometry, material);
    this.points.frustumCulled = false;
    this.points.renderOrder = RENDER_ORDER.smoke;
  }

  /** Quality: the tier's share of the full budget (counts only). */
  setShare(share: number): void {
    this.share = share;
    this.pool.setCap(particleCapFor(share));
  }

  private count(n: number): number {
    return Math.max(1, Math.round(n * this.share));
  }

  /** One round struck the city at `hit` (classified), moving along `dir`. */
  bullet(hit: BulletImpact, now: number): void {
    const p = this.pool;
    const n = hit.normal;
    const rand = this.rand;
    const [sr, sg, sb] = SPARK_RGB;
    for (let i = 0; i < this.count(PER_HIT.sparks); i++) {
      const v = sprayInto(this.v, n, 10 + 18 * rand(), 0.9, rand);
      p.spawn(
        Kind.SPARK,
        hit.point,
        v.x,
        v.y,
        v.z,
        220 + 200 * rand(),
        0.5,
        sr,
        sg,
        sb,
        now,
      );
    }
    const [dr, dg, db] = DUST_RGB[hit.arch];
    for (let i = 0; i < this.count(PER_HIT.dust); i++) {
      const v = sprayInto(this.v, n, 1.2 + 1.5 * rand(), 0.5, rand);
      p.spawn(
        Kind.DUST,
        hit.point,
        v.x,
        v.y,
        v.z,
        900 + 700 * rand(),
        2.2 + 1.6 * rand(),
        dr,
        dg,
        db,
        now,
      );
    }
    for (let i = 0; i < this.count(PER_HIT.chips); i++) {
      const v = sprayInto(this.v, n, 3 + 5 * rand(), 0.7, rand);
      p.spawn(
        Kind.CHIP,
        hit.point,
        v.x,
        v.y,
        v.z,
        900 + 600 * rand(),
        0.28,
        dr * 0.6,
        dg * 0.6,
        db * 0.6,
        now,
      );
    }
    if (hit.surface === "facade" && hit.pane) {
      const [gr, gg, gb] = GLASS_RGB;
      for (let i = 0; i < this.count(PER_HIT.glass); i++) {
        const v = sprayInto(this.v, n, 1.5 + 3 * rand(), 0.8, rand);
        p.spawn(
          Kind.GLASS,
          hit.point,
          v.x,
          v.y,
          v.z,
          1600 + 1400 * rand(),
          0.35,
          gr,
          gg,
          gb,
          now,
          rand() * 6.28,
        );
      }
    }
  }

  /** A blast's glass shower off its nearest facade (the burn starts with
   * the ledger; this is the instant burst). */
  blast(site: BlastSite, now: number): void {
    const [gr, gg, gb] = GLASS_RGB;
    const rand = this.rand;
    for (let i = 0; i < this.count(BLAST_GLASS); i++) {
      const v = sprayInto(this.v, site.normal, 3 + 7 * rand(), 1.1, rand);
      this.at.x = site.point.x;
      this.at.y = site.point.y + (rand() * 2 - 1) * 6;
      this.at.z = site.point.z;
      this.pool.spawn(
        Kind.GLASS,
        this.at,
        v.x,
        v.y,
        v.z,
        2200 + 1600 * rand(),
        0.45,
        gr,
        gg,
        gb,
        now,
        rand() * 6.28,
      );
    }
  }

  /** Feed every live burn's flames and smoke for this frame. `serverMs` is
   * the synced clock the burns age on (null before the first snapshot). */
  burn(
    burns: readonly Burn[],
    serverMs: number | null,
    dt: number,
    now: number,
  ): void {
    if (serverMs === null) return;
    const rand = this.rand;
    for (const b of burns) {
      const age = serverMs - b.t;
      if (age < 0 || age >= SMOKE_LIFE_MS) continue;
      const k = Math.min(1, (SMOKE_LIFE_MS - age) / BURN_TAPER_MS);
      b.fireAcc += BURN_FIRE_RATE * this.share * k * dt;
      b.smokeAcc += BURN_SMOKE_RATE * this.share * k * dt;
      const s = b.site;
      const [fr, fg, fb] = FIRE_RGB;
      while (b.fireAcc >= 1) {
        b.fireAcc -= 1;
        this.patchPoint(s, 3.2, rand);
        this.pool.spawn(
          Kind.FIRE,
          this.at,
          s.normal.x * 0.6 + (rand() - 0.5),
          1.5 + rand() * 2,
          s.normal.z * 0.6 + (rand() - 0.5),
          500 + 500 * rand(),
          1.4 + 1.6 * rand() * k,
          fr,
          fg * (0.8 + 0.4 * rand()),
          fb,
          now,
          rand() * 6.28,
        );
      }
      const [mr, mg, mb] = SMOKE_RGB;
      while (b.smokeAcc >= 1) {
        b.smokeAcc -= 1;
        this.patchPoint(s, 2.5, rand);
        this.pool.spawn(
          Kind.SMOKE,
          this.at,
          s.normal.x * 1.2,
          2 + rand(),
          s.normal.z * 1.2,
          2600 + 1200 * rand(),
          3 + 3 * rand(),
          mr,
          mg,
          mb,
          now,
        );
      }
    }
  }

  /** A random point on the burning patch, a hair off the wall. */
  private patchPoint(s: BlastSite, r: number, rand: () => number): void {
    const u = (rand() * 2 - 1) * r;
    const h = (rand() * 2 - 1) * r * 0.6;
    this.at.x = s.point.x + s.normal.x * 0.6 + (s.normal.x === 0 ? u : 0);
    this.at.y = s.point.y + h;
    this.at.z = s.point.z + s.normal.z * 0.6 + (s.normal.z === 0 ? u : 0);
  }

  /** Place every live particle around the viewer; pack the live prefix. */
  update(viewer: Vec3, now: number): void {
    const p = this.pool;
    let n = 0;
    for (let i = 0; i < p.limit; i++) {
      if (!p.isLive(i, now)) continue;
      const t = (now - (p.born[i] as number)) / 1000;
      const u = (t * 1000) / (p.life[i] as number); // 0..1 of its life
      const kind = p.kind[i] as Kind;
      const g = GRAVITY[kind];
      const x =
        viewer.x +
        wrapDeltaAxis(viewer.x, p.ox[i] as number) +
        (p.vx[i] as number) * t;
      const y = (p.oy[i] as number) + (p.vy[i] as number) * t - 0.5 * g * t * t;
      const z =
        viewer.z +
        wrapDeltaAxis(viewer.z, p.oz[i] as number) +
        (p.vz[i] as number) * t;
      let size = p.size[i] as number;
      let alpha = 1;
      let bright = 1;
      if (kind === Kind.SPARK) {
        alpha = 1 - u;
        size *= 1 - 0.5 * u;
      } else if (kind === Kind.DUST || kind === Kind.SMOKE) {
        size *= 1 + 1.8 * u;
        alpha =
          (kind === Kind.DUST ? 0.55 : 0.5) * (1 - u) * Math.min(1, u * 8);
      } else if (kind === Kind.CHIP) {
        alpha = 1 - u * u;
      } else if (kind === Kind.GLASS) {
        // Tumbling shards catch the light now and then: a glint, not a glow.
        const glint = Math.abs(Math.sin(t * 22 + (p.phase[i] as number)));
        bright = 0.25 + 0.75 * glint * glint * glint;
        alpha = 1 - u * u;
      } else {
        // FIRE: flickers, shrinks and cools as it rises.
        bright = 0.75 + 0.25 * Math.sin(t * 40 + (p.phase[i] as number));
        size *= 1 - 0.6 * u;
        alpha = 1 - u;
      }
      this.positions.setXYZ(n, x, y, z);
      this.colors.setXYZW(
        n,
        (p.rgb[i * 3] as number) * bright,
        (p.rgb[i * 3 + 1] as number) * bright,
        (p.rgb[i * 3 + 2] as number) * bright,
        alpha,
      );
      this.sizes.setX(n, size);
      n++;
    }
    this.lastLive = n;
    this.points.geometry.setDrawRange(0, n);
    uploadPrefix([this.positions, this.colors, this.sizes], n);
  }

  /** QA: live particles drawn last frame, and the tier's cap. */
  get liveCount(): number {
    return this.lastLive;
  }

  get cap(): number {
    return this.pool.limit;
  }
}
