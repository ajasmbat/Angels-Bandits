// Offscreen enemy edge markers (PLAN.md → Presentation & UI): arrows clamped
// to the screen edges for enemies outside the view frustum. The clamp math is
// the pure seam below (NDC in, NDC anchor + arrow angle out); the DOM arrows
// are a thin adapter. World→camera direction comes from nearestImage, i.e.
// wrapDelta — the marker always points the short way around the torus.

import type { Vec3 } from "@angels-bandits/common/world";
import type * as THREE from "three";
import { nearestImageInto } from "../render/wrapPlacement";

/** A1: an arrow's last written transform / display — a frame only touches
 * the DOM where a value changed (a parked arrow is not re-hidden each
 * frame, a still one not re-parsed). */
interface Written {
  transform: string;
  display: string;
}

/** Markers sit at this fraction of the way to the NDC edge (|x|,|y| ≤ this). */
const EDGE = 0.92;

export interface EdgeMarkerAnchor {
  /** Clamped NDC anchor (x right, y up), on the EDGE box. */
  x: number;
  y: number;
  /** Arrow angle, radians clockwise from screen-up, pointing at the target. */
  angle: number;
}

/**
 * Clamp a target's NDC position to the screen edge, or null when the target
 * is on screen (no marker needed). `behind` flips the projected coordinates
 * back to the target's true side — a behind-camera projection mirrors them —
 * and always yields a marker.
 */
export function edgeMarker(
  ndcX: number,
  ndcY: number,
  behind: boolean,
): EdgeMarkerAnchor | null {
  let x = ndcX;
  let y = ndcY;
  if (behind) {
    x = -x;
    y = -y;
    // Exactly astern projects to the center: point straight down. (Assign
    // both — a negated 0 is −0, and atan2(−0, −1) would flip π to −π.)
    if (x === 0 && y === 0) {
      x = 0;
      y = -1;
    }
  } else if (Math.abs(x) <= 1 && Math.abs(y) <= 1) {
    return null;
  }
  const scale = EDGE / Math.max(Math.abs(x), Math.abs(y));
  return { x: x * scale, y: y * scale, angle: Math.atan2(x, y) };
}

/** DOM arrow pool: one `.edge-marker` div per offscreen living enemy. */
export class EdgeMarkers {
  private readonly pool: HTMLDivElement[] = [];
  /** A1: per-arrow last writes (see Written) and nearestImage scratch. */
  private readonly written: Written[] = [];
  private readonly image: Vec3 = { x: 0, y: 0, z: 0 };

  private arrow(i: number): HTMLDivElement {
    let el = this.pool[i];
    if (!el) {
      el = document.createElement("div");
      el.className = "edge-marker";
      document.body.appendChild(el);
      this.pool[i] = el;
    }
    return el;
  }

  /** Project every position and place arrows for the offscreen ones. */
  update(
    camera: THREE.Camera,
    viewer: Vec3,
    positions: readonly Vec3[],
    scratch: THREE.Vector3,
  ): void {
    let used = 0;
    const w = window.innerWidth;
    const h = window.innerHeight;
    for (const pos of positions) {
      const p = nearestImageInto(this.image, viewer, pos);
      scratch.set(p.x, p.y, p.z).applyMatrix4(camera.matrixWorldInverse);
      const behind = scratch.z > 0;
      scratch.applyMatrix4(camera.projectionMatrix);
      const m = edgeMarker(scratch.x, scratch.y, behind);
      if (!m) continue;
      const i = used++;
      const el = this.arrow(i);
      const px = ((m.x + 1) / 2) * w;
      const py = ((1 - m.y) / 2) * h;
      this.write(
        el,
        i,
        `translate(${px.toFixed(1)}px, ${py.toFixed(1)}px) translate(-50%, -50%) rotate(${m.angle.toFixed(4)}rad)`,
        "block",
      );
    }
    for (let i = used; i < this.pool.length; i++) {
      const el = this.pool[i];
      if (el) this.write(el, i, null, "none");
    }
  }

  /** Set arrow `i`'s transform (null: leave it) and display, where changed. */
  private write(
    el: HTMLElement,
    i: number,
    transform: string | null,
    display: string,
  ): void {
    let last = this.written[i];
    if (!last) {
      last = { transform: "", display: "" };
      this.written[i] = last;
    }
    if (transform !== null && last.transform !== transform) {
      last.transform = transform;
      el.style.transform = transform;
    }
    if (last.display !== display) {
      last.display = display;
      el.style.display = display;
    }
  }
}
