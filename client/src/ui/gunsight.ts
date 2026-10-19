// FC1 gun-sight: the zoomed view's reticle. Around the pipper (the gun
// line's far point, hud.ts's crosshair) a sight ring with mil ticks and a
// RANGE ARC — the arc sweeps clockwise from the top as far as the lead
// target's range is of the guns' effective range, with fixed ticks at 100,
// 200 and 300 m, so "inside the ticks" reads at a glance; under it the
// projected GUN LINE: the bullets' path from the wings out to the pipper,
// seen from just above it, with a range tick at each of GUN_LINE_RANGES. A
// vignette darkens the frame's edge. The lead pipper itself stays
// ui/lead.ts's reticle (it is already on screen). Everything fades in over
// the last part of the zoom, so nothing pops while the plane dissolves.
//
// `gunsightView` is the pure half (tested); `Gunsight` writes the DOM in
// index.html (#gunsight, #gun-line, #zoom-vignette), only when a value
// changed — zero allocation once settled.

import { BULLET_RANGE } from "@angels-bandits/common/constants";
import type { FlightState } from "@angels-bandits/common/flight";
import type { Vec3 } from "@angels-bandits/common/world";
import type * as THREE from "three";
import { nearestImageInto } from "../render/wrapPlacement";

/** Ranges along the gun line that get a tick, m (the last is the pipper). */
export const GUN_LINE_RANGES: readonly number[] = [50, 100, 200, BULLET_RANGE];
/** Range-arc ticks, m. */
export const RANGE_TICKS: readonly number[] = [100, 200, 300];
/** The zoom at which the sight starts to show, and where it is full. */
const SHOW_START = 0.5;
const SHOW_FULL = 0.95;
/** The vignette's opacity at full zoom. */
const VIGNETTE_MAX = 0.85;

export interface GunsightView {
  /** 0..1: the sight ring, arc and gun line. */
  opacity: number;
  /** 0..1: the vignette. */
  vignette: number;
  /** The range arc's share of the full circle (0 = no target), and
   * whether that target is inside the guns' effective range. */
  arc: number;
  inRange: boolean;
  /** "240 M" under the ring, or "" with no target. */
  label: string;
}

/**
 * The sight for zoom `z` (0..1) and the lead target's `range`, m (null:
 * none). Pure.
 */
export function gunsightView(z: number, range: number | null): GunsightView {
  const t = Math.min(
    1,
    Math.max(0, (z - SHOW_START) / (SHOW_FULL - SHOW_START)),
  );
  const opacity = t * t * (3 - 2 * t);
  const has = range !== null && Number.isFinite(range) && range >= 0;
  return {
    opacity,
    vignette: VIGNETTE_MAX * z,
    arc: has ? Math.min(1, (range as number) / BULLET_RANGE) : 0,
    inRange: has && (range as number) <= BULLET_RANGE,
    label: has ? `${Math.round(range as number)} M` : "",
  };
}

const linePoint: Vec3 = { x: 0, y: 0, z: 0 };
const lineImage: Vec3 = { x: 0, y: 0, z: 0 };

/**
 * The gun line's GUN_LINE_RANGES points on screen, px, into `out` (x, y
 * pairs; NaN for a point behind the camera). Call after the render, with
 * fresh matrices — as ui/lead.ts's projectToScreen. No allocation.
 */
export function projectGunLine(
  camera: THREE.Camera,
  viewer: Vec3,
  flight: Pick<FlightState, "pos" | "yaw" | "pitch">,
  out: Float64Array,
  scratch: THREE.Vector3,
  width: number,
  height: number,
): void {
  const cp = Math.cos(flight.pitch);
  const fx = -Math.sin(flight.yaw) * cp;
  const fy = Math.sin(flight.pitch);
  const fz = -Math.cos(flight.yaw) * cp;
  for (let i = 0; i < GUN_LINE_RANGES.length; i++) {
    const r = GUN_LINE_RANGES[i] as number;
    linePoint.x = flight.pos.x + fx * r;
    linePoint.y = flight.pos.y + fy * r;
    linePoint.z = flight.pos.z + fz * r;
    // nearestImageInto wraps per axis, so the uncanonicalised point is fine.
    const p = nearestImageInto(lineImage, viewer, linePoint);
    scratch.set(p.x, p.y, p.z).applyMatrix4(camera.matrixWorldInverse);
    if (scratch.z >= 0) {
      out[i * 2] = Number.NaN;
      out[i * 2 + 1] = Number.NaN;
      continue;
    }
    scratch.applyMatrix4(camera.projectionMatrix);
    out[i * 2] = ((scratch.x + 1) / 2) * width;
    out[i * 2 + 1] = ((1 - scratch.y) / 2) * height;
  }
}

/** The ring's radius in the SVG's 200-unit box, and its circumference. */
const RING_R = 52;
const RING_C = 2 * Math.PI * RING_R;

/** The DOM half: index.html's #gunsight, #gun-line and #zoom-vignette. */
export class Gunsight {
  private readonly el = document.getElementById("gunsight");
  private readonly arc = document.getElementById("gunsight-arc");
  private readonly label = document.getElementById("gunsight-range");
  private readonly line = document.getElementById("gun-line");
  private readonly path = document.getElementById("gun-line-path");
  private readonly ticks: Element[] = [];
  private readonly vignette = document.getElementById("zoom-vignette");
  private shown = "";
  private arcShown = "";
  private labelShown = "";
  private vigShown = "";
  private lineShown = "";
  private hot = false;

  constructor() {
    if (this.line) {
      for (let i = 0; i < GUN_LINE_RANGES.length; i++) {
        const c = document.createElementNS(
          "http://www.w3.org/2000/svg",
          "circle",
        );
        c.setAttribute("r", i === GUN_LINE_RANGES.length - 1 ? "0" : "2");
        this.line.appendChild(c);
        this.ticks.push(c);
      }
    }
  }

  /**
   * One frame: `pipper` is where the gun line lands on screen (px; null
   * hides the sight), `gunLine` the screen points of GUN_LINE_RANGES (x, y
   * pairs, px; NaN where behind the camera).
   */
  update(
    v: GunsightView,
    pipper: { x: number; y: number } | null,
    gunLine: Float64Array,
  ): void {
    const vig = v.vignette.toFixed(2);
    if (this.vignette && vig !== this.vigShown) {
      this.vigShown = vig;
      this.vignette.style.opacity = vig;
    }
    if (!this.el) return;
    const show = pipper !== null && v.opacity > 0.01;
    const op = show ? v.opacity.toFixed(2) : "0";
    if (op !== this.shown) {
      this.shown = op;
      this.el.style.opacity = op;
      if (this.line) this.line.style.opacity = op;
    }
    if (!show || !pipper) return;
    this.el.style.transform = `translate(${pipper.x.toFixed(1)}px, ${pipper.y.toFixed(1)}px)`;
    const dash = `${(v.arc * RING_C).toFixed(1)} ${RING_C.toFixed(1)}`;
    if (dash !== this.arcShown) {
      this.arcShown = dash;
      this.arc?.setAttribute("stroke-dasharray", dash);
    }
    if (v.inRange !== this.hot) {
      this.hot = v.inRange;
      this.el.classList.toggle("in-range", v.inRange);
    }
    if (v.label !== this.labelShown && this.label) {
      this.labelShown = v.label;
      this.label.textContent = v.label;
    }
    // The gun line: a polyline through every point in front of the camera.
    let pts = "";
    for (let i = 0; i < GUN_LINE_RANGES.length; i++) {
      const x = gunLine[i * 2] as number;
      const y = gunLine[i * 2 + 1] as number;
      const tick = this.ticks[i];
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      pts += `${x.toFixed(1)},${y.toFixed(1)} `;
      tick?.setAttribute("cx", x.toFixed(1));
      tick?.setAttribute("cy", y.toFixed(1));
    }
    if (pts !== this.lineShown) {
      this.lineShown = pts;
      this.path?.setAttribute("points", pts);
    }
  }
}
