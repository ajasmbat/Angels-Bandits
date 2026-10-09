// U4 × H3: the invisible save threads the tunnels' mouths too — a plaza
// portal's lintel and a river mouth's jamb — measured in the bore's own path
// frame (grade included), the way main.ts flies it: stepFlight → stepHoleSave
// in place → detectCrash. Each near-miss is first flown WITHOUT the save to
// prove it really crashes.

import { generateCity } from "@angels-bandits/common/city";
import {
  BORE_WIDTH,
  TUNNELS,
  type Tunnel,
  ceilingAt,
  guideSlope,
  guideY,
  tunnelFrameInto,
  tunnelPointInto,
} from "@angels-bandits/common/city/tunnels";
import { buildCityIndex } from "@angels-bandits/common/collision";
import {
  CITY_SEED,
  PLAYER_RADIUS,
  WORLD_SIZE,
} from "@angels-bandits/common/constants";
import {
  type FlightInput,
  type FlightState,
  stepFlight,
} from "@angels-bandits/common/flight";
import { describe, expect, it } from "vitest";
import { detectCrash } from "../src/game/collision";
import { cornerSpeed, holeCorridors } from "../src/game/corner-speed";
import {
  SAVE_MAX_OFFSET,
  type SaveWorld,
  createHoleSave,
  stepHoleSave,
} from "../src/game/hole-save";

const city = generateCity(CITY_SEED);
const index = buildCityIndex(city);
const world: SaveWorld = {
  spans: [],
  tunnels: TUNNELS,
  buildings: city,
  index,
};
const wrap = (v: number) => ((v % WORLD_SIZE) + WORLD_SIZE) % WORLD_SIZE;
const NEUTRAL: FlightInput = { pitch: 0, turn: 0, roll: 0, throttle: 0 };

/** A plane on `t`'s path at `s`, `lat` left of it, `up` over the guide line,
 * nose along the path (heading and grade), stick neutral. */
function onPath(t: Tunnel, s: number, lat: number, up: number): FlightState {
  const p = tunnelPointInto(t, s, { x: 0, z: 0, th: 0 });
  return {
    pos: {
      x: wrap(p.x - Math.sin(p.th) * lat),
      y: guideY(t, s) + up,
      z: wrap(p.z + Math.cos(p.th) * lat),
    },
    yaw: Math.atan2(-Math.cos(p.th), -Math.sin(p.th)),
    pitch: Math.atan(guideSlope(t, s)),
    roll: 0,
    speed: 80,
    targetSpeed: 80,
  };
}

/**
 * Fly at 60 Hz on a neutral stick until the plane is `past` m beyond arc
 * length `until` on `t` (through the mouth — a neutral stick does not follow
 * the bore's dive after it, which is the pilot's job, not the save's).
 * Returns whether it crashed and how many saves fired.
 */
function fly(
  t: Tunnel,
  start: FlightState,
  save: boolean,
  until: number,
): { crashed: boolean; saves: number } {
  const s = createHoleSave();
  const f = { s: 0, lat: 0, th: 0 };
  let st = start;
  const dt = 1 / 60;
  for (let k = 0; k < 180; k++) {
    st = stepFlight(st, NEUTRAL, dt);
    if (save) stepHoleSave(s, st, NEUTRAL, dt, world, null, true);
    if (detectCrash(st, city, index)) return { crashed: true, saves: s.saves };
    if (tunnelFrameInto(t, st.pos, f).s > until) break;
  }
  return { crashed: false, saves: s.saves };
}

describe("H3 save at the tunnel mouths", () => {
  const crosstown = TUNNELS[0] as Tunnel;
  const riverside = TUNNELS[1] as Tunnel;

  it("threads a plaza portal's lintel a plane dives at a little high", () => {
    // Down the ramp toward the lintel at s = 80, centre 0.6 m too high to
    // pass under it (the ceiling continues at the ramp's grade).
    const lintel = ceilingAt(crosstown, 81);
    const up = lintel - PLAYER_RADIUS + 0.6 - guideY(crosstown, 81);
    const start = onPath(crosstown, 30, 0, up);
    expect(fly(crosstown, start, false, 120).crashed).toBe(true);
    const saved = fly(crosstown, start, true, 120);
    expect(saved.crashed).toBe(false);
    expect(saved.saves).toBeGreaterThan(0);
  });

  it("threads a river mouth's jamb a plane comes in a little wide", () => {
    // In the channel on the bore's line, 0.6 m too far left to clear the
    // mouth's left jamb.
    const lat = BORE_WIDTH / 2 - PLAYER_RADIUS + 0.6;
    const start = onPath(riverside, 0, lat, 0);
    // Past both jambs (the wall is oblique: they are 40 m apart along s).
    const through = riverside.ends[0].flat;
    expect(fly(riverside, start, false, through).crashed).toBe(true);
    const saved = fly(riverside, start, true, through);
    expect(saved.crashed).toBe(false);
    expect(saved.saves).toBeGreaterThan(0);
  });

  it("never saves a line more than its cap off — a wall hit head-on still kills", () => {
    const lat = BORE_WIDTH / 2 - PLAYER_RADIUS + SAVE_MAX_OFFSET + 1;
    const start = onPath(riverside, 0, lat, 0);
    expect(fly(riverside, start, true, riverside.ends[0].flat).crashed).toBe(
      true,
    );
  });
});

describe("F5 corner speed in a tunnel", () => {
  it("keeps the full ceiling inside a bore, even facing a bend's wall", () => {
    const corners = {
      buildings: city,
      index,
      corridors: holeCorridors([]),
      tunnels: true,
    };
    const t = TUNNELS[0] as Tunnel;
    // Mid-bend, nose straight ahead (the wall is 300 m-radius away).
    const g = t.segs[1];
    if (!g) throw new Error("Crosstown has five legs");
    const st = onPath(t, g.s0 + g.len / 2, 0, 0);
    expect(cornerSpeed(st, corners, 1)).toBeGreaterThanOrEqual(st.targetSpeed);
  });
});
