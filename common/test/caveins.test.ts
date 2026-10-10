// U6 cave-ins (common/src/city/caveins.ts): ALWAYS A GAP. Sweeps cave-ins
// over every bore's placement ranges (its straights and 300 m bends), in
// every lane, and proves
//   (a) the open lane — ≥ 2.5 × the plane's radius — is never touched by a
//       piece at any instant of its life: no posed corner crosses into it,
//       and no plane-sized sphere anywhere in it ever hits a piece;
//   (b) a plane reaches it: real stepFlight, a deterministic pilot that
//       flies the bore holding its line until 0.5 s after it can SEE the
//       cave-in (the later of the warning and its first line of sight),
//       then steers into the lane — from every entry offset across the
//       section, at MIN, MAX and boost speed, both ways, arriving at every
//       phase of the event the lead rule allows — flies through clean
//       against the bore's walls and the falling rock; also two cave-ins
//       at the minimum separation with opposite lanes.

import {
  CAVEIN_CEIL,
  CAVEIN_FLOOR,
  CAVEIN_GAP,
  CAVEIN_LEN,
  CAVEIN_SEPARATION,
  type CaveIn,
  type CaveInGap,
  blankCaveInPose,
  buildCaveIn,
  caveInFairFor,
  caveInGapLat,
  caveInLane,
  caveInLeadM,
  caveInPieceInto,
  caveInRanges,
  collideCaveIns,
  nextCaveInAhead,
} from "@angels-bandits/common/city/caveins";
import {
  TUNNELS,
  type Tunnel,
  type TunnelFrame,
  guideSlope,
  guideY,
  tunnelFrameInto,
  tunnelOpen,
  tunnelPointInto,
} from "@angels-bandits/common/city/tunnels";
import { hitsGround } from "@angels-bandits/common/collision";
import {
  BOOST_MAX_SPEED,
  MAX_SPEED,
  MIN_SPEED,
  PITCH_LIMIT,
  PLAYER_RADIUS,
} from "@angels-bandits/common/constants";
import {
  type FlightInput,
  type FlightState,
  stepFlight,
} from "@angels-bandits/common/flight";
import { type Vec3, wrapCoord } from "@angels-bandits/common/world";
import { describe, expect, it } from "vitest";

const R = PLAYER_RADIUS;
const GAPS: readonly CaveInGap[] = [0, 1, 2];
const frame: TunnelFrame = { s: 0, lat: 0, th: 0 };
const pt = { x: 0, z: 0, th: 0 };

/** A bore-frame point as a canonical world point. */
function boreAt(t: Tunnel, s: number, lat: number, y: number): Vec3 {
  tunnelPointInto(t, s, pt);
  return {
    x: wrapCoord(pt.x - Math.sin(pt.th) * lat),
    y,
    z: wrapCoord(pt.z + Math.cos(pt.th) * lat),
  };
}

/** Let the event loop turn: these sweeps run for tens of seconds, and a
 * long synchronous stretch starves vitest's worker RPC (vitest.setup.ts). */
const turn = (): Promise<void> => new Promise((r) => setImmediate(r));

/** Cave-in centres over every bore's ranges, `step` m apart (both ends). */
function spots(step: number): { t: Tunnel; s: number }[] {
  const out: { t: Tunnel; s: number }[] = [];
  for (const t of TUNNELS) {
    for (const [a, b] of caveInRanges(t)) {
      const n = Math.max(1, Math.round((b - a) / step));
      for (let i = 0; i <= n; i++) out.push({ t, s: a + ((b - a) * i) / n });
    }
  }
  return out;
}

describe("U6 cave-ins: the open lane is never touched", () => {
  it("leaves a lane at least 2.5 × the plane's radius wide", () => {
    for (const g of GAPS) {
      const [lo, hi] = caveInLane(g);
      expect(hi - lo).toBeGreaterThanOrEqual(2.5 * R);
      expect(CAVEIN_GAP).toBeGreaterThanOrEqual(2.5 * R);
    }
  });

  it("never puts a piece's corner in the lane, warning to gone", async () => {
    const pose = blankCaveInPose();
    let checked = 0;
    let worst = Number.POSITIVE_INFINITY;
    for (const { t, s } of spots(45)) {
      await turn();
      for (const gap of GAPS) {
        for (const id of [1, 4242]) {
          const c = buildCaveIn({
            id: id + Math.round(s),
            tunnel: t.id,
            s,
            t0: 0,
            gap,
          });
          expect(c.n).toBeGreaterThan(5);
          const [lo, hi] = caveInLane(gap);
          for (
            let ms = 0;
            ms <= c.endMs;
            ms += ms < c.downMs + 200 ? 100 : 1000
          ) {
            for (let i = 0; i < c.n; i++) {
              const p = caveInPieceInto(c, i, ms, pose);
              if (!p.visible) continue;
              for (const sx of [-1, 1]) {
                for (const sy of [-1, 1]) {
                  for (const sz of [-1, 1]) {
                    // The drawn corner: tumble about local x / z, then yaw.
                    let lx = sx * p.hx;
                    let ly = sy * p.hy;
                    let lz = sz * p.hz;
                    const co = Math.cos(p.phi);
                    const si = Math.sin(p.phi);
                    if (p.axis === 0) {
                      const y = ly * co - lz * si;
                      lz = ly * si + lz * co;
                      ly = y;
                    } else {
                      const x = lx * co - ly * si;
                      ly = lx * si + ly * co;
                      lx = x;
                    }
                    const cy = Math.cos(p.yaw);
                    const sw = Math.sin(p.yaw);
                    tunnelFrameInto(
                      t,
                      {
                        x: p.x + lx * cy + lz * sw,
                        y: p.y + ly,
                        z: p.z - lx * sw + lz * cy,
                      },
                      frame,
                    );
                    const into = Math.min(frame.lat - lo, hi - frame.lat);
                    worst = Math.min(worst, -into);
                    checked++;
                  }
                }
              }
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(1_000_000);
    // Every corner stays outside the lane, with room to spare.
    expect(worst).toBeGreaterThan(0.25);
  }, 300_000);

  it("never lets a plane-sized sphere anywhere in the lane meet a piece", async () => {
    let probes = 0;
    for (const { t, s } of spots(60)) {
      await turn();
      for (const gap of GAPS) {
        const c = buildCaveIn({
          id: 9 + Math.round(s),
          tunnel: t.id,
          s,
          t0: 0,
          gap,
        });
        const [lo, hi] = caveInLane(gap);
        const pts: Vec3[] = [];
        for (let ds = -CAVEIN_LEN / 2 - 6; ds <= CAVEIN_LEN / 2 + 6; ds += 2) {
          for (
            let lat = lo + R;
            lat <= hi - R + 1e-9;
            lat += (hi - lo - 2 * R) / 3
          ) {
            for (
              let y = CAVEIN_FLOOR + R;
              y <= CAVEIN_CEIL - R + 1e-9;
              y += 2.5
            ) {
              pts.push(boreAt(t, s + ds, lat, y));
            }
          }
        }
        for (
          let ms = 0;
          ms <= c.endMs;
          ms += ms < c.downMs + 200 ? 150 : 1500
        ) {
          for (const p of pts) {
            probes++;
            if (collideCaveIns(p, R, [c], ms)) {
              throw new Error(
                `bore ${t.id} s ${s.toFixed(1)} gap ${gap}: lane hit at ${ms} ms`,
              );
            }
          }
        }
      }
    }
    expect(probes).toBeGreaterThan(1_000_000);
  }, 300_000);
});

// --- (b) Reachable paths ------------------------------------------------------------

/** Flight time step, s, and the steering gain (the bots'). */
const DT = 1 / 40;
const GAIN = 3;
/** The pilot's reaction after it can see the cave-in, s. */
const REACT_S = 0.5;
/** Its carrot, m ahead along the bore. */
const CARROT = 45;

const wrapAngle = (a: number): number => {
  const m = (((a + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  return m - Math.PI;
};
const clamp = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, v));

/** Can a plane at `from` see the zone of `c` (its centre at guide height)?
 * Sampled every 2 m against the bore's walls. */
function sees(t: Tunnel, from: Vec3, c: CaveIn): boolean {
  const to = boreAt(t, c.s, 0, guideY(t, c.s));
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const wx = dx - Math.round(dx / 2000) * 2000;
  const wz = dz - Math.round(dz / 2000) * 2000;
  const dy = to.y - from.y;
  const d = Math.hypot(wx, dy, wz);
  for (let k = 1; k * 2 < d; k++) {
    const u = (k * 2) / d;
    if (
      hitsGround(
        {
          x: wrapCoord(from.x + wx * u),
          y: from.y + dy * u,
          z: wrapCoord(from.z + wz * u),
        },
        0,
      )
    ) {
      return false;
    }
  }
  return true;
}

interface Run {
  t: Tunnel;
  list: CaveIn[];
  dir: 1 | -1;
  speed: number;
  /** Start: arc length, lateral, height off the guide line, s after t0. */
  s0: number;
  lat0: number;
  dy: number;
  tStart: number;
}

/** The pilot: flies the bore at its starting lateral (easing onto the
 * guide height) until REACT_S after it can see the next cave-in, then holds
 * a carrot in that cave-in's lane (nextCaveInAhead, as the bots do).
 * Returns the first contact, or null. */
function fly(run: Run): string | null {
  const { t, list, dir, speed } = run;
  const start = boreAt(t, run.s0, run.lat0, guideY(t, run.s0) + run.dy);
  tunnelPointInto(t, run.s0, pt);
  const th = dir > 0 ? pt.th : pt.th + Math.PI;
  let f: FlightState = {
    pos: start,
    yaw: Math.atan2(-Math.cos(th), -Math.sin(th)),
    // Lined up with the bore: its heading and (on a ramp) its grade.
    pitch: Math.atan(dir * guideSlope(t, run.s0)),
    roll: 0,
    bank: 0,
    rollRate: 0,
    speed,
    targetSpeed: Math.min(speed, MAX_SPEED),
  };
  const boost = speed > MAX_SPEED;
  const seenAt = new Map<number, number>();
  const last = list.reduce(
    (m, c) => (dir > 0 ? Math.max(m, c.s) : Math.min(m, c.s)),
    dir > 0 ? -1e9 : 1e9,
  );
  for (let k = 0; k < 4000; k++) {
    const tMs = (run.tStart + k * DT) * 1000;
    tunnelFrameInto(t, f.pos, frame);
    if (dir * (frame.s - last) > CAVEIN_LEN / 2 + 30) return null;
    // Which cave-in is next, and how long the pilot has seen it.
    const c = nextCaveInAhead(list, t.id, frame.s, dir, tMs, 400);
    let lat = run.lat0;
    if (c) {
      if (!seenAt.has(c.id) && tMs >= c.t0 && sees(t, f.pos, c))
        seenAt.set(c.id, tMs);
      const seen = seenAt.get(c.id);
      if (seen !== undefined && tMs >= seen + REACT_S * 1000)
        lat = caveInGapLat(c.gap);
    }
    const q = frame.s + dir * CARROT;
    const aim = boreAt(t, q, lat, guideY(t, q));
    const dx = aim.x - f.pos.x;
    const dz = aim.z - f.pos.z;
    const wx = dx - Math.round(dx / 2000) * 2000;
    const wz = dz - Math.round(dz / 2000) * 2000;
    const dy = aim.y - f.pos.y;
    const len = Math.hypot(wx, dy, wz);
    const yawErr = wrapAngle(Math.atan2(-wx, -wz) - f.yaw);
    const pitchErr = Math.asin(clamp(dy / len, -1, 1)) - f.pitch;
    const input: FlightInput = {
      turn: clamp(-yawErr * GAIN, -1, 1),
      pitch: clamp(pitchErr * GAIN, -1, 1),
      roll: 0,
      throttle: 0,
      boost,
      pitchLimit: PITCH_LIMIT,
    };
    f = stepFlight(f, input, DT);
    const tNext = tMs + DT * 1000;
    if (hitsGround(f.pos, R)) {
      return `wall at s ${frame.s.toFixed(1)} lat ${frame.lat.toFixed(1)}`;
    }
    const hit = collideCaveIns(f.pos, R, list, tNext);
    if (hit) {
      return `cave-in ${hit.caveIn.id} piece ${hit.piece} at s ${frame.s.toFixed(1)} lat ${frame.lat.toFixed(1)} t ${(tNext - hit.caveIn.t0).toFixed(0)} ms`;
    }
  }
  return "never got through";
}

/** Placement spots for the flights: each range's ends and middle. */
function flightSpots(): { t: Tunnel; s: number }[] {
  const out: { t: Tunnel; s: number }[] = [];
  for (const t of TUNNELS) {
    for (const [a, b] of caveInRanges(t)) {
      for (const u of [0, 0.5, 1]) out.push({ t, s: a + (b - a) * u });
    }
  }
  return out;
}

describe("U6 cave-ins: a plane reacting 0.5 s after it sees one gets through", () => {
  it("from every entry offset, speed, direction and arrival phase the lead rule allows", async () => {
    let flown = 0;
    const failures: string[] = [];
    for (const { t, s } of flightSpots()) {
      await turn();
      for (const gap of GAPS) {
        const c = buildCaveIn({
          id: 31 + Math.round(s),
          tunnel: t.id,
          s,
          t0: 0,
          gap,
        });
        // Arrival at the zone's near edge, s after t0: as the director
        // places (its lead), at the end of the warning, mid-fall, onto the
        // rubble, as it settles away.
        for (const speed of [MIN_SPEED, MAX_SPEED, BOOST_MAX_SPEED]) {
          const phases = [
            caveInLeadM(speed) / speed - CAVEIN_LEN / 2 / speed,
            2,
            2.8,
            c.downMs / 1000,
            c.clearMs / 1000 - 3,
            c.clearMs / 1000 + 1,
          ];
          for (const dir of [1, -1] as const) {
            for (const arrive of phases) {
              const tStart = Math.max(0, arrive - 3.2);
              const dist = speed * (arrive - tStart);
              const s0 = s - dir * (CAVEIN_LEN / 2 + dist);
              // Only what the director could stage: the lead rule at t0
              // for a plane already flying in.
              if (tStart === 0) {
                tunnelFrameInto(t, boreAt(t, s0, 0, guideY(t, s0)), frame);
                const fair = caveInFairFor(
                  { s: s0, lat: 0, y: guideY(t, s0), vs: dir * speed },
                  s,
                );
                if (!fair) continue;
              }
              for (const lat0 of [-14, -7, 0, 7, 14]) {
                for (const dy of [-6, 0, 6]) {
                  // A plane in the bore (not yet out over the river or
                  // the plaza, where the mouth is what it has to fly).
                  const at = boreAt(t, s0, lat0, guideY(t, s0) + dy);
                  if (s0 < 0 || s0 > t.length || !tunnelOpen(at, R)) continue;
                  // On a ramp it flies the guide line (off it, the ramp's
                  // own floor and lintel are the test, not the cave-in).
                  if (dy !== 0 && Math.abs(guideSlope(t, s0)) > 0.01) continue;
                  flown++;
                  const why = fly({
                    t,
                    list: [c],
                    dir,
                    speed,
                    s0,
                    lat0,
                    dy,
                    tStart,
                  });
                  if (why) {
                    failures.push(
                      `bore ${t.id} s ${s.toFixed(0)} gap ${gap} v ${speed} dir ${dir} arrive ${arrive.toFixed(2)} lat ${lat0} dy ${dy}: ${why}`,
                    );
                  }
                }
              }
            }
          }
        }
      }
    }
    expect(failures.slice(0, 10)).toEqual([]);
    expect(flown).toBeGreaterThan(5000);
  }, 300_000);

  it("through two cave-ins at the minimum separation with opposite lanes", () => {
    const failures: string[] = [];
    let flown = 0;
    for (const t of TUNNELS) {
      for (const [a, b] of caveInRanges(t)) {
        if (b - a < CAVEIN_SEPARATION + 2) continue;
        const s1 = a + 1;
        const s2 = s1 + CAVEIN_SEPARATION;
        for (const [g1, g2] of [
          [0, 1],
          [1, 0],
          [0, 2],
          [2, 1],
        ] as const) {
          for (const speed of [MIN_SPEED, MAX_SPEED, BOOST_MAX_SPEED]) {
            for (const dir of [1, -1] as const) {
              const first = dir > 0 ? s1 : s2;
              const list = [
                buildCaveIn({
                  id: 1,
                  tunnel: t.id,
                  s: s1,
                  t0: 0,
                  gap: dir > 0 ? g1 : g2,
                }),
                buildCaveIn({
                  id: 2,
                  tunnel: t.id,
                  s: s2,
                  t0: 0,
                  gap: dir > 0 ? g2 : g1,
                }),
              ];
              const s0 = first - dir * (caveInLeadM(speed) - CAVEIN_LEN / 2);
              for (const lat0 of [-14, 0, 14]) {
                const at = boreAt(t, s0, lat0, guideY(t, s0));
                if (s0 < 0 || s0 > t.length || !tunnelOpen(at, R)) continue;
                flown++;
                const why = fly({
                  t,
                  list,
                  dir,
                  speed,
                  s0,
                  lat0,
                  dy: 0,
                  tStart: 0,
                });
                if (why)
                  failures.push(
                    `bore ${t.id} ${g1}/${g2} v ${speed} dir ${dir} lat ${lat0}: ${why}`,
                  );
              }
            }
          }
        }
      }
    }
    expect(failures.slice(0, 10)).toEqual([]);
    expect(flown).toBeGreaterThan(100);
  }, 300_000);
});
