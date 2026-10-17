// E1 Air force: interest management on the wire (common/src/interest.ts).
// Each client's snapshot carries every human, the enemies near it every
// tick, the ones out to half the world at 5 Hz (staggered) and nothing
// beyond — and a squadron counts by its nearest possible plane. What a
// client gets depends only on where it is, and the text is exactly the
// JSON a WireSnapshotMsg would make.

import { FOG_DISTANCE, WORLD_SIZE } from "@angels-bandits/common/constants";
import {
  IM_FAR_M,
  IM_MID_EVERY,
  IM_NEAR_M,
  IM_STALE_MS,
  type InterestRow,
  TIER_MID,
  TIER_NEAR,
  TIER_NONE,
  interestTier,
  selectRows,
  sendsOnTick,
  snapshotJson,
} from "@angels-bandits/common/interest";
import { encodeSnapshotEntry } from "@angels-bandits/common/net";
import type { WireSnapshotMsg } from "@angels-bandits/common/protocol";
import { FORM_REACH, encodeSquadRow } from "@angels-bandits/common/squadron";
import { type Vec3, wrapDistance } from "@angels-bandits/common/world";
import { describe, expect, it } from "vitest";

const row = (
  name: string,
  pos: Vec3,
  extra: Partial<InterestRow> = {},
): InterestRow => ({
  json: JSON.stringify(name),
  pos,
  reach: 0,
  phase: 0,
  always: false,
  squad: false,
  ...extra,
});

describe("E1 interest: the tiers", () => {
  it("is full rate past the far plane, 5 Hz to half the world, nothing beyond", () => {
    expect(IM_NEAR_M).toBeGreaterThan(FOG_DISTANCE + 100);
    expect(IM_FAR_M).toBe(WORLD_SIZE / 2);
    expect(interestTier(0)).toBe(TIER_NEAR);
    expect(interestTier(IM_NEAR_M)).toBe(TIER_NEAR);
    expect(interestTier(IM_NEAR_M + 1)).toBe(TIER_MID);
    expect(interestTier(IM_FAR_M)).toBe(TIER_MID);
    expect(interestTier(IM_FAR_M + 1)).toBe(TIER_NONE);
    // A squadron is as near as its nearest possible plane.
    expect(interestTier(IM_NEAR_M + FORM_REACH, FORM_REACH)).toBe(TIER_NEAR);
    expect(20 / IM_MID_EVERY).toBe(5);
  });

  it("sends near rows every tick, each mid row once every IM_MID_EVERY ticks, staggered by phase", () => {
    for (let tick = 0; tick < 40; tick++) {
      expect(sendsOnTick(TIER_NEAR, tick, 3)).toBe(true);
      expect(sendsOnTick(TIER_NONE, tick, 3)).toBe(false);
    }
    for (let phase = 0; phase < 9; phase++) {
      let sent = 0;
      for (let tick = 100; tick < 100 + IM_MID_EVERY; tick++) {
        if (sendsOnTick(TIER_MID, tick, phase)) sent++;
      }
      expect(sent).toBe(1);
    }
    // Different phases land on different ticks: a snapshot never carries
    // every mid row at once.
    const ticks = [0, 1, 2, 3].map((phase) =>
      [0, 1, 2, 3].find((t) => sendsOnTick(TIER_MID, t, phase)),
    );
    expect(new Set(ticks).size).toBe(4);
    // A client drops an enemy only after missing more than two mid rows.
    expect(IM_STALE_MS).toBeGreaterThan(2 * IM_MID_EVERY * 50);
  });
});

describe("E1 interest: per-client relevance", () => {
  const A: Vec3 = { x: 100, y: 200, z: 100 };
  const B: Vec3 = { x: 1100, y: 200, z: 1100 }; // the far corner from A
  const rows: InterestRow[] = [
    row("human-a", A, { always: true }),
    row("human-b", B, { always: true }),
    row("ace-near-a", { x: 300, y: 150, z: 160 }),
    row("ace-near-b", { x: 1000, y: 150, z: 1200 }, { phase: 1 }),
    row("ace-mid-a", { x: 100, y: 150, z: 1080 }, { phase: 2 }), // 980 m
    row(
      "squad-over-seam",
      { x: 1950, y: 250, z: 60 }, // 153 m from A across the seam
      { squad: true, reach: FORM_REACH, phase: 3 },
    ),
  ];
  const take = (viewer: Vec3 | null, tick: number) => {
    const planes: string[] = [];
    const squads: string[] = [];
    selectRows(viewer, rows, tick, planes, squads);
    return {
      planes: planes.map((j) => JSON.parse(j)),
      squads: squads.map((j) => JSON.parse(j)),
    };
  };

  it("gives each client the humans always, and the enemies near IT", () => {
    const a = take(A, 1);
    expect(a.planes).toContain("human-a");
    expect(a.planes).toContain("human-b");
    expect(a.planes).toContain("ace-near-a");
    expect(a.squads).toEqual(["squad-over-seam"]);
    // ace-near-b is ~1414 m from A: past half the world, never sent to A.
    for (let t = 0; t < 8; t++)
      expect(take(A, t).planes).not.toContain("ace-near-b");
    const b = take(B, 1);
    expect(b.planes).toContain("ace-near-b");
    expect(b.planes).not.toContain("ace-near-a");
    expect(b.squads).toEqual([]);
  });

  it("sends a mid-tier row at 5 Hz", () => {
    expect(wrapDistance(A, { x: 100, y: 150, z: 1080 })).toBeGreaterThan(
      IM_NEAR_M,
    );
    let sent = 0;
    for (let t = 0; t < 20; t++)
      if (take(A, t).planes.includes("ace-mid-a")) sent++;
    expect(sent).toBe(5);
  });

  it("gives a client still loading (no viewer yet) the humans alone", () => {
    expect(take(null, 0)).toEqual({
      planes: ["human-a", "human-b"],
      squads: [],
    });
  });

  it("writes exactly the JSON of the WireSnapshotMsg it stands for", () => {
    const p = [
      encodeSnapshotEntry({
        id: "abc",
        pose: {
          pos: { x: 1, y: 2, z: 3 },
          quat: { x: 0, y: 0, z: 0, w: 1 },
          speed: 70,
        },
        hp: 90,
        prot: true,
      }),
    ];
    const s = [
      encodeSquadRow({
        id0: "bot:room-1:9",
        anchor: {
          pos: { x: 5, y: 300, z: 6 },
          quat: { x: 0, y: 0, z: 0, w: 1 },
          speed: 70,
        },
        form: 1,
        spread: 1,
        prot: false,
        mask: 3,
        hp: [100, 80],
      }),
    ];
    const msg: WireSnapshotMsg = {
      type: "snapshot",
      time: 1_790_000_000_050,
      p,
      s,
    };
    expect(
      snapshotJson(
        msg.time,
        p.map((e) => JSON.stringify(e)),
        s.map((r) => JSON.stringify(r)),
      ),
    ).toBe(JSON.stringify(msg));
    const bare: WireSnapshotMsg = { type: "snapshot", time: 7, p };
    expect(
      snapshotJson(
        7,
        p.map((e) => JSON.stringify(e)),
        [],
      ),
    ).toBe(JSON.stringify(bare));
  });

  it("keeps a client under 250 KB/s with 500 enemies (24 aces, 63 squadron rows) round it", () => {
    // The worst case: every enemy within half the world of one client.
    const viewer: Vec3 = { x: 1000, y: 200, z: 1000 };
    const all: InterestRow[] = [];
    let seed = 1;
    const r = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    const at = (): Vec3 => {
      const a = r() * Math.PI * 2;
      const d = Math.sqrt(r()) * IM_FAR_M;
      return {
        x: 1000 + Math.cos(a) * d,
        y: 100 + r() * 300,
        z: 1000 + Math.sin(a) * d,
      };
    };
    for (let i = 0; i < 12; i++) {
      const pos = at();
      const id = `human-${i}-xxxxxxxx`;
      all.push(
        row("", pos, {
          always: true,
          json: JSON.stringify(
            encodeSnapshotEntry({
              id,
              pose: {
                pos,
                quat: { x: 0.1, y: -0.2, z: 0.3, w: 0.9 },
                speed: 81,
              },
              hp: 77,
              prot: false,
              age: 23,
            }),
          ),
        }),
      );
    }
    for (let i = 0; i < 24; i++) {
      const pos = at();
      all.push(
        row("", pos, {
          phase: i,
          json: JSON.stringify(
            encodeSnapshotEntry({
              id: `bot:room-12:${400 + i}`,
              pose: {
                pos,
                quat: { x: 0.1, y: -0.2, z: 0.3, w: 0.9 },
                speed: 81,
              },
              hp: 77,
              prot: false,
            }),
          ),
        }),
      );
    }
    for (let i = 0; i < 63; i++) {
      const pos = at();
      all.push(
        row("", pos, {
          squad: true,
          reach: FORM_REACH,
          phase: i,
          json: JSON.stringify(
            encodeSquadRow({
              id0: `bot:room-12:${i * 8}`,
              anchor: {
                pos,
                quat: { x: 0.1, y: -0.2, z: 0.3, w: 0.9 },
                speed: 75,
              },
              form: 2,
              spread: 1,
              prot: false,
              mask: 255,
              hp: [100, 100, 93, 100, 100, 41, 100, 100],
            }),
          ),
        }),
      );
    }
    let bytes = 0;
    for (let tick = 0; tick < 20; tick++) {
      const planes: string[] = [];
      const squads: string[] = [];
      selectRows(viewer, all, tick, planes, squads);
      bytes += snapshotJson(
        1_790_000_000_000 + tick * 50,
        planes,
        squads,
      ).length;
    }
    // One second of snapshots.
    expect(bytes).toBeLessThan(250_000);
  });
});
