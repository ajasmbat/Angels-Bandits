// E1 Air force: a plane's image never pops when it changes how it travels.
// I1: a pilot's plane reaches this client as its own entry, at 5 Hz while
// it is out past the full-rate tier; when a human comes close it PROMOTES
// and the brain flies it on from the very flight its pilot had — at 20 Hz.
// Both feed the same InterpolationBuffer, so the drawn pose glides through
// the hand-over exactly as it glides between any two snapshots.

import { generateCity } from "@angels-bandits/common/city";
import {
  CITY_SEED,
  SNAPSHOT_INTERVAL_MS,
} from "@angels-bandits/common/constants";
import { type FlightState, stepFlight } from "@angels-bandits/common/flight";
import { IM_MID_EVERY } from "@angels-bandits/common/interest";
import {
  decodeSnapshotEntry,
  encodeSnapshotEntry,
} from "@angels-bandits/common/net";
import {
  PILOT_FLOOR_ALT,
  RooflineGrid,
  attitudeQuatInto,
  floorAhead,
  newPilot,
  stepPilot,
} from "@angels-bandits/common/pilots";
import type { Pose, SnapshotEntry } from "@angels-bandits/common/protocol";
import { BOT_TUNING } from "@angels-bandits/common/tuning";
import { wrapDistance } from "@angels-bandits/common/world";
import { describe, expect, it } from "vitest";
import { InterpolationBuffer } from "../src/net/interp";

const grid = RooflineGrid.build(generateCity(CITY_SEED));
const T0 = 1_790_000_000_000;
const ID = "bot:room-1:105";

/** The snapshots one client receives for one pilot's plane: its own entry
 * (every IM_MID_EVERY-th tick before `nearTick`, the mid tier, then every
 * tick) until `promoteTick`, then an ace on the same entry every tick (the
 * full-rate tier: promotion happens close, inside it). */
function feed(promoteTick: number, ticks: number, nearTick = 0) {
  const pos = { x: 600, y: 0, z: 900 };
  const yaw = 0.4;
  pos.y = Math.max(PILOT_FLOOR_ALT, floorAhead(grid, pos, yaw));
  const p = newPilot(ID, 0, 7, pos, yaw, 74);
  const pose: Pose = {
    pos: p.pos,
    quat: { x: 0, y: 0, z: 0, w: 1 },
    speed: p.speed,
  };
  let ace: FlightState | null = null;
  const out: { time: number; entry: SnapshotEntry }[] = [];
  const dt = SNAPSHOT_INTERVAL_MS / 1000;
  const entry = (pose: Pose): SnapshotEntry =>
    decodeSnapshotEntry(
      encodeSnapshotEntry({ id: ID, pose, hp: 100, prot: false }),
    );
  for (let t = 0; t < ticks; t++) {
    const time = T0 + t * SNAPSHOT_INTERVAL_MS;
    if (t < promoteTick) {
      p.wantYaw = 0.4 + 0.3 * Math.sin(t / 30);
      stepPilot(p, grid, [], dt, t % 4 === 0, t % 2 === 0);
      attitudeQuatInto(p.yaw, p.pitch, p.roll, pose.quat);
      pose.speed = p.speed;
      if (t >= nearTick || t % IM_MID_EVERY === 0) {
        out.push({ time, entry: entry(pose) });
      }
      if (t === promoteTick - 1) {
        // The promotion: the brain takes the pilot's flight as it stands
        // (RoomBots.promote copies it).
        ace = {
          pos: { ...p.pos },
          yaw: p.yaw,
          pitch: p.pitch,
          roll: p.roll,
          bank: p.roll,
          rollRate: 0,
          speed: p.speed,
          targetSpeed: p.speed,
        };
      }
    } else if (ace) {
      // The ace flies on (a gentle pull — any brain input is continuous).
      ace = stepFlight(
        ace,
        { pitch: 0.15, turn: 0.3, roll: 0, throttle: 0, pitchLimit: 0.4 },
        dt,
        BOT_TUNING,
      );
      const q = attitudeQuatInto(ace.yaw, ace.pitch, ace.roll, {
        x: 0,
        y: 0,
        z: 0,
        w: 1,
      });
      out.push({
        time,
        entry: entry({ pos: ace.pos, quat: q, speed: ace.speed }),
      });
    }
  }
  return out;
}

describe("E1: promotion and the rate switch never pop a plane", () => {
  it("keeps the plane's id across the hand-over", () => {
    const f = feed(60, 120);
    expect(new Set(f.map((x) => x.entry.id))).toEqual(new Set([ID]));
  });

  /** The worst frame-to-frame move of the drawn image at 60 fps, 100 ms
   * behind, over frames from `fromMs` on. */
  function worstStep(
    f: ReturnType<typeof feed>,
    ticks: number,
    fromMs: number,
  ) {
    const buf = new InterpolationBuffer();
    let fed = 0;
    let prev: Pose | null = null;
    let worst = 0;
    const delay = 100;
    for (let ms = 0; ms < ticks * SNAPSHOT_INTERVAL_MS; ms += 1000 / 60) {
      const now = T0 + ms;
      while (fed < f.length && (f[fed]?.time ?? 0) <= now) {
        const s = f[fed++];
        if (s) buf.push(s.time, s.entry.pose);
      }
      const p = buf.sampleInto(now - delay, {
        pos: { x: 0, y: 0, z: 0 },
        quat: { x: 0, y: 0, z: 0, w: 1 },
        speed: 0,
      });
      if (!p) continue;
      if (prev && ms > fromMs) {
        worst = Math.max(worst, wrapDistance(prev.pos, p.pos));
      }
      prev = { pos: { ...p.pos }, quat: { ...p.quat }, speed: p.speed };
    }
    return worst;
  }

  it("glides through the promotion: no frame moves the image further than its speed allows", () => {
    // 80 m/s for a 60 fps frame is 1.33 m; quantisation adds a little. A
    // pop would be tens of metres.
    const worst = worstStep(feed(60, 140), 140, 400);
    expect(worst).toBeGreaterThan(0.5);
    expect(worst).toBeLessThan(2);
  });

  it("is smooth again within a snapshot of a mid → near rate switch", () => {
    const worst = worstStep(
      feed(200, 140, 60),
      140,
      60 * SNAPSHOT_INTERVAL_MS + 150,
    );
    expect(worst).toBeLessThan(2);
  });
});
