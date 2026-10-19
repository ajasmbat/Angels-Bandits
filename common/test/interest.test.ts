// E1 Air force: interest management on the wire (common/src/interest.ts).
// Each client's snapshot carries every human, the enemies near it every
// tick, the ones out to half the world at 5 Hz (staggered) and nothing
// beyond. I1: every enemy is its own row. What a client gets depends only
// on where it is, and the text is exactly the JSON a WireSnapshotMsg would
// make.

import { FOG_DISTANCE, WORLD_SIZE } from "@angels-bandits/common/constants";
import {
  IM_FAR_M,
  IM_FULL_M,
  IM_MID_EVERY,
  IM_MID_LAG_MS,
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
import { type Vec3, wrapDistance } from "@angels-bandits/common/world";
import { describe, expect, it } from "vitest";

const row = (
  name: string,
  pos: Vec3,
  extra: Partial<InterestRow> = {},
): InterestRow => ({
  json: JSON.stringify(name),
  pos,
  phase: 0,
  always: false,
  ...extra,
});

describe("E1 interest: the tiers", () => {
  it("is full rate in the fight, 5 Hz to half the world, nothing beyond", () => {
    // What a human sees reaches past the far plane (the AA's and chaos'
    // range); the full rate stops well inside it (I1: the wire budget).
    expect(IM_NEAR_M).toBeGreaterThan(FOG_DISTANCE + 100);
    expect(IM_FULL_M).toBeLessThan(IM_NEAR_M);
    expect(IM_FAR_M).toBe(WORLD_SIZE / 2);
    expect(interestTier(0)).toBe(TIER_NEAR);
    expect(interestTier(IM_FULL_M)).toBe(TIER_NEAR);
    expect(interestTier(IM_FULL_M + 1)).toBe(TIER_MID);
    expect(interestTier(IM_FAR_M)).toBe(TIER_MID);
    expect(interestTier(IM_FAR_M + 1)).toBe(TIER_NONE);
    expect(20 / IM_MID_EVERY).toBe(5);
    // A mid plane is drawn the gap its rows leave further back.
    expect(IM_MID_LAG_MS).toBe((IM_MID_EVERY - 1) * 50);
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
      "pilot-over-seam",
      { x: 1950, y: 250, z: 60 }, // 153 m from A across the seam
      { phase: 3 },
    ),
  ];
  const take = (viewer: Vec3 | null, tick: number) => {
    const planes: string[] = [];
    selectRows(viewer, rows, tick, planes);
    return { planes: planes.map((j) => JSON.parse(j)) };
  };

  it("gives each client the humans always, and the enemies near IT", () => {
    const a = take(A, 1);
    expect(a.planes).toContain("human-a");
    expect(a.planes).toContain("human-b");
    expect(a.planes).toContain("ace-near-a");
    expect(a.planes).toContain("pilot-over-seam");
    // ace-near-b is ~1414 m from A: past half the world, never sent to A.
    for (let t = 0; t < 8; t++)
      expect(take(A, t).planes).not.toContain("ace-near-b");
    const b = take(B, 1);
    expect(b.planes).toContain("ace-near-b");
    expect(b.planes).not.toContain("ace-near-a");
    expect(b.planes).not.toContain("pilot-over-seam");
  });

  it("sends a mid-tier row at 5 Hz", () => {
    expect(wrapDistance(A, { x: 100, y: 150, z: 1080 })).toBeGreaterThan(
      IM_FULL_M,
    );
    let sent = 0;
    for (let t = 0; t < 20; t++)
      if (take(A, t).planes.includes("ace-mid-a")) sent++;
    expect(sent).toBe(5);
  });

  it("gives a client still loading (no viewer yet) the humans alone", () => {
    expect(take(null, 0)).toEqual({ planes: ["human-a", "human-b"] });
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
    const msg: WireSnapshotMsg = {
      type: "snapshot",
      time: 1_790_000_000_050,
      p,
    };
    expect(
      snapshotJson(
        msg.time,
        p.map((e) => JSON.stringify(e)),
      ),
    ).toBe(JSON.stringify(msg));
    expect(snapshotJson(7, [])).toBe(
      JSON.stringify({ type: "snapshot", time: 7, p: [] }),
    );
  });

  it("keeps a client under 250 KB/s with 500 individual enemies (24 aces, 476 pilots) round it", () => {
    // The worst case: every enemy within half the world of one client —
    // and each its own row (I1: no formations).
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
    for (let i = 0; i < 500; i++) {
      const pos = at();
      all.push(
        row("", pos, {
          phase: i,
          json: JSON.stringify(
            encodeSnapshotEntry({
              id: `bot:room-12:${1400 + i}`,
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
    let bytes = 0;
    for (let tick = 0; tick < 20; tick++) {
      const planes: string[] = [];
      selectRows(viewer, all, tick, planes);
      bytes += snapshotJson(1_790_000_000_000 + tick * 50, planes).length;
    }
    // One second of snapshots.
    expect(bytes).toBeLessThan(250_000);
  });
});
