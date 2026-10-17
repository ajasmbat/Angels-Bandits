// E1 QA (`__ab.qaAirforce`, main.ts): an air force of `n` enemy planes
// staged round a point on this client, as if the server's squadrons were
// flying there — QA only, never from gameplay. The gallery's room has no
// war (AB_WAVES=0), so this is how `airforce-swarm` puts 500 planes round
// the camera.
//
// Every squadron is a WIRE ROW, built and expanded exactly as a live one
// (common/src/squadron.ts encodeSquadRow → expandSquadRow), so the shot
// exercises the real client path: the rows ride each real snapshot that
// lands (their poses a pure function of its time), into the same remotes,
// buffers, LOD and fleet draws. A squadron circles the point at its own
// radius (120–820 m) and height, kept over the roofline the live
// squadrons follow.

import type { Pose, SnapshotMsg } from "@angels-bandits/common/protocol";
import {
  FORMATIONS,
  type RooflineGrid,
  SQUAD_CLEAR,
  SQUAD_SIZE,
  attitudeQuatInto,
  encodeSquadRow,
  expandSquadRow,
} from "@angels-bandits/common/squadron";
import { wrapCoord } from "@angels-bandits/common/world";

export interface QaAirforceSpec {
  /** Enemy planes to stage. */
  n: number;
  /** The point they circle (the camera's, usually). */
  x: number;
  z: number;
}

/** The id prefix of a staged plane (`bot:` — an enemy to every reader). */
export const QA_AIRFORCE_PREFIX = "bot:qa-air:";

/** Squadrons for `n` planes. */
export const qaSquadrons = (n: number): number =>
  Math.ceil(Math.max(0, n) / SQUAD_SIZE);

/** Every staged plane's id (for the roster). */
export function qaAirforceIds(n: number): string[] {
  return Array.from({ length: Math.max(0, n) }, (_, i) => {
    return `${QA_AIRFORCE_PREFIX}${i}`;
  });
}

const anchor: Pose = {
  pos: { x: 0, y: 0, z: 0 },
  quat: { x: 0, y: 0, z: 0, w: 1 },
  speed: 0,
};

/**
 * Append the staged air force at server time `timeMs` to `snap` — one
 * squadron row per SQUAD_SIZE planes, expanded into its planes. Pure in
 * (spec, time, grid).
 */
export function qaAirforceExtend(
  spec: QaAirforceSpec,
  snap: SnapshotMsg,
  grid: RooflineGrid,
): void {
  const squads = qaSquadrons(spec.n);
  const t = snap.time / 1000;
  for (let k = 0; k < squads; k++) {
    const r = 120 + ((k * 137) % 700);
    const speed = 70 + (k % 5) * 2;
    const dir = k % 2 === 0 ? 1 : -1;
    const th = k * 2.399 + (dir * speed * t) / r;
    const x = wrapCoord(spec.x + Math.cos(th) * r);
    const z = wrapCoord(spec.z + Math.sin(th) * r);
    // Heading along the circle (yaw 0 faces −Z): the derivative of the
    // position, dir × (−sin, cos).
    const vx = -Math.sin(th) * dir;
    const vz = Math.cos(th) * dir;
    const yaw = Math.atan2(-vx, -vz);
    const alt = 140 + ((k * 53) % 220);
    anchor.pos.x = x;
    anchor.pos.z = z;
    anchor.pos.y = Math.max(alt, grid.ahead(x, z) + SQUAD_CLEAR);
    attitudeQuatInto(yaw, 0, -dir * 0.35, anchor.quat);
    anchor.speed = speed;
    const count = Math.min(SQUAD_SIZE, spec.n - k * SQUAD_SIZE);
    const mask = (1 << count) - 1;
    expandSquadRow(
      encodeSquadRow({
        id0: `${QA_AIRFORCE_PREFIX}${k * SQUAD_SIZE}`,
        anchor,
        form: k % FORMATIONS.length,
        spread: 1,
        prot: false,
        mask,
        hp: Array.from({ length: count }, () => 100),
      }),
      snap.players,
    );
  }
}
