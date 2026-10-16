// C1 QA (`__ab.qaLowChaos`, main.ts): a low run down a canyon with the city
// coming apart ahead, staged on this client as if the server's low-flying
// chaos (server/src/director.ts) had been at it for a few seconds — QA only,
// never from gameplay.
//
// The server picks its low events off the live fight; the gallery's quiet
// room sends none. So this picks the same KINDS round a held pose, a pure
// function of the pose, the render instant and the city: ahead along the
// nose (yaw 0 faces −Z), a tower already toppling (D5's demolition, through
// qaDestruction's `fell`), a second pouring dust out of its windows, a
// facade cracking and one about to peel, a gas main just blown and one
// venting steam, a roof tank going over and another's footing shearing, a
// car chain going up and a fire taking hold under the next car (D9 props
// down through qaDestruction's `props`), and a bridge span when one is in
// reach. Every warning is a DirectorEvent exactly as `directorWarn` carries
// it — the same tells, sirens and (as the render clock passes each one's
// instant) the same bursts a live room shows.

import { type Building, tierGrids } from "@angels-bandits/common/city";
import {
  DIR_NEG_X,
  DIR_NEG_Z,
  DIR_POS_X,
  DIR_POS_Z,
  TOPPLE,
} from "@angels-bandits/common/city/collapse";
import {
  PROP_BILLBOARD,
  PROP_BRIDGE,
  PROP_CAR,
  PROP_KIND_NAMES,
  PROP_TANK,
  PROP_TAXI,
  type Prop,
  type PropLayout,
  type PropState,
} from "@angels-bandits/common/city/props";
import {
  type DirectorEvent,
  EVENT_CARS,
  EVENT_COLLAPSE,
  EVENT_FACADE,
  EVENT_GAS,
  EVENT_ROOF,
  EVENT_SPAN,
  GAS_BLAST_M,
  gasMainNear,
} from "@angels-bandits/common/director";
import {
  type Vec3,
  wrapCoord,
  wrapDeltaAxis,
} from "@angels-bandits/common/world";
import type { StageFell, StagePropDown } from "./qa-destruction";

/** Staged warnings are numbered from here (far above a room's ids). */
export const QA_LOW_ID_BASE = 2 ** 30 + 4096;

/** The held low view: position and yaw (yaw 0 faces −Z). */
export interface QaLowChaosSpec {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

export interface QaLowChaosPlan {
  /** Warnings for the socket's director map (some already gone off). */
  events: DirectorEvent[];
  /** Towers already coming down (qaDestruction `fell`). */
  fell: StageFell[];
  /** Props already down (qaDestruction `props.down`). */
  down: StagePropDown[];
  /** Gas mains that have just blown (DirectorFx.gasBlast). */
  gas: Vec3[];
}

/**
 * Plan the low run round `spec` at render instant `t0`. Pure in its inputs;
 * kinds the city has nothing for near the pose are left out.
 */
export function planQaLowChaos(
  spec: QaLowChaosSpec,
  t0: number,
  buildings: readonly Building[],
  layout: PropLayout,
  state: PropState,
  seed: number,
): QaLowChaosPlan {
  const fx = -Math.sin(spec.yaw);
  const fz = -Math.cos(spec.yaw);
  const rx = Math.cos(spec.yaw);
  const rz = -Math.sin(spec.yaw);
  const point = (ahead: number, side = 0): Vec3 => ({
    x: wrapCoord(spec.x + fx * ahead + rx * side),
    y: spec.y,
    z: wrapCoord(spec.z + fz * ahead + rz * side),
  });
  /** Along-the-nose and to-the-right offsets of (x, z) from the view. */
  const local = (x: number, z: number) => {
    const dx = wrapDeltaAxis(spec.x, x);
    const dz = wrapDeltaAxis(spec.z, z);
    return { ahead: dx * fx + dz * fz, side: dx * rx + dz * rz };
  };
  const alongX = Math.abs(fx) >= Math.abs(fz);
  let id = QA_LOW_ID_BASE;
  const events: DirectorEvent[] = [];
  const warn = (
    k: number,
    b: number,
    at: Vec3,
    w: number,
    fire: number,
    s = 0,
    d = 0,
    reach = 10,
  ) => {
    events.push({
      id: id++,
      k,
      b,
      x: Math.round(at.x * 10) / 10,
      y: Math.round(at.y * 10) / 10,
      z: Math.round(at.z * 10) / 10,
      s,
      d,
      w: t0 + w,
      at: t0 + fire,
      zone: { x0: -reach, x1: reach, z0: -reach, z1: reach, top: 60 },
    });
  };

  // Towers beside the path ahead, nearest first.
  const towers: { i: number; ahead: number; side: number }[] = [];
  buildings.forEach((b, i) => {
    if (b.height < 60 || b.holes || (tierGrids(b)[0]?.ny ?? 0) < 3) return;
    const o = local(b.x, b.z);
    const half = Math.max(b.width, b.depth) / 2;
    if (o.ahead < 80 || o.ahead > 420 || Math.abs(o.side) > half + 110) return;
    if (Math.abs(o.side) < half + 12) return; // not across the street itself
    towers.push({ i, ...o });
  });
  towers.sort((a, b) => a.ahead - b.ahead || a.i - b.i);
  /** Topple away from the path. */
  const away = (i: number): number => {
    const b = buildings[i] as Building;
    const s = alongX
      ? Math.sign(wrapDeltaAxis(spec.z, b.z)) || 1
      : Math.sign(wrapDeltaAxis(spec.x, b.x)) || 1;
    return alongX
      ? s > 0
        ? DIR_POS_Z
        : DIR_NEG_Z
      : s > 0
        ? DIR_POS_X
        : DIR_NEG_X;
  };
  const fell: StageFell[] = [];
  const felled = towers[1] ?? towers[0];
  if (felled) {
    const b = buildings[felled.i] as Building;
    const dir = away(felled.i);
    fell.push({
      b: felled.i,
      h: Math.round(b.height),
      style: "topple",
      dir,
      t: t0 - 2500,
    });
    const at = { x: b.x, y: 0, z: b.z };
    warn(EVENT_COLLAPSE, felled.i, at, -5500, -2500, TOPPLE, dir, 60);
  }
  const pouring = towers.find((t) => t !== felled);
  if (pouring) {
    const b = buildings[pouring.i] as Building;
    warn(
      EVENT_COLLAPSE,
      pouring.i,
      { x: b.x, y: 0, z: b.z },
      -1200,
      1800,
      TOPPLE,
      away(pouring.i),
      60,
    );
  }

  // Facades facing the path ahead: one cracking, one about to peel.
  const faces: { i: number; d: number; at: Vec3; ahead: number }[] = [];
  buildings.forEach((b, i) => {
    if (b.height < 40 || (felled && i === felled.i)) return;
    const o = local(b.x, b.z);
    if (o.ahead < 90 || o.ahead > 320) return;
    const hw = (b.tiers[0]?.width ?? b.width) / 2;
    const hd = (b.tiers[0]?.depth ?? b.depth) / 2;
    const halfSide = alongX ? hd : hw;
    if (Math.abs(o.side) < halfSide + 10 || Math.abs(o.side) > halfSide + 40) {
      return;
    }
    // The face toward the path (the view's side of the building).
    const nx = alongX ? 0 : Math.sign(wrapDeltaAxis(b.x, spec.x)) || 1;
    const nz = alongX ? Math.sign(wrapDeltaAxis(b.z, spec.z)) || 1 : 0;
    const d =
      nx > 0 ? DIR_POS_X : nx < 0 ? DIR_NEG_X : nz > 0 ? DIR_POS_Z : DIR_NEG_Z;
    const p = point(o.ahead);
    const clamp = (v: number, h: number) =>
      Math.max(-h + 4, Math.min(h - 4, v));
    const ox = nx !== 0 ? nx * (hw + 0.5) : clamp(wrapDeltaAxis(b.x, p.x), hw);
    const oz = nz !== 0 ? nz * (hd + 0.5) : clamp(wrapDeltaAxis(b.z, p.z), hd);
    const y = Math.min(spec.y + 10, b.height - 6);
    if (y < 12) return;
    faces.push({
      i,
      d,
      at: { x: wrapCoord(b.x + ox), y, z: wrapCoord(b.z + oz) },
      ahead: o.ahead,
    });
  });
  faces.sort((a, b) => a.ahead - b.ahead || a.i - b.i);
  const [crack, peel] = faces;
  if (crack) warn(EVENT_FACADE, crack.i, crack.at, -800, 2200, 0, crack.d, 8);
  if (peel) warn(EVENT_FACADE, peel.i, peel.at, -2400, 600, 0, peel.d, 8);

  // Gas mains: one just blown beside the path, one venting further on.
  const gas: Vec3[] = [];
  const blown = gasMainNear(seed, point(140));
  if (blown) {
    gas.push({ x: blown.x, y: 0, z: blown.z });
    warn(EVENT_GAS, -1, blown, -3200, -200, 0, 0, GAS_BLAST_M);
  }
  const venting = gasMainNear(seed, point(300));
  if (
    venting &&
    (!blown ||
      Math.hypot(
        wrapDeltaAxis(blown.x, venting.x),
        wrapDeltaAxis(blown.z, venting.z),
      ) >
        2 * GAS_BLAST_M)
  ) {
    warn(EVENT_GAS, -1, venting, -1500, 1500, 0, 0, GAS_BLAST_M);
  }

  // Props near points ahead, nearest first.
  const near = (kinds: readonly number[], at: Vec3, r: number): Prop[] =>
    layout.props
      .filter(
        (p) =>
          kinds.includes(p.kind) &&
          !state.isDown(p.id) &&
          Math.hypot(wrapDeltaAxis(at.x, p.x), wrapDeltaAxis(at.z, p.z)) <= r,
      )
      .sort(
        (a, b) =>
          Math.hypot(wrapDeltaAxis(at.x, a.x), wrapDeltaAxis(at.z, a.z)) -
            Math.hypot(wrapDeltaAxis(at.x, b.x), wrapDeltaAxis(at.z, b.z)) ||
          a.id - b.id,
      );
  const name = (kind: number) => PROP_KIND_NAMES[kind] as string;
  const down: StagePropDown[] = [];

  // A roof tank over the edge, and another's footing shearing.
  const roofs = near([PROP_TANK, PROP_BILLBOARD], point(200), 140);
  const [over, shearing] = roofs;
  if (over) {
    down.push({
      kind: name(over.kind),
      near: { x: over.x, z: over.z },
      t: t0 - 700,
    });
    warn(EVENT_ROOF, over.id, over, -3700, -700);
  }
  if (shearing) warn(EVENT_ROOF, shearing.id, shearing, -2000, 1000);

  // A car chain going up, and a fire taking hold under the next car.
  const cars = near([PROP_CAR, PROP_TAXI], point(240), 100);
  const [first, second, kindling] = cars;
  if (first) {
    down.push({
      kind: name(first.kind),
      near: { x: first.x, z: first.z },
      t: t0 - 900,
      blast: 150,
    });
    warn(EVENT_CARS, first.id, first, -3900, -900);
  }
  if (second) {
    down.push({
      kind: name(second.kind),
      near: { x: second.x, z: second.z },
      t: t0 - 500,
      blast: 120,
    });
  }
  if (kindling) warn(EVENT_CARS, kindling.id, kindling, -1500, 1500);

  // A bridge span, when one is in reach.
  const [span] = near([PROP_BRIDGE], point(250), 260);
  if (span) warn(EVENT_SPAN, span.id, span, -1800, 1200);

  return { events, fell, down, gas };
}
