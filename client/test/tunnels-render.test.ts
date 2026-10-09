// U4 tunnels, drawn (client/src/render/tunnels.ts): the shell the renderer
// actually builds separates air from rock exactly where hitsGround does —
// every face of it has open air on one side and solid ground on the other
// (draw == collide at the triangle level) — and it is one period, tiled
// 2×2, with no triangle stretched across the seam.

import { hitsGround } from "@angels-bandits/common/collision";
import { WORLD_SIZE } from "@angels-bandits/common/constants";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { QUALITY_PROFILES } from "../src/render/quality";
import { TunnelRenderer, buildTunnelGeometry } from "../src/render/tunnels";

describe("the tunnel shell", () => {
  const [shell, fixtures] = buildTunnelGeometry();
  const pos = shell.getAttribute("position");
  const n = pos.count;

  it("is one period tiled 2×2: four identical copies, none crossing the seam", () => {
    expect(n % 4).toBe(0);
    const q = n / 4;
    for (let i = 0; i < q; i += 3) {
      let minX = Number.POSITIVE_INFINITY;
      let maxX = Number.NEGATIVE_INFINITY;
      let minZ = Number.POSITIVE_INFINITY;
      let maxZ = Number.NEGATIVE_INFINITY;
      for (let v = 0; v < 3; v++) {
        minX = Math.min(minX, pos.getX(i + v));
        maxX = Math.max(maxX, pos.getX(i + v));
        minZ = Math.min(minZ, pos.getZ(i + v));
        maxZ = Math.max(maxZ, pos.getZ(i + v));
      }
      // No stretched triangle: every one is a few metres across at most.
      expect(maxX - minX).toBeLessThan(100);
      expect(maxZ - minZ).toBeLessThan(100);
      // The copies sit exactly one period apart.
      for (let k = 1; k < 4; k++) {
        const dx = pos.getX(i + k * q) - pos.getX(i);
        const dz = pos.getZ(i + k * q) - pos.getZ(i);
        expect([0, WORLD_SIZE]).toContain(Math.round(dx));
        expect([0, WORLD_SIZE]).toContain(Math.round(dz));
      }
    }
    expect(fixtures.getAttribute("position").count % 4).toBe(0);
  });

  it("puts air on one side of every face below street level and rock on the other", () => {
    const q = n / 4;
    let tested = 0;
    let bad = 0;
    const a = { x: 0, y: 0, z: 0 };
    const b = { x: 0, y: 0, z: 0 };
    for (let i = 0; i < q; i += 3) {
      const p0 = [pos.getX(i), pos.getY(i), pos.getZ(i)];
      const p1 = [pos.getX(i + 1), pos.getY(i + 1), pos.getZ(i + 1)];
      const p2 = [pos.getX(i + 2), pos.getY(i + 2), pos.getZ(i + 2)];
      const e1 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
      const e2 = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]];
      let nx = e1[1] * e2[2] - e1[2] * e2[1];
      let ny = e1[2] * e2[0] - e1[0] * e2[2];
      let nz = e1[0] * e2[1] - e1[1] * e2[0];
      const len = Math.hypot(nx, ny, nz);
      // Degenerate (a clipped strip's collapsed edge): nothing to separate.
      if (len < 1e-3) continue;
      nx /= len;
      ny /= len;
      nz /= len;
      const cx = (p0[0] + p1[0] + p2[0]) / 3;
      const cy = (p0[1] + p1[1] + p2[1]) / 3;
      const cz = (p0[2] + p1[2] + p2[2]) / 3;
      // Street level and above (the kerbs, a cut's wall tops) is dressing
      // over open air, not a face of the ground.
      if (cy > -0.5) continue;
      const d = 0.15;
      a.x = cx + nx * d;
      a.y = cy + ny * d;
      a.z = cz + nz * d;
      b.x = cx - nx * d;
      b.y = cy - ny * d;
      b.z = cz - nz * d;
      tested++;
      if (hitsGround(a, 0) === hitsGround(b, 0)) bad++;
    }
    expect(tested).toBeGreaterThan(5000);
    expect(bad).toBe(0);
  });
});

describe("the tunnel renderer's budget", () => {
  it("is two draws for the whole network, and MOBILE drops the fixtures", () => {
    const r = new TunnelRenderer();
    const meshes: THREE.Object3D[] = [];
    r.group.traverse((o) => {
      if (o instanceof THREE.Mesh) meshes.push(o);
    });
    expect(meshes.length).toBe(2);
    for (const tier of ["high", "medium", "low"] as const) {
      expect(QUALITY_PROFILES[tier].tunnelFixtures).toBe(true);
      r.setQuality(tier);
      expect(r.fixtures.visible).toBe(true);
      expect(r.shell.visible).toBe(true);
    }
    expect(QUALITY_PROFILES.mobile.tunnelFixtures).toBe(false);
    r.setQuality("mobile");
    expect(r.fixtures.visible).toBe(false);
    // The shell is solid: identical on every tier.
    expect(r.shell.visible).toBe(true);
  });
});
