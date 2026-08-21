// Snapshot interpolation buffer — remote planes render INTERP_DELAY_MS behind
// server time by sampling between the two snapshots that straddle the render
// time: wrapLerp for positions (seam crossings glide — PLAN.md non-negotiable),
// slerp for attitude, plain lerp for speed. Pure and renderer-free: the frame
// loop feeds it a render time; it never looks at a clock itself.

import type { Pose } from "@angels-bandits/common/protocol";
import { wrapLerp } from "@angels-bandits/common/world";
import * as THREE from "three";

/** Samples older than this before the newest one are dropped, ms. */
const MAX_SAMPLE_AGE_MS = 1000;

interface Sample {
  time: number;
  pose: Pose;
}

const scratchA = new THREE.Quaternion();
const scratchB = new THREE.Quaternion();

export class InterpolationBuffer {
  private samples: Sample[] = [];

  /** Newest sample's server time, or null when empty. */
  get latestTime(): number | null {
    const last = this.samples[this.samples.length - 1];
    return last === undefined ? null : last.time;
  }

  /** Record one snapshot's pose. Times must be the server's snapshot clock. */
  push(time: number, pose: Pose): void {
    // Snapshots arrive in order; drop the rare stale straggler outright.
    const newest = this.latestTime;
    if (newest !== null && time <= newest) return;
    this.samples.push({ time, pose });
    const cutoff = time - MAX_SAMPLE_AGE_MS;
    while (this.samples.length > 1) {
      const head = this.samples[0];
      if (head === undefined || head.time >= cutoff) break;
      this.samples.shift();
    }
  }

  /**
   * The pose at `renderTime` (server clock, ms): interpolated between the
   * straddling samples, clamped to the ends — never extrapolated.
   */
  sample(renderTime: number): Pose | null {
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    if (first === undefined || last === undefined) return null;
    if (renderTime <= first.time) return first.pose;
    if (renderTime >= last.time) return last.pose;

    // renderTime is strictly inside (first.time, last.time): a is the newest
    // sample before it, b the oldest at-or-after it.
    let a = first;
    let b = last;
    for (const cur of this.samples) {
      if (cur.time < renderTime) {
        a = cur;
      } else {
        b = cur;
        break;
      }
    }
    const t = (renderTime - a.time) / (b.time - a.time);

    scratchA.set(a.pose.quat.x, a.pose.quat.y, a.pose.quat.z, a.pose.quat.w);
    scratchB.set(b.pose.quat.x, b.pose.quat.y, b.pose.quat.z, b.pose.quat.w);
    scratchA.slerp(scratchB, t);

    return {
      pos: wrapLerp(a.pose.pos, b.pose.pos, t),
      quat: { x: scratchA.x, y: scratchA.y, z: scratchA.z, w: scratchA.w },
      speed: a.pose.speed + (b.pose.speed - a.pose.speed) * t,
    };
  }
}
