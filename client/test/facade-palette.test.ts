import { generateCity } from "@angels-bandits/common/city";
import { CITY_SEED } from "@angels-bandits/common/constants";
import {
  EMISSIVE_SIGN,
  EMISSIVE_TRACER,
} from "@angels-bandits/common/constants";
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
import { BILLBOARD_FACE_LUMINANCE } from "../src/render/roof-details";
import {
  CROWN_MIN_HEIGHT,
  GARDEN_LIGHT_COLOR,
  LED_LUMINANCE,
  PAD_LIGHT_COLOR,
  ROOF_ALBEDO,
  crownDepth,
  roofStyleFor,
} from "../src/render/roofs";
import { DUSK, LIGHT_RIG } from "../src/render/sky";
import { FACADE } from "../src/render/window-pattern";

const BLOOM_THRESHOLD = 0.72;
/** The ticket's ceiling for a lit, non-window facade (linear luminance). */
const FACADE_PEAK = 0.4;
const city = generateCity(CITY_SEED);
const lum = (hex: number) => luminance(new THREE.Color(hex));
// Every VO1 light at full incidence at once (Lambert 1/π applies at the use
// site; the hemisphere taken at its brighter half) — the worst-case light
// any surface in the city can receive.
const irradiance =
  lum(DUSK.ambient) * LIGHT_RIG.ambient +
  lum(DUSK.moon) * LIGHT_RIG.moon +
  lum(DUSK.glow) * LIGHT_RIG.glow +
  Math.max(lum(DUSK.hemiSky), lum(DUSK.hemiGround)) * LIGHT_RIG.hemi;

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

describe("VO3 roofs & crowns on the emissive ladder", () => {
  const styles = city.map(roofStyleFor);
  const leds = styles.flatMap((s) => (s.led ? [s.led] : []));
  const crowns = styles.flatMap((s) => (s.crown ? [s.crown] : []));
  const maxDiffuse =
    Math.max(...city.map((b) => luminance(facadeColor(b, archetypeFor(b))))) *
    (1 + FACADE.faceJitter);

  it("keeps every LED outline and helipad light at or below the SIGN rung", () => {
    expect(leds.length).toBeGreaterThan(10);
    // The shader only ever takes a CONVEX mix towards the LED colour, so the
    // colour's own luminance is the pixel's ceiling.
    for (const c of leds) {
      expect(luminance(c)).toBeCloseTo(LED_LUMINANCE, 6);
      expect(luminance(c)).toBeLessThanOrEqual(EMISSIVE_SIGN);
    }
    expect(luminance(PAD_LIGHT_COLOR)).toBeLessThanOrEqual(EMISSIVE_SIGN);
    expect(EMISSIVE_SIGN).toBeLessThan(EMISSIVE_TRACER);
  });

  it("keeps the crown a floodlit wash: lit facade + crown stays under bloom", () => {
    expect(crowns.length).toBeGreaterThan(10);
    // lum(albedo ∘ tint) ≤ lum(albedo) · max(tint), and the wash profile ≤ 1.
    const crownPeak =
      maxDiffuse *
      Math.max(...crowns.map((c) => Math.max(c.color.r, c.color.g, c.color.b)));
    // The lowest a crown starts is the shortest crown tower minus its depth;
    // the VO2 canyon bounce left at that height (brightest tint, no AO).
    const crownBase = CROWN_MIN_HEIGHT - crownDepth(CROWN_MIN_HEIGHT);
    const bounceThere =
      maxDiffuse *
      Math.max(...Object.values(BOUNCE_TINTS).map(luminance)) *
      BOUNCE_INTENSITY *
      Math.exp(-crownBase / BOUNCE_HEIGHT);
    const lit = (maxDiffuse * irradiance) / Math.PI;
    expect(crownPeak).toBeLessThanOrEqual(EMISSIVE_SIGN);
    expect(crownPeak + lit + bounceThere).toBeLessThan(BLOOM_THRESHOLD);
  });

  it("lights roofs readably but never near bloom, billboard art included", () => {
    const roofs = Object.values(ROOF_ALBEDO).map(luminance);
    const roofPeak = (Math.max(...roofs) * irradiance) / Math.PI;
    // R2 retired the skylight glow; the roof's lit SURFACE now is billboard
    // art, which glows like a pane, never like a lamp.
    expect(Math.max(roofPeak, BILLBOARD_FACE_LUMINANCE)).toBeLessThan(
      FACADE_PEAK,
    );
    expect(luminance(GARDEN_LIGHT_COLOR)).toBeLessThan(BLOOM_THRESHOLD);
    // …and the deck itself is no longer a black hole.
    expect(luminance(ROOF_ALBEDO.membrane)).toBeGreaterThan(0.2);
  });
});
