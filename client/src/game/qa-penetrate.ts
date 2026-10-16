// P1 QA (`__ab.qaPenetrate(kind)`): stage one penetrating impact into a
// tower on this client only — meant for a quiet room (AB_QUIET_CITY) and a
// fixed QA camera. Pure planning lives here (which tower, which impactor,
// the strike or wreck that flies it in, and a camera that sees the whole
// tunnel side-on); main.ts replays the record through the same
// Penetrations path a server `impact` takes and breaks the tunnel's chunks
// on this client at their entry times (draw == collide, locally).
//
//  - "plane": a shot-down fighter's airframe (a D4 wreck) flown level into
//    a tower's flank at 85 m/s — it ploughs through and out.
//  - "meteor": a meteor streak onto the tower's roof, down through floors.
//  - "comet": a comet's shallow streak into the tower, sideways through
//    the row behind it.

import type { Building } from "@angels-bandits/common/city";
import { chunkBuilding } from "@angels-bandits/common/city";
import {
  IMPACTORS,
  IMPACT_COMET,
  IMPACT_METEOR,
  IMPACT_WRECK,
  type ImpactKind,
  type ImpactRecord,
  type SweepResult,
  makeImpact,
  sweepRecord,
} from "@angels-bandits/common/city/penetrate";
import { type CityIndex, losClear } from "@angels-bandits/common/collision";
import {
  COMET_FLIGHT_MS,
  METEOR_FLIGHT_MS,
  type MissileStrike,
  missileImpactVelocity,
} from "@angels-bandits/common/strike";
import { type Vec3, wrapCoord } from "@angels-bandits/common/world";
import {
  type WreckParams,
  wreckImpact,
  wreckPosAt,
  wreckVelAt,
} from "@angels-bandits/common/wreck";

export type QaPenetrateKind = "plane" | "meteor" | "comet";

export interface QaPenetratePlan {
  kind: QaPenetrateKind;
  /** The tower it goes into. */
  b: number;
  rec: ImpactRecord;
  res: SweepResult;
  /** What flies it in: a strike (meteor, comet) or a wreck (plane). */
  strike: MissileStrike | null;
  wreck: WreckParams | null;
  /** A fixed camera that sees the tunnel side-on. */
  eye: Vec3;
  at: Vec3;
}

/** Staged strike / wreck ids start here (clear of the server's). */
export const QA_PENETRATE_ID = 950_000;

const DIRS: readonly [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/** The impactor for `kind` into tower `b` along plan direction (dx, dz). */
function impactorFor(
  kind: QaPenetrateKind,
  b: Building,
  dx: number,
  dz: number,
): { k: ImpactKind; origin: Vec3; vel: Vec3 } {
  const reach = dx !== 0 ? b.width / 2 : b.depth / 2;
  if (kind === "meteor") {
    return {
      k: IMPACT_METEOR,
      origin: { x: b.x, y: b.height, z: b.z },
      vel: { x: dx * 60, y: -230, z: dz * 60 },
    };
  }
  const y = Math.min(b.height * 0.6, 140);
  const speed = kind === "comet" ? 220 : 85;
  return {
    k: kind === "comet" ? IMPACT_COMET : IMPACT_WRECK,
    origin: { x: b.x - dx * (reach + 1), y, z: b.z - dz * (reach + 1) },
    vel: { x: dx * speed, y: kind === "comet" ? -22 : -2, z: dz * speed },
  };
}

/**
 * Pick the tower and heading for `kind` (deterministic in the city): the
 * first tower 150–320 m tall whose tunnel reads well — a plane out of the
 * far side, a meteor 6+ floors down, a comet through 3+ buildings — else
 * the best seen. Null for a city with no such tower.
 */
export function planQaPenetrate(
  kind: QaPenetrateKind,
  buildings: readonly Building[],
  index: CityIndex,
  t: number,
): QaPenetratePlan | null {
  let best: {
    b: number;
    dx: number;
    dz: number;
    score: number;
  } | null = null;
  for (let i = 0; i < buildings.length; i++) {
    const b = buildings[i] as Building;
    if (b.holes || b.height < 150 || b.height > 320 || b.width < 30) continue;
    for (const [dx, dz] of DIRS) {
      const imp = impactorFor(kind, b, dx, dz);
      const rec = makeImpact(imp.k, t, imp.origin, imp.vel, 1);
      const res = sweepRecord(rec, buildings);
      const hit = new Set(res.chunks.map(chunkBuilding)).size;
      const score =
        kind === "comet"
          ? hit * 100 + res.chunks.length
          : kind === "meteor"
            ? res.chunks.length
            : res.chunks.length + (res.stopDist > b.width ? 50 : 0);
      if (!best || score > best.score) best = { b: i, dx, dz, score };
      const good =
        kind === "comet"
          ? hit >= 3
          : kind === "meteor"
            ? res.chunks.length >= 6
            : res.chunks.length >= 3 && res.stopDist > b.width;
      if (good) return finish(kind, buildings, index, i, dx, dz, t);
    }
  }
  return best
    ? finish(kind, buildings, index, best.b, best.dx, best.dz, t)
    : null;
}

function finish(
  kind: QaPenetrateKind,
  buildings: readonly Building[],
  index: CityIndex,
  bi: number,
  dx: number,
  dz: number,
  t: number,
): QaPenetratePlan {
  const b = buildings[bi] as Building;
  const imp = impactorFor(kind, b, dx, dz);
  const id =
    QA_PENETRATE_ID + (kind === "plane" ? 0 : kind === "meteor" ? 1 : 2);
  let strike: MissileStrike | null = null;
  let wreck: WreckParams | null = null;
  let rec = makeImpact(imp.k, t, imp.origin, imp.vel, id);
  if (kind === "plane") {
    // A fighter flying in level from 45 m out: the D4 wreck path, so the
    // airframe that hits is the one drawn ploughing on.
    const lead = 45 / 85;
    const path = {
      p: {
        x: wrapCoord(imp.origin.x - dx * 45),
        y: imp.origin.y,
        z: wrapCoord(imp.origin.z - dz * 45),
      },
      v: imp.vel,
      t: t - lead * 1000,
      spin: 1 as const,
    };
    const hit = wreckImpact(path, { buildings, index });
    wreck = { id, ...path, end: hit.end, hit: hit.hit };
    const at = path.t + hit.end;
    rec = makeImpact(
      IMPACT_WRECK,
      at,
      wreckPosAt(wreck, at, { x: 0, y: 0, z: 0 }),
      wreckVelAt(wreck, at, { x: 0, y: 0, z: 0 }),
      id,
      (IMPACTORS[IMPACT_WRECK] as (typeof IMPACTORS)[number]).mass,
    );
  } else {
    // The strike that flies it in: a meteor from high over the tower, a
    // comet from 750 m back along its shallow line.
    const flight = kind === "comet" ? COMET_FLIGHT_MS : METEOR_FLIGHT_MS;
    const v = rec.velocity;
    const sp = Math.hypot(v.x, v.y, v.z) || 1;
    const run = kind === "comet" ? 750 : 1050 / (Math.abs(v.y) / sp);
    const from = {
      x: wrapCoord(rec.origin.x - (v.x / sp) * run),
      y: rec.origin.y - (v.y / sp) * run,
      z: wrapCoord(rec.origin.z - (v.z / sp) * run),
    };
    strike = {
      id,
      kind,
      from: {
        x: Math.round(from.x * 10) / 10,
        y: Math.round(from.y * 10) / 10,
        z: Math.round(from.z * 10) / 10,
      },
      to: { ...rec.origin },
      t0: Math.round(t - flight),
    };
    // The record carries the strike's own arrival velocity (as the server's).
    rec = makeImpact(
      imp.k,
      t,
      rec.origin,
      missileImpactVelocity(strike, { x: 0, y: 0, z: 0 }),
      id,
    );
  }
  const res = sweepRecord(rec, buildings);
  const { eye, at } = cameraFor(rec, res, buildings);
  return { kind, b: bi, rec, res, strike, wreck, eye, at };
}

/**
 * A fixed camera on the impact: it looks at the entry hole (a little way
 * into the tunnel), from 45–75° off the line it came in on, 60–180 m out
 * and above it — the first such eye with a clear line of sight to the hole
 * (and just over it), searched nearest first. Falls back to straight back
 * along the incoming line, high.
 */
function cameraFor(
  rec: ImpactRecord,
  res: SweepResult,
  buildings: readonly Building[],
): { eye: Vec3; at: Vec3 } {
  const d = res.dir;
  const h = Math.hypot(d.x, d.z) || 1;
  // The incoming line's reverse in plan (straight down: any heading).
  const bx = h > 0.2 ? -d.x / h : 1;
  const bz = h > 0.2 ? -d.z / h : 0;
  const entry = {
    x: wrapCoord(rec.origin.x - d.x * 4),
    y: Math.max(2, rec.origin.y - d.y * 4),
    z: wrapCoord(rec.origin.z - d.z * 4),
  };
  const above = { x: entry.x, y: entry.y + 15, z: entry.z };
  const into = Math.min(50, res.stopDist / 3);
  const at = {
    x: wrapCoord(rec.origin.x + d.x * into),
    y: Math.max(4, rec.origin.y + d.y * into),
    z: wrapCoord(rec.origin.z + d.z * into),
  };
  for (const dist of [60, 90, 130, 180]) {
    for (const lift of [15, 45, 90]) {
      for (const deg of [55, -55, 70, -70, 40, -40]) {
        const a = (deg * Math.PI) / 180;
        const c = Math.cos(a);
        const sn = Math.sin(a);
        const eye = {
          x: wrapCoord(entry.x + (bx * c - bz * sn) * dist),
          y: entry.y + lift,
          z: wrapCoord(entry.z + (bz * c + bx * sn) * dist),
        };
        if (
          losClear(eye, entry, buildings) &&
          losClear(eye, above, buildings)
        ) {
          return { eye, at };
        }
      }
    }
  }
  return {
    eye: {
      x: wrapCoord(entry.x + bx * 150),
      y: entry.y + 120,
      z: wrapCoord(entry.z + bz * 150),
    },
    at,
  };
}
