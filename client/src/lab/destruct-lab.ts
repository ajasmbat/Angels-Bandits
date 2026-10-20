// DL1 Destruction Lab — the controller main.ts drives while it sits in a
// Destruction Lab room (the server's solo lab room with `destruct`: no
// waves, no carrier, no director or rebuilds, destruction live with chaos
// off). It is a mode of the real game, never a fork: the triggers go to the
// room's server through the real pipeline (server/src/destruct-lab.ts), the
// debris comes back as ordinary collapse wires built by the shared model,
// and the renderers are the game's own — the lab only feeds them its look
// (render/destruct-look.ts) and its clock.
//
// It owns the panel and the telemetry strip, the free orbit / fly camera
// (main.ts renders through it — the QA-camera seam), the arena (a real block
// of the seed city, or any tower with "drop into city"), the target and aim
// point, the lab clock (pause, slow motion, scrub, frame step), the
// time-lapse sheet, and keeping the room's copy of the tuning current.
// main.ts parks the plane on the camera (so the city streams around the
// view) and keeps it out of sight and out of trouble.

import type { Building } from "@angels-bandits/common/city";
import type {
  Collapse,
  CollapseField,
} from "@angels-bandits/common/city/collapse";
import {
  raycastChunk,
  tierGrids,
} from "@angels-bandits/common/city/destruction";
import { PIECE_MOVING } from "@angels-bandits/common/city/physpose";
import { BLOCK_PITCH } from "@angels-bandits/common/constants";
import {
  type LabTrigger,
  type LabTriggerKind,
  TRIGGER_NEEDS,
} from "@angels-bandits/common/destruct-lab";
import {
  type DestructionTuning,
  exportDestructionTuning,
} from "@angels-bandits/common/destruction-tuning";
import type { LabStatsMsg } from "@angels-bandits/common/protocol";
import {
  type Vec3,
  canonicalize,
  wrapDeltaAxis,
} from "@angels-bandits/common/world";
import * as THREE from "three";
import { FacadeArchetype, archetypeFor } from "../render/archetypes";
import { setDestructLook } from "../render/destruct-look";
import { DestructPanel } from "./destruct-panel";
import { DestructTelemetryStrip } from "./destruct-telemetry";
import { LabClock } from "./lab-clock";

/** Lab tuning reaches the server at most this often, ms (trailing edge). */
const SYNC_MS = 150;
/** The time-lapse sheet's moments, ms from the collapse event (D11's
 * collapse-timelapse tool's), and the frame `before` it. */
export const LAPSE_TIMES_MS = [-600, 1500, 3000, 4500, 6500, 9000, 14000];
/** A tile of the sheet, px. */
const LAPSE_TILE_W = 640;
/** The orbit camera's limits. */
const PITCH_MIN = -0.12;
const PITCH_MAX = 1.45;
const DIST_MIN = 15;
const DIST_MAX = 1400;
/** A pointer that moved less than this is a click (a pick), px. */
const CLICK_PX = 5;

/** One arena: a real block of the seed city with 3–5 towers. */
export interface Arena {
  name: string;
  hint: string;
  /** Building indices of its towers, tallest first. */
  towers: number[];
  /** Its middle, canonical, and how far it reaches, m. */
  centre: Vec3;
  reach: number;
}

/** What the lab needs from main.ts. */
export interface DestructLabDeps {
  canvas: HTMLElement;
  camera: THREE.PerspectiveCamera;
  /** The city as it stands (the client's damage applied). */
  buildings: readonly Building[];
  field: CollapseField;
  sendLab(msg: {
    destruct?: unknown;
    trigger?: unknown;
    reset?: boolean;
  }): void;
}

/** The towers (≥ 40 m) of every block, keyed by block. */
function blocksOf(buildings: readonly Building[]): Map<string, number[]> {
  const out = new Map<string, number[]>();
  buildings.forEach((b, i) => {
    if (b.height < 40) return;
    const key = `${Math.floor(b.x / BLOCK_PITCH)},${Math.floor(b.z / BLOCK_PITCH)}`;
    const list = out.get(key);
    if (list) list.push(i);
    else out.set(key, [i]);
  });
  return out;
}

function arenaOf(
  buildings: readonly Building[],
  towers: number[],
  name: string,
  hint: string,
): Arena {
  const sorted = [...towers].sort(
    (a, b) => (buildings[b]?.height ?? 0) - (buildings[a]?.height ?? 0),
  );
  const first = buildings[sorted[0] as number] as Building;
  let sx = 0;
  let sz = 0;
  for (const i of sorted) {
    const b = buildings[i] as Building;
    sx += wrapDeltaAxis(first.x, b.x);
    sz += wrapDeltaAxis(first.z, b.z);
  }
  const centre = canonicalize({
    x: first.x + sx / sorted.length,
    y: 0,
    z: first.z + sz / sorted.length,
  });
  let reach = 0;
  for (const i of sorted) {
    const b = buildings[i] as Building;
    reach = Math.max(
      reach,
      Math.hypot(wrapDeltaAxis(centre.x, b.x), wrapDeltaAxis(centre.z, b.z)) +
        Math.max(b.width, b.depth) / 2,
    );
  }
  return { name, hint, towers: sorted, centre, reach };
}

/**
 * The lab's arenas: real blocks of the seed city with 3–5 towers — the one
 * most masonry, the one most glass, and the one holding the tallest tower.
 * Pure in the city.
 */
export function findArenas(buildings: readonly Building[]): Arena[] {
  const candidates = [...blocksOf(buildings).values()].filter(
    (t) => t.length >= 3 && t.length <= 5,
  );
  if (candidates.length === 0) return [];
  const share = (t: number[], kind: FacadeArchetype) =>
    t.filter((i) => archetypeFor(buildings[i] as Building) === kind).length /
    t.length;
  const tallest = (t: number[]) =>
    Math.max(...t.map((i) => buildings[i]?.height ?? 0));
  const pick = (score: (t: number[]) => number) =>
    candidates.reduce((best, t) => (score(t) > score(best) ? t : best));
  const masonry = pick(
    (t) => share(t, FacadeArchetype.MASONRY) * 1000 + tallest(t) / 10,
  );
  const glass = pick(
    (t) => share(t, FacadeArchetype.GLASS) * 1000 + tallest(t) / 10,
  );
  const supertall = pick(tallest);
  return [
    arenaOf(
      buildings,
      masonry,
      "Masonry block",
      "Brick and stone towers (L3 / L11).",
    ),
    arenaOf(
      buildings,
      glass,
      "Glass towers",
      "Curtain-wall towers: glass showers, peeling sheets.",
    ),
    arenaOf(
      buildings,
      supertall,
      "Supertall core",
      "The H1 core's tallest tower and its neighbours.",
    ),
  ];
}

export class DestructLab {
  readonly panel: DestructPanel;
  readonly tuning: DestructionTuning;
  readonly clock = new LabClock();
  readonly arenas: Arena[];
  private readonly strip = new DestructTelemetryStrip();
  private arena = 0;
  private dropIn = false;
  private target = -1;
  /** The aim point (canonical) on the target, from the last pick. */
  private aim: Vec3 | null = null;
  /** The orbit camera: what it looks at (canonical), and from where. */
  private readonly focus: Vec3 = { x: 0, y: 0, z: 0 };
  private yaw = 0.7;
  private pitch = 0.35;
  private dist = 300;
  private readonly view = {
    eye: { x: 0, y: 0, z: 0 } as Vec3,
    at: { x: 0, y: 0, z: 0 } as Vec3,
  };
  private readonly keys = new Set<string>();
  private drag: { x: number; y: number; moved: boolean; pan: boolean } | null =
    null;
  private syncTimer: ReturnType<typeof setTimeout> | null = null;
  private syncAt = 0;
  private stats: LabStatsMsg | null = null;
  private fps = 60;
  private frameMs = 16.7;
  private draws = 0;
  private lapse: {
    times: number[];
    t0: number;
    shots: { label: string; url: string }[];
    waitFor: number | null;
    settle: number;
  } | null = null;
  /** The last time-lapse sheet, a PNG data URL (QA / the export). */
  lastSheet: string | null = null;

  constructor(private readonly deps: DestructLabDeps) {
    this.arenas = findArenas(deps.buildings);
    this.tuning = {} as DestructionTuning;
    this.panel = new DestructPanel(
      this.tuning,
      {
        onChange: () => this.tuningChanged(),
        onArena: (i) => this.pickArena(i),
        onResetArena: () => this.resetArena(),
        onDropIntoCity: (on) => this.dropIntoCity(on),
        onTrigger: (k) => this.fire(k),
        onPause: () => this.clock.togglePause(),
        onSpeed: (v) => this.clock.setSpeed(v),
        onScrub: (u) => this.scrubTo(u),
        onStep: (n) => this.clock.step(n, this.liveMs),
        onLive: () => this.clock.goLive(),
        onTimelapse: () => this.timelapse(),
      },
      this.arenas,
    );
    setDestructLook(this.tuning);
    document.body.classList.add("dlab");
    this.pickArena(0);
    this.bindInput();
  }

  /** The live render clock main.ts last handed in. */
  private liveMs: number | null = null;
  /** When the last trigger went (live server ms). */
  private firedAt = Number.NEGATIVE_INFINITY;

  /** QA (window.__ab.destructLab): what the lab is doing. */
  debug(): {
    arena: string | null;
    dropIn: boolean;
    target: number;
    aim: Vec3 | null;
    viewMs: number | null;
    live: boolean;
    paused: boolean;
    speed: number;
    collapses: number;
    stats: LabStatsMsg | null;
    lapse: boolean;
    /** The collapse the timeline replays: its event time and length. */
    focus: { t0: number; endMs: number; pieces: number } | null;
    tuning: DestructionTuning;
  } {
    const f = this.focusCollapse();
    return {
      arena: this.dropIn ? null : (this.arenas[this.arena]?.name ?? null),
      dropIn: this.dropIn,
      target: this.target,
      aim: this.aim,
      viewMs: this.clock.viewMs,
      live: this.clock.isLive,
      paused: this.clock.isPaused,
      speed: this.clock.speed,
      collapses: this.deps.field.list.length,
      stats: this.stats,
      lapse: this.lapse !== null,
      focus: f ? { t0: f.t0, endMs: f.endMs, pieces: f.n } : null,
      tuning: { ...this.tuning },
    };
  }

  /** The pointer is on the panel (main.ts keeps the game's mouse off). */
  holdsPointer(): boolean {
    return this.panel.pointerOver();
  }

  /** Send the room the whole tuning now (every welcome: the server's copy
   * starts at the defaults). */
  syncNow(): void {
    if (this.syncTimer !== null) clearTimeout(this.syncTimer);
    this.syncTimer = null;
    this.syncAt = performance.now();
    this.deps.sendLab({
      destruct: JSON.parse(exportDestructionTuning(this.tuning)),
    });
  }

  /** The server's telemetry arrived. */
  noteStats(msg: LabStatsMsg): void {
    this.stats = msg;
  }

  /** QA / the panel: set a trigger off at the current target. */
  fire(kind: LabTriggerKind): void {
    const b = this.target;
    const building = this.deps.buildings[b];
    if (!building) return;
    const need = TRIGGER_NEEDS[kind];
    const opts = this.panel.options;
    const t: LabTrigger = { k: kind, b };
    if (need.point) {
      t.p = this.aim ?? this.facePoint(building);
      t.o = canonicalize(this.view.eye);
    }
    if (need.dir) t.d = opts.dir;
    if (need.corner) t.c = opts.corner;
    if (need.floor) t.f = opts.floor;
    // Watching starts again from now (and the timeline follows this one).
    this.clock.goLive();
    this.firedAt = this.liveMs ?? Number.NEGATIVE_INFINITY;
    this.deps.sendLab({ trigger: t });
  }

  /** QA: aim at building `b` (and point `p` on it, canonical). */
  setTarget(b: number, p: Vec3 | null = null): void {
    const building = this.deps.buildings[b];
    if (!building) return;
    this.target = b;
    this.aim = p;
    const floors = tierGrids(building)[0]?.ny ?? 1;
    this.panel.setTarget(
      `Target: tower ${b} · ${Math.round(building.height)} m · ${floors} floor bands · ${archetypeName(building)}`,
      floors,
    );
  }

  /** QA: put the camera somewhere (canonical focus; angles rad). */
  setCamera(focus: Vec3, yaw: number, pitch: number, dist: number): void {
    const c = canonicalize(focus);
    this.focus.x = c.x;
    this.focus.y = Math.max(0, focus.y);
    this.focus.z = c.z;
    this.yaw = yaw;
    this.pitch = Math.min(PITCH_MAX, Math.max(PITCH_MIN, pitch));
    this.dist = Math.min(DIST_MAX, Math.max(DIST_MIN, dist));
  }

  pickArena(i: number): void {
    const a = this.arenas[i];
    if (!a) return;
    this.arena = i;
    this.dropIntoCity(false);
    this.setTarget(a.towers[0] as number);
    this.frameTower(a.towers[0] as number, a.reach);
    this.panel.setArena(i);
  }

  /** Bring the camera round to tower `b`: back far enough for the whole
   * tower (and `extra` m of where it can fall), from the lowest elevation
   * — of five, each round a ring of 16 directions — that sees at least four
   * of five points up its near face past every other building (a side
   * view reads a fall; its foot is often behind something); failing that,
   * the one that sees the most. */
  frameTower(b: number, extra = 0): void {
    const t = this.deps.buildings[b];
    if (!t) return;
    const dist = Math.min(
      DIST_MAX,
      Math.max(140, 0.95 * t.height + 0.3 * extra + 110),
    );
    const focusY = t.height * 0.45;
    let best = { yaw: this.yaw, pitch: 0.6, seen: -1 };
    const dir = { x: 0, y: 0, z: 0 };
    for (const pitch of [0.18, 0.3, 0.45, 0.62, 0.8]) {
      const cp = Math.cos(pitch);
      for (let k = 0; k < 16; k++) {
        const yaw = this.yaw + (k * Math.PI) / 8;
        const eye = canonicalize({
          x: t.x + dist * cp * Math.sin(yaw),
          y: focusY + dist * Math.sin(pitch),
          z: t.z + dist * cp * Math.cos(yaw),
        });
        let seen = 0;
        for (const share of [0.15, 0.35, 0.55, 0.75, 0.95]) {
          const dx = wrapDeltaAxis(eye.x, t.x);
          const dy = t.height * share - eye.y;
          const dz = wrapDeltaAxis(eye.z, t.z);
          const len = Math.hypot(dx, dy, dz);
          dir.x = dx / len;
          dir.y = dy / len;
          dir.z = dz / len;
          const hit = raycastChunk(this.deps.buildings, eye, dir, len);
          if (!hit || hit.building === b) seen++;
        }
        if (seen > best.seen) best = { yaw, pitch, seen };
        if (seen >= 4) break;
      }
      if (best.seen >= 4) break;
    }
    this.setCamera({ x: t.x, y: focusY, z: t.z }, best.yaw, best.pitch, dist);
  }

  /** "Drop into city": any tower anywhere is a target (off: the arena's). */
  dropIntoCity(on: boolean): void {
    this.dropIn = on;
    this.panel.setDropIntoCity(on);
    this.panel.setArena(on ? -1 : this.arena);
  }

  resetArena(): void {
    this.deps.sendLab({ reset: true });
    this.clock.goLive();
  }

  /** The camera main.ts renders through this frame (canonical eye and
   * look-at). Stepped by the fly keys. */
  cameraView(dt: number): { eye: Vec3; at: Vec3 } {
    // WASD / QE fly the focus, relative to where the camera faces.
    const speed = Math.max(20, this.dist * 0.9) * dt;
    let fx = 0;
    let fz = 0;
    let fy = 0;
    if (this.keys.has("KeyW")) fz -= 1;
    if (this.keys.has("KeyS")) fz += 1;
    if (this.keys.has("KeyA")) fx -= 1;
    if (this.keys.has("KeyD")) fx += 1;
    if (this.keys.has("KeyE")) fy += 1;
    if (this.keys.has("KeyQ")) fy -= 1;
    if (fx !== 0 || fz !== 0 || fy !== 0) {
      const s = Math.sin(this.yaw);
      const c = Math.cos(this.yaw);
      const p = canonicalize({
        x: this.focus.x + (fx * c + fz * s) * speed,
        y: 0,
        z: this.focus.z + (-fx * s + fz * c) * speed,
      });
      this.focus.x = p.x;
      this.focus.z = p.z;
      this.focus.y = Math.min(900, Math.max(0, this.focus.y + fy * speed));
    }
    const cp = Math.cos(this.pitch);
    const e = canonicalize({
      x: this.focus.x + this.dist * cp * Math.sin(this.yaw),
      y: 0,
      z: this.focus.z + this.dist * cp * Math.cos(this.yaw),
    });
    this.view.eye.x = e.x;
    this.view.eye.y = Math.max(
      2,
      this.focus.y + this.dist * Math.sin(this.pitch),
    );
    this.view.eye.z = e.z;
    this.view.at.x = this.focus.x;
    this.view.at.y = this.focus.y;
    this.view.at.z = this.focus.z;
    return this.view;
  }

  /** One frame: the lab clock's view time from the live render clock (what
   * main.ts poses every collapse renderer at), the panel's watch state and
   * the telemetry. */
  frame(
    liveMs: number | null,
    dt: number,
    particles: number,
    particleCap: number,
  ): number | null {
    this.liveMs = liveMs;
    const hold = this.lapse?.waitFor ?? null;
    if (hold !== null && this.clock.viewMs !== hold) {
      // The time-lapse holds the clock on its moment (once the collapse
      // has got that far: the view never runs ahead of the live clock).
      this.clock.scrub(hold, liveMs);
    }
    const view = this.clock.frame(liveMs, dt);
    // Telemetry (smoothed frame time).
    if (dt > 0) {
      this.frameMs += (dt * 1000 - this.frameMs) * 0.1;
      this.fps = 1000 / Math.max(1, this.frameMs);
    }
    const list = this.deps.field.list;
    let boxes = 0;
    let live = 0;
    for (let k = 0; k < list.length; k++) {
      const c = list[k] as Collapse;
      boxes += c.n;
      if (view === null) continue;
      // DS1: a physics collapse's moving pieces are its frames' to say.
      if (c.phys) {
        for (let i = 0; i < c.n; i++) {
          if (c.phys.state(i, view) === PIECE_MOVING) live++;
        }
        continue;
      }
      const age = (view - c.t0) / 1000;
      if (age < 0 || age * 1000 > c.endMs) continue;
      for (let i = 0; i < c.n; i++) {
        const end = (c.start[i] as number) + (c.land[i] as number) + c.squashS;
        if (age < end) live++;
      }
    }
    this.strip.update({
      fps: this.fps,
      frameMs: this.frameMs,
      draws: this.draws,
      live,
      boxes,
      particles,
      particleCap,
      serverLast: this.stats?.last ?? null,
      serverP99: this.stats?.p99 ?? null,
      serverBuild: this.stats?.build ?? null,
      bodies: this.stats?.bodies ?? null,
      bodyBudget: this.stats?.budget ?? null,
      physLast: this.stats?.physLast ?? null,
      physP99: this.stats?.physP99 ?? null,
    });
    const focus = this.focusCollapse();
    let u: number | null = null;
    let label = "—";
    if (focus && view !== null) {
      const [a, b] = this.span(focus);
      u = Math.min(1, Math.max(0, (view - a) / (b - a)));
      label = `${((view - focus.t0) / 1000).toFixed(2)} s`;
    }
    this.panel.setWatch(this.clock.isPaused, this.clock.isLive, u, label);
    return view;
  }

  /** After the frame rendered: the draw count, and a time-lapse capture
   * (the drawing buffer is only valid until the frame is composited). */
  afterRender(canvas: HTMLCanvasElement, drawCalls: number): void {
    this.draws = drawCalls;
    const lapse = this.lapse;
    if (!lapse || lapse.waitFor === null) return;
    if (this.clock.viewMs !== lapse.waitFor) return;
    // Two frames on the moment: the streaming and the dressing settle.
    if (lapse.settle-- > 0) return;
    const off = lapse.waitFor - lapse.t0;
    lapse.shots.push({
      label: off < 0 ? "before" : `t = ${(off / 1000).toFixed(1)} s`,
      url: canvas.toDataURL("image/jpeg", 0.85),
    });
    const next = lapse.times.shift();
    if (next === undefined) {
      lapse.waitFor = null;
      void this.finishTimelapse(lapse.shots);
    } else {
      lapse.waitFor = lapse.t0 + next;
      lapse.settle = 2;
    }
  }

  // --- Internals -------------------------------------------------------------

  private tuningChanged(): void {
    setDestructLook(this.tuning);
    const wait = this.syncAt + SYNC_MS - performance.now();
    if (wait <= 0) this.syncNow();
    else if (this.syncTimer === null) {
      this.syncTimer = setTimeout(() => this.syncNow(), wait);
    }
  }

  /** The collapse the timeline replays: the biggest one since the last
   * trigger (a tower's own fall, not the chain's aftershocks); else the
   * latest. */
  private focusCollapse(): Collapse | null {
    const list = this.deps.field.list;
    let best: Collapse | null = null;
    for (let k = 0; k < list.length; k++) {
      const c = list[k] as Collapse;
      if (c.t0 < this.firedAt - 2000) continue;
      if (!best || c.n > best.n) best = c;
    }
    return best ?? (list[list.length - 1] as Collapse | undefined) ?? null;
  }

  /** Its replay span, server ms: from just before the event to its dust's
   * settling. */
  private span(c: Collapse): [number, number] {
    // DS1: a physics collapse runs until its final frame (or, still going,
    // its newest) — the lab keeps every frame, so all of it scrubs.
    const end = c.phys
      ? c.phys.settled
        ? c.phys.settledAt
        : Math.max(c.t0, c.phys.last)
      : c.t0 + c.endMs;
    return [c.t0 - 1000, end + 6000];
  }

  private scrubTo(u: number): void {
    const c = this.focusCollapse();
    if (!c) return;
    const [a, b] = this.span(c);
    this.clock.scrub(a + (b - a) * u, this.liveMs);
  }

  /** Capture the latest collapse at LAPSE_TIMES_MS into one labelled
   * sheet (downloaded, and kept in `lastSheet`). */
  timelapse(): void {
    const c = this.focusCollapse();
    if (!c || this.lapse) return;
    const times = [...LAPSE_TIMES_MS];
    const first = times.shift() as number;
    this.lapse = {
      times,
      t0: c.t0,
      shots: [],
      waitFor: c.t0 + first,
      settle: 2,
    };
    this.panel.setLapseBusy(true);
  }

  private async finishTimelapse(
    shots: { label: string; url: string }[],
  ): Promise<void> {
    try {
      const imgs = await Promise.all(
        shots.map(
          (s) =>
            new Promise<HTMLImageElement>((resolve, reject) => {
              const img = new Image();
              img.onload = () => resolve(img);
              img.onerror = reject;
              img.src = s.url;
            }),
        ),
      );
      const first = imgs[0];
      if (!first) return;
      const w = LAPSE_TILE_W;
      const h = Math.round((first.height / first.width) * w);
      const cols = 2;
      const rows = Math.ceil(imgs.length / cols);
      const sheet = document.createElement("canvas");
      sheet.width = w * cols;
      sheet.height = h * rows;
      const ctx = sheet.getContext("2d");
      if (!ctx) return;
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, sheet.width, sheet.height);
      imgs.forEach((img, i) => {
        const x = (i % cols) * w;
        const y = Math.floor(i / cols) * h;
        ctx.drawImage(img, x, y, w, h);
        ctx.fillStyle = "#000";
        ctx.fillRect(x, y, 140, 24);
        ctx.fillStyle = "#fff";
        ctx.font = "14px sans-serif";
        ctx.fillText(shots[i]?.label ?? "", x + 8, y + 17);
      });
      this.lastSheet = sheet.toDataURL("image/png");
      const a = document.createElement("a");
      a.href = this.lastSheet;
      a.download = `destruction-lab-timelapse-${Date.now()}.png`;
      a.click();
    } finally {
      this.lapse = null;
      this.panel.setLapseBusy(false);
      this.clock.goLive();
    }
  }

  /** A point on the target's face toward the camera, a third of the way
   * up (canonical) — where a point trigger aims with nothing picked. */
  private facePoint(b: Building): Vec3 {
    const dx = wrapDeltaAxis(b.x, this.view.eye.x);
    const dz = wrapDeltaAxis(b.z, this.view.eye.z);
    const alongX = Math.abs(dx) / b.width >= Math.abs(dz) / b.depth;
    return canonicalize({
      x: b.x + (alongX ? (Math.sign(dx) * b.width) / 2 : 0),
      y: Math.max(6, b.height / 3),
      z: b.z + (alongX ? 0 : (Math.sign(dz) * b.depth) / 2),
    });
  }

  private bindInput(): void {
    const canvas = this.deps.canvas;
    canvas.addEventListener("pointerdown", (e) => {
      this.drag = {
        x: e.clientX,
        y: e.clientY,
        moved: false,
        pan: e.button === 2 || e.shiftKey,
      };
    });
    window.addEventListener("pointermove", (e) => {
      const d = this.drag;
      if (!d) return;
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      if (!d.moved && Math.hypot(dx, dy) < CLICK_PX) return;
      d.moved = true;
      d.x = e.clientX;
      d.y = e.clientY;
      if (d.pan) {
        const k = this.dist * 0.0015;
        const s = Math.sin(this.yaw);
        const c = Math.cos(this.yaw);
        const p = canonicalize({
          x: this.focus.x - (dx * c - dy * s) * k,
          y: 0,
          z: this.focus.z - (-dx * s - dy * c) * k,
        });
        this.focus.x = p.x;
        this.focus.z = p.z;
      } else {
        this.yaw -= dx * 0.005;
        this.pitch = Math.min(
          PITCH_MAX,
          Math.max(PITCH_MIN, this.pitch + dy * 0.004),
        );
      }
    });
    window.addEventListener("pointerup", (e) => {
      const d = this.drag;
      this.drag = null;
      if (d && !d.moved && e.target === canvas) this.pick(e);
    });
    canvas.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        this.dist = Math.min(
          DIST_MAX,
          Math.max(DIST_MIN, this.dist * Math.exp(e.deltaY * 0.0012)),
        );
      },
      { passive: false },
    );
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    window.addEventListener("keydown", (e) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) {
        if ((t as HTMLInputElement).type !== "range") return;
      }
      this.keys.add(e.code);
    });
    window.addEventListener("keyup", (e) => this.keys.delete(e.code));
    window.addEventListener("blur", () => this.keys.clear());
  }

  /** A click on the canvas: the tower under it becomes the target (in the
   * arena, only its towers) and the hit point the aim point. */
  private pick(e: PointerEvent): void {
    const rect = this.deps.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector3(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
      0.5,
    );
    const cam = this.deps.camera;
    ndc.unproject(cam);
    const dir = ndc.sub(cam.position).normalize();
    const from = canonicalize({
      x: cam.position.x,
      y: cam.position.y,
      z: cam.position.z,
    });
    const hit = raycastChunk(this.deps.buildings, from, dir, 950);
    if (!hit) return;
    if (!this.dropIn) {
      const arena = this.arenas[this.arena];
      if (arena && !arena.towers.includes(hit.building)) return;
    }
    const p = canonicalize({
      x: from.x + dir.x * hit.t,
      y: from.y + dir.y * hit.t,
      z: from.z + dir.z * hit.t,
    });
    this.setTarget(hit.building, p);
    // In the city, the camera comes round to the picked tower.
    if (this.dropIn) this.frameTower(hit.building);
  }
}

function archetypeName(b: Building): string {
  const a = archetypeFor(b);
  return a === FacadeArchetype.GLASS
    ? "glass"
    : a === FacadeArchetype.MASONRY
      ? "masonry"
      : "office";
}
