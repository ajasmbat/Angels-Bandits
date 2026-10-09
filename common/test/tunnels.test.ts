// U4 underground tunnels (city/tunnels.ts): the network as the ground
// everything collides with. Three bores, 36 m × 24 m, floor −64, 300 m
// bends, plaza portals (80 m open cuts with a 22° ramp) and river mouths
// (water −22 to lintel −2). These tests hold the ticket's contract: the
// network is seed-free and torus-safe, every centreline is flyable by the
// shared flight model, no portal swallows a building, a bridge, a viaduct
// or a hole, what is drawn is what collides, sight lines agree with the
// ground, and the ground is open exactly inside the bores.

import {
  PLAZA_BLOCKS,
  cityHoles,
  generateCity,
  mulberry32,
} from "@angels-bandits/common/city";
import { natureFor } from "@angels-bandits/common/city/nature";
import {
  BRIDGE_HALF_WIDTH,
  PARAPET_HEIGHT,
  PARAPET_THICKNESS,
  RIVER_CENTER_Z,
  RIVER_HALF_WIDTH,
  bridgeBoxes,
  minAltitude,
  riverOffset,
} from "@angels-bandits/common/city/river";
import { LOT_LINE } from "@angels-bandits/common/city/street";
import {
  collideTrains,
  generateTrains,
} from "@angels-bandits/common/city/train";
import {
  BORE_FLOOR_Y,
  BORE_HEIGHT,
  BORE_WIDTH,
  CUT_LENGTH,
  PORTAL_CUTS,
  RAMP_GRADE,
  RIVER_MOUTHS,
  TUNNELS,
  TUNNEL_RADIUS,
  type Tunnel,
  type TunnelFrame,
  type TunnelPoint,
  type TunnelSection,
  ceilingAt,
  floorAt,
  groundFloor,
  guideY,
  inCut,
  tunnelFrameInto,
  tunnelOpen,
  tunnelPointInto,
  tunnelSamples,
  tunnelSectionInto,
} from "@angels-bandits/common/city/tunnels";
import { hitsGround, losClear } from "@angels-bandits/common/collision";
import {
  BLOCK_PITCH,
  BOOST_MAX_SPEED,
  CITY_SEED,
  MAX_SPEED,
  PLAYER_RADIUS,
  WORLD_SIZE,
} from "@angels-bandits/common/constants";
import {
  type FlightInput,
  type FlightState,
  stepFlight,
} from "@angels-bandits/common/flight";
import {
  decodeSnapshotEntry,
  encodeSnapshotEntry,
} from "@angels-bandits/common/net";
import { type Vec3, wrapDeltaAxis } from "@angels-bandits/common/world";
import { describe, expect, it } from "vitest";

const wrap = (v: number) => ((v % WORLD_SIZE) + WORLD_SIZE) % WORLD_SIZE;
const pt = (): TunnelPoint => ({ x: 0, z: 0, th: 0 });
const frame = (): TunnelFrame => ({ s: 0, lat: 0, th: 0 });
const sec = (): TunnelSection => ({
  lx: 0,
  lz: 0,
  rx: 0,
  rz: 0,
  floor: 0,
  top: 0,
  covered: false,
});

/** The point at arc length `s`, `lat` m left of the centreline, at `y`. */
function at(t: Tunnel, s: number, lat: number, y: number): Vec3 {
  const p = tunnelPointInto(t, s, pt());
  return {
    x: wrap(p.x - Math.sin(p.th) * lat),
    y,
    z: wrap(p.z + Math.cos(p.th) * lat),
  };
}

describe("the network", () => {
  it("is 3–5 bores, ≥ 30 × 22 m, deep, with bends of ≥ 150 m radius", () => {
    expect(TUNNELS.length).toBeGreaterThanOrEqual(3);
    expect(TUNNELS.length).toBeLessThanOrEqual(5);
    expect(BORE_WIDTH).toBeGreaterThanOrEqual(30);
    expect(BORE_HEIGHT).toBeGreaterThanOrEqual(22);
    expect(TUNNEL_RADIUS).toBeGreaterThanOrEqual(150);
    expect(Math.atan(RAMP_GRADE)).toBeLessThanOrEqual((25 * Math.PI) / 180);
    for (const t of TUNNELS) {
      // Deep in the middle: the bore runs at y −40 … −64.
      const mid = t.length / 2;
      expect(floorAt(t, mid)).toBe(BORE_FLOOR_Y);
      expect(ceilingAt(t, mid)).toBe(BORE_FLOOR_Y + BORE_HEIGHT);
      expect(BORE_FLOOR_Y + BORE_HEIGHT).toBeLessThanOrEqual(-40);
      // Long enough to come out on the other side of the city.
      expect(t.length).toBeGreaterThan(800);
      // Starts and ends on a straight leg (the cuts and mouths are straight).
      expect(t.segs[0]?.arc).toBe(false);
      expect(t.segs[t.segs.length - 1]?.arc).toBe(false);
    }
    expect(PORTAL_CUTS.length + RIVER_MOUTHS.length).toBe(2 * TUNNELS.length);
  });

  it("is G1-continuous: every leg starts where the last one ended, on its heading", () => {
    for (const t of TUNNELS) {
      for (let i = 1; i < t.segs.length; i++) {
        const g = t.segs[i];
        if (!g) continue;
        const p = tunnelPointInto(t, g.s0 - 1e-9, pt());
        expect(Math.hypot(p.x - g.x0, p.z - g.z0)).toBeLessThan(1e-6);
        expect(Math.abs(p.th - g.th0)).toBeLessThan(1e-9);
      }
    }
  });

  it("is seed-free and torus-safe: every query agrees on all nine images of a point", () => {
    const rand = mulberry32(0x7055);
    const f0 = frame();
    const f1 = frame();
    for (let i = 0; i < 400; i++) {
      const t = TUNNELS[i % TUNNELS.length] as Tunnel;
      const s = rand() * t.length;
      const p = at(t, s, (rand() - 0.5) * 50, -70 + rand() * 75);
      const r = rand() * 3;
      const open = tunnelOpen(p, r);
      const ground = hitsGround(p, r);
      tunnelFrameInto(t, p, f0);
      for (const dx of [-WORLD_SIZE, 0, WORLD_SIZE]) {
        for (const dz of [-WORLD_SIZE, 0, WORLD_SIZE]) {
          const q = { x: p.x + dx, y: p.y, z: p.z + dz };
          expect(tunnelOpen(q, r)).toBe(open);
          expect(hitsGround(q, r)).toBe(ground);
          tunnelFrameInto(t, q, f1);
          expect(f1.s).toBeCloseTo(f0.s, 6);
          expect(f1.lat).toBeCloseTo(f0.lat, 6);
        }
      }
    }
  });

  it("frames a centreline point at its own arc length, on the centreline", () => {
    const f = frame();
    for (const t of TUNNELS) {
      for (let s = 0; s <= t.length; s += 7.3) {
        tunnelFrameInto(t, at(t, s, 0, -30), f);
        expect(f.s).toBeCloseTo(s, 4);
        expect(f.lat).toBeCloseTo(0, 4);
      }
    }
  });

  it("round-trips a plane at the tunnels' floor through the snapshot wire", () => {
    const pos = { x: 1234.5, y: BORE_FLOOR_Y + 3, z: 456.7 };
    const back = decodeSnapshotEntry(
      encodeSnapshotEntry({
        id: "a",
        pose: { pos, quat: { x: 0, y: 0, z: 0, w: 1 }, speed: 80 },
        hp: 100,
        prot: false,
      }),
    );
    expect(back.pose.pos.y).toBeCloseTo(pos.y, 1);
  });

  it("floors the server's pose clamp at the bores over a tunnel, the river elsewhere", () => {
    for (const t of TUNNELS) {
      for (let s = 0; s <= t.length; s += 25) {
        for (const lat of [0, BORE_WIDTH / 2 - 0.5, -BORE_WIDTH / 2 + 0.5]) {
          const p = at(t, s, lat, 0);
          expect(groundFloor(p.x, p.z, minAltitude(p.z))).toBe(BORE_FLOOR_Y);
        }
      }
    }
    // Mid-block, away from every bore: street level.
    expect(groundFloor(100, 100, minAltitude(100))).toBe(0);
  });
});

/** A plain autopilot, independent of the bots: a carrot `look` m ahead on
 * the centreline at the guide height, yaw/pitch errors to stick. */
function autopilot(
  t: Tunnel,
  dir: 1 | -1,
  st: FlightState,
  look: number,
): FlightInput {
  const f = tunnelFrameInto(t, st.pos, frame());
  const s = f.s + dir * look;
  const p = tunnelPointInto(t, s, pt());
  const dx = wrapDeltaAxis(st.pos.x, p.x);
  const dz = wrapDeltaAxis(st.pos.z, p.z);
  const dy = guideY(t, s) - st.pos.y;
  const wantYaw = Math.atan2(-dx, -dz);
  let dyaw = wantYaw - st.yaw;
  dyaw = Math.atan2(Math.sin(dyaw), Math.cos(dyaw));
  const wantPitch = Math.atan2(dy, Math.hypot(dx, dz));
  const k = 3;
  return {
    turn: Math.max(-1, Math.min(1, -dyaw * k)),
    pitch: Math.max(-1, Math.min(1, (wantPitch - st.pitch) * k)),
    roll: 0,
    throttle: 0,
  };
}

describe("flyable end to end", () => {
  // 60, 80 and 90 m/s on the throttle; ≥ 100 m/s under boost.
  const runs: { v: number; boost: boolean }[] = [
    { v: 60, boost: false },
    { v: 80, boost: false },
    { v: MAX_SPEED, boost: false },
    { v: 100, boost: true },
  ];
  for (const t of TUNNELS) {
    for (const dir of [1, -1] as const) {
      for (const { v, boost } of runs) {
        it(`${t.name} ${dir === 1 ? "→" : "←"} at ${v} m/s${boost ? " (boost)" : ""}`, () => {
          const s0 = dir === 1 ? 0 : t.length;
          const p = tunnelPointInto(t, s0, pt());
          const head = dir === 1 ? p.th : p.th + Math.PI;
          const slope = (guideY(t, s0 + dir * 2) - guideY(t, s0)) / 2;
          let st: FlightState = {
            pos: { x: wrap(p.x), y: guideY(t, s0), z: wrap(p.z) },
            // yaw 0 faces −z: forward (−sin yaw, −cos yaw) = (cos h, sin h).
            yaw: Math.atan2(-Math.cos(head), -Math.sin(head)),
            pitch: Math.atan(slope),
            roll: 0,
            speed: v,
            targetSpeed: Math.min(v, MAX_SPEED),
          };
          const dt = 1 / 60;
          const probe = PLAYER_RADIUS + 1;
          const f = frame();
          let minSpeed = Number.POSITIVE_INFINITY;
          let maxSpeed = 0;
          for (let k = 0; k < 60 * 60; k++) {
            st = stepFlight(st, { ...autopilot(t, dir, st, 40), boost }, dt);
            minSpeed = Math.min(minSpeed, st.speed);
            maxSpeed = Math.max(maxSpeed, st.speed);
            expect(hitsGround(st.pos, probe)).toBe(false);
            tunnelFrameInto(t, st.pos, f);
            if (dir === 1 ? f.s >= t.length : f.s <= 0) break;
          }
          // Came out the other side, at the speed it was flown at.
          expect(dir === 1 ? f.s >= t.length : f.s <= 0).toBe(true);
          expect(minSpeed).toBeGreaterThanOrEqual(v - 15);
          if (boost) expect(maxSpeed).toBeGreaterThanOrEqual(100);
          expect(maxSpeed).toBeLessThanOrEqual(BOOST_MAX_SPEED + 1);
        });
      }
    }
  }
});

describe("portals", () => {
  const seeds = [CITY_SEED, 1, 7, 1234];

  it("sit inside a plaza's lawn: off every street, clear of the pond", () => {
    for (const c of PORTAL_CUTS) {
      const bx = Math.floor((c.x0 + c.x1) / 2 / BLOCK_PITCH);
      const bz = Math.floor((c.z0 + c.z1) / 2 / BLOCK_PITCH);
      expect(PLAZA_BLOCKS.some(([x, z]) => x === bx && z === bz)).toBe(true);
      // Inside the lot lines, with a kerb's margin: no street, no sidewalk.
      const m = 3;
      expect(c.x0).toBeGreaterThan(bx * BLOCK_PITCH + LOT_LINE + m);
      expect(c.x1).toBeLessThan((bx + 1) * BLOCK_PITCH - LOT_LINE - m);
      expect(c.z0).toBeGreaterThan(bz * BLOCK_PITCH + LOT_LINE + m);
      expect(c.z1).toBeLessThan((bz + 1) * BLOCK_PITCH - LOT_LINE - m);
      // The pond (r 24 + rim at the block centre) keeps clear of the cut.
      const cx = (bx + 0.5) * BLOCK_PITCH;
      const cz = (bz + 0.5) * BLOCK_PITCH;
      const nx = Math.max(c.x0, Math.min(cx, c.x1));
      const nz = Math.max(c.z0, Math.min(cz, c.z1));
      expect(Math.hypot(nx - cx, nz - cz)).toBeGreaterThan(24 + 1.6 + 3);
      expect(c.x1 - c.x0 === CUT_LENGTH || c.z1 - c.z0 === CUT_LENGTH).toBe(
        true,
      );
    }
  });

  it("swallow no building, on any seed", () => {
    for (const seed of seeds) {
      for (const b of generateCity(seed)) {
        for (const c of PORTAL_CUTS) {
          const dx = Math.abs(wrapDeltaAxis((c.x0 + c.x1) / 2, b.x));
          const dz = Math.abs(wrapDeltaAxis((c.z0 + c.z1) / 2, b.z));
          const clear =
            dx > (c.x1 - c.x0) / 2 + b.width / 2 + 10 ||
            dz > (c.z1 - c.z0) / 2 + b.depth / 2 + 10;
          expect(clear).toBe(true);
        }
      }
    }
  });

  it("leave no tree or park lamp standing in a cut", () => {
    for (const seed of seeds) {
      const city = generateCity(seed);
      const nature = natureFor(seed, city);
      for (const c of PORTAL_CUTS) {
        const inCutRect = (x: number, z: number, m: number) =>
          Math.abs(wrapDeltaAxis((c.x0 + c.x1) / 2, x)) <
            (c.x1 - c.x0) / 2 + m &&
          Math.abs(wrapDeltaAxis((c.z0 + c.z1) / 2, z)) < (c.z1 - c.z0) / 2 + m;
        for (const t of nature.trees) {
          expect(inCutRect(t.x, t.z, t.canopyR + 1)).toBe(false);
        }
        for (const l of nature.lamps)
          expect(inCutRect(l.x, l.z, 1)).toBe(false);
      }
    }
  });

  it("intersect no H1/H2 hole, on any seed", () => {
    // A hole is cut through a building, mouth to mouth (its run-out is clear
    // AIR beyond, over the street — a cut below it obstructs nothing).
    for (const seed of seeds) {
      for (const h of cityHoles(generateCity(seed))) {
        const x = h.hole.axis === "x";
        const along = h.length / 2 + 10;
        const across = h.hole.width / 2 + 10;
        const hx = x ? along : across;
        const hz = x ? across : along;
        for (const c of PORTAL_CUTS) {
          const dx = Math.abs(wrapDeltaAxis((c.x0 + c.x1) / 2, h.center.x));
          const dz = Math.abs(wrapDeltaAxis((c.z0 + c.z1) / 2, h.center.z));
          const clear =
            dx > (c.x1 - c.x0) / 2 + hx || dz > (c.z1 - c.z0) / 2 + hz;
          expect(clear).toBe(true);
        }
      }
    }
  });

  it("stand under no train viaduct or station, on any seed", () => {
    for (const seed of seeds) {
      const city = generateCity(seed);
      const trains = generateTrains(seed, city);
      for (const c of PORTAL_CUTS) {
        for (let x = c.x0 - 5; x <= c.x1 + 5; x += 4) {
          for (let z = c.z0 - 5; z <= c.z1 + 5; z += 4) {
            for (let y = 1; y < 80; y += 6) {
              expect(collideTrains(trains, { x, y, z }, 4, null)).toBeNull();
            }
          }
        }
      }
    }
  });

  it("open river mouths between two bridges, never under a deck or a railing", () => {
    for (const m of RIVER_MOUTHS) {
      // The opening along the wall, with its frame lights, off every deck.
      const k = Math.round(m.x / BLOCK_PITCH) * BLOCK_PITCH;
      expect(Math.abs(m.x - k)).toBeGreaterThan(
        (m.x1 - m.x0) / 2 + BRIDGE_HALF_WIDTH + 5,
      );
      expect(m.y1).toBeLessThan(-BORE_HEIGHT / 24);
      expect(m.y1 - m.y0).toBeGreaterThanOrEqual(20);
    }
    // No bridge box or railing overlaps any bore's open volume: sampled
    // densely through every deck, parapet and railing near a mouth.
    const solids = [...bridgeBoxes()];
    for (const m of RIVER_MOUTHS) {
      for (const side of [-1, 1]) {
        solids.push({
          x: m.x,
          z: RIVER_CENTER_Z + side * (RIVER_HALF_WIDTH + PARAPET_THICKNESS / 2),
          hx: 100,
          hz: PARAPET_THICKNESS / 2,
          y0: 0,
          y1: PARAPET_HEIGHT,
        });
      }
    }
    for (const b of solids) {
      for (let x = -b.hx; x <= b.hx; x += 1) {
        for (let z = -b.hz; z <= b.hz; z += 1) {
          for (let y = b.y0; y <= b.y1; y += 0.5) {
            expect(tunnelOpen({ x: b.x + x, y, z: b.z + z }, 0)).toBe(false);
          }
        }
      }
    }
  });
});

describe("draw == collide", () => {
  it("every drawn section's walls, floor and ceiling are where the ground starts", () => {
    const r = PLAYER_RADIUS;
    const s0 = sec();
    let walls = 0;
    for (const t of TUNNELS) {
      const samples = tunnelSamples(t);
      for (const s of samples) {
        // The river mouths' in-channel stretch is the river's to draw.
        if (riverStretch(t, s)) continue;
        const covered = !inCut(t, s);
        tunnelSectionInto(t, s, covered, s0);
        const top = covered ? s0.top : 0;
        // Ramps: the sphere test takes the floor over [s − r, s + r].
        const slack = r * RAMP_GRADE + 0.05;
        // Walls, tested where a sphere fits between floor and wall top
        // (near a portal's lip the cut is shallower than a plane).
        const midY = covered
          ? (s0.floor + top) / 2
          : s0.floor + r + slack + 0.3;
        const w = BORE_WIDTH / 2;
        if (midY + r < top && midY - r > s0.floor + slack) {
          // A sphere clear of the drawn wall flies, one touching it dies.
          expect(hitsGround(at(t, s, w - r - 0.05, midY), r)).toBe(false);
          expect(hitsGround(at(t, s, w - r + 0.05, midY), r)).toBe(true);
          expect(hitsGround(at(t, s, -(w - r - 0.05), midY), r)).toBe(false);
          expect(hitsGround(at(t, s, -(w - r + 0.05), midY), r)).toBe(true);
          walls++;
        }
        // Floor.
        expect(hitsGround(at(t, s, 0, s0.floor + r + slack), r)).toBe(false);
        expect(hitsGround(at(t, s, 0, s0.floor + r - 0.05), r)).toBe(true);
        // Ceiling (a cut has none: open sky to street level and up).
        if (
          covered &&
          Math.abs(s - t.ends[0].cut) > r &&
          Math.abs(t.length - t.ends[1].cut - s) > r
        ) {
          expect(hitsGround(at(t, s, 0, top - r - slack), r)).toBe(false);
          expect(hitsGround(at(t, s, 0, top - r + 0.05), r)).toBe(true);
        } else if (!covered) {
          expect(hitsGround(at(t, s, 0, 5), r)).toBe(false);
        }
        // The drawn section matches the profile the ground reads.
        expect(s0.floor).toBe(floorAt(t, s));
        if (covered) expect(s0.top).toBe(ceilingAt(t, s));
      }
    }
    expect(walls).toBeGreaterThan(900);
  });

  it("the drawn wall feet are BORE_WIDTH apart, centred on the path", () => {
    const s0 = sec();
    for (const t of TUNNELS) {
      for (const s of tunnelSamples(t)) {
        tunnelSectionInto(t, s, true, s0);
        expect(Math.hypot(s0.lx - s0.rx, s0.lz - s0.rz)).toBeCloseTo(
          BORE_WIDTH,
          6,
        );
      }
    }
  });
});

/** Is `s` on a river mouth's stretch inside the channel (before its wall)? */
function riverStretch(t: Tunnel, s: number): boolean {
  const p = tunnelPointInto(t, s, pt());
  return Math.abs(riverOffset(p.z)) < RIVER_HALF_WIDTH + BORE_WIDTH;
}

describe("hitsGround", () => {
  it("is false inside every bore, cut and mouth", () => {
    for (const t of TUNNELS) {
      for (let s = 1; s < t.length - 1; s += 3) {
        for (const lat of [-12, 0, 12]) {
          const y = guideY(t, s);
          expect(hitsGround(at(t, s, lat, y), PLAYER_RADIUS)).toBe(false);
        }
      }
    }
  });

  it("is true below street level everywhere else (outside the channel)", () => {
    const rand = mulberry32(0x9e07);
    let tested = 0;
    for (let i = 0; i < 20000; i++) {
      const p = {
        x: rand() * WORLD_SIZE,
        y: -rand() * 70,
        z: rand() * WORLD_SIZE,
      };
      if (Math.abs(riverOffset(p.z)) < RIVER_HALF_WIDTH + 5) continue;
      if (nearAnyBore(p, BORE_WIDTH / 2 + 3)) continue;
      tested++;
      expect(hitsGround(p, 0.5)).toBe(true);
    }
    expect(tested).toBeGreaterThan(15000);
  });

  it("never opens a volume under the river's water (oblique mouths included)", () => {
    for (const m of RIVER_MOUTHS) {
      for (let x = m.x0 - 60; x <= m.x1 + 60; x += 1.5) {
        for (let off = -RIVER_HALF_WIDTH; off <= RIVER_HALF_WIDTH; off += 1.5) {
          for (const y of [-22.5, -25, -30, -40]) {
            const p = { x, y, z: RIVER_CENTER_Z + off };
            expect(hitsGround(p, 0)).toBe(true);
          }
        }
      }
    }
  });

  it("is solid past either end — no endless slab beyond a bore", () => {
    for (const t of TUNNELS) {
      for (const [s, kind] of [
        [-20, t.ends[0].kind],
        [t.length + 20, t.ends[1].kind],
      ] as const) {
        if (kind !== "plaza") continue;
        expect(hitsGround(at(t, s, 0, -5), PLAYER_RADIUS)).toBe(true);
      }
    }
  });
});

function nearAnyBore(p: Vec3, half: number): boolean {
  const f = frame();
  for (const t of TUNNELS) {
    tunnelFrameInto(t, p, f);
    if (f.s > -half && f.s < t.length + half && Math.abs(f.lat) < half) {
      return true;
    }
  }
  return false;
}

describe("losClear", () => {
  /** The truth: walk the line in 0.25 m steps against the ground. */
  function sampled(a: Vec3, b: Vec3): boolean {
    const dx = wrapDeltaAxis(a.x, b.x);
    const dz = wrapDeltaAxis(a.z, b.z);
    const dy = b.y - a.y;
    const n = Math.ceil(Math.hypot(dx, dy, dz) / 0.25);
    for (let i = 0; i <= n; i++) {
      const k = i / n;
      const p = { x: a.x + dx * k, y: a.y + dy * k, z: a.z + dz * k };
      if (p.y < 0 && hitsGround(p, 0)) return false;
    }
    return true;
  }

  it("agrees with the ground along random sight lines into and out of the bores", () => {
    const rand = mulberry32(0x105);
    let clear = 0;
    let blocked = 0;
    let disagree = 0;
    for (let i = 0; i < 1500; i++) {
      const t = TUNNELS[i % TUNNELS.length] as Tunnel;
      const s1 = rand() * t.length;
      const a = at(
        t,
        s1,
        (rand() - 0.5) * 30,
        guideY(t, s1) + (rand() - 0.5) * 16,
      );
      let b: Vec3;
      const kind = i % 3;
      if (kind === 0) {
        // Down the same bore, round its bends.
        const s2 = Math.max(0, Math.min(t.length, s1 + (rand() - 0.5) * 500));
        b = at(t, s2, (rand() - 0.5) * 30, guideY(t, s2) + (rand() - 0.5) * 16);
      } else if (kind === 1) {
        // Up into the sky over a portal or a mouth.
        const end = rand() < 0.5 ? 0 : t.length;
        b = at(
          t,
          end + (end === 0 ? -1 : 1) * rand() * 150,
          (rand() - 0.5) * 40,
          rand() * 120,
        );
      } else {
        // Anywhere in the air nearby.
        b = {
          x: wrap(a.x + (rand() - 0.5) * 600),
          y: rand() * 150,
          z: wrap(a.z + (rand() - 0.5) * 600),
        };
      }
      // Skip lines that graze a surface within the sampling resolution.
      if (hitsGround(a, 0) || (b.y < 0 && hitsGround(b, 0))) continue;
      const truth = sampled(a, b);
      if (truth) clear++;
      else blocked++;
      if (losClear(a, b, []) !== truth) disagree++;
    }
    expect(clear).toBeGreaterThan(200);
    expect(blocked).toBeGreaterThan(200);
    // Sampled at 1 m inside losClear vs 0.25 m here: a line may only
    // disagree where it clips a corner by under a metre.
    expect(disagree / (clear + blocked)).toBeLessThan(0.01);
  });

  it("sees straight down a bore and never through its rock", () => {
    const t = TUNNELS[0] as Tunnel;
    // Down the long straight between the two bends: clear.
    const g = t.segs[2];
    if (!g) throw new Error("Crosstown has five legs");
    const a = at(t, g.s0 + 5, 0, -52);
    const b = at(t, g.s0 + g.len - 5, 0, -52);
    expect(losClear(a, b, [])).toBe(true);
    // From the bore to a plane right above it in the street: rock.
    expect(losClear(a, { ...a, y: 30 }, [])).toBe(false);
    // From the bore out through its own portal: clear.
    const lip = at(t, 0, 0, 12);
    const inCutLow = at(t, 40, 0, guideY(t, 40));
    expect(losClear(inCutLow, lip, [])).toBe(true);
  });
});
