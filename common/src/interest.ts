// E1 Air force — interest management on the wire, the pure half. With
// hundreds of enemies a room can no longer send every plane to every client
// at TICK_DOWN_HZ, so each client gets its OWN snapshot (server/src/index.ts
// builds it from rows encoded once per tick):
//
//  - every human, always (there are at most ROOM_CAP of them, and the
//    receiver's own row carries its HP and protection);
//  - an enemy row within IM_NEAR_M of the viewer every tick — the near tier
//    reaches past the camera's far plane (FOG_DISTANCE + 100), so anything
//    that can be drawn is at full rate;
//  - from there to half the world (IM_FAR_M), every IM_MID_EVERY-th tick
//    (5 Hz), the rows staggered over the ticks by their phase so a snapshot
//    never carries them all at once — the radar's planes;
//  - nothing beyond.
//
// A squadron row counts as near when any of its planes could be (its
// distance less the formation's reach). An enemy missing from a snapshot is
// therefore NOT dead: the client lets it go stale after IM_STALE_MS and
// takes deaths from the `death` messages, as it always has.
//
// Not re-exported from common/src/index.ts; import
// "@angels-bandits/common/interest".

import { FOG_DISTANCE, SNAPSHOT_INTERVAL_MS, WORLD_SIZE } from "./constants";
import { type Vec3, wrapDistance } from "./world/index";

/** Full rate within this of the viewer, m: the far plane (FOG_DISTANCE +
 * 100) plus half a second of closing at top speed. */
export const IM_NEAR_M = FOG_DISTANCE + 150;
/** Nothing beyond this, m: half the world. */
export const IM_FAR_M = WORLD_SIZE / 2;
/** The mid tier rides every this-many ticks (20 Hz / 4 = 5 Hz). */
export const IM_MID_EVERY = 4;
/** A client hides an enemy it has not heard of for this long, ms: two and a
 * half mid-tier periods, so one lost mid row never blinks a plane. */
export const IM_STALE_MS = SNAPSHOT_INTERVAL_MS * IM_MID_EVERY * 2.5;

export const TIER_NONE = 0;
export const TIER_MID = 1;
export const TIER_NEAR = 2;
export type InterestTier = 0 | 1 | 2;

/** The tier of something `dist` m from the viewer whose planes spread
 * `reach` m round that point. */
export function interestTier(dist: number, reach = 0): InterestTier {
  const d = dist - reach;
  if (d <= IM_NEAR_M) return TIER_NEAR;
  if (d <= IM_FAR_M) return TIER_MID;
  return TIER_NONE;
}

/** Does a row of `tier` with stagger `phase` ride snapshot number `tick`? */
export function sendsOnTick(
  tier: InterestTier,
  tick: number,
  phase: number,
): boolean {
  if (tier === TIER_NEAR) return true;
  if (tier === TIER_MID) return (tick + phase) % IM_MID_EVERY === 0;
  return false;
}

/** One pre-encoded snapshot row and where it is. */
export interface InterestRow {
  /** The JSON of the row (encoded once per tick for every client). */
  json: string;
  pos: Vec3;
  /** How far its planes spread round `pos`, m (a squadron's reach; 0 for
   * one plane). */
  reach: number;
  /** Mid-tier stagger, any integer (a stable per-row number). */
  phase: number;
  /** Sent to everyone every tick whatever the distance (the humans). */
  always: boolean;
  /** A squadron row (the snapshot's `s`), not a plane (`p`). */
  squad: boolean;
}

/**
 * The rows snapshot `tick` sends a viewer at `viewer` (null: not in the air
 * yet — the humans only), pushed onto `planes` / `squads` as JSON. Pure.
 */
export function selectRows(
  viewer: Vec3 | null,
  rows: readonly InterestRow[],
  tick: number,
  planes: string[],
  squads: string[],
): void {
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] as InterestRow;
    let send = r.always;
    if (!send && viewer) {
      send = sendsOnTick(
        interestTier(wrapDistance(viewer, r.pos), r.reach),
        tick,
        r.phase,
      );
    }
    if (!send) continue;
    if (r.squad) squads.push(r.json);
    else planes.push(r.json);
  }
}

/** The whole snapshot message for one client, as the text that goes out —
 * the same JSON `JSON.stringify` of a WireSnapshotMsg would make. */
export function snapshotJson(
  time: number,
  planes: readonly string[],
  squads: readonly string[],
): string {
  const s = squads.length > 0 ? `,"s":[${squads.join(",")}]` : "";
  return `{"type":"snapshot","time":${time},"p":[${planes.join(",")}]${s}}`;
}
