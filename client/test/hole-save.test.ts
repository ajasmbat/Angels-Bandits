// H3 invisible hole save (client/src/game/hole-save.ts): the last-moment pose
// correction that threads a hole or a bridge underpass when a crash is
// imminent. H3 shipped against a scratch simulation only; this is that
// simulation committed — seeded near-misses flown through the real seed-42
// city the way main.ts flies them (stepFlight → stepHoleSave in place →
// detectCrash) — plus the caps, the corridor gate and the pass budget.
//
// Movers and nature are left out of the world: they are clock-driven (or
// placed per seed) and would make which approaches are near-misses depend on
// the frame clock. The save tests exactly the solids detectCrash is handed,
// so a static city exercises the same code paths.

import { readFileSync } from "node:fs";
import {
  type HoleSpan,
  cityHoles,
  generateCity,
  mulberry32,
} from "@angels-bandits/common/city";
import { bridgeSpans } from "@angels-bandits/common/city/river";
import { buildCityIndex } from "@angels-bandits/common/collision";
import {
  CITY_SEED,
  MAX_SPEED,
  PLAYER_RADIUS,
  WORLD_SIZE,
} from "@angels-bandits/common/constants";
import {
  type FlightInput,
  type FlightState,
  stepFlight,
} from "@angels-bandits/common/flight";
import { wrapDeltaAxis } from "@angels-bandits/common/world";
import { describe, expect, it } from "vitest";
import { detectCrash } from "../src/game/collision";
import {
  SAVE_ALIGN_MAX,
  SAVE_APPROACH,
  SAVE_CAPTURE,
  SAVE_MAX_ANGLE,
  SAVE_MAX_OFFSET,
  type SaveWorld,
  createHoleSave,
  holeSaveActive,
  resetHoleSave,
  saveCorridor,
  stepHoleSave,
} from "../src/game/hole-save";

const DEG = Math.PI / 180;
const R = PLAYER_RADIUS;
/** What a pilot notices: the correction's rate must stay under these. */
const MAX_POS_RATE = 6;
const MAX_ANG_RATE = 20 * DEG;

const city = generateCity(CITY_SEED);
/** main.ts's saveWorld, without the clock-driven solids (see the header). */
const world: SaveWorld = {
  spans: [...cityHoles(city), ...bridgeSpans()],
  buildings: city,
  index: buildCityIndex(city),
};
const crashes = (st: FlightState) =>
  detectCrash(st, world.buildings, world.index);
const wrap = (v: number) => ((v % WORLD_SIZE) + WORLD_SIZE) % WORLD_SIZE;

// --- Approaches -----------------------------------------------------------

/** One straight approach down a span's axis: stick neutral, so the line is
 * fixed by the start pose, as a pilot holding a slightly-off line would fly. */
interface Approach {
  span: HoleSpan;
  /** +1 along increasing axis coordinate. */
  sg: number;
  st: FlightState;
  input: FlightInput;
  dt: number;
}

/** Start `back` m before `span`'s near mouth (travel sign `sg`), `lat`/`up`
 * off its centre at the near mouth, drifting `th`/`tp` rad across/up. */
function approach(
  span: HoleSpan,
  sg: number,
  back: number,
  lat: number,
  up: number,
  th: number,
  tp: number,
  speed: number,
  dt: number,
): Approach {
  const x = span.hole.axis === "x";
  const along = -span.length / 2 - back; // span frame, + toward travel
  const l = lat - Math.tan(th) * back;
  const u = up - Math.tan(tp) * back;
  // Horizontal heading: along the axis (sg), drifting tan(th) across it.
  // flightForward's horizontal part is (−sin yaw, −cos yaw).
  const fa = sg;
  const fc = Math.tan(th);
  const yaw = Math.atan2(-(x ? fa : fc), -(x ? fc : fa));
  // Climb tan(tp) per metre ALONG the axis: per metre travelled that is
  // tan(tp)·cos(heading offset).
  const pitch = Math.atan(Math.tan(tp) * Math.cos(Math.atan(fc)));
  return {
    span,
    sg,
    st: {
      pos: {
        x: wrap(span.center.x + (x ? along * sg : l)),
        y: span.center.y + u,
        z: wrap(span.center.z + (x ? l : along * sg)),
      },
      yaw,
      pitch,
      roll: 0,
      rollRate: 0,
      speed,
      targetSpeed: Math.min(speed, MAX_SPEED),
    },
    // Above MAX_SPEED only a burn holds the speed (main.ts shapes boost
    // into the same input the save rolls out on).
    input: {
      pitch: 0,
      turn: 0,
      roll: 0,
      throttle: 0,
      boost: speed > MAX_SPEED,
    },
    dt,
  };
}

/** Signed metres past `span`'s centre in the direction of travel. */
function alongOf(span: HoleSpan, sg: number, p: FlightState["pos"]): number {
  return (
    (span.hole.axis === "x"
      ? wrapDeltaAxis(span.center.x, p.x)
      : wrapDeltaAxis(span.center.z, p.z)) * sg
  );
}

/** Flown this far past the far mouth, the hole is threaded. */
const EXIT_RUN = 10;

interface Flight {
  crashed: boolean;
  /** alongOf at the crash (or where the run ended). */
  at: number;
  /** Airspeed at the crash (or the end). */
  speed: number;
  /** The run crossed the wrap seam. */
  seam: boolean;
  saves: number;
  /** The save's own motion: summed |Δpos| m and |Δ(yaw, pitch)| rad, and
   * the highest per-frame rates. */
  pathPos: number;
  pathAng: number;
  peakPos: number;
  peakAng: number;
  /** Frames where the save moved a clear plane into a solid. */
  intoSolid: number;
  /** Frames where stepHoleSave said "no" yet the pose changed. */
  silentMoves: number;
}

/**
 * Fly `a` the way main.ts does — stepFlight, then (when `angles` is not
 * null) stepHoleSave on the fresh pose in place, then the crash check —
 * until a crash or EXIT_RUN past the far mouth. Instruments the save's
 * own per-frame motion: the pose after it minus the pose after stepFlight.
 */
function fly(a: Approach, angles: boolean | null): Flight {
  const out: Flight = {
    crashed: false,
    at: 0,
    speed: 0,
    seam: false,
    saves: 0,
    pathPos: 0,
    pathAng: 0,
    peakPos: 0,
    peakAng: 0,
    intoSolid: 0,
    silentMoves: 0,
  };
  const save = createHoleSave();
  const end = a.span.length / 2 + EXIT_RUN;
  let st: FlightState = { ...a.st, pos: { ...a.st.pos } };
  for (let i = 0; i < 4000; i++) {
    const px = st.pos.x;
    const pz = st.pos.z;
    st = stepFlight(st, a.input, a.dt);
    if (Math.abs(st.pos.x - px) > WORLD_SIZE / 2) out.seam = true;
    if (Math.abs(st.pos.z - pz) > WORLD_SIZE / 2) out.seam = true;
    if (angles !== null) {
      const b = { ...st, pos: { ...st.pos } };
      const moved = stepHoleSave(save, st, a.input, a.dt, world, null, angles);
      const dPos = Math.hypot(
        wrapDeltaAxis(b.pos.x, st.pos.x),
        st.pos.y - b.pos.y,
        wrapDeltaAxis(b.pos.z, st.pos.z),
      );
      const dAng = Math.hypot(st.yaw - b.yaw, st.pitch - b.pitch);
      if (!moved && (dPos !== 0 || dAng !== 0)) out.silentMoves++;
      out.pathPos += dPos;
      out.pathAng += dAng;
      out.peakPos = Math.max(out.peakPos, dPos / a.dt);
      out.peakAng = Math.max(out.peakAng, dAng / a.dt);
      if (dPos > 0 && !crashes(b) && crashes(st)) out.intoSolid++;
    }
    out.at = alongOf(a.span, a.sg, st.pos);
    out.speed = st.speed;
    if (crashes(st)) {
      out.crashed = true;
      break;
    }
    if (out.at > end) break;
  }
  out.saves = save.saves;
  return out;
}

// --- The near-miss sample ---------------------------------------------------

const KINDS = ["tunnel", "gate", "sky", "arch", "bridge"] as const;
/** Kept near-misses per hole kind (≥ 200 in all). */
const PER_KIND = 50;
/** The sphere clips the opening's clear boundary by this much, m: from a
 * graze to most of the save's 1.5 m reach. */
const OVERLAP_MIN = 0.1;
const OVERLAP_MAX = 1.2;
/** Frame times: 30, 60 and 144 Hz — the rollout's step is its own. */
const DTS = [1 / 30, 1 / 60, 1 / 144];

/** The longest run-up (≤ the corridor + 15 m) whose centreline is flown
 * clean through `span` without the save — landmark arches are hand-placed
 * and their approaches are not all clear air. null: no clean run-up. */
function runUp(span: HoleSpan, sg: number): number | null {
  for (const back of [SAVE_APPROACH + 15, 50, 35, 25]) {
    const a = approach(span, sg, back, 0, 0, 0, 0, 60, 1 / 60);
    if (!crashes(a.st) && !fly(a, null).crashed) return back;
  }
  return null;
}

interface NearMiss {
  a: Approach;
  kind: string;
  /** The no-save flight: crashes on the span. */
  off: Flight;
}

/**
 * Draw near-misses from seed 0x4833 (the scratch sim's seed): for each hole
 * kind in turn, a random span of that kind and direction, a speed in
 * 40–125 m/s, a frame time, an edge (a building hole's four sides; a
 * bridge's deck — the water under it is the open river, so a low line
 * there meets the water long before the bridge) and an overlap, on a line
 * drifting ≤ 0.4° each way. A draw is KEPT only when
 *   - it crashes without the save, on that span (mouth or inside), and
 *   - the same line shifted (overlap + 0.25 m) back toward the centre flies
 *     clean — the near-miss is threadable, nothing else is in the way.
 * Rejections are counted by reason so a biased filter shows.
 */
function sample() {
  const rand = mulberry32(0x4833);
  const runUps = new Map<HoleSpan, (number | null)[]>();
  const kept: NearMiss[] = [];
  const rejected = { noRunUp: 0, clear: 0, elsewhere: 0, unthreadable: 0 };
  let drawn = 0;
  for (const kind of KINDS) {
    const pool = world.spans.filter((s) => s.hole.kind === kind);
    let n = 0;
    for (let tries = 0; n < PER_KIND && tries < 4 * PER_KIND; tries++) {
      drawn++;
      const span = pool[Math.floor(rand() * pool.length)] as HoleSpan;
      const sg = rand() < 0.5 ? 1 : -1;
      const speed = 40 + rand() * 85;
      const dt = DTS[Math.floor(rand() * DTS.length)] as number;
      const overlap = OVERLAP_MIN + rand() * (OVERLAP_MAX - OVERLAP_MIN);
      const sides = kind === "bridge" ? 1 : 4;
      const edge = Math.floor(rand() * sides); // 0 top, 1 bottom, 2/3 sides
      const th = (rand() * 2 - 1) * 0.4 * DEG;
      const tp = (rand() * 2 - 1) * 0.4 * DEG;
      const free = rand() * 2 - 1;
      let ups = runUps.get(span);
      if (!ups) {
        ups = [runUp(span, 1), runUp(span, -1)];
        runUps.set(span, ups);
      }
      const back = ups[sg > 0 ? 0 : 1];
      if (back === null || back === undefined) {
        rejected.noRunUp++;
        continue;
      }
      // Each axis's line across the span (s ∈ [0, length] from the near
      // mouth): v(s) = v0 + tan(t)·s. The clipped axis peaks at exactly
      // clear + overlap; the other stays ≥ 1 m inside its clear band.
      const len = span.length;
      const clearL = span.hole.width / 2 - R;
      const clearU = span.hole.height / 2 - R;
      const clip = (clear: number, t: number, side: number, d: number) =>
        side * (clear + d) - Math.max(side * t * len, 0) * side;
      const inside = (clear: number, t: number) => {
        const lo = -(clear - 1) - Math.min(0, t * len);
        const hi = clear - 1 - Math.max(0, t * len);
        return lo + ((free + 1) / 2) * (hi - lo);
      };
      const lineAt = (d: number) => {
        if (edge < 2) {
          const up = clip(clearU, tp, edge === 0 ? 1 : -1, d);
          // A bridge channel is 120 m wide; keep well off its walls.
          const lat = kind === "bridge" ? free * 40 : inside(clearL, th);
          return { lat, up };
        }
        return {
          lat: clip(clearL, th, edge === 2 ? 1 : -1, d),
          up: inside(clearU, tp),
        };
      };
      const make = (d: number) => {
        const { lat, up } = lineAt(d);
        return approach(span, sg, back, lat, up, th, tp, speed, dt);
      };
      const a = make(overlap);
      const off = fly(a, null);
      if (!off.crashed) {
        rejected.clear++;
        continue;
      }
      if (off.at < -len / 2 - R - 1) {
        rejected.elsewhere++;
        continue;
      }
      if (fly(make(-0.25), null).crashed) {
        rejected.unthreadable++;
        continue;
      }
      kept.push({ a, kind, off });
      n++;
    }
  }
  return { kept, rejected, drawn };
}

describe("hole save — seeded near-misses through the seed-42 city", () => {
  const { kept, rejected, drawn } = sample();
  const classic = kept.map((c) => fly(c.a, true));
  const pointer = kept.map((c) => fly(c.a, false)); // mouse-aim / touch

  it("draws ≥ 200 near-misses, every hole kind and the bridges, 40–125 m/s, across the seam — each one a crash without the save", () => {
    expect(kept.length).toBeGreaterThanOrEqual(200);
    for (const kind of KINDS) {
      expect(kept.filter((c) => c.kind === kind).length, kind).toBe(PER_KIND);
    }
    for (const c of kept) expect(c.off.crashed).toBe(true);
    // The filter is not where the result comes from: almost every draw is
    // a real near-miss. (Arch spans whose run-up is blocked are the rest.)
    const lost = rejected.clear + rejected.elsewhere + rejected.unthreadable;
    expect(lost / drawn).toBeLessThan(0.1);
    // Speeds at the moment of impact span the envelope.
    const speeds = kept.map((c) => c.off.speed);
    expect(Math.min(...speeds)).toBeLessThan(45);
    expect(Math.max(...speeds)).toBeGreaterThan(120);
    expect(kept.some((c) => c.off.seam)).toBe(true);
  });

  for (const [mode, flights] of [
    ["classic stick", classic],
    ["mouse-aim / touch (position only)", pointer],
  ] as const) {
    it(`saves ≥ 95% of them in ${mode}, and ≥ 90% of every kind`, () => {
      const survived = flights.filter((f) => !f.crashed).length;
      expect(survived / kept.length).toBeGreaterThanOrEqual(0.95);
      for (const kind of KINDS) {
        const of = flights.filter((_, i) => kept[i]?.kind === kind);
        const ok = of.filter((f) => !f.crashed).length;
        expect(ok / of.length, kind).toBeGreaterThanOrEqual(0.9);
      }
    });

    it(`stays within its caps in ${mode}: ≤ 1.5 m, ≤ 3°, < 6 m/s, < 20°/s — and never into a solid`, () => {
      let peakPos = 0;
      let pathPos = 0;
      for (const f of flights) {
        // One pass per flight (it ends just past the exit): one budget.
        expect(f.pathPos).toBeLessThanOrEqual(SAVE_MAX_OFFSET + 1e-9);
        expect(f.pathAng).toBeLessThanOrEqual(SAVE_MAX_ANGLE + 1e-9);
        expect(f.peakPos).toBeLessThan(MAX_POS_RATE);
        expect(f.peakAng).toBeLessThan(MAX_ANG_RATE);
        expect(f.intoSolid).toBe(0);
        expect(f.silentMoves).toBe(0);
        peakPos = Math.max(peakPos, f.peakPos);
        pathPos = Math.max(pathPos, f.pathPos);
      }
      // …and the caps are approached, not vacuous.
      expect(peakPos).toBeGreaterThan(4);
      expect(pathPos).toBeGreaterThan(1);
      if (flights === pointer) {
        for (const f of flights) expect(f.pathAng).toBe(0);
      } else {
        expect(Math.max(...flights.map((f) => f.pathAng))).toBeGreaterThan(0);
      }
    });
  }
});

// --- Outside the corridor gate --------------------------------------------

/** Frames flown per gate check, 60 Hz: 5 s. */
const GATE_FRAMES = 300;

/** Fly `a` with the save on and require that it never acts: stepHoleSave
 * false, the pose bit-identical, no save. `gated` additionally requires
 * every frame to be outside every corridor. Returns whether it crashed. */
function flyUntouched(a: Approach, gated: boolean): boolean {
  const save = createHoleSave();
  let st: FlightState = { ...a.st, pos: { ...a.st.pos } };
  for (let i = 0; i < GATE_FRAMES; i++) {
    st = stepFlight(st, a.input, a.dt);
    if (gated) expect(saveCorridor(world, st)).toBeNull();
    const b = { ...st, pos: { ...st.pos } };
    expect(stepHoleSave(save, st, a.input, a.dt, world, null, true)).toBe(
      false,
    );
    expect(st).toEqual(b);
    if (crashes(st)) break;
  }
  expect(save.saves).toBe(0);
  expect(holeSaveActive(save)).toBe(false);
  return crashes(st);
}

describe("hole save — never outside the corridor gate", () => {
  const buildingSpans = world.spans.filter((s) => s.hole.kind !== "bridge");

  it("lets a plane lined up just outside a hole's capture crash into the facade beside it", () => {
    let crashed = 0;
    for (const span of buildingSpans) {
      for (const sg of [1, -1]) {
        for (const side of [1, -1]) {
          const lat = side * (span.hole.width / 2 + SAVE_CAPTURE + 0.5);
          const a = approach(span, sg, 40, lat, 0, 0, 0, 80, 1 / 60);
          if (crashes(a.st)) continue;
          if (flyUntouched(a, true)) crashed++;
        }
      }
    }
    // Most hosts are wider than their hole: these are real wall hits.
    expect(crashed).toBeGreaterThan(buildingSpans.length);
  });

  it("lets a plane crossing a mouth more than SAVE_ALIGN_MAX off its axis hit the walls", () => {
    let crashed = 0;
    for (const span of buildingSpans) {
      for (const sg of [1, -1]) {
        // 25° across, aimed to meet the mouth plane at the opening's edge.
        const th = SAVE_ALIGN_MAX + 5 * DEG;
        const a = approach(
          span,
          sg,
          30,
          span.hole.width / 2,
          0,
          th,
          0,
          70,
          1 / 60,
        );
        if (crashes(a.st)) continue;
        if (flyUntouched(a, false)) crashed++;
      }
    }
    expect(crashed).toBeGreaterThan(buildingSpans.length);
  });

  it("lets a plane in a bridge corridor drift into the river's bank wall", () => {
    for (const span of world.spans.filter((s) => s.hole.kind === "bridge")) {
      for (const sg of [1, -1]) {
        // Mid-height under the deck, 12° toward the bank: in the corridor,
        // lined up, and the impact is the embankment — not the hole.
        const a = approach(span, sg, 40, 50, 0, 12 * DEG, 0, 70, 1 / 60);
        expect(saveCorridor(world, a.st)).toBe(span);
        expect(flyUntouched(a, false)).toBe(true);
      }
    }
  });

  it("never acts on runs down the streets and canyons, crash or not", () => {
    const rand = mulberry32(0x4834);
    let runs = 0;
    let crashed = 0;
    for (let i = 0; runs < 150 && i < 600; i++) {
      // Low over the city on a street-aligned or random heading.
      const yaw =
        rand() < 0.6 ? Math.floor(rand() * 4) * (Math.PI / 2) : rand() * 7;
      const st: FlightState = {
        pos: {
          x: rand() * WORLD_SIZE,
          y: 15 + rand() * 90,
          z: rand() * WORLD_SIZE,
        },
        yaw,
        pitch: (rand() * 2 - 1) * 5 * DEG,
        roll: 0,
        rollRate: 0,
        speed: 40 + rand() * 50,
        targetSpeed: MAX_SPEED,
      };
      if (crashes(st)) continue;
      // Skip any run that ever enters a corridor: those are the holes'.
      const input = { pitch: 0, turn: 0, roll: 0, throttle: 0 };
      let probe = st;
      let gated = false;
      for (let k = 0; k < GATE_FRAMES && !crashes(probe); k++) {
        probe = stepFlight(probe, input, 1 / 60);
        if (saveCorridor(world, probe)) {
          gated = true;
          break;
        }
      }
      if (gated) continue;
      runs++;
      const span = world.spans[0] as HoleSpan; // unused by flyUntouched
      if (flyUntouched({ span, sg: 1, st, input, dt: 1 / 60 }, true)) crashed++;
    }
    expect(runs).toBe(150);
    expect(crashed).toBeGreaterThan(20); // the canyon walls do kill
  });
});

// --- The pass budget ---------------------------------------------------------

describe("hole save — one budget per pass, re-armed on death, respawn and teleport", () => {
  // The longest tunnel: a save commits at its mouth and finishes inside it,
  // so the plane is still in the corridor when it is "teleported".
  const tunnel = world.spans
    .filter((s) => s.hole.kind === "tunnel")
    .reduce((a, b) => (b.length > a.length ? b : a));
  const clearL = tunnel.hole.width / 2 - R;
  /** 1.1 m into the right wall, starting inside the corridor. */
  const a = approach(tunnel, 1, 40, clearL + 1.1, 0, 0, 0, 60, 1 / 60);
  const end = tunnel.length / 2 + EXIT_RUN;

  /** Fly `a` with `save` (position only) until the save has finished a
   * correction and gone idle, a crash, or the exit. */
  function run(
    save: ReturnType<typeof createHoleSave>,
    untilIdle: boolean,
  ): { crashed: boolean; at: number } {
    let st: FlightState = { ...a.st, pos: { ...a.st.pos } };
    const saves = save.saves;
    for (let i = 0; i < 2000; i++) {
      st = stepFlight(st, a.input, a.dt);
      stepHoleSave(save, st, a.input, a.dt, world, null, false);
      const at = alongOf(tunnel, 1, st.pos);
      if (crashes(st)) return { crashed: true, at };
      if (untilIdle && save.saves > saves && !holeSaveActive(save)) {
        return { crashed: false, at };
      }
      if (at > end) return { crashed: false, at };
    }
    return { crashed: false, at: Number.NaN };
  }

  it("is a real near-miss: crashes without the save, threads with a fresh one", () => {
    expect(fly(a, null).crashed).toBe(true);
    expect(run(createHoleSave(), false).crashed).toBe(false);
  });

  it("a spent budget blocks a second save in the same pass; resetHoleSave re-arms it", () => {
    const save = createHoleSave();
    const first = run(save, true);
    expect(first.crashed).toBe(false);
    expect(save.saves).toBe(1);
    // Still inside the tunnel's corridor, with most of the budget spent.
    expect(first.at).toBeLessThan(tunnel.length / 2);
    expect(save.usedPos).toBeGreaterThan(SAVE_MAX_OFFSET / 2);

    // Teleported back onto the same line without a reset: what is left of
    // the pass's budget cannot make the same correction again.
    const spent = { ...save };
    expect(run(spent, false).crashed).toBe(true);

    // Death, respawn and teleport all reset it — and then it threads.
    resetHoleSave(save);
    expect(save.usedPos).toBe(0);
    expect(save.usedAng).toBe(0);
    expect(run(save, false).crashed).toBe(false);
    expect(save.saves).toBe(2);
  });

  it("re-arms on its own once the plane has left every corridor", () => {
    const save = createHoleSave();
    run(save, true);
    expect(save.usedPos).toBeGreaterThan(0);
    const out: FlightState = { ...a.st, pos: { x: 0, y: 400, z: 0 } };
    expect(saveCorridor(world, out)).toBeNull();
    stepHoleSave(save, out, a.input, a.dt, world, null, false);
    expect(save.usedPos).toBe(0);
    expect(save.usedAng).toBe(0);
  });

  it("resetHoleSave stops a slide dead", () => {
    const save = createHoleSave();
    let st: FlightState = { ...a.st, pos: { ...a.st.pos } };
    for (let i = 0; i < 600 && save.saves === 0; i++) {
      st = stepFlight(st, a.input, a.dt);
      stepHoleSave(save, st, a.input, a.dt, world, null, false);
    }
    expect(holeSaveActive(save)).toBe(true);
    resetHoleSave(save);
    expect(holeSaveActive(save)).toBe(false);
    expect([save.dx, save.dy, save.dz, save.dyaw, save.dpitch]).toEqual([
      0, 0, 0, 0, 0,
    ]);
    expect(save.span).toBeNull();
  });

  it("main.ts resets it on death, respawn and teleport", () => {
    // main.ts is the browser entry point (DOM, WebGL), so its wiring is
    // read as text, like the markup tests do.
    const src = readFileSync(
      new URL("../src/main.ts", import.meta.url),
      "utf8",
    );
    const body = (start: string) => {
      const i = src.indexOf(start);
      expect(i, start).toBeGreaterThanOrEqual(0);
      return src.slice(i, src.indexOf("\n}\n", i));
    };
    expect(body("function resetAssist(")).toContain("resetHoleSave(holeSave)");
    expect(body("function enterDeath(")).toContain("resetAssist()");
    expect(body("function respawnSelf(")).toContain("resetAssist()");
    const i = src.indexOf("teleport: (", src.indexOf("window.__ab = {"));
    expect(i).toBeGreaterThanOrEqual(0);
    expect(src.slice(i, src.indexOf("\n  },", i))).toContain(
      "resetHoleSave(holeSave)",
    );
  });
});
