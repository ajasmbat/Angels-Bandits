// SOLO: the game host's configuration (server/src/host.ts). Everything the
// host used to read off `process.env` at import time is an option now, so the
// same host runs in the Node shell (server/src/index.ts, which maps its
// environment through hostOptionsFromEnv) and in the browser's sim worker
// (client/src/sim/worker.ts, which maps a `?sim=` parameter the same way).
// Pure: no Node import, no global read.

import {
  AWAY_SILENCE_MS,
  AWAY_TIMEOUT_MS,
  BOOT_TIMEOUT_MS,
  JOIN_DEADLINE_MS,
  LIVENESS_TIMEOUT_MS,
  RESUME_WINDOW_MS,
} from "@angels-bandits/common/constants";
import { type ChaosTunings, chaosTunings } from "./chaos";
import type { PhysicsFactory, PhysicsFrame } from "./physics-port";

export interface GameHostOptions {
  /** How long a connection may stay open without sending `join` (S1). */
  joinDeadlineMs: number;
  /** How long a joined player may stay pending (no pose yet) — W1. */
  bootTimeoutMs: number;
  /** W2 windows. */
  resumeWindowMs: number;
  awayTimeoutMs: number;
  awaySilenceMs: number;
  /** D6: the liveness bound — the perf harness raises it, since a
   * software-rendered page can go seconds between frames. */
  livenessMs: number;
  /** Every chaos tuning (server/src/chaos.ts chaosTunings). */
  tunings: ChaosTunings;
  /** U6: the cave-ins come quickly (AB_CHAOS_FAST; tests and QA only). */
  caveInsFast: boolean;
  /** D6 (perf harness only): no room's city ever breaks and no boss raid
   * starts — see `quiet` in host.ts. */
  quietCity: boolean;
  /** E1 (benches): an air force of exactly this many planes in the air at
   * once, off no rig; null in a live room. */
  airForce: number | null;
  /** A1: profile the tick's phases (GameHost.tickReport). */
  tickStats: boolean;
  /** SOLO: the host may be paused (GameHost.setPaused) — only ever a
   * single-player host: a shared room never pauses. */
  pausable: boolean;
  /** The wall clock, ms. Injected so a test can drive it; Date.now. */
  clock: () => number;
  /** DS1: builds each room's debris physics — the sim worker's Rapier
   * world (server/src/debris-physics.ts); null (the Node shell, tests):
   * every collapse is the closed form. */
  debrisPhysics: PhysicsFactory | null;
  /** DS1: each tick's physics frame, per room that has one (the worker
   * transfers it to the page). */
  onPhysicsFrame: ((frame: PhysicsFrame) => void) | null;
}

/** A host as it ships: the shared constants, C2's chaos, nothing staged. */
export const defaultHostOptions = (): GameHostOptions => hostOptionsFromEnv({});

/**
 * Options from an environment-shaped map — the Node shell's `process.env`,
 * or the worker's `?sim=` pairs. The same names and the same rules the
 * server always read: a timing override wins only when it is a positive
 * number; the AB_* switches are "1" (and AB_CHAOS / AB_WAVES are "0") to
 * flip.
 */
export function hostOptionsFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): GameHostOptions {
  const ms = (key: string, fallback: number): number =>
    Number(env[key]) || fallback;
  const n = Number(env.AB_AIRFORCE);
  return {
    joinDeadlineMs: ms("JOIN_DEADLINE_MS", JOIN_DEADLINE_MS),
    bootTimeoutMs: ms("BOOT_TIMEOUT_MS", BOOT_TIMEOUT_MS),
    resumeWindowMs: ms("RESUME_WINDOW_MS", RESUME_WINDOW_MS),
    awayTimeoutMs: ms("AWAY_TIMEOUT_MS", AWAY_TIMEOUT_MS),
    awaySilenceMs: ms("AWAY_SILENCE_MS", AWAY_SILENCE_MS),
    livenessMs: ms("LIVENESS_TIMEOUT_MS", LIVENESS_TIMEOUT_MS),
    tunings: chaosTunings(env),
    caveInsFast: env.AB_CHAOS_FAST === "1",
    quietCity: env.AB_QUIET_CITY === "1",
    airForce: Number.isInteger(n) && n >= 0 ? Math.min(n, 2000) : null,
    tickStats: env.AB_TICK_STATS === "1",
    pausable: false,
    clock: Date.now,
    debrisPhysics: null,
    onPhysicsFrame: null,
  };
}
