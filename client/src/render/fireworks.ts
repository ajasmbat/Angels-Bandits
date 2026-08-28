// Fireworks (L2): particles only, no collision — by the ticket's design rule
// they never look solid, so they never need to be.
//
// The schedule is common/src/fireworks.ts, a pure function of (seed, window)
// in the strikesInWindow idiom, so every client sees the same burst at the
// same instant with nothing on the wire. BurstFeed polls [lastPoll, now) each
// frame exactly like StrikeFeed does — abutting windows partition the
// timeline, so a burst is never repeated or dropped.
//
// Sparks are drawn into the SHARED MoverLights point cloud rather than a
// Points object of their own. That merge is what holds the L2 spectacle to
// six draw calls, and it is honest: a spark and a nav light are the same
// material — an additive glow sprite with an HDR colour.
//
// Brightness discipline: sparks peak at EMISSIVE_BEACON (1.05), well under
// EMISSIVE_TRACER (1.5). Combat readability outranks scenery, so a burst can
// light up the sky without ever competing with the tracers a fight is read by.

import {
  EMISSIVE_BEACON,
  FIREWORK_BURSTS,
  FIREWORK_LIFETIME_MS,
  FIREWORK_SPARKS,
} from "@angels-bandits/common/constants";
import { type Burst, burstsInWindow } from "@angels-bandits/common/fireworks";
import type { Vec3 } from "@angels-bandits/common/world";
import * as THREE from "three";
import { emissiveBoost } from "./emissive";
import type { MoverLights } from "./movers";
import { nearestImage } from "./wrapPlacement";

/**
 * Polls the shared schedule for bursts that became due since the last call.
 * Pure bookkeeping — no THREE, no DOM — so it is the tested seam.
 *
 * The first call PRIMES rather than firing: a client that joins mid-show must
 * not replay every burst since the epoch. Same contract as StrikeFeed.
 */
export class BurstFeed {
  private lastT: number | null = null;

  constructor(private readonly seed: number) {}

  /** Bursts due in [lastPoll, now). Empty on the priming call, or with no clock. */
  poll(serverTimeMs: number | null): Burst[] {
    if (serverTimeMs === null) return [];
    if (this.lastT === null) {
      this.lastT = serverTimeMs;
      return [];
    }
    // A clock that stepped BACKWARDS (renderTime can, by up to 192 ms, when
    // the interp delay attacks a jitter spike) must not re-fire what it
    // already showed — just re-anchor.
    if (serverTimeMs < this.lastT) {
      this.lastT = serverTimeMs;
      return [];
    }
    const bursts = burstsInWindow(this.seed, this.lastT, serverTimeMs);
    this.lastT = serverTimeMs;
    return bursts;
  }
}

/**
 * One spark's offset from its burst center at `ageMs`, in meters.
 *
 * Analytic, never integrated — the fx.ts convention: a spark is a pure
 * function of (burst, index, age), so it costs no per-frame state and cannot
 * drift between clients. Directions come from a seeded Fibonacci-ish sphere
 * so a burst is an even shell rather than a clump.
 */
export function sparkOffset(
  burst: Burst,
  index: number,
  ageMs: number,
): { x: number; y: number; z: number } {
  // Golden-angle spiral on the sphere: even coverage with no PRNG per spark.
  const u = (index + 0.5) / FIREWORK_SPARKS;
  const phi = Math.acos(1 - 2 * u);
  const theta = index * 2.399963229728653 + burst.hue * Math.PI * 2;
  const speed = 26 + (index % 5) * 3;
  const t = ageMs / 1000;
  // Light drag, then gravity — a shell that opens fast and falls slowly.
  const r = speed * t * (1 - 0.34 * Math.min(t, 1.6));
  return {
    x: Math.sin(phi) * Math.cos(theta) * r,
    y: Math.cos(phi) * r - 4.2 * t * t,
    z: Math.sin(phi) * Math.sin(theta) * r,
  };
}

/** A spark's brightness at `ageMs`, 0..1: a hard flash, then a long fade. */
export function sparkFade(ageMs: number): number {
  const t = ageMs / FIREWORK_LIFETIME_MS;
  if (t < 0 || t >= 1) return 0;
  const flash = 1 - Math.min(1, t / 0.06);
  return Math.max(flash, (1 - t) * (1 - t));
}

// --- Renderer (writes into the shared point cloud; no mesh of its own) ---

/** Seeded palette. Hue drives the pick, so the whole show stays deterministic. */
const PALETTE = [
  new THREE.Color(1.0, 0.32, 0.22),
  new THREE.Color(0.3, 0.72, 1.0),
  new THREE.Color(1.0, 0.85, 0.3),
  new THREE.Color(0.62, 0.35, 1.0),
  new THREE.Color(0.35, 1.0, 0.6),
];
/** Pre-boosted to the rung so the peak of a burst IS EMISSIVE_BEACON. */
const PALETTE_HDR = PALETTE.map((c) =>
  c.clone().multiplyScalar(emissiveBoost(c, EMISSIVE_BEACON)),
);

const scratchColor = new THREE.Color();

/**
 * The firework show. Holds at most FIREWORK_BURSTS live bursts (oldest evicted
 * — the LRU-by-birth idiom the FX pools all use) and paints their sparks into
 * the shared additive cloud each frame.
 */
export class Fireworks {
  private readonly feed: BurstFeed;
  private readonly live: Burst[] = [];

  constructor(private readonly seed: number) {
    this.feed = new BurstFeed(seed);
  }

  /** Bursts currently alive — the perf report's handle on the spark budget. */
  get burstCount(): number {
    return this.live.length;
  }

  /**
   * Advance the show and draw it. `serverTimeMs` is main.ts's latched render
   * clock, the same one the movers use, so a burst is at the same instant in
   * every tab that samples the same time.
   */
  update(
    cameraPos: Vec3,
    serverTimeMs: number | null,
    lights: MoverLights,
  ): void {
    if (serverTimeMs === null) return;
    for (const burst of this.feed.poll(serverTimeMs)) {
      if (this.live.length >= FIREWORK_BURSTS) this.live.shift();
      this.live.push(burst);
    }
    // Retire finished bursts from the front: the list is time-ordered.
    while (
      this.live.length > 0 &&
      serverTimeMs - (this.live[0]?.timeMs ?? 0) > FIREWORK_LIFETIME_MS
    ) {
      this.live.shift();
    }

    for (const burst of this.live) {
      const age = serverTimeMs - burst.timeMs;
      const fade = sparkFade(age);
      if (fade <= 0) continue;
      const hdr =
        PALETTE_HDR[Math.floor(burst.hue * PALETTE_HDR.length)] ??
        PALETTE_HDR[0];
      if (!hdr) continue;
      scratchColor.copy(hdr).multiplyScalar(fade);
      const center = nearestImage(cameraPos, {
        x: burst.x,
        y: burst.y,
        z: burst.z,
      });
      for (let i = 0; i < FIREWORK_SPARKS; i++) {
        const o = sparkOffset(burst, i, age);
        lights.place(
          { x: center.x + o.x, y: center.y + o.y, z: center.z + o.z },
          scratchColor,
          1.6 + fade * 2.2,
        );
      }
    }
  }

  /**
   * QA read-back: the bursts that should be on screen at an explicit server
   * time, plus the next one scheduled.
   *
   * `live` is DERIVED from the time argument, not read off this.live. The
   * render buffer is tab-local: it only holds what this tab has polled at its
   * own render clock, and since ANGE-4KO2W2 two tabs sit at different
   * instants. Reporting the buffer made the two-tab seam check fail against a
   * pair of tabs that were both perfectly correct -- one had a burst at age
   * 1.6 s, the other the same burst at age 7.3 s, retired. Deriving from
   * `serverTimeMs` asks the question the seam check means to ask: at THIS
   * instant, what is the show? Two tabs given the same `at` now agree exactly.
   */
  debug(serverTimeMs: number | null): {
    time: number;
    live: { timeMs: number; x: number; y: number; z: number; hue: number }[];
    next: Burst | null;
  } | null {
    if (serverTimeMs === null) return null;
    return {
      time: serverTimeMs,
      live: burstsInWindow(
        this.seed,
        serverTimeMs - FIREWORK_LIFETIME_MS,
        serverTimeMs,
      ),
      next:
        burstsInWindow(this.seed, serverTimeMs, serverTimeMs + 40_000)[0] ??
        null,
    };
  }
}
