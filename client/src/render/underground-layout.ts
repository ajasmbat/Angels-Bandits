// U5 underground life & light — the pure placement seam behind
// underground.ts (no THREE in here, so the tests read exactly what is drawn).
//
// U4's bores stay as they are: 36 × 24 m, the collision untouched. What
// makes them a world is THEMED STRETCHES of the deep, covered run of each
// bore (floor at BORE_FLOOR_Y, under its ceiling, past both river walls):
//   - Crosstown's middle straight is the STATION: a metro hall in the rock
//     behind a glazed left wall — a platform with market stalls and people,
//     a three-car metro that pulls in, opens its doors and leaves.
//   - Seam Line's long straight is the GARDEN: hanging gardens, waterfalls
//     pouring from wall vents into raised channels, a lake across the floor,
//     birds and fireflies.
//   - Riverside's deep run is the GROTTO: bioluminescent mushrooms and
//     glowing ferns, thick moss, birds.
// Every deep stretch also gets warm daylight panels at the crown, vines,
// moss and drifting pollen.
//
// U6 gives every section its own character on top (lifeU6, below), all in
// the same four draws:
//   - Crosstown either side of the station is the MINE: timber sets, a
//     rail line with a maintenance cart running it, workers with lamps, old
//     machinery, cables and signs, a few stalactites and bats;
//   - Seam Line either side of the garden is the WORKS: pipe runs leaking
//     steam, cable runs, ceiling grates throwing shafts of light, machinery,
//     signs and workers;
//   - the GROTTO adds stalactites and stalagmites, glowing crystals, hanging
//     roots, roosting bats that swarm off the ceiling as a plane passes, and
//     deer and foxes on the moss banks;
//   - the GARDEN adds fish in the lake, deer and foxes, mist off the
//     waterfalls and hanging roots;
//   - the STATION's platform gets passengers waiting at its edge.
//
// DRAW == COLLIDE. Every SOLID item sits in the LINING: within LINING of
// the wall, floor or ceiling it hangs on — under PLAYER_RADIUS, so the
// crash sphere meets the bore's own surface before its centre could reach
// any of it (the tests check every built vertex against tunnelOpen). The
// metro hall is ROCK by hitsGround: its glass is the bore's wall plane, so
// you see the hall and you hit the glass, exactly where the wall kills.
// Birds, fireflies and pollen fly in the clear volume and are not solid —
// the city's birds and T2's platform people are the same exception.
//
// SEEDING. Every item draws from a salted mulberry32 stream keyed by its
// bore's id and an INTEGER slot along it (never a position), so the layout
// is identical on every client and stable under any translation.

import { mulberry32 } from "@angels-bandits/common/city";
import type { MoverBox } from "@angels-bandits/common/city/movers";
import { CAR_PITCH } from "@angels-bandits/common/city/train";
import {
  BORE_FLOOR_Y,
  BORE_HEIGHT,
  BORE_WIDTH,
  LINTEL_MIN,
  RAMP_GRADE,
  TUNNELS,
  type Tunnel,
  type TunnelPoint,
  tunnelPointInto,
} from "@angels-bandits/common/city/tunnels";
import {
  TRAIN_CAR_HEIGHT,
  TRAIN_CAR_LENGTH,
  TRAIN_CAR_LIFT,
  TRAIN_CAR_WIDTH,
} from "@angels-bandits/common/constants";

/** The decoration band against every bore surface, m. Under PLAYER_RADIUS
 * (2): the crash sphere touches the surface before its centre gets here. */
export const LINING = 1.5;
/** Half the bore's clear width, m. */
const HALF = BORE_WIDTH / 2;
/** The deep bore's ceiling (the floor is BORE_FLOOR_Y everywhere deep). */
export const DEEP_CEIL = Math.min(BORE_FLOOR_Y + BORE_HEIGHT, -LINTEL_MIN);
/** Placement slot along a bore, m: one seeded stream per slot. */
export const SLOT = 4;
/** Thinning bands: 0 core (every tier), 1 detail, 2 fine. */
export type Band = 0 | 1 | 2;
export const BANDS = 3;

const SALT = {
  wall: 0x5e11a1,
  garden: 0x6a4de5,
  motes: 0x30f1e5,
  birds: 0xb12d5a,
  walkers: 0x9ea9e2,
  stalls: 0x57a115,
} as const;

/** One stream per (bore, slot, salt). */
const stream = (salt: number, tunnel: number, slot: number): (() => number) =>
  mulberry32(
    (salt ^ Math.imul(tunnel + 1, 0x9e3779b1) ^ Math.imul(slot, 0x85ebca6b)) >>>
      0,
  );

// --- Frames ------------------------------------------------------------------

const pt: TunnelPoint = { x: 0, z: 0, th: 0 };

/** A point in a bore's frame (arc length, lateral offset + left of travel,
 * height) as unwrapped world x/z, written into `out`. */
export function boreXZ(
  t: Tunnel,
  s: number,
  lat: number,
  out: { x: number; z: number; th: number },
): { x: number; z: number; th: number } {
  tunnelPointInto(t, s, pt);
  out.x = pt.x - Math.sin(pt.th) * lat;
  out.z = pt.z + Math.cos(pt.th) * lat;
  out.th = pt.th;
  return out;
}

/** The deep, covered run of a bore: floor at BORE_FLOOR_Y, under its
 * ceiling, past both river walls (the ramps reach the floor long after
 * the sills), less a margin each end. */
export function deepRange(t: Tunnel): [number, number] {
  const [a, b] = t.ends;
  const margin = 2 * SLOT;
  return [
    a.flat + (a.top - BORE_FLOOR_Y) / RAMP_GRADE + margin,
    t.length - b.flat - (b.top - BORE_FLOOR_Y) / RAMP_GRADE - margin,
  ];
}

// --- Themes ------------------------------------------------------------------

/** Crosstown's middle straight (s 364–606): the station. Its window runs on
 * section boundaries (multiples of SECTION_STEP), so the shell's wall
 * strips stop exactly at its jambs. */
export const STATION = {
  tunnel: 0,
  /** +1: the hall is on the bore's left (lat > 0). */
  side: 1 as const,
  s0: 424,
  s1: 544,
  /** The hall's back wall, lateral m (the glass is the bore wall, HALF). */
  back: HALF + 16,
  /** The platform: from the glass to this lateral m, this high. */
  edge: HALF + 7.4,
  platformH: 1,
  /** The metro's centreline, lateral m. */
  track: HALF + 9.3,
  /** Mullion spacing along the glass, m. */
  pane: 6,
} as const;

/** Seam Line's long straight (s 388–1305): the garden, its lake. */
export const GARDEN = { tunnel: 2, s0: 420, s1: 1280 } as const;
export const LAKE = { tunnel: 2, s0: 820, s1: 900, rise: 0.3 } as const;
/** Riverside's deep run: the grotto. */
export const GROTTO = { tunnel: 1 } as const;

export type Zone = "station" | "garden" | "grotto" | "mine" | "works";

export function zoneAt(t: Tunnel, s: number): Zone {
  if (t.id === STATION.tunnel && s > STATION.s0 - 24 && s < STATION.s1 + 24) {
    return "station";
  }
  if (t.id === GARDEN.tunnel && s >= GARDEN.s0 && s <= GARDEN.s1) {
    return "garden";
  }
  if (t.id === GROTTO.tunnel) return "grotto";
  // U6: what was plain bore — Crosstown's is the mine, Seam Line's the works.
  return t.id === STATION.tunnel ? "mine" : "works";
}

/** True where the station's glass replaces the bore's `side` wall. */
export function inStationWindow(t: Tunnel, s: number, side: 1 | -1): boolean {
  return (
    t.id === STATION.tunnel &&
    side === STATION.side &&
    s >= STATION.s0 &&
    s <= STATION.s1
  );
}

// --- Items --------------------------------------------------------------------

/** Warm daylight panels at the crown. */
export interface Panel {
  t: Tunnel;
  s: number;
  lat: number;
  /** Half extents along s and across, m. */
  hl: number;
  hw: number;
  band: Band;
}

/** A vine curtain hanging down a wall from the ceiling. */
export interface Vine {
  t: Tunnel;
  s: number;
  side: 1 | -1;
  /** Hangs from the ceiling this far down, m. */
  length: number;
  width: number;
  shade: number;
  band: Band;
}

/** A moss patch on a wall (low) or a mound at a wall's foot. */
export interface Moss {
  t: Tunnel;
  s: number;
  side: 1 | -1;
  /** Bottom and top height over the floor, m. */
  y0: number;
  y1: number;
  /** Half length along s, m. */
  hl: number;
  shade: number;
  band: Band;
}

/** A glowing mushroom or fern at a wall's foot. */
export interface Glow {
  t: Tunnel;
  s: number;
  side: 1 | -1;
  kind: "mushroom" | "fern";
  /** In from the wall, m (≤ LINING minus its own size). */
  inset: number;
  height: number;
  size: number;
  hue: number;
  phase: number;
  band: Band;
}

/** A hanging garden: a planter at the ceiling, fronds trailing under it. */
export interface Garden {
  t: Tunnel;
  s: number;
  lat: number;
  hl: number;
  fronds: number;
  band: Band;
}

/** A waterfall: a vent high on a wall, a sheet down its face. */
export interface Waterfall {
  t: Tunnel;
  s: number;
  side: 1 | -1;
  /** Half width along s, m. */
  hw: number;
  /** The vent's height over the floor, m. */
  top: number;
  band: Band;
}

/** A raised channel at a wall's foot that the waterfalls pour into. */
export interface Channel {
  t: Tunnel;
  s0: number;
  s1: number;
  side: 1 | -1;
}

/** A market stall on the station platform. */
export interface Stall {
  s: number;
  /** Half length along s, m. */
  hl: number;
  hue: number;
  band: Band;
}

/** Drifting light: a firefly or a pollen grain, round a base point. */
export interface Mote {
  x: number;
  y: number;
  z: number;
  /** U6 adds steam (puffs rising off a pipe leak), mist (off a waterfall)
   * and shaft (dust in a grate's light). */
  kind: "firefly" | "pollen" | "steam" | "mist" | "shaft";
  /** Drift amplitude, m (stays inside the bore). */
  amp: number;
  phase: number;
  band: Band;
}

/** A bird looping an ellipse under the ceiling: centre, axis along the
 * bore (unit), semi-axes along and across, height, speed (rad/s). */
export interface Bird {
  x: number;
  y: number;
  z: number;
  ux: number;
  uz: number;
  a: number;
  b: number;
  speed: number;
  phase: number;
  size: number;
  band: Band;
}

/** Someone walking the platform: from `(x, y, z)` along unit `(ux, uz)`
 * for `length` m and back, at `speed` m/s. */
export interface Walker {
  x: number;
  y: number;
  z: number;
  ux: number;
  uz: number;
  length: number;
  speed: number;
  phase: number;
  height: number;
  shade: number;
  band: Band;
}

export interface UndergroundLayout {
  panels: Panel[];
  vines: Vine[];
  moss: Moss[];
  glows: Glow[];
  gardens: Garden[];
  waterfalls: Waterfall[];
  channels: Channel[];
  stalls: Stall[];
  motes: Mote[];
  birds: Bird[];
  walkers: Walker[];
  // --- U6 ---
  timbers: Timber[];
  rails: Rail[];
  machines: Machine[];
  cables: Cable[];
  signs: Sign[];
  pipes: Pipe[];
  grates: Grate[];
  drips: Drip[];
  crystals: Crystal[];
  roots: Root[];
  bats: Bat[];
  fish: Fish[];
  grazers: Grazer[];
  /** People and the cart move like U5's walkers (there and back). */
  workers: Walker[];
  passengers: Walker[];
  carts: Walker[];
}

// --- U6 items -------------------------------------------------------------------

/** A mine timber set: a post against each wall and a cap under the
 * ceiling, at `s`. */
export interface Timber {
  t: Tunnel;
  s: number;
  band: Band;
}

/** A rail line at the foot of the `side` wall, s0 → s1. */
export interface Rail {
  t: Tunnel;
  s0: number;
  s1: number;
  side: 1 | -1;
}

/** Old machinery against a wall: a housing `hl` half long, `depth` deep
 * (≤ LINING), `height` tall; kind 0 a generator, 1 a winch. */
export interface Machine {
  t: Tunnel;
  s: number;
  side: 1 | -1;
  hl: number;
  depth: number;
  height: number;
  kind: 0 | 1;
  hue: number;
  band: Band;
}

/** A cable run along a wall, slung between brackets every CABLE_SPAN. */
export interface Cable {
  t: Tunnel;
  s0: number;
  s1: number;
  side: 1 | -1;
  /** Bracket height over the floor, m. */
  y: number;
}

/** A wall sign: a lit panel with an arrow along the bore (+1: +s). */
export interface Sign {
  t: Tunnel;
  s: number;
  side: 1 | -1;
  hue: number;
  arrow: 1 | -1;
  band: Band;
}

/** A pipe run along a wall at height `y`, `r` half its section. */
export interface Pipe {
  t: Tunnel;
  s0: number;
  s1: number;
  side: 1 | -1;
  y: number;
  r: number;
}

/** A grate in the ceiling with daylight behind it. */
export interface Grate {
  t: Tunnel;
  s: number;
  lat: number;
  band: Band;
}

/** A stalactite (from the ceiling) or a stalagmite (`up`, from the floor). */
export interface Drip {
  t: Tunnel;
  s: number;
  lat: number;
  len: number;
  r: number;
  up: boolean;
  shade: number;
  band: Band;
}

/** A glowing crystal cluster at a wall's foot. */
export interface Crystal {
  t: Tunnel;
  s: number;
  side: 1 | -1;
  inset: number;
  height: number;
  size: number;
  hue: number;
  phase: number;
  band: Band;
}

/** A hanging root strand from the ceiling. */
export interface Root {
  t: Tunnel;
  s: number;
  lat: number;
  len: number;
  width: number;
  shade: number;
  band: Band;
}

/** A roosting bat: its roost under the ceiling, the bore's way (unit), the
 * radius it swarms at, its wingbeat way round (sign) and phase. */
export interface Bat {
  x: number;
  y: number;
  z: number;
  ux: number;
  uz: number;
  r: number;
  speed: number;
  phase: number;
  band: Band;
}

/** A fish in the lake: an ellipse just under the surface, a jump now and
 * then. */
export interface Fish {
  x: number;
  y: number;
  z: number;
  ux: number;
  uz: number;
  a: number;
  b: number;
  speed: number;
  phase: number;
  jump: number;
  hue: number;
  band: Band;
}

/** A deer or a fox on a moss bank, grazing to and fro along the wall. */
export interface Grazer {
  x: number;
  y: number;
  z: number;
  ux: number;
  uz: number;
  length: number;
  speed: number;
  phase: number;
  kind: "deer" | "fox";
  band: Band;
}

/** Panel spacing along the crown, m. */
const PANEL_STEP = 12;
/** Garden planters: spacing, lateral rows. */
const GARDEN_STEP = 16;
const GARDEN_LAT = 11;
/** Waterfalls: one every this many m, alternating sides. */
const FALL_STEP = 56;

const band = (r: number, core: number, detail: number): Band =>
  r < core ? 0 : r < core + detail ? 1 : 2;

/** The whole layout. Pure: every call returns the same items. */
export function undergroundLayout(): UndergroundLayout {
  const out: UndergroundLayout = {
    panels: [],
    vines: [],
    moss: [],
    glows: [],
    gardens: [],
    waterfalls: [],
    channels: [],
    stalls: [],
    motes: [],
    birds: [],
    walkers: [],
    timbers: [],
    rails: [],
    machines: [],
    cables: [],
    signs: [],
    pipes: [],
    grates: [],
    drips: [],
    crystals: [],
    roots: [],
    bats: [],
    fish: [],
    grazers: [],
    workers: [],
    passengers: [],
    carts: [],
  };
  for (const t of TUNNELS) {
    const [d0, d1] = deepRange(t);
    // Panels at the crown, a pair either side of it, every PANEL_STEP.
    for (let k = Math.ceil(d0 / PANEL_STEP); k * PANEL_STEP <= d1; k++) {
      for (const lat of [-2.2, 2.2]) {
        out.panels.push({
          t,
          s: k * PANEL_STEP,
          lat,
          hl: 2.4,
          hw: 0.9,
          band: 0,
        });
      }
    }
    // Wall dressing, slot by slot.
    const k0 = Math.ceil(d0 / SLOT);
    const k1 = Math.floor(d1 / SLOT);
    for (let k = k0; k < k1; k++) {
      const s = k * SLOT + SLOT / 2;
      const zone = zoneAt(t, s);
      const r = stream(SALT.wall, t.id, k);
      for (const side of [1, -1] as const) {
        if (inStationWindow(t, s, side)) continue;
        const lush = zone === "garden" ? 0.85 : zone === "grotto" ? 0.6 : 0.4;
        if (r() < lush) {
          out.vines.push({
            t,
            s: s + (r() - 0.5) * 2,
            side,
            length: 3 + r() * (zone === "garden" ? 9 : 6),
            width: 0.8 + r() * 1.6,
            shade: r(),
            band: band(r(), 0.25, 0.4),
          });
        } else {
          r();
          r();
          r();
          r();
          r();
        }
        const mossy = zone === "grotto" ? 0.9 : 0.55;
        if (r() < mossy) {
          const y0 = r() * 0.4;
          out.moss.push({
            t,
            s: s + (r() - 0.5) * 2,
            side,
            y0,
            y1: y0 + 0.8 + r() * (zone === "grotto" ? 3.5 : 2),
            hl: 0.9 + r() * 1.2,
            shade: r(),
            band: band(r(), 0.2, 0.4),
          });
        } else {
          r();
          r();
          r();
          r();
          r();
        }
        const glowy =
          zone === "grotto" ? 0.95 : zone === "garden" ? 0.45 : 0.25;
        const n = r() < glowy ? (zone === "grotto" ? 3 : 1) : 0;
        for (let i = 0; i < 3; i++) {
          const mushroom = r() < 0.6;
          const size = mushroom ? 0.18 + r() * 0.32 : 0.25 + r() * 0.3;
          const g: Glow = {
            t,
            s: s + (r() - 0.5) * SLOT * 0.9,
            side,
            kind: mushroom ? "mushroom" : "fern",
            inset: size + 0.05 + r() * (LINING - 2 * size - 0.1),
            height: mushroom ? 0.25 + r() * 0.9 : 0.5 + r() * 0.8,
            size,
            hue: r(),
            phase: r() * Math.PI * 2,
            band: band(r(), 0.3, 0.35),
          };
          if (i < n) out.glows.push(g);
        }
      }
    }
  }

  // The garden: planters at the crown's flanks, waterfalls, channels.
  const g = TUNNELS[GARDEN.tunnel] as Tunnel;
  for (
    let k = Math.ceil(GARDEN.s0 / GARDEN_STEP);
    k * GARDEN_STEP <= GARDEN.s1;
    k++
  ) {
    const r = stream(SALT.garden, g.id, k);
    for (const lat of [-GARDEN_LAT, GARDEN_LAT]) {
      out.gardens.push({
        t: g,
        s: k * GARDEN_STEP + (r() - 0.5) * 3,
        lat: lat + (r() - 0.5) * 1.5,
        hl: 2 + r() * 1.5,
        fronds: 5 + Math.floor(r() * 5),
        band: band(r(), 0.6, 0.3),
      });
    }
  }
  for (
    let k = Math.ceil(GARDEN.s0 / FALL_STEP);
    k * FALL_STEP <= GARDEN.s1 - 8;
    k++
  ) {
    const r = stream(SALT.garden, g.id, 1000 + k);
    out.waterfalls.push({
      t: g,
      s: k * FALL_STEP + (r() - 0.5) * 10,
      side: k % 2 === 0 ? 1 : -1,
      hw: 1.2 + r() * 1.4,
      top: BORE_HEIGHT - 3 - r() * 4,
      band: 0,
    });
  }
  for (const side of [1, -1] as const) {
    out.channels.push({ t: g, s0: GARDEN.s0, s1: LAKE.s0, side });
    out.channels.push({ t: g, s0: LAKE.s1, s1: GARDEN.s1, side });
  }

  // The station: stalls at both ends of the platform, the middle left open
  // to the train; people walking its length.
  for (let k = 0; k < 6; k++) {
    const r = stream(SALT.stalls, STATION.tunnel, k);
    const s = k < 3 ? STATION.s0 + 7 + k * 8 : STATION.s1 - 7 - (k - 3) * 8;
    out.stalls.push({ s, hl: 2.6, hue: r(), band: k % 3 === 2 ? 1 : 0 });
  }
  const st = TUNNELS[STATION.tunnel] as Tunnel;
  const p0 = { x: 0, z: 0, th: 0 };
  for (let k = 0; k < 28; k++) {
    const r = stream(SALT.walkers, st.id, k);
    const lat = HALF + 1.2 + r() * (STATION.edge - HALF - 2.2);
    const from = STATION.s0 + 2 + r() * 20;
    const to = STATION.s1 - 2 - r() * 20;
    boreXZ(st, from, STATION.side * lat, p0);
    out.walkers.push({
      x: p0.x,
      y: BORE_FLOOR_Y + STATION.platformH,
      z: p0.z,
      ux: Math.cos(p0.th),
      uz: Math.sin(p0.th),
      length: to - from,
      speed: 0.9 + r() * 0.7,
      phase: r(),
      height: 1.55 + r() * 0.35,
      shade: r(),
      band: band(r(), 0.5, 0.3),
    });
  }

  // Motes: pollen through every deep stretch, fireflies in the garden and
  // the grotto. Base points keep `amp` clear of every surface.
  for (const t of TUNNELS) {
    const [d0, d1] = deepRange(t);
    for (let k = Math.ceil(d0 / SLOT); k * SLOT < d1; k++) {
      const s = k * SLOT;
      const zone = zoneAt(t, s);
      const r = stream(SALT.motes, t.id, k);
      const fireflies =
        zone === "garden"
          ? 4
          : zone === "grotto"
            ? 5
            : zone === "station"
              ? 0
              : 1;
      const pollen = 3;
      for (let i = 0; i < fireflies + pollen; i++) {
        const firefly = i < fireflies;
        const amp = firefly ? 1.6 : 2;
        const lat = (r() * 2 - 1) * (HALF - amp - 1);
        const lo = BORE_FLOOR_Y + amp + (firefly ? 0.5 : 1);
        const hi = firefly ? BORE_FLOOR_Y + 9 : DEEP_CEIL - amp - 1;
        const y = lo + r() * (hi - lo);
        boreXZ(t, s + r() * SLOT, lat, p0);
        out.motes.push({
          x: p0.x,
          y,
          z: p0.z,
          kind: firefly ? "firefly" : "pollen",
          amp,
          phase: r() * Math.PI * 2,
          band: band(r(), firefly ? 0.4 : 0.3, 0.35),
        });
      }
    }
  }

  // Birds: loops under the ceiling of the garden and the grotto's first
  // straight (Riverside's leg 0 ends at s 463).
  const flocks: [Tunnel, number, number][] = [
    [g, GARDEN.s0 + 40, GARDEN.s1 - 40],
    [
      TUNNELS[GROTTO.tunnel] as Tunnel,
      deepRange(TUNNELS[GROTTO.tunnel] as Tunnel)[0] + 30,
      440,
    ],
  ];
  let id = 0;
  for (const [t, a, b] of flocks) {
    for (let s = a; s < b; s += 45) {
      const r = stream(SALT.birds, t.id, id++);
      const along = 12 + r() * 18;
      boreXZ(t, s, (r() - 0.5) * 6, p0);
      out.birds.push({
        x: p0.x,
        y: DEEP_CEIL - 3.5 - r() * 4,
        z: p0.z,
        ux: Math.cos(p0.th),
        uz: Math.sin(p0.th),
        a: along,
        b: 6 + r() * 5,
        speed: (0.35 + r() * 0.3) * (r() < 0.5 ? 1 : -1),
        phase: r() * Math.PI * 2,
        size: 0.35 + r() * 0.2,
        band: band(r(), 0.35, 0.35),
      });
    }
  }
  lifeU6(out);
  return out;
}

// --- U6: a character per section ------------------------------------------------

const SALT6 = {
  mine: 0x6d1e0b,
  works: 0x3e4b52,
  grotto: 0x9407e3,
  garden: 0x6a2d17,
  people: 0x9e0913,
  fish: 0xf15b0a,
} as const;

/** Cable brackets every this many m (the run sags between them). */
export const CABLE_SPAN = 6;
/** Mine timber sets every this many slots (12 m). */
const TIMBER_EVERY = 3;
/** A worker's walkway keeps this far from any machine along the bore, m. */
const MACHINE_CLEAR = 4;

/** The contiguous stretches of `t`'s deep run in `zone`, [s0, s1]. */
export function zoneRuns(t: Tunnel, zone: Zone): [number, number][] {
  const [d0, d1] = deepRange(t);
  const out: [number, number][] = [];
  let open: number | null = null;
  for (let s = d0; s <= d1; s += SLOT) {
    const inZone = zoneAt(t, s) === zone && s + SLOT <= d1;
    if (inZone && open === null) open = s;
    if (!inZone && open !== null) {
      out.push([open, s]);
      open = null;
    }
  }
  if (open !== null) out.push([open, d1]);
  return out;
}

const pick = (r: () => number): 1 | -1 => (r() < 0.5 ? 1 : -1);

/** U6 dressing and life, appended to `out`. Pure (seeded per slot). */
function lifeU6(out: UndergroundLayout): void {
  const p0 = { x: 0, z: 0, th: 0 };
  const crosstown = TUNNELS[STATION.tunnel] as Tunnel;
  const seam = TUNNELS[GARDEN.tunnel] as Tunnel;
  const grotto = TUNNELS[GROTTO.tunnel] as Tunnel;

  const stalactite = (t: Tunnel, s: number, r: () => number, b: Band) => {
    out.drips.push({
      t,
      s,
      lat: (r() * 2 - 1) * (HALF - 1),
      len: 0.45 + r() * 0.95,
      r: 0.1 + r() * 0.2,
      up: false,
      shade: r(),
      band: b,
    });
  };
  const roost = (t: Tunnel, s: number, r: () => number, n: number) => {
    const lat = (r() * 2 - 1) * (HALF - 8);
    for (let i = 0; i < n; i++) {
      boreXZ(t, s + (r() - 0.5) * 3, lat + (r() - 0.5) * 3, p0);
      out.bats.push({
        x: p0.x,
        y: DEEP_CEIL - 0.25,
        z: p0.z,
        ux: Math.cos(p0.th),
        uz: Math.sin(p0.th),
        r: 2.5 + r() * 3.5,
        speed: (0.8 + r() * 0.6) * pick(r),
        phase: r() * Math.PI * 2,
        band: i < 2 ? 0 : band(r(), 0.2, 0.5),
      });
    }
  };
  /** People walking the foot of the `side` wall, clear of the machines. */
  const workers = (
    t: Tunnel,
    a: number,
    b: number,
    side: 1 | -1,
    n: number,
  ) => {
    const r = stream(SALT6.people, t.id, Math.round(a));
    for (let i = 0; i < n; i++) {
      const len = 12 + r() * 14;
      const from = a + 6 + r() * Math.max(0, b - a - 12 - len);
      const shade = r();
      const speed = 0.8 + r() * 0.5;
      const phase = r();
      const height = 1.7 + r() * 0.15;
      const blocked = out.machines.some(
        (m) =>
          m.t === t &&
          m.side === side &&
          m.s + m.hl + MACHINE_CLEAR > from &&
          m.s - m.hl - MACHINE_CLEAR < from + len,
      );
      if (blocked) continue;
      boreXZ(t, from, side * (HALF - 0.85), p0);
      out.workers.push({
        x: p0.x,
        y: BORE_FLOOR_Y,
        z: p0.z,
        ux: Math.cos(p0.th),
        uz: Math.sin(p0.th),
        length: len,
        speed,
        phase,
        height,
        shade,
        band: i === 0 ? 0 : 1,
      });
    }
  };

  // The MINE: Crosstown either side of the station.
  for (const [a, b] of zoneRuns(crosstown, "mine")) {
    out.rails.push({ t: crosstown, s0: a + 2, s1: b - 2, side: 1 });
    out.cables.push({ t: crosstown, s0: a, s1: b, side: -1, y: 21.6 });
    const k0 = Math.ceil(a / SLOT);
    for (let k = k0; k * SLOT + SLOT <= b; k++) {
      const s = k * SLOT + SLOT / 2;
      const r = stream(SALT6.mine, crosstown.id, k);
      if (k % TIMBER_EVERY === 0) {
        out.timbers.push({ t: crosstown, s, band: k % 6 === 0 ? 0 : 1 });
      }
      // Machinery on the far wall from the rails, never on a timber.
      if (r() < 0.22 && k % TIMBER_EVERY === 1) {
        out.machines.push({
          t: crosstown,
          s,
          side: -1,
          hl: 1.1 + r() * 0.6,
          depth: 0.9 + r() * 0.3,
          height: 1.2 + r() * 0.8,
          kind: r() < 0.5 ? 0 : 1,
          hue: r(),
          band: 0,
        });
      }
      if (r() < 0.16) stalactite(crosstown, s, r, band(r(), 0.2, 0.4));
      if (k % 18 === 5) {
        out.signs.push({
          t: crosstown,
          s,
          side: -1,
          hue: r(),
          arrow: pick(r),
          band: 0,
        });
      }
      if (r() < 0.035) roost(crosstown, s, r, 3 + Math.floor(r() * 3));
    }
    // The maintenance cart, to and fro along the rails.
    const rc = stream(SALT6.people, crosstown.id, 5000 + Math.round(a));
    boreXZ(crosstown, a + 6, HALF - 0.85, p0);
    out.carts.push({
      x: p0.x,
      y: BORE_FLOOR_Y + 0.12,
      z: p0.z,
      ux: Math.cos(p0.th),
      uz: Math.sin(p0.th),
      length: b - a - 12,
      speed: 3 + rc() * 1.5,
      phase: rc(),
      height: 0.9,
      shade: rc(),
      band: 0,
    });
    workers(crosstown, a, b, -1, 4);
  }

  // The WORKS: Seam Line either side of the garden.
  for (const [a, b] of zoneRuns(seam, "works")) {
    out.pipes.push({ t: seam, s0: a + 2, s1: b - 2, side: -1, y: 3, r: 0.26 });
    out.pipes.push({
      t: seam,
      s0: a + 2,
      s1: b - 2,
      side: -1,
      y: 3.9,
      r: 0.17,
    });
    out.cables.push({ t: seam, s0: a, s1: b, side: 1, y: 21.6 });
    const k0 = Math.ceil(a / SLOT);
    for (let k = k0; k * SLOT + SLOT <= b; k++) {
      const s = k * SLOT + SLOT / 2;
      const r = stream(SALT6.works, seam.id, k);
      if (k % 20 === 6) {
        const lat = k % 40 === 6 ? -7 : 7;
        out.grates.push({ t: seam, s, lat, band: 0 });
        // The shaft: dust hanging in its light, floor to ceiling.
        for (let i = 0; i < 26; i++) {
          boreXZ(seam, s + (r() - 0.5) * 2.4, lat + (r() - 0.5) * 2.4, p0);
          out.motes.push({
            x: p0.x,
            y: BORE_FLOOR_Y + 1.6 + r() * (DEEP_CEIL - BORE_FLOOR_Y - 3.2),
            z: p0.z,
            kind: "shaft",
            amp: 0.5,
            phase: r() * Math.PI * 2,
            band: i < 12 ? 0 : 1,
          });
        }
      }
      if (r() < 0.07) {
        // A leaking flange: puffs of steam off the lower pipe.
        for (let i = 0; i < 6; i++) {
          boreXZ(seam, s + (r() - 0.5) * 0.4, -(HALF - 1.9), p0);
          out.motes.push({
            x: p0.x,
            y: BORE_FLOOR_Y + 3.1,
            z: p0.z,
            kind: "steam",
            amp: 1.2,
            phase: (i / 6) * Math.PI * 2,
            band: i < 3 ? 0 : 1,
          });
        }
      }
      if (r() < 0.05 && k % 20 !== 6) {
        out.machines.push({
          t: seam,
          s,
          side: 1,
          hl: 1 + r() * 0.8,
          depth: 0.8 + r() * 0.4,
          height: 1.3 + r() * 1,
          kind: r() < 0.5 ? 0 : 1,
          hue: r(),
          band: 0,
        });
      }
      if (k % 22 === 9) {
        out.signs.push({
          t: seam,
          s,
          side: 1,
          hue: r(),
          arrow: pick(r),
          band: 0,
        });
      }
      if (r() < 0.06) stalactite(seam, s, r, 2);
    }
    workers(seam, a, b, 1, 2);
  }

  // The GROTTO: dripstone, crystals, roots, bats, grazers.
  {
    const [d0, d1] = deepRange(grotto);
    for (let k = Math.ceil(d0 / SLOT); k * SLOT + SLOT <= d1; k++) {
      const s = k * SLOT + SLOT / 2;
      const r = stream(SALT6.grotto, grotto.id, k);
      if (r() < 0.55) stalactite(grotto, s, r, band(r(), 0.35, 0.35));
      if (r() < 0.22) {
        out.drips.push({
          t: grotto,
          s: s + (r() - 0.5) * 2,
          lat: (r() * 2 - 1) * (HALF - 1),
          len: 0.4 + r() * 0.95,
          r: 0.14 + r() * 0.22,
          up: true,
          shade: r(),
          band: band(r(), 0.3, 0.4),
        });
      }
      for (const side of [1, -1] as const) {
        if (r() < 0.3) {
          const size = 0.18 + r() * 0.17;
          out.crystals.push({
            t: grotto,
            s: s + (r() - 0.5) * SLOT * 0.8,
            side,
            inset: size + 0.05 + r() * (LINING - 2 * size - 0.1),
            height: 0.4 + r() * 0.7,
            size,
            hue: r(),
            phase: r() * Math.PI * 2,
            band: band(r(), 0.35, 0.35),
          });
        }
      }
      if (r() < 0.45) {
        out.roots.push({
          t: grotto,
          s: s + (r() - 0.5) * SLOT,
          lat: (r() * 2 - 1) * (HALF - 0.6),
          len: 0.5 + r() * 0.9,
          width: 0.07 + r() * 0.07,
          shade: r(),
          band: band(r(), 0.25, 0.4),
        });
      }
      if (r() < 0.07) roost(grotto, s, r, 4 + Math.floor(r() * 4));
      if (k % 23 === 11) grazer(out, grotto, s, pick(r), r, p0);
    }
  }

  // The GARDEN: roots, fish in the lake, mist off the falls, grazers
  // drinking at the channels.
  for (let k = Math.ceil(GARDEN.s0 / SLOT); k * SLOT + SLOT <= GARDEN.s1; k++) {
    const s = k * SLOT + SLOT / 2;
    const r = stream(SALT6.garden, seam.id, k);
    if (r() < 0.3) {
      out.roots.push({
        t: seam,
        s: s + (r() - 0.5) * SLOT,
        lat: (r() * 2 - 1) * (HALF - 0.6),
        len: 0.5 + r() * 0.9,
        width: 0.07 + r() * 0.07,
        shade: r(),
        band: band(r(), 0.2, 0.4),
      });
    }
    const lakeSide = s > LAKE.s0 - 6 && s < LAKE.s1 + 6;
    if (k % 31 === 17 && !lakeSide) grazer(out, seam, s, pick(r), r, p0);
  }
  for (const w of out.waterfalls) {
    const r = stream(SALT6.garden, w.t.id, 9000 + Math.round(w.s));
    for (let i = 0; i < 8; i++) {
      boreXZ(w.t, w.s + (r() - 0.5) * 2 * w.hw, w.side * (HALF - 2.4), p0);
      out.motes.push({
        x: p0.x,
        y: BORE_FLOOR_Y + 1.3 + r() * 1.2,
        z: p0.z,
        kind: "mist",
        amp: 1.1,
        phase: r() * Math.PI * 2,
        band: i < 4 ? 0 : 1,
      });
    }
  }
  for (let i = 0; i < 26; i++) {
    const r = stream(SALT6.fish, seam.id, i);
    const a = 3 + r() * 6;
    const bb = 1.5 + r() * 3.5;
    const s = LAKE.s0 + 2 + a + r() * (LAKE.s1 - LAKE.s0 - 4 - 2 * a);
    const lat = (r() * 2 - 1) * (HALF - 2 - bb);
    boreXZ(seam, s, lat, p0);
    out.fish.push({
      x: p0.x,
      y: BORE_FLOOR_Y + LAKE.rise + 0.04,
      z: p0.z,
      ux: Math.cos(p0.th),
      uz: Math.sin(p0.th),
      a,
      b: bb,
      speed: (0.25 + r() * 0.3) * pick(r),
      phase: r() * Math.PI * 2,
      jump: r(),
      hue: r(),
      band: band(r(), 0.5, 0.3),
    });
  }

  // The STATION: passengers waiting at the platform's edge.
  const st = TUNNELS[STATION.tunnel] as Tunnel;
  for (let i = 0; i < 16; i++) {
    const r = stream(SALT6.people, st.id, 7000 + i);
    const s = STATION.s0 + 30 + r() * (STATION.s1 - STATION.s0 - 60);
    const lat = STATION.edge - 1.1 - r() * 0.8;
    boreXZ(st, s, STATION.side * lat, p0);
    out.passengers.push({
      x: p0.x,
      y: BORE_FLOOR_Y + STATION.platformH,
      z: p0.z,
      ux: Math.cos(p0.th),
      uz: Math.sin(p0.th),
      length: 0.6 + r() * 0.6,
      speed: 0.08 + r() * 0.1,
      phase: r(),
      height: 1.5 + r() * 0.35,
      shade: r(),
      band: band(r(), 0.5, 0.3),
    });
  }
}

/** A deer or a fox at a wall's foot at `s`, grazing a few metres along it. */
function grazer(
  out: UndergroundLayout,
  t: Tunnel,
  s: number,
  side: 1 | -1,
  r: () => number,
  p0: { x: number; z: number; th: number },
): void {
  const deer = r() < 0.55;
  boreXZ(t, s, side * (HALF - 0.75), p0);
  out.grazers.push({
    x: p0.x,
    y: BORE_FLOOR_Y,
    z: p0.z,
    ux: Math.cos(p0.th),
    uz: Math.sin(p0.th),
    length: 1.5 + r() * 2.5,
    speed: 0.15 + r() * 0.15,
    phase: r(),
    kind: deer ? "deer" : "fox",
    band: 0,
  });
}

/** The tallest bird bob and wing reach over its loop height, m (the shader
 * mirrors this bound). */
export const BIRD_BOB = 0.6;

/** A bird's position at time `sec` (the shader's motion, mirrored). */
export function birdAt(
  b: Bird,
  sec: number,
  out: { x: number; y: number; z: number },
): { x: number; y: number; z: number } {
  const th = b.phase + b.speed * sec;
  const ca = Math.cos(th) * b.a;
  const sb = Math.sin(th) * b.b;
  // Across = (-uz, ux): the bore's left.
  out.x = b.x + b.ux * ca - b.uz * sb;
  out.z = b.z + b.uz * ca + b.ux * sb;
  out.y = b.y + Math.sin(th * 3 + b.phase) * BIRD_BOB;
  return out;
}

// --- The metro ---------------------------------------------------------------

export const METRO_CARS = 3;
/** One metro cycle, s: arrive, dwell, depart, gone. */
export const METRO_CYCLE = 60;
const ARRIVE = 12;
const DWELL = 24;
const DEPART = 12;
/** How far beyond the hall a train starts and ends, m: past the end walls
 * by more than its own length, so it is never seen popping. */
const METRO_RUN = (METRO_CARS - 1) * CAR_PITCH + TRAIN_CAR_LENGTH + 12;
/** Where the lead car's centre stops (the train centred on the hall). */
const METRO_STOP =
  (STATION.s0 + STATION.s1) / 2 + ((METRO_CARS - 1) * CAR_PITCH) / 2;

/** The metro at server time `ms`: the lead car's arc length (null while the
 * platform is empty) and how far its doors are open, 0..1. */
export function metroState(
  ms: number,
  out: { s: number | null; doors: number },
): { s: number | null; doors: number } {
  const c = (((ms / 1000) % METRO_CYCLE) + METRO_CYCLE) % METRO_CYCLE;
  const from = STATION.s0 - METRO_RUN + (METRO_CARS - 1) * CAR_PITCH;
  const d = METRO_STOP - from;
  out.doors = 0;
  if (c < ARRIVE) {
    // Uniform deceleration to a stand at the stop.
    const u = c / ARRIVE;
    out.s = from + d * (2 * u - u * u);
  } else if (c < ARRIVE + DWELL) {
    out.s = METRO_STOP;
    const w = c - ARRIVE;
    out.doors = Math.max(0, Math.min(1, w - 1, DWELL - 1.5 - w));
  } else if (c < ARRIVE + DWELL + DEPART) {
    const u = (c - ARRIVE - DWELL) / DEPART;
    out.s = METRO_STOP + (STATION.s1 + METRO_RUN - METRO_STOP) * u * u;
  } else {
    out.s = null;
  }
  return out;
}

/** The metro's whole track, arc length (for the tests and the hide rule). */
export const METRO_TRACK: readonly [number, number] = [
  STATION.s0 - METRO_RUN,
  STATION.s1 + METRO_RUN,
];

const carPt = { x: 0, z: 0, th: 0 };

/**
 * Car `i` (0 leads) of the metro whose lead is at arc length `lead`, as a
 * T2 car box (local +x along travel, +s). Returns false when the car is
 * wholly beyond either end wall, in the rock, so the renderer hides it.
 */
export function metroCarBox(lead: number, i: number, out: MoverBox): boolean {
  const s = lead - i * CAR_PITCH;
  const t = TUNNELS[STATION.tunnel] as Tunnel;
  boreXZ(t, s, STATION.side * STATION.track, carPt);
  out.x = carPt.x;
  out.y = BORE_FLOOR_Y + TRAIN_CAR_LIFT + TRAIN_CAR_HEIGHT / 2;
  out.z = carPt.z;
  out.hx = TRAIN_CAR_LENGTH / 2;
  out.hy = TRAIN_CAR_HEIGHT / 2;
  out.hz = TRAIN_CAR_WIDTH / 2;
  out.yaw = -carPt.th;
  const h = TRAIN_CAR_LENGTH / 2;
  return s + h > STATION.s0 && s - h < STATION.s1;
}
