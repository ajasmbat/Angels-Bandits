// S7 kill streaks & medals — the pure rules. The server is the only
// authority on credit (PLAN.md authority split): it feeds every credited
// death through one MedalLedger and broadcasts the result, so two clients
// that saw the same kill show the same medals. No sockets, no clocks of its
// own (every call takes `now`), unit-testable — the combat.ts idiom.
//
// Context the server works out per kill (is the killer threading a hole,
// riding a train) comes in as plain booleans on KillFacts; the geometry
// helpers for it live here too so they are tested beside the rules.

import type { HoleSpan } from "./city/holes";
import { type MoverBox, sphereHitsBox } from "./city/movers";
import { type TrainLine, blankCar, carBox } from "./city/train";
import { type Vec3, wrapDelta } from "./world/index";

export type MedalKind =
  | "double"
  | "needle"
  | "train"
  | "demolition"
  | "revenge"
  | "boss";

/** Every medal kind, in the order a toast stacks them. */
export const MEDAL_KINDS: readonly MedalKind[] = [
  "double",
  "needle",
  "train",
  "demolition",
  "revenge",
  "boss",
];

export const MEDAL_LABEL: Readonly<Record<MedalKind, string>> = {
  double: "DOUBLE KILL",
  needle: "THREAD THE NEEDLE",
  train: "TRAIN SURFER",
  demolition: "DEMOLITION",
  revenge: "REVENGE",
  boss: "SKY-BOSS SLAYER",
};

export const isMedalKind = (v: unknown): v is MedalKind =>
  typeof v === "string" && (MEDAL_KINDS as readonly string[]).includes(v);

/** Streak lengths the announcer, the smoke and the scoreboard glow mark. */
export const STREAK_TIERS = [3, 5, 10] as const;
export type StreakTier = (typeof STREAK_TIERS)[number];

/** A kill this soon after the killer's previous one is a DOUBLE KILL, ms. */
export const DOUBLE_KILL_MS = 4000;
/** A kill this soon after flying through a hole is THREAD THE NEEDLE, ms. */
export const NEEDLE_WINDOW_MS = 1500;
/** A kill within this of a train car is TRAIN SURFER, meters. */
export const TRAIN_SURFER_RANGE = 40;

/**
 * Death causes that mean "the city's falling structure did it": a D4 wreck
 * the killer shot down, and D3's building collapses. A string set rather
 * than the DeathMsg union so a cause added later needs no edit here.
 */
export const DEMOLITION_CAUSES: ReadonlySet<string> = new Set([
  "wreck",
  "collapse",
]);

/** The highest tier reached at `streak`, or 0 below the first. */
export function streakTier(streak: number): StreakTier | 0 {
  let tier: StreakTier | 0 = 0;
  for (const t of STREAK_TIERS) if (streak >= t) tier = t;
  return tier;
}

/** One credited kill, as the server saw it. */
export interface KillFacts {
  killerId: string;
  victimId: string;
  /** The death's cause (DeathMsg["cause"], or a later addition). */
  cause: string;
  now: number;
  /** A posthumous kill (a wreck, a credited crash after the killer died)
   * earns medals but never extends a streak — the streak ended on death. */
  killerAlive: boolean;
  /** The killer flew through (or is in) a hole around the kill. */
  needle: boolean;
  /** The killer is within TRAIN_SURFER_RANGE of a train car. */
  train: boolean;
  /** The victim was the S4 sky boss (set by S4; absent until it exists). */
  boss?: boolean;
}

export interface Award {
  /** Each kind at most once, in MEDAL_KINDS order. */
  medals: MedalKind[];
  /** The tier this kill crossed into, exactly once per streak. */
  tier: StreakTier | null;
  /** The killer's streak after this kill. */
  streak: number;
  /** J1: kills in the killer's current DOUBLE_KILL_MS chain, this one
   * included (1 = no combo) — the client's DOUBLE / TRIPLE / MULTI banner. */
  chain: number;
}

interface PilotRecord {
  streak: number;
  best: number;
  lastKillAt: number;
  /** Kills in the current DOUBLE_KILL_MS chain. */
  chain: number;
  /** Who last killed this pilot and has not been paid back yet. */
  grudge: string | null;
}

const fresh = (): PilotRecord => ({
  streak: 0,
  best: 0,
  lastKillAt: Number.NEGATIVE_INFINITY,
  chain: 0,
  grudge: null,
});

export class MedalLedger {
  private readonly pilots = new Map<string, PilotRecord>();

  private record(id: string): PilotRecord {
    let p = this.pilots.get(id);
    if (!p) {
      p = fresh();
      this.pilots.set(id, p);
    }
    return p;
  }

  /** Credit one kill. Call BEFORE death() for the same event, so a REVENGE
   * reads the grudge as it stood before the victim's own death. */
  kill(f: KillFacts): Award {
    const k = this.record(f.killerId);
    const medals = new Set<MedalKind>();

    k.chain = f.now - k.lastKillAt <= DOUBLE_KILL_MS ? k.chain + 1 : 1;
    k.lastKillAt = f.now;
    if (k.chain === 2) medals.add("double");
    if (f.needle) medals.add("needle");
    if (f.train) medals.add("train");
    if (DEMOLITION_CAUSES.has(f.cause)) medals.add("demolition");
    if (k.grudge !== null && k.grudge === f.victimId) {
      medals.add("revenge");
      k.grudge = null;
    }
    if (f.boss) medals.add("boss");

    let tier: StreakTier | null = null;
    if (f.killerAlive) {
      k.streak++;
      k.best = Math.max(k.best, k.streak);
      for (const t of STREAK_TIERS) if (k.streak === t) tier = t;
    }
    return {
      medals: MEDAL_KINDS.filter((m) => medals.has(m)),
      tier,
      streak: k.streak,
      chain: k.chain,
    };
  }

  /**
   * S4: `id` dealt the most damage to a downed sky boss — SKY-BOSS SLAYER.
   * The boss is not a pilot: no streak, no double-kill chain, no grudge, and
   * no record kept for it.
   */
  bossKill(id: string): Award {
    return {
      medals: ["boss"],
      tier: null,
      streak: this.streakOf(id),
      chain: 0,
    };
  }

  /** A death ends the victim's streak; a credited one leaves a grudge. */
  death(victimId: string, killerId: string | null): void {
    const v = this.record(victimId);
    v.streak = 0;
    if (killerId !== null && killerId !== victimId) v.grudge = killerId;
  }

  streakOf(id: string): number {
    return this.pilots.get(id)?.streak ?? 0;
  }

  bestOf(id: string): number {
    return this.pilots.get(id)?.best ?? 0;
  }

  /** W2: put a resumed pilot's streak back (after a drop, not a death). */
  restore(id: string, streak: number, best: number): void {
    const p = this.record(id);
    p.streak = streak;
    p.best = Math.max(best, streak);
  }

  /** The pilot left: forget them, and every grudge held against them. */
  forget(id: string): void {
    this.pilots.delete(id);
    for (const p of this.pilots.values()) if (p.grudge === id) p.grudge = null;
  }
}

/** Is `p` inside the hole's clear volume (torus-aware)? */
export function inHoleSpan(span: HoleSpan, p: Vec3): boolean {
  const x = span.hole.axis === "x";
  const d = wrapDelta(span.center, p);
  const along = x ? d.x : d.z;
  const across = x ? d.z : d.x;
  const { width, y0, height } = span.hole;
  return (
    Math.abs(along) <= span.length / 2 &&
    Math.abs(across) <= width / 2 &&
    p.y >= y0 &&
    p.y <= y0 + height
  );
}

const scratchCar: MoverBox = blankCar();

/**
 * Is any train CAR within `range` of `p` at server time `t`? Cars only — the
 * viaduct under them is not a train (collideTrains reports it first).
 * Allocation-free; called once per kill, so a plain sweep of every car.
 */
export function nearTrainCar(
  lines: readonly TrainLine[],
  p: Vec3,
  range: number,
  t: number,
): boolean {
  for (const line of lines) {
    for (let k = 0; k < line.tracks.length; k++) {
      const trains = line.tracks[k]?.trains ?? 0;
      for (let j = 0; j < trains; j++) {
        for (let i = 0; i < line.cars; i++) {
          carBox(line, k, j, i, t, scratchCar);
          if (sphereHitsBox(scratchCar, p, range)) return true;
        }
      }
    }
  }
  return false;
}
