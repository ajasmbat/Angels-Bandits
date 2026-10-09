// U5 underground life & light (client/src/render/underground-layout.ts,
// underground.ts): the placement is deterministic; nothing solid intrudes
// into a bore's clear flight volume — checked on the BUILT buffers against
// the same tunnelOpen the crash check uses; waterfalls and plants stay in
// the wall lining; the metro hall is rock behind glass that stands exactly
// where the wall would; every surface stays under the bloom threshold; and
// the whole thing is four draws whose cheaper tiers keep whole items.

import {
  RIVER_HALF_WIDTH,
  riverOffset,
} from "@angels-bandits/common/city/river";
import { blankCar } from "@angels-bandits/common/city/train";
import {
  BORE_FLOOR_Y,
  TUNNELS,
  type Tunnel,
  type TunnelFrame,
  overTunnel,
  tunnelFrameInto,
  tunnelOpen,
} from "@angels-bandits/common/city/tunnels";
import { hitsGround } from "@angels-bandits/common/collision";
import {
  EMISSIVE_LAMP,
  EMISSIVE_WINDOW,
  WORLD_SIZE,
} from "@angels-bandits/common/constants";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { luminance } from "../src/render/emissive";
import { QUALITY_PROFILES, type QualityTier } from "../src/render/quality";
import { buildTunnelGeometry } from "../src/render/tunnels";
import {
  ANIM,
  UndergroundLife,
  buildUndergroundBuffers,
} from "../src/render/underground";
import {
  BIRD_BOB,
  DEEP_CEIL,
  LINING,
  METRO_CARS,
  METRO_CYCLE,
  METRO_TRACK,
  STATION,
  birdAt,
  boreXZ,
  deepRange,
  metroCarBox,
  metroState,
  undergroundLayout,
} from "../src/render/underground-layout";

const H = 18;
const BLOOM = 0.72;
const layout = undergroundLayout();
const buffers = buildUndergroundBuffers(layout);
const frame: TunnelFrame = { s: 0, lat: 0, th: 0 };
const p = { x: 0, y: 0, z: 0 };

/** The first copy (of four) of every band: [start, end) vertex ranges. */
function firstCopies(ends: readonly number[]): [number, number][] {
  const out: [number, number][] = [];
  let start = 0;
  for (const end of ends) {
    out.push([start, start + (end - start) / 4]);
    start = end;
  }
  return out;
}

describe("U5 layout", () => {
  const strip = (l: ReturnType<typeof undergroundLayout>) =>
    JSON.stringify(l, (k, v) => (k === "t" ? (v as Tunnel).id : v));

  it("is deterministic", () => {
    expect(strip(undergroundLayout())).toBe(strip(layout));
  });

  it("dresses every bore, and themes the station, the garden and the grotto", () => {
    for (const t of TUNNELS) {
      expect(layout.panels.some((x) => x.t === t)).toBe(true);
      expect(layout.vines.some((x) => x.t === t)).toBe(true);
      expect(layout.moss.some((x) => x.t === t)).toBe(true);
    }
    expect(layout.gardens.length).toBeGreaterThan(40);
    expect(layout.waterfalls.length).toBeGreaterThan(10);
    expect(layout.stalls.length).toBe(6);
    expect(layout.walkers.length).toBeGreaterThan(20);
    expect(layout.birds.length).toBeGreaterThan(15);
    expect(
      layout.motes.filter((m) => m.kind === "firefly").length,
    ).toBeGreaterThan(300);
    expect(layout.glows.filter((g) => g.t.id === 1).length).toBeGreaterThan(
      layout.glows.filter((g) => g.t.id !== 1).length,
    );
  });

  it("keeps plants, moss and waterfalls in the wall lining, deep in the bore", () => {
    for (const t of TUNNELS) {
      const [d0, d1] = deepRange(t);
      expect(d0).toBeGreaterThan(0);
      expect(d1).toBeLessThan(t.length);
    }
    const inDeep = (t: Tunnel, s: number) => {
      const [d0, d1] = deepRange(t);
      return s >= d0 - 2 && s <= d1 + 2;
    };
    for (const g of layout.glows) {
      expect(inDeep(g.t, g.s)).toBe(true);
      // Its whole spread, cap or fronds, within LINING of the wall.
      expect(g.inset - g.size).toBeGreaterThan(0);
      expect(g.inset + g.size).toBeLessThanOrEqual(LINING);
    }
    for (const v of layout.vines) {
      expect(inDeep(v.t, v.s)).toBe(true);
      expect(v.length).toBeLessThan(DEEP_CEIL - BORE_FLOOR_Y);
    }
    for (const m of layout.moss) {
      expect(inDeep(m.t, m.s)).toBe(true);
      expect(m.y0).toBeGreaterThanOrEqual(0);
    }
    for (const w of layout.waterfalls) {
      expect(inDeep(w.t, w.s - w.hw)).toBe(true);
      expect(inDeep(w.t, w.s + w.hw)).toBe(true);
      expect(w.top).toBeLessThan(DEEP_CEIL - BORE_FLOOR_Y - 1.5);
    }
    // Nothing hangs on the station's glass.
    for (const x of [...layout.vines, ...layout.moss, ...layout.glows]) {
      if (x.t.id !== STATION.tunnel || x.side !== STATION.side) continue;
      expect(x.s < STATION.s0 - 1 || x.s > STATION.s1 + 1).toBe(true);
    }
  });

  it("keeps the motes and the birds inside the bore", () => {
    for (const m of layout.motes) {
      p.x = m.x;
      p.y = m.y;
      p.z = m.z;
      // Its own bore: the one it is laterally nearest, within its span.
      let best = Number.POSITIVE_INFINITY;
      for (const t of TUNNELS) {
        tunnelFrameInto(t, p, frame);
        if (frame.s < 0 || frame.s > t.length) continue;
        best = Math.min(best, Math.abs(frame.lat));
      }
      expect(best + m.amp).toBeLessThan(H);
      expect(m.y - m.amp).toBeGreaterThan(BORE_FLOOR_Y);
      expect(m.y + m.amp).toBeLessThan(DEEP_CEIL);
    }
    const q = { x: 0, y: 0, z: 0 };
    for (const b of layout.birds) {
      for (let sec = 0; sec < 60; sec += 0.5) {
        birdAt(b, sec, q);
        expect(q.y + BIRD_BOB).toBeLessThan(DEEP_CEIL);
        expect(
          TUNNELS.some((t) => {
            tunnelFrameInto(t, q, frame);
            const [d0, d1] = deepRange(t);
            return Math.abs(frame.lat) < H - 2 && frame.s > d0 && frame.s < d1;
          }),
        ).toBe(true);
      }
    }
  });
});

describe("U5 draw == collide", () => {
  it("puts no decor or veil vertex inside any bore's clear flight volume", () => {
    let tested = 0;
    for (const buf of [buffers.decor, buffers.veil]) {
      const pos = buf.geometry.getAttribute("position");
      for (const [a, b] of firstCopies(buf.ends)) {
        for (let i = a; i < b; i++) {
          p.x = pos.getX(i);
          p.y = pos.getY(i);
          p.z = pos.getZ(i);
          if (p.y > -0.5) continue;
          tested++;
          // A sphere of radius LINING (+ε) centred on any vertex never fits
          // in the open volume: every vertex is within LINING of a surface
          // (or in the rock), and LINING < PLAYER_RADIUS.
          if (tunnelOpen(p, LINING + 0.01)) {
            throw new Error(`vertex ${i} at ${p.x}, ${p.y}, ${p.z} intrudes`);
          }
        }
      }
    }
    expect(tested).toBeGreaterThan(50_000);
  });

  it("builds the metro hall in rock, clear of the other bores and the river", () => {
    const t = TUNNELS[STATION.tunnel] as Tunnel;
    const xz = { x: 0, z: 0, th: 0 };
    let n = 0;
    for (let s = STATION.s0 - 12; s <= STATION.s1 + 12; s += 3) {
      for (let lat = H + 0.3; lat <= STATION.back; lat += 1.5) {
        boreXZ(t, s, STATION.side * lat, xz);
        expect(overTunnel(xz.x, xz.z)).toBe(false);
        expect(Math.abs(riverOffset(xz.z))).toBeGreaterThan(
          RIVER_HALF_WIDTH + 50,
        );
        for (let y = BORE_FLOOR_Y + 0.5; y < DEEP_CEIL; y += 3) {
          p.x = xz.x;
          p.y = y;
          p.z = xz.z;
          expect(hitsGround(p, 0)).toBe(true);
          n++;
        }
      }
    }
    expect(n).toBeGreaterThan(1000);
  });

  it("covers the shell's window gap exactly with glass, at the wall plane", () => {
    const t = TUNNELS[STATION.tunnel] as Tunnel;
    // The shell leaves no left-wall face along the window.
    const [shell] = buildTunnelGeometry();
    const sp = shell.getAttribute("position");
    for (let i = 0; i < sp.count / 4; i += 3) {
      p.x = (sp.getX(i) + sp.getX(i + 1) + sp.getX(i + 2)) / 3;
      p.y = (sp.getY(i) + sp.getY(i + 1) + sp.getY(i + 2)) / 3;
      p.z = (sp.getZ(i) + sp.getZ(i + 1) + sp.getZ(i + 2)) / 3;
      tunnelFrameInto(t, p, frame);
      if (frame.s > STATION.s0 + 0.01 && frame.s < STATION.s1 - 0.01) {
        expect(STATION.side * frame.lat).toBeLessThan(H - 0.01);
      }
    }
    // The glass: the veil's faces on that wall plane tile it exactly.
    const pos = buffers.veil.geometry.getAttribute("position");
    const [[a, b]] = firstCopies(buffers.veil.ends) as [[number, number]];
    let area = 0;
    let s0 = Number.POSITIVE_INFINITY;
    let s1 = Number.NEGATIVE_INFINITY;
    let y0 = Number.POSITIVE_INFINITY;
    let y1 = Number.NEGATIVE_INFINITY;
    const v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    for (let i = a; i < b; i += 3) {
      for (let k = 0; k < 3; k++) {
        (v[k] as THREE.Vector3).set(
          pos.getX(i + k),
          pos.getY(i + k),
          pos.getZ(i + k),
        );
      }
      p.x =
        ((v[0] as THREE.Vector3).x +
          (v[1] as THREE.Vector3).x +
          (v[2] as THREE.Vector3).x) /
        3;
      p.y =
        ((v[0] as THREE.Vector3).y +
          (v[1] as THREE.Vector3).y +
          (v[2] as THREE.Vector3).y) /
        3;
      p.z =
        ((v[0] as THREE.Vector3).z +
          (v[1] as THREE.Vector3).z +
          (v[2] as THREE.Vector3).z) /
        3;
      tunnelFrameInto(t, p, frame);
      if (Math.abs(STATION.side * frame.lat - H) > 0.01) continue;
      if (frame.s < STATION.s0 - 1 || frame.s > STATION.s1 + 1) continue;
      const tri = new THREE.Triangle(v[0], v[1], v[2]);
      area += tri.getArea();
      for (const w of v) {
        tunnelFrameInto(t, w, frame);
        s0 = Math.min(s0, frame.s);
        s1 = Math.max(s1, frame.s);
        y0 = Math.min(y0, w.y);
        y1 = Math.max(y1, w.y);
      }
      // Air on the bore side of the glass, rock on the hall side.
      const n = tri.getNormal(new THREE.Vector3());
      const c = tri.getMidpoint(new THREE.Vector3());
      const inA = { x: c.x + n.x * 0.15, y: c.y, z: c.z + n.z * 0.15 };
      const inB = { x: c.x - n.x * 0.15, y: c.y, z: c.z - n.z * 0.15 };
      expect(hitsGround(inA, 0)).not.toBe(hitsGround(inB, 0));
    }
    expect(s0).toBeCloseTo(STATION.s0, 3);
    expect(s1).toBeCloseTo(STATION.s1, 3);
    expect(y0).toBeCloseTo(BORE_FLOOR_Y, 5);
    expect(y1).toBeCloseTo(DEEP_CEIL, 5);
    expect(area).toBeCloseTo(
      (STATION.s1 - STATION.s0) * (DEEP_CEIL - BORE_FLOOR_Y),
      1,
    );
  });

  it("runs the metro inside the hall on its schedule, never in a bore", () => {
    const st = { s: null as number | null, doors: 0 };
    const car = blankCar();
    let seen = 0;
    let open = 0;
    for (let ms = 0; ms < METRO_CYCLE * 1000 * 2; ms += 250) {
      metroState(ms, st);
      expect(metroState(ms, { s: null, doors: 0 })).toEqual(st);
      if (st.s === null) continue;
      expect(st.s).toBeGreaterThanOrEqual(METRO_TRACK[0]);
      expect(st.s).toBeLessThanOrEqual(METRO_TRACK[1]);
      if (st.doors > 0) open++;
      for (let i = 0; i < METRO_CARS; i++) {
        if (!metroCarBox(st.s, i, car)) continue;
        seen++;
        // The car stands in the hall: in the rock per collision, off every
        // bore, on the hall's floor.
        p.x = car.x;
        p.y = car.y;
        p.z = car.z;
        expect(hitsGround(p, 0)).toBe(true);
        expect(overTunnel(car.x, car.z)).toBe(false);
        expect(car.y - car.hy).toBeGreaterThan(BORE_FLOOR_Y);
      }
    }
    expect(seen).toBeGreaterThan(100);
    expect(open).toBeGreaterThan(40);
    // A train dwells with its doors open, and the platform empties too.
    expect(metroState(METRO_CYCLE * 1000 * 0.9, st).s).toBeNull();
  });
});

describe("U5 light", () => {
  const lum = (
    col: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
    i: number,
  ) => luminance(new THREE.Color(col.getX(i), col.getY(i), col.getZ(i)));

  it("keeps the shell's every surface under the bloom threshold", () => {
    const [shell] = buildTunnelGeometry();
    const col = shell.getAttribute("color");
    for (let i = 0; i < col.count; i++) expect(lum(col, i)).toBeLessThan(BLOOM);
  });

  it("puts only panels and lamps (LAMP) and bioluminescence (WINDOW) above it", () => {
    for (const buf of [buffers.decor, buffers.veil]) {
      const col = buf.geometry.getAttribute("color");
      const anim = buf.geometry.getAttribute("aAnim");
      for (let i = 0; i < col.count; i++) {
        const l = lum(col, i);
        const k = anim.getX(i);
        if (k === ANIM.lamp)
          expect(l).toBeLessThanOrEqual(EMISSIVE_LAMP + 1e-6);
        else if (k === ANIM.glow)
          expect(l).toBeLessThanOrEqual(EMISSIVE_WINDOW + 1e-6);
        // Water ripples peak 8 % over their base.
        else if (k === ANIM.flow) expect(l * 1.08).toBeLessThan(BLOOM);
        else expect(l).toBeLessThan(BLOOM);
      }
    }
    const mc = buffers.motes.geometry.getAttribute("color");
    const mm = buffers.motes.geometry.getAttribute("aMote");
    for (let i = 0; i < mc.count; i++) {
      const cap = mm.getW(i) > 0.5 ? EMISSIVE_WINDOW + 1e-6 : BLOOM;
      expect(lum(mc, i)).toBeLessThanOrEqual(cap);
    }
    const cc = buffers.critters.geometry.getAttribute("color");
    for (let i = 0; i < cc.count; i++) expect(lum(cc, i)).toBeLessThan(BLOOM);
  });
});

describe("U5 renderer budget", () => {
  it("is four draws on every tier, thinned to whole bands, four images each", () => {
    const r = new UndergroundLife();
    const draws: THREE.Object3D[] = [];
    r.group.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.Points) draws.push(o);
    });
    expect(draws.length).toBe(4);
    const keys = [r.decor, r.veil, r.motes, r.critters].map((m) =>
      (m.material as THREE.Material).customProgramCacheKey(),
    );
    expect(new Set(keys).size).toBe(4);
    const counts: Record<
      QualityTier,
      ReturnType<UndergroundLife["drawn"]>
    > = {} as never;
    for (const tier of ["high", "mobile", "low", "medium", "high"] as const) {
      r.setQuality(tier);
      counts[tier] = r.drawn();
      const bands = QUALITY_PROFILES[tier].tunnelLife;
      expect(r.drawn().decor).toBe(buffers.decor.ends[bands - 1]);
      expect(r.drawn().veil).toBe(buffers.veil.ends[bands - 1]);
      expect(r.drawn().motes).toBe(buffers.motes.ends[bands - 1]);
      expect(r.drawn().critters).toBe(buffers.critters.ends[bands - 1]);
      let n = 0;
      r.group.traverse((o) => {
        if ((o instanceof THREE.Mesh || o instanceof THREE.Points) && o.visible)
          n++;
      });
      expect(n).toBe(4);
      // No tier switch recompiles: the cache keys never move.
      expect(
        [r.decor, r.veil, r.motes, r.critters].map((m) =>
          (m.material as THREE.Material).customProgramCacheKey(),
        ),
      ).toEqual(keys);
    }
    // MOBILE is thinned; the core (the hall, its glass) is on every tier.
    expect(counts.mobile.decor).toBeLessThan(counts.low.decor);
    expect(counts.low.decor).toBeLessThan(counts.high.decor);
    expect(counts.mobile.motes).toBeLessThan(counts.high.motes);
    expect(counts.mobile.critters).toBeLessThan(counts.high.critters);
    expect(counts.mobile.veil).toBeGreaterThan(0);
    expect(QUALITY_PROFILES.mobile.tunnelLife).toBeLessThan(
      QUALITY_PROFILES.high.tunnelLife,
    );
  });

  it("tiles every band 2×2: copies one period apart, no stretched triangle", () => {
    for (const buf of [buffers.decor, buffers.veil]) {
      const pos = buf.geometry.getAttribute("position");
      for (const [a, b] of firstCopies(buf.ends)) {
        const q = b - a;
        for (let i = a; i < b; i += 3) {
          let minX = Number.POSITIVE_INFINITY;
          let maxX = Number.NEGATIVE_INFINITY;
          let minZ = Number.POSITIVE_INFINITY;
          let maxZ = Number.NEGATIVE_INFINITY;
          for (let v = 0; v < 3; v++) {
            minX = Math.min(minX, pos.getX(i + v));
            maxX = Math.max(maxX, pos.getX(i + v));
            minZ = Math.min(minZ, pos.getZ(i + v));
            maxZ = Math.max(maxZ, pos.getZ(i + v));
          }
          expect(maxX - minX).toBeLessThan(20);
          expect(maxZ - minZ).toBeLessThan(20);
          for (let k = 1; k < 4; k++) {
            const dx = pos.getX(i + k * q) - pos.getX(i);
            const dz = pos.getZ(i + k * q) - pos.getZ(i);
            expect([0, WORLD_SIZE]).toContain(Math.round(dx));
            expect([0, WORLD_SIZE]).toContain(Math.round(dz));
          }
        }
      }
    }
    for (const [buf, attr] of [
      [buffers.motes, "position"],
      [buffers.critters, "aBase"],
    ] as const) {
      const pos = buf.geometry.getAttribute(attr);
      let start = 0;
      for (const end of buf.ends) {
        expect((end - start) % 4).toBe(0);
        start = end;
      }
      expect(pos.count).toBe(buf.ends[buf.ends.length - 1]);
    }
  });
});
