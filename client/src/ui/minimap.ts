// Wrapping minimap (PLAN.md → Presentation & UI): a square canvas centered on
// the player, north (−Z) up, showing the full WORLD_SIZE around them. The
// city texture is prerendered once from the shared Building list and drawn as
// a 2×2 wrapped tiling with a modular offset — a torus has no edge, so the
// minimap never shows one. Dots and the tiling both go through wrapDelta
// math (the pure seam below); the canvas painting is a thin adapter.

import {
  type Building,
  type HoleSpan,
  cityHoles,
  standingProfile,
} from "@angels-bandits/common/city";
import {
  BRIDGE_HALF_WIDTH,
  RIVER_CENTER_Z,
  RIVER_HALF_WIDTH,
} from "@angels-bandits/common/city/river";
import {
  PORTAL_CUTS,
  RIVER_MOUTHS,
  TUNNELS,
  tunnelPointInto,
} from "@angels-bandits/common/city/tunnels";
import {
  BLOCK_PITCH,
  BUILDING_MAX_HEIGHT,
  LANDMARK_HEIGHT,
  WORLD_SIZE,
} from "@angels-bandits/common/constants";
import { type Vec3, wrapDelta } from "@angels-bandits/common/world";
import { StandingWatch } from "../render/standing-watch";

const mod = (v: number, m: number): number => ((v % m) + m) % m;

/**
 * Canvas position of `target`'s dot on a `sizePx` map centered on `player`.
 * The map spans exactly WORLD_SIZE, so every wrapDelta lands inside it —
 * a dot can approach the rim but never jump across the map at the seam.
 */
export function minimapPoint(
  player: Vec3,
  target: Vec3,
  sizePx: number,
): { x: number; y: number } {
  const s = sizePx / WORLD_SIZE;
  const d = wrapDelta(player, target);
  return { x: sizePx / 2 + d.x * s, y: sizePx / 2 + d.z * s };
}

/**
 * Canvas position of the wrapped city tile's top-left corner, in [−size, 0):
 * drawing the tile at this offset (+size on each axis for the 2×2 fill)
 * keeps world coordinates glued under the player as they fly and wrap.
 */
export function minimapPatternOffset(
  player: Vec3,
  sizePx: number,
): { x: number; y: number } {
  const s = sizePx / WORLD_SIZE;
  return {
    x: mod(sizePx / 2 - player.x * s, sizePx) - sizePx,
    y: mod(sizePx / 2 - player.z * s, sizePx) - sizePx,
  };
}

/** A blip on the map: canonical position + map-space heading angle (rad). */
export interface MinimapContact {
  pos: Vec3;
  angle: number;
}

/** A storm reveal echo: where a plane was lit + its fading level (1 → 0). */
export interface StormEcho {
  pos: Vec3;
  level: number;
}

/** Neon Vein ping magenta — the reveal accent across model, map, and feed. */
const ECHO_COLOR = "#e07bff";

/** One world's worth of city blocks, drawn once (footprints by height). */
function renderCityTile(
  buildings: readonly Building[],
  sizePx: number,
): HTMLCanvasElement {
  const tile = document.createElement("canvas");
  tile.width = sizePx;
  tile.height = sizePx;
  const ctx = tile.getContext("2d");
  if (!ctx) return tile;
  const s = sizePx / WORLD_SIZE;
  ctx.fillStyle = "#0d0c1a";
  ctx.fillRect(0, 0, sizePx, sizePx);
  // L11 river: the channel as a band of water, crossed by every bridge. It
  // runs along x, so one band wraps with the tile like the streets do.
  ctx.fillStyle = "#123049";
  ctx.fillRect(
    0,
    (RIVER_CENTER_Z - RIVER_HALF_WIDTH) * s,
    sizePx,
    2 * RIVER_HALF_WIDTH * s,
  );
  ctx.fillStyle = "#2a2c3c";
  for (let x = 0; x <= WORLD_SIZE; x += BLOCK_PITCH) {
    ctx.fillRect(
      (x - BRIDGE_HALF_WIDTH) * s,
      (RIVER_CENTER_Z - RIVER_HALF_WIDTH) * s,
      2 * BRIDGE_HALF_WIDTH * s,
      2 * RIVER_HALF_WIDTH * s,
    );
  }
  for (const b of buildings) paintFootprint(ctx, b, s);
  drawHoles(ctx, cityHoles(buildings), s);
  drawTunnels(ctx, s);
  return tile;
}

/** Rubble on a felled lot: warm grey, darker than any standing roof. */
const RUBBLE_COLOR = "#2a2526";

/** One footprint, shaded by the height that STANDS (D8: a felled tower is a
 * low stump or a rubble lot on the map, not its old roof). */
function paintFootprint(
  ctx: CanvasRenderingContext2D,
  b: Building,
  s: number,
): void {
  const top = b.damage ? standingProfile(b).top : b.height;
  if (top >= LANDMARK_HEIGHT) {
    ctx.fillStyle = "#3fb8c9"; // landmark accent — same read as the 3D city
  } else if (top <= 0) {
    ctx.fillStyle = RUBBLE_COLOR;
  } else {
    // Height ramp over the real building range (C1 raised the ceiling;
    // this used to hardcode the old 180 m maximum and clipped flat).
    const shade = 30 + Math.round((top / BUILDING_MAX_HEIGHT) * 45);
    ctx.fillStyle = `rgb(${shade - 6}, ${shade - 4}, ${shade + 14})`;
  }
  ctx.fillRect(
    (b.x - b.width / 2) * s,
    (b.z - b.depth / 2) * s,
    b.width * s,
    b.depth * s,
  );
}

/** H1 holes: a bright tick through the footprint along the line you fly,
 * in the mouth frames' cool white — the map shows where to aim, not just
 * that a hole exists. */
function drawHoles(
  ctx: CanvasRenderingContext2D,
  holes: readonly HoleSpan[],
  s: number,
): void {
  ctx.strokeStyle = "#bfe8ff";
  ctx.lineCap = "round";
  for (const h of holes) {
    ctx.lineWidth = Math.max(2, h.hole.width * s);
    ctx.beginPath();
    ctx.moveTo(h.entry.x * s, h.entry.z * s);
    ctx.lineTo(h.exit.x * s, h.exit.z * s);
    ctx.stroke();
  }
}

/** Portal accent: the tunnels' own cyan (render/tunnels.ts kerb lights). */
const PORTAL_COLOR = "#62e6ff";

/**
 * U4: every tunnel as a faint dashed line (it runs under the blocks, so it
 * is drawn over them, quietly), and its portals and river mouths as bright
 * marks — where to dive in. Pieces are drawn canonical and a piece that
 * crosses the seam is skipped (the next one starts on the other side).
 */
function drawTunnels(ctx: CanvasRenderingContext2D, s: number): void {
  const pt = { x: 0, z: 0, th: 0 };
  const wrap = (v: number) => mod(v, WORLD_SIZE);
  ctx.save();
  ctx.strokeStyle = "rgba(98, 230, 255, 0.45)";
  ctx.lineWidth = 2;
  ctx.setLineDash([4, 4]);
  for (const t of TUNNELS) {
    let px = Number.NaN;
    let pz = Number.NaN;
    for (let d = 0; d <= t.length; d += 10) {
      tunnelPointInto(t, Math.min(d, t.length), pt);
      const x = wrap(pt.x);
      const z = wrap(pt.z);
      if (Math.abs(x - px) < 100 && Math.abs(z - pz) < 100) {
        ctx.beginPath();
        ctx.moveTo(px * s, pz * s);
        ctx.lineTo(x * s, z * s);
        ctx.stroke();
      }
      px = x;
      pz = z;
    }
  }
  ctx.restore();
  ctx.fillStyle = PORTAL_COLOR;
  for (const c of PORTAL_CUTS) {
    ctx.fillRect(c.x0 * s, c.z0 * s, (c.x1 - c.x0) * s, (c.z1 - c.z0) * s);
  }
  for (const m of RIVER_MOUTHS) {
    const z = RIVER_CENTER_Z + m.side * RIVER_HALF_WIDTH;
    ctx.fillRect(m.x0 * s, z * s - 2, (m.x1 - m.x0) * s, 4);
  }
}

export class Minimap {
  private readonly canvas = document.getElementById(
    "minimap",
  ) as HTMLCanvasElement;
  private readonly ctx = this.canvas.getContext("2d");
  private readonly tile: HTMLCanvasElement;
  private readonly size: number;
  /** D8: footprints repainted as their buildings break and are rebuilt. */
  private readonly watch: StandingWatch;
  private readonly holes: readonly HoleSpan[];

  constructor(private readonly buildings: readonly Building[]) {
    this.size = this.canvas.width; // square; CSS scales it down for the HUD
    this.tile = renderCityTile(buildings, this.size);
    this.watch = new StandingWatch(buildings);
    this.holes = cityHoles(buildings);
  }

  /** D8: repaint building `i`'s footprint (and any hole tick through it). */
  private readonly repaint = (i: number): void => {
    const ctx = this.tile.getContext("2d");
    const b = this.buildings[i];
    if (!ctx || !b) return;
    const s = this.size / WORLD_SIZE;
    paintFootprint(ctx, b, s);
    let through = false;
    for (const h of this.holes) if (h.hosts.includes(b)) through = true;
    if (through) {
      drawHoles(
        ctx,
        this.holes.filter((h) => h.hosts.includes(b)),
        s,
      );
    }
  };

  private blip(x: number, y: number, angle: number, color: string): void {
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, -6);
    ctx.lineTo(4.2, 5);
    ctx.lineTo(-4.2, 5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  /** Redraw: wrapped city under the player, storm echoes, contacts, self
   * arrow at center. Echoes draw under contacts — a live blip outranks the
   * storm's 2 s old radar memory of the same plane. */
  update(
    playerPos: Vec3,
    playerYaw: number,
    contacts: readonly MinimapContact[],
    echoes: readonly StormEcho[] = [],
  ): void {
    const ctx = this.ctx;
    if (!ctx) return;
    this.watch.poll(this.repaint);
    const size = this.size;
    const o = minimapPatternOffset(playerPos, size);
    // The 2×2 tile repeat, written out (A1: no per-frame array literals).
    ctx.drawImage(this.tile, o.x, o.y);
    ctx.drawImage(this.tile, o.x, o.y + size);
    ctx.drawImage(this.tile, o.x + size, o.y);
    ctx.drawImage(this.tile, o.x + size, o.y + size);
    for (const e of echoes) {
      const p = minimapPoint(playerPos, e.pos, size);
      // Pulsing magenta echo (Neon Vein): ~3 Hz throb while it fades out.
      const throb =
        0.55 + 0.45 * Math.abs(Math.sin((1 - e.level) * Math.PI * 6));
      ctx.globalAlpha = e.level * throb;
      ctx.fillStyle = ECHO_COLOR;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4 + (1 - e.level) * 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    for (const c of contacts) {
      const p = minimapPoint(playerPos, c.pos, size);
      this.blip(p.x, p.y, c.angle, "#ff8a3d");
    }
    // Self: yaw 0 faces −Z (north, map-up); a right turn decreases yaw —
    // map-space rotation is therefore −yaw (same formula as the contacts').
    this.blip(size / 2, size / 2, -playerYaw, "#27e0c0");
  }
}
