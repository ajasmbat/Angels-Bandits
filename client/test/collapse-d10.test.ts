// D10 on the client: the fracture shape debris is drawn with stays inside
// the box it collides as (the CPU geometry, and the shader's inset in JS),
// the debris program fits WebGL2's 16 vertex attributes, steel stays steel
// when it lands, the dust surges down the streets and squibs out of the
// facade on the floor events, the ground jolts on them, the roars are
// capped, the small stuff is shed only near the viewer, and a tab built for
// another collapse model knows it.

import {
  type Building,
  CUT_RUBBLE,
  CUT_STEEL,
  CityDamage,
  chunkMask,
  generateCity,
  tierGrids,
} from "@angels-bandits/common/city";
import {
  BEAT_CRUSH,
  BEAT_GIVE,
  type Collapse,
  CollapseField,
  DIR_POS_X,
  PANCAKE,
  ROLE_COLUMN,
  TOPPLE,
  blankPose,
  chunkAtCell,
  collapseChunks,
  collapseFloorEvents,
  collapseWire,
  demolitionPlan,
  piecePose,
  planCollapses,
} from "@angels-bandits/common/city/collapse";
import {
  BLOCK_PITCH,
  CITY_SEED,
  COLLAPSE_CAP,
  COLLAPSE_CREEP_MS,
  COLLAPSE_LEAD_MS,
  COLLAPSE_MODEL,
  STREET_WIDTH,
} from "@angels-bandits/common/constants";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { COLLAPSE_BEATS_MAX } from "../src/audio/sound";
import { COLLAPSE_SHAKE_RANGE, collapseShakeAmount } from "../src/game/camera";
import { staleCollapseModel } from "../src/net/socket";
import { createBuildingsMaterial } from "../src/render/buildings-material";
import {
  CityRenderer,
  DEBRIS_PIECES_PER_CHUNK,
  debrisCut,
} from "../src/render/city";
import {
  CollapseDetail,
  DETAIL_RANGE_M,
  beatSchedule,
  creepSeconds,
} from "../src/render/collapse-fx";
import {
  FRACTURE_HASH_MIN,
  FRACTURE_MAX_SHARE,
  FRACTURE_VERTEX_GLSL,
  REBAR_HALF,
  fractureGeometry,
  fractureInset,
} from "../src/render/debris";
import {
  PUFF_SQUIB,
  PUFF_SURGE,
  SQUIB_LIFE_MS,
  SURGE_TOP_M,
  dustHaze,
  dustPuff,
  puffKind,
} from "../src/render/dust";
import type { Impacts } from "../src/render/impacts";

const city = generateCity(CITY_SEED);

/** The tallest plain tower. */
const TOWER = city.reduce((best, b, i) => {
  if (b.holes || tierGrids(b).length === 0) return best;
  return best < 0 || b.height > (city[best]?.height ?? 0) ? i : best;
}, -1);

/** A field holding one collapse of TOWER (`style`), bound to the city. */
function felled(
  style: typeof PANCAKE | typeof TOPPLE,
  midBand = false,
): Collapse {
  const damage = new CityDamage();
  const field = new CollapseField();
  const fresh = generateCity(CITY_SEED);
  damage.bind(fresh);
  field.bind(fresh);
  const b = fresh[TOWER] as Building;
  let plan: ReturnType<typeof demolitionPlan>;
  if (midBand) {
    const g = tierGrids(b)[0];
    if (!g) throw new Error("no grid");
    const band = Math.floor(g.ny / 2);
    const ids: number[] = [];
    for (let iz = 0; iz < g.nz; iz++)
      for (let ix = 0; ix < g.nx; ix++)
        ids.push(chunkAtCell(b, TOWER, 0, ix, band, iz));
    damage.apply(ids);
    plan = planCollapses(b, TOWER)[0] ?? null;
  } else {
    plan = demolitionPlan(b, TOWER, style, DIR_POS_X);
  }
  if (!plan) throw new Error("no plan");
  const c = field.add(collapseWire(plan, TOWER, 3, 100_000));
  if (!c) throw new Error("no debris");
  return c;
}

describe("D10 fracture shape: drawn inside the box it collides as", () => {
  const geo = fractureGeometry();
  const P = geo.getAttribute("position");
  const UV = geo.getAttribute("uv");

  it("every vertex of the geometry lies in the unit box; chips are positive, rebar only at edge midpoints", () => {
    let rebar = 0;
    for (let i = 0; i < P.count; i++) {
      const x = P.getX(i);
      const y = P.getY(i);
      const z = P.getZ(i);
      expect(Math.abs(x)).toBeLessThanOrEqual(0.5 + 1e-9);
      expect(Math.abs(z)).toBeLessThanOrEqual(0.5 + 1e-9);
      expect(y).toBeGreaterThanOrEqual(-1e-9);
      expect(y).toBeLessThanOrEqual(1 + 1e-9);
      expect(UV.getX(i)).toBeGreaterThanOrEqual(0);
      if (UV.getY(i) > 0.5) {
        rebar++;
        const onBoundary = [
          Math.abs(x) > 0.4999,
          y < 1e-4 || y > 0.9999,
          Math.abs(z) > 0.4999,
        ].filter(Boolean).length;
        expect(onBoundary).toBe(2);
      }
    }
    expect(rebar).toBe(12 * 4); // a ribbon (4 ends) per edge midpoint
    // A modest mesh: the debris draws many of these.
    expect(P.count).toBeLessThan(120);
  });

  it("the shader's inset (in JS) keeps every vertex inside the box, for every piece size and hash", () => {
    const sizes: [number, number, number][] = [
      [20, 3.83, 20], // a storey slab
      [2, 12, 20], // a facade sheet
      [1.2, 11.6, 1.2], // a column
      [20, 0.46, 20], // a slab crushed flat
      [0.3, 0.3, 0.3],
    ];
    for (const size of sizes) {
      for (const h of [0, 0.37, 1]) {
        for (let i = 0; i < P.count; i++) {
          const p: [number, number, number] = [P.getX(i), P.getY(i), P.getZ(i)];
          const q = fractureInset(p, UV.getX(i), UV.getY(i), size, h);
          expect(Math.abs(q[0])).toBeLessThanOrEqual(0.5 + 1e-9);
          expect(Math.abs(q[2])).toBeLessThanOrEqual(0.5 + 1e-9);
          expect(q[1]).toBeGreaterThanOrEqual(-1e-9);
          expect(q[1]).toBeLessThanOrEqual(1 + 1e-9);
          // Never further in than MAX_SHARE of the half extent, per axis
          // (plus a rebar ribbon's half width along its edge).
          for (let a = 0; a < 3; a++) {
            const moved =
              Math.abs((q[a] as number) - (p[a] as number)) * size[a];
            expect(moved).toBeLessThanOrEqual(
              FRACTURE_MAX_SHARE * 0.5 * size[a] + REBAR_HALF + 1e-9,
            );
          }
        }
      }
    }
  });

  it("the GLSL carries the same constants as fractureInset", () => {
    expect(FRACTURE_VERTEX_GLSL).toContain(
      `${FRACTURE_MAX_SHARE.toFixed(2)} * 0.5 * frS`,
    );
    expect(FRACTURE_VERTEX_GLSL).toContain(
      `${FRACTURE_HASH_MIN.toFixed(2)} + `,
    );
    expect(FRACTURE_VERTEX_GLSL).toContain(REBAR_HALF.toFixed(2));
    // Keyed on the piece's static offset, never on the slot.
    expect(FRACTURE_VERTEX_GLSL).toContain("aSubOff.xyz");
    expect(FRACTURE_VERTEX_GLSL).not.toContain("gl_InstanceID");
  });

  it("the debris program fits WebGL2's 16 vertex attributes; the city's does not change", () => {
    // Patch three's standard vertex shader the way the renderer would (the
    // hook never reads its renderer argument).
    const patch = (fracture: boolean) => {
      const m = createBuildingsMaterial({ value: 0 }, null, { fracture });
      const shader = {
        uniforms: {},
        vertexShader: THREE.ShaderLib.standard.vertexShader,
        fragmentShader: THREE.ShaderLib.standard.fragmentShader,
      };
      (m.onBeforeCompile as (s: unknown) => void)(shader);
      return { m, vs: shader.vertexShader };
    };
    const city = patch(false);
    const debris = patch(true);
    const custom = (vs: string) =>
      [...vs.matchAll(/^\s*attribute\s+\w+\s+(\w+);/gm)].map((m) => m[1]);
    // Eight per-instance attributes of our own, on both programs.
    expect(custom(city.vs)).toEqual(custom(debris.vs));
    expect(custom(city.vs)).toHaveLength(8);
    // + position, normal, instanceMatrix (4 locations), instanceColor = 15;
    // the debris variant alone also reads `uv` — 16, WebGL2's floor.
    expect(8 + 2 + 4 + 1 + 1).toBeLessThanOrEqual(16);
    // The variant adds its define to three's own; the city keeps three's.
    expect(debris.m.defines).toEqual({ STANDARD: "", AB_FRACTURE: "" });
    expect(city.m.defines).toEqual({ STANDARD: "" });
    expect(debris.m.customProgramCacheKey()).not.toBe(
      city.m.customProgramCacheKey(),
    );
  });

  it("a landed column stays steel; everything else turns to rubble", () => {
    expect(debrisCut(63 | CUT_STEEL, true)).toBe(CUT_RUBBLE | CUT_STEEL);
    expect(debrisCut(63 | CUT_STEEL, false)).toBe(63 | CUT_STEEL);
    expect(debrisCut(5, true)).toBe(CUT_RUBBLE);
    expect(debrisCut(5, false)).toBe(5);
  });
});

describe("D10 the debris mesh in the city renderer", () => {
  it("sizes its boot capacity for the fractured pieces, and paints a landed column as steel", () => {
    const r = new CityRenderer(CITY_SEED);
    const damage = new CityDamage();
    const field = new CollapseField();
    r.attachDamage(damage);
    r.attachCollapses(field);
    let chunks = 0;
    for (const b of r.cityBuildings) {
      for (const mask of chunkMask(b)) for (const v of mask) chunks += v;
    }
    const stats = r.destructionStats;
    expect(stats.debrisBootCapacity).toBeGreaterThanOrEqual(
      Math.ceil(chunks * COLLAPSE_CAP * 3.76),
    );
    expect(stats.debrisBootCapacity).toBe(
      Math.ceil(chunks * COLLAPSE_CAP * DEBRIS_PIECES_PER_CHUNK) + 64,
    );
    const b = r.cityBuildings[TOWER] as Building;
    const plan = demolitionPlan(b, TOWER, PANCAKE, 0);
    if (!plan) throw new Error("no plan");
    const wire = collapseWire(plan, TOWER, 1, 0);
    damage.collapse(collapseChunks(wire));
    const c = field.add(wire) as Collapse;
    r.updateDebris({ x: b.x, y: 60, z: b.z }, 0);
    r.updateDebris({ x: b.x, y: 60, z: b.z }, null);
    const { mesh, start } = r.debrisSlots(c.id);
    if (!mesh) throw new Error("no debris mesh");
    const w = mesh.geometry.getAttribute("aSubOff");
    let columns = 0;
    for (let i = 0; i < c.n; i++) {
      const want =
        c.role[i] === ROLE_COLUMN ? CUT_RUBBLE | CUT_STEEL : CUT_RUBBLE;
      if (c.role[i] === ROLE_COLUMN) columns++;
      expect(w.getW(start + i)).toBe(want);
    }
    expect(columns).toBeGreaterThan(0);
    // The debris mesh is drawn with the fracture geometry and material.
    expect(mesh.geometry.getAttribute("uv")).toBeDefined();
    expect(
      (mesh.material as THREE.Material & { defines?: object }).defines,
    ).toEqual({ STANDARD: "", AB_FRACTURE: "" });
  });
});

/** Distance from world coordinate `v` to the nearest street line. */
const toStreet = (v: number) =>
  Math.abs(v - Math.round(v / BLOCK_PITCH) * BLOCK_PITCH);

describe("D10 dust: the surge rolls down the streets, squibs fire on the floors", () => {
  it("squibs are alive only after their floor event, out of the facade near its height", () => {
    const c = felled(PANCAKE, true);
    const events = collapseFloorEvents(c).filter(
      (e) => e.kind === BEAT_CRUSH || e.kind === BEAT_GIVE,
    );
    expect(events.length).toBeGreaterThan(2);
    const first = Math.min(...events.map((e) => e.t));
    const puff = { x: 0, y: 0, z: 0, size: 0, alpha: 0 };
    let squibs = 0;
    let alive = 0;
    for (let k = 0; k < 72; k++) {
      if (puffKind(c.id, k) !== PUFF_SQUIB) continue;
      squibs++;
      // Nothing before the front reaches the first storey.
      expect(dustPuff(c, k, c.t0 + first - 10, puff)).toBe(false);
      for (let t = first; t < c.endMs + SQUIB_LIFE_MS; t += 100) {
        if (!dustPuff(c, k, c.t0 + t, puff)) continue;
        alive++;
        // Out of the windows of a crushed storey, at or under the failure.
        expect(puff.y).toBeLessThanOrEqual(c.fail + 1);
        expect(puff.size).toBeLessThan(20);
      }
    }
    expect(squibs).toBeGreaterThan(5);
    expect(alive).toBeGreaterThan(0);
  });

  it("the surge hugs the ground, then has rolled out along the streets", () => {
    const c = felled(PANCAKE);
    const puff = { x: 0, y: 0, z: 0, size: 0, alpha: 0 };
    const surgeAt = Math.min(
      ...collapseFloorEvents(c)
        .filter((e) => e.kind === 3)
        .map((e) => e.t),
    );
    let early = 0;
    let inStreet = 0;
    let late = 0;
    for (let k = 0; k < 72; k++) {
      if (puffKind(c.id, k) !== PUFF_SURGE) continue;
      // Its first seconds: low, in the canyon.
      for (let t = surgeAt; t < surgeAt + 4000; t += 250) {
        if (!dustPuff(c, k, c.t0 + t, puff)) continue;
        early++;
        expect(puff.y).toBeLessThanOrEqual(SURGE_TOP_M + 6);
      }
      // Ten seconds on: out in a street, well past the lot.
      if (dustPuff(c, k, c.t0 + surgeAt + 12_000, puff)) {
        late++;
        const x = c.x + puff.x;
        const z = c.z + puff.z;
        if (Math.min(toStreet(x), toStreet(z)) <= STREET_WIDTH / 2 + 1) {
          inStreet++;
        }
      }
    }
    expect(early).toBeGreaterThan(20);
    expect(late).toBeGreaterThan(10);
    expect(inStreet / late).toBeGreaterThan(0.8);
  });

  it("the haze follows the surge down a street, and is nothing far away", () => {
    const c = felled(PANCAKE);
    const b = city[TOWER] as Building;
    const t = c.t0 + c.endMs + 4000;
    // A camera low in the street off the tower's +x side, a block along.
    const sx = Math.ceil((b.x + b.width / 2) / BLOCK_PITCH) * BLOCK_PITCH;
    const cam = { x: sx, y: 6, z: b.z + 80 };
    expect(dustHaze([c], cam, t)).toBeGreaterThan(0.3);
    expect(dustHaze([c], { x: sx, y: 300, z: b.z + 80 }, t)).toBe(0);
    expect(dustHaze([c], { x: b.x + 900, y: 6, z: b.z }, t)).toBe(0);
  });
});

describe("D10 sound and camera", () => {
  it("the ground jolts on the floor events, fades with distance and is still beyond range", () => {
    const c = felled(PANCAKE, true);
    const events = collapseFloorEvents(c);
    const big = events.reduce((a, e) => (e.size > a.size ? e : a));
    const at = { x: c.x + 40, y: 10, z: c.z };
    const hit = collapseShakeAmount([c], at, c.t0 + big.t + 10);
    const after = collapseShakeAmount([c], at, c.t0 + big.t + 1100);
    expect(hit).toBeGreaterThan(after);
    const far = { x: c.x + 400, y: 10, z: c.z };
    expect(collapseShakeAmount([c], far, c.t0 + big.t + 10)).toBeLessThan(hit);
    const out = { x: c.x + COLLAPSE_SHAKE_RANGE + 10, y: 10, z: c.z };
    expect(collapseShakeAmount([c], out, c.t0 + big.t + 10)).toBe(0);
    // Nothing before the lead beat ends.
    expect(collapseShakeAmount([c], at, c.t0 + COLLAPSE_LEAD_MS - 1)).toBe(0);
  });

  it("at most COLLAPSE_BEATS_MAX roars, in time order, none already past; the creep before them", () => {
    const c = felled(PANCAKE, true);
    const beats = beatSchedule(c, c.t0, COLLAPSE_BEATS_MAX);
    expect(beats.length).toBeGreaterThan(1);
    expect(beats.length).toBeLessThanOrEqual(COLLAPSE_BEATS_MAX);
    for (let k = 0; k < beats.length; k++) {
      expect((beats[k] as { t: number }).t).toBeGreaterThanOrEqual(0);
      if (k > 0) {
        expect((beats[k] as { t: number }).t).toBeGreaterThanOrEqual(
          (beats[k - 1] as { t: number }).t,
        );
      }
    }
    expect(creepSeconds(c, c.t0)).toBeCloseTo(
      (COLLAPSE_LEAD_MS + COLLAPSE_CREEP_MS) / 1000,
      9,
    );
    // Joined late: only what is still to come.
    const late = beatSchedule(c, c.t0 + c.endMs - 500, COLLAPSE_BEATS_MAX);
    expect(late.length).toBeLessThan(beats.length);
    expect(creepSeconds(c, c.t0 + 5000)).toBe(0);
  });
});

describe("D10 detail: what a falling building sheds", () => {
  /** An Impacts stand-in that counts what is sprayed. */
  function recorder(): { impacts: Impacts; sprayed: number[] } {
    const sprayed: number[] = [];
    const impacts = {
      spray: (
        kind: number,
        _p: unknown,
        _n: unknown,
        _s: number,
        _sp: number,
        n: number,
      ) => {
        sprayed.push(kind, n);
      },
    } as unknown as Impacts;
    return { impacts, sprayed };
  }

  it("sheds gravel, frames, glass and sparks off a collapse coming down near the viewer — and nothing far away", () => {
    const c = felled(PANCAKE);
    const near = recorder();
    const fx = new CollapseDetail(near.impacts, city);
    const viewer = { x: c.x + 120, y: 80, z: c.z };
    let now = 1000;
    for (let t = c.t0; t < c.t0 + c.endMs; t += 33) {
      fx.update([c], viewer, t, now);
      now += 33;
    }
    expect(near.sprayed.length).toBeGreaterThan(100);
    const far = recorder();
    const fx2 = new CollapseDetail(far.impacts, city);
    const away = { x: c.x + DETAIL_RANGE_M + 50, y: 80, z: c.z };
    now = 1000;
    for (let t = c.t0; t < c.t0 + c.endMs; t += 33) {
      fx2.update([c], away, t, now);
      now += 33;
    }
    expect(far.sprayed).toEqual([]);
    // A landed collapse sheds nothing more.
    const done = recorder();
    const fx3 = new CollapseDetail(done.impacts, city);
    for (let k = 0; k < 30; k++) {
      fx3.update([c], viewer, c.t0 + c.endMs + 2000 + k * 33, 5000 + k * 33);
    }
    expect(done.sprayed).toEqual([]);
  });

  it("is quiet at share 0 and before the clock exists", () => {
    const c = felled(TOPPLE);
    const r = recorder();
    const fx = new CollapseDetail(r.impacts, city);
    fx.setQuality(0);
    const viewer = { x: c.x, y: 80, z: c.z };
    for (let k = 0; k < 60; k++)
      fx.update([c], viewer, c.t0 + 2000 + k * 33, k * 33);
    fx.setQuality(1);
    for (let k = 0; k < 60; k++) fx.update([c], viewer, null, 3000 + k * 33);
    expect(r.sprayed).toEqual([]);
  });
});

describe("D10 the collapse model travels with the welcome", () => {
  it("a tab built for another model knows it; an older server (no cm) is taken as is", () => {
    expect(staleCollapseModel({ cm: COLLAPSE_MODEL })).toBe(false);
    expect(staleCollapseModel({ cm: COLLAPSE_MODEL - 1 })).toBe(true);
    expect(staleCollapseModel({})).toBe(false);
  });

  it("the debris a pose is drawn from is the one collision uses (rest included)", () => {
    const c = felled(TOPPLE);
    const p = piecePose(c, 0, Number.POSITIVE_INFINITY, blankPose());
    expect(p.rest).toBe(true);
    expect(p.phi).toBe(c.rphi[0]);
  });
});
