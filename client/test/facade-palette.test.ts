import { generateCity } from "@angels-bandits/common/city";
import { CITY_SEED } from "@angels-bandits/common/constants";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { archetypeFor } from "../src/render/archetypes";
import {
  BOUNCE_HEIGHT,
  BOUNCE_INTENSITY,
  BOUNCE_LUMINANCE_CAP,
  BOUNCE_NEON_MIX,
  BOUNCE_TINTS,
  BUILDING_SHADER_SOURCE,
  GRAZING_REFLECTANCE,
} from "../src/render/buildings-material";
import { facadeColor } from "../src/render/city";
import { luminance } from "../src/render/emissive";
import { DUSK, LIGHT_RIG } from "../src/render/sky";
import { FACADE } from "../src/render/window-pattern";

const BLOOM_THRESHOLD = 0.72;
/** The ticket's ceiling for a lit, non-window facade (linear luminance). */
const FACADE_PEAK = 0.4;
const city = generateCity(CITY_SEED);
const lum = (hex: number) => luminance(new THREE.Color(hex));

describe("VO2 facade palette", () => {
  const colors = city.map((b) => facadeColor(b, archetypeFor(b)));
  const maxAlbedo = Math.max(...colors.map(luminance));
  // The weathering pass can only brighten a face by its tone jitter.
  const maxDiffuse = maxAlbedo * (1 + FACADE.faceJitter);

  // Mirror of the bounce term in buildings-material.ts, at its worst: the
  // brightest tint, and the shortest lot's AO (the fastest lift with height)
  // with no grime streak — scanned up the facade for its peak.
  const tints = [
    BOUNCE_TINTS.sodium,
    BOUNCE_TINTS.sodium.clone().lerp(BOUNCE_TINTS.magenta, BOUNCE_NEON_MIX),
    BOUNCE_TINTS.sodium.clone().lerp(BOUNCE_TINTS.cyan, BOUNCE_NEON_MIX),
  ];
  const maxTint = Math.max(...tints.map(luminance));
  let bouncePeak = 0;
  for (let y = 0; y <= 60; y += 0.25) {
    const ao = 1 - FACADE.aoStrength * (1 - Math.min(y / 6, 1));
    const soot = 1 - FACADE.soot * (1 - Math.min(y / 90, 1));
    const k = Math.exp(-y / BOUNCE_HEIGHT) * ao * soot;
    bouncePeak = Math.max(
      bouncePeak,
      maxDiffuse * maxTint * BOUNCE_INTENSITY * k,
    );
  }

  it("keeps the canyon bounce a sub-bloom wash, never a lamp", () => {
    expect(bouncePeak).toBeGreaterThan(0.05); // it is visibly there…
    expect(bouncePeak).toBeLessThan(BOUNCE_LUMINANCE_CAP); // …and stays a wash
  });

  it("never lights a facade anywhere near the bloom threshold", () => {
    // Upper bound: every VO1 light at full incidence at once (Lambert 1/π,
    // hemisphere taken at its brighter half) on the brightest albedo, plus
    // the bounce peak on top.
    const irradiance =
      lum(DUSK.ambient) * LIGHT_RIG.ambient +
      lum(DUSK.moon) * LIGHT_RIG.moon +
      lum(DUSK.glow) * LIGHT_RIG.glow +
      Math.max(lum(DUSK.hemiSky), lum(DUSK.hemiGround)) * LIGHT_RIG.hemi;
    const peak = (maxDiffuse * irradiance) / Math.PI + bouncePeak;
    expect(peak).toBeLessThan(FACADE_PEAK);
    expect(FACADE_PEAK).toBeLessThan(BLOOM_THRESHOLD);
  });

  it("is no longer a black city: every facade has a visible albedo", () => {
    expect(Math.min(...colors.map(luminance))).toBeGreaterThan(0.01);
  });

  it("gives a block many finishes, not one", () => {
    const hues = new Set(
      colors.map((c) => Math.round(c.getHSL({ h: 0, s: 0, l: 0 }).h * 20)),
    );
    expect(hues.size).toBeGreaterThan(5);
  });

  it("keeps glass shinier than solid walls at grazing angles", () => {
    expect(GRAZING_REFLECTANCE.glass).toBeGreaterThan(
      GRAZING_REFLECTANCE.solid,
    );
    expect(GRAZING_REFLECTANCE.glass).toBeLessThan(1);
  });

  it("splices the grazing cap and bounce at anchors three still has", () => {
    // A missing anchor makes String.replace a silent no-op.
    const frag = THREE.ShaderLib.physical.fragmentShader;
    expect(frag).toContain("#include <lights_physical_fragment>");
    expect(frag).toContain("#include <emissivemap_fragment>");
    expect(BUILDING_SHADER_SOURCE.fragmentSpecular).toContain(
      "material.specularF90",
    );
    expect(BUILDING_SHADER_SOURCE.fragmentEmissive).toContain("bounceK");
  });
});
