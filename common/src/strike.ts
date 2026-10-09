// X1 missile strikes — the shared, pure half. The SERVER decides when and
// where a missile comes in (server/src/strikes.ts) and broadcasts one event:
// (launch point, target, launch time, kind). Everything else is a pure
// function of that event and the synced clock, so every client flies the
// same missile along the same arc and sees it land on the same facade at
// the same server instant — and the server applies its damage then.
//
// Named MISSILE_* / MissileStrike on purpose: the storm (ST2) already owns
// `Strike`, and nothing here may read as — or be confused with — lightning.
// Not re-exported from common/src/index.ts; import "@angels-bandits/common/strike".

import { type Building, tierGrids } from "./city/index";
import { type CityIndex, forEachBuildingNear, losClear } from "./collision";
import { MAX_HP, WORLD_SIZE } from "./constants";
import {
  type Vec3,
  wrapCoord,
  wrapDelta,
  wrapDeltaAxis,
  wrapDistance,
} from "./world/index";

/** Launch → impact, ms. The broadcast leads the impact by all of it. */
export const MISSILE_FLIGHT_MS = 5000;
/** C2: a meteor's streak from high over the city to its impact, ms. */
export const METEOR_FLIGHT_MS = 4500;
/** C2: a bomb's fall from its bomber to the city, ms. Its run (and so every
 * bomb in it) is announced long before the drop. */
export const BOMB_FALL_MS = 2600;
/** The rising whistle starts this long before impact, ms. */
export const MISSILE_WHISTLE_MS = 2000;
/** The fairness floor: no missile is ever announced later than this before
 * it lands, ms (the telegraph test holds every path to it). */
export const MISSILE_TELEGRAPH_MIN_MS = 1800;
/** Planes inside this take damage (by distance), m. */
export const MISSILE_BLAST_RADIUS = 45;
/** ...and inside this the blast is lethal, m. */
export const MISSILE_LETHAL_RADIUS = 12;
/** Damage just outside the lethal radius; falls off linearly to 0. */
export const MISSILE_EDGE_DAMAGE = 55;
/** The target lands this far from the subject's predicted position, m. */
export const MISSILE_TARGET_MIN_M = 25;
export const MISSILE_TARGET_MAX_M = 80;
/** No plane's predicted (or current) position is ever this close to a
 * target, m — a missile is never aimed AT a plane. */
export const MISSILE_PLANE_CLEAR_M = 20;
/** D2 chunk damage at the impact: radius (point-to-box), m, and amount. */
export const MISSILE_CHUNK_RADIUS = 12;
export const MISSILE_CHUNK_DAMAGE = 300;
/** Launch distance from the target, m — out past the haze, and under
 * WORLD_SIZE / 2 so wrapDelta stays the true path. */
const LAUNCH_MIN_M = 700;
const LAUNCH_MAX_M = 900;
/** Damage-indicator / DamageMsg shooter id for missile damage. Player ids
 * are UUIDs and bots `bot:<room>:<n>`, so this can never name a plane. */
export const MISSILE_SHOOTER_ID = "@missile";

/** A cruise missile skims in low; an artillery round lobs in from on high.
 * C2 adds two more things that fall on the city along the same pipeline: a
 * meteor (a straight fiery streak from ~900 m up) and a bomb (dropped by a
 * bomber run, common/src/chaos.ts). */
export type MissileKind = "cruise" | "artillery" | "meteor" | "bomb";

/** Launch (or drop) → impact for each kind, ms. Every one of them is at
 * least MISSILE_TELEGRAPH_MIN_MS. */
export function missileFlightMs(kind: MissileKind): number {
  return kind === "meteor"
    ? METEOR_FLIGHT_MS
    : kind === "bomb"
      ? BOMB_FALL_MS
      : MISSILE_FLIGHT_MS;
}

/** A meteor hits harder and wider than a missile. */
export const METEOR_BLAST_RADIUS = 55;
export const METEOR_LETHAL_RADIUS = 14;
export const METEOR_CHUNK_RADIUS = 16;
export const METEOR_CHUNK_DAMAGE = 360;
/** A bomb is lighter than a missile: one floor's worth of chunks. */
export const BOMB_CHUNK_RADIUS = 10;
export const BOMB_CHUNK_DAMAGE = 240;

/** D2 chunk damage an impact of `kind` deals: radius (point-to-box), m,
 * and amount. */
export function missileChunkDamage(kind: MissileKind): {
  radius: number;
  damage: number;
} {
  if (kind === "meteor") {
    return { radius: METEOR_CHUNK_RADIUS, damage: METEOR_CHUNK_DAMAGE };
  }
  if (kind === "bomb") {
    return { radius: BOMB_CHUNK_RADIUS, damage: BOMB_CHUNK_DAMAGE };
  }
  return { radius: MISSILE_CHUNK_RADIUS, damage: MISSILE_CHUNK_DAMAGE };
}

/** One strike, exactly as broadcast. Positions are canonical and already on
 * the wire's 0.1 m grid, so the server and every client hold equal values. */
export interface MissileStrike {
  id: number;
  kind: MissileKind;
  from: Vec3;
  to: Vec3;
  /** Launch time, server clock ms. */
  t0: number;
}

/** Arc height over the straight launch → target line, by kind, m. */
const APEX: Record<MissileKind, number> = {
  cruise: 45,
  artillery: 480,
  meteor: 0,
  bomb: 0,
};

/** Server time the missile lands, ms. */
export const missileImpactAt = (s: MissileStrike): number =>
  s.t0 + missileFlightMs(s.kind);

/** When the whistle starts, ms (never before launch). */
export const missileWhistleAt = (s: MissileStrike): number =>
  missileImpactAt(s) - Math.min(MISSILE_WHISTLE_MS, missileFlightMs(s.kind));

const wrap = wrapCoord;

/**
 * Where the missile is at server time `t` (clamped to launch/impact):
 * horizontally along the shortest torus path, vertically the straight line
 * plus a parabolic arc. Exactly `to` at and after impact. Pure; writes into
 * `out` (allocation-free per frame) and returns it.
 */
export function missilePosAt(s: MissileStrike, t: number, out: Vec3): Vec3 {
  const u = Math.min(1, Math.max(0, (t - s.t0) / missileFlightMs(s.kind)));
  if (u <= 0) {
    out.x = s.from.x;
    out.y = s.from.y;
    out.z = s.from.z;
    return out;
  }
  if (u >= 1) {
    out.x = s.to.x;
    out.y = s.to.y;
    out.z = s.to.z;
    return out;
  }
  const dx = wrapDeltaAxis(s.from.x, s.to.x);
  const dz = wrapDeltaAxis(s.from.z, s.to.z);
  if (s.kind === "bomb") {
    // A dropped bomb: it keeps (most of) its bomber's way, slowing as drag
    // takes it, and falls faster and faster — u(2 − u) across, u² down.
    const h = u * (2 - u);
    out.x = wrap(s.from.x + dx * h);
    out.z = wrap(s.from.z + dz * h);
    out.y = s.from.y + (s.to.y - s.from.y) * u * u;
    return out;
  }
  out.x = wrap(s.from.x + dx * u);
  out.z = wrap(s.from.z + dz * u);
  out.y = s.from.y + (s.to.y - s.from.y) * u + 4 * APEX[s.kind] * u * (1 - u);
  return out;
}

/** Damage a plane `d` meters from the impact takes: lethal (MAX_HP) inside
 * the lethal radius, then MISSILE_EDGE_DAMAGE falling linearly to 0 at the
 * blast radius — MISSILE_* for missiles and bombs, METEOR_* for a meteor. */
export function missileDamage(d: number, kind: MissileKind = "cruise"): number {
  if (!(d >= 0)) return 0;
  const lethal =
    kind === "meteor" ? METEOR_LETHAL_RADIUS : MISSILE_LETHAL_RADIUS;
  const blast = kind === "meteor" ? METEOR_BLAST_RADIUS : MISSILE_BLAST_RADIUS;
  if (d <= lethal) return MAX_HP;
  if (d >= blast) return 0;
  return (MISSILE_EDGE_DAMAGE * (blast - d)) / (blast - lethal);
}

/** A plane as the target picker sees it: position and velocity (m/s). */
export interface MissilePlane {
  pos: Vec3;
  vel: Vec3;
}

/** Where `p` will be when a strike launched now lands (`flightMs` on —
 * a missile's by default), flying straight. */
export function predictedPos(
  p: MissilePlane,
  flightMs: number = MISSILE_FLIGHT_MS,
): Vec3 {
  const s = flightMs / 1000;
  return {
    x: wrap(p.pos.x + p.vel.x * s),
    y: Math.max(0, p.pos.y + p.vel.y * s),
    z: wrap(p.pos.z + p.vel.z * s),
  };
}

/** A chosen impact point and the outward normal of what it hits. */
export interface MissileTarget {
  to: Vec3;
  normal: Vec3;
}

/** The wire's 0.1 m grid, for heights. */
const q = (v: number): number => Math.round(v * 10) / 10;
/** A horizontal coordinate wrapped THEN put on the grid (wrapping a grid
 * value can leave it a float hair off, which the wire would not carry). */
const qc = (v: number): number => {
  const r = Math.round(wrap(v) * 10) / 10;
  return r >= WORLD_SIZE ? 0 : r;
};

/** The tier of `b` covering height `y` (null above the roof). */
function tierAt(b: Building, y: number) {
  for (const g of tierGrids(b)) {
    if (y >= g.baseY && y < g.baseY + g.height) return g;
  }
  return null;
}

/**
 * Pick an impact point for a strike on `subject`'s area: a facade, a roof or
 * the street, MISSILE_TARGET_MIN_M..MAX_M from where the subject will be at
 * impact, and at least MISSILE_PLANE_CLEAR_M from every plane's predicted
 * AND current position (`planes` should include the subject). Null when no
 * candidate in `tries` passes. Deterministic in `rand`.
 */
export function pickMissileTarget(
  rand: () => number,
  subject: MissilePlane,
  planes: readonly MissilePlane[],
  index: CityIndex,
  tries = 24,
  /** C2: the strike's flight time (a meteor's is shorter), ms. */
  flightMs: number = MISSILE_FLIGHT_MS,
): MissileTarget | null {
  const aim = predictedPos(subject, flightMs);
  const keepClear: Vec3[] = [];
  for (const p of planes) keepClear.push(p.pos, predictedPos(p, flightMs));
  const buildings = index.buildings;
  for (let n = 0; n < tries; n++) {
    const a = rand() * Math.PI * 2;
    const r =
      MISSILE_TARGET_MIN_M +
      (MISSILE_TARGET_MAX_M - MISSILE_TARGET_MIN_M) * rand();
    const probe = {
      x: wrap(aim.x + Math.cos(a) * r),
      y: 0,
      z: wrap(aim.z + Math.sin(a) * r),
    };
    // The nearest building to the probe (plan-view gap).
    let best = -1;
    let bestGap = Number.POSITIVE_INFINITY;
    const off = { x: 0, y: 0, z: 0 };
    forEachBuildingNear(index, probe, 30, (i, o) => {
      const b = buildings[i] as Building;
      const gap = Math.hypot(
        Math.max(Math.abs(o.x) - b.width / 2, 0),
        Math.max(Math.abs(o.z) - b.depth / 2, 0),
      );
      if (gap < bestGap) {
        bestGap = gap;
        best = i;
        off.x = o.x;
        off.z = o.z;
      }
    });
    let to: Vec3;
    let normal: Vec3;
    const b = best >= 0 ? (buildings[best] as Building) : null;
    // `off` is building − probe; the probe in the building's frame is −off.
    const lx = -off.x;
    const lz = -off.z;
    const grids = b ? tierGrids(b) : [];
    let roof = -1;
    for (const g of grids) {
      if (Math.abs(lx) <= g.width / 2 && Math.abs(lz) <= g.depth / 2) {
        roof = g.baseY + g.height;
      }
    }
    if (b && roof > 0 && rand() < 0.35) {
      to = { x: probe.x, y: roof, z: probe.z };
      normal = { x: 0, y: 1, z: 0 };
    } else if (b) {
      // A facade near the subject's height: snap to that tier's nearest face.
      const want = Math.min(
        b.height - 1,
        Math.max(3, aim.y + (rand() * 2 - 1) * 25),
      );
      const g = tierAt(b, want) ?? grids[0];
      if (!g) continue;
      const hw = g.width / 2;
      const hd = g.depth / 2;
      const cx = Math.max(-hw, Math.min(hw, lx));
      const cz = Math.max(-hd, Math.min(hd, lz));
      // Distance to each face from the clamped point; push to the nearest.
      const toX = hw - Math.abs(cx);
      const toZ = hd - Math.abs(cz);
      let fx: number;
      let fz: number;
      if (toX <= toZ) {
        fx = lx >= 0 ? hw : -hw;
        fz = cz;
        normal = { x: Math.sign(fx) || 1, y: 0, z: 0 };
      } else {
        fx = cx;
        fz = lz >= 0 ? hd : -hd;
        normal = { x: 0, y: 0, z: Math.sign(fz) || 1 };
      }
      const y = Math.min(want, g.baseY + g.height - 0.5);
      to = { x: wrap(b.x + fx), y, z: wrap(b.z + fz) };
    } else {
      to = { x: probe.x, y: 0, z: probe.z };
      normal = { x: 0, y: 1, z: 0 };
    }
    to = { x: qc(to.x), y: q(to.y), z: qc(to.z) };
    const d = wrapDistance(to, aim);
    if (d < MISSILE_TARGET_MIN_M || d > MISSILE_TARGET_MAX_M) continue;
    if (keepClear.some((p) => wrapDistance(p, to) < MISSILE_PLANE_CLEAR_M)) {
      continue;
    }
    return { to, normal };
  }
  return null;
}

/** Path samples the clearance sweep checks. */
const SWEEP_STEPS = 24;
/** The sweep stops this far short of the target (the facade itself). */
const SWEEP_STANDOFF_M = 3;

/**
 * True when the missile's arc clears the city (solids as they stand —
 * pass the room's damaged buildings) all the way to SWEEP_STANDOFF_M off
 * the target. The arc itself is pure, so this is the same on every side.
 */
export function missilePathClear(
  s: MissileStrike,
  buildings: readonly Building[],
): boolean {
  const a = { x: 0, y: 0, z: 0 };
  const b = { x: 0, y: 0, z: 0 };
  missilePosAt(s, s.t0, a);
  for (let i = 1; i <= SWEEP_STEPS; i++) {
    missilePosAt(s, s.t0 + (missileFlightMs(s.kind) * i) / SWEEP_STEPS, b);
    const left = wrapDistance(b, s.to);
    if (left < SWEEP_STANDOFF_M) {
      // Shorten the last segment to stop short of the surface.
      const d = wrapDelta(a, b);
      const span = Math.hypot(d.x, d.y, d.z);
      const keep = span > 0 ? Math.max(0, 1 - SWEEP_STANDOFF_M / span) : 0;
      b.x = wrap(a.x + d.x * keep);
      b.y = a.y + d.y * keep;
      b.z = wrap(a.z + d.z * keep);
      return b.y >= 0 && losClear(a, b, buildings);
    }
    if (b.y < 0 || !losClear(a, b, buildings)) return false;
    a.x = b.x;
    a.y = b.y;
    a.z = b.z;
  }
  return true;
}

/**
 * Plan the flight to `target`: a cruise missile from the side the target
 * faces (± 60°), falling back to an artillery lob from anywhere; each try
 * swept for clearance against `buildings`. Null when nothing gets through.
 * The result is quantised to the wire grid.
 */
export function planMissile(
  rand: () => number,
  id: number,
  target: MissileTarget,
  t0: number,
  buildings: readonly Building[],
): MissileStrike | null {
  const faces = Math.hypot(target.normal.x, target.normal.z) > 0.5;
  const base = Math.atan2(target.normal.z, target.normal.x);
  for (let n = 0; n < 10; n++) {
    const kind: MissileKind = n < 6 ? "cruise" : "artillery";
    const az =
      kind === "cruise" && faces
        ? base + (rand() * 2 - 1) * (Math.PI / 3)
        : rand() * Math.PI * 2;
    const dist = LAUNCH_MIN_M + (LAUNCH_MAX_M - LAUNCH_MIN_M) * rand();
    const y = kind === "cruise" ? 140 + 120 * rand() : 20;
    const s: MissileStrike = {
      id,
      kind,
      from: {
        x: qc(target.to.x + Math.cos(az) * dist),
        y: q(y),
        z: qc(target.to.z + Math.sin(az) * dist),
      },
      to: { ...target.to },
      t0: Math.round(t0),
    };
    if (missilePathClear(s, buildings)) return s;
  }
  return null;
}

// --- Wire --------------------------------------------------------------------

/** Wire kind codes, in order. */
const WIRE_KINDS: readonly MissileKind[] = [
  "cruise",
  "artillery",
  "meteor",
  "bomb",
];

/** A strike on the wire: [id, kind (0 cruise, 1 artillery, 2 meteor,
 * 3 bomb), from ×10, to ×10, t0] — integers only, exactly reconstructible. */
export type WireMissile = [
  id: number,
  kind: 0 | 1 | 2 | 3,
  fx: number,
  fy: number,
  fz: number,
  tx: number,
  ty: number,
  tz: number,
  t0: number,
];

export function encodeMissile(s: MissileStrike): WireMissile {
  const i = (v: number) => Math.round(v * 10);
  return [
    s.id,
    WIRE_KINDS.indexOf(s.kind) as 0 | 1 | 2 | 3,
    i(s.from.x),
    i(s.from.y),
    i(s.from.z),
    i(s.to.x),
    i(s.to.y),
    i(s.to.z),
    s.t0,
  ];
}

/** Inverse of encodeMissile; null for anything malformed — an unknown
 * kind included (its flight time, so its impact instant, would be a guess). */
export function decodeMissile(w: unknown): MissileStrike | null {
  if (!Array.isArray(w) || w.length !== 9) return null;
  if (!w.every((v) => typeof v === "number" && Number.isFinite(v))) {
    return null;
  }
  const [id, code, fx, fy, fz, tx, ty, tz, t0] = w as number[];
  const kind = WIRE_KINDS[code as number];
  if (kind === undefined) return null;
  return {
    id: id as number,
    kind,
    from: {
      x: (fx as number) / 10,
      y: (fy as number) / 10,
      z: (fz as number) / 10,
    },
    to: {
      x: (tx as number) / 10,
      y: (ty as number) / 10,
      z: (tz as number) / 10,
    },
    t0: t0 as number,
  };
}
