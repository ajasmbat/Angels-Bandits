// Wrapping minimap (PLAN.md → Presentation & UI): a square canvas centered on
// the player, north (−Z) up, showing the full WORLD_SIZE around them. The
// city texture is prerendered once from the shared Building list and drawn as
// a 2×2 wrapped tiling with a modular offset — a torus has no edge, so the
// minimap never shows one. Dots and the tiling both go through wrapDelta
// math (the pure seam below); the canvas painting is a thin adapter.

import type { Building } from "@angels-bandits/common/city";
import { LANDMARK_HEIGHT, WORLD_SIZE } from "@angels-bandits/common/constants";
import { type Vec3, wrapDelta } from "@angels-bandits/common/world";

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
  for (const b of buildings) {
    if (b.height >= LANDMARK_HEIGHT) {
      ctx.fillStyle = "#3fb8c9"; // landmark accent — same read as the 3D city
    } else {
      const shade = 30 + Math.round((b.height / 180) * 45);
      ctx.fillStyle = `rgb(${shade - 6}, ${shade - 4}, ${shade + 14})`;
    }
    ctx.fillRect(
      (b.x - b.width / 2) * s,
      (b.z - b.depth / 2) * s,
      b.width * s,
      b.depth * s,
    );
  }
  return tile;
}

export class Minimap {
  private readonly canvas = document.getElementById(
    "minimap",
  ) as HTMLCanvasElement;
  private readonly ctx = this.canvas.getContext("2d");
  private readonly tile: HTMLCanvasElement;
  private readonly size: number;

  constructor(buildings: readonly Building[]) {
    this.size = this.canvas.width; // square; CSS scales it down for the HUD
    this.tile = renderCityTile(buildings, this.size);
  }

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
    const size = this.size;
    const o = minimapPatternOffset(playerPos, size);
    for (const dx of [0, size]) {
      for (const dy of [0, size]) {
        ctx.drawImage(this.tile, o.x + dx, o.y + dy);
      }
    }
    for (const e of echoes) {
      const p = minimapPoint(playerPos, e.pos, size);
      // Pulsing magenta echo (Neon Vein): ~3 Hz throb while it fades out.
      const throb = 0.55 + 0.45 * Math.abs(Math.sin((1 - e.level) * Math.PI * 6));
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
