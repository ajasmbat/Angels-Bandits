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
  BULLET_RANGE,
  DAMAGE_MEMORY_MS,
  FIRE_BURST_SLACK,
  FIRE_INTERVAL_MS,
  HEAT_VALIDATION_SLACK,
  HIT_ORIGIN_SLACK,
  HIT_RANGE_SLACK,
  KILL_CAM_MS,
  MAX_HP,
  OVERHEAT_AT,
  REGEN_DELAY_MS,
  REGEN_RATE,
  SPAWN_PROTECTION_MS,
} from "@angels-bandits/common/constants";
import type { ScoreEntry } from "@angels-bandits/common/protocol";
import { type Vec3, wrapDistance } from "@angels-bandits/common/world";

/** How long after firing a bullet's hit claim is still credible, ms:
 * full flight time plus generous network slack. */
const CLAIM_WINDOW_MS = BULLET_LIFETIME_S * 1000 + 1000;

export type FireReject = "dead" | "overheat" | "cadence";
export type FireResult =
  | { ok: true; protectionCanceled: boolean }
  | { ok: false; reason: FireReject };

export type HitReject =
  | "unknown"
  | "shooter-dead"
  | "target-dead"
  | "protected"
  | "bullet"
  | "origin"
  | "range";
export interface Death {
  victimId: string;
  killerId: string | null;
  cause: "shot" | "crash" | "storm";
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
      respawnAt: Number.POSITIVE_INFINITY,
      regenAt: now,
    });
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

  scores(): ScoreEntry[] {
    return [...this.players.keys()].map((id) => this.scoreOf(id));
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
   */
  hit(
    shooterId: string,
    targetId: string,
    seq: number,
    bulletOrigin: Vec3,
    shooterPos: Vec3,
    targetPos: Vec3,
    now: number,
  ): HitResult {
    const shooter = this.players.get(shooterId);
    const target = this.players.get(targetId);
    if (!shooter || !target) return { ok: false, reason: "unknown" };
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

    if (wrapDistance(bulletOrigin, shooterPos) > HIT_ORIGIN_SLACK) {
      return { ok: false, reason: "origin" };
    }
    if (wrapDistance(shooterPos, targetPos) > BULLET_RANGE + HIT_RANGE_SLACK) {
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

  /** An environment-caused death: last damager within DAMAGE_MEMORY_MS gets
   * the credit (PLAN.md kill-credit rule), else no one. */
  private environmentKill(
    id: string,
    cause: "crash" | "storm",
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
      const from = Math.max(p.regenAt, p.lastDamagedAt + REGEN_DELAY_MS);
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
    p.alive = true;
    p.hp = MAX_HP;
    p.protectedUntil = now + SPAWN_PROTECTION_MS;
    p.heat = createGunHeat(now);
    p.allowance = FIRE_BURST_SLACK;
    p.allowanceAt = now;
    p.bullets.clear();
    p.lastDamagerId = null;
    p.lastDamagedAt = Number.NEGATIVE_INFINITY;
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
