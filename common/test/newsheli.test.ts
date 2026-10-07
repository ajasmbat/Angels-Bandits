// The L10 news heli. What these defend:
//   1. The pose is a pure function of (target, server time), and a target
//      survives the JSON wire bit-for-bit — so the server's bot probes, every
//      client's crash check and every client's renderer agree on one heli.
//   2. A retarget never teleports it and never snaps its hull around.
//   3. It stays where the ticket puts it: 350-450 m, over the site, under
//      the blimp and the cloud deck, above every roof.
//   4. What you collide with is what is drawn: collideMovers and
//      collideBotMovers test the SAME box the renderer poses.

import {
  type MoverBox,
  type MoverField,
  collideBotMovers,
  collideMovers,
  withNewsHeli,
} from "@angels-bandits/common/city/movers";
import {
  NEWS_SPOT_REACH,
  type NewsHeliTarget,
  canRetarget,
  newsHeliArrival,
  newsHeliBoxInto,
  newsHeliIdle,
  newsHeliSlot,
  newsTargetAt,
  retargetNewsHeli,
  setNewsTarget,
} from "@angels-bandits/common/city/newsheli";
import {
  BLIMP_ALT,
  BLIMP_HULL,
  CLOUD_BASE,
  HELI_HULL,
  LANDMARK_HEIGHT,
  NEWS_HELI_ALT_MAX,
  NEWS_HELI_ALT_MIN,
  NEWS_HELI_DWELL_MS,
  NEWS_HELI_ORBIT_R,
  NEWS_HELI_TURN_S,
  PLAYER_RADIUS,
  WORLD_SIZE,
} from "@angels-bandits/common/constants";
import { wrapDeltaAxis } from "@angels-bandits/common/world";
import { describe, expect, it } from "vitest";

const SEED = 42;
const T0 = 1_791_000_000_000;
const EMPTY: MoverField = { cranes: [], aircraft: [] };

const box = (): MoverBox => ({
  x: 0,
  y: 0,
  z: 0,
  hx: 0,
  hy: 0,
  hz: 0,
  yaw: 0,
  kind: "newsHeli",
  id: 0,
});
const pose = (target: NewsHeliTarget, t: number) =>
  newsHeliBoxInto(target, t, box());

/** Horizontal torus distance between two canonical points. */
const flat = (a: { x: number; z: number }, b: { x: number; z: number }) =>
  Math.hypot(wrapDeltaAxis(a.x, b.x), wrapDeltaAxis(a.z, b.z));

const yawStep = (a: number, b: number) => {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return Math.abs(d);
};

/** Kill sites that exercise every branch: far, near, inside the orbit, on
 * it, dead centre, and exactly half a world away (the wrap tie). */
function sitesFrom(c: { x: number; z: number }) {
  const at = (dx: number, dz: number) => ({
    x: (c.x + dx + WORLD_SIZE) % WORLD_SIZE,
    z: (c.z + dz + WORLD_SIZE) % WORLD_SIZE,
  });
  return [
    at(700, -300),
    at(-150, 90),
    at(30, 20),
    at(NEWS_HELI_ORBIT_R, 0),
    at(0, 0),
    at(WORLD_SIZE / 2, 0),
    at(-640, 910),
  ];
}

describe("news heli pose", () => {
  it("is pure in (target, time) and survives the JSON wire exactly", () => {
    const idle = newsHeliIdle(SEED);
    const target = retargetNewsHeli(idle, { x: 1234.5, z: 87.25 }, T0);
    const wired = JSON.parse(JSON.stringify(target)) as NewsHeliTarget;
    for (let k = 0; k < 400; k++) {
      const t = T0 + k * 333.3;
      expect(pose(wired, t)).toEqual(pose(target, t));
    }
    expect(newsHeliIdle(SEED)).toEqual(idle);
    expect(retargetNewsHeli(idle, { x: 1234.5, z: 87.25 }, T0)).toEqual(target);
  });

  it("idles in an orbit before the first kill", () => {
    const idle = newsHeliIdle(SEED);
    for (let k = 0; k < 100; k++) {
      const p = pose(idle, T0 + k * 1_000);
      expect(flat(p, idle)).toBeCloseTo(NEWS_HELI_ORBIT_R, 6);
      expect(p.y).toBe(idle.y);
    }
  });

  it("flies to every kill site without a jump, then orbits it", () => {
    let current = newsHeliIdle(SEED);
    let t = T0;
    for (const site of sitesFrom(current)) {
      const next = retargetNewsHeli(current, site, t);
      // Same place, same heading at the hand-over instant.
      const before = pose(current, t);
      const after = pose(next, t);
      expect(flat(before, after)).toBeLessThan(1e-6);
      expect(after.y).toBeCloseTo(before.y, 9);
      expect(yawStep(before.yaw, after.yaw)).toBeLessThan(1e-9);

      // No step between frames: position AND hull yaw, the whole way in.
      const arrive = newsHeliArrival(next);
      const dt = 50;
      let prev = pose(next, t);
      for (let s = t + dt; s < arrive + 30_000; s += dt) {
        const p = pose(next, s);
        expect(flat(prev, p)).toBeLessThan(3.5); // 50 m/s * 50 ms + slack
        expect(Math.abs(p.y - prev.y)).toBeLessThan(0.5);
        expect(yawStep(prev.yaw, p.yaw)).toBeLessThan(0.1);
        prev = p;
      }
      // On station: orbiting the site at the orbit altitude.
      for (let s = arrive; s < arrive + 60_000; s += 2_000) {
        const p = pose(next, s);
        expect(flat(p, site)).toBeCloseTo(NEWS_HELI_ORBIT_R, 4);
        expect(p.y).toBe(next.y);
      }
      // The turn-in really is over after NEWS_HELI_TURN_S.
      expect(arrive).toBeGreaterThanOrEqual(t);
      expect(NEWS_HELI_TURN_S).toBeLessThan(5);
      current = next;
      t += 7_000; // retarget mid-transit too: still continuous
    }
  });

  it("spirals out when a new story starts inside its orbit", () => {
    for (const r0 of [0, 20, 60, NEWS_HELI_ORBIT_R - 1]) {
      const target: NewsHeliTarget = {
        x: 500,
        y: 370,
        z: 1990,
        t: T0,
        fx: 500 + r0,
        fy: 380,
        fz: 1990,
        fyaw: 2.5,
      };
      let prev = pose(target, T0);
      expect(flat(prev, { x: target.fx, z: target.fz })).toBeLessThan(1e-6);
      expect(prev.yaw).toBe(2.5);
      for (let s = T0 + 50; s < newsHeliArrival(target) + 10_000; s += 50) {
        const p = pose(target, s);
        expect(flat(prev, p)).toBeLessThan(3.5);
        expect(yawStep(prev.yaw, p.yaw)).toBeLessThan(0.1);
        prev = p;
      }
      expect(flat(prev, target)).toBeCloseTo(NEWS_HELI_ORBIT_R, 6);
    }
  });

  it("stays in its band: over every roof, under the blimp and the clouds", () => {
    expect(NEWS_HELI_ALT_MIN).toBeGreaterThanOrEqual(350);
    expect(NEWS_HELI_ALT_MAX).toBeLessThanOrEqual(450);
    const top = NEWS_HELI_ALT_MAX + HELI_HULL[1] * 1.3; // rotor blur
    expect(top).toBeLessThan(BLIMP_ALT - BLIMP_HULL[1]);
    expect(top).toBeLessThan(CLOUD_BASE);
    expect(NEWS_HELI_ALT_MIN - HELI_HULL[1]).toBeGreaterThan(
      LANDMARK_HEIGHT + 50,
    );
    let current = newsHeliIdle(SEED);
    for (let k = 0; k < 40; k++) {
      const t = T0 + k * 90_000;
      current = retargetNewsHeli(
        current,
        { x: (k * 977) % WORLD_SIZE, z: (k * 571) % WORLD_SIZE },
        t,
      );
      expect(current.y).toBeGreaterThanOrEqual(NEWS_HELI_ALT_MIN);
      expect(current.y).toBeLessThanOrEqual(NEWS_HELI_ALT_MAX);
      for (let s = t; s < t + 90_000; s += 3_000) {
        const y = pose(current, s).y;
        expect(y).toBeGreaterThanOrEqual(NEWS_HELI_ALT_MIN);
        expect(y).toBeLessThanOrEqual(NEWS_HELI_ALT_MAX);
      }
    }
  });

  it("throws its spot all the way to the ground under the orbit", () => {
    const lamp = NEWS_HELI_ALT_MAX - HELI_HULL[1];
    expect(NEWS_SPOT_REACH).toBeGreaterThan(
      Math.hypot(NEWS_HELI_ORBIT_R * 1.3, lamp),
    );
  });
});

describe("news heli retarget policy", () => {
  it("waits for arrival plus the dwell before taking a new story", () => {
    const idle = newsHeliIdle(SEED);
    expect(canRetarget(idle, T0)).toBe(true);
    const next = retargetNewsHeli(idle, { x: 10, z: 1500 }, T0);
    const arrive = newsHeliArrival(next);
    expect(arrive).toBeGreaterThan(T0);
    expect(canRetarget(next, T0 + 1)).toBe(false);
    expect(canRetarget(next, arrive)).toBe(false);
    expect(canRetarget(next, arrive + NEWS_HELI_DWELL_MS - 1)).toBe(false);
    expect(canRetarget(next, arrive + NEWS_HELI_DWELL_MS)).toBe(true);
  });

  it("keeps the previous route for render times before the new one", () => {
    const slot = newsHeliSlot(SEED);
    const first = slot.target;
    const next = retargetNewsHeli(first, { x: 500, z: 500 }, T0);
    setNewsTarget(slot, next);
    expect(slot.prev).toBe(first);
    expect(newsTargetAt(slot, T0 - 100)).toBe(first);
    expect(newsTargetAt(slot, T0)).toBe(next);
    expect(newsTargetAt(slot, T0 + 100)).toBe(next);
    // Continuous across the switch as the lagging client sees it.
    const a = pose(newsTargetAt(slot, T0 - 1), T0 - 1);
    const b = pose(newsTargetAt(slot, T0), T0);
    expect(flat(a, b)).toBeLessThan(0.5);
  });
});

describe("news heli collision", () => {
  it("is solid exactly where it is drawn, for players AND bots", () => {
    const field = withNewsHeli(EMPTY, SEED);
    const slot = field.news;
    expect(slot).toBeDefined();
    if (!slot) return;
    setNewsTarget(slot, retargetNewsHeli(slot.target, { x: 1900, z: 40 }, T0));
    for (let k = 0; k < 120; k++) {
      const t = T0 + k * 750;
      const drawn = pose(newsTargetAt(slot, t), t);
      const centre = { x: drawn.x, y: drawn.y, z: drawn.z };
      expect(collideMovers(centre, PLAYER_RADIUS, field, t)).toEqual({
        kind: "newsHeli",
        id: 0,
      });
      expect(collideBotMovers(centre, PLAYER_RADIUS, field, t)).toEqual({
        kind: "newsHeli",
        id: 0,
      });
      // Just past the hull's flank (local +Z), it is clear.
      const c = Math.cos(drawn.yaw);
      const s = Math.sin(drawn.yaw);
      const side = drawn.hz + PLAYER_RADIUS + 0.5;
      const beside = {
        x: (drawn.x + s * side + WORLD_SIZE) % WORLD_SIZE,
        y: drawn.y,
        z: (drawn.z + c * side + WORLD_SIZE) % WORLD_SIZE,
      };
      expect(collideMovers(beside, PLAYER_RADIUS, field, t)).toBeNull();
      // And a plane well below it in the canyons never pays for it.
      expect(
        collideBotMovers({ ...centre, y: 120 }, PLAYER_RADIUS, field, t),
      ).toBeNull();
    }
    // The seed-shared field (no slot) has no news heli at all.
    const t = T0 + 1_000;
    const drawn = pose(newsTargetAt(slot, t), t);
    expect(collideMovers(drawn, PLAYER_RADIUS, EMPTY, t)).toBeNull();
  });
});
