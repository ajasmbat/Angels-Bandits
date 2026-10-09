// FL1 Flight Lab test routes — the pure seam. Five marked routes through the
// real city, each built once from the same shared data the crash check
// reads, so every ring sits in air that is actually clear:
//   - ring slalom: the city's own Canyon Run stunt course (S3 generation
//     already proves every leg clear of buildings, trees and movers);
//   - building hole: three rings straight through one H2 gate (or the
//     biggest hole there is) — H1/H2 guarantee clear run-out past each mouth;
//   - tunnel run: rings down the guide line of a U4 bore, portal to portal;
//   - vertical loop gate: an entry ring, a wide ring at the top of the loop
//     and an exit ring, high over the middle of the map;
//   - target drone: no rings — a slow drone on a circle, for the aim test.
// The rings are ordinary Courses: the lab draws them with its own
// CourseRings and times them with its own CourseRunner, client-side only —
// a lab run never reaches the server's course board.

import {
  type Building,
  type HoleSpan,
  cityHoles,
} from "@angels-bandits/common/city";
import {
  BORE_HEIGHT,
  TUNNELS,
  type Tunnel,
  guideSlope,
  guideY,
  tunnelPointInto,
} from "@angels-bandits/common/city/tunnels";
import { WORLD_SIZE } from "@angels-bandits/common/constants";
import type { Course, Ring } from "@angels-bandits/common/courses";
import {
  type Vec3,
  canonicalize,
  wrapDelta,
} from "@angels-bandits/common/world";

export type LabRouteId = "slalom" | "hole" | "tunnel" | "loop" | "drone";

export interface LabRoute {
  id: LabRouteId;
  name: string;
  /** Where R (and picking the route) puts the plane, and its heading. */
  start: Vec3;
  yaw: number;
  pitch: number;
  /** The route's rings as a Course (null: the drone, which has none). */
  course: Course | null;
}

/** The drone's orbit: centre, radius, altitude and airspeed. Above every
 * rooftop (≤ 250 m) and the boss's 305 m cruise, under the news heli. */
export const DRONE_CENTER: Readonly<Vec3> = { x: 1000, y: 330, z: 1450 };
export const DRONE_RADIUS = 170;
export const DRONE_SPEED = 22;

const NO_MEDALS = { gold: 0, silver: 0, bronze: 0 } as const;
/** The tunnel run starts this far out along the bore's line before its
 * plaza lip, m, this high over the lawn. */
const TUNNEL_RUN_IN = 90;
const TUNNEL_START_Y = 30;

/** Unit vector of (x, y, z). */
function unit(x: number, y: number, z: number): Vec3 {
  const l = Math.hypot(x, y, z) || 1;
  return { x: x / l, y: y / l, z: z / l };
}

/** A Course from rings (lengths are straight-line, medals unused). */
function courseOf(
  id: number,
  name: string,
  theme: Course["theme"],
  rings: Ring[],
): Course {
  let span = 0;
  for (let i = 1; i < rings.length; i++) {
    const a = (rings[i - 1] as Ring).pos;
    const b = (rings[i] as Ring).pos;
    const d = wrapDelta(a, b);
    span += Math.hypot(d.x, d.y, d.z);
  }
  return { id, theme, name, rings, length: span, span, medals: NO_MEDALS };
}

/** The attitude flying along unit `n`. */
const yawOf = (n: Vec3): number => Math.atan2(-n.x, -n.z);
const pitchOf = (n: Vec3): number => Math.asin(Math.max(-1, Math.min(1, n.y)));

/** `back` meters behind `ring` along its normal — a start or checkpoint. */
export function behind(ring: Ring, back: number): Vec3 {
  return canonicalize({
    x: ring.pos.x - ring.n.x * back,
    y: ring.pos.y - ring.n.y * back,
    z: ring.pos.z - ring.n.z * back,
  });
}

/** A route that starts `back` meters before its first ring. */
function ringRoute(
  id: LabRouteId,
  name: string,
  course: Course,
  back: number,
): LabRoute {
  const first = course.rings[0] as Ring;
  return {
    id,
    name,
    start: behind(first, back),
    yaw: yawOf(first.n),
    pitch: pitchOf(first.n),
    course,
  };
}

/** The hole to thread: the gate nearest the map's middle (gates are the
 * big 30 × 26 m openings through tall towers), else the widest hole. */
export function pickHole(spans: readonly HoleSpan[]): HoleSpan | null {
  const mid = WORLD_SIZE / 2;
  const score = (s: HoleSpan): number =>
    (s.hole.kind === "gate" ? 0 : 1e6 - s.hole.width * 1e3) +
    Math.hypot(s.center.x - mid, s.center.z - mid);
  let best: HoleSpan | null = null;
  for (const s of spans) {
    if (s.hole.kind === "bridge") continue;
    if (!best || score(s) < score(best)) best = s;
  }
  return best;
}

/** Three rings through `span`: 60 m before the entry mouth, the middle,
 * 40 m past the exit — all inside the clear run-out H1 guarantees. */
function holeRings(span: HoleSpan): Ring[] {
  const n: Vec3 =
    span.hole.axis === "x" ? { x: 1, y: 0, z: 0 } : { x: 0, y: 0, z: 1 };
  const r = Math.min(span.hole.width, span.hole.height) / 2 - 1.5;
  const at = (along: number): Ring => ({
    pos: canonicalize({
      x: span.center.x + n.x * along,
      y: span.center.y,
      z: span.center.z + n.z * along,
    }),
    n,
    r,
  });
  const half = span.length / 2;
  return [at(-half - 60), at(0), at(half + 40)];
}

/** Rings down a bore's guide line, end A to end B. */
function tunnelRings(t: Tunnel): Ring[] {
  const pt = { x: 0, z: 0, th: 0 };
  const rings: Ring[] = [];
  const count = 8;
  const s0 = 20;
  const s1 = t.length - 20;
  for (let i = 0; i < count; i++) {
    const s = s0 + ((s1 - s0) * i) / (count - 1);
    tunnelPointInto(t, s, pt);
    rings.push({
      pos: canonicalize({ x: pt.x, y: guideY(t, s), z: pt.z }),
      n: unit(Math.cos(pt.th), guideSlope(t, s), Math.sin(pt.th)),
      r: BORE_HEIGHT / 2 - 4,
    });
  }
  return rings;
}

/** The loop gate over the middle of the map, flown north: an entry ring,
 * a wide ring at the top of a full-throttle loop (flown inverted, back the
 * other way) and the exit ring. The top ring is wide because the loop's
 * size is whatever the pilot's tuning makes it. */
function loopRings(): Ring[] {
  const x = WORLD_SIZE / 2;
  const z = WORLD_SIZE / 2;
  const y = 390;
  const north: Vec3 = { x: 0, y: 0, z: -1 };
  return [
    { pos: { x, y, z: z + 60 }, n: north, r: 18 },
    { pos: { x, y: y + 180, z }, n: { x: 0, y: 0, z: 1 }, r: 55 },
    { pos: { x, y, z: z - 90 }, n: north, r: 22 },
  ];
}

/** Every lab route for this city. `courses` is the city's own S3 set. */
export function buildLabRoutes(
  buildings: readonly Building[],
  courses: readonly Course[],
): LabRoute[] {
  const routes: LabRoute[] = [];
  let id = 0;
  const canyon = courses.find((c) => c.theme === "canyon") ?? courses[0];
  if (canyon) {
    const course = courseOf(id++, "Ring slalom", canyon.theme, [
      ...canyon.rings,
    ]);
    routes.push(ringRoute("slalom", "Ring slalom", course, 120));
  }
  const hole = pickHole(cityHoles(buildings));
  if (hole) {
    const course = courseOf(id++, "Building hole", "holes", holeRings(hole));
    routes.push(ringRoute("hole", "Building hole", course, 120));
  }
  const bore = TUNNELS[0];
  if (bore) {
    const course = courseOf(id++, "Tunnel run", "viaduct", tunnelRings(bore));
    // The start is out over the portal's plaza lawn, on the bore's own line
    // (its first leg's straight extension), high enough to clear the trees.
    const pt = tunnelPointInto(bore, -TUNNEL_RUN_IN, { x: 0, z: 0, th: 0 });
    routes.push({
      id: "tunnel",
      name: "Tunnel run",
      start: canonicalize({ x: pt.x, y: TUNNEL_START_Y, z: pt.z }),
      yaw: yawOf(unit(Math.cos(pt.th), 0, Math.sin(pt.th))),
      pitch: 0,
      course,
    });
  }
  routes.push(
    ringRoute(
      "loop",
      "Loop gate",
      courseOf(id++, "Loop gate", "spiral", loopRings()),
      220,
    ),
  );
  routes.push({
    id: "drone",
    name: "Target drone",
    start: {
      x: DRONE_CENTER.x,
      y: DRONE_CENTER.y + 20,
      z: DRONE_CENTER.z + DRONE_RADIUS + 380,
    },
    yaw: 0,
    pitch: 0,
    course: null,
  });
  return routes;
}

/** The drone's position at `ms` (any clock), into `out`. */
export function dronePositionInto(ms: number, out: Vec3): Vec3 {
  const a = ((ms / 1000) * DRONE_SPEED) / DRONE_RADIUS;
  out.x = DRONE_CENTER.x + Math.cos(a) * DRONE_RADIUS;
  out.y = DRONE_CENTER.y + Math.sin(a * 2.3) * 25;
  out.z = DRONE_CENTER.z + Math.sin(a) * DRONE_RADIUS;
  return out;
}

/** The attitude flying along a ring — a checkpoint respawn's. */
export function ringAttitude(ring: Ring): { yaw: number; pitch: number } {
  return { yaw: yawOf(ring.n), pitch: pitchOf(ring.n) };
}
