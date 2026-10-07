// The torus-image cache (O2) against nearestImage itself. The cache exists so
// static scenery stops re-uploading every matrix every frame — and the one
// thing it may never do is draw an instance at a different image than
// nearestImage would, or flip it on a different frame. Random camera paths
// below cross the seam and the half-world line many times over.

import { mulberry32 } from "@angels-bandits/common/city";
import { WORLD_SIZE } from "@angels-bandits/common/constants";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  ImageCache,
  InstanceUploads,
  nearestImage,
  nearestImageInto,
} from "../src/render/wrapPlacement";

/** Which whole-world shift an image is of its canonical anchor. */
const shiftOf = (image: number, canonical: number): number =>
  Math.round((image - canonical) / WORLD_SIZE);

describe("nearestImageInto", () => {
  it("matches nearestImage to the last bit, allocation aside", () => {
    const rand = mulberry32(5);
    const out = { x: 0, y: 0, z: 0 };
    for (let i = 0; i < 2000; i++) {
      const viewer = {
        x: rand() * 3 * WORLD_SIZE - WORLD_SIZE,
        y: 100,
        z: rand() * 3 * WORLD_SIZE - WORLD_SIZE,
      };
      const c = {
        x: rand() * WORLD_SIZE,
        y: rand() * 300,
        z: rand() * WORLD_SIZE,
      };
      expect(nearestImageInto(out, viewer, c)).toEqual(nearestImage(viewer, c));
    }
  });
});

describe("ImageCache", () => {
  const anchors = (n: number, seed: number) => {
    const rand = mulberry32(seed);
    const xs: number[] = [];
    const zs: number[] = [];
    for (let i = 0; i < n; i++) {
      xs.push(rand() * WORLD_SIZE);
      zs.push(rand() * WORLD_SIZE);
    }
    // Exact half-world ties and the seam itself, where rounding bites.
    xs.push(0, WORLD_SIZE / 2, 1000, 1999.999);
    zs.push(0, 1000, WORLD_SIZE / 2, 0.001);
    return { xs, zs };
  };

  for (const seed of [1, 2, 3, 4]) {
    it(`draws and flips every instance exactly as nearestImage does (random path ${seed})`, () => {
      const { xs, zs } = anchors(300, seed);
      const cache = new ImageCache(xs, zs);
      const drawn = xs.map(() => ({ x: Number.NaN, z: Number.NaN }));
      const rand = mulberry32(100 + seed);
      // A flight: random heading changes, speeds up to a teleporting seam
      // wrap, starting anywhere (the camera is not always canonical).
      const cam = { x: rand() * WORLD_SIZE, y: 120, z: rand() * WORLD_SIZE };
      let heading = rand() * Math.PI * 2;
      const prevShift = xs.map(() => ({ x: Number.NaN, z: Number.NaN }));
      let misplaced = 0;
      let mistimed = 0;
      let flips = 0;
      for (let step = 0; step < 1500; step++) {
        heading += (rand() - 0.5) * 0.4;
        const speed = step % 97 === 0 ? 400 : rand() * 6;
        cam.x += Math.cos(heading) * speed;
        cam.z += Math.sin(heading) * speed;
        if (step % 211 === 0) cam.x += WORLD_SIZE; // the camera re-canonicalises
        const written = new Set<number>();
        cache.update(cam, (i, x, z) => {
          written.add(i);
          drawn[i] = { x, z };
        });
        for (let i = 0; i < xs.length; i++) {
          const c = { x: xs[i] as number, y: 0, z: zs[i] as number };
          const want = nearestImage(cam, c);
          const got = drawn[i] as { x: number; z: number };
          if (
            !(
              Math.abs(got.x - want.x) < 1e-6 && Math.abs(got.z - want.z) < 1e-6
            )
          ) {
            misplaced++;
          }
          // Rewritten exactly on the frames nearestImage's image changed.
          const shift = { x: shiftOf(want.x, c.x), z: shiftOf(want.z, c.z) };
          const prev = prevShift[i] as { x: number; z: number };
          const flipped = shift.x !== prev.x || shift.z !== prev.z;
          if (written.has(i) !== flipped) mistimed++;
          if (flipped && step > 0) flips++;
          prevShift[i] = shift;
        }
      }
      expect(misplaced).toBe(0);
      expect(mistimed).toBe(0);
      expect(flips).toBeGreaterThan(100); // the path really crossed lines
    });
  }

  it("rewrites nothing while the camera stays on its side of every half-world line", () => {
    const { xs, zs } = anchors(200, 9);
    const cache = new ImageCache(xs, zs);
    const cam = { x: 400, y: 120, z: 700 };
    expect(cache.update(cam, () => {})).toBe(xs.length);
    expect(cache.update(cam, () => {})).toBe(0);
    cam.x += 0.5; // a small move only flips what it crosses
    const moved = cache.update(cam, () => {});
    expect(moved).toBeLessThan(5);
  });

  it("rewrites everything again after invalidate()", () => {
    const { xs, zs } = anchors(50, 3);
    const cache = new ImageCache(xs, zs);
    const cam = { x: 10, y: 0, z: 10 };
    cache.update(cam, () => {});
    cache.invalidate();
    expect(cache.update(cam, () => {})).toBe(xs.length);
  });
});

describe("InstanceUploads", () => {
  const matrixAttr = (n: number) =>
    new THREE.InstancedBufferAttribute(new Float32Array(n * 16), 16);

  it("uploads nothing on a frame with no marks", () => {
    const attr = matrixAttr(10);
    const uploads = new InstanceUploads([attr]);
    const version = attr.version;
    uploads.flush();
    expect(attr.version).toBe(version);
  });

  it("merges adjacent slots into one range per run, for every attribute", () => {
    const a = matrixAttr(20);
    const b = matrixAttr(20);
    const uploads = new InstanceUploads([a, b]);
    for (const i of [3, 4, 5, 9]) uploads.mark(i);
    uploads.flush();
    for (const attr of [a, b]) {
      expect(attr.version).toBe(1);
      expect(attr.updateRanges).toEqual([
        { start: 3 * 16, count: 3 * 16 },
        { start: 9 * 16, count: 16 },
      ]);
    }
  });

  it("falls back to one full upload past the range budget", () => {
    const attr = matrixAttr(200);
    const uploads = new InstanceUploads([attr]);
    for (let i = 0; i < 200; i += 2) uploads.mark(i); // 100 separate runs
    uploads.flush();
    expect(attr.version).toBe(1);
    expect(attr.updateRanges).toEqual([]); // empty = whole buffer
  });

  it("starts each frame clean (last frame's runs are not re-sent)", () => {
    const attr = matrixAttr(20);
    const uploads = new InstanceUploads([attr]);
    uploads.mark(1);
    uploads.flush();
    uploads.mark(7);
    uploads.flush();
    expect(attr.updateRanges).toEqual([{ start: 7 * 16, count: 16 }]);
  });
});
