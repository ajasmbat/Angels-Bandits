// E1 QA (`__ab.qaAirforce`, main.ts): an air force of `n` enemy planes
// staged round a point on this client, as if the server's pilots were
// flying there — QA only, never from gameplay. The gallery's room has no
// war (AB_WAVES=0), so this is how `airforce-swarm` puts 500 planes round
// the camera.
//
// I1: every plane flies ALONE, a pure function of (spec, time, grid) — its
// own seeded personality (common/src/pilots.ts personalityOf) picks its
// loop round its own centre (somewhere within 900 m of the point), its
// radius, way round, speed, height and weave, so no two share a track and
// nothing flies in formation. Each one is a snapshot entry through the
// real client path: it rides each real snapshot that lands, into the same
// remotes, buffers, LOD and fleet draws. Kept over the roofline the live
// pilots follow.

import {
  PILOT_CLEAR,
  type RooflineGrid,
  attitudeQuatInto,
  personalityOf,
} from "@angels-bandits/common/pilots";
import type { SnapshotMsg } from "@angels-bandits/common/protocol";
import { wrapCoord } from "@angels-bandits/common/world";

export interface QaAirforceSpec {
  /** Enemy planes to stage. */
  n: number;
  /** The point they fly round (the camera's, usually). */
  x: number;
  z: number;
}

/** The id prefix of a staged plane (`bot:` — an enemy to every reader). */
export const QA_AIRFORCE_PREFIX = "bot:qa-air:";

/** Every staged plane's id (for the roster). */
export function qaAirforceIds(n: number): string[] {
  return Array.from({ length: Math.max(0, n) }, (_, i) => {
    return `${QA_AIRFORCE_PREFIX}${i}`;
  });
}

/**
 * Append the staged air force at server time `timeMs` to `snap` — one
 * entry per plane, each on its own path. Pure in (spec, time, grid).
 */
export function qaAirforceExtend(
  spec: QaAirforceSpec,
  snap: SnapshotMsg,
  grid: RooflineGrid,
): void {
  const t = snap.time / 1000;
  for (let k = 0; k < spec.n; k++) {
    const ps = personalityOf(k);
    // Its own loop: a centre within 900 m of the point, a radius, a way
    // round and a speed — every one a draw of its personality.
    const ca = ps.weavePhase * 7.3;
    const cd = 900 * Math.sqrt((ps.risk + ps.skill * 0.37) % 1);
    const r = 90 + ps.aggression * 420;
    const dir = ps.side;
    const speed = ps.speed;
    const th = k * 2.399 + (dir * speed * t) / r;
    // The weave swings the loop in and out: no two circles are alike.
    const rr =
      r + ps.weaveAmp * 160 * Math.sin(t * ps.weaveHz * 6.28 + ps.weavePhase);
    const x = wrapCoord(spec.x + Math.cos(ca) * cd + Math.cos(th) * rr);
    const z = wrapCoord(spec.z + Math.sin(ca) * cd + Math.sin(th) * rr);
    // Heading along the loop (yaw 0 faces −Z): dir × (−sin, cos).
    const vx = -Math.sin(th) * dir;
    const vz = Math.cos(th) * dir;
    const yaw = Math.atan2(-vx, -vz);
    const alt = 110 + ps.prefAlt * 3 + 25 * Math.sin(t * 0.3 + k);
    const pose = {
      pos: { x, y: Math.max(alt, grid.ahead(x, z) + PILOT_CLEAR), z },
      quat: { x: 0, y: 0, z: 0, w: 1 },
      speed,
    };
    // Its own lean: how hard it banks into the loop.
    const lean = Math.atan((speed * speed) / (rr * 9.81)) * ps.bank;
    attitudeQuatInto(yaw, 0, -dir * Math.min(1.1, lean), pose.quat);
    snap.players.push({
      id: `${QA_AIRFORCE_PREFIX}${k}`,
      pose,
      hp: 100,
      prot: false,
    });
  }
}
