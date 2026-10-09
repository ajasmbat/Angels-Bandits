// The server's combat authority (PLAN.md authority split): HP, kills, deaths,
// spawn protection, and respawn timing mutate HERE and nowhere else. The
// engine is pure bookkeeping like room.ts — no sockets, no clocks of its own
// (every call takes `now`), unit-testable. index.ts wires it to the wire.
//
// Hits arrive as shooter-side claims (favor the shooter); this engine only
// judges plausibility: the bullet was really fired (seq), recently, from
// where the shooter is on record, within range-plus-slack of the target
// (wrapDistance — the seam makes raw distance meaningless), at a target that
// is alive and not spawn-protected.

import {
  type GunHeat,
  canFire,
  cooledGunHeat,
  createGunHeat,
  firedGunHeat,
} from "@angels-bandits/common/combat";
import {
  BULLET_DAMAGE,
  BULLET_LIFETIME_S,
  DAMAGE_MEMORY_MS,
  FIRE_BURST_SLACK,
  FIRE_INTERVAL_MS,
  HEAT_VALIDATION_SLACK,
  HIT_ORIGIN_SLACK,
  INTERP_FLOOR_MS,
  KILL_CAM_MS,
  MAX_HP,
  MAX_SPEED,
  OVERHEAT_AT,
  REGEN_DELAY_MS,
  REGEN_RATE,
  SPAWN_PROTECTION_MS,
  SPEED_TOLERANCE,
} from "@angels-bandits/common/constants";
import {
  clampInterpDelay,
  hitRangeBudgetFor,
} from "@angels-bandits/common/net";
import type { ScoreEntry } from "@angels-bandits/common/protocol";
import { type Vec3, wrapDistance } from "@angels-bandits/common/world";

/** How long after firing a bullet's hit claim is still credible, ms:
 * full flight time plus generous network slack. */
const CLAIM_WINDOW_MS = BULLET_LIFETIME_S * 1000 + 1000;

/** Longest bullet age the origin check pays shooter travel for, ms: a full
 * flight plus a little fire→claim arrival jitter. Bounded so the long tail
 * of CLAIM_WINDOW_MS never buys a wider origin window. */
const ORIGIN_AGE_MAX_MS = BULLET_LIFETIME_S * 1000 + 100;

/**
 * A plane's fastest legal airspeed over [since, now], m/s, before
 * SPEED_TOLERANCE — the boost mirror's window cap (F2). Hit validation asks
 * for it per claim, so a boost widens only the claims it can affect.
 */
export type SpeedCapFn = (since: number) => number;
const unboosted: SpeedCapFn = () => MAX_SPEED;

export type FireReject = "dead" | "overheat" | "cadence";
export type FireResult =
  | { ok: true; protectionCanceled: boolean }
  | { ok: false; reason: FireReject };

export type HitReject =
  | "unknown"
  | "self"
  | "shooter-dead"
  | "target-dead"
  | "protected"
  | "bullet"
  | "origin"
  | "range";
export interface Death {
  victimId: string;
  killerId: string | null;
  cause:
    | "shot"
    | "crash"
    | "storm"
    | "wreck"
    | "collapse"
    | "missile"
    | "blast";
}
export type HitResult =
  | { ok: true; hp: number; death: Death | null }
  | { ok: false; reason: HitReject };

interface PlayerCombat {
  hp: number;
  alive: boolean;
  kills: number;
  deaths: number;
  protectedUntil: number;
  heat: GunHeat;
  /** Fire-rate token bucket: refills 1 shot per FIRE_INTERVAL_MS up to
   * FIRE_BURST_SLACK, so batched-but-legal shots pass and spam doesn't. */
  allowance: number;
  allowanceAt: number;
  /** Fired-but-unclaimed bullets: seq → fire time (pruned by claim window). */
  bullets: Map<number, number>;
  lastDamagerId: string | null;
  lastDamagedAt: number;
  /** X1: the last ENVIRONMENT damage (a missile blast). Kept apart from
   * lastDamagedAt on purpose: it holds off regen and the away lock like any
   * hit, but must never stretch an earlier shooter's kill credit window. */
  lastEnvDamagedAt: number;
  /** When a dead player's kill-cam ends and the respawn is due, ms. */
  respawnAt: number;
  /** Regen bookkeeping: end of the last window regen was applied over. */
  regenAt: number;
}

export class Combat {
  private readonly players = new Map<string, PlayerCombat>();

  /** Register a joining player: full HP, spawn-protected. */
  addPlayer(id: string, now: number): void {
    this.players.set(id, {
      hp: MAX_HP,
      alive: true,
      kills: 0,
      deaths: 0,
      protectedUntil: now + SPAWN_PROTECTION_MS,
      heat: createGunHeat(now),
      allowance: FIRE_BURST_SLACK,
      allowanceAt: now,
      bullets: new Map(),
      lastDamagerId: null,
      lastDamagedAt: Number.NEGATIVE_INFINITY,
      lastEnvDamagedAt: Number.NEGATIVE_INFINITY,
      respawnAt: Number.POSITIVE_INFINITY,
      regenAt: now,
    });
  }

  /** Restart a living player's spawn protection from `now` (W1: a joiner's
   * window starts at its first pose, not at the join it spent loading). */
  protectFrom(id: string, now: number): void {
    const p = this.players.get(id);
    if (p?.alive) p.protectedUntil = now + SPAWN_PROTECTION_MS;
  }

  /** W2: put a resumed player's tally back. Call AFTER addPlayer, which
   * starts every player at 0/0. */
  restoreScore(id: string, kills: number, deaths: number): void {
    const p = this.players.get(id);
    if (!p) return;
    p.kills = kills;
    p.deaths = deaths;
  }

  /** W2: did `id` take damage in the last `ms`? (Away waits this out.) */
  damagedWithin(id: string, now: number, ms: number): boolean {
    const p = this.players.get(id);
    return (
      p !== undefined &&
      now - Math.max(p.lastDamagedAt, p.lastEnvDamagedAt) < ms
    );
  }

  removePlayer(id: string): void {
    this.players.delete(id);
  }

  isAlive(id: string): boolean {
    return this.players.get(id)?.alive ?? false;
  }

  isProtected(id: string, now: number): boolean {
    const p = this.players.get(id);
    if (!p?.alive) return false;
    return now < p.protectedUntil;
  }

  hpOf(id: string): number {
    return Math.round(this.players.get(id)?.hp ?? 0);
  }

  scoreOf(id: string): ScoreEntry {
    const p = this.players.get(id);
    return { id, kills: p?.kills ?? 0, deaths: p?.deaths ?? 0 };
  }

  /**
   * Validate one shot (seq is the client's bullet id). Accepting registers
   * the bullet for later hit claims and cancels spawn protection — firing
   * forfeits it (PLAN.md).
   */
  fire(id: string, seq: number, now: number): FireResult {
    const p = this.players.get(id);
    if (!p || !p.alive) return { ok: false, reason: "dead" };

    // Heat: same model the client steps, locked with slack for clock jitter.
    const heat = cooledGunHeat(p.heat, now);
    if (heat.locked) {
      p.heat = heat;
      return { ok: false, reason: "overheat" };
    }

    // Cadence: token bucket — burst-tolerant average of FIRE_INTERVAL_MS.
    const refill = (now - p.allowanceAt) / FIRE_INTERVAL_MS;
    p.allowance = Math.min(FIRE_BURST_SLACK, p.allowance + refill);
    p.allowanceAt = now;
    if (p.allowance < 1) {
      p.heat = heat;
      return { ok: false, reason: "cadence" };
    }
    p.allowance -= 1;

    p.heat = firedGunHeat(heat, now, OVERHEAT_AT + HEAT_VALIDATION_SLACK);
    p.bullets.set(seq, now);
    for (const [s, at] of p.bullets) {
      if (now - at > CLAIM_WINDOW_MS) p.bullets.delete(s);
    }

    const protectionCanceled = now < p.protectedUntil;
    p.protectedUntil = now;
    return { ok: true, protectionCanceled };
  }

  /**
   * Judge a shooter-side hit claim. Positions are the ON-RECORD poses from
   * pose validation, never interpolated ghosts (PLAN.md decision).
   *
   * `interpDelayMs` is the buffer the SHOOTER was holding when it made the
   * claim (ANGE-4KO2W2). The range budget is derived from it rather than
   * fixed, because that delay is exactly the window during which the target
   * image the shooter aimed at went stale. It is clamped to the legal range
   * on the way in, and an omitted value reads as the floor — the tightest
   * budget — so the default can only ever be stricter than a declared one.
   *
   * `shooterCap` / `targetCap` are each plane's boost window cap (F2); they
   * default to MAX_SPEED, which reproduces the un-boosted budget exactly.
   */
  hit(
    shooterId: string,
    targetId: string,
    seq: number,
    bulletOrigin: Vec3,
    shooterPos: Vec3,
    targetPos: Vec3,
    now: number,
    interpDelayMs: number = INTERP_FLOOR_MS,
    shooterCap: SpeedCapFn = unboosted,
    targetCap: SpeedCapFn = unboosted,
  ): HitResult {
    const shooter = this.players.get(shooterId);
    const target = this.players.get(targetId);
    if (!shooter || !target) return { ok: false, reason: "unknown" };
    // A self-hit would kill() with killer === victim and credit the kill.
    if (shooterId === targetId) return { ok: false, reason: "self" };
    if (!shooter.alive) return { ok: false, reason: "shooter-dead" };
    if (!target.alive) return { ok: false, reason: "target-dead" };
    if (now < target.protectedUntil) return { ok: false, reason: "protected" };

    // The claimed bullet must exist, be young enough, and never have hit
    // before — one bullet, one hit.
    const firedAt = shooter.bullets.get(seq);
    if (firedAt === undefined || now - firedAt > CLAIM_WINDOW_MS) {
      return { ok: false, reason: "bullet" };
    }
    shooter.bullets.delete(seq);

    // The origin is the muzzle at FIRE time, but the on-record pose is the
    // shooter's NOW — it kept flying for the bullet's whole age, at up to its
    // own legal speed (boost included).
    const age = Math.min(now - firedAt, ORIGIN_AGE_MAX_MS) / 1000;
    const originSlack =
      HIT_ORIGIN_SLACK + shooterCap(firedAt) * SPEED_TOLERANCE * age;
    if (wrapDistance(bulletOrigin, shooterPos) > originSlack) {
      return { ok: false, reason: "origin" };
    }
    // Both planes keep flying through the delay + flight window; judge the
    // closing speed at each one's own cap over that window.
    const rangeSince =
      now - clampInterpDelay(interpDelayMs) - BULLET_LIFETIME_S * 1000;
    const closing =
      (shooterCap(rangeSince) + targetCap(rangeSince)) * SPEED_TOLERANCE;
    if (
      wrapDistance(shooterPos, targetPos) >
      hitRangeBudgetFor(interpDelayMs, closing)
    ) {
      return { ok: false, reason: "range" };
    }

    target.hp -= BULLET_DAMAGE;
    target.lastDamagerId = shooterId;
    target.lastDamagedAt = now;
    const death =
      target.hp <= 0
        ? this.kill(targetId, target, shooterId, "shot", now)
        : null;
    return { ok: true, hp: Math.round(Math.max(0, target.hp)), death };
  }

  /** Client-reported crash. Credits the last damager within DAMAGE_MEMORY_MS. */
  crash(id: string, now: number): Death | null {
    return this.environmentKill(id, "crash", now);
  }

  /** Storm-ceiling execution (the hidden death ceiling's grace ran out) —
   * the crash credit rule with cause "storm": a bolt finishing off a damaged
   * plane still pays the damager; otherwise the storm itself (⚡) takes it. */
  stormKill(id: string, now: number): Death | null {
    return this.environmentKill(id, "storm", now);
  }

  /**
   * D3: crushed by falling collapse debris. Credit, in order: `by` — whoever
   * brought the building down — while they are still in the fight and are
   * not the victim; else the crash rule (last damager within
   * DAMAGE_MEMORY_MS); else nobody (the environment).
   */
  collapseKill(id: string, by: string | null, now: number): Death | null {
    const p = this.players.get(id);
    if (!p || !p.alive) return null;
    if (by !== null && by !== id && this.players.has(by)) {
      return this.kill(id, p, by, "collapse", now);
    }
    return this.environmentKill(id, "collapse", now);
  }

  /**
   * X1 environment damage (a missile blast; D5 a gas main, cause "blast"):
   * take `amount` off a living, unprotected plane. Nobody is credited for
   * the damage itself — a lethal blast is an environment death that pays
   * the last damager only by the crash rule. Null when nothing was applied
   * (dead, protected, unknown).
   */
  environmentDamage(
    id: string,
    amount: number,
    now: number,
    cause: "missile" | "blast" = "missile",
  ): { hp: number; death: Death | null } | null {
    const p = this.players.get(id);
    if (!p || !p.alive || !(amount > 0)) return null;
    if (now < p.protectedUntil) return null;
    p.hp -= amount;
    p.lastEnvDamagedAt = now;
    const death = p.hp <= 0 ? this.environmentKill(id, cause, now) : null;
    return { hp: Math.round(Math.max(0, p.hp)), death };
  }

  /**
   * D4: `id` flew into the falling wreck `shooterId` shot down. The wreck is
   * what killed it, so its shooter takes the credit over any last damager —
   * unless that is `id` itself (no kill for your own death) or has left, in
   * which case it is an ordinary crash under the environment rule.
   */
  wreckKill(id: string, shooterId: string | null, now: number): Death | null {
    const p = this.players.get(id);
    if (!p || !p.alive) return null;
    if (
      shooterId === null ||
      shooterId === id ||
      !this.players.has(shooterId)
    ) {
      return this.environmentKill(id, "crash", now);
    }
    return this.kill(id, p, shooterId, "wreck", now);
  }

  /** An environment-caused death: last damager within DAMAGE_MEMORY_MS gets
   * the credit (PLAN.md kill-credit rule), else no one. */
  private environmentKill(
    id: string,
    cause: "crash" | "storm" | "collapse" | "missile" | "blast",
    now: number,
  ): Death | null {
    const p = this.players.get(id);
    if (!p || !p.alive) return null;
    const credited =
      p.lastDamagerId !== null && now - p.lastDamagedAt <= DAMAGE_MEMORY_MS;
    return this.kill(id, p, credited ? p.lastDamagerId : null, cause, now);
  }

  /**
   * Advance time-driven state: health regen for the living, and the list of
   * dead players whose kill-cam beat has ended — the caller picks their spawn
   * points and completes each with `respawned()`.
   */
  tick(now: number): { respawnsDue: string[] } {
    const respawnsDue: string[] = [];
    for (const [id, p] of this.players) {
      if (!p.alive) {
        if (now >= p.respawnAt) respawnsDue.push(id);
        continue;
      }
      // Regen: REGEN_RATE from REGEN_DELAY_MS after the last damage, exact
      // over the [regenAt, now] window so tick cadence never changes the rate.
      const hurtAt = Math.max(p.lastDamagedAt, p.lastEnvDamagedAt);
      const from = Math.max(p.regenAt, hurtAt + REGEN_DELAY_MS);
      if (now > from && p.hp < MAX_HP) {
        p.hp = Math.min(MAX_HP, p.hp + (REGEN_RATE * (now - from)) / 1000);
      }
      p.regenAt = now;
    }
    return { respawnsDue };
  }

  /** Complete a respawn: alive again at full HP, spawn-protected. */
  respawned(id: string, now: number): void {
    const p = this.players.get(id);
    if (!p || p.alive) return;
    this.freshPlane(p, now);
  }

  /** W2: a LIVING player back from away gets a fresh plane — its local
   * flight state is stale, so it re-enters like a respawn (no death). */
  returned(id: string, now: number): void {
    const p = this.players.get(id);
    if (p?.alive) this.freshPlane(p, now);
  }

  private freshPlane(p: PlayerCombat, now: number): void {
    p.alive = true;
    p.hp = MAX_HP;
    p.protectedUntil = now + SPAWN_PROTECTION_MS;
    p.heat = createGunHeat(now);
    p.allowance = FIRE_BURST_SLACK;
    p.allowanceAt = now;
    p.bullets.clear();
    p.lastDamagerId = null;
    p.lastDamagedAt = Number.NEGATIVE_INFINITY;
    p.lastEnvDamagedAt = Number.NEGATIVE_INFINITY;
    p.respawnAt = Number.POSITIVE_INFINITY;
    p.regenAt = now;
  }

  private kill(
    victimId: string,
    victim: PlayerCombat,
    killerId: string | null,
    cause: Death["cause"],
    now: number,
  ): Death {
    victim.alive = false;
    victim.hp = 0;
    victim.deaths++;
    victim.respawnAt = now + KILL_CAM_MS;
    if (killerId !== null) {
      const killer = this.players.get(killerId);
      if (killer) killer.kills++;
    }
    return { victimId, killerId, cause };
  }
}
