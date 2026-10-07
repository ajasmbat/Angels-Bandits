import { generateCity } from "@angels-bandits/common/city";
import { CITY_SEED } from "@angels-bandits/common/constants";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { archetypeFor } from "../src/render/archetypes";
import {
  BOUNCE_LUMINANCE_CAP,
  BUILDING_SHADER_SOURCE,
} from "../src/render/buildings-material";
import { facadeColor } from "../src/render/city";
import { luminance } from "../src/render/emissive";
import { HAZE_PARAMS, installHeightFog } from "../src/render/fog";
import {
  DUSK,
  EXPOSURE,
  GLOW_DIR,
  LIGHT_RIG,
  MOON_DIR,
  MOON_RADIUS,
  SKY_FOG_ELEVATION,
  SkyDome,
} from "../src/render/sky";
import {
  DUSK_KEY,
  MOON_EL_LOW,
  MOON_EL_PEAK,
  NIGHT,
  PREDAWN,
  SKY_CYCLE_MS,
  SKY_FIELDS,
  SKY_MOMENTS,
  type SkyState,
  createSkyState,
  lumOf,
  parseSkyParam,
  rigIrradiance,
  skyPhase,
  skyStateAt,
  skyStateAtPhase,
} from "../src/render/skycycle";
import {
  FACADE,
  OCCUPANCY_FADE,
  windowOccupied,
} from "../src/render/window-pattern";

const BLOOM_THRESHOLD = 0.72;
/** facade-palette.test.ts's ceiling for a lit, non-window facade. */
const FACADE_PEAK = 0.4;
const STEP_MS = 100;

/** Every scalar the cycle drives, flattened in a fixed order. */
function flatten(s: SkyState): number[] {
  const out: number[] = [];
  for (const k of SKY_FIELDS) {
    const v = s[k];
    if (typeof v === "number") out.push(v);
    else out.push(...v);
  }
  out.push(s.moonVis);
  return out;
}

/** The whole loop at 100 ms, plus one sample past the seam. */
const samples: { t: number; s: SkyState }[] = [];
for (let t = 0; t <= SKY_CYCLE_MS + STEP_MS; t += STEP_MS) {
  samples.push({ t, s: skyStateAt(t) });
}

const angle = (a: readonly number[], b: readonly number[]): number =>
  Math.acos(
    Math.min(
      1,
      (a[0] as number) * (b[0] as number) +
        (a[1] as number) * (b[1] as number) +
        (a[2] as number) * (b[2] as number),
    ),
  );

describe("L12 sky cycle — the pure schedule", () => {
  it("is deterministic and loops on the synced clock", () => {
    for (const t of [0, 123_456, 1_799_999, 1.8e12 + 4321]) {
      expect(flatten(skyStateAt(t))).toEqual(flatten(skyStateAt(t)));
      const a = flatten(skyStateAt(t));
      const b = flatten(skyStateAt(t + SKY_CYCLE_MS));
      a.forEach((v, i) => expect(b[i]).toBeCloseTo(v, 6));
    }
    expect(skyPhase(-1)).toBeCloseTo(1 - 1 / SKY_CYCLE_MS, 12);
  });

  it("reuses the caller's state object (no per-frame allocation)", () => {
    const out = createSkyState();
    expect(skyStateAt(777_000, out)).toBe(out);
  });

  it("is today's VO1 night at the night moment, moon included", () => {
    const s = skyStateAtPhase(SKY_MOMENTS.night);
    const fog = new THREE.Color(DUSK.sky);
    expect(s.horizon[0]).toBeCloseTo(fog.r, 9);
    expect(s.horizon[1]).toBeCloseTo(fog.g, 9);
    expect(s.horizon[2]).toBeCloseTo(fog.b, 9);
    expect(s.ambientI).toBe(LIGHT_RIG.ambient);
    expect(s.moonI).toBeCloseTo(LIGHT_RIG.moon, 9);
    expect(s.glowI).toBe(LIGHT_RIG.glow);
    expect(s.hemiI).toBe(LIGHT_RIG.hemi);
    expect(s.exposure).toBe(EXPOSURE);
    expect(s.occupancy).toBe(1);
    expect(s.moonVis).toBe(1);
    expect(angle(s.moonDir, MOON_DIR.toArray())).toBeLessThan(1e-6);
    expect(angle(s.glowDir, GLOW_DIR.toArray())).toBeLessThan(1e-6);
  });

  it("changes no parameter by more than 1 % of its swing per second", () => {
    const flat = samples.map(({ s }) => flatten(s));
    const n = (flat[0] as number[]).length;
    for (let i = 0; i < n; i++) {
      const vals = flat.map((f) => f[i] as number);
      const range = Math.max(...vals) - Math.min(...vals);
      let worst = 0;
      for (let j = 1; j < vals.length; j++) {
        worst = Math.max(
          worst,
          Math.abs((vals[j] as number) - (vals[j - 1] as number)),
        );
      }
      // Per 100 ms step: ≤ 0.1 % of the swing; constants never move at all.
      expect(worst).toBeLessThanOrEqual(
        range * 0.01 * (STEP_MS / 1000) + 1e-12,
      );
    }
  });

  it("turns the moon and the rim light no faster than 1°/s", () => {
    const limit = ((1 * Math.PI) / 180) * (STEP_MS / 1000);
    // Aggregated, not one expect per sample: 24 000 samples of expect()
    // starve the vitest worker's RPC heartbeat on a loaded machine.
    let moonWorst = 0;
    let glowWorst = 0;
    for (let j = 1; j < samples.length; j++) {
      const a = (samples[j - 1] as (typeof samples)[number]).s;
      const b = (samples[j] as (typeof samples)[number]).s;
      moonWorst = Math.max(moonWorst, angle(a.moonDir, b.moonDir));
      glowWorst = Math.max(glowWorst, angle(a.glowDir, b.glowDir));
    }
    expect(moonWorst).toBeLessThanOrEqual(limit);
    expect(glowWorst).toBeLessThanOrEqual(limit);
  });

  it("keeps the moon disc above the fog band, inside a level frame", () => {
    expect(MOON_EL_LOW - MOON_RADIUS).toBeGreaterThan(SKY_FOG_ELEVATION);
    expect(MOON_EL_PEAK).toBeLessThan(0.6);
    const lowest = Math.min(...samples.map(({ s }) => Math.asin(s.moonDir[1])));
    expect(lowest).toBeGreaterThanOrEqual(MOON_EL_LOW - 1e-9);
    // It actually travels: ~100° of azimuth across the night.
    const az = (f: number) => {
      const d = skyStateAtPhase(f).moonDir;
      return Math.atan2(d[2], d[0]);
    };
    expect(Math.abs(az(0.85) - az(0.1))).toBeGreaterThan(1.2);
  });

  it("runs dusk → night → pre-dawn with the promised moods", () => {
    const dusk = skyStateAtPhase(SKY_MOMENTS.dusk);
    const pre = skyStateAtPhase(SKY_MOMENTS.predawn);
    // Dusk: more ambient light, fewer windows, a warm glow in one quarter.
    expect(lumOf(dusk.ambient) * dusk.ambientI).toBeGreaterThan(
      lumOf(NIGHT.ambient) * NIGHT.ambientI,
    );
    expect(dusk.occupancy).toBeLessThan(1);
    expect(dusk.duskGlow[0]).toBeGreaterThan(dusk.duskGlow[2]);
    // Pre-dawn: a cool lift, windows thinning out, a faint dawn glow.
    expect(pre.horizon[2]).toBeGreaterThan(pre.horizon[0]);
    expect(lumOf(pre.horizon)).toBeGreaterThan(lumOf(NIGHT.horizon));
    expect(pre.occupancy).toBeLessThan(dusk.occupancy);
    expect(lumOf(pre.dawnGlow)).toBeGreaterThan(0);
    expect(lumOf(pre.dawnGlow)).toBeLessThan(lumOf(dusk.duskGlow));
  });

  it("keeps every level in range", () => {
    const levels = samples.flatMap(({ s }) => [
      s.occupancy,
      s.pools,
      s.stars,
      s.moonVis,
    ]);
    expect(Math.min(...levels)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...levels)).toBeLessThanOrEqual(1);
    const exposures = samples.map(({ s }) => s.exposure);
    expect(Math.min(...exposures)).toBeGreaterThanOrEqual(1);
    expect(Math.max(...exposures)).toBeLessThan(1.5);
  });

  it("parses the ?sky= boot pin", () => {
    expect(parseSkyParam("?sky=dusk")).toBe(SKY_MOMENTS.dusk);
    expect(parseSkyParam("?res=1.5&sky=0.25")).toBe(0.25);
    expect(parseSkyParam("?sky=1.5")).toBe(0.5);
    expect(parseSkyParam("?sky=nope")).toBeNull();
    expect(parseSkyParam("")).toBeNull();
  });
});

describe("L12 sky cycle — the emissive ladder holds", () => {
  const city = generateCity(CITY_SEED);
  const maxDiffuse =
    Math.max(...city.map((b) => luminance(facadeColor(b, archetypeFor(b))))) *
    (1 + FACADE.faceJitter);

  it("keeps every facade far under the bloom threshold all night", () => {
    const night = rigIrradiance(NIGHT);
    const irr = Math.max(...samples.map(({ s }) => rigIrradiance(s)));
    // Never more worst-case light than the night rig facade-palette pins…
    expect(irr).toBeLessThanOrEqual(night + 1e-9);
    // …and the bound itself, brightest albedo + bounce on top.
    const peak = (maxDiffuse * irr) / Math.PI + BOUNCE_LUMINANCE_CAP;
    expect(peak).toBeLessThan(FACADE_PEAK);
    expect(FACADE_PEAK).toBeLessThan(BLOOM_THRESHOLD);
  });

  it("keeps the sky itself sub-bloom", () => {
    for (const k of [DUSK_KEY, NIGHT, PREDAWN]) {
      const brightest = Math.max(
        ...[k.zenith, k.sky14, k.sky25, k.sky32, k.sky37, k.horizon].map(lumOf),
      );
      expect(brightest + lumOf(k.duskGlow) + lumOf(k.dawnGlow)).toBeLessThan(
        BLOOM_THRESHOLD,
      );
    }
  });
});

describe("L12 sky cycle — the GPU seams", () => {
  it("switches windows one at a time, never popping", () => {
    // Steepest occupancy rate anywhere in the loop, per second.
    let rate = 0;
    for (let j = 1; j < samples.length; j++) {
      const a = (samples[j - 1] as (typeof samples)[number]).s.occupancy;
      const b = (samples[j] as (typeof samples)[number]).s.occupancy;
      rate = Math.max(rate, Math.abs(b - a) / (STEP_MS / 1000));
    }
    expect(OCCUPANCY_FADE / rate).toBeGreaterThanOrEqual(2); // ≥ 2 s fades
    let on = 0;
    let full = 0;
    let none = 0;
    for (let x = 0; x < 60; x++) {
      for (let y = 0; y < 60; y++) {
        full += windowOccupied(1234, x, y, 1);
        none += windowOccupied(1234, x, y, 0);
        on += windowOccupied(1234, x, y, 0.55);
      }
    }
    expect(full).toBe(3600); // occupancy 1: every lit window fully on
    expect(none).toBe(0); // occupancy 0: none at all
    expect(on / 3600).toBeGreaterThan(0.5);
    expect(on / 3600).toBeLessThan(0.6);
    expect(BUILDING_SHADER_SOURCE.fragmentPars).toContain(
      "uniform float uOccupancy",
    );
    expect(BUILDING_SHADER_SOURCE.fragmentColor).toContain("uOccupancy");
  });

  it("drives the haze through ONE shared uniform in every fogged program", () => {
    installHeightFog();
    expect(THREE.ShaderChunk.fog_pars_fragment).toContain(
      "uniform vec4 abHazeParams",
    );
    expect(THREE.ShaderChunk.fog_fragment).toContain("abHazeParams.rgb");
    // cloneUniforms copies typed arrays by reference: one write, every program.
    for (const lib of ["standard", "physical", "basic", "points", "sprite"]) {
      const u = THREE.UniformsUtils.clone(
        (THREE.ShaderLib as Record<string, THREE.ShaderMaterialParameters>)[lib]
          ?.uniforms ?? {},
      );
      expect(u.abHazeParams?.value).toBe(HAZE_PARAMS);
    }
  });

  it("ramps the moon halo and the dome glows in from zero at the fog stop", () => {
    const dome = new SkyDome();
    const material = dome.mesh.material as THREE.MeshBasicMaterial;
    const shader = {
      uniforms: {} as Record<string, THREE.IUniform>,
      vertexShader: THREE.ShaderLib.basic.vertexShader,
      fragmentShader: THREE.ShaderLib.basic.fragmentShader,
    };
    material.onBeforeCompile(
      shader as unknown as THREE.WebGLProgramParametersWithUniforms,
      {} as THREE.WebGLRenderer,
    );
    const frag = shader.fragmentShader;
    expect(frag).toContain(
      `float above = smoothstep(${SKY_FOG_ELEVATION.toFixed(5)}`,
    );
    expect(frag).toMatch(/float halo = .*\* uMoonVis \* above;/);
    expect(frag).toMatch(/float band = above \*/);
    expect(shader.uniforms.uSkyStops).toBeDefined();
  });
});
