// The wire's math, shared verbatim by client and server (ANGE-4KO2W2).
//
// Two jobs, both pure — no sockets, no clocks, no state:
//
//  1. **Snapshot quantisation.** Full float precision was being spent on
//     positions and attitudes that need nothing like it. Every snapshot entry
//     is encoded as a fixed tuple of INTEGERS (decimetres, milli-quaternion
//     units, decimetres/second), which is both shorter than the float text and
//     exactly reconstructible. Losing the JSON key names is most of the win:
//     a ~240-byte entry becomes ~70.
//  2. **The interpolation-delay controller's math** and the hit-claim range
//     slack DERIVED from that delay. Those two are one system — the slack
//     exists precisely to absorb the distance both planes cover during the
//     shooter's interpolation delay, so the moment the delay became adaptive
//     a hardcoded slack beside it would drift out of agreement.
//
// Positions are canonicalised in INTEGER space (WORLD_SIZE * POS_SCALE is a
// whole number of wire units), so a rounded position can never land one unit
// past the seam and read as 2000 m instead of 0.

import { BORE_FLOOR_Y } from "./city/tunnels";
import {
  BULLET_LIFETIME_S,
  BULLET_RANGE,
  INTERP_DELAY_MAX_MS,
  INTERP_FLOOR_MS,
  INTERP_JITTER_DECAY,
  INTERP_JITTER_FACTOR,
  MAX_ALTITUDE,
  MAX_SPEED,
  SNAPSHOT_INTERVAL_MS,
  SPEED_TOLERANCE,
  WORLD_SIZE,
} from "./constants";
import type { Pose, SnapshotEntry, WireSnapshotEntry } from "./protocol";

/** The wire's version. E1 (2): snapshots are per client and interest
 * managed — an enemy missing from one is not dead. I1 (3): no formation
 * rows any more — every enemy is its own entry. A client built for another
 * version reloads (main.ts). */
export const PROTOCOL_VERSION = 3;

// --- Quantisation scales (wire units per real unit) ---

/** Position: 10 units per meter → 0.1 m resolution, ±0.05 m worst case. */
export const POS_SCALE = 10;
/** Attitude: 1000 units per quaternion component → ~0.06° worst-case error. */
export const QUAT_SCALE = 1000;
/** Airspeed: 10 units per m/s. Remote speed only drives engine audio and
 * trail hardness — 0.1 m/s is far finer than either can show. */
export const SPEED_SCALE = 10;

/** The torus period in wire units. Whole number by construction, which is
 * what makes integer-space canonicalisation exact. */
const WORLD_UNITS = WORLD_SIZE * POS_SCALE;
const MAX_ALTITUDE_UNITS = MAX_ALTITUDE * POS_SCALE;
/** The lowest encodable altitude: the U4 tunnels' floor, the lowest point a
 * plane can fly (the L11 river's water is above it). Negative units are
 * plain JSON ints. */
const MIN_ALTITUDE_UNITS = BORE_FLOOR_Y * POS_SCALE;

/** Canonicalise a position already expressed in integer wire units. */
const wrapUnits = (n: number): number => {
  const m = n % WORLD_UNITS;
  return m < 0 ? m + WORLD_UNITS : m;
};

/**
 * Quantise one snapshot entry for the wire.
 *
 * The attitude keeps all four quaternion components rather than the classic
 * "smallest three": dropping a component and rebuilding it from the unit norm
 * forces a sign convention, and the whole quaternion flips sign whenever the
 * dropped component's index changes — a discontinuity right in the middle of
 * the slerp that interpolation depends on. One extra small integer is a
 * cheaper price than that class of bug.
 */
export function encodeSnapshotEntry(entry: SnapshotEntry): WireSnapshotEntry {
  const { pos, quat, speed } = entry.pose;
  const norm = Math.hypot(quat.x, quat.y, quat.z, quat.w) || 1;
  const tuple: WireSnapshotEntry = [
    entry.id,
    wrapUnits(Math.round(pos.x * POS_SCALE)),
    Math.min(
      MAX_ALTITUDE_UNITS,
      Math.max(MIN_ALTITUDE_UNITS, Math.round(pos.y * POS_SCALE)),
    ),
    wrapUnits(Math.round(pos.z * POS_SCALE)),
    Math.round((quat.x / norm) * QUAT_SCALE),
    Math.round((quat.y / norm) * QUAT_SCALE),
    Math.round((quat.z / norm) * QUAT_SCALE),
    Math.round((quat.w / norm) * QUAT_SCALE),
    Math.max(0, Math.round(speed * SPEED_SCALE)),
    Math.round(entry.hp),
  ];
  // Spawn protection is the rare case: send the flag only when it is set and
  // let the decoder read an absent slot as false. A pose age (O2) rides in
  // the slot after it — omitted at 0 (every bot row) — and forces the flag
  // slot to an explicit 0/1, so the tuple never serialises a hole as null.
  const age = Math.max(0, Math.round(entry.age ?? 0));
  if (age > 0) {
    tuple[10] = entry.prot ? 1 : 0;
    tuple[11] = age;
  } else if (entry.prot) {
    tuple[10] = 1;
  }
  return tuple;
}

/** Rebuild a snapshot entry from its wire tuple (the exact inverse of the
 * rounding above — the only loss is the rounding itself). */
export function decodeSnapshotEntry(w: WireSnapshotEntry): SnapshotEntry {
  const qx = w[4] / QUAT_SCALE;
  const qy = w[5] / QUAT_SCALE;
  const qz = w[6] / QUAT_SCALE;
  const qw = w[7] / QUAT_SCALE;
  // Rounding four components off the unit sphere; renormalise so downstream
  // slerp gets a unit quaternion, exactly as it did before quantisation.
  const norm = Math.hypot(qx, qy, qz, qw) || 1;
  return {
    id: w[0],
    pose: {
      pos: {
        x: wrapUnits(w[1]) / POS_SCALE,
        y: w[2] / POS_SCALE,
        z: wrapUnits(w[3]) / POS_SCALE,
      },
      quat: { x: qx / norm, y: qy / norm, z: qz / norm, w: qw / norm },
      speed: w[8] / SPEED_SCALE,
    },
    hp: w[9],
    prot: w[10] === 1,
    age: w[11] ?? 0,
  };
}

// --- G9: packed snapshots (solo) ---
//
// The solo game's sim worker hands the page each snapshot PACKED instead of
// as JSON text (client/src/sim/worker.ts): the wire tuple's numbers in one
// transferred Float64Array, each id as its index in the link's id table
// (sent once, when an id first appears). The page decodes it straight into
// objects it reuses — no text, no JSON, nothing allocated per snapshot.

/** Floats before a packed snapshot's entries: its time and entry count. */
export const SNAP_HEAD = 2;
/** Floats per packed entry: the id's index, then the wire tuple's numbers
 * x … hp, prot (0/1) and age (0 when absent). */
export const SNAP_STRIDE = 12;

/** `p` (a snapshot's wire tuples at `time`) packed, ids by `idIndex`. */
export function packSnapshot(
  time: number,
  p: readonly WireSnapshotEntry[],
  idIndex: (id: string) => number,
): Float64Array {
  const out = new Float64Array(SNAP_HEAD + p.length * SNAP_STRIDE);
  out[0] = time;
  out[1] = p.length;
  for (let k = 0; k < p.length; k++) {
    const w = p[k] as WireSnapshotEntry;
    const o = SNAP_HEAD + k * SNAP_STRIDE;
    out[o] = idIndex(w[0]);
    for (let j = 1; j <= 9; j++) out[o + j] = w[j] as number;
    out[o + 10] = w[10] ?? 0;
    out[o + 11] = w[11] ?? 0;
  }
  return out;
}

/** A snapshot entry to decode packed ones into (reused). */
export const blankSnapshotEntry = (): SnapshotEntry => ({
  id: "",
  pose: {
    pos: { x: 0, y: 0, z: 0 },
    quat: { x: 0, y: 0, z: 0, w: 1 },
    speed: 0,
  },
  hp: 0,
  prot: false,
  age: 0,
});

/** decodeSnapshotEntry for the packed entry at `o` of `data`, id `id`,
 * written into `out` (the same rounding undone; nothing allocated). */
export function decodePackedEntry(
  data: Float64Array,
  o: number,
  id: string,
  out: SnapshotEntry,
): SnapshotEntry {
  const qx = (data[o + 4] as number) / QUAT_SCALE;
  const qy = (data[o + 5] as number) / QUAT_SCALE;
  const qz = (data[o + 6] as number) / QUAT_SCALE;
  const qw = (data[o + 7] as number) / QUAT_SCALE;
  const norm = Math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw) || 1;
  const pose = out.pose;
  out.id = id;
  pose.pos.x = wrapUnits(data[o + 1] as number) / POS_SCALE;
  pose.pos.y = (data[o + 2] as number) / POS_SCALE;
  pose.pos.z = wrapUnits(data[o + 3] as number) / POS_SCALE;
  pose.quat.x = qx / norm;
  pose.quat.y = qy / norm;
  pose.quat.z = qz / norm;
  pose.quat.w = qw / norm;
  pose.speed = (data[o + 8] as number) / SPEED_SCALE;
  out.hp = data[o + 9] as number;
  out.prot = data[o + 10] === 1;
  out.age = data[o + 11] as number;
  return out;
}

/** The pose a remote will actually be shown at, given what the server holds —
 * i.e. `pose` put through the wire. Handy for proving quantisation can never
 * flip a validation outcome. */
export const quantisePose = (pose: Pose): Pose =>
  decodeSnapshotEntry(encodeSnapshotEntry({ id: "", pose, hp: 0, prot: false }))
    .pose;

/** Worst-case position error one round trip through the wire can introduce,
 * meters (half a quantisation step on each of three axes). */
export const POS_QUANT_ERROR_M = (Math.sqrt(3) * 0.5) / POS_SCALE;

// --- Interpolation delay ---

/**
 * Fold one snapshot's arrival into the jitter estimate.
 *
 * The signal is how far the arrival gap strayed from the nominal snapshot
 * interval — which catches BOTH a late packet (gap too long) and the bunched
 * packet behind it (gap too short), and does not care whether the cause was
 * the network or a server that missed its tick. Either way the buffer needs
 * to be deeper.
 *
 * Deviation attacks INSTANTLY and decays slowly. That single asymmetry is
 * what makes the controller (a) grow before remotes stutter rather than after,
 * (b) grow faster than it shrinks, and (c) unable to oscillate: on alternating
 * jitter the estimate pins to the larger deviation and simply holds.
 */
export const nextJitter = (jitter: number, gapMs: number): number => {
  const dev = Math.abs(gapMs - SNAPSHOT_INTERVAL_MS);
  return dev > jitter ? dev : jitter + (dev - jitter) * INTERP_JITTER_DECAY;
};

/**
 * The interpolation delay to hold for a given jitter estimate, ms.
 * Never below one snapshot interval plus the margin — under that floor there
 * is frequently no future sample to lerp toward and remotes stutter.
 */
export const interpDelayFor = (jitterMs: number): number =>
  Math.min(
    INTERP_DELAY_MAX_MS,
    INTERP_FLOOR_MS + INTERP_JITTER_FACTOR * Math.max(0, jitterMs),
  );

/** Clamp a client-declared interpolation delay to the range the server is
 * willing to honour. An absent or nonsense claim reads as the FLOOR — the
 * least permissive value — so under-declaring is the only thing a client can
 * do to itself, and over-declaring buys at most INTERP_DELAY_MAX_MS. */
export const clampInterpDelay = (ms: unknown): number => {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return INTERP_FLOOR_MS;
  return Math.min(INTERP_DELAY_MAX_MS, Math.max(INTERP_FLOOR_MS, ms));
};

// --- The slack that must track the delay ---

/** Worst-case closing speed of two legally-flying, un-boosted planes, m/s.
 * A boosting shooter or target (F2) is judged at its own boost envelope
 * instead: the server passes that closing speed per claim, so boost widens
 * the window only for the claims it can actually affect. */
const CLOSING_SPEED = 2 * MAX_SPEED * SPEED_TOLERANCE;

/**
 * Meters of slack on top of BULLET_RANGE for a hit claim from a shooter
 * holding `interpDelayMs` of interpolation buffer.
 *
 * Both planes keep flying while (a) the shooter aims at a target image that
 * is `interpDelayMs` old and (b) the bullet crosses the gap. Worst case they
 * close at CLOSING_SPEED for that whole window, so the server's range check
 * must budget for it or legitimate hits get rejected.
 *
 * Sanity: at the old fixed 100 ms delay this yields 193 m — within 4% of the
 * hand-tuned 200 m it replaces. At the new 58 ms floor it TIGHTENS to 185 m,
 * and only a client that genuinely declares a deep buffer reaches 223 m.
 */
export const hitRangeSlackFor = (
  interpDelayMs: number,
  closingSpeed: number = CLOSING_SPEED,
): number =>
  closingSpeed * (clampInterpDelay(interpDelayMs) / 1000 + BULLET_LIFETIME_S);

/** Full range budget a claim gets: bullet range plus the derived slack. */
export const hitRangeBudgetFor = (
  interpDelayMs: number,
  closingSpeed: number = CLOSING_SPEED,
): number => BULLET_RANGE + hitRangeSlackFor(interpDelayMs, closingSpeed);
