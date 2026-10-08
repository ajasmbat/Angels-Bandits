// The elevated trains (L5, T2). What these tests are defending:
//
//   1. Poses are a pure function of (seed, server time), and a lap closes.
//   2. The schedule delivers what it promises: every point of every track
//      sees a train at most TRAIN_HEADWAY apart, the dwell / brake / pull-away
//      profile is continuous in position and speed, and trains never overlap
//      — not on one track, not across the two, not into a platform.
//   3. The boxes you COLLIDE are the boxes you DRAW, for every car of every
//      train, and they are solid for bots too.
//   4. Nothing is buried: no line meets a building, a tree, a hole's flight
//      corridor, a crane, the river channel or another line.
//
// Worked numbers for the shipped city (seed 42): line 0 is L5's 1000 x 400 m
// loop from the intersection (800, 600), line 1 a 400 x 1000 m loop from
// (400, 1200). Each has 3 stations and 142 static boxes. Each track runs 10
// trains of 3 cars, a 195 s lap (10 x 19.5 s), cruising at 19.5 m/s
// (outer, 2762 m) and 19.2 m/s (inner, 2728 m).

import {
  type Building,
  CONSTRUCTION_BLOCKS,
  cityHoles,
  generateCity,
  mulberry32,
} from "@angels-bandits/common/city";
import {
  type MoverBox,
  collideBotMovers,
  collideMovers,
  craneBoxes,
  generateMovers,
  sphereHitsBox,
} from "@angels-bandits/common/city/movers";
import { natureFor } from "@angels-bandits/common/city/nature";
import {
  RIVER_HALF_WIDTH,
  riverOffset,
} from "@angels-bandits/common/city/river";
import {
  isInIntersection,
  isInRoadway,
  offCenterline,
} from "@angels-bandits/common/city/street";
import {
  CAR_PITCH,
  StaticRole,
  TRAIN_LENGTH,
  type TrainLine,
  type TrainState,
  type TrainTrack,
  blankCar,
  carBox,
  carBoxAt,
  collideTrain,
  generateTrains,
  lapTime,
  nextMeeting,
  solveCruise,
  stopClock,
  trainBoxes,
  trainFloor,
  trainHead,
  trainState,
} from "@angels-bandits/common/city/train";
import {
  type CityIndex,
  buildCityIndex,
  buildNatureIndex,
  collideCity,
  collideNature,
} from "@angels-bandits/common/collision";
import {
  BLOCK_PITCH,
  CITY_SEED,
  HOLE_RUN_OUT,
  PLAYER_RADIUS,
  TRAIN_ACCEL,
  TRAIN_CARS,
  TRAIN_DECK_TOP,
  TRAIN_DWELL,
  TRAIN_HEADWAY,
  TRAIN_PILLAR_SIDE,
  TRAIN_SPEED_MIN,
  TRAIN_STATION_TOP,
  TRAIN_TOP,
  WORLD_SIZE,
} from "@angels-bandits/common/constants";
import { type Vec3, wrapDeltaAxis } from "@angels-bandits/common/world";
import { describe, expect, it } from "vitest";

const city = generateCity(CITY_SEED);
const cityIndex = buildCityIndex(city);
const field = generateMovers(CITY_SEED, city);
const lines = field.trains ?? [];

/** A server-clock-sized time, so nothing is ever tested at a cosy t = 0. */
const T0 = 1_787_000_000_000;

const tracksOf = (ls: readonly TrainLine[]) =>
  ls.flatMap((line) => line.tracks.map((track) => ({ line, track })));

/** Every box a line ever occupies: the static boxes, and every car at many
 * times round a cycle. */
function sweep(l: TrainLine, stepMs = 2000): MoverBox[] {
  const out: MoverBox[] = [...l.viaduct];
  const cycle = (l.tracks[0] as TrainTrack).cycle * 1000;
  for (let t = 0; t < cycle; t += stepMs) out.push(...trainBoxes(l, T0 + t));
  return out;
}

/** Exact plan-view separating-axis test between two oriented boxes, each
 * grown by `pad` m, torus-correct. */
function obbOverlap(a: MoverBox, b: MoverBox, pad = 0): boolean {
  const dx = wrapDeltaAxis(a.x, b.x);
  const dz = wrapDeltaAxis(a.z, b.z);
  const axesOf = (m: MoverBox): [number, number][] => {
    const c = Math.cos(m.yaw);
    const s = Math.sin(m.yaw);
    return [
      [c, -s],
      [s, c],
    ];
  };
  const radius = (m: MoverBox, ax: number, az: number) => {
    const [[ux, uz], [vx, vz]] = axesOf(m) as [
      [number, number],
      [number, number],
    ];
    return (
      (m.hx + pad) * Math.abs(ux * ax + uz * az) +
      (m.hz + pad) * Math.abs(vx * ax + vz * az)
    );
  };
  for (const [ax, az] of [...axesOf(a), ...axesOf(b)]) {
    if (Math.abs(dx * ax + dz * az) > radius(a, ax, az) + radius(b, ax, az)) {
      return false;
    }
  }
  return true;
}

/** ...and in 3D: the vertical bands must overlap too. */
const boxesOverlap = (a: MoverBox, b: MoverBox, pad = 0) =>
  Math.abs(a.y - b.y) < a.hy + b.hy + pad && obbOverlap(a, b, pad);

/** Exact plan-view SAT: oriented box vs axis-aligned rectangle. */
function obbMeetsRect(
  b: MoverBox,
  r: { x: number; z: number; hx: number; hz: number },
): boolean {
  return obbOverlap(b, { ...b, x: r.x, z: r.z, hx: r.hx, hz: r.hz, yaw: 0 });
}

/** Walk each box's long axis in 1 m steps with a sphere that covers its
 * cross-section, as the crane test does — conservative in the safe
 * direction — and report the first city/tree contact. */
function buried(
  boxes: readonly MoverBox[],
  buildings: readonly Building[],
  index: CityIndex,
  trees?: ReturnType<typeof buildNatureIndex>,
): string[] {
  const bad: string[] = [];
  for (const b of boxes) {
    const ax = Math.cos(b.yaw);
    const az = -Math.sin(b.yaw);
    const radius = Math.hypot(b.hz, b.hy);
    for (let s = -b.hx; s <= b.hx; s += 1) {
      const p = { x: b.x + ax * s, y: b.y, z: b.z + az * s };
      if (collideCity(p, radius, buildings, index)) {
        bad.push(`${b.kind}#${b.id} building at s=${s.toFixed(0)}`);
        break;
      }
      if (trees && collideNature(p, radius, trees)) {
        bad.push(`${b.kind}#${b.id} tree at s=${s.toFixed(0)}`);
        break;
      }
    }
  }
  return bad;
}

describe("the shipped lines", () => {
  it("ships two lines for the live seed, 3-car sets, 2-3 stations, on real streets", () => {
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line.cars).toBe(TRAIN_CARS);
      expect(line.stations.length).toBeGreaterThanOrEqual(2);
      expect(line.stations.length).toBeLessThanOrEqual(3);
      // Corners are intersections: the loop runs on street centrelines.
      expect(line.ox % BLOCK_PITCH).toBe(0);
      expect(line.oz % BLOCK_PITCH).toBe(0);
      expect(Math.max(line.w, line.d)).toBeGreaterThanOrEqual(3 * BLOCK_PITCH);
      // Double track, opposite directions.
      const [outer, inner] = line.tracks;
      expect(outer.dir).toBe(-inner.dir);
      expect(outer.length).toBeGreaterThan(inner.length);
    }
    // L5's route did not move.
    const l5 = lines[0] as TrainLine;
    expect([l5.ox, l5.oz, l5.w, l5.d]).toEqual([800, 600, 1000, 400]);
  });

  it("puts every station mid-block on a straight, clear of every intersection", () => {
    for (const line of lines) {
      for (const st of line.stations) {
        expect(Math.min(offCenterline(st.x), offCenterline(st.z))).toBeLessThan(
          1e-6,
        );
        // 100 m from the crossings either side.
        const along = Math.abs(st.ux) > 0.5 ? st.x : st.z;
        expect(Math.abs((along % BLOCK_PITCH) - BLOCK_PITCH / 2)).toBeLessThan(
          1e-6,
        );
        expect(isInIntersection({ x: st.x, y: 0, z: st.z })).toBe(false);
      }
    }
  });

  it("finds routes for other seeds too, and keeps them out of the city", () => {
    let found = 0;
    for (const seed of [1, 2, 3, 7, 11]) {
      const c = generateCity(seed);
      const ls = generateTrains(seed, c);
      found += ls.length;
      for (const l of ls) {
        expect(buried(l.viaduct, c, buildCityIndex(c)).slice(0, 3)).toEqual([]);
      }
    }
    expect(found).toBeGreaterThanOrEqual(8);
  });
});

describe("the schedule", () => {
  it("solves the cruise speed on the slow branch: the lap is exactly N headways", () => {
    for (const { track } of tracksOf(lines)) {
      expect(track.cycle).toBeCloseTo(track.trains * TRAIN_HEADWAY, 9);
      expect(track.headway).toBe(TRAIN_HEADWAY);
      expect(
        lapTime(track.length, track.stops.length, track.speed),
      ).toBeCloseTo(track.cycle, 6);
      expect(track.speed).toBeGreaterThanOrEqual(TRAIN_SPEED_MIN);
      expect(track.speed).toBeLessThan(25);
      // The other root is the absurd one.
      expect(
        solveCruise(track.length, track.stops.length, track.trains),
      ).toBeCloseTo(track.speed, 9);
    }
  });

  it("headway: every point on every track sees a train at most 20 s apart", () => {
    // Brute force from the poses: step the clock through a whole cycle (plus a
    // headway so the wrap is covered), find every time a lead car's nose
    // crosses each sample point, and check the gaps. One spot check per track
    // that carBox really puts the lead car on that point at the crossing.
    const STEP = 0.1;
    for (const { line, track } of tracksOf(lines)) {
      const points: number[] = [];
      for (let q = 0; q < track.length; q += 25) points.push(q);
      const passes: number[][] = points.map(() => []);
      const prev: number[] = [];
      for (let j = 0; j < track.trains; j++) prev.push(trainHead(track, j, T0));
      const span = track.cycle + TRAIN_HEADWAY;
      for (let s = STEP; s <= span + 1e-9; s += STEP) {
        const t = T0 + s * 1000;
        for (let j = 0; j < track.trains; j++) {
          let q = trainHead(track, j, t);
          const p = prev[j] as number;
          // Profiles are continuous; unwrap the cycle seam into p's lap.
          q += Math.round((p - q) / track.length) * track.length;
          if (q < p - 1e-6) throw new Error("a train went backwards");
          if (q > p) {
            points.forEach((x, k) => {
              const lap = Math.ceil((p - x) / track.length);
              const at = x + lap * track.length;
              if (at > p && at <= q) {
                passes[k]?.push(s - STEP + (STEP * (at - p)) / (q - p));
              }
            });
          }
          prev[j] = q;
        }
      }
      let worst = 0;
      passes.forEach((times, k) => {
        times.sort((a, b) => a - b);
        expect(times.length).toBeGreaterThanOrEqual(track.trains);
        for (let i = 1; i < times.length; i++) {
          worst = Math.max(
            worst,
            (times[i] as number) - (times[i - 1] as number),
          );
        }
        // Nothing may be missing at the start of the window either.
        expect(times[0] as number).toBeLessThanOrEqual(20);
        if (k === 0) {
          // At the first crossing, carBox really has some lead car there.
          const at = T0 + (times[0] as number) * 1000;
          const spot = carBoxAt(
            line,
            track,
            points[0] as number,
            0,
            0,
            blankCar(),
          );
          let best = Number.POSITIVE_INFINITY;
          for (let j = 0; j < track.trains; j++) {
            const real = carBox(line, track.index, j, 0, at, blankCar());
            best = Math.min(
              best,
              Math.hypot(
                wrapDeltaAxis(spot.x, real.x),
                wrapDeltaAxis(spot.z, real.z),
              ),
            );
          }
          expect(best).toBeLessThan(track.speed * STEP + 0.5);
        }
      });
      expect(worst).toBeLessThanOrEqual(20);
      expect(worst).toBeCloseTo(TRAIN_HEADWAY, 0);
    }
  });

  it("is continuous in position and speed through every dwell, brake and pull-away", () => {
    const STEP_MS = 10;
    const dt = STEP_MS / 1000;
    const s: TrainState = { q: 0, v: 0, doors: 0, station: -1 };
    for (const { track } of tracksOf(lines)) {
      let q0 = trainState(track, 0, T0, s).q;
      let v0 = s.v;
      let maxV = 0;
      let dwellSteps = 0;
      let openSteps = 0;
      for (let ms = STEP_MS; ms <= track.cycle * 1000; ms += STEP_MS) {
        trainState(track, 0, T0 + ms, s);
        let q = s.q;
        q += Math.round((q0 - q) / track.length) * track.length;
        // Position moves by at most v·dt, never backwards; speed by a·dt.
        expect(q - q0).toBeGreaterThanOrEqual(-1e-6);
        expect(q - q0).toBeLessThanOrEqual(track.speed * dt + 1e-4);
        expect(Math.abs(s.v - v0)).toBeLessThanOrEqual(TRAIN_ACCEL * dt + 1e-6);
        expect(s.v).toBeGreaterThanOrEqual(-1e-9);
        maxV = Math.max(maxV, s.v);
        if (s.station >= 0) {
          dwellSteps++;
          expect(s.v).toBe(0);
          if (s.doors > 0) openSteps++;
        } else {
          expect(s.doors).toBe(0);
        }
        q0 = q;
        v0 = s.v;
      }
      expect(maxV).toBeCloseTo(track.speed, 6);
      // ~8 s at each stop, doors open for most of it.
      const stops = track.stops.length;
      expect(dwellSteps * dt).toBeCloseTo(stops * TRAIN_DWELL, 0);
      expect(openSteps * dt).toBeGreaterThan(stops * (TRAIN_DWELL - 3));
    }
  });

  it("is a pure function of time that returns to the same pose after one lap", () => {
    for (const { line, track } of tracksOf(lines)) {
      const lapMs = track.cycle * 1000;
      for (const j of [0, Math.floor(track.trains / 2), track.trains - 1]) {
        for (let i = 0; i < line.cars; i++) {
          for (const t of [T0, T0 + 12_345, T0 + 987_654]) {
            const a = carBox(line, track.index, j, i, t, blankCar());
            const b = carBox(line, track.index, j, i, t + lapMs, blankCar());
            // Tolerance is double precision at epoch-ms times (lap-closure).
            expect(b.x).toBeCloseTo(a.x, 4);
            expect(b.z).toBeCloseTo(a.z, 4);
            expect(b.yaw).toBeCloseTo(a.yaw, 4);
          }
        }
      }
    }
  });

  it("dwells at the stations: a stopped train is centred on a platform with its doors open", () => {
    const s: TrainState = { q: 0, v: 0, doors: 0, station: -1 };
    for (const { line, track } of tracksOf(lines)) {
      track.stops.forEach((_, k) => {
        // Half way through a dwell at stop k, some train is standing there.
        const t = T0 + (TRAIN_DWELL / 2 - stopClock(track, k, T0)) * 1000;
        const later =
          t + (stopClock(track, k, t) < 1 ? 0 : track.headway * 1000);
        expect(stopClock(track, k, later)).toBeCloseTo(TRAIN_DWELL / 2, 3);
        let standing = 0;
        for (let j = 0; j < track.trains; j++) {
          trainState(track, j, later, s);
          if (s.station !== track.stopStation[k]) continue;
          standing++;
          expect(s.v).toBe(0);
          expect(s.doors).toBe(1);
          const mid = carBoxAt(line, track, s.q - CAR_PITCH, 0, 0, blankCar());
          const st = line.stations[s.station];
          if (!st) throw new Error("no station");
          const off = Math.hypot(
            wrapDeltaAxis(st.x, mid.x),
            wrapDeltaAxis(st.z, mid.z),
          );
          // The middle car's centre is beside the platform's centre.
          expect(off).toBeCloseTo(Math.abs(track.offset), 6);
        }
        expect(standing).toBe(1);
      });
    }
  });

  it("moves: a cruising car is somewhere else half a second later, along its nose", () => {
    const s: TrainState = { q: 0, v: 0, doors: 0, station: -1 };
    for (const { line, track } of tracksOf(lines)) {
      let t = T0;
      while (trainState(track, 0, t, s).v < track.speed - 0.01) t += 250;
      const a = carBox(line, track.index, 0, 0, t, blankCar());
      const b = carBox(line, track.index, 0, 0, t + 500, blankCar());
      const dx = wrapDeltaAxis(a.x, b.x);
      const dz = wrapDeltaAxis(a.z, b.z);
      expect(Math.hypot(dx, dz)).toBeGreaterThan(5);
      // Local +X maps to world (cos yaw, -sin yaw): travel must agree with it.
      expect(Math.cos(a.yaw) * dx - Math.sin(a.yaw) * dz).toBeGreaterThan(0);
    }
  });
});

describe("trains never overlap", () => {
  const STEP_MS = 250;

  it("same track: nose to tail stays at least 10 m, cars stay coupled", () => {
    for (const { line, track } of tracksOf(lines)) {
      let closest = Number.POSITIVE_INFINITY;
      for (let ms = 0; ms < track.cycle * 1000; ms += STEP_MS) {
        const t = T0 + ms;
        const heads = Array.from(
          { length: track.trains },
          (_, j) =>
            ((trainHead(track, j, t) % track.length) + track.length) %
            track.length,
        ).sort((a, b) => a - b);
        for (let j = 0; j < heads.length; j++) {
          const a = heads[j] as number;
          const b =
            j + 1 < heads.length
              ? (heads[j + 1] as number)
              : (heads[0] as number) + track.length;
          closest = Math.min(closest, b - a - TRAIN_LENGTH);
        }
        if (ms % 5000 === 0) {
          const cars = Array.from({ length: line.cars }, (_, i) =>
            carBox(line, track.index, 0, i, t, blankCar()),
          );
          for (let i = 1; i < cars.length; i++) {
            const a = cars[i - 1] as MoverBox;
            const b = cars[i] as MoverBox;
            const gap = Math.hypot(
              wrapDeltaAxis(a.x, b.x),
              wrapDeltaAxis(a.z, b.z),
            );
            // Straight: exactly the pitch; on a curve the chord is shorter.
            expect(gap).toBeGreaterThan(CAR_PITCH - 1.5);
            expect(gap).toBeLessThanOrEqual(CAR_PITCH + 1e-6);
          }
        }
      }
      expect(closest).toBeGreaterThanOrEqual(10);
    }
  });

  it("opposite tracks: cars never touch, even on the curves", () => {
    for (const line of lines) {
      const [outer, inner] = line.tracks;
      let near = 0;
      for (let ms = 0; ms < outer.cycle * 1000; ms += STEP_MS * 2) {
        const t = T0 + ms;
        const a: MoverBox[] = [];
        const b: MoverBox[] = [];
        for (let j = 0; j < outer.trains; j++) {
          for (let i = 0; i < line.cars; i++) {
            a.push(carBox(line, 0, j, i, t, blankCar()));
          }
        }
        for (let j = 0; j < inner.trains; j++) {
          for (let i = 0; i < line.cars; i++) {
            b.push(carBox(line, 1, j, i, t, blankCar()));
          }
        }
        for (const p of a) {
          for (const q of b) {
            if (Math.abs(wrapDeltaAxis(p.x, q.x)) > 20) continue;
            if (Math.abs(wrapDeltaAxis(p.z, q.z)) > 20) continue;
            near++;
            expect(boxesOverlap(p, q)).toBe(false);
          }
        }
      }
      // They really do pass each other — the test is not vacuous.
      expect(near).toBeGreaterThan(50);
    }
  });

  it("never touches a platform, canopy, rail or post", () => {
    for (const line of lines) {
      const fixtures = line.viaduct.filter(
        (_, i) => (line.roles[i] ?? 0) >= StaticRole.Platform,
      );
      expect(fixtures.length).toBe(line.stations.length * 16);
      let checked = 0;
      for (let ms = 0; ms < 60_000; ms += 500) {
        for (const car of trainBoxes(line, T0 + ms)) {
          for (const f of fixtures) {
            if (Math.abs(wrapDeltaAxis(f.x, car.x)) > 50) continue;
            if (Math.abs(wrapDeltaAxis(f.z, car.z)) > 50) continue;
            checked++;
            expect(boxesOverlap(car, f, 0.05)).toBe(false);
          }
        }
      }
      expect(checked).toBeGreaterThan(100);
    }
  });
});

describe("draw == collide", () => {
  it("collideMovers agrees with a brute-force scan of every drawn train box", () => {
    const rand = mulberry32(0x7a1);
    const mismatches: string[] = [];
    let hits = 0;
    let carsHit = 0;
    const cycle = (lines[0]?.tracks[0].cycle ?? 1) * 1000;
    for (let n = 0; n < 4000; n++) {
      const t = T0 + rand() * cycle;
      const line = lines[Math.floor(rand() * lines.length)] as TrainLine;
      // Half the samples on a car, half on the static boxes.
      const cars = trainBoxes(line, t);
      const pool = rand() < 0.5 ? cars : line.viaduct;
      const box = pool[Math.floor(rand() * pool.length)] as MoverBox;
      const ax = Math.cos(box.yaw);
      const az = -Math.sin(box.yaw);
      const lx = (rand() * 2 - 1) * (box.hx + PLAYER_RADIUS) * 1.4;
      const lz = (rand() * 2 - 1) * (box.hz + PLAYER_RADIUS) * 1.6;
      const pos: Vec3 = {
        x: box.x + ax * lx - az * lz,
        y: box.y + (rand() * 2 - 1) * (box.hy + PLAYER_RADIUS) * 1.6,
        z: box.z + az * lx + ax * lz,
      };
      const drawn = lines.some((l) =>
        [...l.viaduct, ...(l === line ? cars : trainBoxes(l, t))].some((b) =>
          sphereHitsBox(b, pos, PLAYER_RADIUS),
        ),
      );
      const direct = lines.some(
        (l) => collideTrain(l, pos, PLAYER_RADIUS, t) !== null,
      );
      const hit = collideMovers(pos, PLAYER_RADIUS, field, t);
      const bot = collideBotMovers(pos, PLAYER_RADIUS, field, t);
      const trainHit =
        hit !== null && (hit.kind === "train" || hit.kind === "viaduct");
      if (direct) hits++;
      if (hit?.kind === "train") carsHit++;
      // Another mover (a boat, an aircraft) may legitimately be hit first.
      const otherMover = hit !== null && !trainHit;
      if (
        direct !== drawn ||
        (!otherMover && trainHit !== drawn) ||
        (bot !== null) !== (hit !== null && hit.kind !== "helicopter")
      ) {
        mismatches.push(
          `t=${t} pos=(${pos.x.toFixed(1)},${pos.y.toFixed(1)},${pos.z.toFixed(1)}) direct=${direct} collide=${hit?.kind} bot=${bot?.kind} drawn=${drawn}`,
        );
      }
    }
    expect(mismatches.slice(0, 5)).toEqual([]);
    expect(hits).toBeGreaterThan(400);
    expect(hits).toBeLessThan(3600);
    expect(carsHit).toBeGreaterThan(200);
  });

  it("reports every car of every train with its own id", () => {
    const ids = new Set<number>();
    for (const line of lines) {
      for (const car of trainBoxes(line, T0)) {
        const hit = collideTrain(line, car, PLAYER_RADIUS, T0);
        expect(hit?.kind).toBe("train");
        ids.add(hit?.id ?? -1);
      }
    }
    const cars = lines.reduce(
      (n, l) => n + l.tracks.reduce((m, k) => m + k.trains, 0) * l.cars,
      0,
    );
    expect(ids.size).toBe(cars);
  });

  it("is solid for bots too: a deck, a pillar, a platform, a canopy and a car all register", () => {
    const line = lines[0] as TrainLine;
    const pick = (role: StaticRole) =>
      line.viaduct[line.roles.indexOf(role)] as MoverBox;
    const car = carBox(line, 0, 0, 0, T0, blankCar());
    for (const b of [
      pick(StaticRole.Deck),
      pick(StaticRole.Pillar),
      pick(StaticRole.Platform),
      pick(StaticRole.Canopy),
      car,
    ]) {
      const hit = collideBotMovers(
        { x: b.x, y: b.y, z: b.z },
        PLAYER_RADIUS,
        field,
        T0,
      );
      expect(hit?.kind).toBe(b.kind);
    }
    // The bot floor: over a line it is above the cars, far away it is 0.
    const deck = pick(StaticRole.Deck);
    expect(
      trainFloor(lines, { x: deck.x, y: 0, z: deck.z }, 0),
    ).toBeGreaterThan(TRAIN_STATION_TOP);
    const far = { x: line.ox + line.w / 2, y: 0, z: line.oz + line.d / 2 };
    expect(trainFloor(lines, far, 0)).toBe(0);
  });

  it("keeps the viaduct and stations solid with no clock, and only them", () => {
    const line = lines[0] as TrainLine;
    for (const b of line.viaduct) {
      expect(
        collideTrain(line, { x: b.x, y: b.y, z: b.z }, PLAYER_RADIUS, null)
          ?.kind,
      ).toBe("viaduct");
    }
    const car = carBox(line, 0, 0, 0, T0, blankCar());
    const onCar = { x: car.x, y: car.y + 1, z: car.z };
    expect(collideTrain(line, onCar, PLAYER_RADIUS, null)).toBeNull();
    expect(collideTrain(line, onCar, PLAYER_RADIUS, T0)?.kind).toBe("train");
  });
});

describe("nothing is buried", () => {
  it("stands every pillar on a street centreline, clear of every intersection", () => {
    for (const line of lines) {
      const pillars = line.viaduct.filter(
        (_, i) => line.roles[i] === StaticRole.Pillar,
      );
      expect(pillars.length).toBeGreaterThan(20);
      for (const p of pillars) {
        const off = Math.min(offCenterline(p.x), offCenterline(p.z));
        expect(off).toBeLessThan(0.01);
        expect(TRAIN_PILLAR_SIDE / 2).toBeLessThan(5 - 1);
        expect(isInIntersection({ x: p.x, y: 0, z: p.z })).toBe(false);
        expect(isInRoadway({ x: p.x, y: 0, z: p.z })).toBe(true);
      }
    }
  });

  it("never intersects a building or a solid tree — viaduct, stations or trains", () => {
    const trees = buildNatureIndex(natureFor(CITY_SEED, city));
    for (const line of lines) {
      expect(buried(sweep(line), city, cityIndex, trees).slice(0, 5)).toEqual(
        [],
      );
    }
  });

  it("never intersects an H1 hole volume (the clear tunnel plus its run-out)", () => {
    const bad: string[] = [];
    for (const line of lines) {
      const boxes = sweep(line, 4000);
      for (const span of cityHoles(city)) {
        const { hole } = span;
        const x = hole.axis === "x";
        const along = span.length / 2 + HOLE_RUN_OUT;
        const across = hole.width / 2;
        const area = {
          x: span.center.x,
          z: span.center.z,
          hx: x ? along : across,
          hz: x ? across : along,
        };
        for (const b of boxes) {
          if (b.y + b.hy < hole.y0 || b.y - b.hy > hole.y0 + hole.height) {
            continue;
          }
          if (obbMeetsRect(b, area)) {
            bad.push(
              `line ${line.index} ${b.kind}#${b.id} in ${hole.kind} at (${area.x},${area.z})`,
            );
            break;
          }
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it("never meets a crane, at any slew", () => {
    const bad: string[] = [];
    expect(field.cranes.length).toBe(CONSTRUCTION_BLOCKS.length);
    for (const line of lines) {
      const boxes = sweep(line, 8000);
      for (let ms = 0; ms < 400_000; ms += 10_000) {
        for (const c of field.cranes) {
          for (const part of craneBoxes(c, T0 + ms)) {
            for (const b of boxes) {
              if (boxesOverlap(part, b, PLAYER_RADIUS)) {
                bad.push(
                  `line ${line.index} ${b.kind}#${b.id} vs crane ${c.id}`,
                );
              }
            }
          }
        }
      }
    }
    expect(bad.slice(0, 5)).toEqual([]);
  });

  it("never stands in the river channel", () => {
    for (const line of lines) {
      for (const b of line.viaduct) {
        // The box's plan-view half-extent across the river (along z).
        const ez =
          Math.abs(Math.sin(b.yaw)) * b.hx + Math.abs(Math.cos(b.yaw)) * b.hz;
        const reach = Math.abs(riverOffset(b.z)) - ez;
        expect(reach).toBeGreaterThan(RIVER_HALF_WIDTH);
      }
    }
  });

  it("keeps the lines apart: no box of one comes within 20 m of another's", () => {
    for (let a = 0; a < lines.length; a++) {
      for (let b = a + 1; b < lines.length; b++) {
        const A = sweep(lines[a] as TrainLine, 8000);
        const B = sweep(lines[b] as TrainLine, 8000);
        for (const p of A) {
          for (const q of B) {
            if (Math.abs(wrapDeltaAxis(p.x, q.x)) > 80) continue;
            if (Math.abs(wrapDeltaAxis(p.z, q.z)) > 80) continue;
            expect(obbOverlap(p, q, 10)).toBe(false);
          }
        }
      }
    }
  });

  it("canonicalizes every box", () => {
    for (const line of lines) {
      for (const b of [...line.viaduct, ...trainBoxes(line, T0 + 4321)]) {
        expect(b.x).toBeGreaterThanOrEqual(0);
        expect(b.x).toBeLessThan(WORLD_SIZE);
        expect(b.z).toBeGreaterThanOrEqual(0);
        expect(b.z).toBeLessThan(WORLD_SIZE);
        expect(b.y + b.hy).toBeLessThanOrEqual(TRAIN_STATION_TOP + 1e-9);
        if (b.kind === "train") {
          expect(b.y + b.hy).toBeCloseTo(TRAIN_TOP, 9);
        }
      }
    }
  });
});

describe("QA helpers", () => {
  it("finds a moment two trains pass each other", () => {
    for (const line of lines) {
      const m = nextMeeting(line, T0);
      expect(m).not.toBeNull();
      if (!m) continue;
      expect(m.timeMs).toBeGreaterThanOrEqual(T0);
      // Both tracks really have a car right there.
      const cars = trainBoxes(line, m.timeMs);
      const near = (k: number) =>
        cars.some(
          (c) =>
            Math.floor(c.id / 8 / 64) % 2 === k &&
            Math.hypot(wrapDeltaAxis(m.x, c.x), wrapDeltaAxis(m.z, c.z)) < 12,
        );
      expect(near(0)).toBe(true);
      expect(near(1)).toBe(true);
    }
  });

  it("deck top is the rail level the cars ride on", () => {
    const line = lines[0] as TrainLine;
    const car = carBox(line, 0, 0, 0, T0, blankCar());
    expect(car.y - car.hy).toBeGreaterThan(TRAIN_DECK_TOP);
  });
});
