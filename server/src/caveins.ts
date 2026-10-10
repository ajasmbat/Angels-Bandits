// U6 cave-ins, server side: WHEN and WHERE the ceiling of a deep bore comes
// down — one CaveInDirector per room. The shared, pure half (pieces, pose,
// collision, the lane, the lead rule) is common/src/city/caveins.ts; this
// file only decides and broadcasts one small event per cave-in.
//
// The rules:
//  - only while the room's city is live (index.ts's `quiet` gate: a human
//    is in it, not D6's quiet city, not a calm Flight Lab), off under
//    AB_CHAOS=0;
//  - AHEAD OF PLANES: every plane (bots too) deep in a bore gets one about
//    every 15–30 s (seeded), the first 3–6 s after it is first seen down
//    there — placed caveInLeadM ahead along its travel, so a cruising plane
//    meets the falling rock just after the warning; its open lane is, three
//    times in four, not the lane the plane is in;
//  - AND AT RANDOM elsewhere underground every 8–14 s;
//  - every placement is re-made from the planes' current (age-extrapolated)
//    poses each attempt and must pass the lead rule (caveInFairFor) for
//    every plane in that bore's frame, keep CAVEIN_SEPARATION from every
//    live cave-in in the bore, stay under CAVEIN_MAX live, and be allowed by
//    the room's DangerBudget for every plane it will meet (layer "cavein",
//    charged by id) — the shared budget wins: a refused one retries every
//    second from wherever the plane has got to.

import { mulberry32 } from "@angels-bandits/common/city";
import {
  CAVEIN_LEN,
  CAVEIN_MAX,
  CAVEIN_SEPARATION,
  type CaveInEvent,
  type CaveInGap,
  type CaveInPlane,
  type WireCaveIn,
  addCaveIn,
  caveInFairFor,
  caveInLeadM,
  caveInRanges,
  caveInSpotOk,
  emptyCaveInSlot,
  encodeCaveIn,
  pruneCaveIns,
} from "@angels-bandits/common/city/caveins";
import {
  BORE_WIDTH,
  TUNNELS,
  type Tunnel,
  type TunnelFrame,
  tunnelFrameInto,
} from "@angels-bandits/common/city/tunnels";
import { MAX_SPEED } from "@angels-bandits/common/constants";
import type { ChaosPlane } from "./chaos";
import type { DangerBudget } from "./danger";

export interface CaveInTuning {
  /** A plane deep in a bore gets one every [min, max] ms… */
  perPlaneMs: readonly [number, number];
  /** …the first [min, max] ms after it is first seen down there. */
  firstMs: readonly [number, number];
  /** One at random somewhere underground every [min, max] ms. */
  randomMs: readonly [number, number];
  /** A refused placement retries this often, ms. */
  retryMs: number;
  /** Share of a plane's cave-ins whose open lane is not its own. */
  laneAwayShare: number;
}

export const CAVEIN_TUNING: CaveInTuning = {
  perPlaneMs: [15_000, 30_000],
  firstMs: [3000, 6000],
  randomMs: [8000, 14_000],
  retryMs: 1000,
  laneAwayShare: 0.75,
};

/** AB_CHAOS_FAST=1 (tests and QA only): every cadence a quarter as long. */
export const CAVEIN_FAST: CaveInTuning = {
  ...CAVEIN_TUNING,
  perPlaneMs: [3750, 7500],
  firstMs: [750, 1500],
  randomMs: [2000, 3500],
};

/** A plane is "deep in a bore" between these past either end of the deep
 * run's placement ranges, m. */
const DEEP_MARGIN = 40;
/** A cave-in "meets" a plane that crosses its zone within this, s (the
 * planes it is charged to). */
const MEET_S = 6;
/** A random cave-in keeps this far along its bore from every plane, m. */
const RANDOM_CLEAR = 350;

const H = BORE_WIDTH / 2;

/** Which lane holds lateral `lat`. */
const laneOf = (lat: number): CaveInGap =>
  lat > H - 12 ? 0 : lat < -H + 12 ? 1 : 2;

interface PlaneTimer {
  /** When its next cave-in is due (null: not deep in a bore now). */
  due: number | null;
  /** Its last placement, ms. */
  last: number;
}

/** Telemetry (scratch sims and QA): placements and refusals by cause. */
export interface CaveInStats {
  placed: number;
  ahead: number;
  random: number;
  refused: Record<"spot" | "max" | "separation" | "fair" | "budget", number>;
}

export class CaveInDirector {
  /** The room's cave-ins as both sides hold them — the room's mover field
   * holds this very object (bots, crash checks). */
  readonly slot = emptyCaveInSlot();
  readonly stats: CaveInStats = {
    placed: 0,
    ahead: 0,
    random: 0,
    refused: { spot: 0, max: 0, separation: 0, fair: 0, budget: 0 },
  };
  private readonly timers = new Map<string, PlaneTimer>();
  private randomAt: number | null = null;
  private nextId = 1;
  private readonly rand: () => number;
  /** Per tunnel, per plane: its frame this tick (reused). */
  private readonly frames: CaveInPlane[][] = TUNNELS.map(() => []);
  private readonly frame: TunnelFrame = { s: 0, lat: 0, th: 0 };

  constructor(
    seed: number,
    private readonly tuning: CaveInTuning = CAVEIN_TUNING,
  ) {
    this.rand = mulberry32((seed ^ 0x0ca7e1) >>> 0);
  }

  /** The welcome's replay: every live cave-in. */
  state(now: number): WireCaveIn[] {
    pruneCaveIns(this.slot, now);
    return this.slot.list.map(encodeCaveIn);
  }

  /** The room's city went back to whole (its last human left). */
  reset(): void {
    this.slot.list.length = 0;
    this.timers.clear();
    this.randomAt = null;
  }

  /** A plane left the room. */
  forget(id: string): void {
    this.timers.delete(id);
  }

  /**
   * One tick: prune what is over, then each deep plane's due cave-in and
   * the random one. Returns the events placed (broadcast each as `caveIn`).
   */
  tick(
    now: number,
    planes: readonly ChaosPlane[],
    budget?: DangerBudget,
  ): CaveInEvent[] {
    const out: CaveInEvent[] = [];
    pruneCaveIns(this.slot, now);
    this.measure(planes);
    const t = this.tuning;
    for (let k = 0; k < planes.length; k++) {
      const p = planes[k] as ChaosPlane;
      let timer = this.timers.get(p.id);
      if (!timer) {
        timer = { due: null, last: Number.NEGATIVE_INFINITY };
        this.timers.set(p.id, timer);
      }
      const deep = this.deepIn(k);
      if (deep < 0) {
        timer.due = null;
        continue;
      }
      if (timer.due === null) {
        timer.due = Math.max(
          now + this.between(t.firstMs),
          timer.last + t.perPlaneMs[0],
        );
      }
      if (now < timer.due) continue;
      const e = this.ahead(now, k, deep, planes, budget);
      if (e) {
        out.push(e);
        this.stats.ahead++;
        timer.last = now;
        timer.due = now + this.between(t.perPlaneMs);
      } else {
        // Refused (no deep spot ahead yet, the budget, a neighbour): try
        // again in a beat from wherever the plane has got to.
        timer.due = now + t.retryMs;
      }
    }
    if (this.randomAt === null) this.randomAt = now + this.between(t.randomMs);
    if (now >= this.randomAt) {
      const e = this.random(now, planes, budget);
      if (e) {
        out.push(e);
        this.stats.random++;
        this.randomAt = now + this.between(t.randomMs);
      } else {
        this.randomAt = now + t.retryMs;
      }
    }
    return out;
  }

  private between(r: readonly [number, number]): number {
    return r[0] + (r[1] - r[0]) * this.rand();
  }

  /** Every plane's frame in every bore, this tick. */
  private measure(planes: readonly ChaosPlane[]): void {
    for (let b = 0; b < TUNNELS.length; b++) {
      const t = TUNNELS[b] as Tunnel;
      const list = this.frames[b] as CaveInPlane[];
      list.length = planes.length;
      for (let k = 0; k < planes.length; k++) {
        const p = planes[k] as ChaosPlane;
        tunnelFrameInto(t, p.pos, this.frame);
        const f = this.frame;
        let q = list[k];
        if (!q) {
          q = { s: 0, lat: 0, y: 0, vs: 0 };
          list[k] = q;
        }
        q.s = f.s;
        q.lat = f.lat;
        q.y = p.pos.y;
        q.vs = p.vel.x * Math.cos(f.th) + p.vel.z * Math.sin(f.th);
      }
    }
  }

  /** The bore plane `k` is deep in (inside it, under cover, along its deep
   * run), or −1. */
  private deepIn(k: number): number {
    for (let b = 0; b < TUNNELS.length; b++) {
      const q = (this.frames[b] as CaveInPlane[])[k] as CaveInPlane;
      if (q.y > -30 || Math.abs(q.lat) > H + 1) continue;
      const r = caveInRanges(TUNNELS[b] as Tunnel);
      const lo = (r[0] as [number, number])[0] - DEEP_MARGIN;
      const hi = (r[r.length - 1] as [number, number])[1] + DEEP_MARGIN;
      if (q.s >= lo && q.s <= hi) return b;
    }
    return -1;
  }

  /** One ahead of plane `k` in bore `b`, from where it is now. */
  private ahead(
    now: number,
    k: number,
    b: number,
    planes: readonly ChaosPlane[],
    budget?: DangerBudget,
  ): CaveInEvent | null {
    const q = (this.frames[b] as CaveInPlane[])[k] as CaveInPlane;
    const p = planes[k] as ChaosPlane;
    const speed = Math.hypot(p.vel.x, p.vel.y, p.vel.z);
    const dir = q.vs >= 0 ? 1 : -1;
    const s = q.s + dir * caveInLeadM(speed);
    const own = laneOf(q.lat);
    let gap: CaveInGap = own;
    if (this.rand() < this.tuning.laneAwayShare) {
      const others = ([0, 1, 2] as const).filter((g) => g !== own);
      gap = others[Math.floor(this.rand() * others.length)] as CaveInGap;
    }
    return this.place(now, b, s, gap, planes, budget);
  }

  /** One at a random deep spot of a random bore (a few tries). */
  private random(
    now: number,
    planes: readonly ChaosPlane[],
    budget?: DangerBudget,
  ): CaveInEvent | null {
    for (let n = 0; n < 6; n++) {
      const b = Math.floor(this.rand() * TUNNELS.length);
      const ranges = caveInRanges(TUNNELS[b] as Tunnel);
      let total = 0;
      for (const [a, c] of ranges) total += c - a;
      let u = this.rand() * total;
      let s = 0;
      for (const [a, c] of ranges) {
        if (u <= c - a) {
          s = a + u;
          break;
        }
        u -= c - a;
      }
      const gap = Math.floor(this.rand() * 3) as CaveInGap;
      // ELSEWHERE: well clear of every plane in that bore, so it never
      // crowds out the cave-ins placed ahead of them.
      if (this.nearPlane(b, s)) continue;
      const e = this.place(now, b, s, gap, planes, budget);
      if (e) return e;
    }
    return null;
  }

  /** Is any plane in bore `b`'s frame within RANDOM_CLEAR of `s`? */
  private nearPlane(b: number, s: number): boolean {
    for (const q of this.frames[b] as CaveInPlane[]) {
      if (q.y > 30 || Math.abs(q.lat) > H + 20) continue;
      if (Math.abs(q.s - s) < RANDOM_CLEAR) return true;
    }
    return false;
  }

  /** Every rule, then the event (added to the slot). */
  private place(
    now: number,
    b: number,
    sRaw: number,
    gap: CaveInGap,
    planes: readonly ChaosPlane[],
    budget?: DangerBudget,
  ): CaveInEvent | null {
    const s = Math.round(sRaw * 10) / 10;
    const r = this.stats.refused;
    if (!caveInSpotOk(b, s)) {
      r.spot++;
      return null;
    }
    if (this.slot.list.length >= CAVEIN_MAX) {
      r.max++;
      return null;
    }
    for (const c of this.slot.list) {
      if (c.tunnel === b && Math.abs(c.s - s) < CAVEIN_SEPARATION) {
        r.separation++;
        return null;
      }
    }
    const frames = this.frames[b] as CaveInPlane[];
    const meets: string[] = [];
    for (let k = 0; k < planes.length; k++) {
      const q = frames[k] as CaveInPlane;
      if (!caveInFairFor(q, s)) {
        r.fair++;
        return null;
      }
      if (meetsZone(q, s)) meets.push((planes[k] as ChaosPlane).id);
    }
    if (budget && meets.length > 0) {
      if (!budget.allowsIds("cavein", meets, now, planes)) {
        r.budget++;
        return null;
      }
      budget.chargeIds("cavein", meets, now);
    }
    const e: CaveInEvent = {
      id: this.nextId++,
      tunnel: b,
      s,
      t0: Math.round(now),
      gap,
    };
    addCaveIn(this.slot, e);
    this.stats.placed++;
    return e;
  }
}

/** Will a plane in the bore's frame cross a zone centred at `s` within
 * MEET_S (at its reference speed)? The planes a cave-in is charged to. */
function meetsZone(q: CaveInPlane, s: number): boolean {
  if (q.y > 30 || Math.abs(q.lat) > H + 20) return false;
  const v = Math.max(Math.abs(q.vs), MAX_SPEED);
  const half = CAVEIN_LEN / 2;
  const d = q.vs >= 0 ? s - half - q.s : q.s - (s + half);
  return d > -CAVEIN_LEN && d < v * MEET_S;
}
