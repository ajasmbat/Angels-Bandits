// DL1 Destruction Lab — what the lab can set off, shared by the client (its
// buttons) and the server (server/src/destruct-lab.ts runs each one through
// the room's real destruction pipeline: rays, blasts, D5 demolitions, the
// planner). A trigger names a building of the room's city and, depending on
// its kind, an aim point, the shooter's eye, a direction, a corner or a
// floor band. `parseLabTrigger` is the one gate between a socket and the
// executor: anything it returns is in range for the city it was given.

import { tierGrids } from "./city/destruction";
import type { Building } from "./city/index";
import { type Vec3, canonicalize } from "./world/index";

/** Every trigger, in the panel's order. */
export const LAB_TRIGGERS = [
  "shoot",
  "bomb",
  "missile",
  "pancake",
  "topple",
  "shear",
  "charge",
  "lean",
  "neighbour",
  "chain",
] as const;
export type LabTriggerKind = (typeof LAB_TRIGGERS)[number];

export const LAB_TRIGGER_NAMES: Record<LabTriggerKind, string> = {
  shoot: "Shoot",
  bomb: "Bomb",
  missile: "Missile",
  pancake: "Pancake",
  topple: "Topple",
  shear: "Shear a corner",
  charge: "Floor charge",
  lean: "Lean",
  neighbour: "Hit neighbour",
  chain: "Chain the block",
};

export const LAB_TRIGGER_HINTS: Record<LabTriggerKind, string> = {
  shoot:
    "Sustained gunfire at the aim point for a couple of seconds, from where you are.",
  bomb: "An enemy bomb (W2) dropped onto the aim point.",
  missile: "A cruise missile flown into the aim point.",
  pancake:
    "A demolition charge under the second floor: it drops straight down.",
  topple: "The same charge, but it tips over in the chosen direction.",
  shear: "Cuts away one corner's support: that wing shears off.",
  charge: "Blows out the whole of the chosen floor.",
  lean: "Blows out the chosen floor on the chosen side only: its columns fail there and the tower leans over and hinges (DS1).",
  neighbour: "Topples the tower into its nearest neighbour.",
  chain:
    "Fells every tower in the block one after another, each into the next.",
};

/** Which extra inputs a kind reads. */
export const TRIGGER_NEEDS: Record<
  LabTriggerKind,
  { point?: true; dir?: true; corner?: true; floor?: true }
> = {
  shoot: { point: true },
  bomb: { point: true },
  missile: { point: true },
  pancake: {},
  topple: { dir: true },
  shear: { corner: true },
  charge: { floor: true },
  lean: { floor: true, dir: true },
  neighbour: {},
  chain: {},
};

export interface LabTrigger {
  k: LabTriggerKind;
  /** Building index in the room's city. */
  b: number;
  /** The aim point (canonical world position) — shoot, bomb, missile. */
  p?: Vec3;
  /** The shooter's eye (canonical) — shoot. */
  o?: Vec3;
  /** DIR_* topple direction (−x, +x, −z, +z) — topple, lean. */
  d?: number;
  /** Corner 0..3 (bit 0: +x side, bit 1: +z side) — shear. */
  c?: number;
  /** Tier-0 floor band — charge, lean. */
  f?: number;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const vec = (v: unknown): Vec3 | undefined =>
  isObj(v) &&
  Number.isFinite(v.x) &&
  Number.isFinite(v.y) &&
  Number.isFinite(v.z)
    ? canonicalize({
        x: v.x as number,
        y: Math.min(2000, Math.max(-50, v.y as number)),
        z: v.z as number,
      })
    : undefined;

const intIn = (v: unknown, lo: number, hi: number, d: number): number =>
  typeof v === "number" && Number.isFinite(v)
    ? Math.min(hi, Math.max(lo, Math.round(v)))
    : d;

/** A wire `trigger` → a valid LabTrigger for `buildings`, or null. */
export function parseLabTrigger(
  raw: unknown,
  buildings: readonly Building[],
): LabTrigger | null {
  if (!isObj(raw)) return null;
  const k = raw.k;
  if (typeof k !== "string" || !LAB_TRIGGERS.includes(k as LabTriggerKind)) {
    return null;
  }
  const kind = k as LabTriggerKind;
  const b = raw.b;
  if (typeof b !== "number" || !Number.isInteger(b)) return null;
  const building = buildings[b];
  if (!building) return null;
  const need = TRIGGER_NEEDS[kind];
  const out: LabTrigger = { k: kind, b };
  if (need.point) {
    const p = vec(raw.p);
    if (!p) return null;
    out.p = p;
    const o = vec(raw.o);
    if (o) out.o = o;
  }
  if (need.dir) out.d = intIn(raw.d, 0, 3, 1);
  if (need.corner) out.c = intIn(raw.c, 0, 3, 3);
  if (need.floor) {
    const ny = tierGrids(building)[0]?.ny ?? 1;
    out.f = intIn(raw.f, 0, ny - 1, Math.min(1, ny - 1));
  }
  return out;
}
