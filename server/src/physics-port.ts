// DS1: the debris physics as the host sees it — types only. The Rapier
// world itself (./debris-physics.ts) is built by the sim worker and handed to
// the host through GameHostOptions.debrisPhysics, so nothing on the host's
// import path (and nothing in the Node shell) ever loads Rapier's WASM.

import type { Building } from "@angels-bandits/common/city";
import type {
  Collapse,
  CollapseImpact,
} from "@angels-bandits/common/city/collapse";
import type { PhysRegistry } from "@angels-bandits/common/city/physpose";
import type { DestructionTuning } from "@angels-bandits/common/destruction-tuning";

/** A chain impact the physics found: debris striking a building (another
 * one, or — a leaning section bearing down — its own). */
export interface PhysicsImpact extends CollapseImpact {
  /** The collapse whose debris it is, and its chain link. */
  source: number;
  depth: number;
}

/** One frame for the page: host time, the physics epoch, the poses
 * (city/physpose.ts records) and any heaps settled in it. */
export interface PhysicsFrame {
  t: number;
  epoch: number;
  data: Float32Array;
  heaps: Float32Array | null;
}

/** What the physics needs of its room. */
export interface PhysicsRoom {
  readonly buildings: readonly Building[];
  tuning: Readonly<DestructionTuning>;
}

/** Where the camera is and how many moving bodies its tier allows. */
export interface PhysicsView {
  x: number;
  z: number;
  budget: number;
}

/** One room's debris physics. */
export interface PhysicsHost {
  /** The poses it writes (the room's CollapseField reads them). */
  readonly registry: PhysRegistry;
  /** Moving bodies now, the most there ever were, and the budget. */
  readonly active: number;
  readonly peakActive: number;
  readonly budget: number;
  /** The last step's cost, ms. */
  readonly lastStepMs: number;
  /** Simulate `c`? False: the room keeps it analytic. */
  add(c: Collapse, depth: number): boolean;
  /** Forget collapse `id` (a rebuild). */
  remove(id: number): void;
  /** Everything gone (a room reset). */
  reset(): void;
  /** Advance to host time `now`, ms. */
  step(now: number): void;
  takeImpacts(): PhysicsImpact[];
  takeFrame(): PhysicsFrame | null;
  setView(view: PhysicsView): void;
  /** Free it (the room is gone). */
  dispose(): void;
}

/** Builds one room's physics (the sim worker's GameHostOptions). */
export type PhysicsFactory = (room: PhysicsRoom) => PhysicsHost;
