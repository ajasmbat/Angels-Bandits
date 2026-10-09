// D6 perf-harness staging (QA only — `__ab.qaDestruction`): put a broken
// city on screen as if the server had broken it, through the server's own
// steps, so a perf segment measures the destruction a player would see with
// nothing left to wall-clock timing.
//
// The server's path (server/src/destruction.ts tickDestruction) is: chunks
// break → every touched building, in index order, gets `planCollapses` → each
// plan becomes a wire (`collapseWire`) whose chunks fall (`damage.collapse`)
// and whose debris starts (`field.add`). This does exactly that, against the
// GameSocket's own `cityDamage` and `collapses` — the state every renderer,
// the crash check and the camera arm already read — and honours the same
// caps: nothing breaks past DESTROY_CAP, and no collapse starts once
// COLLAPSE_CAP of the city's chunks are gone. A felled tower is D5's
// demolition (`demolitionPlan`), which the director runs past both caps.
//
// Deliberately left out: `collapseImpacts` chains (the server lands those
// later as D2 blasts; a staged scene is the state at one instant).
//
// Building indices are generateCity(CITY_SEED)'s — a protocol-level contract
// — and every spec states what it expects to find there, so a generator
// change throws here instead of quietly staging a different scene.

import {
  type Building,
  type CityDamage,
  chunksOf,
  mulberry32,
} from "@angels-bandits/common/city";
import {
  type CollapseField,
  type CollapseWire,
  PANCAKE,
  TOPPLE,
  collapseChunks,
  collapseWire,
  demolitionPlan,
  planCollapses,
} from "@angels-bandits/common/city/collapse";
import { COLLAPSE_CAP, DESTROY_CAP } from "@angels-bandits/common/constants";
import { wrapDeltaAxis } from "@angels-bandits/common/world";

/** Staged ids start here: far above any id a room mints in a session. */
export const QA_ID_BASE = 2 ** 30;

/** A block broken by sustained fire: a seeded share of the chunks of every
 * building whose footprint centre lies within `r` of (x, z), then the
 * collapses that leaves owing — the first at `t`, each next `stepMs` on. */
export interface StageArea {
  x: number;
  z: number;
  r: number;
  share: number;
  seed: number;
  /** Server (world) time of the first collapse, ms. */
  t: number;
  stepMs: number;
  /** How many buildings the area must hold (the generator guard). */
  buildings: number;
}

/** One tower brought down whole (D5's demolition) at world time `t`. */
export interface StageFell {
  b: number;
  /** Its height, rounded to the metre (the generator guard). */
  h: number;
  style: "topple" | "pancake";
  /** Topple direction, DIR_* (−x, +x, −z, +z). */
  dir: number;
  t: number;
}

export interface StageResult {
  wires: CollapseWire[];
  /** Chunks broken by the area. */
  broken: number;
  /** Buildings the area touched. */
  touched: number[];
}

/**
 * Stage `area` and `fell` on `damage` / `field` (both bound to `buildings`).
 * `ids.next` is the next collapse id to mint. Pure in its inputs: the same
 * spec on the same city stages the same chunks and the same wires.
 */
export function stageDestruction(
  buildings: readonly Building[],
  damage: CityDamage,
  field: CollapseField,
  spec: { area?: StageArea; fell?: readonly StageFell[] },
  ids: { next: number },
): StageResult {
  const wires: CollapseWire[] = [];
  const touched: number[] = [];
  let broken = 0;
  const area = spec.area;
  if (area) {
    buildings.forEach((b, i) => {
      const dx = wrapDeltaAxis(area.x, b.x);
      const dz = wrapDeltaAxis(area.z, b.z);
      if (dx * dx + dz * dz <= area.r * area.r) touched.push(i);
    });
    if (touched.length !== area.buildings) {
      throw new Error(
        `qaDestruction: ${touched.length} buildings within ${area.r} m of (${area.x}, ${area.z}), the spec expects ${area.buildings} — the city changed`,
      );
    }
    const room = Math.floor(DESTROY_CAP * damage.chunkCount);
    const rand = mulberry32(area.seed);
    const pick: number[] = [];
    for (const i of touched) {
      for (const id of chunksOf(buildings[i] as Building, i)) {
        // One draw per chunk, whatever happens to it: the stream stays
        // aligned with the city, not with what is already broken.
        if (rand() >= area.share || damage.isGone(id)) continue;
        if (damage.destroyedCount + pick.length >= room) break;
        pick.push(id);
      }
    }
    damage.apply(pick);
    broken = pick.length;
    const capped = () =>
      damage.destroyedCount + damage.fallenCount >=
      COLLAPSE_CAP * damage.chunkCount;
    for (const i of touched) {
      if (capped()) break;
      for (const plan of planCollapses(buildings[i] as Building, i)) {
        const t = area.t + wires.length * area.stepMs;
        wires.push(record(damage, field, collapseWire(plan, i, ids.next++, t)));
      }
    }
  }
  for (const f of spec.fell ?? []) {
    const b = buildings[f.b];
    if (!b || Math.round(b.height) !== f.h) {
      throw new Error(
        `qaDestruction: building ${f.b} is ${b ? Math.round(b.height) : "missing"} m tall, the spec expects ${f.h} m — the city changed`,
      );
    }
    const style = f.style === "pancake" ? PANCAKE : TOPPLE;
    const plan = demolitionPlan(b, f.b, style, f.dir);
    if (!plan)
      throw new Error(
        `qaDestruction: building ${f.b} has nothing left to fell`,
      );
    wires.push(record(damage, field, collapseWire(plan, f.b, ids.next++, f.t)));
  }
  return { wires, broken, touched };
}

/** recordCollapse's client half: the chunks fall, the debris starts. */
function record(
  damage: CityDamage,
  field: CollapseField,
  wire: CollapseWire,
): CollapseWire {
  damage.collapse(collapseChunks(wire));
  field.add(wire);
  return wire;
}

/** Fire: a death blast at (x, y, z) at world time `t` — through the D1
 * BlastLedger, so it blows out and scorches the facades around it and
 * leaves them burning, exactly as a server death event would. */
export interface StageBlast {
  x: number;
  y: number;
  z: number;
  t: number;
}

/** A downed plane's wreck (D4): the path from its death at `t`. `hit` is
 * what its sweep must strike (the guard): a "city" hit leaves no street
 * scorch behind, so clearing it leaves nothing drawn. */
export interface StageWreck {
  p: { x: number; y: number; z: number };
  v: { x: number; y: number; z: number };
  t: number;
  spin: 1 | -1;
  hit: string;
}

/** What `__ab.qaDestruction` stages. Without `keep` the staged state is
 * cleared back to intact first. */
export interface QaDestructionSpec {
  area?: StageArea;
  fell?: StageFell[];
  blasts?: StageBlast[];
  wrecks?: StageWreck[];
  keep?: boolean;
}
