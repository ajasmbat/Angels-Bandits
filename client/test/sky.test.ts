import {
  CITY_TOP,
  EMISSIVE_TRACER,
  FOG_DISTANCE,
} from "@angels-bandits/common/constants";
import { describe, expect, it } from "vitest";
import {
  EXPOSURE,
  FOG_NEAR,
  MOON_DIR,
  MOON_PEAK,
  SKY_FOG_ELEVATION,
  SKY_FOG_STOP,
  SKY_GLOW_RAMP,
  STAR_PEAK,
} from "../src/render/sky";
import { skyFogAbove } from "../src/render/sky-fog";
import { SKY_CYCLE_MS, domeGradient, skyStateAt } from "../src/render/skycycle";

const BLOOM_THRESHOLD = 0.72;

describe("VO1 blue-hour sky", () => {
  it("is fog-coloured everywhere a fully fogged landmark could stand", () => {
    // The gradient's canvas fraction maps to polar angle; 0.5 is the horizon.
    const fogFromElevation = (0.5 - SKY_FOG_STOP) * Math.PI;
    // Worst case: a landmark at the fog limit (radial fog: the crown is
    // CITY_TOP up and FOG_DISTANCE away), seen from the pavement. H1's
    // supertalls stand far above the stop there… (T1: the mega-towers rise
    // past FOG_DISTANCE itself, so a fully fogged face can stand anywhere
    // up to straight overhead.)
    const tallest = Math.asin(Math.min(1, CITY_TOP / FOG_DISTANCE));
    expect(fogFromElevation).toBeLessThan(tallest);
    // …so above the stop a fully fogged surface takes the dome's own colour
    // (sky-fog.ts abSkyFog): its blend from the fog colour to the dome's
    // gradient is the dome's, exactly, at every elevation up to the crown.
    const domeAbove = (el: number) => {
      const t = Math.min(
        1,
        Math.max(0, (el - SKY_FOG_ELEVATION) / SKY_GLOW_RAMP),
      );
      return t * t * (3 - 2 * t);
    };
    for (let el = 0; el <= tallest; el += 0.002) {
      expect(skyFogAbove(el)).toBeCloseTo(domeAbove(el), 12);
    }
    // Below the stop it is the plain fog colour, as the dome is.
    expect(skyFogAbove(fogFromElevation)).toBe(0);
  });

  it("keeps the linear fog reaching 1 before the torus half-world", () => {
    expect(FOG_NEAR).toBeLessThan(FOG_DISTANCE);
    expect(FOG_NEAR).toBeGreaterThan(0);
  });

  it("puts the moon on the ladder: a soft halo, never a tracer", () => {
    expect(MOON_PEAK).toBeGreaterThan(BLOOM_THRESHOLD);
    expect(MOON_PEAK).toBeLessThan(EMISSIVE_TRACER);
    expect(STAR_PEAK).toBeLessThan(BLOOM_THRESHOLD);
  });

  it("hangs the moon low enough for a chase camera to see it", () => {
    const elevation = Math.asin(MOON_DIR.y);
    expect(elevation).toBeGreaterThan(0.25); // clear of the glow band
    expect(elevation).toBeLessThan(0.6); // inside a level FOV-70 frame
  });

  it("lifts exposure modestly — the ladder, not exposure, carries the night", () => {
    expect(EXPOSURE).toBeGreaterThanOrEqual(1);
    expect(EXPOSURE).toBeLessThan(1.5);
  });

  it("L12: the dome IS the fog colour below the stop at every moment of the cycle", () => {
    // The torus contract under the sky cycle: whatever time of night it is,
    // the sky from SKY_FOG_STOP down equals the colour handed to the fog.
    let worst = 0;
    for (let t = 0; t < SKY_CYCLE_MS; t += 1000) {
      const s = skyStateAt(t);
      for (const f of [SKY_FOG_STOP, 0.45, 0.5, 0.75, 1]) {
        const c = domeGradient(f, s);
        for (let i = 0; i < 3; i++) {
          worst = Math.max(
            worst,
            Math.abs((c[i] as number) - (s.horizon[i] as number)),
          );
        }
      }
    }
    expect(worst).toBeLessThan(1e-9);
  });
});
