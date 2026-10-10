// FL1 Flight Lab — the controller main.ts drives while it sits in a lab
// room (the server's solo room: no enemy waves, no carrier, no chaos unless
// toggled, validation against this room's own tuning). It owns the panel and the
// telemetry strip, the five test routes (their rings, their client-side
// timing, the checkpoints a crash respawns at) and the target drone, and it
// keeps the room's server-side copy of the tuning current. main.ts keeps
// the flight itself: it asks holdsStick() (fly the autopilot while the
// pointer is on the panel) and hands crashes here instead of to the server.

import {
  BULLET_RANGE,
  EMISSIVE_HAZARD,
} from "@angels-bandits/common/constants";
import {
  type Course,
  CourseRunner,
  type Ring,
} from "@angels-bandits/common/courses";
import { type FlightState, flightForward } from "@angels-bandits/common/flight";
import { type FlightTuning, exportTuning } from "@angels-bandits/common/tuning";
import { type Vec3, wrapDelta } from "@angels-bandits/common/world";
import * as THREE from "three";
import { emissiveBoost } from "../render/emissive";
import { CourseRings } from "../render/rings";
import { nearestImage } from "../render/wrapPlacement";
import { readStored, writeStored } from "../ui/storage";
import { FlightMeter } from "./meter";
import { LabPanel } from "./panel";
import {
  type LabRoute,
  type LabRouteId,
  behind,
  dronePositionInto,
  ringAttitude,
} from "./routes";
import { TelemetryStrip } from "./telemetry-strip";

/** Best route times, ms, by route id. */
const LAB_BEST_KEY = "ab-lab-best";
/** A checkpoint respawn sits this far before the ring it was earned at, m. */
const CHECKPOINT_BACK = 30;
/** The aim test: within this of the drone counts as on target (rad, ~2.5°)
 * inside gun range… */
const AIM_CONE = Math.cos((2.5 * Math.PI) / 180);
const AIM_RANGE = BULLET_RANGE * 1.2;
/** …and this much time on target finishes the drone route, ms. */
const AIM_GOAL_MS = 5000;
/** Lab tuning reaches the server at most this often, ms (trailing edge, so
 * a drag's last value always lands). */
const SYNC_MS = 150;

/** What the lab needs from main.ts. */
export interface LabDeps {
  scene: THREE.Scene;
  /** The client's live tuning (the panel writes it in place). */
  tuning: FlightTuning;
  routes: readonly LabRoute[];
  /** Put the plane at `pos` flying along (yaw, pitch), fresh. */
  teleport(pos: Vec3, yaw: number, pitch: number): void;
  /** The tuning changed: re-read anything derived from it (feel, assist). */
  onTuning(): void;
  sendLab(msg: { tuning?: unknown; chaos?: boolean; waves?: boolean }): void;
}

interface Checkpoint {
  pos: Vec3;
  yaw: number;
  pitch: number;
}

export class FlightLab {
  readonly panel: LabPanel;
  private readonly strip = new TelemetryStrip();
  private readonly meter = new FlightMeter();
  private readonly courses: Course[];
  private readonly courseRoute: LabRoute[];
  private readonly runner: CourseRunner;
  private readonly rings: CourseRings;
  private readonly drone: THREE.Mesh;
  private readonly dronePos: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly best: Partial<Record<LabRouteId, number>>;
  private route: LabRoute | null = null;
  private checkpoint: Checkpoint | null = null;
  private crashes = 0;
  /** Last finished time on the current route, ms (shown between runs). */
  private lastMs: number | null = null;
  private readonly prev: Vec3 = { x: 0, y: 0, z: 0 };
  private prevMs = -1;
  /** The aim test: when it started and how long the pipper has been on. */
  private aimStart = -1;
  private aimOn = 0;
  private syncTimer: ReturnType<typeof setTimeout> | null = null;
  private syncAt = 0;

  constructor(private readonly deps: LabDeps) {
    this.courseRoute = deps.routes.filter((r) => r.course !== null);
    this.courses = this.courseRoute.map((r) => r.course as Course);
    this.runner = new CourseRunner(this.courses);
    this.rings = new CourseRings(this.courses);
    this.rings.mesh.name = "lab-rings";
    deps.scene.add(this.rings.mesh);
    const color = new THREE.Color(0xff3b5c);
    color.multiplyScalar(emissiveBoost(color, EMISSIVE_HAZARD));
    this.drone = new THREE.Mesh(
      new THREE.OctahedronGeometry(3.2, 0),
      new THREE.MeshBasicMaterial({ color }),
    );
    this.drone.name = "lab-drone";
    deps.scene.add(this.drone);
    this.best = loadBest();
    this.panel = new LabPanel(
      deps.tuning,
      {
        onChange: () => this.tuningChanged(),
        onRoute: (id) => this.pickRoute(id as LabRouteId),
        onToggle: (name, on) => {
          // W1: the carrier and its enemy waves, or the chaos.
          if (name === "waves") deps.sendLab({ waves: on });
          else deps.sendLab({ chaos: on });
        },
        onRespawn: () => this.respawnAtStart(),
      },
      deps.routes,
    );
    // The panel loaded the stored / shared tuning into the live object.
    deps.onTuning();
  }

  /** QA (window.__ab.lab): what the lab is doing. */
  debug(): {
    route: LabRouteId | null;
    running: boolean;
    next: number;
    crashes: number;
    checkpoint: Vec3 | null;
    panelOpen: boolean;
    aimOnMs: number;
  } {
    return {
      route: this.route?.id ?? null,
      running: this.runner.active,
      next: this.runner.next,
      crashes: this.crashes,
      checkpoint: this.checkpoint?.pos ?? null,
      panelOpen: this.panel.isOpen,
      aimOnMs: this.aimOn,
    };
  }

  /** Fly the autopilot this frame: the pointer is on the panel. */
  holdsStick(): boolean {
    return this.panel.pointerOver();
  }

  /** Send the room the whole tuning now (every lab welcome: the server's
   * copy starts at the defaults). */
  syncNow(): void {
    if (this.syncTimer !== null) clearTimeout(this.syncTimer);
    this.syncTimer = null;
    this.syncAt = performance.now();
    this.deps.sendLab({ tuning: JSON.parse(exportTuning(this.deps.tuning)) });
  }

  private tuningChanged(): void {
    this.deps.onTuning();
    const wait = this.syncAt + SYNC_MS - performance.now();
    if (wait <= 0) this.syncNow();
    else if (this.syncTimer === null) {
      this.syncTimer = setTimeout(() => this.syncNow(), wait);
    }
  }

  /** Fly a route: back to its start, its clock cleared. */
  pickRoute(id: LabRouteId): void {
    const route = this.deps.routes.find((r) => r.id === id);
    if (!route) return;
    this.route = route;
    this.lastMs = null;
    this.runner.abort();
    this.respawnAtStart();
  }

  /** R: back to the current route's start (or just a fresh plane where it
   * is, with no route picked). */
  respawnAtStart(): void {
    const r = this.route;
    this.runner.abort();
    if (r) {
      this.checkpoint = { pos: r.start, yaw: r.yaw, pitch: r.pitch };
      this.aimStart = r.id === "drone" ? -2 : -1; // -2: arm on the next frame
      this.aimOn = 0;
      this.teleport(this.checkpoint);
    }
  }

  /** A crash: no death in the lab — straight back to the last checkpoint
   * (the route's start before its first ring). */
  crash(flight: FlightState): void {
    this.crashes++;
    this.teleport(
      this.checkpoint ?? {
        pos: {
          x: flight.pos.x,
          y: Math.max(flight.pos.y, 0) + 80,
          z: flight.pos.z,
        },
        yaw: flight.yaw,
        pitch: 0,
      },
    );
  }

  private teleport(c: Checkpoint): void {
    this.deps.teleport(c.pos, c.yaw, c.pitch);
    this.prevMs = -1;
    this.meter.reset();
  }

  /** One frame, after the flight step (alive only for the timing). */
  frame(
    flight: FlightState,
    alive: boolean,
    dt: number,
    nowMs: number,
    view: Vec3,
  ): void {
    if (alive) {
      this.meter.step(flight, dt);
      this.stepRuns(flight, nowMs);
    } else {
      this.prevMs = -1;
    }
    this.stepDrone(flight, alive, dt, nowMs, view);
    this.rings.setRun(this.runner.course, this.runner.next);
    this.rings.update(view, nowMs);
    const r = this.route;
    let routeMs: number | null = this.lastMs;
    if (r?.id === "drone" && this.aimStart >= 0)
      routeMs = nowMs - this.aimStart;
    else if (this.runner.active) routeMs = nowMs - this.runner.startMs;
    this.strip.update({
      speed: this.meter.speed,
      turnRadius: this.meter.turnRadius,
      rollRate: this.meter.rollRate,
      pitchRate: this.meter.pitchRate,
      g: this.meter.g,
      routeName: r?.name ?? null,
      routeMs,
      bestMs: r ? (this.best[r.id] ?? null) : null,
      crashes: this.crashes,
      aimPct:
        r?.id === "drone" && this.aimStart >= 0
          ? (100 * this.aimOn) / Math.max(1, nowMs - this.aimStart)
          : null,
    });
  }

  private stepRuns(flight: FlightState, nowMs: number): void {
    if (this.prevMs >= 0) {
      const step = this.runner.step(this.prev, flight.pos, this.prevMs, nowMs);
      const route = this.courseRoute[this.runner.subject];
      if (step === "start" && route) {
        // Passing any route's first ring flies that route.
        if (this.route !== route) this.lastMs = null;
        this.route = route;
        this.checkpoint = {
          pos: route.start,
          yaw: route.yaw,
          pitch: route.pitch,
        };
      } else if (step === "ring" && route) {
        const ring = route.course?.rings[this.runner.ring] as Ring;
        const a = ringAttitude(ring);
        this.checkpoint = {
          pos: behind(ring, CHECKPOINT_BACK),
          yaw: a.yaw,
          pitch: a.pitch,
        };
      } else if (step === "finish" && route) {
        this.finish(route.id, this.runner.timeMs);
        this.checkpoint = {
          pos: route.start,
          yaw: route.yaw,
          pitch: route.pitch,
        };
      }
    }
    this.prev.x = flight.pos.x;
    this.prev.y = flight.pos.y;
    this.prev.z = flight.pos.z;
    this.prevMs = nowMs;
  }

  private finish(id: LabRouteId, ms: number): void {
    this.lastMs = ms;
    const old = this.best[id];
    if (old === undefined || ms < old) {
      this.best[id] = ms;
      writeStored(LAB_BEST_KEY, JSON.stringify(this.best));
    }
  }

  private stepDrone(
    flight: FlightState,
    alive: boolean,
    dt: number,
    nowMs: number,
    view: Vec3,
  ): void {
    const p = dronePositionInto(nowMs, this.dronePos);
    const img = nearestImage(view, p);
    this.drone.position.set(img.x, img.y, img.z);
    this.drone.rotation.y += dt * 2;
    if (this.route?.id !== "drone" || !alive) return;
    if (this.aimStart === -2) {
      this.aimStart = nowMs;
      return;
    }
    if (this.aimStart < 0) return;
    const d = wrapDelta(flight.pos, p);
    const dist = Math.hypot(d.x, d.y, d.z);
    const f = flightForward(flight);
    if (
      dist > 0 &&
      dist < AIM_RANGE &&
      (d.x * f.x + d.y * f.y + d.z * f.z) / dist > AIM_CONE
    ) {
      this.aimOn += dt * 1000;
      if (this.aimOn >= AIM_GOAL_MS) {
        this.finish("drone", nowMs - this.aimStart);
        this.aimStart = -1;
      }
    }
  }
}

function loadBest(): Partial<Record<LabRouteId, number>> {
  try {
    const raw = readStored(LAB_BEST_KEY);
    const o = raw ? (JSON.parse(raw) as unknown) : null;
    if (!o || typeof o !== "object") return {};
    const out: Partial<Record<LabRouteId, number>> = {};
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === "number" && Number.isFinite(v) && v > 0) {
        out[k as LabRouteId] = v;
      }
    }
    return out;
  } catch {
    return {};
  }
}
