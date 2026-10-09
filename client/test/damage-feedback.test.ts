// U1 feel every hit: the damage-direction arc's bearing (torus-safe, a
// compass that ignores altitude), the vignette's opacity, the arc slots
// over a minimal fake DOM, the haptics throttles, and the shooter-side
// impact sweep that turns a round meeting a shielded plane into a "shield"
// glance instead of a hit marker.

import { HIT_RADIUS, WORLD_SIZE } from "@angels-bandits/common/constants";
import type { Vec3 } from "@angels-bandits/common/world";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bulletImpact, impactKind } from "../src/game/hitdetect";
import {
  DAMAGE_ARC_MS,
  DAMAGE_ARC_SLOTS,
  DAMAGE_FLASH_MS,
  DamageIndicator,
  damageBearing,
  flashOpacity,
} from "../src/ui/damage-indicator";
import {
  HAPTIC_DAMAGE,
  HAPTIC_DAMAGE_GAP_MS,
  HAPTIC_HIT,
  HAPTIC_HIT_GAP_MS,
  Haptics,
  type VibrateHost,
  canVibrate,
} from "../src/ui/haptics";

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

describe("damageBearing — where the shooter is, screen-clockwise", () => {
  const me = v(1000, 300, 1000);

  it("yaw 0 (facing −Z): ahead 0, right +π/2, left −π/2, behind ±π", () => {
    expect(damageBearing(me, v(1000, 300, 900), 0)).toBeCloseTo(0, 9);
    expect(damageBearing(me, v(1100, 300, 1000), 0)).toBeCloseTo(
      Math.PI / 2,
      9,
    );
    expect(damageBearing(me, v(900, 300, 1000), 0)).toBeCloseTo(
      -Math.PI / 2,
      9,
    );
    expect(Math.abs(damageBearing(me, v(1000, 300, 1100), 0))).toBeCloseTo(
      Math.PI,
      9,
    );
  });

  it("follows the view: yaw π/2 faces −X, so −Z is on the right", () => {
    const yaw = Math.PI / 2;
    expect(damageBearing(me, v(900, 300, 1000), yaw)).toBeCloseTo(0, 9);
    expect(damageBearing(me, v(1000, 300, 900), yaw)).toBeCloseTo(
      Math.PI / 2,
      9,
    );
  });

  it("any yaw: a shooter placed at bearing β reads back β", () => {
    const yaw = 0.7;
    const fwd = v(-Math.sin(yaw), 0, -Math.cos(yaw));
    const right = v(Math.cos(yaw), 0, -Math.sin(yaw));
    for (const beta of [-2.5, -1, -0.2, 0.3, 1.2, 3]) {
      const d = 150;
      const shooter = v(
        me.x + (fwd.x * Math.cos(beta) + right.x * Math.sin(beta)) * d,
        me.y,
        me.z + (fwd.z * Math.cos(beta) + right.z * Math.sin(beta)) * d,
      );
      expect(damageBearing(me, shooter, yaw)).toBeCloseTo(beta, 9);
    }
  });

  it("is torus-safe: a shooter just across the seam points the short way", () => {
    const edge = v(WORLD_SIZE - 10, 300, 500);
    // 20 m to the east across x = 0, not 1980 m to the west.
    expect(damageBearing(edge, v(10, 300, 500), 0)).toBeCloseTo(Math.PI / 2, 9);
    // 20 m north across z = 0 is dead ahead.
    expect(
      damageBearing(v(500, 300, 10), v(500, 300, WORLD_SIZE - 10), 0),
    ).toBeCloseTo(0, 9);
  });

  it("ignores altitude: a shooter far above or below reads the same", () => {
    const flat = damageBearing(me, v(1100, 300, 900), 0.3);
    expect(damageBearing(me, v(1100, 900, 900), 0.3)).toBeCloseTo(flat, 12);
    expect(damageBearing(me, v(1100, 20, 900), 0.3)).toBeCloseTo(flat, 12);
  });
});

describe("flashOpacity", () => {
  it("scales with the damage up to a ceiling, never negative", () => {
    expect(flashOpacity(0)).toBe(0);
    expect(flashOpacity(-10)).toBe(0);
    expect(flashOpacity(5)).toBeCloseTo(0.2, 9);
    expect(flashOpacity(10)).toBeGreaterThan(flashOpacity(5));
    expect(flashOpacity(25)).toBe(0.6);
    expect(flashOpacity(1000)).toBe(0.6);
  });
});

/** The slice of an element the indicator writes. */
interface FakeEl {
  className: string;
  style: { opacity?: string; transform?: string };
  children: FakeEl[];
  append: (el: FakeEl) => void;
}
const fakeEl = (): FakeEl => {
  const el: FakeEl = {
    className: "",
    style: {},
    children: [],
    append: (c) => el.children.push(c),
  };
  return el;
};

describe("DamageIndicator — arcs and flash over a fake DOM", () => {
  afterEach(() => vi.unstubAllGlobals());

  const setup = () => {
    const flash = fakeEl();
    const arcs = fakeEl();
    vi.stubGlobal("document", {
      getElementById: (id: string) =>
        id === "damage-flash" ? flash : id === "damage-arcs" ? arcs : null,
      createElement: () => fakeEl(),
    });
    const ind = new DamageIndicator();
    return { ind, flash, arcs: arcs.children };
  };
  const me = v(1000, 300, 1000);
  const gone = () => null;
  /** Arcs currently shown (opacity above 0). */
  const shown = (arcs: FakeEl[]) =>
    arcs.filter((a) => Number(a.style.opacity ?? "0") > 0);

  it("builds DAMAGE_ARC_SLOTS arcs; a hit flashes and points an arc at the shooter", () => {
    const { ind, flash, arcs } = setup();
    expect(arcs).toHaveLength(DAMAGE_ARC_SLOTS);
    ind.hit("bandit", v(1100, 300, 1000), 25, 0);
    ind.update(0, me, 0, gone);
    expect(flash.style.opacity).toBe("0.60");
    expect(shown(arcs)).toHaveLength(1);
    expect(shown(arcs)[0]?.style.transform).toBe("rotate(90.0deg)");
    // The flash fades out over DAMAGE_FLASH_MS.
    ind.update(DAMAGE_FLASH_MS, me, 0, gone);
    expect(flash.style.opacity).toBe("0.00");
  });

  it("follows a live shooter, and a repeat shooter refreshes its own arc", () => {
    const { ind, arcs } = setup();
    ind.hit("bandit", v(1100, 300, 1000), 10, 0);
    ind.update(100, me, 0, () => v(1000, 300, 900));
    expect(shown(arcs)[0]?.style.transform).toBe("rotate(0.0deg)");
    ind.hit("bandit", v(1000, 300, 900), 10, 1000);
    ind.update(DAMAGE_ARC_MS + 500, me, 0, gone);
    expect(shown(arcs)).toHaveLength(1);
  });

  it("a fifth shooter takes the oldest slot", () => {
    const { ind, arcs } = setup();
    for (let i = 0; i < DAMAGE_ARC_SLOTS; i++) {
      ind.hit(
        `s${i}`,
        v(1000 + 100 * Math.cos(i), 300, 1000 + 100 * Math.sin(i)),
        5,
        i * 100,
      );
    }
    ind.hit("late", v(1000, 300, 1100), 5, 1000); // behind
    ind.update(1000, me, 0, gone);
    expect(shown(arcs)).toHaveLength(DAMAGE_ARC_SLOTS);
    const bearings = shown(arcs).map((a) => a.style.transform);
    // s0 sat due right (90°); "late" sits behind (180°).
    expect(bearings).not.toContain("rotate(90.0deg)");
    expect(bearings).toContain("rotate(180.0deg)");
    // s0 (the oldest) gave its slot to "late": once s1…s3 expire, the
    // only arc left is late's, pointing behind.
    ind.update(DAMAGE_ARC_MS + 350, me, 0, gone);
    expect(shown(arcs)).toHaveLength(1);
    expect(shown(arcs)[0]?.style.transform).toBe("rotate(180.0deg)");
  });

  it("arcs expire after DAMAGE_ARC_MS; no shooter position is a flash only; clear() drops everything", () => {
    const { ind, flash, arcs } = setup();
    ind.hit("bandit", v(1100, 300, 1000), 10, 0);
    ind.update(DAMAGE_ARC_MS - 100, me, 0, gone); // faded, still up
    expect(shown(arcs)).toHaveLength(1);
    ind.update(DAMAGE_ARC_MS, me, 0, gone);
    expect(shown(arcs)).toHaveLength(0);

    ind.hit("ghost", undefined, 10, 5000);
    ind.update(5000, me, 0, gone);
    expect(Number(flash.style.opacity)).toBeGreaterThan(0);
    expect(shown(arcs)).toHaveLength(0);

    ind.hit("bandit", v(1100, 300, 1000), 10, 6000);
    ind.update(6000, me, 0, gone);
    ind.clear();
    expect(flash.style.opacity).toBe("0");
    expect(shown(arcs)).toHaveLength(0);
    ind.update(6001, me, 0, gone);
    expect(shown(arcs)).toHaveLength(0);
  });
});

describe("Haptics — throttled buzzes", () => {
  const host = (): VibrateHost & { calls: (number | number[])[] } => {
    const calls: (number | number[])[] = [];
    return {
      calls,
      vibrate(pattern) {
        calls.push(pattern);
        return true;
      },
    };
  };

  it("feature-detects vibrate", () => {
    expect(canVibrate(undefined)).toBe(false);
    expect(canVibrate({})).toBe(false);
    expect(canVibrate(host())).toBe(true);
    expect(new Haptics({}, true).available).toBe(false);
  });

  it("hit: at most one buzz per HAPTIC_HIT_GAP_MS — exactly the gap fires, a millisecond less doesn't", () => {
    const h = host();
    const haptics = new Haptics(h, true);
    haptics.hit(1000);
    haptics.hit(1000 + HAPTIC_HIT_GAP_MS - 1);
    expect(h.calls).toEqual([HAPTIC_HIT]);
    haptics.hit(1000 + HAPTIC_HIT_GAP_MS);
    expect(h.calls).toEqual([HAPTIC_HIT, HAPTIC_HIT]);
  });

  it("damage: at most one pattern per HAPTIC_DAMAGE_GAP_MS", () => {
    const h = host();
    const haptics = new Haptics(h, true);
    for (let t = 0; t < 1000; t += 100) haptics.damage(t); // a bot's cadence
    // 0, 300, 600, 900 — each the first call ≥ 250 ms after the last buzz.
    expect(h.calls).toEqual([
      HAPTIC_DAMAGE,
      HAPTIC_DAMAGE,
      HAPTIC_DAMAGE,
      HAPTIC_DAMAGE,
    ]);
    haptics.damage(900 + HAPTIC_DAMAGE_GAP_MS);
    expect(h.calls).toHaveLength(5);
  });

  it("disabled, or a host without vibrate, never buzzes — and never starts a throttle window", () => {
    const h = host();
    const haptics = new Haptics(h, false);
    haptics.hit(0);
    haptics.damage(0);
    haptics.kill();
    haptics.death();
    expect(h.calls).toEqual([]);
    haptics.setEnabled(true);
    expect(haptics.enabled).toBe(true);
    haptics.hit(1); // 1 ms later: no window was opened while off
    haptics.damage(1);
    expect(h.calls).toEqual([HAPTIC_HIT, HAPTIC_DAMAGE]);
    expect(() => new Haptics(undefined, true).hit(0)).not.toThrow();
  });

  it("a vibrate that throws (no user gesture yet) is swallowed and still counts as the buzz", () => {
    let calls = 0;
    const haptics = new Haptics(
      {
        vibrate: () => {
          calls++;
          throw new Error("NotAllowedError");
        },
      },
      true,
    );
    expect(() => haptics.hit(0)).not.toThrow();
    haptics.hit(50);
    expect(calls).toBe(1);
  });
});

describe("bulletImpact / impactKind — no fake hit marker on a shielded plane", () => {
  const prev = v(500, 300, 500);
  const cur = v(500, 300, 400);

  it("the first target the step touches stops the round; a miss is null", () => {
    const a = { id: "a", pos: v(500, 300, 450) };
    const b = { id: "b", pos: v(500, 300, 420) };
    expect(bulletImpact(prev, cur, [a, b])?.id).toBe("a");
    expect(
      bulletImpact(prev, cur, [
        { id: "c", pos: v(500 + HIT_RADIUS + 1, 300, 450) },
      ]),
    ).toBeNull();
  });

  it("a spawn-protected plane still stops the round, as a 'shield' — only an unprotected one is a 'hit'", () => {
    const shielded = { id: "s", pos: v(500, 300, 450), prot: true };
    const behind = { id: "h", pos: v(500, 300, 430) };
    const met = bulletImpact(prev, cur, [shielded, behind]);
    expect(met?.id).toBe("s");
    expect(impactKind(met as typeof shielded)).toBe("shield");
    expect(impactKind(behind)).toBe("hit");
    expect(impactKind({ pos: behind.pos, prot: false })).toBe("hit");
  });

  it("is torus-safe: a step across the seam hits a target on the other side", () => {
    const target = { pos: v(2, 300, 500) };
    expect(
      bulletImpact(v(WORLD_SIZE - 5, 300, 500), v(8, 300, 500), [target]),
    ).toBe(target);
  });
});
