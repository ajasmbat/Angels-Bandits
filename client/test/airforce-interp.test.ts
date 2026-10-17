// E1 Air force: a plane's image never pops when it changes how it travels.
// A squadron plane in formation reaches this client inside its squadron's
// row (expanded off the anchor), at 5 Hz while it is out past the near
// tier; when a human comes close it PROMOTES and arrives as its own entry,
// at 20 Hz. Both feed the same InterpolationBuffer, and the ace starts from
// the very flight its slot had — so the drawn pose glides through the
// hand-over exactly as it glides between any two snapshots.

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
import type { Pose, SnapshotEntry } from "@angels-bandits/common/protocol";
import {
  RooflineGrid,
  SQUAD_FLOOR_ALT,
  type SquadAnchor,
  attitudeQuatInto,
  encodeSquadRow,
  expandSquadRow,
  floorAhead,
  slotPoseInto,
  stepAnchor,
} from "@angels-bandits/common/squadron";
import { BOT_TUNING } from "@angels-bandits/common/tuning";
import { wrapDistance } from "@angels-bandits/common/world";
import { describe, expect, it } from "vitest";
import { InterpolationBuffer } from "../src/net/interp";

const grid = RooflineGrid.build(generateCity(CITY_SEED));
const T0 = 1_790_000_000_000;
const SLOT = 5;
const FORM = 0;

/** The snapshots one client receives for squadron slot SLOT's plane: in
 * formation (its squadron's rows — every IM_MID_EVERY-th tick before
 * `nearTick`, the mid tier, then every tick) until `promoteTick`, then an
 * ace on its own entry every tick (the near tier: promotion happens well
 * inside it, PROMOTE_M < IM_NEAR_M). */
function feed(promoteTick: number, ticks: number, nearTick = 0) {
  const pos = { x: 600, y: 0, z: 900 };
  const yaw = 0.4;
  pos.y = Math.max(SQUAD_FLOOR_ALT, floorAhead(grid, pos, yaw));
  const a: SquadAnchor = {
    pos,
    yaw,
    pitch: 0,
    roll: 0,
    speed: 74,
    steer: yaw,
    steerNeed: 0,
  };
  const anchor: Pose = {
    pos: a.pos,
    quat: { x: 0, y: 0, z: 0, w: 1 },
    speed: a.speed,
  };
  let ace: FlightState | null = null;
  const out: { time: number; entry: SnapshotEntry }[] = [];
  const dt = SNAPSHOT_INTERVAL_MS / 1000;
  for (let t = 0; t < ticks; t++) {
    const time = T0 + t * SNAPSHOT_INTERVAL_MS;
    if (t < promoteTick) {
      stepAnchor(
        a,
        0.4 + 0.3 * Math.sin(t / 30),
        20,
        grid,
        [],
        dt,
        t % 4 === 0,
      );
      attitudeQuatInto(a.yaw, a.pitch, a.roll, anchor.quat);
      anchor.speed = a.speed;
      const row = encodeSquadRow({
        id0: "bot:room-1:100",
        anchor,
        form: FORM,
        spread: 1,
        prot: false,
        mask: 0xff,
        hp: [100, 100, 100, 100, 100, 100, 100, 100],
      });
      if (t >= nearTick || t % IM_MID_EVERY === 0) {
        const players: SnapshotEntry[] = [];
        expandSquadRow(row, players);
        out.push({ time, entry: players[SLOT] as SnapshotEntry });
      }
      if (t === promoteTick - 1) {
        // The promotion: the brain takes the slot's flight as it stands
        // (server/src/squadrons.ts pose(): slot position, anchor attitude).
        const p = slotPoseInto(anchor, FORM, SLOT, 1, {
          pos: { x: 0, y: 0, z: 0 },
          quat: { x: 0, y: 0, z: 0, w: 1 },
          speed: 0,
        });
        ace = {
          pos: { ...p.pos },
          yaw: a.yaw,
          pitch: a.pitch,
          roll: a.roll,
          bank: a.roll,
          rollRate: 0,
          speed: a.speed,
          targetSpeed: a.speed,
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
      const cy = Math.cos(ace.yaw / 2);
      const sy = Math.sin(ace.yaw / 2);
      const cx = Math.cos(ace.pitch / 2);
      const sx = Math.sin(ace.pitch / 2);
      const cz = Math.cos(ace.roll / 2);
      const sz = Math.sin(ace.roll / 2);
      const pose: Pose = {
        pos: ace.pos,
        quat: {
          x: sx * cy * cz + cx * sy * sz,
          y: cx * sy * cz - sx * cy * sz,
          z: cx * cy * sz - sx * sy * cz,
          w: cx * cy * cz + sx * sy * sz,
        },
        speed: ace.speed,
      };
      out.push({
        time,
        entry: decodeSnapshotEntry(
          encodeSnapshotEntry({
            id: "bot:room-1:105",
            pose,
            hp: 100,
            prot: false,
          }),
        ),
      });
    }
  }
  return out;
}

describe("E1: promotion and the rate switch never pop a plane", () => {
  it("keeps the slot plane's id across the hand-over", () => {
    const f = feed(60, 120);
    expect(new Set(f.map((x) => x.entry.id))).toEqual(
      new Set(["bot:room-1:105"]),
    );
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

  it("is smooth again within a snapshot of a mid → near rate switch (past the far plane, where the mid tier lives)", () => {
    const worst = worstStep(
      feed(200, 140, 60),
      140,
      60 * SNAPSHOT_INTERVAL_MS + 150,
    );
    expect(worst).toBeLessThan(2);
  });
});
